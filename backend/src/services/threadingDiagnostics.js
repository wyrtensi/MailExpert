import { query } from './db.js';
import { parseReferences } from './threading/threadId.js';

// Per-message threading diagnostics (GET /api/mail/messages/:id/threading): why one letter
// landed in its conversation. Shows the raw Message-ID/In-Reply-To/References, the Gmail
// thread number when the mailbox backfilled one, the thread key computeThreading picked and
// the reason it picked it, the mailbox's threading mode, and how many other letters share the
// same thread and where they live.

// { messageId, inReplyTo, references: [..], providerThreadId, providerMessageId, threadId,
//   reason, mode, conversation: { total, folders: [{ folder, count }] } }, or null when the
// message row does not exist (or was soft-deleted — same "not found" as the other message routes).
//
// conversation.total counts distinct letters, not rows: the same Gmail letter can live in
// several folders as separate rows (e.g. INBOX and [Gmail]/All Mail), exactly like the thread
// list (services/messageService.js's thread_totals, COUNT(DISTINCT message_id)) and
// GET /thread/:threadId (DISTINCT ON (m.message_id)) already dedupe it. A row with no
// message_id can't be matched to any duplicate, so it counts as its own letter.
// conversation.folders stays row-based — it answers "where do the copies live", not "how many
// letters".
export async function threadingDiagnostics(messageId) {
  const found = await query(`
    SELECT m.message_id, m.in_reply_to, m.thread_references, m.provider_thread_id, m.provider_message_id,
           m.thread_id, m.thread_key, m.threading_reason, m.account_id, m.is_deleted, a.thread_mode
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE m.id = $1
  `, [messageId]);
  if (!found.rows.length || found.rows[0].is_deleted) return null;
  const row = found.rows[0];

  const [{ rows: totalRows }, { rows: folderRows }] = await Promise.all([
    query(`
      SELECT count(DISTINCT message_id) FILTER (WHERE message_id IS NOT NULL)::int
             + count(*) FILTER (WHERE message_id IS NULL)::int AS total
      FROM messages
      WHERE account_id = $1 AND thread_key = $2 AND is_deleted = false
    `, [row.account_id, row.thread_key]),
    query(`
      SELECT folder, count(*)::int AS count
      FROM messages
      WHERE account_id = $1 AND thread_key = $2 AND is_deleted = false
      GROUP BY folder
      ORDER BY count DESC, folder ASC
    `, [row.account_id, row.thread_key]),
  ]);

  return {
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: parseReferences(row.thread_references),
    providerThreadId: row.provider_thread_id,
    providerMessageId: row.provider_message_id,
    threadId: row.thread_id,
    reason: row.threading_reason,
    mode: row.thread_mode,
    conversation: {
      total: Number(totalRows[0]?.total) || 0,
      folders: folderRows.map((r) => ({ folder: r.folder, count: r.count })),
    },
  };
}
