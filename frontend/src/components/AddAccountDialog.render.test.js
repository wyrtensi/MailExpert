// Render tests for the add-account dialog: the tile picker, the full-form screen, Back and Close
// with focus handling, the keyboard trap and Escape, and results that arrive after the form was
// left. The kind -> form table is replaced by a fake form so no backend is involved.
//
// The harness mirrors AccountsTab.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed.

import { test, describe, before, after, beforeEach, mock } from 'node:test';
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
const { default: AddAccountDialog } = await import('./AddAccountDialog.jsx');
const { ADD_ACCOUNT_KINDS } = await import('../utils/addAccount.js');
const { isAttemptId } = await import('../utils/addAccountFlow.js');
const { appOAuthReturnWatch } = await import('../utils/appOAuthReturn.js');

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
const key = (target, k, init = {}) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

// A form that exposes what the dialog hands to it, so the tests can drive it.
let lastProps = null;
function FakeForm(props) {
  lastProps = props;
  return React.createElement('div', { 'data-fake-form': props.email }, React.createElement('input', { 'aria-label': 'fake address', value: props.email, onChange: (e) => props.onEmailChange(e.target.value) }));
}
const FORMS = Object.fromEntries(ADD_ACCOUNT_KINDS.map((kind) => [kind, FakeForm]));

