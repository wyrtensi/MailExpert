import { query, withTransaction } from './db.js';
import { decrypt } from './encryption.js';
import { sanitizeSignature } from './emailSanitizer.js';
import { insertAuditEntries } from './auditLog.js';
import { ensureFreshOAuthAccount, OAuthTokenError } from './oauth/tokenManager.js';
import { PROVIDER_FETCH_TIMEOUT_MS } from './oauth/constants.js';
import { SYSTEM_ACTOR } from './mailNode/domains.js';
import { pluginRegistry } from '../plugins/registry.js';

// Gmail "send mail as" import: reading users.settings.sendAs.list with the mailbox's OAuth token,
// planning which account_aliases rows to create, update, adopt or remove (pure), and applying the
// plan in one transaction with a journal entry (syncGmailSendAs).

export const GMAIL_SEND_AS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs';

export class GmailSendAsError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'GmailSendAsError';
    this.code = code;
    this.status = status;
  }
}

function codeForStatus(status) {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return 'upstream';
}

// Never put the token, the Authorization header or the response body into an error message.
export async function fetchGmailSendAs({ accessToken, signal } = {}) {
  let res;
  try {
    res = await fetch(GMAIL_SEND_AS_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
  } catch {
    throw new GmailSendAsError('upstream', null, 'Gmail send-as request failed (network error)');
  }
  if (!res.ok) {
    throw new GmailSendAsError(codeForStatus(res.status), res.status, `Gmail send-as request failed (HTTP ${res.status})`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new GmailSendAsError('bad_response', res.status, 'Gmail send-as response is not valid JSON');
  }
  if (!body || !Array.isArray(body.sendAs)) {
    throw new GmailSendAsError('bad_response', res.status, 'Gmail send-as response has no sendAs array');
  }
  return body.sendAs;
}

const lc = (s) => String(s || '').trim().toLowerCase();
const blank = (v) => (v == null || v === '' ? null : v);

function toFields(entry) {
  const email = String(entry.sendAsEmail).trim();
  const displayName = typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
  return {
    name: displayName || email.split('@')[0],
    email,
    reply_to: entry.replyToAddress || null,
    // Owner decision: an empty or missing send-as signature is '' (no signature, as in Gmail),
    // never null, which would inherit the mailbox signature.
    signature: (typeof entry.signature === 'string' && entry.signature.trim() ? sanitizeSignature(entry.signature) : '') || '',
  };
}

function sameFields(row, fields) {
  return row.name === fields.name
    && row.email === fields.email
    && blank(row.reply_to) === blank(fields.reply_to)
    && (row.signature ?? null) === fields.signature;
}

export function planSendAsSync({ accountEmail, existing = [], sendAs = [] }) {
  const own = lc(accountEmail);
  const candidates = new Map();
  for (const entry of sendAs) {
    if (!entry || !entry.sendAsEmail || !String(entry.sendAsEmail).trim()) continue;
    if (entry.verificationStatus !== 'accepted' || entry.isPrimary === true) continue;
    const key = lc(entry.sendAsEmail);
    if (key === own || candidates.has(key)) continue;
    candidates.set(key, toFields(entry));
  }

  const gmailRows = new Map();
  const manualRows = new Map();
  for (const row of existing) {
    const key = lc(row.email);
    if (row.source === 'gmail') {
      if (!gmailRows.has(key)) gmailRows.set(key, row);
    } else if (key !== own && !manualRows.has(key)) {
      manualRows.set(key, row);
    }
  }

  const plan = { create: [], update: [], adopt: [], remove: [] };
  for (const [key, fields] of candidates) {
    const g = gmailRows.get(key);
    const m = manualRows.get(key);
    if (g) {
      if (!sameFields(g, fields)) plan.update.push({ id: g.id, fields });
    } else if (m) {
      plan.adopt.push({ id: m.id, fields });
    } else {
      plan.create.push(fields);
    }
  }
  for (const [key, row] of gmailRows) {
    if (!candidates.has(key)) plan.remove.push(row.id);
  }
  return plan;
}

const skipped = (reason) => ({ status: 'skipped', reason });

// One request with its own timeout. A missing token (a corrupted credential) counts as a rejected
// one, so the caller's forced refresh gets a chance before anything goes to Google.
async function fetchWithToken(account) {
  const accessToken = decrypt(account.oauth_access_token);
  if (!accessToken) throw new GmailSendAsError('unauthorized', null, 'Gmail send-as request has no usable access token');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchGmailSendAs({ accessToken, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// The send-as list, refreshing the token when it is near expiry and once more, forced, when Google
// rejects it (401). A refresh failure propagates as its OAuthTokenError.
async function readSendAs(account) {
  const fresh = await ensureFreshOAuthAccount(account);
  try {
    return await fetchWithToken(fresh);
  } catch (err) {
    if (!(err instanceof GmailSendAsError) || err.code !== 'unauthorized') throw err;
    const refreshed = await ensureFreshOAuthAccount(fresh, { force: true });
    return fetchWithToken(refreshed);
  }
}

const ACCOUNT_SQL = `SELECT id, email_address, oauth_provider, oauth_reconnect_required, oauth_app_id,
  oauth_access_token, oauth_refresh_token, oauth_token_expiry FROM email_accounts WHERE id = $1`;

function skipReason(account) {
  if (!account) return 'not_found';
  if (account.oauth_provider !== 'google') return 'not_google';
  if (account.oauth_reconnect_required) return 'reconnect_required';
  return null;
}

// Applies one plan under the account's row lock. The alias rows are read raw (not through
// listAliases, which sanitizes signatures again on read), so a second run with the same Gmail
// answer plans nothing. Order: remove, then update/adopt, then create, so a case change or a
// re-adopted address never meets the unique gmail index on its way.
async function applySendAs(client, accountId, sendAs, actor) {
  const { rows: [account] } = await client.query(
    'SELECT id, email_address, oauth_provider, oauth_reconnect_required FROM email_accounts WHERE id = $1 FOR UPDATE',
    [accountId],
  );
  const reason = skipReason(account);
  if (reason) return skipped(reason);

  const { rows: existing } = await client.query(
    'SELECT id, name, email, reply_to, signature, source FROM account_aliases WHERE account_id = $1 ORDER BY created_at, id',
    [accountId],
  );
  const plan = planSendAsSync({ accountEmail: account.email_address, existing, sendAs });
  const emailById = new Map(existing.map((row) => [row.id, row.email]));

  for (const id of plan.remove) {
    await client.query('DELETE FROM account_aliases WHERE id = $1 AND account_id = $2', [id, accountId]);
  }
  for (const { id, fields } of [...plan.update, ...plan.adopt]) {
    await client.query(
      `UPDATE account_aliases SET name = $1, email = $2, reply_to = $3, signature = $4, source = 'gmail'
        WHERE id = $5 AND account_id = $6`,
      [fields.name, fields.email, fields.reply_to, fields.signature, id, accountId],
    );
  }
  for (const fields of plan.create) {
    await client.query(
      `INSERT INTO account_aliases (account_id, name, email, reply_to, signature, source)
       VALUES ($1, $2, $3, $4, $5, 'gmail')`,
      [accountId, fields.name, fields.email, fields.reply_to, fields.signature],
    );
  }
  const { rows: [stamp] } = await client.query(
    'UPDATE email_accounts SET gmail_send_as_synced_at = NOW() WHERE id = $1 RETURNING gmail_send_as_synced_at',
    [accountId],
  );

  const details = {
    added: plan.create.map((f) => f.email),
    updated: [...plan.update, ...plan.adopt].map(({ fields }) => fields.email),
    removed: plan.remove.map((id) => emailById.get(id)),
  };
  const changed = details.added.length + details.updated.length + details.removed.length > 0;
  if (changed) {
    await insertAuditEntries(client, [{
      action: 'mailbox.aliases_synced',
      accountId,
      accountEmail: account.email_address,
      actorUserId: actor?.userId ?? null,
      actorEmail: actor ? (actor.email ?? null) : SYSTEM_ACTOR,
      details,
    }]);
  }
  return { status: 'synced', ...details, syncedAt: stamp.gmail_send_as_synced_at, changed };
}

// Reads the mailbox's Gmail send-as list and makes its gmail aliases match it. actor: null for the
// system (the hourly job), { userId, email } for a user. The request to Google runs before the
// transaction, so no row lock is held across the network; a failed read changes nothing and
// propagates (GmailSendAsError, or the refresh's OAuthTokenError other than a revoked grant).
export async function syncGmailSendAs(accountId, { actor = null } = {}) {
  const { rows: [account] } = await query(ACCOUNT_SQL, [accountId]);
  const reason = skipReason(account);
  if (reason) return skipped(reason);

  let sendAs;
  try {
    sendAs = await readSendAs(account);
  } catch (err) {
    if (err instanceof OAuthTokenError && err.code === 'oauth_reconnect_required') return skipped('reconnect_required');
    throw err;
  }

  const result = await withTransaction((client) => applySendAs(client, accountId, sendAs, actor));
  if (result.status !== 'synced') return result;
  const { changed, ...synced } = result;
  if (changed) {
    pluginRegistry.runHook('onAccountIdentityChanged', { accountId })
      .catch((err) => console.warn('onAccountIdentityChanged hook failed:', err?.message));
  }
  return synced;
}
