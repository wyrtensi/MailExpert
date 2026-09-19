// Loads Gmail's X-GM-THRID / X-GM-MSGID for cached messages that were stored without them:
// rows synced before migration 0060, and Sent/Drafts rows the app wrote itself after an APPEND.
// Rows are taken from the database in UID order, so a cursor per folder makes the walk resumable
// and later runs only look at rows above it. thread_id is only touched in gmail mode (see rekey).
import { gmailProviderIds } from './providerIds.js';
import { loadProviderIdBackfill, markProviderIdBackfillFinished, saveProviderIdCursor } from './providerIdBackfillStore.js';
import { GMAIL_KEY_PREFIX, THREAD_MODE_GMAIL } from './threadId.js';

export const PROVIDER_ID_BATCH_SIZE = 500;

// Ascending UIDs as a compact IMAP set: [1, 2, 3, 7, 9, 10] -> "1:3,7,9:10".
export function uidSet(uids) {
  const parts = [];
  let start = null;
  let prev = null;
  const flush = () => { if (start !== null) parts.push(start === prev ? `${start}` : `${start}:${prev}`); };
  for (const uid of uids) {
    if (start !== null && uid === prev + 1) {
      prev = uid;
      continue;
    }
    flush();
    start = uid;
    prev = uid;
  }
  flush();
  return parts.join(',');
}

const validityText = (value) => (value === null || value === undefined ? null : String(value));

// Folders that still have rows without ids above their cursor. A cursor saved under another
// UIDVALIDITY is dropped: the folder was renumbered and the sync refetches its rows with ids.
// Rows in folders the account no longer lists are left alone.
export async function planProviderIdBackfill(query, accountId) {
  const state = await loadProviderIdBackfill(query, accountId);
  const { rows: folderRows } = await query(
    'SELECT path, uid_validity FROM folders WHERE account_id = $1',
    [accountId],
  );
  const validity = new Map();
  const cursors = {};
  for (const folder of folderRows) {
    const uidValidity = validityText(folder.uid_validity);
    validity.set(folder.path, uidValidity);
    const saved = state?.cursors?.[folder.path];
    if (saved && validityText(saved.uidValidity) === uidValidity) cursors[folder.path] = saved;
  }
  const { rows } = await query(
    `SELECT m.folder, COUNT(*)::int AS remaining
     FROM messages m
     WHERE m.account_id = $1 AND m.is_deleted = false AND m.provider_message_id IS NULL
       AND m.uid > COALESCE((($2::jsonb -> m.folder) ->> 'lastUid')::bigint, 0)
     GROUP BY m.folder`,
    [accountId, JSON.stringify(cursors)],
  );
  const folders = rows
    .filter(r => validity.has(r.folder))
    .map(r => ({
      path: r.folder,
      uidValidity: validity.get(r.folder),
      lastUid: Number(cursors[r.folder]?.lastUid || 0),
      remaining: Number(r.remaining),
    }))
    .sort((a, b) => {
      if (a.path === 'INBOX') return -1;
      if (b.path === 'INBOX') return 1;
      return a.path.localeCompare(b.path);
    });
  return {
    folders,
    total: folders.reduce((sum, f) => sum + f.remaining, 0),
    // Read before any batch, so a local write during the run keeps its pending mark.
    pendingSince: state?.pending_since ?? null,
  };
}

// A tagged NO/BAD answer to SELECT or FETCH concerns that folder only (deleted label, server-side
// problem with one mailbox); the connection is still usable for the next folder.
const isFolderError = (err) => err?.responseStatus === 'NO' || err?.responseStatus === 'BAD';

// The mailbox's mode as it stands right now. Read per batch rather than captured when the job
// started: a fill of a large mailbox outlives an admin's rollback to rfc, and a stale capture
// would keep writing gmail: keys into a mailbox that no longer threads that way.
async function rekeyNow(query, accountId) {
  const { rows } = await query('SELECT thread_mode FROM email_accounts WHERE id = $1', [accountId]);
  return rows[0]?.thread_mode === THREAD_MODE_GMAIL;
}

