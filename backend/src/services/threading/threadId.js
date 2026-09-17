import { query } from '../db.js';

// Parse an RFC 5322 References header into its angle-bracketed Message-IDs, in order.
export function parseReferences(refHeader) {
  if (!refHeader) return [];
  return refHeader.match(/<[^>]+>/g) || [];
}

// Thread id for an incoming message, from the RFC 5322 References / In-Reply-To chain inside
// one mailbox. A message without threading headers starts its own thread: grouping by subject
// merged unrelated mail that shares a subject such as "Invoice" or "Report".
export async function computeThreadId(accountId, messageId, inReplyTo, references) {
  if (!messageId) return null;

  const candidates = parseReferences(references);
  if (inReplyTo && !candidates.includes(inReplyTo)) candidates.push(inReplyTo);
  if (candidates.length === 0) return messageId;

  const rows = await query(
    `SELECT message_id, thread_id FROM messages
     WHERE account_id = $1 AND message_id = ANY($2) AND thread_id IS NOT NULL`,
    [accountId, candidates]
  );
  if (rows.rows.length > 0) {
    const found = new Map(rows.rows.map(r => [r.message_id, r.thread_id]));
    // Prefer the thread root (first Reference per RFC 5322), then the newest stored ancestor.
    if (found.has(candidates[0])) return found.get(candidates[0]);
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (found.has(candidates[i])) return found.get(candidates[i]);
    }
  }

  // An ancestor is referenced but not stored yet: use the root provisionally. When the root
  // arrives its thread_id equals its own Message-ID, so the thread converges.
  return candidates[0];
}
