import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
const session = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
  requireAdmin: (_req, res, next) => (
    session.isAdmin ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));
vi.mock('../services/mailNode/diskWatch.js', () => ({ DISK_WARN_PERCENT: 85, checkMailNodeDisk: vi.fn(async () => null) }));
const node = vi.hoisted(() => ({ cfg: null }));
vi.mock('../services/mailNode/mailcow.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    getMailNodeConfig: vi.fn(async () => node.cfg),
    saveMailNodeConfig: vi.fn(async () => {}),
    listDomains: vi.fn(async () => [{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1 }]),
    addDomain: vi.fn(async () => {}),
    listMailboxes: vi.fn(async () => [{ email: 'info@example.com', active: true, quotaMb: 5120, usedBytes: 2048 }]),
    setMailboxQuota: vi.fn(async () => {}),
    getDiskStatus: vi.fn(async () => ({ usedPercent: 90, used: '36G', total: '40G' })),
  };
});

import express from 'express';
import mailNodeRoutes from './mailNode.js';
import { query } from '../services/db.js';
import {
  MailNodeError, addDomain, listDomains, saveMailNodeConfig, setMailboxQuota,
} from '../services/mailNode/mailcow.js';

const ID = '77777777-7777-4777-8777-777777777777';
const CFG = { mailHost: 'mail.example.com', apiKey: 'stored-key', quotaMb: 5120, diskPingUrl: null };

describe('/api/mail-node', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail-node', mailNodeRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    vi.clearAllMocks();
    session.isAdmin = true;
    node.cfg = CFG;
  });

  const call = (method, path, body) => fetch(`${base}/api/mail-node${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  it('shows the settings to an administrator with the key redacted', async () => {
    const body = await (await call('GET', '/config')).json();
    expect(body).toEqual({ configured: true, mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120, diskPingUrl: '' });
    session.isAdmin = false;
    expect((await call('GET', '/config')).status).toBe(403);
  });

  it('checks the key against the node before saving', async () => {
    node.cfg = null;
    const res = await call('PUT', '/config', { mailHost: 'Mail.Example.com', apiKey: 'new-key', quotaMb: '5120', diskPingUrl: 'https://hc.example.com/p/1' });
    expect(res.status).toBe(200);
    const saved = { mailHost: 'mail.example.com', apiKey: 'new-key', quotaMb: 5120, diskPingUrl: 'https://hc.example.com/p/1' };
    expect(listDomains).toHaveBeenCalledWith(saved);
    expect(saveMailNodeConfig).toHaveBeenCalledWith(saved);
  });

  it('keeps the stored key when the placeholder comes back', async () => {
    await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 1024 });
    expect(saveMailNodeConfig).toHaveBeenCalledWith({ mailHost: 'mail.example.com', apiKey: 'stored-key', quotaMb: 1024, diskPingUrl: null });
  });

  it('asks for the key again when the host changes, so the stored key never goes to a new host', async () => {
    const res = await call('PUT', '/config', { mailHost: 'other.example.net', apiKey: '••••••••' });
    expect((await res.json()).code).toBe('api_key_required');
    expect(listDomains).not.toHaveBeenCalled();
  });

  it('does not save settings the node refuses', async () => {
    listDomains.mockRejectedValueOnce(new MailNodeError('mail_node_auth', 'The mail node refused the API key'));
    const res = await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: 'wrong' });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('mail_node_auth');
    expect(saveMailNodeConfig).not.toHaveBeenCalled();
  });

  it('refuses a bad host, quota, ping URL or a missing first key', async () => {
    expect((await (await call('PUT', '/config', { mailHost: '10.0.0.5', apiKey: 'k' })).json()).code).toBe('mail_host_invalid');
    expect((await (await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 0 })).json()).code).toBe('quota_invalid');
    expect((await (await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: 'k', diskPingUrl: 'http://x.example' })).json()).code).toBe('ping_url_invalid');
    node.cfg = null;
    expect((await (await call('PUT', '/config', { mailHost: 'mail.example.com' })).json()).code).toBe('api_key_required');
    expect(saveMailNodeConfig).not.toHaveBeenCalled();
  });

  it('lists domains to every signed-in user', async () => {
    session.isAdmin = false;
    const res = await call('GET', '/domains');
    expect(res.status).toBe(200);
    expect((await res.json()).domains[0].domain).toBe('example.com');
  });

  it('lets only an administrator add a domain', async () => {
    let res = await call('POST', '/domains', { domain: 'New.Example', mailboxes: 50 });
    expect(res.status).toBe(200);
    expect(addDomain).toHaveBeenCalledWith(CFG, { domain: 'new.example', mailboxes: 50 });
    expect((await (await call('POST', '/domains', { domain: 'bad' })).json()).code).toBe('domain_invalid');
    session.isAdmin = false;
    res = await call('POST', '/domains', { domain: 'x.example' });
    expect(res.status).toBe(403);
  });

  it('lists the mailboxes MailExpert made with usage and the disk reading', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID, email_address: 'Info@example.com' }, { id: 'other', email_address: 'gone@example.com' }] });
    const body = await (await call('GET', '/mailboxes')).json();
    expect(body.disk).toEqual({ usedPercent: 90, used: '36G', total: '40G', warn: true });
    expect(body.mailboxes).toEqual([
      { accountId: ID, email: 'Info@example.com', onNode: true, active: true, quotaMb: 5120, usedBytes: 2048 },
      { accountId: 'other', email: 'gone@example.com', onNode: false, active: false, quotaMb: null, usedBytes: null },
    ]);
  });

  it('changes the quota of a mail node mailbox only', async () => {
    query.mockResolvedValueOnce({ rows: [{ email_address: 'info@example.com' }] });
    let res = await call('PUT', `/mailboxes/${ID}/quota`, { quotaMb: 10240 });
    expect(res.status).toBe(200);
    expect(setMailboxQuota).toHaveBeenCalledWith(CFG, 'info@example.com', 10240);
    query.mockResolvedValueOnce({ rows: [] });
    res = await call('PUT', `/mailboxes/${ID}/quota`, { quotaMb: 10240 });
    expect(res.status).toBe(404);
    res = await call('PUT', `/mailboxes/${ID}/quota`, { quotaMb: 999999 });
    expect((await res.json()).code).toBe('quota_invalid');
  });
});
