// Progress of the Gmail id backfill, one provider_id_backfill row per mailbox (see migration 0062).
const ERROR_MAX_LENGTH = 500;

export async function loadProviderIdBackfill(query, accountId) {
  const { rows } = await query(
    'SELECT account_id, cursors, finished_at, error, updated_at FROM provider_id_backfill WHERE account_id = $1',
    [accountId],
  );
  return rows[0] || null;
}

export async function saveProviderIdCursor(query, accountId, folder, cursor) {
  await query(
    `INSERT INTO provider_id_backfill (account_id, cursors, updated_at)
     VALUES ($1, jsonb_build_object($2::text, $3::jsonb), now())
     ON CONFLICT (account_id) DO UPDATE
       SET cursors = provider_id_backfill.cursors || EXCLUDED.cursors, updated_at = now()`,
    [accountId, folder, JSON.stringify(cursor)],
  );
}

export async function markProviderIdBackfillFinished(query, accountId) {
  await query(
    `INSERT INTO provider_id_backfill (account_id, finished_at, error, updated_at)
     VALUES ($1, now(), NULL, now())
     ON CONFLICT (account_id) DO UPDATE SET finished_at = now(), error = NULL, updated_at = now()`,
    [accountId],
  );
}

export async function recordProviderIdBackfillError(query, accountId, message) {
  const text = String(message || 'Unknown error').slice(0, ERROR_MAX_LENGTH);
  await query(
    `INSERT INTO provider_id_backfill (account_id, error, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (account_id) DO UPDATE SET error = EXCLUDED.error, updated_at = now()`,
    [accountId, text],
  );
}

// What the admin panel shows for a Gmail mailbox. `running` and `progress` come from process
// memory; the row holds what survives a restart. A row without finished_at and without an error
// is a run that stopped early (cooldown, disabled mailbox, restart) and resumes on its own.
export function providerIdBackfillState({ row = null, running = false, progress = null } = {}) {
  if (running) {
    const percent = progress?.total > 0
      ? Math.min(100, Math.floor((progress.processed / progress.total) * 100))
      : null;
    return { status: 'running', percent, error: null };
  }
  if (!row) return { status: 'not_started', percent: null, error: null };
  if (row.error) return { status: 'error', percent: null, error: row.error };
  if (row.finished_at) return { status: 'done', percent: 100, error: null };
  return { status: 'paused', percent: null, error: null };
}
