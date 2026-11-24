import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  notifyMailboxOAuthConnected, oauthMailboxConnection, resolveMailboxOAuthTarget, saveMailboxOAuthAccount,
} from '../services/accounts/mailboxOAuthAccount.js';
import { probeConnection } from '../services/accounts/connectionProbe.js';
import { getMailboxOAuthConfig } from '../services/integrations/mailboxOAuth.js';
import { acquireOAuthLease, releaseOAuthLease } from '../services/oauth/oauthLease.js';
import {
  buildYandexAuthorizationUrl, exchangeYandexCode, exchangeYandexDeviceCode, fetchYandexIdentity, requestYandexDeviceCode,
} from '../services/oauth/yandexOAuth.js';
import { consume } from '../services/rateLimiter.js';
import { redisClient } from '../services/redis.js';
import { isUuid } from '../utils/uuid.js';
import { createMailboxOAuthRedirectRoutes } from './mailboxOAuthRedirect.js';

const router = Router();
const PROVIDER = 'yandex';
const RESULT_TTL = 120;
const errors = {
  email_invalid: 400,
  invalid_state: 404,
  already_connected: 409,
  not_configured: 409,
  account_mismatch: 409,
  rate_limited: 429,
  imap_auth_failed: 422,
  smtp_auth_failed: 422,
  scope_missing: 422,
  missing_refresh_token: 422,
  authentication_failed: 502,
};
const errorResult = (code) => ({ http: errors[code], body: { error: code, code } });
const replyError = (res, code) => res.status(errors[code]).json({ error: code, code });

async function proveIdentity(tokens, config, email) {
  const identity = await fetchYandexIdentity(tokens.accessToken, { clientId: config.clientId });
  // This OAuth app may have no login:email permission. Prove the intended mailbox by signing
  // in over both protocols before saving the grant. This SMTP probe does not send a message.
  await probeConnection(oauthMailboxConnection(PROVIDER, email), { oauthAccessToken: tokens.accessToken });
  return identity;
}

const { apiRoutes, callbackRoutes: yandexCallbackRoutes } = createMailboxOAuthRedirectRoutes({
  provider: PROVIDER,
  buildAuthorizationUrl: buildYandexAuthorizationUrl,
  exchangeCode: exchangeYandexCode,
  proveIdentity,
  providerErrors: new Set(['imap_auth_failed', 'smtp_auth_failed', 'scope_missing', 'missing_refresh_token']),
});
export { yandexCallbackRoutes };

router.use(apiRoutes);
router.use(requireAuth, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function flowKey(req, flowId) {
  if (!req.sessionID || !isUuid(flowId)) return null;
  const binding = createHash('sha256')
    .update(JSON.stringify([req.sessionID, req.session.userId, flowId]))
    .digest('hex');
  return `yandex:device:${binding}`;
}

router.post('/device', async (req, res) => {
  if (!req.sessionID) return replyError(res, 'invalid_state');
  const target = await resolveMailboxOAuthTarget(PROVIDER, req.body);
  if (target.error) return replyError(res, target.error);
  const config = await getMailboxOAuthConfig(PROVIDER);
  if (!config) return replyError(res, 'not_configured');
  if ((await consume(`yandex-device:${req.session.userId}`, 5, 60000)).limited) return replyError(res, 'rate_limited');
  try {
    const { deviceCode, userCode, verificationUri, expiresIn, interval } = await requestYandexDeviceCode({ clientId: config.clientId });
    const flowId = randomUUID();
    const now = Date.now();
    await redisClient.set(flowKey(req, flowId), JSON.stringify({
      ...target, userId: req.session.userId, clientId: config.clientId, deviceCode, interval,
      expiresAt: now + expiresIn * 1000, nextPollAt: now,
    }), { EX: expiresIn + RESULT_TTL });
    return res.json({ flowId, userCode, verificationUri, expiresIn, interval });
  } catch (err) {
    return replyError(res, err?.code === 'app_unavailable' ? 'not_configured' : 'authentication_failed');
  }
});

async function finishDeviceFlow(req, key, flow, config) {
  const tokens = await exchangeYandexDeviceCode({ ...config, deviceCode: flow.deviceCode });
  const identity = await proveIdentity(tokens, config, flow.email);
  const saved = await saveMailboxOAuthAccount({
    provider: PROVIDER, pending: flow, identity, tokens, config,
    // Check again after waiting for the mailbox address lock, just before persistence.
    isPending: () => redisClient.get(key),
  });
  if (saved.error) return errorResult(saved.error);
  notifyMailboxOAuthConnected(req.app.get('imapManager'), { provider: PROVIDER, saved, userId: flow.userId });
  return { http: 200, body: { status: 'success', result: saved.result } };
}

function pending(interval) {
  return { http: 200, body: { status: 'pending', interval } };
}

async function pollDeviceFlow(req, key) {
  const raw = await redisClient.get(key);
  if (!raw) return errorResult('invalid_state');
  const flow = JSON.parse(raw);
  if (flow.result) return flow.result;
  const finish = async (result) => {
    await redisClient.set(key, JSON.stringify({ result }), { XX: true, EX: RESULT_TTL });
    return result;
  };
  const now = Date.now();
  if (now >= flow.expiresAt) return finish({ http: 200, body: { status: 'expired' } });
  if (now < flow.nextPollAt) return pending(Math.ceil((flow.nextPollAt - now) / 1000));
  const config = await getMailboxOAuthConfig(PROVIDER);
  if (!config || config.clientId !== flow.clientId) return finish(errorResult('not_configured'));

  try {
    const result = await finishDeviceFlow(req, key, flow, config);
    return finish(result);
  } catch (err) {
    if (err?.code === 'authorization_pending' || err?.code === 'slow_down') {
      if (err.code === 'slow_down') flow.interval += 5;
      flow.nextPollAt = now + flow.interval * 1000;
      const ttl = Math.max(1, Math.ceil((flow.expiresAt - Date.now()) / 1000)) + RESULT_TTL;
      await redisClient.set(key, JSON.stringify(flow), { XX: true, EX: ttl });
      return pending(flow.interval);
    }
    if (err?.code === 'access_denied') return finish({ http: 200, body: { status: 'declined' } });
    if (err?.code === 'expired_token') return finish({ http: 200, body: { status: 'expired' } });
    const code = err?.code === 'app_unavailable' ? 'not_configured' : err?.code;
    return finish(errorResult(Object.hasOwn(errors, code) ? code : 'authentication_failed'));
  }
}

router.post('/device/poll', async (req, res) => {
  const key = flowKey(req, req.body?.flowId);
  if (!key || !await redisClient.get(key)) return replyError(res, 'invalid_state');
  // The token exchange consumes the device code. A duplicate poll must never try the same
  // code or hold a database connection while another request is exchanging it.
  const leaseKey = `${key}:poll`;
  // The exchange also performs two mail probes and may wait for the mailbox address lock.
  const lease = await acquireOAuthLease(leaseKey, { ttlSeconds: 120 });
  if (!lease) return res.json(pending(5).body);
  try {
    const result = await pollDeviceFlow(req, key);
    return res.status(result.http).json(result.body);
  } finally {
    await releaseOAuthLease(leaseKey, lease);
  }
});

router.post('/device/cancel', async (req, res) => {
  const key = flowKey(req, req.body?.flowId);
  if (key) await redisClient.del(key);
  return res.json({ ok: true });
});

export default router;
