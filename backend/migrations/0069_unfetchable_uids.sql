-- UIDs the server lists but will not hand over, so the folder integrity check stops
-- rediscovering the same gap forever (upstream maathimself/mailflow 0058_unfetchable_uids).
--
-- Observed upstream on an iCloud account: five UIDs appear in the server's UID set, the
-- integrity check counts them as missing locally and schedules a UID backfill, the backfill
-- requests exactly those five, the server returns nothing, and the next pass finds the same
-- gap. Thirty-five cycles in five hours, and it would run forever.
--
-- The backfill records a miss here per attempt and clears the row when the UID does arrive.
-- Once a UID has been refused often enough (services/unfetchableUids.js), the integrity check
-- stops counting it as missing and later backfills stop asking for it.
--
-- Rows are scoped to a UIDVALIDITY generation: a UID number means nothing outside its epoch,
-- and after a renumbering it can belong to a real new message. No row is written without an
-- epoch and a lookup matches the current epoch exactly, so uid_validity is NOT NULL here
-- (upstream's column is nullable only because its first version wrote NULLs).

CREATE TABLE IF NOT EXISTS unfetchable_uids (
  account_id      UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  folder          VARCHAR(500) NOT NULL,
  uid             BIGINT NOT NULL,
  uid_validity    BIGINT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, folder, uid)
);
