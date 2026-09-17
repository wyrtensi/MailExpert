import { describe, expect, it, vi } from 'vitest';
import {
  loadProviderIdBackfill,
  markProviderIdBackfillFinished,
  providerIdBackfillState,
  recordProviderIdBackfillError,
  saveProviderIdCursor,
} from './providerIdBackfillStore.js';

describe('provider id backfill store', () => {
  it('loads the row of one account, or null', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ account_id: 'a1', cursors: {} }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await loadProviderIdBackfill(query, 'a1')).toEqual({ account_id: 'a1', cursors: {} });
    expect(await loadProviderIdBackfill(query, 'a2')).toBeNull();
    expect(query.mock.calls[0][1]).toEqual(['a1']);
  });

  it('merges one folder cursor into the stored cursors', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await saveProviderIdCursor(query, 'a1', 'INBOX', { lastUid: 42, uidValidity: '7' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/provider_id_backfill\.cursors \|\| EXCLUDED\.cursors/);
    expect(params).toEqual(['a1', 'INBOX', '{"lastUid":42,"uidValidity":"7"}']);
  });

  it('clears the error when a run finishes', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await markProviderIdBackfillFinished(query, 'a1');
    expect(query.mock.calls[0][0]).toMatch(/finished_at = now\(\), error = NULL/);
    expect(query.mock.calls[0][1]).toEqual(['a1']);
  });

  it('stores a bounded error text', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await recordProviderIdBackfillError(query, 'a1', 'x'.repeat(900));
    expect(query.mock.calls[0][1]).toEqual(['a1', 'x'.repeat(500)]);
    await recordProviderIdBackfillError(query, 'a1', '');
    expect(query.mock.calls[1][1]).toEqual(['a1', 'Unknown error']);
  });
});

describe('providerIdBackfillState', () => {
  it.each([
    [{}, { status: 'not_started', percent: null, error: null }],
    [{ running: true, progress: { processed: 1, total: 3 } }, { status: 'running', percent: 33, error: null }],
    [{ running: true, progress: { processed: 0, total: 0 } }, { status: 'running', percent: null, error: null }],
    [{ running: true, row: { error: 'old failure' } }, { status: 'running', percent: null, error: null }],
    [{ row: { cursors: {}, finished_at: null, error: 'Command failed' } }, { status: 'error', percent: null, error: 'Command failed' }],
    [{ row: { cursors: {}, finished_at: '2026-09-17T10:00:00Z', error: null } }, { status: 'done', percent: 100, error: null }],
    [{ row: { cursors: { INBOX: { lastUid: 5 } }, finished_at: null, error: null } }, { status: 'paused', percent: null, error: null }],
  ])('%j -> %j', (input, expected) => {
    expect(providerIdBackfillState(input)).toEqual(expected);
  });
});
