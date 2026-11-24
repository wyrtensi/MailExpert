import { query, withTransaction } from '../db.js';
import { decrypt, encrypt, isEncrypted } from '../encryption.js';
import { getPublicOrigins } from '../../utils/publicOrigins.js';
import { REDACTED_SECRET } from './microsoft.js';

const CALLBACK_PATHS = { mailru: '/oauth/mailru/callback', yandex: '/oauth/yandex/callback' };

export const MAILBOX_OAUTH_CONFIG_ERRORS = Object.freeze({
  client_id_invalid: 'Enter a valid mailbox OAuth client ID',
  client_secret_required: 'Enter the mailbox OAuth client secret',
  client_secret_redacted: 'Enter the full mailbox OAuth client secret',
  redirect_uri_invalid: 'Enter the callback URL on an approved HTTPS panel origin',
});

function parseRedirectUri(value, path) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  let url;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== 'https:' || trimmed !== `${url.origin}${path}`) return null;
  return getPublicOrigins().includes(url.origin) ? trimmed : null;
}

export async function readMailboxOAuthConfig(provider, db = { query }, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT config FROM integration_config WHERE provider = $1${lock ? ' FOR SHARE' : ''}`,
    [provider],
  );
  return rows[0]?.config || null;
}

export async function getMailboxOAuthConfig(provider) {
  const stored = await readMailboxOAuthConfig(provider);
  if (!stored?.clientId || !isEncrypted(stored.clientSecret)) return null;
  if (provider === 'mailru' && !parseRedirectUri(stored.redirectUri, CALLBACK_PATHS.mailru)) return null;
  const clientSecret = decrypt(stored.clientSecret);
  return clientSecret ? { clientId: stored.clientId, redirectUri: stored.redirectUri, clientSecret } : null;
}

export function mailboxOAuthRedirectConfigured(provider, config, origin) {
  const redirectUri = parseRedirectUri(config?.redirectUri, CALLBACK_PATHS[provider]);
  return !!redirectUri && new URL(redirectUri).origin === origin;
}

export async function hasMailboxOAuthConfig(provider, origin) {
  const stored = await getMailboxOAuthConfig(provider);
  return !!stored && (!stored.redirectUri || origin === undefined || new URL(stored.redirectUri).origin === origin);
}

export async function saveMailboxOAuthConfig(provider, input) {
  const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : '';
  const redirectInput = input?.redirectUri;
  const redirectSupplied = provider === 'mailru' || redirectInput !== undefined;
  const redirectUri = parseRedirectUri(redirectInput, CALLBACK_PATHS[provider]);
  const clearRedirect = provider === 'yandex' && typeof redirectInput === 'string' && !redirectInput.trim();
  const secret = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '';
  if (!/^[A-Za-z0-9._~-]{1,256}$/.test(clientId)) return { error: 'client_id_invalid' };
  if (redirectSupplied && !redirectUri && !clearRedirect) return { error: 'redirect_uri_invalid' };
  const keepSecret = !secret || secret === REDACTED_SECRET;
  // eslint-disable-next-line no-control-regex
  if (!keepSecret && (secret.length > 4096 || /[•\x00-\x1f\x7f]/.test(secret))) return { error: 'client_secret_redacted' };

  return withTransaction(async (client) => {
    if (keepSecret) {
      // Preserve a saved secret only for the client it belongs to, even on concurrent edits.
      const { rows } = await client.query(
        `UPDATE integration_config
            SET config = CASE WHEN NOT $4::boolean THEN config
                         WHEN $2::text IS NULL THEN config - 'redirectUri'
                         ELSE jsonb_set(config, '{redirectUri}', to_jsonb($2::text)) END,
                updated_at = NOW()
          WHERE provider = $1 AND config->>'clientId' = $3 AND config->>'clientSecret' LIKE 'enc:v1:%'
          RETURNING provider`,
        [provider, redirectUri, clientId, redirectSupplied],
      );
      return rows.length ? { ok: true } : { error: 'client_secret_required' };
    }
    const config = { clientId, clientSecret: encrypt(secret), ...(redirectUri ? { redirectUri } : {}) };
    await client.query(
      `INSERT INTO integration_config (provider, config) VALUES ($1, $2)
       ON CONFLICT (provider) DO UPDATE SET
         config = CASE WHEN NOT $3::boolean AND integration_config.config->>'clientId' = EXCLUDED.config->>'clientId'
                            AND integration_config.config ? 'redirectUri'
                       THEN EXCLUDED.config || jsonb_build_object('redirectUri', integration_config.config->'redirectUri')
                       ELSE EXCLUDED.config END,
         updated_at = NOW()`,
      [provider, config, redirectSupplied],
    );
    return { ok: true };
  });
}
