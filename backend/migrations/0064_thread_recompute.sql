-- Progress of recomputing a mailbox's thread keys after its threading mode changed.
-- One row per mailbox: the target mode, how far the pass got (cursor over date, id), how many
-- rows it looked at and actually changed, and the last failure. Whether a pass is running is kept
-- in process memory only, so a crash never leaves a mailbox marked as running.
CREATE TABLE IF NOT EXISTS thread_recompute (
  account_id  UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  target_mode TEXT NOT NULL,
  cursor_date TIMESTAMPTZ,
  cursor_id   UUID,
  processed   BIGINT NOT NULL DEFAULT 0,
  changed     BIGINT NOT NULL DEFAULT 0,
  total       BIGINT NOT NULL DEFAULT 0,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE thread_recompute DROP CONSTRAINT IF EXISTS thread_recompute_target_mode_check;
ALTER TABLE thread_recompute ADD CONSTRAINT thread_recompute_target_mode_check CHECK (target_mode IN ('rfc', 'gmail'));
