// The image references of sanitized email HTML, for the image proxy (services/imageProxy.js):
// every remote image an email loads, found where the browser would load it (img src and srcset,
// the background attribute, url() and image-set() in inline styles and <style> blocks), and
// rewritten in place.
//
// It reads sanitize-html's output only: every attribute value is double-quoted, with " written
// as &quot;. A single-quoted value is not that output, and rewriting inside one could let a URL
// close the attribute, so only double-quoted values are touched. Markup is scanned left to right,
// tag by tag, and <style> blocks are read as CSS, never as tags; every search moves forward only,
// so time grows with the length of the HTML.
import { rewriteCssUrls, decodeAttr, encodeAttr } from './emailSanitizer.js';

const REMOTE = /^\s*(?:https?:)?\/\//i;
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// An image that draws nothing: what a panel URL an email wrote itself, or a tracker, becomes.
export const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// The URL a remote reference loads, from its decoded text: protocol-relative ("//host/...") is
// https, as the email frame resolves it, and plain http is upgraded as sanitizeEmail upgrades it
// (the image proxy fetches over https only).
export function remoteUrlOf(text) {
  const url = text.trim();
  if (url.startsWith('//')) return `https:${url}`;
  if (/^http:/i.test(url)) return `https:${url.slice(5)}`;
  return url;
}

// The <style> blocks of `html` passed to onStyle(css), everything else to onMarkup(markup); the
// results joined. A block with no end runs to the end of the document, as the browser reads it.
function mapStyleBlocks(html, onMarkup, onStyle) {
  const open = /<style\b/gi;
  const close = /<\/style\s*>/gi;
  let out = '';
  let pos = 0;
  let m;
  while ((m = open.exec(html)) !== null) {
    const gt = html.indexOf('>', m.index);
    if (gt === -1) break;
    out += onMarkup(html.slice(pos, gt + 1));
    close.lastIndex = gt + 1;
    const end = close.exec(html);
    if (!end) {
      out += onStyle(html.slice(gt + 1));
      return out;
    }
    out += onStyle(html.slice(gt + 1, end.index)) + end[0];
    pos = end.index + end[0].length;
    open.lastIndex = pos;
  }
  return out + onMarkup(html.slice(pos));
}

// Every tag of `markup` passed to onTag(name, text); text between tags is kept as it is.
function mapTags(markup, onTag) {
  const tag = /<([a-zA-Z][a-zA-Z0-9]*)/g;
  let out = '';
  let pos = 0;
  let m;
  while ((m = tag.exec(markup)) !== null) {
    const gt = markup.indexOf('>', m.index);
    if (gt === -1) break;
    out += markup.slice(pos, m.index) + onTag(m[1].toLowerCase(), markup.slice(m.index, gt + 1));
    pos = gt + 1;
    tag.lastIndex = pos;
  }
  return out + markup.slice(pos);
}

// A tag's attributes as sanitize-html writes them: name="value" or a bare name.
const ATTR = /(\s)([^\s"'>/=]+)(?:(\s*=\s*)"([^"]*)")?/g;

export function tagAttributes(text) {
  const attrs = new Map();
  for (const m of text.matchAll(ATTR)) {
    const name = m[2].toLowerCase();
    if (m[4] !== undefined && !attrs.has(name)) attrs.set(name, m[4]);
  }
  return attrs;
}

// The URLs of a srcset value as the browser reads them (HTML's srcset parsing): a URL runs to the
// next whitespace less any trailing commas, then descriptors run to a comma outside parentheses.
// `replace(url)` returns the text for one URL.
function mapSrcsetUrls(value, replace) {
  const n = value.length;
  let out = '';
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && (isSpace(value[j]) || value[j] === ',')) j += 1;
    out += value.slice(i, j);
    i = j;
    if (i >= n) break;
    while (j < n && !isSpace(value[j])) j += 1;
    let k = j;
    while (k > i && value[k - 1] === ',') k -= 1;
    out += replace(value.slice(i, k)) + value.slice(k, j);
    i = j;
    if (k < j) continue;
    let depth = 0;
    while (j < n) {
      const c = value[j];
      if (c === '(') depth += 1;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ',' && depth === 0) break;
      j += 1;
    }
    out += value.slice(i, j);
    i = j;
  }
  return out;
}

