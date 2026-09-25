import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { selectSelectedMessageIdentity, parseSelectedIdentity } = await import('./index.js');
globalThis.window = new EventTarget();

// The selected message's Message-ID and account come from ONE selector. It runs on every store
// update in every subscribed component (message list, GTD sidebar, GTD tab list), and two
// selectors each scanning the list and every cached thread doubled that work.

function state(overrides = {}) {
  return { selectedMessageId: null, searchQuery: '', messages: [], searchResults: [], threadMessages: {}, ...overrides };
}

test('returns the message id and account of the selected list row', () => {
  const s = state({
    selectedMessageId: 'r2',
    messages: [
      { id: 'r1', message_id: '<m1>', account_id: 'sales' },
      { id: 'r2', message_id: '<m1>', account_id: 'info' },
    ],
  });
  assert.deepEqual(parseSelectedIdentity(selectSelectedMessageIdentity(s)), { mid: '<m1>', accountId: 'info' });
});

test('finds a selected thread sub-message and keeps a missing Message-ID as null', () => {
  const s = state({
    selectedMessageId: 'sub',
    threadMessages: { 'info:t1': [{ id: 'sub', message_id: null, account_id: 'info' }] },
  });
  assert.deepEqual(parseSelectedIdentity(selectSelectedMessageIdentity(s)), { mid: null, accountId: 'info' });
});

test('is null with nothing selected, and parses to nulls', () => {
  assert.equal(selectSelectedMessageIdentity(state()), null);
  assert.deepEqual(parseSelectedIdentity(null), { mid: null, accountId: null });
});

test('is a primitive that stays equal while the selection does, so subscribers do not re-render', () => {
  const messages = [{ id: 'r1', message_id: '<m1>', account_id: 'sales' }];
  const a = selectSelectedMessageIdentity(state({ selectedMessageId: 'r1', messages }));
  const b = selectSelectedMessageIdentity(state({ selectedMessageId: 'r1', messages: [...messages] }));
  assert.equal(typeof a, 'string');
  assert.equal(a, b);
});

test('scans the pools once per call', () => {
  let scans = 0;
  const s = state({ selectedMessageId: 'sub' });
  Object.defineProperty(s, 'threadMessages', {
    get() { scans += 1; return { 'info:t1': [{ id: 'sub', message_id: '<m1>', account_id: 'info' }] }; },
  });
  selectSelectedMessageIdentity(s);
  assert.equal(scans, 1);
});
