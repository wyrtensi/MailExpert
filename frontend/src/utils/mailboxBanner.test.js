import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mailboxBanner } from './mailboxBanner.js';

const account = { email_address: 'Sales@example.com', aliases: [{ email: 'info@example.com' }] };

describe('mailboxBanner', () => {
  it('names the mailbox a letter arrived in, with no extra address when it came to the mailbox itself', () => {
    assert.deepEqual(mailboxBanner({ from_email: 'client@example.net', delivery_addresses: ['sales@example.com'] }, account),
      { direction: 'in', via: null });
    assert.deepEqual(mailboxBanner({ from_email: 'client@example.net' }, account), { direction: 'in', via: null });
  });

  it('shows the address it was delivered to when that is an alias or a group address', () => {
    assert.deepEqual(mailboxBanner({ from_email: 'client@example.net', delivery_addresses: '["team@example.com"]' }, account),
      { direction: 'in', via: 'team@example.com' });
  });

  it('says the mailbox sent it when the mailbox or one of its aliases wrote it', () => {
    assert.equal(mailboxBanner({ from_email: 'sales@example.com' }, account).direction, 'out');
    assert.equal(mailboxBanner({ from_email: 'INFO@example.com' }, account).direction, 'out');
  });

  it('falls back to the address on the letter row when the mailbox is not in the store', () => {
    assert.equal(mailboxBanner({ from_email: 'ops@example.com', account_email: 'ops@example.com' }, null).direction, 'out');
  });
});
