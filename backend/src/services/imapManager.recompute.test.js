import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./threading/recompute.js', () => ({ runRecompute: vi.fn(), RECOMPUTE_BATCH_DELAY_MS: 200 }));

import { query } from './db.js';
import { runRecompute } from './threading/recompute.js';
import { ImapManager } from './imapManager.js';

const TIMERS = ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer'];
function newManager() {
  const mgr = new ImapManager(null);
  for (const key of TIMERS) clearInterval(mgr[key]);
  mgr.broadcast = vi.fn();
  return mgr;
}

const account = { id: 'a1', user_id: 'u1', enabled: true, protocol: 'imap', email_address: 'box@example.com' };
const other = { id: 'a2', user_id: 'u1', enabled: true, protocol: 'imap', email_address: 'other@example.com' };

let recomputeRows; // rows thread_recompute would hold, keyed by account id
let accountRow; // what email_accounts holds for `account`; tests change or null it mid-run
beforeEach(() => {
  recomputeRows = [];
  accountRow = account;
  query.mockReset();
  query.mockImplementation(async (sql, params = []) => {
    if (/FROM thread_recompute WHERE account_id = ANY/.test(sql)) {
      const ids = params[0];
      return { rows: recomputeRows.filter(row => ids.includes(row.account_id)) };
    }
    if (/FROM email_accounts WHERE id = \$1/.test(sql)) {
      return { rows: accountRow && accountRow.id === params[0] ? [accountRow] : [] };
    }
    if (/UPDATE thread_recompute SET error/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  runRecompute.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const broadcasts = (mgr) => mgr.broadcast.mock.calls.map(c => c[0]).filter(e => e.type === 'thread_recompute');

describe('startThreadRecompute', () => {
  it('marks nothing as running and broadcasts the final state once a run finishes', async () => {
    const mgr = newManager();
    runRecompute.mockImplementation(async () => {
      recomputeRows = [{ account_id: account.id, processed: 5, changed: 2, total: 5, finished_at: new Date(), error: null }];
      return { outcome: 'done', processed: 5, changed: 2, total: 5 };
    });

    await mgr.startThreadRecompute(account, 'rfc');
    await new Promise(resolve => setImmediate(resolve)); // the final state broadcast is not awaited

    expect(mgr.threadRecomputeRunning.has(account.id)).toBe(false);
    expect(broadcasts(mgr).at(-1)).toEqual({
      type: 'thread_recompute', accountId: account.id, state: { status: 'done', percent: 100, changed: 2, error: null },
    });
  });

  it('does not start a second pass while one is already running', async () => {
    const mgr = newManager();
    let resolveRun;
    runRecompute.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));

    const first = mgr.startThreadRecompute(account, 'rfc');
    await mgr.startThreadRecompute(account, 'rfc');
    expect(runRecompute).toHaveBeenCalledTimes(1);

    resolveRun({ outcome: 'done', processed: 0, changed: 0, total: 0 });
    await first;
  });

  it('records the error through the store and clears the running flag when the run fails', async () => {
    const mgr = newManager();
    runRecompute.mockRejectedValue(new Error('Connection closed'));

    await mgr.startThreadRecompute(account, 'rfc');

    expect(mgr.threadRecomputeRunning.has(account.id)).toBe(false);
    const errorUpdate = query.mock.calls.find(([sql]) => /UPDATE thread_recompute SET error/.test(sql));
    expect(errorUpdate[1]).toEqual([account.id, expect.stringContaining('Connection closed')]);
  });

  it('broadcasts progress with status running and the percent from the store', async () => {
    const mgr = newManager();
    runRecompute.mockImplementation(async ({ onProgress }) => {
      recomputeRows = [{ account_id: account.id, processed: 2, changed: 1, total: 4, finished_at: null, error: null }];
      await onProgress({ processed: 2, changed: 1, total: 4 });
      return { outcome: 'done', processed: 4, changed: 2, total: 4 };
    });

    await mgr.startThreadRecompute(account, 'rfc');

    expect(broadcasts(mgr)).toContainEqual({
      type: 'thread_recompute', accountId: account.id, state: { status: 'running', percent: 50, changed: 1, error: null },
    });
  });
});

describe('startThreadRecompute shouldContinue', () => {
  async function continueAnswer(mgr, during = () => {}) {
    let answer;
    runRecompute.mockImplementation(async ({ shouldContinue }) => {
      during();
      answer = await shouldContinue();
      return { outcome: 'stopped', processed: 0, changed: 0, total: 1 };
    });
    await mgr.startThreadRecompute(account, 'rfc');
    return answer;
  }

  it('continues for an enabled mailbox', async () => {
    expect(await continueAnswer(newManager())).toBe(true);
  });

  it('stops once the mailbox is disabled', async () => {
    expect(await continueAnswer(newManager(), () => { accountRow = { ...account, enabled: false }; })).toBe(false);
  });

  it('stops once the mailbox row is gone', async () => {
    expect(await continueAnswer(newManager(), () => { accountRow = null; })).toBe(false);
  });
});

describe('threadRecomputeStates', () => {
  it('returns a state per requested mailbox', async () => {
    const mgr = newManager();
    recomputeRows = [{ account_id: account.id, processed: 4, changed: 2, total: 4, finished_at: new Date(), error: null }];

    const states = await mgr.threadRecomputeStates([account, other]);

    expect([...states.entries()]).toEqual([
      [account.id, { status: 'done', percent: 100, changed: 2, error: null }],
      [other.id, { status: 'idle', percent: null, changed: null, error: null }],
    ]);
  });

  it('does not query the database when given an empty list', async () => {
    const mgr = newManager();
    expect(await mgr.threadRecomputeStates([])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
});
