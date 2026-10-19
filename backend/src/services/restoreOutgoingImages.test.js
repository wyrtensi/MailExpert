import { describe, expect, it } from 'vitest';
import { parseDocument } from 'htmlparser2';
import { imageProxyPath, verifyImageProxyToken } from './imageProxy.js';
import { restoreOutgoingImages } from './restoreOutgoingImages.js';

const ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const RAW = 'https://img.example/a.png?x=1&amp;y=2';
const path = (raw = RAW, user = 'user-1', options) => imageProxyPath(ID, raw, user, options);
const restore = html => restoreOutgoingImages(html, 'user-1', { panelUrl: 'https://panel.example' });

describe('authenticated outgoing image restoration', () => {
  it('restores real image attributes and same-origin clipboard URLs with HTML escaping', () => {
    const proxy = path();
    const out = restore(`<img src="${proxy}" srcset="${proxy} 1x"><table background="https://panel.example${proxy}"></table>`);
    expect(out).toBe(`<img src="${RAW}" srcset="${RAW} 1x"><table background="${RAW}"></table>`);
  });

  it('restores expired authentic references without authorizing a fetch', () => {
    const proxy = path(RAW, 'user-1', { now: Date.UTC(2020, 0, 1), allowBlocked: true });
    const parsed = new URL(proxy, 'https://panel.example');
    expect(verifyImageProxyToken(parsed.pathname.split('/').pop(), { userId: 'user-1', messageId: ID, raw: RAW, allowBlocked: true })).toBe(false);
    expect(restore(`<img src="${proxy.replace(/&/g, '&amp;')}">`)).toBe(`<img src="${RAW}">`);
  });

  it('leaves invalid signatures, other users and tampered references untouched', () => {
    for (const proxy of [
      path(RAW, 'user-2'), path().replace(/\/image\/[^?]+/, '/image/123.sig'),
      path().replace(ID, '9b1c7f0e-2a44-4c1d-8e5f-0a1b2c3d4e5f'),
      path().replace('img.example', 'other.example'), `${path()}&allow=1`,
      `${path()}&u=another`, `${path()}#suffix`,
    ]) {
      const html = `<img src="${proxy}">`;
      expect(restore(html)).toBe(html);
    }
  });

  it('leaves anchors, plain text, other origins and unsigned injection attempts untouched', () => {
    const attack = '/api/mail/messages/' + ID + '/image/123.sig?u=%22%3E%3Cp%3EUNSEEN%20TEXT%3C%2Fp%3E';
    for (const html of [
      `<a href="https://sender.example${attack}">View invoice</a>`,
      `<a href="https://panel.example${path()}">View</a>`,
      `<p>${path()}</p>`, `<img src="https://sender.example${path()}">`,
      `<img src="https://panel.example${attack}">`, `<img src="${attack}">`,
      `<img title=" src='${path()}'" src="cid:x">`,
    ]) expect(restore(html)).toBe(html);
  });

  it('requires the configured panel origin for absolute references', () => {
    const html = `<img src="https://panel.example${path()}">`;
    expect(restoreOutgoingImages(html, 'user-1', { panelUrl: null })).toBe(html);
    expect(restoreOutgoingImages(`<img src="${path()}">`, 'user-1', { panelUrl: null })).toBe(`<img src="${RAW}">`);
  });

  it('keeps restored quotes and angle brackets inside one image attribute', () => {
    const raw = 'https://img.example/a&quot;&gt;&lt;p&gt;INJECTED&lt;/p&gt;';
    const out = restore(`<img src="${path(raw)}">`);
    const nodes = parseDocument(out).children;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('img');
    expect(nodes[0].attribs.src).toBe('https://img.example/a"><p>INJECTED</p>');
  });

  it('restores CSS url and image-set references without closing style blocks', () => {
    const proxy = path('https://img.example/a.png');
    const html = `<style>.a{background:url(${proxy})}.b{background:image-set("${proxy}" 1x)}</style><p style="background:url(${proxy})">x</p>`;
    const out = restore(html);
    expect(out).not.toContain('/api/mail/messages/');
    expect(out).toContain('url("https://img.example/a.png")');
    expect(out).toContain('url(&quot;https://img.example/a.png&quot;)');
    expect(out).toContain('image-set("https://img.example/a.png" 1x)');
    const hostile = path('https://img.example/a</style><p>INJECTED</p>');
    const sealed = restore(`<style>.a{background:url(${hostile})}</style>`);
    expect(sealed).not.toContain('<p>');
    expect((sealed.match(/<\/style>/g) || [])).toHaveLength(1);
  });
});
