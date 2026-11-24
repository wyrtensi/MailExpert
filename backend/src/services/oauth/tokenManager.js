import { query } from '../db.js';
import { refreshMicrosoftToken } from './microsoftOAuth.js';
import { refreshGoogleToken } from './googleOAuth.js';
import { refreshMailruToken } from './mailruOAuth.js';
import { refreshYandexToken } from './yandexOAuth.js';
import { acquireOAuthLease, releaseOAuthLease } from './oauthLease.js';
import { OAUTH_RECONNECT_REQUIRED_MESSAGE, isOAuthAccount } from './constants.js';
import { needsBackgroundRefresh } from './refreshSchedule.js';

// Refresh tokens that expire within this window so a connection never starts with a
// token about to lapse mid-session.
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

// Default wait for callers without a tighter deadline (SMTP send, routes). Callers that race
// the refresh against a timeout (imapManager) pass a shorter `lockWaitMs` so the wait plus the
// provider's token calls still fit inside their budget.
const DEFAULT_LOCK_WAIT_MS = 10000;
const DEFAULT_LOCK_POLL_MS = 200;

// Provider error codes that no retry can fix: only a new user consent helps. app_unavailable
// means the app that issued the tokens was disabled, removed or replaced.
const RECONNECT_OAUTH_ERRORS = new Set(['invalid_grant', 'missing_refresh_token', 'app_unavailable', 'scope_missing']);
const CLIENT_BOUND_PROVIDERS = new Set(['mailru', 'yandex']);

// Stable, secret-free error. `code` is one of: oauth_reconnect_required,
// oauth_refresh_failed, oauth_unsupported_provider, oauth_account_not_found.
export class OAuthTokenError extends Error {
  constructor(code) {
    super(code === 'oauth_reconnect_required'
      ? OAUTH_RECONNECT_REQUIRED_MESSAGE
      : `OAuth token refresh failed: ${code}`);
    this.name = 'OAuthTokenError';
    this.code = code;
  }
}

export function needsTokenRefresh(account, now = Date.now()) {
  if (!account.oauth_access_token || !account.oauth_token_expiry) return true;
  const expiryMs = new Date(account.oauth_token_expiry).getTime();
  if (!Number.isFinite(expiryMs)) return true;
  return expiryMs - now < TOKEN_REFRESH_SKEW_MS;
}

// Compare-and-set on the refresh token the provider rejected: a reconsent may commit new
// tokens while the refresh is in flight, and those must not be flagged. Returns false when
// the stored refresh token changed meanwhile.
//
// Exported so a caller outside a refresh — mailSendTransport.js, when the Gmail API rejects a
// token that was JUST refreshed successfully (the grant is bad even though the refresh call
// itself worked) — can flag the same way a refresh failure does, instead of only telling the
// user to reconnect without ever recording it.
export async function markReconnectRequired(accountId, rejectedRefreshToken, grant) {
  const params = [accountId, rejectedRefreshToken ?? null];
  if (grant) params.push(grant.oauth_client_id ?? null, grant.oauth_provider);
  const result = await query(
    `UPDATE email_accounts SET oauth_reconnect_required = true, sync_error = 'oauth_reconnect_required'
     WHERE id = $1 AND oauth_refresh_token IS NOT DISTINCT FROM $2
     ${grant ? 'AND oauth_provider = $4 AND oauth_client_id IS NOT DISTINCT FROM $3' : ''}`,
    params,
  );
  return result?.rowCount !== 0;
}

