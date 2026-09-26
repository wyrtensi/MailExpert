// DB-first moves (moveQueue.js) against a real (in-process) Postgres engine and the real
// migration: the row moves at once and holds a placeholder uid, the worker sends one MOVE per
// (source, destination) group, the row takes the uid the server names, a destination sync that
// sees the letter first attaches it instead of inserting it again, and a permanent failure puts
// the row back where the server has the letter. The mail server is a fake manager.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from './testing/realSchema.js';

const dbState = { db: null };
vi.mock('./db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({ ...(await importOriginal()), adjustFolderCounts: vi.fn() }));

const { MoveQueue, MOVE_MAX_ATTEMPTS, placeholderUid } = await import('./moveQueue.js');
const { ImapManager } = await import('./imapManager.js');
const { adjustFolderCounts } = await import('../utils/mailUtils.js');

const ACCOUNT = '40000000-0000-4000-8000-000000000001';
const USER = '42000000-0000-4000-8000-000000000001';
const A = '41000000-0000-4000-8000-000000000001';
const B = '41000000-0000-4000-8000-000000000002';
const C = '41000000-0000-4000-8000-000000000003';
let db;

// The real schema, every migration applied: the real messages table with its UNIQUE, generated
// columns and indexes, not a hand-written subset.
beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

// The manager surface the queue uses. Guards are the real ref-counted ones.
function fakeManager() {
  return {
    connections: new Map([[ACCOUNT, {}]]),
    _pollOnlyAccounts: new Set(),
    _pendingMoveUids: new Map(),
    _guardMoveUid: ImapManager.prototype._guardMoveUid,
    _unguardMoveUid: ImapManager.prototype._unguardMoveUid,
    _isMoveUidGuarded: ImapManager.prototype._isMoveUidGuarded,
    _secondaryLoginBlocked: vi.fn(() => null),
    _poolLoginOpts: vi.fn(() => ({ noNewLogin: false })),
    flagStoresSettled: vi.fn(async () => {}),
    bulkMoveMessages: vi.fn(),
    searchUids: vi.fn(async () => []),
    findMessageIdInFolders: vi.fn(async () => []),
    setFlags: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    _pendingFlagPush: new Map(),
    _enqueueFlagPush: vi.fn(),
    _resolveFlagPush: vi.fn(),
    _scheduleProviderIdBackfill: vi.fn(),
    broadcast: vi.fn(),
  };
}

let mgr;
let queue;
function newQueue() {
  const q = new MoveQueue(mgr);
  // The worker runs when the test says so, not in the background of an enqueue.
  q.kick = vi.fn();
  return q;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await db.exec('DELETE FROM message_moves; DELETE FROM messages; DELETE FROM folders; DELETE FROM email_accounts; DELETE FROM users;');
  await db.query("INSERT INTO users (id, username) VALUES ($1, 'anna')", [USER]);
  await db.query("INSERT INTO email_accounts (id, name, email_address) VALUES ($1, 'Office', 'office@example.com')", [ACCOUNT]);
  for (const path of ['INBOX', 'Archive', 'Trash', 'Projects']) {
    await db.query('INSERT INTO folders (account_id, path, name) VALUES ($1, $2, $2)', [ACCOUNT, path]);
  }
  await db.query("INSERT INTO folders (account_id, path, name, special_use) VALUES ($1, '[Gmail]/All Mail', 'All Mail', '\\All')", [ACCOUNT]);
  await db.query(
    `INSERT INTO messages (id, account_id, uid, folder, message_id, is_read) VALUES
       ($1, $4, 11, 'INBOX', '<a@example.com>', false),
       ($2, $4, 12, 'INBOX', '<b@example.com>', true),
       ($3, $4, 13, 'Projects', '<c@example.com>', true)`,
    [A, B, C, ACCOUNT]
  );
  mgr = fakeManager();
  queue = newQueue();
});

const row = async (id) => (await db.query('SELECT uid::int AS uid, folder, is_read, read_changed_at FROM messages WHERE id = $1', [id])).rows[0];
const moves = async () => (await db.query('SELECT * FROM message_moves ORDER BY id')).rows;
const rowsOf = async (ids) => (await db.query('SELECT * FROM messages WHERE id = ANY($1::uuid[])', [ids])).rows;
const guarded = (folder, uid) => mgr._isMoveUidGuarded(ACCOUNT, folder, uid);
// The server moves every requested uid and names new ones from `base` up, like UIDNEXT.
const serverMoves = (base = 900) => {
  let next = base;
  mgr.bulkMoveMessages.mockImplementation(async (_account, uids) => ({
    uidMap: new Map(uids.map(u => [Number(u), next++])), succeeded: uids, failed: [],
  }));
};

