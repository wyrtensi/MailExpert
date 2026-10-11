// Render tests for the provider forms of the add-account dialog: the two-field forms of Yahoo,
// Yandex, Mail.ru and iCloud, "Other", Proton (with its polling and challenges), the collapsed
// advanced block of all eight services, the app-password help and its clipboard failure, and the
// secrets boundary. Requests are checked at the HTTP level (a fetch stub), so the headers, the
// bodies and the routes are what the server would see.
//
// The harness mirrors AddAccountDialog.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed to return keys.

import { test, describe, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o && o.service ? k + "|" + o.service : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
  sessionStorage: dom.window.sessionStorage,
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
Object.defineProperty(globalThis, 'getSelection', { value: () => dom.window.getSelection(), configurable: true, writable: true });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../../store/index.js');
const { default: ImapProviderAddForm } = await import('./ImapProviderAddForm.jsx');
const { default: ManualAccountAddForm } = await import('./ManualAccountAddForm.jsx');
const { default: ProtonAddForm } = await import('./ProtonAddForm.jsx');
const { default: AppPasswordHelp } = await import('./AppPasswordHelp.jsx');
const { default: GmailAddForm } = await import('../GmailAddForm.jsx');
const { default: DomainMailboxAddForm } = await import('../DomainMailboxAddForm.jsx');

const SENTINEL = 'secret-sentinel';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONNECTION_ID = '5a8b1a22-3f5d-4be0-9b8e-3c1a5f0d7e11';

const CATALOG = [
  { id: 'yahoo', imap: { host: 'imap.mail.yahoo.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.yahoo.com', port: 587, tls: 'starttls' }, appPasswordUrl: 'https://login.yahoo.com/account/security', publicDomains: ['yahoo.com', 'ymail.com'], loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] } },
  { id: 'yandex', imap: { host: 'imap.yandex.ru', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.yandex.ru', port: 465, tls: 'implicit' }, appPasswordUrl: 'https://id.yandex.ru/security', publicDomains: ['yandex.ru', 'ya.ru'], loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] } },
  { id: 'mailru', imap: { host: 'imap.mail.ru', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.ru', port: 465, tls: 'implicit' }, appPasswordUrl: 'https://account.mail.ru/user/2-step-auth/passwords/', publicDomains: ['mail.ru', 'bk.ru', 'list.ru'], loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] } },
  { id: 'icloud', imap: { host: 'imap.mail.me.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' }, appPasswordUrl: 'https://account.apple.com/', publicDomains: ['icloud.com', 'me.com'], loginAlternatives: { imap: ['full_address', 'local_part'], smtp: ['full_address'] } },
];
const PRESETS = ['yahoo', 'yandex', 'mailru', 'icloud'];
const accountRow = (id, email, extra = {}) => ({ id, name: email, email_address: email, protocol: 'imap', enabled: true, aliases: [], ...extra });

let calls;
let answers;
let outcomes;
function mockFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = opts.method || 'GET';
    const call = { method, path, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : undefined, signal: opts.signal };
    calls.push(call);
    const answer = answers[`${method} ${path}`];
    const value = typeof answer === 'function' ? await answer(call) : answer;
    outcomes.push(value);
    if (value instanceof Error) throw value;
    if (value?.status >= 400) return { ok: false, status: value.status, json: async () => value.body };
    return { ok: true, status: 200, json: async () => value ?? {} };
  };
}

const win = dom.window;
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const until = async (check, label, ms = 1500) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (check()) return;
    await React.act(async () => { await new Promise((r) => setTimeout(r, 4)); });
  }
  assert.fail(`timed out waiting for: ${label}`);
};
const mounted = [];
async function mount(element) {
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => { root.render(element); });
  await flush();
  const handle = { host, unmount: async () => { await React.act(async () => { root.unmount(); }); host.remove(); } };
  mounted.push(handle);
  return handle;
}
async function type(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  await React.act(async () => { el.dispatchEvent(new win.Event('input', { bubbles: true })); });
}
async function click(el) {
  await React.act(async () => { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await flush();
}
async function submit(form) {
  await React.act(async () => { form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
}
// A failing assert on a DOM node would pretty-print the whole jsdom tree; compare a boolean instead.
const gone = (el, message) => assert.ok(el === null || el === undefined, message ?? 'expected the element to be absent');
const byText = (root, selector, text) => [...root.querySelectorAll(selector)].find((el) => el.textContent === text);

// A parent that owns the typed address, as the dialog does.
function Harness({ Form, initialEmail = '', onConnected = () => {}, ...props }) {
  const [email, setEmail] = React.useState(initialEmail);
  return React.createElement(Form, { email, onEmailChange: setEmail, onAttemptStart() {}, onConnected, signal: undefined, ...props });
}

beforeEach(() => {
  calls = [];
  outcomes = [];
  answers = {};
  mockFetch();
  useStore.setState({ accounts: [], accountsReady: true, user: { id: 'u1', isAdmin: false } });
  win.localStorage.clear();
  win.sessionStorage.clear();
});
afterEach(async () => {
  while (mounted.length) await mounted.pop().unmount();
});
after(() => { win.close(); });

const outsideAdvanced = (host, selector) => [...host.querySelectorAll(selector)].filter((el) => !el.closest('[data-advanced-connection]'));

describe('fixed providers: Yahoo, Yandex, Mail.ru, iCloud', () => {
  for (const id of PRESETS) {
    test(`two_required_fields_for_each_preset: ${id}`, async () => {
      const { host } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: id, catalog: CATALOG }));
      const inputs = outsideAdvanced(host, 'input, select, textarea');
      assert.deepEqual(inputs.map((el) => el.id), ['imap-add-email', 'imap-add-password']);
      assert.equal(host.querySelector('#imap-add-password').type, 'password');
      const connect = host.querySelector('button[type="submit"]');
      assert.equal(connect.disabled, true);
      await type(host.querySelector('#imap-add-email'), `person@${CATALOG.find((p) => p.id === id).publicDomains[0]}`);
      assert.equal(connect.disabled, true, 'the password is required too');
      await type(host.querySelector('#imap-add-password'), 'app-pass');
      assert.equal(connect.disabled, false);
      // The help: official page link (new tab, no opener, no referrer), copy button, steps.
      const link = host.querySelector('[data-app-password-help] a[href]');
      assert.equal(link.getAttribute('href'), CATALOG.find((p) => p.id === id).appPasswordUrl);
      assert.equal(link.getAttribute('target'), '_blank');
      assert.match(link.getAttribute('rel'), /noopener/);
      assert.match(link.getAttribute('rel'), /noreferrer/);
      for (const a of host.querySelectorAll('[data-app-password-help] a[href]')) {
        assert.equal(a.getAttribute('target'), '_blank');
        assert.match(a.getAttribute('rel'), /noopener noreferrer/);
        assert.doesNotMatch(a.getAttribute('href'), /@|person|[?&#=]/);
      }
    });
  }

  test('unchanged_advanced_uses_fixed_provider: opening the block alone keeps the fixed route', async () => {
    answers['POST /api/accounts/provider'] = accountRow('a1', 'person@yahoo.com', { mail_provider: 'yahoo' });
    const connected = [];
    const { host } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'yahoo', catalog: CATALOG, onConnected: (r) => connected.push(r) }));
    await type(host.querySelector('#imap-add-email'), 'person@yahoo.com');
    await type(host.querySelector('#imap-add-password'), SENTINEL);
    await click(host.querySelector('[data-advanced-connection] button[aria-expanded]'));
    assert.equal(host.querySelector('[id$="imap_host"]').value, 'imap.mail.yahoo.com', 'prefilled with the tested route');
    await submit(host.querySelector('form'));
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, '/api/accounts/provider');
    assert.deepEqual(posts[0].body, { provider: 'yahoo', email: 'person@yahoo.com', appPassword: SENTINEL });
    assert.match(posts[0].headers['Idempotency-Key'], UUID);
    assert.equal(posts[0].headers['X-Requested-With'], 'MailExpert');
    assert.equal(connected.length, 1);
    assert.equal(connected[0].kind, 'account');
    assert.equal(connected[0].attemptId, posts[0].headers['Idempotency-Key']);
  });

  test('server_edit_switches_to_manual_and_preserves_label; restore returns to the fixed route', async () => {
    answers['POST /api/accounts'] = accountRow('a2', 'team@bk.ru', { mail_provider: 'mailru', connection_mode: 'manual' });
    answers['POST /api/accounts/provider'] = accountRow('a3', 'team@bk.ru', { mail_provider: 'mailru' });
    const { host } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'mailru', catalog: CATALOG }));
    await type(host.querySelector('#imap-add-email'), 'team@bk.ru');
    await type(host.querySelector('#imap-add-password'), SENTINEL);
    await click(host.querySelector('[data-advanced-connection] button[aria-expanded]'));
    await type(host.querySelector('[id$="imap_host"]'), 'imap.example.com');
    assert.ok(host.querySelector('[role="status"].add-account-note'), 'the form says that the route changed');
    await submit(host.querySelector('form'));
    const manual = calls.find((c) => c.method === 'POST' && c.path === '/api/accounts');
    assert.ok(manual, 'goes to the manual route');
    assert.equal(manual.body.provider, 'mailru');
    assert.equal(manual.body.email_address, 'team@bk.ru');
    assert.equal(manual.body.imap_host, 'imap.example.com');
    assert.equal(manual.body.smtp_host, 'smtp.mail.ru');
    assert.equal(manual.body.imap_port, 993);
    assert.equal(manual.body.imap_tls_mode, 'implicit');
    assert.equal(manual.body.smtp_tls, 'SSL');
    assert.equal(manual.body.auth_pass, SENTINEL);
    assert.equal('imap_skip_tls_verify' in manual.body, false);
    assert.equal(calls.some((c) => c.path === '/api/accounts/provider'), false);

    // Restoring the tested settings goes back to the fixed route (a new press, a new attempt).
    await type(host.querySelector('#imap-add-password'), SENTINEL);
    await click(byText(host, 'button', 'admin.accounts.add.serversReset'));
    assert.equal(host.querySelector('[id$="imap_host"]').value, 'imap.mail.ru');
    await submit(host.querySelector('form'));
    const fixed = calls.find((c) => c.path === '/api/accounts/provider');
    assert.ok(fixed);
    assert.notEqual(fixed.headers['Idempotency-Key'], manual.headers['Idempotency-Key']);
  });

  test('known_alternate_domains_keep_full_address and unknown_domain_never_changes_server', async () => {
    answers['POST /api/accounts/provider'] = accountRow('a4', 'x', {});
    let { host, unmount } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'mailru', catalog: CATALOG }));
    await type(host.querySelector('#imap-add-email'), 'team@bk.ru');
    gone(host.querySelector('[data-other-tile]'), 'the address belongs to this tile');
    await type(host.querySelector('#imap-add-password'), 'p');
    await submit(host.querySelector('form'));
    assert.equal(calls.at(-1).body.email, 'team@bk.ru');
    assert.equal('login' in calls.at(-1).body, false);
    await unmount();

    // Another service's public domain only suggests its tile; nothing is switched.
    ({ host, unmount } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'yahoo', catalog: CATALOG })));
    await type(host.querySelector('#imap-add-email'), 'team@bk.ru');
    assert.equal(host.querySelector('[data-other-tile]').dataset.otherTile, 'mailru');
    await type(host.querySelector('#imap-add-password'), 'p');
    await submit(host.querySelector('form'));
    assert.deepEqual(calls.at(-1).body, { provider: 'yahoo', email: 'team@bk.ru', appPassword: 'p' });
    await unmount();

    // An unknown domain: no hint, no server value.
    ({ host } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'yandex', catalog: CATALOG })));
    await type(host.querySelector('#imap-add-email'), 'team@corp.example');
    gone(host.querySelector('[data-other-tile]'));
    await type(host.querySelector('#imap-add-password'), 'p');
    await submit(host.querySelector('form'));
    assert.deepEqual(calls.at(-1).body, { provider: 'yandex', email: 'team@corp.example', appPassword: 'p' });
  });

  test('an AUTH refusal offers the optional login, never echoes the password, and a new press is a new attempt', async () => {
    answers['POST /api/accounts/provider'] = { status: 400, body: { error: 'imap_auth_failed', code: 'imap_auth_failed' } };
    const { host } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'yandex', catalog: CATALOG }));
    await type(host.querySelector('#imap-add-email'), 'ann@ya.ru');
    await type(host.querySelector('#imap-add-password'), SENTINEL);
    gone(host.querySelector('[data-login-offered]'));
    await submit(host.querySelector('form'));
    assert.ok(host.querySelector('[data-login-offered]'), 'the optional login appears');
    assert.equal(host.querySelector('[role="alert"]').textContent, 'admin.accounts.add.error.imapAuth');
    assert.equal(host.textContent.includes(SENTINEL), false);
    assert.equal([...host.querySelectorAll('input')].filter((i) => i.type !== 'password').some((i) => i.value.includes(SENTINEL)), false);
    const firstKey = calls.at(-1).headers['Idempotency-Key'];
    await type(host.querySelector('#imap-add-login'), 'ann');
    await submit(host.querySelector('form'));
    assert.equal(calls.at(-1).body.login, 'ann');
    assert.notEqual(calls.at(-1).headers['Idempotency-Key'], firstKey);
  });

  test('a TLS or network refusal does not offer a login', async () => {
    answers['POST /api/accounts/provider'] = { status: 400, body: { error: 'tls_error', code: 'tls_error' } };
    const { host } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'yahoo', catalog: CATALOG }));
    await type(host.querySelector('#imap-add-email'), 'ann@yahoo.com');
    await type(host.querySelector('#imap-add-password'), 'p');
    await submit(host.querySelector('form'));
    gone(host.querySelector('[data-login-offered]'));
    assert.equal(host.querySelector('[role="alert"]').textContent, 'admin.accounts.add.error.tls');
    // The form stays open with the details so the user can fix them.
    assert.equal(host.querySelector('#imap-add-email').value, 'ann@yahoo.com');
  });

  test('a lost answer is replayed once with the same attempt id', async () => {
    let attempts = 0;
    answers['POST /api/accounts/provider'] = () => {
      attempts += 1;
      return attempts === 1 ? new TypeError('network down') : accountRow('a5', 'ann@yahoo.com');
    };
    const connected = [];
    const { host } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'yahoo', catalog: CATALOG, onConnected: (r) => connected.push(r) }));
    await type(host.querySelector('#imap-add-email'), 'ann@yahoo.com');
    await type(host.querySelector('#imap-add-password'), 'p');
    await submit(host.querySelector('form'));
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key']);
    assert.equal(connected.length, 1);
  });

  test('the form without a catalog still connects through the fixed route and offers no server fields', async () => {
    answers['POST /api/accounts/provider'] = accountRow('a6', 'ann@yahoo.com');
    const { host } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'yahoo', catalog: null }));
    await type(host.querySelector('#imap-add-email'), 'ann@yahoo.com');
    await type(host.querySelector('#imap-add-password'), 'p');
    await click(host.querySelector('[data-advanced-connection] button[aria-expanded]'));
    gone(host.querySelector('[id$="imap_host"]'));
    await submit(host.querySelector('form'));
    assert.deepEqual(calls.at(-1).body, { provider: 'yahoo', email: 'ann@yahoo.com', appPassword: 'p' });
  });
});

