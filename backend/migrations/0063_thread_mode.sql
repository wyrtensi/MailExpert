-- How a mailbox keys its conversations. 'rfc' threads by the RFC 5322 References chain (what every
-- mailbox does today); 'gmail' keys them by Gmail's own thread number (X-GM-THRID, stored in
-- messages.provider_thread_id by 0060). Only SQL sets 'gmail' for now: switching a mailbox whose
-- rows still carry RFC keys needs the batched recompute that comes with the admin switch.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS thread_mode TEXT NOT NULL DEFAULT 'rfc';
ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_thread_mode_check;
ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_thread_mode_check CHECK (thread_mode IN ('rfc', 'gmail'));

-- Why this row got its thread key: gmail-thrid, rfc-root, rfc-ancestor, rfc-provisional, new-root.
-- Read by the threading diagnostics; NULL for rows stored before this migration.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS threading_reason TEXT;
