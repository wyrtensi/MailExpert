// Recomputes the thread key of a mailbox's stored messages after its mode changed. Every row is
// derived from scratch — the Gmail thread number, else the RFC 5322 chain, else its own
// Message-ID — so a key that only ever existed because of the old subject grouping cannot
// survive, and a group that was glued by subject splits into its real conversations.
import { GMAIL_KEY_PREFIX, THREAD_MODE_GMAIL, ancestorCandidates } from './threadId.js';
import { clearRecomputeError, finishRecompute, loadRecompute, saveRecomputeCursor, startRecomputeRow } from './recomputeStore.js';

export const RECOMPUTE_BATCH_SIZE = 2000;
export const RECOMPUTE_BATCH_DELAY_MS = 200;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// ancestorKeys: Map of Message-ID -> thread key, holding both the keys already stored in the
// database and the ones this pass assigned earlier (a reply must follow its ancestor's NEW key).
export function threadingForRow(row, { mode, ancestorKeys }) {
  if (mode === THREAD_MODE_GMAIL && row.provider_thread_id) {
    return { threadId: `${GMAIL_KEY_PREFIX}${row.provider_thread_id}`, reason: 'gmail-thrid' };
  }
  if (!row.message_id) return { threadId: null, reason: null };
  // Same candidate list computeThreading builds for a live message, including the guard against a
  // row's own Message-ID (see ancestorCandidates).
  const candidates = ancestorCandidates(row.message_id, row.in_reply_to, row.thread_references);
  if (candidates.length === 0) return { threadId: row.message_id, reason: 'new-root' };
  if (ancestorKeys.has(candidates[0])) return { threadId: ancestorKeys.get(candidates[0]), reason: 'rfc-root' };
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (ancestorKeys.has(candidates[i])) return { threadId: ancestorKeys.get(candidates[i]), reason: 'rfc-ancestor' };
  }
  return { threadId: candidates[0], reason: 'rfc-provisional' };
}

// Aggregates only, no per-row walk, so the admin gets an answer in seconds. The two targets are
// written as separate statements rather than branching inside one SQL string.
export async function previewRecompute(query, accountId, targetMode) {
  if (targetMode === THREAD_MODE_GMAIL) {
    const { rows } = await query(
      `SELECT
         count(*)::bigint AS rows,
         -- lower bound: rows whose provider_thread_id already resolved but whose stored key does
         -- not match it yet. A row whose key already matches but whose threading_reason is stale
         -- (e.g. carried over from before gmail-thrid existed) is also written by the pass and is
         -- not counted here — this is a floor on "changing", not the exact count.
         count(*) FILTER (
           WHERE m.provider_thread_id IS NOT NULL
             AND m.thread_id IS DISTINCT FROM $2 || m.provider_thread_id
         )::bigint AS changing,
         -- rows with no threading headers whose stored key is not their own Message-ID: only the
         -- removed subject grouping could have produced that, so recompute must split them
         count(*) FILTER (
           WHERE m.in_reply_to IS NULL AND m.thread_references IS NULL
             AND m.thread_id IS DISTINCT FROM m.message_id
         )::bigint AS subject_only,
         count(DISTINCT m.thread_key)::bigint AS threads_now,
         count(DISTINCT COALESCE($2 || m.provider_thread_id, m.thread_key))::bigint AS threads_after
       FROM messages m
       WHERE m.account_id = $1 AND m.is_deleted = false`,
      [accountId, GMAIL_KEY_PREFIX],
    );
    const row = rows[0];
    return {
      rows: Number(row.rows),
      changing: Number(row.changing),
      subjectOnly: Number(row.subject_only),
      threadsNow: Number(row.threads_now),
      threadsAfter: Number(row.threads_after),
    };
  }

  // rfc target: threads_after is not predictable from SQL alone — a reply's key can depend on
  // an ancestor resolved earlier in the pass — so it is reported as null and the admin panel
  // shows a dash instead.
  const { rows } = await query(
    `SELECT
       count(*)::bigint AS rows,
       -- lower bound: a leftover gmail: key (mode no longer gmail), or a subject-glued row. A row
       -- whose key stays but whose threading_reason changes is also written by the pass and is
       -- not counted here — this is a floor on "changing", not the exact count.
       count(*) FILTER (
         WHERE m.thread_id LIKE $2 || '%'
            OR (m.in_reply_to IS NULL AND m.thread_references IS NULL
                AND m.thread_id IS DISTINCT FROM m.message_id)
       )::bigint AS changing,
       count(*) FILTER (
         WHERE m.in_reply_to IS NULL AND m.thread_references IS NULL
           AND m.thread_id IS DISTINCT FROM m.message_id
       )::bigint AS subject_only,
       count(DISTINCT m.thread_key)::bigint AS threads_now
     FROM messages m
     WHERE m.account_id = $1 AND m.is_deleted = false`,
    [accountId, GMAIL_KEY_PREFIX],
  );
  const row = rows[0];
  return {
    rows: Number(row.rows),
    changing: Number(row.changing),
    subjectOnly: Number(row.subject_only),
    threadsNow: Number(row.threads_now),
    threadsAfter: null,
  };
}

