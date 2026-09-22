// "Conversation" under the headers modal (GET /mail/messages/:id/threading): why a letter
// landed in its conversation. Pure functions: no DOM, no store, no network, so they run under
// `node --test`.

// Spelled out literally so the i18n coverage test finds them.
const REASON_KEYS = {
  'gmail-thrid': 'message.threading.reason.gmailThrid',
  'new-root': 'message.threading.reason.newRoot',
  'rfc-root': 'message.threading.reason.rfcRoot',
  'rfc-ancestor': 'message.threading.reason.rfcAncestor',
  'rfc-provisional': 'message.threading.reason.rfcProvisional',
};
const REASON_UNKNOWN_KEY = 'message.threading.reason.unknown';

// A human sentence for computeThreading's reason: a stored key from before diagnostics
// existed, or an old row with no Message-ID, comes back as null and reads as "not recorded".
export function reasonKey(reason) {
  return REASON_KEYS[reason] ?? REASON_UNKNOWN_KEY;
}

const MODE_KEYS = {
  gmail: 'message.threading.mode.gmail',
  rfc: 'message.threading.mode.rfc',
};

// The mailbox's threading mode (email_accounts.thread_mode); unset reads as 'rfc', its default.
export function modeKey(mode) {
  return MODE_KEYS[mode] ?? MODE_KEYS.rfc;
}

// The Gmail thread number is only worth a row once the mailbox has backfilled one.
export function hasGmailThreadNumber(diagnostics) {
  return !!diagnostics?.providerThreadId;
}

export function hasReferences(diagnostics) {
  return Array.isArray(diagnostics?.references) && diagnostics.references.length > 0;
}

// Folders sorted the way the server already sends them (count desc, then folder) — this just
// guards against a diagnostics payload with none at all.
export function conversationFolders(diagnostics) {
  return Array.isArray(diagnostics?.conversation?.folders) ? diagnostics.conversation.folders : [];
}

export function conversationTotal(diagnostics) {
  return Number(diagnostics?.conversation?.total) || 0;
}
