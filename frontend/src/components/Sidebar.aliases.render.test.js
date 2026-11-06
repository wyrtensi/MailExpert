// Render tests for "Display aliases as accounts" in the sidebar: the switch under All inboxes, the
// alias rows after the mailboxes (name above address, unread count, the mailbox filter), the
// alias's Inbox and Sent, the owner mailbox not being highlighted meanwhile, and the phone drawer.
//
// The harness is the one of Sidebar.accounts.render.test.js: node --test cannot parse JSX, so the
// loader hook transforms .jsx with sucrase, and react-i18next is stubbed (t returns the key).

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'const interp = (k, o) => (o && typeof o === "object" ? k + " " + Object.values(o).join(" ") : k);',
        'export const useTranslation = () => ({ t: (k, o) => interp(k, o), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  Image: dom.window.Image,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ([]), text: async () => '' });


const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { default: Sidebar } = await import('./Sidebar.jsx');

const alias = (id, email, name) => ({ id, email, name, enabled: true });
const account = (id, name, aliases, extra = {}) => ({
  id, name, email_address: `${id}@example.invalid`, color: '#7c3aed', protocol: 'imap', enabled: true,
  health: 'healthy', last_received_at: null, aliases, ...extra,
});
// Rows: Beta and Zeta of Alpha, Gamma of Bravo. Alpha's own address (any case), the mail node's
// alias and the disabled mailbox's alias get none.
const ACCOUNTS = [
  account('a', 'Alpha', [
    alias('a1', 'zeta@example.invalid', 'Zeta'),
    alias('a2', 'beta@example.invalid', 'Beta'),
    alias('a3', 'A@EXAMPLE.INVALID', 'Own address'),
  ]),
  account('b', 'Bravo', [alias('b1', 'gamma@example.invalid', 'Gamma')]),
  account('n', 'Node', [alias('n1', 'nodealias@example.invalid', 'Node alias')], { mail_node: true }),
  account('d', 'Disabled', [alias('d1', 'off@example.invalid', 'Off alias')], { enabled: false }),
];
const PLAIN = [account('p', 'Plain', []), account('q', 'Quiet', [alias('q1', 'q@example.invalid', 'Same')])];
const FOLDERS_A = [
  { path: 'INBOX', name: 'INBOX', unread_count: 0 },
  { path: 'Sent', name: 'Sent', special_use: '\\Sent', unread_count: 0 },
];

