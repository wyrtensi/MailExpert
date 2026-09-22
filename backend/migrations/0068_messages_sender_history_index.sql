-- no-transaction
-- The sender history under an open letter (services/senderHistory.js) looks up one mailbox's
-- letters from one address, newest first, and the mailbox's own sent letters the same way.
-- Neither the trigram index on from_email nor (account_id, date, id) serves an exact
-- case-insensitive match per mailbox.
--
-- Drop first: only matters on a retry after a crashed CONCURRENTLY build left an INVALID index that IF NOT EXISTS would otherwise keep forever.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_account_from_date;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_account_from_date
  ON messages (account_id, lower(from_email), date DESC)
  WHERE is_deleted = false;
