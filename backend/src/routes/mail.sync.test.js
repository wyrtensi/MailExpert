import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { requestSync: vi.fn(), requestFolderSync: vi.fn() } }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';

describe.each([
  ['/sync', 'requestSync'],
  ['/sync-folders', 'requestFolderSync'],
])('POST /api/mail%s syncs one mailbox', (path, method) => {
  let server;
  let base;
  let mailboxRow;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  beforeEach(() => {
    query.mockReset();
    imapManager[method].mockReset().mockReturnValue({ started: true });
    mailboxRow = { id: ACCOUNT_ID, enabled: true, protocol: 'imap' };
    query.mockImplementation(async (sql, params = []) => (
      sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')
        && params[0] === ACCOUNT_ID && params[1] === 'user-1' && mailboxRow
        ? { rows: [mailboxRow] }
        : { rows: [] }
    ));
  });

  const post = (body) => fetch(`${base}/api/mail${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('requires a mailbox', async () => {
    expect(await post({})).toMatchObject({ status: 400, body: { code: 'account_required' } });
    expect(imapManager[method]).not.toHaveBeenCalled();
  });

  it('answers 404 for a mailbox the user cannot reach', async () => {
    mailboxRow = null;
    expect((await post({ accountId: ACCOUNT_ID })).status).toBe(404);
    expect(imapManager[method]).not.toHaveBeenCalled();
  });

  it('starts a sync of that mailbox', async () => {
    expect(await post({ accountId: ACCOUNT_ID })).toEqual({ status: 200, body: { ok: true } });
    expect(imapManager[method]).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('reports a repeat the manager turned away', async () => {
    imapManager[method].mockReturnValue({ started: false });
    expect(await post({ accountId: ACCOUNT_ID })).toEqual({ status: 200, body: { ok: true, skipped: true } });
  });

  it('skips a disabled mailbox without asking the manager', async () => {
    mailboxRow = { ...mailboxRow, enabled: false };
    expect(await post({ accountId: ACCOUNT_ID })).toEqual({ status: 200, body: { ok: true, skipped: true } });
    expect(imapManager[method]).not.toHaveBeenCalled();
  });
});
