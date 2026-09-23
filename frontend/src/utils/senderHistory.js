// "Before this letter" under an open letter: the earlier correspondence of the mailbox with the
// same person (GET /api/mail/messages/:id/sender-history). Pure functions: no DOM, no store, no
// network, so they run under `node --test`.

export const SENDER_HISTORY_LIMIT = 5;

// Whether the block shows at all: only when the server found earlier letters.
export function hasSenderHistory(history) {
  return !!history?.correspondent && Number(history.total) > 0 && Array.isArray(history.items) && history.items.length > 0;
}

// The search that lists every letter from the person, for the "All letters from them" link.
export function senderSearchQuery(correspondent) {
  const email = String(correspondent ?? '').trim();
  if (!email) return '';
  return /\s/.test(email) ? `from:"${email}"` : `from:${email}`;
}

// How many earlier letters are not in the short list.
export function moreCount(history) {
  const total = Number(history?.total) || 0;
  const shown = Array.isArray(history?.items) ? history.items.length : 0;
  return Math.max(0, total - shown);
}
