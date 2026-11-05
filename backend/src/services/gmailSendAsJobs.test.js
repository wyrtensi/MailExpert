import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./jobQueue.js', () => ({
  JobError: class JobError extends Error {
    constructor(message, { outcome = 'retry', code = null } = {}) {
      super(message);
      this.jobOutcome = outcome;
      this.code = code;
    }
  },
  enqueueJob: vi.fn(),
  registerJobKind: vi.fn(),
}));
vi.mock('./gmailSendAs.js', () => ({
  GmailSendAsError: class GmailSendAsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  },
  syncGmailSendAs: vi.fn(),
}));
vi.mock('./oauth/tokenManager.js', () => ({ OAuthTokenError: class OAuthTokenError extends Error {} }));

const { query } = await import('./db.js');
const { enqueueJob } = await import('./jobQueue.js');
const { GmailSendAsError, syncGmailSendAs } = await import('./gmailSendAs.js');
const { enqueueGmailSendAsSync, pollGmailSendAs, runGmailSendAsSync, GMAIL_SEND_AS_SYNC_KIND } = await import('./gmailSendAsJobs.js');

const HOUR = 60 * 60 * 1000;
const T0 = 5000 * HOUR + 1000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Behaves like ON CONFLICT (kind, dedupe_key) DO NOTHING.
  const seen = new Set();
  enqueueJob.mockImplementation(async ({ kind, dedupeKey }) => {
    const key = `${kind}|${dedupeKey}`;
    const created = !seen.has(key);
    seen.add(key);
    return { job: { id: key }, created };
  });
});

describe('gmail send-as jobs', () => {
  it('poll enqueues one job per google account per hour slot', async () => {
    query.mockResolvedValue({ rows: [{ id: 'a1' }, { id: 'a2' }] });
    await pollGmailSendAs(T0);
    await pollGmailSendAs(T0 + 30 * 60 * 1000);
    const results = await Promise.all(enqueueJob.mock.results.map((r) => r.value));
    expect(results.filter((r) => r.created)).toHaveLength(2);
    expect(enqueueJob.mock.calls.map(([a]) => a.dedupeKey).sort())
      .toEqual(['a1:slot-5000', 'a1:slot-5000', 'a2:slot-5000', 'a2:slot-5000']);
    expect(enqueueJob.mock.calls[0][0]).toMatchObject({ kind: GMAIL_SEND_AS_SYNC_KIND, accountId: 'a1' });
    expect(query.mock.calls[0][0]).toMatch(/oauth_provider = 'google'/);
    expect(query.mock.calls[0][0]).toMatch(/oauth_reconnect_required = false/);
  });

  it('poll keeps going when one enqueue fails', async () => {
    query.mockResolvedValue({ rows: [{ id: 'a1' }, { id: 'a2' }] });
    enqueueJob.mockRejectedValueOnce(new Error('db down'));
    await pollGmailSendAs(T0);
    expect(enqueueJob).toHaveBeenCalledTimes(2);
  });

  it('handler maps rate_limited and upstream to retry, bad_response to fail, skipped to success', async () => {
    const job = { account_id: 'a1' };
    for (const code of ['rate_limited', 'upstream', 'unauthorized']) {
      syncGmailSendAs.mockRejectedValueOnce(new GmailSendAsError(code, 'boom'));
      await expect(runGmailSendAsSync(job)).rejects.toMatchObject({ jobOutcome: 'retry', code });
    }
    syncGmailSendAs.mockRejectedValueOnce(new GmailSendAsError('bad_response', 'boom'));
    await expect(runGmailSendAsSync(job)).rejects.toMatchObject({ jobOutcome: 'fail', code: 'bad_response' });
    syncGmailSendAs.mockResolvedValueOnce({ status: 'skipped', reason: 'reconnect_required' });
    await expect(runGmailSendAsSync(job)).resolves.toBeUndefined();
    expect(syncGmailSendAs).toHaveBeenCalledWith('a1');
  });

  it('connect reason always creates a new job', async () => {
    const first = await enqueueGmailSendAsSync('a1', { reason: 'connect', now: T0 });
    const second = await enqueueGmailSendAsSync('a1', { reason: 'connect', now: T0 + 5 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
  });
});
