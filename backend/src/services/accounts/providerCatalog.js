// Alternatives are ordered: full_address is the initial login. A local-part fallback is only
// tried after AUTH refusal, never a TLS/network error or an explicit user-supplied login.
// local_part_public_domain requires an exact publicDomains match. iCloud's local_part is an
// IMAP-only alternative; automatic fallback also requires a public domain. Custom-domain
// iCloud mailboxes can instead supply the primary iCloud login explicitly.
const providers = [
  {
    id: 'yahoo',
    imap: { host: 'imap.mail.yahoo.com', port: 993, tls: 'implicit' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 587, tls: 'starttls' },
    appPasswordUrl: 'https://login.yahoo.com/account/security',
    publicDomains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
    loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] },
  },
  {
    id: 'yandex',
    imap: { host: 'imap.yandex.ru', port: 993, tls: 'implicit' },
    smtp: { host: 'smtp.yandex.ru', port: 465, tls: 'implicit' },
    appPasswordUrl: 'https://id.yandex.ru/security',
    publicDomains: ['yandex.ru', 'ya.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.com.tr'],
    loginAlternatives: { imap: ['full_address', 'local_part_public_domain'], smtp: ['full_address', 'local_part_public_domain'] },
  },
  {
    id: 'mailru',
    imap: { host: 'imap.mail.ru', port: 993, tls: 'implicit' },
    smtp: { host: 'smtp.mail.ru', port: 465, tls: 'implicit' },
    appPasswordUrl: 'https://account.mail.ru/user/2-step-auth/passwords/',
    publicDomains: ['mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'internet.ru'],
    loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] },
  },
  {
    id: 'icloud',
    imap: { host: 'imap.mail.me.com', port: 993, tls: 'implicit' },
    smtp: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' },
    appPasswordUrl: 'https://account.apple.com/',
    publicDomains: ['icloud.com', 'me.com', 'mac.com'],
    loginAlternatives: { imap: ['full_address', 'local_part'], smtp: ['full_address'] },
  },
];

export function getImapProvider(id) {
  const provider = providers.find(provider => provider.id === id);
  return provider ? structuredClone(provider) : null;
}

export function publicProviderCatalog() {
  return structuredClone(providers);
}