describe('Other (manual)', () => {
  test('connect is off until the servers are filled; the block opens only on an explicit click', async () => {
    answers['POST /api/accounts'] = accountRow('o1', 'me@example.com', { mail_provider: 'other' });
    const { host } = await mount(React.createElement(Harness, { Form: ManualAccountAddForm, manualPolicy: { allowNonstandardPorts: false } }));
    assert.deepEqual(outsideAdvanced(host, 'input').map((el) => el.id), ['imap-add-email', 'imap-add-password']);
    await type(host.querySelector('#imap-add-email'), 'me@example.com');
    await type(host.querySelector('#imap-add-password'), 'p');
    const connect = host.querySelector('button[type="submit"]');
    assert.equal(connect.disabled, true);
    assert.ok(host.querySelector('[data-servers-missing]'), 'the hint explains the action');
    assert.equal(host.querySelector('[data-advanced-connection] button[aria-expanded]').getAttribute('aria-expanded'), 'false');
    gone(host.querySelector('[id$="imap_host"]'), 'nothing opens by itself');
    await click(byText(host, 'button', 'admin.accounts.add.serversShow'));
    assert.equal(host.querySelector('[data-advanced-connection] button[aria-expanded]').getAttribute('aria-expanded'), 'true');
    assert.equal(host.querySelector('[id$="imap_host"]').value, '', 'no invented host');
    await type(host.querySelector('[id$="imap_host"]'), 'imap.example.com');
    assert.equal(connect.disabled, true, 'both hosts are needed');
    await type(host.querySelector('[id$="smtp_host"]'), 'smtp.example.com');
    assert.equal(connect.disabled, false);
    gone(host.querySelector('[data-servers-missing]'));
    await submit(host.querySelector('form'));
    const post = calls.find((c) => c.path === '/api/accounts');
    assert.equal(post.body.provider, 'other');
    assert.equal(post.body.imap_host, 'imap.example.com');
    assert.equal(post.body.smtp_host, 'smtp.example.com');
    assert.equal(post.body.auth_user, 'me@example.com');
    assert.match(post.headers['Idempotency-Key'], UUID);
    assert.equal([...host.querySelectorAll('input[type="checkbox"]')].length, 0, 'no TLS-bypass control');
  });

  test('a nonstandard port is refused client-side unless the installation allows it', async () => {
    const { host } = await mount(React.createElement(Harness, { Form: ManualAccountAddForm, manualPolicy: { allowNonstandardPorts: false } }));
    await type(host.querySelector('#imap-add-email'), 'me@example.com');
    await type(host.querySelector('#imap-add-password'), 'p');
    await click(byText(host, 'button', 'admin.accounts.add.serversShow'));
    await type(host.querySelector('[id$="imap_host"]'), 'imap.example.com');
    await type(host.querySelector('[id$="smtp_host"]'), 'smtp.example.com');
    await type(host.querySelector('[id$="imap_port"]'), '2993');
    assert.equal(host.querySelector('button[type="submit"]').disabled, true);
    assert.ok(host.querySelector('[role="alert"]'));
    await mounted.pop().unmount();
    const allowed = await mount(React.createElement(Harness, { Form: ManualAccountAddForm, manualPolicy: { allowNonstandardPorts: true } }));
    await type(allowed.host.querySelector('#imap-add-email'), 'me@example.com');
    await type(allowed.host.querySelector('#imap-add-password'), 'p');
    await click(byText(allowed.host, 'button', 'admin.accounts.add.serversShow'));
    await type(allowed.host.querySelector('[id$="imap_host"]'), 'imap.example.com');
    await type(allowed.host.querySelector('[id$="smtp_host"]'), 'smtp.example.com');
    await type(allowed.host.querySelector('[id$="imap_port"]'), '2993');
    assert.equal(allowed.host.querySelector('button[type="submit"]').disabled, false);
  });
});