describe('enqueue: the database moves at once', () => {
  it('puts the row in the destination with a placeholder uid and queues the server move', async () => {
    const moved = await queue.enqueue(ACCOUNT, await rowsOf([A, B]), 'Archive');
    expect(moved.sort()).toEqual([A, B].sort());
    const ops = await moves();
    expect(ops).toHaveLength(2);
    for (const op of ops) {
      expect(op).toMatchObject({ src_folder: 'INBOX', dest_folder: 'Archive', state: 'queued', attempts: 0 });
      const r = (await db.query('SELECT uid::int AS uid, folder FROM messages WHERE id = $1', [op.message_row_id])).rows[0];
      expect(r).toEqual({ uid: placeholderUid(op.id), folder: 'Archive' });
      // Neither the letter at its source nor the placeholder may be deleted or re-added by a sync.
      expect(guarded('INBOX', Number(op.src_uid))).toBe(true);
      expect(guarded('Archive', placeholderUid(op.id))).toBe(true);
    }
    expect(queue.kick).toHaveBeenCalledWith(ACCOUNT);
  });

  it('counts a row already in the destination as moved and queues nothing for it', async () => {
    expect(await queue.enqueue(ACCOUNT, await rowsOf([C]), 'Projects')).toEqual([C]);
    expect(await moves()).toEqual([]);
  });

  it('moves a queued row again by changing its move, and cancels it when the row goes back', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    const [op] = await moves();
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Trash');
    expect(await moves()).toMatchObject([{ id: op.id, src_folder: 'INBOX', dest_folder: 'Trash' }]);
    expect(await row(A)).toMatchObject({ uid: placeholderUid(op.id), folder: 'Trash' });
    expect(guarded('Trash', placeholderUid(op.id))).toBe(true);
    expect(guarded('Archive', placeholderUid(op.id))).toBe(false);

    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'INBOX');
    expect(await moves()).toEqual([]);
    expect(await row(A)).toMatchObject({ uid: 11, folder: 'INBOX' });
    expect(guarded('INBOX', 11)).toBe(false);
  });
});

// I3: moving a letter back while its move is queued must not lose a read/star change deferred
// onto that move.
describe('a move cancelled by moving the letter back', () => {
  it('hands a deferred flag change to the flag-push queue at the source', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await queue.deferFlags(await rowsOf([A]), '\\Seen', true);
    await queue.deferFlags(await rowsOf([A]), '\\Flagged', false);
    expect((await moves())[0]).toMatchObject({ set_seen: true, set_flagged: false });

    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'INBOX');
    expect(await moves()).toEqual([]);
    expect(await row(A)).toMatchObject({ uid: 11, folder: 'INBOX' });
    expect(mgr._enqueueFlagPush).toHaveBeenCalledWith(ACCOUNT, A, '\\Seen', true);
    expect(mgr._enqueueFlagPush).toHaveBeenCalledWith(ACCOUNT, A, '\\Flagged', false);
  });

  it('hands it to the move in flight before it, which stores it after its MOVE', async () => {
    let answer;
    mgr.bulkMoveMessages.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    const run = queue.runAccount(ACCOUNT);
    await vi.waitFor(() => expect(mgr.bulkMoveMessages).toHaveBeenCalled());
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Trash'); // a second move follows the first
    await queue.deferFlags(await rowsOf([A]), '\\Seen', true);
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive'); // back: the second move is dropped
    expect(await moves()).toMatchObject([{ dest_folder: 'Archive', set_seen: true }]);
    expect(mgr._enqueueFlagPush).not.toHaveBeenCalled();

    answer({ uidMap: new Map([[11, 900]]), succeeded: [11], failed: [] });
    await run;
    expect(await row(A)).toMatchObject({ uid: 900, folder: 'Archive' });
    expect(mgr.setFlags).toHaveBeenCalledWith(expect.anything(), 'Archive', [900], '\\Seen', true, { background: true });
  });
});

