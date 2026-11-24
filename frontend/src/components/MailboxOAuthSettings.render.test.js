import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (key, vars) => [key, ...Object.values(vars || {})].join(" ") });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    if (url.startsWith('file:') && /\.jsx?$/.test(url)) {
      let source = readFileSync(new URL(url), 'utf8');
      if (url.endsWith('.jsx')) source = transform(source, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code;
      if (url.endsWith('.jsx') || source.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: source.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://alternate.example.com' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', DEV: false, PROD: true },
});
globalThis.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MailboxOAuthSettings } = await import('./AdminPanel.jsx');
const { api } = await import('../utils/api.js');

const panelOrigin = 'https://panel.example.com:8443';
const browserRedirect = 'https://alternate.example.com/oauth/yandex/callback';
const host = document.getElementById('root');
const click = (element) => act(async () => element.click());
const field = (id) => host.querySelector(`#${id}`);
const checkbox = () => field('yandex-code-login');
const originalSave = api.saveIntegration;
let root;
let requests;

beforeEach(() => {
  root = createRoot(host);
  requests = [];
  api.saveIntegration = async (...args) => requests.push(args);
});
afterEach(async () => {
  await act(async () => root.unmount());
  api.saveIntegration = originalSave;
});

async function render(provider, config) {
  await act(async () => root.render(createElement(MailboxOAuthSettings, { provider, config, panelOrigin, onSaved() {} })));
  await click(host.querySelector('.admin-integration-header'));
}

test('new browser integrations suggest the configured panel origin with its port', async () => {
  await render('yandex');
  assert.equal(field('yandex-redirect-uri').value, `${panelOrigin}/oauth/yandex/callback`);
  assert.equal(checkbox().checked, false);
  assert.equal(field('yandex-redirect-uri').required, true);
  assert.ok(host.querySelector('a[href="https://oauth.yandex.ru/"]'));
  assert.match(host.textContent, /panel\.example\.com/);
});

test('the Yandex setup guide copies each of its three required scopes separately', async () => {
  await render('yandex');
  const scopes = ['mail:smtp', 'mail:imap_full', 'login:info'];
  const copyLabel = 'admin.integrations.yandex.copyScope';
  const buttons = [...host.querySelectorAll(`button[aria-label^="${copyLabel} "]`)];
  assert.deepEqual(buttons.map(button => button.getAttribute('aria-label')), scopes.map(scope => `${copyLabel} ${scope}`));
  assert.match(host.textContent, /admin\.integrations\.yandex\.setupPermissions/);

  const copied = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async (value) => copied.push(value) },
  });
  try {
    for (const [index, button] of buttons.entries()) {
      await click(button);
      assert.equal(host.querySelector('[role="status"]').textContent, `admin.integrations.yandex.scopeCopied ${scopes[index]}`);
    }
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else delete navigator.clipboard;
  }
  assert.deepEqual(copied, scopes);
  assert.deepEqual(requests, []);
});

test('Yandex code mode disables the redirect, preserves the draft on toggle, and saves without a redirect', async () => {
  await render('yandex', { clientId: 'saved-client', redirectUri: browserRedirect });
  const redirect = field('yandex-redirect-uri');
  assert.equal(redirect.value, browserRedirect);
  await click(checkbox());
  assert.equal(redirect.disabled, true);
  assert.equal(redirect.required, false);
  await click(checkbox());
  assert.equal(redirect.disabled, false);
  assert.equal(redirect.value, browserRedirect);
  await click(checkbox());
  await click(host.querySelector('button[type="submit"]'));
  assert.deepEqual(requests, [['yandex', { clientId: 'saved-client', redirectUri: '', clientSecret: '' }]]);
});

test('a saved code-only Yandex integration stays in code mode when reopened', async () => {
  await render('yandex', { clientId: 'saved-client' });
  assert.equal(checkbox().checked, true);
  assert.equal(field('yandex-redirect-uri').disabled, true);
  await click(checkbox());
  assert.equal(field('yandex-redirect-uri').value, `${panelOrigin}/oauth/yandex/callback`);
  assert.equal(field('yandex-redirect-uri').required, true);
  await click(host.querySelector('button[type="submit"]'));
  assert.deepEqual(requests, [['yandex', { clientId: 'saved-client', redirectUri: `${panelOrigin}/oauth/yandex/callback`, clientSecret: '' }]]);
});

test('Mail.ru requires a redirect from the panel origin and links to its OAuth console', async () => {
  await render('mailru');
  assert.equal(field('mailru-redirect-uri').value, `${panelOrigin}/oauth/mailru/callback`);
  assert.equal(field('mailru-redirect-uri').required, true);
  assert.equal(checkbox(), null);
  assert.ok(host.querySelector('a[href="https://oauth.mail.ru/app/"]'));
});
