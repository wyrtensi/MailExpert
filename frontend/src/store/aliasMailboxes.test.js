// The selected alias mailbox and the per-alias unread counts in the store, with the fallback to
// the owner's Inbox when the alias goes away or the mode is turned off.

import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  Image: dom.window.Image, CustomEvent: dom.window.CustomEvent,
});

const owner = (aliases = [{ id: 'al1', email: 'sales@example.com', name: 'Sales' }]) => ({
  id: 'acc1', email_address: 'me@example.com', enabled: true, aliases,
});

describe('selected alias and alias unread counts', () => {
  let useStore;
  let api;
  let calls;
  let answers;

  before(async () => {
    ({ useStore } = await import('./index.js'));
    ({ api } = await import('../utils/api.js'));
    api.savePreferencesOnExit = () => Promise.resolve();
    api.savePreferences = () => Promise.resolve();
  });

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    localStorage.clear();
    calls = 0;
    answers = [() => Promise.resolve({ byAlias: { al1: 3 } })];
    api.getAliasUnreadCounts = () => { calls += 1; return answers.shift()(); };
    useStore.setState({
      aliasesAsAccounts: true, accounts: [owner()], accountsReady: true,
      selectedAccountId: 'acc1', selectedFolder: 'INBOX', selectedAliasId: null, aliasUnreadCounts: {},
      isLocked: false,
    });
  });
  afterEach(() => {
    // Signing another user in cancels the store's pending 400 ms timer while the mock clock is still
    // installed (clearing a timer from an older mock clock would cancel a new one).
    useStore.getState().setUser({ id: 'leaving' });
    useStore.getState().setUser(null);
    mock.timers.reset();
  });

  const settle = async () => { mock.timers.tick(400); await Promise.resolve().then(() => {}).then(() => {}); };

  it('setSelectedAccount with an alias stores it; a two-argument call clears it', () => {
    useStore.getState().setSelectedAccount('acc1', 'INBOX', 'al1');
    assert.equal(useStore.getState().selectedAliasId, 'al1');
    assert.equal(localStorage.getItem('mailexpert_selected_alias'), 'al1');
    useStore.getState().setSelectedAccount('acc1', 'INBOX');
    assert.equal(useStore.getState().selectedAliasId, null);
    assert.equal(localStorage.getItem('mailexpert_selected_alias'), '');
  });

  it('switching between two aliases of one mailbox and folder counts as a navigation', () => {
    useStore.getState().setSelectedAccount('acc1', 'INBOX', 'al1');
    useStore.setState({ searchQuery: 'x', searchAllFolders: false });
    useStore.getState().setSelectedAccount('acc1', 'INBOX', 'al2');
    assert.equal(useStore.getState().searchQuery, '');
  });

  it("an alias removed by a mailbox list refresh falls back to the owner's Inbox", () => {
    useStore.getState().setSelectedAccount('acc1', 'Sent', 'al1');
    useStore.getState().setAccounts([owner([])]);
    const s = useStore.getState();
    assert.equal(s.selectedAliasId, null);
    assert.equal(s.selectedFolder, 'INBOX');
    assert.equal(s.selectedAccountId, 'acc1');
    assert.equal(localStorage.getItem('mailexpert_selected_alias'), '');
    assert.equal(localStorage.getItem('mailexpert_selected_folder'), 'INBOX');
  });

  it("turning the mode off with an alias selected opens the owner's Inbox", () => {
    useStore.getState().setSelectedAccount('acc1', 'Sent', 'al1');
    useStore.getState().setAliasesAsAccounts(false);
    const s = useStore.getState();
    assert.equal(s.selectedAliasId, null);
    assert.equal(s.selectedFolder, 'INBOX');
    assert.equal(s.selectedAccountId, 'acc1');
  });

  it('server preferences with the mode off drop a cached alias selection', async () => {
    useStore.getState().setUser({ id: 'u1' });
    useStore.getState().setSelectedAccount('acc1', 'INBOX', 'al1');
    api.getPreferences = async () => ({ theme: 'daylight' });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().aliasesAsAccounts, false);
    assert.equal(useStore.getState().selectedAliasId, null);
    assert.equal(useStore.getState().selectedFolder, 'INBOX');
  });

  it('a cached alias survives preferences arriving before the mailbox list', async () => {
    useStore.getState().setUser({ id: 'u1' });
    useStore.setState({ accounts: [], accountsReady: false, aliasesAsAccounts: false });
    useStore.getState().setSelectedAccount('acc1', 'INBOX', 'al1');
    api.getPreferences = async () => ({ aliasesAsAccounts: true });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().selectedAliasId, 'al1');
    useStore.getState().setAccounts([owner()]);
    assert.equal(useStore.getState().selectedAliasId, 'al1');
  });

  it('server counts arriving refresh alias counts when the mode is on, never when it is off', async () => {
    useStore.getState().setUnreadCounts({ total: 1, byAccount: { acc1: 1 } });
    useStore.getState().setUnreadCounts({ total: 2, byAccount: { acc1: 2 } });
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual(useStore.getState().aliasUnreadCounts, { al1: 3 });
    useStore.setState({ aliasesAsAccounts: false });
    useStore.getState().setUnreadCounts({ total: 3, byAccount: { acc1: 3 } });
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual(useStore.getState().aliasUnreadCounts, {});
  });

  it('a local read change on the owner refreshes alias counts', async () => {
    useStore.getState().adjustUnread('acc1', -1);
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual(useStore.getState().aliasUnreadCounts, { al1: 3 });
  });

  it('an older alias count answer does not overwrite a newer one', async () => {
    let releaseOld;
    answers = [
      () => new Promise((resolve) => { releaseOld = () => resolve({ byAlias: { al1: 9 } }); }),
      () => Promise.resolve({ byAlias: { al1: 1 } }),
    ];
    const first = useStore.getState().refreshAliasUnreadCounts();
    await useStore.getState().refreshAliasUnreadCounts();
    releaseOld();
    await first;
    assert.deepEqual(useStore.getState().aliasUnreadCounts, { al1: 1 });
  });

  it('another user signing in clears the alias selection and counts', () => {
    useStore.getState().setUser({ id: 'u1' });
    useStore.getState().setSelectedAccount('acc1', 'INBOX', 'al1');
    useStore.setState({ aliasUnreadCounts: { al1: 2 } });
    useStore.getState().setUser({ id: 'u2' });
    assert.equal(useStore.getState().selectedAliasId, null);
    assert.deepEqual(useStore.getState().aliasUnreadCounts, {});
    assert.equal(localStorage.getItem('mailexpert_selected_alias'), null);
  });
});