describe('advanced block of all eight services', () => {
  const domainAnswers = () => {
    answers['GET /api/mail-node/domains'] = { domains: [{ domain: 'example.com', active: true, state: 'ready' }] };
    answers['GET /api/mail-node/seats'] = { used: 1, held: 0, free: 5, known: true, heldSeats: [], requests: [] };
  };
  const forms = () => [
    ['domain', () => React.createElement(Harness, { Form: (p) => React.createElement(DomainMailboxAddForm, { accounts: [], initialEmail: p.email, onEmailChange: p.onEmailChange, onCreated() {} }) })],
    ['gmail', () => React.createElement(Harness, { Form: (p) => React.createElement(GmailAddForm, { accounts: [], initialEmail: p.email, onEmailChange: p.onEmailChange }) })],
    ['proton', () => React.createElement(Harness, { Form: ProtonAddForm, proton: { configured: true, available: true, code: null } })],
    ...PRESETS.map((id) => [id, () => React.createElement(Harness, { Form: ImapProviderAddForm, provider: id, catalog: CATALOG })]),
    ['other', () => React.createElement(Harness, { Form: ManualAccountAddForm })],
  ];

  test('advanced_is_collapsed_for_all_eight', async () => {
    domainAnswers();
    const kinds = [];
    for (const [kind, build] of forms()) {
      const { host, unmount } = await mount(build());
      const toggle = host.querySelector('[data-advanced-connection] > button[aria-expanded]');
      assert.ok(toggle, `${kind} has the block`);
      assert.equal(toggle.getAttribute('aria-expanded'), 'false', `${kind} starts collapsed`);
      gone(host.querySelector('.add-account-advanced-body'), `${kind} shows no technical detail`);
      gone(host.querySelector('[data-managed-details]'));
      gone(host.querySelector('[id$="imap_host"]'));
      await click(toggle);
      assert.equal(toggle.getAttribute('aria-expanded'), 'true', `${kind} opens on a click`);
      assert.ok(host.querySelector('.add-account-advanced-body'));
      assert.equal(toggle.getAttribute('aria-controls'), host.querySelector('.add-account-advanced-body').id);
      kinds.push(kind);
      await unmount();
    }
    assert.equal(kinds.length, 8);
  });

  test('managed_fields_are_not_editable: Gmail, Proton and our own mailbox', async () => {
    domainAnswers();
    for (const [kind, build] of forms().filter(([k]) => ['domain', 'gmail', 'proton'].includes(k))) {
      const { host, unmount } = await mount(build());
      await click(host.querySelector('[data-advanced-connection] > button[aria-expanded]'));
      const managed = host.querySelector(`[data-managed-details="${kind}"]`);
      assert.ok(managed, `${kind} describes how it connects`);
      const body = host.querySelector('.add-account-advanced-body');
      for (const field of ['imap_host', 'imap_port', 'smtp_host', 'smtp_port', 'imap_tls_mode', 'smtp_tls', 'login']) {
        gone(body.querySelector(`[id$="${field}"]`), `${kind}: no ${field} field`);
      }
      gone(body.querySelector('input[type="password"]'), `${kind}: no password field in the block`);
      gone(body.querySelector('select'));
      // Only the keys of the managed explanation; no credential-bearing value appears.
      assert.equal(managed.querySelectorAll('input, textarea, select').length, 0);
      assert.doesNotMatch(body.textContent, /bridge[-_ ]?pass|token/i);
      await unmount();
    }
  });

  test('Proton, Gmail and node keep their optional fields inside the block', async () => {
    domainAnswers();
    let { host, unmount } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: null }));
    await click(host.querySelector('[data-advanced-connection] > button[aria-expanded]'));
    assert.ok(host.querySelector('.add-account-advanced-body [id$="-name"]'));
    assert.ok(host.querySelector('.add-account-advanced-body [id$="-signature"]'));
    await unmount();
    ({ host, unmount } = await mount(React.createElement(Harness, { Form: (p) => React.createElement(GmailAddForm, { accounts: [], initialEmail: p.email, onEmailChange: p.onEmailChange }) })));
    gone(host.querySelector('#gmail-add-sender'), 'collapsed');
    await click(host.querySelector('[data-advanced-connection] > button[aria-expanded]'));
    assert.ok(host.querySelector('#gmail-add-sender'));
    assert.ok(host.querySelector('#gmail-add-sender-alt'));
    await unmount();
    ({ host } = await mount(React.createElement(Harness, { Form: (p) => React.createElement(DomainMailboxAddForm, { accounts: [], initialEmail: p.email, onEmailChange: p.onEmailChange, onCreated() {} }) })));
    assert.ok(host.querySelector('#domain-add-sender'), 'the required sender name stays visible');
    gone(host.querySelector('#domain-add-sender-alt'));
    await click(host.querySelector('[data-advanced-connection] > button[aria-expanded]'));
    assert.ok(host.querySelector('#domain-add-sender-alt'));
    assert.ok(host.querySelector('#domain-add-name'));
  });
});

