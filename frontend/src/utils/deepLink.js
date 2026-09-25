// Durable permalinks to one email: /?m=<ref>&a=<account>. The ref is the stable Message-ID
// header (the row UUID only when there is none), so the link survives the email moving folders
// or being re-synced (#270, #375). The account names the mailbox the link was copied from: one
// email delivered to two mailboxes has the same Message-ID in both, and opening a link marks the
// copy it resolves to as read, which in a shared mailbox the whole team sees. Links made before
// the account was added carry only m and still resolve, to a fixed copy.

// The link for a message row, or null when it has nothing to resolve by.
export function messageDeepLink(origin, message) {
  const ref = message?.message_id || message?.id;
  if (!ref) return null;
  const params = new URLSearchParams({ m: ref });
  if (message.account_id) params.set('a', message.account_id);
  return `${origin}/?${params}`;
}

// { ref, accountId } from a link's query string (URLSearchParams), or null without a ref.
export function readDeepLink(params) {
  const ref = params?.get('m');
  if (!ref) return null;
  return { ref, accountId: params.get('a') || null };
}
