import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { buildGoogleAuthorizationUrl } from '../services/oauth/googleOAuth.js';
import { findKnownGoogleEmails, resolveGoogleConfig } from '../services/oauth/googleApps.js';
import { GoogleAppSelectionError, releaseGoogleSeat, selectGoogleApp } from '../services/oauth/googleAppSelection.js';
import { createOAuthState } from '../services/oauth/oauthState.js';
import { GOOGLE_EMAIL_PATTERN, createGoogleLaunch } from '../services/oauth/googleLaunch.js';
import { allowedRequestOrigin } from '../utils/publicOrigins.js';

// Mounted at /api/oauth/google. Starting a flow reserves a seat, so it lives under /api where
// the X-Requested-With check and the screen lock apply; the browser then follows a one-time
// /oauth/google/launch path to Google.
const router = Router();
router.use(requireAuth);

const PROVIDER = 'google';
const QUERY_MIN = 2;
const QUERY_MAX = 254;

router.post('/start', async (req, res) => {
  const raw = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!GOOGLE_EMAIL_PATTERN.test(raw)) return res.status(400).json({ error: 'Enter a valid email address', code: 'email_invalid' });
  const email = raw.toLowerCase();

  // Mailboxes are shared: an address any user already connected is connected for everyone.
  const existing = await query('SELECT id FROM email_accounts WHERE lower(email_address) = $1 LIMIT 1', [email]);
  if (existing.rows.length) return res.status(409).json({ error: 'This mailbox is already connected', code: 'already_connected' });

  let selected;
  try {
    selected = await selectGoogleApp({ email });
  } catch (err) {
    if (err instanceof GoogleAppSelectionError) return res.status(409).json({ error: 'Gmail cannot be connected now', code: err.code });
    throw err;
  }

  const config = await resolveGoogleConfig({ appId: selected.appId, origin: allowedRequestOrigin(req) });
  if (!config) {
    if (selected.reserved) await releaseGoogleSeat(selected.appId, email);
    return res.status(409).json({ error: 'Gmail cannot be connected now', code: 'not_configured' });
  }

  try {
    const { state, codeChallenge } = await createOAuthState({
      provider: PROVIDER, userId: req.session.userId, loginHint: email, appId: config.appId, mode: 'add', email,
    });
    const url = buildGoogleAuthorizationUrl({
      clientId: config.clientId, state, codeChallenge, redirectUri: config.redirectUri, loginHint: email,
    });
    const flow = await createGoogleLaunch({ userId: req.session.userId, url });
    res.json({ path: `/oauth/google/launch?flow=${flow}` });
  } catch (err) {
    // A late failure here would otherwise leave the seat reserved for the full state TTL.
    if (selected.reserved) await releaseGoogleSeat(selected.appId, email);
    throw err;
  }
});

router.get('/known-emails', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < QUERY_MIN || q.length > QUERY_MAX) {
    return res.status(400).json({ error: 'Query must be 2 to 254 characters', code: 'query_invalid' });
  }
  res.json({ emails: await findKnownGoogleEmails(q) });
});

export default router;