// Refresh through the provider module, then normalize failures. Provider modules persist
// the new tokens themselves in a single UPDATE that keeps the stored refresh token when
// none is returned, and only while the grant they refreshed is still the stored one (otherwise
// they return the stored row a reconnect wrote meanwhile). The original error is intentionally
// not attached as `cause`: its message may contain the provider response.
export async function refreshOAuthToken(account) {
  let refresh;
  if (account.oauth_provider === 'microsoft') refresh = refreshMicrosoftToken;
  else if (account.oauth_provider === 'google') refresh = refreshGoogleToken;
  else if (account.oauth_provider === 'mailru') refresh = refreshMailruToken;
  else if (account.oauth_provider === 'yandex') refresh = refreshYandexToken;
  else throw new OAuthTokenError('oauth_unsupported_provider');

  try {
    return await refresh(account);
  } catch (err) {
    if (RECONNECT_OAUTH_ERRORS.has(err?.oauthError)) {
      const grant = CLIENT_BOUND_PROVIDERS.has(account.oauth_provider) ? account : undefined;
      if (!(await markReconnectRequired(account.id, account.oauth_refresh_token, grant))) {
        // The grant was replaced during the provider call; the caller retries with the new row.
        console.error(`OAuth refresh for account ${account.id} (${account.oauth_provider}) raced a token update`);
        throw new OAuthTokenError('oauth_refresh_failed');
      }
      console.error(`OAuth refresh for account ${account.id} (${account.oauth_provider}) needs reconnect`);
      throw new OAuthTokenError('oauth_reconnect_required');
    }
    const reason = typeof err?.code === 'string' ? err.code : 'unknown';
    console.error(`OAuth refresh for account ${account.id} (${account.oauth_provider}) failed: ${reason}`);
    throw new OAuthTokenError('oauth_refresh_failed');
  }
}

const expiryTime = (account) => {
  const ms = account?.oauth_token_expiry ? new Date(account.oauth_token_expiry).getTime() : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
};

async function refreshUnderLock(account, options) {
  const accountId = account.id;
  const key = `oauth:refresh-lock:${accountId}`;
  const token = await acquireOAuthLease(key, options);
  if (!token) {
    // A scheduled pass can defer to the current owner. Foreground callers still get their
    // normal lock budget, including callers that joined this pass in this process.
    if (options.background) return null;
    throw new OAuthTokenError('oauth_refresh_failed');
  }
  try {
    // Re-read after acquiring the lock: another process may have refreshed already,
    // and refreshing with a superseded refresh token could strand the account.
    const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    const row = rows[0];
    if (!row) throw new OAuthTokenError('oauth_account_not_found');
    if (row.oauth_reconnect_required) throw new OAuthTokenError('oauth_reconnect_required');
    // A forced refresh means the provider rejected the caller's token: reuse the row only when
    // it already holds a newer token than the rejected one (a peer refreshed in the meantime).
    if (options.background) {
      if (!needsBackgroundRefresh(row)) return row;
    } else if (!needsTokenRefresh(row) && (!options.force || expiryTime(row) > expiryTime(account))) {
      return row;
    }
    const refreshed = await refreshOAuthToken(row);
    if (refreshed.oauth_reconnect_required) throw new OAuthTokenError('oauth_reconnect_required');
    return refreshed;
  } finally {
    await releaseOAuthLease(key, token);
  }
}

const inFlightRefresh = new Map();

// Return an account whose OAuth access token is valid for at least the skew window.
// Non-OAuth and still-fresh accounts are returned unchanged. The returned access token
// may be plaintext (just refreshed) or encrypted (re-read row); decrypt() handles both.
// `force: true` bypasses the skew window after the provider rejected the caller's token.
// `background: true` applies the proactive schedule to an enabled mailbox.
export function ensureFreshOAuthAccount(account, options = {}) {
  if (!isOAuthAccount(account)) return Promise.resolve(account);
  const force = !!options.force;
  const background = !force && !!options.background;
  const needsRefresh = background ? needsBackgroundRefresh : needsTokenRefresh;
  if (!force && !needsRefresh(account)) return Promise.resolve(account);

  const existing = inFlightRefresh.get(account.id);
  if (existing) {
    if (existing.force || (!force && background === existing.background)) return existing.promise;
    if (!force) return existing.promise.then((row) => ensureFreshOAuthAccount(row ?? account, options));
    // A non-forced refresh may resolve to the stored row without calling the provider, and that
    // row can hold the very token this caller just had rejected. Take its result only when it is
    // newer than the rejected token; otherwise run a forced refresh once it has settled.
    return existing.promise.then((row) => (
      expiryTime(row) > expiryTime(account) ? row : ensureFreshOAuthAccount(account, options)
    ));
  }

  const promise = refreshUnderLock(account, {
    force,
    background,
    lockWaitMs: options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    lockPollMs: options.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
  }).finally(() => inFlightRefresh.delete(account.id));
  inFlightRefresh.set(account.id, { promise, force, background });
  return promise;
}
