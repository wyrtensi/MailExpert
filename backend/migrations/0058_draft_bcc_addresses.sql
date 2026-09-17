-- Bcc recipients of a draft saved from MailExpert. A Drafts row only kept To and Cc, so reopening a
-- draft and saving or sending it again silently dropped its Bcc recipients. Sync does not fill this
-- column: Bcc is private to the sender and appears only on drafts the composer wrote.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS bcc_addresses JSONB NOT NULL DEFAULT '[]'::jsonb;
