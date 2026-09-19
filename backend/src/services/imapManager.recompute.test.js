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

const account = { id: 'a1', user_id: 'u1', enabled: true, protocol: 'imap', email_address: 'box@example.com', thread_mode: 'rfc' };
const other = { id: 'a2', user_id: 'u1', enabled: true, protocol: 'imap', email_address: 'other@example.com', thread_mode: 'rfc' };

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
    // loadRecompute, the single-row read the resume trigger uses.
    if (/FROM thread_recompute WHERE account_id = \$1/.test(sql)) {
      return { rows: recomputeRows.filter(row => row.account_id === params[0]) };
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

  it('does not start an overlapping pass while one is already running', async () => {
    const mgr = newManager();
    let resolveRun;
    runRecompute.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));

    const first = mgr.startThreadRecompute(account, 'rfc');
    await mgr.startThreadRecompute(account, 'rfc');
    expect(runRecompute).toHaveBeenCalledTimes(1);

    resolveRun({ outcome: 'done', processed: 0, changed: 0, total: 0 });
    await first;
    // The mailbox is still in the mode this pass ran for, so nothing is re-dispatched either.
    expect(runRecompute).toHaveBeenCalledTimes(1);
  });

  it('starts a pass for the new mode when the mode changed while the pass ran', async () => {
    const mgr = newManager();
    const modes = [];
    runRecompute.mockImplementation(async ({ targetMode, shouldContinue }) => {
      modes.push(targetMode);
      // The admin switched the mailbox to gmail while the rfc pass was walking it.
      if (modes.length === 1) accountRow = { ...account, thread_mode: 'gmail' };
      const keepGoing = await shouldContinue();
      return { outcome: keepGoing ? 'done' : 'stopped', processed: 0, changed: 0, total: 0 };
    });

    await mgr.startThreadRecompute(account, 'rfc');

    expect(modes).toEqual(['rfc', 'gmail']);
    expect(mgr.threadRecomputeRunning.has(account.id)).toBe(false);
  });

  it('starts a pass for the current mode when a pass finished for a mode the mailbox no longer has', async () => {
    const mgr = newManager();
    const modes = [];
    runRecompute.mockImplementation(async ({ targetMode }) => {
      modes.push(targetMode);
      if (modes.length === 1) accountRow = { ...account, thread_mode: 'gmail' };
      return { outcome: 'done', processed: 1, changed: 1, total: 1 };
    });

    await mgr.startThreadRecompute(account, 'rfc');

    expect(modes).toEqual(['rfc', 'gmail']);
  });

  it('does not re-dispatch a pass that failed: the error stays visible until a retry', async () => {
    const mgr = newManager();
    runRecompute.mockImplementation(async () => {
      accountRow = { ...account, thread_mode: 'gmail' };
      throw new Error('Connection closed');
    });

    await mgr.startThreadRecompute(account, 'rfc');

    expect(runRecompute).toHaveBeenCalledTimes(1);
  });

  it('does not re-dispatch for a mailbox that was disabled mid-pass', async () => {
    const mgr = newManager();
    runRecompute.mockImplementation(async ({ shouldContinue }) => {
      accountRow = { ...account, enabled: false, thread_mode: 'gmail' };
      await shouldContinue();
      return { outcome: 'stopped', processed: 0, changed: 0, total: 1 };
    });

    await mgr.startThreadRecompute(account, 'rfc');

    expect(runRecompute).toHaveBeenCalledTimes(1);
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
  // Only the FIRST pass's answer is returned: a pass stopped by a mode change re-dispatches a
  // pass for the new mode, and that one answers for itself.
  async function continueAnswer(mgr, during = () => {}) {
    const answers = [];
    runRecompute.mockImplementation(async ({ shouldContinue }) => {
      if (answers.length === 0) during();
      answers.push(await shouldContinue());
      return { outcome: 'stopped', processed: 0, changed: 0, total: 1 };
    });
    await mgr.startThreadRecompute(account, 'rfc');
    return answers[0];
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

  it('stops once the mailbox mode no longer matches the mode the pass started for', async () => {
    expect(await continueAnswer(newManager(), () => { accountRow = { ...account, thread_mode: 'gmail' }; })).toBe(false);
  });

  it('continues for a mailbox whose mode column is empty, which reads as rfc', async () => {
    expect(await continueAnswer(newManager(), () => { accountRow = { ...account, thread_mode: null }; })).toBe(true);
  });
});

describe('_resumeThreadRecompute', () => {
  const resumeWith = async (row) => {
    const mgr = newManager();
    recomputeRows = row ? [row] : [];
    runRecompute.mockResolvedValue({ outcome: 'done', processed: 0, changed: 0, total: 0 });
    await mgr._resumeThreadRecompute(account);
    return runRecompute.mock.calls.map(([args]) => args.targetMode);
  };

  it('starts nothing for a mailbox that never ran a pass', async () => {
    expect(await resumeWith(null)).toEqual([]);
  });

  it('continues a pass that stopped, for the mode the mailbox has now', async () => {
    expect(await resumeWith({ account_id: account.id, target_mode: 'rfc', finished_at: null, error: null })).toEqual(['rfc']);
  });

  it('starts nothing for a pass that finished for the mode the mailbox still has', async () => {
    expect(await resumeWith({ account_id: account.id, target_mode: 'rfc', finished_at: new Date(), error: null })).toEqual([]);
  });

  it('starts a pass when the last one finished for a mode the mailbox no longer has', async () => {
    expect(await resumeWith({ account_id: account.id, target_mode: 'gmail', finished_at: new Date(), error: null })).toEqual(['rfc']);
  });

  it('starts nothing for a pass that failed: the error stays visible until a retry', async () => {
    expect(await resumeWith({ account_id: account.id, target_mode: 'rfc', finished_at: null, error: 'Connection closed' })).toEqual([]);
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
