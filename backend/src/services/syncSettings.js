import { query } from './db.js';

// How often mailboxes sync is one install-wide setting: the server services every mailbox, not
// whoever happens to be signed in. Values are seconds, stored as text in system_settings.
export const SYNC_INTERVAL_KEY = 'sync_interval_sec';
export const FOLDER_SYNC_INTERVAL_KEY = 'folder_sync_interval_sec';

export const SYNC_INTERVAL_CHOICES_SEC = Object.freeze([15, 30, 60, 120]);
// 0 turns the periodic folder-structure sync off.
export const FOLDER_SYNC_INTERVAL_CHOICES_SEC = Object.freeze([0, 900, 1800, 3600]);

export const DEFAULT_SYNC_INTERVAL_SEC = 60;
export const DEFAULT_FOLDER_SYNC_INTERVAL_SEC = 1800;

// A number, or a string of digits, that is one of the offered choices; null otherwise.
function pickChoice(value, choices) {
  let seconds = Number.NaN;
  if (typeof value === 'number') seconds = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) seconds = Number(value);
  return choices.includes(seconds) ? seconds : null;
}

export const parseSyncIntervalSec = (value) => pickChoice(value, SYNC_INTERVAL_CHOICES_SEC);
export const parseFolderSyncIntervalSec = (value) => pickChoice(value, FOLDER_SYNC_INTERVAL_CHOICES_SEC);

export async function loadSyncSettings(queryFn = query) {
  const { rows } = await queryFn(
    'SELECT key, value FROM system_settings WHERE key = ANY($1::text[])',
    [[SYNC_INTERVAL_KEY, FOLDER_SYNC_INTERVAL_KEY]],
  );
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    syncIntervalSec: parseSyncIntervalSec(stored[SYNC_INTERVAL_KEY]) ?? DEFAULT_SYNC_INTERVAL_SEC,
    folderSyncIntervalSec: parseFolderSyncIntervalSec(stored[FOLDER_SYNC_INTERVAL_KEY]) ?? DEFAULT_FOLDER_SYNC_INTERVAL_SEC,
  };
}
