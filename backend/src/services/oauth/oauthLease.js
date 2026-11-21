import { randomBytes } from 'node:crypto';
import { redisClient } from '../redis.js';

// Long enough for the provider's requests, mailbox probes and database writes.
const LEASE_TTL_SECONDS = 60;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export async function acquireOAuthLease(key, { lockWaitMs = 0, lockPollMs = 200, ttlSeconds = LEASE_TTL_SECONDS } = {}) {
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    const ok = await redisClient.set(key, token, { NX: true, EX: ttlSeconds });
    if (ok) return token;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, lockPollMs));
  }
}

export async function releaseOAuthLease(key, token) {
  try {
    await redisClient.eval(RELEASE, { keys: [key], arguments: [token] });
  } catch {
    console.error('OAuth lease release failed');
  }
}
