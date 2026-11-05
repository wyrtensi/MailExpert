// The server refuses a send or a draft save whose From alias no longer exists (removed in Gmail
// or by an admin) instead of falling back to the mailbox address.
export const ALIAS_GONE_CODE = 'alias_gone';

export function isAliasGone(err) {
  return err?.code === ALIAS_GONE_CODE;
}

// True when From holds an alias (`alias:<aliasId>:<accountId>`) that the loaded mailbox list no
// longer has. The composer then shows a disabled "removed alias" option for it, so the select
// displays what the state holds and the user picks another sender; From is never switched to the
// mailbox address behind the user's back.
export function isVanishedAliasFrom(fromValue, accounts) {
  if (typeof fromValue !== 'string' || !fromValue.startsWith('alias:')) return false;
  if (!Array.isArray(accounts) || accounts.length === 0) return false;
  const [, aliasId, accountId] = fromValue.split(':');
  const account = accounts.find((a) => a.id === accountId);
  return !(account?.aliases || []).some((alias) => alias.id === aliasId);
}
