import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { createRealSchemaDb } from '../services/testing/realSchema.js';
import { decrypt, encrypt } from '../services/encryption.js';
import yandexOAuthRoutes, { yandexCallbackRoutes } from './oauthYandex.js';
import { buildYandexAuthorizationUrl, exchangeYandexCode, exchangeYandexDeviceCode, fetchYandexIdentity, requestYandexDeviceCode } from '../services/oauth/yandexOAuth.js';
import { probeConnection } from '../services/accounts/connectionProbe.js';

const fixtures = vi.hoisted(() => ({ db: null, redis: new Map() }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => fixtures.db.query(sql, params),
  withTransaction: (fn) => fixtures.db.transaction(fn),
}));
vi.mock('../services/redis.js', () => ({
  redisClient: {
    set: async (key, value, options) => {
      const present = fixtures.redis.has(key);
      if (options?.NX && present || options?.XX && !present) return null;
      fixtures.redis.set(key, value);
      return 'OK';
    },
    get: async (key) => fixtures.redis.get(key),
    del: async (key) => Number(fixtures.redis.delete(key)),
    eval: async (_script, { keys: [key], arguments: [token] }) =>
      fixtures.redis.get(key) === token ? Number(fixtures.redis.delete(key)) : 0,
    getDel: async (key) => {
      const value = fixtures.redis.get(key);
      fixtures.redis.delete(key);
      return value;
    },
  },
}));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../services/oauth/yandexOAuth.js', () => ({
  buildYandexAuthorizationUrl: vi.fn(({ state }) => `https://oauth.yandex.ru/authorize?state=${state}`),
  exchangeYandexCode: vi.fn(),
  requestYandexDeviceCode: vi.fn(),
  exchangeYandexDeviceCode: vi.fn(),
  fetchYandexIdentity: vi.fn(),
}));
vi.mock('../services/accounts/connectionProbe.js', () => ({ probeConnection: vi.fn() }));
vi.mock('../services/oauth/mailruOAuth.js', () => ({
  buildMailruAuthorizationUrl: vi.fn(async ({ state }) => `https://o2.mail.ru/login?state=${state}`),
  exchangeMailruCode: vi.fn(),
  fetchMailruIdentity: vi.fn(),
}));

import { mailruApiRoutes, mailruCallbackRoutes } from './oauthMailru.js';
import { hasMailboxOAuthConfig, saveMailboxOAuthConfig } from '../services/integrations/mailboxOAuth.js';
import { buildMailruAuthorizationUrl, exchangeMailruCode, fetchMailruIdentity } from '../services/oauth/mailruOAuth.js';

const USER = '40000000-0000-4000-8000-000000000001';
const EMAIL = 'team@example.com';
const ORIGIN = 'https://localhost';
const CALLBACK = `${ORIGIN}/oauth/mailru/callback`;
const YANDEX_CALLBACK = `${ORIGIN}/oauth/yandex/callback`;
const CONFIG = { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: CALLBACK };
let server;
let base;

beforeAll(async () => {
  vi.stubEnv('APP_URL', ORIGIN);
  vi.stubEnv('ENCRYPTION_KEY', '42'.repeat(32));
  fixtures.db = await createRealSchemaDb();
  await fixtures.db.query('INSERT INTO users (id, username) VALUES ($1, $2)', [USER, 'employee']);
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.headers.host = req.get('x-test-host');
    req.sessionID = req.get('x-test-session') || 'browser-1';
    if (req.get('x-test-session') !== 'anonymous') req.session = { userId: USER };
    next();
  });
  app.use('/api/oauth/mailru', mailruApiRoutes);
  app.use('/oauth/mailru', mailruCallbackRoutes);
  app.use('/api/oauth/yandex', yandexOAuthRoutes);
  app.use('/oauth/yandex', yandexCallbackRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  fixtures.redis.clear();
  vi.clearAllMocks();
  await fixtures.db.exec('DELETE FROM email_accounts; DELETE FROM integration_config;');
  await fixtures.db.query('INSERT INTO integration_config (provider, config) VALUES ($1, $2)', [
    'mailru', { ...CONFIG, clientSecret: encrypt(CONFIG.clientSecret) },
  ]);
  exchangeMailruCode.mockResolvedValue({
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: new Date(Date.now() + 3600000),
    scope: 'openid email mail.imap offline_access',
  });
  fetchMailruIdentity.mockResolvedValue({ sub: 'mail-user-id', email: EMAIL, name: 'Team' });
  await fixtures.db.query('INSERT INTO integration_config (provider, config) VALUES ($1, $2)', [
    'yandex', { clientId: CONFIG.clientId, clientSecret: encrypt(CONFIG.clientSecret) },
  ]);
  requestYandexDeviceCode.mockResolvedValue({
    deviceCode: 'server-private-code', userCode: 'usercode', verificationUri: 'https://ya.ru/device', interval: 5, expiresIn: 300,
  });
  const yandexTokens = {
    accessToken: 'yandex-access', refreshToken: 'yandex-refresh', expiresAt: new Date(Date.now() + 3600000),
  };
  exchangeYandexDeviceCode.mockResolvedValue(yandexTokens);
  exchangeYandexCode.mockResolvedValue(yandexTokens);
  fetchYandexIdentity.mockResolvedValue({ sub: 'yandex-user-id' });
  probeConnection.mockResolvedValue({ imapLogin: EMAIL, smtpLogin: EMAIL });
});

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await fixtures.db?.close();
  vi.unstubAllEnvs();
});

