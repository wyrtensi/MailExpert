-- Owner decision: "all inboxes" means the inbox of every mailbox, with no per-mailbox opt-out
-- (the admin toggle and the API field are removed in this same change). The column already
-- defaults true (0036_unified_inbox_accounts.sql); this migration turns on the mailboxes that
-- were opted out before the decision, and restates the default for clarity.
UPDATE email_accounts SET include_in_unified_inbox = true WHERE include_in_unified_inbox IS DISTINCT FROM true;
ALTER TABLE email_accounts ALTER COLUMN include_in_unified_inbox SET DEFAULT true;