describe('app password help', () => {
  let clipboardStub;
  const setClipboard = (writeText) => {
    clipboardStub = writeText ? { writeText } : undefined;
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test', ...(clipboardStub ? { clipboard: clipboardStub } : {}) }, configurable: true, writable: true });
  };
  const withDialog = async (provider = 'yahoo', url = 'https://login.yahoo.com/account/security') => {
    const dialog = win.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    win.document.body.appendChild(dialog);
    const root = createRoot(dialog);
    await React.act(async () => { root.render(React.createElement(AppPasswordHelp, { provider, url })); });
    mounted.push({ unmount: async () => { await React.act(async () => { root.unmount(); }); dialog.remove(); } });
    return dialog;
  };

  test('app_password_link_copy_failure_is_accessible', async () => {
    setClipboard(async () => { throw new Error('denied'); });
    win.document.execCommand = () => false;
    const dialog = await withDialog();
    const copy = dialog.querySelector('button');
    assert.equal(copy.getAttribute('aria-label'), 'admin.accounts.add.appPassword.copyLabel|admin.accounts.add.yahooTitle');
    copy.focus();
    await click(copy);
    const alert = dialog.querySelector('[role="alert"]');
    assert.ok(alert, 'the failure is announced');
    const url = dialog.querySelector('code[data-copy-fallback]');
    assert.equal(url.textContent, 'https://login.yahoo.com/account/security');
    assert.equal(win.getSelection().toString(), 'https://login.yahoo.com/account/security', 'the link is selected for a manual copy');
    assert.equal(win.document.activeElement, copy, 'focus stays on the control that was used');
    assert.equal(dialog.querySelector('[role="status"]').textContent, '');
  });

  test('a successful copy is confirmed in a polite status region', async () => {
    const written = [];
    setClipboard(async (v) => { written.push(v); });
    const dialog = await withDialog('icloud', 'https://account.apple.com/');
    await click(dialog.querySelector('button'));
    assert.deepEqual(written, ['https://account.apple.com/']);
    const status = dialog.querySelector('[role="status"]');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.equal(status.textContent, 'admin.accounts.add.appPassword.copied');
    gone(dialog.querySelector('[role="alert"]'));
  });

  test('help_links_secure_oauth_opener_preserved: help links drop the opener, the Google launch keeps it', async () => {
    const dialog = await withDialog('mailru', 'https://account.mail.ru/user/2-step-auth/passwords/');
    const links = [...dialog.querySelectorAll('a[href]')];
    assert.equal(links.length, 2);
    for (const link of links) {
      assert.equal(link.getAttribute('target'), '_blank');
      assert.match(link.getAttribute('rel'), /noopener/);
      assert.match(link.getAttribute('rel'), /noreferrer/);
    }
    assert.equal(links[1].getAttribute('href'), 'https://help.mail.ru/mail/faq/password/external/');

    // The Google launch link must keep window.opener: the callback posts its result back through it.
    answers['POST /api/oauth/google/start'] = { path: '/oauth/google/launch/abc123' };
    useStore.setState({ accounts: [] });
    const { host } = await mount(React.createElement(Harness, { Form: (p) => React.createElement(GmailAddForm, { accounts: [], initialEmail: p.email, onEmailChange: p.onEmailChange }) }));
    await type(host.querySelector('#gmail-add-email'), 'me@gmail.com');
    await click(byText(host, 'button', 'admin.accounts.add.continue'));
    const launch = host.querySelector('a[href="/oauth/google/launch/abc123"]');
    assert.ok(launch);
    assert.equal(launch.getAttribute('rel'), 'opener');
  });
});

