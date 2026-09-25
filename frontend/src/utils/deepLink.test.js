import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { messageDeepLink, readDeepLink } from './deepLink.js';

const ORIGIN = 'https://mail.example.invalid';
const readUrl = (url) => readDeepLink(new URL(url).searchParams);

describe('messageDeepLink', () => {
  it('names the mailbox, so the link opens that copy and not the other mailbox copy', () => {
    const link = messageDeepLink(ORIGIN, { id: 'row-1', message_id: '<m1@c.example>', account_id: 'info' });
    assert.deepEqual(readUrl(link), { ref: '<m1@c.example>', accountId: 'info' });
  });

  it('falls back to the row id without a Message-ID', () => {
    const link = messageDeepLink(ORIGIN, { id: 'row-1', message_id: null, account_id: 'info' });
    assert.deepEqual(readUrl(link), { ref: 'row-1', accountId: 'info' });
  });

  it('leaves the mailbox out when the row has none', () => {
    const link = messageDeepLink(ORIGIN, { id: 'row-1', message_id: '<m1@c.example>' });
    assert.equal(new URL(link).searchParams.has('a'), false);
  });

  it('keeps a Message-ID with reserved characters intact', () => {
    const ref = '<a+b&c=d?e#f@c.example>';
    const link = messageDeepLink(ORIGIN, { id: 'row-1', message_id: ref, account_id: 'info' });
    assert.equal(readUrl(link).ref, ref);
  });

  it('is null when there is nothing to resolve by', () => {
    assert.equal(messageDeepLink(ORIGIN, { message_id: null }), null);
    assert.equal(messageDeepLink(ORIGIN, null), null);
  });
});

describe('readDeepLink', () => {
  it('still reads an older link that carries only m', () => {
    const link = `${ORIGIN}/?m=${encodeURIComponent('<m1@c.example>')}`;
    assert.deepEqual(readUrl(link), { ref: '<m1@c.example>', accountId: null });
  });

  it('is null without m', () => {
    assert.equal(readUrl(`${ORIGIN}/?a=info`), null);
    assert.equal(readDeepLink(null), null);
  });
});
