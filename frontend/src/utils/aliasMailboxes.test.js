import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aliasMailboxRows, aliasSentFolder, composeDataForView, filterAliasRows, replyAliasesOf, resolveSelectedAlias,
  viewReplyAliasId,
} from './aliasMailboxes.js';

const alias = (id, email, name = null) => ({ id, email, name });
const acc = (id, extra = {}) => ({ id, email_address: `${id}@example.com`, color: `c-${id}`, aliases: [], ...extra });

test('aliasMailboxRows lists aliases of all mailboxes in sortAliasesByName order with the mailbox color', () => {
  const rows = aliasMailboxRows([
    acc('a', { aliases: [alias('a1', 'zeta@example.com', 'Zeta'), alias('a2', 'mid@example.com')] }),
    acc('b', { aliases: [alias('b1', 'alpha@example.com', 'Alpha'), alias('b2', 'beta@example.com')] }),
  ]);
  assert.deepEqual(rows, [
    { key: 'b:b1', accountId: 'b', aliasId: 'b1', name: 'Alpha', email: 'alpha@example.com', color: 'c-b' },
    { key: 'b:b2', accountId: 'b', aliasId: 'b2', name: 'beta', email: 'beta@example.com', color: 'c-b' },
    { key: 'a:a2', accountId: 'a', aliasId: 'a2', name: 'mid', email: 'mid@example.com', color: 'c-a' },
    { key: 'a:a1', accountId: 'a', aliasId: 'a1', name: 'Zeta', email: 'zeta@example.com', color: 'c-a' },
  ]);
});

test("aliasMailboxRows skips the mailbox's own address in any case, a mail node mailbox, a disabled mailbox and a second alias with the same address", () => {
  const rows = aliasMailboxRows([
    acc('a', { aliases: [alias('a1', 'A@Example.com'), alias('a2', 'x@example.com', 'First'), alias('a3', 'X@example.com', 'Second')] }),
    acc('n', { mail_node: true, aliases: [alias('n1', 'n-alias@example.com')] }),
    acc('d', { enabled: false, aliases: [alias('d1', 'd-alias@example.com')] }),
  ]);
  assert.deepEqual(rows.map((r) => r.key), ['a:a2']);
  assert.deepEqual(replyAliasesOf(acc('n', { mail_node: true, aliases: [alias('n1', 'q@example.com')] })), []);
  assert.deepEqual(replyAliasesOf(null), []);
});

test('filterAliasRows matches name and address, case-insensitive', () => {
  const rows = aliasMailboxRows([acc('a', { aliases: [alias('a1', 'sales@example.com', 'Vendor Desk'), alias('a2', 'ops@example.com', 'Ops')] })]);
  assert.equal(filterAliasRows(rows, '  ').length, 2);
  assert.equal(filterAliasRows(rows, '').length, 2);
  assert.deepEqual(filterAliasRows(rows, 'VENDOR').map((r) => r.aliasId), ['a1']);
  assert.deepEqual(filterAliasRows(rows, 'OPS@EX').map((r) => r.aliasId), ['a2']);
});

const accounts = [acc('a', { aliases: [alias('a1', 'x@example.com', 'X')] }), acc('b', { aliases: [alias('b1', 'y@example.com', 'Y')] })];

test('resolveSelectedAlias keeps a current alias and drops a removed one, one of another mailbox, and any when the mode is off', () => {
  const base = { accounts, accountsReady: true, selectedAccountId: 'a', selectedAliasId: 'a1', enabled: true };
  assert.equal(resolveSelectedAlias(base), 'a1');
  assert.equal(resolveSelectedAlias({ ...base, selectedAliasId: 'gone' }), null);
  assert.equal(resolveSelectedAlias({ ...base, selectedAliasId: 'b1' }), null);
  assert.equal(resolveSelectedAlias({ ...base, selectedAccountId: 'b' }), null);
  assert.equal(resolveSelectedAlias({ ...base, enabled: false }), null);
  assert.equal(resolveSelectedAlias({ ...base, selectedAliasId: null }), null);
});

test('resolveSelectedAlias keeps the alias while the mailbox list is not loaded yet', () => {
  assert.equal(resolveSelectedAlias({ accounts: [], accountsReady: false, selectedAccountId: 'a', selectedAliasId: 'a1', enabled: true }), 'a1');
  assert.equal(resolveSelectedAlias({ accounts: [], accountsReady: false, selectedAccountId: 'a', selectedAliasId: 'a1', enabled: false }), null);
});

test('aliasSentFolder prefers the mapping present in the folder list, then the \\Sent folder, else null', () => {
  const folders = [{ path: 'INBOX' }, { path: 'Sent Items', special_use: '\\Sent' }, { path: 'Mapped' }];
  assert.equal(aliasSentFolder({ folder_mappings: { sent: 'Mapped' } }, folders), 'Mapped');
  assert.equal(aliasSentFolder({ folder_mappings: { sent: 'Missing' } }, folders), 'Sent Items');
  assert.equal(aliasSentFolder({}, folders), 'Sent Items');
  assert.equal(aliasSentFolder({}, [{ path: 'INBOX' }]), null);
  assert.equal(aliasSentFolder({}, undefined), null);
});

test('composeDataForView carries aliasId only with an account', () => {
  assert.deepEqual(composeDataForView({ selectedAccountId: 'a', selectedAliasId: 'a1' }), { accountId: 'a', aliasId: 'a1' });
  assert.deepEqual(composeDataForView({ selectedAccountId: 'a', selectedAliasId: null }), { accountId: 'a' });
  assert.deepEqual(composeDataForView({ selectedAccountId: null, selectedAliasId: 'a1' }), {});
});

test("viewReplyAliasId answers only for a letter of the open alias's mailbox", () => {
  const view = { selectedAccountId: 'a', selectedAliasId: 'a1' };
  assert.equal(viewReplyAliasId({ account_id: 'a' }, view), 'a1');
  assert.equal(viewReplyAliasId({ account_id: 'b' }, view), null);
  assert.equal(viewReplyAliasId({ account_id: 'a' }, { selectedAccountId: 'a', selectedAliasId: null }), null);
  assert.equal(viewReplyAliasId(null, view), null);
});
