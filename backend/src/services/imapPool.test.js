// How many IMAP connections does one account open when the pool is stalled, and who gets a
// connection when one frees up?
//
// Upstream #474 (maathimself/mailflow@c9bcd738, @33363c11): body FETCHes time out, and afterwards
// every other IMAP operation starts failing with "Command failed", on Gmail as well as Yahoo.
//
// The mechanism was in acquirePooledClient. The pool holds poolSizeFor(account) connections, and
// a caller that found them all busy used to give up waiting after 10 seconds and open a temporary
// login of its own. Nothing bounded how many callers did that at once, so two stalled body
// fetches were enough to turn every queued operation into its own login.
//
// It now queues instead. These tests pin the ceiling (no amount of queued work may add a
// connection), the queue order (a freed slot goes to the head waiter, clicks ahead of background
// work), and the bound on a stalled pooled command. ImapFlow is mocked, so one constructor call
// is one socket.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('./oauth/tokenManager.js', async (importOriginal) => ({
  OAuthTokenError: (await importOriginal()).OAuthTokenError,
  ensureFreshOAuthAccount: vi.fn(async account => account),
}));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import {
  ImapManager, acquirePooledClient, releasePooledClient, evictPool, poolSizeFor,
  POOL_SIZE, ACQUIRE_TIMEOUT_MS, BACKGROUND_ACQUIRE_TIMEOUT_MS, POOLED_OPERATION_TIMEOUT_MS, BODY_FETCH_POOL_TIMEOUT_MS,
  LONG_POOLED_OPERATION_TIMEOUT_MS,
} from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

// A generic host, so the pool size is the default rather than a provider override.
const ACCOUNT = {
  id: 'acct-474',
  imap_host: '127.0.0.1',
  imap_port: 1143,
  imap_tls: true,
  imap_skip_tls_verify: false,
  auth_user: 'user',
  auth_pass: 'enc',
};

let sockets;
beforeEach(() => {
  vi.clearAllMocks();
  evictPool(ACCOUNT.id);
  vi.useFakeTimers();
  sockets = [];
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [] });
  ImapFlow.mockImplementation(function () {
    const client = new EventEmitter();
    client.connect = vi.fn(() => Promise.resolve());
    client.logout = vi.fn(() => Promise.resolve());
    client.close = vi.fn();
    sockets.push(client);
    return client;
  });
});

afterEach(() => {
  evictPool(ACCOUNT.id);
  vi.useRealTimers();
});

// Settle a promise into a value or its rejection, so an assertion can run while timers advance.
const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));

async function fillPool() {
  const held = [];
  for (let i = 0; i < POOL_SIZE; i++) held.push(await acquirePooledClient(ACCOUNT));
  expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
  return held;
}

// A `this` for calling fetchMessageBody off the prototype with no backoff armed.
const NO_BACKOFF = { _poolLoginOpts: () => ({ noNewLogin: false }) };

describe('pool size and waits', () => {
  it('defaults to 4 while Gmail and Yahoo keep their profile values', () => {
    expect(POOL_SIZE).toBe(4);
    expect(poolSizeFor(ACCOUNT)).toBe(POOL_SIZE);
    // Up to 100 Gmail accounts share one server IP: each extra pooled session is another sign-in.
    expect(poolSizeFor({ imap_host: 'imap.gmail.com' })).toBe(3);
    // Yahoo drops sessions past about three per account (#433).
    expect(poolSizeFor({ imap_host: 'imap.mail.yahoo.com' })).toBe(1);
  });

  it('keeps an interactive wait short and a background one shorter', () => {
    expect(ACQUIRE_TIMEOUT_MS).toBe(15000);
    expect(BACKGROUND_ACQUIRE_TIMEOUT_MS).toBeLessThan(ACQUIRE_TIMEOUT_MS);
  });
});

