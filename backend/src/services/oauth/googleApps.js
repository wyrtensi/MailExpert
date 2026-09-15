import { query, withTransaction } from '../db.js';
import { decrypt } from '../encryption.js';

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

export function getGoogleRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || null;
}

// Credentials for one consent flow: the given app, or the default app. Null when the
// callback URL is missing, the app is missing or disabled, or its secret cannot be decrypted.
export async function resolveGoogleConfig({ appId = null } = {}) {
  const redirectUri = getGoogleRedirectUri();
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
