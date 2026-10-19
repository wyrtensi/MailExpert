// The image proxy's cache (services/imageProxy.js): each image as it was served, kept on disk.
// Without it every view on another device, and every view once the browser's own copy had gone,
// fetched the image from the sender's server again, and the sender learned of each view.
//
// Kept per user: an image URL often carries a token for one recipient, and a cache shared between
// users would let one tell from its timing that another had opened the same email. A key is a
// hash of the user and the URL, so nothing readable is in a file name, and a file name is only
// ever 64 hex characters and an extension from a fixed list: no key can reach outside the
// directory.
//
// It is a cache: nothing else reads it, backups leave it out, and deleting it only costs fetching
// the images again. Least recently used goes first past IMAGE_CACHE_MAX_MB (512 by default), an
// image larger than an eighth of that is not kept, and anything older than a month is fetched
// again. Failures are remembered for ten minutes, so an email full of dead images does not ask for
// each of them again on every open. Requests for an image already being fetched wait for that
// fetch. Should the directory not be writable, it carries on without the disk. The directory is
// read the first time the cache is used, not at import.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5000;
const EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico',
};
const TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]));
const KEY = /^[0-9a-f]{64}$/;
const NAME = /^([0-9a-f]{64})\.([a-z]+)$/;

export function imageCacheKey(userId, url) {
  return createHash('sha256').update(`${userId}\0${url}`).digest('hex');
}

export function createImageCache({
  dir = process.env.IMAGE_CACHE_DIR || path.join(os.tmpdir(), 'mailexpert-image-cache'),
  maxBytes = (Number(process.env.IMAGE_CACHE_MAX_MB) || 512) * 1024 * 1024,
  now = () => Date.now(),
} = {}) {
  // key -> { type, size, stored }, least recently used first.
  const index = new Map();
  let total = 0;
  let disabled = false;
  let ready = null;
  const failures = new Map();
  const inFlight = new Map();

  const fileOf = (key, type) => path.join(dir, `${key}.${EXTENSIONS[type]}`);
  const forget = (key) => {
    const entry = index.get(key);
    if (!entry) return;
    index.delete(key);
    total -= entry.size;
    unlink(fileOf(key, entry.type)).catch(() => {});
  };

  // What is on disk from before a restart, oldest first.
  const open = () => {
    ready ??= (async () => {
      try {
        await mkdir(dir, { recursive: true });
        const found = [];
        for (const name of await readdir(dir)) {
          const m = NAME.exec(name);
          if (!m || !TYPES[m[2]]) {
            if (name.endsWith('.tmp')) unlink(path.join(dir, name)).catch(() => {});
            continue;
          }
          const info = await stat(path.join(dir, name)).catch(() => null);
          if (info?.isFile()) found.push({ key: m[1], type: TYPES[m[2]], size: info.size, stored: info.mtimeMs });
        }
        found.sort((a, b) => a.stored - b.stored);
        for (const f of found) {
          index.set(f.key, { type: f.type, size: f.size, stored: f.stored });
          total += f.size;
        }
        while (total > maxBytes && index.size) forget(index.keys().next().value);
      } catch {
        disabled = true;
      }
    })();
    return ready;
  };

  async function get(key) {
    if (!KEY.test(key)) return null;
    await open();
    const entry = index.get(key);
    if (!entry) return null;
    if (now() - entry.stored > MAX_AGE_MS) {
      forget(key);
      return null;
    }
    try {
      const bytes = await readFile(fileOf(key, entry.type));
      index.delete(key);
      index.set(key, entry);
      return { bytes, type: entry.type };
    } catch {
      forget(key);
      return null;
    }
  }

  async function put(key, { bytes, type }) {
    if (!KEY.test(key)) return;
    await open();
    if (disabled || !EXTENSIONS[type] || bytes.length > maxBytes / 8) return;
    const file = fileOf(key, type);
    const tmp = path.join(dir, `${key}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    } catch {
      unlink(tmp).catch(() => {});
      return;
    }
    const old = index.get(key);
    if (old) {
      // Written over in place when the type is the same; only another type's file is left over.
      index.delete(key);
      total -= old.size;
      if (old.type !== type) unlink(fileOf(key, old.type)).catch(() => {});
    }
    index.set(key, { type, size: bytes.length, stored: now() });
    total += bytes.length;
    while (total > maxBytes && index.size > 1) forget(index.keys().next().value);
  }

  return {
    get,
    put,
    // The status a recent failure answered with, or null.
    failure(key) {
      const f = failures.get(key);
      if (!f) return null;
      if (now() > f.until) {
        failures.delete(key);
        return null;
      }
      return f.status;
    },
    fail(key, status) {
      failures.delete(key);
      failures.set(key, { status, until: now() + FAILURE_MS });
      if (failures.size > MAX_FAILURES) failures.delete(failures.keys().next().value);
    },
    // The image for `key`: from disk, from a fetch already under way, or from `produce()`, whose
    // result is then stored. Its errors pass through, and are not stored here (see fail).
    async load(key, produce) {
      const cached = await get(key);
      if (cached) return { ...cached, hit: true };
      const pending = inFlight.get(key);
      if (pending) return pending;
      const work = (async () => {
        try {
          const image = await produce();
          await put(key, image);
          return { ...image, hit: false };
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, work);
      return work;
    },
    stats: () => ({ entries: index.size, bytes: total, disabled }),
    async clear() {
      await open();
      for (const key of [...index.keys()]) forget(key);
      failures.clear();
    },
  };
}

// The one the image route uses.
export const imageCache = createImageCache();
