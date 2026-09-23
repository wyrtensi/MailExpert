import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEXT_QUOTE_HEADER_RE, buildQuote, formatQuoteDate, identityName, quoteHeaderHtml, quoteMetaFor,
  quoteHeaderPlain, senderLanguage, switchQuoteText,
} from './quoteHeader.js';

const date = '2026-09-16T08:45:00';
const reply = quoteMetaFor({ date, from_name: 'Maya Chen', from_email: 'maya@northstar.example' }, 'reply');
const forward = quoteMetaFor({ date, from_name: 'Анна', from_email: 'anna@example.com', subject: 'Счёт' }, 'forward');

describe('which language the quote header speaks', () => {
  it('follows the From name: Cyrillic is Russian, anything else English', () => {
    assert.equal(senderLanguage('Иван Петров'), 'ru');
    assert.equal(senderLanguage('Ivan Petrov'), 'en');
    assert.equal(senderLanguage(''), 'en');
  });

  it('takes the alias name, else the sender name, else the mailbox name', () => {
    const account = { name: 'Sales', sender_name: 'Отдел продаж', aliases: [{ id: 'al', name: 'Sales Department' }] };
    assert.equal(identityName(account), 'Отдел продаж');
    assert.equal(identityName(account, 'al'), 'Sales Department');
    assert.equal(identityName({ name: 'Sales' }), 'Sales');
    assert.equal(identityName(null), '');
  });
});

describe('quote headers', () => {
  it('writes the date the way each language reads it', () => {
    assert.equal(formatQuoteDate(date, 'ru'), '16 сентября 2026 г., 08:45');
    assert.equal(formatQuoteDate(date, 'en'), 'Sep 16, 2026, 8:45 AM');
    assert.equal(formatQuoteDate(null, 'en'), '');
  });

  it('builds a reply header and a forward block in either language', () => {
    assert.equal(buildQuote(reply, 'ru', { text: 'hi' }).quotedText,
      '\n\n---\n16 сентября 2026 г., 08:45, Maya Chen <maya@northstar.example> написал(а):\n> hi');
    assert.equal(buildQuote(forward, 'en', { text: 'body', to: 'sales@example.com' }).quotedText,
      '\n\n---------- Forwarded message ----------\nFrom: Анна <anna@example.com>\nDate: Sep 16, 2026, 8:45 AM\nSubject: Счёт\nTo: sales@example.com\n\nbody');
    assert.equal(buildQuote(forward, 'ru', { text: 'body' }).quotedText,
      '\n\n---------- Пересланное сообщение ----------\nОт: Анна <anna@example.com>\nДата: 16 сентября 2026 г., 08:45\nТема: Счёт\n\nbody');
  });

  it('escapes the addresses in the HTML header, which carries its language', () => {
    const { quotedHtml } = buildQuote(reply, 'en', { html: '<p>x</p>' });
    assert.match(quotedHtml, /<p data-mailexpert-quote-header="en"[^>]*>On Sep 16, 2026, 8:45 AM, Maya Chen &lt;maya@northstar.example&gt; wrote:<\/p><p>x<\/p>/);
    assert.equal(quoteHeaderHtml(forward, 'ru').split('<br>')[1], 'От: Анна &lt;anna@example.com&gt;');
  });
});

describe('switching the From name', () => {
  it('rewrites the generated header and leaves an edited one alone', () => {
    const en = buildQuote(reply, 'en', { text: 'hi' }).quotedText;
    const ru = switchQuoteText(en, reply, 'en', 'ru');
    assert.equal(ru, buildQuote(reply, 'ru', { text: 'hi' }).quotedText);
    assert.equal(switchQuoteText(ru, reply, 'ru', 'en'), en);
    const edited = en.replace('wrote:', 'said:');
    assert.equal(switchQuoteText(edited, reply, 'en', 'ru'), edited);
    assert.equal(switchQuoteText(en, reply, 'en', 'en'), en);
  });

  it('finds where a quote starts in a draft, in either language', () => {
    for (const lang of ['en', 'ru']) {
      assert.ok(TEXT_QUOTE_HEADER_RE.test(`body${buildQuote(reply, lang, { text: 'x' }).quotedText}`), `reply ${lang}`);
      assert.ok(TEXT_QUOTE_HEADER_RE.test(`body${buildQuote(forward, lang, { text: 'x' }).quotedText}`), `forward ${lang}`);
    }
  });
});

describe('text from the letter in the header', () => {
  it('keeps "$$" and "$&" in a subject when the header switches language', () => {
    const meta = quoteMetaFor({ date, from_email: 'a@example.com', subject: 'Save $$ and $& today' }, 'forward');
    const en = buildQuote(meta, 'en', { text: 'x' }).quotedText;
    const ru = switchQuoteText(en, meta, 'en', 'ru');
    assert.ok(ru.includes('Тема: Save $$ and $& today'), ru);
  });

  it('gives the generated header as the page shows it, line by line', () => {
    assert.equal(quoteHeaderPlain(forward, 'ru').split('\n')[0], '---------- Пересланное сообщение ----------');
  });
});
