import { query } from '../db.js';
import { encrypt } from '../encryption.js';
import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import { consume } from '../rateLimiter.js';
import { createKeyedSerializer } from '../../utils/keyedSerializer.js';
import { reconnectAccount, withAccountAddressLock } from '../accounts/connection.js';
import { ConnectionError } from '../accounts/connectionErrors.js';
import { CREATION_REQUEST_ID, withCreationAdmission } from '../accounts/accountCreation.js';
import { persistManualAccount, safeAccount } from '../accounts/manualAccounts.js';
import { callWorker } from './workerClient.js';
import { isProtonApiReachable } from './apiReachability.js';
import {
  PROTON_LOOPBACK_HOST, PROTON_PORTS, ProtonEndpointError, probeManagedProtonConnection, trustedProtonEndpoint,
} from './mailEndpoint.js';

// Connecting a managed Proton mailbox through the worker (deploy/proton-worker). One row of
// proton_connections is one attempt of one employee, keyed by (employee, request UUID): a repeated
// request answers that row and never starts a second native login. The main Proton password and a
// 2FA code or second password go to the worker inside the request that carries them and are kept
// nowhere. The worker is event driven, so a poll moves the attempt on: once Bridge holds the
// native user, both protocols are probed, the mailbox and its link are written in one transaction
// (state 'committing'), and only then does the worker record the link (state 'connected'). A
// 'committing' row left by a crash or a worker outage is committed again later, idempotently.
//
// States: starting, authenticating, needs_2fa, needs_second_password, checking, committing (shown
// as checking), connected, failed, cancelled, expired.

export const PROTON_CONNECTION_TTL_MS = 600000;
// Task 11 polls once a second; room for a second tab or an administrator watching.
const POLLS_PER_MINUTE = 300;
const POLL_TIMEOUT_MS = 5000;
const LOGIN_TIMEOUT_MS = 20000;
const COMMIT_TIMEOUT_MS = 15000;
// Task 2 probes take up to 35 s; the credentials call and the commit fit in the rest.
const FINALIZE_BUDGET_MS = 60000;

const WORKER_LIVE = ['authenticating', 'needs_2fa', 'needs_second_password'];
const PRE_COMMIT = ['starting', ...WORKER_LIVE, 'checking'];
const CHALLENGES = Object.freeze({ '2fa': 'needs_2fa', second_password: 'needs_second_password' });
const PUBLIC_STATE = Object.freeze({ starting: 'authenticating', committing: 'checking' });
const LOGIN_FAILURES = new Set(['invalid_credentials', 'verification_required', 'address_mismatch', 'login_busy', 'login_failed']);
// The worker no longer holds a committable attempt: the link cannot be recorded there.
const COMMIT_LOST = new Set(['not_connected', 'not_found', 'generation_mismatch', 'operation_conflict']);

const START_FIELDS = new Set(['email', 'password', 'requestId', 'reconnectAccountId', 'name', 'senderName', 'signature', 'color']);
const CONTINUE_FIELDS = new Set(['challenge', 'secret']);
// eslint-disable-next-line no-control-regex
const controls = /[\x00-\x1f\x7f]/;

const refusal = code => ({ error: code, code });
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isUuid = value => typeof value === 'string' && CREATION_REQUEST_ID.test(value);
const isExpired = row => new Date(row.expires_at).getTime() <= Date.now();

