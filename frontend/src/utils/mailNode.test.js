import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  domainMailboxFormError,
  domainMailboxTaken,
  senderNameError,
  senderNamesPayload,
  mailNodeConfigError,
  mailNodeErrorDetail,
  mailNodeErrorKey,
  quotaMbInGb,
  selectableDomains,
  sizeParts,
  usagePercent,
} from './mailNode.js';

describe('domainMailboxFormError', () => {
  it('accepts a valid name before @ with a picked domain', () => {
    assert.equal(domainMailboxFormError({ localPart: ' Info.Sales ', domain: 'example.com' }), null);
  });

  it('refuses a bad name before @ and a missing domain', () => {
    for (const localPart of ['', '.a', 'a.', 'a..b', 'a b', 'a@b', 'a+b']) {
      assert.equal(domainMailboxFormError({ localPart, domain: 'example.com' }), 'admin.accounts.add.domainErrorLocalPart');
    }
    assert.equal(domainMailboxFormError({ localPart: 'info', domain: '' }), 'admin.accounts.add.domainErrorPickDomain');
  });
});

describe('selectableDomains', () => {
  it('offers active domains, sorted', () => {
    assert.deepEqual(selectableDomains([
      { domain: 'b.example', active: true }, { domain: 'off.example', active: false }, { domain: 'a.example', active: true },
    ]), ['a.example', 'b.example']);
    assert.deepEqual(selectableDomains(null), []);
  });
});

describe('mailNodeConfigError', () => {
  const ok = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: '5120', diskPingUrl: '' };

  it('accepts complete settings, and a blank key when one is stored', () => {
    assert.equal(mailNodeConfigError(ok), null);
    assert.equal(mailNodeConfigError({ ...ok, apiKey: '' }, { hasStoredKey: true }), null);
  });

  it('names the first problem', () => {
    assert.equal(mailNodeConfigError({ ...ok, mailHost: '10.0.0.1' }), 'admin.mailNode.errorHost');
    assert.equal(mailNodeConfigError({ ...ok, apiKey: '' }), 'admin.mailNode.errorApiKey');
    assert.equal(mailNodeConfigError({ ...ok, quotaMb: '0' }), 'admin.mailNode.errorQuota');
    assert.equal(mailNodeConfigError({ ...ok, quotaMb: '1.5' }), 'admin.mailNode.errorQuota');
    assert.equal(mailNodeConfigError({ ...ok, diskPingUrl: 'http://hc.example.com/x' }), 'admin.mailNode.errorPingUrl');
  });
});

describe('errors', () => {
  it('maps server codes to keys, unknown ones to the generic text', () => {
    assert.equal(mailNodeErrorKey('mail_node_auth'), 'admin.mailNode.errorAuth');
    assert.equal(mailNodeErrorKey('mailbox_exists'), 'admin.accounts.add.domainErrorExists');
    assert.equal(mailNodeErrorKey('something_new'), 'admin.mailNode.errorFailed');
  });

  it('shows the node words of a refusal only', () => {
    assert.equal(mailNodeErrorDetail({ code: 'mail_node_refused', message: 'The mail node refused: max_mailbox_exceeded 500' }), 'max_mailbox_exceeded 500');
    assert.equal(mailNodeErrorDetail({ code: 'mail_node_auth', message: 'The mail node refused the API key' }), '');
  });
});

describe('usage', () => {
  it('gives the share of the quota, capped at 100', () => {
    assert.equal(usagePercent(1048576 * 512, 1024), 50);
    assert.equal(usagePercent(1048576 * 2048, 1024), 100);
    assert.equal(usagePercent(null, 1024), null);
    assert.equal(usagePercent(10, null), null);
  });

  it('shows megabytes below a gigabyte and gigabytes above', () => {
    assert.deepEqual(sizeParts(1048576 * 300), { value: '300', unitKey: 'admin.mailNode.unitMb' });
    assert.deepEqual(sizeParts(1024 ** 3 * 1.25), { value: '1.3', unitKey: 'admin.mailNode.unitGb' });
  });
});

describe('quotaMbInGb', () => {
  it('is null below a full gigabyte', () => {
    assert.equal(quotaMbInGb(1023), null);
    assert.equal(quotaMbInGb('700'), null);
    assert.equal(quotaMbInGb(''), null);
    assert.equal(quotaMbInGb('not a number'), null);
  });

  it('reads MB back in GB at and above a full gigabyte', () => {
    assert.equal(quotaMbInGb(1024), '1.0');
    assert.equal(quotaMbInGb('5120'), '5.0');
    assert.equal(quotaMbInGb(102400), '100.0');
  });
});

describe('domainMailboxTaken', () => {
  const accounts = [{ email_address: 'Sales@Example.com' }, { email_address: 'ops@example.org' }];

  it('finds an address that is already a mailbox, whatever the case and spaces', () => {
    assert.equal(domainMailboxTaken({ localPart: ' sales ', domain: 'example.com' }, accounts), true);
    assert.equal(domainMailboxTaken({ localPart: 'SALES', domain: 'EXAMPLE.COM' }, accounts), true);
  });

  it('lets the same name through on another domain, and says nothing for an empty form', () => {
    assert.equal(domainMailboxTaken({ localPart: 'sales', domain: 'example.org' }, accounts), false);
    assert.equal(domainMailboxTaken({ localPart: '', domain: 'example.com' }, accounts), false);
    assert.equal(domainMailboxTaken({ localPart: 'sales', domain: '' }, accounts), false);
    assert.equal(domainMailboxTaken({ localPart: 'sales', domain: 'example.com' }), false);
  });
});

describe('sender names', () => {
  it('requires the sender name of Our mailbox', () => {
    assert.equal(senderNameError('  '), 'admin.accounts.add.senderNameRequired');
    assert.equal(senderNameError(undefined), 'admin.accounts.add.senderNameRequired');
    assert.equal(senderNameError('Иван Петров'), null);
  });

  it('sends trimmed names, leaves empty ones out and drops a second name equal to the first', () => {
    assert.deepEqual(senderNamesPayload({ senderName: ' Иван Петров ', senderNameAlt: ' Ivan Petrov ' }),
      { senderName: 'Иван Петров', senderNameAlt: 'Ivan Petrov' });
    assert.deepEqual(senderNamesPayload({ senderName: 'Sales', senderNameAlt: 'sales' }), { senderName: 'Sales' });
    assert.deepEqual(senderNamesPayload({ senderName: '', senderNameAlt: '' }), {});
    assert.deepEqual(senderNamesPayload({ senderNameAlt: 'Ivan' }), { senderNameAlt: 'Ivan' });
  });
});
