import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function captureUrl() {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ messages: [] }) };
  };
  return urls;
}

describe('api.getThread', () => {
  it('names the mailbox when the thread belongs to one', async () => {
    const urls = captureUrl();
    await api.getThread('thread-1', 'INBOX', false, 'acct-sales');
    assert.match(urls[0], /\/mail\/thread\/thread-1\?folder=INBOX&accountId=acct-sales$/);
  });

  it('leaves the mailbox out for the unified inbox', async () => {
    const urls = captureUrl();
    await api.getThread('thread-1', 'INBOX', true);
    assert.match(urls[0], /\/mail\/thread\/thread-1\?folder=INBOX&unified=true$/);
  });

  it('still names the mailbox for a unified request when one is given', async () => {
    const urls = captureUrl();
    await api.getThread('thread-1', 'INBOX', true, 'acc-1');
    assert.match(urls[0], /\/mail\/thread\/thread-1\?folder=INBOX&unified=true&accountId=acc-1$/);
  });
});
