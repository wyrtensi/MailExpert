import { describe, expect, it, vi } from 'vitest';
import {
  clearRecomputeError,
  finishRecompute,
  loadRecompute,
  recomputeState,
  recordRecomputeError,
  saveRecomputeCursor,
  startRecomputeRow,
} from './recomputeStore.js';

describe('recompute store', () => {
  it('loads the row of one account, or null', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ account_id: 'a1', target_mode: 'gmail' }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await loadRecompute(query, 'a1')).toEqual({ account_id: 'a1', target_mode: 'gmail' });
    expect(await loadRecompute(query, 'a2')).toBeNull();
    expect(query.mock.calls[0][1]).toEqual(['a1']);
  });

  it('starts a run: resets the cursor, counters, error and finished_at', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await startRecomputeRow(query, 'a1', 'gmail', 42);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/finished_at = NULL/);
    expect(sql).toMatch(/error = NULL/);
    expect(params).toEqual(['a1', 'gmail', 42]);
  });

  it('saves the cursor and counters, and bumps updated_at, as a plain UPDATE', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await saveRecomputeCursor(query, 'a1', {
      cursorDate: '2026-09-17T10:00:00Z', cursorId: 'm1', processed: 10, changed: 3,
    });
    const [sql, params] = query.mock.calls[0];
    // A plain UPDATE, not an INSERT: the row always exists by now (startRecomputeRow creates
    // it with the NOT NULL target_mode), so there is nothing safe to insert here.
    expect(sql).toMatch(/^\s*UPDATE thread_recompute\b/);
    expect(sql).not.toMatch(/INSERT INTO/);
    expect(sql).toMatch(/updated_at = now\(\)/);
    expect(params).toEqual(['a1', '2026-09-17T10:00:00Z', 'm1', 10, 3]);
  });

  it('finishes a run by setting finished_at to now and clearing the error, as a plain UPDATE', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await finishRecompute(query, 'a1');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/^\s*UPDATE thread_recompute\b/);
    expect(sql).not.toMatch(/INSERT INTO/);
    expect(sql).toMatch(/finished_at = now\(\)/);
    // A run that completed is not a failed one: a stale error would keep the panel reporting the
    // failure (recomputeState reads error before finished_at) after a successful retry.
    expect(sql).toMatch(/error = NULL/);
    expect(params).toEqual(['a1']);
  });

  it('clears the error of a run that is being continued, as a plain UPDATE', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await clearRecomputeError(query, 'a1');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/^\s*UPDATE thread_recompute\b/);
    expect(sql).toMatch(/error = NULL/);
    expect(params).toEqual(['a1']);
  });

  it('stores a bounded error text, as a plain UPDATE', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await recordRecomputeError(query, 'a1', 'x'.repeat(900));
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/^\s*UPDATE thread_recompute\b/);
    expect(sql).not.toMatch(/INSERT INTO/);
    expect(params).toEqual(['a1', 'x'.repeat(500)]);
    await recordRecomputeError(query, 'a1', '');
    expect(query.mock.calls[1][1]).toEqual(['a1', 'Unknown error']);
  });
});

describe('recomputeState', () => {
  it.each([
    [{}, { status: 'idle', percent: null, changed: null, error: null }],
    [{ running: true, row: { processed: 1, total: 4, changed: 0 } }, { status: 'running', percent: 25, changed: 0, error: null }],
    [{ running: true, row: { processed: 1, total: 0, changed: 0 } }, { status: 'running', percent: null, changed: 0, error: null }],
    [{ row: { error: 'Command failed', processed: 2, total: 4, changed: 1 } }, { status: 'error', percent: null, changed: 1, error: 'Command failed' }],
    [{ row: { finished_at: '2026-09-17T10:00:00Z', processed: 4, total: 4, changed: 2, error: null } }, { status: 'done', percent: 100, changed: 2, error: null }],
    // a row that exists but never finished and is not running: the pass stopped (restart, disabled
    // mailbox, a mode switch during the pass) and a later trigger continues it — not idle.
    [{ row: { finished_at: null, processed: 0, total: 0, changed: 0, error: null } }, { status: 'paused', percent: null, changed: 0, error: null }],
    // running stays running and hides a stale error stored from an earlier failed run.
    [{ running: true, row: { error: 'stale failure', processed: 2, total: 4, changed: 1 } }, { status: 'running', percent: 50, changed: 1, error: null }],
    // a row carrying both an error and finished_at reports error: a failure after an earlier
    // complete run must show, not the stale "done".
    [{ row: { error: 'Command failed', finished_at: '2026-09-17T10:00:00Z', processed: 4, total: 4, changed: 2 } }, { status: 'error', percent: null, changed: 2, error: 'Command failed' }],
  ])('%j -> %j', (input, expected) => {
    expect(recomputeState(input)).toEqual(expected);
  });
});
