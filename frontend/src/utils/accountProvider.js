// Labels for the provider and connection mode a mailbox card shows (GET /api/accounts sends
// mail_provider and connection_mode). Keys are spelled out literally so the i18n source-coverage
// test can find them.
export const PROVIDER_LABEL_KEYS = Object.freeze({
  gmail: 'admin.accounts.provider.gmail',
  microsoft: 'admin.accounts.provider.microsoft',
  domain: 'admin.accounts.provider.domain',
  proton: 'admin.accounts.provider.proton',
  yahoo: 'admin.accounts.provider.yahoo',
  yandex: 'admin.accounts.provider.yandex',
  mailru: 'admin.accounts.provider.mailru',
  icloud: 'admin.accounts.provider.icloud',
  other: 'admin.accounts.provider.other',
});

export const MODE_LABEL_KEYS = Object.freeze({
  preset: 'admin.accounts.mode.preset',
  managed: 'admin.accounts.mode.managed',
  manual: 'admin.accounts.mode.manual',
});

// Translation keys of a card's provider and mode chips; a value the client does not know is left out.
export function accountProviderLabels(account) {
  const provider = Object.hasOwn(PROVIDER_LABEL_KEYS, account?.mail_provider) ? PROVIDER_LABEL_KEYS[account.mail_provider] : null;
  const mode = Object.hasOwn(MODE_LABEL_KEYS, account?.connection_mode) ? MODE_LABEL_KEYS[account.connection_mode] : null;
  return { provider, mode };
}
