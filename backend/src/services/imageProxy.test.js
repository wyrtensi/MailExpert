// The image proxy: its signed URLs, what it accepts as an image, and how it fetches.
import { describe, it, expect } from 'vitest';
import {
  imageProxyPath, parseImageProxyToken, verifyImageProxyToken, sniffImageType, fetchProxiedImage,
  createUserLimiter, IMAGE_PROXY_TOKEN_TTL_MS, IMAGE_PROXY_MAX_REDIRECTS,
} from './imageProxy.js';

const ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const response = (body, { status = 200, type = 'image/png', length, location } = {}) => ({
  status,
  headers: new Headers({
    ...(type ? { 'content-type': type } : {}),
    ...(length !== undefined ? { 'content-length': String(length) } : {}),
    ...(location ? { location } : {}),
  }),
  body: new Blob([body]).stream(),
});

describe('imageProxyPath', () => {
  const NOW = Date.UTC(2026, 9, 19, 10, 17);

  it('carries the reference as written, encoded to letters, digits and - . _ ~ % only', () => {
    const raw = "https://img.example/a'b(c)*!.png?x=1&amp;y=\"2\" ";
    const path = imageProxyPath(ID, raw, 'user-1', { now: NOW });
    expect(path).toMatch(new RegExp(`^/api/mail/messages/${ID}/image/\\d+\\.[A-Za-z0-9_-]+\\?u=[A-Za-z0-9%._~-]+$`));
    expect(decodeURIComponent(path.split('?u=')[1])).toBe(raw);
  });

  it('is signed for one user, one message and one reference, until it expires', () => {
    const path = imageProxyPath(ID, 'https://img.example/a.png', 'user-1', { now: NOW });
    const token = /\/image\/([^?]+)\?/.exec(path)[1];
    const ok = (over = {}) => verifyImageProxyToken(token, { userId: 'user-1', messageId: ID, raw: 'https://img.example/a.png', now: NOW, ...over });
    expect(ok()).toBe(true);
    expect(ok({ userId: 'user-2' })).toBe(false);
    expect(ok({ messageId: '9b1c7f0e-2a44-4c1d-8e5f-0a1b2c3d4e5f' })).toBe(false);
    expect(ok({ raw: 'https://img.example/b.png' })).toBe(false);
    expect(ok({ now: NOW + IMAGE_PROXY_TOKEN_TTL_MS + 3_600_000 })).toBe(false);
  });

  it('keeps the same URL within the hour, so the browser can keep the image', () => {
    const a = imageProxyPath(ID, 'https://img.example/a.png', 'user-1', { now: NOW });
    const b = imageProxyPath(ID, 'https://img.example/a.png', 'user-1', { now: NOW + 60_000 });
    expect(a).toBe(b);
  });

  it('refuses forged, malformed and far-future tokens', () => {
    const check = (token) => verifyImageProxyToken(token, { userId: 'user-1', messageId: ID, raw: 'x', now: NOW });
    for (const token of ['', 'x', '1.', '.abc', `${NOW + 10 * IMAGE_PROXY_TOKEN_TTL_MS}.AAAA`, `${NOW + 3_600_000}.${'A'.repeat(43)}`, '1e99.AAAA', null, undefined]) {
      expect(check(token)).toBe(false);
    }
    expect(parseImageProxyToken('12.ab_-')).toEqual({ exp: 12, sig: 'ab_-' });
    expect(parseImageProxyToken('12.a b')).toBeNull();
  });
});

