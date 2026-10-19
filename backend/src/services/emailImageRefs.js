// The image references of sanitized email HTML, for the image proxy (services/imageProxy.js):
// every remote image an email loads, found where the browser would load it (img src and srcset,
// the background attribute, url() and image-set() in inline styles and <style> blocks), and
// rewritten in place.
//
// It reads sanitize-html's output only: every attribute value is double-quoted, with " written
// as &quot;. A single-quoted value is not that output, and rewriting inside one could let a URL
// close the attribute, so only double-quoted values are touched. Markup is scanned left to right,
// tag by tag with the shared sanitizer tokenizer, and <style> blocks are read as CSS, never as tags;
// every search moves forward only,
// so time grows with the length of the HTML.
import { mapStartTags, rewriteCssUrls, decodeAttr, encodeAttr } from './emailSanitizer.js';

const REMOTE = /^\s*(?:https?:)?\/\//i;
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// An image that draws nothing, one pixel: what a tracker, or a panel URL an email wrote itself,
// becomes, so the layout stays as sent.
export const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// The URL a remote reference loads, from its decoded text: protocol-relative ("//host/...") is
// https, as the email frame resolves it, and plain http is upgraded as sanitizeEmail upgrades it
// (the image proxy fetches over https only).
export function remoteUrlOf(text) {
  const url = text.replace(/[\t\n\r]/g, '').trim();
  if (url.startsWith('//')) return `https:${url}`;
  if (/^http:/i.test(url)) return `https:${url.slice(5)}`;
  return url;
}

// The URLs of a srcset value as the browser reads them (HTML's srcset parsing): a URL runs to the
// next whitespace less any trailing commas, then descriptors run to a comma outside parentheses.
// `replace(url)` returns the text for one URL.
export function mapSrcsetUrls(value, replace) {
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
  return mapStartTags(html, (name, attrs) => {
    const imgAttrs = new Map(attrs.filter(a => a.value !== null).map(a => [a.name.toLowerCase(), a.value]));
    let changed = false;
    const nextAttrs = attrs.map(attribute => {
      const { name: attrName, value } = attribute;
      if (value === null || !attribute.raw.includes('="')) return attribute;
      const attr = attrName.toLowerCase();
      const at = (where, raw, imageAttrs) => {
        const url = decodeAttr(raw);
        return visit(raw, { url, remote: REMOTE.test(url), where, attrs: imageAttrs });
      };
      let next = value;
      if (name === 'img' && attr === 'src') next = at('src', value, imgAttrs) ?? value;
      else if (name === 'img' && attr === 'srcset') next = mapSrcsetUrls(value, raw => at('srcset', raw, imgAttrs) ?? raw);
      else if (attr === 'background') next = at('background', value) ?? value;
      else if (attr === 'style') {
        const css = decodeAttr(value);
        const rewritten = rewriteCssUrls(css, cssRewrite(encodeAttr, 'style'));
        if (rewritten !== css) next = encodeAttr(rewritten);
      }
      if (next === value) return attribute;
      changed = true;
      return { name: attrName, value: next };
    });
    return changed ? nextAttrs : null;
  }, { onStyle: css => rewriteCssUrls(css, cssRewrite(v => v, 'css')) });
}

// Open-tracking images. The image proxy hides the reader's address, but fetching a tracking pixel
// still tells the sender the email was opened, so MailExpert does not fetch these at all, even
// with images allowed: an <img> the email itself sizes at 2x2 px or less (width and height, as
// attributes or inline style), and the open-tracking addresses of the common sending platforms.
// Images hidden with display:none are not counted: senders hide a dark-mode logo that way.
const TINY = 2;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const OPEN_SEGMENT = /^open(?:ed)?(?:\.(?:gif|png|jpe?g|php|aspx?))?$/i;
const TRACKER_FILE = /^(?:pixel|beacon|track(?:ing)?|open)\.(?:gif|png)$/i;
const TOKEN = /^[\w.=~-]{16,}$/;