// M1, M2: a folder being emptied, renamed or deleted is held.
describe('a held folder', () => {
  it('while Trash is emptied: letters may be moved in, their MOVE waits, nothing is moved out', async () => {
    serverMoves();
    const release = queue.holdFolder(ACCOUNT, 'Trash', { kind: 'empty' });
    expect(await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Trash')).toEqual([A]);
    await queue.runAccount(ACCOUNT);
    expect(mgr.bulkMoveMessages).not.toHaveBeenCalled();
    expect(await moves()).toMatchObject([{ state: 'queued', attempts: 0 }]);

    // A letter in Trash is not moved out while it is emptied.
    await db.query("UPDATE messages SET folder = 'Trash', uid = 44 WHERE id = $1", [B]);
    expect(await queue.enqueue(ACCOUNT, await rowsOf([B]), 'INBOX')).toEqual([]);
    expect((await row(B)).folder).toBe('Trash');

    release();
    expect(queue.kick).toHaveBeenCalledWith(ACCOUNT);
    await queue.runAccount(ACCOUNT);
    expect(await row(A)).toMatchObject({ folder: 'Trash', uid: 900 });
  });

  it('while a folder is renamed or deleted, nothing is moved into it', async () => {
    const release = queue.holdFolder(ACCOUNT, 'Projects', { kind: 'rename', delimiter: '/' });
    expect(await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Projects/2026')).toEqual([]);
    expect(await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Projects')).toEqual([]);
    expect(await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive')).toEqual([A]);
    release();
  });

  it('leaves awaiting moves of a held folder to be looked up after it', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await db.query("UPDATE message_moves SET state = 'awaiting_uid'");
    const release = queue.holdFolder(ACCOUNT, 'Archive', { kind: 'rename', delimiter: '/' });
    await queue.runAccount(ACCOUNT);
    expect(mgr.searchUids).not.toHaveBeenCalled();
    release();
  });
});

describe('the worker', () => {
  it('sends one MOVE per (source, destination) group and the rows take the uids the server names', async () => {
    serverMoves();
    await queue.enqueue(ACCOUNT, await rowsOf([A, B]), 'Archive');
    await queue.enqueue(ACCOUNT, await rowsOf([C]), 'Archive');
    await queue.runAccount(ACCOUNT);

    expect(mgr.bulkMoveMessages).toHaveBeenCalledTimes(2);
    expect(mgr.bulkMoveMessages).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), [11, 12], 'INBOX', 'Archive', expect.objectContaining({ background: true }));
    expect(mgr.bulkMoveMessages).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), [13], 'Projects', 'Archive', expect.objectContaining({ background: true }));
    expect(await row(A)).toMatchObject({ uid: 900, folder: 'Archive' });
    expect(await row(B)).toMatchObject({ uid: 901, folder: 'Archive' });
    expect(await row(C)).toMatchObject({ uid: 902, folder: 'Archive' });
    expect(await moves()).toEqual([]);
    // The placeholder guards are gone; the source guard lingers a little for a FETCH in flight.
    expect([...mgr._pendingMoveUids.keys()].some(k => k.startsWith(`${ACCOUNT}:Archive:-`))).toBe(false);
    expect(guarded('INBOX', 11)).toBe(true);
  });

  it('waits for flag stores already called on the letters before the MOVE', async () => {
    let releaseStore;
    mgr.flagStoresSettled.mockImplementation(() => new Promise((resolve) => { releaseStore = resolve; }));
    serverMoves();
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    const run = queue.runAccount(ACCOUNT);
    await vi.waitFor(() => expect(mgr.flagStoresSettled).toHaveBeenCalledWith(ACCOUNT, 'INBOX', [11]));
    expect(mgr.bulkMoveMessages).not.toHaveBeenCalled();
    releaseStore();
    await run;
    expect(mgr.bulkMoveMessages).toHaveBeenCalledOnce();
  });

  it('stores a flag set while the move was pending at the new uid, never at the old one', async () => {
    serverMoves();
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    const [pendingRow] = await rowsOf([A]);
    // The user marks it read before the MOVE: the value goes onto the move.
    const { deferred, located } = await queue.deferFlags([pendingRow], '\\Seen', true);
    expect([...deferred]).toEqual([A]);
    expect(located.size).toBe(0);
    expect((await moves())[0].set_seen).toBe(true);

    await queue.runAccount(ACCOUNT);

    expect(mgr.setFlags).toHaveBeenCalledOnce();
    expect(mgr.setFlags).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), 'Archive', [900], '\\Seen', true, { background: true });
    // A fresh local-wins window: the letter arrived with its old flags.
    expect((await row(A)).read_changed_at).not.toBeNull();
  });

  it('gives the location to store at when the move settled before the flag change', async () => {
    serverMoves();
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    const [stale] = await rowsOf([A]);
    await queue.runAccount(ACCOUNT);
    const { deferred, located } = await queue.deferFlags([stale], '\\Seen', true);
    expect(deferred.size).toBe(0);
    expect(located.get(A)).toEqual({ uid: 900, folder: 'Archive' });
  });

  it('keeps the moves queued, without an attempt, while the mailbox gives no session', async () => {
    mgr.bulkMoveMessages.mockRejectedValue(Object.assign(new Error('IMAP pool busy, please retry'), { poolExhausted: true }));
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await queue.runAccount(ACCOUNT);
    expect(await moves()).toMatchObject([{ state: 'queued', attempts: 0 }]);
    expect((await row(A)).folder).toBe('Archive');
  });

  it('does not touch the server while a backoff holds background logins back', async () => {
    mgr._secondaryLoginBlocked.mockReturnValue({ until: Date.now() + 60000 });
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await queue.runAccount(ACCOUNT);
    expect(mgr.bulkMoveMessages).not.toHaveBeenCalled();
    expect(await moves()).toMatchObject([{ state: 'queued', attempts: 0 }]);
  });

  it('retries with backoff when the server did not move a letter it still has', async () => {
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [], failed: [11] });
    mgr.searchUids.mockResolvedValue([11]);
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await queue.runAccount(ACCOUNT);
    const [op] = await moves();
    expect(op).toMatchObject({ state: 'queued', attempts: 1 });
    expect(new Date(op.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect((await row(A)).folder).toBe('Archive');
  });

  it('gives up after MOVE_MAX_ATTEMPTS and returns the row to its source', async () => {
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [], failed: [11] });
    mgr.searchUids.mockResolvedValue([11]);
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await db.query('UPDATE message_moves SET attempts = $1', [MOVE_MAX_ATTEMPTS - 1]);
    await queue.runAccount(ACCOUNT);
    expect(await moves()).toEqual([]);
    expect(await row(A)).toMatchObject({ uid: 11, folder: 'INBOX' });
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'move_reverted', accountId: ACCOUNT, folder: 'INBOX', reason: 'gave_up', ids: [A] });
  });

  it('returns the row to its source and tells every client when the letter is gone from the server', async () => {
    // Gmail: deleted in the web UI while the move waited. MOVE names no uid, the source lacks it.
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map([[12, 901]]), succeeded: [12], failed: [11] });
    mgr.searchUids.mockResolvedValue([]);
    await queue.enqueue(ACCOUNT, await rowsOf([A, B]), 'Archive');
    await queue.runAccount(ACCOUNT);

    expect(await row(A)).toMatchObject({ uid: 11, folder: 'INBOX' });
    expect(await row(B)).toMatchObject({ uid: 901, folder: 'Archive' });
    expect(await moves()).toEqual([]);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'move_reverted', accountId: ACCOUNT, folder: 'INBOX', reason: 'gone', ids: [A] });
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'folder_updated', accountId: ACCOUNT, folder: 'INBOX' });
    // The counts go back: Archive loses the unread letter, INBOX gets it again.
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT, 'Archive', -1, -1);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT, 'INBOX', 1, 1);
    expect(guarded('INBOX', 11)).toBe(false);
  });

  it('returns the row when the destination folder is gone', async () => {
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [], failed: [11] });
    mgr.searchUids.mockResolvedValue([11]);
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await db.query("DELETE FROM folders WHERE path = 'Archive'");
    await queue.runAccount(ACCOUNT);
    expect(await row(A)).toMatchObject({ uid: 11, folder: 'INBOX' });
    expect(mgr.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'move_reverted', reason: 'destination_gone', ids: [A] }));
  });

  it('pushes a flag set while the move was pending at the source after a revert', async () => {
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [], failed: [11] });
    mgr.searchUids.mockResolvedValue([]);
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await queue.deferFlags(await rowsOf([A]), '\\Flagged', true);
    await queue.runAccount(ACCOUNT);
    expect(mgr._enqueueFlagPush).toHaveBeenCalledWith(ACCOUNT, A, '\\Flagged', true);
  });
});

