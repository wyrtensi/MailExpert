import { query } from './db.js';

// A contact's correspondence across EVERY mailbox, not just the one an open letter belongs to
// (that narrower "before this letter" view is senderHistory.js — read together, this mirrors
// its address handling and SQL shapes, just fanned out over every enabled account instead of one).
//
// Direction precedence matches utils/mailboxBanner.js exactly: an own address (the account's
// address or one of its aliases) as the sender is ALWAYS 'out', checked first — even when the
// contact's own address happens to equal one of our mailboxes (an auto-contact can be one of our
// shared mailboxes). Only once that's ruled out does a letter from one of the contact's addresses
// count as 'in'. Getting this order backwards would badge every letter that mailbox sent as
// "Получено", with no recipient check, for exactly the contacts most likely to trigger it.
//
// Dedup is per MAILBOX, not globally: the same Message-ID can legitimately land in two different
// mailboxes (the contact wrote to both, or cc'd both), and the UI names the mailbox per row, so
// each mailbox's copy is its own row and its own count — a letter to sales@ and info@ (both of
// ours) counts as 2 received, not 1.

export const CONTACT_LETTERS_DEFAULT_LIMIT = 20;
export const CONTACT_LETTERS_MAX_LIMIT = 50;

const lower = (value) => String(value ?? '').trim().toLowerCase();

function addressList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Shared CTE chain for both the aggregate and the page query below. Placeholders:
//   $1 = enabled account ids.
//   $2 = the contact's addresses, lowercased.
//   $3/$4 = unnest pair (account_id, own_email) — the account's address + its aliases. 'out'
//           needs the sender to be THAT account's own address, not merely some other mailbox's,
//           so this can't be a flat address list; 'in' uses it to exclude an own-address row
//           (precedence, see module comment above).
//   $5/$6 = unnest pair (account_id, folder) to skip — each account's own trash/spam/drafts path.
//   $7/$8 = unnest pair (account_id, folder) preferred on a dedup tie — each account's own
//           inbox/sent path, so "Show more" paging doesn't depend on which Gmail-label copy of a
//           letter the planner happens to visit first (see the `filtered` comment below).
//
// The 'in' branch's leading filter (account_id = ANY($1) AND lower(from_email) = ANY($2), where
// $2 is just the contact's own handful of addresses) is index-assisted by
// idx_messages_account_from_date(account_id, lower(from_email), date). The 'out' branch's leading
// filter uses the same index shape but over the account's own addresses instead (still a small,
// bounded set per account), and then checks the recipient side with the GIN-indexed
// message_recipient_addresses() (migration 0071) rather than a per-row jsonb_array_elements scan
// — with 50-100 mailboxes, scanning every sent letter in the fleet row by row was the actual cost
// this function used to pay on every contact click.
const FILTERED_CTE_SQL = `
  WITH own(account_id, email) AS (
    SELECT * FROM unnest($3::uuid[], $4::text[])
  ),
  skip(account_id, folder) AS (
    SELECT * FROM unnest($5::uuid[], $6::text[])
  ),
  primary_folder(account_id, folder) AS (
    SELECT * FROM unnest($7::uuid[], $8::text[])
  ),
  candidates_in AS (
    SELECT m.id, m.account_id, m.folder, m.subject, m.snippet, m.date, m.message_id,
           'in'::text AS direction
    FROM messages m
    WHERE m.account_id = ANY($1::uuid[])
      AND lower(m.from_email) = ANY($2::text[])
      AND m.is_deleted = false
      AND NOT EXISTS (SELECT 1 FROM skip WHERE skip.account_id = m.account_id AND skip.folder = m.folder)
      -- Precedence: an own address always wins (see module comment), so this is 'out', not 'in'.
      AND NOT EXISTS (SELECT 1 FROM own WHERE own.account_id = m.account_id AND own.email = lower(m.from_email))
  ),
  candidates_out AS (
    SELECT m.id, m.account_id, m.folder, m.subject, m.snippet, m.date, m.message_id,
           'out'::text AS direction
    FROM messages m
    WHERE m.account_id = ANY($1::uuid[])
      AND EXISTS (SELECT 1 FROM own WHERE own.account_id = m.account_id AND own.email = lower(m.from_email))
      AND m.is_deleted = false
      AND NOT EXISTS (SELECT 1 FROM skip WHERE skip.account_id = m.account_id AND skip.folder = m.folder)
      AND message_recipient_addresses(m.to_addresses, m.cc_addresses) && $2::text[]
  ),
  candidates AS (
    SELECT * FROM candidates_in
    UNION ALL
    SELECT * FROM candidates_out
  ),
  filtered AS (
    -- A letter stored in several folders (Gmail labels) counts once per mailbox (see module
    -- comment). Among a mailbox's copies, prefer its INBOX/Sent copy over a label folder so a
    -- row consistently opens in the "real" folder rather than whichever label the planner
    -- visited first, then the id, so paging never depends on the query plan.
    SELECT DISTINCT ON (account_id, COALESCE(message_id, id::text))
      id, account_id, folder, subject, snippet, date, direction
    FROM candidates
    ORDER BY account_id, COALESCE(message_id, id::text),
      CASE WHEN EXISTS (
        SELECT 1 FROM primary_folder pf WHERE pf.account_id = candidates.account_id AND pf.folder = candidates.folder
      ) THEN 0 ELSE 1 END,
      date DESC, id
  )
`;