describe('AddAccountDialog', () => {
  let host, root, trigger, closed, getAccountsCalls, serverAccounts;
  const open = async () => {
    trigger.focus();
    await React.act(async () => {
      root.render(React.createElement(AddAccountDialog, { onClose: () => { closed += 1; root.render(null); }, forms: FORMS }));
    });
    await settle();
  };
  const dialog = () => document.querySelector('[role="dialog"]');
  const tile = (kind) => dialog().querySelector(`[data-provider-tile="${kind}"]`);
  const click = (el) => React.act(async () => { el.click(); });

  before(() => {
    api.getIntegrationsStatus = () => Promise.resolve({ google: { configured: true, available: true }, domainMail: { configured: true } });
    api.getAccounts = () => { getAccountsCalls += 1; return Promise.resolve(serverAccounts); };
    host = document.createElement('div');
    trigger = document.createElement('button');
    trigger.textContent = 'open';
    document.body.append(trigger, host);
    root = createRoot(host);
  });
  after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
    trigger.remove();
  });
  beforeEach(async () => {
    await React.act(async () => root.render(null));
    closed = 0;
    getAccountsCalls = 0;
    lastProps = null;
    serverAccounts = [];
    document.body.style.overflow = 'auto';
    useStore.setState({ accounts: [{ id: 'a1', email_address: 'one@example.invalid' }], showAddAccountDialog: true, notifications: [], fontSize: 100 });
  });

  test('provider_intro_under_title: each form opens with one line on what the service needs', async () => {
    await open();
    await click(tile('yahoo'));
    const intro = dialog().querySelector('[data-provider-intro]');
    assert.equal(intro?.textContent, 'admin.accounts.add.intro.appPassword');
    await click(dialog().querySelector('.add-account-back'));
    await click(tile('other'));
    assert.equal(dialog().querySelector('[data-provider-intro]')?.textContent, 'admin.accounts.add.intro.other');
  });

  test('proton_tile_shows_unavailable: a stopped Proton service is visible on its tile, which stays selectable', async () => {
    api.getIntegrationsStatus = () => Promise.resolve({
      google: { configured: true, available: true }, domainMail: { configured: true }, proton: { configured: true, available: false },
    });
    try {
      await open();
      assert.ok(tile('proton').querySelector('.add-account-tile-state'), 'the tile says the service is unavailable');
      assert.equal(tile('yahoo').querySelector('.add-account-tile-state'), null);
      await click(tile('proton'));
      assert.ok(lastProps, 'the Proton form still opens and explains why');
    } finally {
      api.getIntegrationsStatus = () => Promise.resolve({ google: { configured: true, available: true }, domainMail: { configured: true } });
    }
  });

  test('shows one labelled modal dialog with eight tiles in the picker order, and no form', async () => {
    await open();
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    const d = dialog();
    assert.equal(d.getAttribute('aria-modal'), 'true');
    assert.equal(document.getElementById(d.getAttribute('aria-labelledby')).textContent, 'admin.accounts.addTitle');
    assert.equal(d.querySelectorAll('[data-provider-tile]').length, 8);
    assert.deepEqual([...d.querySelectorAll('[data-provider-tile]')].map((el) => el.dataset.providerTile), [...ADD_ACCOUNT_KINDS]);
    assert.equal(d.querySelector('[data-fake-form]'), null);
    assert.equal(d.querySelector('svg[aria-hidden="true"]') !== null, true, 'tile icons are decorative');
    assert.equal(document.activeElement, d.querySelector('h2'), 'focus moved into the dialog');
  });

  test('tile_replaces_picker_with_full_form: the grid is gone, the title carries the service name', async () => {
    await open();
    await click(tile('yahoo'));
    const d = dialog();
    assert.equal(d.querySelector('[data-provider-picker]'), null);
    assert.equal(d.querySelectorAll('[data-provider-tile]').length, 0);
    assert.ok(d.querySelector('[data-fake-form]'));
    assert.equal(d.querySelector('h2').textContent, 'admin.accounts.add.yahooTitle');
    assert.equal(document.activeElement, d.querySelector('h2'), 'the next step lands on the form title');
  });

  test('back_is_top_left_and_restores_tile_focus, keeping the typed address', async () => {
    await open();
    await click(tile('gmail'));
    const d = dialog();
    const buttons = [...d.querySelectorAll('.add-account-header button')];
    assert.equal(buttons[0].textContent, 'common.back', 'Back is the first control of the header');
    assert.equal(buttons[buttons.length - 1].getAttribute('aria-label'), 'common.close', 'Close is the last');
    const input = d.querySelector('input');
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'me@example.invalid');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click(buttons[0]);
    assert.equal(dialog().querySelector('[data-fake-form]'), null);
    assert.equal(dialog().querySelectorAll('[data-provider-tile]').length, 8);
    assert.equal(document.activeElement, tile('gmail'));
    await click(tile('proton'));
    assert.equal(lastProps.email, 'me@example.invalid', 'the address survives Back within the open dialog');
  });

  test('Back aborts the attempt of the form; Close aborts it too', async () => {
    await open();
    await click(tile('proton'));
    const first = lastProps.signal;
    assert.equal(first.aborted, false);
    await click(dialog().querySelector('.add-account-back'));
    assert.equal(first.aborted, true);
    await click(tile('other'));
    const second = lastProps.signal;
    assert.notEqual(second, first);
    assert.equal(second.aborted, false);
    await click(dialog().querySelector('[aria-label="common.close"]'));
    assert.equal(second.aborted, true);
    assert.equal(closed, 1);
  });

  test('escape_traps_and_restores_focus: Tab wraps inside, Escape closes and focus returns to the opener', async () => {
    await open();
    await click(tile('icloud'));
    const d = dialog();
    const focusables = [...d.querySelectorAll('button, input')];
    focusables[focusables.length - 1].focus();
    await React.act(async () => { key(focusables[focusables.length - 1], 'Tab'); });
    assert.equal(document.activeElement, focusables[0], 'Tab from the last control goes to the first');
    await React.act(async () => { key(focusables[0], 'Tab', { shiftKey: true }); });
    assert.equal(document.activeElement, focusables[focusables.length - 1], 'Shift+Tab from the first goes to the last');
    await React.act(async () => { trigger.focus(); });
    assert.ok(d.contains(document.activeElement), 'focus cannot leave the dialog');
    await React.act(async () => { key(document.activeElement, 'Escape'); });
    assert.equal(closed, 1);
    assert.equal(document.activeElement, trigger);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  });

  test('escape_dismisses_suggestions_first: a key the form already used does not close the dialog', async () => {
    await open();
    await click(tile('gmail'));
    const input = dialog().querySelector('input');
    input.addEventListener('keydown', (e) => { e.preventDefault(); e.stopPropagation(); });
    await React.act(async () => { key(input, 'Escape'); });
    assert.equal(closed, 0);
    assert.ok(dialog());
    await React.act(async () => { key(document.querySelector('.add-account-panel'), 'Escape'); });
    assert.equal(closed, 1);
  });

  test('portal_font_scale_and_inert_restore: scale on the panel only; scroll and inert come back as found', async () => {
    useStore.setState({ fontSize: 125 });
    const aside = document.createElement('div');
    const alreadyInert = document.createElement('div');
    alreadyInert.setAttribute('inert', '');
    document.body.append(aside, alreadyInert);
    document.body.style.overflow = 'scroll';
    await open();
    assert.equal(dialog().style.getPropertyValue('--add-account-scale'), '1.25');
    assert.equal(document.querySelector('.add-account-overlay').style.transform, '', 'the overlay is not transformed');
    assert.equal(document.body.style.overflow, 'hidden');
    assert.equal(aside.hasAttribute('inert'), true, 'the background is inert');
    assert.equal(host.hasAttribute('inert'), true);
    assert.equal(document.querySelector('.add-account-overlay').hasAttribute('inert'), false);
    await click(dialog().querySelector('[aria-label="common.close"]'));
    assert.equal(document.body.style.overflow, 'scroll');
    assert.equal(aside.hasAttribute('inert'), false);
    assert.equal(host.hasAttribute('inert'), false);
    assert.equal(alreadyInert.hasAttribute('inert'), true, 'what was inert before stays inert');
    aside.remove();
    alreadyInert.remove();
  });

  test('success adds the account against the latest list, shows a notice and closes', async () => {
    await open();
    await click(tile('other'));
    const { onAttemptStart, onConnected } = lastProps;
    onAttemptStart();
    // The list changed while the form was busy: the upsert must start from this one.
    useStore.setState({ accounts: [{ id: 'a1', email_address: 'one@example.invalid' }, { id: 'a2', email_address: 'two@example.invalid' }] });
    await React.act(async () => { onConnected({ kind: 'account', account: { id: 'a3', email_address: 'three@example.invalid' }, attemptId: 'x' }); });
    assert.deepEqual(useStore.getState().accounts.map((a) => a.id), ['a1', 'a2', 'a3']);
    assert.equal(useStore.getState().notifications.length, 1);
    assert.equal(closed, 1);
  });

  test('late_completion_never_reopens_form: a result after Back is kept in the list, the form stays gone', async () => {
    await open();
    await click(tile('other'));
    const { onAttemptStart, onConnected } = lastProps;
    onAttemptStart();
    await click(dialog().querySelector('.add-account-back'));
    await settle();
    assert.equal(getAccountsCalls, 1, 'leaving a sent attempt reads the server list');
    await React.act(async () => { onConnected({ kind: 'account', account: { id: 'late', email_address: 'late@example.invalid' }, attemptId: 'x' }); });
    assert.ok(useStore.getState().accounts.some((a) => a.id === 'late'), 'the created mailbox is not hidden');
    assert.equal(dialog().querySelector('[data-fake-form]'), null, 'the form is not reopened');
    assert.equal(dialog().querySelectorAll('[data-provider-tile]').length, 8, 'the picker stays');
    assert.equal(closed, 0, 'and the dialog is not closed by a late result');
    assert.equal(useStore.getState().notifications.length, 0);
  });

  test('closing with a sent attempt reads the list again, and an OAuth result refreshes it without closing a closed dialog', async () => {
    await open();
    await click(tile('gmail'));
    lastProps.onAttemptStart();
    await click(dialog().querySelector('[aria-label="common.close"]'));
    await settle();
    assert.equal(getAccountsCalls, 1);
    assert.equal(closed, 1);
    const { onConnected } = lastProps;
    serverAccounts = [{ id: 'g1', email_address: 'g@example.invalid' }];
    await React.act(async () => { onConnected({ kind: 'oauth', attemptId: 'x' }); });
    await settle();
    assert.equal(getAccountsCalls, 2);
    assert.deepEqual(useStore.getState().accounts.map((a) => a.id), ['g1'], 'the list comes from the server, no account is invented');
    assert.equal(closed, 1);
  });
});

