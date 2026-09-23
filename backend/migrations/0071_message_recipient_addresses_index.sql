-- no-transaction
-- contactLetters.js's "sent to this contact" branch needs to know, across every letter any
-- mailbox sent, whether one of the contact's addresses is anywhere in To or Cc. A per-row
-- jsonb_array_elements scan (the same shape senderHistory.js uses for one mailbox) does not use
-- an index once it runs over every sent letter in the fleet. This immutable function flattens
-- To+Cc into a lowercased text[] — handling both string entries and {email} objects, and
-- tolerating a non-array jsonb value, exactly like the inline CASE logic it replaces — so a GIN
-- index on its result lets `message_recipient_addresses(to_addresses, cc_addresses) && $contacts`
-- use an index intersection instead of a per-row decompose.
CREATE OR REPLACE FUNCTION message_recipient_addresses(to_addresses jsonb, cc_addresses jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(array_agg(DISTINCT lower(
    CASE WHEN jsonb_typeof(rcpt) = 'string' THEN rcpt #>> '{}' ELSE rcpt ->> 'email' END
  )), '{}')
  FROM jsonb_array_elements(
    (CASE WHEN jsonb_typeof(to_addresses) = 'array' THEN to_addresses ELSE '[]'::jsonb END)
    || (CASE WHEN jsonb_typeof(cc_addresses) = 'array' THEN cc_addresses ELSE '[]'::jsonb END)
  ) AS rcpt
$$;

-- Drop first: only matters on a retry after a crashed CONCURRENTLY build left an INVALID index that IF NOT EXISTS would otherwise keep forever.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_recipient_addresses;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_recipient_addresses
  ON messages USING GIN (message_recipient_addresses(to_addresses, cc_addresses))
  WHERE is_deleted = false;
