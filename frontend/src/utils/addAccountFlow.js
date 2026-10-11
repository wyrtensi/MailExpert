// Local state of the "Add account" dialog: which screen is shown, which provider is chosen and the
// address typed so far. Pure functions, no DOM, no store, no network. Passwords are deliberately
// not part of this state (nor of any Zustand store): they live in the form that owns the field
// and die with it.
import { ADD_ACCOUNT_KINDS } from './addAccount.js';

export function initialAddAccountFlow() {
  return { screen: 'picker', provider: null, email: '' };
}

// Events: { type: 'select', provider } | { type: 'back' } | { type: 'email', email } | { type: 'close' }.
// An event that changes nothing returns the same object, so React skips the render.
export function transitionAddAccountFlow(state, event) {
  switch (event?.type) {
    case 'select':
      if (!ADD_ACCOUNT_KINDS.includes(event.provider)) return state;
      return { screen: 'form', provider: event.provider, email: state.email };
    case 'back':
      return { screen: 'picker', provider: null, email: state.email };
    case 'email':
      return typeof event.email === 'string' ? { ...state, email: event.email } : state;
    case 'close':
      return initialAddAccountFlow();
    default:
      return state;
  }
}

// Insert or replace one account by id against the list it is given (the caller passes the
// latest store state, never a captured array).
export function upsertAccountById(list, account) {
  const current = Array.isArray(list) ? list : [];
  if (!account || typeof account !== 'object' || !account.id) return current;
  const index = current.findIndex((item) => item?.id === account.id);
  if (index === -1) return [...current, account];
  return current.map((item, i) => (i === index ? account : item));
}

// One id per connection attempt: minted once when the user submits, reused on retry and replay of
// that submission so the server's durable replay returns the same result, and never regenerated
// by a re-render. A random UUID: it is the Idempotency-Key of POST /api/accounts and also the
// opaque attempt id the OAuth state carries; it holds no address, secret or time.
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// crypto.randomUUID needs a secure context; plain-HTTP LAN installs only have getRandomValues, so
// the v4 UUID is built from it (the server wants the UUID shape for the Idempotency-Key).
export function newAttemptId() {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isAttemptId(value) {
  return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value);
}

// Sends one submission with its attempt id. A transport failure (no HTTP status: the answer may
// have been lost on the way) is replayed with the SAME id, so the server's durable replay returns
// the result of the first try instead of connecting twice; an answer from the server, a refusal
// or a cancel is final. A new user-initiated submit gets a new id from the caller.
export async function submitWithReplay(send, attemptId, { signal = null, replays = 1 } = {}) {
  for (let tries = 0; ; tries += 1) {
    try {
      return await send(attemptId);
    } catch (err) {
      const transport = !err?.status && err?.name !== 'AbortError' && !err?.code;
      if (!transport || signal?.aborted || tries >= replays) throw err;
    }
  }
}
