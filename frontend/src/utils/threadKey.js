// Cache key for a thread row. The same conversation in two mailboxes has the same thread key in
// both, and each mailbox shows its own row, so the mailbox has to be part of the key: without it
// opening one row would expand the other and serve it the wrong messages.
export function threadCacheKey(message) {
  return `${message?.account_id || 'unknown'}:${message?.thread_id || message?.id}`;
}

// Dedup key for a pending (undo-able) delete. Two mailboxes can share a thread_key for their own
// copy of a conversation, so this must include the mailbox too -- otherwise a delete pending in
// one mailbox's thread would make scheduleDelete return early for a different mailbox's row that
// happens to share the same thread key, silently swallowing the second delete.
export function pendingDeleteTimerKey(message, isThreadRow) {
  return isThreadRow ? `thread:${threadCacheKey(message)}` : message?.id;
}
