import { Router } from 'express';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';

// Each dependency check gets this long before it counts as failed.
const CHECK_TIMEOUT_MS = 2000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 'ok' or 'error' only: error texts can carry connection details and never reach the response.
async function probe(check, timeoutMs) {
  try {
    await withTimeout(Promise.resolve().then(check), timeoutMs);
    return 'ok';
  } catch {
    return 'error';
  }
}

// Readiness for deploy scripts: PostgreSQL and Redis answer. The server listens only after
// migrations ran, so a 200 also means the schema is current.
export function createReadyHandler({ checkPostgres, checkRedis, timeoutMs = CHECK_TIMEOUT_MS }) {
  return async (_req, res) => {
    const [postgres, redis] = await Promise.all([
      probe(checkPostgres, timeoutMs),
      probe(checkRedis, timeoutMs),
    ]);
    const ready = postgres === 'ok' && redis === 'ok';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', postgres, redis });
  };
}

// node-redis queues commands while disconnected, so a bare PING would wait instead of failing.
export async function pingRedis() {
  if (!redisClient.isReady) throw new Error('Redis is not connected');
  await redisClient.ping();
}

const router = Router();

// Liveness for the container healthcheck: answers as long as the process serves HTTP.
router.get('/', (_req, res) => res.json({ status: 'ok' }));
router.get('/ready', createReadyHandler({
  checkPostgres: () => query('SELECT 1'),
  checkRedis: pingRedis,
}));

export default router;
