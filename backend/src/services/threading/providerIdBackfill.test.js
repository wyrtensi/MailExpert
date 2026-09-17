import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_ID_BATCH_SIZE, planProviderIdBackfill, runProviderIdBackfill, uidSet,
} from './providerIdBackfill.js';

const THREAD = '1700000000000000001';
const gm = (uid, over = {}) => ({ uid, threadId: THREAD, emailId: String(1800000000000000000n + BigInt(uid)), ...over });

// An in-memory stand-in for the SQL this module issues. Each branch mirrors one statement.
function fakeDb({ folders, messages, state = null }) {
  const db = { state, messages, updates: [], finished: 0 };
  const query = vi.fn(async (sql, params = []) => {
    if (/FROM provider_id_backfill/.test(sql)) return { rows: db.state ? [db.state] : [] };
    if (/FROM folders/.test(sql)) return { rows: folders };
    if (/AS remaining/.test(sql)) {
      const cursors = JSON.parse(params[1]);
      const counts = new Map();
      for (const m of db.messages) {
        if (m.provider_message_id || m.is_deleted) continue;
        if (m.uid <= Number(cursors[m.folder]?.lastUid || 0)) continue;
        counts.set(m.folder, (counts.get(m.folder) || 0) + 1);
      }
      return { rows: [...counts].map(([folder, remaining]) => ({ folder, remaining })) };
    }
    if (/^\s*SELECT uid FROM messages/.test(sql)) {
      const [, folder, after, limit] = params;
      return {
        rows: db.messages
          .filter(m => m.folder === folder && !m.is_deleted && !m.provider_message_id && m.uid > after)
          .sort((a, b) => a.uid - b.uid)
          .slice(0, limit)
          .map(m => ({ uid: String(m.uid) })),
      };
    }
    if (/^\s*UPDATE messages m/.test(sql)) {
      const [, folder, uids, threads, ids] = params;
      uids.forEach((uid, i) => {
        const row = db.messages.find(m => m.folder === folder && m.uid === uid && !m.provider_message_id);
        if (row) Object.assign(row, { provider_thread_id: threads[i], provider_message_id: ids[i] });
      });
      db.updates.push({ folder, uids });
      return { rows: [] };
    }
    if (/jsonb_build_object/.test(sql)) {
      const [, folder, cursor] = params;
      db.state = { ...(db.state || {}), cursors: { ...(db.state?.cursors || {}), [folder]: JSON.parse(cursor) } };
      return { rows: [] };
    }
    if (/finished_at = now\(\)/.test(sql)) {
      db.finished += 1;
      db.state = { cursors: {}, ...(db.state || {}), finished_at: new Date(), error: null };
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { db, query };
}

function expandSet(range) {
  const set = new Set();
  for (const part of range.split(',')) {
    const [from, to] = part.split(':').map(Number);
    for (let uid = from; uid <= (to ?? from); uid++) set.add(uid);
  }
  return set;
}

// server: { [folderPath]: fetch responses }. uidValidity is a BigInt, as imapflow reports it.
function fakeClient(server, { uidValidity = 7n } = {}) {
  const client = {
    mailbox: null,
    getMailboxLock: vi.fn(async (path) => {
      client.mailbox = { path, uidValidity };
      return { release: vi.fn() };
    }),
    fetch: vi.fn((range) => (async function* () {
      const wanted = expandSet(range);
      for (const msg of server[client.mailbox.path] || []) if (wanted.has(msg.uid)) yield msg;
    })()),
  };
  return client;
}

const row = (folder, uid, over = {}) => ({ folder, uid, provider_message_id: null, provider_thread_id: null, is_deleted: false, ...over });
const FOLDERS = [{ path: 'INBOX', uid_validity: '7' }, { path: '[Gmail]/Sent Mail', uid_validity: '7' }];

async function run(db, client, over = {}) {
  return runProviderIdBackfill({
    query: db.query,
    accountId: 'a1',
    getClient: vi.fn(async () => client),
    shouldContinue: vi.fn(async () => true),
    ...over,
  });
}

describe('uidSet', () => {
  it.each([
    [[], ''],
    [[5], '5'],
    [[1, 2, 3], '1:3'],
    [[1, 2, 3, 7, 9, 10], '1:3,7,9:10'],
  ])('%j -> %s', (uids, expected) => {
    expect(uidSet(uids)).toBe(expected);
  });
});

describe('planProviderIdBackfill', () => {
  it('counts rows missing ids above each cursor, INBOX first', async () => {
    const { query } = fakeDb({
      folders: FOLDERS,
      messages: [row('[Gmail]/Sent Mail', 1), row('INBOX', 1), row('INBOX', 2), row('INBOX', 3, { provider_message_id: '9' })],
      state: { cursors: { INBOX: { lastUid: 1, uidValidity: '7' } } },
    });
    expect(await planProviderIdBackfill(query, 'a1')).toEqual({
      folders: [
        { path: 'INBOX', uidValidity: '7', lastUid: 1, remaining: 1 },
        { path: '[Gmail]/Sent Mail', uidValidity: '7', lastUid: 0, remaining: 1 },
      ],
      total: 2,
    });
  });

  it('ignores a cursor recorded under another UIDVALIDITY and folders that are no longer known', async () => {
    const { query } = fakeDb({
      folders: [{ path: 'INBOX', uid_validity: '8' }],
      messages: [row('INBOX', 1), row('INBOX', 2), row('Old label', 1)],
      state: { cursors: { INBOX: { lastUid: 2, uidValidity: '7' } } },
    });
    expect(await planProviderIdBackfill(query, 'a1')).toEqual({
      folders: [{ path: 'INBOX', uidValidity: '8', lastUid: 0, remaining: 2 }],
      total: 2,
    });
  });
});

describe('runProviderIdBackfill', () => {
  it('fills ids, saves the cursor per folder and marks the run finished', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1), row('INBOX', 2), row('[Gmail]/Sent Mail', 4)] });
    const client = fakeClient({ INBOX: [gm(1), gm(2)], '[Gmail]/Sent Mail': [gm(4)] });
    const progress = [];

    const result = await run(db, client, { onProgress: p => progress.push(p) });

    expect(result).toEqual({ outcome: 'done', processed: 3, total: 3 });
    expect(db.db.messages.map(m => [m.folder, m.uid, m.provider_thread_id, m.provider_message_id])).toEqual([
      ['INBOX', 1, THREAD, '1800000000000000001'],
      ['INBOX', 2, THREAD, '1800000000000000002'],
      ['[Gmail]/Sent Mail', 4, THREAD, '1800000000000000004'],
    ]);
    expect(client.fetch.mock.calls).toEqual([
      ['1:2', { uid: true, threadId: true }, { uid: true }],
      ['4', { uid: true, threadId: true }, { uid: true }],
    ]);
    expect(db.db.state.cursors).toEqual({
      INBOX: { lastUid: 2, uidValidity: '7' },
      '[Gmail]/Sent Mail': { lastUid: 4, uidValidity: '7' },
    });
    expect(db.db.finished).toBe(1);
    expect(progress).toEqual([
      { processed: 0, total: 3 },
      { processed: 2, total: 3 },
      { processed: 3, total: 3 },
    ]);
  });

  it('passes rows the server no longer has, so a second run finds nothing to do', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1), row('INBOX', 2)] });
    const client = fakeClient({ INBOX: [gm(2)] });

    await run(db, client);
    const getClient = vi.fn(async () => client);
    const second = await run(db, client, { getClient });

    expect(db.db.messages[0].provider_message_id).toBeNull();
    expect(db.db.messages[1].provider_message_id).toBe('1800000000000000002');
    expect(second).toEqual({ outcome: 'done', processed: 0, total: 0 });
    expect(getClient).not.toHaveBeenCalled();
    expect(db.db.finished).toBe(2);
  });

  it('resumes after the saved cursor', async () => {
    const db = fakeDb({
      folders: FOLDERS,
      messages: [row('INBOX', 1), row('INBOX', 2), row('INBOX', 3)],
      state: { cursors: { INBOX: { lastUid: 2, uidValidity: '7' } } },
    });
    const client = fakeClient({ INBOX: [gm(1), gm(2), gm(3)] });

    expect(await run(db, client)).toEqual({ outcome: 'done', processed: 1, total: 1 });
    expect(client.fetch.mock.calls.map(c => c[0])).toEqual(['3']);
  });

  it('fetches in batches of PROVIDER_ID_BATCH_SIZE UIDs', async () => {
    const messages = Array.from({ length: PROVIDER_ID_BATCH_SIZE + 1 }, (_, i) => row('INBOX', i + 1));
    const db = fakeDb({ folders: FOLDERS, messages });
    const client = fakeClient({ INBOX: messages.map(m => gm(m.uid)) });

    await run(db, client);

    expect(client.fetch.mock.calls.map(c => c[0])).toEqual([`1:${PROVIDER_ID_BATCH_SIZE}`, `${PROVIDER_ID_BATCH_SIZE + 1}`]);
    expect(db.db.messages.every(m => m.provider_message_id)).toBe(true);
  });

  it('ignores unrequested UIDs and responses without a valid Gmail message id', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1), row('INBOX', 3)] });
    const client = fakeClient({ INBOX: [gm(1, { emailId: 'not-a-number' }), gm(2), gm(3, { threadId: undefined })] });
    client.fetch.mockImplementation(() => (async function* () { yield* [gm(1, { emailId: 'not-a-number' }), gm(2), gm(3, { threadId: undefined })]; })());

    await run(db, client);

    expect(db.db.updates).toEqual([{ folder: 'INBOX', uids: [3] }]);
    expect(db.db.messages.map(m => [m.uid, m.provider_thread_id, m.provider_message_id])).toEqual([
      [1, null, null],
      [3, null, '1800000000000000003'],
    ]);
  });

  it('skips a folder whose server UIDVALIDITY no longer matches the cached rows', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1)] });
    const client = fakeClient({ INBOX: [gm(1)] }, { uidValidity: 9n });

    const result = await run(db, client);

    expect(result.outcome).toBe('done');
    expect(client.fetch).not.toHaveBeenCalled();
    expect(db.db.updates).toEqual([]);
    expect(db.db.state?.cursors?.INBOX).toBeUndefined();
  });

  it('stops before the next batch when asked, without marking the run finished', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1)] });
    const client = fakeClient({ INBOX: [gm(1)] });

    const result = await run(db, client, { shouldContinue: vi.fn(async () => false) });

    expect(result).toEqual({ outcome: 'stopped', processed: 0, total: 1 });
    expect(client.fetch).not.toHaveBeenCalled();
    expect(db.db.finished).toBe(0);
  });

  it('releases the mailbox lock and keeps earlier cursors when a fetch fails', async () => {
    const messages = Array.from({ length: PROVIDER_ID_BATCH_SIZE + 1 }, (_, i) => row('INBOX', i + 1));
    const db = fakeDb({ folders: FOLDERS, messages });
    const client = fakeClient({ INBOX: messages.map(m => gm(m.uid)) });
    const releases = [];
    client.getMailboxLock.mockImplementation(async (path) => {
      client.mailbox = { path, uidValidity: 7n };
      const lock = { release: vi.fn() };
      releases.push(lock.release);
      return lock;
    });
    const realFetch = client.fetch.getMockImplementation();
    client.fetch.mockImplementationOnce(realFetch).mockImplementationOnce(() => (async function* () { yield* []; throw new Error('Connection closed'); })());

    await expect(run(db, client)).rejects.toThrow('Connection closed');

    expect(releases).toHaveLength(2);
    for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
    expect(db.db.state.cursors.INBOX).toEqual({ lastUid: PROVIDER_ID_BATCH_SIZE, uidValidity: '7' });
    expect(db.db.finished).toBe(0);
  });
});