describe('the destination sync', () => {
  it('attaches the letter to the moved row instead of inserting it again', async () => {
    // The MOVE is on its way; the destination sees the letter before the worker hears back.
    let answer;
    mgr.bulkMoveMessages.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    const run = queue.runAccount(ACCOUNT);
    await vi.waitFor(() => expect(mgr.bulkMoveMessages).toHaveBeenCalled());

    expect(queue.expectsArrival(ACCOUNT, 'Archive', '<a@example.com>')).toBe(true);
    // Another letter with a Message-ID nobody waits for is not claimed.
    expect(await queue.claimArrival(ACCOUNT, 'Archive', '<zzz@example.com>', 950)).toBe(false);
    expect(await queue.claimArrival(ACCOUNT, 'Archive', '<a@example.com>', 900)).toBe(true);
    expect(await row(A)).toMatchObject({ uid: 900, folder: 'Archive' });
    expect(await moves()).toEqual([]);

    answer({ uidMap: new Map([[11, 900]]), succeeded: [11], failed: [] });
    await run;
    const { rows } = await db.query("SELECT id FROM messages WHERE folder = 'Archive'");
    expect(rows).toEqual([{ id: A }]);
    expect(queue.expectsArrival(ACCOUNT, 'Archive', '<a@example.com>')).toBe(false);
  });

  it('does not claim a same Message-ID letter before the MOVE was sent: that is a separate copy', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    expect(queue.expectsArrival(ACCOUNT, 'Archive', '<a@example.com>')).toBe(false);
    expect(await queue.claimArrival(ACCOUNT, 'Archive', '<a@example.com>', 900)).toBe(false);
  });

  it('finds the new uid by Message-ID when the server named none', async () => {
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [11], failed: [] });
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await queue.runAccount(ACCOUNT);
    expect(await moves()).toMatchObject([{ state: 'awaiting_uid' }]);
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), 'Archive');

    mgr.findMessageIdInFolders.mockResolvedValue([{ folder: 'Archive', uids: [905] }]);
    await db.query('UPDATE message_moves SET next_attempt_at = now()');
    await queue.runAccount(ACCOUNT);
    expect(mgr.findMessageIdInFolders).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), expect.arrayContaining(['Archive']), '<a@example.com>', expect.objectContaining({ background: true }));
    expect(await row(A)).toMatchObject({ uid: 905, folder: 'Archive' });
    expect(await moves()).toEqual([]);
  });
});

