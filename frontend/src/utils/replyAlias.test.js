import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchReplyAlias, parseAddressListField, pickReplyAlias } from './replyAlias.js';
import { recipientAliasFor } from './mailboxBanner.js';

const aliases = [
  { id: 'alias-1', email: 'sales@example.com' },
  { id: 'alias-2', email: 'support@example.com' },
];

describe('parseAddressListField', () => {
  it('returns arrays as-is', () => {
    const arr = [{ email: 'a@example.com' }];
    assert.equal(parseAddressListField(arr), arr);
  });

  it('parses a JSON string', () => {
    assert.deepEqual(parseAddressListField('[{"email":"a@example.com"}]'), [{ email: 'a@example.com' }]);
  });

  it('is null-safe for malformed JSON', () => {
    assert.deepEqual(parseAddressListField('not json'), []);
  });

  it('defaults missing input to []', () => {
    assert.deepEqual(parseAddressListField(undefined), []);
    assert.deepEqual(parseAddressListField(null), []);
  });
});

describe('pickReplyAlias', () => {
  it('matches a delivery address not present in To/Cc (BCC / catch-all case)', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['sales@example.com'],
      toAddresses: [{ email: 'someone-else@example.com' }],
      ccAddresses: [],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('matches To when there is no delivery address hit (unchanged semantics)', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [{ email: 'support@example.com' }],
      ccAddresses: [],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-2');
  });

  it('matches Cc when there is no delivery or To hit', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [],
      ccAddresses: [{ email: 'sales@example.com' }],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('falls back to from_email when nothing else matches', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [],
      ccAddresses: [],
      fromEmail: 'support@example.com',
    });
    assert.equal(result, 'alias-2');
  });

  it('prefers the delivery address match over a different To/Cc match', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['sales@example.com'],
      toAddresses: [{ email: 'support@example.com' }],
      ccAddresses: [],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('returns null when the account has no aliases', () => {
    const result = pickReplyAlias({
      aliases: [],
      deliveryAddresses: ['sales@example.com'],
      toAddresses: [],
      ccAddresses: [],
      fromEmail: '',
    });
    assert.equal(result, null);
  });

  it('is null-safe against malformed JSON strings', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: 'not json',
      toAddresses: 'not json',
      ccAddresses: 'not json',
      fromEmail: '',
    });
    assert.equal(result, null);
  });

  it('matches case-insensitively', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['SALES@Example.com'],
      toAddresses: [],
      ccAddresses: [],
      fromEmail: '',
    });
    assert.equal(result, 'alias-1');
  });

  it('keeps alias creation order as the tiebreak when To and Cc match different aliases', () => {
    // alias-1 was created first; the original matcher scanned aliases against
    // the combined To+Cc set, so it wins even though alias-2 is in To.
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [{ email: 'support@example.com' }],
      ccAddresses: [{ email: 'sales@example.com' }],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('keeps alias creation order as the tiebreak between a From match and a Cc match', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [],
      ccAddresses: [{ email: 'support@example.com' }],
      fromEmail: 'sales@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('lets a delivery match beat alias creation order', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['support@example.com'],
      toAddresses: [{ email: 'sales@example.com' }],
      ccAddresses: [],
      fromEmail: '',
    });
    assert.equal(result, 'alias-2');
  });
});

describe('pickReplyAlias with a second sender name', () => {
  const second = { id: 'al-second', email: 'Sales@Example.com' };
  const other = { id: 'al-other', email: 'info@example.com' };

  it('replies under the main name: an alias with the mailbox address never wins', () => {
    assert.equal(pickReplyAlias({
      aliases: [second], deliveryAddresses: ['sales@example.com'], toAddresses: [{ email: 'sales@example.com' }],
      fromEmail: 'client@example.net', accountEmail: 'sales@example.com',
    }), null);
    // A letter from Sent, written under the second name, still replies under the main one.
    assert.equal(pickReplyAlias({
      aliases: [second], toAddresses: [{ email: 'client@example.net' }], fromEmail: 'sales@example.com', accountEmail: 'sales@example.com',
    }), null);
  });

  it('still picks an alias with its own address next to it', () => {
    assert.equal(pickReplyAlias({
      aliases: [second, other], deliveryAddresses: ['info@example.com'], accountEmail: 'sales@example.com',
    }), 'al-other');
  });
});

describe('pickReplyAlias for a mail node mailbox (D-16)', () => {
  const aliases = [{ id: 'old', name: 'Orders desk', email: 'orders@example.com' }];
  const letter = { deliveryAddresses: ['orders@example.com'], toAddresses: [{ email: 'orders@example.com' }], accountEmail: 'sales@example.com' };

  it('never picks an alias with another address: sending from it is refused', () => {
    assert.equal(pickReplyAlias({ aliases, ...letter, mailNode: true }), null);
  });

  it('still picks it for a mailbox that is not on the mail node', () => {
    assert.equal(pickReplyAlias({ aliases, ...letter }), 'old');
  });
});

