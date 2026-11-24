-- Keep the provider refresh schedule across restarts and restores. Existing grants are checked
-- using their expiry; a Yandex grant with no refresh history gets an initial check.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS oauth_token_refreshed_at timestamptz;
