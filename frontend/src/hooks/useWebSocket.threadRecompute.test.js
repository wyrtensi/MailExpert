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
  constructor() { socket = this; this.readyState = 1; }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeSocket;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { useWebSocket } = await import('./useWebSocket.js');

function App() { useWebSocket(); return null; }

test('a thread recompute event patches the mailbox state', async () => {
  const root = createRoot(document.getElementById('root'));
  useStore.getState().setAccounts([{ id: 'a', enabled: true }, { id: 'b', enabled: true }]);
  try {
    await React.act(async () => { root.render(React.createElement(App)); });
    const state = { status: 'running', percent: 40, changed: 12, error: null };
    await React.act(async () => {
      socket.onmessage({ data: JSON.stringify({ type: 'thread_recompute', accountId: 'a', state }) });
    });
    const accounts = useStore.getState().accounts;
    assert.deepEqual(accounts.find(a => a.id === 'a').thread_recompute, state);
    assert.equal(accounts.find(a => a.id === 'b').thread_recompute, undefined);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
