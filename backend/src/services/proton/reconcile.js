import { query } from '../db.js';
import { decrypt, encrypt } from '../encryption.js';
import { reconnectAccount, withAccountAddressLock } from '../accounts/connection.js';
import { callWorker } from './workerClient.js';
import { trustedProtonEndpoint } from './mailEndpoint.js';

// Keeps committed managed Proton links in step with Bridge in the worker. A pass asks the worker for
// the credentials of each link (native user, address, the link's generation) and:
//   - same certificate and Bridge password: nothing to do;
//   - a new certificate or password: both are stored in one transaction, provided the link is still
//     the one that was read (a reconnect may have committed meanwhile), and the mailbox reconnects
//     through the shared reconnect queue so the IMAP sessions trust the new certificate (SMTP builds
//     its transport per send from the link);
//   - the native user or the address is gone from Bridge, or Bridge holds another generation (lost
//     or restored state): proton_reconnect_required, until any employee signs in again;
//   - the worker does not answer: proton_unavailable, a temporary state. Nothing is changed, and the
//     mailbox never falls back to another endpoint: only the managed link reaches Bridge.
// Links of a native user in cleanup or removal are left to that lifecycle, and a mailbox with a
// connection attempt in flight to that attempt. Nothing is deleted here.
// Statuses live in this process and are rebuilt by every pass (startup, then every minute).

const PASS_BUDGET_MS = 45000;
const CALL_TIMEOUT_MS = 5000;
// The worker answered and Bridge does not hold this link any more.
const LOST = new Set(['not_found', 'not_connected', 'generation_mismatch', 'address_mismatch']);
// The worker itself is out of reach: the rest of the pass would only wait out the same timeout.
const OFFLINE = new Set(['worker_unavailable', 'worker_timeout']);
// States of services/proton/connections.js after which an attempt no longer touches its mailbox.
const FINISHED_ATTEMPT = ['connected', 'failed', 'cancelled', 'expired'];

export const PROTON_RECONNECT_REQUIRED = 'proton_reconnect_required';
export const PROTON_UNAVAILABLE = 'proton_unavailable';

let engine = null;
let statuses = new Map();

// index.js hands over the backend's mail engine (imapManager), as for connections.js.
export function setProtonReconcileEngine(mailEngine) {
  engine = mailEngine;
}

// { code } for a managed mailbox whose link is not usable right now, else null. Safe to show.
export function protonLinkStatus(accountId) {
  const code = statuses.get(accountId);
  return code ? { code } : null;
}

// A successful reconnect (services/proton/connections.js) has just proved the link works.
export function clearProtonLinkStatus(accountId) {
  statuses.delete(accountId);
}

const normalizedEmail = value => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const normalizedFingerprint = value => (typeof value === 'string' ? value.replace(/:/g, '').toLowerCase() : '');

function storedPassword(value) {
  try { return value ? decrypt(value) : null; } catch { return null; }
}

// The worker material is used only when it names this link's native user and address and passes
// the same certificate checks as every connection (public PEM, matching fingerprint, loopback
// identity). Anything else is treated as an unusable answer, never stored.
function trustedMaterial(material, link) {
  if (material?.userId !== link.proton_user_id || normalizedEmail(material.email) !== normalizedEmail(link.email_address)
    || typeof material.bridgePassword !== 'string' || !material.bridgePassword) return null;
  try { trustedProtonEndpoint(material, 'imap'); } catch { return null; }
  return material;
}

