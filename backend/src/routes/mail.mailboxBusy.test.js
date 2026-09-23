import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A full IMAP pool fails an operation with poolExhausted (upstream #474). That is our own
// connection budget, not a broken server, so the delete, move and bulk routes answer
// 503 { code: 'mailbox_busy' }, which the client shows as "the mailbox is busy, try again".
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
    moveMessage: vi.fn(),
    permanentDeleteMessage: vi.fn(),
    bulkMoveMessages: vi.fn(),
    bulkPermanentDelete: vi.fn(),
    syncFolderOnDemand: vi.fn(async () => {}),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    _scheduleProviderIdBackfill: vi.fn(),
    scheduleCountRefresh: vi.fn(),
  },
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}), collectHook: vi.fn(async () => []) } }));
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveTrashFolder: vi.fn(async () => 'Trash'),
  resolveAllTrashPaths: vi.fn(async () => new Set(['Trash'])),
  resolveAllDraftsPaths: vi.fn(async () => new Set(['Drafts'])),
  resolveSpamFolder: vi.fn(async () => 'Junk'),
  resolveArchiveFolder: vi.fn(async () => 'Archive'),
  adjustFolderCounts: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const INBOX_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const TRASH_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const MSG = (id, folder, uid) => ({
  id, account_id: ACCOUNT_ID, uid, folder, is_read: true, message_id: `<${uid}@example.com>`,
  subject: 'Board minutes', from_email: 'sender@example.com', folder_mappings: null,
});
const rows = { [INBOX_ID]: MSG(INBOX_ID, 'INBOX', 11), [TRASH_ID]: MSG(TRASH_ID, 'Trash', 22) };
const busy = () => Object.assign(new Error('IMAP pool busy, please retry'), { poolExhausted: true });

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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  query.mockReset().mockImplementation(async (sql, params) => {
    if (/FROM messages m[\s\S]*WHERE m\.id = \$1/.test(sql)) return { rows: rows[params[0]] ? [rows[params[0]]] : [] };
    if (/FROM messages m[\s\S]*m\.id = ANY/.test(sql)) return { rows: params[0].map((id) => rows[id]).filter(Boolean) };
    if (sql.includes('FROM email_accounts WHERE id = $1')) return { rows: [{ id: ACCOUNT_ID, folder_mappings: null }] };
    if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ '?column?': 1 }] };
    return { rows: [], rowCount: 0 };
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
const expectBusy = ({ status, body }) => {
  expect(status).toBe(503);
  expect(body.code).toBe('mailbox_busy');
};

describe('a busy mailbox answers 503 mailbox_busy', () => {
  it('on delete (move to Trash)', async () => {
    imapManager.moveMessage.mockRejectedValue(busy());
    expectBusy(await call('DELETE', `/messages/${INBOX_ID}`));
  });

  it('on delete of a message already in Trash', async () => {
    imapManager.permanentDeleteMessage.mockRejectedValue(busy());
    expectBusy(await call('DELETE', `/messages/${TRASH_ID}`));
  });

  it('on bulk move, bulk delete and bulk archive', async () => {
    imapManager.bulkMoveMessages.mockRejectedValue(busy());
    expectBusy(await call('POST', '/messages/bulk-move', { ids: [INBOX_ID], folder: 'Archive' }));
    expectBusy(await call('POST', '/messages/bulk-delete', { ids: [INBOX_ID] }));
    expectBusy(await call('POST', '/messages/bulk-archive', { ids: [INBOX_ID] }));
    expect(imapManager.bulkMoveMessages).toHaveBeenCalledTimes(3);
  });

  it('on mark as spam', async () => {
    imapManager.moveMessage.mockRejectedValue(busy());
    expectBusy(await call('POST', `/messages/${INBOX_ID}/spam`));
  });

  it('keeps other failures as they were', async () => {
    imapManager.moveMessage.mockRejectedValue(new Error('Mailbox does not exist'));
    const res = await call('DELETE', `/messages/${INBOX_ID}`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
  });
});
