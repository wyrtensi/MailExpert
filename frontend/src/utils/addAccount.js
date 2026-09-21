// "Add account" dialog: which ways to add a mailbox are offered, the Gmail address suggestions and
// the form's error messages. Pure functions: no DOM, no store, no network, so they run under
// `node --test`.
import { computeAccountHealth, reconnectUrlFor } from './accountHealth.js';

// The ways to add a mailbox, in the order the dialog lists them. The dialog renders whatever
// addAccountOptions returns through a kind -> form table, so the domain mailbox (PR 9) is one
// entry here plus its form.
export const ADD_ACCOUNT_KINDS = Object.freeze(['gmail', 'manual']);

// Same check as POST /api/oauth/google/start (backend services/oauth/googleLaunch.js).
export const GMAIL_EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
export const SUGGESTION_LIMIT = 8;
export const KNOWN_EMAILS_MIN_QUERY = 2;
export const KNOWN_EMAILS_MAX_QUERY = 254;
export const KNOWN_EMAILS_DEBOUNCE_MS = 200;
// How long the one-time launch path from start stays valid (GOOGLE_LAUNCH_TTL_SECONDS).
export const GOOGLE_LAUNCH_TTL_MS = 60 * 1000;

const OPTION_KEYS = {
  gmail: { titleKey: 'admin.accounts.add.gmailTitle', descriptionKey: 'admin.accounts.add.gmailDescription' },
  manual: { titleKey: 'admin.accounts.add.manualTitle', descriptionKey: 'admin.accounts.add.manualDescription' },
};

// Spelled out literally so the i18n coverage test finds them.
export const SUGGESTION_BADGE_KEYS = Object.freeze({
  connected: 'admin.accounts.add.badgeConnected',
  reconnect: 'admin.accounts.add.badgeReconnect',
  disabled: 'admin.accounts.add.badgeDisabled',
  known: 'admin.accounts.add.badgeKnown',
});

const START_ERROR_KEYS = {
  already_connected: 'admin.integrations.google.errorAlreadyConnected',
  no_app_capacity: 'admin.integrations.google.errorNoAppCapacity',
  not_configured: 'admin.integrations.google.errorNotConfigured',
  email_invalid: 'admin.accounts.add.errorInvalidEmail',
};
const START_ERROR_FALLBACK_KEY = 'admin.integrations.google.errorGeneric';

const normalize = (email) => String(email ?? '').trim().toLowerCase();

// Why Gmail cannot be chosen right now, or null. `googleStatus` is the `google` part of
// GET /api/integrations/status, or null while it loads.
function gmailUnavailableHint(googleStatus) {
  if (!googleStatus) return null;
  if (!googleStatus.configured) return 'admin.integrations.google.errorNotConfigured';
  return 'admin.integrations.google.errorNoAppCapacity';
}

// Options the dialog lists. Manual server setup is for administrators only (the server answers
// 403 to anyone else). Gmail is listed for everyone but stays inactive, with the reason, while no
// Google app can take a new address.
export function addAccountOptions({ isAdmin = false, googleStatus = null } = {}) {
  const options = [];
  for (const kind of ADD_ACCOUNT_KINDS) {
    if (kind === 'manual' && !isAdmin) continue;
    const enabled = kind !== 'gmail' || googleStatus?.available === true;
    const hintKey = kind === 'gmail' && !enabled ? gmailUnavailableHint(googleStatus) : null;
    options.push({ kind, ...OPTION_KEYS[kind], enabled, hintKey });
  }
  return options;
}

// How a mailbox of the install shows up in the suggestions. Mailboxes are shared, so every
// mailbox in the store counts, whoever added it.
export function mailboxSuggestion(account) {
  const email = normalize(account?.email_address);
  const health = account?.health ?? computeAccountHealth(account);
  if (health === 'disabled') return { email, kind: 'disabled', reconnectUrl: null };
  if (health === 'oauth_reconnect_required') {
    const url = reconnectUrlFor(account);
    if (url) return { email, kind: 'reconnect', reconnectUrl: url };
  }
  return { email, kind: 'connected', reconnectUrl: null };
}

// Rows under the Gmail field: mailboxes of the install whose address contains the query (by
// address), then addresses from the grant journal without a mailbox (the server's order), with
// no address twice and at most SUGGESTION_LIMIT rows.
export function buildEmailSuggestions({ query, accounts = [], knownEmails = [] } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const seen = new Set();
  const mailboxes = [];
  for (const account of accounts) {
    const row = mailboxSuggestion(account);
    if (!row.email || !row.email.includes(q) || seen.has(row.email)) continue;
    seen.add(row.email);
    mailboxes.push(row);
  }
  mailboxes.sort((a, b) => a.email.localeCompare(b.email));
  const known = [];
  for (const raw of knownEmails) {
    const email = normalize(raw);
    if (!email || !email.includes(q) || seen.has(email)) continue;
    seen.add(email);
    known.push({ email, kind: 'known', reconnectUrl: null });
  }
  return [...mailboxes, ...known].slice(0, SUGGESTION_LIMIT);
}

// The mailbox whose address is typed in full, as a suggestion row, or null. Its badge shows under
// the field even with the list closed.
export function exactMailboxMatch(email, accounts = []) {
  const wanted = normalize(email);
  if (!wanted) return null;
  const account = accounts.find((a) => normalize(a?.email_address) === wanted);
  return account ? mailboxSuggestion(account) : null;
}

// "Continue with Google" is active for a valid address that is not a mailbox yet.
export function canStartGmail(email, accounts = []) {
  const value = String(email ?? '').trim();
  return GMAIL_EMAIL_PATTERN.test(value) && !exactMailboxMatch(value, accounts);
}

export function shouldFetchKnownEmails(query) {
  const q = String(query ?? '').trim();
  return q.length >= KNOWN_EMAILS_MIN_QUERY && q.length <= KNOWN_EMAILS_MAX_QUERY;
}

// Next highlighted row for an arrow key; -1 means no row. Wraps around both ends.
export function moveSuggestionHighlight(index, key, count) {
  if (!count) return -1;
  if (key === 'ArrowDown') return index < 0 || index >= count - 1 ? 0 : index + 1;
  if (key === 'ArrowUp') return index <= 0 ? count - 1 : index - 1;
  return index;
}

// What choosing a row does: a journal address fills the field (the app is picked by the journal,
// no seat is spent), a broken mailbox reconnects; connected and disabled mailboxes cannot be picked.
export function suggestionAction(row) {
  if (row?.kind === 'known') return { type: 'fill', email: row.email };
  if (row?.kind === 'reconnect' && row.reconnectUrl) return { type: 'reconnect', url: row.reconnectUrl };
  return null;
}

// Own-property lookup so codes like "toString" fall back to the generic message.
export function gmailStartErrorKey(code) {
  return typeof code === 'string' && Object.hasOwn(START_ERROR_KEYS, code) ? START_ERROR_KEYS[code] : START_ERROR_FALLBACK_KEY;
}