// Selects the next batch after the cursor, oldest first. The cursor is carried forward as
// `date::text`, never the bare `date` column: messages.date is timestamptz with microsecond
// precision, but node-postgres parses a bare timestamptz into a JS Date, which only holds
// milliseconds. A cursor taken from that truncated Date would still be less than the very row it
// came from — `(date, id) > (cursor, id)` would stay true for that row forever, and the pass
// would never terminate (confirmed against a real mailbox: `processed` climbed past 272000 on an
// 8-row mailbox, `changed` stuck at 8, one row selected per batch, forever). `date::text` is
// exact in Postgres, so round-tripping that string back in as an explicit ::timestamptz keeps
// the comparison lossless. The walk assumes `date` itself is never NULL: every write path either
// computes it through imapManager.js's safeDate() (live sync, backfill, the Sent/Draft upserts —
// falls back to `new Date()` rather than ever storing NULL) or copies it verbatim from an
// existing row (insertCopiedSibling, the relocate CTEs in routes/mail.js), whose own date was
// written the same way; see idx_messages_account_date (migration 0066) for the index this
// ordering relies on.
async function selectBatch(query, accountId, cursorDate, cursorId, batchSize) {
  const { rows } = await query(
    `SELECT id, message_id, in_reply_to, thread_references, provider_thread_id, thread_id, threading_reason, date::text AS cursor_date
       FROM messages
      WHERE account_id = $1 AND is_deleted = false
        AND (date, id) > ($2::timestamptz, $3)
      ORDER BY date, id
      LIMIT $4`,
    [accountId, cursorDate, cursorId, batchSize],
  );
  return rows;
}

// Resolves every candidate ancestor Message-ID referenced by the batch to its currently stored
// thread key, in one query — bounded to rows this pass has already walked and written
// (is_deleted = false and at or before the cursor as it stood before this batch). Without that
// bound a row not yet reached, or one that is soft-deleted and will never be reached, would seed
// the map with its old, pre-recompute key — exactly the kind of stale key the recompute exists to
// remove. A candidate that belongs to the current batch itself is resolved through the in-memory
// map instead (see the loop below), not through this query. cursorDate is always the lossless
// text form described above (never a JS Date), hence the explicit ::timestamptz cast here too.
async function resolveAncestors(query, accountId, candidateIds, cursorDate, cursorId) {
  if (candidateIds.length === 0) return [];
  const { rows } = await query(
    `SELECT message_id, thread_id FROM messages
      WHERE account_id = $1 AND message_id = ANY($2) AND thread_id IS NOT NULL
        AND is_deleted = false AND (date, id) <= ($3::timestamptz, $4)`,
    [accountId, candidateIds, cursorDate, cursorId],
  );
  return rows;
}

// A row's own Message-ID is dropped here too (see ancestorCandidates), so a self-referencing
// header never asks the database to resolve a row against itself.
function collectCandidateIds(batch) {
  const ids = new Set();
  for (const row of batch) {
    for (const id of ancestorCandidates(row.message_id, row.in_reply_to, row.thread_references)) ids.add(id);
  }
  return [...ids];
}

// Writes only the rows whose key or reason actually differs, and trusts the database's own
// rowCount for how many changed — not how many were attempted, since the guard clause below is
// the source of truth for what counts as a change.
async function writeBatch(query, accountId, updates) {
  if (updates.length === 0) return 0;
  const { rowCount } = await query(
    `UPDATE messages m
        SET thread_id = v.thread_id, threading_reason = v.reason
       FROM unnest($2::uuid[], $3::text[], $4::text[]) AS v(id, thread_id, reason)
      WHERE m.id = v.id AND m.account_id = $1
        AND (m.thread_id IS DISTINCT FROM v.thread_id OR m.threading_reason IS DISTINCT FROM v.reason)`,
    [accountId, updates.map(u => u.id), updates.map(u => u.threadId), updates.map(u => u.reason)],
  );
  return rowCount ?? 0;
}

// Rows the ordered walk can never reach: `date IS NULL` never satisfies `(date, id) > (cursor,
// id)` — NULL comparisons are never true — so such a row would keep its pre-recompute key forever
// while still counting toward `total`. messages.date has no NOT NULL constraint and historical
// rows predate the write paths that guarantee one (see selectBatch), so the pass cleans them up
// in one tail batch. They have no ordering requirement: nothing resolves through them by date.
async function selectUndated(query, accountId) {
  const { rows } = await query(
    `SELECT id, message_id, in_reply_to, thread_references, provider_thread_id, thread_id, threading_reason
       FROM messages
      WHERE account_id = $1 AND is_deleted = false AND date IS NULL
      ORDER BY id`,
    [accountId],
  );
  return rows;
}

