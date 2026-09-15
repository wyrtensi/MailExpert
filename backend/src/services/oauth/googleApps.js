import { query, withTransaction } from '../db.js';
import { encrypt, decrypt } from '../encryption.js';

// Google OAuth apps: one row per Google Cloud project. OAuth clients of one project share
// its unverified-app user cap, so the project number in the client ID identifies an app.
const GOOGLE_CLIENT_ID_PATTERN = /^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export const GOOGLE_APP_STATUSES = Object.freeze(['active', 'closed', 'disabled']);

const APP_COLUMNS = 'id, label, client_id, client_secret, project_number, user_limit, status, created_at';

// Stable, secret-free error for app registry operations.
export class GoogleAppError extends Error {
  constructor(code) {
    super(`Google OAuth app error: ${code}`);
    this.name = 'GoogleAppError';
    this.code = code;
  }
}

export function parseGoogleClientId(clientId) {
  if (typeof clientId !== 'string') return null;
  const match = GOOGLE_CLIENT_ID_PATTERN.exec(clientId.trim());
  return match ? match[1] : null;
}

export async function getGoogleAppById(appId) {
  if (!appId) return null;
  const { rows } = await query(`SELECT ${APP_COLUMNS} FROM google_oauth_apps WHERE id = $1`, [appId]);
  return rows[0] || null;
}

// The oldest app that is not disabled. Single-app code paths use it until the connect
// flow picks an app per mailbox.
export async function getDefaultGoogleApp() {
  const { rows } = await query(
    `SELECT ${APP_COLUMNS} FROM google_oauth_apps WHERE status <> 'disabled' ORDER BY created_at, id LIMIT 1`,
  );
  return rows[0] || null;
}

// The callback URL registered for every app. A browser that came through another public
// origin (APP_ALT_URLS) is sent back to that origin, on the same path.
export function getGoogleRedirectUri(origin = null) {
  const configured = process.env.GOOGLE_REDIRECT_URI || null;
  if (!configured || !origin) return configured;
  try {
    return `${origin}${new URL(configured).pathname}`;
  } catch {
    return configured;
  }
}

// Credentials for one consent flow: the given app, or the default app. Null when the
// callback URL is missing, the app is missing or disabled, or its secret cannot be decrypted.
export async function resolveGoogleConfig({ appId = null, origin = null } = {}) {
  const redirectUri = getGoogleRedirectUri(origin);
  if (!redirectUri) return null;
  const app = appId ? await getGoogleAppById(appId) : await getDefaultGoogleApp();
  if (!app || app.status === 'disabled') return null;
  const clientSecret = decrypt(app.client_secret);
  if (!clientSecret) return null;
  return { appId: app.id, clientId: app.client_id, clientSecret, redirectUri };
}

// Journal the Google account an app issued tokens to. Google counts it against the app's
// user cap from that moment, so rows are kept when the mailbox is removed.
export async function recordGoogleGrant({ appId, email, sub = null }, db = { query }) {
  await db.query(
    `INSERT INTO google_oauth_grants (app_id, email, google_sub) VALUES ($1, lower($2), $3)
     ON CONFLICT (app_id, email) DO UPDATE SET google_sub = COALESCE(google_oauth_grants.google_sub, EXCLUDED.google_sub)`,
    [appId, email, sub],
  );
}

// Change an app's status. Disabling flags its mailboxes for reconnect through another app and
// returns their ids so the caller can drop their IMAP connections.
export async function setGoogleAppStatus(appId, status) {
  if (!GOOGLE_APP_STATUSES.includes(status)) throw new GoogleAppError('app_status_invalid');
  return withTransaction(async (client) => {
    const updated = await client.query(
      'UPDATE google_oauth_apps SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING id',
      [appId, status],
    );
    if (!updated.rows.length) throw new GoogleAppError('app_not_found');
    if (status !== 'disabled') return [];
    const flagged = await client.query(
      `UPDATE email_accounts SET oauth_reconnect_required = true, sync_error = 'oauth_reconnect_required'
       WHERE oauth_app_id = $1 RETURNING id`,
      [appId],
    );
    return flagged.rows.map((row) => row.id);
  });
}

