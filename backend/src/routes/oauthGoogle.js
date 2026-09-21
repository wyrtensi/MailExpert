import { Router } from 'express';
import { query, withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { recordAudit } from '../services/auditLog.js';
import { redactEmail } from '../utils/redact.js';
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  hasGoogleMailScope,
  revokeGoogleToken,
  verifyGoogleIdToken,
} from '../services/oauth/googleOAuth.js';
import { recordGoogleGrant, resolveGoogleConfig } from '../services/oauth/googleApps.js';
import { createOAuthState, consumeOAuthState } from '../services/oauth/oauthState.js';
import { GoogleAppSelectionError, releaseGoogleSeat, selectGoogleApp } from '../services/oauth/googleAppSelection.js';
import { GOOGLE_EMAIL_PATTERN, consumeGoogleLaunch } from '../services/oauth/googleLaunch.js';
import { allowedRequestOrigin } from '../utils/publicOrigins.js';
import { isUuid } from '../utils/uuid.js';

// Mounted at /oauth/google. Redirect targets carry only stable codes — never provider
// error text, authorization codes or tokens.
const router = Router();

const PROVIDER = 'google';
// Codes the panel knows how to render; anything else collapses to authentication_failed.
const CALLBACK_ERROR_CODES = new Set([
  'access_denied', 'invalid_state', 'not_configured', 'email_not_verified',
  'missing_refresh_token', 'scope_missing', 'authentication_failed',
  'already_connected', 'account_mismatch', 'no_app_capacity',
]);
const ACCOUNT_COLORS = ['#ea4335', '#4285f4', '#34a853', '#fbbc05'];

class CallbackError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const errorRedirect = (code) => `/?oauth_error=${code}&oauth_provider=${PROVIDER}`;

// What a start request asks for. `?account=<id>` reconnects that mailbox. Until the new
// "Add account" dialog ships, the old entry points keep working: `?login_hint=<email>` reconnects
// the Gmail mailbox with that address or adds it, and no parameter at all adds or updates
// whichever account the user picks at Google.
async function resolveStartTarget(req) {
  if (req.query.account !== undefined) {
    const id = typeof req.query.account === 'string' ? req.query.account : '';
    if (!isUuid(id)) throw new CallbackError('invalid_state');
    const { rows } = await query(
      'SELECT id, email_address, oauth_provider, oauth_app_id FROM email_accounts WHERE id = $1',
      [id],
    );
    const account = rows[0];
    if (!account || account.oauth_provider !== PROVIDER) throw new CallbackError('invalid_state');
    return { mode: 'reconnect', email: account.email_address.toLowerCase(), account };
  }

  const rawHint = typeof req.query.login_hint === 'string' ? req.query.login_hint.trim() : '';
  if (!GOOGLE_EMAIL_PATTERN.test(rawHint)) return { mode: 'upsert', email: null, account: null };
  const email = rawHint.toLowerCase();
  const { rows } = await query(
    `SELECT id, email_address, oauth_provider, oauth_app_id FROM email_accounts
     WHERE lower(email_address) = $1 ORDER BY created_at LIMIT 1`,
    [email],
  );
  const account = rows[0];
  if (account?.oauth_provider === PROVIDER) return { mode: 'reconnect', email, account };
  return { mode: 'add', email, account: null };
}

// Step 1: pick the app, create state + PKCE and send the user to Google's consent screen.
router.get('/', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });

  let selected = null;
  let target = null;
  try {
    target = await resolveStartTarget(req);
    selected = await selectGoogleApp({ email: target.email, account: target.account });
    const config = await resolveGoogleConfig({ appId: selected.appId, origin: allowedRequestOrigin(req) });
    if (!config) throw new CallbackError('not_configured');
    const { state, codeChallenge } = await createOAuthState({
      provider: PROVIDER,
      userId: req.session.userId,
      loginHint: target.email,
      appId: config.appId,
      mode: target.mode,
      email: target.email,
      accountId: target.account?.id ?? null,
    });
    res.redirect(buildGoogleAuthorizationUrl({
      clientId: config.clientId,
      state,
      codeChallenge,
      redirectUri: config.redirectUri,
      loginHint: target.email,
    }));
  } catch (err) {
    if (selected?.reserved) await releaseGoogleSeat(selected.appId, target.email);
    const known = err instanceof CallbackError || err instanceof GoogleAppSelectionError;
    if (!known) console.error(`Google OAuth start failed: ${err?.name || 'Error'}`);
    res.redirect(errorRedirect(known ? err.code : 'authentication_failed'));
  }
});

// Step 1b of the Gmail form: follow the one-time path created by POST /api/oauth/google/start.
router.get('/launch', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const flow = typeof req.query.flow === 'string' ? req.query.flow : '';
  const url = await consumeGoogleLaunch({ flow, userId: req.session.userId });
  res.redirect(url || errorRedirect('invalid_state'));
});