// Every image reference of sanitized HTML passed to `visit(raw, ref)`, which returns the text to
// put in place of `raw`, or undefined to keep it. `raw` is the reference exactly as written in
// the HTML (in an attribute, with its entities). `ref` is { url, remote, where, attrs }: `url` the
// reference decoded, `where` one of 'src', 'srcset', 'background', 'style' and 'css' (a <style>
// block), `attrs` the tag's attributes for an img. CSS references are visited when remote only.
function visitImageRefs(html, visit) {
  if (!html) return html;
  const cssRewrite = (encodeRaw, where) => (kind, url, token) => {
    if (kind === 'import') return token.text;
    const raw = encodeRaw(token.value);
    const out = visit(raw, { url: decodeAttr(raw), remote: true, where });
    return out === undefined ? token.text : `${token.before}${out}${token.after}`;
  };
  const onTag = (name, text) => text.replace(ATTR, (match, space, attrName, eq, value) => {
    if (value === undefined) return match;
    const attr = attrName.toLowerCase();
    const at = (where, raw, attrs) => {
      const url = decodeAttr(raw);
      return visit(raw, { url, remote: REMOTE.test(url), where, attrs });
    };
    let next = value;
    if (name === 'img' && attr === 'src') {
      next = at('src', value, tagAttributes(text)) ?? value;
    } else if (name === 'img' && attr === 'srcset') {
      next = mapSrcsetUrls(value, (raw) => at('srcset', raw) ?? raw);
    } else if (attr === 'background') {
      next = at('background', value) ?? value;
    } else if (attr === 'style') {
      const css = decodeAttr(value);
      const rewritten = rewriteCssUrls(css, cssRewrite(encodeAttr, 'style'));
      if (rewritten !== css) next = encodeAttr(rewritten);
    }
    return next === value ? match : `${space}${attrName}${eq}"${next}"`;
  });
  return mapStyleBlocks(
    html,
    (markup) => mapTags(markup, onTag),
    (css) => rewriteCssUrls(css, cssRewrite((v) => v, 'css')),
  );
}

// Every remote image of sanitized HTML through the image proxy: each remote reference becomes
// `toProxy(raw, ref)` (routes/mail.js, services/imageProxy.js imageProxyPath), which carries the
// reference as it was written, so the frontend can put the original back exactly when the HTML
// leaves for the server (a reply, a forward, a draft).
export function proxyRemoteImages(html, toProxy) {
  return visitImageRefs(html, (raw, ref) => (ref.remote ? toProxy(raw, ref) : undefined));
}

// The remote image references of sanitized HTML, as written, with what each loads: the only URLs
// the image proxy fetches for a message.
export function remoteImageRefs(html) {
  const refs = new Map();
  visitImageRefs(html, (raw, ref) => {
    if (ref.remote && !refs.has(raw)) refs.set(raw, remoteUrlOf(ref.url));
    return undefined;
  });
  return refs;
}

// Whether a reference points at the panel's own image proxy route, however it is spelled: the
// URL parser drops tabs and newlines and reads \ as /, and the path may be percent-encoded.
const PANEL_IMAGE_PATH = /\/api\/mail\/messages\/[^?#]*\/image(?:[/?#]|$)/;
function isPanelImageRef(url) {
  let text = url.replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
  try { text = decodeURIComponent(text); } catch { /* read as written */ }
  return PANEL_IMAGE_PATH.test(text.toLowerCase());
}

// The panel's own image proxy URLs an email wrote itself, relative or absolute, replaced with an
// image that draws nothing. A proxy URL works only with a signature the panel issues for the
// reader (services/imageProxy.js), so such a URL fetches nothing anyway; this keeps an email from
// trying. Relative URLs inside CSS are not read here; the signature refuses them.
export function stripPanelImageRefs(html) {
  return visitImageRefs(html, (raw, ref) => (isPanelImageRef(ref.url) ? BLANK_IMAGE : undefined));
}