describe('matchReplyAlias', () => {
  const letters = [
    { deliveryAddresses: ['sales@example.com'], toAddresses: [{ email: 'someone-else@example.com' }], fromEmail: 'them@example.com' },
    { toAddresses: [{ email: 'support@example.com' }], fromEmail: 'them@example.com' },
    { ccAddresses: [{ email: 'sales@example.com' }], fromEmail: 'them@example.com' },
    { fromEmail: 'support@example.com' },
    { toAddresses: [{ email: 'support@example.com' }], ccAddresses: [{ email: 'sales@example.com' }] },
    { deliveryAddresses: ['support@example.com'], toAddresses: [{ email: 'sales@example.com' }] },
    { toAddresses: [{ email: 'nobody@example.com' }], fromEmail: 'them@example.com' },
    { deliveryAddresses: 'not json', toAddresses: 'not json', ccAddresses: 'not json' },
  ];

  it('pickReplyAlias returns the same ids as before', () => {
    const expected = ['alias-1', 'alias-2', 'alias-1', 'alias-2', 'alias-1', 'alias-2', null, null];
    assert.deepEqual(letters.map(letter => pickReplyAlias({ aliases, ...letter })), expected);
    assert.deepEqual(letters.map(letter => matchReplyAlias({ aliases, ...letter })?.id ?? null), expected);
  });

  it('matchReplyAlias returns the alias object', () => {
    assert.equal(matchReplyAlias({ aliases, toAddresses: [{ email: 'support@example.com' }] }), aliases[1]);
    assert.equal(matchReplyAlias({ aliases, toAddresses: [{ email: 'nobody@example.com' }] }), null);
    assert.equal(matchReplyAlias({ aliases, toAddresses: [{ email: 'support@example.com' }], mailNode: true }), null);
  });
});

describe('recipientAliasFor', () => {
  const account = {
    id: 'acct-1',
    email_address: 'team@example.com',
    aliases: [
      { id: 'al-1', email: 'sales@example.com' },
      { id: 'al-2', email: 'support@example.com' },
      { id: 'al-own', email: 'Team@Example.com' },
    ],
  };
  const incoming = (fields) => ({ account_id: 'acct-1', folder: 'INBOX', from_email: 'client@example.net', ...fields });

  it('recipientAliasFor returns the alias email for an incoming letter addressed to it in To or Cc', () => {
    assert.equal(recipientAliasFor(incoming({ to_addresses: [{ email: 'Sales@example.com' }] }), account), 'sales@example.com');
    assert.equal(recipientAliasFor(incoming({
      to_addresses: JSON.stringify([{ email: 'team@example.com' }]),
      cc_addresses: JSON.stringify([{ email: 'support@example.com' }]),
    }), account), 'support@example.com');
    assert.equal(recipientAliasFor(incoming({ delivery_addresses: ['support@example.com'] }), account), 'support@example.com');
  });

  it('recipientAliasFor returns null for the mailbox\'s own address, an outgoing letter, an address that is not a current alias, a node mailbox', () => {
    // The mailbox's own address, also when an alias row (a second sender name) carries it.
    assert.equal(recipientAliasFor(incoming({ to_addresses: [{ email: 'team@example.com' }] }), account), null);
    // An outgoing letter from an alias to a client.
    assert.equal(recipientAliasFor({
      account_id: 'acct-1', folder: 'Sent', from_email: 'sales@example.com', to_addresses: [{ email: 'client@example.net' }],
    }, { ...account, folder_mappings: { sent: 'Sent' } }), null);
    // An address on the same domain that is not a current alias of this mailbox.
    assert.equal(recipientAliasFor(incoming({ to_addresses: [{ email: 'billing@example.com' }] }), account), null);
    // A mail node mailbox sends only from its own address (D-16).
    assert.equal(recipientAliasFor(incoming({ to_addresses: [{ email: 'sales@example.com' }] }), { ...account, mail_node: true }), null);
    // No account loaded yet.
    assert.equal(recipientAliasFor(incoming({ to_addresses: [{ email: 'sales@example.com' }] }), undefined), null);
  });

  it('recipientAliasFor and pickReplyAlias agree on the same message', () => {
    // Delivered-To says one alias, To another, Cc a third address: both must pick the same one.
    const message = incoming({
      delivery_addresses: ['support@example.com'],
      to_addresses: [{ email: 'sales@example.com' }],
      cc_addresses: [{ email: 'team@example.com' }],
    });
    // The same fields every reply path (list swipe, context menu, reading pane) passes.
    const id = pickReplyAlias({
      aliases: account.aliases,
      deliveryAddresses: message.delivery_addresses,
      toAddresses: message.to_addresses,
      ccAddresses: message.cc_addresses,
      fromEmail: message.from_email,
      accountEmail: account.email_address,
      mailNode: account.mail_node === true,
    });
    assert.equal(recipientAliasFor(message, account), account.aliases.find(a => a.id === id).email);
  });
});
