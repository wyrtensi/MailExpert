import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(), pool: {} }));

const { armPoolIdleClose, disarmPoolIdleClose, parsePoolIdleMs, DEFAULT_POOL_IDLE_SECONDS } = await import('./imapManager.js');

const makePool = () => ({ clients: [], inUse: new Set(), waiters: [], connecting: 0, idleTimers: new Map() });
const makeClient = () => ({ logout: vi.fn(() => Promise.resolve()) });

describe('parsePoolIdleMs', () => {
  it('defaults to 300 seconds when unset, empty or invalid', () => {
    for (const raw of [undefined, null, '', '  ', 'abc', '-5', '1.5']) {
      expect(parsePoolIdleMs(raw)).toBe(DEFAULT_POOL_IDLE_SECONDS * 1000);
    }
  });

  it('takes whole seconds, and 0 keeps pooled logins open', () => {
    expect(parsePoolIdleMs('60')).toBe(60000);
    expect(parsePoolIdleMs('0')).toBe(0);
  });
});

describe('pooled login idle close', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('closes a client left idle in its pool for the idle time', () => {
    const pool = makePool();
    const client = makeClient();
    pool.clients.push(client);
    armPoolIdleClose(pool, client, 1000);
    vi.advanceTimersByTime(999);
    expect(client.logout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(client.logout).toHaveBeenCalledTimes(1);
    expect(pool.clients).toEqual([]);
    expect(pool.idleTimers.size).toBe(0);
  });

  it('keeps a client taken again before the time is up', () => {
    const pool = makePool();
    const client = makeClient();
    pool.clients.push(client);
    armPoolIdleClose(pool, client, 1000);
    vi.advanceTimersByTime(500);
    disarmPoolIdleClose(pool, client);
    pool.inUse.add(client);
    vi.advanceTimersByTime(5000);
    expect(client.logout).not.toHaveBeenCalled();
    expect(pool.clients).toEqual([client]);
  });

  it('never closes a client that is in use or already left the pool', () => {
    const pool = makePool();
    const busy = makeClient();
    const gone = makeClient();
    pool.clients.push(busy);
    armPoolIdleClose(pool, busy, 1000);
    pool.inUse.add(busy);
    armPoolIdleClose(pool, gone, 1000);
    vi.advanceTimersByTime(1000);
    expect(busy.logout).not.toHaveBeenCalled();
    expect(gone.logout).not.toHaveBeenCalled();
    expect(pool.clients).toEqual([busy]);
  });

  it('restarts the clock on each return and does nothing when disabled', () => {
    const pool = makePool();
    const client = makeClient();
    pool.clients.push(client);
    armPoolIdleClose(pool, client, 1000);
    vi.advanceTimersByTime(800);
    armPoolIdleClose(pool, client, 1000);
    vi.advanceTimersByTime(800);
    expect(client.logout).not.toHaveBeenCalled();
    expect(pool.idleTimers.size).toBe(1);
    armPoolIdleClose(pool, client, 0);
    vi.advanceTimersByTime(10000);
    expect(client.logout).not.toHaveBeenCalled();
    expect(pool.idleTimers.size).toBe(0);
  });
});
