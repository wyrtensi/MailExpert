import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRealSchemaDb } from '../testing/realSchema.js';
const state = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({
  query: (sql, p) => state.db.query(sql, p),
  pool: { connect: async () => ({ query: (sql, p) => state.db.query(sql, p), release() {} }) },
}));
vi.mock('./connectionProbe.js', () => ({ probeConnection: vi.fn(async c => ({ imapLogin: c.auth_user, smtpLogin: c.smtp_auth_user })) }));
vi.mock('../encryption.js', () => ({ encrypt: v => v ? 'enc:' + v : null }));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../redis.js', () => ({redisClient:{incr:async()=>{throw new Error('offline');},del:async()=>{}}}));
import { reset } from '../rateLimiter.js';
import { createVerifiedAccount } from './accountCreation.js';
import { parseManualCreate } from './createRequest.js';
import { probeConnection } from './connectionProbe.js';
const USER = '70000000-0000-4000-8000-000000000001';
const actor = { userId: USER };
const parsed = () => parseManualCreate({ provider: 'yahoo', email_address: 'team@example.com', imap_host: 'imap.example.com', smtp_host: 'smtp.example.com', auth_pass: 'secret', signature: '<script>alert(1)</script><b>Team</b>' });
const create = (requestId = randomUUID(), patch = {}) => { const p = parsed(); return createVerifiedAccount({ ...p.candidate, ...patch }, actor, { provider: p.provider, mode: p.mode, requestId }); };
beforeAll(async () => { state.db = await createRealSchemaDb(); await state.db.query("INSERT INTO users (id, username) VALUES ($1, 'employee')", [USER]); });
afterAll(async () => state.db.close());
beforeEach(async () => {
  vi.clearAllMocks();
  await reset(`account-create:${USER}`);
  await state.db.exec('DELETE FROM account_creation_requests; DELETE FROM email_accounts;');
  probeConnection.mockImplementation(async c => ({ imapLogin: c.auth_user, smtpLogin: c.smtp_auth_user }));
});
it('persists only after both protocols and saves independent successful logins', async () => {
  probeConnection.mockImplementationOnce(async () => {
    expect((await state.db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(0);
    return { imapLogin: 'team', smtpLogin: 'team@example.com' };
  });
  const { account } = await create();
  expect(account).toMatchObject({ mail_provider: 'yahoo', connection_mode: 'manual', imap_tls_mode: 'implicit', auth_user: 'team', smtp_auth_user: 'team@example.com', auth_pass: 'enc:secret' });
  expect(account.signature).not.toContain('<script');
});
it('smtp_failure_has_no_insert and durable safe result', async () => {
  const key = randomUUID();
  probeConnection.mockRejectedValueOnce(Object.assign(new Error('secret raw response'), { code: 'smtp_auth_failed' }));
  expect(await create(key)).toMatchObject({ error: 'smtp_auth_failed' });
  expect((await state.db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(0);
  expect(await create(key)).toMatchObject({ error: 'smtp_auth_failed' });
  expect(probeConnection).toHaveBeenCalledOnce();
});
it('same actor/key returns earlier account without probing again', async () => {
  const key = randomUUID(), first = await create(key), second = await create(key);
  expect(second.account.id).toBe(first.account.id);
  expect(probeConnection).toHaveBeenCalledOnce();
});
it('legacy_duplicate_rows_remain and trimmed address is refused', async () => {
  await state.db.query("INSERT INTO email_accounts (name, email_address) VALUES ('old', ' TEAM@EXAMPLE.COM '), ('old2', 'team@example.com')");
  expect(await create()).toMatchObject({ error: 'already_connected' });
  expect((await state.db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(2);
  expect(probeConnection).not.toHaveBeenCalled();
});
it('a request key cannot be reused for another address or route', async () => {
  const key = randomUUID(); await create(key);
  expect(await create(key, { email_address: 'other@example.com' })).toMatchObject({ error: 'idempotency_conflict' });
});


it('deleted successful result cannot recreate a mailbox with the old key', async () => {
  const key = randomUUID(), first = await create(key);
  await state.db.query('DELETE FROM email_accounts WHERE id = $1', [first.account.id]);
  expect(await create(key)).toMatchObject({error: 'already_connected', code:'already_connected'});
  expect(probeConnection).toHaveBeenCalledOnce();
  expect((await state.db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(0);
});
it('a client disconnect is not stored as the outcome: a retry with the same key probes again', async () => {
  const key = randomUUID(), p = parsed(), controller = new AbortController();
  probeConnection.mockImplementationOnce(async () => {
    controller.abort();
    throw Object.assign(new Error('aborted'), { code: 'connection_cancelled' });
  });
  const first = await createVerifiedAccount(p.candidate, actor, { provider: p.provider, mode: p.mode, requestId: key, signal: controller.signal });
  expect(first).toMatchObject({ error: 'connection_cancelled' });
  const { rows: [request] } = await state.db.query('SELECT result_code, account_id FROM account_creation_requests WHERE request_id = $1', [key]);
  expect(request).toMatchObject({ result_code: null, account_id: null });
  const second = await create(key);
  expect(second.account).toMatchObject({ email_address: 'team@example.com' });
  expect(probeConnection).toHaveBeenCalledTimes(2);
});
it('a disconnect after a successful probe is not stored either', async () => {
  const key = randomUUID(), p = parsed(), controller = new AbortController();
  probeConnection.mockImplementationOnce(async c => { controller.abort(); return { imapLogin: c.auth_user, smtpLogin: c.smtp_auth_user }; });
  expect(await createVerifiedAccount(p.candidate, actor, { provider: p.provider, mode: p.mode, requestId: key, signal: controller.signal })).toMatchObject({ error: 'connection_cancelled' });
  expect((await create(key)).account).toBeTruthy();
});
