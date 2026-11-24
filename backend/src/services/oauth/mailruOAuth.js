import { PROVIDER_FETCH_TIMEOUT_MS } from './constants.js';
import { refreshMailboxToken } from './mailboxRefresh.js';

const ISSUER = 'https://account.mail.ru';
const DISCOVERY_URL = ISSUER + '/.well-known/openid-configuration';
const ENDPOINT_ORIGINS = new Set(['https://o2.mail.ru', 'https://oauth.mail.ru']);
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const SCOPES = 'openid email mail.imap offline_access';
const ADDRESS_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const TOKEN_RE = /^[\x21-\x7e]+$/;

const error = (code, oauthError) => Object.assign(new Error(code), { code, oauthError });

async function requestJson(url, init, failureCode) {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw error(failureCode);
    return { ok: response.ok, payload };
  } catch {
    // Fetch and parser errors can contain URLs or provider responses.
    throw error(failureCode);
  }
}

function trustedEndpoint(value) {
  try {
    const url = new URL(value);
    if (ENDPOINT_ORIGINS.has(url.origin) && !url.username && !url.password && !url.hash) return url.href;
  } catch {
    // Invalid URLs and unexpected origins are treated as invalid discovery metadata.
  }
  throw error('mailru_discovery_failed');
}

let cachedDiscovery;
let pendingDiscovery;

async function loadDiscovery() {
  const { ok, payload } = await requestJson(DISCOVERY_URL, {}, 'mailru_discovery_failed');
  if (!ok || payload.issuer !== ISSUER) throw error('mailru_discovery_failed');
  const endpoints = {
    authorization: trustedEndpoint(payload.authorization_endpoint),
    token: trustedEndpoint(payload.token_endpoint),
    userinfo: trustedEndpoint(payload.userinfo_endpoint),
  };
  cachedDiscovery = { endpoints, expiresAt: Date.now() + DISCOVERY_TTL_MS };
  return endpoints;
}

function discover() {
  if (cachedDiscovery?.expiresAt > Date.now()) return Promise.resolve(cachedDiscovery.endpoints);
  pendingDiscovery ??= loadDiscovery().finally(() => { pendingDiscovery = undefined; });
  return pendingDiscovery;
}

export async function buildMailruAuthorizationUrl({ clientId, state, codeChallenge, redirectUri, loginHint }) {
  const { authorization } = await discover();
  const url = new URL(authorization);
  const params = {
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: SCOPES,
    prompt: 'consent',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.href;
}

const formEncode = (value) => new URLSearchParams({ v: value }).toString().slice(2);

async function requestToken({ clientId, clientSecret }, params) {
  const { token } = await discover();
  const credentials = Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`).toString('base64');
  const { ok, payload } = await requestJson(token, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}` },
    body: new URLSearchParams(params),
  }, 'mailru_token_failed');

  if (!ok || 'error' in payload) {
    throw error('mailru_token_failed', payload.error === 'invalid_grant' ? 'invalid_grant' : undefined);
  }
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, token_type: tokenType } = payload;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  if (typeof accessToken !== 'string' || !TOKEN_RE.test(accessToken)
    || (refreshToken != null && (typeof refreshToken !== 'string' || !TOKEN_RE.test(refreshToken)))
    || !Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isFinite(expiresAt.getTime())
    || (tokenType != null && !/^bearer$/i.test(tokenType))) {
    throw error('mailru_token_failed');
  }
  // OAuth returns scope only when it differs from the requested grant. The refresh
  // request omits scope so Mail.ru uses the scope associated with the refresh token.
  const scope = 'scope' in payload ? payload.scope : SCOPES;
  if (typeof scope !== 'string' || !scope.split(/\s+/).includes('mail.imap')) {
    throw error('scope_missing', 'scope_missing');
  }
  return { accessToken, refreshToken: refreshToken ?? null, expiresAt, scope };
}

export async function exchangeMailruCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  const tokens = await requestToken({ clientId, clientSecret }, {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });
  if (!tokens.refreshToken) throw error('missing_refresh_token');
  return tokens;
}

export async function fetchMailruIdentity(accessToken) {
  const { userinfo } = await discover();
  const { ok, payload } = await requestJson(userinfo, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 'mailru_userinfo_failed');
  if (!ok || 'error' in payload) throw error('mailru_userinfo_failed');

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (payload.email_verified !== true || !ADDRESS_RE.test(email) || email.length > 320
    || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 255) {
    throw error('email_not_verified');
  }
  return { email, sub: payload.sub, name: typeof payload.name === 'string' ? payload.name : null };
}

export function refreshMailruToken(account) {
  return refreshMailboxToken(account, 'mailru', (config, refreshToken) => requestToken(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  }));
}
