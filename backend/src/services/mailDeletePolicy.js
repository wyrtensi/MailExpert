// MAIL_DELETE_ENABLED=false turns off deleting letters for the whole panel: moving them to Trash,
// deleting them forever, emptying or deleting a folder, and the rule and block-list actions that
// do the same. Unset, empty or true: deleting works as before. Read on every call, so a test or a
// restarted container sees the current value. Drafts (DELETE /api/mail/draft/:uid) are not
// covered: compose replaces and discards its own drafts.

export const MAIL_DELETE_DISABLED_CODE = 'mail_delete_disabled';

let warnedValue = null;

export function mailDeleteEnabled() {
  const raw = process.env.MAIL_DELETE_ENABLED;
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'true') return true;
  if (value === 'false') return false;
  if (warnedValue !== raw) {
    warnedValue = raw;
    console.warn(`MAIL_DELETE_ENABLED="${raw}" is not "true" or "false"; deleting letters stays on`);
  }
  return true;
}

export function sendMailDeleteDisabled(res) {
  return res.status(403).json({
    error: 'Deleting letters is turned off on this panel',
    code: MAIL_DELETE_DISABLED_CODE,
  });
}
