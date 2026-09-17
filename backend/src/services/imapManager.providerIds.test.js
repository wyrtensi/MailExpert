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
vi.mock('./threading/providerIdBackfill.js', () => ({ runProviderIdBackfill: vi.fn() }));
vi.mock('./threading/providerIdBackfillStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  recordProviderIdBackfillError: vi.fn(async () => {}),
}));

import { query } from './db.js';
import { runProviderIdBackfill } from './threading/providerIdBackfill.js';
import { recordProviderIdBackfillError } from './threading/providerIdBackfillStore.js';
import { ImapManager } from './imapManager.js';

const TIMERS = ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer'];
function newManager() {
  const mgr = new ImapManager(null);
  for (const key of TIMERS) clearInterval(mgr[key]);
  mgr.broadcast = vi.fn();
  return mgr;
}

const gmail = {
  id: 'g1', user_id: 'u1', enabled: true, protocol: 'imap', email_address: 'box@gmail.com',
  imap_host: 'imap.gmail.com', imap_port: 993, oauth_reconnect_required: false,
};
const other = { ...gmail, id: 'o1', email_address: 'box@example.com', imap_host: 'imap.example.com' };

let backfillRows;
beforeEach(() => {
  backfillRows = [];
  query.mockReset();
  query.mockImplementation(async (sql, params = []) => {
    if (/FROM provider_id_backfill/.test(sql)) return { rows: backfillRows };
    if (/FROM email_accounts WHERE id = \$1/.test(sql)) return { rows: [params[0] === gmail.id ? gmail : other] };
    return { rows: [] };
  });
  runProviderIdBackfill.mockReset();
  recordProviderIdBackfillError.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

const broadcasts = (mgr) => mgr.broadcast.mock.calls.map(c => c[0]).filter(e => e.type === 'provider_ids_backfill');

describe('startProviderIdBackfill', () => {
  it('does nothing for a mailbox that is not on Gmail', async () => {
    await newManager().startProviderIdBackfill(other);
    expect(runProviderIdBackfill).not.toHaveBeenCalled();
  });

  it('leaves the start to a running full backfill', async () => {
    const mgr = newManager();
    mgr.backfillAllRunning.add(gmail.id);
    await mgr.startProviderIdBackfill(gmail);
    expect(runProviderIdBackfill).not.toHaveBeenCalled();
  });

  it('marks the mailbox clean after a complete run and skips it next time', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockResolvedValue({ outcome: 'done', processed: 3, total: 3 });
    await mgr.startProviderIdBackfill(gmail);
    await mgr.startProviderIdBackfill(gmail);
    await new Promise(resolve => setImmediate(resolve)); // the final state broadcast is not awaited
    expect(runProviderIdBackfill).toHaveBeenCalledTimes(1);
    expect(runProviderIdBackfill.mock.calls[0][0]).toMatchObject({ query, accountId: gmail.id });
    expect(mgr.providerIdBackfillRunning.has(gmail.id)).toBe(false);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(true);
    expect(broadcasts(mgr).at(-1)).toMatchObject({ accountId: gmail.id, state: { status: 'not_started' } });
  });

  it('keeps a stopped run eligible for the scheduler', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockResolvedValue({ outcome: 'stopped', processed: 0, total: 3 });
    await mgr.startProviderIdBackfill(gmail);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });

  it('does not mark the mailbox clean when a local write happened during the run', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    runProviderIdBackfill.mockImplementation(async () => {
      mgr._scheduleProviderIdBackfill(gmail);
      return { outcome: 'done', processed: 1, total: 1 };
    });
    await mgr.startProviderIdBackfill(gmail);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });

  it('broadcasts progress while running', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockImplementation(async ({ onProgress }) => {
      onProgress({ processed: 1, total: 4 });
      await new Promise(resolve => setImmediate(resolve));
      return { outcome: 'done', processed: 4, total: 4 };
    });
    await mgr.startProviderIdBackfill(gmail);
    expect(broadcasts(mgr)).toContainEqual({
      type: 'provider_ids_backfill', accountId: gmail.id, state: { status: 'running', percent: 25, error: null },
    });
  });

  it('takes no background connection when the run never needs IMAP', async () => {
    const mgr = newManager();
    const acquire = vi.spyOn(mgr._bgConnSem, 'acquire');
    runProviderIdBackfill.mockResolvedValue({ outcome: 'done', processed: 0, total: 0 });
    await mgr.startProviderIdBackfill(gmail);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('records the failure and frees the mailbox', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockRejectedValue(new Error('Connection closed'));
    await mgr.startProviderIdBackfill(gmail);
    expect(recordProviderIdBackfillError).toHaveBeenCalledWith(query, gmail.id, expect.stringContaining('Connection closed'));
    expect(mgr.providerIdBackfillRunning.has(gmail.id)).toBe(false);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });
});

describe('providerIdBackfillStates', () => {
  it('returns a state for Gmail mailboxes only', async () => {
    const mgr = newManager();
    backfillRows = [{ account_id: gmail.id, cursors: {}, finished_at: '2026-09-17T10:00:00Z', error: null }];
    const states = await mgr.providerIdBackfillStates([gmail, other]);
    expect([...states.entries()]).toEqual([[gmail.id, { status: 'done', percent: 100, error: null }]]);
  });

  it('does not query the database when no mailbox is on Gmail', async () => {
    const mgr = newManager();
    expect((await mgr.providerIdBackfillStates([other])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Gmail id backfill triggers', () => {
  it('a local Sent copy starts a run a minute later', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    mgr.providerIdBackfillClean.add(gmail.id);
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr.upsertSentMessageRecord(gmail, '[Gmail]/Sent Mail', 12, { subject: 'Hello' });
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(59 * 1000);
    expect(mgr.startProviderIdBackfill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledWith(gmail);
  });

  it('a local draft on another provider starts nothing', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr.upsertDraftMessageRecord(other, 'Drafts', 5, { subject: 'Hello' });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(mgr.startProviderIdBackfill).not.toHaveBeenCalled();
  });

  it('the scheduler starts connected mailboxes that are not clean', async () => {
    const mgr = newManager();
    mgr.connections.set(gmail.id, {});
    mgr.connections.set(other.id, {});
    mgr.providerIdBackfillClean.add(other.id);
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr._nudgeProviderIdBackfills();
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledTimes(1);
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledWith(gmail);
  });

  it('a finished full backfill starts the id backfill', async () => {
    const mgr = newManager();
    mgr._connectCooldown.set(gmail.id, { until: Date.now() + 60 * 1000 });
    mgr.refreshBulkFlags = vi.fn(async () => {});
    mgr.startSnippetIndexer = vi.fn(async () => {});
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr.backfillAllFolders(gmail);
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledWith(gmail);
  });
});
