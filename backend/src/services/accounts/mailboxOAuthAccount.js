import { query, withTransaction } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { normalizeEmail } from '../auth/userIdentity.js';
import { encrypt } from '../encryption.js';
import { readMailboxOAuthConfig } from '../integrations/mailboxOAuth.js';
import { isUuid } from '../../utils/uuid.js';
import { reconnectAccount, withAccountAddressLock } from './connection.js';
import { getImapProvider } from './providerCatalog.js';

export function oauthMailboxConnection(provider, email) {
  const { imap, smtp } = getImapProvider(provider);
  // The documented Yandex XOAUTH2 endpoints also use implicit TLS for SMTP.
  const yandex = provider === 'yandex';
  return {
    email_address: email, auth_user: email, smtp_auth_user: email,
    imap_host: yandex ? 'imap.yandex.com' : imap.host, imap_port: imap.port, imap_tls_mode: imap.tls,
    smtp_host: yandex ? 'smtp.yandex.com' : smtp.host, smtp_port: 465, smtp_tls: 'SSL',
    explicitLogin: true,
  };
}

async function findMailboxByEmail(email, db = { query }) {
  const { rows } = await db.query(
    'SELECT id FROM email_accounts WHERE lower(btrim(email_address)) = $1 LIMIT 1', [email],
  );
  return rows[0] || null;
}

async function findOAuthReconnectTarget(provider, id, db = { query }) {
  const { rows } = await db.query(
    `SELECT id, email_address, oauth_subject FROM email_accounts
      WHERE id = $1 AND oauth_provider = $2 AND mail_node IS NOT TRUE`,
    [id, provider],
  );
  return rows[0] || null;
}

export async function resolveMailboxOAuthTarget(provider, body) {
  const accountId = body?.accountId;
  if (accountId !== undefined) {
    if (!isUuid(accountId) || body?.email !== undefined) return { error: 'invalid_state' };
    const target = await findOAuthReconnectTarget(provider, accountId);
    const email = normalizeEmail(target?.email_address);
    return email ? { mode: 'reconnect', accountId, email } : { error: 'invalid_state' };
  }
  const email = normalizeEmail(body?.email);
  if (!email) return { error: 'email_invalid' };
  if (await findMailboxByEmail(email)) return { error: 'already_connected' };
  return { mode: 'add', email };
}

export async function saveMailboxOAuthAccount({ provider, pending, identity, tokens, config, isPending }) {
  const { email } = pending;
  return withTransaction(client => withAccountAddressLock(email, async () => {
    // Reject a consent completed against a client or callback that was replaced mid-flow.
    const stored = await readMailboxOAuthConfig(provider, client, { lock: true });
    if (stored?.clientId !== config.clientId || stored.redirectUri !== config.redirectUri) {
      return { error: 'not_configured' };
    }
    if (isPending && !await isPending()) return { error: 'invalid_state' };
    const encryptedAccess = encrypt(tokens.accessToken);
    const encryptedRefresh = encrypt(tokens.refreshToken);
    if (pending.mode === 'reconnect') {
      const existing = await findOAuthReconnectTarget(provider, pending.accountId, client);
      if (!existing || existing.email_address.trim().toLowerCase() !== email) return { error: 'invalid_state' };
      if (existing.oauth_subject !== identity.sub) return { error: 'account_mismatch' };
      const { rows } = await client.query(
        `UPDATE email_accounts SET oauth_access_token = $1, oauth_refresh_token = $2, oauth_token_expiry = $3,
           oauth_client_id = $4, oauth_reconnect_required = false, sync_error = NULL
          WHERE id = $5 AND oauth_provider = $6 AND oauth_subject = $7 AND mail_node IS NOT TRUE
          RETURNING id`,
        [encryptedAccess, encryptedRefresh, tokens.expiresAt, config.clientId, existing.id, provider, identity.sub],
      );
      return rows.length ? { id: rows[0].id, result: 'updated' } : { error: 'invalid_state' };
    }
    if (await findMailboxByEmail(email, client)) return { error: 'already_connected' };
    const name = (typeof identity.name === 'string' ? identity.name.trim().slice(0, 255) : '') || email;
    const connection = oauthMailboxConnection(provider, email);
    const { rows } = await client.query(
      `INSERT INTO email_accounts (
          added_by, name, email_address, auth_user, smtp_auth_user,
          mail_provider, connection_mode, imap_tls_mode, imap_host, imap_port,
          smtp_host, smtp_port, smtp_tls, oauth_provider, oauth_access_token,
          oauth_refresh_token, oauth_token_expiry, oauth_client_id, oauth_subject, include_in_unified_inbox
       ) VALUES ($1, $2, $3, $3, $3, $4::text, 'managed', $5, $6, $7, $8, $9, 'SSL',
                 $4::text, $10, $11, $12, $13, $14, true)
       RETURNING id`,
      [pending.userId, name, email, provider, connection.imap_tls_mode, connection.imap_host, connection.imap_port, connection.smtp_host, connection.smtp_port,
        encryptedAccess, encryptedRefresh, tokens.expiresAt, config.clientId, identity.sub],
    );
    return { id: rows[0].id, result: 'created' };
  }, { client }));
}

export function notifyMailboxOAuthConnected(imapManager, { provider, saved, userId }) {
  recordAudit({
    action: saved.result === 'created' ? 'mailbox.added' : 'mailbox.reconnected',
    actorUserId: userId, accountId: saved.id, details: { oauthProvider: provider },
  });
  if (imapManager) {
    reconnectAccount(imapManager, saved.id, { onlyActive: true })
      .catch(() => console.error(`${provider} OAuth mailbox reconnect could not start`));
  }
}
