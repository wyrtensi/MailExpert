-- When MailExpert last restored this mail node mailbox's password by itself
-- (services/mailNode/passwordRestore.js). At most one automatic restore per
-- NODE_PASSWORD_RESTORE_MIN_INTERVAL_MS, across restarts, so a node that keeps rejecting a correct
-- password now and then does not get a new password every half hour forever.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS node_password_restored_at timestamptz;
