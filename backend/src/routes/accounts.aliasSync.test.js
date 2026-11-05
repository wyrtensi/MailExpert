import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  isAdminRequest: async () => true,
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/gmailSendAs.js', () => {
  class GmailSendAsError extends Error {
    constructor(code, status, message) { super(message); this.name = 'GmailSendAsError'; this.code = code; }
  }
  return { GmailSendAsError, syncGmailSendAs: vi.fn() };
});
vi.mock('../services/oauth/tokenManager.js', () => {
  class OAuthTokenError extends Error {
    constructor(code) { super(`secret-token-detail ${code}`); this.name = 'OAuthTokenError'; this.code = code; }
  }
  return { OAuthTokenError };
});
vi.mock('../services/accountAliases.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listAliases: vi.fn(),
}));

import express from 'express';
import { GmailSendAsError, syncGmailSendAs } from '../services/gmailSendAs.js';
import { OAuthTokenError } from '../services/oauth/tokenManager.js';
import { listAliases } from '../services/accountAliases.js';
import accountRoutes from './accounts.js';

const ID = '11111111-1111-4111-8111-111111111111';
const aliases = [{ id: 'a1', email: 'sales@example.com', source: 'gmail' }];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  app.use((err, _req, res, next) => {
    void err;
    void next;
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  listAliases.mockResolvedValue(aliases);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const post = async (id = ID) => {
  const res = await fetch(`${base}/api/accounts/${id}/aliases/sync-gmail`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
};

describe('POST /api/accounts/:id/aliases/sync-gmail', () => {
  it('answers the sync result with the fresh alias list and passes the session user as actor', async () => {
    syncGmailSendAs.mockResolvedValue({
      status: 'synced', added: ['sales@example.com'], updated: ['a@example.com'], removed: ['b@example.com'], syncedAt: '2026-11-05T10:00:00.000Z',
    });
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body).toEqual({
      added: ['sales@example.com'], updated: ['a@example.com'], removed: ['b@example.com'],
      synced_at: '2026-11-05T10:00:00.000Z', aliases,
    });
    expect(syncGmailSendAs).toHaveBeenCalledWith(ID, { actor: expect.objectContaining({ userId: 'u1' }) });
    expect(listAliases).toHaveBeenCalledWith(ID);
  });

  it.each([
    ['reconnect_required', 'Reconnect this mailbox to Google first'],
    ['not_google', 'This mailbox is not connected through Google'],
  ])('answers 409 for %s', async (reason, error) => {
    syncGmailSendAs.mockResolvedValue({ status: 'skipped', reason });
    expect(await post()).toEqual({ status: 409, body: { error, code: reason } });
  });

  it('answers 404 for a missing account', async () => {
    syncGmailSendAs.mockResolvedValue({ status: 'skipped', reason: 'not_found' });
    expect(await post()).toEqual({ status: 404, body: { error: 'Account not found' } });
  });

  it('answers 502 without Google error text when Gmail fails', async () => {
    syncGmailSendAs.mockRejectedValue(new GmailSendAsError('http_error', 500, 'Bearer ya29.secret-google-text'));
    const { status, body } = await post();
    expect(status).toBe(502);
    expect(body).toEqual({ error: 'Gmail did not answer, try later', code: 'gmail_unavailable' });
  });

  it('answers 502 without the message of a token error', async () => {
    syncGmailSendAs.mockRejectedValue(new OAuthTokenError('oauth_refresh_failed'));
    const { status, body } = await post();
    expect(status).toBe(502);
    expect(JSON.stringify(body)).not.toContain('secret-token-detail');
    expect(body.code).toBe('gmail_unavailable');
  });

  it('leaves other errors to the error handler', async () => {
    syncGmailSendAs.mockRejectedValue(new Error('db password leaked'));
    const { status, body } = await post();
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('leaked');
  });
});
