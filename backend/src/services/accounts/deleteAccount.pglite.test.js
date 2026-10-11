import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const state = vi.hoisted(() => ({ db: null, order: [] }));
vi.mock('../db.js', () => ({ query: (sql, p) => state.db.query(sql, p) }));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn(() => { state.order.push('audit'); }) }));
vi.mock('../oauth/googleOAuth.js', () => ({ revokeGoogleToken: vi.fn(async () => { state.order.push('revoke'); return true; }) }));

const { deleteAccount } = await import('./deleteAccount.js');
const { recordAudit } = await import('../auditLog.js');
const { revokeGoogleToken } = await import('../oauth/googleOAuth.js');

const ACTOR = '72000000-0000-4000-8000-000000000001';
const columns = 'id, email_address, oauth_provider, oauth_refresh_token, oauth_access_token';
let account;
const engine = { disconnectAccount: vi.fn(async () => { state.order.push('disconnect'); }) };

beforeAll(async () => {
  state.db = await createRealSchemaDb();
  await state.db.query(`INSERT INTO users (id, username) VALUES ($1, 'actor')`, [ACTOR]);
});
afterAll(async () => { await state.db.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  state.order = [];
  await state.db.exec('DELETE FROM jobs; DELETE FROM email_accounts;');
  ({ rows: [account] } = await state.db.query(`INSERT INTO email_accounts (name, email_address, imap_host, smtp_host, oauth_provider, oauth_refresh_token)
    VALUES ('Team', 'team@example.com', 'imap.example.com', 'smtp.example.com', 'google', 'enc:refresh') RETURNING ${columns}`));
  await state.db.query(`INSERT INTO jobs (kind, account_id, status) VALUES ('send_message', $1, 'queued'), ('send_message', $1, 'done')`, [account.id]);
});

it('fails waiting jobs, revokes Google, deletes the row, journals it, then lets the engine go', async () => {
  const { disconnected } = await deleteAccount(account, { actor: { userId: ACTOR }, googleRevokeToken: 'refresh', engine });
  await disconnected;
  expect((await state.db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(0);
  expect((await state.db.query('SELECT status, error_code, account_id FROM jobs ORDER BY id')).rows).toEqual([
    { status: 'failed', error_code: 'account_missing', account_id: null }, { status: 'done', error_code: null, account_id: null },
  ]);
  expect(revokeGoogleToken).toHaveBeenCalledWith('refresh');
  expect(recordAudit).toHaveBeenCalledWith({ actorUserId: ACTOR, accountEmail: 'team@example.com', action: 'mailbox.deleted', details: { mailNode: false } });
  expect(engine.disconnectAccount).toHaveBeenCalledWith(account.id);
  expect(state.order).toEqual(['revoke', 'audit', 'disconnect']);
});

it('records a reason, uses the caller\'s client and survives a failed disconnect', async () => {
  const client = { query: vi.fn((sql, p) => state.db.query(sql, p)) };
  const failing = { disconnectAccount: vi.fn(async () => { throw new Error('logout failed'); }) };
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { disconnected } = await deleteAccount(account, { actor: null, reason: 'proton_commit_abandoned', client, engine: failing });
  await disconnected;
  error.mockRestore();
  expect(client.query).toHaveBeenCalledWith('DELETE FROM email_accounts WHERE id = $1', [account.id]);
  expect(revokeGoogleToken).not.toHaveBeenCalled();
  expect(recordAudit).toHaveBeenCalledWith({ actorUserId: null, accountEmail: 'team@example.com', action: 'mailbox.deleted', details: { mailNode: false, reason: 'proton_commit_abandoned' } });
  expect((await state.db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(0);
});
