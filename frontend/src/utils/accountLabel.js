// How an account is named in lists that show several accounts' items (rules, block list).
export function accountLabel(accounts, accountId) {
  const account = (accounts || []).find((a) => a.id === accountId);
  return account ? (account.name || account.email_address || '') : '';
}
