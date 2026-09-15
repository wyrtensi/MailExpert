-- Mailboxes and the data around them are shared by every user of the install. Owner columns
-- become "who did it" columns that outlive the user, and per-user copies of what is now one
-- install-wide set are merged. The owner columns go last: the copy steps enumerate each
-- owner's mailboxes and books through them.

-- Mailboxes remember who added them.
ALTER TABLE email_accounts ADD COLUMN added_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE email_accounts SET added_by = user_id;

-- A rule for "all my mailboxes" becomes one rule per mailbox of its owner. Each copy keeps the
-- forward reservations for messages of its own mailbox, so nothing is forwarded twice.
ALTER TABLE inbox_rules ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE inbox_rules ADD COLUMN copied_from UUID;
UPDATE inbox_rules SET created_by = user_id;
INSERT INTO inbox_rules (user_id, created_by, account_id, name, enabled, stop_processing, priority,
                         condition_logic, conditions, actions, created_at, updated_at, copied_from)
SELECT r.user_id, r.created_by, a.id, r.name, r.enabled, r.stop_processing, r.priority,
       r.condition_logic, r.conditions, r.actions, r.created_at, r.updated_at, r.id
  FROM inbox_rules r
  JOIN email_accounts a ON a.user_id = r.user_id
 WHERE r.account_id IS NULL;
INSERT INTO inbox_rule_forwards (rule_id, message_id, status, created_at, sent_at)
SELECT n.id, f.message_id, f.status, f.created_at, f.sent_at
  FROM inbox_rules n
  JOIN inbox_rule_forwards f ON f.rule_id = n.copied_from
  JOIN messages m ON m.id = f.message_id AND m.account_id = n.account_id
ON CONFLICT (rule_id, message_id) DO NOTHING;
DELETE FROM inbox_rules WHERE account_id IS NULL;
ALTER TABLE inbox_rules DROP COLUMN copied_from;
ALTER TABLE inbox_rules ALTER COLUMN account_id SET NOT NULL;

-- A block list entry applies to each mailbox of its owner.
ALTER TABLE block_list DROP CONSTRAINT block_list_user_id_email_address_key;
ALTER TABLE block_list ADD COLUMN account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE;
INSERT INTO block_list (user_id, account_id, email_address, created_at)
SELECT b.user_id, a.id, b.email_address, b.created_at
  FROM block_list b
  JOIN email_accounts a ON a.user_id = b.user_id
 WHERE b.account_id IS NULL;
DELETE FROM block_list WHERE account_id IS NULL;
ALTER TABLE block_list ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE block_list ADD CONSTRAINT block_list_account_id_email_address_key UNIQUE (account_id, email_address);

-- Snoozes and spam decisions remember who made them.
ALTER TABLE snoozed_messages ADD COLUMN snoozed_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE snoozed_messages SET snoozed_by = user_id;
ALTER TABLE spam_training_log ADD COLUMN trained_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE spam_training_log SET trained_by = user_id;

-- Contacts live only inside the install: books imported from an external CardDAV server go
-- with their contacts, and so do the connections that filled them.
DELETE FROM address_books WHERE source = 'carddav';
DELETE FROM user_integrations WHERE provider = 'carddav';

-- Address books: one shared book holds every contact.
ALTER TABLE address_books DROP CONSTRAINT address_books_user_id_name_key;
ALTER TABLE address_books ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE address_books ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ALTER COLUMN user_id DROP NOT NULL;

-- Each user's books hold what they sent to, created by hand or learned from inbound mail.
-- They merge into the shared book; a contact present in several keeps its best copy with the
-- sends of all of them.
CREATE TEMP TABLE merged_books ON COMMIT DROP AS
  SELECT id FROM address_books;
