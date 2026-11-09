// MAIL_DELETE_ENABLED=false: a rule may not delete letters. Creating or enabling a rule with the
// delete action is refused; turning such a rule off still works.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-2' }; next(); },
}));
vi.mock('../services/inboxRules.js', () => ({ applyInboxRules: vi.fn(), isDangerousRegex: () => false }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import express from 'express';
import rulesRoutes from './rules.js';
import { query } from '../services/db.js';

const MAILBOX = 'f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6';
const RULE_ID = '11111111-1111-4111-8111-111111111111';
const DELETE_RULE = {
  name: 'Drop newsletters',
  accountId: MAILBOX,
  conditions: [{ field: 'from', operator: 'contains', value: 'news@' }],
  actions: [{ type: 'delete', value: '' }],
};

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/rules', rulesRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  query.mockReset().mockImplementation(async (sql) => {
    if (sql === 'SELECT id FROM email_accounts WHERE id = $1') return { rows: [{ id: MAILBOX }] };
    if (sql.includes('COUNT(*) AS cnt FROM inbox_rules')) return { rows: [{ cnt: '3' }] };
    if (sql.includes('INSERT INTO inbox_rules') || sql.includes('UPDATE inbox_rules')) return { rows: [{ id: RULE_ID }] };
    if (sql.startsWith('SELECT id, account_id, name, actions FROM inbox_rules')) return { rows: [{ id: RULE_ID, account_id: MAILBOX, name: 'x', actions: [] }] };
    return { rows: [] };
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

const send = (method, path, body) => fetch(`${base}/api/rules${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

const wrote = () => query.mock.calls.some(([sql]) => /INSERT INTO inbox_rules|UPDATE inbox_rules/.test(sql));

describe('with MAIL_DELETE_ENABLED=false', () => {
  beforeEach(() => { vi.stubEnv('MAIL_DELETE_ENABLED', 'false'); });

  it('refuses to create a rule that deletes', async () => {
    expect(await send('POST', '/', DELETE_RULE)).toMatchObject({ status: 403, body: { code: 'mail_delete_disabled' } });
    expect(wrote()).toBe(false);
  });

  it('refuses to save an enabled rule that deletes', async () => {
    expect(await send('PUT', `/${RULE_ID}`, DELETE_RULE)).toMatchObject({ status: 403, body: { code: 'mail_delete_disabled' } });
    expect(wrote()).toBe(false);
  });

  it('lets a rule that deletes be turned off', async () => {
    const res = await send('PUT', `/${RULE_ID}`, { ...DELETE_RULE, enabled: false });
    expect(res.status).toBe(200);
  });
});

describe('with MAIL_DELETE_ENABLED unset', () => {
  it('creates a rule that deletes', async () => {
    expect((await send('POST', '/', DELETE_RULE)).status).toBe(201);
  });
});
