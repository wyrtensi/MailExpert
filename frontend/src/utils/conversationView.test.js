import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { conversationSrcDoc, htmlHasQuote, personLabel, recipientsLine, splitTextQuote } from './conversationView.js';

describe('splitTextQuote', () => {
  it('cuts at an English attribution line', () => {
    const { main, quote } = splitTextQuote('Thanks, see you.\n\nOn Mon, Sep 1, 2026 Maya <m@c> wrote:\n> Hi');
    assert.equal(main, 'Thanks, see you.');
    assert.ok(quote.startsWith('On Mon'));
  });

  it('cuts at a Russian attribution line and at our "---" form', () => {
    assert.equal(splitTextQuote('Спасибо.\n\n1 сент. 2026, Иван <i@c> написал(а):\n> Привет').main, 'Спасибо.');
    assert.equal(splitTextQuote('Ok.\n\n---\nOn Sep 1 Maya wrote:\nold').main, 'Ok.');
  });

  it('cuts at a trailing run of quoted lines without an attribution', () => {
    assert.deepEqual(splitTextQuote('Agreed.\n> earlier\n> text\n'), { main: 'Agreed.', quote: '> earlier\n> text\n' });
  });

  it('does not take a line of the letter ending in "написал:" for an attribution', () => {
    const text = 'Коллега написал:\nвсё готово, отправляем.';
    assert.deepEqual(splitTextQuote(text), { main: text, quote: '' });
  });

  it('keeps a letter without a quote whole, and a forward is never split', () => {
    assert.deepEqual(splitTextQuote('Just text'), { main: 'Just text', quote: '' });
    const fwd = 'See below.\n\n---------- Forwarded message ----------\nFrom: a@b';
    assert.equal(splitTextQuote(fwd).quote, '');
  });
});

describe('conversationSrcDoc', () => {
  it('forbids scripts and hides the quote unless asked', () => {
    const doc = conversationSrcDoc('<p>Hi</p><div class="gmail_quote">old</div>');
    assert.match(doc, /script-src 'none'/);
    assert.match(doc, /\.gmail_quote/);
    assert.doesNotMatch(conversationSrcDoc('<p>Hi</p>', { showQuote: true }), /\.gmail_quote/);
  });

  it('opens links outside with noopener', () => {
    assert.match(conversationSrcDoc('<a href="https://x.example">x</a>'), /<a rel="noopener noreferrer" href=/);
  });
});

describe('htmlHasQuote', () => {
  it('finds the quote blocks mail clients write and nothing else', () => {
    assert.equal(htmlHasQuote('<p>Hi</p><div class="gmail_quote">old</div>'), true);
    assert.equal(htmlHasQuote('<p>Hi</p><blockquote type="cite">old</blockquote>'), true);
    assert.equal(htmlHasQuote('<p>A plain <blockquote>citation</blockquote> in the text</p>'), false);
    assert.equal(htmlHasQuote('<p data-mailexpert-quote-header>On ... wrote:</p>'), true);
    assert.equal(htmlHasQuote('<div id="divRplyFwdMsg">From:</div>'), true);
    assert.equal(htmlHasQuote('<p>Just a letter</p>'), false);
  });
});

describe('personLabel and recipientsLine', () => {
  it('prefers the name, falls back to the address', () => {
    assert.equal(personLabel('Maya Chen', 'maya@c'), 'Maya Chen');
    assert.equal(personLabel('', 'maya@c'), 'maya@c');
    assert.equal(personLabel('maya@c', 'maya@c'), 'maya@c');
  });

  it('joins To and Cc from arrays or JSON text', () => {
    assert.equal(recipientsLine([{ name: 'A', email: 'a@x' }], '[{"email":"b@x"}]'), 'A, b@x');
    assert.equal(recipientsLine('not json', null), '');
  });
});