function start(body = { email: EMAIL }, host = 'localhost', session = 'browser-1') {
  return fetch(`${base}/api/oauth/mailru/start`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-test-host': host, 'x-forwarded-proto': 'https', 'x-test-session': session },
  });
}

async function startState(body) {
  const res = await start(body);
  expect(res.status).toBe(200);
  const { authorizationUrl } = await res.json();
  return new URL(authorizationUrl).searchParams.get('state');
}

function callback(state, session = 'browser-1') {
  return fetch(`${base}/oauth/mailru/callback?code=test-code&state=${state}`, {
    redirect: 'manual', headers: { 'x-test-host': 'localhost', 'x-forwarded-proto': 'https', 'x-test-session': session },
  });
}

const accounts = async () => (await fixtures.db.query('SELECT * FROM email_accounts')).rows;

it('saves only known fields and encrypts the write-only client secret', async () => {
  const result = await saveMailboxOAuthConfig('mailru', { ...CONFIG, clientSecret: 'replacement', unexpected: 'ignore' });
  expect(result).toEqual({ ok: true });
  const { rows: [{ config }] } = await fixtures.db.query("SELECT config FROM integration_config WHERE provider = 'mailru'");
  expect(Object.keys(config).sort()).toEqual(['clientId', 'clientSecret', 'redirectUri']);
  expect(config.clientSecret).not.toBe('replacement');
  expect(decrypt(config.clientSecret)).toBe('replacement');
  await expect(hasMailboxOAuthConfig('mailru')).resolves.toBe(true);
  await expect(saveMailboxOAuthConfig('mailru', { ...CONFIG, clientId: 'another-id', clientSecret: '' })).resolves.toEqual({ error: 'client_secret_required' });
  await expect(saveMailboxOAuthConfig('mailru', { ...CONFIG, redirectUri: 'https://other.example.com/oauth/mailru/callback' })).resolves.toEqual({ error: 'redirect_uri_invalid' });
});

it('connects by authorization code and stores only encrypted credentials for the fixed IMAP and SMTP servers', async () => {
  const state = await startState({ email: EMAIL.toUpperCase() });
  expect(buildMailruAuthorizationUrl).toHaveBeenCalledWith({
    clientId: CONFIG.clientId, state, codeChallenge: expect.any(String), redirectUri: CALLBACK, loginHint: EMAIL,
  });
  const res = await callback(state);
  expect(res.headers.get('location')).toBe('/?oauth_success=mailru&oauth_result=created');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  const [row] = await accounts();
  expect(row).toMatchObject({
    email_address: EMAIL, added_by: USER, auth_user: EMAIL, smtp_auth_user: EMAIL,
    imap_host: 'imap.mail.ru', imap_port: 993, imap_tls_mode: 'implicit',
    smtp_host: 'smtp.mail.ru', smtp_port: 465, smtp_tls: 'SSL',
    oauth_provider: 'mailru', mail_provider: 'mailru', connection_mode: 'managed',
    oauth_client_id: CONFIG.clientId, oauth_subject: 'mail-user-id',
  });
  expect(row.oauth_access_token).not.toBe('fixture-access');
  expect(row.oauth_refresh_token).not.toBe('fixture-refresh');
  expect(decrypt(row.oauth_access_token)).toBe('fixture-access');
  expect(decrypt(row.oauth_refresh_token)).toBe('fixture-refresh');
  expect((await callback(state)).headers.get('location')).toContain('oauth_error=invalid_state');
  expect(await accounts()).toHaveLength(1);
});

it('refuses anonymous starts, foreign origins and another browser for the same user', async () => {
  expect((await start(undefined, 'localhost', 'anonymous')).status).toBe(401);
  expect((await start(undefined, 'unlisted.example.com')).status).toBe(409);
  const state = await startState();
  expect((await callback(state, 'another-browser')).headers.get('location')).toContain('oauth_error=invalid_state');
  expect(exchangeMailruCode).not.toHaveBeenCalled();
  expect(await accounts()).toHaveLength(0);
});

