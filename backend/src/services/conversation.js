import { query } from './db.js';
import { resolveAllDraftsPaths, resolveAllSpamPaths, resolveAllTrashPaths } from '../utils/mailUtils.js';

// "The whole conversation" under an open letter, as Gmail stacks it: every letter of the open
// letter's thread in the same mailbox, oldest first, each marked with its direction. Only this
// mailbox (the same conversation in another mailbox is that mailbox's business), never trash or
// spam; a draft is listed and marked as one. A letter synced into several folders (Gmail labels)
// counts once, the Inbox or Sent copy preferred.

export const CONVERSATION_MAX_LETTERS = 100;

// { threadKey, total, items: [{ id, folder, subject, snippet, date, from_name, from_email,
//   to_addresses, cc_addresses, has_attachments, direction: 'in' | 'out' | 'draft' }] },
// oldest first; null when the message does not exist.
export async function conversation(messageId) {
  const found = await query(`
    SELECT m.account_id, m.thread_key, a.email_address, a.folder_mappings,
           COALESCE((SELECT array_agg(al.email) FROM account_aliases al WHERE al.account_id = a.id), '{}') AS alias_emails
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE m.id = $1 AND m.is_deleted = false
  `, [messageId]);
  if (!found.rows.length) return null;
  const { account_id: accountId, thread_key: threadKey, folder_mappings: mappings } = found.rows[0];
  if (!threadKey) return { threadKey: null, total: 0, items: [] };

  const own = [...new Set([found.rows[0].email_address, ...(found.rows[0].alias_emails || [])]
    .map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean))];
  const [trash, spam, drafts] = await Promise.all([
    resolveAllTrashPaths(accountId, mappings),
    resolveAllSpamPaths(accountId, mappings),
    resolveAllDraftsPaths(accountId, mappings),
  ]);
  const inboxPath = 'INBOX';
  const sentPath = typeof mappings?.sent === 'string' && mappings.sent ? mappings.sent : null;

  const { rows } = await query(`
    WITH letters AS (
      SELECT DISTINCT ON (COALESCE(m.message_id, m.id::text))
             m.id, m.folder, m.subject, m.snippet, m.date, m.from_name, m.from_email,
             m.to_addresses, m.cc_addresses, m.has_attachments
      FROM messages m
      WHERE m.account_id = $1
        AND m.thread_key = $2
        AND m.is_deleted = false
        AND NOT (m.folder = ANY($3::text[]))
      ORDER BY COALESCE(m.message_id, m.id::text),
               CASE WHEN m.folder = $4 OR m.folder = $5 THEN 0 ELSE 1 END,
               m.id
    )
    SELECT * FROM letters ORDER BY date ASC NULLS FIRST, id ASC LIMIT $6
  `, [accountId, threadKey, [...trash, ...spam], inboxPath, sentPath, CONVERSATION_MAX_LETTERS]);

  return {
    threadKey,
    total: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      folder: r.folder,
      subject: r.subject,
      snippet: r.snippet,
      date: r.date,
      from_name: r.from_name,
      from_email: r.from_email,
      to_addresses: r.to_addresses,
      cc_addresses: r.cc_addresses,
      has_attachments: r.has_attachments,
      direction: drafts.has(r.folder)
        ? 'draft'
        : own.includes(String(r.from_email ?? '').trim().toLowerCase()) ? 'out' : 'in',
    })),
  };
}
