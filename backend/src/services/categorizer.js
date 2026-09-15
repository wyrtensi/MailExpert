import { query } from './db.js';
import { completeText } from './aiProvider.js';
import { detectCategoryFromHeaders } from './messageParser.js';

// Social domains and the categorization switch are install-wide. Both are cached briefly and
// dropped when someone changes category_list_sources or an admin flips the switch.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let socialDomainCache = null;         // { domains: Set<string>, expiry: number }
let globalCategorizationCache = null; // { value: boolean, expiry: number }

export function invalidateSocialDomainCache() {
  socialDomainCache = null;
}

export async function getGlobalCategorizationEnabled() {
  if (globalCategorizationCache && globalCategorizationCache.expiry > Date.now()) return globalCategorizationCache.value;
  const result = await query("SELECT value FROM system_settings WHERE key = 'categorization_enabled'");
  const value = result.rows[0]?.value === 'true';
  globalCategorizationCache = { value, expiry: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidateGlobalCategorizationCache() {
  globalCategorizationCache = null;
}

// Known shipping carrier / logistics sender domains → 'automated'.
// Kept narrow (pure carriers) to avoid false-positives on domains like
// amazon.com that also send promotional and transactional mail.
const SHIPPING_DOMAINS = new Set([
  'ups.com', 'pkginfo.ups.com', 'email.ups.com',
  'fedex.com', 'email.fedex.com', 'fedexemail.com',
  'usps.com', 'informeddelivery.usps.com',
  'dhl.com', 'dhlparcel.com',
  'ontrac.com',
  'lasership.com', 'lasership-email.com',
  'dpd.com', 'dpd.de', 'dpd.fr',
  'royalmail.com',
  'canadapost.ca', 'canadapost-postescanada.ca',
  'auspost.com.au',
  'gls-group.eu', 'gls-group.com',
]);

// Known built-in social domain sets bundled with the app.
// Users enable these by name; domains are resolved here, not in the DB.
const BUILTIN_SETS = {
  social_networks: [
    'facebookmail.com', 'notification.facebook.com', 'facebookappmail.com',
    'twitteremail.com', 'mail.twitter.com', 'x.com',
    'linkedin.com', 'notifications.linkedin.com',
    'instagrammail.com', 'notification.instagram.com',
    'tiktok.com', 'emailmg.tiktok.com',
    'redditmail.com', 'reddit.com',
    'pinterest.com', 'email.pinterest.com',
    'snapchat.com',
    'discordapp.com', 'discord.com',
  ],
  developer_platforms: [
    'github.com', 'noreply.github.com', 'notifications.github.com',
    'gitlab.com', 'noreply.gitlab.com',
    'npmjs.com', 'stackoverflow.com',
    'hackerrank.com', 'leetcode.com',
  ],
};

async function loadSocialDomains() {
  if (socialDomainCache && socialDomainCache.expiry > Date.now()) return socialDomainCache.domains;

  const result = await query(
    `SELECT source_type, value, resolved_domains
     FROM category_list_sources
     WHERE enabled = true`
  );

  const domains = new Set();
  for (const row of result.rows) {
    if (row.source_type === 'manual') {
      domains.add(row.value.toLowerCase().trim());
    } else if (row.source_type === 'builtin') {
      const set = BUILTIN_SETS[row.value];
      if (set) set.forEach(d => domains.add(d));
    } else if (row.source_type === 'url' && Array.isArray(row.resolved_domains)) {
      row.resolved_domains.forEach(d => domains.add(d.toLowerCase().trim()));
    }
  }

  socialDomainCache = { domains, expiry: Date.now() + CACHE_TTL_MS };
  return domains;
}

// Determines the category for a single message given its parsed headers,
// sender address, and the install's social domain set.
// Returns 'primary' | 'newsletter' | 'promotion' | 'automated' | 'social'.
export function classifyMessage(parsedHeaders, fromEmail, socialDomains) {
  // Social check first — user intent overrides header-based detection.
  if (socialDomains && socialDomains.size > 0 && fromEmail) {
    const addr = fromEmail.toLowerCase().trim();
    const atIdx = addr.indexOf('@');
    const domain = atIdx >= 0 ? addr.slice(atIdx + 1) : null;
    if (socialDomains.has(addr)) return 'social';
    if (domain && socialDomains.has(domain)) return 'social';
  }

  // Known shipping carrier domains → automated, checked before headers so
  // these always land in Automated even if they also set list headers.
  if (fromEmail) {
    const addr = fromEmail.toLowerCase().trim();
    const atIdx = addr.indexOf('@');
    const domain = atIdx >= 0 ? addr.slice(atIdx + 1) : null;
    if (domain && SHIPPING_DOMAINS.has(domain)) return 'automated';
  }

  const headerCategory = detectCategoryFromHeaders(parsedHeaders);
  return headerCategory ?? 'primary';
}

// Use the configured AI provider to classify a message that has no header
// signals. Returns a valid category string, or null if AI is unavailable or
// the response is unusable. Errors are swallowed — the caller treats null as
// 'keep primary'.
export async function aiClassifyMessage(subject, fromEmail, snippet) {
  const prompt = `Classify this email into exactly one category. Reply with only the category name, nothing else.

Categories:
- primary: personal email, work correspondence, direct replies
- newsletter: mailing lists, blog digests, subscribed newsletters
- promotion: marketing, sales, discount offers, advertisements
- automated: transactional email, receipts, notifications, alerts, password resets
- social: social media notifications (Facebook, Twitter, LinkedIn, etc.)

From: ${fromEmail || '(unknown)'}
Subject: ${(subject || '').slice(0, 200)}
${snippet ? `Preview: ${snippet.slice(0, 300)}` : ''}

Category:`;

  try {
    const response = await completeText([{ role: 'user', content: prompt }], { maxTokens: 1024 });
    if (typeof response !== 'string') return null;
    const category = response.toLowerCase().trim();
    return ['primary', 'newsletter', 'promotion', 'automated', 'social'].includes(category)
      ? category
      : null;
  } catch {
    return null;
  }
}

// Assigns a category to a message and writes it to the DB.
// Used during IMAP sync for new messages when categorization is enabled.
export async function categorizeAndStore(messageId, parsedHeaders, fromEmail) {
  const socialDomains = await loadSocialDomains();
  const category = classifyMessage(parsedHeaders, fromEmail, socialDomains);
  if (category !== 'primary') {
    await query('UPDATE messages SET category = $1 WHERE id = $2', [category, messageId]);
  }
  return category;
}

// Backfills categories for all uncategorized messages belonging to an account.
// Fetches headers from DB (is_bulk + from_email are already stored) and applies
// header-based detection without an IMAP round-trip. Social domain matching
// requires a separate header fetch and is handled in imapManager.refreshCategories().
export async function backfillCategories(accountId) {
  const socialDomains = await loadSocialDomains();

  // Process in batches of 500 to avoid memory pressure.
  //
  // Paged by a keyset on id, NOT by OFFSET. The result set shrinks under the cursor as we
  // work: a row that gets a category drops out of `category IS NULL`, while a row we
  // classify as primary is left NULL and stays in. With OFFSET that meant every row we
  // categorized pushed one un-examined row past the next window, so it was never
  // classified at all and nothing reported it. Keying off the last id visits every row
  // exactly once however the set changes underneath.
  //
  // id rather than date: it is a non-null primary key, so the ordering is total, whereas
  // date is nullable and DESC would put NULLs first and break the cursor comparison. The
  // order rows are visited in does not affect which category any of them gets.
  const BATCH = 500;
  let lastId = null;
  let processed = 0;

  for (;;) {
    const result = await query(
      `SELECT id, from_email, is_bulk
       FROM messages
       WHERE account_id = $1
         AND category IS NULL
         AND is_deleted = false
         AND ($2::uuid IS NULL OR id > $2::uuid)
       ORDER BY id
       LIMIT $3`,
      [accountId, lastId, BATCH]
    );
    if (!result.rows.length) break;

    const ids = [];
    const categories = [];

    for (const row of result.rows) {
      // For backfill without re-fetching IMAP headers, derive from is_bulk
      // (which already encodes the newsletter signal) and social domain check.
      let category = 'primary';

      if (socialDomains && socialDomains.size > 0 && row.from_email) {
        const addr = row.from_email.toLowerCase().trim();
        const atIdx = addr.indexOf('@');
        const domain = atIdx >= 0 ? addr.slice(atIdx + 1) : null;
        if (socialDomains.has(addr) || (domain && socialDomains.has(domain))) {
          category = 'social';
        }
      }

      if (category === 'primary' && row.is_bulk) {
        category = 'newsletter';
      }

      if (category !== 'primary') {
        ids.push(row.id);
        categories.push(category);
      }
    }

    if (ids.length > 0) {
      await query(
        `UPDATE messages SET category = v.category
         FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS category) AS v
         WHERE messages.id = v.id`,
        [ids, categories]
      );
    }

    processed += result.rows.length;
    lastId = result.rows[result.rows.length - 1].id;
    if (result.rows.length < BATCH) break;
  }

  return processed;
}

export { BUILTIN_SETS, loadSocialDomains };