describe('cancelling a Gmail launch', () => {
  test('cancel_during_oauth_launch_never_reopens: an aborted start opens nothing and reports nothing', async () => {
    let release;
    answers['POST /api/oauth/google/start'] = () => new Promise((resolve) => { release = () => resolve({ path: '/oauth/google/launch/late' }); });
    const controller = new AbortController();
    const anchors = [];
    const originalAppend = win.document.body.appendChild.bind(win.document.body);
    win.document.body.appendChild = (node) => { if (node.tagName === 'A') anchors.push(node); return originalAppend(node); };
    try {
      const connected = [];
      const { host } = await mount(React.createElement(Harness, {
        Form: (p) => React.createElement(GmailAddForm, { accounts: [], initialEmail: p.email, onEmailChange: p.onEmailChange, signal: controller.signal, onConnected: (r) => connected.push(r) }),
      }));
      await type(host.querySelector('#gmail-add-email'), 'me@gmail.com');
      await click(byText(host, 'button', 'admin.accounts.add.continue'));
      controller.abort();
      await React.act(async () => { release(); });
      await flush();
      assert.equal(anchors.length, 0, 'no OAuth tab is opened after Back or Close');
      gone(host.querySelector('a[href^="/oauth/"]'));
      assert.equal(connected.length, 0);
    } finally {
      win.document.body.appendChild = originalAppend;
    }
  });
});

