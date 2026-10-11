import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initialAddAccountFlow, transitionAddAccountFlow, upsertAccountById, newAttemptId, isAttemptId, submitWithReplay } from './addAccountFlow.js';

describe('add account flow state', () => {
  test('starts on the picker with nothing chosen', () => {
    assert.deepEqual(initialAddAccountFlow(), { screen: 'picker', provider: null, email: '' });
  });

  test('select opens that provider and keeps the typed address', () => {
    const typed = transitionAddAccountFlow(initialAddAccountFlow(), { type: 'email', email: 'a@example.com' });
    const next = transitionAddAccountFlow(typed, { type: 'select', provider: 'yahoo' });
    assert.deepEqual(next, { screen: 'form', provider: 'yahoo', email: 'a@example.com' });
  });

  test('select ignores an unknown provider', () => {
    const state = initialAddAccountFlow();
    assert.equal(transitionAddAccountFlow(state, { type: 'select', provider: 'nope' }), state);
  });

  test('back returns to the picker and keeps the address', () => {
    const form = { screen: 'form', provider: 'gmail', email: 'a@example.com' };
    assert.deepEqual(transitionAddAccountFlow(form, { type: 'back' }), { screen: 'picker', provider: null, email: 'a@example.com' });
  });

  test('close resets everything', () => {
    const form = { screen: 'form', provider: 'gmail', email: 'a@example.com' };
    assert.deepEqual(transitionAddAccountFlow(form, { type: 'close' }), initialAddAccountFlow());
  });

  test('an email event only applies to a string and does not touch the screen', () => {
    const form = { screen: 'form', provider: 'gmail', email: '' };
    assert.deepEqual(transitionAddAccountFlow(form, { type: 'email', email: 'x@y.z' }), { ...form, email: 'x@y.z' });
    assert.equal(transitionAddAccountFlow(form, { type: 'email', email: 7 }), form);
    assert.equal(transitionAddAccountFlow(form, { type: 'bogus' }), form);
  });

  test('state never carries a password field', () => {
    for (const key of Object.keys(initialAddAccountFlow())) assert.ok(!/pass|secret|token/i.test(key));
  });
});

describe('upsertAccountById', () => {
  test('appends a new account and replaces one with the same id without duplicating', () => {
    const list = [{ id: 'a', name: 'A' }];
    assert.deepEqual(upsertAccountById(list, { id: 'b', name: 'B' }), [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
    assert.deepEqual(upsertAccountById(list, { id: 'a', name: 'A2' }), [{ id: 'a', name: 'A2' }]);
    assert.equal(list.length, 1, 'input is not mutated');
  });

  test('tolerates a missing list and ignores an account without id', () => {
    assert.deepEqual(upsertAccountById(undefined, { id: 'x' }), [{ id: 'x' }]);
    assert.deepEqual(upsertAccountById([{ id: 'a' }], null), [{ id: 'a' }]);
    assert.deepEqual(upsertAccountById([{ id: 'a' }], {}), [{ id: 'a' }]);
  });
});

describe('attempt ids', () => {
  test('are opaque, unique and accepted by the validator', () => {
    const a = newAttemptId();
    const b = newAttemptId();
    assert.notEqual(a, b);
    assert.ok(isAttemptId(a));
    assert.ok(!isAttemptId('short'));
    assert.ok(!isAttemptId('has space has space has space'));
    assert.ok(!isAttemptId(undefined));
  });
});

describe('submitWithReplay', () => {
  test('replays a transport failure with the same attempt id and returns the result', async () => {
    const seen = [];
    const result = await submitWithReplay(async (id) => {
      seen.push(id);
      if (seen.length === 1) throw new TypeError('network down');
      return { ok: true };
    }, 'attempt-id-aaaaaaaaaaaa');
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(seen, ['attempt-id-aaaaaaaaaaaa', 'attempt-id-aaaaaaaaaaaa']);
  });

  test('does not replay a server answer, a coded refusal or a cancel', async () => {
    for (const err of [Object.assign(new Error('x'), { status: 409 }), Object.assign(new Error('x'), { code: 'invalid_credentials' }), Object.assign(new Error('x'), { name: 'AbortError' })]) {
      let calls = 0;
      await assert.rejects(submitWithReplay(async () => { calls += 1; throw err; }, 'id'), err);
      assert.equal(calls, 1);
    }
  });

  test('stops after the replay budget', async () => {
    let calls = 0;
    await assert.rejects(submitWithReplay(async () => { calls += 1; throw new TypeError('down'); }, 'id'));
    assert.equal(calls, 2);
  });
});

describe('newAttemptId without crypto.randomUUID (plain-HTTP installs)', () => {
  test('still returns a v4 UUID built from getRandomValues', () => {
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
    try {
      const ids = new Set(Array.from({ length: 50 }, () => newAttemptId()));
      assert.equal(ids.size, 50);
      for (const id of ids) {
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.ok(isAttemptId(id));
      }
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true, writable: true });
    }
  });
});
