-- Websites on a contact, stored like emails and phones: [{ "value": "https://...", "type": "work" }].
-- Values are normalised to http(s) addresses by the contacts API before they are written.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS urls JSONB NOT NULL DEFAULT '[]'::jsonb;