// Only these fields reach the service; the request body is never forwarded.
export function parseProtonStart(body) {
  if (!plainObject(body) || !Object.keys(body).every(key => START_FIELDS.has(key))) return refusal('invalid_request');
  const { email, password, requestId, reconnectAccountId } = body;
  if (!boundedText(email, 320) || controls.test(email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return refusal('invalid_request');
  if (!boundedText(password, 1024) || !isUuid(requestId)) return refusal('invalid_request');
  if (reconnectAccountId != null && !isUuid(reconnectAccountId)) return refusal('invalid_request');
  for (const key of ['name', 'senderName', 'color']) {
    if (body[key] != null && (typeof body[key] !== 'string' || body[key].length > 255 || controls.test(body[key]))) return refusal('invalid_request');
  }
  if (body.signature != null && (typeof body.signature !== 'string' || body.signature.length > 20000)) return refusal('invalid_request');
  const input = {
    email: email.trim().toLowerCase(), password, requestId: requestId.toLowerCase(),
    reconnectAccountId: reconnectAccountId ? reconnectAccountId.toLowerCase() : null,
  };
  for (const key of ['name', 'senderName', 'signature', 'color']) if (body[key]) input[key] = key === 'signature' ? body[key] : body[key].trim();
  return { input };
}

export function parseProtonContinue(body) {
  if (!plainObject(body) || !Object.keys(body).every(key => CONTINUE_FIELDS.has(key))) return refusal('invalid_request');
  if (!Object.hasOwn(CHALLENGES, body.challenge) || !boundedText(body.secret, 1024)) return refusal('invalid_request');
  return { input: { challenge: body.challenge, secret: body.secret } };
}

// Per operation, in this process: worker syncs, continue, cancel and the commit section never
// interleave. Across processes the conditional state updates below decide.
const operationQueue = createKeyedSerializer();
// Optional mailbox metadata until the attempt ends; an attempt interrupted by a restart fails.
const metadataById = new Map();
const background = new Map();
let mailEngine = null;

// index.js hands over the backend's mail engine (imapManager) once it exists.
export function setProtonMailEngine(engine) {
  mailEngine = engine;
}

function track(key, work) {
  const settled = Promise.resolve(work).catch(() => {}).finally(() => {
    if (background.get(key) === settled) background.delete(key);
  });
  background.set(key, settled);
  return settled;
}

// Resolves once the background steps started so far (and those they start) have settled.
export async function protonConnectionWork() {
  while (background.size) await Promise.allSettled([...background.values()]);
}

const load = async id => (await query('SELECT * FROM proton_connections WHERE id = $1', [id])).rows[0];

async function update(id, fromStates, { state, errorCode = null }) {
  const { rows: [row] } = await query(
    'UPDATE proton_connections SET state = $3, error_code = $4 WHERE id = $1 AND state = ANY($2) RETURNING *',
    [id, fromStates, state, errorCode],
  );
  return row;
}

async function publicStatus(row) {
  const status = { id: row.id, state: PUBLIC_STATE[row.state] ?? row.state };
  if (row.error_code) status.errorCode = row.error_code;
  if (row.state === 'connected' && row.account_id) {
    const { rows: [account] } = await query(
      `SELECT a.*, EXISTS (SELECT 1 FROM proton_mailbox_links l WHERE l.account_id = a.id) AS proton_managed_link
         FROM email_accounts a WHERE a.id = $1`, [row.account_id],
    );
    if (account) {
      status.account = safeAccount({
        ...account,
        can_reconnect_proton: account.mail_provider === 'proton' && account.connection_mode === 'managed' && account.proton_managed_link === true,
      });
    }
  }
  return status;
}

const auditActor = row => ({ userId: row.actor_user_id });
function auditFailure(row, code) {
  recordAudit(auditOf(auditActor(row), {
    accountEmail: row.requested_email, action: 'mailbox.connection_failed', details: { provider: 'proton', mode: 'managed', code },
  }));
}

async function cancelWorkerOperation(id) {
  try { await callWorker('POST', `/connections/${id}/cancel`, undefined, { timeoutMs: POLL_TIMEOUT_MS }); }
  catch { /* The worker ends an attempt nobody commits at its own TTL. */ }
}

// Ends a not yet committed attempt. The worker attempt is cancelled where it may still live: the
// worker then removes the native user only if this attempt created it.
async function fail(row, code, { cancelWorker = false } = {}) {
  const failed = await update(row.id, PRE_COMMIT, { state: 'failed', errorCode: code });
  if (!failed) return load(row.id);
  metadataById.delete(row.id);
  auditFailure(row, code);
  if (cancelWorker) await cancelWorkerOperation(row.id);
  return failed;
}

async function expire(row) {
  const expired = await update(row.id, PRE_COMMIT, { state: 'expired' });
  if (!expired) return load(row.id);
  metadataById.delete(row.id);
  auditFailure(row, 'expired');
  await cancelWorkerOperation(row.id);
  return expired;
}

const workerFailure = err => (err?.code === 'login_busy' ? 'login_busy' : 'proton_unavailable');

// Bridge reports a missing network as a wrong password, so a refused login is a connection
// failure when the Proton API does not answer at all.
async function loginFailure(code) {
  if (code === 'invalid_credentials' && !(await isProtonApiReachable())) return 'connection';
  return LOGIN_FAILURES.has(code) ? code : 'proton_unavailable';
}

function probeFailure(err) {
  if (err?.code === 'proton_identity_mismatch') return 'address_mismatch';
  if (err instanceof ConnectionError || new ConnectionError(err?.code).code === err?.code) return new ConnectionError(err.code).code;
  return 'proton_unavailable';
}

// The address must be free, unless this is an explicit reconnect of the managed mailbox that has
// it. Any approved employee may reconnect; who added the mailbox does not matter.
function addressRefusal(row) {
  return withAccountAddressLock(row.requested_email, async client => {
    const { rows } = await client.query(
      `SELECT a.id, a.mail_provider, a.connection_mode,
              EXISTS (SELECT 1 FROM proton_mailbox_links l WHERE l.account_id = a.id) AS linked
         FROM email_accounts a WHERE lower(btrim(a.email_address)) = $1`, [row.requested_email],
    );
    if (!row.reconnect_intent) return rows.length ? 'already_connected' : null;
    const target = rows.find(account => account.id === row.reconnect_account_id);
    if (target && target.mail_provider === 'proton' && target.connection_mode === 'managed' && target.linked) return null;
    return rows.length ? 'already_connected' : 'reconnect_unavailable';
  });
}

export async function startProtonConnection(input, actor) {
  const parsed = parseProtonStart(input);
  if (parsed.error || !actor?.userId) return refusal('invalid_request');
  const request = parsed.input;
  const existing = await findAttempt(actor.userId, request.requestId);
  if (existing) return replay(existing, request);
  const admitted = await withCreationAdmission(actor, async () => {
    const { rows: [row] } = await query(
      `INSERT INTO proton_connections (actor_user_id, request_id, requested_email, state, reconnect_intent, reconnect_account_id, expires_at)
       VALUES ($1, $2, $3, 'starting', $4, (SELECT id FROM email_accounts WHERE id = $5), $6)
       ON CONFLICT (actor_user_id, request_id) DO NOTHING RETURNING *`,
      [actor.userId, request.requestId, request.email, !!request.reconnectAccountId, request.reconnectAccountId,
        new Date(Date.now() + PROTON_CONNECTION_TTL_MS)],
    );
    if (!row) return { replay: await findAttempt(actor.userId, request.requestId) };
    metadataById.set(row.id, { name: request.name, senderName: request.senderName, signature: request.signature, color: request.color });
    return { row: await operationQueue(row.id, () => beginLogin(row, request.password)) };
  });
  if (admitted.error) return refusal(admitted.code === 'rate_limited' ? 'rate_limited' : 'proton_unavailable');
  if (admitted.replay) return replay(admitted.replay, request);
  return publicStatus(admitted.row);
}

const findAttempt = async (actorId, requestId) => (await query(
  'SELECT * FROM proton_connections WHERE actor_user_id = $1 AND request_id = $2', [actorId, requestId],
)).rows[0];

function replay(row, request) {
  if (row.requested_email !== request.email || row.reconnect_intent !== !!request.reconnectAccountId) return refusal('idempotency_conflict');
  return publicStatus(row);
}

async function beginLogin(row, password) {
  let code;
  try { code = await addressRefusal(row); }
  catch { code = 'proton_unavailable'; }
  if (code) return fail(row, code);
  let operation;
  try {
    operation = await callWorker('POST', '/connections', { operationId: row.id, email: row.requested_email, password }, { timeoutMs: LOGIN_TIMEOUT_MS });
  } catch (err) {
    // A call that failed in transit may still have reached Bridge: end the attempt there too.
    const failure = workerFailure(err);
    return fail(row, failure, { cancelWorker: failure !== 'login_busy' });
  }
  return applyWorkerOperation(row, operation);
}

async function applyWorkerOperation(row, operation) {
  const from = ['starting', ...WORKER_LIVE];
  const move = async (state, errorCode = null) => {
    if (row.state === state && (row.error_code ?? null) === errorCode) return row;
    return (await update(row.id, from, { state, errorCode })) ?? load(row.id);
  };
  switch (operation?.state) {
    case 'starting': case 'authenticating': case 'checking':
      return move('authenticating');
    case 'needs_2fa': case 'needs_second_password':
      return move(operation.state, operation.errorCode === 'invalid_challenge' ? 'invalid_challenge' : null);
    case 'failed':
      return fail(row, await loginFailure(operation.errorCode));
    case 'cancelled': case 'expired': {
      const ended = await update(row.id, PRE_COMMIT, { state: operation.state });
      if (ended) metadataById.delete(row.id);
      return ended ?? load(row.id);
    }
    case 'connected':
      if (typeof operation.userId !== 'string' || !operation.userId) return fail(row, 'proton_unavailable', { cancelWorker: true });
      return beginFinalize(row, operation.userId);
    default:
      return fail(row, 'proton_unavailable', { cancelWorker: true });
  }
}

async function beginFinalize(row, nativeUserId) {
  if (row.reconnect_intent) {
    // A reconnect must sign in the native user the mailbox is linked to.
    const { rows: [link] } = await query('SELECT proton_user_id FROM proton_mailbox_links WHERE account_id = $1', [row.reconnect_account_id]);
    if (!link || link.proton_user_id !== nativeUserId) return fail(row, 'reconnect_mismatch', { cancelWorker: true });
  }
  if (!background.has(row.id)) track(row.id, finalize(row, nativeUserId));
  return row;
}

// Probe and commit under the owner's creation admission (no attempt spent): the snapshot gate
// waits for it. A refused admission leaves the attempt as it is; the next poll tries again.
function finalize(row, nativeUserId) {
  return withCreationAdmission(auditActor(row), async () => {
    // The operation's native user must exist as a row before the operation names it (FK).
    await query('INSERT INTO proton_users (proton_user_id, creator_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [nativeUserId, row.actor_user_id]);
    const { rows: [checking] } = await query(
      `UPDATE proton_connections SET state = 'checking', error_code = NULL, proton_user_id = $2
        WHERE id = $1 AND state = ANY($3) AND expires_at > now() RETURNING *`,
      [row.id, nativeUserId, ['starting', ...WORKER_LIVE]],
    );
    if (!checking) return;
    const signal = AbortSignal.timeout(FINALIZE_BUDGET_MS);
    let logins, material;
    try {
      logins = await probeManagedProtonConnection(row.id, { signal });
      // The probe keeps the credentials to itself; the ones to store are asked for again.
      material = await callWorker('POST', `/users/${nativeUserId}/credentials`, { operationId: row.id }, { signal, timeoutMs: COMMIT_TIMEOUT_MS });
      if (material?.userId !== nativeUserId || String(material.email ?? '').trim().toLowerCase() !== checking.requested_email
        || typeof material.bridgePassword !== 'string' || !material.bridgePassword) {
        throw new ProtonEndpointError('proton_identity_mismatch');
      }
      trustedProtonEndpoint(material, 'imap');
    } catch (err) {
      const code = probeFailure(err);
      return operationQueue(row.id, () => failChecking(row.id, code));
    }
    return operationQueue(row.id, () => commitAccount(checking, logins, material));
  }, { spendAttempt: false });
}

async function failChecking(id, code) {
  const row = await load(id);
  if (row?.state !== 'checking') return row;
  return isExpired(row) ? expire(row) : fail(row, code, { cancelWorker: true });
}

async function commitAccount(checking, logins, material) {
  let outcome;
  try {
    outcome = await withAccountAddressLock(checking.requested_email, async client => {
      await client.query('BEGIN');
      try {
        const result = await writeMailbox(client, checking, logins, material);
        await client.query(result.row ? 'COMMIT' : 'ROLLBACK');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  } catch {
    outcome = { code: 'proton_unavailable' };
  }
  if (outcome.stale) {
    const row = await load(checking.id);
    return row?.state === 'checking' && isExpired(row) ? expire(row) : row;
  }
  if (outcome.code) return fail(await load(checking.id), outcome.code, { cancelWorker: true });
  return commitWorker(outcome.row, outcome);
}

// One transaction: the operation is re-read under a row lock (cancel, expiry, owner and native
// user may have changed since the probe), the address is re-checked, then the mailbox and its
// link are written and the operation becomes 'committing'.
async function writeMailbox(client, checking, logins, material) {
  const { rows: [op] } = await client.query(
    'SELECT *, expires_at > now() AS live FROM proton_connections WHERE id = $1 FOR UPDATE', [checking.id],
  );
  if (!op || op.state !== 'checking' || !op.live || op.actor_user_id !== checking.actor_user_id
    || op.proton_user_id !== checking.proton_user_id) return { stale: true };
  const nativeUserId = op.proton_user_id;
  const { rows: [nativeUser] } = await client.query(
    'SELECT generation, cleanup_pending, removal_state FROM proton_users WHERE proton_user_id = $1 FOR UPDATE', [nativeUserId],
  );
  // A native user being cleaned up (Task 8) is not linked again until that has finished.
  if (!nativeUser || nativeUser.cleanup_pending || nativeUser.removal_state) return { code: 'proton_unavailable' };
  const certificate = [material.certificatePem, material.certificateFingerprint, material.tlsServername];
  let accountId, previousGeneration = null;
  if (op.reconnect_intent) {
    const { rows: [target] } = await client.query(
      `SELECT a.id, l.generation FROM email_accounts a JOIN proton_mailbox_links l ON l.account_id = a.id
        WHERE a.id = $1 AND l.proton_user_id = $2 AND a.mail_provider = 'proton' AND a.connection_mode = 'managed'
          AND lower(btrim(a.email_address)) = $3
        FOR UPDATE OF a`, [op.reconnect_account_id, nativeUserId, op.requested_email],
    );
    if (!target) return { code: 'reconnect_mismatch' };
    const secret = encrypt(material.bridgePassword);
    await client.query(
      'UPDATE email_accounts SET auth_user = $2, auth_pass = $3, smtp_auth_user = $4, smtp_auth_pass = $3 WHERE id = $1',
      [target.id, logins.imapLogin, secret, logins.smtpLogin],
    );
    await client.query(
      `UPDATE proton_mailbox_links SET generation = $2, certificate_pem = $3, certificate_fingerprint = $4, tls_servername = $5
        WHERE account_id = $1`, [target.id, nativeUser.generation, ...certificate],
    );
    accountId = target.id;
    if (target.generation !== nativeUser.generation) previousGeneration = target.generation;
  } else {
    const { rows: taken } = await client.query('SELECT 1 FROM email_accounts WHERE lower(btrim(email_address)) = $1 LIMIT 1', [op.requested_email]);
    if (taken.length) return { code: 'already_connected' };
    const metadata = metadataById.get(op.id) ?? {};
    const created = await persistManualAccount({
      name: metadata.name || op.requested_email, sender_name: metadata.senderName || null, email_address: op.requested_email,
      color: metadata.color || '#6366f1', signature: metadata.signature || null, protocol: 'imap',
      imap_host: PROTON_LOOPBACK_HOST, imap_port: PROTON_PORTS.imap, smtp_host: PROTON_LOOPBACK_HOST, smtp_port: PROTON_PORTS.smtp,
      smtp_tls: 'SSL', imap_skip_tls_verify: false, auth_user: logins.imapLogin, auth_pass: material.bridgePassword,
      smtp_auth_user: logins.smtpLogin, smtp_auth_pass: material.bridgePassword,
    }, auditActor(op), { client, provider: 'proton', mode: 'managed', imapTlsMode: 'implicit', audit: false });
    if (created.error) return { code: created.error };
    await client.query(
      `INSERT INTO proton_mailbox_links (account_id, proton_user_id, generation, certificate_pem, certificate_fingerprint, tls_servername)
       VALUES ($1, $2, $3, $4, $5, $6)`, [created.account.id, nativeUserId, nativeUser.generation, ...certificate],
    );
    accountId = created.account.id;
  }
  const { rows: [row] } = await client.query(
    `UPDATE proton_connections SET state = 'committing', account_id = $2 WHERE id = $1 RETURNING *`, [op.id, accountId],
  );
  return { row, generation: nativeUser.generation, previousGeneration };
}

// The worker records the link only after the SQL commit. A transient failure leaves the row
// 'committing' for a later poll, the sweeper or the next start.
async function commitWorker(row, { generation, previousGeneration = null, timeoutMs = COMMIT_TIMEOUT_MS } = {}) {
  let linkGeneration = generation;
  if (!linkGeneration) {
    const { rows: [link] } = await query('SELECT generation FROM proton_mailbox_links WHERE account_id = $1', [row.account_id]);
    if (!link) return abandonCommit(row);
    linkGeneration = link.generation;
  }
  try {
    await callWorker('POST', `/connections/${row.id}/commit`, {
      userId: row.proton_user_id, generation: linkGeneration, ...(previousGeneration ? { previousGeneration } : {}),
    }, { timeoutMs });
  } catch (err) {
    return COMMIT_LOST.has(err?.code) ? abandonCommit(row) : row;
  }
  const connected = await update(row.id, ['committing'], { state: 'connected' });
  if (!connected) return load(row.id);
  metadataById.delete(row.id);
  recordAudit(auditOf(auditActor(connected), {
    accountId: connected.account_id, action: connected.reconnect_intent ? 'mailbox.reconnected' : 'mailbox.added',
    details: { provider: 'proton', mode: 'managed', protocol: 'imap' },
  }));
  connectMailbox(connected);
  return connected;
}

// The worker lost the attempt before recording the link (its TTL, a cancel, a removal): a new
// mailbox without a native session is taken back; a reconnected mailbox keeps its row.
async function abandonCommit(row) {
  let ended;
  try {
    ended = await withAccountAddressLock(row.requested_email, async client => {
      await client.query('BEGIN');
      try {
        const { rows: [op] } = await client.query(
          `UPDATE proton_connections SET state = 'failed', error_code = 'proton_unavailable'
            WHERE id = $1 AND state = 'committing' RETURNING *`, [row.id],
        );
        if (op && !op.reconnect_intent && op.account_id) await client.query('DELETE FROM email_accounts WHERE id = $1', [op.account_id]);
        await client.query('COMMIT');
        return op;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  } catch {
    return row;
  }
  if (!ended) return load(row.id);
  metadataById.delete(row.id);
  auditFailure(row, 'proton_unavailable');
  return ended;
}

function connectMailbox(row) {
  if (!mailEngine || !row.account_id) return;
  track(Symbol('connect'), row.reconnect_intent
    ? reconnectAccount(mailEngine, row.account_id)
    : query('SELECT * FROM email_accounts WHERE id = $1', [row.account_id])
      .then(({ rows: [account] }) => account && mailEngine.connectAccount(account)));
}

const retryCommit = row => withCreationAdmission(auditActor(row), () => commitWorker(row, { timeoutMs: POLL_TIMEOUT_MS }), { spendAttempt: false })
  .then(result => (result?.error ? row : result));

// One poll: follow the worker while the login runs, retry a pending worker commit, end what expired.
async function sync(row) {
  if (!row || !PRE_COMMIT.includes(row.state) && row.state !== 'committing') return row;
  if (row.state === 'committing') return retryCommit(row);
  if (row.state === 'starting' || row.state === 'checking') return row;
  if (isExpired(row)) return expire(row);
  let operation;
  try {
    operation = await callWorker('GET', `/connections/${row.id}`, undefined, { timeoutMs: POLL_TIMEOUT_MS });
  } catch (err) {
    return err?.code === 'not_found' ? fail(row, 'proton_unavailable') : row;
  }
  return applyWorkerOperation(row, operation);
}

// Status for its owner or an administrator; anyone else gets not_found. Polls have their own
// bound and never spend the password-attempt bucket.
export async function getProtonConnection(id, actor) {
  if (!isUuid(id) || !actor?.userId) return refusal('not_found');
  const row = await load(id);
  if (!row || (row.actor_user_id !== actor.userId && actor.isAdmin !== true)) return refusal('not_found');
  const rate = await consume(`proton-poll:${actor.userId}`, POLLS_PER_MINUTE, 60000);
  if (rate.limited) return refusal('rate_limited');
  return publicStatus(await operationQueue(id, async () => sync(await load(id))));
}

export async function continueProtonConnection(id, input, actor) {
  if (!isUuid(id) || !actor?.userId) return refusal('not_found');
  const parsed = parseProtonContinue(input);
  if (parsed.error) return refusal('invalid_request');
  const { challenge, secret } = parsed.input;
  const row = await load(id);
  if (!row || row.actor_user_id !== actor.userId) return refusal('not_found');
  if (row.state !== CHALLENGES[challenge]) return refusal('invalid_challenge');
  const admitted = await withCreationAdmission(actor, () => operationQueue(id, async () => {
    const current = await load(id);
    if (current.state !== CHALLENGES[challenge]) return { refused: 'invalid_challenge' };
    if (isExpired(current)) return { row: await expire(current) };
    let operation;
    try {
      operation = await callWorker('POST', `/connections/${id}/continue`, { challenge, secret }, { timeoutMs: LOGIN_TIMEOUT_MS });
    } catch (err) {
      if (err?.code === 'invalid_challenge') return { refused: 'invalid_challenge' };
      const failure = workerFailure(err);
      return { row: await fail(current, failure, { cancelWorker: failure !== 'login_busy' }) };
    }
    return { row: await applyWorkerOperation(current, operation) };
  }));
  if (admitted.error) return refusal(admitted.code === 'rate_limited' ? 'rate_limited' : 'proton_unavailable');
  if (admitted.refused) return refusal(admitted.refused);
  return publicStatus(admitted.row);
}

// Only the employee who started the attempt cancels it. A committed attempt stays connected.
export async function cancelProtonConnection(id, actor) {
  if (!isUuid(id) || !actor?.userId) return refusal('not_found');
  return operationQueue(id, async () => {
    const row = await load(id);
    if (!row || row.actor_user_id !== actor.userId) return refusal('not_found');
    if (!PRE_COMMIT.includes(row.state)) return publicStatus(row);
    const cancelled = await update(id, PRE_COMMIT, { state: 'cancelled' });
    if (!cancelled) return publicStatus(await load(id));
    metadataById.delete(id);
    auditFailure(row, 'cancelled');
    await cancelWorkerOperation(id);
    return publicStatus(cancelled);
  });
}

// At start, before requests: attempts this process can no longer follow (their metadata and
// probes were in memory) fail safely and are cancelled in the worker; commits interrupted between
// the SQL commit and the worker commit are completed.
export async function reconcileProtonConnectionsAtStartup() {
  const { rows: interrupted } = await query(
    `UPDATE proton_connections SET state = 'failed', error_code = 'proton_unavailable'
      WHERE state = ANY($1) RETURNING *`, [PRE_COMMIT],
  );
  for (const row of interrupted) auditFailure(row, 'proton_unavailable');
  const { rows: committing } = await query(`SELECT id FROM proton_connections WHERE state = 'committing'`);
  track(Symbol('startup'), (async () => {
    for (const row of interrupted) await cancelWorkerOperation(row.id);
    for (const { id } of committing) await operationQueue(id, async () => sync(await load(id)));
  })());
}

// Every minute: retry pending worker commits and end attempts nobody polls any more.
export async function sweepProtonConnections() {
  const { rows } = await query(
    `SELECT id FROM proton_connections
      WHERE state = 'committing' OR (state = ANY($1) AND expires_at <= now())`, [WORKER_LIVE],
  );
  for (const { id } of rows) await operationQueue(id, async () => sync(await load(id)));
}

export function startProtonConnectionSweeper({ intervalMs = 60000 } = {}) {
  const timer = setInterval(() => { track(Symbol('sweep'), sweepProtonConnections()); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
