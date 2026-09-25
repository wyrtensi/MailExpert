import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Bulk mark-read stores \Seen with one STORE per (account, folder) group instead of one per
// letter: one setFlagsGroups call per mailbox, which reserves the order of all its groups and
// stops after a rejected login (tested with the manager). Every letter not stored goes onto the
// flag-push queue, since the DB already holds the new state.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
    setFlagsGroups: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    _resolveFlagPush: vi.fn(),
    scheduleCountRefresh: vi.fn(),
  },
}));
vi.mock('../plugins/registry.js', () => ({
  pluginRegistry: { runHook: vi.fn(async () => {}), collectHook: vi.fn(async () => []), hasActiveAsync: vi.fn(async () => false) },
}));
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  adjustFolderCounts: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const OTHER_ACCOUNT_ID = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rows = {};
const letter = (n, folder, uid, accountId = ACCOUNT_ID) => {
  rows[id(n)] = { id: id(n), uid, folder, is_read: false, account_id: accountId, message_id: `<${n}@example.com>` };
  return id(n);
};
// 50 unread letters of one mailbox: 30 in INBOX, 20 in Archive.
const inboxIds = Array.from({ length: 30 }, (_, i) => letter(i + 1, 'INBOX', 1000 + i));
const archiveIds = Array.from({ length: 20 }, (_, i) => letter(i + 101, 'Archive', 500 + i));
const fifty = [...inboxIds, ...archiveIds];
// A letter in a second mailbox.
const otherId = letter(201, 'INBOX', 77, OTHER_ACCOUNT_ID);

const stored = { stored: true };
const failed = () => ({ stored: false, error: new Error('Authentication failed.') });
const skipped = { stored: false, skipped: true };

let server;
let base;
let accountRows;
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
  imapManager.setFlagsGroups.mockReset().mockImplementation(async (_account, groups) => groups.map(() => stored));
  accountRows = { [ACCOUNT_ID]: { id: ACCOUNT_ID }, [OTHER_ACCOUNT_ID]: { id: OTHER_ACCOUNT_ID } };
  query.mockReset().mockImplementation(async (sql, params) => {
    if (/FROM messages m[\s\S]*m\.id = ANY/.test(sql)) return { rows: params[0].map((i) => rows[i]).filter(Boolean) };
    if (sql.includes('FROM email_accounts WHERE id = $1')) return { rows: accountRows[params[0]] ? [accountRows[params[0]]] : [] };
    return { rows: [], rowCount: 0 };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const bulkRead = async (ids, read = true) => {
  const res = await fetch(`${base}/api/mail/messages/bulk-read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, read }),
  });
  return { status: res.status, body: await res.json() };
};
const uidsOf = (ids) => ids.map((i) => rows[i].uid);
const enqueued = () => imapManager._enqueueFlagPush.mock.calls.map(([, messageId]) => messageId);
const resolved = () => imapManager._resolveFlagPush.mock.calls.map(([, messageId]) => messageId);

describe('POST /messages/bulk-read', () => {
  it('stores 50 letters in two folders with one call carrying one group per folder', async () => {
    const { status, body } = await bulkRead(fifty);

    expect(status).toBe(200);
    expect(body.updated).toHaveLength(50);
    expect(imapManager.setFlagsGroups).toHaveBeenCalledOnce();
    expect(imapManager.setFlagsGroups).toHaveBeenCalledWith({ id: ACCOUNT_ID }, [
      { folder: 'INBOX', uids: uidsOf(inboxIds) },
      { folder: 'Archive', uids: uidsOf(archiveIds) },
    ], '\\Seen', true);
  });

  it('resolves the pending pushes of every letter of a group that went through', async () => {
    await bulkRead(fifty);

    expect(resolved().sort()).toEqual([...fifty].sort());
    expect(imapManager._resolveFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, inboxIds[0], '\\Seen');
    expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
  });

  it('queues a group that failed and resolves one that went through', async () => {
    imapManager.setFlagsGroups.mockResolvedValueOnce([failed(), stored]);

    await bulkRead(fifty);

    expect(enqueued().sort()).toEqual([...inboxIds].sort());
    expect(resolved().sort()).toEqual([...archiveIds].sort());
  });

  it('queues every letter of a failed and a skipped group, with the new value', async () => {
    imapManager.setFlagsGroups.mockResolvedValueOnce([failed(), skipped]);

    const { status, body } = await bulkRead(fifty);

    expect(status).toBe(200);                            // the DB holds the change; the queue pushes it
    expect(body.updated).toHaveLength(50);
    expect(enqueued().sort()).toEqual([...fifty].sort());
    expect(imapManager._enqueueFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, archiveIds[0], '\\Seen', true);
    expect(imapManager._resolveFlagPush).not.toHaveBeenCalled();
  });

  it('stores each mailbox of the request with its own call', async () => {
    imapManager.setFlagsGroups.mockResolvedValueOnce([failed(), skipped]);

    await bulkRead([...fifty, otherId]);

    expect(imapManager.setFlagsGroups).toHaveBeenCalledTimes(2);
    expect(imapManager.setFlagsGroups).toHaveBeenLastCalledWith({ id: OTHER_ACCOUNT_ID }, [{ folder: 'INBOX', uids: [77] }], '\\Seen', true);
    expect(resolved()).toEqual([otherId]);
    expect(enqueued()).toHaveLength(50);
  });

  it('queues the letters of a mailbox whose account row is gone', async () => {
    delete accountRows[ACCOUNT_ID];

    await bulkRead(fifty);

    expect(imapManager.setFlagsGroups).not.toHaveBeenCalled();
    expect(enqueued()).toHaveLength(50);
  });
});
