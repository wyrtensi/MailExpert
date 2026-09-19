// Cache key for a thread row. The same conversation in two mailboxes has the same thread key in
// both, and each mailbox shows its own row, so the mailbox has to be part of the key: without it
// opening one row would expand the other and serve it the wrong messages.
export function threadCacheKey(message) {
  return `${message?.account_id || 'unknown'}:${message?.thread_id || message?.id}`;
}
