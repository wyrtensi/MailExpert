// Search over the mailbox list in Settings -> Mail accounts. Pure functions (no DOM, no store)
// so they run under `node --test`.
//
// The sidebar filter (accountFilter.js) matches the name and address only. Here the person is
// hunting for one mailbox among many, so the search also reads what identifies it elsewhere: the
// sender name, every alias, the provider and the mail server. Each account's searchable text is
// built once per account list (buildAccountSearchIndex); a keystroke is then a substring scan
// over strings, which stays instant for a few hundred mailboxes.

const text = (value) => (typeof value === 'string' ? value : '');

// The mail server's own name without its role label: 'imap.fastmail.com' is Fastmail, found by
// 'fastmail'. Nothing common to every mailbox is indexed (not the protocol, not 'imap' or 'smtp'),
// so a query like 'imap' or 'mail' does not match the whole list.
function providerHost(host) {
  return text(host).replace(/^(imap|smtp|pop3?|mail)\./i, '');
}

// Words a person may use for the provider, whatever the interface language: the identifiers the
// server stores, plus the names of the products behind them.
// Names a person may type for each mail_provider and connection_mode the server stores, in both
// interface languages. The mail server is indexed only when it names a real service: the
// loopback address of a managed Proton mailbox says nothing about it.
const PROVIDER_NAMES = {
  proton: ['proton', 'protonmail', 'proton mail', 'протон'],
  yahoo: ['yahoo', 'ямху', 'яху'],
  yandex: ['yandex', 'яндекс'],
  mailru: ['mail.ru', 'mailru', 'майл', 'мейл', 'мэйл'],
  icloud: ['icloud', 'apple', 'айклауд', 'эппл'],
  other: ['other', 'imap', 'другой'],
};
const MODE_NAMES = {
  preset: ['preset', 'готовый', 'пресет'],
  managed: ['managed', 'bridge', 'управляемый', 'управляемое'],
  manual: ['manual', 'ручной', 'ручное'],
};
const LOOPBACK_HOST = /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$/i;

function providerWords(account, mailNodeLabel) {
  const words = [];
  if (account.oauth_provider === 'google') words.push('google', 'gmail');
  else if (account.oauth_provider === 'microsoft') words.push('microsoft', 'outlook', 'office 365');
  if (account.mail_node === true) words.push('mail node', mailNodeLabel);
  if (Object.hasOwn(PROVIDER_NAMES, account.mail_provider)) words.push(...PROVIDER_NAMES[account.mail_provider]);
  if (Object.hasOwn(MODE_NAMES, account.connection_mode)) words.push(...MODE_NAMES[account.connection_mode]);
  const host = providerHost(account.imap_host);
  if (!LOOPBACK_HOST.test(host)) words.push(host);
  return words;
}

export function accountSearchText(account, { mailNodeLabel = '' } = {}) {
  const a = account && typeof account === 'object' ? account : {};
  const aliases = Array.isArray(a.aliases) ? a.aliases : [];
  const parts = [
    text(a.name), text(a.email_address), text(a.sender_name),
    ...aliases.flatMap(alias => [text(alias?.name), text(alias?.email), text(alias?.reply_to)]),
    ...providerWords(a, text(mailNodeLabel)),
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

export function buildAccountSearchIndex(accounts, options) {
  return (Array.isArray(accounts) ? accounts : []).map(account => ({
    account,
    text: accountSearchText(account, options),
  }));
}

// Every whitespace-separated word of the query must appear somewhere in the account's text, in
// any order. A blank query returns the accounts as given, in order.
export function searchAccounts(index, query) {
  const words = (typeof query === 'string' ? query.trim().toLowerCase() : '').split(/\s+/).filter(Boolean);
  if (!words.length) return index.map(entry => entry.account);
  return index
    .filter(entry => words.every(word => entry.text.includes(word)))
    .map(entry => entry.account);
}
