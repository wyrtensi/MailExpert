// The node password restore's SQL against a real (in-process) Postgres engine and the real
// migrations: the pending password is stored before the node call, promoted after it, and the
// restore time it stamps is what the next attempt is limited by. The unit tests mock every query.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const dbState = { query: null };
vi.mock('../db.js', () => ({ query: (...args) => dbState.query(...args) }));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
}));
vi.mock('./mailcow.js', () => ({
  generateMailboxPassword: vi.fn(),
  getMailNodeConfig: vi.fn(),
  getMailbox: vi.fn(),
  listDomains: vi.fn(),
  setMailboxPassword: vi.fn(),
}));

const { generateMailboxPassword, getMailNodeConfig, getMailbox, listDomains, setMailboxPassword } = await import('./mailcow.js');
const { restoreNodeMailboxPassword } = await import('./passwordRestore.js');

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ID = '30000000-0000-0000-0000-000000000001';
let db;

async function runMigrationFile(filename) {
  const statements = readFileSync(join(migrationsDir, filename), 'utf8')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.query(statement);
}

const row = async () => (await db.query(
  'SELECT auth_pass, node_password_pending, node_password_restored_at FROM email_accounts WHERE id = $1', [ID],
)).rows[0];

beforeAll(async () => {
  db = await PGlite.create();
  dbState.query = (sql, params) => db.query(sql, params);
  // The columns the restore reads, as the baseline and 0067 define them.
  await db.query(`CREATE TABLE email_accounts (
    id uuid PRIMARY KEY,
    email_address text NOT NULL,
    protocol text NOT NULL DEFAULT 'imap',
    imap_host text,
    auth_pass text,
    oauth_provider text,
    enabled boolean NOT NULL DEFAULT true
  )`);
  await runMigrationFile('0067_mail_node_mailboxes.sql');
  await runMigrationFile('0073_node_password_pending.sql');
  await runMigrationFile('0074_node_password_restored_at.sql');
});
afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  await db.query('DELETE FROM email_accounts');
  await db.query(
    `INSERT INTO email_accounts (id, email_address, imap_host, auth_pass, mail_node)
     VALUES ($1, 'box@example.com', 'mail.example.com', 'enc:old', true)`,
    [ID],
  );
  getMailNodeConfig.mockResolvedValue({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120 });
  getMailbox.mockResolvedValue({
    email: 'box@example.com', active: true, state: 1, authsource: 'mailcow', imapAccess: true, forcePwUpdate: false, domain: 'example.com',
  });
  listDomains.mockResolvedValue([{ domain: 'example.com', active: true }]);
  generateMailboxPassword.mockReturnValueOnce('first').mockReturnValue('second');
  setMailboxPassword.mockImplementation(async (cfg, email, password) => password);
});

describe('restoreNodeMailboxPassword against the migrated table', () => {
  it('stores the password as pending before the node call and promotes it after', async () => {
    setMailboxPassword.mockImplementationOnce(async (cfg, email, password) => {
      expect(await row()).toMatchObject({ auth_pass: 'enc:old', node_password_pending: `enc:${password}` });
      return password;
    });
    const result = await restoreNodeMailboxPassword(ID);
    expect(result.outcome).toBe('restored');
    expect(result.account.auth_pass).toBe('enc:first');
    const after = await row();
    expect(after).toMatchObject({ auth_pass: 'enc:first', node_password_pending: null });
    expect(Date.now() - new Date(after.node_password_restored_at).getTime()).toBeLessThan(60000);

    // The stamp limits the next attempt.
    expect((await restoreNodeMailboxPassword(ID)).outcome).toBe('rate_limited');
  });

  it('keeps an unconfirmed password pending and sends the same one again', async () => {
    setMailboxPassword.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'mail_node_unreachable' }));
    expect(await restoreNodeMailboxPassword(ID)).toEqual({ outcome: 'api_failed', code: 'mail_node_unreachable', stage: 'set' });
    expect(await row()).toMatchObject({ auth_pass: 'enc:old', node_password_pending: 'enc:first', node_password_restored_at: null });

    expect((await restoreNodeMailboxPassword(ID)).outcome).toBe('restored');
    expect(setMailboxPassword.mock.calls.map((c) => c[2])).toEqual(['first', 'first']);
    expect(await row()).toMatchObject({ auth_pass: 'enc:first', node_password_pending: null });
  });

  it('allows the next restore once six hours have passed', async () => {
    await db.query("UPDATE email_accounts SET node_password_restored_at = NOW() - interval '6 hours 1 minute' WHERE id = $1", [ID]);
    expect((await restoreNodeMailboxPassword(ID)).outcome).toBe('restored');
    await db.query("UPDATE email_accounts SET node_password_restored_at = NOW() - interval '5 hours 59 minutes' WHERE id = $1", [ID]);
    expect((await restoreNodeMailboxPassword(ID)).outcome).toBe('rate_limited');
  });
});
