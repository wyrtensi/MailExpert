import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget();

// Everything one signed-in user has loaded: mailboxes, folders, mail, search, an open draft.
function loadPrivateState() {
  const s = useStore.getState();
  s.setAccounts([{ id: 'acct-a', enabled: true, email_address: 'a@example.com' }]);
  s.setFolders('acct-a', [{ path: 'INBOX', name: 'Inbox' }]);
  s.setMessages([{ id: 'm1', account_id: 'acct-a', folder: 'INBOX', uid: 1, subject: 'Private' }]);
  s.setSearchResults([{ id: 'm1', subject: 'Private' }]);
  s.addNotification({ title: 'New mail', body: 'Private' });
  s.openCompose({ accountId: 'acct-a', subject: 'Draft' });
}

function assertNoPrivateState(state) {
  assert.deepEqual(state.accounts, []);
  assert.deepEqual(state.folders, {});
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.searchResults, []);
  assert.deepEqual(state.notifications, []);
  assert.equal(state.composing, false);
  assert.equal(state.composeData, null);
}

beforeEach(() => {
  useStore.getState().setLocked(false);
  useStore.getState().setUser({ id: 'u1' });
});

test('an expired session drops the previous user\'s mail state', () => {
  loadPrivateState();
  useStore.getState().setUser(null);
  assertNoPrivateState(useStore.getState());
});

test('signing in as someone else drops the previous user\'s mail state', () => {
  loadPrivateState();
  useStore.getState().setUser({ id: 'u2' });
  assertNoPrivateState(useStore.getState());
});

test('refreshing the same user keeps the loaded mail state', () => {
  loadPrivateState();
  useStore.getState().setUser({ id: 'u1', displayName: 'Renamed' });
  const state = useStore.getState();
  assert.equal(state.accounts.length, 1);
  assert.equal(state.messages.length, 1);
  assert.equal(state.composing, true);
});
