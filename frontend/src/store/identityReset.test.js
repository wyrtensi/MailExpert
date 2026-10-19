import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const stored = new Map();
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: key => stored.delete(key),
};
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
  stored.clear();
  useStore.getState().setLocked(false);
  useStore.getState().setUser({ id: 'u1' });
});

test('leaving a session resets personal settings and the remembered locked message', () => {
  const removed = [];
  const previousRemove = localStorage.removeItem;
  localStorage.removeItem = key => removed.push(key);
  try {
    useStore.setState({ autoLockMinutes: 30, blockRemoteImages: true,
      imageWhitelist: { addresses: ['allowed@example.com'], domains: [] },
      hiddenFolders: { account: ['INBOX'] }, shortcuts: { next: 'z' } });
    useStore.getState().setUser(null);
    const state = useStore.getState();
    assert.equal(state.autoLockMinutes, 0);
    assert.equal(state.blockRemoteImages, false);
    assert.deepEqual(state.imageWhitelist, { addresses: [], domains: [] });
    assert.deepEqual(state.hiddenFolders, {});
    assert.deepEqual(state.shortcuts, {});
    assert.ok(removed.includes('mailexpert_locked_message'));
  } finally { localStorage.removeItem = previousRemove; }
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

const personalFolders = {
  favoriteFolders: [{ accountId: 'acct-a', path: 'Projects' }],
  recentFolders: [{ accountId: 'acct-a', path: 'Archive' }],
  defaultSender: 'account:acct-a', collapsedFolders: ['acct-a:Projects'],
  expandedAccounts: { 'acct-a': true },
};
const personalFolderKeys = [
  'mailexpert_favorite_folders', 'mailexpert_recent_folders',
  'mailexpert_default_sender', 'mailexpert_last_from_account',
  'mailexpert_collapsed_folders', 'mailexpert_expanded_accounts',
];

function loadPersonalFolders() {
  useStore.setState(personalFolders);
  for (const key of personalFolderKeys) localStorage.setItem(key, 'previous-user');
}

for (const [label, nextUser] of [['switching users', { id: 'u2' }], ['expiring the session', null]]) {
  test(`${label} clears personal folder and sender preferences from memory and storage`, () => {
    loadPersonalFolders();
    useStore.getState().setUser(nextUser);
    const state = useStore.getState();
    assert.deepEqual(state.favoriteFolders, []);
    assert.deepEqual(state.recentFolders, []);
    assert.equal(state.defaultSender, '');
    assert.deepEqual(state.collapsedFolders, []);
    assert.deepEqual(state.expandedAccounts, {});
    for (const key of personalFolderKeys) assert.equal(localStorage.getItem(key), null, key);
  });
}

test('the next user adding a favorite never persists the previous personal shortcuts', () => {
  loadPersonalFolders();
  useStore.getState().setUser(null);
  useStore.getState().setUser({ id: 'u2' });
  try {
    useStore.getState().addFavoriteFolder({ accountId: 'acct-a', path: 'INBOX' });
    assert.deepEqual(JSON.parse(localStorage.getItem('mailexpert_favorite_folders')), [
      { accountId: 'acct-a', path: 'INBOX' },
    ]);
  } finally {
    useStore.getState().setUser(null);
  }
});

test('rechecking the same user preserves personal folder and sender preferences', () => {
  loadPersonalFolders();
  useStore.getState().setUser({ id: 'u1', displayName: 'Renamed' });
  for (const [key, value] of Object.entries(personalFolders)) assert.deepEqual(useStore.getState()[key], value, key);
  for (const key of personalFolderKeys) assert.equal(localStorage.getItem(key), 'previous-user', key);
});

test('the first sign-in preserves this page load\'s cached personal preferences', () => {
  useStore.getState().setUser(null);
  loadPersonalFolders();
  useStore.getState().setUser({ id: 'u1' });
  for (const [key, value] of Object.entries(personalFolders)) assert.deepEqual(useStore.getState()[key], value, key);
  for (const key of personalFolderKeys) assert.equal(localStorage.getItem(key), 'previous-user', key);
});
