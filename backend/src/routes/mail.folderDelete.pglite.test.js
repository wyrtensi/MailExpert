// POST /api/mail/folders/delete on PGlite with the real schema: the letters a folder delete
// destroys are journaled like any other permanent delete, and special-use folders are refused.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../services/testing/realSchema.js';

const dbState = { db: null };
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/auditLog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  recordAudit: vi.fn(async () => {}),
}));
const mgrState = {};
vi.mock('../index.js', () => ({ get imapManager() { return mgrState.mgr; } }));

const { MoveQueue } = await import('../services/moveQueue.js');
const { recordAudit } = await import('../services/auditLog.js');
const express = (await import('express')).default;
const mailRoutes = (await import('./mail.js')).default;

const ACCOUNT = '42000000-0000-4000-8000-000000000001';
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
  vi.clearAllMocks();
  await db.exec('DELETE FROM message_moves; DELETE FROM messages; DELETE FROM folders; DELETE FROM email_accounts;');
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, folder_mappings)
     VALUES ($1, 'Office', 'office@example.com', '{"archive": "Old"}'::jsonb)`,
    [ACCOUNT],
  );
  const folders = [
    ['INBOX', null], ['Contracts', null], ['Sent', '\\Sent'], ['Drafts', '\\Drafts'], ['Trash', '\\Trash'],
    ['Junk', '\\Junk'], ['Archive', '\\Archive'], ['All Mail', '\\All'], ['Old', null],
  ];
  for (const [path, specialUse] of folders) {
    await db.query(
      "INSERT INTO folders (account_id, path, name, delimiter, special_use) VALUES ($1, $2, $2, '/', $3)",
      [ACCOUNT, path, specialUse],
    );
  }
  for (const [uid, folder] of [[1, 'Contracts'], [2, 'Contracts'], [3, 'INBOX']]) {
    await db.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, from_email)
       VALUES ($1, $2, $3, $4, 'sender@example.com')`,
      [ACCOUNT, uid, folder, `<${uid}@example.com>`],
    );
  }
  const mgr = { deleteFolder: vi.fn(async () => {}), broadcast: vi.fn() };
  mgr.moveQueue = new MoveQueue(mgr);
  mgr.moveQueue.kick = vi.fn();
  mgrState.mgr = mgr;
});

const call = async (body) => {
  const res = await fetch(`${base}/api/mail/folders/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

describe('deleting a folder', () => {
  it('journals every letter it destroys as a permanent message.deleted', async () => {
    const res = await call({ accountId: ACCOUNT, path: 'Contracts' });
    expect(res.status).toBe(200);
    const entries = recordAudit.mock.calls.flatMap(([list]) => list);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.details.messageId).sort()).toEqual(['<1@example.com>', '<2@example.com>']);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        actorUserId: 'u1', accountId: ACCOUNT, action: 'message.deleted',
        details: { folder: 'Contracts', from: 'sender@example.com', permanent: true },
      });
    }
    const left = (await db.query('SELECT folder FROM messages WHERE account_id = $1', [ACCOUNT])).rows;
    expect(left).toEqual([{ folder: 'INBOX' }]);
  });

  it('journals nothing when the server refuses the delete', async () => {
    mgrState.mgr.deleteFolder.mockRejectedValueOnce(new Error('NO [CANNOT]'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call({ accountId: ACCOUNT, path: 'Contracts' });
    expect(res.status).toBe(500);
    expect(recordAudit).not.toHaveBeenCalled();
    const left = (await db.query("SELECT 1 FROM messages WHERE folder = 'Contracts'")).rows;
    expect(left).toHaveLength(2);
  });

  it.each(['INBOX', 'inbox', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive', 'All Mail', 'Old'])(
    'refuses the special folder %s',
    async (path) => {
      const res = await call({ accountId: ACCOUNT, path });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('special_folder');
      expect(mgrState.mgr.deleteFolder).not.toHaveBeenCalled();
    },
  );
});
