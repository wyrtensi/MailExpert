import { sanitizeSignature } from './emailSanitizer.js';

// Gmail "send mail as" import. This file holds the pure parts: reading users.settings.sendAs.list
// and planning which account_aliases rows to create, update, adopt or remove. No database access
// here; the caller applies the plan.

export const GMAIL_SEND_AS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs';

export class GmailSendAsError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'GmailSendAsError';
    this.code = code;
    this.status = status;
  }
}

function codeForStatus(status) {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return 'upstream';
}

// Never put the token, the Authorization header or the response body into an error message.
export async function fetchGmailSendAs({ accessToken, signal } = {}) {
  let res;
  try {
    res = await fetch(GMAIL_SEND_AS_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
  } catch {
    throw new GmailSendAsError('upstream', null, 'Gmail send-as request failed (network error)');
  }
  if (!res.ok) {
    throw new GmailSendAsError(codeForStatus(res.status), res.status, `Gmail send-as request failed (HTTP ${res.status})`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new GmailSendAsError('bad_response', res.status, 'Gmail send-as response is not valid JSON');
  }
  if (!body || !Array.isArray(body.sendAs)) {
    throw new GmailSendAsError('bad_response', res.status, 'Gmail send-as response has no sendAs array');
  }
  return body.sendAs;
}

const lc = (s) => String(s || '').trim().toLowerCase();
const blank = (v) => (v == null || v === '' ? null : v);

function toFields(entry) {
  const email = String(entry.sendAsEmail).trim();
  const displayName = typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
  return {
    name: displayName || email.split('@')[0],
    email,
    reply_to: entry.replyToAddress || null,
    signature: sanitizeSignature(entry.signature || '') || null,
  };
}

function sameFields(row, fields) {
  return row.name === fields.name
    && row.email === fields.email
    && blank(row.reply_to) === blank(fields.reply_to)
    && blank(row.signature) === blank(fields.signature);
}

export function planSendAsSync({ accountEmail, existing = [], sendAs = [] }) {
  const own = lc(accountEmail);
  const candidates = new Map();
  for (const entry of sendAs) {
    if (!entry || !entry.sendAsEmail || !String(entry.sendAsEmail).trim()) continue;
    if (entry.verificationStatus !== 'accepted' || entry.isPrimary === true) continue;
    const key = lc(entry.sendAsEmail);
    if (key === own || candidates.has(key)) continue;
    candidates.set(key, toFields(entry));
  }

  const gmailRows = new Map();
  const manualRows = new Map();
  for (const row of existing) {
    const key = lc(row.email);
    if (row.source === 'gmail') {
      if (!gmailRows.has(key)) gmailRows.set(key, row);
    } else if (key !== own && !manualRows.has(key)) {
      manualRows.set(key, row);
    }
  }

  const plan = { create: [], update: [], adopt: [], remove: [] };
  for (const [key, fields] of candidates) {
    const g = gmailRows.get(key);
    const m = manualRows.get(key);
    if (g) {
      if (!sameFields(g, fields)) plan.update.push({ id: g.id, fields });
    } else if (m) {
      plan.adopt.push({ id: m.id, fields });
    } else {
      plan.create.push(fields);
    }
  }
  for (const [key, row] of gmailRows) {
    if (!candidates.has(key)) plan.remove.push(row.id);
  }
  return plan;
}