// One transaction under the mailbox's address lock (the lock Proton commits take): the link and its
// native user are read again and must still be what this pass saw.
async function storeMaterial(link, material) {
  return withAccountAddressLock(link.email_address, async client => {
    await client.query('BEGIN');
    try {
      const { rows: [current] } = await client.query(
        `SELECT l.proton_user_id, l.generation, l.certificate_fingerprint, a.auth_pass, u.cleanup_pending, u.removal_state
           FROM proton_mailbox_links l
           JOIN proton_users u ON u.proton_user_id = l.proton_user_id AND u.generation = l.generation
           JOIN email_accounts a ON a.id = l.account_id
          WHERE l.account_id = $1 AND a.mail_provider = 'proton' AND a.connection_mode = 'managed'
          FOR UPDATE OF l, a, u`, [link.account_id],
      );
      const unchanged = current && current.proton_user_id === link.proton_user_id && current.generation === link.generation
        && !current.cleanup_pending && !current.removal_state
        && current.certificate_fingerprint === link.certificate_fingerprint && current.auth_pass === link.auth_pass;
      if (!unchanged) {
        await client.query('ROLLBACK');
        return false;
      }
      const secret = encrypt(material.bridgePassword);
      await client.query('UPDATE email_accounts SET auth_pass = $2, smtp_auth_pass = $2 WHERE id = $1', [link.account_id, secret]);
      await client.query(
        `UPDATE proton_mailbox_links SET certificate_pem = $2, certificate_fingerprint = $3, tls_servername = $4
          WHERE account_id = $1`,
        [link.account_id, material.certificatePem, normalizedFingerprint(material.certificateFingerprint), material.tlsServername],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

function reconnect(accountId) {
  if (!engine) return;
  reconnectAccount(engine, accountId, { onlyActive: true })
    .catch(err => console.error(`Proton link reconnect failed for ${accountId}:`, err.message));
}

// Returns the account IDs whose stored credentials changed and those that need a new sign-in.
export async function reconcileProtonLinks({ signal } = {}) {
  const { rows: links } = await query(
    `SELECT l.account_id, l.proton_user_id, l.generation, l.certificate_fingerprint, a.email_address, a.auth_pass,
            u.cleanup_pending, u.removal_state,
            EXISTS (SELECT 1 FROM proton_connections c
                     WHERE (c.account_id = l.account_id OR c.reconnect_account_id = l.account_id)
                       AND c.state <> ALL ($1)) AS attempt_in_flight
       FROM proton_mailbox_links l
       JOIN proton_users u ON u.proton_user_id = l.proton_user_id AND u.generation = l.generation
       JOIN email_accounts a ON a.id = l.account_id
      WHERE a.mail_provider = 'proton' AND a.connection_mode = 'managed'
      ORDER BY a.email_address, l.account_id`, [FINISHED_ATTEMPT],
  );
  const previous = statuses;
  const next = new Map();
  const changed = [];
  let offline = false;
  for (const link of links) {
    const id = link.account_id;
    if (link.cleanup_pending || link.removal_state) continue;
    // A connection attempt for this mailbox has written (or will write) the link before the worker
    // records it, and the worker answers for the old material until then: the attempt decides, and
    // its commit clears the status (connections.js). Until then the known status stands.
    if (signal?.aborted || link.attempt_in_flight) {
      if (previous.has(id)) next.set(id, previous.get(id));
      continue;
    }
    if (offline) {
      next.set(id, previous.get(id) === PROTON_RECONNECT_REQUIRED ? PROTON_RECONNECT_REQUIRED : PROTON_UNAVAILABLE);
      continue;
    }
    let material;
    try {
      material = await callWorker('POST', `/users/${link.proton_user_id}/credentials`,
        { generation: link.generation, email: normalizedEmail(link.email_address) }, { signal, timeoutMs: CALL_TIMEOUT_MS });
    } catch (err) {
      if (LOST.has(err?.code)) {
        next.set(id, PROTON_RECONNECT_REQUIRED);
      } else if (err?.code === 'worker_cancelled' || signal?.aborted) {
        if (previous.has(id)) next.set(id, previous.get(id));
      } else {
        offline = OFFLINE.has(err?.code);
        next.set(id, previous.get(id) === PROTON_RECONNECT_REQUIRED ? PROTON_RECONNECT_REQUIRED : PROTON_UNAVAILABLE);
      }
      continue;
    }
    const trusted = trustedMaterial(material, link);
    if (!trusted) {
      next.set(id, PROTON_UNAVAILABLE);
      continue;
    }
    const sameCertificate = normalizedFingerprint(trusted.certificateFingerprint) === normalizedFingerprint(link.certificate_fingerprint);
    const samePassword = storedPassword(link.auth_pass) === trusted.bridgePassword;
    if (sameCertificate && samePassword) {
      // Back from a lost session (a new sign-in elsewhere, a restored state): connect again now
      // instead of waiting out the auth backoff of the rejected logins.
      if (previous.get(id) === PROTON_RECONNECT_REQUIRED) reconnect(id);
      continue;
    }
    let stored;
    try { stored = await storeMaterial(link, trusted); }
    catch (err) {
      console.error(`Storing rotated Proton credentials failed for ${id}:`, err.message);
      next.set(id, PROTON_UNAVAILABLE);
      continue;
    }
    // A link changed meanwhile was updated by whoever changed it; the next pass looks again.
    if (!stored) continue;
    changed.push(id);
    reconnect(id);
  }
  statuses = next;
  for (const [id, code] of next) {
    if (code === PROTON_RECONNECT_REQUIRED && previous.get(id) !== PROTON_RECONNECT_REQUIRED) {
      engine?.broadcast?.({ type: 'account_error', accountId: id, error: PROTON_RECONNECT_REQUIRED });
    }
  }
  const reconnectRequired = [...next].filter(([, code]) => code === PROTON_RECONNECT_REQUIRED).map(([id]) => id);
  return { changed, reconnectRequired };
}

// At start and then every minute, one pass at a time, each bounded by its own budget.
export function startProtonLinkReconciler({ intervalMs = 60000, budgetMs = PASS_BUDGET_MS } = {}) {
  let running = null;
  let controller = null;
  const run = () => {
    if (running) return running;
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    timer.unref?.();
    running = reconcileProtonLinks({ signal: controller.signal })
      .catch(err => console.error('Proton link reconciliation failed:', err.message))
      .finally(() => { clearTimeout(timer); running = null; });
    return running;
  };
  run();
  const interval = setInterval(run, intervalMs);
  interval.unref?.();
  return () => {
    clearInterval(interval);
    controller?.abort();
  };
}
