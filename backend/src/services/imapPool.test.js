// How many IMAP connections does one account open when the pool is stalled?
//
// Upstream #474 (maathimself/mailflow@c9bcd738, @33363c11): body FETCHes time out, and afterwards
// every other IMAP operation starts failing with "Command failed", on Gmail as well as Yahoo.
//
// The mechanism was in acquirePooledClient. The pool holds poolSizeFor(account) connections, and
// a caller that found them all busy used to give up waiting after 10 seconds and open a temporary
// login of its own. Nothing bounded how many callers did that at once, so two stalled body
// fetches were enough to turn every queued operation into its own login.
//
// It now queues instead. These tests pin the ceiling: no amount of queued work may add a
// connection. ImapFlow is mocked, so one constructor call is one socket.

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
  POOL_SIZE, ACQUIRE_TIMEOUT_MS, BACKGROUND_ACQUIRE_TIMEOUT_MS,
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

beforeEach(() => {
  vi.clearAllMocks();
  evictPool(ACCOUNT.id);
  vi.useFakeTimers();
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [] });
  ImapFlow.mockImplementation(function () {
    const client = new EventEmitter();
    client.connect = vi.fn(() => Promise.resolve());
    client.logout = vi.fn(() => Promise.resolve());
    client.close = vi.fn();
    return client;
  });
});

afterEach(() => {
  evictPool(ACCOUNT.id);
  vi.useRealTimers();
});

describe('pool size', () => {
  it('defaults to 4 while Gmail and Yahoo keep their profile values', () => {
    expect(POOL_SIZE).toBe(4);
    expect(poolSizeFor(ACCOUNT)).toBe(POOL_SIZE);
    // Up to 100 Gmail accounts share one server IP: each extra pooled session is another sign-in.
    expect(poolSizeFor({ imap_host: 'imap.gmail.com' })).toBe(3);
    // Yahoo drops sessions past about three per account (#433).
    expect(poolSizeFor({ imap_host: 'imap.mail.yahoo.com' })).toBe(1);
  });
});

describe('connection fan-out when the pool is stalled (#474)', () => {
  it('serves queued work from the pool instead of opening a connection each', async () => {
    // Fill the pool: slow body fetches that hold their connections.
    const stalled = [];
    for (let i = 0; i < POOL_SIZE; i++) stalled.push(await acquirePooledClient(ACCOUNT));
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    // Meanwhile the ordinary work of an open mailbox wants connections.
    const queued = Array.from({ length: 8 }, () => acquirePooledClient(ACCOUNT));
    // Settled up front: these promises reject while timers advance, and a rejection with no
    // handler attached yet is reported as unhandled by the runner.
    const settled = Promise.allSettled(queued);

    // Past the old 10s overflow, where each of these used to open its own login.
    await vi.advanceTimersByTimeAsync(15_000);
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
    const stalled = [];
    for (let i = 0; i < POOL_SIZE; i++) stalled.push(await acquirePooledClient(ACCOUNT));

    const queued = Array.from({ length: 25 }, () => acquirePooledClient(ACCOUNT));
    const settled = Promise.allSettled(queued);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    // Past the acquire timeout they fail rather than silently opening sockets.
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS);
    const results = await settled;
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(results[0].reason.poolExhausted).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    for (const c of stalled) releasePooledClient(ACCOUNT, c);
  });

  it('lets background work give up sooner, still without opening a connection', async () => {
    const stalled = [];
    for (let i = 0; i < POOL_SIZE; i++) stalled.push(await acquirePooledClient(ACCOUNT));

    const background = acquirePooledClient(ACCOUNT, { noTemp: true });
    const outcome = background.then(() => 'served', err => err);
    await vi.advanceTimersByTimeAsync(BACKGROUND_ACQUIRE_TIMEOUT_MS);
    const err = await outcome;
    expect(err.poolExhausted).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    for (const c of stalled) releasePooledClient(ACCOUNT, c);
  });

  it('never exceeds the ceiling when several callers ask at once', async () => {
    // The grow path awaits a token refresh, a host resolve and a connect before it pushes, so
    // callers arriving together would all pass a plain length check. pool.connecting reserves
    // the slot before those awaits.
    const asks = Array.from({ length: POOL_SIZE * 3 }, () => acquirePooledClient(ACCOUNT));
    const settled = Promise.allSettled(asks);
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    const results = await settled;

    expect(ImapFlow.mock.calls.length).toBeLessThanOrEqual(POOL_SIZE);
    // A real ceiling, not a stall: that many callers were served.
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
    const held = [];
    for (let i = 0; i < POOL_SIZE; i++) held.push(await acquirePooledClient(ACCOUNT));

    const queued = acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, held[0]);
    const reused = await queued;

    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    expect(reused).toBe(held[0]);

    for (let i = 1; i < held.length; i++) releasePooledClient(ACCOUNT, held[i]);
    releasePooledClient(ACCOUNT, reused);
  });

  it('closes a released client that already left the pool, instead of awaiting LOGOUT', async () => {
    const client = await acquirePooledClient(ACCOUNT);
    evictPool(ACCOUNT.id);
    expect(client.close).toHaveBeenCalled();
    releasePooledClient(ACCOUNT, client);
    expect(client.logout).not.toHaveBeenCalled();
  });
});

describe('a body fetch on a busy account', () => {
  it('fails as busy and does not fall back to a fresh login', async () => {
    const held = [];
    for (let i = 0; i < POOL_SIZE; i++) held.push(await acquirePooledClient(ACCOUNT));

    const fetch = ImapManager.prototype.fetchMessageBody.call({}, ACCOUNT, 9, 'INBOX');
    const outcome = fetch.then(() => 'served', err => err);
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    const err = await outcome;

    // The flag survives to the route, which answers 503 "account is busy".
    expect(err.poolExhausted).toBe(true);
    // The fresh-login retry is for broken connections, not for a full pool: no new socket.
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    for (const c of held) releasePooledClient(ACCOUNT, c);
  });
});
