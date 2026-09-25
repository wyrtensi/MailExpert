import { query } from '../db.js';
import { decrypt, encrypt } from '../encryption.js';
import { isOAuthAccount } from '../oauth/constants.js';
import { generateMailboxPassword, getMailbox, getMailNodeConfig, listDomains, setMailboxPassword } from './mailcow.js';

// At most one automatic restore per mailbox in this long (email_accounts.node_password_restored_at,
// so it holds across restarts): a node that rejects a correct password now and then must not get a
// new password every time the auth ladder, which a restore resets, lets a login through.
export const NODE_PASSWORD_RESTORE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

// The node rejected the password of one of its mailboxes. MailExpert owns that password (nobody
// can change it in the panel, mail_node_connection_locked), so it sets a new one through the
// mailcow API instead of waiting for a human, and stores it encrypted as the create route does.
//
// A mailbox an administrator disabled in mailcow stays disabled: only an active mailbox gets a
// new password, and the edit carries nothing but the password (setMailboxPassword).
//
// Outcomes:
// - { outcome: 'restored', account, replacedAuthPass }: the node took the new password and the row
//   holds it (account is the updated row, replacedAuthPass the auth_pass it replaced);
// - { outcome: 'host_mismatch' }: the row's host is not the configured node;
// - { outcome: 'rate_limited' }: restored less than NODE_PASSWORD_RESTORE_MIN_INTERVAL_MS ago;
// - { outcome: 'disabled' | 'missing' }: the mailbox is inactive or gone on the node;
// - { outcome: 'receive_only' | 'foreign_authsource' | 'no_imap_access' | 'force_pw_update' |
//   'domain_missing' | 'domain_inactive' }: the node refuses the login for another reason;
// - { outcome: 'api_failed', code, stage }: the node API failed (MailNodeError code, or the error
//   name); stage 'set' when it was the password change itself, which may have been applied;
// - { outcome: 'skipped' }: not a mail node mailbox (anymore), disabled in MailExpert, or no mail
//   node configured.
// Throws only when the database fails.
//
// The new password is stored (encrypted, node_password_pending) BEFORE the node is asked to take it,
// and becomes auth_pass only once the node said yes. A timeout after mailcow applied the change, or a
// database failure after it, therefore never leaves a password nobody knows: the next attempt sends
// the same pending password again (setting a password to its current value is harmless) and promotes it.
export async function restoreNodeMailboxPassword(accountId) {
  const { rows } = await query(
    `SELECT id, email_address, imap_host, mail_node, enabled, protocol, oauth_provider, node_password_pending,
            node_password_restored_at, auth_pass
       FROM email_accounts WHERE id = $1`,
    [accountId],
  );
  const row = rows[0];
  if (!row?.mail_node || !row.enabled || row.protocol !== 'imap' || isOAuthAccount(row)) return { outcome: 'skipped' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { outcome: 'skipped' };
  // The mailbox lives on the node its row names. If the configured node is another host (the admin
  // pointed the panel at a new node name), its same-named mailbox may belong to someone else.
  if (String(row.imap_host || '').toLowerCase() !== cfg.mailHost) return { outcome: 'host_mismatch' };
  const restoredAt = row.node_password_restored_at ? new Date(row.node_password_restored_at).getTime() : NaN;
  if (Date.now() - restoredAt < NODE_PASSWORD_RESTORE_MIN_INTERVAL_MS) return { outcome: 'rate_limited' };

  let mailbox;
  try {
    mailbox = await getMailbox(cfg, row.email_address);
  } catch (err) {
    return { outcome: 'api_failed', code: apiErrorCode(err) };
  }
  if (!mailbox) return { outcome: 'missing' };
  // The node refuses the login for a reason a new password does not change: setting one would only
  // cost another rejected login from the panel (and, for an external authsource, mailcow would report
  // success without changing anything).
  if (mailbox.state === 2) return { outcome: 'receive_only' };
  if (!mailbox.active) return { outcome: 'disabled' };
  if (mailbox.authsource !== 'mailcow') return { outcome: 'foreign_authsource' };
  if (!mailbox.imapAccess) return { outcome: 'no_imap_access' };
  if (mailbox.forcePwUpdate) return { outcome: 'force_pw_update' };
  let domain;
  try {
    domain = (await listDomains(cfg)).find((d) => d.domain === mailbox.domain);
  } catch (err) {
    return { outcome: 'api_failed', code: apiErrorCode(err) };
  }
  if (!domain) return { outcome: 'domain_missing' };
  if (!domain.active) return { outcome: 'domain_inactive' };

  let password;
  if (row.node_password_pending) {
    password = decrypt(row.node_password_pending);
  } else {
    password = generateMailboxPassword();
    const pending = await query(
      'UPDATE email_accounts SET node_password_pending = $1 WHERE id = $2 AND mail_node = true',
      [encrypt(password), accountId],
    );
    if (!pending.rowCount) return { outcome: 'skipped' };
  }
  try {
    await setMailboxPassword(cfg, row.email_address, password);
  } catch (err) {
    return { outcome: 'api_failed', code: apiErrorCode(err), stage: 'set' };
  }
  const updated = await query(
    `UPDATE email_accounts SET auth_pass = node_password_pending, node_password_pending = NULL,
            node_password_restored_at = NOW()
      WHERE id = $1 AND mail_node = true AND node_password_pending IS NOT NULL
      RETURNING *`,
    [accountId],
  );
  // Deleted meanwhile: the delete route disables the mailbox on the node, nothing to reconnect.
  if (!updated.rows.length) return { outcome: 'skipped' };
  return { outcome: 'restored', account: updated.rows[0], replacedAuthPass: row.auth_pass };
}

function apiErrorCode(err) {
  return err?.code || err?.name || 'error';
}
