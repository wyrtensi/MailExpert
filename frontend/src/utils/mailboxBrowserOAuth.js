import { api } from './api.js';
import { isDemoMode } from '../demo/mode.js';
import { reconcileAccounts } from './accountsReconcile.js';
import { useStore } from '../store/index.js';

const MAILRU_ERROR_KEYS = {
  access_denied: 'admin.integrations.mailru.errorAccessDenied',
  invalid_state: 'admin.integrations.mailru.errorInvalidState',
  not_configured: 'admin.integrations.mailru.errorNotConfigured',
  email_invalid: 'admin.accounts.add.error.emailInvalid',
  email_not_verified: 'admin.integrations.mailru.errorEmailNotVerified',
  missing_refresh_token: 'admin.integrations.mailru.errorMissingRefreshToken',
  scope_missing: 'admin.integrations.mailru.errorScopeMissing',
  already_connected: 'admin.integrations.mailru.errorAlreadyConnected',
  account_mismatch: 'admin.integrations.mailru.errorAccountMismatch',
};

const YANDEX_ERROR_KEYS = {
  access_denied: 'admin.integrations.yandex.errorAccessDenied',
  invalid_state: 'admin.integrations.yandex.errorInvalidState',
  not_configured: 'admin.integrations.yandex.errorNotConfigured',
  already_connected: 'admin.integrations.yandex.errorAlreadyConnected',
  email_invalid: 'admin.accounts.add.error.emailInvalid',
  rate_limited: 'admin.accounts.add.error.rateLimited',
  scope_missing: 'admin.integrations.yandex.errorScopeMissing',
  missing_refresh_token: 'admin.integrations.yandex.errorMissingRefreshToken',
  account_mismatch: 'admin.integrations.yandex.errorAccountMismatch',
  imap_auth_failed: 'admin.integrations.yandex.errorImapAuth',
  smtp_auth_failed: 'admin.integrations.yandex.errorSmtpAuth',
};

const PROVIDERS = {
  mailru: {
    errorKeys: MAILRU_ERROR_KEYS,
    failed: 'admin.integrations.mailru.errorAuthenticationFailed',
    title: 'admin.integrations.mailru.title',
    connected: 'admin.integrations.mailru.connected',
    updated: 'admin.integrations.mailru.updated',
    origins: ['https://o2.mail.ru', 'https://oauth.mail.ru'],
  },
  yandex: {
    errorKeys: YANDEX_ERROR_KEYS,
    failed: 'admin.integrations.yandex.errorAuthenticationFailed',
    title: 'admin.integrations.yandex.title',
    connected: 'admin.integrations.yandex.connected',
    updated: 'admin.integrations.yandex.updated',
    origins: ['https://oauth.yandex.ru'],
  },
};

export function isMailboxBrowserOAuthProvider(provider) {
  return Object.hasOwn(PROVIDERS, provider);
}

export function mailboxBrowserOAuthErrorKey(provider, code) {
  const { errorKeys, failed } = PROVIDERS[provider];
  return Object.hasOwn(errorKeys, code) ? errorKeys[code] : failed;
}

export function mailboxBrowserOAuthNotification(params, t) {
  const error = params.get('oauth_error');
  const provider = error ? params.get('oauth_provider') : params.get('oauth_success');
  if (!isMailboxBrowserOAuthProvider(provider)) return null;
  const { title, connected, updated } = PROVIDERS[provider];
  if (error) return { type: 'error', title: t(title), body: t(mailboxBrowserOAuthErrorKey(provider, error)) };
  return {
    type: 'info', title: t(title),
    body: t(params.get('oauth_result') === 'updated' ? updated : connected),
  };
}

export async function beginMailboxBrowserOAuth(provider, target, t, signal) {
  const start = provider === 'yandex' ? api.startYandexBrowserOAuth : api.startMailruOAuth;
  const response = await start(target, signal);
  if (signal?.aborted) return false;
  if (isDemoMode && response.demo === true) {
    useStore.getState().addNotification(mailboxBrowserOAuthNotification(
      new URLSearchParams({ oauth_success: provider, oauth_result: response.result }), t,
    ));
    return true;
  }
  const url = new URL(response.authorizationUrl);
  if (!PROVIDERS[provider].origins.includes(url.origin) || url.username || url.password) {
    throw new Error('Invalid OAuth authorization URL');
  }
  window.location.assign(url.href);
  return false;
}

export async function reconnectMailruOAuth(accountId, t) {
  try {
    if (await beginMailboxBrowserOAuth('mailru', { accountId }, t)) reconcileAccounts();
  } catch (err) {
    useStore.getState().addNotification({
      type: 'error', title: t('common.actionFailed.reconnect'), body: t(mailboxBrowserOAuthErrorKey('mailru', err?.code)),
    });
  }
}
