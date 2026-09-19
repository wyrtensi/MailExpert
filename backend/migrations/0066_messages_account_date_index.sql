-- no-transaction
-- The mailbox thread recompute (services/threading/recompute.js) walks a mailbox's live rows in
-- (account_id, date, id) order, batch after batch, via `(date, id) > ($cursor_date, $cursor_id)`.
-- Neither existing index covers that: idx_messages_list is (account_id, folder, date DESC) with
-- folder unconstrained in the middle, and idx_messages_date is (date DESC) without account_id.
-- Without this index the walk falls back to a per-batch sort over the whole mailbox.
--
-- Drop first: only matters on a retry after a crashed CONCURRENTLY build left an INVALID index that IF NOT EXISTS would otherwise keep forever.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_account_date;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_account_date
  ON messages (account_id, date, id)
  WHERE is_deleted = false;
