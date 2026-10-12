import { query } from '../db.js';
import { consume } from '../rateLimiter.js';
import { probeConnection } from './connectionProbe.js';
import { ConnectionError } from './connectionErrors.js';
import { withAccountAddressLock } from './connection.js';
import { persistManualAccount } from './manualAccounts.js';
import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';

export const CREATION_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refusal = code => ({ error: code, code });
const safeFailure = err => new ConnectionError(err?.code).code;

// The session lock covers duplicate checks, probing and commit, but no transaction spans the
// network. Request outcomes are durable, scoped to the employee and never contain credentials.
export async function createVerifiedAccount(candidate, actor, { provider, mode, requestId, signal } = {}) {
  if (!actor?.userId || !CREATION_REQUEST_ID.test(requestId || '')) return refusal('invalid_request');
  const email = candidate.email_address.trim().toLowerCase();
  try {
    return await withAccountAddressLock(email, async client => {
      await client.query(
        'INSERT INTO account_creation_requests (actor_user_id, request_id, requested_email, provider, mode) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [actor.userId, requestId, email, provider, mode],
      );
      const { rows: [request] } = await client.query(
        'SELECT * FROM account_creation_requests WHERE actor_user_id = $1 AND request_id = $2', [actor.userId, requestId],
      );
      if (request.requested_email !== email || request.provider !== provider || request.mode !== mode) return refusal('idempotency_conflict');
      if (request.account_id) {
        const { rows: [account] } = await client.query('SELECT * FROM email_accounts WHERE id = $1', [request.account_id]);
        return account ? { account, replayed: true } : refusal('already_connected');
      }
      if (request.result_code) return refusal(request.result_code === 'connected' ? 'already_connected' : request.result_code);
      const finishFailure = async code => {
        await client.query('UPDATE account_creation_requests SET result_code = $3 WHERE actor_user_id = $1 AND request_id = $2', [actor.userId, requestId, code]);
        recordAudit(auditOf(actor, { accountEmail: email, action: 'mailbox.connection_failed', details: { provider, mode, code } }));
        return refusal(code);
      };
      // The client went away (the route aborts on close): not an outcome of the request, so a
      // retry with the same key probes again instead of replaying the cancellation.
      const abandon = () => {
        recordAudit(auditOf(actor, { accountEmail: email, action: 'mailbox.connection_failed', details: { provider, mode, code: 'connection_cancelled' } }));
        return refusal('connection_cancelled');
      };
      const existing = await client.query('SELECT id FROM email_accounts WHERE lower(btrim(email_address)) = $1 LIMIT 1', [email]);
      if (existing.rows.length) return finishFailure('already_connected');
      return withCreationAdmission(actor, async () => {
        let logins;
        try { logins = await probeConnection(candidate, { signal }); }
        catch (err) { return signal?.aborted ? abandon() : finishFailure(safeFailure(err)); }
        if (signal?.aborted) return abandon();
        await client.query('BEGIN');
        try {
          const result = await persistManualAccount({
            ...candidate, auth_user: logins.imapLogin, smtp_auth_user: logins.smtpLogin,
            imap_skip_tls_verify: false,
          }, actor, { client, provider, mode, imapTlsMode: candidate.imap_tls_mode, audit: false });
          if (result.error) { await client.query('ROLLBACK'); return finishFailure(result.error); }
          await client.query('UPDATE account_creation_requests SET account_id = $3, result_code = $4 WHERE actor_user_id = $1 AND request_id = $2', [actor.userId, requestId, result.account.id, 'connected']);
          await client.query('COMMIT');
          recordAudit(auditOf(actor, { accountId: result.account.id, action: 'mailbox.added', details: { provider, mode, protocol: 'imap' } }));
          return result;
        } catch (err) { await client.query('ROLLBACK'); throw err; }
      });
    }, { signal });
  } catch (err) {
    const code = safeFailure(err);
    recordAudit(auditOf(actor, { accountEmail: email, action: 'mailbox.connection_failed', details: { provider, mode, code } }));
    return refusal(code);
  }
}

// A request ID lives 10 minutes (expires_at); its outcome is kept one more lifetime for a late
// replay, then deleted. The Proton sweeper (services/proton/connections.js) runs this every minute.
export const CREATION_REQUEST_GRACE_MS = 600000;
export async function pruneFinishedCreationRequests({ graceMs = CREATION_REQUEST_GRACE_MS } = {}) {
  const { rowCount } = await query(
    `DELETE FROM account_creation_requests
      WHERE expires_at < now() - make_interval(secs => $1::double precision / 1000)`, [graceMs],
  );
  return rowCount;
}

const running = new Map();
let total = 0;
// Shared with managed onboarding: admission is released only once the owned work has cleaned up.
// A secret attempt (a password, a challenge) spends the per-employee bucket; follow-up work of an
// attempt already admitted (probe, SQL commit, worker commit reconciliation) holds a slot only.
export async function withCreationAdmission(actor, fn, { spendAttempt = true } = {}) {
  const rate = spendAttempt ? await consume(`account-create:${actor.userId}`, 5, 60000) : { limited: false };
  if (rate.limited || (running.get(actor.userId) || 0) >= 2 || total >= 8) return { error: 'rate_limited', code: 'rate_limited' };
  running.set(actor.userId, (running.get(actor.userId) || 0) + 1); total++;
  try { return await fn(); }
  finally {
    total--;
    const count = running.get(actor.userId) - 1;
    if (count) running.set(actor.userId, count); else running.delete(actor.userId);
  }
}
