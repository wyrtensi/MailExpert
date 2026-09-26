import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// DB-first moves (services/moveQueue.js) at the routes: a move changes the database through the
// queue, adjusts the folder counts and tells every client at once, without any IMAP call. A read
// or star change on a letter whose move has not reached the server goes onto the move instead of
// a STORE at a uid the letter no longer has once the MOVE runs.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
    moveMessage: vi.fn(),
    bulkMoveMessages: vi.fn(),
    setFlag: vi.fn(async () => {}),
    setFlagsGroups: vi.fn(async (_account, groups) => groups.map(() => ({ stored: true }))),
    fetchMessageBody: vi.fn(async () => ({ html: '<p>hi</p>', text: 'hi', attachments: [] })),
    noteUserActivity: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    _resolveFlagPush: vi.fn(),
    scheduleCountRefresh: vi.fn(),
    moveQueue: {
      enqueue: vi.fn(async (_accountId, rows) => rows.map(r => ({ id: r.id, from: r.folder, isRead: !!r.is_read }))),
      deferFlags: vi.fn(),
      serverLocation: vi.fn(),
    },
  },
}));
vi.mock('../plugins/registry.js', () => ({
  pluginRegistry: { runHook: vi.fn(async () => {}), collectHook: vi.fn(async () => []), hasActiveAsync: vi.fn(async () => false) },
}));
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveTrashFolder: vi.fn(async () => 'Trash'),
  resolveAllTrashPaths: vi.fn(async () => new Set(['Trash'])),
  resolveAllDraftsPaths: vi.fn(async () => new Set(['Drafts'])),
  resolveSpamFolder: vi.fn(async () => 'Junk'),
  resolveAllSpamPaths: vi.fn(async () => new Set(['Junk'])),
  resolveArchiveFolder: vi.fn(async () => '[Gmail]/All Mail'),
  isAllMailFolder: vi.fn(async () => true),
  adjustFolderCounts: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const UNREAD_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const READ_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const PENDING_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const MSG = (id, folder, uid, isRead) => ({
  id, account_id: ACCOUNT_ID, uid, folder, is_read: isRead, is_starred: false, message_id: `<${uid}@example.com>`,
  subject: 'Board minutes', from_email: 'sender@example.com', folder_mappings: null, sibling_count: 1,
  body_html: null, body_text: null, attachments: '[]', snippet: 'x', preferences: {},
});
const rows = {
  [UNREAD_ID]: MSG(UNREAD_ID, 'INBOX', 11, false),
  [READ_ID]: MSG(READ_ID, 'INBOX', 12, true),
  // Moved to Archive a moment ago; its MOVE has not run yet (placeholder uid -9).
  [PENDING_ID]: MSG(PENDING_ID, 'Archive', -9, false),
};

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  query.mockReset().mockImplementation(async (sql, params) => {
    if (/FROM messages m[\s\S]*WHERE m\.id = \$1/.test(sql)) return { rows: rows[params[0]] ? [rows[params[0]]] : [] };
    if (/FROM messages m[\s\S]*m\.id = ANY/.test(sql)) return { rows: params[0].map((id) => rows[id]).filter(Boolean) };
    if (sql.includes('FROM email_accounts WHERE id = $1')) return { rows: [{ id: ACCOUNT_ID, folder_mappings: null }] };
    if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ '?column?': 1 }] };
    return { rows: [], rowCount: 1 };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const call = async (method, path, body) => {
  const res = await fetch(`${base}/api/mail${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

describe('a move changes the database at once', () => {
  it('queues the rows, moves the counts with them and tells every client', async () => {
    const res = await call('POST', '/messages/bulk-move', { ids: [UNREAD_ID, READ_ID], folder: 'Projects' });
    expect(res).toEqual({ status: 200, body: { ok: true, moved: [UNREAD_ID, READ_ID] } });
    expect(imapManager.moveQueue.enqueue).toHaveBeenCalledOnce();
    expect(imapManager.moveQueue.enqueue).toHaveBeenCalledWith(
      ACCOUNT_ID, [expect.objectContaining({ id: UNREAD_ID, folder: 'INBOX' }), expect.objectContaining({ id: READ_ID })], 'Projects', { dropRow: false, movedBy: 'u1' },
    );
    // Two letters leave INBOX, one of them unread, and land in Projects.
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', -2, -1);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT_ID, 'Projects', 2, 1);
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'folder_updated', folder: 'Projects', accountId: ACCOUNT_ID });
    expect(imapManager.bulkMoveMessages).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });

  it('counts only the rows the queue moved', async () => {
    imapManager.moveQueue.enqueue.mockResolvedValueOnce([{ id: READ_ID, from: 'INBOX', isRead: true }]);
    const res = await call('POST', '/messages/bulk-move', { ids: [UNREAD_ID, READ_ID], folder: 'Projects' });
    expect(res.body.moved).toEqual([READ_ID]);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', -1, 0);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT_ID, 'Projects', 1, 0);
  });

  // Another request moved the unread letter to Archive between this route's read and its move:
  // the counts follow what the move saw under its lock, not the route's stale INBOX.
  it('counts from the folder and read state the move saw, not from the route read', async () => {
    imapManager.moveQueue.enqueue.mockResolvedValueOnce([{ id: UNREAD_ID, from: 'Archive', isRead: false }]);
    await call('POST', '/messages/bulk-move', { ids: [UNREAD_ID], folder: 'Projects' });
    expect(adjustFolderCounts).toHaveBeenCalledTimes(2);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT_ID, 'Archive', -1, -1);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT_ID, 'Projects', 1, 1);
  });

  it('archives to Gmail All Mail: the row goes once moved, All Mail counts are not kept', async () => {
    const res = await call('POST', '/messages/bulk-archive', { ids: [UNREAD_ID] });
    expect(res.body.archived).toEqual([UNREAD_ID]);
    expect(imapManager.moveQueue.enqueue).toHaveBeenCalledWith(ACCOUNT_ID, [expect.objectContaining({ id: UNREAD_ID })], '[Gmail]/All Mail', { dropRow: true, movedBy: 'u1' });
    expect(adjustFolderCounts).toHaveBeenCalledTimes(1);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', -1, -1);
  });

  it('marks as spam in the database and records the verdict', async () => {
    imapManager.moveQueue.serverLocation.mockResolvedValueOnce({ folder: 'INBOX', uid: 11 });
    const res = await call('POST', `/messages/${UNREAD_ID}/spam`);
    expect(res.body).toEqual({ ok: true, folder: 'Junk', newUid: null });
    expect(query.mock.calls.some(([sql, params]) => sql.includes('SET spam_user_override') && params[0] === 'spam')).toBe(true);
    const log = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO spam_training_log'));
    expect(log[1]).toEqual(['u1', ACCOUNT_ID, '<11@example.com>', 11, 'INBOX', 'spam']);
  });

  // M11: a letter whose earlier move is pending holds a placeholder uid; the training log records
  // where the server has it, or nothing, never the placeholder or the folder it is only going to.
  it('records the server location of a letter whose move is pending, or none', async () => {
    imapManager.moveQueue.serverLocation.mockResolvedValueOnce({ folder: 'INBOX', uid: 21 });
    await call('POST', `/messages/${PENDING_ID}/spam`);
    let log = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO spam_training_log')).at(-1);
    expect(log[1]).toEqual(['u1', ACCOUNT_ID, '<-9@example.com>', 21, 'INBOX', 'spam']);

    imapManager.moveQueue.serverLocation.mockResolvedValueOnce(null);
    await call('POST', `/messages/${PENDING_ID}/spam`);
    log = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO spam_training_log')).at(-1);
    expect(log[1]).toEqual(['u1', ACCOUNT_ID, '<-9@example.com>', null, null, 'spam']);
  });

  // M12: a letter the move did not take (gone meanwhile, or its folder held) writes no verdict,
  // no training row and no journal entry.
  it('answers 404 for a letter gone meanwhile and 409 for one that cannot move now', async () => {
    imapManager.moveQueue.enqueue.mockResolvedValueOnce([]);
    query.mockImplementationOnce(async () => ({ rows: [rows[UNREAD_ID]] })); // the spam lookup
    const base = query.getMockImplementation();
    query.mockImplementation(async (sql, params) => (sql.startsWith('SELECT 1 FROM messages WHERE id = $1') ? { rows: [] } : base(sql, params)));
    try {
      const gone = await call('POST', `/messages/${UNREAD_ID}/spam`);
      expect(gone.status).toBe(404);
    } finally {
      query.mockImplementation(base);
    }
    imapManager.moveQueue.enqueue.mockResolvedValueOnce([]);
    const known = query.getMockImplementation();
    query.mockImplementation(async (sql, params) => (sql.startsWith('SELECT 1 FROM messages WHERE id = $1') ? { rows: [{ '?column?': 1 }] } : known(sql, params)));
    const held = await call('DELETE', `/messages/${UNREAD_ID}`);
    expect(held.status).toBe(409);
    expect(held.body.code).toBe('move_pending');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO spam_training_log'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO mailbox_audit_log'))).toBe(false);
  });
});

describe('a flag change on a letter whose move has not reached the server', () => {
  it('goes onto the move: no STORE now, and none at the old uid', async () => {
    imapManager.moveQueue.deferFlags.mockResolvedValue({ deferred: new Set([PENDING_ID]), located: new Map() });
    const res = await call('PATCH', `/messages/${PENDING_ID}/read`, { read: true });
    expect(res.status).toBe(200);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE messages SET is_read'))).toBe(true);
    expect(imapManager.moveQueue.deferFlags).toHaveBeenCalledWith([expect.objectContaining({ id: PENDING_ID })], '\\Seen', true);
    expect(imapManager.setFlag).not.toHaveBeenCalled();
    expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
  });

  it('is stored at the new location when the move settled in the meantime', async () => {
    imapManager.moveQueue.deferFlags.mockResolvedValue({ deferred: new Set(), located: new Map([[PENDING_ID, { uid: 905, folder: 'Archive' }]]) });
    await call('PATCH', `/messages/${PENDING_ID}/star`, { starred: true });
    expect(imapManager.setFlag).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 905, 'Archive', '\\Flagged', true);
  });

  it('is left out of a bulk STORE, which gets the other letters only', async () => {
    imapManager.moveQueue.deferFlags.mockResolvedValue({ deferred: new Set([PENDING_ID]), located: new Map() });
    const res = await call('POST', '/messages/bulk-read', { ids: [UNREAD_ID, PENDING_ID], read: true });
    expect(res.body.updated).toEqual([UNREAD_ID, PENDING_ID]);
    expect(imapManager.setFlagsGroups).toHaveBeenCalledWith(expect.anything(), [{ folder: 'INBOX', uids: [11] }], '\\Seen', true);
  });
});

describe('reading a letter whose move has not reached the server', () => {
  it('reads an uncached body at the source while the move is queued', async () => {
    imapManager.moveQueue.serverLocation.mockResolvedValue({ folder: 'INBOX', uid: 21 });
    const res = await call('GET', `/messages/${PENDING_ID}/body`);
    expect(res.status).toBe(200);
    expect(imapManager.fetchMessageBody).toHaveBeenCalledWith(expect.anything(), 21, 'INBOX');
    // With the account, so a letter whose MOVE may have gone out can be placed on the server.
    expect(imapManager.moveQueue.serverLocation).toHaveBeenCalledWith(expect.objectContaining({ id: PENDING_ID }), expect.objectContaining({ id: ACCOUNT_ID }));
  });

  it('answers move_pending while the MOVE is in flight', async () => {
    imapManager.moveQueue.serverLocation.mockResolvedValue(null);
    const res = await call('GET', `/messages/${PENDING_ID}/body`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('move_pending');
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
  });
});
