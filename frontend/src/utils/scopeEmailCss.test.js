import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scopeEmailCss } from './scopeEmailCss.js';

// The div renderer places an email's style blocks in the app's page, whose CSP allows any https:
// image. For a body served with remote images blocked, nothing that can load an image survives.
describe('scopeEmailCss with remote images blocked', () => {
  const css = [
    'p { color: red; background-image: url(https://evil.example/a.png) }',
    'td { background: image-set("https://evil.example/b.png" 1x) }',
    'div { background: var(--u, \\75 rl(https://evil.example/c.png)); margin: 0 }',
    'span { --u: url(//evil.example/d.png) }',
  ].join('\n');

  it('drops every declaration that can load an image and keeps the rest', () => {
    const out = scopeEmailCss(css, 'email-1', { remoteImagesBlocked: true });
    assert.doesNotMatch(out, /evil\.example/);
    assert.match(out, /\.email-1 p \{ color: red/);
    assert.match(out, /margin: 0/);
  });

  it('drops an at-rule with an escaped name, which the browser reads as @import', () => {
    assert.doesNotMatch(scopeEmailCss('@\\69mport "https://evil.example/x.css"; p { color: red }', 'email-1'), /evil\.example/);
  });

  it('leaves the CSS to the email when images are allowed', () => {
    assert.match(scopeEmailCss(css, 'email-1'), /evil\.example\/a\.png/);
  });
});
