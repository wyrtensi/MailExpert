import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountUpdateFromForm } from './accountUpdate.js';

const FORM = {
  name: 'Team', sender_name: '', color: '#000000', signature: '', categorization_enabled: true,
  imap_host: 'imap.example.com', imap_port: 993, imap_skip_tls_verify: false,
  smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
  auth_user: 'team@example.com', auth_pass: 'secret', smtp_auth_user: '', smtp_auth_pass: '',
};
const SERVER_KEYS = /^(imap_|smtp_|auth_)/;

describe('accountUpdateFromForm', () => {
  it('sends only the fields everyone may change for a user who is not an administrator', () => {
    const updates = accountUpdateFromForm(FORM, { isAdmin: false });
    assert.deepEqual(updates, { name: 'Team', sender_name: null, color: '#000000', signature: null, categorization_enabled: true });
    assert.equal(Object.keys(updates).some((key) => SERVER_KEYS.test(key)), false);
  });

  it('defaults to a user who is not an administrator', () => {
    assert.equal(Object.keys(accountUpdateFromForm(FORM)).some((key) => SERVER_KEYS.test(key)), false);
  });

  it('sends the server settings for an administrator', () => {
    const updates = accountUpdateFromForm(FORM, { isAdmin: true });
    assert.equal(updates.imap_host, 'imap.example.com');
    assert.equal(updates.auth_pass, 'secret');
    assert.equal(updates.smtp_auth_user, null);
    assert.equal(updates.smtp_auth_pass, null);
  });

  it('keeps a stored SMTP password when an administrator leaves it blank', () => {
    const updates = accountUpdateFromForm({ ...FORM, smtp_auth_user: 'relay@example.com' }, { isAdmin: true });
    assert.equal(updates.smtp_auth_user, 'relay@example.com');
    assert.equal('smtp_auth_pass' in updates, false);
  });
});

describe('managed mailboxes', () => {
  const MANAGED = { mail_provider: 'proton', connection_mode: 'managed' };
  it('managed_employee_edit_sends_only_metadata: even an administrator sends no connection fields', () => {
    for (const isAdmin of [false, true]) {
      const updates = accountUpdateFromForm(FORM, { isAdmin, account: MANAGED });
      assert.deepEqual(updates, { name: 'Team', sender_name: null, color: '#000000', signature: null, categorization_enabled: true });
    }
  });
  it('a mail node mailbox is metadata-only as well', () => {
    assert.equal('imap_host' in accountUpdateFromForm(FORM, { isAdmin: true, account: { mail_node: true } }), false);
  });
  it('an ordinary mailbox is unchanged for an administrator', () => {
    const updates = accountUpdateFromForm(FORM, { isAdmin: true, account: { mail_provider: 'yandex', connection_mode: 'preset' } });
    assert.equal(updates.imap_host, 'imap.example.com');
  });
});
