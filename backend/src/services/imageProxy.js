// The image proxy: the remote images of an email the reader may load arrive through MailExpert,
// so the sender's server sees the panel, not the reader's address, browser or cookies, and the
// email frame can forbid every direct remote load (frontend utils/remoteImagePolicy.js). Only what
// the reader may load goes through it (images not blocked, a sender they allow, or "Load
// images"); blocked images stay blocked, and open-tracking images are never fetched
// (emailImageRefs.js).
//
// It is not an open proxy. GET /api/mail/messages/:id/image/:token needs the panel session, and:
// - the token signs the user, the message and the reference with a key only the panel has, and
//   expires: the body route mints one only for a body it serves with images allowed, so a proxy
//   URL an email writes itself, or one minted for another user, fetches nothing;
// - the reference must be one that message's HTML holds (emailImageRefs.js remoteImageRefs).
//
// The fetch goes through safeFetch: private and reserved addresses are refused on every
// connection, whatever the private-hosts setting (that setting is for servers an admin enters,
// and an image address is the sender's), plaintext HTTP is refused, redirects are followed here
// one hop at a time, at most IMAGE_PROXY_MAX_REDIRECTS, and the request carries no cookies,
// referrer or credentials, and a generic user agent. What comes back is served only if its bytes
// are a raster image of a known type, under a size limit; never SVG or HTML, which opened on
// their own would be documents on the panel's origin.
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { safeFetch } from './safeFetch.js';
import { readBodyLimited } from './senderFavicon.js';
import { deriveKey } from './encryption.js';

export const IMAGE_PROXY_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_PROXY_TIMEOUT_MS = 15_000;
// A server that has not started answering by then is not going to: give the slot to the next image.
export const IMAGE_PROXY_HEADERS_TIMEOUT_MS = 8_000;
export const IMAGE_PROXY_PER_USER = 6;
export const IMAGE_PROXY_MAX_REDIRECTS = 5;
// How long a proxy URL stays valid: a body re-read after that mints new ones.
export const IMAGE_PROXY_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// The signing key: derived from ENCRYPTION_KEY, or else from SESSION_SECRET (which index.js
// requires), so tokens survive a restart; a random one only when neither is set (tests).
let signingKey = null;
function key() {
  if (signingKey) return signingKey;
  const derived = deriveKey('image-proxy');
  const secret = process.env.SESSION_SECRET;
  signingKey = derived
    ?? (secret ? Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'mailexpert:image-proxy', 32)) : randomBytes(32));
  return signingKey;
}

const sign = (userId, messageId, raw, exp, allowBlocked = false) => createHmac('sha256', key())
  .update(`${userId}\0${messageId}\0${exp}\0${allowBlocked ? 1 : 0}\0${raw}`)
  .digest('base64url');

// "<exp>.<signature>": exp in seconds since the epoch.
const TOKEN = /^(\d{1,12})\.([A-Za-z0-9_-]{1,128})$/;
export function parseImageProxyToken(token) {
  const m = typeof token === 'string' ? TOKEN.exec(token) : null;
  return m ? { exp: Number(m[1]), sig: m[2] } : null;
}

