import DOMPurify from 'dompurify';

// Email HTML placed in MailExpert's own page rather than the email frame: the composer's quoted
// reply or forward, and the div renderer. When a body is served with remote images blocked, the
// email frame's CSP allows no remote images (utils/remoteImagePolicy.js), but the app's allows any
// https: image (avatars, sender favicons), so here nothing but the page itself stands between a
// sender's image and the reader's browser. The server blocks every remote image it recognizes; one
// written so it does not recognize it (a CSS escape such as url(\68ttps://…) or u\72l(…)) reached
// the composer as written, and the browser, which decodes those escapes, fetched it from the
// sender on Reply.
//
// So, for a body served blocked, every image URL is judged here as the browser reads it: through
// its own URL parser for attributes and its own CSS parser for inline styles. Only MailExpert's own
// origin, data:, blob: and cid: are kept. Remote images are shown by default; a body served with
// them is placed as it is.

const KEPT_SCHEMES = new Set(['data:', 'blob:', 'cid:']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_IMAGE_ELEMENTS = new Set(['image', 'feimage', 'use']);
const CSS_URL = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/gi;
const CSS_STRING = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;

function keptUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim(), window.location.href);
  } catch {
    return false;
  }
  return KEPT_SCHEMES.has(url.protocol) || url.origin === window.location.origin;
}

function keptSrcset(value) {
  return String(value).split(',').every(candidate => {
    const url = candidate.trim().split(/\s+/)[0];
    return !url || keptUrl(url);
  });
}

const unescapeCss = s => s.replace(/\\(.)/g, '$1');

// A declaration value that loads something (url(), or image-set() with a plain string) and
// anything it loads is not kept: drop the declaration. A url() the pattern cannot read is dropped too.
export function keptCssValue(value) {
  if (!/url\(|image-set\(|image\(/i.test(value)) return true;
  let found = false;
  for (const m of value.matchAll(CSS_URL)) {
    found = true;
    if (!keptUrl(unescapeCss(m[1] ?? m[2] ?? m[3] ?? ''))) return false;
  }
  if (/image-set\(|image\(/i.test(value)) {
    for (const m of value.matchAll(CSS_STRING)) {
      found = true;
      if (!keptUrl(unescapeCss(m[1] ?? m[2] ?? ''))) return false;
    }
  }
  return found;
}

function keepOnlyLocalImages(node) {
  if (node.nodeType !== 1) return;
  for (const attr of ['src', 'poster', 'background']) {
    if (node.hasAttribute(attr) && !keptUrl(node.getAttribute(attr))) node.removeAttribute(attr);
  }
  if (node.hasAttribute('srcset') && !keptSrcset(node.getAttribute('srcset'))) node.removeAttribute('srcset');
  if (node.namespaceURI === SVG_NS && SVG_IMAGE_ELEMENTS.has(node.localName.toLowerCase())) {
    for (const attr of ['href', 'xlink:href']) {
      if (node.hasAttribute(attr) && !keptUrl(node.getAttribute(attr))) node.removeAttribute(attr);
    }
  }
  // A URL behind var() or a CSS escape does not show in the parsed longhands: var(--u, \75 rl(…))
  // keeps its raw text, a shorthand holding var() leaves every longhand empty, a custom property
  // carries its URL to wherever var() reads it, and \68ttps: reads as a relative path here. The
  // browser resolves all of them when it draws. Such a style is dropped whole.
  if (node.hasAttribute('style') && /\\|var\(/i.test(node.getAttribute('style'))) {
    node.removeAttribute('style');
  }
  if (node.hasAttribute('style')) {
    // The browser's own reading of the declarations, escapes decoded and shorthands expanded.
    const style = node.style;
    for (let i = style.length - 1; i >= 0; i -= 1) {
      const prop = style[i];
      if (!keptCssValue(style.getPropertyValue(prop))) style.removeProperty(prop);
    }
    if (!style.length) node.removeAttribute('style');
  }
}

// DOMPurify.sanitize with the image rule above. The hook is added for this call only, so other
// sanitizes (markdown, signatures) are unaffected.
export function sanitizeEmailForApp(html, config = {}) {
  DOMPurify.addHook('afterSanitizeAttributes', keepOnlyLocalImages);
  try {
    return DOMPurify.sanitize(html, config);
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', keepOnlyLocalImages);
  }
}

// The composer's quoted HTML. <style> blocks are stripped: marketing emails use global rules like
// "div { margin: 0 !important }" that leak out of contentEditable into the app UI; inline style
// attributes are preserved. imagesBlocked: the quoted body was served with remote images blocked.
export function sanitizeQuoteHtml(html, { imagesBlocked = false, imagesProxied = false } = {}) {
  const config = { FORBID_TAGS: ['style'] };
  return (imagesBlocked || imagesProxied) ? sanitizeEmailForApp(html, config) : DOMPurify.sanitize(html, config);
}
