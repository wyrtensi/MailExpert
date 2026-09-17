// Admin line for loading Gmail thread ids of a mailbox. null when the mailbox has no such job
// (not on Gmail) or the state is unknown to this client.
export function providerIdsBackfillText(state, t) {
  switch (state?.status) {
    case 'not_started':
      return t('admin.accounts.providerIds.notStarted');
    case 'running':
      return state.percent == null
        ? t('admin.accounts.providerIds.running')
        : t('admin.accounts.providerIds.runningPercent', { percent: state.percent });
    case 'paused':
      return t('admin.accounts.providerIds.paused');
    case 'done':
      return t('admin.accounts.providerIds.done');
    case 'error':
      return t('admin.accounts.providerIds.error', { error: state.error || '' });
    default:
      return null;
  }
}
