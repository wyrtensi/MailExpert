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
const ru = JSON.parse(readFileSync(new URL('../locales/ru.json', import.meta.url), 'utf8'));

// Moves are DB-first: the letters showed in their new folder at once and the server MOVE ran later.
// When it cannot be done, the server returns the rows to their folder and says so to every client.
test('a reverted move tells the reader where the letters went back and refreshes the view', async () => {
  const root = createRoot(document.getElementById('root'));
  let refreshes = 0;
  window.addEventListener('mailexpert:refresh', () => { refreshes += 1; });
  try {
    await React.act(async () => { root.render(React.createElement(App)); });
    const reverted = async (ids) => {
      useStore.setState({ notifications: [] });
      await React.act(async () => {
        socket.onmessage({ data: JSON.stringify({ type: 'move_reverted', accountId: 'a', folder: 'INBOX', reason: 'gone', ids }) });
      });
      return useStore.getState().notifications[0];
    };
    const one = await reverted(['m1']);
    assert.equal(one.title, en.message.moveReverted.title_one);
    assert.equal(one.body, 'It was returned to INBOX.');
    const three = await reverted(['m1', 'm2', 'm3']);
    assert.equal(three.title, 'Could not move 3 letters');
    assert.equal(three.body, 'They were returned to INBOX.');
    assert.equal(refreshes, 2);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});

test('the reverted-move notice is translated', () => {
  assert.equal(ru.message.moveReverted.title_one, 'Не удалось переместить {{count}} письмо');
  assert.equal(ru.message.moveReverted.body_one, 'Письмо возвращено в папку {{folder}}.');
  assert.equal(ru.common.movePending, 'Письмо ещё перемещается, попробуйте через несколько секунд');
  assert.equal(en.common.movePending, 'The letter is still being moved, try again in a few seconds');
});
