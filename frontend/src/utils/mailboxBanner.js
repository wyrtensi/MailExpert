// The strip at the top of an open letter that says which mailbox it belongs to: with many shared
// mailboxes the reader must see at once where a letter arrived (or which one sent it). Pure
// function, so it runs under `node --test`.
import { parseAddressListField } from './replyAlias.js';

const lower = (value) => String(value ?? '').trim().toLowerCase();

// { direction: 'in' | 'out', via }. 'out' when the mailbox (or one of its aliases) wrote it.
// `via` is the address it was delivered to when that is not the mailbox's own (an alias or a
// group address that forwards here), else null.
export function mailboxBanner(message, account) {
  const own = lower(account?.email_address ?? message?.account_email);
  const aliasEmails = (account?.aliases || []).map((a) => lower(a.email));
  const from = lower(message?.from_email);
  const direction = from && (from === own || aliasEmails.includes(from)) ? 'out' : 'in';
  if (direction === 'out') return { direction, via: null };
  const delivered = parseAddressListField(message?.delivery_addresses).map(lower).filter(Boolean);
  const via = delivered.find((address) => address !== own) ?? null;
  return { direction, via };
}
