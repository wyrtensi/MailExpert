ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS mail_provider text
  CHECK (mail_provider IN ('gmail', 'microsoft', 'domain', 'proton', 'yahoo', 'yandex', 'mailru', 'icloud', 'other'));
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS connection_mode text NOT NULL DEFAULT 'manual'
  CHECK (connection_mode IN ('preset', 'manual', 'managed'));
-- NULL preserves the existing engine's legacy connection behavior.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS imap_tls_mode text
  CHECK (imap_tls_mode IN ('implicit', 'starttls'));

-- Only existing explicit integrations are adopted; hostnames never identify managed Proton.
UPDATE email_accounts SET mail_provider = CASE
    WHEN mail_node THEN 'domain'
    WHEN oauth_provider = 'google' THEN 'gmail'
    WHEN oauth_provider = 'microsoft' THEN 'microsoft'
  END, connection_mode = 'managed'
 WHERE mail_provider IS NULL AND connection_mode = 'manual'
   AND (mail_node OR oauth_provider IN ('google', 'microsoft'));

CREATE TABLE IF NOT EXISTS proton_users (
  proton_user_id text PRIMARY KEY,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  creator_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  cleanup_pending boolean NOT NULL DEFAULT false,
  removal_state text,
  UNIQUE (proton_user_id, generation)
);

CREATE TABLE IF NOT EXISTS proton_mailbox_links (
  account_id uuid PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  proton_user_id text NOT NULL,
  generation uuid NOT NULL,
  certificate_pem text NOT NULL,
  certificate_fingerprint text NOT NULL,
  tls_servername text NOT NULL,
  FOREIGN KEY (proton_user_id, generation) REFERENCES proton_users(proton_user_id, generation)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS proton_mailbox_links_proton_user_idx ON proton_mailbox_links (proton_user_id);

CREATE TABLE IF NOT EXISTS proton_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  requested_email text NOT NULL,
  proton_user_id text REFERENCES proton_users(proton_user_id) ON DELETE SET NULL,
  state text NOT NULL,
  account_id uuid REFERENCES email_accounts(id) ON DELETE SET NULL,
  reconnect_account_id uuid REFERENCES email_accounts(id) ON DELETE SET NULL,
  reconnect_intent boolean NOT NULL DEFAULT false,
  error_code text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  UNIQUE (actor_user_id, request_id)
);
CREATE INDEX IF NOT EXISTS proton_connections_expiry_idx ON proton_connections (expires_at);

CREATE TABLE IF NOT EXISTS account_creation_requests (
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  requested_email text NOT NULL,
  provider text NOT NULL
    CHECK (provider IN ('gmail', 'microsoft', 'domain', 'proton', 'yahoo', 'yandex', 'mailru', 'icloud', 'other')),
  mode text NOT NULL CHECK (mode IN ('preset', 'manual', 'managed')),
  account_id uuid REFERENCES email_accounts(id) ON DELETE SET NULL,
  result_code text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  PRIMARY KEY (actor_user_id, request_id)
);
CREATE INDEX IF NOT EXISTS account_creation_requests_expiry_idx ON account_creation_requests (expires_at);
