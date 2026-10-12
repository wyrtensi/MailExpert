// Re-reads the mailbox list from the server into the shared store. Used when the dialog closes
// with a connection attempt in flight (the server may have finished it before the cancel) and
// when an OAuth result arrives: the result never invents an account, the server is asked.
// Generation-aware: only the newest read applies, so an older, slower answer cannot overwrite a
// newer list.
import { api } from './api.js';
import { useStore } from '../store/index.js';

let generation = 0;

export function reconcileAccounts() {
  const mine = ++generation;
  return api.getAccounts()
    .then((list) => {
      if (mine === generation && Array.isArray(list)) useStore.getState().setAccounts(list);
    })
    .catch(() => {});
}
