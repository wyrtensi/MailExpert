import { describe, it, expect } from 'vitest';
import {
  stripEmailHead,
  sealStyleText,
  sanitizeEmail,
  sanitizeSignature,
  sanitizeComposeBody,
  hasRemoteImages,
  blockRemoteImages,
  rewriteEbayImageserUrls,
  rewriteAnchorHrefs,
} from './emailSanitizer.js';

// ── stripEmailHead ─────────────────────────────────────────────────────────

describe('stripEmailHead', () => {
  it('removes <head> and its text content', () => {
    const html = '<html><head><title>Newsletter</title></head><body>Hello</body></html>';
    expect(stripEmailHead(html)).not.toContain('Newsletter');
    expect(stripEmailHead(html)).not.toContain('<title>');
  });

  it('preserves <style> blocks found inside <head>', () => {
    const html = '<head><style>body { color: red; }</style><title>X</title></head><body/>';
    const out = stripEmailHead(html);
    expect(out).toContain('body { color: red; }');
    expect(out).not.toContain('<title>');
  });

  it('strips MSO conditional comments from head styles', () => {
    const html = '<head><style><!--[if gte mso 9]>mso-only{}<![endif]-->real{}</style></head>';
    const out = stripEmailHead(html);
    expect(out).toContain('real{}');
    expect(out).not.toContain('mso-only');
    expect(out).not.toContain('[if gte mso');
  });

  it('returns falsy input unchanged', () => {
    expect(stripEmailHead('')).toBe('');
    expect(stripEmailHead(null)).toBeNull();
    expect(stripEmailHead(undefined)).toBeUndefined();
  });

  it('leaves HTML with no <head> unchanged', () => {
    const html = '<body><p>Hello</p></body>';
    expect(stripEmailHead(html)).toBe(html);
  });
});

// ── sanitizeEmail ──────────────────────────────────────────────────────────

