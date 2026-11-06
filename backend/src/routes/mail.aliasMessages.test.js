import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/messageService.js', () => ({ listMessages: vi.fn(), aliasUnreadCounts: vi.fn() }));

import express from 'express';
import mailRoutes from './mail.js';
import { aliasUnreadCounts, listMessages } from '../services/messageService.js';

const ACCOUNT = '84000000-0000-4000-8000-000000000001';
const ALIAS = '85000000-0000-4000-8000-000000000001';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use('/api/mail', mailRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

describe('GET /api/mail/messages with aliasId', () => {
  beforeEach(() => { listMessages.mockReset(); });

  const get = (qs) => fetch(`${base}/api/mail/messages?${qs}`);

  it('400 for a malformed aliasId', async () => {
    const res = await get(`accountId=${ACCOUNT}&aliasId=not-a-uuid`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid alias id' });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('400 for aliasId without accountId', async () => {
    const res = await get(`aliasId=${ALIAS}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'aliasId needs accountId' });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('404 alias_gone', async () => {
    listMessages.mockResolvedValueOnce({ error: 'alias_gone' });
    const res = await get(`accountId=${ACCOUNT}&aliasId=${ALIAS}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'This alias is no longer a mailbox here', code: 'alias_gone' });
  });

  it('400 alias_folder', async () => {
    listMessages.mockResolvedValueOnce({ error: 'alias_folder' });
    const res = await get(`accountId=${ACCOUNT}&aliasId=${ALIAS}&folder=Archive`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'An alias has only Inbox and Sent', code: 'alias_folder' });
  });

  it('passes aliasId to listMessages', async () => {
    listMessages.mockResolvedValueOnce({ messages: [], total: 0 });
    const res = await get(`accountId=${ACCOUNT}&aliasId=${ALIAS}&folder=Sent`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [], total: 0 });
    expect(listMessages).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT, aliasId: ALIAS, folder: 'Sent' }));
  });

  it('passes no aliasId when the query has none', async () => {
    listMessages.mockResolvedValueOnce({ messages: [], total: 0 });
    const res = await get(`accountId=${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(listMessages.mock.calls[0][0].aliasId).toBeUndefined();
  });
});

describe('GET /api/mail/alias-unread-counts', () => {
  beforeEach(() => { aliasUnreadCounts.mockReset(); });

  it('GET /alias-unread-counts answers byAlias with no-store', async () => {
    aliasUnreadCounts.mockResolvedValueOnce({ [ALIAS]: 3 });
    const res = await fetch(`${base}/api/mail/alias-unread-counts`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ byAlias: { [ALIAS]: 3 } });
    expect(aliasUnreadCounts).toHaveBeenCalledTimes(1);
  });
});