describe('Proton', () => {
  const READY = { configured: true, available: true, code: null };
  // The status the (stub) server reports on every poll; a test moves the attempt on by assigning it.
  let current;
  const fastProps = { pollMs: 8, ttlMs: 5000 };
  const fillAndStart = async (host, email = 'ann@proton.me') => {
    await type(host.querySelector('#proton-add-email'), email);
    await type(host.querySelector('#proton-add-password'), SENTINEL);
    await submit(host.querySelector('form'));
  };
  beforeEach(() => {
    current = { id: CONNECTION_ID, state: 'authenticating' };
    answers['POST /api/accounts/proton/connect'] = { id: CONNECTION_ID, state: 'authenticating' };
    answers[`GET /api/accounts/proton/connect/${CONNECTION_ID}`] = () => current;
    answers[`POST /api/accounts/proton/connect/${CONNECTION_ID}/continue`] = () => ({ id: CONNECTION_ID, state: 'checking' });
    answers[`POST /api/accounts/proton/connect/${CONNECTION_ID}/cancel`] = { id: CONNECTION_ID, state: 'cancelled' };
  });
  const gets = () => calls.filter((c) => c.method === 'GET' && c.path.endsWith(CONNECTION_ID));
  const idle = (ms) => React.act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  test('proton_challenge_is_conditional: the code field appears only when Bridge asks, and the answer is cleared', async () => {
    const connected = [];
    const { host } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, onConnected: (r) => connected.push(r), ...fastProps }));
    await fillAndStart(host);
    const start = calls.find((c) => c.method === 'POST' && c.path === '/api/accounts/proton/connect');
    assert.match(start.body.requestId, UUID, 'the attempt id is a UUID in the body');
    assert.equal(start.body.password, SENTINEL);
    assert.equal('Idempotency-Key' in start.headers, false);
    gone(host.querySelector('#proton-add-password'), 'the password field is gone while signing in');
    await until(() => gets().length >= 2, 'polling');
    gone(host.querySelector('[data-proton-challenge]'), 'no challenge field before Bridge asks');
    current = { id: CONNECTION_ID, state: 'needs_2fa' };
    await until(() => host.querySelector('[data-proton-challenge="2fa"]'), 'the two-factor field');
    const input = host.querySelector('#proton-add-secret');
    assert.equal(input.autocomplete, 'one-time-code');
    await type(input, '123456');
    current = { id: CONNECTION_ID, state: 'checking' };
    await submit(host.querySelector('[data-proton-challenge]'));
    const cont = calls.find((c) => c.path.endsWith('/continue'));
    assert.deepEqual(cont.body, { challenge: '2fa', secret: '123456' });
    await until(() => host.querySelector('[data-proton-working="checking"]'), 'the checking state');
    gone(host.querySelector('[data-proton-challenge]'), 'the answered challenge goes away');
    current = { id: CONNECTION_ID, state: 'connected', account: accountRow('p1', 'ann@proton.me', { mail_provider: 'proton' }) };
    await until(() => connected.length === 1, 'the connected callback');
    assert.equal(connected[0].account.id, 'p1');
    assert.equal(connected[0].attemptId, start.body.requestId);
    assert.equal(win.document.body.textContent.includes(SENTINEL), false);
    const settled = gets().length;
    await idle(50);
    assert.equal(gets().length, settled, 'polling stops when the attempt ends');
  });

  test('a lost start answer is replayed once with the same attempt id in the body', async () => {
    let attempts = 0;
    answers['POST /api/accounts/proton/connect'] = () => {
      attempts += 1;
      return attempts === 1 ? new TypeError('network down') : { id: CONNECTION_ID, state: 'authenticating' };
    };
    const { host } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, ...fastProps }));
    await fillAndStart(host);
    const starts = calls.filter((c) => c.method === 'POST' && c.path === '/api/accounts/proton/connect');
    assert.equal(starts.length, 2);
    assert.match(starts[0].body.requestId, UUID);
    assert.equal(starts[1].body.requestId, starts[0].body.requestId, 'no new UUID on the replay');
    await until(() => host.querySelector('[data-proton-working]'), 'the attempt is running');
  });

  test('a second password asks with a password field', async () => {
    const { host } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, ...fastProps }));
    await fillAndStart(host);
    current = { id: CONNECTION_ID, state: 'needs_second_password' };
    await until(() => host.querySelector('[data-proton-challenge="second_password"]'), 'the second password field');
    assert.equal(host.querySelector('#proton-add-secret').type, 'password');
    await type(host.querySelector('#proton-add-secret'), 'second-secret');
    await submit(host.querySelector('[data-proton-challenge="second_password"]'));
    assert.deepEqual(calls.find((c) => c.path.endsWith('/continue')).body, { challenge: 'second_password', secret: 'second-secret' });
  });

  test('a wrong code is announced once and the field stays for a retry', async () => {
    const { host } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, ...fastProps }));
    await fillAndStart(host);
    current = { id: CONNECTION_ID, state: 'needs_2fa' };
    await until(() => host.querySelector('#proton-add-secret'), 'the field');
    await type(host.querySelector('#proton-add-secret'), '000000');
    // The server keeps reporting the retryable error until the next answer.
    current = { id: CONNECTION_ID, state: 'needs_2fa', errorCode: 'invalid_challenge' };
    await submit(host.querySelector('[data-proton-challenge]'));
    await until(() => host.querySelector('[role="alert"]'), 'the wrong-code message');
    assert.equal(host.querySelector('[role="alert"]').textContent, 'admin.accounts.add.protonError.invalidChallenge');
    assert.ok(host.querySelector('[data-proton-challenge="2fa"]'));
    assert.equal(host.querySelector('#proton-add-secret').value, '', 'the wrong code is cleared');
    // Typing again clears the message; the repeated status does not bring it back before a new answer.
    await type(host.querySelector('#proton-add-secret'), '1');
    await idle(60);
    gone(host.querySelector('[role="alert"]'));
  });

  for (const [code, key] of [
    ['invalid_credentials', 'admin.accounts.add.protonError.invalidCredentials'],
    ['connection', 'admin.accounts.add.protonError.connection'],
    ['verification_required', 'admin.accounts.add.protonError.verificationRequired'],
    ['proton_unavailable', 'admin.accounts.add.protonError.unavailable'],
  ]) {
    test(`a failed attempt (${code}) shows its own message, clears the password and keeps the address`, async () => {
      current = { id: CONNECTION_ID, state: 'failed', errorCode: code };
      const { host } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, ...fastProps }));
      await fillAndStart(host);
      await until(() => host.querySelector('[role="alert"]'), 'the failure');
      assert.equal(host.querySelector('[role="alert"]').textContent, key);
      assert.equal(host.querySelector('#proton-add-email').value, 'ann@proton.me');
      assert.equal(host.querySelector('#proton-add-password').value, '');
      assert.equal(host.textContent.includes(SENTINEL), false);
    });
  }

  test('an unavailable worker takes no password', async () => {
    const down = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: { configured: true, available: false, code: 'proton_unavailable' } }));
    assert.ok(down.host.querySelector('[data-proton-unavailable]'));
    gone(down.host.querySelector('input[type="password"]'));
    gone(down.host.querySelector('input'));
    assert.equal(down.host.querySelector('[role="status"]').textContent, 'admin.accounts.add.protonWorkerDown');
    const missing = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: { configured: false, available: false, code: 'proton_unavailable' } }));
    assert.equal(missing.host.querySelector('[role="status"]').textContent, 'admin.accounts.add.protonNotConfigured');
  });

  test('back_close_clear_secrets: leaving the form cancels the attempt, stops polling and leaves no secret behind', async () => {
    const handle = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, ...fastProps }));
    await fillAndStart(handle.host);
    await until(() => gets().length >= 2, 'polling');
    await handle.unmount();
    mounted.splice(mounted.indexOf(handle), 1);
    const cancels = calls.filter((c) => c.path.endsWith('/cancel'));
    assert.equal(cancels.length, 1, 'an explicit cancel is sent');
    assert.equal(cancels[0].signal, undefined, 'the cancel carries no signal');
    const settled = gets().length;
    await idle(60);
    assert.equal(gets().length, settled, 'no poll after the form is gone');
    assert.equal(JSON.stringify(useStore.getState()).includes(SENTINEL), false);
    assert.equal(JSON.stringify({ ...win.localStorage }).includes(SENTINEL), false);
    assert.equal(JSON.stringify({ ...win.sessionStorage }).includes(SENTINEL), false);
    assert.equal(calls.some((c) => c.path.includes(SENTINEL)), false);
    // A fresh form starts empty.
    const again = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, ...fastProps }));
    assert.equal(again.host.querySelector('#proton-add-password').value, '');
  });

  test('Cancel in the form ends the attempt on the server and returns to the form', async () => {
    const { host } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, ...fastProps }));
    await fillAndStart(host);
    await until(() => host.querySelector('[data-proton-working]'), 'the working state');
    await click(byText(host, 'button', 'common.cancel'));
    assert.equal(calls.filter((c) => c.path.endsWith('/cancel')).length, 1);
    assert.ok(host.querySelector('#proton-add-password'));
    const settled = gets().length;
    await idle(40);
    assert.equal(gets().length, settled);
  });

  test('an aborted dialog signal stops the polling request chain', async () => {
    const controller = new AbortController();
    const { host } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, signal: controller.signal, ...fastProps }));
    await fillAndStart(host);
    await until(() => gets().length >= 2, 'polling');
    assert.equal(gets()[0].signal, controller.signal, 'polls carry the dialog signal');
    controller.abort();
    await idle(20);
    const settled = gets().length;
    await idle(60);
    assert.equal(gets().length, settled);
  });

  test('the attempt is given up and cancelled after the time limit', async () => {
    const { host } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, pollMs: 8, ttlMs: 60 }));
    await fillAndStart(host);
    await until(() => host.querySelector('[role="alert"]'), 'the expiry message');
    assert.equal(host.querySelector('[role="alert"]').textContent, 'admin.accounts.add.protonError.expired');
    assert.equal(calls.filter((c) => c.path.endsWith('/cancel')).length, 1);
    assert.equal(host.querySelector('#proton-add-password').value, '');
  });

  test('reconnect_seed_requires_capability: only a server-approved mailbox is reconnected', async () => {
    const accounts = [
      accountRow('m1', 'ann@proton.me', { mail_provider: 'proton', can_reconnect_proton: true }),
      accountRow('m2', 'bob@proton.me', { mail_provider: 'proton', can_reconnect_proton: false }),
    ];
    let { host, unmount } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, accounts, ...fastProps }));
    await type(host.querySelector('#proton-add-email'), 'bob@proton.me');
    gone(host.querySelector('[data-reconnect]'));
    await unmount();
    ({ host } = await mount(React.createElement(Harness, { Form: ProtonAddForm, proton: READY, accounts, seedAccount: accounts[0], ...fastProps })));
    await type(host.querySelector('#proton-add-email'), 'ann@proton.me');
    assert.ok(host.querySelector('[data-reconnect]'));
    await type(host.querySelector('#proton-add-password'), 'p');
    await submit(host.querySelector('form'));
    assert.equal(calls.find((c) => c.method === 'POST' && c.path === '/api/accounts/proton/connect').body.reconnectAccountId, 'm1');
  });
});

