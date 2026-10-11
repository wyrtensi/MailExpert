import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountSearchText, buildAccountSearchIndex, searchAccounts } from './accountSearch.js';

const ACCOUNTS = [
  {
    id: 'a1', name: 'Sales Team', email_address: 'sales@example.com', sender_name: 'Acme Sales Desk',
    protocol: 'imap', imap_host: 'imap.example.com',
    aliases: [{ id: 'x1', name: 'Quotes', email: 'quotes@example.com', reply_to: 'boss@elsewhere.test' }],
  },
  {
    id: 'a2', name: 'Support', email_address: 'Help.Desk@Gmail.com', oauth_provider: 'google', protocol: 'imap',
    imap_host: 'imap.gmail.com', aliases: [],
  },
  { id: 'a3', name: 'Ops', email_address: 'ops@corp.example', oauth_provider: 'microsoft', protocol: 'imap', aliases: null },
  { id: 'a4', name: 'Node box', email_address: 'box@node.example', mail_node: true, protocol: 'imap' },
  { id: 'a5', name: null, email_address: undefined },
];
const ids = (list) => list.map(a => a.id);
const find = (query, options) => ids(searchAccounts(buildAccountSearchIndex(ACCOUNTS, options), query));

describe('accountSearchText', () => {
  it('is lower case and joins name, address, sender name, aliases and provider', () => {
    const text = accountSearchText(ACCOUNTS[0]);
    for (const part of ['sales team', 'sales@example.com', 'acme sales desk', 'quotes', 'quotes@example.com']) {
      assert.ok(text.includes(part), part);
    }
    assert.equal(text, text.toLowerCase());
  });

  it('survives accounts with missing or odd fields', () => {
    assert.equal(typeof accountSearchText({}), 'string');
    assert.equal(typeof accountSearchText(null), 'string');
    assert.equal(typeof accountSearchText({ aliases: 'nope', name: 7 }), 'string');
  });
});

describe('searchAccounts', () => {
  it('returns every account for a blank query, as the same list', () => {
    const index = buildAccountSearchIndex(ACCOUNTS);
    assert.deepEqual(ids(searchAccounts(index, '')), ids(ACCOUNTS));
    assert.deepEqual(ids(searchAccounts(index, '   ')), ids(ACCOUNTS));
    assert.deepEqual(ids(searchAccounts(index, null)), ids(ACCOUNTS));
  });

  it('matches the address, case-insensitively', () => {
    assert.deepEqual(find('HELP.desk@gmail'), ['a2']);
    assert.deepEqual(find('sales@'), ['a1']);
  });

  it('matches the display name', () => {
    assert.deepEqual(find('support'), ['a2']);
    assert.deepEqual(find('NODE BOX'), ['a4']);
  });

  it('matches the sender name', () => {
    assert.deepEqual(find('sales desk'), ['a1']);
  });

  it('matches an alias name, address and reply-to', () => {
    assert.deepEqual(find('quotes'), ['a1']);
    assert.deepEqual(find('quotes@example'), ['a1']);
    assert.deepEqual(find('elsewhere.test'), ['a1']);
  });

  it('matches the provider', () => {
    assert.deepEqual(find('google'), ['a2']);
    assert.deepEqual(find('gmail'), ['a2']);
    assert.deepEqual(find('outlook'), ['a3']);
    assert.deepEqual(find('microsoft'), ['a3']);
    assert.deepEqual(find('mail node'), ['a4']);
  });

  it('matches the translated mail node label it is given', () => {
    assert.deepEqual(find('почтовый узел', { mailNodeLabel: 'Почтовый узел' }), ['a4']);
  });

  it('matches the mail server by its own name', () => {
    const custom = [...ACCOUNTS, { id: 'a6', name: 'Fast', email_address: 'me@own.test', imap_host: 'imap.fastmail.com', smtp_host: 'smtp.fastmail.com', protocol: 'imap' }];
    const got = (q) => ids(searchAccounts(buildAccountSearchIndex(custom), q));
    assert.deepEqual(got('fastmail'), ['a6']);
    assert.deepEqual(got('fastmail.com'), ['a6']);
  });

  it('does not index what every mailbox has, so \'imap\', \'smtp\' and \'mail.\' match nothing on their own', () => {
    assert.deepEqual(find('imap'), []);
    assert.deepEqual(find('smtp'), []);
    assert.deepEqual(find('imap.gmail'), [], 'the role label of the host is not part of the name');
  });

  it('requires every word of the query, in any order', () => {
    assert.deepEqual(find('example sales'), ['a1']);
    assert.deepEqual(find('sales gmail'), []);
  });

  it('returns nothing when nothing matches', () => {
    assert.deepEqual(find('zzz-no-such'), []);
  });

  it('keeps the input order', () => {
    assert.deepEqual(find('example'), ['a1', 'a3', 'a4']);
  });

  it('stays fast for a few hundred accounts', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({
      id: `m${i}`, name: `Mailbox ${i}`, email_address: `box${i}@corp${i % 7}.example`, protocol: 'imap',
      aliases: [{ id: `al${i}`, name: `Alias ${i}`, email: `alias${i}@corp.example` }],
    }));
    const index = buildAccountSearchIndex(many);
    const started = performance.now();
    for (let i = 0; i < 200; i++) searchAccounts(index, `box${i % 600} corp`);
    assert.ok(performance.now() - started < 500, 'the keystroke path is a plain substring scan');
    assert.equal(searchAccounts(index, 'box599@corp4').length, 1);
  });
});

describe('provider keywords', () => {
  const PROVIDERS = [
    { id: 'p1', name: 'One', email_address: 'one@yandex.ru', mail_provider: 'yandex', connection_mode: 'preset', imap_host: 'imap.yandex.ru' },
    { id: 'p2', name: 'Two', email_address: 'two@proton.me', mail_provider: 'proton', connection_mode: 'managed', imap_host: '127.0.0.1' },
    { id: 'p3', name: 'Three', email_address: 'three@example.test', mail_provider: 'other', connection_mode: 'manual', imap_host: 'imap.example.test' },
    { id: 'p4', name: 'Four', email_address: 'four@mail.ru', mail_provider: 'mailru', connection_mode: 'preset' },
    { id: 'p5', name: 'Five', email_address: 'five@icloud.com', mail_provider: 'icloud', connection_mode: 'preset' },
  ];
  const run = (query) => ids(searchAccounts(buildAccountSearchIndex(PROVIDERS), query));

  it('search_matches_provider_email_sender_alias: a Russian and an English name find the same account', () => {
    assert.deepEqual(run('Яндекс'), run('yandex'));
    assert.deepEqual(run('yandex'), ['p1']);
    assert.deepEqual(run('протон'), ['p2']);
    assert.deepEqual(run('майл'), ['p4']);
    assert.deepEqual(run('apple'), ['p5']);
  });

  it('reads the connection mode in both languages', () => {
    assert.deepEqual(run('управляемый'), ['p2']);
    assert.deepEqual(run('managed'), ['p2']);
    assert.deepEqual(run('ручной'), ['p3']);
    assert.deepEqual(run('manual'), ['p3']);
  });

  it('does not index the loopback host of a managed mailbox', () => {
    assert.deepEqual(run('127.0.0.1'), []);
    assert.equal(accountSearchText(PROVIDERS[1]).includes('127.0.0.1'), false);
  });
});
