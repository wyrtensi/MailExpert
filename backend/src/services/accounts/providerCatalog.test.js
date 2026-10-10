import { describe, expect, it } from 'vitest';
import { getImapProvider, publicProviderCatalog } from './providerCatalog.js';
import { safeAccount } from './manualAccounts.js';

describe('mailbox provider catalog', () => {
  it('catalog_has_four_exact_presets', () => {
    const catalog = publicProviderCatalog();
    expect(catalog.map(provider => provider.id)).toEqual(['yahoo', 'yandex', 'mailru', 'icloud']);
    expect(catalog).toEqual([
      { id: 'yahoo', imap: { host: 'imap.mail.yahoo.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.yahoo.com', port: 587, tls: 'starttls' }, appPasswordUrl: 'https://login.yahoo.com/account/security', publicDomains: ['yahoo.com', 'ymail.com', 'rocketmail.com'], loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] } },
      { id: 'yandex', imap: { host: 'imap.yandex.ru', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.yandex.ru', port: 465, tls: 'implicit' }, appPasswordUrl: 'https://id.yandex.ru/security/app-passwords', publicDomains: ['yandex.ru', 'ya.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.com.tr'], loginAlternatives: { imap: ['full_address', 'local_part_public_domain'], smtp: ['full_address', 'local_part_public_domain'] } },
      { id: 'mailru', imap: { host: 'imap.mail.ru', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.ru', port: 465, tls: 'implicit' }, appPasswordUrl: 'https://account.mail.ru/user/2-step-auth/passwords/', publicDomains: ['mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'internet.ru'], loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] } },
      { id: 'icloud', imap: { host: 'imap.mail.me.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' }, appPasswordUrl: 'https://account.apple.com/', publicDomains: ['icloud.com', 'me.com', 'mac.com'], loginAlternatives: { imap: ['full_address', 'local_part'], smtp: ['full_address'] } },
    ]);
    expect(getImapProvider('mailru').imap.host).toBe('imap.mail.ru');
    expect(getImapProvider('yandex').appPasswordUrl).toBe('https://id.yandex.ru/security/app-passwords');
  });

  it('does not treat managed or unknown providers as fixed IMAP presets', () => {
    for (const id of ['proton', 'gmail', 'microsoft', 'domain', 'other', 'toString', null]) {
      expect(getImapProvider(id)).toBeNull();
    }
  });

  it('public metadata cannot mutate the authoritative server defaults', () => {
    const catalog = publicProviderCatalog();
    catalog[0].imap.host = 'changed.example.com';
    catalog[0].publicDomains.push('changed.example.com');
    expect(getImapProvider('yahoo').imap.host).toBe('imap.mail.yahoo.com');
    expect(getImapProvider('yahoo').publicDomains).toEqual(['yahoo.com', 'ymail.com', 'rocketmail.com']);
  });

  it('safe_account_excludes_managed_credentials', () => {
    const row = {
      id: 'account', mail_provider: 'proton', connection_mode: 'managed', imap_tls_mode: 'implicit',
      can_reconnect_proton: true, auth_pass: 'secret-sentinel', smtp_auth_pass: 'secret-sentinel',
      oauth_access_token: 'secret-sentinel', user_id: 'secret-sentinel', generation: 'secret-sentinel',
      certificate_pem: 'secret-sentinel', certificate_fingerprint: 'secret-sentinel',
      tls_servername: 'secret-sentinel', creator_user_id: 'secret-sentinel',
    };
    expect(safeAccount(row)).toMatchObject({ mail_provider: 'proton', connection_mode: 'managed', imap_tls_mode: 'implicit', can_reconnect_proton: true });
    expect(JSON.stringify(safeAccount(row))).not.toContain('secret-sentinel');
  });
});
