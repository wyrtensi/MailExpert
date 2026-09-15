-- Google OAuth apps (one per Google Cloud project), the journal of Google accounts each
-- app issued tokens to, and the app a Gmail account's tokens belong to. Existing
-- single-app settings are imported at startup by services/oauth/googleApps.js, which can
-- encrypt a legacy plaintext secret.
CREATE TABLE IF NOT EXISTS google_oauth_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(100) NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT NOT NULL,
  project_number TEXT NOT NULL UNIQUE,
  user_limit INTEGER NOT NULL DEFAULT 100 CHECK (user_limit > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS google_oauth_grants (
  app_id UUID NOT NULL REFERENCES google_oauth_apps(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  google_sub TEXT,
  first_granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, email)
);

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS oauth_app_id UUID REFERENCES google_oauth_apps(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS oauth_subject TEXT;

CREATE INDEX IF NOT EXISTS idx_email_accounts_oauth_app
  ON email_accounts (oauth_app_id) WHERE oauth_app_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_accounts_lower_email
  ON email_accounts (lower(email_address));
