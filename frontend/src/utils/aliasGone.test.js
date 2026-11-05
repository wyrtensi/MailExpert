import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAliasGone, isVanishedAliasFrom } from './aliasGone.js';

test('recognises the alias_gone refusal by its code', () => {
  assert.equal(isAliasGone(Object.assign(new Error('x'), { code: 'alias_gone' })), true);
  assert.equal(isAliasGone(Object.assign(new Error('x'), { code: 'node_alias_stale' })), false);
  assert.equal(isAliasGone(new Error('x')), false);
  assert.equal(isAliasGone(null), false);
});

// After an alias_gone refusal the mailbox list is read again and the dead alias drops out of it.
// From then still holds `alias:<id>:<account>`; the composer shows that as "removed alias" instead
// of letting the select display another sender the state does not hold.
test('isVanishedAliasFrom: an alias From value the mailbox no longer has', () => {
  const accounts = [
    { id: 'acc-1', aliases: [{ id: 'al-1', email: 'info@example.com' }] },
    { id: 'acc-2' },
  ];
  assert.equal(isVanishedAliasFrom('alias:al-1:acc-1', accounts), false);
  assert.equal(isVanishedAliasFrom('alias:al-9:acc-1', accounts), true);
  assert.equal(isVanishedAliasFrom('alias:al-1:acc-2', accounts), true);
  // The mailbox itself is gone: no option matches the value either.
  assert.equal(isVanishedAliasFrom('alias:al-1:acc-9', accounts), true);
  // Mailbox addresses and an empty value are never a vanished alias.
  assert.equal(isVanishedAliasFrom('account:acc-1', accounts), false);
  assert.equal(isVanishedAliasFrom('', accounts), false);
  assert.equal(isVanishedAliasFrom(null, accounts), false);
  // The mailbox list is not loaded yet: nothing to compare against.
  assert.equal(isVanishedAliasFrom('alias:al-1:acc-1', []), false);
  assert.equal(isVanishedAliasFrom('alias:al-1:acc-1', undefined), false);
});