describe('connection fan-out when the pool is stalled (#474)', () => {
  it('serves queued work from the pool instead of opening a connection each', async () => {
    const stalled = await fillPool();
    const queued = Array.from({ length: 8 }, () => acquirePooledClient(ACCOUNT));
    // Settled up front: these promises reject while timers advance, and a rejection with no
    // handler attached yet is reported as unhandled by the runner.
    const settled = Promise.allSettled(queued);

    // Past the old 10s overflow, where each of these used to open its own login.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    // They are queued, not failed, and a released connection goes to the next one.
    releasePooledClient(ACCOUNT, stalled[0]);
    const served = await queued[0];
    expect(served).toBe(stalled[0]);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    releasePooledClient(ACCOUNT, served);
    for (let i = 1; i < stalled.length; i++) releasePooledClient(ACCOUNT, stalled[i]);
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    await settled;
  });

  it('holds the ceiling no matter how much work piles up, then fails as busy', async () => {
    const stalled = await fillPool();
    const queued = Array.from({ length: 25 }, () => acquirePooledClient(ACCOUNT));
    const settled = Promise.allSettled(queued);
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    const results = await settled;
    // Past the acquire timeout they fail rather than silently opening sockets.
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(results[0].reason.poolExhausted).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    for (const c of stalled) releasePooledClient(ACCOUNT, c);
  });

  it('lets background work give up sooner, still without opening a connection', async () => {
    const stalled = await fillPool();
    const outcome = settle(acquirePooledClient(ACCOUNT, { background: true }));
    await vi.advanceTimersByTimeAsync(BACKGROUND_ACQUIRE_TIMEOUT_MS);
    const { ok, e } = await outcome;
    expect(ok).toBe(false);
    expect(e.poolExhausted).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    for (const c of stalled) releasePooledClient(ACCOUNT, c);
  });

  it('keeps the ceiling under a concurrent burst', async () => {
    // A regression guard, not a test of this branch: pool.connecting (the reservation upstream
    // added as its pending counter) predates the port, so this also passes on main. Checked
    // before any acquire timeout, so it measures the grow path and nothing else.
    const asks = Array.from({ length: POOL_SIZE * 3 }, () => acquirePooledClient(ACCOUNT));
    const settled = Promise.allSettled(asks);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    const results = await settled;
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(POOL_SIZE);
    for (const r of results) if (r.status === 'fulfilled') releasePooledClient(ACCOUNT, r.value);
  });

  it('a failed connect does not leave a reservation that shrinks the pool forever', async () => {
    ImapFlow.mockImplementationOnce(function () {
      const c = new EventEmitter();
      c.connect = vi.fn(() => Promise.reject(new Error('refused')));
      c.logout = vi.fn(() => Promise.resolve());
      c.close = vi.fn();
      return c;
    });
    await expect(acquirePooledClient(ACCOUNT)).rejects.toThrow();
    const got = [];
    for (let i = 0; i < POOL_SIZE; i++) got.push(await acquirePooledClient(ACCOUNT));
    expect(got).toHaveLength(POOL_SIZE);
    for (const c of got) releasePooledClient(ACCOUNT, c);
  });

  it('releasing a stalled connection lets a waiter reuse it rather than open one', async () => {
    const held = await fillPool();
    const queued = acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, held[0]);
    const reused = await queued;
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    expect(reused).toBe(held[0]);
    for (let i = 1; i < held.length; i++) releasePooledClient(ACCOUNT, held[i]);
    releasePooledClient(ACCOUNT, reused);
  });
});

describe('who gets a freed slot', () => {
  it('a slot freed by a closed session goes to the head waiter, which opens a connection', async () => {
    // Before: drainWaiters only handed out idle clients, so after a session was evicted or
    // closed by the server the queued waiters sat out their full timeout with room in the pool.
    const held = await fillPool();
    const waiter = settle(acquirePooledClient(ACCOUNT));
    held[0].emit('close');                         // the server dropped one session
    await vi.advanceTimersByTimeAsync(100);
    const { ok, v } = await waiter;
    expect(ok).toBe(true);
    expect(v).not.toBe(held[0]);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE + 1); // one replacement, never more
    releasePooledClient(ACCOUNT, v);
    for (let i = 1; i < held.length; i++) releasePooledClient(ACCOUNT, held[i]);
  });

  it('a new caller does not jump the queue when a slot frees', async () => {
    const held = await fillPool();
    const first = settle(acquirePooledClient(ACCOUNT));
    held[0].emit('close');
    // Arrives right after the slot freed: the queued waiter already owns it.
    let lateServed = false;
    const late = acquirePooledClient(ACCOUNT).then(c => { lateServed = true; return c; });
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).ok).toBe(true);
    expect(lateServed).toBe(false);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE + 1);
    // It is served by the next release instead.
    releasePooledClient(ACCOUNT, held[1]);
    expect(await late).toBe(held[1]);
    releasePooledClient(ACCOUNT, (await first).v);
    releasePooledClient(ACCOUNT, held[1]);
    for (let i = 2; i < held.length; i++) releasePooledClient(ACCOUNT, held[i]);
  });

  it('serves a click before background work that queued earlier', async () => {
    const held = await fillPool();
    const background = settle(acquirePooledClient(ACCOUNT, { background: true }));
    const click = acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, held[0]);
    expect(await click).toBe(held[0]);
    releasePooledClient(ACCOUNT, held[0]);
    expect((await background).v).toBe(held[0]);
    releasePooledClient(ACCOUNT, held[0]);
    for (let i = 1; i < held.length; i++) releasePooledClient(ACCOUNT, held[i]);
  });
});

