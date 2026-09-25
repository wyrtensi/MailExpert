import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Bulk mark-read stores \Seen with one STORE per (account, folder) group instead of one per
// letter, and stops trying an account's groups once its login was rejected: every letter not
// stored goes onto the flag-push queue, since the DB already holds the new state.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
    setFlags: vi.fn(),
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
// A letter in a second mailbox, whose login has nothing to do with the first one's.
const otherId = letter(201, 'INBOX', 77, OTHER_ACCOUNT_ID);

// A rejected login as ImapFlow reports it (isImapAuthFailure), and the typed error the pool
// fails with while a rejected password holds the mailbox's logins back.
const authFailure = () => Object.assign(new Error('Authentication failed.'), {
  responseStatus: 'NO', serverResponseCode: 'AUTHENTICATIONFAILED', authenticationFailed: true,
});
const authHeld = () => Object.assign(new Error('Mail server is not accepting new connections for this account right now'), { providerRefusing: true, authRejected: true });

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
  imapManager.setFlags.mockReset().mockResolvedValue(); // drops a leftover mockRejectedValueOnce too
  query.mockReset().mockImplementation(async (sql, params) => {
    if (/FROM messages m[\s\S]*m\.id = ANY/.test(sql)) return { rows: params[0].map((i) => rows[i]).filter(Boolean) };
    if (sql.includes('FROM email_accounts WHERE id = $1')) return { rows: [{ id: params[0] }] };
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
  it('stores 50 letters in two folders with one call per folder', async () => {
    const { status, body } = await bulkRead(fifty);

    expect(status).toBe(200);
    expect(body.updated).toHaveLength(50);
    expect(imapManager.setFlags).toHaveBeenCalledTimes(2);
    expect(imapManager.setFlags).toHaveBeenNthCalledWith(1, { id: ACCOUNT_ID }, 'INBOX', uidsOf(inboxIds), '\\Seen', true);
    expect(imapManager.setFlags).toHaveBeenNthCalledWith(2, { id: ACCOUNT_ID }, 'Archive', uidsOf(archiveIds), '\\Seen', true);
  });

  it('resolves the pending pushes of every letter of a group that went through', async () => {
    await bulkRead(fifty);

    expect(resolved().sort()).toEqual([...fifty].sort());
    expect(imapManager._resolveFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, inboxIds[0], '\\Seen');
    expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
  });

  it('queues only the group that failed when the failure is not a rejected login', async () => {
    imapManager.setFlags.mockRejectedValueOnce(new Error('server did not apply \\Seen=true'));

    await bulkRead(fifty);

    expect(imapManager.setFlags).toHaveBeenCalledTimes(2); // Archive is still tried
    expect(enqueued().sort()).toEqual([...inboxIds].sort());
    expect(resolved().sort()).toEqual([...archiveIds].sort());
  });

  it.each([
    ['a rejected login', authFailure],
    ['a login held back by a rejected password', authHeld],
  ])('after %s on the first group, tries no other group of that mailbox and queues every letter', async (_what, error) => {
    imapManager.setFlags.mockRejectedValueOnce(error());

    const { status, body } = await bulkRead(fifty);

    expect(status).toBe(200);                            // the DB holds the change; the queue pushes it
    expect(body.updated).toHaveLength(50);
    expect(imapManager.setFlags).toHaveBeenCalledOnce();  // no second login attempt
    expect(enqueued().sort()).toEqual([...fifty].sort());
    expect(imapManager._enqueueFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, archiveIds[0], '\\Seen', true);
    expect(imapManager._resolveFlagPush).not.toHaveBeenCalled();
  });

  it('still stores another mailbox of the same request after a rejected login', async () => {
    imapManager.setFlags.mockRejectedValueOnce(authFailure());

    await bulkRead([...fifty, otherId]);

    expect(imapManager.setFlags).toHaveBeenCalledTimes(2);
    expect(imapManager.setFlags).toHaveBeenLastCalledWith({ id: OTHER_ACCOUNT_ID }, 'INBOX', [77], '\\Seen', true);
    expect(resolved()).toEqual([otherId]);
    expect(enqueued()).toHaveLength(50);
  });
});
