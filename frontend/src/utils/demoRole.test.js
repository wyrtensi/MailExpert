import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_ROLE_KEY, demoRole, switchDemoRole } from './demoRole.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
}

describe('demoRole', () => {
  it('is the administrator by default', () => {
    assert.equal(demoRole({ search: '', storage: memoryStorage() }), 'admin');
  });

  it('takes ?demoUser from the address and remembers it', () => {
    const storage = memoryStorage();
    assert.equal(demoRole({ search: '?demoUser=user', storage }), 'user');
    assert.equal(storage.data[DEMO_ROLE_KEY], 'user');
    assert.equal(demoRole({ search: '', storage }), 'user');
  });

  it('ignores unknown values and survives storage that throws', () => {
    assert.equal(demoRole({ search: '?demoUser=root', storage: memoryStorage({ [DEMO_ROLE_KEY]: 'boss' }) }), 'admin');
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(demoRole({ search: '?demoUser=user', storage: broken }), 'user');
    assert.equal(demoRole({ search: '', storage: broken }), 'admin');
  });
});

describe('switchDemoRole', () => {
  it('flips the role, stores it and reloads without the address parameter', () => {
    const storage = memoryStorage();
    let assigned = null;
    const location = { href: 'http://localhost:5190/?demoUser=admin#x', assign: (u) => { assigned = u; } };
    assert.equal(switchDemoRole('admin', { storage, location }), 'user');
    assert.equal(storage.data[DEMO_ROLE_KEY], 'user');
    assert.equal(assigned, 'http://localhost:5190/#x');
    assert.equal(switchDemoRole('user', { storage, location: null }), 'admin');
  });
});
