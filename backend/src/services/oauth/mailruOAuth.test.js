import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../integrations/mailboxOAuth.js', () => ({ getMailboxOAuthConfig: vi.fn() }));

import { query } from '../db.js';
import { decrypt, encrypt } from '../encryption.js';
import { getMailboxOAuthConfig } from '../integrations/mailboxOAuth.js';

const issuer = 'https://account.mail.ru';
const discovery = {
  issuer,
  authorization_endpoint: 'https://o2.mail.ru/login',
  token_endpoint: 'https://o2.mail.ru/api/v1/oidc/token/issue',
  userinfo_endpoint: 'https://o2.mail.ru/api/v1/oidc/userinfo',
};
const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:3000/oauth/mailru/callback',
};
const tokens = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 };
const fakeFetch = vi.fn();
let oauth;

const json = (payload, status = 200) => Response.json(payload, { status });

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  fakeFetch.mockResolvedValueOnce(json(discovery));
  oauth = await import('./mailruOAuth.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Mail.ru OAuth protocol', () => {
  it('reuses discovery and requests PKCE, offline consent and a mailbox login hint', async () => {
    const input = { ...config, state: 'state', codeChallenge: 'challenge', loginHint: 'team+alerts@mail.ru' };
    const urls = await Promise.all([oauth.buildMailruAuthorizationUrl(input), oauth.buildMailruAuthorizationUrl(input)]);
    expect(fakeFetch).toHaveBeenCalledExactlyOnceWith(issuer + '/.well-known/openid-configuration',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
    for (const value of urls) {
      const url = new URL(value);
      expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri,
        state: 'state', code_challenge: 'challenge', code_challenge_method: 'S256',
        scope: 'openid email mail.imap offline_access', prompt: 'consent', login_hint: 'team+alerts@mail.ru',
      });
    }
  });

  it.each([
    { issuer: 'https://example.org' },
    { token_endpoint: 'https://o2.mail.ru.evil.example/api/v1/oidc/token/issue' },
    { token_endpoint: 'https://user:secret@o2.mail.ru/api/v1/oidc/token/issue' },
    { userinfo_endpoint: 'http://o2.mail.ru/api/v1/oidc/userinfo' },
  ])('rejects untrusted metadata without transmitting credentials (%o)', async (override) => {
    fakeFetch.mockReset().mockResolvedValueOnce(json({ ...discovery, ...override }));
    await expect(oauth.exchangeMailruCode({ ...config, code: 'code', codeVerifier: 'verifier' }))
      .rejects.toMatchObject({ code: 'mailru_discovery_failed' });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('retries discovery after a failed lookup', async () => {
    fakeFetch.mockReset().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(discovery));
    const input = { ...config, state: 'state', codeChallenge: 'challenge' };
    await expect(oauth.buildMailruAuthorizationUrl(input)).rejects.toMatchObject({ code: 'mailru_discovery_failed' });
    await expect(oauth.buildMailruAuthorizationUrl(input)).resolves.toContain(discovery.authorization_endpoint);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('posts code, verifier and callback using HTTP Basic and accepts an omitted scope', async () => {
    fakeFetch.mockResolvedValueOnce(json(tokens));
    const result = await oauth.exchangeMailruCode({ ...config, code: 'code', codeVerifier: 'verifier' });
    expect(result).toEqual({
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: expect.any(Date), scope: 'openid email mail.imap offline_access',
    });
    const [url, request] = fakeFetch.mock.calls[1];
    expect(url).toBe(discovery.token_endpoint);
    expect(request).toMatchObject({
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { Authorization: 'Basic ' + Buffer.from('client-id:client-secret').toString('base64') },
    });
    expect(Object.fromEntries(request.body)).toEqual({
      grant_type: 'authorization_code', code: 'code', code_verifier: 'verifier', redirect_uri: config.redirectUri,
    });
  });

  it.each([
    [{ scope: 'openid email offline_access' }, 'scope_missing'],
    [{ refresh_token: undefined }, 'missing_refresh_token'],
    [{ error: 'invalid_grant', error_description: 'secret data' }, 'mailru_token_failed'],
    [{ expires_in: 0 }, 'mailru_token_failed'],
  ])('rejects incomplete or invalid token responses and keeps errors free of secrets', async (override, code) => {
    fakeFetch.mockResolvedValueOnce(json({ ...tokens, ...override }));
    await expect(oauth.exchangeMailruCode({ ...config, code: 'code', codeVerifier: 'verifier' }))
      .rejects.toMatchObject({ code, message: expect.not.stringContaining('secret data') });
  });

  it('reads verified identity with a redirect-blocked POST and bearer authentication', async () => {
    fakeFetch.mockResolvedValueOnce(json({ email: 'User@Example.com', email_verified: true, sub: 'subject' }));
    await expect(oauth.fetchMailruIdentity(tokens.access_token)).resolves.toEqual({
      email: 'user@example.com', sub: 'subject', name: null,
    });
    expect(fakeFetch.mock.calls[1]).toEqual([discovery.userinfo_endpoint, expect.objectContaining({
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { Authorization: 'Bearer test-access' },
    })]);
  });

  it.each([{ email_verified: 'true' }, { email_verified: false }, { sub: '' }, { email: 'invalid' }])(
    'rejects incomplete or unverified identity (%o)', async (override) => {
      fakeFetch.mockResolvedValueOnce(json({ email: 'user@example.com', email_verified: true, sub: 'subject', ...override }));
      await expect(oauth.fetchMailruIdentity(tokens.access_token)).rejects.toMatchObject({ code: 'email_not_verified' });
    },
  );
});

describe('Mail.ru OAuth refresh', () => {
  const account = (overrides = {}) => ({
    id: 'account', oauth_provider: 'mailru', oauth_client_id: config.clientId,
    oauth_refresh_token: encrypt('old-refresh'), oauth_reconnect_required: false, ...overrides,
  });

  it('uses the issuing client and persists encrypted rotated credentials with a grant compare-and-set', async () => {
    getMailboxOAuthConfig.mockResolvedValue(config);
    fakeFetch.mockResolvedValueOnce(json(tokens));
    const original = account();
    const saved = { ...original, oauth_access_token: encrypt(tokens.access_token) };
    query.mockResolvedValueOnce({ rows: [saved] });

    await expect(oauth.refreshMailruToken(original)).resolves.toEqual(saved);
    expect(getMailboxOAuthConfig).toHaveBeenCalledExactlyOnceWith('mailru');
    expect(Object.fromEntries(fakeFetch.mock.calls[1][1].body)).toEqual({
      grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: config.clientId,
    });
    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain('oauth_provider = $7');
    expect(sql).toContain('oauth_client_id = $5');
    expect(sql).toContain('oauth_refresh_token IS NOT DISTINCT FROM $6');
    expect(sql).toContain('oauth_reconnect_required = false');
    expect(decrypt(args[0])).toBe(tokens.access_token);
    expect(decrypt(args[1])).toBe(tokens.refresh_token);
    expect(args.slice(2)).toEqual([expect.any(Date), original.id, config.clientId, original.oauth_refresh_token, 'mailru']);
  });

  it('keeps the stored refresh token when no replacement is returned and returns a concurrently reconnected row', async () => {
    getMailboxOAuthConfig.mockResolvedValue(config);
    fakeFetch.mockResolvedValueOnce(json({ ...tokens, refresh_token: undefined }));
    const updated = account();
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [updated] });

    await expect(oauth.refreshMailruToken(account())).resolves.toEqual(updated);
    expect(query.mock.calls[0][0]).toContain('COALESCE($2, oauth_refresh_token)');
    expect(query.mock.calls[0][1][1]).toBeNull();
  });

  it('rejects a different configured client before any network requests', async () => {
    getMailboxOAuthConfig.mockResolvedValue({ ...config, clientId: 'different' });
    await expect(oauth.refreshMailruToken(account())).rejects.toMatchObject({ oauthError: 'app_unavailable' });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('recognizes a revoked grant returned with HTTP 200', async () => {
    getMailboxOAuthConfig.mockResolvedValue(config);
    fakeFetch.mockResolvedValueOnce(json({ error: 'invalid_grant', error_description: 'secret data' }));
    await expect(oauth.refreshMailruToken(account())).rejects.toMatchObject({
      oauthError: 'invalid_grant', message: expect.not.stringContaining('secret data'),
    });
  });
});
