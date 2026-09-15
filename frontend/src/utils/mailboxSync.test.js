import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { manualSyncAccountIds, noSyncStarted, readSyncIntervals } from './mailboxSync.js';

const accounts = [
  { id: 'a', enabled: true, protocol: 'imap' },
  { id: 'b', enabled: false, protocol: 'imap' },
  { id: 'c', enabled: true, protocol: 'pop3' },
  { id: 'd', enabled: true, protocol: 'imap' },
];

describe('manualSyncAccountIds', () => {
  it('syncs the open mailbox', () => {
    assert.deepEqual(manualSyncAccountIds(accounts, 'd'), ['d']);
  });

  it('syncs every enabled IMAP mailbox from the unified inbox', () => {
    assert.deepEqual(manualSyncAccountIds(accounts, null), ['a', 'd']);
    assert.deepEqual(manualSyncAccountIds(undefined), []);
  });

  it('asks for nothing when the open mailbox cannot sync', () => {
    assert.deepEqual(manualSyncAccountIds(accounts, 'b'), []);
    assert.deepEqual(manualSyncAccountIds(accounts, 'missing'), []);
  });
});

describe('noSyncStarted', () => {
  it('is true only when every request was skipped', () => {
    assert.equal(noSyncStarted([]), true);
    assert.equal(noSyncStarted([{ ok: true, skipped: true }]), true);
    assert.equal(noSyncStarted([{ ok: true, skipped: true }, { ok: true }]), false);
  });
});

describe('readSyncIntervals', () => {
  it('reads the stored text values', () => {
    assert.deepEqual(
      readSyncIntervals({ sync_interval_sec: '30', folder_sync_interval_sec: '0' }),
      { syncIntervalSec: 30, folderSyncIntervalSec: 0 },
    );
  });

  it('falls back to the defaults', () => {
    assert.deepEqual(readSyncIntervals({ sync_interval_sec: '45' }), { syncIntervalSec: 60, folderSyncIntervalSec: 1800 });
    assert.deepEqual(readSyncIntervals(undefined), { syncIntervalSec: 60, folderSyncIntervalSec: 1800 });
  });
});
