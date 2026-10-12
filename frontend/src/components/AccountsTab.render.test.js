// Render tests for the accounts tab of the settings (AdminPanel.jsx's AccountsTab, exported for
// exactly this): the sidebar's "Account settings" item must land on that account's own settings
// view, not on the general accounts list; and the search field over that list.
//
// The harness mirrors ThemesTab.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed.

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
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
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
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { AccountsTab } = await import('./AdminPanel.jsx');

const account = (id, name, email) => ({
  id, name, email_address: email, color: '#7c3aed', protocol: 'imap', enabled: true, health: 'healthy',
  imap_host: 'imap.example.invalid', imap_port: 993, smtp_host: 'smtp.example.invalid', smtp_port: 587,
  smtp_tls: 'STARTTLS', aliases: [],
});
const ACCOUNTS = [
  account('a1', 'Sales Team', 'sales@example.invalid'),
  account('a2', 'Operations', 'ops@example.invalid'),
  account('a3', 'Support', 'support@example.invalid'),
];

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('AccountsTab opened for one account (sidebar "Account settings")', () => {
  let host, root;
  before(() => {
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
  });
  after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  beforeEach(async () => {
    await React.act(async () => root.render(null));
    useStore.setState({
      accounts: ACCOUNTS, accountsReady: true, user: { id: 'u1', isAdmin: true },
      showAdmin: false, adminTab: 'appearance', accountSettingsRequested: null, showAddAccountDialog: false,
    });
  });

  const showsEditFor = (email) => host.textContent.includes('admin.accounts.editTitle') && host.textContent.includes(email);
  const showsList = () => host.textContent.includes('admin.accounts.addButton');

  test('without a request the tab shows the general accounts list', async () => {
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();
    assert.ok(showsList());
    assert.ok(!host.textContent.includes('admin.accounts.editTitle'));
  });

  test('openAccountSettings opens the settings, on the accounts tab, with that account as the target', () => {
    useStore.getState().openAccountSettings('a2');
    const state = useStore.getState();
    assert.equal(state.showAdmin, true);
    assert.equal(state.adminTab, 'accounts');
    assert.equal(state.accountSettingsRequested, 'a2');
  });

  test('a request made before the tab mounted opens that account, not the list', async () => {
    useStore.getState().openAccountSettings('a2');
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();

    assert.ok(showsEditFor('ops@example.invalid'), 'the edit view of the requested account is shown');
    assert.ok(!showsList(), 'the general list is not');
    assert.ok(!host.textContent.includes('sales@example.invalid'), 'no other account is shown');
    assert.equal(useStore.getState().accountSettingsRequested, null, 'the request is consumed');
  });

  test('a request made while the tab is open switches it to that account', async () => {
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();
    assert.ok(showsList());

    await React.act(async () => { useStore.getState().openAccountSettings('a3'); });
    await settle();
    assert.ok(showsEditFor('support@example.invalid'));
    assert.ok(!showsList());
  });

  test('a request made while another account is being edited shows the new account, title and fields alike', async () => {
    useStore.getState().openAccountSettings('a1');
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();
    const nameField = () => host.querySelector('input[placeholder="admin.accounts.displayNamePh"]');
    assert.ok(showsEditFor('sales@example.invalid'));
    assert.equal(nameField().value, 'Sales Team');

    await React.act(async () => { useStore.getState().openAccountSettings('a2'); });
    await settle();
    assert.ok(showsEditFor('ops@example.invalid'), 'the title names the second account');
    assert.ok(!host.textContent.includes('sales@example.invalid'));
    // The form is the second account's own: not the first one's fields saved into it.
    assert.equal(nameField().value, 'Operations', 'the fields are the second account\'s, not the first one\'s');
  });

  test('closing the settings drops a request that has not been taken yet, but not the add-account dialog', async () => {
    useStore.getState().openAccountSettings('a2');
    useStore.getState().openAddAccount();
    useStore.getState().setShowAdmin(false);
    assert.equal(useStore.getState().accountSettingsRequested, null);
    assert.equal(useStore.getState().showAddAccountDialog, true);
    useStore.getState().closeAddAccount();
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();
    assert.ok(showsList(), 'nothing opens later');
  });

  test('a request for an account that is not in the list is dropped, the list stays', async () => {
    useStore.getState().openAccountSettings('gone');
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();

    assert.ok(showsList());
    assert.equal(useStore.getState().accountSettingsRequested, null, 'it does not linger to open a view later');
  });

  test('a request that arrives before the accounts are loaded waits for them', async () => {
    useStore.setState({ accounts: [], accountsReady: false });
    useStore.getState().openAccountSettings('a1');
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();
    assert.equal(useStore.getState().accountSettingsRequested, 'a1', 'still pending');

    await React.act(async () => { useStore.getState().setAccounts(ACCOUNTS); });
    await settle();
    assert.ok(showsEditFor('sales@example.invalid'));
    assert.equal(useStore.getState().accountSettingsRequested, null);
  });
});

