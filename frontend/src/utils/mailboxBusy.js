// The server answers 503 { code: 'mailbox_busy' } when every pooled IMAP connection of the
// mailbox is busy and the request waited its turn out. Nothing failed and nothing is lost, so
// the reader is told to try again in a few seconds instead of seeing a generic failure. A bulk
// request that got partly through answers 200 with the ids that went through and the same code
// in its body, so a partial-failure toast can say why the rest did not.
export const MAILBOX_BUSY_CODE = 'mailbox_busy';

export function isMailboxBusy(err) {
  return err?.code === MAILBOX_BUSY_CODE;
}

// The busy text when `err` is a busy mailbox, else `fallback` (the message the caller showed
// before). `t` is the i18n translate function.
export function mailboxBusyOr(err, t, fallback) {
  return isMailboxBusy(err) ? t('common.mailboxBusy') : fallback;
}
