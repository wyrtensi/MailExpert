import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/senderHistory.js', () => ({
  SENDER_HISTORY_DEFAULT_LIMIT: 5,
  SENDER_HISTORY_MAX_LIMIT: 20,
  senderHistory: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { senderHistory } from '../services/senderHistory.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('GET /api/mail/messages/:id/sender-history', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use('/api/mail', mailRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => { senderHistory.mockReset(); });

  const get = (path) => fetch(`${base}/api/mail/messages/${path}`);

  it('returns the history with the default limit of 5', async () => {
    const history = { correspondent: 'maya@c.example', total: 1, items: [{ id: 'x', direction: 'in' }] };
    senderHistory.mockResolvedValueOnce(history);
    const res = await get(`${ID}/sender-history`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(history);
    expect(senderHistory).toHaveBeenCalledWith(ID, { limit: 5 });
  });

  it('takes a limit from 1 to 20 and refuses anything else', async () => {
    senderHistory.mockResolvedValue({ correspondent: null, total: 0, items: [] });
    expect((await get(`${ID}/sender-history?limit=20`)).status).toBe(200);
    expect(senderHistory).toHaveBeenLastCalledWith(ID, { limit: 20 });
    for (const bad of ['0', '21', '2.5', 'x']) {
      expect((await get(`${ID}/sender-history?limit=${bad}`)).status).toBe(400);
    }
  });

  it('answers 404 for a missing letter and 400 for a malformed id', async () => {
    senderHistory.mockResolvedValueOnce(null);
    expect((await get(`${ID}/sender-history`)).status).toBe(404);
    expect((await get('not-a-uuid/sender-history')).status).toBe(400);
    expect(senderHistory).toHaveBeenCalledTimes(1);
  });
});
