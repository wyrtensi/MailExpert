// The 503 answer for mail work that got no IMAP session (imapManager's isMailboxBusyError): the
// pool stayed full (poolExhausted) or a backoff held the login back (providerRefusing). Nothing
// was sent and nothing is lost, so the answer carries a stable code the client turns into a
// localized message instead of a generic failure.
//
// Two codes, because the two need different advice:
// - mailbox_busy: every pooled session is busy or the server is refusing extra connections for
//   a moment. Worth retrying in a few seconds.
// - mailbox_auth_rejected: the server rejected the mailbox's password on a recent login
//   (providerRefusing with authRejected), so no login is tried for 30 minutes to 6 hours.
//   Retrying does nothing until the password is updated in the mailbox settings.
export const MAILBOX_BUSY_CODE = 'mailbox_busy';
export const MAILBOX_AUTH_REJECTED_CODE = 'mailbox_auth_rejected';

const MAILBOX_BUSY_ERROR = 'This mailbox is busy with other mail operations. Please try again in a few seconds.';
const MAILBOX_AUTH_REJECTED_ERROR = "The mail server rejected this mailbox's password. Update it in the mailbox settings.";

// { error, code } for a busy answer; `err` is the error that got no session (or an object with
// authRejected, for a bulk route that tracks it across groups).
export function mailboxBusyBody(err) {
  return err?.authRejected
    ? { error: MAILBOX_AUTH_REJECTED_ERROR, code: MAILBOX_AUTH_REJECTED_CODE }
    : { error: MAILBOX_BUSY_ERROR, code: MAILBOX_BUSY_CODE };
}

export function sendMailboxBusy(res, err) {
  return res.status(503).json({ ...mailboxBusyBody(err), busy: true });
}
