import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// db and redis are stubbed: the readiness probe is exercised without real services.
const db = vi.hoisted(() => ({ fail: null }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async () => {
    if (db.fail) throw db.fail;
    return { rows: [{ ok: 1 }] };
  }),
}));
const redis = vi.hoisted(() => ({ ready: true, ping: null }));
vi.mock('../services/redis.js', () => ({
  redisClient: {
    get isReady() { return redis.ready; },
    ping: (...args) => redis.ping(...args),
  },
}));

import express from 'express';
import healthRoutes, { createReadyHandler, pingRedis } from './health.js';
import { query } from '../services/db.js';

async function serve(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function healthApp() {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
}

beforeEach(() => {
  db.fail = null;
  redis.ready = true;
  redis.ping = vi.fn(async () => 'PONG');
});

afterEach(() => {
  query.mockClear();
});

describe('GET /api/health', () => {
  it('keeps answering {status: ok} without touching PostgreSQL or Redis', async () => {
    await serve(healthApp(), async (base) => {
      const res = await fetch(`${base}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });
    expect(query).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });
});

describe('GET /api/health/ready', () => {
  it('is 200 when PostgreSQL and Redis answer', async () => {
    await serve(healthApp(), async (base) => {
      const res = await fetch(`${base}/api/health/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ready', postgres: 'ok', redis: 'ok' });
    });
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('is 503 when PostgreSQL fails, without the error text', async () => {
    db.fail = new Error('password authentication failed for user "mailexpert"');
    await serve(healthApp(), async (base) => {
      const res = await fetch(`${base}/api/health/ready`);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ status: 'not_ready', postgres: 'error', redis: 'ok' });
      expect(text).not.toMatch(/password|mailexpert/);
    });
  });

  it('is 503 when Redis is not connected, without queueing a PING', async () => {
    redis.ready = false;
    await serve(healthApp(), async (base) => {
      const res = await fetch(`${base}/api/health/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready', postgres: 'ok', redis: 'error' });
    });
    expect(redis.ping).not.toHaveBeenCalled();
  });

  it('is 503 when PING rejects', async () => {
    redis.ping = vi.fn(async () => { throw new Error('READONLY'); });
    await serve(healthApp(), async (base) => {
      const res = await fetch(`${base}/api/health/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready', postgres: 'ok', redis: 'error' });
    });
  });
});

describe('createReadyHandler', () => {
  it('reports a check that never settles as an error after the timeout', async () => {
    const app = express();
    app.get('/ready', createReadyHandler({
      checkPostgres: () => new Promise(() => {}),
      checkRedis: async () => {},
      timeoutMs: 20,
    }));
    await serve(app, async (base) => {
      const started = Date.now();
      const res = await fetch(`${base}/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready', postgres: 'error', redis: 'ok' });
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  it('reports a check that throws synchronously as an error', async () => {
    const app = express();
    app.get('/ready', createReadyHandler({
      checkPostgres: async () => {},
      checkRedis: () => { throw new Error('boom'); },
    }));
    await serve(app, async (base) => {
      const res = await fetch(`${base}/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready', postgres: 'ok', redis: 'error' });
    });
  });
});

describe('pingRedis', () => {
  it('rejects without sending PING while the client is not ready', async () => {
    redis.ready = false;
    await expect(pingRedis()).rejects.toThrow();
    expect(redis.ping).not.toHaveBeenCalled();
  });
});
