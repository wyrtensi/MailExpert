import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import {
  DEFAULT_FOLDER_SYNC_INTERVAL_SEC, DEFAULT_SYNC_INTERVAL_SEC, FOLDER_SYNC_INTERVAL_KEY, SYNC_INTERVAL_KEY,
  loadSyncSettings, parseFolderSyncIntervalSec, parseSyncIntervalSec,
} from './syncSettings.js';

describe('parseSyncIntervalSec', () => {
  it('accepts only the offered message intervals', () => {
    expect(parseSyncIntervalSec(30)).toBe(30);
    expect(parseSyncIntervalSec('120')).toBe(120);
    for (const bad of [10, 45, 60.5, '60s', ' 60', '', null, undefined, true]) {
      expect(parseSyncIntervalSec(bad)).toBeNull();
    }
  });
});

describe('parseFolderSyncIntervalSec', () => {
  it('accepts only the offered folder intervals, never included', () => {
    expect(parseFolderSyncIntervalSec(0)).toBe(0);
    expect(parseFolderSyncIntervalSec('3600')).toBe(3600);
    for (const bad of ['', null, undefined, false, 60, '0x10']) {
      expect(parseFolderSyncIntervalSec(bad)).toBeNull();
    }
  });
});

describe('loadSyncSettings', () => {
  it('reads both settings from system_settings', async () => {
    const queryFn = vi.fn(async () => ({
      rows: [{ key: SYNC_INTERVAL_KEY, value: '30' }, { key: FOLDER_SYNC_INTERVAL_KEY, value: '0' }],
    }));
    expect(await loadSyncSettings(queryFn)).toEqual({ syncIntervalSec: 30, folderSyncIntervalSec: 0 });
    expect(queryFn.mock.calls[0][1]).toEqual([[SYNC_INTERVAL_KEY, FOLDER_SYNC_INTERVAL_KEY]]);
  });

  it('falls back to the defaults for missing or broken values', async () => {
    const queryFn = vi.fn(async () => ({ rows: [{ key: SYNC_INTERVAL_KEY, value: 'fast' }] }));
    expect(await loadSyncSettings(queryFn)).toEqual({
      syncIntervalSec: DEFAULT_SYNC_INTERVAL_SEC,
      folderSyncIntervalSec: DEFAULT_FOLDER_SYNC_INTERVAL_SEC,
    });
  });
});