// One-time import of the single-app settings (Settings → Integrations, or the
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment) as the first app. Runs at every
// startup and does nothing once any app exists.
export async function importLegacyGoogleConfig() {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-import'))");
    const existing = await client.query('SELECT 1 FROM google_oauth_apps LIMIT 1');
    if (existing.rows.length) return null;

    const stored = await client.query("SELECT config FROM integration_config WHERE provider = 'google'");
    const config = stored.rows[0]?.config || {};
    let source = null;
    if (config.clientId && config.clientSecret) {
      source = { from: 'the stored integration settings', clientId: config.clientId, clientSecret: decrypt(config.clientSecret) };
    } else if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      source = { from: 'the environment', clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
    }
    if (!source) return null;

    const projectNumber = parseGoogleClientId(source.clientId);
    if (!projectNumber) {
      console.error(`Google OAuth: the client ID from ${source.from} is not a Google OAuth client ID; add the app again in Settings → Integrations`);
      return null;
    }
    if (!source.clientSecret) {
      console.error(`Google OAuth: the client secret from ${source.from} cannot be decrypted; add the app again in Settings → Integrations`);
      return null;
    }

    const inserted = await client.query(
      `INSERT INTO google_oauth_apps (label, client_id, client_secret, project_number)
       VALUES ('Google 1', $1, $2, $3) RETURNING id`,
      [source.clientId.trim(), encrypt(source.clientSecret), projectNumber],
    );
    const appId = inserted.rows[0].id;
    await client.query(
      `UPDATE email_accounts SET oauth_app_id = $1 WHERE oauth_provider = 'google' AND oauth_app_id IS NULL`,
      [appId],
    );
    await client.query(
      `INSERT INTO google_oauth_grants (app_id, email)
       SELECT DISTINCT $1::uuid, lower(email_address) FROM email_accounts WHERE oauth_app_id = $1
       ON CONFLICT (app_id, email) DO NOTHING`,
      [appId],
    );
    if (stored.rows.length) {
      await client.query(
        `UPDATE integration_config
         SET config = jsonb_strip_nulls(jsonb_build_object('redirectUri', config->'redirectUri')), updated_at = NOW()
         WHERE provider = 'google'`,
      );
    }
    console.log(`Google OAuth: imported the client from ${source.from} as app "Google 1"`);
    return appId;
  });
}

// Compatibility for the single-app settings card until the multi-app admin UI replaces it:
// saving a client ID updates that app (re-activating it), or replaces the default app when
// the default has no mailboxes yet. `clientSecret` null keeps the stored secret.
export async function saveDefaultGoogleAppCompat({ clientId, clientSecret }) {
  const projectNumber = parseGoogleClientId(clientId);
  if (!projectNumber) throw new GoogleAppError('client_id_invalid');
  const normalizedClientId = clientId.trim();

  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-import'))");

    const same = await client.query('SELECT id FROM google_oauth_apps WHERE client_id = $1', [normalizedClientId]);
    if (same.rows.length) {
      const appId = same.rows[0].id;
      await client.query(
        `UPDATE google_oauth_apps SET status = 'active', client_secret = COALESCE($2, client_secret), updated_at = NOW()
         WHERE id = $1`,
        [appId, clientSecret ? encrypt(clientSecret) : null],
      );
      return appId;
    }
    if (!clientSecret) throw new GoogleAppError('client_secret_required');

    const current = await client.query(
      `SELECT a.id, (SELECT count(*) FROM email_accounts e WHERE e.oauth_app_id = a.id)::int AS accounts
       FROM google_oauth_apps a WHERE a.status <> 'disabled' ORDER BY a.created_at, a.id LIMIT 1`,
    );
    if (current.rows.length) {
      if (current.rows[0].accounts > 0) throw new GoogleAppError('app_in_use');
      await client.query('DELETE FROM google_oauth_apps WHERE id = $1', [current.rows[0].id]);
    }

    const taken = await client.query('SELECT 1 FROM google_oauth_apps WHERE project_number = $1', [projectNumber]);
    if (taken.rows.length) throw new GoogleAppError('app_same_project');

    const inserted = await client.query(
      `INSERT INTO google_oauth_apps (label, client_id, client_secret, project_number)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Google 1', normalizedClientId, encrypt(clientSecret), projectNumber],
    );
    return inserted.rows[0].id;
  });
}