describe('Sidebar alias mailboxes', () => {
  let host, root;
  before(() => {
    api.savePreferences = () => Promise.resolve();
    api.savePreferencesOnExit = () => Promise.resolve();
    api.getFolders = () => Promise.resolve([]);
    api.getAliasUnreadCounts = () => Promise.resolve({ byAlias: {} });
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
  });
  after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });

  const render = async (state = {}) => {
    await React.act(async () => root.render(null));
    localStorage.clear();
    useStore.setState({
      accounts: ACCOUNTS, accountsReady: true, user: { id: 'u1', isAdmin: true },
      pinnedAccounts: [], sortAccountsByLatest: false, accountFilter: '',
      sidebarCollapsed: false, selectedAccountId: null, selectedFolder: 'INBOX', selectedAliasId: null,
      aliasesAsAccounts: false, aliasUnreadCounts: {}, folders: {}, favoriteFolders: [],
      showAdmin: false, showContacts: false, expandedAccounts: {}, mobileSidebarOpen: false,
      ...state,
    });
    await React.act(async () => { root.render(React.createElement(Sidebar)); });
  };
  beforeEach(() => render());

  const toggle = () => host.querySelector('[role="switch"][aria-label="sidebar.aliases.toggle"]');
  const allInboxes = () => [...host.querySelectorAll('[role="button"]')].find(el => el.textContent.includes('sidebar.allInboxes'));
  const navRows = () => [...host.querySelectorAll('[data-nav-row]')];
  const aliasRows = () => navRows().filter(el => el.dataset.navRow.startsWith('alias:'));
  const aliasKeys = () => aliasRows().map(el => el.dataset.navRow.slice('alias:'.length));
  const aliasRow = (key) => host.querySelector(`[data-nav-row="alias:${key}"]`);
  const aliasInbox = (key) => host.querySelector(`[data-nav-row="alias-folder:${key}:inbox"]`);
  const aliasSent = (key) => host.querySelector(`[data-nav-row="alias-folder:${key}:sent"]`);
  const click = (el) => React.act(async () => { el.click(); });

  test('the switch sits right under All inboxes and is hidden when no mailbox has an alias', async () => {
    assert.ok(toggle(), 'shown: some mailbox has an alias row');
    assert.ok(allInboxes().nextElementSibling.contains(toggle()), 'the row right after All inboxes');
    assert.equal(toggle().getAttribute('aria-checked'), 'false');
    assert.ok(allInboxes().nextElementSibling.textContent.includes('sidebar.aliases.toggle'), 'with its label');

    await click(toggle());
    assert.equal(useStore.getState().aliasesAsAccounts, true, 'the switch turns the mode on');
    assert.equal(toggle().getAttribute('aria-checked'), 'true');

    await render({ accounts: PLAIN });
    assert.equal(toggle(), null, 'no alias row anywhere: no switch');
    await render({ accounts: PLAIN, aliasesAsAccounts: true });
    assert.ok(toggle(), 'kept while the mode is on, so it can be turned off');
    await render({ sidebarCollapsed: true });
    assert.equal(toggle(), null, 'not in the collapsed sidebar');
  });

  test('with the mode on, alias rows follow the mailboxes, alphabetical across mailboxes, name above address', async () => {
    assert.deepEqual(aliasKeys(), [], 'no alias rows while the mode is off');
    await render({ aliasesAsAccounts: true });
    assert.deepEqual(aliasKeys(), ['a:a2', 'b:b1', 'a:a1']);
    const rows = navRows();
    const lastAccount = Math.max(...rows.map((el, i) => (el.dataset.navRow.startsWith('account:') ? i : -1)));
    assert.ok(lastAccount >= 0 && rows.indexOf(aliasRows()[0]) > lastAccount, 'after the last mailbox');
    const zeta = aliasRow('a:a1');
    assert.ok(zeta.textContent.includes('Zeta') && zeta.textContent.includes('zeta@example.invalid'));
    assert.ok(zeta.textContent.indexOf('Zeta') < zeta.textContent.indexOf('zeta@example.invalid'), 'name above address');
    assert.ok(!zeta.textContent.includes('Alpha'), 'without the owner mailbox\'s name');

    await React.act(async () => { useStore.setState({ sidebarCollapsed: true }); });
    const tile = aliasRow('a:a1');
    assert.equal(tile.textContent, 'Z', 'collapsed: a tile with the first letter');
    assert.equal(tile.getAttribute('title'), 'Zeta — zeta@example.invalid');
  });

  test('the mailbox\'s own address, a mail node and a disabled mailbox give no alias rows', async () => {
    await render({ aliasesAsAccounts: true });
    const text = aliasRows().map(el => el.textContent).join('\n');
    for (const absent of ['Own address', 'Node alias', 'Off alias']) assert.ok(!text.includes(absent), absent);
    assert.equal(aliasRows().length, 3);
  });

  test('clicking an alias opens its Inbox; Inbox and Sent show under it; the owner row and the owner\'s Inbox are not aria-current', async () => {
    await render({ aliasesAsAccounts: true, folders: { a: FOLDERS_A } });
    assert.equal(aliasInbox('a:a1'), null, 'nothing under an alias that is not open');
    await click(aliasRow('a:a1'));
    const state = useStore.getState();
    assert.deepEqual([state.selectedAccountId, state.selectedFolder, state.selectedAliasId], ['a', 'INBOX', 'a1']);
    assert.ok(aliasInbox('a:a1'), 'Inbox under the open alias');
    assert.ok(aliasInbox('a:a1').textContent.includes('sidebar.aliases.inbox'));
    assert.ok(aliasSent('a:a1').textContent.includes('sidebar.aliases.sent'));
    assert.equal(aliasInbox('a:a1').getAttribute('aria-current'), 'true');
    assert.equal(aliasSent('a:a1').getAttribute('aria-current'), null);
    assert.equal(aliasInbox('a:a2'), null, 'the other alias of the mailbox stays shut');
    assert.equal(host.querySelector('[data-nav-row="account:a"]').getAttribute('aria-current'), null, 'owner row');

    await React.act(async () => { useStore.setState({ expandedAccounts: { a: true } }); });
    const ownerInbox = host.querySelector('[data-nav-row="folder:a:INBOX"]');
    assert.ok(ownerInbox, 'the owner\'s folders are shown');
    assert.equal(ownerInbox.getAttribute('aria-current'), null, 'owner Inbox');

    await click(host.querySelector('[data-nav-row="account:a"]'));
    assert.equal(useStore.getState().selectedAliasId, null, 'the owner row opens the owner, not the alias');
  });

  test('Sent opens the owner\'s Sent folder for the alias, loading the owner\'s folders first', async () => {
    const asked = [];
    let deliver;
    api.getFolders = (id) => { asked.push(id); return new Promise(resolve => { deliver = resolve; }); };
    try {
      await render({ aliasesAsAccounts: true });
      await click(aliasRow('b:b1'));
      assert.deepEqual(asked, ['b'], 'the owner\'s folders are loaded');
      assert.equal(aliasSent('b:b1'), null, 'no Sent until the owner\'s Sent folder is known');
      await React.act(async () => { deliver([{ path: 'INBOX', name: 'INBOX' }, { path: '[Gmail]/Sent Mail', name: 'Sent Mail', special_use: '\\Sent' }]); });
      assert.ok(aliasSent('b:b1'));
      await click(aliasSent('b:b1'));
      const state = useStore.getState();
      assert.deepEqual([state.selectedAccountId, state.selectedFolder, state.selectedAliasId], ['b', '[Gmail]/Sent Mail', 'b1']);
      assert.equal(aliasSent('b:b1').getAttribute('aria-current'), 'true');
      assert.equal(aliasInbox('b:b1').getAttribute('aria-current'), null);
      await click(aliasRow('b:b1'));
      assert.equal(asked.length, 1, 'loaded folders are not asked for again');
      assert.equal(useStore.getState().selectedFolder, 'INBOX', 'the row opens the alias\'s Inbox again');
    } finally {
      api.getFolders = () => Promise.resolve([]);
    }
  });

  test('an alias row shows its unread count', async () => {
    await render({ aliasesAsAccounts: true, aliasUnreadCounts: { a1: 7, b1: 0 }, folders: { a: FOLDERS_A } });
    assert.equal(aliasRow('a:a1').textContent, 'Zetazeta@example.invalid7');
    assert.equal(aliasRow('b:b1').textContent, 'Gammagamma@example.invalid', 'no badge for zero');
    await click(aliasRow('a:a1'));
    assert.ok(aliasInbox('a:a1').textContent.includes('7'), 'and its Inbox too');
    await React.act(async () => { useStore.setState({ aliasUnreadCounts: { a1: 3 } }); });
    assert.ok(aliasRow('a:a1').textContent.endsWith('3'), 'follows the store');
  });

  test('the mailbox filter narrows alias rows by alias name and address', async () => {
    await render({ aliasesAsAccounts: true, accountFilter: 'gam' });
    assert.deepEqual(aliasKeys(), ['b:b1'], 'by name');
    assert.equal(host.querySelector('[role="status"]'), null, 'a matching alias is a match: no "No mailboxes match"');
    await React.act(async () => { useStore.setState({ accountFilter: 'BETA@' }); });
    assert.deepEqual(aliasKeys(), ['a:a2'], 'by address, any case');
    await React.act(async () => { useStore.setState({ accountFilter: 'nothing-like-it' }); });
    assert.deepEqual(aliasKeys(), []);
    assert.ok(host.querySelector('[role="status"]').textContent.includes('sidebar.accountFilter.noMatch'));
  });

  test('on a phone, choosing another alias of the same mailbox closes the drawer', async () => {
    const width = dom.window.innerWidth;
    const media = dom.window.matchMedia;
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 600 });
    dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    try {
      await render({ aliasesAsAccounts: true });
      await click(aliasRow('a:a1'));
      assert.equal(useStore.getState().mobileSidebarOpen, false);
      await React.act(async () => { useStore.setState({ mobileSidebarOpen: true }); });
      await click(aliasRow('a:a2'));
      assert.equal(useStore.getState().selectedAliasId, 'a2');
      assert.equal(useStore.getState().mobileSidebarOpen, false, 'same mailbox, same folder, another alias: closed');
    } finally {
      Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: width });
      dom.window.matchMedia = media;
    }
  });

  test('switching the mode off removes the alias rows at once', async () => {
    await render({ aliasesAsAccounts: true });
    await click(aliasRow('a:a1'));
    assert.equal(aliasRows().length, 3);
    await click(toggle());
    assert.equal(useStore.getState().aliasesAsAccounts, false);
    assert.deepEqual(aliasKeys(), []);
    assert.equal(aliasInbox('a:a1'), null);
    assert.equal(useStore.getState().selectedAliasId, null, 'the open alias falls back to its mailbox');
  });
});
