import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountLabel } from './accountLabel.js';

describe('accountLabel', () => {
  const accounts = [
    { id: 'a', name: 'Sales', email_address: 'sales@example.com' },
    { id: 'b', name: '', email_address: 'help@example.com' },
  ];

  it('names an account by its display name, then its address', () => {
    assert.equal(accountLabel(accounts, 'a'), 'Sales');
    assert.equal(accountLabel(accounts, 'b'), 'help@example.com');
  });

  it('is empty for an unknown account', () => {
    assert.equal(accountLabel(accounts, 'missing'), '');
    assert.equal(accountLabel(undefined, 'a'), '');
  });
});
