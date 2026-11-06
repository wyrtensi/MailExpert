// "Display aliases as accounts": each alias of a mailbox gets its own sidebar row with its own
// Inbox and Sent. Pure helpers (no DOM, no store) so they run under `node --test`.
import { sortAliasesByName } from './aliasSort.js';
import { pickReplyAlias } from './replyAlias.js';

const lower = (value) => String(value ?? '').trim().toLowerCase();

// The aliases of a mailbox that get a row: its aliases except the mailbox's own address (any case)
// and repeats of one address (the first by order wins, the one matchReplyAlias picks). A mail node
// mailbox sends only from its own address and a disabled mailbox is not worked, so neither has any.
export function replyAliasesOf(account) {
  if (!account || account.mail_node === true || account.enabled === false) return [];
  const own = lower(account.email_address);
  const seen = new Set();
  const result = [];
  for (const alias of Array.isArray(account.aliases) ? account.aliases : []) {
    const email = lower(alias?.email);
    if (!email || email === own || seen.has(email)) continue;
    seen.add(email);
    result.push(alias);
  }
  return result;
}

// { key, accountId, aliasId, name, email, color } for the aliases of every mailbox, mixed, in
// sortAliasesByName order. The name falls back to the local part of the address.
export function aliasMailboxRows(accounts) {
  const entries = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    for (const alias of replyAliasesOf(account)) entries.push({ account, alias });
  }
  const accountOf = new Map(entries.map(({ account, alias }) => [alias, account]));
  return sortAliasesByName(entries.map(({ alias }) => alias)).map((alias) => {
    const account = accountOf.get(alias);
    const name = typeof alias.name === 'string' && alias.name.trim()
      ? alias.name.trim()
      : String(alias.email).split('@')[0];
    return {
      key: `${account.id}:${alias.id}`,
      accountId: account.id,
      aliasId: alias.id,
      name,
      email: alias.email,
      color: account.color,
    };
  });
}

// Case-insensitive substring match on the shown name and the address; a blank query returns `rows`.
export function filterAliasRows(rows, query) {
  const needle = lower(query);
  if (!needle) return rows;
  return (rows || []).filter((row) => lower(row.name).includes(needle) || lower(row.email).includes(needle));
}

// The alias to keep selected: none when the mode is off; while the mailbox list is unknown the
// selection as it is (see resolveSelectedAccount); else only an alias that still has a row under
// the selected mailbox.
export function resolveSelectedAlias({ accounts, accountsReady, selectedAccountId, selectedAliasId, enabled }) {
  if (!enabled || !selectedAliasId) return null;
  if (accountsReady === false) return selectedAliasId;
  const found = aliasMailboxRows(accounts).some(
    (row) => row.accountId === selectedAccountId && row.aliasId === selectedAliasId,
  );
  return found ? selectedAliasId : null;
}

// The Sent folder of the owner mailbox for an alias's Sent view: the configured mapping if it is in
// the folder list, else the folder flagged \Sent, else null (like resolveAllSentPaths).
export function aliasSentFolder(account, folderList) {
  const folders = Array.isArray(folderList) ? folderList : [];
  const mapped = account?.folder_mappings?.sent;
  if (mapped && folders.some((f) => f.path === mapped)) return mapped;
  return folders.find((f) => f.special_use === '\\Sent')?.path ?? null;
}

// What the compose window gets from the open view: the mailbox, and the alias when one is open.
export function composeDataForView({ selectedAccountId, selectedAliasId }) {
  if (!selectedAccountId) return {};
  return selectedAliasId ? { accountId: selectedAccountId, aliasId: selectedAliasId } : { accountId: selectedAccountId };
}

// The alias a reply to `message` should send from when an alias view is open: the open alias, but
// only for a letter of that view - a letter of its mailbox sent From the alias (its Sent), or one
// whose reply pick (the recipient pill, pickReplyAlias) is the alias (its Inbox). Any other letter
// (search results across the mailbox, a conversation letter to another alias, GTD triage) gets
// null, so the caller's own pickReplyAlias decides and one client never sees another's address.
// `accounts` (the store's mailbox list) gives the alias's address.
export function viewReplyAliasId(message, { selectedAccountId, selectedAliasId, accounts } = {}) {
  if (!selectedAliasId || !message || message.account_id !== selectedAccountId) return null;
  const account = (Array.isArray(accounts) ? accounts : []).find((a) => a.id === selectedAccountId);
  const alias = replyAliasesOf(account).find((a) => a.id === selectedAliasId);
  if (!alias) return null;
  if (lower(message.from_email) === lower(alias.email)) return selectedAliasId;
  const picked = pickReplyAlias({
    aliases: account.aliases || [],
    deliveryAddresses: message.delivery_addresses,
    toAddresses: message.to_addresses,
    ccAddresses: message.cc_addresses,
    fromEmail: message.from_email,
    accountEmail: account.email_address || '',
    mailNode: account.mail_node === true,
  });
  return picked === selectedAliasId ? selectedAliasId : null;
}
