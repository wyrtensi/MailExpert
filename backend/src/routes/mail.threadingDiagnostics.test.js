import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/threadingDiagnostics.js', () => ({
  threadingDiagnostics: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { threadingDiagnostics } from '../services/threadingDiagnostics.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('GET /api/mail/messages/:id/threading', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use('/api/mail', mailRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => { threadingDiagnostics.mockReset(); });

  const get = (path) => fetch(`${base}/api/mail/messages/${path}`);

  it('returns the diagnostics for a valid id', async () => {
    const diagnostics = {
      messageId: '<a@example.com>', inReplyTo: null, references: [],
      providerThreadId: null, providerMessageId: null, threadId: '<a@example.com>',
      reason: 'new-root', mode: 'rfc', conversation: { total: 1, folders: [{ folder: 'INBOX', count: 1 }] },
    };
    threadingDiagnostics.mockResolvedValueOnce(diagnostics);
    const res = await get(`${ID}/threading`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(diagnostics);
    expect(threadingDiagnostics).toHaveBeenCalledWith(ID);
  });

  it('answers 404 for a missing letter and 400 for a malformed id', async () => {
    threadingDiagnostics.mockResolvedValueOnce(null);
    expect((await get(`${ID}/threading`)).status).toBe(404);
    expect((await get('not-a-uuid/threading')).status).toBe(400);
    expect(threadingDiagnostics).toHaveBeenCalledTimes(1);
  });
});
