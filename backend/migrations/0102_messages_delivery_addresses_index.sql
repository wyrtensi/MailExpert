-- no-transaction
-- The alias Inbox and its unread counter look letters up by the address they were delivered to
-- (message_delivery_addresses, 0101); the GIN index lets `... && $aliases` skip the rest of a big
-- old INBOX. Same shape as idx_messages_recipient_addresses (0071).
-- Drop first: only matters on a retry after a crashed CONCURRENTLY build left an INVALID index that IF NOT EXISTS would otherwise keep forever.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_delivery_addresses;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_delivery_addresses
  ON messages USING GIN (message_delivery_addresses(delivery_addresses))
  WHERE is_deleted = false;
