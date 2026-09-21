import { createHash } from 'crypto';
import { query, withTransaction } from '../db.js';
import { redisClient } from '../redis.js';
import { OAUTH_STATE_TTL_SECONDS } from './oauthState.js';

// Which Google OAuth app a consent flow goes through. An unverified app accepts at most
// user_limit distinct Google accounts for its whole life, so a seat is taken by every email the
// app has ever issued tokens to (google_oauth_grants) plus the flows started but not finished
// (reservations in Redis). Selection runs under one advisory lock so two backend processes
// cannot both hand out an app's last seat.

const SELECTION_LOCK = "SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-selection'))";
const APPS_WITH_SEATS = `
  SELECT a.id, a.status, a.user_limit,
         (SELECT count(*) FROM google_oauth_grants g WHERE g.app_id = a.id)::int AS grants,
         EXISTS (SELECT 1 FROM google_oauth_grants g WHERE g.app_id = a.id AND g.email = lower($1)) AS granted
  FROM google_oauth_apps a
  ORDER BY a.created_at, a.id`;

export class GoogleAppSelectionError extends Error {
  constructor(code) {
    super(`Google OAuth app selection failed: ${code}`);
    this.name = 'GoogleAppSelectionError';
    this.code = code;
  }
}

const reservationKey = (appId) => `oauth:google:reservations:${appId}`;

// Reservations name an email only by its hash, so Redis never holds the address itself.
export function googleEmailDigest(email) {
  return createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

// Live reservations of one app. Expired ones are dropped on every count.
export async function countGoogleReservations(appId, now = Date.now()) {
  const key = reservationKey(appId);
  await redisClient.zRemRangeByScore(key, '-inf', now);
  return redisClient.zCard(key);
}

async function hasLiveReservation(appId, email, now) {
  const expiresAt = await redisClient.zScore(reservationKey(appId), googleEmailDigest(email));
  return expiresAt !== null && Number(expiresAt) > now;
}

// A repeated start for the same email refreshes its one reservation instead of adding another.
async function reserveSeat(appId, email, now) {
  const key = reservationKey(appId);
  await redisClient.zAdd(key, { score: now + OAUTH_STATE_TTL_SECONDS * 1000, value: googleEmailDigest(email) });
  // The set itself never outlives its newest reservation.
  await redisClient.expire(key, OAUTH_STATE_TTL_SECONDS);
}

// Called on the callback whatever its outcome, before the grant is journaled, so one email is
// never counted both as a reservation and as a grant.
export async function releaseGoogleSeat(appId, email) {
  if (!appId || !email) return;
  try {
    await redisClient.zRem(reservationKey(appId), googleEmailDigest(email));
  } catch (err) {
    console.error(`Google OAuth reservation release failed: ${err?.name || 'Error'}`);
  }
}

async function hasFreeSeat(app, now) {
  return app.grants + await countGoogleReservations(app.id, now) < app.user_limit;
}

// `reserve: false` picks an app the same way but never touches Redis: an existing live
// reservation still wins the app (without extending its TTL), and a free seat is judged by
// grants alone. For the legacy GET add path, which a cross-site top-level link can trigger.
export async function selectGoogleApp({ email = null, account = null, reserve = true } = {}) {
  return withTransaction(async (client) => {
    await client.query(SELECTION_LOCK);
    const { rows } = await client.query(APPS_WITH_SEATS, [email]);
    const usable = rows.filter((app) => app.status !== 'disabled');
    if (!usable.length) throw new GoogleAppSelectionError('not_configured');

    // A reconnect stays where its refresh token lives.
    const own = account?.oauth_app_id ? usable.find((app) => app.id === account.oauth_app_id) : null;
    if (own) return { appId: own.id, reserved: false };

    // Google already counted this email in that app: going back there costs no seat.
    const known = email ? usable.find((app) => app.granted) : null;
    if (known) return { appId: known.id, reserved: false };

    const now = Date.now();
    const active = usable.filter((app) => app.status === 'active');
    if (email) {
      for (const app of active) {
        if (await hasLiveReservation(app.id, email, now)) {
          if (!reserve) return { appId: app.id, reserved: false };
          await reserveSeat(app.id, email, now);
          return { appId: app.id, reserved: true };
        }
      }
    }
    for (const app of active) {
      const free = reserve ? await hasFreeSeat(app, now) : app.grants < app.user_limit;
      if (free) {
        if (!email || !reserve) return { appId: app.id, reserved: false };
        await reserveSeat(app.id, email, now);
        return { appId: app.id, reserved: true };
      }
    }
    throw new GoogleAppSelectionError('no_app_capacity');
  });
}

// Whether a new Gmail address can be connected right now. A hint for the UI, not a promise:
// selection itself decides under the lock.
export async function googleHasCapacity() {
  const { rows } = await query(APPS_WITH_SEATS, [null]);
  const now = Date.now();
  for (const app of rows.filter((a) => a.status === 'active')) {
    if (await hasFreeSeat(app, now)) return true;
  }
  return false;
}
