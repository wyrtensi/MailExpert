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
export const MAILBOX_BUSY_CODE = 'mailbox_busy';
export const MAILBOX_AUTH_REJECTED_CODE = 'mailbox_auth_rejected';

// True for either code: the request got no IMAP session and nothing was changed.
export function isMailboxBusy(err) {
  return err?.code === MAILBOX_BUSY_CODE || err?.code === MAILBOX_AUTH_REJECTED_CODE;
}

// The text for a busy answer (`err` carries its code). `t` is the i18n translate function.
export function mailboxBusyText(err, t) {
  return err?.code === MAILBOX_AUTH_REJECTED_CODE ? t('common.mailboxAuthRejected') : t('common.mailboxBusy');
}

// The busy text when `err` is a busy mailbox, else `fallback` (the message the caller showed
// before).
export function mailboxBusyOr(err, t, fallback) {
  return isMailboxBusy(err) ? mailboxBusyText(err, t) : fallback;
}
