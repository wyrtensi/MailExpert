import { createHash, randomBytes } from 'crypto';
import { redisClient } from '../redis.js';
import { GOOGLE_AUTH_URL } from './googleOAuth.js';

// The Gmail form gets a one-time path instead of the Google URL, so the address in login_hint
// never appears in a MailExpert URL or in the proxy logs: the URL waits in Redis for one minute.
export const GOOGLE_LAUNCH_TTL_SECONDS = 60;
export const GOOGLE_EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

const FLOW_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const launchKey = (flow) => `oauth:google:launch:${createHash('sha256').update(flow).digest('hex')}`;

export async function createGoogleLaunch({ userId, url }) {
  const flow = randomBytes(32).toString('base64url');
  await redisClient.set(launchKey(flow), JSON.stringify({ userId, url }), { NX: true, EX: GOOGLE_LAUNCH_TTL_SECONDS });
  return flow;
}

// Burned on first use whatever the outcome.
export async function consumeGoogleLaunch({ flow, userId }) {
  if (typeof flow !== 'string' || !FLOW_PATTERN.test(flow)) return null;
  const raw = await redisClient.getDel(launchKey(flow));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || data.userId !== userId) return null;
    if (typeof data.url !== 'string' || !data.url.startsWith(`${GOOGLE_AUTH_URL}?`)) return null;
    return data.url;
  } catch {
    return null;
  }
}
