import { pool, query } from '../db.js';
import { JobError, enqueueJob, registerJobKind } from '../jobQueue.js';
import { callWorker } from './workerClient.js';

// What happens to the worker's side of a managed Proton mailbox once the mailbox is deleted. The
// deletion (services/accounts/deleteAccount.js, the one path for DELETE /api/accounts/:id and an
// abandoned commit) writes a proton_cleanup job in the transaction that deletes the mailbox: one
// job per deleted (native user, address) link, payload { userId, generation, email } read before
// the row goes, never a credential. The job asks the worker to drop that link; the worker removes
// the native user (the local Bridge session, never the Proton account) with its last link, and
// only when no live attempt uses it. A job is retried with the queue's backoff (cap 30 min) until
// the worker answers, so an offline worker leaves the cleanup pending, never lost.
//
// proton_users.cleanup_pending marks a native user whose last link is gone and whose native
// removal has not been confirmed: no endpoint is issued for it (mailEndpoint.js), the reconciler
// skips it (reconcile.js) and no attempt links it again (connections.js). The worker confirms the
// removal only after Bridge's removal event and GetUserList absence ('removed'); until then
// ('removing') the job is retried and the lock stays. A confirmed removal deletes the row, so the
// same native user added again gets a new generation, and a stale job of the old one (generation
// differs or the row is gone) ends as done without touching the worker.
//
// While any cleanup job of a native user is outstanding, no attempt commits a link of that user:
// the generation stays the same while the user keeps other links, so a re-added address could
// otherwise be dropped by the old job. The deletion and the attempt's commit both lock the user's
// row, so that check and the enqueue are serialized.

export const PROTON_CLEANUP_KIND = 'proton_cleanup';
// jobs.max_attempts is an INTEGER column: Number.MAX_SAFE_INTEGER does not fit, this is "never give up".
export const PROTON_CLEANUP_MAX_ATTEMPTS = 2147483647;
const REMOVE_TIMEOUT_MS = 15000;

const OUTSTANDING = `SELECT 1 FROM jobs
  WHERE kind = '${PROTON_CLEANUP_KIND}' AND status IN ('queued', 'running') AND payload->>'userId' = $1`;

// Whether a cleanup of this native user is still outstanding (connections.js refuses a commit).
export async function protonCleanupOutstanding(client, userId) {
  const { rows } = await client.query(`${OUTSTANDING} LIMIT 1`, [userId]);
  return rows.length > 0;
}

// Whether a mailbox has a managed Proton link.
export async function hasProtonLink(accountId, client = { query }) {
  const { rows } = await client.query('SELECT 1 FROM proton_mailbox_links WHERE account_id = $1', [accountId]);
  return rows.length > 0;
}

