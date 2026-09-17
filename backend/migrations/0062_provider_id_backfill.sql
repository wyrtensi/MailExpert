-- Progress of loading Gmail ids (0060) for messages cached before the sync stored them.
-- One row per mailbox: a { lastUid, uidValidity } cursor per folder path, when the last
-- complete run finished, the last failure, and the last local write that still needs a run.
-- Whether a run is in progress is kept in process memory only, so a crash never leaves a
-- mailbox marked as running.
CREATE TABLE IF NOT EXISTS provider_id_backfill (
  account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  cursors JSONB NOT NULL DEFAULT '{}'::jsonb,
  finished_at TIMESTAMPTZ,
  error TEXT,
  -- Last local write that stored a row without ids; NULL once a complete run has covered it.
  pending_since TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
