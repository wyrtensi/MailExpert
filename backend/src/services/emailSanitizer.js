import sanitizeHtml from 'sanitize-html';

// Strip the <head> element from email HTML, preserving any <style> blocks inside it.
//
// Why: sanitize-html's 'discard' mode removes disallowed tags (e.g. <title>) but
// keeps their text content.  Non-whitespace text inside <head> is moved to <body>
// by the HTML5 parser (it treats it as an implicit body-start), so text like
// "Document" or "Buffalo Tech Systems" from a <title> tag renders visibly at the
// top of the email.  Stripping <head> entirely (while rescuing <style> blocks, which
// contain layout CSS) prevents this and has no effect on the visible email content.
//
// MSO conditional comments (<!--[if gte mso 9]>...<![endif]-->) are stripped before
// extracting <style> blocks so that Outlook-only CSS rules (e.g. mso-* properties,
// table layout overrides) are not applied in browser rendering, where they can break
// font sizes, spacing, and colors that the email author tuned for non-Outlook clients.

// Case-insensitive indexOf for an ASCII needle, searched in the string itself. Searching a
// toLowerCase() copy instead gives wrong positions once the text holds a character whose lowercase
// is longer (İ becomes two characters): offsets drifted by one per İ, so text was cut at the wrong
// place and a following block could be skipped.
function indexOfCi(str, needle, from) {
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  re.lastIndex = from;
  const m = re.exec(str);
  return m ? m.index : -1;
}

// Replace every `<tag …>content</tag>` span in linear time. A lazy
// `<tag\b[^>]*>[\s\S]*?</tag>` /g regex is O(n²) on hostile email HTML on TWO axes:
// the `[^>]*>` opener backtracks futilely when a tag has no `>`, and the lazy
// `[\s\S]*?` re-scans to end-of-string from every unmatched opener when a close is
// missing. A crafted body of many bare `<head>`/`<style>` froze the render path
// (found by eslint-plugin-redos). Node lacks possessive/atomic quantifiers, so we
// scan by hand: `openNameRe` is a fixed tag-name literal (e.g. /<style\b/gi, linear),
// the opening tag ends at the first `>` (indexOf — same as the quote-unaware `[^>]*>`),
// and content ends at the nearest close (indexOf — same as lazy `[\s\S]*?`). When no
// `>` or close exists at/after an opener, none exists for any later opener either
// (positions only advance), so we stop — exactly what the regex would leave unmatched.
function scanPaired(str, openNameRe, closeLiteral, transform) {
  let out = '';
  let pos = 0;
  let m;
  openNameRe.lastIndex = 0;
  while ((m = openNameRe.exec(str)) !== null) {
    const gt = str.indexOf('>', m.index);
    if (gt === -1) break; // unterminated opening tag — no match, like [^>]*> would fail
    const contentStart = gt + 1;
    const closeIdx = indexOfCi(str, closeLiteral, contentStart);
    if (closeIdx === -1) break;
    const spanEnd = closeIdx + closeLiteral.length;
    out += str.slice(pos, m.index) + transform(str.slice(m.index, contentStart), str.slice(contentStart, closeIdx), str.slice(closeIdx, spanEnd));
    pos = spanEnd;
    openNameRe.lastIndex = spanEnd;
  }
  return out + str.slice(pos);
}