// Restoration authenticates old quotes without granting permission to fetch an expired URL.
export function verifyImageProxyToken(token, { userId, messageId, raw, now = Date.now(), allowBlocked = false, purpose = 'fetch' }) {
  const parsed = parseImageProxyToken(token);
  if (!parsed || !userId) return false;
  const expMs = parsed.exp * 1000;
  if (purpose !== 'restore' && (expMs < now || expMs - now > IMAGE_PROXY_TOKEN_TTL_MS + HOUR_MS)) return false;
  const expected = Buffer.from(sign(userId, messageId, raw, parsed.exp, allowBlocked));
  const given = Buffer.from(parsed.sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The proxy URL for a reference as written in a message's HTML, signed for `userId`. The expiry
// is rounded to the hour, so a body read again within the hour gets the same URLs and the browser
// keeps its copies. The reference is percent-encoded beyond encodeURIComponent (which leaves
// ! ' ( ) * alone), so the URL is safe in any attribute, inline style or <style> block: only
// letters, digits, - . _ ~ % / ? = remain. restoreOutgoingImages.js authenticates and reverses
// it at send/save time; the composer keeps the signed URL.
export function imageProxyPath(messageId, raw, userId, { now = Date.now(), allowBlocked = false } = {}) {
  const exp = Math.floor((Math.ceil(now / HOUR_MS) * HOUR_MS + IMAGE_PROXY_TOKEN_TTL_MS) / 1000);
  const encoded = encodeURIComponent(raw).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `/api/mail/messages/${messageId}/image/${exp}.${sign(userId, messageId, raw, exp, allowBlocked)}?u=${encoded}${allowBlocked ? "&allow=1" : ""}`;
}

// The image type from the file's first bytes, or null: the upstream Content-Type is not trusted.
export function sniffImageType(bytes) {
  const b = bytes;
  const ascii = (start, end) => b.subarray(start, end).toString('latin1');
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'image/avif';
  if (b.length >= 2 && ascii(0, 2) === 'BM') return 'image/bmp';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  return null;
}

// A declared type the bytes may be checked under: none, an image type other than SVG, or a
// generic binary one (CDNs often send that, or another raster type than the file is). The bytes
// decide what is served.
function acceptableDeclaredType(type) {
  if (!type) return true;
  if (type.includes('svg')) return false;
  return type.startsWith('image/') || type === 'application/octet-stream' || type === 'binary/octet-stream';
}

const failure = (status, reason) => Object.assign(new Error(reason), { status, reason });
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function cancelBody(body) {
  try { await body?.cancel?.(); } catch { /* best effort */ }
}

// Fetches one remote image. Returns { bytes, type }; throws an error carrying the HTTP status to
// answer with (404 nothing there, 413 too large, 415 not an image we serve, 502 upstream failed).
export async function fetchProxiedImage(url, {
  fetchImpl = safeFetch, timeoutMs = IMAGE_PROXY_TIMEOUT_MS, headersTimeoutMs = IMAGE_PROXY_HEADERS_TIMEOUT_MS,
  maxBytes = IMAGE_PROXY_MAX_BYTES,
} = {}) {
  // Two limits: the answer must start within headersTimeoutMs, and be complete within timeoutMs.
  const total = AbortSignal.timeout(timeoutMs);
  let current = url;
  let upstream;
  for (let hop = 0; ; hop += 1) {
    let parsed;
    try { parsed = new URL(current); } catch { throw failure(502, 'bad url'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw failure(502, 'scheme');
    const headers = new AbortController();
    const headersTimer = setTimeout(() => headers.abort(), headersTimeoutMs);
    try {
      upstream = await fetchImpl(parsed.href, {
        redirect: 'manual',
        signal: AbortSignal.any([headers.signal, total]),
        // No cookies, no referrer, no credentials: a fresh request that says only what it wants.
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; image proxy)',
        },
      });
    } catch {
      throw failure(502, 'fetch failed');
    } finally {
      clearTimeout(headersTimer);
    }
    if (!REDIRECTS.has(upstream.status)) break;
    await cancelBody(upstream.body);
    const location = upstream.headers.get('location');
    if (!location || hop >= IMAGE_PROXY_MAX_REDIRECTS) throw failure(502, 'redirect');
    try { current = new URL(location, parsed).href; } catch { throw failure(502, 'redirect'); }
  }
  if (upstream.status !== 200) {
    await cancelBody(upstream.body);
    throw failure(upstream.status === 404 || upstream.status === 410 ? 404 : 502, `upstream ${upstream.status}`);
  }
  const declaredType = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || '';
  const declaredLength = Number(upstream.headers.get('content-length'));
  if (!acceptableDeclaredType(declaredType)) { await cancelBody(upstream.body); throw failure(415, 'not an image type'); }
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) { await cancelBody(upstream.body); throw failure(413, 'too large'); }
  let bytes;
  try {
    bytes = await readBodyLimited(upstream.body, maxBytes);
  } catch (error) {
    throw failure(error?.code === 'ERR_BODY_TOO_LARGE' ? 413 : 502, 'body failed');
  }
  const type = sniffImageType(bytes);
  if (!type) throw failure(415, 'not a raster image');
  return { bytes, type };
}

// At most IMAGE_PROXY_PER_USER fetches at once per user; the rest wait their turn. A newsletter
// asks for dozens of images together, and the sender's servers need not be hit all at once.
export function createUserLimiter(limit = IMAGE_PROXY_PER_USER) {
  const users = new Map();
  return async function run(userId, task) {
    let entry = users.get(userId);
    if (!entry) { entry = { active: 0, waiting: [] }; users.set(userId, entry); }
    if (entry.active >= limit) await new Promise((resolve) => entry.waiting.push(resolve));
    else entry.active += 1;
    try {
      return await task();
    } finally {
      const nextTask = entry.waiting.shift();
      if (nextTask) nextTask();
      else {
        entry.active -= 1;
        if (entry.active === 0) users.delete(userId);
      }
    }
  };
}
