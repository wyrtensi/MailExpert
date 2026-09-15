import { Router } from 'express';
import { withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { encrypt } from '../services/encryption.js';
import { redactEmail } from '../utils/redact.js';
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  hasGoogleMailScope,
  verifyGoogleIdToken,
} from '../services/oauth/googleOAuth.js';
import { recordGoogleGrant, resolveGoogleConfig } from '../services/oauth/googleApps.js';
import { createOAuthState, consumeOAuthState } from '../services/oauth/oauthState.js';
import { allowedRequestOrigin } from '../utils/publicOrigins.js';

// Mounted at /oauth/google. Redirect targets carry only stable codes — never provider
// error text, authorization codes or tokens.
const router = Router();

const PROVIDER = 'google';
// Codes the panel knows how to render; anything else collapses to authentication_failed.
const CALLBACK_ERROR_CODES = new Set([
  'access_denied', 'invalid_state', 'not_configured', 'email_not_verified',
  'missing_refresh_token', 'scope_missing', 'authentication_failed',
]);
const ACCOUNT_COLORS = ['#ea4335', '#4285f4', '#34a853', '#fbbc05'];
const LOGIN_HINT_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

class CallbackError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const errorRedirect = (code) => `/?oauth_error=${code}&oauth_provider=${PROVIDER}`;

// Step 1: create state + PKCE and send the user to Google's consent screen.
router.get('/', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });

  const rawHint = typeof req.query.login_hint === 'string' ? req.query.login_hint.trim() : '';
  const loginHint = LOGIN_HINT_PATTERN.test(rawHint) ? rawHint : null;

  try {
    const config = await resolveGoogleConfig({ origin: allowedRequestOrigin(req) });
    if (!config) return res.redirect(errorRedirect('not_configured'));
    const { state, codeChallenge } = await createOAuthState({
      provider: PROVIDER,
      userId: req.session.userId,
      loginHint,
      appId: config.appId,
    });
    res.redirect(buildGoogleAuthorizationUrl({
      clientId: config.clientId,
      state,
      codeChallenge,
      redirectUri: config.redirectUri,
      loginHint,
    }));
  } catch (err) {
    console.error(`Google OAuth start failed: ${err?.name || 'Error'}`);
    res.redirect(errorRedirect('authentication_failed'));
  }
});

// Step 2: Google redirects back with a code (or an error) and the state.
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  try {
    // Consume first so a state is burned whatever the outcome.
    const pending = await consumeOAuthState({ provider: PROVIDER, state });

    if (error !== undefined) {
      throw new CallbackError(error === 'access_denied' ? 'access_denied' : 'authentication_failed');
    }
    // The flow must finish in the same MailExpert session that started it.
    if (!pending || !req.session?.userId || req.session.userId !== pending.userId) {
      throw new CallbackError('invalid_state');
    }
    // Finish with the app chosen at start: its client is the one Google issued the code to.
    const config = await resolveGoogleConfig({ appId: pending.appId, origin: allowedRequestOrigin(req) });
    if (!config) throw new CallbackError('not_configured');
    if (typeof code !== 'string' || !code) throw new CallbackError('authentication_failed');

    const tokens = await exchangeGoogleCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: config.redirectUri,
    });
    const identity = await verifyGoogleIdToken({ idToken: tokens.idToken, clientId: config.clientId });
    // Google counts this account against the app's user cap once it issued tokens, even if
    // the consent is refused below.
    await recordGoogleGrant({ appId: config.appId, email: identity.email, sub: identity.sub });
    if (!hasGoogleMailScope(tokens.scope)) throw new CallbackError('scope_missing');

    const { account, result } = await upsertGoogleAccount(pending.userId, identity, tokens, config.appId);

    reconnectAccount(account, result);
    res.redirect(`/?oauth_success=${PROVIDER}&oauth_result=${result}`);
  } catch (err) {
    const stable = typeof err?.code === 'string' && CALLBACK_ERROR_CODES.has(err.code)
      ? err.code
      : 'authentication_failed';
    // Log the stable code and error class only; messages may carry provider details.
    console.error(`Google OAuth callback failed: ${stable} (${err?.name || 'Error'})`);
    res.redirect(errorRedirect(stable));
  }
});

