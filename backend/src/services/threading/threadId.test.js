import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import { computeThreadId, parseReferences } from './threadId.js';

describe('parseReferences', () => {
  it('returns the bracketed Message-IDs in order', () => {
    expect(parseReferences('<a@x> <b@x>\r\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(parseReferences(null)).toEqual([]);
  });
});

describe('computeThreadId', () => {
  beforeEach(() => query.mockReset());

  it('returns null without a Message-ID', async () => {
    expect(await computeThreadId('acct', null, null, null)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('prefers the thread of the root reference', async () => {
    query.mockResolvedValueOnce({ rows: [
      { message_id: '<root@x>', thread_id: 'T-root' },
      { message_id: '<parent@x>', thread_id: 'T-parent' },
    ] });
    expect(await computeThreadId('acct', '<new@x>', '<parent@x>', '<root@x> <parent@x>')).toBe('T-root');
    expect(query.mock.calls[0][1]).toEqual(['acct', ['<root@x>', '<parent@x>']]);
  });

  it('falls back to the newest known ancestor', async () => {
    query.mockResolvedValueOnce({ rows: [{ message_id: '<parent@x>', thread_id: 'T-parent' }] });
    expect(await computeThreadId('acct', '<new@x>', '<parent@x>', '<root@x> <parent@x>')).toBe('T-parent');
  });

  it('uses the root reference provisionally when no ancestor is stored yet', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await computeThreadId('acct', '<new@x>', '<parent@x>', '<root@x> <parent@x>')).toBe('<root@x>');
  });

  it('starts its own thread without threading headers and never looks up the subject', async () => {
    // Messages without References or In-Reply-To used to join the earliest message with the same
    // normalised subject from the last 90 days, merging unrelated "Invoice" or "Report" mail.
    expect(await computeThreadId('acct', '<lonely@x>', null, null)).toBe('<lonely@x>');
    expect(query).not.toHaveBeenCalled();
  });
});
