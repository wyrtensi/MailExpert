-- The Mail.ru grant belongs to the configured client that issued it.
ALTER TABLE email_accounts ADD COLUMN oauth_client_id text;
