import { query } from '../db.js';
import { OAUTH_PROVIDERS, OAUTH_REFRESH_MAX_TOKEN_CALLS, PROVIDER_FETCH_TIMEOUT_MS } from './constants.js';
import { needsBackgroundRefresh, OAUTH_MAINTENANCE_INTERVAL_MS } from './refreshSchedule.js';
import { ensureFreshOAuthAccount } from './tokenManager.js';

const CONCURRENCY = 4;
const MAX_RETRY_DELAY_MS = 15 * OAUTH_MAINTENANCE_INTERVAL_MS;
const PERMANENT_ERRORS = new Set(['oauth_reconnect_required', 'oauth_account_not_found']);

let timer = null;
let activePass = null;
const retries = new Map();

// Exponential backoff must not sleep past a token's last refresh window (especially Yandex, where
// both access and refresh tokens expire together). Leaving one tick interval plus the provider
// call budget before expiry guarantees an attempt starts with time left to finish.
function nextRetryAt(account, retry, now) {
  if (!retry) return 0;
  const scheduled = retry.startedAt + retry.delay;
  const expiry = account.oauth_token_expiry == null ? NaN : new Date(account.oauth_token_expiry).getTime();
  if (!Number.isFinite(expiry) || expiry <= now) return scheduled;
  const callBudgetMs = (OAUTH_REFRESH_MAX_TOKEN_CALLS[account.oauth_provider] ?? 1) * PROVIDER_FETCH_TIMEOUT_MS;
  return Math.min(scheduled, expiry - OAUTH_MAINTENANCE_INTERVAL_MS - callBudgetMs);
}

async function renew(account, startedAt) {
  try {
    // The foreground refresh may already be running. Leave it alone and try again on a tick.
    await ensureFreshOAuthAccount(account, { background: true, lockWaitMs: 0 });
    retries.delete(account.id);
  } catch (err) {
    if (PERMANENT_ERRORS.has(err?.code)) {
      retries.delete(account.id);
      return;
    }
    const previous = retries.get(account.id);
    const delay = previous ? Math.min(MAX_RETRY_DELAY_MS, previous.delay * 2) : OAUTH_MAINTENANCE_INTERVAL_MS;
    retries.set(account.id, { delay, startedAt });
    // The token manager records the normalized provider error. Database/lease failures can also
    // reach here, and their raw messages are never needed for this log.
    if (!previous) {
      console.warn(`Background OAuth renewal deferred for account ${account.id} (${account.oauth_provider})`);
    }
  }
}

async function refreshDueAccounts() {
  const startedAt = Date.now();
  const { rows } = await query(`
    SELECT id, enabled, oauth_provider, oauth_access_token, oauth_token_expiry, oauth_token_refreshed_at
    FROM email_accounts
    WHERE enabled AND NOT oauth_reconnect_required AND oauth_provider = ANY($1::text[])
    ORDER BY oauth_token_expiry NULLS FIRST, id
  `, [[...OAUTH_PROVIDERS]]);
  const now = Date.now();
  const due = rows.filter((account) => needsBackgroundRefresh(account, now));
  const dueIds = new Set(due.map(({ id }) => id));
  for (const id of retries.keys()) {
    if (!dueIds.has(id)) retries.delete(id);
  }
  const ready = due.filter((account) => nextRetryAt(account, retries.get(account.id), now) <= now);
  for (let index = 0; timer && index < ready.length; index += CONCURRENCY) {
    await Promise.all(ready.slice(index, index + CONCURRENCY).map((account) => renew(account, startedAt)));
  }
}

export function startOAuthMaintenance() {
  if (timer) return;
  const run = () => {
    if (activePass) return;
    activePass = refreshDueAccounts()
      .catch(() => console.warn('Background OAuth renewal could not scan mailboxes'))
      .finally(() => { activePass = null; });
  };
  timer = setInterval(run, OAUTH_MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
  run();
}

export async function stopOAuthMaintenance() {
  clearInterval(timer);
  timer = null;
  await activePass;
  retries.clear();
}
