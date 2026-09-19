import { describe, expect, it, vi } from 'vitest';
import {
  RECOMPUTE_BATCH_SIZE, previewRecompute, runRecompute, threadingForRow,
} from './recompute.js';
import { recomputeState } from './recomputeStore.js';

// An in-memory stand-in for the SQL this module issues, same shape as providerIdBackfill.test.js's
// fakeDb: routes by regex over an in-memory array of message rows plus a single thread_recompute
// row, and records the UPDATEs.
function threadKeyOf(m) { return m.thread_id ?? m.id; }

// Independent JS mirror of the two preview aggregate queries (see recompute.js), so the test data
// below is checked against hand-derived expected numbers, not against this function's own output.
function previewAggregate(messages, accountId, targetMode) {
  const rows = messages.filter(m => m.account_id === accountId && !m.is_deleted);
  const isSubjectOnly = (m) => m.in_reply_to == null && m.thread_references == null && m.thread_id !== m.message_id;
  if (targetMode === 'gmail') {
    return {
      rows: rows.length,
      changing: rows.filter(m => m.provider_thread_id != null && m.thread_id !== `gmail:${m.provider_thread_id}`).length,
      subject_only: rows.filter(isSubjectOnly).length,
      threads_now: new Set(rows.map(threadKeyOf)).size,
      threads_after: new Set(rows.map(m => (m.provider_thread_id != null ? `gmail:${m.provider_thread_id}` : threadKeyOf(m)))).size,
    };
  }
  return {
    rows: rows.length,
    changing: rows.filter(m => (m.thread_id || '').startsWith('gmail:') || isSubjectOnly(m)).length,
    subject_only: rows.filter(isSubjectOnly).length,
    threads_now: new Set(rows.map(threadKeyOf)).size,
  };
}

// Simulates node-postgres's default timestamptz handling, which is the root of the bug this file
// pins down: a bare `date` column comes back from the driver as a JS Date, which only carries
// millisecond precision, while a `date::text` projection comes back as the exact stored string
// (Postgres renders full microseconds). When a Date object is later bound back as a query
// parameter, Postgres receives exactly the millisecond instant it encodes — not the row's real
// microsecond value — so padding it out to a 6-digit fractional string here mirrors what the
// database itself would see. A value that is already a string (a `::text` projection, or the
// '-infinity' starting cursor) passes through unchanged, since that round trip is lossless.
function toComparable(value) {
  if (value instanceof Date) return value.toISOString().replace('Z', '000Z');
  return value;
}