// Step 2: Google redirects back with a code (or an error) and the state.
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  let issued = null;
  let pending = null;
  // Kept reserved until the grant is journaled, so a concurrent start never sees this seat as
  // free while the code exchange is in flight; released as soon as the journal write lands, or
  // in the catch below on any path that ends before that.
  let released = false;

  try {
    // Consume first so a state is burned whatever the outcome.
    pending = await consumeOAuthState({ provider: PROVIDER, state });

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
    issued = { appId: config.appId, tokens, email: identity.email };
    // Google counts this account against the app's user cap once it issued tokens, even if
    // the consent is refused below.
    await recordGoogleGrant({ appId: config.appId, email: identity.email, sub: identity.sub });
    // Now that the journal has the email, the reservation can go. A brief double count
    // (reservation + grant) is intended: it is only more conservative than the alternative of
    // releasing before the exchange, which would let the seat look free while it is in flight.
    if (pending.appId && pending.email) {
      await releaseGoogleSeat(pending.appId, pending.email);
      released = true;
    }
    // The user may pick another Google account on Google's page than the one asked for.
    if (pending.email && identity.email.toLowerCase() !== pending.email) throw new CallbackError('account_mismatch');
    if (!hasGoogleMailScope(tokens.scope)) throw new CallbackError('scope_missing');

    const { account, result, previousAppId, previousRefreshToken } =
      await upsertGoogleAccount(pending, identity, tokens, config.appId);
    issued = null; // the tokens are stored now: nothing to revoke
    recordGoogleConsent({ userId: pending.userId, account, result, previousAppId, appId: config.appId });
    if (result === 'updated' && previousAppId && previousAppId !== config.appId) {
      // The old token belongs to a client the mailbox left; best effort, the reply does not wait.
      revokeGoogleToken(decrypt(previousRefreshToken)).catch(() => {});
    }

    reconnectAccount(account, result);
    res.redirect(`/?oauth_success=${PROVIDER}&oauth_result=${result}`);
  } catch (err) {
    const stable = typeof err?.code === 'string' && CALLBACK_ERROR_CODES.has(err.code)
      ? err.code
      : 'authentication_failed';
    // Log the stable code and error class only; messages may carry provider details.
    console.error(`Google OAuth callback failed: ${stable} (${err?.name || 'Error'})`);
    if (pending?.appId && pending.email && !released) await releaseGoogleSeat(pending.appId, pending.email);
    if (issued) await revokeRefusedGrant(issued);
    res.redirect(errorRedirect(stable));
  }
});

// A refused consent must not leave a live grant behind. Google revokes a person's access to the
// whole project, not to one token, so skip it when that address already has a working mailbox on
// this app: revoking would cut that mailbox off too.
async function revokeRefusedGrant({ appId, tokens, email }) {
  try {
    const { rows } = await query(
      'SELECT 1 FROM email_accounts WHERE lower(email_address) = lower($1) AND oauth_app_id = $2 LIMIT 1',
      [email, appId],
    );
    if (rows.length) return;
    await revokeGoogleToken(tokens.refreshToken || tokens.accessToken);
  } catch (err) {
    console.error(`Google OAuth refused-grant cleanup failed: ${err?.name || 'Error'}`);
  }
}

// Create or update the Gmail mailbox with this address under a transaction-scoped advisory
// lock so racing callbacks for one mailbox cannot insert duplicates. Mailboxes are shared, so
// the address alone names one; userId only records who added it. The account is bound to the
// app whose client issued the tokens.
async function upsertGoogleAccount(pending, identity, tokens, appId) {
  const email = identity.email.toLowerCase();
  const encryptedAccess = encrypt(tokens.accessToken);
  const encryptedRefresh = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth-account:${email}`]);

    const existing = await client.query(
      `SELECT id, oauth_provider, oauth_refresh_token, oauth_app_id, oauth_subject FROM email_accounts
       WHERE lower(email_address) = lower($1)
       ORDER BY created_at LIMIT 1`,
      [email],
    );
    const row = existing.rows[0] || null;
    if (pending.mode === 'add' && row) throw new CallbackError('already_connected');
    if (pending.mode === 'reconnect' && (!row || row.id !== pending.accountId || row.oauth_provider !== PROVIDER)) {
      throw new CallbackError('invalid_state');
    }
    // A Gmail address is never reissued, so another subject means another Google account.
    if (row?.oauth_subject && row.oauth_subject !== identity.sub) throw new CallbackError('account_mismatch');

    let accountId;
    let result;
    let previousAppId = null;
    if (row) {
      previousAppId = row.oauth_app_id;
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
          added_by, name, email_address, color, protocol,
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
      `, [pending.userId, identity.name || email, email, color, encryptedAccess, encryptedRefresh, tokens.expiresAt, appId, identity.sub]);
      accountId = inserted.rows[0].id;
      result = 'created';
    }

    const accountResult = await client.query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    return { account: accountResult.rows[0], result, previousAppId, previousRefreshToken: row?.oauth_refresh_token ?? null };
  });
}

// Journal the consent: a new mailbox is an addition, an existing one a reconnect, and moving the
// mailbox to another Google app also changes its connection.
function recordGoogleConsent({ userId, account, result, previousAppId, appId }) {
  const entry = { actorUserId: userId, accountId: account.id };
  if (result === 'created') {
    recordAudit([{ ...entry, action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: PROVIDER } }]);
    return;
  }
  const entries = [{ ...entry, action: 'mailbox.reconnected', details: { oauthProvider: PROVIDER } }];
  if (previousAppId !== appId) {
    entries.push({ ...entry, action: 'mailbox.connection_changed', details: { fields: ['oauth_app_id'] } });
  }
  recordAudit(entries);
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
