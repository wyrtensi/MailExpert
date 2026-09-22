import { query } from './db.js';

// "Before this letter": the earlier correspondence of the open message's mailbox with the same
// person. The person is the sender, or for a letter the mailbox sent, its first recipient that is
// not the mailbox itself. Their letters and the mailbox's letters to them both count, each marked
// with its direction. Only this mailbox, never trash or spam, and a letter synced into several
// folders (Gmail labels) counts once.

export const SENDER_HISTORY_DEFAULT_LIMIT = 5;
export const SENDER_HISTORY_MAX_LIMIT = 20;

const lower = (value) => String(value ?? '').trim().toLowerCase();

function addressList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// The other side of the letter, lowercased, or null (a note to self, a letter without addresses).
export function correspondentOf(message, ownAddresses) {
  const from = lower(message.from_email);
  if (from && !ownAddresses.has(from)) return from;
  for (const entry of [...addressList(message.to_addresses), ...addressList(message.cc_addresses)]) {
    const email = lower(typeof entry === 'string' ? entry : entry?.email);
    if (email && !ownAddresses.has(email)) return email;
  }
  return null;
}

// { correspondent, total, items: [{ id, folder, subject, snippet, date, direction: 'in' | 'out' }] },
// newest first; null when the message does not exist.
export async function senderHistory(messageId, { limit = SENDER_HISTORY_DEFAULT_LIMIT } = {}) {
  const found = await query(`
    SELECT m.account_id, m.from_email, m.to_addresses, m.cc_addresses, m.date,
           a.email_address, a.folder_mappings,
           COALESCE((SELECT array_agg(al.email) FROM account_aliases al WHERE al.account_id = a.id), '{}') AS alias_emails
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE m.id = $1 AND m.is_deleted = false
  `, [messageId]);
  if (!found.rows.length) return null;
  const message = found.rows[0];

  const own = new Set([message.email_address, ...(message.alias_emails || [])].map(lower).filter(Boolean));
  const correspondent = correspondentOf(message, own);
  if (!correspondent) return { correspondent: null, total: 0, items: [] };

  const mappings = message.folder_mappings || {};
  const skippedFolders = [mappings.trash, mappings.spam].filter((f) => typeof f === 'string' && f);

  const { rows } = await query(`
    WITH history AS (
      SELECT DISTINCT ON (COALESCE(m.message_id, m.id::text))
             m.id, m.folder, m.subject, m.snippet, m.date,
             lower(m.from_email) = ANY($5::text[]) AS outgoing
      FROM messages m
      WHERE m.account_id = $1
        AND m.is_deleted = false
        AND m.id <> $2
        AND ($3::timestamptz IS NULL OR m.date < $3)
        AND NOT (m.folder = ANY($6::text[]))
        AND (
          lower(m.from_email) = $4
          OR (
            lower(m.from_email) = ANY($5::text[])
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                (CASE WHEN jsonb_typeof(m.to_addresses) = 'array' THEN m.to_addresses ELSE '[]'::jsonb END)
                || (CASE WHEN jsonb_typeof(m.cc_addresses) = 'array' THEN m.cc_addresses ELSE '[]'::jsonb END)
              ) AS rcpt
              WHERE lower(CASE WHEN jsonb_typeof(rcpt) = 'string' THEN rcpt #>> '{}' ELSE rcpt ->> 'email' END) = $4
            )
          )
        )
      ORDER BY COALESCE(m.message_id, m.id::text), m.date DESC
    )
    SELECT id, folder, subject, snippet, date, outgoing, count(*) OVER () AS total
    FROM history
    ORDER BY date DESC NULLS LAST
    LIMIT $7
  `, [message.account_id, messageId, message.date, correspondent, [...own], skippedFolders, limit]);

  return {
    correspondent,
    total: rows.length ? Number(rows[0].total) : 0,
    items: rows.map((r) => ({
      id: r.id,
      folder: r.folder,
      subject: r.subject,
      snippet: r.snippet,
      date: r.date,
      direction: r.outgoing ? 'out' : 'in',
    })),
  };
}
