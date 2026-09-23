// The line above a quoted letter in a reply ("On <date>, <sender> wrote:") and the block above a
// forwarded one, in the language of the name the reply is sent under: a Russian name writes them
// in Russian, any other in English. Compose rewrites them when the From name changes
// (switchQuoteText, the data-mailexpert-quote-header paragraph). Pure functions.
import { format } from 'date-fns';
import { ru } from 'date-fns/locale/ru';

export const QUOTE_HEADER_ATTR = 'data-mailexpert-quote-header';

const TEXT = {
  en: {
    wrote: (date, from) => `On ${date}, ${from} wrote:`,
    forwarded: '---------- Forwarded message ----------',
    from: 'From', date: 'Date', subject: 'Subject', to: 'To', cc: 'Cc',
  },
  ru: {
    wrote: (date, from) => `${date}, ${from} написал(а):`,
    forwarded: '---------- Пересланное сообщение ----------',
    from: 'От', date: 'Дата', subject: 'Тема', to: 'Кому', cc: 'Копия',
  },
};
export const QUOTE_LANGUAGES = Object.freeze(Object.keys(TEXT));

// The name a letter goes out under: the alias's, else the mailbox's sender name, else its name.
export function identityName(account, aliasId = null) {
  const alias = aliasId ? (account?.aliases || []).find(a => a.id === aliasId) : null;
  return alias ? alias.name : (account?.sender_name || account?.name || '');
}

// Russian when the name has Cyrillic letters, English otherwise (Latin names, no name at all).
export function senderLanguage(name) {
  return /[А-Яа-яЁё]/.test(String(name ?? '')) ? 'ru' : 'en';
}

export function formatQuoteDate(date, lang) {
  const d = date ? new Date(date) : null;
  if (!d || !Number.isFinite(d.getTime())) return '';
  return lang === 'ru'
    ? format(d, "d MMMM yyyy 'г.', HH:mm", { locale: ru })
    : format(d, 'MMM d, yyyy, h:mm a');
}

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// What the header needs from the original letter, in the shape compose keeps as quoteMeta.
export function quoteMetaFor(message, kind) {
  const name = (message?.from_name || '').replace(/[\r\n]+/g, ' ');
  const from = name ? `${name} <${message?.from_email}>` : (message?.from_email || '');
  return {
    kind,
    date: message?.date || null,
    from,
    subject: (message?.subject || '').replace(/[\r\n]+/g, ' '),
  };
}

// The header lines, plain text: one line for a reply, the block for a forward (to/cc as strings).
export function quoteHeaderLines(meta, lang, { to = '', cc = '' } = {}) {
  const T = TEXT[lang] || TEXT.en;
  const date = formatQuoteDate(meta.date, lang);
  if (meta.kind === 'forward') {
    return [
      T.forwarded,
      `${T.from}: ${meta.from}`,
      `${T.date}: ${date}`,
      `${T.subject}: ${meta.subject}`,
      ...(to ? [`${T.to}: ${to}`] : []),
      ...(cc ? [`${T.cc}: ${cc}`] : []),
    ];
  }
  return [T.wrote(date, meta.from)];
}

// The quoted part as compose takes it: the plain text (header, then the original quoted with "> "
// for a reply or as is for a forward) and the HTML, whose header paragraph carries
// QUOTE_HEADER_ATTR so it can be rewritten in place.
export function buildQuote(meta, lang, { text, html, to = '', cc = '' } = {}) {
  const lines = quoteHeaderLines(meta, lang, { to, cc });
  const reply = meta.kind !== 'forward';
  const quotedText = reply
    ? (text ? `\n\n---\n${lines[0]}\n${text.split('\n').map(l => '> ' + l).join('\n')}` : '')
    : `\n\n${lines.join('\n')}\n\n${text || ''}`;
  const quotedHtml = html
    ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p ${QUOTE_HEADER_ATTR}="${lang}" style="margin:0 0 6px;font-size:12px">${lines.map(escapeHtml).join('<br>')}</p>${html}</div>`
    : null;
  return { quotedText, quotedHtml };
}

// The plain-text quote with its header switched to another language; untouched when the writer
// edited the header (it no longer matches what was generated).
export function switchQuoteText(quoted, meta, fromLang, toLang, extra = {}) {
  if (!quoted || fromLang === toLang) return quoted;
  const before = quoteHeaderLines(meta, fromLang, extra).join('\n');
  const after = quoteHeaderLines(meta, toLang, extra).join('\n');
  return quoted.includes(before) ? quoted.replace(before, after) : quoted;
}

// The HTML header paragraph's content for a language (escaped, lines joined with <br>).
export function quoteHeaderHtml(meta, lang, extra = {}) {
  return quoteHeaderLines(meta, lang, extra).map(escapeHtml).join('<br>');
}

// Matches where a generated quote starts in a plain-text draft, in either language
// (utils/draftSignature.js splits the signature off before it).
export const TEXT_QUOTE_HEADER_RE = new RegExp(
  `\\n\\n(?:---\\n(?:On [^\\n]* wrote:|[^\\n]* написал\\(а\\):)\\n|(?:${TEXT.en.forwarded}|${TEXT.ru.forwarded})\\n)`,
);
