import { query } from '../db.js';
import { encrypt } from '../encryption.js';
import { isOAuthAccount } from '../oauth/constants.js';
import { getMailbox, getMailNodeConfig, setMailboxPassword } from './mailcow.js';

// The node rejected the password of one of its mailboxes. MailExpert owns that password (nobody
// can change it in the panel, mail_node_connection_locked), so it sets a new one through the
// mailcow API instead of waiting for a human, and stores it encrypted as the create route does.
//
// A mailbox an administrator disabled in mailcow stays disabled: only an active mailbox gets a
// new password, and the edit carries nothing but the password (setMailboxPassword).
//
// Outcomes:
// - { outcome: 'restored', account }: the node took the new password and the row holds it
//   (account is the updated row);
// - { outcome: 'disabled' | 'missing' }: the mailbox is inactive or gone on the node;
// - { outcome: 'api_failed', code }: the node API failed (MailNodeError code, or the error name);
// - { outcome: 'skipped' }: not a mail node mailbox (anymore), disabled in MailExpert, or no mail
//   node configured.
// Throws only when the database fails.
export async function restoreNodeMailboxPassword(accountId) {
  const { rows } = await query(
    'SELECT id, email_address, mail_node, enabled, protocol, oauth_provider FROM email_accounts WHERE id = $1',
    [accountId],
  );
  const row = rows[0];
  if (!row?.mail_node || !row.enabled || row.protocol !== 'imap' || isOAuthAccount(row)) return { outcome: 'skipped' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { outcome: 'skipped' };

  let mailbox;
  try {
    mailbox = await getMailbox(cfg, row.email_address);
  } catch (err) {
    return { outcome: 'api_failed', code: apiErrorCode(err) };
  }
  if (!mailbox) return { outcome: 'missing' };
  if (!mailbox.active) return { outcome: 'disabled' };

  let password;
  try {
    password = await setMailboxPassword(cfg, row.email_address);
  } catch (err) {
    return { outcome: 'api_failed', code: apiErrorCode(err) };
  }
  const updated = await query(
    'UPDATE email_accounts SET auth_pass = $1 WHERE id = $2 AND mail_node = true RETURNING *',
    [encrypt(password), accountId],
  );
  // Deleted meanwhile: the delete route disables the mailbox on the node, nothing to reconnect.
  if (!updated.rows.length) return { outcome: 'skipped' };
  return { outcome: 'restored', account: updated.rows[0] };
}

function apiErrorCode(err) {
  return err?.code || err?.name || 'error';
}
