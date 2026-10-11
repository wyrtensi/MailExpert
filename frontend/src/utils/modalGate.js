// Whether a modal layer owns the keyboard and the native Back: the add-account dialog today.
// MailApp's global shortcuts, the command palette key and the Back handlers ask this first, so
// nothing behind the dialog reacts while it is open. Pure: takes the store state.
export function isModalOpen(state) {
  return !!state?.showAddAccountDialog;
}
