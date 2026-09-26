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
//   Retrying does nothing; someone has to check the mailbox. The text does not say to change the
//   password in the mailbox settings: a mail-node mailbox cannot change it there
//   (mail_node_connection_locked), and it may be the mailbox that was deactivated.
export const MAILBOX_BUSY_CODE = 'mailbox_busy';
export const MAILBOX_AUTH_REJECTED_CODE = 'mailbox_auth_rejected';

const MAILBOX_BUSY_ERROR = 'This mailbox is busy with other mail operations. Please try again in a few seconds.';
const MAILBOX_AUTH_REJECTED_ERROR = 'The mail server does not accept the sign-in to this mailbox. Ask an administrator to check the mailbox.';

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

// A letter whose DB-first move has not reached the mail server yet (services/moveQueue.js) is
// between folders for a moment. Work that needs its server location and stays server-first
// (permanent delete, snooze, reading an uncached body while its MOVE is in flight) answers 409
// with this code; retrying in a few seconds works.
export const MOVE_PENDING_CODE = 'move_pending';
const MOVE_PENDING_ERROR = 'This letter is still being moved on the mail server. Please try again in a few seconds.';

export function movePendingBody() {
  return { error: MOVE_PENDING_ERROR, code: MOVE_PENDING_CODE };
}

export function sendMovePending(res) {
  return res.status(409).json(movePendingBody());
}

// The error for work that met a letter whose move is pending (a placeholder uid): nothing was
// sent. Routes answer it with sendMovePending.
export function movePendingError() {
  const err = new Error(MOVE_PENDING_ERROR);
  err.movePending = true;
  err.code = MOVE_PENDING_CODE;
  return err;
}

export function isMovePendingError(err) {
  return !!err?.movePending;
}
