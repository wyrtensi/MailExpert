import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';

const SALES = '11111111-1111-4111-8111-111111111111';
const OPS = '22222222-2222-4222-8222-222222222222';

describe('GET /api/mail/thread scoped to one mailbox', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

  beforeEach(() => {
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [
        { id: SALES, include_in_unified_inbox: true },
        { id: OPS, include_in_unified_inbox: true },
      ] })
      .mockResolvedValueOnce({ rows: [] });
  });

  it('loads only the named mailbox, so a thread action cannot reach the same conversation in another one', async () => {
    // One message sent to sales@ and ops@ has the same thread key in both mailboxes.
    const response = await fetch(`${base}/api/mail/thread/thread-1?accountId=${SALES}`);
    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1]).toEqual([[SALES], 'thread-1']);
  });

  it('returns nothing for a mailbox that is not enabled', async () => {
    const response = await fetch(`${base}/api/mail/thread/thread-1?accountId=33333333-3333-4333-8333-333333333333`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed mailbox id', async () => {
    const response = await fetch(`${base}/api/mail/thread/thread-1?accountId=nope`);
    expect(response.status).toBe(400);
  });

  it('keeps every enabled mailbox when none is named', async () => {
    const response = await fetch(`${base}/api/mail/thread/thread-1`);
    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1]).toEqual([[SALES, OPS], 'thread-1']);
  });
});
