import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('./oauth/tokenManager.js', async (importOriginal) => ({
  OAuthTokenError: (await importOriginal()).OAuthTokenError,
  ensureFreshOAuthAccount: vi.fn(async (account) => account),
}));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'redacted') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import { query } from './db.js';
import {
  ImapManager, MANUAL_SYNC_MIN_GAP_MS, MIN_SYNC_INTERVAL_MS, manualSyncDue, parseConnectConcurrency,
} from './imapManager.js';
import { SYNC_INTERVAL_CHOICES_SEC } from './syncSettings.js';

// Mailboxes are serviced by the server: they connect at startup and stay connected no matter
// who signs in or out.

const TIMERS = ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer'];
function newManager() {
  const mgr = new ImapManager(null);
  for (const key of TIMERS) clearInterval(mgr[key]);
  mgr.broadcast = vi.fn();
  return mgr;
}

const mailbox = (n, over = {}) => ({
  id: `mailbox-${n}`,
  user_id: 'u1',
  enabled: true,
  protocol: 'imap',
  email_address: `m${n}@example.com`,
  imap_host: 'imap.example.com',
  imap_port: 993,
  oauth_reconnect_required: false,
  ...over,
});

// Database rows by id. List queries honour the enabled/IMAP/reconsent filter the way Postgres would.
const rows = new Map();
const enabledImap = (row) => row.enabled && row.protocol === 'imap' && !row.oauth_reconnect_required;
function installDb() {
  query.mockImplementation(async (sql, params = []) => {
    if (/WHERE enabled = true AND protocol = 'imap' AND oauth_reconnect_required = false/.test(sql)) {
      return { rows: [...rows.values()].filter(enabledImap) };
    }
    if (/^\s*SELECT \* FROM email_accounts WHERE id = \$1/.test(sql)) {
      const row = rows.get(params[0]);
      const onlyEnabledImap = /enabled = true AND protocol = 'imap'/.test(sql);
      return { rows: row && (!onlyEnabledImap || (row.enabled && row.protocol === 'imap')) ? [row] : [] };
    }
    if (/WHERE id = ANY\(\$1::uuid\[\]\)/.test(sql)) {
      return { rows: params[0].map((id) => rows.get(id)).filter(Boolean) };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  installDb();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// connectAccount stand-in that keeps each connect open until the test releases it, marking the
// mailbox connecting and then connected the way the real method does.
function holdConnects(mgr) {
  const pending = [];
  let inFlight = 0;
  let maxInFlight = 0;
  vi.spyOn(mgr, 'connectAccount').mockImplementation((account) => {
    mgr.connectingAccounts.add(account.id);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => pending.push(() => {
      mgr.connectingAccounts.delete(account.id);
      mgr.connections.set(account.id, {});
      inFlight -= 1;
      resolve(true);
    }));
  });
  return { pending, maxInFlight: () => maxInFlight };
}

async function releaseAll(held) {
  while (held.pending.length) {
    held.pending.shift()();
    await vi.advanceTimersByTimeAsync(10_000);
  }
}

describe('connectAllEnabled', () => {
  it('connects every enabled mailbox, at most `concurrency` at a time', async () => {
    vi.useFakeTimers();
    for (let n = 1; n <= 5; n += 1) rows.set(`mailbox-${n}`, mailbox(n));
    rows.set('mailbox-6', mailbox(6, { enabled: false }));
    rows.set('mailbox-7', mailbox(7, { oauth_reconnect_required: true }));
    const mgr = newManager();
    const held = holdConnects(mgr);

    const done = mgr.connectAllEnabled({ concurrency: 2 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mgr.connectAccount).toHaveBeenCalledTimes(2);

    await releaseAll(held);
    await done;
    expect(mgr.connectAccount.mock.calls.map(([account]) => account.id))
      .toEqual(['mailbox-1', 'mailbox-2', 'mailbox-3', 'mailbox-4', 'mailbox-5']);
    expect(held.maxInFlight()).toBe(2);
    expect(mgr._startupQueued.size).toBe(0);
  });

  it('leaves mailboxes waiting in the queue to the queue when the health check runs', async () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    for (let n = 1; n <= 3; n += 1) rows.set(`mailbox-${n}`, mailbox(n));
    const mgr = newManager();
    const healthCheck = intervalSpy.mock.calls.find(([, ms]) => ms === 90000)[0];
    const held = holdConnects(mgr);

    const done = mgr.connectAllEnabled({ concurrency: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    await healthCheck();
    expect(mgr.connectAccount).toHaveBeenCalledTimes(1);

    await releaseAll(held);
    await done;
    expect(mgr.connectAccount).toHaveBeenCalledTimes(3);
  });

  it('re-reads a mailbox at its turn and skips one disabled while it waited', async () => {
    vi.useFakeTimers();
    rows.set('mailbox-1', mailbox(1));
    rows.set('mailbox-2', mailbox(2));
    const mgr = newManager();
    const held = holdConnects(mgr);

    const done = mgr.connectAllEnabled({ concurrency: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    rows.set('mailbox-2', mailbox(2, { enabled: false }));
    await releaseAll(held);
    await done;

    expect(mgr.connectAccount.mock.calls.map(([account]) => account.id)).toEqual(['mailbox-1']);
  });

  it('skips a mailbox that is already connected', async () => {
    vi.useFakeTimers();
    rows.set('mailbox-1', mailbox(1));
    rows.set('mailbox-2', mailbox(2));
    const mgr = newManager();
    mgr.connections.set('mailbox-1', {});
    vi.spyOn(mgr, 'connectAccount').mockResolvedValue(true);

    const done = mgr.connectAllEnabled();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(mgr.connectAccount.mock.calls.map(([account]) => account.id)).toEqual(['mailbox-2']);
  });

  it('reads IMAP_CONNECT_CONCURRENCY and falls back to 3', () => {
    expect(parseConnectConcurrency('5')).toBe(5);
    for (const raw of [undefined, '', '0', '-2', 'many']) expect(parseConnectConcurrency(raw)).toBe(3);
  });
});

describe('mailboxes do not follow sign-in', () => {
  it('has no per-user connect or disconnect', () => {
    expect(ImapManager.prototype.connectAllForUser).toBeUndefined();
    expect(ImapManager.prototype.disconnectUser).toBeUndefined();
  });

  it.each(['routes/auth.js', 'routes/oidc.js', 'routes/authGoogle.js', 'services/websocket.js', 'middleware/identityGate.js'])(
    '%s never connects or disconnects mailboxes',
    async (file) => {
      const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/connectAllForUser|disconnectUser|imapManager\.(connect|disconnect)/);
    },
  );
});

describe('install-wide sync intervals', () => {
  it('keeps the fastest tick in step with the sync setting choices', () => {
    expect(MIN_SYNC_INTERVAL_MS).toBe(Math.min(...SYNC_INTERVAL_CHOICES_SEC) * 1000);
  });

  it('starts with the defaults', () => {
    const mgr = newManager();
    expect(mgr.syncIntervalMs).toBe(60_000);
    expect(mgr.folderSyncIntervalMs).toBe(30 * 60_000);
  });

  it('has no per-user interval methods', () => {
    expect(ImapManager.prototype.updateSyncIntervalForUser).toBeUndefined();
    expect(ImapManager.prototype.updateFolderSyncIntervalForUser).toBeUndefined();
  });

  it('re-arms running timers with the new interval, poll-only mailboxes included', async () => {
    const mgr = newManager();
    rows.set('mailbox-1', mailbox(1));
    rows.set('mailbox-2', mailbox(2));
    mgr.syncIntervals.set('mailbox-1', setTimeout(() => {}, 60_000));
    mgr.syncIntervals.set('mailbox-2', setTimeout(() => {}, 60_000));
    mgr._pollOnlyAccounts.add('mailbox-2');
    const startSync = vi.spyOn(mgr, '_startSyncInterval').mockImplementation(() => {});
    const armPoll = vi.spyOn(mgr, '_armPollOnlyTimer').mockImplementation(() => {});

    await mgr.applySyncSettings({ syncIntervalSec: 30, folderSyncIntervalSec: 0 });

    expect(mgr.syncIntervalMs).toBe(30_000);
    expect(mgr.folderSyncIntervalMs).toBe(0);
    expect(startSync).toHaveBeenCalledWith(expect.objectContaining({ id: 'mailbox-1' }), 30_000);
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(armPoll).toHaveBeenCalledWith(expect.objectContaining({ id: 'mailbox-2' }));
    expect(mgr.syncIntervals.size).toBe(0);
  });

  it('leaves timers alone when only the folder interval changes', async () => {
    const mgr = newManager();
    mgr.syncIntervals.set('mailbox-1', setTimeout(() => {}, 60_000));
    const startSync = vi.spyOn(mgr, '_startSyncInterval');

    await mgr.applySyncSettings({ syncIntervalSec: 60, folderSyncIntervalSec: 900 });

    expect(mgr.folderSyncIntervalMs).toBe(900_000);
    expect(startSync).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    clearTimeout(mgr.syncIntervals.get('mailbox-1'));
  });
});

describe('manual sync of one mailbox', () => {
  const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

  it('waits MANUAL_SYNC_MIN_GAP_MS after the last sync', () => {
    expect(MANUAL_SYNC_MIN_GAP_MS).toBe(15_000);
    expect(manualSyncDue(undefined, 1_000_000)).toBe(true);
    expect(manualSyncDue(1_000_000 - 14_999, 1_000_000)).toBe(false);
    expect(manualSyncDue(1_000_000 - 15_000, 1_000_000)).toBe(true);
  });

  it('starts one sync and turns away a repeat while it runs', async () => {
    const mgr = newManager();
    let finish;
    const syncNow = vi.spyOn(mgr, 'syncNow').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    expect(mgr.requestSync('mailbox-1')).toEqual({ started: true });
    expect(mgr.requestSync('mailbox-1')).toEqual({ started: false });
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledWith('mailbox-1');

    finish();
    await flushPromises();
    expect(mgr.requestSync('mailbox-1')).toEqual({ started: true });
  });

  it('turns away a mailbox that is syncing, connecting or synced less than 15 seconds ago', () => {
    const mgr = newManager();
    const syncNow = vi.spyOn(mgr, 'syncNow').mockResolvedValue();
    const now = 5_000_000;
    mgr.syncingAccounts.add('a');
    mgr.connectingAccounts.add('b');
    mgr.lastSyncOkAt.set('c', now - 10_000);
    mgr.lastSyncOkAt.set('d', now - 20_000);

    expect(mgr.requestSync('a', now)).toEqual({ started: false });
    expect(mgr.requestSync('b', now)).toEqual({ started: false });
    expect(mgr.requestSync('c', now)).toEqual({ started: false });
    expect(mgr.requestSync('d', now)).toEqual({ started: true });
    expect(syncNow.mock.calls.map(([id]) => id)).toEqual(['d']);
  });

  it('syncs the INBOX, records the success and tells clients', async () => {
    const mgr = newManager();
    rows.set('mailbox-1', mailbox(1));
    const client = {};
    mgr.connections.set('mailbox-1', client);
    const syncMessages = vi.spyOn(mgr, 'syncMessages').mockResolvedValue({ insertedCount: 0 });

    await mgr.syncNow('mailbox-1');

    expect(syncMessages).toHaveBeenCalledWith(expect.objectContaining({ id: 'mailbox-1' }), client, 'INBOX', 20, false, true);
    expect(mgr.lastSyncOkAt.has('mailbox-1')).toBe(true);
    expect(mgr.syncingAccounts.has('mailbox-1')).toBe(false);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'sync_complete', accountId: 'mailbox-1' });
  });

  it('does nothing for a mailbox disabled after the request', async () => {
    const mgr = newManager();
    rows.set('mailbox-1', mailbox(1, { enabled: false }));
    const connect = vi.spyOn(mgr, 'connectAccount').mockResolvedValue(true);

    await mgr.syncNow('mailbox-1');

    expect(connect).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('folder sync: one at a time, not while connecting and not within 15 seconds of the last one', async () => {
    const mgr = newManager();
    let finish;
    const syncFoldersNow = vi.spyOn(mgr, 'syncFoldersNow').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const now = 5_000_000;

    expect(mgr.requestFolderSync('a', now)).toEqual({ started: true });
    expect(mgr.requestFolderSync('a', now)).toEqual({ started: false });
    mgr.lastFolderSyncAt.set('b', now - 5_000);
    expect(mgr.requestFolderSync('b', now)).toEqual({ started: false });
    mgr.connectingAccounts.add('c');
    expect(mgr.requestFolderSync('c', now)).toEqual({ started: false });
    expect(syncFoldersNow).toHaveBeenCalledTimes(1);

    finish();
    await flushPromises();
    expect(mgr.requestFolderSync('a', now)).toEqual({ started: true });
  });

  it('refreshes the folder list of a connected mailbox', async () => {
    const mgr = newManager();
    rows.set('mailbox-1', mailbox(1));
    const client = {};
    mgr.connections.set('mailbox-1', client);
    const syncFolders = vi.spyOn(mgr, 'syncFolders').mockResolvedValue();

    await mgr.syncFoldersNow('mailbox-1');

    expect(syncFolders).toHaveBeenCalledWith(expect.objectContaining({ id: 'mailbox-1' }), client);
    expect(mgr.lastFolderSyncAt.has('mailbox-1')).toBe(true);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'folders_synced', accountId: 'mailbox-1' });
  });

  it('reports a connect in progress', () => {
    const mgr = newManager();
    expect(mgr.isConnecting('a')).toBe(false);
    mgr.connectingAccounts.add('a');
    expect(mgr.isConnecting('a')).toBe(true);
  });
});
