import { createHash } from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { notifyMailboxOAuthConnected, resolveMailboxOAuthTarget, saveMailboxOAuthAccount } from '../services/accounts/mailboxOAuthAccount.js';
import { normalizeEmail } from '../services/auth/userIdentity.js';
import { getMailboxOAuthConfig, mailboxOAuthRedirectConfigured } from '../services/integrations/mailboxOAuth.js';
import { consumeOAuthState, createOAuthState } from '../services/oauth/oauthState.js';
import { allowedRequestOrigin } from '../utils/publicOrigins.js';

const START_ERRORS = {
  email_invalid: 400, invalid_state: 400, already_connected: 409, not_configured: 409, authentication_failed: 502,
};
const rejectStart = (res, code) => res.status(START_ERRORS[code]).json({ error: code, code });

function bindSession(req, config) {
  return createHash('sha256').update(JSON.stringify([req.sessionID, config.redirectUri, config.clientId])).digest('base64url');
}

export function createMailboxOAuthRedirectRoutes({ provider, buildAuthorizationUrl, exchangeCode, proveIdentity, providerErrors }) {
  const apiRoutes = Router();
  const callbackRoutes = Router();
  const errorRedirect = (res, code) => res.redirect(`/?oauth_error=${code}&oauth_provider=${provider}`);

  async function configForRequest(req) {
    const origin = allowedRequestOrigin(req);
    if (!origin) return null;
    const config = await getMailboxOAuthConfig(provider);
    return mailboxOAuthRedirectConfigured(provider, config, origin) ? config : null;
  }

  apiRoutes.post('/start', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const target = await resolveMailboxOAuthTarget(provider, req.body);
    if (target.error) return rejectStart(res, target.error);
    if (!req.sessionID) return rejectStart(res, 'invalid_state');
    const config = await configForRequest(req);
    if (!config) return rejectStart(res, 'not_configured');

    try {
      const { state, codeChallenge } = await createOAuthState({
        provider, userId: req.session.userId, ...target, sessionBinding: bindSession(req, config),
      });
      const authorizationUrl = await buildAuthorizationUrl({
        clientId: config.clientId, redirectUri: config.redirectUri, loginHint: target.email, state, codeChallenge,
      });
      return res.json({ authorizationUrl });
    } catch {
      return rejectStart(res, 'authentication_failed');
    }
  });

  callbackRoutes.get('/callback', requireAuth, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    try {
      const pending = await consumeOAuthState({ provider, state: req.query.state });
      if (!req.sessionID || !pending || pending.userId !== req.session.userId) return errorRedirect(res, 'invalid_state');
      const discoverEmail = provider === 'mailru' && pending.mode === 'discover' && !pending.email && !pending.accountId;
      if (!discoverEmail && (!pending.email || !['add', 'reconnect'].includes(pending.mode))) {
        return errorRedirect(res, 'invalid_state');
      }
      const config = await configForRequest(req);
      if (!config) return errorRedirect(res, 'not_configured');
      if (pending.sessionBinding !== bindSession(req, config)) return errorRedirect(res, 'invalid_state');
      if (req.query.error === 'access_denied') return errorRedirect(res, 'access_denied');
      if (req.query.error !== undefined || typeof req.query.code !== 'string' || !req.query.code) {
        return errorRedirect(res, 'authentication_failed');
      }
      const tokens = await exchangeCode({ ...config, code: req.query.code, codeVerifier: pending.codeVerifier });
      const identity = await proveIdentity(tokens, config, pending.email);
      if (!identity) return errorRedirect(res, 'account_mismatch');
      const email = discoverEmail ? normalizeEmail(identity.email) : pending.email;
      if (!email) return errorRedirect(res, 'email_not_verified');
      const target = discoverEmail ? { ...pending, mode: 'add', email } : pending;
      const saved = await saveMailboxOAuthAccount({ provider, pending: target, identity, tokens, config });
      if (saved.error) return errorRedirect(res, saved.error);
      notifyMailboxOAuthConnected(req.app.get('imapManager'), { provider, saved, userId: pending.userId });
      return res.redirect(`/?oauth_success=${provider}&oauth_result=${saved.result}`);
    } catch (err) {
      return errorRedirect(res, providerErrors.has(err?.code) ? err.code : 'authentication_failed');
    }
  });

  return { apiRoutes, callbackRoutes };
}