it('refuses a different mailbox and a grant without mail access or refresh capability', async () => {
  fetchMailruIdentity.mockResolvedValueOnce({ sub: 'different', email: 'different@example.com' });
  expect((await callback(await startState())).headers.get('location')).toContain('oauth_error=account_mismatch');
  exchangeMailruCode.mockRejectedValueOnce(Object.assign(new Error('scope_missing'), { code: 'scope_missing' }));
  expect((await callback(await startState())).headers.get('location')).toContain('oauth_error=scope_missing');
  exchangeMailruCode.mockRejectedValueOnce(Object.assign(new Error('missing_refresh_token'), { code: 'missing_refresh_token' }));
  expect((await callback(await startState())).headers.get('location')).toContain('oauth_error=missing_refresh_token');
  expect(await accounts()).toHaveLength(0);
});

it('reconnects the same account in place only for its existing subject', async () => {
  await callback(await startState());
  const [original] = await accounts();
  expect((await start()).status).toBe(409);
  await fixtures.db.query("UPDATE email_accounts SET oauth_reconnect_required = true, sync_error = 'oauth_reconnect_required' WHERE id = $1", [original.id]);
  fetchMailruIdentity.mockResolvedValueOnce({ sub: 'other-user-id', email: EMAIL });
  expect((await callback(await startState({ accountId: original.id }))).headers.get('location')).toContain('oauth_error=account_mismatch');
  expect((await accounts())[0].oauth_refresh_token).toBe(original.oauth_refresh_token);
  const res = await callback(await startState({ accountId: original.id }));
  expect(res.headers.get('location')).toBe('/?oauth_success=mailru&oauth_result=updated');
  expect(await accounts()).toEqual([expect.objectContaining({ id: original.id, oauth_reconnect_required: false, sync_error: null })]);
});

