import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createRealSchemaDb } from '../services/testing/realSchema.js';
import { createFakeWorker } from '../services/proton/connections.fixtures.js';

// Real requireAuth, identity gate and CSRF check over the real schema; the worker is a fake.
const state = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({ query: (s, p) => state.db.query(s, p), pool: { connect: async () => ({ query: (s, p) => state.db.query(s, p), release() {} }) } }));
vi.mock('../services/proton/workerClient.js', () => ({ callWorker: vi.fn() }));
vi.mock('../services/proton/apiReachability.js', () => ({ isProtonApiReachable: vi.fn(async () => true) }));
vi.mock('../services/accounts/connectionProbe.js', () => ({ probeConnection: vi.fn(async c => ({ imapLogin: c.auth_user, smtpLogin: c.smtp_auth_user })) }));
vi.mock('../services/encryption.js', () => ({ encrypt: v => v ? 'enc:' + v : null, decrypt: v => v }));
vi.mock('../services/redis.js', () => ({ redisClient: { incr: async () => { throw new Error('offline'); }, del: async () => {} } }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn() }));
import protonRoutes from './accountProton.js';
import { createIdentityGate } from '../middleware/identityGate.js';
import { requireCsrfHeader } from '../middleware/csrf.js';
import { callWorker } from '../services/proton/workerClient.js';
import { reset } from '../services/rateLimiter.js';
import { protonConnectionWork, setProtonMailEngine } from '../services/proton/connections.js';

const OWNER = '71000000-0000-4000-8000-000000000001';
const OTHER = '71000000-0000-4000-8000-000000000002';
const ADMIN = '71000000-0000-4000-8000-000000000003';
const DISABLED = '71000000-0000-4000-8000-000000000004';
const NATIVE = 'bmF0aXZlLXVzZXI=';
let server, base, fake;

beforeAll(async () => {
  state.db = await createRealSchemaDb();
  await state.db.query(`INSERT INTO users (id, username, email, is_admin, disabled_at) VALUES
    ($1, 'owner', 'owner@example.com', false, NULL), ($2, 'other', 'other@example.com', false, NULL),
    ($3, 'admin', 'admin@example.com', true, NULL), ($4, 'disabled', 'disabled@example.com', false, now())`, [OWNER, OTHER, ADMIN, DISABLED]);
  setProtonMailEngine({ connectAccount: vi.fn(async () => true), disconnectAccount: vi.fn(async () => {}), clearConnectCooldown: vi.fn() });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: req.get('x-test-user'), authMethod: 'google', destroy: fn => fn() }; next(); });
  app.use(createIdentityGate({ getSettings: () => ({ mode: 'google' }) }));
  app.use(requireCsrfHeader);
  app.use('/api/accounts/proton/connect', protonRoutes);
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); await state.db.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  for (const user of [OWNER, OTHER, ADMIN, DISABLED]) { await reset(`account-create:${user}`); await reset(`proton-poll:${user}`); }
  await state.db.exec('DELETE FROM proton_connections; DELETE FROM proton_mailbox_links; DELETE FROM email_accounts; DELETE FROM proton_users;');
  fake = createFakeWorker();
  callWorker.mockImplementation(fake.call);
});

