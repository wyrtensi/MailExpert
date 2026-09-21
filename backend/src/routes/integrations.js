import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt, isEncrypted } from '../services/encryption.js';
import {
  GoogleAppError,
  getDefaultGoogleApp,
  importLegacyGoogleConfig,
  resolveGoogleConfig,
  saveDefaultGoogleAppCompat,
  setGoogleAppStatus,
} from '../services/oauth/googleApps.js';
import { googleHasCapacity } from '../services/oauth/googleAppSelection.js';

const router = Router();

// Placeholder sent instead of a stored client secret; posting it back keeps the stored value.
const REDACTED_SECRET = '••••••••';

// HTTP status and message for registry errors the single-app Google card can trigger.
const GOOGLE_APP_ERRORS = {
  client_id_invalid: [400, 'Client ID is not a Google OAuth client ID'],
  client_secret_required: [400, 'Client secret is required'],
  app_same_project: [409, 'An app from this Google Cloud project is already added'],
  app_in_use: [409, 'The current Google app still has connected mailboxes'],
};

// Mirror the stored Google callback URL into process.env. Client credentials live in
// google_oauth_apps, so only the redirect URI is kept in integration_config.
function applyGoogleEnv(config) {
  if (config?.redirectUri) process.env.GOOGLE_REDIRECT_URI = config.redirectUri;
  else delete process.env.GOOGLE_REDIRECT_URI;
}

const stringField = (value) => (typeof value === 'string' ? value.trim() : '');

router.use(requireAuth);

// Get all integration configs (secrets redacted) — admin only (exposes OAuth client IDs)
router.get('/', requireAdmin, async (req, res) => {
  const result = await query(
    'SELECT provider, config, updated_at FROM integration_config'
  );

  // Redact secrets from response
  const configs = {};
  for (const row of result.rows) {
    const cfg = { ...row.config };
    if (cfg.clientSecret) cfg.clientSecret = REDACTED_SECRET;
    configs[row.provider] = { ...cfg, updated_at: row.updated_at };
  }
  // The Google card shows the default app's client; any client fields left in the legacy
  // row are ignored.
  const googleApp = await getDefaultGoogleApp();
  if (configs.google || googleApp) {
    const stored = configs.google || {};
    configs.google = {
      ...(googleApp ? { clientId: googleApp.client_id, clientSecret: REDACTED_SECRET } : {}),
      ...(stored.redirectUri ? { redirectUri: stored.redirectUri } : {}),
      ...(stored.updated_at ? { updated_at: stored.updated_at } : {}),
    };
  }
  res.json(configs);
});

// Capability check for any authenticated user (non-admins included). Reports only
// whether each provider is configured — never the client ID, secret, or any other
// credential. This lets a non-admin see that Microsoft OAuth is available and enable
// the connect buttons, while the config read/write/delete endpoints stay admin-only.
// The OAuth connect routes already require only an authenticated session and bind the
// resulting mailbox to that user, so no privilege is granted here. (#315)
// A Redis error from googleHasCapacity must not fail the whole response: Microsoft's
// configured flag has nothing to do with Google's capacity check.
async function googleAvailable(configured) {
  if (!configured) return false;
  try {
    return await googleHasCapacity();
  } catch (err) {
    console.error(`Google OAuth capacity check failed: ${err?.name || 'Error'}`);
    return false;
  }
}

router.get('/status', async (req, res) => {
  const configured = !!(await resolveGoogleConfig());
  res.json({
    microsoft: {
      configured: !!process.env.MS_CLIENT_ID,
    },
    google: {
      configured,
      // Whether an active app still has a free seat: the Gmail option is offered only then.
      available: await googleAvailable(configured),
    },
  });
});