describe('AccountsTab search', () => {
  let host, root;
  before(() => {
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
  });
  after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  beforeEach(async () => {
    await React.act(async () => root.render(null));
    useStore.setState({
      accounts: [
        { ...ACCOUNTS[0], sender_name: 'Acme Sales Desk', aliases: [{ id: 'al1', name: 'Quotes', email: 'quotes@alias.invalid', reply_to: null }] },
        ACCOUNTS[1],
        { ...ACCOUNTS[2], oauth_provider: 'google' },
      ],
      accountsReady: true, user: { id: 'u1', isAdmin: true }, accountSettingsRequested: null,
    });
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();
  });

  const searchBox = () => host.querySelector('input[type="search"]');
  const type = async (value) => {
    const input = searchBox();
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const shown = () => ['sales@', 'ops@', 'support@'].filter(prefix => host.textContent.includes(`${prefix}example.invalid`));

  test('offers a labelled search field, with every account listed to begin with', () => {
    assert.ok(searchBox(), 'the search field is there');
    assert.equal(searchBox().getAttribute('aria-label'), 'admin.accounts.search.label');
    assert.deepEqual(shown(), ['sales@', 'ops@', 'support@']);
  });

  test('narrows the list by address, case-insensitively', async () => {
    await type('OPS@Example');
    assert.deepEqual(shown(), ['ops@']);
  });

  test('finds an account by its sender name, its alias and its provider', async () => {
    await type('sales desk');
    assert.deepEqual(shown(), ['sales@']);
    await type('quotes@alias');
    assert.deepEqual(shown(), ['sales@']);
    await type('gmail');
    assert.deepEqual(shown(), ['support@']);
  });

  test('says so when nothing matches, and the list comes back when the box is emptied', async () => {
    await type('zzz-nothing');
    assert.deepEqual(shown(), []);
    assert.ok(host.textContent.includes('admin.accounts.search.noMatch'), 'the empty state is shown');
    assert.ok(host.querySelector('[role="status"]') != null, 'and announced');
    await type('');
    assert.deepEqual(shown(), ['sales@', 'ops@', 'support@']);
  });

  test('Escape in the field clears it', async () => {
    await type('ops');
    assert.deepEqual(shown(), ['ops@']);
    await React.act(async () => {
      searchBox().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(searchBox().value, '');
    assert.deepEqual(shown(), ['sales@', 'ops@', 'support@']);
  });

  test('settings_opens_same_dialog_and_keeps_filter: the add button opens the store dialog, the list and the filter stay', async () => {
    await type('ops');
    assert.deepEqual(shown(), ['ops@']);
    const before = useStore.getState();
    const addButton = [...host.querySelectorAll('button')].find(b => b.textContent.includes('admin.accounts.addButton'));
    await React.act(async () => { addButton.click(); });
    const after = useStore.getState();
    assert.equal(after.showAddAccountDialog, true);
    assert.equal(after.showAdmin, before.showAdmin);
    assert.equal(after.adminTab, before.adminTab);
    assert.equal(searchBox().value, 'ops', 'the filter is not reset');
    assert.deepEqual(shown(), ['ops@'], 'the list under the dialog is the same');
    assert.ok(!host.textContent.includes('admin.accounts.addTitle'), 'no add sub-view inside the settings any more');
    assert.equal(after.accounts, before.accounts, 'the shared list is untouched');
  });

  test('search_is_visible_with_empty_single_and_many_accounts', async () => {
    for (const accounts of [[], [ACCOUNTS[0]], ACCOUNTS]) {
      await React.act(async () => { useStore.setState({ accounts }); });
      await settle();
      assert.ok(searchBox(), `the search field is there with ${accounts.length} accounts`);
    }
  });

  test('with one account the search still narrows it and says when nothing matches', async () => {
    await React.act(async () => { useStore.setState({ accounts: [ACCOUNTS[0]] }); });
    await settle();
    await type('zzz-nothing');
    assert.ok(host.textContent.includes('admin.accounts.search.noMatch'));
    await type('sales');
    assert.deepEqual(shown(), ['sales@']);
  });

  test('opening_dialog_retains_query_and_selection: the dialog changes neither the unread counts nor the list order', async () => {
    const unread = { a1: 3, a2: 0 };
    await React.act(async () => { useStore.setState({ unreadCounts: unread, selectedAccountId: 'a2' }); });
    await type('ops');
    const accounts = useStore.getState().accounts;
    const addButton = [...host.querySelectorAll('button')].find(b => b.textContent.includes('admin.accounts.addButton'));
    await React.act(async () => { addButton.click(); });
    assert.equal(useStore.getState().unreadCounts, unread);
    assert.equal(useStore.getState().accounts, accounts);
    assert.equal(useStore.getState().selectedAccountId, 'a2');
    assert.equal(searchBox().value, 'ops');
  });
});

describe('AccountsTab provider details', () => {
  let host, root;
  before(() => {
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
    // An ordinary user also gets the quarantine card, which reads an empty list.
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [], total: 0, historyRead: true, spamInHistory: 0 }), text: async () => '' });
  });
  after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  const mount = async (accounts, user = { id: 'u1', isAdmin: false }) => {
    await React.act(async () => root.render(null));
    useStore.setState({ accounts, accountsReady: true, user, accountSettingsRequested: null, showAddAccountDialog: false, addAccountSeed: null });
    await React.act(async () => { root.render(React.createElement(AccountsTab)); });
    await settle();
  };
  const PROTON = { ...account('p1', 'Proton box', 'team@proton.example'), mail_provider: 'proton', connection_mode: 'managed',
    can_reconnect_proton: true, proton_status: 'proton_reconnect_required', health: 'proton_reconnect_required', imap_host: '127.0.0.1', imap_port: 1993 };
  const MANUAL = { ...account('m1', 'Manual box', 'manual@example.invalid'), mail_provider: 'other', connection_mode: 'manual' };

  test('manual_override_card_shows_mode: the card names the provider and the connection mode', async () => {
    await mount([MANUAL, PROTON]);
    assert.ok(host.textContent.includes('admin.accounts.provider.other'));
    assert.ok(host.textContent.includes('admin.accounts.mode.manual'));
    assert.ok(host.textContent.includes('admin.accounts.provider.proton'));
    assert.ok(host.textContent.includes('admin.accounts.mode.managed'));
  });

  test('a Proton mailbox that lost its session offers the Proton sign-in to an ordinary employee', async () => {
    await mount([PROTON], { id: 'u2', isAdmin: false });
    assert.ok(host.textContent.includes('sidebar.health.protonReconnectRequired'));
    const button = host.querySelector('button[title="admin.accounts.protonReconnect"]');
    assert.ok(button, 'the reconnect button is on the card');
    await React.act(async () => { button.click(); });
    const state = useStore.getState();
    assert.equal(state.showAddAccountDialog, true);
    assert.deepEqual(state.addAccountSeed, { id: 'p1', email_address: 'team@proton.example' });
  });

  test('a managed mailbox offers no plain IMAP reconnect and an ordinary mailbox no Proton one', async () => {
    await mount([{ ...PROTON, sync_error: 'boom' }, { ...MANUAL, sync_error: 'boom' }]);
    const reconnects = [...host.querySelectorAll('button[title="sidebar.accountMenu.reconnect"]')];
    assert.equal(reconnects.length, 1, 'only the manual mailbox keeps the IMAP reconnect');
    assert.equal(host.querySelectorAll('button[title="admin.accounts.protonReconnect"]').length, 1);
  });

  test('oauth_reconnect_reset_device_actions_remain: a Google mailbox keeps its reconnect and sign-in reset', async () => {
    const google = { ...account('g1', 'Gmail box', 'g@example.invalid'), oauth_provider: 'google', oauth_reconnect_required: true, health: 'oauth_reconnect_required' };
    await mount([google], { id: 'u1', isAdmin: true });
    assert.ok(host.textContent.includes('admin.accounts.reconnectGmail'));
    assert.ok(host.textContent.includes('admin.accounts.oauthSubjectReset'));
  });

  test('the edit form of a managed mailbox shows a note instead of the server fields, for an administrator too', async () => {
    await mount([PROTON], { id: 'u1', isAdmin: true });
    await React.act(async () => { useStore.getState().openAccountSettings('p1'); });
    await settle();
    assert.ok(host.textContent.includes('admin.accounts.managedServerNote'));
    assert.equal(host.querySelector('input[placeholder="admin.accounts.imapHostPh"]'), null);
  });
});
