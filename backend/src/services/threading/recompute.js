// Recomputes the thread key of a mailbox's stored messages after its mode changed. Every row is
// derived from scratch — the Gmail thread number, else the RFC 5322 chain, else its own
// Message-ID — so a key that only ever existed because of the old subject grouping cannot
// survive, and a group that was glued by subject splits into its real conversations.
import { GMAIL_KEY_PREFIX, THREAD_MODE_GMAIL, parseReferences } from './threadId.js';
import { finishRecompute, loadRecompute, saveRecomputeCursor, startRecomputeRow } from './recomputeStore.js';

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
  const candidates = parseReferences(row.thread_references);
  if (row.in_reply_to && !candidates.includes(row.in_reply_to)) candidates.push(row.in_reply_to);
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
         -- rows whose provider_thread_id already resolved but whose stored key does not match it yet
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
       -- rows that will change: a leftover gmail: key (mode no longer gmail), or a subject-glued row
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

// Selects the next batch after the cursor, oldest first.
async function selectBatch(query, accountId, cursorDate, cursorId) {
  const { rows } = await query(
    `SELECT id, message_id, in_reply_to, thread_references, provider_thread_id, thread_id, threading_reason, date
       FROM messages
      WHERE account_id = $1 AND is_deleted = false
        AND (date, id) > ($2, $3)
      ORDER BY date, id
      LIMIT $4`,
    [accountId, cursorDate, cursorId, RECOMPUTE_BATCH_SIZE],
  );
  return rows;
}

// Resolves every candidate ancestor Message-ID referenced by the batch to its currently stored
// thread key, in one query.
async function resolveAncestors(query, accountId, candidateIds) {
  if (candidateIds.length === 0) return [];
  const { rows } = await query(
    `SELECT message_id, thread_id FROM messages
      WHERE account_id = $1 AND message_id = ANY($2) AND thread_id IS NOT NULL`,
    [accountId, candidateIds],
  );
  return rows;
}

function collectCandidateIds(batch) {
  const ids = new Set();
  for (const row of batch) {
    for (const ref of parseReferences(row.thread_references)) ids.add(ref);
    if (row.in_reply_to) ids.add(row.in_reply_to);
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

export async function runRecompute({
  query, accountId, targetMode, shouldContinue, onProgress = () => {}, pause = async () => {},
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
    cursorDate = existing.cursor_date ?? cursorDate;
    cursorId = existing.cursor_id ?? cursorId;
  } else {
    const { rows } = await query(
      `SELECT count(*)::bigint AS total FROM messages WHERE account_id = $1 AND is_deleted = false`,
      [accountId],
    );
    total = Number(rows[0]?.total ?? 0);
    await startRecomputeRow(query, accountId, targetMode, total);
  }

  // Survives across batches; cleared and re-seeded at the start of each one (see resolveAncestors
  // and the loop below) so it never grows unbounded and always reflects this pass's own progress.
  const ancestorKeys = new Map();

  for (;;) {
    if (!(await shouldContinue())) return { outcome: 'stopped', processed, changed, total };

    const batch = await selectBatch(query, accountId, cursorDate, cursorId);
    if (batch.length === 0) break;

    ancestorKeys.clear();
    const resolved = await resolveAncestors(query, accountId, collectCandidateIds(batch));
    for (const r of resolved) ancestorKeys.set(r.message_id, r.thread_id);

    const updates = [];
    for (const row of batch) {
      const { threadId, reason } = threadingForRow(row, { mode: targetMode, ancestorKeys });
      if (row.message_id) ancestorKeys.set(row.message_id, threadId);
      if (row.thread_id !== threadId || row.threading_reason !== reason) {
        updates.push({ id: row.id, threadId, reason });
      }
    }

    changed += await writeBatch(query, accountId, updates);

    processed += batch.length;
    const last = batch[batch.length - 1];
    cursorDate = last.date;
    cursorId = last.id;
    await saveRecomputeCursor(query, accountId, { cursorDate, cursorId, processed, changed });
    onProgress({ processed, changed, total });
    await pause();
  }

  await finishRecompute(query, accountId);
  return { outcome: 'done', processed, changed, total };
}
