// The per-user "display aliases as accounts" preference in the store: saved with the other
// preferences, mirrored in localStorage for the first paint, and owned by the server.

import { afterEach, before, beforeEach, describe, it } from 'node:test';
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


describe('aliasesAsAccounts preference', () => {
  let useStore;
  let api;
  let saved;

  before(async () => {
    ({ useStore } = await import('./index.js'));
    ({ api } = await import('../utils/api.js'));
    api.savePreferencesOnExit = (prefs) => { saved.push(prefs); return Promise.resolve(); };
    api.savePreferences = (prefs) => { saved.push(prefs); return Promise.resolve(); };
  });

  const flush = () => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); };

  beforeEach(() => {
    saved = [];
    localStorage.clear();
    useStore.setState({ aliasesAsAccounts: false });
  });
  afterEach(() => { flush(); saved = []; });

  it('setAliasesAsAccounts saves through the preference queue and mirrors localStorage', () => {
    useStore.getState().setAliasesAsAccounts(true);
    assert.equal(useStore.getState().aliasesAsAccounts, true);
    assert.equal(localStorage.getItem('mailexpert_aliases_as_accounts'), 'true');
    flush();
    assert.deepEqual(saved, [{ aliasesAsAccounts: true }]);
  });

  it('loadPreferences turns the mode off when the server has no key, even if this browser cached true', async () => {
    useStore.getState().setUser({ id: 'u1' });
    useStore.setState({ aliasesAsAccounts: true });
    localStorage.setItem('mailexpert_aliases_as_accounts', 'true');
    api.getPreferences = async () => ({ theme: 'daylight' });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().aliasesAsAccounts, false);
    assert.equal(localStorage.getItem('mailexpert_aliases_as_accounts'), 'false');
  });

  it('loadPreferences applies true from the server', async () => {
    useStore.getState().setUser({ id: 'u1' });
    api.getPreferences = async () => ({ aliasesAsAccounts: true });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().aliasesAsAccounts, true);
    assert.equal(localStorage.getItem('mailexpert_aliases_as_accounts'), 'true');
  });

  it('another user signing in on the tab starts with the mode off', () => {
    useStore.getState().setUser({ id: 'u1' });
    useStore.setState({ aliasesAsAccounts: true });
    localStorage.setItem('mailexpert_aliases_as_accounts', 'true');
    useStore.getState().setUser({ id: 'u2' });
    assert.equal(useStore.getState().aliasesAsAccounts, false);
    assert.equal(localStorage.getItem('mailexpert_aliases_as_accounts'), null);
  });
});
