import { query } from './db.js';
import { JobError, enqueueJob, registerJobKind } from './jobQueue.js';
import { GmailSendAsError, syncGmailSendAs } from './gmailSendAs.js';
import { OAuthTokenError } from './oauth/tokenManager.js';

// Keeps the Gmail "send mail as" aliases of Google mailboxes current (services/gmailSendAs.js):
// one queued job per mailbox after connecting Google and one pass an hour for every connected
// Google mailbox. Gmail is the source of truth, so a failed read changes nothing and the next
// pass tries again.

export const GMAIL_SEND_AS_SYNC_KIND = 'gmail_send_as_sync';
export const GMAIL_SEND_AS_POLL_MS = 60 * 60 * 1000;
const FIRST_POLL_DELAY_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// The handler: a skipped mailbox (not Google, reconnect needed, deleted) is a finished job, not a
// retry loop. Messages of GmailSendAsError carry no token or provider body, so they may be kept.
export async function runGmailSendAsSync(job) {
  const accountId = job.account_id ?? job.accountId ?? job.payload?.accountId;
  if (!accountId) return;
  try {
    await syncGmailSendAs(accountId);
  } catch (err) {
    if (err instanceof GmailSendAsError) {
      const outcome = err.code === 'bad_response' ? 'fail' : 'retry';
      throw new JobError(err.message, { outcome, code: err.code });
    }
    if (err instanceof OAuthTokenError) {
      throw new JobError(`Google token error: ${err.code || 'oauth_token_error'}`, { outcome: 'retry', code: err.code || 'oauth_token_error' });
    }
    throw err;
  }
}

export function registerGmailSendAsJobKind() {
  registerJobKind(GMAIL_SEND_AS_SYNC_KIND, { handler: runGmailSendAsSync, maxAttempts: MAX_ATTEMPTS });
}

// 'poll' queues one job per mailbox per hour slot (two ticks, or two processes, in one hour make
// one job); 'connect' always queues a new one, so a reconnect is not swallowed by the hour's slot.
export async function enqueueGmailSendAsSync(accountId, { reason = 'poll', now = Date.now() } = {}) {
  const dedupeKey = reason === 'connect'
    ? `${accountId}:connect-${now}`
    : `${accountId}:slot-${Math.floor(now / GMAIL_SEND_AS_POLL_MS)}`;
  return enqueueJob({ kind: GMAIL_SEND_AS_SYNC_KIND, accountId, dedupeKey, maxAttempts: MAX_ATTEMPTS });
}

export async function pollGmailSendAs(now = Date.now()) {
  const { rows } = await query(
    "SELECT id FROM email_accounts WHERE oauth_provider = 'google' AND oauth_reconnect_required = false",
  );
  for (const { id } of rows) {
    try {
      await enqueueGmailSendAsSync(id, { reason: 'poll', now });
    } catch (err) {
      console.error('Gmail send-as sync could not be queued:', err?.code || err?.message);
    }
  }
}

let firstPoll = null;
let pollTimer = null;

export function startGmailSendAsPoll() {
  if (pollTimer) return;
  const run = () => {
    pollGmailSendAs().catch((err) => console.error('Gmail send-as poll failed:', err?.code || err?.message));
  };
  firstPoll = setTimeout(run, FIRST_POLL_DELAY_MS);
  firstPoll.unref?.();
  pollTimer = setInterval(run, GMAIL_SEND_AS_POLL_MS);
  pollTimer.unref?.();
}

export function stopGmailSendAsPoll() {
  clearTimeout(firstPoll);
  clearInterval(pollTimer);
  firstPoll = null;
  pollTimer = null;
}
