// The image proxy's disk cache: kept per user, least recently used first out, a month at most,
// failures remembered briefly, one fetch for concurrent requests, and harmless when the disk is not.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageCache, imageCacheKey } from './imageCache.js';

const dir = () => mkdtempSync(join(tmpdir(), 'me-image-cache-'));
const png = (n) => ({ bytes: Buffer.alloc(n, 7), type: 'image/png' });
const key = (s) => imageCacheKey('user-1', `https://img.example/${s}`);

describe('imageCacheKey', () => {
  it('is per user, and gives nothing away', () => {
    const k = imageCacheKey('user-1', 'https://img.example/a.png');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(imageCacheKey('user-2', 'https://img.example/a.png')).not.toBe(k);
    expect(imageCacheKey('user-1', 'https://img.example/b.png')).not.toBe(k);
  });
});

describe('createImageCache', () => {
  it('touches the disk only once used', async () => {
    const d = join(dir(), 'later');
    const cache = createImageCache({ dir: d });
    expect(existsSync(d)).toBe(false);
    await cache.put(key('a'), png(10));
    expect(existsSync(d)).toBe(true);
  });

  it('keeps an image, and finds it again after a restart', async () => {
    const d = dir();
    const cache = createImageCache({ dir: d });
    await cache.put(key('a'), png(10));
    expect((await cache.get(key('a'))).bytes.length).toBe(10);
    const restarted = createImageCache({ dir: d });
    expect((await restarted.get(key('a')))?.type).toBe('image/png');
  });

  it('never reads or writes outside its directory, whatever the key', async () => {
    const d = dir();
    const cache = createImageCache({ dir: d });
    for (const bad of ['../x', '..\\x', '/etc/passwd', 'a'.repeat(64) + '/../x', '']) {
      await cache.put(bad, png(10));
      expect(await cache.get(bad)).toBeNull();
    }
    expect(readdirSync(d)).toEqual([]);
  });

  it('ignores files in its directory it did not write', async () => {
    const d = dir();
    writeFileSync(join(d, 'notes.txt'), 'x');
    writeFileSync(join(d, `${'b'.repeat(64)}.svg`), '<svg/>');
    const cache = createImageCache({ dir: d });
    expect(await cache.get('b'.repeat(64))).toBeNull();
    expect(cache.stats().entries).toBe(0);
  });

  it('lets the least recently used go past its size, counting a read as a use', async () => {
    // An image may take up to an eighth of the cache: eight fill it, a ninth makes room.
    const cache = createImageCache({ dir: dir(), maxBytes: 8000 });
    for (const name of 'abcdefgh') await cache.put(key(name), png(1000));
    await cache.get(key('a'));
    await cache.put(key('i'), png(1000));
    expect(await cache.get(key('a'))).not.toBeNull();
    expect(await cache.get(key('b'))).toBeNull();
    expect(cache.stats().bytes).toBeLessThanOrEqual(8000);
  });

  it('does not keep an image larger than an eighth of the cache', async () => {
    const cache = createImageCache({ dir: dir(), maxBytes: 8000 });
    await cache.put(key('big'), png(1001));
    expect(await cache.get(key('big'))).toBeNull();
  });

  it('fetches again after a month', async () => {
    let t = Date.now();
    const cache = createImageCache({ dir: dir(), now: () => t });
    await cache.put(key('a'), png(10));
    t += 31 * 24 * 60 * 60 * 1000;
    expect(await cache.get(key('a'))).toBeNull();
  });

  it('remembers a failure for ten minutes', () => {
    let t = Date.now();
    const cache = createImageCache({ dir: dir(), now: () => t });
    cache.fail(key('a'), 502);
    expect(cache.failure(key('a'))).toBe(502);
    t += 11 * 60 * 1000;
    expect(cache.failure(key('a'))).toBeNull();
  });

  it('fetches once for requests that arrive together, and stores the result', async () => {
    const cache = createImageCache({ dir: dir() });
    let calls = 0;
    const produce = async () => { calls += 1; await new Promise(r => setTimeout(r, 20)); return png(5); };
    const [a, b] = await Promise.all([cache.load(key('x'), produce), cache.load(key('x'), produce)]);
    expect(calls).toBe(1);
    expect(a.bytes.length).toBe(5);
    expect(b.bytes.length).toBe(5);
    // Stored without holding up the answer: wait for the write.
    for (let i = 0; i < 200 && cache.stats().entries === 0; i += 1) await new Promise(r => setTimeout(r, 10));
    expect((await cache.load(key('x'), produce)).hit).toBe(true);
    expect(calls).toBe(1);
  });

  it('finishes storing before load resolves, so clearing cannot resurrect images', async () => {
    const cache = createImageCache({ dir: dir() });
    await cache.load(key('finished'), async () => png(10));
    expect(cache.stats().entries).toBe(1);
    await cache.clear();
    expect(await cache.get(key('finished'))).toBeNull();
  });

  it('carries on without the disk when it cannot write there', async () => {
    const d = dir();
    writeFileSync(join(d, 'blocker'), '');
    const cache = createImageCache({ dir: join(d, 'blocker', 'sub') }); // under a file: cannot be made
    await cache.put(key('a'), png(10));
    expect(await cache.get(key('a'))).toBeNull();
    expect(cache.stats().disabled).toBe(true);
    let calls = 0;
    expect((await cache.load(key('a'), async () => { calls += 1; return png(3); })).bytes.length).toBe(3);
    expect(calls).toBe(1);
  });

  it('leaves no half-written files behind', async () => {
    const d = dir();
    const cache = createImageCache({ dir: d });
    await cache.put(key('a'), png(10));
    expect(readdirSync(d).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });
});
