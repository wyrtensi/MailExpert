// DB-first moves (moveQueue.js) against a real (in-process) Postgres engine and the real
// migration: the row moves at once and holds a placeholder uid, the worker sends one MOVE per
// (source, destination) group, the row takes the uid the server names, a destination sync that
// sees the letter first attaches it instead of inserting it again, and a permanent failure puts
// the row back where the server has the letter. The mail server is a fake manager.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

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

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const ACCOUNT = '40000000-0000-4000-8000-000000000001';
const A = '41000000-0000-4000-8000-000000000001';
const B = '41000000-0000-4000-8000-000000000002';
const C = '41000000-0000-4000-8000-000000000003';
let db;

async function runMigrationFile(filename) {
  const statements = readFileSync(join(migrationsDir, filename), 'utf8')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.query(statement);
}

beforeAll(async () => {
  db = await PGlite.create();
  dbState.db = db;
  // The columns the queue touches, as the baseline and later migrations define them.
  await db.exec(`
    CREATE TABLE email_accounts (id uuid PRIMARY KEY);
    CREATE TABLE folders (account_id uuid NOT NULL, path text NOT NULL, PRIMARY KEY (account_id, path));
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      uid bigint NOT NULL,
      folder text NOT NULL,
      message_id text,
      is_read boolean NOT NULL DEFAULT false,
      is_starred boolean NOT NULL DEFAULT false,
      read_changed_at timestamptz,
      star_changed_at timestamptz,
      synced_at timestamptz DEFAULT now(),
      provider_message_id text,
      UNIQUE (account_id, uid, folder)
    );
  `);
  await runMigrationFile('0075_message_moves.sql');
});
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
    findUidByMessageId: vi.fn(async () => null),
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
  await db.exec('DELETE FROM message_moves; DELETE FROM messages; DELETE FROM folders; DELETE FROM email_accounts;');
  await db.query('INSERT INTO email_accounts (id) VALUES ($1)', [ACCOUNT]);
  for (const path of ['INBOX', 'Archive', 'Trash', 'Projects', '[Gmail]/All Mail']) {
    await db.query('INSERT INTO folders (account_id, path) VALUES ($1, $2)', [ACCOUNT, path]);
  }
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

    mgr.findUidByMessageId.mockResolvedValue(905);
    await db.query('UPDATE message_moves SET next_attempt_at = now()');
    await queue.runAccount(ACCOUNT);
    expect(mgr.findUidByMessageId).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), 'Archive', '<a@example.com>', expect.objectContaining({ background: true }));
    expect(await row(A)).toMatchObject({ uid: 905, folder: 'Archive' });
    expect(await moves()).toEqual([]);
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
    await db.query("UPDATE message_moves SET state = 'moving'");
    mgr = fakeManager();
    queue = newQueue();
    queue.start = vi.fn();
    await queue.resume();
    expect(await moves()).toMatchObject([{ state: 'awaiting_uid' }]);
    expect(queue.expectsArrival(ACCOUNT, 'Archive', '<a@example.com>')).toBe(true);

    mgr.findUidByMessageId.mockResolvedValue(907);
    await queue.runAccount(ACCOUNT);
    expect(mgr.bulkMoveMessages).not.toHaveBeenCalled();
    expect(await row(A)).toMatchObject({ uid: 907, folder: 'Archive' });
  });

  it('looks up a move that was in flight: still at the source, it is queued again', async () => {
    await queue.enqueue(ACCOUNT, await rowsOf([A]), 'Archive');
    await db.query("UPDATE message_moves SET state = 'moving'");
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
