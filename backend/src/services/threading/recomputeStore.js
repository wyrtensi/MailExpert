// Progress of recomputing a mailbox's thread keys after its threading mode changed, one
// thread_recompute row per mailbox (see migration 0064).
const ERROR_MAX_LENGTH = 500;

// Reads the recompute row for one mailbox, or null when no run has ever started.
export async function loadRecompute(query, accountId) {
  const { rows } = await query(
    `SELECT account_id, target_mode, cursor_date, cursor_id, processed, changed, total,
            started_at, finished_at, error, updated_at
       FROM thread_recompute WHERE account_id = $1`,
    [accountId],
  );
  return rows[0] || null;
}

// Starts (or restarts) a run: sets the target mode and total, and clears the cursor, counters,
// error and finished_at left over from any earlier run.
export async function startRecomputeRow(query, accountId, targetMode, total) {
  await query(
    `INSERT INTO thread_recompute (account_id, target_mode, total, processed, changed, cursor_date, cursor_id, started_at, finished_at, error, updated_at)
     VALUES ($1, $2, $3, 0, 0, NULL, NULL, now(), NULL, NULL, now())
     ON CONFLICT (account_id) DO UPDATE
       SET target_mode = EXCLUDED.target_mode, total = EXCLUDED.total, processed = 0, changed = 0,
           cursor_date = NULL, cursor_id = NULL, started_at = now(), finished_at = NULL, error = NULL, updated_at = now()`,
    [accountId, targetMode, total],
  );
}

// Saves how far a run has gotten: the cursor to resume from and the counters seen so far.
// Plain UPDATE: the row always exists by now (startRecomputeRow creates it, carrying the
// NOT NULL target_mode), so there is nothing to insert here — an update of no rows for an
// account that never started a run is the honest no-op outcome.
export async function saveRecomputeCursor(query, accountId, { cursorDate, cursorId, processed, changed }) {
  await query(
    `UPDATE thread_recompute
        SET cursor_date = $2, cursor_id = $3, processed = $4, changed = $5, updated_at = now()
      WHERE account_id = $1`,
    [accountId, cursorDate, cursorId, processed, changed],
  );
}

// Marks a run as complete. The error of an earlier attempt is cleared with it: recomputeState
// reads error before finished_at, so a stale one would keep reporting a failure the run just
// undid. Plain UPDATE, see saveRecomputeCursor for why.
export async function finishRecompute(query, accountId) {
  await query(
    `UPDATE thread_recompute SET finished_at = now(), error = NULL, updated_at = now() WHERE account_id = $1`,
    [accountId],
  );
}

// Clears the error of the run a new pass is continuing (the admin's retry of a failed pass posts
// the same mode, which resumes the stored row instead of starting a fresh one). Without this the
// row would carry the old error while the retry walks the mailbox, and a retry that stopped early
// would keep reporting `error` — which no trigger resumes. Plain UPDATE, see saveRecomputeCursor.
export async function clearRecomputeError(query, accountId) {
  await query(
    `UPDATE thread_recompute SET error = NULL, updated_at = now() WHERE account_id = $1`,
    [accountId],
  );
}

// Records the last failure of a run, bounded so a runaway message never bloats the row.
// Plain UPDATE, see saveRecomputeCursor for why.
export async function recordRecomputeError(query, accountId, message) {
  const text = String(message || 'Unknown error').slice(0, ERROR_MAX_LENGTH);
  await query(
    `UPDATE thread_recompute SET error = $2, updated_at = now() WHERE account_id = $1`,
    [accountId, text],
  );
}

// What the admin panel shows for a mailbox's recompute. `running` comes from process memory; the
// row holds what survives a restart. A row without finished_at and without an error, not running,
// is a run that stopped early (restart, disabled mailbox, a mode switch during the pass) and is
// reported as `paused` — the same word the provider-id backfill uses for its own stopped run:
// the mailbox reconnect continues it, so it is not `idle`, which stays for a mailbox that never
// ran a pass at all.
export function recomputeState({ row = null, running = false } = {}) {
  if (running) {
    const total = row?.total ?? 0;
    const processed = row?.processed ?? 0;
    const percent = total > 0 ? Math.min(100, Math.floor((processed / total) * 100)) : null;
    return { status: 'running', percent, changed: row?.changed ?? null, error: null };
  }
  if (!row) return { status: 'idle', percent: null, changed: null, error: null };
  // error before finished_at on purpose: a failure after an earlier complete run must show.
  if (row.error) return { status: 'error', percent: null, changed: row.changed ?? null, error: row.error };
  if (row.finished_at) return { status: 'done', percent: 100, changed: row.changed ?? null, error: null };
  return { status: 'paused', percent: null, changed: row.changed ?? null, error: null };
}
