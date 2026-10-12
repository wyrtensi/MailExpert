import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthReturnWatch } from './oauthReturnWatch.js';

// A fake window: counts listeners and lets the test fire 'focus'.
function fakeTarget() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener: (type, fn) => { if (type === 'focus') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'focus') listeners.delete(fn); },
    focus: () => [...listeners].map((fn) => fn()),
  };
}

function setup({ maxWaits } = {}) {
  const target = fakeTarget();
  let clock = 1_000_000;
  let accounts = [];
  let reads = 0;
  const watch = createOAuthReturnWatch({
    target,
    now: () => clock,
    interval: 3000,
    maxWaits,
    reconcile: () => { reads += 1; return Promise.resolve(); },
    getAccounts: () => accounts,
  });
  return {
    watch, target,
    tick: (ms) => { clock += ms; },
    now: () => clock,
    setAccounts: (list) => { accounts = list; },
    reads: () => reads,
    focus: async () => { await Promise.all(target.focus()); },
  };
}

describe('oauthReturnWatch', () => {
  it('listens only while an attempt waits, and reads the list on a return', async () => {
    const t = setup();
    assert.equal(t.target.listeners.size, 0);
    t.watch.watch({ attemptId: 'a', email: 'Me@Example.com', until: t.now() + 600_000 });
    assert.equal(t.target.listeners.size, 1);
    await t.focus();
    assert.equal(t.reads(), 1);
  });

  it('keeps reading after the form is gone (released), and stops when the launched address appears', async () => {
    const t = setup();
    let found = 0;
    t.watch.watch({ attemptId: 'a', email: 'me@example.com', until: t.now() + 600_000, onFound: () => { found += 1; } });
    t.watch.release('a'); // the dialog was closed
    await t.focus();
    assert.equal(t.reads(), 1, 'the list is still refreshed on return');
    t.tick(5000);
    t.setAccounts([{ email_address: ' ME@example.com ' }]);
    await t.focus();
    assert.equal(t.reads(), 2);
    assert.equal(found, 0, 'a released wait reports to nobody');
    assert.equal(t.target.listeners.size, 0, 'nothing waits any more');
  });

  it('reports to the form that still waits', async () => {
    const t = setup();
    const found = [];
    t.watch.watch({ attemptId: 'a', email: 'me@example.com', until: t.now() + 600_000, onFound: () => found.push('a') });
    t.setAccounts([{ email_address: 'me@example.com' }]);
    await t.focus();
    assert.deepEqual(found, ['a']);
  });

  it('a burst of returns is one read; the interval tolerates a clock that moved back', async () => {
    const t = setup();
    t.watch.watch({ attemptId: 'a', email: 'me@example.com', until: t.now() + 600_000 });
    await t.focus();
    await t.focus();
    assert.equal(t.reads(), 1);
    t.tick(-60_000);
    await t.focus();
    assert.equal(t.reads(), 2, 'a clock set back does not block reads');
  });

  it('gives up at the OAuth state lifetime', async () => {
    const t = setup();
    t.watch.watch({ attemptId: 'a', email: 'me@example.com', until: t.now() + 600_000 });
    t.tick(601_000);
    await t.focus();
    assert.equal(t.reads(), 0);
    assert.equal(t.target.listeners.size, 0);
  });

  it('forget ends a wait (its callback reported a result)', async () => {
    const t = setup();
    t.watch.watch({ attemptId: 'a', email: 'me@example.com', until: t.now() + 600_000 });
    t.watch.forget('a');
    assert.equal(t.target.listeners.size, 0);
    await t.focus();
    assert.equal(t.reads(), 0);
  });

  it('holds a bounded number of waits, dropping the oldest', async () => {
    const t = setup({ maxWaits: 2 });
    const found = [];
    for (const id of ['a', 'b', 'c']) {
      t.watch.watch({ attemptId: id, email: `${id}@example.com`, until: t.now() + 600_000, onFound: () => found.push(id) });
    }
    t.setAccounts(['a', 'b', 'c'].map((id) => ({ email_address: `${id}@example.com` })));
    await t.focus();
    assert.deepEqual(found, ['b', 'c']);
  });

  it('watching the same attempt again replaces it', async () => {
    const t = setup();
    const found = [];
    t.watch.watch({ attemptId: 'a', email: 'old@example.com', until: t.now() + 600_000, onFound: () => found.push('old') });
    t.watch.watch({ attemptId: 'a', email: 'new@example.com', until: t.now() + 600_000, onFound: () => found.push('new') });
    t.setAccounts([{ email_address: 'old@example.com' }, { email_address: 'new@example.com' }]);
    await t.focus();
    assert.deepEqual(found, ['new']);
  });
});
