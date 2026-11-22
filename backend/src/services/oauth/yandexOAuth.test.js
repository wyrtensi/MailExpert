import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildYandexAuthorizationUrl, exchangeYandexCode, exchangeYandexDeviceCode, fetchYandexIdentity, requestYandexDeviceCode, refreshYandexToken,
} from './yandexOAuth.js';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../integrations/mailboxOAuth.js', () => ({ getMailboxOAuthConfig: vi.fn() }));
import { query } from '../db.js';
import { decrypt, encrypt } from '../encryption.js';
import { getMailboxOAuthConfig } from '../integrations/mailboxOAuth.js';

const config = { clientId: 'client', clientSecret: 'secret+%' };
const tokenResponse = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer' };
const deviceResponse = {
  device_code: 'opaque-device-secret',
  user_code: 'h5nbcr6c',
  verification_url: 'https://ya.ru/device',
  expires_in: 300,
  interval: 5,
};

let fetchMock;
const reply = (data, ok = true) => fetchMock.mockResolvedValue({ ok, json: async () => data });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Yandex browser authorization', () => {
  it('prefills the mailbox and asks only for the required mail scopes with PKCE', () => {
    const redirectUri = 'https://panel.example.com/oauth/yandex/callback';
    const url = new URL(buildYandexAuthorizationUrl({
      ...config, redirectUri, loginHint: 'team+inbox@example.com', state: 'flow-state', codeChallenge: 'challenge',
    }));
    expect(url.origin + url.pathname).toBe('https://oauth.yandex.ru/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: config.clientId, response_type: 'code', redirect_uri: redirectUri, login_hint: 'team+inbox@example.com',
      state: 'flow-state', code_challenge: 'challenge', code_challenge_method: 'S256', scope: 'mail:imap_full mail:smtp',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchanges the browser code with the verifier and server-side client credentials', async () => {
    reply(tokenResponse);
    await expect(exchangeYandexCode({ ...config, code: 'browser-code', codeVerifier: 'verifier' })).resolves.toMatchObject({
      accessToken: 'access', refreshToken: 'refresh', scope: 'mail:imap_full mail:smtp',
    });
    const [[url, init]] = fetchMock.mock.calls;
    expect(url).toBe('https://oauth.yandex.ru/token');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('client:secret+%').toString('base64'));
    expect(Object.fromEntries(init.body)).toEqual({
      grant_type: 'authorization_code', code: 'browser-code', code_verifier: 'verifier',
    });
  });

  it('requires a refresh token for the browser grant as well', async () => {
    reply({ ...tokenResponse, refresh_token: undefined });
    await expect(exchangeYandexCode({ ...config, code: 'browser-code', codeVerifier: 'verifier' }))
      .rejects.toMatchObject({ code: 'missing_refresh_token' });
  });
});