// C1: a database error during a run must not strand claimed moves in 'moving'.
describe('a database error during a run', () => {
  const states = async () => (await moves()).map(o => `${o.src_folder}->${o.dest_folder}:${o.state}`).sort();

  it('puts the failing group back, keeps running the other groups, and the next run moves it', async () => {
    serverMoves();
    await queue.enqueue(ACCOUNT, await rowsOf([A, C]), 'Archive'); // INBOX->Archive, Projects->Archive
    const realSettle = queue._settle.bind(queue);
    let calls = 0;
    queue._settle = async (...args) => {
      if (calls++ === 0) throw new Error('Connection terminated unexpectedly');
      return realSettle(...args);
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await queue.runAccount(ACCOUNT);
    // The other group settled; the failing one went back. Its MOVE was sent, so it is looked up.
    expect(await states()).toEqual(['INBOX->Archive:awaiting_uid']);
    expect(await row(C)).toMatchObject({ folder: 'Archive', uid: 901 });

    // Next run: the source is checked first; the letter left it, and the destination has it.
    queue._settle = realSettle;
    await db.query('UPDATE message_moves SET next_attempt_at = now()');
    mgr.searchUids.mockResolvedValue([]);
    mgr.findMessageIdInFolders.mockResolvedValue([{ folder: 'Archive', uids: [900] }]);
    await queue.runAccount(ACCOUNT);
    expect(await moves()).toEqual([]);
    expect(await row(A)).toMatchObject({ folder: 'Archive', uid: 900 });
  });

  it('queues a group again when the error came before its MOVE was sent', async () => {
    serverMoves();
    await queue.enqueue(ACCOUNT, await rowsOf([A, C]), 'Archive');
    const realQuery = dbState.db.query.bind(dbState.db);
    let failed = false;
    dbState.db.query = async (sql, params) => {
      if (!failed && sql.includes('SELECT 1 FROM folders')) { failed = true; throw new Error('canceling statement due to statement timeout'); }
      if (!failed && sql.includes('SET claimed_at = now(), sent_at = now()')) { failed = true; throw new Error('canceling statement due to statement timeout'); }
      return realQuery(sql, params);
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await queue.runAccount(ACCOUNT);
    } finally {
      dbState.db.query = realQuery;
    }
    // The first group failed before its MOVE: queued again, nothing sent; the second one moved.
    expect(mgr.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(await states()).toEqual(['INBOX->Archive:queued']);
    expect(queue.expectsArrival(ACCOUNT, 'Archive', '<a@example.com>')).toBe(false);
    await db.query('UPDATE message_moves SET next_attempt_at = now()');
    await queue.runAccount(ACCOUNT);
    expect(await moves()).toEqual([]);
    expect((await row(A)).folder).toBe('Archive');
  });

  it('still runs the queued moves when looking up the awaiting ones fails', async () => {
    serverMoves();
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    const realQuery = dbState.db.query.bind(dbState.db);
    dbState.db.query = async (sql, params) => {
      if (sql.includes("state = 'awaiting_uid' AND next_attempt_at <= now()")) throw new Error('Connection terminated unexpectedly');
      return realQuery(sql, params);
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await queue.runAccount(ACCOUNT);
    } finally {
      dbState.db.query = realQuery;
    }
    expect(await row(A)).toMatchObject({ folder: 'Archive', uid: 900 });
  });

  it('is swept back by the tick when even the recovery failed', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    // Claimed and sent by a run that died without putting it back; no run is in progress.
    await db.query("UPDATE message_moves SET state = 'moving', claimed_at = now(), sent_at = now()");
    expect(await queue.sweep()).toBe(1);
    expect(await states()).toEqual(['INBOX->Archive:awaiting_uid']);

    // Claimed, never sent: queued again.
    await db.query("UPDATE message_moves SET state = 'moving', claimed_at = now(), sent_at = NULL");
    await queue.tick();
    expect(await states()).toEqual(['INBOX->Archive:queued']);
    expect(queue.kick).toHaveBeenCalledWith(ACCOUNT);
  });

  it('leaves the claims of a run in progress alone until their lease runs out', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await db.query("UPDATE message_moves SET state = 'moving', claimed_at = now(), sent_at = now()");
    queue._running.add(ACCOUNT);
    expect(await queue.sweep()).toBe(0);
    await db.query("UPDATE message_moves SET claimed_at = now() - interval '1 hour'");
    expect(await queue.sweep()).toBe(1);
    queue._running.delete(ACCOUNT);
  });
});