describe('evicting a pool', () => {
  it('leaves a session in use running and closes it when it is released', async () => {
    const busy = await acquirePooledClient(ACCOUNT);
    const idle = await acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, idle);
    evictPool(ACCOUNT.id);
    expect(idle.close).toHaveBeenCalled();
    // Closing it now would abort another operation mid-command (a MOVE the server may apply).
    expect(busy.close).not.toHaveBeenCalled();
    releasePooledClient(ACCOUNT, busy);
    expect(busy.close).toHaveBeenCalled();
    expect(busy.logout).not.toHaveBeenCalled();
  });
});

describe('a stalled pooled command', () => {
  // imapflow 2.0.x has no command timeout, so a command that never answers kept its pool slot
  // until the 5-minute socket timeout, or forever if data trickled in.
  const hangOnLock = () => {
    ImapFlow.mockImplementation(function () {
      const client = new EventEmitter();
      client.connect = vi.fn(() => Promise.resolve());
      client.logout = vi.fn(() => Promise.resolve());
      client.close = vi.fn();
      client.getMailboxLock = vi.fn(() => new Promise(() => {}));
      sockets.push(client);
      return client;
    });
  };

  it('times out, closes the session and frees the slot', async () => {
    hangOnLock();
    const move = settle(ImapManager.prototype.moveMessage.call({}, ACCOUNT, 7, 'INBOX', 'Trash'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(POOLED_OPERATION_TIMEOUT_MS + 100);
    const { ok, e } = await move;
    expect(ok).toBe(false);
    expect(e.message).toMatch(/Pooled IMAP operation timeout/);
    expect(sockets[0].close).toHaveBeenCalled();
    // The next operation gets a fresh session instead of queueing behind the stalled one.
    const next = await acquirePooledClient(ACCOUNT);
    expect(next).not.toBe(sockets[0]);
    releasePooledClient(ACCOUNT, next);
  });

  it.each([
    ['emptyFolder', mgr => mgr.emptyFolder(ACCOUNT, 'Trash')],
    ['markAllReadImap', mgr => mgr.markAllReadImap(ACCOUNT, 'INBOX')],
    ['appendToFolder', mgr => mgr.appendToFolder(ACCOUNT, 'Sent', Buffer.from('x'))],
  ])('gives %s the long bound, not the default one', async (_name, run) => {
    // Whole-folder writes and a large Sent upload legitimately take longer than the default;
    // cutting them off at 120 s would leave a folder half emptied or lose the Sent copy.
    hangOnLock();
    ImapFlow.mockImplementation(function () {
      const client = new EventEmitter();
      client.connect = vi.fn(() => Promise.resolve());
      client.close = vi.fn();
      client.getMailboxLock = vi.fn(() => new Promise(() => {}));
      client.append = vi.fn(() => new Promise(() => {}));
      sockets.push(client);
      return client;
    });
    const mgr = Object.create(ImapManager.prototype);
    const outcome = settle(run(mgr));
    await vi.advanceTimersByTimeAsync(POOLED_OPERATION_TIMEOUT_MS + 1000);
    expect(sockets[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LONG_POOLED_OPERATION_TIMEOUT_MS - POOLED_OPERATION_TIMEOUT_MS);
    const { ok } = await outcome;
    expect(ok).toBe(false);
    expect(sockets[0].close).toHaveBeenCalled();
  });

  it('bounds a body fetch inside the route budget', async () => {
    hangOnLock();
    const fetch = settle(ImapManager.prototype.fetchMessageBody.call(NO_BACKOFF, ACCOUNT, 9, 'INBOX'));
    await vi.advanceTimersByTimeAsync(BODY_FETCH_POOL_TIMEOUT_MS + 100);
    const { ok } = await fetch;
    expect(ok).toBe(false);
    expect(BODY_FETCH_POOL_TIMEOUT_MS).toBeLessThan(40000);
    expect(sockets[0].close).toHaveBeenCalled();
  });
});

describe('a body fetch on a busy account', () => {
  it('fails as busy and does not fall back to a fresh login', async () => {
    const held = await fillPool();
    const outcome = settle(ImapManager.prototype.fetchMessageBody.call(NO_BACKOFF, ACCOUNT, 9, 'INBOX'));
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    const { ok, e } = await outcome;
    expect(ok).toBe(false);
    // The flag survives to the route, which answers 503 mailbox_busy.
    expect(e.poolExhausted).toBe(true);
    // The fresh-login retry is for broken connections, not for a full pool: no new socket.
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    for (const c of held) releasePooledClient(ACCOUNT, c);
  });
});

describe('bulk operations on a busy account', () => {
  it('fail as busy at once, without a reconcile that would wait out the pool again', async () => {
    const held = await fillPool();
    const outcome = settle(ImapManager.prototype.bulkMoveMessages.call({}, ACCOUNT, [1, 2], 'INBOX', 'Archive'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // One acquire wait (the STATUS), not three.
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 100);
    const { ok, e } = await outcome;
    expect(ok).toBe(false);
    expect(e.poolExhausted).toBe(true);
    for (const c of held) releasePooledClient(ACCOUNT, c);
  });
});