// Derives every row of one batch from scratch and writes the ones that actually change, returning
// how many the database reported as updated. cursorDate/cursorId are the cursor as it stood BEFORE
// this batch: that is the bound resolveAncestors needs to see only rows the pass already committed.
async function rekeyBatch(query, accountId, batch, { targetMode, cursorDate, cursorId }) {
  // Seeded per batch from the database (a previous batch's UPDATE is committed by then, so the
  // seed already reflects this pass's own results), then extended with the current batch's rows as
  // they are computed, since those are not committed yet.
  const ancestorKeys = new Map();
  const resolved = await resolveAncestors(query, accountId, collectCandidateIds(batch), cursorDate, cursorId);
  for (const r of resolved) ancestorKeys.set(r.message_id, r.thread_id);

  const updates = [];
  for (const row of batch) {
    const { threadId, reason } = threadingForRow(row, { mode: targetMode, ancestorKeys });
    if (row.message_id) ancestorKeys.set(row.message_id, threadId);
    if (row.thread_id !== threadId || row.threading_reason !== reason) {
      updates.push({ id: row.id, threadId, reason });
    }
  }
  return writeBatch(query, accountId, updates);
}

export async function runRecompute({
  query, accountId, targetMode, shouldContinue, onProgress = () => {}, pause = async () => {},
  batchSize = RECOMPUTE_BATCH_SIZE,
}) {
  const existing = await loadRecompute(query, accountId);
  const resuming = Boolean(existing) && existing.target_mode === targetMode && !existing.finished_at;

  let cursorDate = '-infinity';
  let cursorId = ZERO_UUID;
  let processed = 0;
  let changed = 0;
  let total;

  if (resuming) {
    total = Number(existing.total);
    processed = Number(existing.processed);
    changed = Number(existing.changed);
    cursorId = existing.cursor_id ?? cursorId;
    // loadRecompute's cursor_date comes back as a JS Date — same millisecond truncation as the
    // messages.date column (see selectBatch) — so it is re-read here as text instead, or a
    // resumed pass would reselect its last row forever too.
    const { rows: cursorRows } = await query(
      `SELECT cursor_date::text AS cursor_date FROM thread_recompute WHERE account_id = $1`,
      [accountId],
    );
    cursorDate = cursorRows[0]?.cursor_date ?? cursorDate;
    // This run replaces whatever stopped the last one — a retry of a failed pass comes through
    // here, since it posts the same mode and therefore resumes rather than starting fresh.
    if (existing.error) await clearRecomputeError(query, accountId);
  } else {
    // Every live row of the mailbox — which is exactly what the pass covers: the ordered walk
    // below, then the undated tail — so `processed` reaches `total` and the percentage reaches 100.
    const { rows } = await query(
      `SELECT count(*)::bigint AS total FROM messages WHERE account_id = $1 AND is_deleted = false`,
      [accountId],
    );
    total = Number(rows[0]?.total ?? 0);
    await startRecomputeRow(query, accountId, targetMode, total);
  }

  for (;;) {
    if (!(await shouldContinue())) return { outcome: 'stopped', processed, changed, total };

    const batch = await selectBatch(query, accountId, cursorDate, cursorId, batchSize);
    if (batch.length === 0) break;

    changed += await rekeyBatch(query, accountId, batch, { targetMode, cursorDate, cursorId });

    processed += batch.length;
    const last = batch[batch.length - 1];
    cursorDate = last.cursor_date;
    cursorId = last.id;
    await saveRecomputeCursor(query, accountId, { cursorDate, cursorId, processed, changed });
    await onProgress({ processed, changed, total });
    await pause();
  }

  // The tail: rows with no date, resolved against the pass's final cursor, i.e. against everything
  // the walk has already written (see selectUndated). The cursor is left where the walk ended, so
  // a pass stopped here resumes with an empty walk and runs the tail again — it is idempotent.
  if (!(await shouldContinue())) return { outcome: 'stopped', processed, changed, total };
  const undated = await selectUndated(query, accountId);
  if (undated.length) {
    changed += await rekeyBatch(query, accountId, undated, { targetMode, cursorDate, cursorId });
    processed += undated.length;
    await saveRecomputeCursor(query, accountId, { cursorDate, cursorId, processed, changed });
    await onProgress({ processed, changed, total });
  }

  await finishRecompute(query, accountId);
  return { outcome: 'done', processed, changed, total };
}