describe('sniffImageType', () => {
  it('knows raster images by their first bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('\0\0\0\x1cftypavif'))).toBe('image/avif');
  });
  it('refuses SVG, HTML and anything else, whatever the server called it', () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('fetchProxiedImage', () => {
  it('returns the image under its detected type, asking with no cookies, referrer or credentials', async () => {
    let asked;
    const out = await fetchProxiedImage('https://img.example/a.png', {
      fetchImpl: async (url, options) => { asked = { url, options }; return response(PNG, { type: 'application/octet-stream' }); },
    });
    expect(out.type).toBe('image/png');
    expect(Buffer.compare(out.bytes, PNG)).toBe(0);
    expect(asked.url).toBe('https://img.example/a.png');
    expect(asked.options.redirect).toBe('manual');
    expect(Object.keys(asked.options.headers).map(h => h.toLowerCase()).sort()).toEqual(['accept', 'user-agent']);
    expect(asked.options.headers['User-Agent']).not.toMatch(/mailexpert/i);
  });

  it('serves the sniffed type when the server names another raster type', async () => {
    const out = await fetchProxiedImage('https://img.example/a.jpg', { fetchImpl: async () => response(PNG, { type: 'image/jpeg' }) });
    expect(out.type).toBe('image/png');
  });

  it('follows a few redirects, each through the guarded fetch, resolving relative locations', async () => {
    const asked = [];
    const hops = [response('', { status: 302, location: '/b.png' }), response('', { status: 301, location: 'https://cdn.example/c.png' }), response(PNG)];
    const out = await fetchProxiedImage('https://img.example/a.png', {
      fetchImpl: async (url, options) => { asked.push([url, options.redirect]); return hops.shift(); },
    });
    expect(out.type).toBe('image/png');
    expect(asked).toEqual([['https://img.example/a.png', 'manual'], ['https://img.example/b.png', 'manual'], ['https://cdn.example/c.png', 'manual']]);
  });

  it('gives up after too many redirects, or on a redirect anywhere but http(s)', async () => {
    let calls = 0;
    await expect(fetchProxiedImage('https://img.example/a.png', {
      fetchImpl: async () => { calls += 1; return response('', { status: 302, location: `/r${calls}` }); },
    })).rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(IMAGE_PROXY_MAX_REDIRECTS + 1);
    for (const location of ['file:///etc/passwd', 'javascript:alert(1)', 'gopher://x/']) {
      await expect(fetchProxiedImage('https://img.example/a.png', {
        fetchImpl: async () => response('', { status: 302, location }),
      })).rejects.toMatchObject({ status: 502 });
    }
    await expect(fetchProxiedImage('https://img.example/a.png', {
      fetchImpl: async () => response('', { status: 302 }),
    })).rejects.toMatchObject({ status: 502 });
  });

  it('fetches http(s) only', async () => {
    let called = false;
    await expect(fetchProxiedImage('file:///etc/passwd', { fetchImpl: async () => { called = true; return response(PNG); } }))
      .rejects.toMatchObject({ status: 502 });
    expect(called).toBe(false);
  });

  const failsWith = async (status, upstream) => {
    await expect(fetchProxiedImage('https://img.example/x', { fetchImpl: async () => upstream })).rejects.toMatchObject({ status });
  };
  it('answers 404 for an image that is gone, 502 for other upstream failures', async () => {
    await failsWith(404, response(PNG, { status: 404 }));
    await failsWith(404, response(PNG, { status: 410 }));
    await failsWith(502, response(PNG, { status: 500 }));
    await expect(fetchProxiedImage('https://img.example/x', { fetchImpl: async () => { throw Object.assign(new Error('blocked'), { code: 'ERR_BLOCKED_PRIVATE_IP' }); } }))
      .rejects.toMatchObject({ status: 502 });
  });
  it('refuses SVG, HTML and other declared types, and bytes that are not a raster image', async () => {
    await failsWith(415, response(PNG, { type: 'image/svg+xml' }));
    await failsWith(415, response(PNG, { type: 'text/html' }));
    await failsWith(415, response(PNG, { type: 'application/xml' }));
    await failsWith(415, response('<svg xmlns="http://www.w3.org/2000/svg"/>', { type: 'image/png' }));
    await failsWith(415, response('<html>not an image</html>', { type: null }));
  });
  it('refuses images over the size limit, declared or not', async () => {
    await expect(fetchProxiedImage('https://img.example/x', { maxBytes: 10, fetchImpl: async () => response(PNG, { length: 1000 }) }))
      .rejects.toMatchObject({ status: 413 });
    await expect(fetchProxiedImage('https://img.example/x', { maxBytes: 10, fetchImpl: async () => response(PNG) }))
      .rejects.toMatchObject({ status: 413 });
  });
  it('gives up on a server that does not answer in time', async () => {
    const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    await expect(fetchProxiedImage('https://img.example/x', { fetchImpl: hang, headersTimeoutMs: 20 })).rejects.toMatchObject({ status: 502 });
  });
});

describe('createUserLimiter', () => {
  it('runs at most `limit` tasks at once per user, the rest in turn, and other users alongside', async () => {
    const run = createUserLimiter(2);
    let active = 0;
    let peak = 0;
    const releases = [];
    const task = () => new Promise((resolve) => {
      active += 1; peak = Math.max(peak, active);
      releases.push(() => { active -= 1; resolve(); });
    });
    const userA = [run('a', task), run('a', task), run('a', task), run('a', task)];
    await new Promise(r => setTimeout(r, 0));
    expect(active).toBe(2);
    const userB = run('b', task);
    await new Promise(r => setTimeout(r, 0));
    expect(active).toBe(3);
    while (releases.length) { releases.shift()(); await new Promise(r => setTimeout(r, 0)); }
    await Promise.all([...userA, userB]);
    expect(peak).toBe(3);
  });

  it('frees the slot when a task fails', async () => {
    const run = createUserLimiter(1);
    await expect(run('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(run('a', async () => 'ok')).resolves.toBe('ok');
  });
});
