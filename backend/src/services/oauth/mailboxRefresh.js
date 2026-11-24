import { query } from '../db.js';
import { decrypt, encrypt } from '../encryption.js';
import { getMailboxOAuthConfig } from '../integrations/mailboxOAuth.js';

export async function refreshMailboxToken(account, provider, requestToken) {
  const failureCode = `${provider}_refresh_failed`;
  const config = await getMailboxOAuthConfig(provider);
  if (!config || config.clientId !== account.oauth_client_id) {
    throw Object.assign(new Error(failureCode), { code: failureCode, oauthError: 'app_unavailable' });
  }
  const currentRefreshToken = decrypt(account.oauth_refresh_token);
  if (!currentRefreshToken) {
    throw Object.assign(new Error(failureCode), { code: failureCode, oauthError: 'missing_refresh_token' });
  }

  const { accessToken, refreshToken, expiresAt } = await requestToken(config, currentRefreshToken);
  const { rows } = await query(`
    UPDATE email_accounts SET
      oauth_access_token = $1,
      oauth_refresh_token = COALESCE($2, oauth_refresh_token),
      oauth_token_expiry = $3,
      oauth_token_refreshed_at = NOW()
    WHERE id = $4
      AND oauth_client_id = $5
      AND oauth_refresh_token IS NOT DISTINCT FROM $6
      AND oauth_provider = $7
      AND oauth_reconnect_required = false
    RETURNING *
  `, [encrypt(accessToken), encrypt(refreshToken), expiresAt, account.id, config.clientId, account.oauth_refresh_token, provider]);
  if (rows[0]) return rows[0];

  const current = await query('SELECT * FROM email_accounts WHERE id = $1', [account.id]);
  if (!current.rows[0]) throw Object.assign(new Error('account_not_found'), { code: 'account_not_found' });
  return current.rows[0];
}
