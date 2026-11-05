// The server refuses a send or a draft save whose From alias no longer exists (removed in Gmail
// or by an admin) instead of falling back to the mailbox address.
export const ALIAS_GONE_CODE = 'alias_gone';

export function isAliasGone(err) {
  return err?.code === ALIAS_GONE_CODE;
}
