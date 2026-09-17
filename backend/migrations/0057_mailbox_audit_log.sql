-- Journal of what users do with the shared mailboxes: who added, changed or removed a mailbox,
-- who sent or deleted a message, and what admins did to users. The actor and mailbox emails are
-- copied into the row so an entry stays readable after the user or mailbox is gone. Sync and
-- inbox rules never write here, and no subject, body, password or token is ever stored.
CREATE TABLE IF NOT EXISTS mailbox_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email   VARCHAR(255),
  account_id    UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
  account_email VARCHAR(255),
  action        VARCHAR(64) NOT NULL,
  details       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_mailbox_audit_occurred ON mailbox_audit_log (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_audit_account ON mailbox_audit_log (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_audit_actor ON mailbox_audit_log (actor_user_id, occurred_at DESC);
