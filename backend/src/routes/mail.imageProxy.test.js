// The image proxy end to end: the body route serves allowed images as signed proxy URLs and drops
// trackers; GET /messages/:id/image/:token fetches only what it signed, and serves it safely.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: req.get('x-test-user') || 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    fetchMessageBody: vi.fn(),
    noteUserActivity: vi.fn(),
    moveQueue: { serverLocation: async (m) => ({ folder: m.folder, uid: Number(m.uid) }) },
  },
}));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false, resetMs: 0 })) }));
// A real image cache, in a directory of its own, emptied before each test.
vi.mock('../services/imageCache.js', async (importOriginal) => {
  const real = await importOriginal();
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return { ...real, imageCache: real.createImageCache({ dir: mkdtempSync(join(tmpdir(), 'me-img-route-')) }) };
});

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { safeFetch } from '../services/safeFetch.js';
import { consume } from '../services/rateLimiter.js';
import { imageProxyPath } from '../services/imageProxy.js';
import { imageCache } from '../services/imageCache.js';
import { rewriteEbayImageserUrls } from '../services/emailSanitizer.js';

const MESSAGE_ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const OTHER_ID = '9b1c7f0e-2a44-4c1d-8e5f-0a1b2c3d4e5f';
const PHOTO = '<p>Hi</p><img src="//img.example/photo.jpg" width="600" height="300"><img src="//tracker.example/p.gif" width="1" height="1">';
const OWN_PROXY = `<img src="/api/mail/messages/${MESSAGE_ID}/image/99999999999.AAAA?u=https%3A%2F%2Ft.example%2Fx.gif">`;
const row = (body_html, preferences = {}) => ({
  id: MESSAGE_ID, account_id: 'acc-1', uid: 42, folder: 'INBOX', body_html,
  body_text: body_html ? 'Hi' : null, attachments: '[]', snippet: 'Hi', preferences,
  from_email: 's@sender.example', sender_email: null, sender_name: null, eop_category: null,
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const upstream = (body, type = 'image/png', status = 200) => ({ status, headers: new Headers({ 'content-type': type }), body: new Blob([body]).stream() });

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use('/api/mail', mailRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(async () => {
  await imageCache.clear();
  query.mockReset();
  imapManager.fetchMessageBody.mockReset();
  safeFetch.mockReset();
  consume.mockClear();
});

describe('GET /messages/:id/body and the image proxy', () => {
  const get = async (suffix = '') => (await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body${suffix}`)).json();
  const answer = (first) => query.mockResolvedValueOnce({ rows: [first] }).mockResolvedValue({ rows: [{ id: 'acc-1' }] });

  it('serves allowed images as proxy URLs signed for the reader, and never a tracker', async () => {
    answer(row(PHOTO));
    const body = await get();
    expect(body.remoteImagesBlocked).toBe(false);
    expect(body.remoteImagesProxied).toBe(true);
    expect(body.trackersBlocked).toBe(1);
    expect(body.html).not.toMatch(/(?:src|srcset)="(?:https?:)?\/\//);
    expect(body.html).toContain(`src="${imageProxyPath(MESSAGE_ID, '//img.example/photo.jpg', 'user-1')}"`);
    expect(body.html).not.toContain('tracker.example');
  });

  it('proxies when images were asked for, or the sender is allowed', async () => {
    answer(row(PHOTO, { blockRemoteImages: true }));
    expect((await get('?remoteImages=1')).remoteImagesProxied).toBe(true);
    answer(row(PHOTO, { blockRemoteImages: true, imageWhitelist: { domains: ['sender.example'] } }));
    expect((await get()).remoteImagesProxied).toBe(true);
  });

  it('proxies a body fetched from the server too, and never a blocked one', async () => {
    answer(row(null));
    imapManager.fetchMessageBody.mockResolvedValue({ html: PHOTO, text: 'Hi', attachments: [] });
    const fetched = await get();
    expect(fetched.remoteImagesProxied).toBe(true);
    expect(fetched.trackersBlocked).toBe(1);
    expect(fetched.html).toContain(`/api/mail/messages/${MESSAGE_ID}/image/`);
    answer(row(PHOTO, { blockRemoteImages: true }));
    const blocked = await get();
    expect(blocked.remoteImagesProxied).toBe(false);
    expect(blocked.trackersBlocked).toBe(0);
    expect(blocked.html).not.toContain('/image/');
  });

  it('takes out proxy URLs the email wrote itself, blocked or not', async () => {
    answer(row(OWN_PROXY));
    expect((await get()).html).not.toContain('/api/mail/');
    answer(row(OWN_PROXY, { blockRemoteImages: true }));
    expect((await get()).html).not.toContain('/api/mail/');
  });
});

describe('GET /messages/:id/image/:token, the image proxy', () => {
  const BODY = '<p>Hi</p><img src="https://img.example/a.png?x=1&amp;y=2"><img src="//img.example/b.gif"><img src="https://img.example/p.gif" width="1" height="1">';
  const image = (raw, { id = MESSAGE_ID, user = 'user-1', signedFor = user, headers = {} } = {}) => {
    const path = imageProxyPath(id, raw, signedFor);
    return fetch(`${base}${path}`, { headers: { 'x-test-user': user, ...headers } });
  };

  it('fetches an image the message holds, as it loads it, and serves it safely', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream(PNG, 'application/octet-stream'));
    const res = await image('https://img.example/a.png?x=1&amp;y=2');
    expect(res.status).toBe(200);
    expect(safeFetch.mock.calls[0][0]).toBe('https://img.example/a.png?x=1&y=2');
    expect(safeFetch.mock.calls[0][2]).toBeUndefined(); // the default policy: no private hosts, https only
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('private, max-age=2592000, immutable');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), PNG)).toBe(0);
    expect(query.mock.calls[0][1]).toEqual([MESSAGE_ID]);
  });

  it('passes nothing of the sender\'s answer on but the image', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue({ status: 200, headers: new Headers({ 'content-type': 'image/png', 'set-cookie': 'a=b', 'x-upstream': '1', 'access-control-allow-origin': '*' }), body: new Blob([PNG]).stream() });
    const res = await image('//img.example/b.gif');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-upstream')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('loads a protocol-relative image over https', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream(Buffer.from('GIF89a\x01\x00\x01\x00')));
    expect((await image('//img.example/b.gif')).status).toBe(200);
    expect(safeFetch.mock.calls[0][0]).toBe('https://img.example/b.gif');
  });

  it('fetches nothing for a URL it did not sign for this reader', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    expect((await image('//img.example/b.gif', { signedFor: 'user-2' })).status).toBe(403);
    const forged = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/image/99999999999.AAAA?u=${encodeURIComponent('//img.example/b.gif')}`);
    expect(forged.status).toBe(403);
    const signed = imageProxyPath(MESSAGE_ID, '//img.example/b.gif', 'user-1');
    expect((await fetch(`${base}${signed.replace(MESSAGE_ID, OTHER_ID)}`)).status).toBe(403);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('is not an open proxy: a signed reference the message does not hold is refused unfetched', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    expect((await image('https://attacker.example/x.png')).status).toBe(404);
    expect((await image('http://169.254.169.254/latest/meta-data')).status).toBe(404);
    query.mockResolvedValue({ rows: [] });
    expect((await image('https://img.example/a.png?x=1&amp;y=2', { id: OTHER_ID })).status).toBe(404);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('never fetches a tracking pixel the message holds', async () => {
    query.mockResolvedValue({ rows: [{ body_html: `${BODY}<img src="https://u1.ct.sendgrid.net/wf/open?upn=abc">` }] });
    expect((await image('https://img.example/p.gif')).status).toBe(404);
    expect((await image('https://u1.ct.sendgrid.net/wf/open?upn=abc')).status).toBe(404);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('refuses a bad message id or a missing reference', async () => {
    expect((await fetch(`${base}/api/mail/messages/not-a-uuid/image/1.a?u=x`)).status).toBe(400);
    expect((await fetch(`${base}${imageProxyPath(MESSAGE_ID, 'x', 'user-1').split('?')[0]}`)).status).toBe(400);
  });

  it('refuses SVG and non-images from the sender', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'));
    expect((await image('//img.example/b.gif')).status).toBe(415);
    safeFetch.mockResolvedValue(upstream('<script>alert(1)</script>', 'image/png'));
    expect((await image('https://img.example/a.png?x=1&amp;y=2')).status).toBe(415);
  });

  it('limits how fast one user may fetch', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    consume.mockResolvedValueOnce({ limited: true, resetMs: 30_000 });
    const res = await image('//img.example/b.gif');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(consume.mock.calls[0][0]).toBe('image-proxy:user-1');
    expect(safeFetch).not.toHaveBeenCalled();
  });

  // Served once, kept: a second view, on this device or another, does not ask the sender again.
  it('serves an image again from its cache, and a browser that has it gets a 304', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream(PNG));
    const first = await image('//img.example/b.gif');
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    for (let i = 0; i < 200 && imageCache.stats().entries === 0; i += 1) await new Promise(r => setTimeout(r, 10));
    const again = await image('//img.example/b.gif');
    expect(again.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await again.arrayBuffer()), PNG)).toBe(0);
    expect((await image('//img.example/b.gif', { headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1); // the rate limit counts fetches from the sender only
  });

  it('keeps each user\'s images apart', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockImplementation(async () => upstream(PNG));
    expect((await image('//img.example/b.gif')).status).toBe(200);
    for (let i = 0; i < 200 && imageCache.stats().entries === 0; i += 1) await new Promise(r => setTimeout(r, 10));
    const other = await image('//img.example/b.gif', { user: 'user-2' });
    expect(other.status).toBe(200);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it('remembers a failure for a while instead of asking the sender again on every open', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream('gone', 'text/html', 404));
    expect((await image('//img.example/b.gif')).status).toBe(404);
    const again = await image('//img.example/b.gif');
    expect(again.status).toBe(404);
    expect(again.headers.get('cache-control')).toBe('private, max-age=600');
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  // The body route writes its served version back without waiting; an image asked for first
  // must still be found.
  it('finds a reference in the body as the route serves it, before that is stored', async () => {
    const EBAY = '<img src="https://svcs.ebay.com/imageser/1/render?imageUrl=https://i.ebayimg.example/a.jpg&amp;w=200">';
    query.mockResolvedValue({ rows: [{ body_html: EBAY }] });
    safeFetch.mockResolvedValue(upstream(PNG));
    const served = /src="([^"]*)"/.exec(rewriteEbayImageserUrls(EBAY))[1];
    expect(served).not.toBe(/src="([^"]*)"/.exec(EBAY)[1]);
    expect((await image(served)).status).toBe(200);
  });
});
