import { query } from '../db.js';

// Parse an RFC 5322 References header into its angle-bracketed Message-IDs, in order.
export function parseReferences(refHeader) {
  if (!refHeader) return [];
  return refHeader.match(/<[^>]+>/g) || [];
}

// A mailbox in gmail mode keys its conversations by Gmail's own thread number; everything else
// keys them by the RFC 5322 References chain inside one mailbox.
export const GMAIL_KEY_PREFIX = 'gmail:';
export const THREAD_MODE_GMAIL = 'gmail';

// Thread key and the reason it was chosen, for one incoming message. The Gmail branch needs both
// the mailbox mode and a Gmail thread number: a mailbox switched to gmail mode still receives
// messages whose number has not been loaded yet, and those thread by their headers. A message
// without threading headers starts its own thread: grouping by subject merged unrelated mail that
// shares a subject such as "Invoice" or "Report".
export async function computeThreading(accountId, messageId, inReplyTo, references, { mode = 'rfc', providerThreadId = null } = {}) {
  if (mode === THREAD_MODE_GMAIL && providerThreadId) {
    return { threadId: `${GMAIL_KEY_PREFIX}${providerThreadId}`, reason: 'gmail-thrid' };
  }
  if (!messageId) return { threadId: null, reason: null };

  const candidates = parseReferences(references);
  if (inReplyTo && !candidates.includes(inReplyTo)) candidates.push(inReplyTo);
  if (candidates.length === 0) return { threadId: messageId, reason: 'new-root' };

  const rows = await query(
    `SELECT message_id, thread_id FROM messages
     WHERE account_id = $1 AND message_id = ANY($2) AND thread_id IS NOT NULL`,
    [accountId, candidates]
  );
  if (rows.rows.length > 0) {
    const found = new Map(rows.rows.map(r => [r.message_id, r.thread_id]));
    // Prefer the thread root (first Reference per RFC 5322), then the newest stored ancestor.
    if (found.has(candidates[0])) return { threadId: found.get(candidates[0]), reason: 'rfc-root' };
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (found.has(candidates[i])) return { threadId: found.get(candidates[i]), reason: 'rfc-ancestor' };
    }
  }

  // An ancestor is referenced but not stored yet: use the root provisionally. When the root
  // arrives its thread_id equals its own Message-ID, so the thread converges.
  return { threadId: candidates[0], reason: 'rfc-provisional' };
}