// Create or update the Gmail account for (userId, email) under a transaction-scoped
// advisory lock so racing callbacks for one mailbox cannot insert duplicates. The account
// is bound to the app whose client issued the tokens.
async function upsertGoogleAccount(userId, identity, tokens, appId) {
  const email = identity.email.toLowerCase();
  const encryptedAccess = encrypt(tokens.accessToken);
  const encryptedRefresh = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth-account:${userId}:${email}`]);

    const existing = await client.query(
      `SELECT id, oauth_refresh_token, oauth_app_id FROM email_accounts
       WHERE user_id = $1 AND lower(email_address) = lower($2)
       ORDER BY created_at LIMIT 1`,
      [userId, email],
    );

    let accountId;
    let result;
    if (existing.rows.length) {
      const row = existing.rows[0];
      // A stored refresh token only works with the app that issued it, so it can be kept
      // only when the account stays on the same app.
      const canKeepStoredRefresh = !!row.oauth_refresh_token && row.oauth_app_id === appId;
      if (!encryptedRefresh && !canKeepStoredRefresh) throw new CallbackError('missing_refresh_token');
      accountId = row.id;
      result = 'updated';
      await client.query(`
        UPDATE email_accounts SET
          oauth_access_token = $1,
          oauth_refresh_token = COALESCE($2, oauth_refresh_token),
          oauth_token_expiry = $3,
          oauth_provider = 'google', oauth_public_client = false, auth_user = email_address,
          imap_host = 'imap.gmail.com', imap_port = 993, imap_tls = true,
          smtp_host = 'smtp.gmail.com', smtp_port = 465, smtp_tls = 'SSL',
          oauth_app_id = $4, oauth_subject = $5,
          oauth_reconnect_required = false, sync_error = NULL
        WHERE id = $6
      `, [encryptedAccess, encryptedRefresh, tokens.expiresAt, appId, identity.sub, accountId]);
    } else {
      if (!encryptedRefresh) throw new CallbackError('missing_refresh_token');
      const color = ACCOUNT_COLORS[Math.floor(Math.random() * ACCOUNT_COLORS.length)];
      const inserted = await client.query(`
        INSERT INTO email_accounts (
          user_id, name, email_address, color, protocol,
          imap_host, imap_port, imap_tls,
          smtp_host, smtp_port, smtp_tls,
          auth_user,
          oauth_provider, oauth_access_token, oauth_refresh_token, oauth_token_expiry,
          oauth_public_client, oauth_reconnect_required, include_in_unified_inbox,
          oauth_app_id, oauth_subject
        ) VALUES ($1, $2, $3, $4, 'imap',
          'imap.gmail.com', 993, true,
          'smtp.gmail.com', 465, 'SSL',
          $3,
          'google', $5, $6, $7,
          false, false, false,
          $8, $9)
        RETURNING id
      `, [userId, identity.name || email, email, color, encryptedAccess, encryptedRefresh, tokens.expiresAt, appId, identity.sub]);
      accountId = inserted.rows[0].id;
      result = 'created';
    }

    const accountResult = await client.query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    return { account: accountResult.rows[0], result };
  });
}

// Bring the mailbox online with the new tokens. An updated account may still hold a
// connection built from the old (possibly revoked) token, so restart it.
function reconnectAccount(account, result) {
  const connect = () => {
    // Fresh tokens from a (re)consent: lift any auth cooldown left by the old, rejected grant.
    imapManager.clearConnectCooldown(account.id);
    return imapManager.connectAccount(account);
  };
  const run = result === 'updated'
    ? Promise.resolve(imapManager.disconnectAccount(account.id)).catch(() => {}).then(connect)
    : connect();
  Promise.resolve(run).catch((err) =>
    console.error(`Google OAuth connect failed for ${redactEmail(account.email_address)}: ${err?.name || 'Error'}`),
  );
}

export default router;
