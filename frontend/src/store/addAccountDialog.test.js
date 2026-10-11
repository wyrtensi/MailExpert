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

beforeEach(() => {
  useStore.setState({
    showAddAccountDialog: false, showAdmin: false, adminTab: 'appearance', accountSettingsRequested: null,
    selectedAccountId: 'a1', selectedFolder: 'Sent', selectedMessageId: 'm1', searchQuery: 'invoice',
  });
});

test('the dialog is closed at start and the old hand-off flag is gone', () => {
  const state = useStore.getState();
  assert.equal(state.showAddAccountDialog, false);
  assert.equal('addAccountRequested' in state, false);
  assert.equal('clearAddAccountRequest' in state, false);
});

test('openAddAccount opens only the dialog: settings, mailbox, folder, letter and search stay', () => {
  const before = useStore.getState();
  before.openAddAccount();
  const after = useStore.getState();
  assert.equal(after.showAddAccountDialog, true);
  for (const key of ['showAdmin', 'adminTab', 'selectedAccountId', 'selectedFolder', 'selectedMessageId', 'searchQuery']) {
    assert.equal(after[key], before[key], key);
  }
});

test('closeAddAccount closes the dialog and leaves the settings where they were', () => {
  useStore.setState({ showAdmin: true, adminTab: 'accounts' });
  useStore.getState().openAddAccount();
  assert.equal(useStore.getState().showAdmin, true);
  useStore.getState().closeAddAccount();
  const state = useStore.getState();
  assert.equal(state.showAddAccountDialog, false);
  assert.equal(state.showAdmin, true);
  assert.equal(state.adminTab, 'accounts');
});

test('closing the settings does not close the dialog opened over them, and still drops a pending account request', () => {
  useStore.setState({ showAdmin: true, accountSettingsRequested: 'a2' });
  useStore.getState().openAddAccount();
  useStore.getState().setShowAdmin(false);
  assert.equal(useStore.getState().showAddAccountDialog, true);
  assert.equal(useStore.getState().accountSettingsRequested, null);
});

test('openProtonReconnect opens the dialog with the mailbox as the Proton seed, and closing drops the seed', () => {
  useStore.getState().openProtonReconnect({ id: 'a9', email_address: 'team@proton.test', password: 'never-kept', extra: 1 });
  const state = useStore.getState();
  assert.equal(state.showAddAccountDialog, true);
  assert.deepEqual(state.addAccountSeed, { id: 'a9', email_address: 'team@proton.test' });
  useStore.getState().closeAddAccount();
  assert.equal(useStore.getState().addAccountSeed, null);
  useStore.getState().openAddAccount();
  assert.equal(useStore.getState().addAccountSeed, null, 'a plain open carries no seed');
});
