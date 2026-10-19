// Email HTML placed in MailExpert's own page (the composer's quote, the div renderer) keeps images
// only from MailExpert itself once the body was served with remote images blocked. The CSS escape
// cases depend on the browser's CSS parser; jsdom covers the URL handling and what must be kept.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify binds to the window it finds when it is first imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mail.example.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { sanitizeEmailForApp, sanitizeQuoteHtml } = await import('./appEmailHtml.js');
const DOMPurify = (await import('dompurify')).default;

const parse = html => new dom.window.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;

describe('sanitizeEmailForApp', () => {
  it("drops a sender's image, written plainly or with a line break in its scheme", () => {
    const out = parse(sanitizeEmailForApp('<img id="a" src="https://evil.example/a.gif"><img id="b" src="ht\ntps://evil.example/b.gif"><table><tr><td id="c" background="https://evil.example/c.gif">x</td></tr></table>'));
    assert.equal(out.querySelector('#a').hasAttribute('src'), false);
    assert.equal(out.querySelector('#b').hasAttribute('src'), false);
    assert.equal(out.querySelector('#c').hasAttribute('background'), false);
  });

  it('drops a protocol-relative image, which resolves against the page to https', () => {
    const out = parse(sanitizeEmailForApp('<img id="r" src="//evil.example/r.gif">'));
    assert.equal(out.querySelector('#r').hasAttribute('src'), false);
  });

  it('drops a srcset with any remote candidate, and an SVG image from the sender', () => {
    const out = parse(sanitizeEmailForApp('<img id="s" srcset="data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, https://evil.example/s.png 2x"><svg><image id="v" href="https://evil.example/v.png"></image></svg>'));
    assert.equal(out.querySelector('#s').hasAttribute('srcset'), false);
    assert.equal(out.querySelector('#v')?.hasAttribute('href') ?? false, false);
  });

  it("keeps the panel's own images, data:, blob: and cid: images, and ordinary styling", () => {
    const out = parse(sanitizeEmailForApp('<img id="p" src="/api/contacts/photo?email=a"><img id="d" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><img id="c" src="cid:logo@x"><p id="t" style="color: red; font-weight: bold">Hi</p>'));
    assert.equal(out.querySelector('#p').getAttribute('src'), '/api/contacts/photo?email=a');
    assert.ok(out.querySelector('#d').getAttribute('src').startsWith('data:'));
    assert.equal(out.querySelector('#c').getAttribute('src'), 'cid:logo@x');
    assert.equal(out.querySelector('#t').style.color, 'red');
    assert.equal(out.querySelector('#t').style.fontWeight, 'bold');
  });

  it('drops a style declaration that loads from the sender and keeps the rest', () => {
    const out = parse(sanitizeEmailForApp('<div id="x" style="color: red; background-image: url(https://evil.example/bg.gif)">x</div>'));
    assert.equal(out.querySelector('#x').style.backgroundImage, '');
    assert.equal(out.querySelector('#x').style.color, 'red');
  });

  // The parsed longhands do not show a URL behind var() or CSS escapes: var(--u, \75 rl(...)) keeps
  // its raw text, and a shorthand with var() leaves every longhand empty while the browser still
  // resolves it. Such a style is dropped whole; this runs only for a body served blocked.
  for (const [label, css] of [
    ['an escaped url( in a var() fallback', 'background-image: var(--u, \\75 rl(https://evil.example/x))'],
    ['a shorthand with var()', 'background: var(--u, url(https://evil.example/x))'],
    ['an escaped url( alone', 'background-image: \\75 rl(https://evil.example/x)'],
    ['an escaped scheme', 'background-image: url(\\68ttps://evil.example/x)'],
    ['a custom property used later', '--u: url(https://evil.example/x); background-image: var(--u)'],
  ]) {
    it(`drops a style that hides a URL behind ${label}`, () => {
      const out = parse(sanitizeEmailForApp(`<div id="x" style="color: red; ${css.replace(/"/g, '&quot;')}">x</div>`));
      assert.equal(out.querySelector('#x').hasAttribute('style'), false);
    });
  }

  it('leaves other sanitizes alone', () => {
    sanitizeEmailForApp('<p>x</p>');
    assert.match(DOMPurify.sanitize('<img src="https://example.com/a.png">'), /https:\/\/example\.com\/a\.png/);
  });
});

// Remote images are shown by default, so a quote keeps them unless the quoted body was served blocked.
describe('sanitizeQuoteHtml', () => {
  const quote = '<style>div{margin:0 !important}</style><p>Hi</p><img id="i" src="https://img.example/a.png">';

  it("keeps the sender's images when the quoted body was shown with them", () => {
    const out = parse(sanitizeQuoteHtml(quote, { imagesBlocked: false }));
    assert.equal(out.querySelector('#i').getAttribute('src'), 'https://img.example/a.png');
    assert.equal(out.querySelector('style'), null, 'style blocks never leak into the app UI');
  });

  it('drops them when the quoted body was served with remote images blocked', () => {
    const out = parse(sanitizeQuoteHtml(quote, { imagesBlocked: true }));
    assert.equal(out.querySelector('#i').hasAttribute('src'), false);
    assert.equal(out.querySelector('style'), null);
    assert.equal(out.querySelector('p').textContent, 'Hi');
  });
});
