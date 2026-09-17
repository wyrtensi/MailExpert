-- Progress of loading Gmail ids (0060) for messages cached before the sync stored them.
-- One row per mailbox: a { lastUid, uidValidity } cursor per folder path, when the last
-- complete run finished, and the last failure. Whether a run is in progress is kept in
-- process memory only, so a crash never leaves a mailbox marked as running.
CREATE TABLE IF NOT EXISTS provider_id_backfill (
  account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  cursors JSONB NOT NULL DEFAULT '{}'::jsonb,
  finished_at TIMESTAMPTZ,
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
