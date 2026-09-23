// A hung LOGOUT must never pin a lock (upstream maathimself/mailflow@72da5238).
//
// LOGOUT is a command, so it queues behind whatever wedged the transport and can hang
// indefinitely. Several teardown paths awaited logout() with a lock release sitting after it:
//
//   _pollOnlyTick      -> the per-host background semaphore slot AND syncingAccounts
//   refreshBulkFlags   -> the same semaphore slot
//   syncNow            -> syncingAccounts and syncStartedAt (cleared in a later finally)
//
// (and the snippet indexer, backfill and provider id backfill, which take the same one-line
// change but cost more to drive in a unit test than they prove). The consequence was an
// account that stops syncing, or background work that stops for every account on that host,
// until the process restarts. Every client here connects and then never answers LOGOUT.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('./oauth/tokenManager.js', async (importOriginal) => ({
  OAuthTokenError: (await importOriginal()).OAuthTokenError,
  ensureFreshOAuthAccount: vi.fn(async account => account),
}));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import { ImapManager } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const HOST = 'imap.example.com';
const acct = {
  id: 'teardown', user_id: 'u1', imap_host: HOST, imap_port: 993,
  imap_tls: true, auth_user: 'u', auth_pass: 'enc', enabled: true, protocol: 'imap',
};

// The connection every path under test gets: it connects, then never answers LOGOUT.
let clients = [];
function installHungImapFlow() {
  ImapFlow.mockImplementation(function () {
    const c = new EventEmitter();
    c.connect = vi.fn(() => Promise.resolve());
    c.logout = vi.fn(() => new Promise(() => {}));
    c.close = vi.fn();
    c.mailbox = { exists: 0, uidValidity: 1n, highestModseq: 1n };
    c.getMailboxLock = async () => ({ release: vi.fn() });
    c.search = async () => [];
    // Fails the run after the connect.
    c.fetch = async function* () { yield await Promise.reject(new Error('boom')); };
    clients.push(c);
    return c;
  });
}

function manager() {
  const mgr = new ImapManager(null);
  for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer']) {
    clearInterval(mgr[key]);
  }
  mgr.broadcast = vi.fn();
  mgr.syncFolders = vi.fn().mockResolvedValue({});
  mgr.syncMessages = vi.fn().mockResolvedValue({});
  return mgr;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clients = [];
  installHungImapFlow();
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [acct] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a hung LOGOUT in _pollOnlyTick', () => {
  it('does not hold the per-host background slot or the sync guard', async () => {
    const mgr = manager();
    const tick = mgr._pollOnlyTick(acct);
    await vi.advanceTimersByTimeAsync(120000);
    await tick;

    expect(mgr._bgConnSem.activeCount(HOST)).toBe(0);
    expect(mgr.syncingAccounts.has(acct.id)).toBe(false);
    expect(clients).toHaveLength(1);
    expect(clients[0].close).toHaveBeenCalled();
    expect(clients[0].logout).not.toHaveBeenCalled();
  });
});

describe('a hung LOGOUT in refreshBulkFlags', () => {
  it('releases the per-host background slot after a failed folder', async () => {
    const mgr = manager();
    query.mockImplementation(async (sql) => {
      if (/is_bulk IS NULL/.test(sql)) return { rows: [{ id: 'm1', uid: '7', folder: 'INBOX' }] };
      return { rows: [acct] };
    });
    const run = mgr.refreshBulkFlags(acct);
    await vi.advanceTimersByTimeAsync(120000);
    await run;

    expect(mgr._bgConnSem.activeCount(HOST)).toBe(0);
    expect(clients).toHaveLength(1);
    expect(clients[0].close).toHaveBeenCalled();
    expect(clients[0].logout).not.toHaveBeenCalled();
  });
});

describe('a hung LOGOUT in syncNow', () => {
  it('does not hold the sync guard for the account', async () => {
    const mgr = manager();
    const client = { close: vi.fn(), logout: vi.fn(() => new Promise(() => {})) };
    mgr.connections.set(acct.id, client);
    mgr.syncMessages = vi.fn().mockRejectedValue(new Error('boom'));

    const run = mgr.syncNow(acct.id);
    await vi.advanceTimersByTimeAsync(120000);
    await run;

    expect(mgr.syncingAccounts.has(acct.id)).toBe(false);
    expect(mgr.syncStartedAt.has(acct.id)).toBe(false);
    expect(client.close).toHaveBeenCalled();
    expect(client.logout).not.toHaveBeenCalled();
  });
});
