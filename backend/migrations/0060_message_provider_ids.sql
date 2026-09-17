-- Gmail's own ids for a message: X-GM-THRID (the conversation Gmail shows) and X-GM-MSGID (one
-- logical message across all its label folders). Filled by the sync for Gmail accounts only;
-- NULL for other providers and for rows synced before this migration. Nullable with no default,
-- so adding them does not rewrite the table.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
