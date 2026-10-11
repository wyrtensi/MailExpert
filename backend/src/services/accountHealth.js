// Account connection health for the sidebar indicator. Returns a stable code, never
// localized text, provider messages or the sync_error string itself.
//
// The frontend mirrors this rule in frontend/src/utils/accountHealth.js to recompute a
// provisional code after WebSocket account events; accountHealth.fixtures.json is read
// by both test suites and keeps the two implementations in parity.

// An enabled account with no recorded error whose last successful sync is older than
// this (or that never synced) is reported as stale.
export const STALE_AFTER_MS = 15 * 60 * 1000;

export const ACCOUNT_HEALTH_CODES = Object.freeze([
  'healthy', 'stale', 'failed', 'oauth_reconnect_required', 'proton_reconnect_required', 'proton_unavailable', 'disabled',
]);

// Safe status codes of a managed Proton mailbox's link (backend services/proton/reconcile.js),
// sent as proton_status. The reconnect code may also arrive as sync_error over WebSocket.
const PROTON_STATUS_CODES = new Set(['proton_reconnect_required', 'proton_unavailable']);

// Priority: disabled → oauth_reconnect_required → proton_reconnect_required →
// proton_unavailable → failed → stale → healthy.
// sync_error === 'oauth_reconnect_required' counts as reconnect-required too: the IMAP
// manager pushes that stable code over WebSocket before the flag column is re-read.
export function computeAccountHealth(account, now = Date.now()) {
  const a = account ?? {};
  if (a.enabled === false) return 'disabled';
  if (a.oauth_reconnect_required === true || a.sync_error === 'oauth_reconnect_required') return 'oauth_reconnect_required';
  if (a.proton_status === 'proton_reconnect_required' || a.sync_error === 'proton_reconnect_required') return 'proton_reconnect_required';
  if (PROTON_STATUS_CODES.has(a.proton_status)) return a.proton_status;
  if (a.sync_error) return 'failed';
  const lastSync = a.last_sync == null ? NaN : new Date(a.last_sync).getTime();
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(lastSync) || nowMs - lastSync > STALE_AFTER_MS) return 'stale';
  return 'healthy';
}