const send = (method, path, { body, user = OWNER, csrf = true } = {}) => fetch(base + '/api/accounts/proton/connect' + path, {
  method,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(user ? { 'x-test-user': user } : {}), ...(csrf ? { 'X-Requested-With': 'MailExpert' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const startBody = (patch = {}) => ({ email: 'box@proton.me', password: 'main-secret-sentinel', requestId: randomUUID(), ...patch });

it('starts, polls and finishes a connection with no secret in any response', async () => {
  const started = await send('POST', '', { body: startBody({ name: 'Team' }) });
  expect(started.status).toBe(200);
  expect(started.headers.get('cache-control')).toBe('no-store');
  const { id } = await started.clone().json();
  fake.connect(id, NATIVE);
  const texts = [await started.text(), await (await send('GET', `/${id}`)).text()];
  await protonConnectionWork();
  const done = await send('GET', `/${id}`);
  texts.push(await done.clone().text());
  expect(await done.json()).toMatchObject({ id, state: 'connected', account: { email_address: 'box@proton.me', name: 'Team', can_reconnect_proton: true } });
  for (const text of texts) {
    for (const marker of ['secret-sentinel', 'password', 'bridgePassword', 'certificatePem', 'grpcToken', 'BEGIN CERTIFICATE']) expect(text).not.toContain(marker);
  }
});

it('login_operation_is_bound_to_actor over HTTP', async () => {
  const { id } = await (await send('POST', '', { body: startBody() })).json();
  const foreignActorResponse = await send('GET', `/${id}`, { user: OTHER });
  expect(foreignActorResponse.status).toBe(404);
  expect((await send('POST', `/${id}/cancel`, { user: OTHER })).status).toBe(404);
  expect((await send('POST', `/${id}/continue`, { user: OTHER, body: { challenge: '2fa', secret: '1' } })).status).toBe(404);
  const adminStatus = await send('GET', `/${id}`, { user: ADMIN });
  expect(adminStatus.status).toBe(200);
  expect(await adminStatus.json()).toEqual({ id, state: 'authenticating' });
  expect((await send('GET', '/not-a-uuid')).status).toBe(400);
  expect((await send('POST', `/${id}/cancel`)).status).toBe(200);
});

it.each([[null, 401], [DISABLED, 403]])('anonymous_or_disabled_cannot_start_reconnect (%s)', async (user, status) => {
  const reconnectAccountId = randomUUID();
  expect((await send('POST', '', { user, body: startBody({ reconnectAccountId }) })).status).toBe(status);
  expect((await send('POST', '', { user, body: startBody() })).status).toBe(status);
  expect(callWorker).not.toHaveBeenCalled();
  expect((await state.db.query('SELECT count(*)::int AS n FROM proton_connections')).rows[0].n).toBe(0);
});

it('refuses unknown fields, a missing CSRF header and a malformed request ID before the worker', async () => {
  for (const body of [startBody({ mail_provider: 'proton' }), startBody({ requestId: 'not-a-uuid' }), startBody({ password: '' }),
    startBody({ email: 'not-an-address' }), startBody({ reconnectAccountId: 'x' }), startBody({ name: 'a\r\nBcc: x' })]) {
    const res = await send('POST', '', { body });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request', code: 'invalid_request' });
  }
  expect((await send('POST', '', { body: startBody(), csrf: false })).status).toBe(403);
  const { id } = await (await send('POST', '', { body: startBody() })).json();
  expect((await send('POST', `/${id}/continue`, { body: { challenge: 'totp', secret: '1' } })).status).toBe(400);
  expect((await send('POST', `/${id}/continue`, { body: { challenge: '2fa', secret: '1', extra: true } })).status).toBe(400);
  expect((await send('POST', `/${id}/continue`, { body: { challenge: '2fa', secret: '1' } })).status).toBe(409);
  expect(fake.logins).toBe(1);
});

it('polling does not spend the password-attempt bucket and is bounded on its own', async () => {
  const { id } = await (await send('POST', '', { body: startBody() })).json();
  for (let i = 0; i < 20; i++) expect((await send('GET', `/${id}`)).status).toBe(200);
  for (let i = 0; i < 4; i++) expect((await send('POST', '', { body: startBody({ email: `n${i}@proton.me` }) })).status).toBe(200);
  const limited = await send('POST', '', { body: startBody({ email: 'six@proton.me' }) });
  expect(limited.status).toBe(429);
  expect(fake.logins).toBe(5);
  let status = 200;
  for (let i = 0; i < 400 && status === 200; i++) status = (await send('GET', `/${id}`)).status;
  expect(status).toBe(429);
});