function fakeDb({ messages, state = null }) {
  const db = { state, messages, updates: [], finished: 0 };
  const query = vi.fn(async (sql, params = []) => {
    if (/cursor_date::text/.test(sql)) {
      return { rows: [{ cursor_date: db.state?.cursor_date ?? null }] };
    }
    if (/FROM thread_recompute WHERE account_id/.test(sql)) {
      // Mirrors loadRecompute: cursor_date comes back as a JS Date, same precision loss as the
      // `date` column on messages (see toComparable above) — the reason runRecompute's resume
      // path must not use this value directly for the cursor.
      const cursorDate = db.state?.cursor_date;
      return {
        rows: db.state
          ? [{ account_id: params[0], ...db.state, cursor_date: cursorDate != null ? new Date(cursorDate) : null }]
          : [],
      };
    }
    if (/INSERT INTO thread_recompute/.test(sql)) {
      const [, targetMode, total] = params;
      db.state = {
        target_mode: targetMode, total, processed: 0, changed: 0,
        cursor_date: null, cursor_id: null, finished_at: null, error: null,
      };
      return { rows: [] };
    }
    if (/UPDATE thread_recompute\s+SET cursor_date/.test(sql)) {
      const [, cursorDate, cursorId, processed, changed] = params;
      db.state = { ...db.state, cursor_date: cursorDate, cursor_id: cursorId, processed, changed };
      return { rows: [] };
    }
    if (/UPDATE thread_recompute SET finished_at/.test(sql)) {
      db.finished += 1;
      db.state = { ...db.state, finished_at: new Date(), error: null };
      return { rows: [] };
    }
    // clearRecomputeError, issued when a run continues a stored one.
    if (/UPDATE thread_recompute SET error = NULL/.test(sql)) {
      db.state = { ...db.state, error: null };
      return { rows: [] };
    }
    if (/AS total FROM messages/.test(sql)) {
      const [accountId] = params;
      const count = db.messages.filter(m => m.account_id === accountId && !m.is_deleted).length;
      return { rows: [{ total: String(count) }] };
    }
    if (/AS threads_after/.test(sql)) {
      const [accountId] = params;
      const agg = previewAggregate(db.messages, accountId, 'gmail');
      return {
        rows: [{
          rows: String(agg.rows), changing: String(agg.changing), subject_only: String(agg.subject_only),
          threads_now: String(agg.threads_now), threads_after: String(agg.threads_after),
        }],
      };
    }
    if (/AS subject_only/.test(sql)) {
      const [accountId] = params;
      const agg = previewAggregate(db.messages, accountId, 'rfc');
      return {
        rows: [{
          rows: String(agg.rows), changing: String(agg.changing), subject_only: String(agg.subject_only),
          threads_now: String(agg.threads_now),
        }],
      };
    }
    // The tail select for rows the ordered walk can never reach: `date IS NULL` never satisfies
    // the (date, id) cursor comparison, in SQL as in the `after()` helper below (null > x is false).
    if (/date IS NULL/.test(sql)) {
      const [accountId] = params;
      return {
        rows: db.messages
          .filter(m => m.account_id === accountId && !m.is_deleted && m.date == null)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map(m => ({ ...m })),
      };
    }
    if (/SELECT id, message_id, in_reply_to, thread_references, provider_thread_id, thread_id, threading_reason, date/.test(sql)) {
      const [accountId, cursorDate, cursorId, limit] = params;
      const lossless = /date::text AS cursor_date/.test(sql);
      const cmpCursor = toComparable(cursorDate);
      const after = (m) => m.date > cmpCursor || (m.date === cmpCursor && m.id > cursorId);
      const cmp = (a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      };
      const batch = db.messages
        .filter(m => m.account_id === accountId && !m.is_deleted && after(m))
        .sort(cmp)
        .slice(0, limit);
      // Mirrors what the real SELECT list projects: `date::text AS cursor_date` gives the exact
      // stored string; a bare `date` column gives a JS Date (see toComparable).
      return {
        rows: batch.map(m => ({ ...m, ...(lossless ? { cursor_date: m.date } : { date: new Date(m.date) }) })),
      };
    }
    if (/SELECT message_id, thread_id FROM messages/.test(sql)) {
      const [accountId, ids, cursorDate, cursorId] = params;
      const idSet = new Set(ids);
      const cmpCursor = toComparable(cursorDate);
      const atOrBeforeCursor = (m) => m.date < cmpCursor || (m.date === cmpCursor && m.id <= cursorId);
      const rows = db.messages.filter(m => m.account_id === accountId && idSet.has(m.message_id)
        && m.thread_id != null && !m.is_deleted && atOrBeforeCursor(m));
      return { rows: rows.map(m => ({ message_id: m.message_id, thread_id: m.thread_id })) };
    }
    if (/^\s*UPDATE messages m/.test(sql)) {
      const [accountId, ids, threadIds, reasons] = params;
      let rowCount = 0;
      ids.forEach((id, i) => {
        const row = db.messages.find(m => m.id === id && m.account_id === accountId);
        if (row && (row.thread_id !== threadIds[i] || row.threading_reason !== reasons[i])) {
          row.thread_id = threadIds[i];
          row.threading_reason = reasons[i];
          rowCount += 1;
        }
      });
      db.updates.push({ ids, threadIds, reasons });
      return { rowCount };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { db, query };
}

// A message row as the batch SELECT would return it.
const msg = (id, date, over = {}) => ({
  id, date, account_id: 'a1', is_deleted: false,
  message_id: `<${id}>`, in_reply_to: null, thread_references: null,
  provider_thread_id: null, thread_id: `<${id}>`, threading_reason: 'new-root',
  ...over,
});

describe('threadingForRow', () => {
  it('gmail mode with provider_thread_id uses the Gmail thread number', () => {
    const row = { provider_thread_id: '17', message_id: '<a>', in_reply_to: null, thread_references: null };
    expect(threadingForRow(row, { mode: 'gmail', ancestorKeys: new Map() })).toEqual({ threadId: 'gmail:17', reason: 'gmail-thrid' });
  });

  it('gmail mode without provider_thread_id falls back to the header branch', () => {
    const row = { provider_thread_id: null, message_id: '<a>', in_reply_to: null, thread_references: null };
    expect(threadingForRow(row, { mode: 'gmail', ancestorKeys: new Map() })).toEqual({ threadId: '<a>', reason: 'new-root' });
  });

  it('rfc mode with provider_thread_id present still uses the header branch', () => {
    const row = { provider_thread_id: '17', message_id: '<a>', in_reply_to: null, thread_references: null };
    expect(threadingForRow(row, { mode: 'rfc', ancestorKeys: new Map() })).toEqual({ threadId: '<a>', reason: 'new-root' });
  });

  it('no headers starts its own thread at its own Message-ID', () => {
    const row = { provider_thread_id: null, message_id: '<a>', in_reply_to: null, thread_references: null };
    expect(threadingForRow(row, { mode: 'rfc', ancestorKeys: new Map() })).toEqual({ threadId: '<a>', reason: 'new-root' });
  });

  it('resolves the first Reference through ancestorKeys as the root', () => {
    const row = { message_id: '<c>', in_reply_to: null, thread_references: '<a> <b>' };
    const ancestorKeys = new Map([['<a>', 'keyA'], ['<b>', 'keyB']]);
    expect(threadingForRow(row, { mode: 'rfc', ancestorKeys })).toEqual({ threadId: 'keyA', reason: 'rfc-root' });
  });

  it('resolves only a later Reference through ancestorKeys as an ancestor', () => {
    const row = { message_id: '<c>', in_reply_to: null, thread_references: '<a> <b>' };
    const ancestorKeys = new Map([['<b>', 'keyB']]);
    expect(threadingForRow(row, { mode: 'rfc', ancestorKeys })).toEqual({ threadId: 'keyB', reason: 'rfc-ancestor' });
  });

  it('falls back to the first Reference when nothing resolves', () => {
    const row = { message_id: '<c>', in_reply_to: null, thread_references: '<a> <b>' };
    expect(threadingForRow(row, { mode: 'rfc', ancestorKeys: new Map() })).toEqual({ threadId: '<a>', reason: 'rfc-provisional' });
  });

  it('does not add in_reply_to twice when it already appears in References', () => {
    // in_reply_to duplicates the FIRST reference (not the last), so a missing dedup guard would
    // make the backward scan visit '<b>' an extra time before reaching '<a>' — observable as an
    // extra .has() call, even though the returned value would look the same either way.
    const real = new Map([['<a>', 'keyA']]);
    const calls = [];
    const ancestorKeys = {
      has: (k) => { calls.push(k); return real.has(k); },
      get: (k) => real.get(k),
    };
    const row = { message_id: '<c>', in_reply_to: '<b>', thread_references: '<b> <a>' };
    const result = threadingForRow(row, { mode: 'rfc', ancestorKeys });
    expect(result).toEqual({ threadId: 'keyA', reason: 'rfc-ancestor' });
    expect(calls).toEqual(['<b>', '<a>']);
  });

  it('drops its own Message-ID from the candidate list before resolving', () => {
    // The self-reference is placed FIRST, so a naive candidates[0] check would find nothing (no
    // row ever resolves to its own id) and fall back to the real ancestor via the backward scan,
    // reporting 'rfc-ancestor' instead of 'rfc-root'. Dropping it makes '<a>' the real first
    // candidate, resolving as the root.
    const row = { message_id: '<c>', in_reply_to: null, thread_references: '<c> <a>' };
    const ancestorKeys = new Map([['<a>', 'keyA']]);
    expect(threadingForRow(row, { mode: 'rfc', ancestorKeys })).toEqual({ threadId: 'keyA', reason: 'rfc-root' });
  });

  it('drops in_reply_to when it equals its own Message-ID', () => {
    const row = { message_id: '<c>', in_reply_to: '<c>', thread_references: null };
    expect(threadingForRow(row, { mode: 'rfc', ancestorKeys: new Map() })).toEqual({ threadId: '<c>', reason: 'new-root' });
  });
});

describe('previewRecompute', () => {
  it('counts changing, subject-glued and distinct-thread rows for a gmail target', async () => {
    const messages = [
      msg('m1', '2024-01-01T00:00:00.000Z', { thread_id: '<m1>' }), // already own key, untouched
      msg('m2', '2024-01-02T00:00:00.000Z', { thread_id: '<m1>' }), // subject-glued to m1
      msg('m3', '2024-01-03T00:00:00.000Z', { provider_thread_id: '500', thread_id: 'gmail:500' }), // already gmail-keyed
      msg('m4', '2024-01-04T00:00:00.000Z', { provider_thread_id: '600', thread_id: '<m4>' }), // needs gmail rekey
      msg('m5', '2024-01-05T00:00:00.000Z', { in_reply_to: '<m4>', thread_id: '<m4>' }), // has headers
    ];
    const { query } = fakeDb({ messages });

    expect(await previewRecompute(query, 'a1', 'gmail')).toEqual({
      rows: 5, changing: 1, subjectOnly: 2, threadsNow: 3, threadsAfter: 4,
    });
  });

  it('reports threadsAfter as null for an rfc target, since a reply key can depend on the pass order', async () => {
    const messages = [
      msg('n1', '2024-01-01T00:00:00.000Z', { thread_id: '<n1>' }),
      msg('n2', '2024-01-02T00:00:00.000Z', { thread_id: '<n1>' }), // subject-glued to n1
      msg('n3', '2024-01-03T00:00:00.000Z', { thread_id: 'gmail:900' }), // leftover gmail key
      msg('n4', '2024-01-04T00:00:00.000Z', { in_reply_to: '<n1>', thread_id: '<n4>' }),
    ];
    const { query } = fakeDb({ messages });

    expect(await previewRecompute(query, 'a1', 'rfc')).toEqual({
      rows: 4, changing: 2, subjectOnly: 2, threadsNow: 3, threadsAfter: null,
    });
  });
});

describe('runRecompute', () => {
  async function run(db, over = {}) {
    return runRecompute({
      query: db.query,
      accountId: 'a1',
      targetMode: 'gmail',
      shouldContinue: vi.fn(async () => true),
      ...over,
    });
  }

  it('rekeys a mailbox to gmail: keys and reports changed from what the database actually updated', async () => {
    const messages = [
      msg('m1', '2024-01-01T00:00:00.000Z', { provider_thread_id: '100', thread_id: '<m1>', threading_reason: 'new-root' }),
      msg('m2', '2024-01-02T00:00:00.000Z', { provider_thread_id: '200', thread_id: '<m2>', threading_reason: 'new-root' }),
    ];
    const db = fakeDb({ messages });
    const realImpl = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      const result = await realImpl(sql, params);
      if (/^\s*UPDATE messages m/.test(sql)) return { rowCount: Math.max(0, result.rowCount - 1) };
      return result;
    });

    const result = await run(db);

    expect(result).toEqual({ outcome: 'done', processed: 2, changed: 1, total: 2 });
    expect(messages.map(m => [m.id, m.thread_id, m.threading_reason])).toEqual([
      ['m1', 'gmail:100', 'gmail-thrid'],
      ['m2', 'gmail:200', 'gmail-thrid'],
    ]);
  });

  it('splits a subject-glued group into its own conversations in rfc mode', async () => {
    const messages = [
      msg('a1', '2024-01-01T00:00:00.000Z', { thread_id: 'glue', threading_reason: null }),
      msg('a2', '2024-01-02T00:00:00.000Z', { thread_id: 'glue', threading_reason: null }),
      msg('a3', '2024-01-03T00:00:00.000Z', { thread_id: 'glue', threading_reason: null }),
    ];
    const db = fakeDb({ messages });

    const result = await run(db, { targetMode: 'rfc' });

    expect(result).toEqual({ outcome: 'done', processed: 3, changed: 3, total: 3 });
    expect(messages.map(m => [m.id, m.thread_id, m.threading_reason])).toEqual([
      ['a1', '<a1>', 'new-root'],
      ['a2', '<a2>', 'new-root'],
      ['a3', '<a3>', 'new-root'],
    ]);
  });

  it('a reply follows the key its ancestor got earlier in the same batch', async () => {
    const messages = [
      msg('root', '2024-01-01T00:00:00.000Z', {
        message_id: '<root>', thread_id: 'glue', threading_reason: null,
      }),
      msg('reply', '2024-01-02T00:00:00.000Z', {
        message_id: '<reply>', in_reply_to: '<root>', thread_id: 'glue', threading_reason: null,
      }),
    ];
    const db = fakeDb({ messages });

    const result = await run(db, { targetMode: 'rfc' });

    expect(result.outcome).toBe('done');
    expect(messages.map(m => [m.id, m.thread_id, m.threading_reason])).toEqual([
      ['root', '<root>', 'new-root'],
      ['reply', '<root>', 'rfc-root'],
    ]);
  });

  it('does not resolve an ancestor through a soft-deleted row\'s stale key', async () => {
    // The root was gmail-keyed, then soft-deleted; the mailbox rolls back to rfc. No live row can
    // ever reproduce 'gmail:5' again, so the reply must not inherit it — it falls through to its
    // own provisional root instead, same as any other unresolved reference.
    const messages = [
      msg('root', '2024-01-01T00:00:00.000Z', {
        message_id: '<root>', thread_id: 'gmail:5', is_deleted: true,
      }),
      msg('reply', '2024-01-02T00:00:00.000Z', {
        message_id: '<reply>', in_reply_to: '<root>', thread_id: 'gmail:5',
      }),
    ];
    const db = fakeDb({ messages });

    const result = await run(db, { targetMode: 'rfc' });

    expect(result.outcome).toBe('done');
    expect(messages.find(m => m.id === 'reply').thread_id).toBe('<root>');
    expect(messages.find(m => m.id === 'reply').threading_reason).toBe('rfc-provisional');
  });

  it('does not resolve an ancestor ordered after the current row in the same pass', async () => {
    // '<later>' references an ancestor that has not been walked yet (it sorts after '<earlier>'
    // in this batch but the ancestor resolution only looks at rows already committed by a prior
    // batch). It must not adopt the not-yet-recomputed row's still-stale stored key.
    const messages = [
      msg('earlier', '2024-01-01T00:00:00.000Z', {
        message_id: '<earlier>', in_reply_to: '<later>', thread_id: 'stale',
      }),
      msg('later', '2024-01-02T00:00:00.000Z', {
        message_id: '<later>', thread_id: 'stale',
      }),
    ];
    const db = fakeDb({ messages });

    const result = await run(db, { targetMode: 'rfc' });

    expect(result.outcome).toBe('done');
    expect(messages.find(m => m.id === 'earlier').thread_id).toBe('<later>');
    expect(messages.find(m => m.id === 'earlier').threading_reason).toBe('rfc-provisional');
  });

  it('carries an ancestor rekeyed in an earlier batch forward into a later batch', async () => {
    const messages = [
      msg('root', '2024-01-01T00:00:00.000Z', { message_id: '<root>', thread_id: 'glue', threading_reason: null }),
      msg('mid1', '2024-01-02T00:00:00.000Z', { message_id: '<mid1>', thread_id: 'glue', threading_reason: null }),
      msg('mid2', '2024-01-03T00:00:00.000Z', { message_id: '<mid2>', thread_id: 'glue', threading_reason: null }),
      msg('reply', '2024-01-04T00:00:00.000Z', {
        message_id: '<reply>', in_reply_to: '<root>', thread_id: 'glue', threading_reason: null,
      }),
    ];
    const db = fakeDb({ messages });
    const selectCalls = [];
    const realImpl = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      const result = await realImpl(sql, params);
      if (/SELECT id, message_id, in_reply_to, thread_references, provider_thread_id, thread_id, threading_reason, date/.test(sql)) {
        selectCalls.push(result.rows.map(r => r.id));
      }
      return result;
    });

    const result = await run(db, { targetMode: 'rfc', batchSize: 1 });

    expect(result).toEqual({ outcome: 'done', processed: 4, changed: 4, total: 4 });
    // Four batches of one row each, plus a final empty batch that ends the walk.
    expect(selectCalls).toEqual([['root'], ['mid1'], ['mid2'], ['reply'], []]);
    expect(db.db.state.cursor_id).toBe('reply');
    expect(messages.map(m => [m.id, m.thread_id, m.threading_reason])).toEqual([
      ['root', '<root>', 'new-root'],
      ['mid1', '<mid1>', 'new-root'],
      ['mid2', '<mid2>', 'new-root'],
      ['reply', '<root>', 'rfc-root'],
    ]);
  });

  it('keeps the cursor at full microsecond precision, so the last row of a batch is not selected again', async () => {
    // messages.date is timestamptz (microsecond precision); node-postgres hands back a bare `date`
    // column as a JS Date, which only holds milliseconds. If the cursor were taken from that Date
    // instead of a lossless text projection, this row's own (truncated) cursor would still be
    // less than its own (real, microsecond) stored date, so `(date, id) > (cursor, id)` would
    // stay true for it forever and the pass would never terminate.
    const messages = [
      msg('a', '2024-01-01T00:00:00.123456Z', { thread_id: 'glue', threading_reason: null }),
    ];
    const db = fakeDb({ messages });
    const selectCalls = [];
    const realImpl = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      const result = await realImpl(sql, params);
      if (/SELECT id, message_id, in_reply_to, thread_references, provider_thread_id, thread_id, threading_reason, date/.test(sql)) {
        selectCalls.push(result.rows.map(r => r.id));
      }
      return result;
    });

    const result = await run(db, { targetMode: 'rfc' });

    expect(result).toEqual({ outcome: 'done', processed: 1, changed: 1, total: 1 });
    // One real batch plus the closing empty one — not a third call re-selecting 'a'.
    expect(selectCalls).toEqual([['a'], []]);
    expect(db.db.state.cursor_date).toBe('2024-01-01T00:00:00.123456Z');
    expect(typeof db.db.state.cursor_date).toBe('string');
  });

  it('a resumed pass reads the stored cursor at full precision too, so it does not reselect its last row forever', async () => {
    // The earlier run's cursor was saved with microseconds intact ('...123456Z'); the row it
    // points at is already correct. loadRecompute would hand this back as a millisecond-truncated
    // Date ('...123000Z' once compared), which would make that already-correct row look newer
    // than the cursor and reselect it. The resume path must read the cursor losslessly instead.
    const messages = [
      msg('a', '2024-01-01T00:00:00.123456Z', { thread_id: '<a>', threading_reason: 'new-root' }),
      msg('b', '2024-01-02T00:00:00.000000Z', { thread_id: 'glue', threading_reason: null }),
    ];
    const db = fakeDb({
      messages,
      state: {
        target_mode: 'rfc', total: 2, processed: 1, changed: 0,
        cursor_date: '2024-01-01T00:00:00.123456Z', cursor_id: 'a', finished_at: null, error: null,
      },
    });
    const selectCalls = [];
    const realImpl = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      const result = await realImpl(sql, params);
      if (/SELECT id, message_id, in_reply_to, thread_references, provider_thread_id, thread_id, threading_reason, date/.test(sql)) {
        selectCalls.push(result.rows.map(r => r.id));
      }
      return result;
    });

    const result = await run(db, { targetMode: 'rfc' });

    expect(result).toEqual({ outcome: 'done', processed: 2, changed: 1, total: 2 });
    expect(selectCalls).toEqual([['b'], []]);
  });

  it('never processes more rows than the mailbox had, once the cursor advances losslessly', async () => {
    const messages = [
      msg('a', '2024-01-01T00:00:00.111111Z', { thread_id: 'glue', threading_reason: null }),
      msg('b', '2024-01-02T00:00:00.222222Z', { thread_id: 'glue', threading_reason: null }),
      msg('c', '2024-01-03T00:00:00.333333Z', { thread_id: 'glue', threading_reason: null }),
    ];
    const db = fakeDb({ messages });

    const result = await run(db, { targetMode: 'rfc', batchSize: 1 });

    expect(result.outcome).toBe('done');
    expect(result.processed).toBe(result.total);
    expect(result.processed).toBeLessThanOrEqual(result.total);
  });

  it('processes rows oldest first and saves the cursor to the batch\'s last (date, id)', async () => {
    const messages = [
      msg('m2', '2024-01-02T00:00:00.000Z'),
      msg('m1', '2024-01-01T00:00:00.000Z'),
      msg('m3', '2024-01-03T00:00:00.000Z'),
    ];
    const db = fakeDb({ messages });

    await run(db);

    expect(db.db.state.cursor_date).toBe('2024-01-03T00:00:00.000Z');
    expect(db.db.state.cursor_id).toBe('m3');
  });

  it('a second run with a stored (unfinished) cursor starts after it, keeping the earlier counters', async () => {
    const messages = [
      msg('m1', '2024-01-01T00:00:00.000Z', { provider_thread_id: '100', thread_id: 'gmail:100', threading_reason: 'gmail-thrid' }),
      msg('m2', '2024-01-02T00:00:00.000Z', { provider_thread_id: '200', thread_id: 'gmail:200', threading_reason: 'gmail-thrid' }),
      msg('m3', '2024-01-03T00:00:00.000Z', { provider_thread_id: '300' }), // still needs rekeying
    ];
    // An earlier run got through m1 and m2 (both already correct, hence changed: 0) and was
    // interrupted before m3 — cursor saved, finished_at still null.
    const db = fakeDb({
      messages,
      state: {
        target_mode: 'gmail', total: 3, processed: 2, changed: 0,
        cursor_date: '2024-01-02T00:00:00.000Z', cursor_id: 'm2', finished_at: null, error: null,
      },
    });
    const selectCalls = [];
    const realImpl = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/SELECT id, message_id, in_reply_to, thread_references, provider_thread_id, thread_id, threading_reason, date/.test(sql)) {
        const result = await realImpl(sql, params);
        selectCalls.push(result);
        return result;
      }
      return realImpl(sql, params);
    });

    const result = await run(db);

    expect(result).toEqual({ outcome: 'done', processed: 3, changed: 1, total: 3 });
    expect(selectCalls.map(r => r.rows.map(row => row.id))).toEqual([['m3'], []]);
    expect(messages.find(m => m.id === 'm3').thread_id).toBe('gmail:300');
  });

  it('clears the error of the run it continues, so a retry of a failed pass does not stay failed', async () => {
    const messages = [
      msg('m1', '2024-01-01T00:00:00.000Z', { provider_thread_id: '100', thread_id: 'gmail:100', threading_reason: 'gmail-thrid' }),
      msg('m2', '2024-01-02T00:00:00.000Z', { provider_thread_id: '200' }),
    ];
    // The pass that walked m1 died with an error; the admin pressed Recompute for the same mode.
    const db = fakeDb({
      messages,
      state: {
        target_mode: 'gmail', total: 2, processed: 1, changed: 0,
        cursor_date: '2024-01-01T00:00:00.000Z', cursor_id: 'm1', finished_at: null, error: 'Connection closed',
      },
    });

    const result = await run(db);

    expect(result).toEqual({ outcome: 'done', processed: 2, changed: 1, total: 2 });
    expect(db.db.state.error).toBeNull();
    expect(recomputeState({ row: db.db.state })).toEqual({ status: 'done', percent: 100, changed: 1, error: null });
  });

  it('a pass that is stopped after continuing a failed one reports paused, not the old error', async () => {
    const messages = [msg('m1', '2024-01-01T00:00:00.000Z', { provider_thread_id: '100' })];
    const db = fakeDb({
      messages,
      state: {
        target_mode: 'gmail', total: 1, processed: 0, changed: 0,
        cursor_date: null, cursor_id: null, finished_at: null, error: 'Connection closed',
      },
    });

    const result = await run(db, { shouldContinue: vi.fn(async () => false) });

    expect(result.outcome).toBe('stopped');
    expect(recomputeState({ row: db.db.state }).status).toBe('paused');
  });

  it('stops before the next batch when asked, without marking the run finished', async () => {
    const messages = [msg('m1', '2024-01-01T00:00:00.000Z')];
    const db = fakeDb({ messages });

    const result = await run(db, { shouldContinue: vi.fn(async () => false) });

    expect(result).toEqual({ outcome: 'stopped', processed: 0, changed: 0, total: 1 });
    expect(db.db.finished).toBe(0);
    expect(db.db.updates).toEqual([]);
  });

  it('marks a completed run finished, and running it again over an already-correct mailbox changes nothing', async () => {
    const messages = [
      msg('m1', '2024-01-01T00:00:00.000Z', { provider_thread_id: '100', thread_id: '<m1>' }),
    ];
    const db = fakeDb({ messages });

    const first = await run(db);
    expect(first.outcome).toBe('done');
    expect(db.db.finished).toBe(1);
    expect(db.db.state.finished_at).toBeTruthy();

    const second = await run(db);
    expect(second).toEqual({ outcome: 'done', processed: 1, changed: 0, total: 1 });
  });

  it('rekeys rows with no date, which the ordered walk can never reach, and reaches processed == total', async () => {
    const messages = [
      msg('m1', '2024-01-01T00:00:00.000Z', { provider_thread_id: '100', thread_id: '<m1>' }),
      msg('n1', null, { provider_thread_id: '900', thread_id: 'glue', threading_reason: null }),
      msg('n2', null, { provider_thread_id: '900', thread_id: 'glue', threading_reason: null }),
    ];
    const db = fakeDb({ messages });

    const result = await run(db);

    expect(result).toEqual({ outcome: 'done', processed: 3, changed: 3, total: 3 });
    expect(messages.map(m => [m.id, m.thread_id, m.threading_reason])).toEqual([
      ['m1', 'gmail:100', 'gmail-thrid'],
      ['n1', 'gmail:900', 'gmail-thrid'],
      ['n2', 'gmail:900', 'gmail-thrid'],
    ]);
    expect(db.db.finished).toBe(1);
  });

  it('resolves an undated row through an ancestor the pass already rekeyed', async () => {
    const messages = [
      msg('m1', '2024-01-01T00:00:00.000Z', { thread_id: 'glue', threading_reason: null }),
      msg('n1', null, { in_reply_to: '<m1>', thread_id: 'glue', threading_reason: null }),
    ];
    const db = fakeDb({ messages });

    const result = await run(db, { targetMode: 'rfc' });

    expect(result).toEqual({ outcome: 'done', processed: 2, changed: 2, total: 2 });
    expect(messages.map(m => [m.id, m.thread_id, m.threading_reason])).toEqual([
      ['m1', '<m1>', 'new-root'],
      ['n1', '<m1>', 'rfc-root'],
    ]);
  });

  it('does not touch the undated rows, or finish, when the pass is asked to stop first', async () => {
    const messages = [
      msg('m1', '2024-01-01T00:00:00.000Z', { provider_thread_id: '100', thread_id: '<m1>' }),
      msg('n1', null, { provider_thread_id: '900', thread_id: 'glue' }),
    ];
    const db = fakeDb({ messages });
    // true for the walk's two iterations (the second selects nothing and ends it), false at the
    // tail: the undated batch must honour shouldContinue the same way the walk does.
    const shouldContinue = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);

    const result = await run(db, { shouldContinue });

    expect(result).toEqual({ outcome: 'stopped', processed: 1, changed: 1, total: 2 });
    expect(messages.find(m => m.id === 'n1').thread_id).toBe('glue');
    expect(db.db.finished).toBe(0);
  });

  it('does not write a row whose key and reason are already correct', async () => {
    const messages = [
      msg('m1', '2024-01-01T00:00:00.000Z', { provider_thread_id: '100', thread_id: 'gmail:100', threading_reason: 'gmail-thrid' }),
      msg('m2', '2024-01-02T00:00:00.000Z', { provider_thread_id: '200', thread_id: '<m2>', threading_reason: 'new-root' }),
    ];
    const db = fakeDb({ messages });

    await run(db);

    expect(db.db.updates).toEqual([{ ids: ['m2'], threadIds: ['gmail:200'], reasons: ['gmail-thrid'] }]);
  });
});

it('RECOMPUTE_BATCH_SIZE is 2000', () => {
  expect(RECOMPUTE_BATCH_SIZE).toBe(2000);
});