describe('sanitizeEmail — XSS prevention', () => {
  it('strips <script> tags and their content', () => {
    const out = sanitizeEmail('<p>Hi</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips inline event handlers', () => {
    const out = sanitizeEmail('<p onclick="alert(1)">click me</p>');
    expect(out).not.toContain('onclick');
  });

  it('strips javascript: href values', () => {
    const out = sanitizeEmail('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript:');
  });

  it('strips <iframe> tags', () => {
    const out = sanitizeEmail('<iframe src="https://evil.com"></iframe>');
    expect(out).not.toContain('<iframe');
  });

  it('strips <object> and <embed> tags', () => {
    expect(sanitizeEmail('<object data="x.swf"></object>')).not.toContain('<object');
    expect(sanitizeEmail('<embed src="x.swf">')).not.toContain('<embed');
  });
});

describe('sanitizeEmail — link handling', () => {
  it('adds rel="noopener noreferrer" to all links', () => {
    const out = sanitizeEmail('<a href="https://example.com">link</a>');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('preserves valid https href', () => {
    const out = sanitizeEmail('<a href="https://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
  });

  it('preserves mailto href', () => {
    const out = sanitizeEmail('<a href="mailto:user@example.com">email</a>');
    expect(out).toContain('href="mailto:user@example.com"');
  });

  it('upgrades bare domain href to https', () => {
    const out = sanitizeEmail('<a href="benchmade.com">logo</a>');
    expect(out).toContain('href="https://benchmade.com"');
  });

  it('upgrades bare domain with path to https', () => {
    const out = sanitizeEmail('<a href="www.example.com/path?q=1">link</a>');
    expect(out).toContain('href="https://www.example.com/path?q=1"');
  });

  it('upgrades protocol-relative href to https', () => {
    const out = sanitizeEmail('<a href="//example.com/foo">link</a>');
    expect(out).toContain('href="https://example.com/foo"');
  });

  it('upgrades http href to https', () => {
    const out = sanitizeEmail('<a href="http://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).not.toContain('href="http://');
  });

  it('removes root-relative href', () => {
    const out = sanitizeEmail('<a href="/">home</a>');
    expect(out).not.toContain('href="/"');
  });

  it('removes path-relative href', () => {
    const out = sanitizeEmail('<a href="./page">link</a>');
    expect(out).not.toContain('href="./page"');
  });

  it('removes fragment href', () => {
    const out = sanitizeEmail('<a href="#section">link</a>');
    expect(out).not.toContain('href="#section"');
  });

  it('removes empty href', () => {
    const out = sanitizeEmail('<a href="">link</a>');
    expect(out).not.toContain('href=""');
  });
});

// ── rewriteAnchorHrefs ─────────────────────────────────────────────────────

describe('rewriteAnchorHrefs', () => {
  it('upgrades bare domain href to absolute https', () => {
    const out = rewriteAnchorHrefs('<a href="benchmade.com">logo</a>');
    expect(out).toContain('href="https://benchmade.com"');
  });

  it('upgrades bare domain with path', () => {
    const out = rewriteAnchorHrefs('<a href="www.example.com/foo">x</a>');
    expect(out).toContain('href="https://www.example.com/foo"');
  });

  it('upgrades protocol-relative href', () => {
    const out = rewriteAnchorHrefs('<a href="//example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
  });

  it('removes root-relative href', () => {
    const out = rewriteAnchorHrefs('<a href="/">x</a>');
    expect(out).not.toContain('href="/"');
  });

  it('leaves absolute https href unchanged', () => {
    const html = '<a href="https://example.com">x</a>';
    expect(rewriteAnchorHrefs(html)).toBe(html);
  });

  it('leaves mailto href unchanged', () => {
    const html = '<a href="mailto:a@b.com">x</a>';
    expect(rewriteAnchorHrefs(html)).toBe(html);
  });

  it('handles multiple anchors in one pass', () => {
    const out = rewriteAnchorHrefs(
      '<a href="benchmade.com">logo</a> <a href="https://safe.com">safe</a> <a href="/">bad</a>'
    );
    expect(out).toContain('href="https://benchmade.com"');
    expect(out).toContain('href="https://safe.com"');
    expect(out).not.toContain('href="/"');
  });

  it('rewrites only a real href, never href text inside a title', () => {
    const html = `<a title=" href='/x' onclick=alert(1) " href="https://ok.example/">x</a>`;
    expect(rewriteAnchorHrefs(html)).toBe(html);
  });

  it('returns falsy input unchanged', () => {
    expect(rewriteAnchorHrefs(null)).toBeNull();
    expect(rewriteAnchorHrefs('')).toBe('');
  });
});

describe('sanitizeEmail — image handling', () => {
  it('upgrades http:// img src to https://', () => {
    const out = sanitizeEmail('<img src="http://example.com/img.jpg">');
    expect(out).toContain('src="https://example.com/img.jpg"');
    expect(out).not.toContain('src="http://');
  });

  it('upgrades http:// in srcset to https://', () => {
    const out = sanitizeEmail('<img srcset="http://example.com/img.jpg 2x">');
    expect(out).not.toContain('srcset="http://');
  });

  it('adds loading="lazy" to remote images', () => {
    const out = sanitizeEmail('<img src="https://example.com/img.jpg">');
    expect(out).toContain('loading="lazy"');
  });

  it('does not add loading="lazy" to cid: images', () => {
    const out = sanitizeEmail('<img src="cid:part1@msg">');
    expect(out).not.toContain('loading="lazy"');
  });

  it('does not add loading="lazy" to data: images', () => {
    const out = sanitizeEmail('<img src="data:image/png;base64,abc">');
    expect(out).not.toContain('loading="lazy"');
  });

  it('unwraps eBay imageser URLs to the direct image URL', () => {
    const ebayUrl = 'https://svcs.ebay.com/imageser/1/render?imageUrl=https://i.ebayimg.com/thumb.jpg&w=200';
    const out = sanitizeEmail(`<img src="${ebayUrl}">`);
    expect(out).toContain('i.ebayimg.com');
    expect(out).not.toContain('svcs.ebay.com');
  });
});

describe('sanitizeEmail — CSS upgrades', () => {
  it('upgrades http:// url() in inline styles', () => {
    const out = sanitizeEmail('<div style="background:url(http://example.com/bg.jpg)">x</div>');
    expect(out).not.toContain('url(http://');
    expect(out).toContain('url(https://');
  });

  it('strips external url() in <style> blocks', () => {
    const out = sanitizeEmail('<style>body{background:url(http://example.com/bg.jpg)}</style>');
    expect(out).not.toContain('url(http://');
    expect(out).not.toContain('url(https://');
    expect(out).toContain('url()');
  });

  it('strips quoted and spaced external url() in <style> blocks and keeps data: and cid:', () => {
    const out = sanitizeEmail(`<style>.a{background:URL( "https://t.example/a.gif" )}.b{background:url('http://t.example/b.gif')}.c{background:url(data:image/gif;base64,R0lGOD)}.d{background:url(cid:logo)}</style>`);
    expect(out).toBe('<style>.a{background:url()}.b{background:url()}.c{background:url(data:image/gif;base64,R0lGOD)}.d{background:url(cid:logo)}</style>');
  });
});

describe('sanitizeEmail — dark-mode CSS', () => {
  it('removes prefers-color-scheme: dark media blocks and keeps other media queries', () => {
    const out = sanitizeEmail('<style>@media screen and (max-width:600px){.col{width:100%}}.a{b:c}@media (prefers-color-scheme: dark){.a{b:d}.x{y:z}}.e{f:g}</style><p>x</p>');
    expect(out).toBe('<style>@media screen and (max-width:600px){.col{width:100%}}.a{b:c}.e{f:g}</style><p>x</p>');
  });

  it('removes rules scoped to Outlook [data-og*] dark-mode selectors', () => {
    const out = sanitizeEmail('<style>a[href]{color:red}[data-ogsc] .h{color:#fff !important}[data-ogsb] .h{background:#000}.k{l:m}</style>');
    expect(out).toBe('<style>a[href]{color:red}.k{l:m}</style>');
  });

  it('removes color-scheme declarations and filter: invert()', () => {
    const out = sanitizeEmail('<style>:root{color-scheme:light dark}.r{filter:invert(1) hue-rotate(180deg);s:t}.q{filter:blur(2px)}</style>');
    expect(out).toBe('<style>:root{}.r{s:t}.q{filter:blur(2px)}</style>');
  });
});

describe('sanitizeEmail — crafted <style> CSS', () => {
  // Fastest of two runs so a GC pause or cold JIT cannot flake CI. Each input took
  // 5 to 9 seconds per run when these passes were backtracking regexes.
  function fastestRunMs(fn, runs) {
    let fastest = Infinity;
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      fn();
      fastest = Math.min(fastest, performance.now() - start);
    }
    return fastest;
  }

  it('stays linear on input crafted against each pass', () => {
    // Each input holds the `)`, `{` or `]` its old regex needed, where the regex could not
    // use it, so skipping a pass only when that character is absent still fails here.
    const crafted = {
      url: 'url("https://'.repeat(20000) + ')',
      media: '@media (prefers-color-scheme: dark) '.repeat(1500) + '{',
      outlook: '[data-og '.repeat(2500) + ']{',
      invert: ')' + 'filter:invert('.repeat(60000),
    };
    for (const [name, css] of Object.entries(crafted)) {
      const html = `<style>${css}</style>`;
      expect(fastestRunMs(() => sanitizeEmail(html), 2), name).toBeLessThan(1000);
    }
  });
});

describe('sanitizeEmail — draft signature wrapper (#432)', () => {
  // A draft re-fetched from IMAP goes through sanitizeEmail before the composer reopens
  // it. The frontend splitter needs the wrapper to come back unchanged to find it.
  it('keeps the marked signature wrapper byte-for-byte', () => {
    const wrapper = '<div class="mailexpert-signature" style="margin-top:16px;color:#555;font-size:13px"><b>Sig</b></div>';
    expect(sanitizeEmail(`<p>hello</p>${wrapper}<div>quote</div>`)).toBe(`<p>hello</p>${wrapper}<div>quote</div>`);
  });

  it('keeps the legacy unmarked wrapper style byte-for-byte', () => {
    const legacy = '<div style="margin-top:16px;color:#555;font-size:13px"><b>Sig</b></div>';
    expect(sanitizeEmail(`<p>hello</p>${legacy}`)).toBe(`<p>hello</p>${legacy}`);
  });
});

// ── hasRemoteImages ────────────────────────────────────────────────────────

describe('hasRemoteImages', () => {
  it('detects https img src', () => {
    expect(hasRemoteImages('<img src="https://example.com/x.jpg">')).toBe(true);
  });

  it('detects http img src', () => {
    expect(hasRemoteImages('<img src="http://example.com/x.jpg">')).toBe(true);
  });

  it('detects https in srcset', () => {
    expect(hasRemoteImages('<img srcset="https://example.com/x.jpg 2x">')).toBe(true);
  });

  it('detects background attribute', () => {
    expect(hasRemoteImages('<table background="https://example.com/bg.jpg">')).toBe(true);
  });

  it('detects url() in CSS', () => {
    expect(hasRemoteImages('<style>div{background:url(https://example.com/bg.jpg)}</style>')).toBe(true);
  });

  it('detects @import with bare URL', () => {
    expect(hasRemoteImages('<style>@import "https://fonts.googleapis.com/css";</style>')).toBe(true);
  });

  it('returns false for no remote images', () => {
    expect(hasRemoteImages('<p>Hello world</p>')).toBe(false);
  });

  it('returns false for cid: images', () => {
    expect(hasRemoteImages('<img src="cid:part1@msg">')).toBe(false);
  });

  it('returns false for data: images', () => {
    expect(hasRemoteImages('<img src="data:image/png;base64,abc">')).toBe(false);
  });

  it('returns false for null/empty', () => {
    expect(hasRemoteImages(null)).toBe(false);
    expect(hasRemoteImages('')).toBe(false);
  });
});

// ── blockRemoteImages ──────────────────────────────────────────────────────

describe('blockRemoteImages', () => {
  it('replaces remote img src with an SVG placeholder', () => {
    const out = blockRemoteImages('<img src="https://example.com/tracker.png">');
    expect(out).toContain('src="data:image/svg+xml,');
    expect(out).not.toContain('example.com');
  });

  it('removes srcset containing remote URLs', () => {
    const out = blockRemoteImages('<img src="data:," srcset="https://example.com/img.jpg 2x">');
    expect(out).not.toContain('srcset=');
  });

  it('preserves srcset that contains no remote URLs', () => {
    const out = blockRemoteImages('<img srcset="cid:part1 2x">');
    expect(out).toContain('srcset=');
  });

  it('blanks remote background attribute', () => {
    const out = blockRemoteImages('<table background="https://example.com/bg.jpg">');
    expect(out).toContain('background=""');
    expect(out).not.toContain('example.com');
  });

  it('blocks url() in inline style attributes', () => {
    const out = blockRemoteImages('<div style="background:url(https://example.com/bg.jpg)">');
    expect(out).not.toContain('example.com');
    expect(out).toContain('url(data:,)');
  });

  it('strips @import in <style> blocks', () => {
    const out = blockRemoteImages('<style>@import "https://fonts.googleapis.com/css"; body{}</style>');
    expect(out).not.toContain('@import');
    expect(out).toContain('body{}');
  });

  it('replaces url() in <style> blocks with data:,', () => {
    const out = blockRemoteImages('<style>div{background:url(https://example.com/bg.jpg)}</style>');
    expect(out).not.toContain('example.com');
    expect(out).toContain('url(data:,)');
  });

  it('leaves cid: images intact', () => {
    const html = '<img src="cid:part1@msg">';
    expect(blockRemoteImages(html)).toContain('src="cid:part1@msg"');
  });

  it('leaves data: images intact', () => {
    const html = '<img src="data:image/png;base64,abc">';
    expect(blockRemoteImages(html)).toContain('src="data:image/png;base64,abc"');
  });

  it('returns null/undefined unchanged', () => {
    expect(blockRemoteImages(null)).toBeNull();
    expect(blockRemoteImages(undefined)).toBeUndefined();
  });

  // Protocol-relative URLs ("//host/x"): the email frame resolves them to https, so they load like
  // any remote URL and must be blocked like one. They used to slip through every rule.
  it.each([
    ['img src', '<img src="//tracker.example/p.gif" width="1" height="1">'],
    ['img src with leading space', '<img src=" //tracker.example/p.gif">'],
    ['srcset', '<img src="data:," srcset="//tracker.example/b.png 2x">'],
    ['background attribute', '<table background="//tracker.example/bg.png"><tr><td>x</td></tr></table>'],
    ['inline style', '<div style="background:url(//tracker.example/i.png)">x</div>'],
    ['style block', '<style>.h{background:url(//tracker.example/s.png)}</style>'],
    ['style block @import', '<style>@import url(//tracker.example/s.css); p{}</style>'],
  ])('blocks a protocol-relative URL in %s', (_, html) => {
    expect(blockRemoteImages(html)).not.toContain('tracker.example');
  });

  // Sanitized HTML writes a double quote inside an attribute as &quot;, so a URL the email quoted
  // with " was not recognized in an inline style and loaded anyway.
  it('blocks an inline style URL quoted with &quot;', () => {
    const out = blockRemoteImages('<div style="background-image:url(&quot;https://tracker.example/h.png&quot;);background-color:#ffffff">x</div>');
    expect(out).toBe('<div style="background-image:url(data:,);background-color:#ffffff">x</div>');
  });

  it('blocks a quoted URL that contains parentheses', () => {
    const out = blockRemoteImages('<style>.h{background:url("https://tracker.example/a(1).png")}</style>');
    expect(out).toBe('<style>.h{background:url(data:,)}</style>');
  });

  it('blocks URLs in image-set()', () => {
    const out = blockRemoteImages('<div style="background-image:image-set(&quot;https://tracker.example/a.png&quot; 1x, url(https://tracker.example/b.png) 2x)">x</div>');
    expect(out).not.toContain('tracker.example');
  });

  // The replacement used to be url("data:,"), whose quotes ended the double-quoted style attribute:
  // everything after a blocked background image (its color, the text color, padding) was lost.
  it.each([
    ['unquoted', 'url(https://example.com/h.png)'],
    ['single-quoted', "url('https://example.com/h.png')"],
    ['double-quoted', 'url(&quot;https://example.com/h.png&quot;)'],
  ])('keeps the rest of an inline style after a blocked %s URL', (_, url) => {
    const out = blockRemoteImages(`<div style="background-image:${url};background-color:#ffffff;color:#222222;padding:40px">A</div>`);
    expect(out).toBe('<div style="background-image:url(data:,);background-color:#ffffff;color:#222222;padding:40px">A</div>');
  });

  it('keeps a single-quoted style attribute well formed', () => {
    const out = blockRemoteImages(`<div style='background:url("https://example.com/h.png");color:red'>x</div>`);
    expect(out).toBe('<div style="background:url(data:,);color:red">x</div>');
  });

  it('leaves a style with nothing remote exactly as it was', () => {
    const html = '<div style="font-family:&quot;Helvetica Neue&quot;, Arial;background:url(data:image/png;base64,AAAA)">x</div>';
    expect(blockRemoteImages(html)).toBe(html);
  });

  it('leaves relative and same-page URLs alone', () => {
    const html = '<div style="background:url(/local.png)"><a href="#top">x</a></div><style>p{background:url(img/a.png)}</style>';
    expect(blockRemoteImages(html)).toBe(html);
  });

  it('keeps &lt; and &gt; in an inline style it rewrites', () => {
    const html = '<div style="background:url(https://example.com/a.png);font-family:&quot;A&lt;B&gt;&quot;">x</div>';
    expect(blockRemoteImages(html)).toBe('<div style="background:url(data:,);font-family:&quot;A&lt;B&gt;&quot;">x</div>');
  });
});

// Detection is defined as "blocking would change something", so the two cannot disagree: a body
// that needs blocking is always detected, and the blocked-images notice always shows for it.
// Blocking runs on sanitized HTML and must rewrite only real attributes of real tags. sanitize-html
// writes values in double quotes and leaves ' as it is, so attribute-looking text inside another
// attribute's value (or in the text) matched the old patterns, and the rewrite's own quotes closed
// that value: a javascript: href or an onerror handler came out as a real attribute.
describe('blockRemoteImages rewrites only real attributes', () => {
  const pipeline = (html) => blockRemoteImages(sanitizeEmail(html));

  it.each([
    ['style text in a title', `<div title=" style='background:url(https://e.example/x)' onmouseover=alert(1) ">hi</div>`],
    ['style text in a link title', `<a href="https://ok.example/" title=" style='background:url(//e.example/x)' href=javascript:alert(1) ">click</a>`],
    ['style text in a title, no href', `<a title=" style='background:url(//e.example/x)' href=javascript:alert(1) ">click</a>`],
    ['src text in an alt', `<img alt=" src='https://e.example/a' onerror=alert(1) " src="cid:x">`],
    ['style text in the body text', `<p> style="background:url(https://e.example/x)" </p>`],
  ])('leaves %s alone', (_, html) => {
    const sanitized = sanitizeEmail(html);
    expect(blockRemoteImages(sanitized)).toBe(sanitized);
    expect(hasRemoteImages(sanitized)).toBe(false);
  });

  it('blocks a real src with an apostrophe in its URL and keeps the alt as it was', () => {
    const out = pipeline(`<img alt=" src='https://e.example/a'" src="https://e.example/b'c.png">`);
    expect(out).toContain(`alt=" src='https://e.example/a'"`);
    expect(out).not.toContain("b'c.png");
    expect(out).toContain('src="data:image/svg+xml,');
  });

  it('blocks a srcset with an apostrophe in its URL', () => {
    const out = pipeline(`<img srcset="https://e.example/x'y.png 1x">`);
    expect(out).not.toContain('e.example');
  });

  it('blocks a remote background behind a line break in the scheme, in a body stored before it was trimmed', () => {
    const out = blockRemoteImages('<table background="ht\ntps://e.example/bg.png"><tr><td>x</td></tr></table>');
    expect(out).not.toContain('e.example');
  });
});

// CSS escapes: the browser decodes \75 rl( to url( and u\72l( to url(, which no url( pattern reads.
// With blocking on, CSS that hides a remote URL behind escapes is blocked as the browser reads it.
describe('blockRemoteImages and CSS escapes', () => {
  it.each([
    ['an escaped url( in an inline style', `<div style="background:\\75 rl(https://e.example/x)">x</div>`],
    ['an escaped letter in url(', `<div style="background:u\\72l(https://e.example/x)">x</div>`],
    ['an escaped scheme', `<div style="background:url(\\68ttps://e.example/x)">x</div>`],
  ])('blocks %s', (_, html) => {
    const sanitized = sanitizeEmail(html);
    expect(hasRemoteImages(sanitized)).toBe(true);
    expect(blockRemoteImages(sanitized)).not.toContain('e.example');
  });

  it('blocks an escaped url( in a style block of a body stored as it is', () => {
    expect(blockRemoteImages('<style>p{background:\\75 rl(//e.example/x)}</style>')).toBe('<style>p{background:url(data:,)}</style>');
  });

  // Style blocks lose external url()s at sanitize time whatever the image preference; an escape
  // hid one from that too.
  it('sanitizing strips an external url() hidden behind escapes from a style block', () => {
    expect(sanitizeEmail('<style>p{background:\\75 rl(https://e.example/x)}</style>')).toBe('<style>p{background:url()}</style>');
  });

  it('leaves escapes alone when nothing remote hides behind them', () => {
    const html = '<style>p::before{content:"\\201C"}</style>';
    expect(blockRemoteImages(html)).toBe(html);
  });

  it('strips an @import written with a comment before its URL', () => {
    expect(blockRemoteImages('<style>@import/**/"https://e.example/x.css";p{}</style>')).toBe('<style>p{}</style>');
  });
});

describe('hasRemoteImages and blockRemoteImages agree', () => {
  it.each([
    '<img src="//tracker.example/p.gif">',
    '<table background="//tracker.example/bg.png">',
    '<div style="background:url(&quot;https://tracker.example/h.png&quot;)">x</div>',
    '<div style="background-image:image-set(&quot;https://tracker.example/a.png&quot; 1x)">x</div>',
    '<style>.h{background:url(//tracker.example/s.png)}</style>',
  ])('detects %s', (html) => {
    expect(hasRemoteImages(html)).toBe(true);
    expect(hasRemoteImages(blockRemoteImages(html))).toBe(false);
  });
});

// A crafted <style> made every url( pattern scan to the end of the block from each candidate: 40,000
// unclosed url(// held the event loop for half a minute per call, and the body route calls both.
// The CSS scanner reads the text once; these would take seconds again if that regressed.
describe('remote image blocking stays fast on hostile CSS', () => {
  const n = 40000;
  it.each([
    ['unclosed url(//', `<style>${'a{background:url(//x'.repeat(n)}</style>`],
    ['unclosed url(https://', `<style>${'a{background:url(https://x'.repeat(n)}</style>`],
    ['unclosed quoted url(', `<style>${'a{background:url("//x'.repeat(n)}</style>`],
    ['unclosed image-set(', `<style>${'a{b:image-set("//x" '.repeat(n)}</style>`],
    ['image-set( without strings', `<style>${'a{b:image-set('.repeat(n)}</style>`],
    ['unclosed @import', `<style>${'@import url("//x '.repeat(n)}</style>`],
    ['url( with nothing remote', `<style>${'a{background:url(x'.repeat(n)}</style>`],
    ['unclosed url( in an inline style', `<div style="${'background:url(https://x'.repeat(n)}">x</div>`],
    ['escaped unclosed url(', `<style>${'a{background:\\75 rl(//x'.repeat(n)}</style>`],
    ['@import with unclosed comments', `<style>${'@import/*'.repeat(n)}</style>`],
    ['many unterminated attributes', `<img alt="${" src='//a".repeat(n)}" src="cid:x">`],
  ])('%s', (_, html) => {
    const started = performance.now();
    hasRemoteImages(html);
    blockRemoteImages(html);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

// The clean-ups that run on <style> text after sanitize-html delete parts of the CSS, and a deletion
// joins the text around it: `</` before a removed declaration and `style>` after it made a real end
// tag, so CSS text the allowlist never saw as markup came out of the sanitizer as markup.
describe('style blocks stay closed after the dark-mode and URL clean-ups', () => {
  const ELEMENTS = /<(a|form|input|base|img)\b/i;
  // The markup outside every <style> block, where the HTML parser would build elements.
  const outsideStyles = (html) => {
    let out = '';
    let pos = 0;
    const open = /<style\b[^>]*>/gi;
    let m;
    while ((m = open.exec(html))) {
      out += html.slice(pos, m.index);
      const close = html.toLowerCase().indexOf('</style', open.lastIndex);
      pos = close === -1 ? html.length : html.indexOf('>', close) + 1;
      open.lastIndex = pos;
    }
    return out + html.slice(pos);
  };

  it.each([
    ['an invert() filter', '<style>p{color:red}</filter:invert(1);style><a href="javascript:alert(1)">x</a><form action=https://evil.example><input name=p></form><base href="https://evil.example/"></style><p>after</p>'],
    ['a color-scheme declaration', '<style>p{color:red}</color-scheme:dark;style><img src=x onerror=alert(1)><base href="https://evil.example/"></style><p>after</p>'],
    ['a dark @media block', '<style>p{color:red}</@media (prefers-color-scheme: dark){p{color:#fff}}style><a href="javascript:alert(1)">x</a></style><p>after</p>'],
    ['an Outlook dark rule', '<style>p{color:red}</[data-ogsc] .h{color:#fff}style><a href="javascript:alert(1)">x</a></style><p>after</p>'],
    ['an external url()', '<style>p{color:red}</url(https://evil.example/x.png)style><a href="javascript:alert(1)">x</a></style><p>after</p>'],
  ])('removing %s cannot close the block early', (_label, html) => {
    const out = sanitizeEmail(html);
    expect(outsideStyles(out)).not.toMatch(ELEMENTS);
    expect(out).toContain('<p>after</p>');
  });

  it('a blocked url() in a style block cannot close it early either', () => {
    const out = blockRemoteImages('<style>p{color:red}</@import "https://evil.example/a.css";style><a href="javascript:alert(1)">x</a></style><p>after</p>');
    expect(outsideStyles(out)).not.toMatch(ELEMENTS);
  });

  it('sealing leaves ordinary CSS as it was, and a sealed body as it is', () => {
    expect(sealStyleText('p{color:red} a:hover{color:blue}')).toBe('p{color:red} a:hover{color:blue}');
    expect(sealStyleText('x</STYLE')).toBe('x<\\/STYLE');
    expect(sealStyleText('<style')).toBe('<\\style');
    const once = sanitizeEmail('<style>p{color:red}</filter:invert(1);style><a href="javascript:alert(1)">x</a></style><p>after</p>');
    expect(sanitizeEmail(once)).toBe(once);
  });
});

// The URL standard drops tabs and line breaks inside a URL and trims control characters from its
// ends. An image written `ht&#x0A;tps://…` was not recognized by remote-image blocking, while the
// browser still fetched it from the sender.
describe('image URLs are read as the browser reads them', () => {
  it.each([
    ['a line break in the scheme', '<img src="ht&#x0A;tps://evil.example/a.gif">'],
    ['a tab and a leading space', '<img src=" &#x09;https://evil.example/a.gif">'],
    ['a carriage return in a background', '<table><tr><td background="ht&#x0D;tps://evil.example/a.gif">x</td></tr></table>'],
  ])('%s is blocked like any remote image', (_label, html) => {
    const out = sanitizeEmail(html);
    expect(out).toContain('https://evil.example/a.gif');
    expect(blockRemoteImages(out)).not.toContain('evil.example');
  });
});

// Searching a lowercased copy put positions off by one per İ (its lowercase is two characters), so
// in Turkish mail a later <style> could be skipped and text cut at the wrong place.
describe('text whose lowercase is longer', () => {
  const many = 'İ'.repeat(30);

  it('still blocks the remote URL in a later style block, and keeps the text around it', () => {
    const html = `<p>${many}</p><style>.a{color:red}</style><p>between</p><style>.h{background:url(//x.example/a.png)}</style><p>after</p>`;
    expect(blockRemoteImages(html)).toBe(`<p>${many}</p><style>.a{color:red}</style><p>between</p><style>.h{background:url(data:,)}</style><p>after</p>`);
  });

  it('strips an Outlook-only block from the head without eating what follows', () => {
    const out = stripEmailHead(`<html><head><title>${many}</title><!--[if mso]><style>.m{}</style><![endif]--><style>.keep{color:blue}</style></head><body>x</body></html>`);
    expect(out).not.toContain('.m{}');
    expect(out).toContain('<style>.keep{color:blue}</style>');
  });
});

// ── rewriteEbayImageserUrls ────────────────────────────────────────────────

describe('rewriteEbayImageserUrls', () => {
  it('rewrites eBay imageser src to the direct imageUrl', () => {
    const html = '<img src="https://svcs.ebay.com/imageser/1/render?imageUrl=https://i.ebayimg.com/t.jpg&amp;w=200">';
    const out = rewriteEbayImageserUrls(html);
    expect(out).toContain('i.ebayimg.com');
    expect(out).not.toContain('svcs.ebay.com');
  });

  it('leaves non-eBay URLs unchanged', () => {
    const html = '<img src="https://example.com/img.jpg">';
    expect(rewriteEbayImageserUrls(html)).toBe(html);
  });

  it('returns HTML without imageser unchanged (fast path)', () => {
    const html = '<p>No images here</p>';
    expect(rewriteEbayImageserUrls(html)).toBe(html);
  });

  // The direct URL comes from the query, decoded, so it can hold a " that would close the attribute.
  it('writes a direct URL with a quote in it back as one attribute value', () => {
    const html = '<img src="https://svcs.ebay.com/imageser/1/r?imageUrl=https://i.ebayimg.com/a%22onerror%3Dalert(1)%20x">';
    const out = rewriteEbayImageserUrls(html);
    expect(out).toBe('<img src="https://i.ebayimg.com/a&quot;onerror=alert(1) x">');
  });

  it('leaves src text inside another attribute alone', () => {
    const html = `<img alt=" src='https://svcs.ebay.com/imageser/1/r?imageUrl=https://i.ebayimg.com/a%22onerror%3Dalert(1)%20x' " src="cid:x">`;
    expect(rewriteEbayImageserUrls(html)).toBe(html);
  });
});

// ── sanitizeComposeBody ────────────────────────────────────────────────────

describe('sanitizeComposeBody', () => {
  it('preserves inline data: images from the compose editor', () => {
    const html = '<p><span style="font-size:14px"><img src="data:image/png;base64,abc123" width="200">test</span></p>';
    const out = sanitizeComposeBody(html);
    expect(out).toContain('src="data:image/png;base64,abc123"');
    expect(out).toContain('test');
  });

  it('preserves https:// images', () => {
    const html = '<img src="https://example.com/photo.jpg" alt="photo">';
    const out = sanitizeComposeBody(html);
    expect(out).toContain('src="https://example.com/photo.jpg"');
    expect(out).toContain('alt="photo"');
  });

  it('strips http:// images (only https and data allowed)', () => {
    const out = sanitizeComposeBody('<img src="http://example.com/tracker.png">');
    expect(out).not.toContain('src="http://');
  });

  it('strips <script> tags', () => {
    const out = sanitizeComposeBody('<p>Hi</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('Hi');
  });

  it('returns falsy input unchanged', () => {
    expect(sanitizeComposeBody(null)).toBeNull();
    expect(sanitizeComposeBody('')).toBe('');
  });
});

// ── sanitizeSignature ──────────────────────────────────────────────────────

describe('sanitizeSignature', () => {
  it('strips <script> tags', () => {
    const out = sanitizeSignature('<b>Name</b><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips event handlers', () => {
    const out = sanitizeSignature('<b onclick="alert(1)">Name</b>');
    expect(out).not.toContain('onclick');
  });

  it('adds rel and target to links', () => {
    const out = sanitizeSignature('<a href="https://example.com">Site</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('strips http:// links (only https allowed)', () => {
    const out = sanitizeSignature('<a href="http://example.com">link</a>');
    expect(out).not.toContain('href="http://');
  });

  it('allows https:// and mailto: links', () => {
    const out = sanitizeSignature(
      '<a href="https://example.com">web</a> <a href="mailto:a@b.com">email</a>'
    );
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="mailto:a@b.com"');
  });

  it('returns falsy input unchanged', () => {
    expect(sanitizeSignature(null)).toBeNull();
    expect(sanitizeSignature('')).toBe('');
  });
});

// ── outgoing hrefs must survive the send path ───────────────────────────────────────────
//
// A disallowed scheme makes sanitize-html drop the href attribute but keep the <a>, so the
// result renders and styles as a link yet does nothing when clicked. That is worse than
// dropping the anchor outright, because nothing looks wrong until a recipient tries it.
// The composer autolinks a typed bare domain as http:// (Tiptap's defaultProtocol), which
// is precisely the case that used to be gutted.

describe('sanitizeComposeBody link hrefs', () => {
  const hrefOf = (html) => (html.match(/href="([^"]*)"/) || [])[1] ?? null;

  it('upgrades an http:// link instead of stripping its href', () => {
    const out = sanitizeComposeBody('<p><a href="http://example.com">example.com</a></p>');
    expect(hrefOf(out)).toBe('https://example.com');
  });

  it('keeps an https:// link untouched', () => {
    const out = sanitizeComposeBody('<p><a href="https://example.com/x?y=1">x</a></p>');
    expect(hrefOf(out)).toBe('https://example.com/x?y=1');
  });

  it('resolves a bare domain to https', () => {
    const out = sanitizeComposeBody('<p><a href="example.com">example.com</a></p>');
    expect(hrefOf(out)).toBe('https://example.com');
  });

  it('keeps mailto and tel links clickable', () => {
    expect(hrefOf(sanitizeComposeBody('<a href="mailto:a@b.com">m</a>'))).toBe('mailto:a@b.com');
    expect(hrefOf(sanitizeComposeBody('<a href="tel:+15551234">t</a>'))).toBe('tel:+15551234');
  });

  it('never emits an anchor that has lost its href', () => {
    // The actual defect: a styled link with nowhere to go. Either the href survives in a
    // usable form, or normalizeHref rejected it and we expect no href at all.
    for (const href of ['http://example.com', 'https://example.com', 'example.com',
                        'www.example.com/path', 'mailto:a@b.com', 'tel:+15551234']) {
      const out = sanitizeComposeBody(`<p><a href="${href}">text</a></p>`);
      expect(hrefOf(out), `href "${href}" was stripped`).not.toBe(null);
    }
  });

  it('still refuses dangerous and unresolvable hrefs', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '#anchor', '/relative']) {
      const out = sanitizeComposeBody(`<p><a href="${href}">text</a></p>`);
      expect(hrefOf(out)).toBe(null);
      expect(out).not.toMatch(/javascript:|vbscript:|data:text/i);
    }
  });

  it('applies the same rules to signatures', () => {
    expect(hrefOf(sanitizeSignature('<a href="http://example.com">site</a>'))).toBe('https://example.com');
    expect(hrefOf(sanitizeSignature('<a href="javascript:alert(1)">x</a>'))).toBe(null);
  });
});