function device(path, body, session = 'browser-1') {
  return fetch(`${base}/api/oauth/yandex/device${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-test-host': 'localhost', 'x-forwarded-proto': 'https', 'x-test-session': session },
  });
}

function yandexStart(body = { email: EMAIL }, host = 'localhost', session = 'browser-1') {
  return fetch(`${base}/api/oauth/yandex/start`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-test-host': host, 'x-forwarded-proto': 'https', 'x-test-session': session },
  });
}

async function yandexStartState(body) {
  const response = await yandexStart(body);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return new URL((await response.json()).authorizationUrl).searchParams.get('state');
}

function yandexCallback(state, session = 'browser-1') {
  return fetch(`${base}/oauth/yandex/callback?code=browser-code&state=${state}`, {
    redirect: 'manual', headers: { 'x-test-host': 'localhost', 'x-forwarded-proto': 'https', 'x-test-session': session },
  });
}

async function configureYandexCallback() {
  await expect(saveMailboxOAuthConfig('yandex', { clientId: CONFIG.clientId, redirectUri: YANDEX_CALLBACK }))
    .resolves.toEqual({ ok: true });
}

it('stores, preserves and clears the optional Yandex callback with the saved secret', async () => {
  expect((await yandexStart()).status).toBe(409);
  await expect(saveMailboxOAuthConfig('yandex', { clientId: CONFIG.clientId, redirectUri: CALLBACK }))
    .resolves.toEqual({ error: 'redirect_uri_invalid' });
  await configureYandexCallback();
  await expect(saveMailboxOAuthConfig('yandex', { clientId: CONFIG.clientId, clientSecret: 'rotated' }))
    .resolves.toEqual({ ok: true });
  expect((await yandexStart()).status).toBe(200);
  await expect(saveMailboxOAuthConfig('yandex', { clientId: CONFIG.clientId, redirectUri: ' ' }))
    .resolves.toEqual({ ok: true });
  const { rows: [{ config }] } = await fixtures.db.query("SELECT config FROM integration_config WHERE provider = 'yandex'");
  expect(config).not.toHaveProperty('redirectUri');
  expect(decrypt(config.clientSecret)).toBe('rotated');
  expect((await yandexStart()).status).toBe(409);
  await deviceStart();
});

it('prefills the Yandex browser login and verifies mailbox access before saving a single-use grant', async () => {
  await configureYandexCallback();
  const state = await yandexStartState({ email: EMAIL.toUpperCase() });
  expect(buildYandexAuthorizationUrl).toHaveBeenCalledWith({
    clientId: CONFIG.clientId, redirectUri: YANDEX_CALLBACK, loginHint: EMAIL, state, codeChallenge: expect.any(String),
  });
  probeConnection.mockImplementationOnce(async () => {
    expect(await accounts()).toHaveLength(0);
    return { imapLogin: EMAIL, smtpLogin: EMAIL };
  });
  const response = await yandexCallback(state);
  expect(response.headers.get('location')).toBe('/?oauth_success=yandex&oauth_result=created');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(exchangeYandexCode).toHaveBeenCalledWith(expect.objectContaining({
    clientId: CONFIG.clientId, code: 'browser-code', codeVerifier: expect.any(String),
  }));
  expect(probeConnection).toHaveBeenCalledWith(expect.objectContaining({
    email_address: EMAIL, imap_host: 'imap.yandex.com', smtp_host: 'smtp.yandex.com',
  }), { oauthAccessToken: 'yandex-access' });
  expect(await accounts()).toEqual([expect.objectContaining({ email_address: EMAIL, oauth_subject: 'yandex-user-id' })]);
  expect((await yandexCallback(state)).headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=yandex');
  expect(exchangeYandexCode).toHaveBeenCalledOnce();
});

it('refuses Yandex browser flow on a different origin or session or without mailbox access', async () => {
  await configureYandexCallback();
  expect((await yandexStart(undefined, 'unlisted.example.com')).status).toBe(409);
  expect((await yandexStart(undefined, 'localhost', 'anonymous')).status).toBe(401);
  const state = await yandexStartState();
  expect((await yandexCallback(state, 'another-browser')).headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=yandex');
  expect(exchangeYandexCode).not.toHaveBeenCalled();
  probeConnection.mockRejectedValueOnce(Object.assign(new Error('provider response'), { code: 'smtp_auth_failed' }));
  expect((await yandexCallback(await yandexStartState())).headers.get('location')).toBe('/?oauth_error=smtp_auth_failed&oauth_provider=yandex');
  expect(await accounts()).toHaveLength(0);
});

async function deviceStart(body = { email: EMAIL }) {
  const response = await device('', body);
  expect(response.status).toBe(200);
  const flow = await response.json();
  expect(flow).toEqual({
    flowId: expect.any(String), userCode: 'usercode', verificationUri: 'https://ya.ru/device', expiresIn: 300, interval: 5,
  });
  return { flowId: flow.flowId };
}

it('verifies the requested Yandex mailbox over both mail protocols before storing the grant', async () => {
  probeConnection.mockImplementationOnce(async () => {
    expect(await accounts()).toHaveLength(0);
    return { imapLogin: EMAIL, smtpLogin: EMAIL };
  });
  const poll = await deviceStart();
  expect((await device('/poll', poll, 'another-browser')).status).toBe(404);
  const result = await device('/poll', poll);
  expect(await result.json()).toEqual({ status: 'success', result: 'created' });
  expect(probeConnection).toHaveBeenCalledWith(expect.objectContaining({
    email_address: EMAIL, imap_host: 'imap.yandex.com', smtp_host: 'smtp.yandex.com', smtp_port: 465,
  }), { oauthAccessToken: 'yandex-access' });
  const [row] = await accounts();
  expect(row).toMatchObject({ mail_provider: 'yandex', oauth_provider: 'yandex', oauth_subject: 'yandex-user-id', connection_mode: 'managed' });
  expect(decrypt(row.oauth_refresh_token)).toBe('yandex-refresh');
  expect(await (await device('/poll', poll)).json()).toEqual({ status: 'success', result: 'created' });
  expect(exchangeYandexDeviceCode).toHaveBeenCalledTimes(1);
});

it('does not save a Yandex account whose SMTP authorization fails', async () => {
  probeConnection.mockRejectedValueOnce(Object.assign(new Error('provider response'), { code: 'smtp_auth_failed' }));
  const poll = await deviceStart();
  expect(await (await device('/poll', poll)).json()).toEqual({ error: 'smtp_auth_failed', code: 'smtp_auth_failed' });
  expect(await accounts()).toHaveLength(0);
});

it('can cancel a pending Yandex flow before the token is exchanged', async () => {
  const poll = await deviceStart();
  const cancel = await device('/cancel', poll);
  expect(cancel.status).toBe(200);
  expect(await cancel.json()).toEqual({ ok: true });
  expect((await device('/poll', poll)).status).toBe(404);
  expect(exchangeYandexDeviceCode).not.toHaveBeenCalled();
});

it('does not exchange a Yandex device code twice or save after cancellation during probing', async () => {
  const enteredProbe = Promise.withResolvers();
  const continueProbe = Promise.withResolvers();
  probeConnection.mockImplementationOnce(async () => {
    enteredProbe.resolve();
    await continueProbe.promise;
  });
  const poll = await deviceStart();
  const original = device('/poll', poll);
  await enteredProbe.promise;
  try {
    expect(await (await device('/poll', poll)).json()).toMatchObject({ status: 'pending' });
    expect((await device('/cancel', poll)).status).toBe(200);
  } finally {
    continueProbe.resolve();
  }
  expect((await original).status).toBe(404);
  expect(exchangeYandexDeviceCode).toHaveBeenCalledOnce();
  expect(await accounts()).toHaveLength(0);
});