// Deletes a mailbox that has a managed Proton link and enqueues the cleanup of that link in one
// transaction: a rollback leaves neither, a commit both. client: a dedicated connection (not in a
// transaction) the caller holds, else one is taken from the pool.
export async function deleteLinkedMailbox(account, { client = null } = {}) {
  const connection = client ?? await pool.connect();
  try {
    await connection.query('BEGIN');
    try {
      const { rows: [mailbox] } = await connection.query(
        `SELECT l.proton_user_id, l.generation, lower(btrim(a.email_address)) AS email
           FROM proton_mailbox_links l JOIN email_accounts a ON a.id = l.account_id
          WHERE l.account_id = $1`, [account.id],
      );
      if (mailbox) {
        // Same lock as an attempt's commit (connections.js writeMailbox).
        await connection.query('SELECT 1 FROM proton_users WHERE proton_user_id = $1 FOR UPDATE', [mailbox.proton_user_id]);
        await enqueueJob({
          kind: PROTON_CLEANUP_KIND,
          payload: { userId: mailbox.proton_user_id, generation: mailbox.generation, email: mailbox.email },
          maxAttempts: PROTON_CLEANUP_MAX_ATTEMPTS,
          // A mailbox is deleted once; its ID never comes back.
          dedupeKey: `${PROTON_CLEANUP_KIND}:${account.id}`,
        }, connection);
      }
      await connection.query('DELETE FROM email_accounts WHERE id = $1', [account.id]);
      if (mailbox) {
        await connection.query(
          `UPDATE proton_users SET cleanup_pending = true
            WHERE proton_user_id = $1
              AND NOT EXISTS (SELECT 1 FROM proton_mailbox_links WHERE proton_user_id = $1)`,
          [mailbox.proton_user_id],
        );
      }
      await connection.query('COMMIT');
    } catch (err) {
      await connection.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    if (!client) connection.release();
  }
}

const validPayload = ({ userId, generation, email } = {}) =>
  [userId, generation, email].every(value => typeof value === 'string' && value.length > 0 && value.length <= 320);

export async function runProtonCleanup(job, ctx) {
  const payload = job.payload ?? {};
  if (!validPayload(payload)) throw new JobError('Invalid cleanup payload', { outcome: 'fail', code: 'invalid_payload' });
  const { userId, generation, email } = payload;
  const { rows: [user] } = await query(
    `SELECT generation, cleanup_pending,
            EXISTS (SELECT 1 FROM proton_mailbox_links l WHERE l.proton_user_id = u.proton_user_id) AS linked
       FROM proton_users u WHERE proton_user_id = $1`, [userId],
  );
  // Stale: the user was removed already, or added again under a new generation.
  if (!user || user.generation !== generation) return;
  let result;
  try {
    result = await callWorker('POST', `/users/${userId}/remove`, { generation, email }, { timeoutMs: REMOVE_TIMEOUT_MS });
  } catch (err) {
    // The worker's link carries another generation than the database's: nothing is removed by a
    // guess. Reported on the job; the user stays locked for an operator.
    if (err?.code === 'generation_mismatch') throw new JobError('The worker holds another generation', { outcome: 'fail', code: 'generation_mismatch' });
    throw new JobError(`Proton worker: ${err?.code || 'worker_unavailable'}`, { code: err?.code || 'worker_unavailable' });
  }
  const state = result?.state;
  if (state === 'removed') {
    await ctx.complete(async tx => {
      await tx.query(
        `DELETE FROM proton_users u
          WHERE proton_user_id = $1 AND generation = $2 AND cleanup_pending
            AND NOT EXISTS (SELECT 1 FROM proton_mailbox_links l WHERE l.proton_user_id = u.proton_user_id)`,
        [userId, generation],
      );
    });
    return;
  }
  // Dropped this link; the user keeps other links (or a live attempt) in the worker. While the
  // database still has links, that is the end of this job; with none left the user's removal is
  // still to come, so the job waits for it.
  if (state === 'unlinked' && (user.linked || !user.cleanup_pending)) return;
  if (state === 'unlinked' || state === 'removing') {
    throw new JobError('Native user removal pending', { code: 'removal_pending' });
  }
  throw new JobError('Unexpected worker answer', { code: 'worker_invalid_response' });
}

export function registerProtonJobKinds() {
  registerJobKind(PROTON_CLEANUP_KIND, { handler: runProtonCleanup, maxAttempts: PROTON_CLEANUP_MAX_ATTEMPTS });
}

// Native users left without links and without anything that may still link them: a failed or
// abandoned attempt's row, or a cleanup whose row stayed. Run with the connection sweeper (every
// minute), so it is retried; deleting nothing is the steady state.
export async function pruneOrphanProtonUsers() {
  const { rowCount } = await query(
    `DELETE FROM proton_users u
      WHERE NOT u.cleanup_pending AND u.removal_state IS NULL
        AND NOT EXISTS (SELECT 1 FROM proton_mailbox_links l WHERE l.proton_user_id = u.proton_user_id)
        AND NOT EXISTS (SELECT 1 FROM proton_connections c
                         WHERE c.proton_user_id = u.proton_user_id
                           AND c.state <> ALL ($1)
                           AND (c.state = 'committing' OR c.expires_at > now()))
        AND NOT EXISTS (SELECT 1 FROM jobs j
                         WHERE j.kind = '${PROTON_CLEANUP_KIND}' AND j.status IN ('queued', 'running')
                           AND j.payload->>'userId' = u.proton_user_id)`,
    [['connected', 'failed', 'cancelled', 'expired']],
  );
  return rowCount;
}
