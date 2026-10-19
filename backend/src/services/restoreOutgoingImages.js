// Only the server can authenticate a proxy reference. Restore it at send/save time, leaving
// signed URLs in the composer and leaving unsigned lookalikes, links and text untouched.
import { decodeAttr, encodeAttr, mapStartTags, rewriteCssUrls } from './emailSanitizer.js';
import { mapSrcsetUrls } from './emailImageRefs.js';
import { verifyImageProxyToken } from './imageProxy.js';

const PATH = /^\/api\/mail\/messages\/([0-9a-f-]{36})\/image\/(\d+\.[A-Za-z0-9_-]+)$/i;
const REMOTE = /^\s*(?:https?:)?\/\//i;
const cssString = value => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  .replace(/</g, '\\3c ').replace(/[\n\r\f]/g, char => `\\${char.charCodeAt(0).toString(16)} `);

export function restoreOutgoingImages(html, userId, { panelUrl = process.env.APP_URL } = {}) {
  if (typeof html !== 'string' || !html.includes('/api/mail/messages/')) return html;
  let origin = null;
  try { origin = new URL(panelUrl).origin; } catch { /* relative proxies still work */ }
  const original = (reference, decodeSource) => {
    let url;
    try {
      if (reference.startsWith('/') && !reference.startsWith('//')) url = new URL(reference, 'https://panel.invalid');
      else {
        url = new URL(reference);
        if (!origin || url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      }
    } catch { return null; }
    const match = PATH.exec(url.pathname);
    if (!match || url.hash || [...url.searchParams.keys()].some(key => key !== 'u' && key !== 'allow')
      || url.searchParams.getAll('u').length !== 1 || url.searchParams.getAll('allow').length > 1) return null;
    const raw = url.searchParams.get('u');
    const allow = url.searchParams.get('allow');
    if (allow !== null && allow !== '1') return null;
    if (!raw || !REMOTE.test(decodeAttr(raw)) || !verifyImageProxyToken(match[2], {
      userId, messageId: match[1], raw, allowBlocked: allow === '1', purpose: 'restore',
    })) return null;
    return decodeSource ? decodeAttr(raw) : raw;
  };
  const css = (value, decodeSource) => rewriteCssUrls(value, (kind, _url, token) => {
    if (kind === 'import') return token.text;
    const restored = original(token.value, decodeSource);
    if (restored === null) return token.text;
    const quoted = `"${cssString(restored)}"`;
    return kind === 'url' ? `url(${quoted})` : quoted;
  }, { localUrls: true });
  return mapStartTags(html, (tag, attrs) => {
    let changed = false;
    const next = attrs.map(attr => {
      if (attr.value === null) return attr;
      const name = attr.name.toLowerCase();
      let value = attr.value;
      if ((tag === 'img' && name === 'src') || name === 'background') {
        const restored = original(decodeAttr(value), true);
        if (restored !== null) value = encodeAttr(restored);
      } else if (tag === 'img' && name === 'srcset') {
        value = mapSrcsetUrls(value, raw => {
          const restored = original(decodeAttr(raw), true);
          return restored === null ? raw : encodeAttr(restored);
        });
      } else if (name === 'style') {
        const decoded = decodeAttr(value);
        const restored = css(decoded, true);
        if (restored !== decoded) value = encodeAttr(restored);
      }
      if (value === attr.value) return attr;
      changed = true;
      return { name: attr.name, value };
    });
    return changed ? next : null;
  }, { onStyle: value => css(value, false) });
}

export function restoreOutgoingImagePayload(data, userId) {
  return {
    ...data,
    ...(data.bodyIsHtml && typeof data.body === 'string' ? { body: restoreOutgoingImages(data.body, userId) } : {}),
    ...(typeof data.quotedBodyHtml === 'string' ? { quotedBodyHtml: restoreOutgoingImages(data.quotedBodyHtml, userId) } : {}),
    ...(typeof data.editedSignature === 'string' ? { editedSignature: restoreOutgoingImages(data.editedSignature, userId) } : {}),
  };
}
