import { query } from './db.js';
import { listAliasesByAccount } from './accountAliases.js';

// An alias shown as its own mailbox: its Inbox is the owner's INBOX letters whose recipient pill
// names the alias (message_reply_alias, migration 0101, the same rule as the list pill's
// recipientAliasFor in frontend/src/utils/mailboxBanner.js), its Sent the owner's Sent letters
// from the alias address. Other folders it has none.

// The aliases a reply can go out from, as matchReplyAlias (frontend/src/utils/replyAlias.js) sees
// them: not the mailbox's own address (any case), one per address (the first in created_at, id
// order, which the rows already are), none on a mail node mailbox (D-16). Addresses lowercase.
export function replyAliases(account, aliases) {
  if (account?.mail_node === true) return [];
  const own = (account?.email_address || '').toLowerCase();
  const seen = new Set([own]);
  const result = [];
  for (const alias of aliases || []) {
    const email = (alias.email || '').toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push({ id: alias.id, email });
  }
  return result;
}

// AliasMailbox = { accountId, folderMappings, aliases: [{ id, email }], ownAddresses: string[] }
// for every enabled, non-node mailbox with at least one alias of its own (optionally only of
// accountIds). ownAddresses: the mailbox address and all its alias addresses, lowercase.
export async function loadAliasMailboxes(accountIds) {
  const scoped = Array.isArray(accountIds);
  if (scoped && !accountIds.length) return [];
  const accounts = await query(
    `SELECT id, email_address, mail_node, folder_mappings FROM email_accounts
      WHERE enabled = true AND mail_node = false${scoped ? ' AND id = ANY($1)' : ''}
      ORDER BY id`,
    scoped ? [accountIds] : [],
  );
  if (!accounts.rows.length) return [];
  const aliasesByAccount = await listAliasesByAccount(accounts.rows.map((a) => a.id));
  const mailboxes = [];
  for (const account of accounts.rows) {
    const rows = aliasesByAccount[account.id] || [];
    const aliases = replyAliases(account, rows);
    if (!aliases.length) continue;
    mailboxes.push({
      accountId: account.id,
      folderMappings: account.folder_mappings ?? null,
      aliases,
      ownAddresses: [...new Set([account.email_address, ...rows.map((a) => a.email)].map((e) => (e || '').toLowerCase()))],
    });
  }
  return mailboxes;
}

// The alias's Inbox letters among an INBOX listing. The second part is the rule itself; the first
// follows from it and changes no result: it lets the planner answer from the three address
// indexes (BitmapOr) instead of reading the whole INBOX. Its expressions are those of
// idx_messages_delivery_addresses (0102), idx_messages_recipient_addresses (0071) and
// idx_messages_account_from_date (0068), word for word.
export function aliasInboxCondition(mailbox, aliasEmail, p) {
  return {
    sql: `(message_delivery_addresses(m.delivery_addresses) @> ARRAY[$${p}::text]
       OR message_recipient_addresses(m.to_addresses, m.cc_addresses) @> ARRAY[$${p}::text]
       OR lower(m.from_email) = $${p}::text)
      AND message_reply_alias(m.delivery_addresses, m.to_addresses, m.cc_addresses, m.from_email,
                              $${p + 1}::text[], $${p + 2}::text[]) = $${p}::text`,
    values: [aliasEmail, mailbox.aliases.map((a) => a.email), mailbox.ownAddresses],
  };
}

// The alias's letters among a Sent listing: sent from its address, any case.
export function aliasSentCondition(aliasEmail, p) {
  return { sql: `lower(m.from_email) = $${p}::text`, values: [aliasEmail] };
}
