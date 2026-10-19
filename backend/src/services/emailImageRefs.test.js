// The remote image references of sanitized email HTML: found, rewritten to the image proxy and
// restored exactly, and panel URLs an email wrote itself taken out.
import { describe, it, expect } from 'vitest';
import { proxyRemoteImages, remoteImageRefs, remoteUrlOf, stripPanelImageRefs, BLANK_IMAGE } from './emailImageRefs.js';
import { blockRemoteImages, sanitizeEmail } from './emailSanitizer.js';

// As the backend's imageProxyPath writes the reference: only letters, digits and - . _ ~ %.
const encode = (raw) => encodeURIComponent(raw).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const toProxy = (raw) => `/api/mail/messages/m1/image/1.sig?u=${encode(raw)}`;
const restore = (html) => html.replace(/\/api\/mail\/messages\/m1\/image\/1\.sig\?u=([A-Za-z0-9%._~-]*)/g, (_, u) => decodeURIComponent(u));

describe('remoteUrlOf', () => {
  it('reads protocol-relative and plain-http references as https, as the email frame loads them', () => {
    expect(remoteUrlOf(' //img.example/a.png')).toBe('https://img.example/a.png');
    expect(remoteUrlOf('http://img.example/a.png')).toBe('https://img.example/a.png');
    expect(remoteUrlOf('HTTPS://img.example/a.png')).toBe('HTTPS://img.example/a.png');
  });
});

