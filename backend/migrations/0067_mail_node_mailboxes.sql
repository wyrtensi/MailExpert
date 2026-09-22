-- Mailboxes MailExpert created on the mail node (mailcow). Deleting such a mailbox in MailExpert
-- only disables it on the node, so the flag decides which delete path runs.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS mail_node boolean NOT NULL DEFAULT false;