describe('our own mailbox keeps its alias contract', () => {
  test('domain_foreign_alias_contract_preserved: an alias turned into a mailbox prefills the form and creates with the same body', async () => {
    answers['GET /api/mail-node/domains'] = { domains: [{ domain: 'example.com', active: true, state: 'ready' }] };
    answers['GET /api/mail-node/seats'] = { used: 1, held: 0, free: 5, known: true, heldSeats: [], requests: [] };
    answers['POST /api/accounts'] = accountRow('n9', 'orders@example.com', { mail_node: true });
    const created = [];
    const typed = [];
    const controller = new AbortController();
    const { host } = await mount(React.createElement(DomainMailboxAddForm, {
      accounts: [], initial: { localPart: 'orders', domain: 'example.com', senderName: 'Orders desk' },
      initialEmail: 'orders@example.com', onEmailChange: (value) => typed.push(value), signal: controller.signal,
      onCreated: (account) => created.push(account),
    }));
    assert.equal(host.querySelector('#domain-add-local').value, 'orders');
    assert.equal(host.querySelector('#domain-add-sender').value, 'Orders desk');
    assert.equal(host.querySelector('select').value, 'example.com');
    assert.equal(calls.some((c) => c.method !== 'GET'), false, 'nothing is created by opening the form');
    await click(byText(host, 'button', 'admin.accounts.add.domainNext'));
    await click(byText(host, 'button', 'admin.accounts.add.domainCreate'));
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/accounts');
    assert.deepEqual(
      { kind: post.body.kind, localPart: post.body.localPart, domain: post.body.domain, senderName: post.body.senderName },
      { kind: 'domain', localPart: 'orders', domain: 'example.com', senderName: 'Orders desk' },
    );
    assert.equal('Idempotency-Key' in post.headers, false, 'the node route takes no idempotency key');
    assert.equal(created.length, 1);
    assert.ok(typed.includes('orders@example.com'));
  });
});

