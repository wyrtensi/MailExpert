// A one-client pool makes nested reservations fail deterministically. PGlite supplies the real
// schema; this tests resource ownership, not cross-session PostgreSQL advisory-lock semantics.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const state = vi.hoisted(() => ({ db: null, busy: false, transaction: false, waiters: [], reservations: 0, released: [] }));
vi.mock('pg', () => ({ default: { Pool: class {
  on() {}
  async connect() {
    state.reservations++;
    if (state.busy) await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        state.waiters.splice(state.waiters.indexOf(waiter), 1);
        reject(new Error('bounded pool exhausted'));
      }, 1000);
      state.waiters.push(waiter);
    });
    state.busy = true;
    let address;
    return {
      async query(sql, params) {
        const result = await state.db.query(sql, params);
        if (sql.includes('pg_try_advisory_lock')) address = params[0];
        if (sql === 'BEGIN') state.transaction = true;
        if (sql === 'COMMIT' || sql === 'ROLLBACK') state.transaction = false;
        return result;
      },
      release() {
        expect(state.transaction).toBe(false);
        state.released.push(address);
        state.busy = false;
        state.waiters.shift()?.resolve();
      },
    };
  }
  async query(sql, params) {
    const client = await this.connect();
    try { return await client.query(sql, params); }
    finally { client.release(); }
  }
} } }));
vi.mock('../encryption.js', () => ({ encrypt: (v) => `enc:${v}`, decrypt: (v) => v }));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../tenant/tenantDomains.js', async (actual) => ({
  ...await actual(), kickDomainSync: vi.fn(async () => {}),
}));
vi.mock('./mailcow.js', async (actual) => ({
  ...await actual(),
  listDomains: vi.fn(async () => {
    expect(state.transaction).toBe(false);
    return [{ domain: 'example.com', active: true }];
  }),
  provisionMailbox: vi.fn(async () => {
    expect(state.transaction).toBe(false);
    return { password: 'test-password', reused: false };
  }),
  deleteMailbox: vi.fn(async () => { expect(state.transaction).toBe(false); }),
}));
const { createNodeMailbox } = await import('./mailboxActions.js');
const { provisionMailbox, deleteMailbox } = await import('./mailcow.js');
const { setTenantDriver } = await import('../tenant/driver.js');
const create = (localPart) => createNodeMailbox({ localPart, domain: 'example.com' }, {}, { onCreated: (account) => {
  expect(state.released).toContain(`account-address:${account.email_address}`);
} });

beforeAll(async () => {
  state.db = await createRealSchemaDb();
  setTenantDriver(null);
  await state.db.query("INSERT INTO mail_node_domains (domain, state, origin) VALUES ('example.com', 'ready', 'created')");
  await state.db.query("INSERT INTO integration_config (provider, config) VALUES ('mail_node', $1), ('mail_node_eop', $2)",
    [{ mailHost: 'mail.example.com', apiKey: 'test-key' }, { licenses: 2 }]);
});
afterAll(async () => { setTenantDriver(undefined); await state.db?.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  setTenantDriver(null);
  state.reservations = 0;
  state.released = [];
  await state.db.exec('DELETE FROM email_accounts; DELETE FROM mail_node_seat_assignments;');
  await state.db.query("UPDATE integration_config SET config = $1 WHERE provider = 'mail_node_eop'", [{ licenses: 2 }]);
});

it.each(['manual', 'graph'])('creates concurrent distinct addresses with one reservation each using %s seats', async (source) => {
  if (source === 'graph') {
    setTenantDriver({ kind: 'worker' });
    await state.db.query("UPDATE integration_config SET config = $1 WHERE provider = 'mail_node_eop'",
      [{ licenses: 0, tenantId: 'test', tenantDomain: 'example.com', appId: 'test', certThumbprint: 'test' }]);
    await state.db.query("INSERT INTO integration_config (provider, config) VALUES ('mail_node_eop_seats', $1)",
      [{ purchased: 2, found: true, at: new Date().toISOString() }]);
  }
  const results = await Promise.allSettled([create('first'), create('second')]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(results.map((result) => result.value?.account?.email_address)).toEqual(['first@example.com', 'second@example.com']);
  expect(state.reservations).toBe(2);
  expect(state.busy).toBe(false);
  expect((await state.db.query('SELECT account_id, pending_until FROM mail_node_seat_assignments')).rows)
    .toEqual(expect.arrayContaining(results.map(({ value }) => ({ account_id: value.account.id, pending_until: null }))));
});

it('rolls back an insert failure and compensates through the reserved client', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await state.db.exec("ALTER TABLE email_accounts ADD CONSTRAINT pool_test_block CHECK (email_address <> 'blocked@example.com')");
  try {
    expect(await create('blocked')).toEqual({ error: 'mailbox_create_failed' });
    expect(deleteMailbox).toHaveBeenCalledOnce();
    expect(state.reservations).toBe(1);
    expect((await state.db.query('SELECT * FROM mail_node_seat_assignments')).rows).toEqual([]);
    expect((await state.db.query('SELECT * FROM email_accounts')).rows).toEqual([]);
  } finally {
    await state.db.exec('ALTER TABLE email_accounts DROP CONSTRAINT pool_test_block');
    log.mockRestore();
  }
});

it('returns a pending seat on provision failure without another reservation', async () => {
  provisionMailbox.mockRejectedValueOnce(new Error('node unavailable'));
  await expect(create('failed')).rejects.toThrow('node unavailable');
  expect(state.reservations).toBe(1);
  expect((await state.db.query('SELECT * FROM mail_node_seat_assignments')).rows).toEqual([]);
});
