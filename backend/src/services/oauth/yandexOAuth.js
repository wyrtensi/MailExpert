import { PROVIDER_FETCH_TIMEOUT_MS } from './constants.js';
import { refreshMailboxToken } from './mailboxRefresh.js';
import { hasHeaderInjectionChars } from '../accountAliases.js';

const AUTHORIZATION_ENDPOINT = 'https://oauth.yandex.ru/authorize';
const DEVICE_ENDPOINT = 'https://oauth.yandex.ru/device/code';
const TOKEN_ENDPOINT = 'https://oauth.yandex.ru/token';
const USERINFO_ENDPOINT = 'https://login.yandex.ru/info';
const VERIFICATION_URLS = new Set(['https://ya.ru/device', 'https://oauth.yandex.ru/device']);
const SCOPES = ['mail:imap_full', 'mail:smtp'];
const PROFILE_SCOPE = 'login:info';
const SCOPE_LOOKUP_TIMEOUT_MS = 2500;
const POLLING_ERRORS = new Map([
  ['authorization_pending', 'authorization_pending'],
  ['slow_down', 'slow_down'],
  ['access_denied', 'access_denied'],
  ['expired_token', 'expired_token'],
  ['invalid_grant', 'expired_token'],
]);

const error = (code, oauthError) => Object.assign(new Error(code), { code, oauthError });
const isOpaqueToken = (value) => typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isClientError = (value) => value === 'invalid_client' || value === 'unauthorized_client';

async function requestJson(url, init, failureCode, timeoutMs = PROVIDER_FETCH_TIMEOUT_MS) {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json();
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) return { ok: response.ok, payload };
  } catch {
    // Provider responses and transport errors can contain credentials.
  }
  throw error(failureCode);
}

async function authorizationParams(clientId) {
  const params = new URLSearchParams({ client_id: clientId, scope: SCOPES.join(' ') });
  const failureCode = 'yandex_scope_lookup_failed';
  try {
    const endpoint = `https://oauth.yandex.ru/client/${encodeURIComponent(clientId)}/info`;
    const { ok, payload } = await requestJson(endpoint, {}, failureCode, SCOPE_LOOKUP_TIMEOUT_MS);
    if (!ok || payload.id !== clientId || !Array.isArray(payload.scope)) throw error(failureCode);
    if (payload.scope.includes(PROFILE_SCOPE)) params.set('optional_scope', PROFILE_SCOPE);
  } catch {
    // Profile access is optional. A metadata outage must not interrupt an otherwise valid grant.
    console.warn('Yandex OAuth app scope lookup failed; requesting mailbox access only');
  }
  return params;
}

export async function buildYandexAuthorizationUrl({ clientId, redirectUri, loginHint, state, codeChallenge }) {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  const params = await authorizationParams(clientId);
  if (params.has('optional_scope')) params.set('force_confirm', 'yes');
  for (const [key, value] of Object.entries({
    response_type: 'code',
    redirect_uri: redirectUri,
    login_hint: loginHint,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })) params.set(key, value);
  url.search = params.toString();
  return url.href;
}

export async function requestYandexDeviceCode({ clientId }) {
  const failureCode = 'yandex_device_code_failed';
  const { ok, payload } = await requestJson(DEVICE_ENDPOINT, {
    method: 'POST',
    body: await authorizationParams(clientId),
  }, failureCode);
  if (!ok || 'error' in payload) throw error(isClientError(payload.error) ? 'app_unavailable' : failureCode);

  const {
    device_code: deviceCode, user_code: userCode, verification_url: verificationUri,
    expires_in: expiresIn, interval = 5,
  } = payload;
  if (!isOpaqueToken(deviceCode) || typeof userCode !== 'string' || !/^[A-Za-z0-9]{8}$/.test(userCode)
    || !VERIFICATION_URLS.has(verificationUri) || !isPositiveInteger(expiresIn) || !isPositiveInteger(interval)) {
    throw error(failureCode);
  }
  return { deviceCode, userCode, verificationUri, expiresIn, interval };
}

async function requestToken({ clientId, clientSecret }, params) {
  const failureCode = 'yandex_token_failed';
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const { ok, payload } = await requestJson(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}` },
    body: new URLSearchParams(params),
  }, failureCode);
  if (!ok || 'error' in payload) {
    if (isClientError(payload.error)) throw error('app_unavailable', 'app_unavailable');
    if (params.grant_type === 'device_code' && POLLING_ERRORS.has(payload.error)) {
      throw error(POLLING_ERRORS.get(payload.error));
    }
    throw error(failureCode, payload.error === 'invalid_grant' ? 'invalid_grant' : undefined);
  }

  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, token_type: tokenType } = payload;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  if (!isOpaqueToken(accessToken) || (refreshToken != null && !isOpaqueToken(refreshToken))
    || !isPositiveInteger(expiresIn) || !Number.isFinite(expiresAt.getTime())
    || typeof tokenType !== 'string' || !/^bearer$/i.test(tokenType)) {
    throw error(failureCode);
  }
  // Yandex only includes scope when it grants fewer permissions than requested.
  const scope = 'scope' in payload ? payload.scope : SCOPES.join(' ');
  if (typeof scope !== 'string' || !SCOPES.every((required) => scope.split(/\s+/).includes(required))) {
    throw error('scope_missing', 'scope_missing');
  }
  return { accessToken, refreshToken: refreshToken ?? null, expiresAt, scope };
}

async function exchangeYandexGrant(config, params) {
  const tokens = await requestToken(config, params);
  if (!tokens.refreshToken) throw error('missing_refresh_token');
  return tokens;
}

export function exchangeYandexDeviceCode({ clientId, clientSecret, deviceCode }) {
  return exchangeYandexGrant({ clientId, clientSecret }, { grant_type: 'device_code', code: deviceCode });
}

export function exchangeYandexCode({ clientId, clientSecret, code, codeVerifier }) {
  return exchangeYandexGrant({ clientId, clientSecret }, { grant_type: 'authorization_code', code, code_verifier: codeVerifier });
}

export async function fetchYandexIdentity(accessToken, { clientId }) {
  const failureCode = 'yandex_userinfo_failed';
  const { ok, payload } = await requestJson(USERINFO_ENDPOINT, {
    method: 'GET',
    headers: { Authorization: `OAuth ${accessToken}` },
  }, failureCode);
  if (!ok || 'error' in payload || payload.client_id !== clientId || !isOpaqueToken(payload.id) || payload.id.length > 255) {
    throw error(failureCode);
  }
  const login = typeof payload.login === 'string' ? payload.login.trim().toLowerCase() : null;
  // Yandex uses the login as a fallback display name even when the full name is available.
  const displayName = typeof payload.display_name === 'string' && payload.display_name.trim().toLowerCase() !== login
    ? payload.display_name
    : null;
  const name = [displayName, payload.real_name]
    .find(value => typeof value === 'string' && value.trim() && !hasHeaderInjectionChars(value))?.trim();
  return { sub: payload.id, ...(name ? { name } : {}) };
}

export function refreshYandexToken(account) {
  return refreshMailboxToken(account, 'yandex', (config, refreshToken) => requestToken(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }));
}
