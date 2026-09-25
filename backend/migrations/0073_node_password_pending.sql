-- A mail node mailbox's new password while MailExpert restores it (services/mailNode/passwordRestore.js),
-- encrypted like auth_pass. Stored before the node is asked to take it and moved to auth_pass once the
-- node said yes, so a timeout or a database failure after the node applied it never leaves a password
-- nobody knows: the next attempt sends the same one again.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS node_password_pending text;
