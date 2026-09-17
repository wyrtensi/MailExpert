// Gmail's ids for a fetched message, as imapflow returns them: X-GM-THRID in `threadId` (only when
// the FETCH asked for `threadId: true`) and X-GM-MSGID in `emailId` (always requested on Gmail).
// Both are unsigned 64-bit integers; anything that is not a plain decimal id is ignored.
const DECIMAL_ID = /^\d{1,20}$/;

function decimalId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return DECIMAL_ID.test(text) ? text : null;
}

export function gmailProviderIds(msg) {
  return {
    providerThreadId: decimalId(msg?.threadId),
    providerMessageId: decimalId(msg?.emailId),
  };
}

export const NO_PROVIDER_IDS = Object.freeze({ providerThreadId: null, providerMessageId: null });