// I2, M14, M7: a letter gone from its source is looked for before anything is reverted.
describe('a letter gone from its source', () => {
  const COPY = '41000000-0000-4000-8000-000000000009';

  it('a MOVE that landed but whose answer and source check were lost is found, not reverted', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    // Attempt 1: the connection drops; the reconciling search and the source check fail too.
    mgr.bulkMoveMessages.mockResolvedValueOnce({ uidMap: new Map(), succeeded: [], failed: [11] });
    mgr.searchUids.mockRejectedValueOnce(new Error('Connection closed'));
    await queue.runAccount(ACCOUNT);
    // No clear answer: looked up before anything is sent again.
    expect(await moves()).toMatchObject([{ state: 'awaiting_uid', attempts: 1 }]);

    await db.query('UPDATE message_moves SET next_attempt_at = now()');
    mgr.searchUids.mockResolvedValueOnce([]); // gone from INBOX: it is in Archive as 900
    mgr.findMessageIdInFolders.mockResolvedValue([{ folder: 'Archive', uids: [900] }]);
    await queue.runAccount(ACCOUNT);
    expect(await row(A)).toMatchObject({ uid: 900, folder: 'Archive' });
    expect(await moves()).toEqual([]);
    expect(mgr.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(mgr.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'move_reverted' }));
  });

  it('a MOVE the server reports failed for a letter already in the destination settles there', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [], failed: [11] });
    mgr.searchUids.mockResolvedValue([]);
    mgr.findMessageIdInFolders.mockResolvedValue([{ folder: 'Archive', uids: [900] }]);
    await queue.runAccount(ACCOUNT);
    expect(await row(A)).toMatchObject({ uid: 900, folder: 'Archive' });
    expect(mgr.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'move_reverted' }));
  });

  it('moved by another client into another folder: the row follows it, keeps its id, no toast', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    // Outlook moved it to Projects meanwhile; the Projects sync inserted it as a new row.
    await db.query("INSERT INTO messages (id, account_id, uid, folder, message_id) VALUES ($1, $2, 55, 'Projects', '<a@example.com>')", [COPY, ACCOUNT]);
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [], failed: [11] });
    mgr.searchUids.mockResolvedValue([]);
    mgr.findMessageIdInFolders.mockResolvedValue([{ folder: 'Projects', uids: [55] }]);
    await queue.runAccount(ACCOUNT);

    expect(mgr.findMessageIdInFolders).toHaveBeenCalledWith(expect.anything(), ['Archive', 'Projects', 'Trash'], '<a@example.com>', expect.anything());
    expect(await row(A)).toMatchObject({ uid: 55, folder: 'Projects' });
    expect(await row(COPY)).toBeUndefined();
    expect(await moves()).toEqual([]);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT, 'Archive', -1, -1);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT, 'Projects', 1, 1);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'folder_updated', folder: 'Projects', accountId: ACCOUNT });
    expect(mgr.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'move_reverted' }));
  });

  it('an older copy of the letter elsewhere is not taken for it: reverted as gone', async () => {
    await db.query("INSERT INTO messages (id, account_id, uid, folder, message_id, synced_at) VALUES ($1, $2, 55, 'Projects', '<a@example.com>', now() - interval '1 day')", [COPY, ACCOUNT]);
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [], failed: [11] });
    mgr.searchUids.mockResolvedValue([]);
    mgr.findMessageIdInFolders.mockResolvedValue([{ folder: 'Projects', uids: [55] }]);
    await queue.runAccount(ACCOUNT);
    expect(await row(COPY)).toMatchObject({ uid: 55, folder: 'Projects' });
    expect(await row(A)).toMatchObject({ uid: 11, folder: 'INBOX' });
    expect(mgr.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'move_reverted', reason: 'gone' }));
  });

  it('a thrown MOVE is looked up before it is sent again, and never reverted from there', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    mgr.bulkMoveMessages.mockRejectedValue(new Error('Socket closed'));
    await db.query('UPDATE message_moves SET attempts = $1', [MOVE_MAX_ATTEMPTS + 2]);
    await queue.runAccount(ACCOUNT);
    expect(await moves()).toMatchObject([{ state: 'awaiting_uid' }]);
    expect(mgr.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'move_reverted' }));

    // Still at the source after every attempt: now it is reverted.
    await db.query('UPDATE message_moves SET next_attempt_at = now()');
    mgr.searchUids.mockResolvedValue([11]);
    await queue.runAccount(ACCOUNT);
    expect(await row(A)).toMatchObject({ uid: 11, folder: 'INBOX' });
    expect(mgr.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'move_reverted', reason: 'gave_up' }));
  });

  it('a letter without a Message-ID whose MOVE named no uid drops its row at once for the sync', async () => {
    await db.query('UPDATE messages SET message_id = NULL WHERE id = $1', [A]);
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [11], failed: [] });
    await queue.runAccount(ACCOUNT);
    expect(await row(A)).toBeUndefined();
    expect(await moves()).toEqual([]);
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), 'Archive');
  });
});

describe('a move whose new uid cannot be found', () => {
  // The MOVE went through without a uid, and nothing finds the letter for MOVE_AWAITING_UID_MAX_MS.
  async function awaitingTooLong() {
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [11], failed: [] });
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await queue.runAccount(ACCOUNT);
    await db.query("UPDATE message_moves SET updated_at = now() - interval '1 hour', next_attempt_at = now()");
  }

  it('reverts a letter that is nowhere: gone from the source and in no folder', async () => {
    await awaitingTooLong();
    await queue.runAccount(ACCOUNT);
    expect(await moves()).toEqual([]);
    expect(await row(A)).toMatchObject({ uid: 11, folder: 'INBOX' });
    expect(mgr.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'move_reverted', reason: 'gone', ids: [A] }));
  });

  it('drops the row, and a move that followed it, when the lookup keeps failing', async () => {
    await awaitingTooLong();
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Trash');
    expect(await moves()).toHaveLength(2);
    await db.query("UPDATE message_moves SET updated_at = now() - interval '1 hour', next_attempt_at = now() WHERE state = 'awaiting_uid'");
    mgr.findMessageIdInFolders.mockRejectedValue(new Error('Mailbox does not exist'));
    await queue.runAccount(ACCOUNT);
    expect(await moves()).toEqual([]);
    expect(await row(A)).toBeUndefined();
    expect([...mgr._pendingMoveUids.keys()].some(k => k.includes(':-'))).toBe(false);
  });

  it('stops looking when the lookup keeps failing', async () => {
    await awaitingTooLong();
    mgr.findMessageIdInFolders.mockRejectedValue(new Error('Mailbox does not exist'));
    await queue.runAccount(ACCOUNT);
    expect(await moves()).toEqual([]);
    expect(await row(A)).toBeUndefined();
  });
});

