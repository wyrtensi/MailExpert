import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({
  invalidateSocialDomainCache: vi.fn(), backfillCategories: vi.fn(async () => 0), aiClassifyMessage: vi.fn(),
  BUILTIN_SETS: {}, getGlobalCategorizationEnabled: vi.fn(async () => true),
}));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn() }));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));

import express from 'express';
import session from 'express-session';
import categoriesRoutes from './categories.js';
import { query } from '../services/db.js';

let server;
let base;
let isAdmin = false;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => { req.session.userId = '00000000-0000-0000-0000-00000000000b'; next(); });
  app.use('/api', categoriesRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (sql) => {
    if (/SELECT is_admin, disabled_at FROM users/.test(sql)) return { rows: [{ is_admin: isAdmin, disabled_at: null }] };
    if (/SELECT id, disabled_at FROM users/.test(sql)) return { rows: [{ id: 'u', disabled_at: null }] };
    return { rows: [] };
  });
});

const call = (method, path, body) => fetch(`${base}/api${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

const ADMIN_ONLY = [
  ['POST', '/categories/sources', { sourceType: 'manual', value: 'example.com' }],
  ['PATCH', '/categories/sources/00000000-0000-0000-0000-000000000001', { enabled: false }],
  ['DELETE', '/categories/sources/00000000-0000-0000-0000-000000000001'],
  ['POST', '/categories/sources/00000000-0000-0000-0000-000000000001/refresh'],
  ['POST', '/categories/recategorize/00000000-0000-0000-0000-000000000002'],
];

describe('category settings are for administrators', () => {
  it.each(ADMIN_ONLY)('%s %s answers 403 to a user who is not an administrator', async (method, path, body) => {
    isAdmin = false;
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
  });

  it.each(ADMIN_ONLY)('%s %s gets past the check for an administrator', async (method, path, body) => {
    isAdmin = true;
    const res = await call(method, path, body);
    expect(res.status).not.toBe(403);
  });

  it('still lets any signed-in user read the sources', async () => {
    isAdmin = false;
    const res = await call('GET', '/categories/sources');
    expect(res.status).not.toBe(403);
  });
});