INSERT INTO address_books (name, is_default) VALUES ('Contacts', true);
CREATE TEMP TABLE merged_contacts ON COMMIT DROP AS
  SELECT c.id,
         row_number() OVER same_contact AS keep_rank,
         SUM(c.send_count) OVER (PARTITION BY COALESCE(c.primary_email, c.id::text)) AS send_count,
         MAX(c.last_sent) OVER (PARTITION BY COALESCE(c.primary_email, c.id::text)) AS last_sent
    FROM contacts c
   WHERE c.address_book_id IN (SELECT id FROM merged_books)
  WINDOW same_contact AS (PARTITION BY COALESCE(c.primary_email, c.id::text)
                          ORDER BY c.is_auto, c.send_count DESC, c.updated_at DESC, c.id);
DELETE FROM contacts WHERE id IN (SELECT id FROM merged_contacts WHERE keep_rank > 1);
UPDATE contacts c
   SET send_count = m.send_count, last_sent = m.last_sent
  FROM merged_contacts m
 WHERE c.id = m.id AND m.keep_rank = 1;
-- A card written with the same vCard UID into two users' books keeps its newest copy.
DELETE FROM contacts c
 WHERE c.address_book_id IN (SELECT id FROM merged_books)
   AND EXISTS (SELECT 1 FROM contacts o
                WHERE o.address_book_id IN (SELECT id FROM merged_books)
                  AND o.uid = c.uid
                  AND (o.updated_at, o.id) > (c.updated_at, c.id));
UPDATE contacts SET address_book_id = (SELECT id FROM address_books WHERE is_default)
 WHERE address_book_id IN (SELECT id FROM merged_books);
DELETE FROM address_books WHERE id IN (SELECT id FROM merged_books);
CREATE UNIQUE INDEX address_books_single_default_idx ON address_books (is_default) WHERE is_default;
-- These columns served CardDAV sync only.
ALTER TABLE address_books DROP COLUMN source;
ALTER TABLE address_books DROP COLUMN external_url;
ALTER TABLE address_books DROP COLUMN sync_token;

-- Category sources are one install-wide set; duplicates keep the enabled, freshest copy.
DELETE FROM category_list_sources s
 USING (SELECT id,
               row_number() OVER (PARTITION BY source_type, value
                                  ORDER BY enabled DESC, last_fetched_at DESC NULLS LAST, created_at, id) AS keep_rank
          FROM category_list_sources) r
 WHERE s.id = r.id AND r.keep_rank > 1;
ALTER TABLE category_list_sources DROP COLUMN user_id;
ALTER TABLE category_list_sources ADD CONSTRAINT category_list_sources_source_type_value_key UNIQUE (source_type, value);

-- Categorization is on for the install when anyone had it on.
INSERT INTO system_settings (key, value, updated_at)
SELECT 'categorization_enabled',
       CASE WHEN EXISTS (SELECT 1 FROM users WHERE preferences->>'categorizationEnabled' = 'true')
            THEN 'true' ELSE 'false' END,
       NOW()
ON CONFLICT (key) DO NOTHING;
UPDATE users SET preferences = preferences - 'categorizationEnabled' WHERE preferences ? 'categorizationEnabled';

-- Owner columns go; dropping a column also drops the indexes and constraints built on it.
ALTER TABLE inbox_rules DROP COLUMN user_id;
DROP INDEX IF EXISTS idx_inbox_rules_account;
CREATE INDEX idx_inbox_rules_account ON inbox_rules (account_id, enabled, priority);
ALTER TABLE block_list DROP COLUMN user_id;
ALTER TABLE snoozed_messages DROP COLUMN user_id;
ALTER TABLE spam_training_log DROP COLUMN user_id;
CREATE INDEX idx_spam_training_account ON spam_training_log (account_id, created_at DESC);
CREATE INDEX idx_spam_training_account_label ON spam_training_log (account_id, label);
CREATE INDEX idx_spam_training_account_message ON spam_training_log (account_id, message_id_header)
  WHERE message_id_header IS NOT NULL;
ALTER TABLE contacts DROP COLUMN user_id;
CREATE INDEX contacts_primary_email_lookup_idx ON contacts (primary_email) WHERE primary_email IS NOT NULL;
CREATE INDEX contacts_display_name_idx ON contacts (lower(display_name));
ALTER TABLE address_books DROP COLUMN user_id;
ALTER TABLE email_accounts DROP COLUMN user_id;
