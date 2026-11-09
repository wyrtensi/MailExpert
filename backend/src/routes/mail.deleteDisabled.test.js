// MAIL_DELETE_ENABLED=false: every route that deletes letters (to Trash or forever) refuses with
// 403 mail_delete_disabled and touches neither the server nor the database.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
    moveMessage: vi.fn(),
    permanentDeleteMessage: vi.fn(),
    bulkMoveMessages: vi.fn(),
    bulkPermanentDelete: vi.fn(),
    deleteFolder: vi.fn(),
    emptyFolder: vi.fn(),
    syncFolderOnDemand: vi.fn(async () => {}),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    _scheduleProviderIdBackfill: vi.fn(),
    scheduleCountRefresh: vi.fn(),
    moveQueue: {
      enqueue: vi.fn(async (_accountId, rows) => rows.map(r => ({ id: r.id, from: r.folder, isRead: true }))),
      holdFolder: vi.fn(() => () => {}),
    },
  },
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}), collectHook: vi.fn(async () => []) } }));
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveTrashFolder: vi.fn(async () => 'Trash'),
  resolveAllTrashPaths: vi.fn(async () => new Set(['Trash', '[Gmail]/Bin'])),
  resolveAllDraftsPaths: vi.fn(async () => new Set(['Drafts'])),
  adjustFolderCounts: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const MSG_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const message = {
  id: MSG_ID, account_id: ACCOUNT_ID, uid: 11, folder: 'INBOX', is_read: true, message_id: '<11@example.com>',
  subject: 'Board minutes', from_email: 'sender@example.com', folder_mappings: null,
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
    if (/FROM messages m\s+WHERE m\.id = \$1/.test(sql)) return { rows: [message] };
    if (/FROM messages m\s+JOIN email_accounts a/.test(sql)) return { rows: params[0].map(() => message) };
    if (/FROM messages m\s+WHERE m\.id = ANY/.test(sql)) return { rows: params[0].map(() => message) };
    if (sql.includes('FROM email_accounts WHERE id = $1')) return { rows: [{ id: ACCOUNT_ID, folder_mappings: null }] };
    if (sql.includes('FROM email_accounts WHERE id = ANY')) return { rows: [{ id: ACCOUNT_ID, folder_mappings: null }] };
    if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ '?column?': 1 }] };
    return { rows: [] };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const call = (method, path, body) => fetch(`${base}/api/mail${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

const expectRefused = async (res) => {
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code: 'mail_delete_disabled' });
  // Nothing was read, moved or deleted.
  expect(query).not.toHaveBeenCalled();
  expect(imapManager.moveQueue.enqueue).not.toHaveBeenCalled();
  expect(imapManager.bulkPermanentDelete).not.toHaveBeenCalled();
  expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  expect(imapManager.deleteFolder).not.toHaveBeenCalled();
  expect(imapManager.emptyFolder).not.toHaveBeenCalled();
};

describe('with MAIL_DELETE_ENABLED=false', () => {
  beforeEach(() => { vi.stubEnv('MAIL_DELETE_ENABLED', 'false'); });

  it('refuses to delete one letter', async () => {
    await expectRefused(await call('DELETE', `/messages/${MSG_ID}`));
  });

  it('refuses a bulk delete', async () => {
    await expectRefused(await call('POST', '/messages/bulk-delete', { ids: [MSG_ID] }));
  });

  it('refuses to empty a folder', async () => {
    await expectRefused(await call('POST', '/folders/empty', { accountId: ACCOUNT_ID, path: 'Trash' }));
  });

  it('refuses to delete a folder (its letters go with it)', async () => {
    await expectRefused(await call('POST', '/folders/delete', { accountId: ACCOUNT_ID, path: 'Projects' }));
  });

  it('refuses to move letters into a Trash folder', async () => {
    const res = await call('POST', '/messages/bulk-move', { ids: [MSG_ID], folder: '[Gmail]/Bin' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'mail_delete_disabled' });
    expect(imapManager.moveQueue.enqueue).not.toHaveBeenCalled();
  });

  it('still moves letters into an ordinary folder', async () => {
    const res = await call('POST', '/messages/bulk-move', { ids: [MSG_ID], folder: 'Projects' });
    expect(res.status).toBe(200);
    expect(imapManager.moveQueue.enqueue).toHaveBeenCalled();
  });
});

describe('with MAIL_DELETE_ENABLED unset', () => {
  it('still moves a letter to Trash', async () => {
    const res = await call('POST', '/messages/bulk-delete', { ids: [MSG_ID] });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toEqual([MSG_ID]);
  });
});
