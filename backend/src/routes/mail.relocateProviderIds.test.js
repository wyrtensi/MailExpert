import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Bulk delete / move / archive re-home rows by copying them to the destination UID. A copied row
// keeps the source's Gmail ids, which may still be missing, so each asks for an id backfill run.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
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
  resolveArchiveFolder: vi.fn(async () => 'Archive'),
  isAllMailFolder: vi.fn(async () => false),
  adjustFolderCounts: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT = { id: 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3', imap_host: 'imap.gmail.com', folder_mappings: null };
const INBOX_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const INBOX_ROW = {
  id: INBOX_ID, account_id: ACCOUNT.id, uid: 11, folder: 'INBOX', is_read: true, message_id: '<11@example.com>',
  subject: 'Hello', from_name: 'Sender', from_email: 'sender@example.com', folder_mappings: null,
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  query.mockReset().mockImplementation(async (sql) => {
    if (/FROM messages m\s+(JOIN email_accounts a|WHERE m\.id = ANY)/.test(sql)) return { rows: [INBOX_ROW] };
    if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM email_accounts WHERE id = $1')) return { rows: [ACCOUNT] };
    return { rows: [] };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const post = (path, body) => fetch(`${base}/api/mail/messages/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe.each([
  ['bulk-delete', { ids: [INBOX_ID] }],
  ['bulk-move', { ids: [INBOX_ID], folder: 'Label' }],
  ['bulk-archive', { ids: [INBOX_ID] }],
])('%s', (route, body) => {
  it('schedules the Gmail id backfill for the account whose rows were copied to a new UID', async () => {
    imapManager.bulkMoveMessages.mockResolvedValue({ uidMap: new Map([[11, 901]]), succeeded: [11], failed: [] });
    expect((await post(route, body)).status).toBe(200);
    expect(imapManager._scheduleProviderIdBackfill).toHaveBeenCalledTimes(1);
    expect(imapManager._scheduleProviderIdBackfill).toHaveBeenCalledWith(ACCOUNT);
  });

  it('schedules nothing when the server gave no new UID and no row was copied', async () => {
    imapManager.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [11], failed: [] });
    expect((await post(route, body)).status).toBe(200);
    expect(imapManager._scheduleProviderIdBackfill).not.toHaveBeenCalled();
  });
});
