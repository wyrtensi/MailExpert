import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => new Map());
vi.mock('../redis.js', () => ({
  redisClient: {
    set: vi.fn(async (key, value, opts) => { store.set(key, { value, opts }); return 'OK'; }),
    getDel: vi.fn(async (key) => { const v = store.get(key)?.value ?? null; store.delete(key); return v; }),
  },
}));

const { createGoogleLaunch, consumeGoogleLaunch, GOOGLE_LAUNCH_TTL_SECONDS } = await import('./googleLaunch.js');
const URL_ = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&login_hint=a%40gmail.com';

beforeEach(() => store.clear());

describe('google launch key', () => {
  it('is single use, lives 60 seconds and keys Redis by a hash of the flow', async () => {
    const flow = await createGoogleLaunch({ userId: 'u1', url: URL_ });
    expect(flow).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [[key, { opts }]] = [...store.entries()];
    expect(key).toMatch(/^oauth:google:launch:[0-9a-f]{64}$/);
    expect(key).not.toContain(flow);
    expect(opts).toEqual({ NX: true, EX: GOOGLE_LAUNCH_TTL_SECONDS });
    expect(GOOGLE_LAUNCH_TTL_SECONDS).toBe(60);
    await expect(consumeGoogleLaunch({ flow, userId: 'u1' })).resolves.toBe(URL_);
    await expect(consumeGoogleLaunch({ flow, userId: 'u1' })).resolves.toBeNull();
  });

  it('belongs to the user who started it', async () => {
    const flow = await createGoogleLaunch({ userId: 'u1', url: URL_ });
    await expect(consumeGoogleLaunch({ flow, userId: 'u2' })).resolves.toBeNull();
  });

  it('rejects a malformed flow without reaching Redis', async () => {
    await expect(consumeGoogleLaunch({ flow: 'short', userId: 'u1' })).resolves.toBeNull();
    await expect(consumeGoogleLaunch({ flow: undefined, userId: 'u1' })).resolves.toBeNull();
  });

  it('only ever hands out a Google authorization URL', async () => {
    const flow = await createGoogleLaunch({ userId: 'u1', url: 'https://evil.example/' });
    await expect(consumeGoogleLaunch({ flow, userId: 'u1' })).resolves.toBeNull();
  });
});
