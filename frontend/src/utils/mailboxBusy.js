// The server answers 503 { code: 'mailbox_busy' } when every pooled IMAP connection of the
// mailbox is busy and the request waited its turn out. Nothing failed and nothing is lost, so
// the reader is told to try again in a few seconds instead of seeing a generic failure. A bulk
// request that got partly through answers 200 with the ids that went through and the same code
// in its body, so a partial-failure toast can say why the rest did not.
//
// 'mailbox_auth_rejected' is the same answer when the reason is that the mail server rejected the
// mailbox's password: no login is tried for a while and retrying does nothing, so the reader is
// told to have the mailbox checked. Not "change the password in the settings": a mail-node
// mailbox cannot change it there.
//
// 'move_pending' (409) is the same "nothing changed, try again in a few seconds" for a letter
// whose move has not reached the mail server yet: moves are DB-first and run from a queue, and
// work that stays server-first (permanent delete, snooze, an uncached body while the MOVE is in
// flight) waits for it. Moves themselves never answer any of these codes.
export const MAILBOX_BUSY_CODE = 'mailbox_busy';
export const MAILBOX_AUTH_REJECTED_CODE = 'mailbox_auth_rejected';
export const MOVE_PENDING_CODE = 'move_pending';

// True for any of the codes: the request did nothing and says why.
export function isMailboxBusy(err) {
  return err?.code === MAILBOX_BUSY_CODE || err?.code === MAILBOX_AUTH_REJECTED_CODE || err?.code === MOVE_PENDING_CODE;
}

// The text for a busy answer (`err` carries its code). `t` is the i18n translate function.
export function mailboxBusyText(err, t) {
  if (err?.code === MAILBOX_AUTH_REJECTED_CODE) return t('common.mailboxAuthRejected');
  if (err?.code === MOVE_PENDING_CODE) return t('common.movePending');
  return t('common.mailboxBusy');
}

// The busy text when `err` is a busy mailbox, else `fallback` (the message the caller showed
// before).
export function mailboxBusyOr(err, t, fallback) {
  return isMailboxBusy(err) ? mailboxBusyText(err, t) : fallback;
}
