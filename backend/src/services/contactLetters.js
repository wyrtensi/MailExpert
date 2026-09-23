import { query } from './db.js';

// A contact's correspondence across EVERY mailbox, not just the one an open letter belongs to
// (that narrower "before this letter" view is senderHistory.js — read together, this mirrors
// its address handling and SQL shapes, just fanned out over every enabled account instead of one).

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

// The recipient-match fragment shared by both queries below: true when one of the addresses in
// $3 (the contact's addresses) appears in the letter's To or Cc.
const RECIPIENT_MATCH_SQL = `
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      (CASE WHEN jsonb_typeof(m.to_addresses) = 'array' THEN m.to_addresses ELSE '[]'::jsonb END)
      || (CASE WHEN jsonb_typeof(m.cc_addresses) = 'array' THEN m.cc_addresses ELSE '[]'::jsonb END)
    ) AS rcpt
    WHERE lower(CASE WHEN jsonb_typeof(rcpt) = 'string' THEN rcpt #>> '{}' ELSE rcpt ->> 'email' END) = ANY($3::text[])
  )
`;

// Shared CTE chain for both the aggregate and the page query below. Placeholders:
//   $1 = every address worth an index hit — the contact's addresses union every enabled
//        account's own address and alias addresses (lower(from_email) = ANY($1) is the leading
//        filter that can use idx_messages_account_from_date(account_id, lower(from_email), date)).
//   $2 = enabled account ids ("account_id = ANY($2)", the other half of that index).
//   $3 = the contact's addresses, lowercased — decides 'in' and the recipient side of 'out'.
//   $4/$5 = unnest pair (account_id, own_email) — 'out' needs the sender to be THAT account's own
//           address, not merely some other mailbox's, so this can't be a flat address list.
//   $6/$7 = unnest pair (account_id, folder) to skip — each account's own trash/spam path.
const FILTERED_CTE_SQL = `
  WITH own(account_id, email) AS (
    SELECT * FROM unnest($4::uuid[], $5::text[])
  ),
  skip(account_id, folder) AS (
    SELECT * FROM unnest($6::uuid[], $7::text[])
  ),
  candidates AS (
    SELECT m.id, m.account_id, m.folder, m.subject, m.snippet, m.date, m.message_id,
      CASE
        WHEN lower(m.from_email) = ANY($3::text[]) THEN 'in'
        WHEN EXISTS (SELECT 1 FROM own WHERE own.account_id = m.account_id AND own.email = lower(m.from_email))
          AND ${RECIPIENT_MATCH_SQL}
        THEN 'out'
        ELSE NULL
      END AS direction
    FROM messages m
    WHERE m.account_id = ANY($2::uuid[])
      AND lower(m.from_email) = ANY($1::text[])
      AND m.is_deleted = false
      AND NOT EXISTS (SELECT 1 FROM skip WHERE skip.account_id = m.account_id AND skip.folder = m.folder)
  ),
  filtered AS (
    -- A letter stored in several folders (Gmail labels) counts once per mailbox: the same
    -- Message-ID can legitimately appear in two different mailboxes when the contact wrote to
    -- both, and each mailbox's copy is its own row in the UI (it names the mailbox), so the
    -- de-dup key is (account_id, message_id) rather than message_id alone.
    SELECT DISTINCT ON (account_id, COALESCE(message_id, id::text))
      id, account_id, folder, subject, snippet, date, direction
    FROM candidates
    WHERE direction IS NOT NULL
    ORDER BY account_id, COALESCE(message_id, id::text), date DESC
  )
`;

async function ownAndSkipParams(accountIds) {
  if (!accountIds.length) return { ownAccountIds: [], ownEmails: [], skipAccountIds: [], skipFolders: [] };

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
  for (const account of accountsResult.rows) {
    const addresses = [account.email_address, ...(aliasesByAccount.get(account.id) || [])]
      .map(lower).filter(Boolean);
    for (const email of addresses) {
      ownAccountIds.push(account.id);
      ownEmails.push(email);
    }
    const mappings = account.folder_mappings || {};
    for (const folder of [mappings.trash, mappings.spam]) {
      if (typeof folder === 'string' && folder) {
        skipAccountIds.push(account.id);
        skipFolders.push(folder);
      }
    }
  }
  return { ownAccountIds, ownEmails, skipAccountIds, skipFolders };
}

// { received, sent, lastDate, total, items: [{ id, account_id, folder, subject, snippet, date,
// direction: 'in' | 'out' }] }, newest first; null when the contact does not exist.
export async function contactLetters(contactId, { limit = CONTACT_LETTERS_DEFAULT_LIMIT, offset = 0 } = {}) {
  const cappedLimit = Math.max(1, Math.min(Number(limit) || CONTACT_LETTERS_DEFAULT_LIMIT, CONTACT_LETTERS_MAX_LIMIT));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const contactResult = await query('SELECT emails FROM contacts WHERE id = $1', [contactId]);
  if (!contactResult.rows.length) return null;

  const addresses = [...new Set(addressList(contactResult.rows[0].emails).map((e) => lower(e?.value)).filter(Boolean))];
  const empty = { received: 0, sent: 0, lastDate: null, total: 0, items: [] };
  if (!addresses.length) return empty;

  const enabledAccounts = await query('SELECT id FROM email_accounts WHERE enabled = true');
  const accountIds = enabledAccounts.rows.map((r) => r.id);
  if (!accountIds.length) return empty;

  const { ownAccountIds, ownEmails, skipAccountIds, skipFolders } = await ownAndSkipParams(accountIds);
  const allFromAddresses = [...new Set([...addresses, ...ownEmails])];
  const params = [allFromAddresses, accountIds, addresses, ownAccountIds, ownEmails, skipAccountIds, skipFolders];

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
      ORDER BY date DESC NULLS LAST
      LIMIT $8 OFFSET $9
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
