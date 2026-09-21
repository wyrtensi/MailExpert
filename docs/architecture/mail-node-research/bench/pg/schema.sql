-- Consolidated "messages" schema as of MailExpert backend/migrations/0066 (baseline
-- 0001 + every later migration that touches the messages table). Reconstructed by
-- reading the migrations, not copy-pasted from a running MailExpert database.
--
-- email_accounts is a minimal stub, just enough to satisfy the FK — this is a
-- throwaway synthetic sizing test, not a copy of MailExpert's real accounts table.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

CREATE TABLE email_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  uid BIGINT NOT NULL,
  folder VARCHAR(500) NOT NULL DEFAULT 'INBOX',
  message_id VARCHAR(500),
  subject TEXT,
  from_name VARCHAR(500),
  from_email VARCHAR(500),
  to_addresses JSONB DEFAULT '[]',
  cc_addresses JSONB DEFAULT '[]',
  date TIMESTAMPTZ,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  is_read BOOLEAN DEFAULT false,
  is_starred BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  has_attachments BOOLEAN DEFAULT false,
  attachments JSONB DEFAULT '[]',
  flags JSONB DEFAULT '[]',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  reply_to JSONB DEFAULT '[]',
  in_reply_to TEXT,
  thread_references TEXT,
  thread_id TEXT,
  read_changed_at TIMESTAMPTZ,
  star_changed_at TIMESTAMPTZ,
  -- 0009_thread_key_column
  thread_key TEXT GENERATED ALWAYS AS (COALESCE(thread_id, id::text)) STORED,
  -- 0008_search_indexes
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(subject, '') || ' ' ||
      coalesce(from_name, '') || ' ' ||
      coalesce(from_email, '') || ' ' ||
      coalesce(snippet, '')
    )
  ) STORED,
  -- 0016_is_bulk
  is_bulk BOOLEAN,
  -- 0021_spam_training
  spam_score_sa FLOAT,
  spam_score_ml FLOAT,
  spam_verdict VARCHAR(20),
  spam_analyzed_at TIMESTAMPTZ,
  spam_details JSONB,
  spam_user_override VARCHAR(20),
  -- 0023_message_categories
  category VARCHAR(50),
  -- 0024_category_improvements
  list_unsubscribe TEXT,
  list_unsubscribe_post TEXT,
  -- 0025_unsubscribe_state
  unsubscribed_at TIMESTAMPTZ DEFAULT NULL,
  -- 0037_message_delivery_addresses
  delivery_addresses JSONB,
  -- 0044_message_plugin_annotations (also drops 0031's gtd_gist, not carried here)
  plugin_annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 0048_snippet_attempted_at
  snippet_attempted_at TIMESTAMPTZ,
  -- 0050_message_sender
  sender_email VARCHAR(500),
  sender_name VARCHAR(500),
  -- 0058_draft_bcc_addresses
  bcc_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 0060_message_provider_ids
  provider_thread_id TEXT,
  provider_message_id TEXT,
  -- 0063_thread_mode
  threading_reason TEXT,
  UNIQUE(account_id, uid, folder)
);

-- 0001_baseline
CREATE INDEX idx_messages_account_folder ON messages(account_id, folder);
CREATE INDEX idx_messages_date ON messages(date DESC);
CREATE INDEX idx_messages_read ON messages(is_read);
CREATE INDEX idx_messages_body ON messages USING gin(
  to_tsvector('english', coalesce(body_text,''))
);
CREATE INDEX idx_messages_list
  ON messages(account_id, folder, date DESC)
  WHERE is_deleted = false;
CREATE INDEX idx_messages_list_unread
  ON messages(account_id, folder, date DESC)
  WHERE is_deleted = false AND is_read = false;
CREATE INDEX idx_messages_thread_id
  ON messages(account_id, thread_id)
  WHERE is_deleted = false;
CREATE INDEX idx_messages_msg_id
  ON messages(message_id)
  WHERE message_id IS NOT NULL;

-- 0008_search_indexes (idx_messages_search from 0001 was dropped here)
CREATE INDEX idx_messages_search_vector ON messages USING GIN (search_vector);
CREATE INDEX idx_messages_from_email_trgm ON messages USING GIN (from_email gin_trgm_ops);
CREATE INDEX idx_messages_from_name_trgm ON messages USING GIN (from_name gin_trgm_ops);
CREATE INDEX idx_messages_subject_trgm ON messages USING GIN (subject gin_trgm_ops);

-- 0009_thread_key_column (superseded 0006/0007's thread_date/threaded_dedup/thread_count)
CREATE INDEX idx_messages_thread_key
  ON messages(account_id, folder, thread_key, date DESC)
  WHERE is_deleted = false;
CREATE INDEX idx_messages_threaded_dedup
  ON messages(account_id, folder, thread_key, message_id, date)
  WHERE is_deleted = false;
CREATE INDEX idx_messages_thread_count
  ON messages(account_id, thread_key, message_id)
  WHERE is_deleted = false AND message_id IS NOT NULL;
CREATE INDEX idx_messages_thread_key_lookup
  ON messages(account_id, thread_key)
  WHERE is_deleted = false;

-- 0011_message_id_dedup_index
CREATE INDEX idx_messages_account_message_id ON messages(account_id, message_id);

-- 0021_spam_training
CREATE INDEX idx_messages_spam_verdict ON messages(spam_verdict) WHERE spam_verdict IS NOT NULL;

-- 0023_message_categories
CREATE INDEX idx_messages_category ON messages (account_id, folder, category, date DESC);

-- 0066_messages_account_date_index
CREATE INDEX idx_messages_account_date ON messages (account_id, date, id) WHERE is_deleted = false;