describe('a letter moved again while its first move is in flight', () => {
  it('gets a second move that starts from the uid the first one lands on', async () => {
    let answer;
    mgr.bulkMoveMessages.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    const run = queue.runAccount(ACCOUNT);
    await vi.waitFor(() => expect(mgr.bulkMoveMessages).toHaveBeenCalled());

    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Trash');
    const [first, second] = await moves();
    expect(second).toMatchObject({ src_folder: 'Archive', src_uid: null, dest_folder: 'Trash', predecessor_id: first.id, state: 'queued' });
    expect(await row(A)).toMatchObject({ uid: placeholderUid(second.id), folder: 'Trash' });

    answer({ uidMap: new Map([[11, 900]]), succeeded: [11], failed: [] });
    await run;
    const [handed] = await moves();
    expect(handed).toMatchObject({ id: second.id, src_folder: 'Archive', predecessor_id: null });
    expect(Number(handed.src_uid)).toBe(900);
    // The letter now waits at Archive/900: no Archive sync may insert it there.
    expect(guarded('Archive', 900)).toBe(true);

    serverMoves(700);
    await queue.runAccount(ACCOUNT);
    expect(mgr.bulkMoveMessages).toHaveBeenLastCalledWith(expect.anything(), [900], 'Archive', 'Trash', expect.anything());
    expect(await row(A)).toMatchObject({ uid: 700, folder: 'Trash' });
  });
});

describe('Gmail', () => {
  it('drops the row once a letter archived to All Mail has moved', async () => {
    serverMoves();
    await queue.enqueue(ACCOUNT, await rowsOf([A]), '[Gmail]/All Mail', { dropRow: true });
    expect((await row(A)).folder).toBe('[Gmail]/All Mail');
    await queue.runAccount(ACCOUNT);
    expect(await row(A)).toBeUndefined();
    expect(await moves()).toEqual([]);
  });

  it('keeps the moved row when the server names the uid of a label copy it already had', async () => {
    // MOVE into a label the letter already carries answers with that copy's uid (COPYUID).
    const SIBLING = '41000000-0000-4000-8000-000000000009';
    await db.query("INSERT INTO messages (id, account_id, uid, folder, message_id) VALUES ($1, $2, 55, 'Projects', '<a@example.com>')", [SIBLING, ACCOUNT]);
    mgr.bulkMoveMessages.mockResolvedValue({ uidMap: new Map([[11, 55]]), succeeded: [11], failed: [] });
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Projects');
    await queue.runAccount(ACCOUNT);
    expect(await row(A)).toMatchObject({ uid: 55, folder: 'Projects' });
    expect(await row(SIBLING)).toBeUndefined();
  });

  it('asks for the Gmail id backfill for a moved row that has no ids yet', async () => {
    serverMoves();
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await queue.runAccount(ACCOUNT);
    expect(mgr._scheduleProviderIdBackfill).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }));
  });
});

describe('a restart', () => {
  it('rebuilds the guards and resumes queued moves', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    const [op] = await moves();

    // A new process: new manager state, same database.
    mgr = fakeManager();
    queue = newQueue();
    queue.start = vi.fn();
    expect(await queue.resume()).toBe(1);
    expect(guarded('INBOX', 11)).toBe(true);
    expect(guarded('Archive', placeholderUid(op.id))).toBe(true);
    expect(queue.kick).toHaveBeenCalledWith(ACCOUNT);

    serverMoves();
    await queue.runAccount(ACCOUNT);
    expect(await row(A)).toMatchObject({ uid: 900, folder: 'Archive' });
  });

  it('looks up a move that was in flight: moved already, the row takes its uid', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    // Claimed and sent when the process stopped.
    await db.query("UPDATE message_moves SET state = 'moving', claimed_at = now(), sent_at = now()");
    mgr = fakeManager();
    queue = newQueue();
    queue.start = vi.fn();
    await queue.resume();
    expect(await moves()).toMatchObject([{ state: 'awaiting_uid' }]);
    expect(queue.expectsArrival(ACCOUNT, 'Archive', '<a@example.com>')).toBe(true);

    mgr.findMessageIdInFolders.mockResolvedValue([{ folder: 'Archive', uids: [907] }]);
    await queue.runAccount(ACCOUNT);
    expect(mgr.bulkMoveMessages).not.toHaveBeenCalled();
    expect(await row(A)).toMatchObject({ uid: 907, folder: 'Archive' });
  });

  it('looks up a move that was in flight: still at the source, it is queued again', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    // Claimed and sent when the process stopped.
    await db.query("UPDATE message_moves SET state = 'moving', claimed_at = now(), sent_at = now()");
    mgr = fakeManager();
    queue = newQueue();
    queue.start = vi.fn();
    await queue.resume();

    // Queued again in the same run, where the MOVE finds the mailbox busy: still no attempt.
    mgr.searchUids.mockResolvedValue([11]);
    mgr.bulkMoveMessages.mockRejectedValueOnce(Object.assign(new Error('IMAP pool busy, please retry'), { poolExhausted: true }));
    await queue.runAccount(ACCOUNT);
    expect(mgr.searchUids).toHaveBeenCalledWith(expect.anything(), 'INBOX', [11], expect.anything());
    expect(await moves()).toMatchObject([{ state: 'queued', attempts: 0 }]);
    serverMoves();
    await queue.runAccount(ACCOUNT);
    expect(await row(A)).toMatchObject({ uid: 900, folder: 'Archive' });
  });
});