describe('Yandex device authorization', () => {
  it('requests device codes with only mail scopes and public client ID', async () => {
    reply(deviceResponse);
    await expect(requestYandexDeviceCode(config)).resolves.toEqual({
      deviceCode: 'opaque-device-secret',
      userCode: 'h5nbcr6c',
      verificationUri: 'https://ya.ru/device',
      expiresIn: 300,
      interval: 5,
    });
    const [[url, init]] = fetchMock.mock.calls;
    expect(url).toBe('https://oauth.yandex.ru/device/code');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Object.fromEntries(init.body)).toEqual({ client_id: 'client', scope: 'mail:imap_full mail:smtp' });
    expect(init.headers?.Authorization).toBeUndefined();
  });

  it('defaults the polling interval if omitted', async () => {
    reply({ ...deviceResponse, verification_url: 'https://oauth.yandex.ru/device', interval: undefined });
    await expect(requestYandexDeviceCode(config)).resolves.toMatchObject({ interval: 5 });
  });

  it.each(['https://ya.ru/device?next=/', 'https://oauth.yandex.ru.example.com/device', 'http://ya.ru/device'])(
    'rejects an unexpected verification URL %s', async (verification_url) => {
      reply({ ...deviceResponse, verification_url });
      await expect(requestYandexDeviceCode(config)).rejects.toMatchObject({ code: 'yandex_device_code_failed' });
    },
  );

  it('exchanges the opaque device code with Basic credentials', async () => {
    reply(tokenResponse);
    await expect(exchangeYandexDeviceCode({ ...config, deviceCode: 'device' })).resolves.toMatchObject({
      accessToken: 'access', refreshToken: 'refresh', expiresAt: expect.any(Date), scope: 'mail:imap_full mail:smtp',
    });
    const [[url, init]] = fetchMock.mock.calls;
    expect(url).toBe('https://oauth.yandex.ru/token');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('client:secret+%').toString('base64'));
    expect(Object.fromEntries(init.body)).toEqual({ grant_type: 'device_code', code: 'device' });
  });

  it.each([
    ['authorization_pending', 'authorization_pending'], ['slow_down', 'slow_down'],
    ['access_denied', 'access_denied'], ['expired_token', 'expired_token'],
    ['invalid_grant', 'expired_token'], ['invalid_client', 'app_unavailable'],
    ['unexpected secret', 'yandex_token_failed'],
  ])('normalizes %s to %s', async (error, code) => {
    reply({ error, error_description: 'private provider data' }, false);
    await expect(exchangeYandexDeviceCode({ ...config, deviceCode: 'device' })).rejects.toMatchObject({ code, message: code });
  });

  it.each([
    [{ scope: 'mail:imap_full' }, 'scope_missing'],
    [{ refresh_token: undefined }, 'missing_refresh_token'],
    [{ access_token: 'access\nsecret' }, 'yandex_token_failed'],
  ])('rejects insufficient or malformed grants', async (changes, code) => {
    reply({ ...tokenResponse, ...changes });
    await expect(exchangeYandexDeviceCode({ ...config, deviceCode: 'device' })).rejects.toMatchObject({ code });
  });
});

describe('Yandex refresh', () => {
  const makeAccount = () => ({
    id: 'account', oauth_provider: 'yandex', oauth_client_id: config.clientId,
    oauth_refresh_token: encrypt('old-refresh'),
  });

  it('uses the issuing client and compares the full grant before persisting rotated tokens', async () => {
    const account = makeAccount();
    getMailboxOAuthConfig.mockResolvedValue(config);
    query.mockResolvedValueOnce({ rows: [account] });
    reply(tokenResponse);

    await expect(refreshYandexToken(account)).resolves.toBe(account);
    expect(getMailboxOAuthConfig).toHaveBeenCalledExactlyOnceWith('yandex');
    const [[url, init]] = fetchMock.mock.calls;
    expect(url).toBe('https://oauth.yandex.ru/token');
    expect(Object.fromEntries(init.body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh' });
    const [[sql, params]] = query.mock.calls;
    expect(sql).toContain('oauth_client_id = $5');
    expect(sql).toContain('oauth_refresh_token IS NOT DISTINCT FROM $6');
    expect(sql).toContain('oauth_provider = $7');
    expect(sql).toContain('oauth_reconnect_required = false');
    expect(decrypt(params[0])).toBe('access');
    expect(decrypt(params[1])).toBe('refresh');
    expect(params.slice(2)).toEqual([expect.any(Date), account.id, config.clientId, account.oauth_refresh_token, 'yandex']);
  });

  it('preserves the reconnect signal for a revoked grant', async () => {
    getMailboxOAuthConfig.mockResolvedValue(config);
    reply({ error: 'invalid_grant' }, false);
    await expect(refreshYandexToken(makeAccount())).rejects.toMatchObject({
      code: 'yandex_token_failed', oauthError: 'invalid_grant',
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Yandex user identity', () => {
  it('uses the stable id and verifies the token client with no email scope', async () => {
    reply({ id: 'user-id', psuid: 'client-pairwise-id', client_id: 'client' });
    await expect(fetchYandexIdentity('token', config)).resolves.toEqual({ sub: 'user-id' });
    expect(fetchMock).toHaveBeenCalledWith('https://login.yandex.ru/info', expect.objectContaining({
      method: 'GET', headers: { Authorization: 'OAuth token' }, redirect: 'error',
    }));
  });

  it.each([{ id: 'user-id', client_id: 'other-client' }, { psuid: 'pairwise', client_id: 'client' }])(
    'rejects an identity without matching client and stable id', async (payload) => {
      reply(payload);
      await expect(fetchYandexIdentity('token', config)).rejects.toMatchObject({ code: 'yandex_userinfo_failed' });
    },
  );
});
