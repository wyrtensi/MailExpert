import { isOAuthAccount } from './constants.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const OAUTH_MAINTENANCE_INTERVAL_MS = MINUTE;
const SHORT_TOKEN_LEAD_MS = 10 * MINUTE;
const YANDEX_CHECK_INTERVAL_MS = 90 * DAY;
const YANDEX_EXPIRY_WINDOW_MS = 7 * DAY;

function timestamp(value) {
  return value == null ? NaN : new Date(value).getTime();
}

export function needsBackgroundRefresh(account, now = Date.now()) {
  if (!isOAuthAccount(account) || !account.enabled || account.oauth_reconnect_required) return false;
  const expiry = timestamp(account.oauth_token_expiry);
  if (!account.oauth_access_token || !Number.isFinite(expiry) || expiry <= now) return true;

  const remaining = expiry - now;
  const renewedAt = timestamp(account.oauth_token_refreshed_at);
  if (account.oauth_provider === 'yandex') {
    // Yandex can return the same token and its remaining lifetime. Remember that we checked it,
    // and increase the frequency only as expiration approaches.
    if (!Number.isFinite(renewedAt)) return true;
    if (remaining <= SHORT_TOKEN_LEAD_MS) return now - renewedAt >= OAUTH_MAINTENANCE_INTERVAL_MS;
    if (remaining <= YANDEX_EXPIRY_WINDOW_MS) return now - renewedAt >= 60 * MINUTE;
    return now - renewedAt >= YANDEX_CHECK_INTERVAL_MS;
  }

  // For a short grant, renew in its final quarter instead of refreshing every poll if its
  // entire lifetime happens to be shorter than the normal safety window.
  const lifetime = expiry - renewedAt;
  const lead = lifetime > 0 ? Math.min(SHORT_TOKEN_LEAD_MS, lifetime / 4) : SHORT_TOKEN_LEAD_MS;
  return remaining <= lead;
}