// I1: after a restart the source is checked first. The destination is looked at only for a letter
// gone from the source, so a letter that is there anyway is never taken for the moved one.
describe('a restart with a move whose answer was lost, the letter still at its source', () => {
  async function restartWithSentMove(dest, opts) {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), dest, opts);
    await db.query("UPDATE message_moves SET state = 'moving', claimed_at = now(), sent_at = now()");
    mgr = fakeManager();
    queue = newQueue();
    queue.start = vi.fn();
    await queue.resume();
    mgr.searchUids.mockResolvedValue([11]); // the server still has the letter in INBOX
  }

  it('Gmail archive: All Mail holds every letter, so it proves nothing; the MOVE is sent again', async () => {
    await restartWithSentMove('[Gmail]/All Mail', { dropRow: true });
    mgr.findMessageIdInFolders.mockResolvedValue([{ folder: 'Archive', uids: [5000] }]);
    serverMoves(6000);
    await queue.runAccount(ACCOUNT);
    // Queued again and sent in the same run; nothing was taken from All Mail.
    expect(mgr.findMessageIdInFolders).not.toHaveBeenCalled();
    expect(mgr.bulkMoveMessages).toHaveBeenCalledWith(expect.anything(), [11], 'INBOX', '[Gmail]/All Mail', expect.anything());
    expect(await row(A)).toBeUndefined();
    expect(await moves()).toEqual([]);
  });

  it('Dovecot: another copy with the same Message-ID in the destination is left alone', async () => {
    const COPY = '41000000-0000-4000-8000-000000000009';
    await db.query("INSERT INTO messages (id, account_id, uid, folder, message_id) VALUES ($1, $2, 77, 'Archive', '<a@example.com>')", [COPY, ACCOUNT]);
    await restartWithSentMove('Archive');
    mgr.findMessageIdInFolders.mockResolvedValue([{ folder: 'Archive', uids: [77] }]);
    serverMoves(900);
    await queue.runAccount(ACCOUNT);
    expect(mgr.findMessageIdInFolders).not.toHaveBeenCalled();
    expect(mgr.bulkMoveMessages).toHaveBeenCalledWith(expect.anything(), [11], 'INBOX', 'Archive', expect.anything());
    expect(await row(A)).toMatchObject({ uid: 900, folder: 'Archive' });
    expect(await row(COPY)).toMatchObject({ uid: 77, folder: 'Archive' });
  });

  it('keeps the retry backoff of a move that already failed', async () => {
    await restartWithSentMove('Archive');
    await db.query('UPDATE message_moves SET attempts = 2');
    await queue.runAccount(ACCOUNT);
    const [op] = await moves();
    expect(op).toMatchObject({ state: 'queued', attempts: 2 });
    expect(new Date(op.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('a restart with a claimed move whose MOVE was never sent', () => {
  it('queues it again without looking anything up', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await db.query("UPDATE message_moves SET state = 'moving', claimed_at = now()");
    mgr = fakeManager();
    queue = newQueue();
    queue.start = vi.fn();
    await queue.resume();
    expect(await moves()).toMatchObject([{ state: 'queued' }]);
    expect(queue.expectsArrival(ACCOUNT, 'Archive', '<a@example.com>')).toBe(false);
  });
});

describe('serverLocation', () => {
  it('reads a queued letter at its source and a moved one where it is', async () => {
    const [before] = await rowsOf([A]);
    expect(await queue.serverLocation(before)).toEqual({ folder: 'INBOX', uid: 11 });
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    const [pending] = await rowsOf([A]);
    expect(await queue.serverLocation(pending)).toEqual({ folder: 'INBOX', uid: 11 });
    await db.query("UPDATE message_moves SET state = 'moving'");
    expect(await queue.serverLocation(pending)).toBeNull();
  });
});
