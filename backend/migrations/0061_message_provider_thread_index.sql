-- no-transaction
-- Lookup of a mailbox's messages by Gmail thread id, used when threads are keyed by X-GM-THRID.
-- Partial: only Gmail rows carry the id. Built concurrently so a large messages table stays writable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_provider_thread
  ON messages (account_id, provider_thread_id)
  WHERE provider_thread_id IS NOT NULL;
