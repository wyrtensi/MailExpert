import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { emptyFolder: vi.fn(), broadcast: vi.fn() } }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { recordAudit } from '../services/auditLog.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const ACCOUNT = { id: ACCOUNT_ID, user_id: 'user-1' };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}
const tick = () => new Promise(r => setTimeout(r, 20));
const clearedDb = () => query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages WHERE account_id = $1 AND folder = $2'));
const emittedType = (type) => imapManager.broadcast.mock.calls.find(c => c[0]?.type === type)?.[0];

describe('POST /api/mail/folders/empty — async background empty', () => {
  let server, base;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset(); imapManager.emptyFolder.mockReset(); imapManager.broadcast.mockReset();
    recordAudit.mockClear();
    query.mockImplementation((sql) => {
      if (sql.includes('FROM email_accounts WHERE id = $1')) return Promise.resolve({ rows: [ACCOUNT] });
      if (sql.startsWith('DELETE FROM messages WHERE account_id = $1 AND folder = $2')) {
        return Promise.resolve({ rows: [
          { message_id: '<1@example.com>', from_email: 'a@example.com' },
          { message_id: '<2@example.com>', from_email: 'b@example.com' },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('journals every message removed from the emptied folder', async () => {
    imapManager.emptyFolder.mockResolvedValue(undefined);
    await empty('Trash');
    await tick();
    const entry = (messageId, from) => ({
      actorUserId: 'user-1', accountId: ACCOUNT_ID, action: 'message.deleted',
      details: { messageId, folder: 'Trash', from, permanent: true },
    });
    expect(recordAudit).toHaveBeenCalledWith([entry('<1@example.com>', 'a@example.com'), entry('<2@example.com>', 'b@example.com')]);
  });

  it('journals nothing when the server empty fails', async () => {
    imapManager.emptyFolder.mockRejectedValue(new Error('throttled'));
    await empty('Trash');
    await tick();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  const empty = (path) => fetch(`${base}/api/mail/folders/empty`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, path }),
  });

  it('returns 202 immediately and finishes the delete in the background', async () => {
    imapManager.emptyFolder.mockResolvedValue(undefined);
    const res = await empty('Trash');
    expect(res.status).toBe(202);
    expect((await res.json()).started).toBe(true);
    await tick();
    expect(imapManager.emptyFolder).toHaveBeenCalledWith(ACCOUNT, 'Trash');
    expect(clearedDb()).toBe(true);
    expect(emittedType('folder_emptied')?.ok).toBe(true);
    expect(emittedType('sync_complete')).toBeTruthy();
    // Folder events reach every client, not only the user who emptied the folder.
    expect(imapManager.broadcast.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it('leaves the DB rows intact and reports failure when the IMAP empty throws', async () => {
    imapManager.emptyFolder.mockRejectedValue(new Error('throttled'));
    const res = await empty('Archive');
    expect(res.status).toBe(202);
    await tick();
    expect(clearedDb()).toBe(false);            // next sync reconciles instead
    expect(emittedType('folder_emptied')?.ok).toBe(false);
    expect(emittedType('sync_complete')).toBeUndefined();
  });

  it('rejects a concurrent empty of the same folder with 409', async () => {
    let release;
    imapManager.emptyFolder.mockImplementation(() => new Promise(r => { release = r; }));
    const first = await empty('Junk');
    expect(first.status).toBe(202);
    const second = await empty('Junk');   // same folder still in flight
    expect(second.status).toBe(409);
    release();                            // let the first complete so the guard clears
    await tick();
  });
});