describe('proxyRemoteImages', () => {
  const CASES = {
    img: '<img src="https://img.example/a.png?x=1&amp;y=2" width="10">',
    protocolRelative: '<img src=" //img.example/p.gif">',
    srcset: '<img src="data:image/png;base64,AAAA" srcset="https://img.example/a.png 1x, //img.example/b.png 2x">',
    srcsetComma: '<img srcset="https://img.example/a,b.png 1x,https://img.example/c.png 2x">',
    background: '<table background="https://img.example/bg.png"><tr><td>x</td></tr></table>',
    inlineQuoted: '<div style="background-image:url(&quot;https://img.example/h.png?a=1&amp;b=2&quot;);color:#222">x</div>',
    imageSet: '<div style="background-image:image-set(&quot;https://img.example/1.png&quot; 1x, url(https://img.example/2.png) 2x)">x</div>',
    styleBlock: '<style>.h{background:url( "https://img.example/st.png" )}.k{background:url(//img.example/k.png)}</style><div class="h">x</div>',
    untouched: '<img src="data:image/png;base64,AAAA"><img src="cid:part1"><div style="background:url(/local.png);font-family:&quot;A&lt;B&gt;&quot;">x</div>',
  };

  it.each(Object.entries(CASES))('%s: proxied, then restored exactly', (name, html) => {
    const proxied = proxyRemoteImages(html, toProxy);
    expect(proxied).not.toMatch(/(?:https?:)?\/\/img\.example/);
    expect(restore(proxied)).toBe(html);
    if (name === 'untouched') expect(proxied).toBe(html);
  });

  it('leaves nothing for blocking to block', () => {
    for (const html of Object.values(CASES)) {
      const proxied = proxyRemoteImages(html, toProxy);
      expect(blockRemoteImages(proxied)).toBe(proxied);
    }
  });

  it('reads srcset as the browser does: a URL runs to whitespace, trailing commas are not part of it', () => {
    const refs = remoteImageRefs('<img srcset="https://img.example/a,b.png 1x,https://img.example/c.png, https://img.example/d.png">');
    expect([...refs.keys()]).toEqual(['https://img.example/a,b.png', 'https://img.example/c.png', 'https://img.example/d.png']);
  });

  // Sanitized HTML writes every attribute in double quotes; a single-quoted one is not
  // sanitize-html output, and rewriting inside it could break out of the attribute.
  it('rewrites double-quoted attributes only', () => {
    const html = "<img src='https://img.example/a.png'>";
    expect(proxyRemoteImages(html, toProxy)).toBe(html);
  });

  it('does not take markup inside a style block for tags', () => {
    const html = '<style>.a{content:"<img src=\\"https://img.example/x.png\\">"}</style>';
    expect(proxyRemoteImages(html, toProxy)).toBe(html);
  });

  it('rewrites an unterminated style block as CSS, as the browser reads it', () => {
    const out = proxyRemoteImages('<p>x</p><style>.a{background:url(//img.example/u.png)}', toProxy);
    expect(out).not.toContain('//img.example');
  });

  it('leaves remote @imports alone: stylesheets, not images', () => {
    const html = '<style>@import url(https://fonts.example/a.css); p{}</style>';
    expect(proxyRemoteImages(html, toProxy)).toBe(html);
  });

  it('works on what sanitizeEmail writes', () => {
    const html = sanitizeEmail('<img src="http://img.example/a.png" srcset="http://img.example/b.png 2x"><td background="http://img.example/c.png" style="background:url(\'http://img.example/d.png\')">x</td>');
    const proxied = proxyRemoteImages(html, toProxy);
    expect(proxied).not.toMatch(/https?:\/\/img\.example/);
    expect(restore(proxied)).toBe(html);
  });

  it('stays fast on hostile input', () => {
    const hostile = [
      `<style>${'a{background:url(//x'.repeat(40000)}</style>`,
      `<style>${'a{b:image-set("//x" '.repeat(40000)}</style>`,
      '<img src="https://img.example/a.png"'.repeat(20000),
      `<img ${'a'.repeat(200000)}`,
      `<img srcset="${'https://x/a ('.repeat(30000)}">`,
      '<style'.repeat(40000),
    ];
    for (const html of hostile) {
      const started = performance.now();
      proxyRemoteImages(html, toProxy);
      remoteImageRefs(html);
      stripPanelImageRefs(html);
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});

describe('remoteImageRefs', () => {
  it('maps each reference as written to the URL it loads', () => {
    const refs = remoteImageRefs('<img src="https://img.example/a.png?x=1&amp;y=2"><img src="//img.example/b.png"><div style="background:url(&quot;https://img.example/c.png&quot;)">x</div><style>.s{background:url(https://img.example/d.png)}</style>');
    expect(Object.fromEntries(refs)).toEqual({
      'https://img.example/a.png?x=1&amp;y=2': 'https://img.example/a.png?x=1&y=2',
      '//img.example/b.png': 'https://img.example/b.png',
      'https://img.example/c.png': 'https://img.example/c.png',
      'https://img.example/d.png': 'https://img.example/d.png',
    });
  });

  it('has nothing for cid:, data: or relative images', () => {
    expect(remoteImageRefs('<img src="cid:a"><img src="data:image/png;base64,AAAA"><img src="/x.png">').size).toBe(0);
  });
});

// An email may write the panel's own image proxy URLs itself, relative or absolute, hoping the
// reader's browser loads them with the reader's session. They are never left in.
describe('stripPanelImageRefs', () => {
  it.each([
    '<img src="/api/mail/messages/4d479e4f-9b21-4013-9c07-3fbc35f275b1/image/1.x?u=https%3A%2F%2Ft.example%2Fp.gif">',
    '<img src="https://panel.example/api/mail/messages/4d479e4f-9b21-4013-9c07-3fbc35f275b1/image/1.x?u=a">',
    '<img src="/API/Mail/Messages/x/%69mage/1.x?u=a">',
    '<img src="\\api\\mail\\messages\\x\\image?u=a">',
    '<img srcset="/api/mail/messages/x/image?u=a 2x">',
    '<td background="/api/mail/messages/x/image?u=a">x</td>',
    '<div style="background:url(https://panel.example/api/mail/messages/x/image?u=a)">x</div>',
  ])('takes out %s', (html) => {
    const out = stripPanelImageRefs(html);
    expect(out).not.toMatch(/api.mail.messages/i);
  });

  it('puts an image that draws nothing in an img src', () => {
    expect(stripPanelImageRefs('<img src="/api/mail/messages/x/image?u=a" width="5">')).toBe(`<img src="${BLANK_IMAGE}" width="5">`);
  });

  it('leaves every other image alone', () => {
    const html = '<img src="https://img.example/api/a.png"><img src="/api/contacts/photo?email=a"><img src="cid:a">';
    expect(stripPanelImageRefs(html)).toBe(html);
  });
});
