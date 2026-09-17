import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => `enc:${v}`, decrypt: (v) => v }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../services/totp.js', () => ({
  generateTotpSecret: vi.fn(() => 'NEWSECRET'),
  totpKeyUri: vi.fn(() => 'otpauth://totp/user?secret=NEWSECRET'),
  verifyTotp: vi.fn(async () => true),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,') } }));

import express from 'express';
import totpRoutes from './totp.js';
import { query } from '../services/db.js';

let server;
let base;
let session;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/api/totp', totpRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  // A distinct user per test keeps the per-user attempt limiter out of the way.
  session = { userId: `user-${Math.random()}` };
});

const send = async (method, path, body) => {
  const res = await fetch(`${base}/api/totp${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

describe('TOTP setup never replaces an active second factor', () => {
  it('refuses to start setup while 2FA is enabled and keeps no pending secret', async () => {
    query.mockResolvedValueOnce({ rows: [{ username: 'user', totp_enabled: true }] });
    const res = await send('GET', '/setup');
    expect(res.status).toBe(409);
    expect(res.body.secret).toBeUndefined();
    expect(session.pendingTOTPSecret).toBeUndefined();
  });

  it('starts setup while 2FA is off', async () => {
    query.mockResolvedValueOnce({ rows: [{ username: 'user', totp_enabled: false }] });
    const res = await send('GET', '/setup');
    expect(res.status).toBe(200);
    expect(res.body.secret).toBe('NEWSECRET');
    expect(session.pendingTOTPSecret).toBe('NEWSECRET');
  });

  it('enables only when the account has no active secret', async () => {
    session.pendingTOTPSecret = 'NEWSECRET';
    session.pendingTOTPExpiry = Date.now() + 60_000;
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const res = await send('POST', '/enable', { code: '123456' });
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/totp_enabled = false/);
    expect(params).toEqual(['enc:NEWSECRET', session.userId]);
  });

  it('does not overwrite a secret enabled meanwhile by another session', async () => {
    session.pendingTOTPSecret = 'NEWSECRET';
    session.pendingTOTPExpiry = Date.now() + 60_000;
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await send('POST', '/enable', { code: '123456' });
    expect(res.status).toBe(409);
    expect(session.pendingTOTPSecret).toBeUndefined();
  });
});
