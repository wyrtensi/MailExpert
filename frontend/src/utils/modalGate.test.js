import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isModalOpen } from './modalGate.js';

test('the add-account dialog counts as an open modal', () => {
  assert.equal(isModalOpen({ showAddAccountDialog: true }), true);
  assert.equal(isModalOpen({ showAddAccountDialog: false }), false);
  assert.equal(isModalOpen(undefined), false);
});
