import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json')
    ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true }
    : nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});

let socket;
class FakeSocket {
  static CLOSED = 3;
  static OPEN = 1;
  constructor() { socket = this; this.readyState = 1; }
  close() { this.readyState = 3; }
  send() {}
}
globalThis.WebSocket = FakeSocket;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { useWebSocket } = await import('./useWebSocket.js');

function App() { useWebSocket(); return null; }

const mailbox = (aliases) => ({ id: 'acc-1', email_address: 'sales@example.com', aliases });
const flush = () => new Promise((resolve) => { globalThis.setImmediate(resolve); });

// The hourly Gmail send-as sync runs with no browser behind it: every open tab gets aliases_changed
// and reads the mailbox list again, so a reply picks the alias the letter was addressed to instead
// of the mailbox's main address. A tab whose socket was down re-reads it on reconnect.
test('aliases_changed and a reconnect re-read the mailbox list', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const root = createRoot(document.getElementById('root'));
  const originals = { getAccounts: api.getAccounts, getUnreadCounts: api.getUnreadCounts };
  let reads = 0;
  let served = [mailbox([{ id: 'al-1', email: 'info@example.com', source: 'gmail' }])];
  api.getAccounts = async () => { reads += 1; return served; };
  api.getUnreadCounts = async () => ({ byAccount: {}, snapshots: {} });
  try {
    useStore.setState({ user: { id: 'u1', isAdmin: false }, accounts: [mailbox([])] });
    await React.act(async () => { root.render(React.createElement(App)); });
    await React.act(async () => { socket.onopen(); });
    assert.equal(reads, 0);

    await React.act(async () => {
      socket.onmessage({ data: JSON.stringify({ type: 'aliases_changed', accountId: 'acc-1' }) });
      await flush();
    });
    assert.equal(reads, 1);
    assert.deepEqual(useStore.getState().accounts[0].aliases.map((a) => a.email), ['info@example.com']);

    served = [mailbox([])];
    await React.act(async () => { socket.onopen(); await flush(); });
    assert.equal(reads, 2);
    assert.deepEqual(useStore.getState().accounts[0].aliases, []);
  } finally {
    Object.assign(api, originals);
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
