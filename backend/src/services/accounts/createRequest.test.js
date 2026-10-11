import { expect, it } from 'vitest';
import { parseProviderCreate, parseManualCreate } from './createRequest.js';
const provider = { provider: 'yahoo', email: ' Team@Example.com ', appPassword: 'pass' };
const manual = { email_address: 'team@example.com', imap_host: 'imap.example.com', smtp_host: 'smtp.example.com', auth_pass: 'pass' };
it('builds fixed endpoints from the server catalog', () => {
  expect(parseProviderCreate(provider)).toMatchObject({ provider: 'yahoo', mode: 'preset', candidate: { email_address: 'team@example.com', imap_host: 'imap.mail.yahoo.com', smtp_tls: 'STARTTLS', explicitLogin: false } });
});
it.each(['imap_host', 'smtp_port', 'oauth_provider', 'mail_provider', 'connection_mode', 'proton_user_id', 'explicitLogin'])('refuses provider field %s', key => {
  expect(parseProviderCreate({ ...provider, [key]: 'forged' }).error).toBe('invalid_request');
});
it.each(['gmail', 'proton', 'other', 'domain', 'microsoft'])('refuses non-preset %s', value => {
  expect(parseProviderCreate({ ...provider, provider: value }).error).toBe('invalid_request');
});
it('advanced_preset_uses_manual_policy', () => {
  expect(parseManualCreate({ ...manual, provider: 'yahoo', imap_port: 143 })).toMatchObject({ provider: 'yahoo', mode: 'manual', candidate: { imap_host: 'imap.example.com', imap_tls_mode: 'starttls', explicitLogin: true } });
});
it.each([
  { imap_host: '' }, { smtp_host: 42 }, { imap_port: '993' }, { smtp_port: 0 },
  { smtp_tls: 'none' }, { imap_skip_tls_verify: true }, { auth_user: 'a\r\nb' },
  { email_address: 'a\n@example.com' }, { auth_pass: {} }, { mail_node: false },
  { provider: 'proton' }, { oauth_access_token: 'secret' }, { imap_tls_mode: null },
])('rejects unsafe manual input %o', patch => expect(parseManualCreate({ ...manual, ...patch }).error).toBeTruthy());
