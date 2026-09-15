import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAdmin: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({
  imapManager: { disconnectUser: vi.fn(async () => {}), wss: { clients: new Set() } },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({})),
  invalidateConnectionPolicyCache: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));

import express from 'express';
import adminRoutes from './admin.js';
import { query, withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { destroyUserSessions } from './auth.js';
import { closeUserSockets } from '../services/websocket.js';

const ADMIN_ID = '00000000-0000-0000-0000-00000000000a';
const USER_ID = '00000000-0000-0000-0000-00000000000b';
const USER_ROW = {
  id: USER_ID, username: 'user@example.com', email: 'user@example.com', is_admin: false,
  totp_enabled: false, disabled_at: null, created_at: '2026-09-15T00:00:00.000Z',
};

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: ADMIN_ID, username: 'admin@example.com' };
    next();
  });
  app.use('/api/admin', adminRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Transaction client that routes SQL by pattern and records every call.
let calls;
function installTransaction(handlers) {
  calls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push([sql, params]);
      for (const [re, result] of handlers) {
        if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  withTransaction.mockImplementation(async (fn) => fn(client));
}
const sqlCall = (re) => calls.find(([sql]) => re.test(sql));
const lock = [/pg_advisory_xact_lock/, { rows: [] }];
const target = (row) => [/SELECT id, email, is_admin, disabled_at FROM users WHERE id = \$1 FOR UPDATE/, { rows: row ? [row] : [] }];
const otherAdmins = (count) => [/SELECT COUNT\(\*\)::int AS count FROM users/, { rows: [{ count }] }];

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  destroyUserSessions.mockClear();
  closeUserSockets.mockClear();
  imapManager.disconnectUser.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const send = (method, path, body) => fetch(`${base}/api/admin${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

describe('GET /api/admin/users', () => {
  it('lists email, status and bootstrap admins', async () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'user@example.com');
    query.mockImplementation(async (sql) => (/COUNT/.test(sql)
      ? { rows: [{ total: '1' }] }
      : { rows: [{ ...USER_ROW, disabled_at: '2026-09-16T00:00:00.000Z' }] }));
    const { body } = await send('GET', '/users');
    expect(body).toEqual({
      total: 1,
      users: [{
        id: USER_ID, username: 'user@example.com', email: 'user@example.com', isAdmin: false, totpEnabled: false,
        disabledAt: '2026-09-16T00:00:00.000Z', created_at: '2026-09-15T00:00:00.000Z', isBootstrapAdmin: true,
      }],
    });
  });
});

describe('POST /api/admin/users', () => {
  const emailLookup = (row) => [/^\s*SELECT .* FROM users WHERE lower\(email\) = \$1/, { rows: row ? [row] : [] }];
  const claim = (row) => [/^\s*UPDATE users SET email = \$1/, { rows: row ? [row] : [] }];

  it('rejects an invalid address', async () => {
    expect(await send('POST', '/users', { email: 'nope' })).toEqual({
      status: 400, body: { error: 'A valid email address is required', code: 'email_invalid' },
    });
  });

  it('approves a new person', async () => {
    installTransaction([lock, emailLookup(null), claim(null), [/^\s*INSERT INTO users/, { rows: [USER_ROW] }]]);
    const { status, body } = await send('POST', '/users', { email: ' User@Example.com ' });
    expect(status).toBe(201);
    expect(body.user).toMatchObject({ id: USER_ID, email: 'user@example.com', isAdmin: false, disabledAt: null });
    expect(sqlCall(/INSERT INTO users/)[1]).toEqual(['user@example.com', false]);
  });

  it('gives the email to a legacy user named by it', async () => {
    installTransaction([lock, emailLookup(null), claim(USER_ROW)]);
    expect((await send('POST', '/users', { email: 'user@example.com' })).status).toBe(200);
  });

  it('refuses an address that is already approved or taken as a username', async () => {
    installTransaction([lock, emailLookup(USER_ROW)]);
    expect((await send('POST', '/users', { email: 'user@example.com' })).body.code).toBe('user_exists');

    installTransaction([lock, emailLookup(null), claim(null), [/^\s*INSERT INTO users/, () => {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    }]]);
    expect(await send('POST', '/users', { email: 'user@example.com' })).toMatchObject({ status: 409, body: { code: 'username_taken' } });
  });
});

describe('PATCH /api/admin/users/:id', () => {
  const update = (row) => [/^\s*UPDATE users\s+SET is_admin = \$2/, (params) => ({
    rows: [{ ...row, is_admin: params[1], email: params[2], disabled_at: params[3] }],
  })];

  it('validates the fields and refuses to lock the admin out of their own account', async () => {
    expect((await send('PATCH', `/users/${USER_ID}`, { isAdmin: 'yes' })).body.code).toBe('invalid_field');
    expect((await send('PATCH', `/users/${USER_ID}`, { email: 'nope' })).body.code).toBe('email_invalid');
    expect((await send('PATCH', `/users/${USER_ID}`, {})).body.code).toBe('no_fields');
    expect((await send('PATCH', `/users/${ADMIN_ID}`, { disabled: true })).body.code).toBe('self_change');
    expect((await send('PATCH', `/users/${ADMIN_ID}`, { isAdmin: false })).body.code).toBe('self_change');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('disables a user and ends their sessions and sockets', async () => {
    installTransaction([lock, target(USER_ROW), update(USER_ROW)]);
    const { status, body } = await send('PATCH', `/users/${USER_ID}`, { disabled: true });
    expect(status).toBe(200);
    expect(body.user.disabledAt).toEqual(expect.any(String));
    const [, params] = sqlCall(/^\s*UPDATE users/);
    expect(params[0]).toBe(USER_ID);
    expect(params[3]).toEqual(expect.any(Date));
    expect(params[4]).toBe(ADMIN_ID);
    expect(destroyUserSessions).toHaveBeenCalledWith(USER_ID);
    expect(closeUserSockets).toHaveBeenCalledWith(imapManager.wss, USER_ID);
  });

  it('enables a user without touching sessions', async () => {
    const disabledRow = { ...USER_ROW, disabled_at: '2026-09-16T00:00:00.000Z' };
    installTransaction([lock, target(disabledRow), update(disabledRow)]);
    const { body } = await send('PATCH', `/users/${USER_ID}`, { disabled: false });
    expect(body.user.disabledAt).toBeNull();
    expect(destroyUserSessions).not.toHaveBeenCalled();
  });

  it('keeps at least one active admin', async () => {
    const adminRow = { ...USER_ROW, is_admin: true };
    installTransaction([lock, target(adminRow), otherAdmins(0)]);
    expect(await send('PATCH', `/users/${USER_ID}`, { isAdmin: false })).toMatchObject({ status: 409, body: { code: 'last_admin' } });
    expect(sqlCall(/^\s*UPDATE users/)).toBeUndefined();

    vi.stubEnv('AUTH_MODE', 'google');
    installTransaction([lock, target(adminRow), otherAdmins(0)]);
    expect((await send('PATCH', `/users/${USER_ID}`, { email: null })).body.code).toBe('last_admin');
    expect(sqlCall(/COUNT/)[0]).toMatch(/AND email IS NOT NULL/);
  });

  it('refuses to change a bootstrap admin', async () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'user@example.com');
    installTransaction([lock, target({ ...USER_ROW, is_admin: true })]);
    expect(await send('PATCH', `/users/${USER_ID}`, { disabled: true })).toMatchObject({ status: 409, body: { code: 'bootstrap_admin' } });
  });

  it('refuses an email another user already has', async () => {
    installTransaction([lock, target(USER_ROW), [/SELECT id FROM users WHERE lower\(email\) = \$1 AND id <> \$2/, { rows: [{ id: ADMIN_ID }] }]]);
    expect((await send('PATCH', `/users/${USER_ID}`, { email: 'admin@example.com' })).body.code).toBe('email_taken');
  });

  it('signs a user out when google mode loses their email', async () => {
    vi.stubEnv('AUTH_MODE', 'google');
    installTransaction([lock, target(USER_ROW), update(USER_ROW)]);
    expect((await send('PATCH', `/users/${USER_ID}`, { email: '' })).body.user.email).toBeNull();
    expect(destroyUserSessions).toHaveBeenCalledWith(USER_ID);
  });
});

describe('DELETE /api/admin/users/:id', () => {
  const mailboxes = (count) => [/FROM email_accounts WHERE user_id = \$1/, { rows: [{ count }] }];

  it('keeps mailbox owners in google mode until mailboxes are shared', async () => {
    vi.stubEnv('AUTH_MODE', 'google');
    installTransaction([lock, target(USER_ROW), mailboxes(2)]);
    expect(await send('DELETE', `/users/${USER_ID}`)).toMatchObject({ status: 409, body: { code: 'user_has_mailboxes' } });
    expect(imapManager.disconnectUser).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a bootstrap admin and the last active admin', async () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'user@example.com');
    installTransaction([lock, target(USER_ROW)]);
    expect((await send('DELETE', `/users/${USER_ID}`)).body.code).toBe('bootstrap_admin');

    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', '');
    installTransaction([lock, target({ ...USER_ROW, is_admin: true }), otherAdmins(0)]);
    expect((await send('DELETE', `/users/${USER_ID}`)).body.code).toBe('last_admin');
  });

  it('signs the user out everywhere and deletes them', async () => {
    installTransaction([lock, target(USER_ROW)]);
    query.mockResolvedValue({ rows: [] });
    expect(await send('DELETE', `/users/${USER_ID}`)).toEqual({ status: 200, body: { ok: true } });
    expect(imapManager.disconnectUser).toHaveBeenCalledWith(USER_ID);
    expect(destroyUserSessions).toHaveBeenCalledWith(USER_ID);
    expect(closeUserSockets).toHaveBeenCalledWith(imapManager.wss, USER_ID);
    expect(query).toHaveBeenCalledWith('DELETE FROM users WHERE id = $1', [USER_ID]);
  });
});

describe('POST /api/admin/invites', () => {
  it('sends invites through the system SMTP only', async () => {
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    query.mockResolvedValue({ rows: [] });
    const { body } = await send('POST', '/invites', { email: 'new@example.com' });
    expect(body).toMatchObject({ ok: true, emailSent: false, emailError: null });
    expect(query.mock.calls.some(([sql]) => /email_accounts/.test(sql))).toBe(false);
  });
});
