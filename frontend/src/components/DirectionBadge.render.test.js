// Render test for DirectionBadge — the shared "Received"/"Sent"/"Draft" pill used across message
// lists, sender history and contact letters. Covers what a plain unit test of the component
// can't: what actually renders for each kind, that compact mode drops the visible text but keeps
// it reachable via aria-label/title, and that an unrecognised direction renders nothing rather
// than guessing (a caller bug should be visibly blank, not silently mislabeled).
//
// The harness mirrors MessageList.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed with a translation table so
// the rendered text can be asserted on directly instead of just the key.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

const LABELS = {
  'message.direction.received': 'Received',
  'message.direction.sent': 'Sent',
  'message.direction.draft': 'Draft',
};

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return {
        format: 'module', shortCircuit: true, source: [
          `const LABELS = ${JSON.stringify(LABELS)};`,
          'export const useTranslation = () => ({ t: (k) => LABELS[k] ?? k, i18n: { language: "en", changeLanguage: () => {} } });',
          'export const initReactI18next = { type: "3rdParty", init: () => {} };',
          'export const Trans = ({ children }) => children ?? null;',
          'export const I18nextProvider = ({ children }) => children ?? null;',
          'export default { useTranslation, initReactI18next };',
        ].join('\n'),
      };
    }
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: out.code };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const DirectionBadge = (await import('./DirectionBadge.jsx')).default;

async function mount(props) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  await React.act(async () => {
    createRoot(host).render(React.createElement(DirectionBadge, props));
  });
  return host;
}

describe('DirectionBadge', () => {
  test('renders the full "Received" text for direction=in', async () => {
    const host = await mount({ direction: 'in' });
    assert.match(host.textContent, /Received/);
    const span = host.querySelector('[role="img"]');
    assert.equal(span.getAttribute('aria-label'), 'Received');
    assert.equal(span.getAttribute('title'), 'Received');
  });

  test('renders the full "Sent" text for direction=out', async () => {
    const host = await mount({ direction: 'out' });
    assert.match(host.textContent, /Sent/);
  });

  test('renders "Draft" for direction=draft, distinct from received/sent', async () => {
    const host = await mount({ direction: 'draft' });
    assert.match(host.textContent, /Draft/);
    assert.doesNotMatch(host.textContent, /Received|Sent/);
  });

  test('compact mode drops the visible text but keeps aria-label and title', async () => {
    const host = await mount({ direction: 'out', compact: true });
    assert.doesNotMatch(host.textContent, /Sent/);
    const span = host.querySelector('[role="img"]');
    assert.equal(span.getAttribute('aria-label'), 'Sent');
    assert.equal(span.getAttribute('title'), 'Sent');
  });

  test('an unrecognised direction renders nothing, not a guess', async () => {
    const host = await mount({ direction: undefined });
    assert.equal(host.textContent.trim(), '');
    assert.equal(host.querySelector('[role="img"]'), null);

    const host2 = await mount({ direction: 'sideways' });
    assert.equal(host2.textContent.trim(), '');
  });

  test('received and sent use visibly different colors', async () => {
    const inHost = await mount({ direction: 'in' });
    const outHost = await mount({ direction: 'out' });
    const inColor = inHost.querySelector('[role="img"]').style.color;
    const outColor = outHost.querySelector('[role="img"]').style.color;
    assert.notEqual(inColor, outColor);
  });
});