export async function runProviderIdBackfill({
  query, accountId, getClient, shouldContinue, onProgress = () => {}, pause = async () => {},
}) {
  const plan = await planProviderIdBackfill(query, accountId);
  let processed = 0;
  const failedFolders = []; // { path, error }: the server refused SELECT or FETCH for the folder
  const skippedFolders = []; // paths whose server UIDVALIDITY differs from the cached rows
  const result = (outcome) => ({ outcome, processed, total: plan.total, failedFolders, skippedFolders });
  onProgress({ processed, total: plan.total });

  folders: for (const folder of plan.folders) {
    let lastUid = folder.lastUid;
    for (;;) {
      if (!(await shouldContinue())) return result('stopped');

      const { rows } = await query(
        `SELECT uid FROM messages
         WHERE account_id = $1 AND folder = $2 AND is_deleted = false
           AND provider_message_id IS NULL AND uid > $3
         ORDER BY uid
         LIMIT $4`,
        [accountId, folder.path, lastUid, PROVIDER_ID_BATCH_SIZE],
      );
      if (!rows.length) break;

      const uids = rows.map(r => Number(r.uid));
      const wanted = new Set(uids);
      const found = [];
      const client = await getClient();
      let renumbered;
      try {
        const lock = await client.getMailboxLock(folder.path);
        try {
          // The cached rows belong to the stored UIDVALIDITY; if the server moved on, the sync
          // purges and refetches this folder with ids, so its UIDs must not be matched here.
          // Only a known stored value can mismatch: rows of a folder stored without one are filled.
          renumbered = folder.uidValidity !== null && validityText(client.mailbox?.uidValidity) !== folder.uidValidity;
          if (!renumbered) {
            for await (const msg of client.fetch(uidSet(uids), { uid: true, threadId: true }, { uid: true })) {
              const uid = Number(msg.uid);
              const ids = gmailProviderIds(msg);
              if (wanted.has(uid) && ids.providerMessageId) found.push({ uid, ...ids });
            }
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        if (!isFolderError(err)) throw err;
        // The cursor stays at the last completed batch; the next run retries from there.
        failedFolders.push({ path: folder.path, error: err.responseText || err.message });
        continue folders;
      }
      if (renumbered) {
        skippedFolders.push(folder.path);
        break;
      }

      if (found.length) {
        // In gmail mode the thread key follows the number the fill just learned; the sync will not
        // revisit these UIDs, so this UPDATE is where an old row joins its Gmail conversation.
        const rekey = await rekeyNow(query, accountId);
        await query(
          `UPDATE messages m
           SET provider_thread_id = v.thread_id,
               provider_message_id = v.message_id,
               thread_id = CASE WHEN $6::boolean AND v.thread_id IS NOT NULL
                                THEN $7::text || v.thread_id ELSE m.thread_id END,
               threading_reason = CASE WHEN $6::boolean AND v.thread_id IS NOT NULL
                                       THEN 'gmail-thrid' ELSE m.threading_reason END
           FROM unnest($3::bigint[], $4::text[], $5::text[]) AS v(uid, thread_id, message_id)
           WHERE m.account_id = $1 AND m.folder = $2 AND m.uid = v.uid
             AND m.provider_message_id IS NULL`,
          [accountId, folder.path, found.map(f => f.uid), found.map(f => f.providerThreadId), found.map(f => f.providerMessageId), rekey, GMAIL_KEY_PREFIX],
        );
      }
      lastUid = uids[uids.length - 1];
      await saveProviderIdCursor(query, accountId, folder.path, { lastUid, uidValidity: folder.uidValidity });
      processed += uids.length;
      onProgress({ processed, total: plan.total });
      await pause();
    }
  }

  // A folder that failed or was skipped still has rows without ids: not finished, try again later.
  if (failedFolders.length || skippedFolders.length) return result('incomplete');
  await markProviderIdBackfillFinished(query, accountId, plan.pendingSince);
  return result('done');
}
