// The whole conversation stacked under an open letter (components/ConversationThread.jsx). Pure
// helpers: no DOM, no store, no network, so they run under `node --test`.

// A reply's own text and the quoted history under it. The quote starts at the attribution line a
// mail client writes above it after a blank line ("On ... wrote:", "... написал(а):", our "---"
// form) or, without
// one, at the first run of "> " lines. A forwarded message is content, not history: never split.
const ATTRIBUTION_RE = /\n\n(?:---\n)?(?:On [^\n]{1,300} wrote:|[^\n]{1,300} написал(?:\(а\)|а)?:)[ \t]*\n/;
const QUOTED_LINES_RE = /\n>[^\n]*(?:\n>[^\n]*|\n[ \t]*)*$/;

export function splitTextQuote(text) {
  const value = String(text ?? '');
  const attribution = value.search(ATTRIBUTION_RE);
  if (attribution > 0) return { main: value.slice(0, attribution).trimEnd(), quote: value.slice(attribution + 2) };
  const quoted = value.search(QUOTED_LINES_RE);
  if (quoted > 0) return { main: value.slice(0, quoted).trimEnd(), quote: value.slice(quoted + 1) };
  return { main: value, quote: '' };
}

// CSS that hides the quoted history in an HTML letter: Gmail's quote block, cited blockquotes,
// our own quote header and everything after it, Outlook's reply header and what follows it.
export const HIDE_QUOTE_CSS = `
  .gmail_quote, .gmail_quote_container, blockquote[type="cite"], .moz-cite-prefix,
  [data-mailexpert-quote-header], [data-mailexpert-quote-header] ~ *,
  #divRplyFwdMsg, #divRplyFwdMsg ~ *, #appendonsend ~ * { display: none !important; }
`;

// Whether an HTML letter carries quoted history that HIDE_QUOTE_CSS would hide.
export function htmlHasQuote(html) {
  return /class=["'][^"']*(?:gmail_quote|moz-cite-prefix)|<blockquote[^>]*\btype=["']cite["']|data-mailexpert-quote-header|id=["'](?:divRplyFwdMsg|appendonsend)["']/i.test(String(html ?? ''));
}

// The srcdoc for one stacked letter: the same sandboxing as the open letter (no scripts, links
// open outside), the interface font, a white page, and the quote hidden unless asked for.
export function conversationSrcDoc(html, { font = { family: '', css: '' }, showQuote = false } = {}) {
  const body = String(html ?? '').replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="color-scheme" content="only light">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';">
<base target="_blank">
</head><body><div id="mf-scale-wrapper">${body}</div><style>
  html, body { height: auto !important; min-height: 0 !important; overflow: hidden !important; }
  ${font.css || ''}
  body { margin: 0 !important; padding: 0 !important; background-color: #ffffff !important; color-scheme: light;
         font-family: ${font.family ? `${font.family}, ` : ''}-apple-system, Arial, sans-serif;
         font-size: 14px; line-height: 1.6; color: #1a1a1a; word-wrap: break-word; overflow-wrap: break-word; }
  img { max-width: 100% !important; height: auto !important; }
  table { max-width: 100% !important; }
  a { color: #6366f1; }
  pre, code { white-space: pre-wrap; word-break: break-all; }
  blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }
  ${showQuote ? '' : HIDE_QUOTE_CSS}
</style></body></html>`;
}

// "Name <email>" for the sender, or just the address.
export function personLabel(name, email) {
  const n = String(name ?? '').trim();
  const e = String(email ?? '').trim();
  if (n && e && n.toLowerCase() !== e.toLowerCase()) return n;
  return e || n;
}

// The recipients of a stacked letter as one short line.
export function recipientsLine(toAddresses, ccAddresses) {
  const parse = (raw) => {
    if (Array.isArray(raw)) return raw;
    try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  return [...parse(toAddresses), ...parse(ccAddresses)]
    .map((r) => (typeof r === 'string' ? r : personLabel(r?.name, r?.email)))
    .filter(Boolean)
    .join(', ');
}
