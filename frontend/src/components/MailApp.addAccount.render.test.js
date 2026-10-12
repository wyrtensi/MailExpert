// MailApp shell tests for the add-account dialog.

import { test, describe, before, after } from 'node:test';
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
const { api } = await import('../utils/api.js');
const { default: MailApp } = await import('./MailApp.jsx');

globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.history = dom.window.history;
// Background fetches of the shell settle outside act(); that warning is noise here.
const originalConsoleError = console.error;
console.error = (...args) => { if (!String(args[0]).includes('not wrapped in act')) originalConsoleError(...args); };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.WebSocket = class { constructor() { this.readyState = 0; } close() {} send() {} addEventListener() {} removeEventListener() {} };
dom.window.WebSocket = globalThis.WebSocket;
const noop = () => Promise.resolve([]);
for (const name of ['getAccounts', 'getFolders', 'getPreferences']) api[name] = noop;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ messages: [], total: 0, contacts: [], items: [], folders: [] }), text: async () => '' });
api.todoist = { status: () => Promise.resolve({ connected: false }) };

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 20)); });

describe('MailApp with the add-account dialog', () => {
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
  const baseState = {
    accounts: [{ id: 'a1', name: 'One', email_address: 'one@example.invalid', color: '#7c3aed', protocol: 'imap', enabled: true, health: 'healthy', aliases: [] }],
    accountsReady: true, user: { id: 'u1', isAdmin: false }, showAdmin: false, showAddAccountDialog: false, showContacts: false,
    composing: false, selectedMessageId: null, selectedAccountId: 'a1', selectedFolder: 'INBOX', searchQuery: '', mobileSidebarOpen: false,
  };
  const mount = async (width = 1200) => {
    dom.window.innerWidth = width;
    await React.act(async () => root.render(null));
    useStore.setState(baseState);
    await React.act(async () => { root.render(React.createElement(MailApp)); });
    await settle();
  };
  const press = (key, init = {}) => React.act(async () => {
    document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
  const openDialog = async () => { await React.act(async () => { useStore.getState().openAddAccount(); }); await settle(); };

  test('dialog_blocks_shell_shortcuts_and_native_back: nothing behind the dialog reacts to keys, and Back closes the dialog first', async () => {
    await mount();
    await press('c');
    assert.equal(useStore.getState().composing, true, 'control: the compose shortcut works without the dialog');
    await React.act(async () => { useStore.setState({ composing: false }); });

    await openDialog();
    assert.equal(document.querySelectorAll('.add-account-panel').length, 1, 'the dialog is mounted by MailApp');
    await press('c');
    assert.equal(useStore.getState().composing, false, 'the compose shortcut is ignored under the dialog');
    await press('k', { ctrlKey: true });
    assert.equal(document.querySelector('input[placeholder="commandPalette.placeholder"]'), null, 'the command palette does not open over the dialog');

    assert.equal(window.__mailexpertHandleAndroidBack(), true);
    assert.equal(useStore.getState().showAddAccountDialog, false, 'native Back closed the dialog');
    await settle();
    assert.equal(document.querySelector('.add-account-panel'), null);
    assert.equal(window.__mailexpertHandleAndroidBack(), false, 'the next Back is the app\'s');
  });

  test('escape under the dialog closes only the dialog: the selection mode of the list behind it stays', async () => {
    await mount(500);
    const selectButton = () => document.querySelector('[aria-label="messageList.selectMessages"]');
    await React.act(async () => { selectButton().click(); });
    assert.equal(selectButton(), null, 'control: selection mode is on');
    await openDialog();
    await React.act(async () => { document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    assert.equal(useStore.getState().showAddAccountDialog, false, 'the dialog closed');
    assert.equal(selectButton(), null, 'the list is still in selection mode');
  });

  test('the mobile list header stays on one row at 320 px: icon-only controls, the title keeps its minimum, every action reachable', async () => {
    await mount(320);
    const header = document.querySelector('[data-mobile-list-header]');
    assert.equal(header.style.flexWrap, 'nowrap');
    // Fixed widths the row asks for: padding, gaps and the minimum of every child.
    const px = (v) => parseInt(v, 10) || 0;
    const children = [...header.children];
    const needed = px(header.style.paddingLeft) + px(header.style.paddingRight)
      + px(header.style.columnGap || header.style.gap) * (children.length - 1)
      + children.reduce((sum, el) => sum + px(el.style.minWidth), 0);
    assert.ok(needed <= 320, `the row needs ${needed}px of 320`);
    const title = header.querySelector('[data-mobile-list-title]');
    assert.ok(px(title.style.minWidth) >= 64, 'the title keeps a readable minimum');
    for (const el of header.querySelectorAll('button')) {
      assert.ok(px(el.style.minWidth) >= 44 && px(el.style.minHeight) >= 44, 'touch targets stay 44 px');
      assert.ok(el.getAttribute('aria-label') || el.textContent.trim(), 'each control is named');
    }
    const add = header.querySelector('[data-add-account-trigger]');
    assert.equal(add.textContent.trim(), '', 'the add action is icon-only');
    assert.equal(add.getAttribute('aria-label'), 'sidebar.addAccount');
    assert.equal(add.getAttribute('title'), 'sidebar.addAccount');
    assert.ok(header.querySelector('[aria-label="messageList.unreadOnly"]'), 'the unread filter is there as an icon');
    assert.ok(header.querySelector('[aria-label="messageList.sync"]'));
    assert.ok(header.querySelector('[aria-label="messageList.selectMessages"]'));
    assert.equal(header.querySelector('[aria-label="contacts.title"]'), null, 'Contacts left the header...');
    const contactsInDrawer = [...document.querySelectorAll('[role="button"]')].some((el) => el.textContent.includes('contacts.title'));
    assert.ok(contactsInDrawer, '...and stays reachable from the sidebar drawer');
  });

  test('in selection mode the 320 px header still fits: Cancel is a named 44 px icon, not a word that grows with the language', async () => {
    await mount(320);
    await React.act(async () => { document.querySelector('[aria-label="messageList.selectMessages"]').click(); });
    const header = document.querySelector('[data-mobile-list-header]');
    const cancel = header.querySelector('[aria-label="common.cancel"]');
    assert.ok(cancel, 'Cancel is named for screen readers');
    assert.equal(cancel.textContent.trim(), '', 'no visible word: "Отмена" was ~6 px too wide at 320 px');
    assert.equal(cancel.getAttribute('title'), 'common.cancel');
    const px = (v) => parseInt(v, 10) || 0;
    assert.equal(px(cancel.style.minWidth), 44);
    assert.ok(px(cancel.style.minHeight) >= 44);
    const children = [...header.children];
    const needed = px(header.style.paddingLeft) + px(header.style.paddingRight)
      + px(header.style.columnGap || header.style.gap) * (children.length - 1)
      + children.reduce((sum, el) => sum + px(el.style.minWidth), 0);
    assert.ok(needed <= 320, `the row needs ${needed}px of 320`);
    await React.act(async () => { cancel.click(); });
    assert.ok(header.querySelector('[aria-label="messageList.selectMessages"]'), 'Cancel leaves selection mode');
  });

  test('the command palette opens with Cmd+K when no dialog is open', async () => {
    await mount();
    await press('k', { ctrlKey: true });
    assert.ok(document.querySelector('input[placeholder="commandPalette.placeholder"]'), 'control for the assertion above');
  });

  test('opening_does_not_change_current_mail_context: the dialog opens over the same view, settings and selection', async () => {
    await mount();
    await React.act(async () => { useStore.setState({ selectedFolder: 'Sent', searchQuery: 'invoice' }); });
    await settle();
    const before = useStore.getState();
    await openDialog();
    const state = useStore.getState();
    assert.equal(state.showAddAccountDialog, true);
    for (const k of ['showAdmin', 'adminTab', 'selectedAccountId', 'selectedFolder', 'selectedMessageId', 'searchQuery', 'showContacts', 'composing']) {
      assert.equal(state[k], before[k], k);
    }
    assert.equal(state.searchQuery, 'invoice');
  });

  test('mobile_reading_contacts_keep_add_action: the list and the contacts view carry the direct action, no menu first', async () => {
    await mount(500);
    const triggers = () => document.querySelectorAll('[data-add-account-trigger]');
    assert.ok(triggers().length >= 1, 'the mailbox list header has it');
    await React.act(async () => { useStore.setState({ showContacts: true }); });
    await settle();
    assert.ok(triggers().length >= 2, 'the contacts header has it too');
    const before = { showAdmin: useStore.getState().showAdmin, showContacts: useStore.getState().showContacts };
    await React.act(async () => { triggers()[triggers().length - 1].click(); });
    assert.equal(useStore.getState().showAddAccountDialog, true, 'one tap opens the dialog');
    assert.equal(useStore.getState().showAdmin, before.showAdmin);
    assert.equal(useStore.getState().showContacts, before.showContacts, 'the contacts view stays under the dialog');
    assert.equal(useStore.getState().mobileSidebarOpen, false, 'no menu had to be opened');
  });

  test('mobile_reading_contacts_keep_add_action: the reading pane keeps it too', async () => {
    await mount(500);
    const message = {
      id: 'm1', account_id: 'a1', folder: 'INBOX', uid: 1, subject: 'Hello', from_name: 'Sender', from_email: 'sender@example.invalid',
      date: '2026-10-01T10:00:00.000Z', is_read: true, preview: 'Hi', has_attachments: false, to_addresses: [], cc_addresses: [],
    };
    await React.act(async () => { useStore.setState({ messages: [message], selectedMessageId: 'm1', selectedMessage: message }); });
    await settle();
    const bars = [...document.querySelectorAll('[data-add-account-trigger]')].filter((el) => el.parentElement.textContent.includes('common.back'));
    assert.equal(bars.length, 1, 'the reading pane back bar has the action');
    await React.act(async () => { bars[0].click(); });
    assert.equal(useStore.getState().showAddAccountDialog, true);
    assert.equal(useStore.getState().selectedMessageId, 'm1', 'the open letter stays under the dialog');
  });
});
