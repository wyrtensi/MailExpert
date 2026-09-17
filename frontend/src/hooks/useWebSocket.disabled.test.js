import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.json')
      ? {
          format: 'module',
          source: `export default ${readFileSync(new URL(url), 'utf8')}`,
          shortCircuit: true,
        }
      : nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let socketConstructions = 0;
class FakeSocket {
  static CLOSED = 3;

  static CLOSING = 2;

  constructor() {
    socketConstructions += 1;
    this.readyState = 1;
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}
globalThis.WebSocket = FakeSocket;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useWebSocket } = await import('./useWebSocket.js');

function App() {
  useWebSocket(false);
  return null;
}

test('a disabled websocket hook never connects or revives', async () => {
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(App)));

    window.dispatchEvent(new dom.window.Event('online'));
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await React.act(async () => {});

    assert.equal(socketConstructions, 0);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
