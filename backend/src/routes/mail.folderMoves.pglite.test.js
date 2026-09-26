// Folder rename and delete against DB-first moves (services/moveQueue.js), on PGlite with the real
// schema and a real MoveQueue. A rename rewrites the paths of queued moves and their guards; a move
// whose MOVE is on its way, or any move for a delete, makes the route wait (409 move_pending).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../services/testing/realSchema.js';

const dbState = { db: null };
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
const mgrState = {};
vi.mock('../index.js', () => ({ get imapManager() { return mgrState.mgr; } }));

const { MoveQueue, placeholderUid } = await import('../services/moveQueue.js');
const { ImapManager } = await import('../services/imapManager.js');
const express = (await import('express')).default;
const mailRoutes = (await import('./mail.js')).default;

const ACCOUNT = '40000000-0000-4000-8000-000000000001';
const A = '41000000-0000-4000-8000-000000000001';
let db;
let server;
let base;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

beforeEach(async () => {
  await db.exec('DELETE FROM message_moves; DELETE FROM messages; DELETE FROM folders; DELETE FROM email_accounts;');
  await db.query("INSERT INTO email_accounts (id, name, email_address) VALUES ($1, 'Office', 'office@example.com')", [ACCOUNT]);
  for (const path of ['INBOX', 'Projects', 'Projects/2026']) {
    await db.query("INSERT INTO folders (account_id, path, name, delimiter) VALUES ($1, $2, $2, '/')", [ACCOUNT, path]);
  }
  await db.query("INSERT INTO messages (id, account_id, uid, folder, message_id) VALUES ($1, $2, 11, 'INBOX', '<a@example.com>')", [A, ACCOUNT]);
  const mgr = {
    _pendingMoveUids: new Map(),
    _guardMoveUid: ImapManager.prototype._guardMoveUid,
    _unguardMoveUid: ImapManager.prototype._unguardMoveUid,
    _isMoveUidGuarded: ImapManager.prototype._isMoveUidGuarded,
    _pendingFlagPush: new Map(),
    renameFolder: vi.fn(async () => {}),
    deleteFolder: vi.fn(async () => {}),
    broadcast: vi.fn(),
  };
  mgr.moveQueue = new MoveQueue(mgr);
  mgr.moveQueue.kick = vi.fn();
  mgrState.mgr = mgr;
});

const call = async (path, body) => {
  const res = await fetch(`${base}/api/mail${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const rows = async (ids) => (await db.query('SELECT * FROM messages WHERE id = ANY($1::uuid[])', [ids])).rows;
const moves = async () => (await db.query('SELECT * FROM message_moves ORDER BY id')).rows;

describe('renaming a folder with DB-first moves into it', () => {
  it('rewrites the queued moves and the moved rows to the new path, and their guards', async () => {
    const mgr = mgrState.mgr;
    await mgr.moveQueue.enqueue(ACCOUNT, await rows([A]), 'Projects/2026');
    const [op] = await moves();

    const res = await call('/folders/rename', { accountId: ACCOUNT, oldPath: 'Projects', newName: 'Clients' });
    expect(res).toEqual({ status: 200, body: { ok: true, newPath: 'Clients' } });
    expect(await moves()).toMatchObject([{ src_folder: 'INBOX', dest_folder: 'Clients/2026' }]);
    expect((await rows([A]))[0]).toMatchObject({ folder: 'Clients/2026' });
    expect(Number((await rows([A]))[0].uid)).toBe(placeholderUid(op.id));
    expect(mgr._isMoveUidGuarded(ACCOUNT, 'Clients/2026', placeholderUid(op.id))).toBe(true);
    expect(mgr._isMoveUidGuarded(ACCOUNT, 'Projects/2026', placeholderUid(op.id))).toBe(false);
    expect(mgr._isMoveUidGuarded(ACCOUNT, 'INBOX', 11)).toBe(true);
    // The hold is gone: the move can run again.
    expect(mgr.moveQueue._heldBy(ACCOUNT, 'Clients/2026')).toBeNull();
    expect(mgr.moveQueue._heldBy(ACCOUNT, 'Projects/2026')).toBeNull();
  });

  it('waits (409 move_pending) while a MOVE into the tree is on its way', async () => {
    const mgr = mgrState.mgr;
    await mgr.moveQueue.enqueue(ACCOUNT, await rows([A]), 'Projects/2026');
    await db.query("UPDATE message_moves SET state = 'moving'");
    const res = await call('/folders/rename', { accountId: ACCOUNT, oldPath: 'Projects', newName: 'Clients' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('move_pending');
    expect(mgr.renameFolder).not.toHaveBeenCalled();
    expect(mgr.moveQueue._heldBy(ACCOUNT, 'Projects')).toBeNull();
  });

  it('holds the tree while the server renames it: no letter is moved into it meanwhile', async () => {
    const mgr = mgrState.mgr;
    let inRename;
    mgr.renameFolder.mockImplementation(async () => {
      inRename = await mgr.moveQueue.enqueue(ACCOUNT, await rows([A]), 'Projects/2026');
    });
    await call('/folders/rename', { accountId: ACCOUNT, oldPath: 'Projects', newName: 'Clients' });
    expect(inRename).toEqual([]);
    expect(await moves()).toEqual([]);
  });
});

describe('deleting a folder with DB-first moves into it', () => {
  it('waits (409 move_pending) while any move goes into or out of the tree', async () => {
    const mgr = mgrState.mgr;
    await mgr.moveQueue.enqueue(ACCOUNT, await rows([A]), 'Projects/2026');
    const res = await call('/folders/delete', { accountId: ACCOUNT, path: 'Projects' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('move_pending');
    expect(mgr.deleteFolder).not.toHaveBeenCalled();
    expect(mgr.moveQueue._heldBy(ACCOUNT, 'Projects')).toBeNull();
  });

  it('deletes a folder no move touches', async () => {
    const res = await call('/folders/delete', { accountId: ACCOUNT, path: 'Projects' });
    expect(res.status).toBe(200);
    expect(mgrState.mgr.deleteFolder).toHaveBeenCalledOnce();
  });
});
