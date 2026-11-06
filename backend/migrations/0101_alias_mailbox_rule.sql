-- The rule "which alias of a mailbox a letter in its INBOX belongs to", on the server. It repeats
-- the list pill (frontend/src/utils/mailboxBanner.js recipientAliasFor with replyAlias.js
-- matchReplyAlias); backend/src/services/aliasMailbox.fixtures.json is run by both, so change the
-- rule in both places at once and add a case there.

-- delivery_addresses (jsonb array of address strings) as a lowercased text[]; '{}' for NULL and
-- for anything that is not an array. IMMUTABLE so a GIN index can be built over it (0102).
CREATE OR REPLACE FUNCTION message_delivery_addresses(delivery_addresses jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(array_agg(DISTINCT lower(e #>> '{}')), '{}')
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(delivery_addresses) = 'array' THEN delivery_addresses ELSE '[]'::jsonb END
  ) AS e
  WHERE jsonb_typeof(e) = 'string'
$$;

-- The alias address (lowercase) an INBOX letter was addressed to, or NULL. aliases: the mailbox's
-- aliases in created_at, id order, lowercase, without the mailbox's own address; own_addresses:
-- the mailbox address and all its aliases, lowercase. The first branch is an outgoing letter
-- (no pill); then delivery_addresses in alias order; then one pass over To, Cc and From in alias
-- order.
CREATE OR REPLACE FUNCTION message_reply_alias(
  delivery_addresses jsonb, to_addresses jsonb, cc_addresses jsonb,
  from_email text, aliases text[], own_addresses text[]
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN COALESCE(lower(from_email), '') = ANY(own_addresses)
     AND NOT (message_recipient_addresses(to_addresses, cc_addresses) && own_addresses
              OR message_delivery_addresses(delivery_addresses) && own_addresses)
      THEN NULL
    ELSE COALESCE(
      (SELECT a.email FROM unnest(aliases) WITH ORDINALITY AS a(email, ord)
        WHERE a.email = ANY(message_delivery_addresses(delivery_addresses)) ORDER BY a.ord LIMIT 1),
      (SELECT a.email FROM unnest(aliases) WITH ORDINALITY AS a(email, ord)
        WHERE a.email = ANY(message_recipient_addresses(to_addresses, cc_addresses))
           OR a.email = COALESCE(lower(from_email), '')
        ORDER BY a.ord LIMIT 1))
  END
$$;
