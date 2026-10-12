import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Local sign-in (AUTH_MODE=local) of a disabled user: the right password opens no session and
// starts no second factor; a wrong one answers as for anyone else.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, encrypt: (v) => v }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ getGlobalCategorizationEnabled: vi.fn(async () => false) }));
vi.mock('../services/redis.js', () => ({ redisClient: { scan: vi.fn(), get: vi.fn(), del: vi.fn(), set: vi.fn() } }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(), peek: vi.fn(), reset: vi.fn() }));

import express from 'express';
import bcrypt from 'bcryptjs';
import authRoutes from './auth.js';
import { query } from '../services/db.js';
import { consume, peek, reset } from '../services/rateLimiter.js';

let hash;
let server;
let base;
let session;
let user;
beforeAll(async () => {
  hash = await bcrypt.hash('right-password', 4);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = session;
    next();
  });
  app.use('/api/auth', authRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  session = { regenerate: (cb) => cb(), save: (cb) => cb(), destroy: (cb) => cb() };
  user = { id: 'u1', username: 'alice', password_hash: hash, totp_enabled: false, is_admin: false, disabled_at: new Date() };
  consume.mockReset().mockResolvedValue({ limited: false, resetMs: 0 });
  reset.mockReset().mockResolvedValue();
  peek.mockReset().mockResolvedValue({ limited: false, resetMs: 0 });
  query.mockReset().mockImplementation(async (sql) => {
    if (sql.includes("key = 'internal_auth_disabled'")) return { rows: [] };
    if (sql.startsWith('SELECT * FROM users WHERE')) return { rows: [user] };
    return { rows: [] };
  });
});

const login = (password) => fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'Alice', password }),
});

describe('POST /api/auth/login for a disabled user', () => {
  it('refuses the right password with user_disabled and opens no session', async () => {
    const res = await login('right-password');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'user_disabled', code: 'user_disabled' });
    expect(session.userId).toBeUndefined();
    expect(session.pendingUserId).toBeUndefined();
  });

  it('refuses before the second factor starts', async () => {
    user.totp_enabled = true;
    const res = await login('right-password');
    expect(res.status).toBe(403);
    expect(session.pendingUserId).toBeUndefined();
  });

  it('answers a wrong password as for any account', async () => {
    expect((await login('wrong')).status).toBe(401);
  });

  it('lets an enabled user in', async () => {
    user.disabled_at = null;
    const res = await login('right-password');
    expect(res.status).toBe(200);
    expect(session.userId).toBe('u1');
  });
});

describe('second factor of a user disabled after the password step', () => {
  it('opens no session on a valid email code', async () => {
    session.pendingUserId = 'u1';
    session.pendingTOTPExpiry = Date.now() + 60_000;
    const base0 = query.getMockImplementation();
    query.mockImplementation(async (sql, params) => (
      sql.includes('UPDATE email_otp_tokens SET used_at') ? { rows: [{ id: 't1' }] } : base0(sql, params)
    ));
    const res = await fetch(`${base}/api/auth/2fa/verify-email-otp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'user_disabled', code: 'user_disabled' });
    expect(session.userId).toBeUndefined();
  });
});
