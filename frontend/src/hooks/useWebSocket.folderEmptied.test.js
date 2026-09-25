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
const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));

// Emptying a folder runs in the background after a 202, so a busy mailbox or a rejected password
// reaches the client only as the folder_emptied event's code.
test('a failed empty-folder event says why when the mailbox was busy or its password rejected', async () => {
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => { root.render(React.createElement(App)); });
    const emptied = async (data) => {
      useStore.setState({ notifications: [] });
      await React.act(async () => {
        socket.onmessage({ data: JSON.stringify({ type: 'folder_emptied', accountId: 'a', folder: 'Trash', ...data }) });
      });
      return useStore.getState().notifications[0];
    };
    assert.equal((await emptied({ ok: false, code: 'mailbox_auth_rejected' })).body, en.common.mailboxAuthRejected);
    assert.equal((await emptied({ ok: false, code: 'mailbox_busy' })).body, en.common.mailboxBusy);
    const other = await emptied({ ok: false });
    assert.equal(other.title, en.sidebar.emptyFailed);
    assert.equal(other.body, undefined);
    assert.equal((await emptied({ ok: true })).title, en.sidebar.emptied);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
