// The app's one OAuth return watch (utils/oauthReturnWatch.js): window focus, the generation-aware
// account reconcile and the shared store. Created on first use, so importing it has no effect.
import { reconcileAccounts } from './accountsReconcile.js';
import { useStore } from '../store/index.js';
import { OAUTH_RETURN_MIN_INTERVAL_MS } from './addAccount.js';
import { createOAuthReturnWatch } from './oauthReturnWatch.js';

let watch = null;

export function appOAuthReturnWatch() {
  if (!watch) {
    watch = createOAuthReturnWatch({
      target: window,
      reconcile: reconcileAccounts,
      getAccounts: () => useStore.getState().accounts,
      interval: OAUTH_RETURN_MIN_INTERVAL_MS,
    });
  }
  return watch;
}