// Every start tag in sanitized HTML with its attributes, read as the HTML tokenizer reads them:
// a value runs to its own closing quote, so text that looks like an attribute inside another
// attribute's value (title=" style='…' href=javascript:… ") is part of that value, never an
// attribute. Patterns over the markup (\sstyle=('|")…) matched such text, and the quotes of their
// rewrite closed the outer value, turning the rest of it into real attributes.
//
// map(tag, attrs) gets the lowercased tag name and its attributes as { name, value, raw }: value is
// as written (entities not decoded), null for a bare attribute, and raw the attribute's source
// text. It returns null to leave the tag byte for byte, or the attributes to write back: an entry
// that keeps its raw is written as it was, any other as name="value" (value already encoded).
// The text of raw-text elements (<style>) is skipped, not read as tags. Linear: every search moves
// forward, and an unterminated quote or tag ends the walk with the rest left as it is.
const RAW_TEXT_TAGS = new Set(['style', 'script', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const isHtmlSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

function mapStartTags(html, map) {
  const n = html.length;
  const tagName = /[a-zA-Z][^\s/>]*/y;
  let out = '';
  let pos = 0;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    tagName.lastIndex = lt + 1;
    const nm = tagName.exec(html);
    if (!nm) { i = lt + 1; continue; }
    const tag = nm[0].toLowerCase();
    const attrs = [];
    let j = tagName.lastIndex;
    let end = -1;
    while (j < n) {
      while (j < n && (isHtmlSpace(html[j]) || html[j] === '/')) j += 1;
      if (j >= n) break;
      if (html[j] === '>') { end = j + 1; break; }
      const start = j;
      j += 1; // an attribute name may start with any character but space, / and >
      while (j < n && !isHtmlSpace(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j += 1;
      const name = html.slice(start, j);
      let k = j;
      while (k < n && isHtmlSpace(html[k])) k += 1;
      if (html[k] !== '=') { attrs.push({ name, value: null, raw: name }); continue; }
      k += 1;
      while (k < n && isHtmlSpace(html[k])) k += 1;
      let value;
      if (html[k] === '"' || html[k] === "'") {
        const close = html.indexOf(html[k], k + 1);
        if (close === -1) break; // unterminated value: end stays -1 and the walk stops
        value = html.slice(k + 1, close);
        j = close + 1;
      } else {
        const from = k;
        while (k < n && !isHtmlSpace(html[k]) && html[k] !== '>') k += 1;
        value = html.slice(from, k);
        j = k;
      }
      attrs.push({ name, value, raw: html.slice(start, j) });
    }
    if (end === -1) break;
    const next = map(tag, attrs);
    if (next) {
      const selfClosing = html[end - 2] === '/';
      out += html.slice(pos, lt) + '<' + nm[0]
        + next.map(a => ` ${a.raw ?? `${a.name}="${a.value}"`}`).join('')
        + (selfClosing ? ' />' : '>');
      pos = end;
    }
    i = end;
    if (RAW_TEXT_TAGS.has(tag)) {
      const close = indexOfCi(html, `</${tag}`, end);
      if (close === -1) break;
      i = close;
    }
  }
  return out + html.slice(pos);
}

// Rewrites the text of every <style> block, then seals it. The rewrites run on sanitized output and
// delete parts of the CSS (a declaration, a url(), a whole @media block); a deletion joins the text
// on either side of it, and `</` before one with `style` after it made a real end tag, closing the
// block early so whatever followed it in the CSS (tags sanitize-html had only seen as style text:
// <a href="javascript:…">, <form>, <base>) reached the body as markup. Sealing turns any `</style`
// left in the text into `<\/style`, the same characters to CSS and no end tag to the HTML parser.
// An opening `<style` is escaped the same way (`<\style`).
export function sealStyleText(css) {
  return css.replace(/<(\/?)(style)/gi, '<\\$1$2');
}

function rewriteStyleBlocks(html, rewrite) {
  return scanPaired(html, /<style\b/gi, '</style>', (open, content, close) => open + sealStyleText(rewrite(content)) + close);
}

// Strip MSO-positive conditional comments (<!--[if mso]>…<![endif]-->) linearly,
// preserving <!--[if !mso]> blocks (browser-targeted CSS). Mirrors the old regex
// /<!--\[if(?!\s*!)[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi without its backtracking.
function stripMsoConditionals(hc) {
  const END = '<![endif]-->';
  const openRe = /<!--\[if/gi;
  let out = '';
  let pos = 0;
  let m;
  while ((m = openRe.exec(hc)) !== null) {
    const after = m.index + m[0].length;
    let k = after;
    while (k < hc.length && /\s/.test(hc[k])) k++;
    if (hc[k] === '!') { openRe.lastIndex = after; continue; } // <!--[if !mso]> — keep
    const rb = hc.indexOf(']', after);
    if (rb === -1) break;
    if (hc[rb + 1] !== '>') { openRe.lastIndex = after; continue; } // ']' not immediately '>' — no match
    const endIdx = indexOfCi(hc, END, rb + 2);
    if (endIdx === -1) break;
    out += hc.slice(pos, m.index);
    pos = endIdx + END.length;
    openRe.lastIndex = pos;
  }
  return out + hc.slice(pos);
}

export function stripEmailHead(html) {
  if (!html) return html;
  return scanPaired(html, /<head\b/gi, '</head>', (_open, headContent) => {
    const noMso = stripMsoConditionals(headContent);
    // Rescue <style> blocks (layout CSS) from the head; drop everything else.
    let styles = '';
    scanPaired(noMso, /<style\b/gi, '</style>', (open, content, close) => { styles += open + content + close; return ''; });
    return styles;
  });
}


function upgradeUrl(url) {
  return typeof url === 'string' && url.startsWith('http://') ? 'https://' + url.slice(7) : url;
}

// Normalise an anchor href value to an absolute https/mailto/tel URL, or return
// null if the href cannot be safely resolved (relative paths, fragments, etc.).
// Returns null for hrefs that would resolve against the mailexpert origin in a
// same-origin srcdoc iframe — callers should omit the href attribute entirely.
function normalizeHref(href) {
  if (!href) return null;
  const h = href.trim();
  if (!h) return null;
  if (/^https:\/\//i.test(h)) return h;
  if (/^http:\/\//i.test(h)) return 'https://' + h.slice(7);
  if (/^(mailto:|cid:|tel:|sms:)/i.test(h)) return h;
  if (h.startsWith('//')) return 'https:' + h;
  // Fragment, root-relative, path-relative, query-only — unsafe to resolve in iframe
  if (/^[#/?.]/i.test(h)) return null;
  // Explicitly block dangerous schemes even if they somehow reach this point
  if (/^(javascript|data|vbscript):/i.test(h)) return null;
  // Bare domain (e.g. "benchmade.com", "www.example.com/path") — no scheme, has a dot
  if (/^[a-z0-9]/i.test(h) && h.includes('.')) return 'https://' + h;
  return null;
}

// Rewrite anchor hrefs in already-cached HTML — applied at serve-time for emails
// stored before href normalisation was added to sanitizeEmail().
export function rewriteAnchorHrefs(html) {
  if (!html) return html;
  return mapStartTags(html, (tag, attrs) => {
    if (tag !== 'a') return null;
    let changed = false;
    const next = [];
    for (const attr of attrs) {
      if (attr.name.toLowerCase() !== 'href' || attr.value === null) { next.push(attr); continue; }
      const raw = decodeAttr(attr.value);
      const normalized = normalizeHref(raw);
      changed ||= normalized !== raw;
      if (normalized === null) continue; // drop the href attribute
      next.push(normalized === raw ? attr : { name: attr.name, value: encodeAttr(normalized) });
    }
    return changed ? next : null;
  });
}

// eBay's imageser service (svcs.ebay.com/imageser) wraps real product images
// behind a session-authenticated rendering layer.  Cross-site iframe requests
// never carry eBay cookies (SameSite policy), so imageser returns 1 byte instead
// of the actual image.  The real URL is always in the `imageUrl` query parameter
// and is publicly accessible from i.ebayimg.com.  Extract and use it directly.
function unwrapEbayImgUrl(url) {
  if (!url || !url.includes('svcs.ebay.com/imageser')) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'svcs.ebay.com' && u.pathname.startsWith('/imageser/')) {
      const direct = u.searchParams.get('imageUrl');
      if (direct && direct.startsWith('https://')) return direct;
    }
  } catch { /* invalid URL — return as-is */ }
  return url;
}

// Rewrite any eBay imageser src URLs remaining in already-cached HTML.
// Applied at serve-time for emails stored before this fix was deployed.
// The src attribute value in stored HTML has & escaped as &amp;, so we decode
// it before parsing the URL, and encode the direct URL (decoded from the query, so it
// may hold a ") before writing it back.
export function rewriteEbayImageserUrls(html) {
  if (!html || !html.includes('svcs.ebay.com/imageser')) return html;
  return mapStartTags(html, (tag, attrs) => {
    if (tag !== 'img') return null;
    let changed = false;
    const next = attrs.map(attr => {
      if (attr.name.toLowerCase() !== 'src' || attr.value === null) return attr;
      const url = decodeAttr(attr.value);
      const direct = unwrapEbayImgUrl(url);
      if (direct === url) return attr;
      changed = true;
      return { name: attr.name, value: encodeAttr(direct) };
    });
    return changed ? next : null;
  });
}

// Upgrade http:// → https:// inside CSS url() expressions.
// Handles both quoted (url('http://...'), url("http://...")) and unquoted (url(http://...)) forms.
function upgradeStyleUrls(style) {
  if (!style) return style;
  return style.replace(/url\(\s*(['"]?)http:\/\//gi, (_, q) => `url(${q}https://`);
}

// Strip external http/https url() expressions from <style> block CSS at sanitize time.
// This prevents CSS-based exfiltration (loading pixel beacons or fonts) regardless of
// the user's remote image blocking preference.  data: and cid: URIs are left intact.
function stripExternalStyleBlockUrls(html) {
  if (!html) return html;
  return rewriteStyleBlocks(html, asCssReads(stripExternalCssUrls));
}

// Mirrors /url\s*\(\s*(['"]?)https?:\/\/[^)]*\1\s*\)/gi without its backtracking: from every
// candidate, [^)]* ran on to the next `)`, or to the end of the block, and backtracked through
// it, so a crafted <style> held the event loop for seconds. Candidates that reach the same `)`
// can differ in quote, so each one is tested against it, but that `)` and the last non-space
// character before it are found only once.
function stripExternalCssUrls(css) {
  const urlRe = /url\s*\(\s*(['"]?)https?:\/\//gi;
  let out = '';
  let pos = 0;
  let paren = -1;
  let lastNonSpace = -1;
  let m;
  while ((m = urlRe.exec(css)) !== null) {
    const valueStart = urlRe.lastIndex;
    if (paren < valueStart) {
      paren = css.indexOf(')', valueStart);
      if (paren === -1) break;
      lastNonSpace = paren - 1;
      while (lastNonSpace >= valueStart && /\s/.test(css[lastNonSpace])) lastNonSpace--;
    }
    const quote = m[1];
    if (quote && (lastNonSpace < valueStart || css[lastNonSpace] !== quote)) continue;
    out += css.slice(pos, m.index) + 'url()';
    pos = paren + 1;
    urlRe.lastIndex = pos;
  }
  return out + css.slice(pos);
}

// Post-process sanitized HTML to upgrade http:// URLs inside <style> blocks.
// sanitize-html only transforms attributes, not element text content, so <style>
// block CSS must be handled separately after sanitization.
function upgradeStyleBlocks(html) {
  if (!html) return html;
  return rewriteStyleBlocks(html, content => content.replace(/url\(\s*(['"]?)http:\/\//gi, (_, q) => `url(${q}https://`));
}

// Strip dark-mode CSS from a <style> block's text content.
// Targets @media (prefers-color-scheme: dark) blocks, Outlook dark-mode attribute
// selectors, and properties that invert or override the forced-light background.
function stripDarkModeCss(css) {
  // Remove @media (prefers-color-scheme: dark) { ... } blocks.
  let out = stripDarkMediaBlocks(css);
  // Remove rules scoped to Outlook dark-mode attribute selectors
  // (e.g. [data-ogsc], [data-ogsb]).
  out = stripOutlookDarkRules(out);
  // Strip color-scheme declarations — the iframe meta tag controls this instead.
  out = out.replace(/\bcolor-scheme\s*:[^;!}]+;?/gi, '');
  // Strip filter:invert(...) — used to simulate dark mode by inverting the page,
  // which breaks rendering on our forced-white background.
  out = stripInvertFilters(out);
  return out;
}

// The three scanners below mirror the old regexes
//   /@media\b[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gi
//   /\[[^\]]*data-og[^\]]*\][^{]*\{[^}]*\}/gi
//   /\bfilter\s*:\s*invert\([^)]*\)[^;]*;?/gi
// without their backtracking. From every candidate, the leading [^{]*, [^\]]* or [^)]*
// ran on to the next `{`, `]` or `)`, or to the end of the block, and backtracked
// through it, so a crafted <style> of a few tens of KB held the event loop for seconds
// to minutes, and sanitizeEmail runs when sync prefetches a new message. Candidates
// that reach the same `{` or `]` share its outcome, so after one fails the scan resumes
// past it; once the `{`, `]` or `)` a candidate needs is missing, every later candidate
// lacks it too, so the scan stops.
function stripDarkMediaBlocks(css) {
  const atMedia = /@media\b/gi;
  let out = '';
  let pos = 0;
  let m;
  while ((m = atMedia.exec(css)) !== null) {
    const open = css.indexOf('{', atMedia.lastIndex);
    if (open === -1) break;
    const dark = /prefers-color-scheme\s*:\s*dark/i.test(css.slice(atMedia.lastIndex, open));
    const end = dark ? mediaBlockEnd(css, open) : -1;
    if (end === -1) { atMedia.lastIndex = open; continue; }
    out += css.slice(pos, m.index);
    pos = end;
    atMedia.lastIndex = end;
  }
  return out + css.slice(pos);
}

// Index just past the `}` closing the block opened at `open`, allowing one level of
// nested blocks as the old pattern did, or -1 if it is unterminated or nests deeper.
function mediaBlockEnd(css, open) {
  let depth = 1;
  for (let i = open + 1; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 2) return -1;
      depth = 2;
    } else if (css[i] === '}') {
      if (depth === 1) return i + 1;
      depth = 1;
    }
  }
  return -1;
}

function stripOutlookDarkRules(css) {
  let out = '';
  let pos = 0;
  let from = 0;
  for (;;) {
    const lb = css.indexOf('[', from);
    if (lb === -1) break;
    const rb = css.indexOf(']', lb + 1);
    if (rb === -1) break;
    if (!/data-og/i.test(css.slice(lb + 1, rb))) { from = rb + 1; continue; }
    const open = css.indexOf('{', rb + 1);
    if (open === -1) break;
    const close = css.indexOf('}', open + 1);
    if (close === -1) break;
    out += css.slice(pos, lb);
    pos = close + 1;
    from = pos;
  }
  return out + css.slice(pos);
}

function stripInvertFilters(css) {
  const invertRe = /\bfilter\s*:\s*invert\(/gi;
  let out = '';
  let pos = 0;
  let m;
  while ((m = invertRe.exec(css)) !== null) {
    const paren = css.indexOf(')', invertRe.lastIndex);
    if (paren === -1) break;
    const semi = css.indexOf(';', paren + 1);
    const brace = css.indexOf('}', paren + 1);
    out += css.slice(pos, m.index);
    // A declaration without a semicolon must not consume the next CSS rule.
    pos = brace !== -1 && (semi === -1 || brace < semi) ? brace : (semi === -1 ? css.length : semi + 1);
    invertRe.lastIndex = pos;
  }
  return out + css.slice(pos);
}

function stripDarkModeStyleBlocks(html) {
  if (!html) return html;
  return rewriteStyleBlocks(html, stripDarkModeCss);
}

// A URL attribute as the browser reads it: the URL standard drops every tab and line break inside
// a URL and trims control characters and spaces from its ends. Left in, `ht&#x0A;tps://…` hid an
// image from remote-image blocking, which matches the URL as written, while the browser still
// fetched it from the sender.
function asBrowserUrl(value) {
  // eslint-disable-next-line no-control-regex -- the C0 controls the URL standard trims
  return String(value).replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
}

// Sanitize HTML email body — permissive but safe.
export function sanitizeEmail(html) {
  const sanitized = sanitizeHtml(stripEmailHead(html), {
    allowVulnerableTags: true,
    allowedTags: [
      'div','span','p','br','hr',
      'h1','h2','h3','h4','h5','h6',
      'ul','ol','li','dl','dt','dd',
      'table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col',
      'a','img','figure','figcaption',
      'strong','b','em','i','u','s','del','ins','sub','sup','small','big',
      'blockquote','pre','code','tt','kbd','samp',
      'center','font','strike',
      'style',
    ],
    allowedAttributes: {
      '*': ['style', 'class', 'id', 'align', 'valign', 'width', 'height',
             'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing',
             'colspan', 'rowspan', 'nowrap', 'dir', 'lang',
             // 'background' is an old HTML attribute used on table/td/tr for
             // background images — common in marketing emails.
             'background'],
      'a': ['href', 'name', 'target', 'title', 'rel'],
      'img': ['src', 'alt', 'width', 'height', 'border',
              // srcset is required for responsive images — many senders
              // (LinkedIn, etc.) use srcset as the primary image source and
              // put a 1×1 tracking pixel in src as the fallback.  Without
              // srcset, only the tracker is visible.
              'srcset', 'sizes',
              'loading', 'decoding'],
      'table': ['summary'],
      'td': ['abbr', 'axis', 'headers', 'scope'],
      'th': ['abbr', 'axis', 'headers', 'scope'],
    },
    transformTags: {
      // Ensure all links open safely.  Also normalise bare-domain hrefs like
      // "benchmade.com" → "https://benchmade.com" so they work as expected in
      // the sandboxed iframe, and strip relative/fragment hrefs that would
      // otherwise resolve to the mailexpert origin.
      'a': (tagName, attribs) => {
        const out = { ...attribs, rel: 'noopener noreferrer' };
        if ('href' in out) {
          const normalized = normalizeHref(out.href);
          if (normalized === null) delete out.href;
          else out.href = normalized;
        }
        return { tagName, attribs: out };
      },
      // Upgrade http:// → https:// for image sources and inline style url() refs.
      // Many marketing emails still use plain-http image URLs which are blocked as
      // mixed content on an https host, causing images to silently fail.
      'img': (tagName, attribs) => {
        const out = { ...attribs };
        if (out.src)    out.src    = unwrapEbayImgUrl(upgradeUrl(asBrowserUrl(out.src)));
        // Simple regex replacement avoids split(',') corrupting data: URIs that
        // contain commas (e.g. data:image/png;base64,abc 2x).
        if (out.srcset) out.srcset = out.srcset.replace(/\bhttp:\/\//g, 'https://');
        if (out.background) out.background = upgradeUrl(asBrowserUrl(out.background));
        if (out.style) out.style = upgradeStyleUrls(out.style);
        // Defer loading of remote images; skip cid:/data: which are already local.
        const isLocal = out.src && /^(cid:|data:)/i.test(out.src);
        if (!isLocal) out.loading = 'lazy';
        out.decoding = 'async';
        return { tagName, attribs: out };
      },
      // Wildcard: upgrade background attribute and inline style url() for all
      // elements that don't have a specific transform above.  sanitize-html uses
      // the specific-tag transform when one exists and falls back to '*', so this
      // fires for <table>, <td>, <tr>, <div>, <body>, etc. — all the elements
      // that marketing emails (like eBay's) use for table-based background images
      // and CSS background-image declarations.
      '*': (tagName, attribs) => {
        const out = { ...attribs };
        if (out.background) out.background = upgradeUrl(asBrowserUrl(out.background));
        if (out.style) out.style = upgradeStyleUrls(out.style);
        return { tagName, attribs: out };
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'cid', 'data'],
    },
    disallowedTagsMode: 'discard',
  });

  // Upgrade http:// URLs in <style> block CSS content — sanitize-html's transformTags
  // only handles attributes, so CSS url() inside <style> blocks must be fixed afterward.
  // Then strip dark-mode CSS that would override the forced-light rendering environment.
  return stripDarkModeStyleBlocks(upgradeStyleBlocks(stripExternalStyleBlockUrls(sanitized)));
}

// Sanitize user-authored compose body HTML — allows rich formatting and inline
// images (data: or https:) but strips scripts and event handlers.
export function sanitizeComposeBody(html) {
  if (!html) return html;
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del',
      'p', 'br', 'div', 'span', 'img',
      'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
      'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'font', 'center',
    ],
    allowedAttributes: {
      '*': ['style', 'class'],
      'a': ['href', 'target', 'rel'],
      'img': ['src', 'alt', 'width', 'height', 'title'],
      'font': ['color', 'size', 'face'],
      'td': ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor'],
      'th': ['colspan', 'rowspan', 'align', 'valign'],
      'table': ['width', 'cellpadding', 'cellspacing', 'border', 'align', 'bgcolor'],
      'code': ['class'],
    },
    // Every scheme normalizeHref can emit must be listed. Anything it produces that is not
    // allowed gets its href stripped while the <a> survives, which renders as a link but
    // does nothing when clicked.
    allowedSchemes: ['https', 'mailto', 'tel', 'sms', 'cid'],
    allowedSchemesByTag: { img: ['https', 'data'] },
    transformTags: {
      'a': (tagName, attribs) => {
        // Normalise before the scheme filter runs, as sanitizeEmail() already does on the
        // receive path. Without it an http:// href was discarded rather than upgraded to
        // https, and http:// is exactly what the composer emits for a typed bare domain,
        // because Tiptap autolinks with defaultProtocol 'http'. So "example.com" became
        // http://example.com and arrived as an anchor with no destination.
        const out = { ...attribs, rel: 'noopener noreferrer', target: '_blank' };
        if ('href' in out) {
          const normalized = normalizeHref(out.href);
          if (normalized === null) delete out.href;
          else out.href = normalized;
        }
        return { tagName, attribs: out };
      },
    },
    disallowedTagsMode: 'discard',
  });
}

// Sanitize user-authored signature HTML — allows common formatting and images
// but strips all event handlers and scripts. Stricter than sanitizeEmail().
export function sanitizeSignature(html) {
  if (!html) return html;
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del',
      'p', 'br', 'div', 'span', 'img',
      'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'hr',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'font', 'center',
    ],
    allowedAttributes: {
      '*': ['style', 'class'],
      'a': ['href', 'target', 'rel'],
      'img': ['src', 'alt', 'width', 'height'],
      'font': ['color', 'size', 'face'],
      'td': ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor'],
      'th': ['colspan', 'rowspan', 'align', 'valign'],
      'table': ['width', 'cellpadding', 'cellspacing', 'border', 'align', 'bgcolor'],
    },
    // Every scheme normalizeHref can emit must be listed. Anything it produces that is not
    // allowed gets its href stripped while the <a> survives, which renders as a link but
    // does nothing when clicked.
    allowedSchemes: ['https', 'mailto', 'tel', 'sms', 'cid'],
    allowedSchemesByTag: { img: ['https', 'data'] },
    transformTags: {
      'a': (tagName, attribs) => {
        // Normalise before the scheme filter runs, as sanitizeEmail() already does on the
        // receive path. Without it an http:// href was discarded rather than upgraded to
        // https, and http:// is exactly what the composer emits for a typed bare domain,
        // because Tiptap autolinks with defaultProtocol 'http'. So "example.com" became
        // http://example.com and arrived as an anchor with no destination.
        const out = { ...attribs, rel: 'noopener noreferrer', target: '_blank' };
        if ('href' in out) {
          const normalized = normalizeHref(out.href);
          if (normalized === null) delete out.href;
          else out.href = normalized;
        }
        return { tagName, attribs: out };
      },
    },
    disallowedTagsMode: 'discard',
  });
}

// Remote here means http(s) or protocol-relative ("//host/...", which the email frame resolves to
// https); browsers ignore leading whitespace in a URL, so the patterns below do too.

const REMOTE_URL = /^\s*(?:https?:)?\/\//i;
const isCssSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// Every remote URL in CSS text, rewritten by `rewrite(kind, url)`, which returns the text that
// replaces the whole token: kind 'url' for url(...), 'string' for a quoted URL inside image-set(),
// 'import' for an @import rule (through its ';'). Anything else is copied as it is.
//
// One pass from left to right that never reads text twice: every search for a closing character
// remembers where it last looked. Patterns that scan ahead from each candidate (url\(...\)) cost
// time in proportion to candidates times length, and a <style> of 40,000 unclosed url( held the
// event loop for half a minute. Here time grows only with the length of the CSS.
// Case-insensitive needles are searched with regexes over the CSS itself, not over a lowercased
// copy: lowercasing can change the length of a string (İ becomes two characters), and positions in
// the copy would then point at the wrong text.
const CSS_NEEDLES = { 'url(': /url\(/gi, 'image-set(': /image-set\(/gi, '@import': /@import/gi };
const startsWithCi = (text, at, needle) => text.slice(at, at + needle.length).toLowerCase() === needle;

function rewriteCssUrls(css, rewrite) {
  const n = css.length;
  const found = new Map();
  // The next index of `needle` at or after `from`. A result is reused while it still answers the
  // question, so a search never covers the same text twice as long as `from` only grows.
  const next = (needle, from) => {
    const hit = found.get(needle);
    if (hit && hit.from <= from && (hit.at === -1 || hit.at >= from)) return hit.at;
    let at;
    const re = CSS_NEEDLES[needle];
    if (re) {
      re.lastIndex = from;
      const m = re.exec(css);
      at = m ? m.index : -1;
    } else {
      at = css.indexOf(needle, from);
    }
    found.set(needle, { from, at });
    return at;
  };
  // A url( token starting at `start` (the 'u'): its value and the index after its ')', or null.
  const urlToken = (start) => {
    let j = start + 4;
    while (j < n && isCssSpace(css[j])) j += 1;
    let value;
    let k;
    if (css[j] === '"' || css[j] === "'") {
      const close = next(css[j], j + 1);
      if (close === -1) return null;
      value = css.slice(j + 1, close);
      k = close + 1;
    } else {
      k = j;
      while (k < n && css[k] !== ')' && css[k] !== '(' && css[k] !== '"' && css[k] !== "'" && !isCssSpace(css[k])) k += 1;
      value = css.slice(j, k);
    }
    while (k < n && isCssSpace(css[k])) k += 1;
    return css[k] === ')' ? { value, end: k + 1 } : null;
  };

  let out = '';
  let i = 0;
  while (i < n) {
    const candidates = [['url', next('url(', i)], ['set', next('image-set(', i)], ['import', next('@import', i)]]
      .filter(([, at]) => at !== -1);
    if (!candidates.length) break;
    const [kind, at] = candidates.reduce((a, b) => (b[1] < a[1] ? b : a));
    out += css.slice(i, at);
    if (kind === 'url') {
      const token = urlToken(at);
      if (token && REMOTE_URL.test(token.value)) { out += rewrite('url', token.value.trim()); i = token.end; continue; }
      out += css.slice(at, at + 4);
      i = at + 4;
    } else if (kind === 'import') {
      const semi = next(';', at);
      const end = semi === -1 ? n : semi + 1;
      let j = at + 7;
      // Spaces and comments may stand between @import and its URL (@import/**/"https://…").
      for (;;) {
        while (j < end && isCssSpace(css[j])) j += 1;
        if (!css.startsWith('/*', j)) break;
        const close = next('*/', j + 2);
        j = close === -1 ? n : close + 2;
      }
      let target = '';
      if (startsWithCi(css, j, 'url(')) target = urlToken(j)?.value ?? '';
      else if (css[j] === '"' || css[j] === "'") { const close = next(css[j], j + 1); target = close === -1 ? '' : css.slice(j + 1, close); }
      if (REMOTE_URL.test(target)) { out += rewrite('import', target.trim()); i = end; continue; }
      out += css.slice(at, at + 7);
      i = at + 7;
    } else {
      // image-set( ... ): to its matching ')', its quoted URLs and url() tokens rewritten.
      const open = at + 'image-set('.length;
      out += css.slice(at, open);
      let depth = 1;
      let k = open;
      while (k < n && depth > 0) {
        const c = css[k];
        if (c === '"' || c === "'") {
          const close = next(c, k + 1);
          const stop = close === -1 ? n : close + 1;
          const value = css.slice(k + 1, close === -1 ? n : close);
          out += REMOTE_URL.test(value) ? rewrite('string', value.trim()) : css.slice(k, stop);
          k = stop;
        } else if (startsWithCi(css, k, 'url(')) {
          const token = urlToken(k);
          if (token && REMOTE_URL.test(token.value)) { out += rewrite('url', token.value.trim()); k = token.end; }
          else { out += css.slice(k, k + 4); k += 4; depth += 1; }
        } else {
          if (c === '(') depth += 1;
          else if (c === ')') depth -= 1;
          out += c;
          k += 1;
        }
      }
      i = k;
    }
  }
  return out + css.slice(i);
}

// CSS text with its escapes decoded, as the browser's CSS tokenizer decodes them: \75 rl( and
// u\72l( are url(, \68ttps: is https:. A backslash and a newline (a string continuation) go.
function unescapeCss(css) {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g, (_, hex, newline, char) => {
    if (newline !== undefined) return '';
    if (char !== undefined) return char;
    const code = parseInt(hex, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code);
  });
}

// A CSS URL rewrite that also sees URLs hidden behind escapes. CSS without a backslash, or whose
// escapes hide nothing the rewrite changes, is rewritten as written; otherwise the decoded CSS is
// rewritten instead, which may change how its other escapes read: acceptable for CSS that hid a
// remote URL that way. The result is still sealed (rewriteStyleBlocks) or encoded for an attribute.
function asCssReads(rewrite) {
  return (css) => {
    if (css.includes('\\')) {
      const decoded = unescapeCss(css);
      const rewritten = rewrite(decoded);
      if (rewritten !== decoded) return rewritten;
    }
    return rewrite(css);
  };
}

// Remote loads in CSS text made inert: url(...) and quoted URLs in image-set() become data:,
// (which draws nothing) and remote @imports are dropped. url(data:,) carries no quotes, so it is
// safe inside any attribute or style block.
const blockCssUrls = asCssReads((css) =>
  rewriteCssUrls(css, (kind) => (kind === 'import' ? '' : kind === 'url' ? 'url(data:,)' : '"data:,"')));

// An attribute value as written in the HTML, and back. Sanitized HTML writes values in double
// quotes with " as &quot;, & as &amp; and < > as &lt; &gt;; a CSS URL quoted with " is only
// visible once decoded, and what was decoded is encoded again the same way.
const decodeAttr = (v) => v
  .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"').replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
const encodeAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Whether the HTML loads anything remote that blockRemoteImages would stop: exactly when blocking
// would change it, so the two can never disagree.
export function hasRemoteImages(html) {
  if (!html) return false;
  return blockRemoteImages(html) !== html;
}

// Rewrite remote http/https image references so the browser makes no network requests.
// data: and cid: sources are always left intact.
// Never call this on HTML that will be written back to the database — apply only at
// response time so the canonical cached body remains unmodified.
//
// This is the first line only: the email frame also forbids remote images, fonts and media in its
// Content-Security-Policy whenever a body is served blocked (remoteImagesBlocked), which stops what
// no pattern here can foresee (CSS escapes, for one).
export function blockRemoteImages(html) {
  if (!html) return html;

  // Block <img src="https://..."> — replace with a dimension-preserving SVG placeholder
  // so no network request fires.  A plain data:, produces a 0×0 image; emails that use
  // height:auto CSS (like marketing templates) would then collapse all images to 0px tall,
  // making the entire email appear blank.  Reading the explicit width/height attributes
  // lets us generate a grey rectangle that matches the layout slot the author intended.
  //
  // Only real attributes of real tags are read (mapStartTags), each value as the browser reads it
  // (entities decoded, tabs and line breaks dropped), and a tag with nothing to block is left byte
  // for byte.
  const isRemote = (value) => REMOTE_URL.test(asBrowserUrl(decodeAttr(value)));
  const placeholder = (attrs) => {
    const size = (name, fallback) => {
      const attr = attrs.find(a => a.name.toLowerCase() === name && a.value !== null);
      const m = attr && /^\s*(\d+)/.exec(decodeAttr(attr.value));
      return m ? parseInt(m[1], 10) : fallback;
    };
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size('width', 600)}" height="${size('height', 200)}"><rect width="100%" height="100%" fill="#e8e8e8"/></svg>`
    )}`;
  };
  let out = mapStartTags(html, (tag, attrs) => {
    let changed = false;
    const next = [];
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      if (attr.value === null) { next.push(attr); continue; }
      if (tag === 'img' && name === 'src' && isRemote(attr.value)) {
        next.push({ name: attr.name, value: placeholder(attrs) });
        changed = true;
      } else if (tag === 'img' && name === 'srcset' && /(?:^|[\s,])(?:https?:)?\/\//i.test(decodeAttr(attr.value))) {
        changed = true; // a remote candidate drops the whole srcset
      } else if (name === 'background' && isRemote(attr.value)) {
        // Table-based marketing layouts: the background image is blanked.
        next.push({ name: attr.name, value: '' });
        changed = true;
      } else if (name === 'style') {
        // CSS url(https://...) and image-set() in an inline style, read as the browser reads them.
        const css = decodeAttr(attr.value);
        const blocked = blockCssUrls(css);
        if (blocked === css) next.push(attr);
        else { next.push({ name: attr.name, value: encodeAttr(blocked) }); changed = true; }
      } else {
        next.push(attr);
      }
    }
    return changed ? next : null;
  });

  // Block remote CSS loads inside <style> blocks: remote @imports dropped, url(...) and
  // image-set() URLs made inert.
  out = rewriteStyleBlocks(out, blockCssUrls);

  return out;
}
