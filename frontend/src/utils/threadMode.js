// Admin panel helpers for a mailbox's threading mode (PR C2): the current mode label and the
// line shown while a thread recompute runs after a switch.

// account.thread_mode is 'rfc' or 'gmail' (email_accounts.thread_mode, default 'rfc'); any other
// value (missing column on an older client, unexpected data) reads as rfc, the safe default.
export function threadModeLabel(account, t) {
  return account?.thread_mode === 'gmail'
    ? t('admin.accounts.threading.modeGmail')
    : t('admin.accounts.threading.modeRfc');
}

// state is the mailbox's `thread_recompute` field: { status, percent, changed, error } | null,
// status one of 'idle' | 'running' | 'done' | 'error'. null and 'idle' both mean nothing to show.
export function threadRecomputeText(state, t) {
  switch (state?.status) {
    case 'running':
      return state.percent == null
        ? t('admin.accounts.threading.running')
        : `${t('admin.accounts.threading.running')} ${state.percent}%`;
    case 'done':
      return t('admin.accounts.threading.done', { changed: state.changed });
    case 'error':
      return t('admin.accounts.threading.failed', { error: state.error || '' });
    default:
      return null;
  }
}
