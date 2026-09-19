// Admin panel helpers for a mailbox's threading mode (PR C2): the current mode label and the
// line shown while a thread recompute runs after a switch.

// account.thread_mode is 'rfc' or 'gmail' (email_accounts.thread_mode, default 'rfc'); any other
// value (missing column on an older client, unexpected data) reads as rfc, the safe default.
export function threadModeOf(account) {
  return account?.thread_mode === 'gmail' ? 'gmail' : 'rfc';
}

export function threadModeLabel(account, t) {
  return threadModeOf(account) === 'gmail'
    ? t('admin.accounts.threading.modeGmail')
    : t('admin.accounts.threading.modeRfc');
}

// Mirrors the backend's provider profile (providerProfile in services/imapManager.js): only a
// mailbox on a Gmail host stores X-GM-THRID, and POST .../threading/mode refuses gmail for any
// other host with 409 not_gmail. The rule lives here, tested, instead of inline in the panel.
export function isGmailMailbox(account) {
  const host = (account?.imap_host || '').toLowerCase();
  return host.includes('.gmail.com') || host.includes('.googlemail.com');
}

// The mode the switch action targets, or null when there is nothing to offer — the panel must not
// propose a switch the backend would refuse. A mailbox in gmail mode can always roll back to rfc,
// whatever its host; only a Gmail mailbox can move the other way.
export function threadSwitchTarget(account) {
  if (threadModeOf(account) === 'gmail') return 'rfc';
  return isGmailMailbox(account) ? 'gmail' : null;
}

// state is the mailbox's `thread_recompute` field: { status, percent, changed, error } | null,
// status one of 'idle' | 'running' | 'paused' | 'done' | 'error'. null and 'idle' both mean the
// mailbox never ran a pass, so there is nothing to show; 'paused' is a pass that stopped and is
// continued when the mailbox reconnects, which must be visible.
export function threadRecomputeText(state, t) {
  switch (state?.status) {
    case 'running':
      return state.percent == null
        ? t('admin.accounts.threading.running')
        : `${t('admin.accounts.threading.running')} ${state.percent}%`;
    case 'paused':
      return t('admin.accounts.threading.paused');
    case 'done':
      return t('admin.accounts.threading.done', { changed: state.changed });
    case 'error':
      return t('admin.accounts.threading.failed', { error: state.error || '' });
    default:
      return null;
  }
}
