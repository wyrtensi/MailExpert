// Helpers for the mailbox sync the server runs. Choices and defaults mirror
// backend/src/services/syncSettings.js.

export const SYNC_INTERVAL_CHOICES_SEC = Object.freeze([15, 30, 60, 120]);
export const FOLDER_SYNC_INTERVAL_CHOICES_SEC = Object.freeze([0, 900, 1800, 3600]);
export const DEFAULT_SYNC_INTERVAL_SEC = 60;
export const DEFAULT_FOLDER_SYNC_INTERVAL_SEC = 1800;

// Mailboxes a manual "sync now" asks for: the open mailbox, or every enabled IMAP mailbox from the
// unified inbox. The server syncs one mailbox per request.
export function manualSyncAccountIds(accounts, selectedAccountId = null) {
  const syncable = (accounts || []).filter((account) => account?.enabled && account.protocol === 'imap');
  if (!selectedAccountId) return syncable.map((account) => account.id);
  return syncable.some((account) => account.id === selectedAccountId) ? [selectedAccountId] : [];
}

// True when no request started a sync, so no sync_complete event will follow.
export function noSyncStarted(results) {
  return (results || []).every((result) => result?.skipped === true);
}

function readChoice(raw, choices, fallback) {
  const seconds = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  return choices.includes(seconds) ? seconds : fallback;
}

// Sync intervals from GET /api/admin/settings, where values are text, with the defaults for
// anything missing or unexpected.
export function readSyncIntervals(settings) {
  return {
    syncIntervalSec: readChoice(settings?.sync_interval_sec, SYNC_INTERVAL_CHOICES_SEC, DEFAULT_SYNC_INTERVAL_SEC),
    folderSyncIntervalSec: readChoice(
      settings?.folder_sync_interval_sec, FOLDER_SYNC_INTERVAL_CHOICES_SEC, DEFAULT_FOLDER_SYNC_INTERVAL_SEC,
    ),
  };
}
