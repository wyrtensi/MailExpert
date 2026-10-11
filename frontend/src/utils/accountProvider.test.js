import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountProviderLabels, PROVIDER_LABEL_KEYS } from './accountProvider.js';

describe('accountProviderLabels', () => {
  it('maps every stored provider and mode to a key', () => {
    assert.deepEqual(accountProviderLabels({ mail_provider: 'proton', connection_mode: 'managed' }),
      { provider: 'admin.accounts.provider.proton', mode: 'admin.accounts.mode.managed' });
    assert.equal(accountProviderLabels({ mail_provider: 'other', connection_mode: 'manual' }).mode, 'admin.accounts.mode.manual');
    assert.equal(Object.keys(PROVIDER_LABEL_KEYS).length, 9);
  });
  it('leaves out what it does not know', () => {
    assert.deepEqual(accountProviderLabels({ mail_provider: 'constructor', connection_mode: '__proto__' }), { provider: null, mode: null });
    assert.deepEqual(accountProviderLabels(null), { provider: null, mode: null });
  });
});
