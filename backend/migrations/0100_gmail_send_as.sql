-- Gmail "send mail as" import: where an alias came from. 'gmail' rows are written only by the
-- sync (Gmail is the source of truth) and are read-only for the manual alias functions.
ALTER TABLE account_aliases ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'gmail'));
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS gmail_send_as_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_aliases_gmail_email
  ON account_aliases (account_id, lower(email)) WHERE source = 'gmail';