// Save/update integration config — admin only (writes affect global OAuth env vars)
router.post('/:provider', requireAdmin, async (req, res) => {
  const { provider } = req.params;
  const allowed = ['microsoft', 'google'];
  if (!allowed.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });

  const isRedactionMix = (secret) => typeof secret === 'string'
    && secret !== REDACTED_SECRET
    && secret.includes('•');

  if (provider === 'google') {
    const body = req.body || {};
    const clientSecret = stringField(body.clientSecret);
    // A secret that contains the redaction bullet but is not exactly the placeholder was typed
    // into (or around) the redacted field; storing it would replace the real secret with junk.
    if (isRedactionMix(clientSecret)) {
      return res.status(400).json({
        error: 'Client secret contains the redaction placeholder; enter the full secret',
        code: 'client_secret_redacted',
      });
    }
    try {
      await saveDefaultGoogleAppCompat({
        clientId: stringField(body.clientId),
        clientSecret: clientSecret && clientSecret !== REDACTED_SECRET ? clientSecret : null,
      });
    } catch (err) {
      const mapped = err instanceof GoogleAppError ? GOOGLE_APP_ERRORS[err.code] : null;
      if (!mapped) throw err;
      return res.status(mapped[0]).json({ error: mapped[1], code: err.code });
    }
    const redirectUri = stringField(body.redirectUri);
    const googleConfig = redirectUri ? { redirectUri } : {};
    await query(`
      INSERT INTO integration_config (provider, config)
      VALUES ($1, $2)
      ON CONFLICT (provider) DO UPDATE
      SET config = EXCLUDED.config, updated_at = NOW()
    `, [provider, googleConfig]);
    applyGoogleEnv(googleConfig);
    return res.json({ ok: true });
  }

  const config = req.body;

  // A secret that contains the redaction bullet but is not exactly the placeholder was typed into
  // (or around) the redacted field; storing it would silently replace the real secret with junk.
  if (isRedactionMix(config.clientSecret)) {
    return res.status(400).json({
      error: 'Client secret contains the redaction placeholder; enter the full secret',
      code: 'client_secret_redacted',
    });
  }

  // If clientSecret is redacted, keep the existing stored value (already encrypted or legacy plaintext)
  if (config.clientSecret === REDACTED_SECRET) {
    const existing = await query(
      'SELECT config FROM integration_config WHERE provider = $1',
      [provider]
    );
    if (existing.rows.length) {
      config.clientSecret = existing.rows[0].config.clientSecret;
    } else {
      delete config.clientSecret;
    }
  }

  // Encrypt clientSecret at rest — handles both new writes and migration of legacy plaintext values
  if (config.clientSecret && !isEncrypted(config.clientSecret)) {
    config.clientSecret = encrypt(config.clientSecret);
  }

  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = EXCLUDED.config, updated_at = NOW()
  `, [provider, config]);

  // Write plaintext values to process.env so oauth routes pick them up immediately
  if (provider === 'microsoft') {
    if (config.clientId) process.env.MS_CLIENT_ID = config.clientId;
    if (config.clientSecret) process.env.MS_CLIENT_SECRET = decrypt(config.clientSecret);
    if (config.tenantId) process.env.MS_TENANT_ID = config.tenantId;
    if (config.redirectUri) process.env.MS_REDIRECT_URI = config.redirectUri;
  }

  res.json({ ok: true });
});

// Delete integration config — admin only
router.delete('/:provider', requireAdmin, async (req, res) => {
  await query(
    'DELETE FROM integration_config WHERE provider = $1',
    [req.params.provider]
  );
  if (req.params.provider === 'microsoft') {
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
    delete process.env.MS_TENANT_ID;
    delete process.env.MS_REDIRECT_URI;
  } else if (req.params.provider === 'google') {
    // The single-app card removes "the" Google app: disable it so its mailboxes ask for a
    // reconnect, and drop their connections built from its tokens.
    const app = await getDefaultGoogleApp();
    if (app) {
      const accountIds = await setGoogleAppStatus(app.id, 'disabled');
      const manager = req.app.get('imapManager');
      for (const accountId of accountIds) {
        Promise.resolve(manager?.disconnectAccount(accountId)).catch(() => {});
      }
    }
    applyGoogleEnv(null);
  }
  res.json({ ok: true });
});

// Load saved configs into process.env on startup
export async function loadIntegrationConfigs() {
  try {
    const result = await query('SELECT provider, config FROM integration_config');
    for (const row of result.rows) {
      if (row.provider === 'microsoft') {
        const c = row.config;
        if (c.clientId) process.env.MS_CLIENT_ID = c.clientId;
        // decrypt() returns value unchanged for plaintext (migration fallback)
        if (c.clientSecret) process.env.MS_CLIENT_SECRET = decrypt(c.clientSecret);
        if (c.tenantId) process.env.MS_TENANT_ID = c.tenantId;
        if (c.redirectUri) process.env.MS_REDIRECT_URI = c.redirectUri;
      } else if (row.provider === 'google') {
        applyGoogleEnv(row.config);
      }
    }
    console.log('Integration configs loaded');
  } catch (err) {
    console.error('Failed to load integration configs:', err.message);
  }
  // Runs after the stored callback URL is applied; logs only a code so a failure never
  // prints SQL, secrets or provider text.
  try {
    await importLegacyGoogleConfig();
  } catch (err) {
    console.error(`Google OAuth app import failed: ${err?.code || err?.name || 'Error'}`);
  }
}

export default router;