// Whether `url` is a known open-tracking address. Only the path is read.
export function isTrackingUrl(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const segs = path.split('/').filter(Boolean);
  if (!segs.length) return false;
  const last = segs[segs.length - 1];
  if (TRACKER_FILE.test(last)) return true;
  // .../open, .../open.php, .../open/<token> (SendGrid /wf/open, Mailchimp /track/open.php,
  // Salesforce /open.aspx, /api/notifications/v1/open/<token>), but not /open/images/logo.png.
  for (let i = Math.max(0, segs.length - 2); i < segs.length; i += 1) {
    if (OPEN_SEGMENT.test(segs[i]) && (i === segs.length - 1 || !IMAGE_FILE.test(last))) return true;
  }
  // Mailgun /o/<token>, Customer.io /e/o/<token>, Amazon SES /I0/<token> and /CI0/<token>.
  if (segs.length >= 2 && ['o', 'I0', 'CI0'].includes(segs[segs.length - 2]) && TOKEN.test(last) && !IMAGE_FILE.test(last)) return true;
  return false;
}

const PIXELS = /^(\d+(?:\.\d+)?)(?:px)?$/i;
const STYLE_PIXELS = /^(\d+(?:\.\d+)?)px$/i;

// An img's width or height in pixels, from its attribute or its inline style, or null.
function dimension(attrs, name) {
  const attr = attrs.get(name);
  if (attr !== undefined) {
    const m = PIXELS.exec(decodeAttr(attr).trim());
    if (m) return Number(m[1]);
  }
  const style = attrs.get('style');
  if (style === undefined) return null;
  let found = null;
  for (const decl of decodeAttr(style).split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1 || decl.slice(0, colon).trim().toLowerCase() !== name) continue;
    const m = STYLE_PIXELS.exec(decl.slice(colon + 1).replace(/!important/i, '').trim());
    if (m) found = Number(m[1]);
  }
  return found;
}

const isTinyImage = (attrs) => {
  const w = dimension(attrs, 'width');
  const h = dimension(attrs, 'height');
  return w !== null && h !== null && w <= TINY && h <= TINY;
};

// Whether a remote reference is a tracker: its address is one, or an <img> the email sizes as a
// pixel loads it (wherever else the same reference is used).
function trackerTest(html) {
  const tiny = new Set();
  visitImageRefs(html, (raw, ref) => {
    if (ref.remote && (ref.where === 'src' || ref.where === 'srcset') && isTinyImage(ref.attrs)) tiny.add(raw);
    return undefined;
  });
  return (raw, url) => tiny.has(raw) || isTrackingUrl(url);
}

// Every remote image of sanitized HTML through the image proxy: each remote reference becomes
// `toProxy(raw, ref)` (routes/mail.js, services/imageProxy.js imageProxyPath), which carries the
// reference as it was written, so send/save can authenticate it and restore the original
// (restoreOutgoingImages.js). Trackers are not loaded: they become
// BLANK_IMAGE, and `stats.trackers` counts the distinct ones.
export function proxyRemoteImages(html, toProxy, stats = {}) {
  stats.trackers = 0;
  if (!html) return html;
  const isTracker = trackerTest(html);
  const trackers = new Set();
  const out = visitImageRefs(html, (raw, ref) => {
    if (!ref.remote) return undefined;
    const url = remoteUrlOf(ref.url);
    if (!isTracker(raw, url)) return toProxy(raw, ref);
    trackers.add(url);
    return BLANK_IMAGE;
  });
  stats.trackers = trackers.size;
  return out;
}

// The remote image references of sanitized HTML, as written, with what each loads: the only URLs
// the image proxy fetches for a message. Trackers are left out.
export function remoteImageRefs(html) {
  const refs = new Map();
  if (!html) return refs;
  const isTracker = trackerTest(html);
  visitImageRefs(html, (raw, ref) => {
    if (!ref.remote || refs.has(raw)) return undefined;
    const url = remoteUrlOf(ref.url);
    if (!isTracker(raw, url)) refs.set(raw, url);
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