async function accountFilterParams(accountIds) {
  if (!accountIds.length) {
    return { ownAccountIds: [], ownEmails: [], skipAccountIds: [], skipFolders: [], primaryAccountIds: [], primaryFolders: [] };
  }

  const accountsResult = await query(
    'SELECT id, email_address, folder_mappings FROM email_accounts WHERE id = ANY($1)',
    [accountIds],
  );
  const aliasResult = await query(
    'SELECT account_id, email FROM account_aliases WHERE account_id = ANY($1)',
    [accountIds],
  );
  const aliasesByAccount = new Map();
  for (const row of aliasResult.rows) {
    if (!aliasesByAccount.has(row.account_id)) aliasesByAccount.set(row.account_id, []);
    aliasesByAccount.get(row.account_id).push(row.email);
  }

  const ownAccountIds = [];
  const ownEmails = [];
  const skipAccountIds = [];
  const skipFolders = [];
  const primaryAccountIds = [];
  const primaryFolders = [];
  for (const account of accountsResult.rows) {
    const addresses = [account.email_address, ...(aliasesByAccount.get(account.id) || [])]
      .map(lower).filter(Boolean);
    for (const email of addresses) {
      ownAccountIds.push(account.id);
      ownEmails.push(email);
    }
    const mappings = account.folder_mappings || {};
    // Drafts are not sent yet, so an unsent draft never counts as (or shows as) "Отправлено" —
    // skipped the same way trash/spam are.
    for (const folder of [mappings.trash, mappings.spam, mappings.drafts]) {
      if (typeof folder === 'string' && folder) {
        skipAccountIds.push(account.id);
        skipFolders.push(folder);
      }
    }
    for (const folder of [mappings.inbox || 'INBOX', mappings.sent]) {
      if (typeof folder === 'string' && folder) {
        primaryAccountIds.push(account.id);
        primaryFolders.push(folder);
      }
    }
  }
  return { ownAccountIds, ownEmails, skipAccountIds, skipFolders, primaryAccountIds, primaryFolders };
}

// { received, sent, lastDate, total, items: [{ id, account_id, folder, subject, snippet, date,
// direction: 'in' | 'out' }] }, newest first; null when the contact does not exist.
export async function contactLetters(contactId, { limit = CONTACT_LETTERS_DEFAULT_LIMIT, offset = 0 } = {}) {
  const cappedLimit = Math.max(1, Math.min(Math.trunc(Number(limit)) || CONTACT_LETTERS_DEFAULT_LIMIT, CONTACT_LETTERS_MAX_LIMIT));
  const safeOffset = Math.max(0, Math.trunc(Number(offset)) || 0);

  const contactResult = await query('SELECT emails FROM contacts WHERE id = $1', [contactId]);
  if (!contactResult.rows.length) return null;

  const addresses = [...new Set(addressList(contactResult.rows[0].emails).map((e) => lower(e?.value)).filter(Boolean))];
  const empty = { received: 0, sent: 0, lastDate: null, total: 0, items: [] };
  if (!addresses.length) return empty;

  const enabledAccounts = await query('SELECT id FROM email_accounts WHERE enabled = true');
  const accountIds = enabledAccounts.rows.map((r) => r.id);
  if (!accountIds.length) return empty;

  const { ownAccountIds, ownEmails, skipAccountIds, skipFolders, primaryAccountIds, primaryFolders } =
    await accountFilterParams(accountIds);
  const params = [accountIds, addresses, ownAccountIds, ownEmails, skipAccountIds, skipFolders, primaryAccountIds, primaryFolders];

  const [aggResult, itemsResult] = await Promise.all([
    query(`
      ${FILTERED_CTE_SQL}
      SELECT
        count(*) FILTER (WHERE direction = 'in') AS received,
        count(*) FILTER (WHERE direction = 'out') AS sent,
        max(date) AS last_date,
        count(*) AS total
      FROM filtered
    `, params),
    query(`
      ${FILTERED_CTE_SQL}
      SELECT id, account_id, folder, subject, snippet, date, direction
      FROM filtered
      ORDER BY date DESC NULLS LAST, account_id, id
      LIMIT $9 OFFSET $10
    `, [...params, cappedLimit, safeOffset]),
  ]);

  const agg = aggResult.rows[0] || {};
  return {
    received: Number(agg.received) || 0,
    sent: Number(agg.sent) || 0,
    lastDate: agg.last_date || null,
    total: Number(agg.total) || 0,
    items: itemsResult.rows.map((r) => ({
      id: r.id,
      account_id: r.account_id,
      folder: r.folder,
      subject: r.subject,
      snippet: r.snippet,
      date: r.date,
      direction: r.direction,
    })),
  };
}
