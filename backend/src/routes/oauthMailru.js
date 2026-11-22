import { normalizeEmail } from '../services/auth/userIdentity.js';
import { buildMailruAuthorizationUrl, exchangeMailruCode, fetchMailruIdentity } from '../services/oauth/mailruOAuth.js';
import { createMailboxOAuthRedirectRoutes } from './mailboxOAuthRedirect.js';

export const { apiRoutes: mailruApiRoutes, callbackRoutes: mailruCallbackRoutes } = createMailboxOAuthRedirectRoutes({
  provider: 'mailru',
  buildAuthorizationUrl: buildMailruAuthorizationUrl,
  exchangeCode: exchangeMailruCode,
  async proveIdentity(tokens, _config, email) {
    const identity = await fetchMailruIdentity(tokens.accessToken);
    return normalizeEmail(identity.email) === email ? identity : null;
  },
  providerErrors: new Set(['email_not_verified', 'missing_refresh_token', 'scope_missing']),
});