describe('secrets boundary', () => {
  test('back_close_clear_secrets: an app password dies with the form and never reaches state, URLs or storage', async () => {
    answers['POST /api/accounts/provider'] = { status: 400, body: { error: 'imap_auth_failed', code: 'imap_auth_failed' } };
    const first = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'yahoo', catalog: CATALOG }));
    await type(first.host.querySelector('#imap-add-email'), 'ann@yahoo.com');
    await type(first.host.querySelector('#imap-add-password'), SENTINEL);
    await submit(first.host.querySelector('form'));
    assert.equal(JSON.stringify(useStore.getState()).includes(SENTINEL), false);
    assert.equal(calls.some((c) => c.path.includes(SENTINEL) || JSON.stringify(c.headers).includes(SENTINEL)), false);
    await first.unmount();
    mounted.splice(mounted.indexOf(first), 1);
    const second = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'yahoo', catalog: CATALOG }));
    assert.equal(second.host.querySelector('#imap-add-password').value, '');
    assert.equal(JSON.stringify({ ...win.localStorage, ...win.sessionStorage }).includes(SENTINEL), false);
    assert.equal(win.document.body.innerHTML.includes(SENTINEL), false);
  });

  test('the password is cleared when the connection succeeds', async () => {
    answers['POST /api/accounts/provider'] = accountRow('a9', 'ann@yahoo.com');
    const { host } = await mount(React.createElement(Harness, { Form: ImapProviderAddForm, provider: 'yahoo', catalog: CATALOG }));
    await type(host.querySelector('#imap-add-email'), 'ann@yahoo.com');
    await type(host.querySelector('#imap-add-password'), SENTINEL);
    await submit(host.querySelector('form'));
    assert.equal(host.querySelector('#imap-add-password').value, '');
  });
});
