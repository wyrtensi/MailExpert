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
export async function saveRecomputeCursor(query, accountId, { cursorDate, cursorId, processed, changed }) {
  await query(
    `INSERT INTO thread_recompute (account_id, cursor_date, cursor_id, processed, changed, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (account_id) DO UPDATE
       SET cursor_date = EXCLUDED.cursor_date, cursor_id = EXCLUDED.cursor_id, processed = EXCLUDED.processed,
           changed = EXCLUDED.changed, updated_at = now()`,
    [accountId, cursorDate, cursorId, processed, changed],
  );
}

// Marks a run as complete.
export async function finishRecompute(query, accountId) {
  await query(
    `INSERT INTO thread_recompute (account_id, finished_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (account_id) DO UPDATE SET finished_at = now(), updated_at = now()`,
    [accountId],
  );
}

// Records the last failure of a run, bounded so a runaway message never bloats the row.
export async function recordRecomputeError(query, accountId, message) {
  const text = String(message || 'Unknown error').slice(0, ERROR_MAX_LENGTH);
  await query(
    `INSERT INTO thread_recompute (account_id, error, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (account_id) DO UPDATE SET error = EXCLUDED.error, updated_at = now()`,
    [accountId, text],
  );
}

// What the admin panel shows for a mailbox's recompute. `running` comes from process memory; the
// row holds what survives a restart. A row without finished_at and without an error, not running,
// is a run that stopped early (restart, disabled mailbox) and has not been resumed yet.
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
  return { status: 'idle', percent: null, changed: row.changed ?? null, error: null };
}
