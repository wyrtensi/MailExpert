import { createHash } from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { notifyMailboxOAuthConnected, resolveMailboxOAuthTarget, saveMailboxOAuthAccount } from '../services/accounts/mailboxOAuthAccount.js';
import { normalizeEmail } from '../services/auth/userIdentity.js';
import { getMailboxOAuthConfig } from '../services/integrations/mailboxOAuth.js';
import { buildMailruAuthorizationUrl, exchangeMailruCode, fetchMailruIdentity } from '../services/oauth/mailruOAuth.js';
import { consumeOAuthState, createOAuthState } from '../services/oauth/oauthState.js';
import { allowedRequestOrigin } from '../utils/publicOrigins.js';

export const mailruApiRoutes = Router();
export const mailruCallbackRoutes = Router();
const MAILRU_PROVIDER = 'mailru';

const START_ERRORS = {
  email_invalid: 400, invalid_state: 400, already_connected: 409, not_configured: 409, authentication_failed: 502,
};
const PROVIDER_ERRORS = new Set(['email_not_verified', 'missing_refresh_token', 'scope_missing']);
const rejectStart = (res, code) => res.status(START_ERRORS[code]).json({ error: code, code });
const errorRedirect = (res, code) => res.redirect(`/?oauth_error=${code}&oauth_provider=mailru`);

async function configForRequest(req) {
  const origin = allowedRequestOrigin(req);
  if (!origin) return null;
  const config = await getMailboxOAuthConfig(MAILRU_PROVIDER);
  return config && new URL(config.redirectUri).origin === origin ? config : null;
}

function bindSession(req, config) {
  return createHash('sha256').update(JSON.stringify([req.sessionID, config.redirectUri, config.clientId])).digest('base64url');
}

mailruApiRoutes.post('/start', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const target = await resolveMailboxOAuthTarget(MAILRU_PROVIDER, req.body);
  if (target.error) return rejectStart(res, target.error);
  if (!req.sessionID) return rejectStart(res, 'invalid_state');
  const config = await configForRequest(req);
  if (!config) return rejectStart(res, 'not_configured');

  try {
    const { state, codeChallenge } = await createOAuthState({
      provider: MAILRU_PROVIDER, userId: req.session.userId, ...target, sessionBinding: bindSession(req, config),
    });
    const authorizationUrl = await buildMailruAuthorizationUrl({
      clientId: config.clientId, redirectUri: config.redirectUri, state, codeChallenge,
    });
    return res.json({ authorizationUrl });
  } catch {
    return rejectStart(res, 'authentication_failed');
  }
});

mailruCallbackRoutes.get('/callback', requireAuth, async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  try {
    const pending = await consumeOAuthState({ provider: MAILRU_PROVIDER, state: req.query.state });
    if (!req.sessionID || pending?.userId !== req.session.userId || !pending.email ||
        !['add', 'reconnect'].includes(pending.mode)) return errorRedirect(res, 'invalid_state');
    const config = await configForRequest(req);
    if (!config) return errorRedirect(res, 'not_configured');
    if (pending.sessionBinding !== bindSession(req, config)) return errorRedirect(res, 'invalid_state');
    if (req.query.error === 'access_denied') return errorRedirect(res, 'access_denied');
    if (req.query.error !== undefined || typeof req.query.code !== 'string' || !req.query.code) {
      return errorRedirect(res, 'authentication_failed');
    }
    const tokens = await exchangeMailruCode({ ...config, code: req.query.code, codeVerifier: pending.codeVerifier });
    const identity = await fetchMailruIdentity(tokens.accessToken);
    if (normalizeEmail(identity.email) !== pending.email) return errorRedirect(res, 'account_mismatch');
    const saved = await saveMailboxOAuthAccount({ provider: MAILRU_PROVIDER, pending, identity, tokens, config });
    if (saved.error) return errorRedirect(res, saved.error);

    notifyMailboxOAuthConnected(req.app.get('imapManager'), { provider: MAILRU_PROVIDER, saved, userId: pending.userId });
    return res.redirect(`/?oauth_success=mailru&oauth_result=${saved.result}`);
  } catch (err) {
    const code = PROVIDER_ERRORS.has(err?.code) ? err.code : 'authentication_failed';
    return errorRedirect(res, code);
  }
});
