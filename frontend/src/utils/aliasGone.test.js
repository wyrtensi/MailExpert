import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAliasGone } from './aliasGone.js';

test('recognises the alias_gone refusal by its code', () => {
  assert.equal(isAliasGone(Object.assign(new Error('x'), { code: 'alias_gone' })), true);
  assert.equal(isAliasGone(Object.assign(new Error('x'), { code: 'node_alias_stale' })), false);
  assert.equal(isAliasGone(new Error('x')), false);
  assert.equal(isAliasGone(null), false);
});
