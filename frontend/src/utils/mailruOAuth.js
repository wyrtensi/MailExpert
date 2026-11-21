import { api } from './api.js';
import { isDemoMode } from '../demo/mode.js';
import { reconcileAccounts } from './accountsReconcile.js';
import { useStore } from '../store/index.js';

const ERROR_KEYS = Object.freeze({
  access_denied: 'admin.integrations.mailru.errorAccessDenied',
  invalid_state: 'admin.integrations.mailru.errorInvalidState',
  not_configured: 'admin.integrations.mailru.errorNotConfigured',
  email_invalid: 'admin.accounts.add.error.emailInvalid',
  email_not_verified: 'admin.integrations.mailru.errorEmailNotVerified',
  missing_refresh_token: 'admin.integrations.mailru.errorMissingRefreshToken',
  scope_missing: 'admin.integrations.mailru.errorScopeMissing',
  already_connected: 'admin.integrations.mailru.errorAlreadyConnected',
  account_mismatch: 'admin.integrations.mailru.errorAccountMismatch',
});

export function mailruOAuthErrorKey(code) {
  return Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : 'admin.integrations.mailru.errorAuthenticationFailed';
}

export function mailruOAuthNotification(params, t) {
  const error = params.get('oauth_error');
  const provider = error ? params.get('oauth_provider') : params.get('oauth_success');
  if (provider !== 'mailru') return null;
  const title = t('admin.integrations.mailru.title');
  if (error) return { type: 'error', title, body: t(mailruOAuthErrorKey(error)) };
  return {
    type: 'info', title,
    body: t(params.get('oauth_result') === 'updated'
      ? 'admin.integrations.mailru.updated'
      : 'admin.integrations.mailru.connected'),
  };
}

export async function beginMailruOAuth(target, t, signal) {
  const response = await api.startMailruOAuth(target, signal);
  if (signal?.aborted) return false;
  if (isDemoMode && response.demo === true) {
    useStore.getState().addNotification(mailruOAuthNotification(
      new URLSearchParams({ oauth_success: 'mailru', oauth_result: response.result }), t,
    ));
    return true;
  }
  const url = new URL(response.authorizationUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid OAuth authorization URL');
  window.location.assign(url.href);
  return false;
}

export async function reconnectMailruOAuth(accountId, t) {
  try {
    if (await beginMailruOAuth({ accountId }, t)) reconcileAccounts();
  } catch (err) {
    useStore.getState().addNotification({
      type: 'error', title: t('common.actionFailed.reconnect'), body: t(mailruOAuthErrorKey(err?.code)),
    });
  }
}