describe('AddAccountDialog Gmail attempts', () => {
  let host, root, closed, starts;
  const dialog = () => document.querySelector('[role="dialog"]');
  const click = (el) => React.act(async () => { el.click(); });
  const message = (data) => React.act(async () => {
    window.dispatchEvent(new dom.window.MessageEvent('message', { data, origin: dom.window.location.origin }));
  });
  const success = (attempt) => ({ type: 'oauth_success', provider: 'google', result: 'created', attempt });

  before(() => {
    api.getIntegrationsStatus = () => Promise.resolve({ google: { configured: true, available: true }, domainMail: { configured: true } });
    api.knownGoogleEmails = () => Promise.resolve({ emails: [] });
    api.getAccounts = () => Promise.resolve([]);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  beforeEach(async () => {
    await React.act(async () => root.render(null));
    // The return watch outlives a dialog by design; each test starts with nothing waiting.
    appOAuthReturnWatch().clear();
    closed = 0;
    starts = [];
    api.startGoogleOAuth = (email, names, attemptId) => {
      starts.push({ email, attemptId });
      return starts.length === 1 && failFirst
        ? Promise.reject(Object.assign(new Error('down'), { code: 'oops' }))
        : Promise.resolve({ path: '/oauth/google/launch?flow=abc' });
    };
    useStore.setState({ accounts: [], showAddAccountDialog: true, notifications: [], fontSize: 100 });
    await React.act(async () => {
      root.render(React.createElement(AddAccountDialog, { onClose: () => { closed += 1; root.render(null); } }));
    });
    await settle();
    await click(dialog().querySelector('[data-provider-tile="gmail"]'));
    const input = dialog().querySelector('input[type="email"]');
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'me@example.com');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  });
  let failFirst = false;
  const cont = async () => {
    await click([...dialog().querySelectorAll('button')].find((b) => b.textContent === 'admin.accounts.add.continue'));
    await settle();
  };

  test('late_oauth_a_cannot_close_b: only the callback of the newest attempt closes the form', async () => {
    failFirst = false;
    await cont();
    await cont();
    assert.equal(starts.length, 2);
    const [a, b] = [starts[0].attemptId, starts[1].attemptId];
    assert.notEqual(a, b, 'a new start is a new attempt');
    assert.ok(isAttemptId(a) && isAttemptId(b));
    await message(success(a));
    assert.equal(closed, 0, 'the late result of attempt A does not close attempt B');
    assert.ok(dialog(), 'the form is still there');
    await message({ ...success(b), attempt: undefined });
    assert.equal(closed, 0, 'a result without an attempt id closes nothing');
    await message(success(b));
    assert.equal(closed, 1, 'the callback of B closes it');
    assert.equal(useStore.getState().notifications.length, 0, 'the toast of an OAuth result comes from the MailApp listener, not the dialog');
  });

  test('escape_dismisses_suggestions_first (real Gmail form): the first Escape closes the list, the second the dialog', async () => {
    await React.act(async () => { useStore.setState({ accounts: [{ id: 'x', email_address: 'me@example.com', oauth_provider: 'google', enabled: true, health: 'healthy' }] }); });
    const input = dialog().querySelector('input[type="email"]');
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'me@example.co');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.ok(dialog().querySelector('[role="listbox"]'), 'the suggestion list is open');
    await React.act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    assert.equal(dialog().querySelector('[role="listbox"]'), null, 'the list is closed');
    assert.equal(closed, 0, 'the dialog stays');
    await React.act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    assert.equal(closed, 1, 'the second Escape closes the dialog');
  });

  test('the panel height follows its overlay (the visual viewport), not dvh', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    const panel = css.slice(css.indexOf(".add-account-panel {"), css.indexOf("}", css.indexOf(".add-account-panel {")));
    assert.ok(panel.includes("max-height: calc(100% / var(--add-account-scale))"));
    assert.ok(!/dvh/.test(panel));
  });

  test('return from an external browser reconciles on focus for the whole OAuth state lifetime, against the launched address', async () => {
    failFirst = false;
    let reads = 0;
    let list = [];
    api.getAccounts = () => { reads += 1; return Promise.resolve(list); };
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    try {
      await cont();
      const focus = async () => { await React.act(async () => { window.dispatchEvent(new dom.window.Event('focus')); }); await settle(); };
      await focus();
      await focus();
      assert.equal(reads, 1, 'a burst of focus events is one read');
      // The field is edited after the start: the attempt still looks for the address it launched with.
      const input = dialog().querySelector('input[type="email"]');
      await React.act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'someone-else@example.com');
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      mock.timers.tick(90_000); // past the 60 s launch-link lifetime, far inside the 600 s state lifetime
      list = [{ id: 'other', email_address: 'someone-else@example.com' }];
      await focus();
      assert.equal(reads, 2, 'still listening after 90 s');
      assert.equal(closed, 0, 'the edited address is not what the attempt waits for');
      list = [{ id: 'g', email_address: 'ME@example.com' }];
      mock.timers.tick(5_000);
      await focus();
      assert.equal(closed, 1, 'the launched address appeared: the form finishes');
      assert.deepEqual(useStore.getState().accounts.map((a) => a.id), ['g']);
    } finally {
      mock.timers.reset();
    }
  });

  test('closed_dialog_external_return_reconciles: a sign-in finished in the external browser after Close still refreshes the list', async () => {
    failFirst = false;
    let reads = 0;
    let list = [];
    api.getAccounts = () => { reads += 1; return Promise.resolve(list); };
    mock.timers.enable({ apis: ['Date'], now: 3_000_000 });
    try {
      await cont();
      await click(dialog().querySelector('button[aria-label="common.close"]'));
      assert.equal(closed, 1, 'the dialog is closed while Google is still open elsewhere');
      const focus = async () => { await React.act(async () => { window.dispatchEvent(new dom.window.Event('focus')); }); await settle(); };
      mock.timers.tick(120_000);
      list = [{ id: 'g', email_address: 'me@example.com' }];
      const before = reads;
      await focus();
      assert.equal(reads, before + 1, 'the return reads the list although the form is gone');
      assert.deepEqual(useStore.getState().accounts.map((a) => a.id), ['g'], 'the new mailbox is in the shared list');
      assert.equal(closed, 1, 'nothing reopens');
      mock.timers.tick(5_000);
      await focus();
      assert.equal(reads, before + 1, 'once the address is there, the wait is over');
    } finally {
      mock.timers.reset();
    }
  });

  test('the focus listener stops after the OAuth state lifetime (600 s)', async () => {
    failFirst = false;
    let reads = 0;
    api.getAccounts = () => { reads += 1; return Promise.resolve([]); };
    mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
    try {
      await cont();
      mock.timers.tick(601_000);
      await React.act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
      await settle();
      assert.equal(reads, 0);
    } finally {
      mock.timers.reset();
    }
  });

  test('a start that failed is retried with the same attempt id', async () => {
    failFirst = true;
    await cont();
    await cont();
    assert.equal(starts.length, 2);
    assert.equal(starts[0].attemptId, starts[1].attemptId, 'the retry reuses the id');
    failFirst = false;
    await cont();
    assert.notEqual(starts[2].attemptId, starts[1].attemptId, 'a start that reached Google ends the attempt');
  });

  test('a result after the form was left closes nothing', async () => {
    failFirst = false;
    await cont();
    const a = starts[0].attemptId;
    await click(dialog().querySelector('.add-account-back'));
    await message(success(a));
    assert.equal(closed, 0);
    assert.ok(dialog().querySelector('[data-provider-picker]'), 'the picker stays, the form is not reopened');
  });
});
