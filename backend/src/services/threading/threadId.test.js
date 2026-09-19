import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import { GMAIL_KEY_PREFIX, THREAD_MODE_GMAIL, computeThreading, parseReferences } from './threadId.js';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('computeThreading — Gmail branch', () => {
  it('keys by the Gmail thread number in gmail mode', async () => {
    expect(await computeThreading('a1', '<m@example.com>', null, null, { mode: THREAD_MODE_GMAIL, providerThreadId: '1700000000000000001' }))
      .toEqual({ threadId: `${GMAIL_KEY_PREFIX}1700000000000000001`, reason: 'gmail-thrid' });
    expect(query).not.toHaveBeenCalled();
  });

  it('keys by the Gmail number even when the message has no Message-ID', async () => {
    expect(await computeThreading('a1', null, null, null, { mode: THREAD_MODE_GMAIL, providerThreadId: '17' }))
      .toEqual({ threadId: `${GMAIL_KEY_PREFIX}17`, reason: 'gmail-thrid' });
  });

  it('falls back to the RFC chain in gmail mode when the number is missing', async () => {
    expect(await computeThreading('a1', '<m@example.com>', null, null, { mode: THREAD_MODE_GMAIL, providerThreadId: null }))
      .toEqual({ threadId: '<m@example.com>', reason: 'new-root' });
  });

  it('ignores a Gmail number in rfc mode', async () => {
    expect(await computeThreading('a1', '<m@example.com>', null, null, { providerThreadId: '17' }))
      .toEqual({ threadId: '<m@example.com>', reason: 'new-root' });
  });
});

describe('computeThreading — RFC branch', () => {
  it('returns nothing for a message without a Message-ID', async () => {
    expect(await computeThreading('a1', null, null, null)).toEqual({ threadId: null, reason: null });
  });

  it('adopts the stored root named first in References', async () => {
    query.mockResolvedValue({ rows: [
      { message_id: '<root@example.com>', thread_id: '<root@example.com>' },
      { message_id: '<mid@example.com>', thread_id: '<root@example.com>' },
    ] });
    expect(await computeThreading('a1', '<new@example.com>', '<mid@example.com>', '<root@example.com> <mid@example.com>'))
      .toEqual({ threadId: '<root@example.com>', reason: 'rfc-root' });
  });

  it('adopts the newest stored ancestor when the root is not stored', async () => {
    query.mockResolvedValue({ rows: [{ message_id: '<mid@example.com>', thread_id: `${GMAIL_KEY_PREFIX}17` }] });
    expect(await computeThreading('a1', '<new@example.com>', '<mid@example.com>', '<root@example.com> <mid@example.com>'))
      .toEqual({ threadId: `${GMAIL_KEY_PREFIX}17`, reason: 'rfc-ancestor' });
  });

  it('uses the referenced root provisionally when no ancestor is stored', async () => {
    expect(await computeThreading('a1', '<new@example.com>', '<mid@example.com>', '<root@example.com> <mid@example.com>'))
      .toEqual({ threadId: '<root@example.com>', reason: 'rfc-provisional' });
  });

  it('starts a new thread when the message has no threading headers', async () => {
    // Messages without References or In-Reply-To used to join the earliest message with the same
    // normalised subject from the last 90 days, merging unrelated "Invoice" or "Report" mail.
    expect(await computeThreading('a1', '<new@example.com>', null, null))
      .toEqual({ threadId: '<new@example.com>', reason: 'new-root' });
    expect(query).not.toHaveBeenCalled();
  });

  it('adds In-Reply-To to the candidates only once', async () => {
    await computeThreading('a1', '<new@example.com>', '<mid@example.com>', '<mid@example.com>');
    expect(query.mock.calls[0][1]).toEqual(['a1', ['<mid@example.com>']]);
  });
});

describe('parseReferences', () => {
  it('reads the angle-bracketed ids in order', () => {
    expect(parseReferences('<a@x> <b@x>\r\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(parseReferences(null)).toEqual([]);
  });
});
