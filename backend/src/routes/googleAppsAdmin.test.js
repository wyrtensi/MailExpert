import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const registry = vi.hoisted(() => ({
  listGoogleApps: vi.fn(),
  createGoogleApp: vi.fn(),
  updateGoogleApp: vi.fn(),
  deleteGoogleApp: vi.fn(),
  setGoogleAppStatus: vi.fn(async () => []),
}));
vi.mock('../services/oauth/googleApps.js', () => {
  class GoogleAppError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  return { ...registry, GoogleAppError, GOOGLE_APP_STATUSES: ['active', 'closed', 'disabled'] };
});
vi.mock('../services/oauth/googleAppSelection.js', () => ({
  countGoogleReservations: vi.fn(async () => 1),
}));

import express from 'express';
import googleAppsAdminRoutes from './googleAppsAdmin.js';
import { GoogleAppError } from '../services/oauth/googleApps.js';

const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const manager = { disconnectAccount: vi.fn(async () => {}) };
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.set('imapManager', manager);
  app.use('/api/admin/google-apps', googleAppsAdminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/google-apps`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  Object.values(registry).forEach((fn) => fn.mockReset());
  registry.setGoogleAppStatus.mockResolvedValue([]);
  manager.disconnectAccount.mockClear();
});

const send = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const ROW = {
  id: ID, label: 'Google 1', client_id: '1-a.apps.googleusercontent.com', project_number: '1',
  user_limit: 2, status: 'active', created_at: '2026-09-21T00:00:00.000Z', grants_count: 1, accounts_count: 1,
};

describe('/api/admin/google-apps', () => {
  it('lists apps with reservations counted and a computed full flag, never a secret', async () => {
    registry.listGoogleApps.mockResolvedValue([ROW]);
    const res = await send('GET', '');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps).toEqual([{
      id: ID, label: 'Google 1', clientId: ROW.client_id, projectNumber: '1', userLimit: 2, status: 'active',
      grantsCount: 1, reservedCount: 1, accountsCount: 1, full: true, createdAt: ROW.created_at,
    }]);
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
  });

  it('creates an app and maps registry errors to stable codes', async () => {
    registry.createGoogleApp.mockResolvedValueOnce(ROW);
    let res = await send('POST', '', { label: 'Google 1', clientId: ROW.client_id, clientSecret: 's' });
    expect(res.status).toBe(201);
    expect((await res.json()).app.clientId).toBe(ROW.client_id);

    registry.createGoogleApp.mockRejectedValueOnce(new GoogleAppError('app_same_project'));
    res = await send('POST', '', { label: 'G', clientId: ROW.client_id, clientSecret: 's' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'app_same_project' });
  });

  it('refuses a secret typed around the redaction placeholder', async () => {
    const res = await send('PATCH', `/${ID}`, { clientSecret: 'x••••••••' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'client_secret_redacted' });
    expect(registry.updateGoogleApp).not.toHaveBeenCalled();
  });

  it('keeps the stored secret when the placeholder comes back', async () => {
    registry.updateGoogleApp.mockResolvedValue(ROW);
    await send('PATCH', `/${ID}`, { label: 'Renamed', clientSecret: '••••••••' });
    expect(registry.updateGoogleApp).toHaveBeenCalledWith(ID, { label: 'Renamed', clientSecret: null, userLimit: undefined });
  });

  it('disabling drops the IMAP connections of the flagged mailboxes', async () => {
    registry.updateGoogleApp.mockResolvedValue({ ...ROW, status: 'disabled' });
    registry.setGoogleAppStatus.mockResolvedValue(['acc-1', 'acc-2']);
    const res = await send('PATCH', `/${ID}`, { status: 'disabled' });
    expect(res.status).toBe(200);
    expect(registry.setGoogleAppStatus).toHaveBeenCalledWith(ID, 'disabled');
    expect(manager.disconnectAccount.mock.calls.map((c) => c[0])).toEqual(['acc-1', 'acc-2']);
  });

  it('refuses to delete an app with mailboxes and rejects a malformed id', async () => {
    registry.deleteGoogleApp.mockRejectedValueOnce(new GoogleAppError('app_in_use'));
    let res = await send('DELETE', `/${ID}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'app_in_use' });

    res = await send('DELETE', '/not-a-uuid');
    expect(res.status).toBe(400);
  });
});
