import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// account_aliases.source on the real schema: aliases synced from Gmail are read-only for the
// manual alias functions, and a manual alias never duplicates a synced address.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('./db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));

const { createRealSchemaDb } = await import('./testing/realSchema.js');
const { ALIAS_ERRORS, createAlias, deleteAlias, listAliases, listAliasesByAccount, updateAlias } = await import('./accountAliases.js');

const SALES = '70000000-0000-4000-8000-000000000001';
const OPS = '70000000-0000-4000-8000-000000000002';

let db;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

beforeEach(async () => {
  await db.exec('DELETE FROM account_aliases; DELETE FROM email_accounts;');
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, imap_host) VALUES
       ($1, 'Sales', 'sales@example.com', 'mail.test'), ($2, 'Ops', 'ops@example.com', 'mail.test')`,
    [SALES, OPS],
  );
});

const insertGmail = async (accountId, email) => {
  const { rows } = await db.query(
    "INSERT INTO account_aliases (account_id, name, email, source) VALUES ($1, 'Gmail name', $2, 'gmail') RETURNING *",
    [accountId, email],
  );
  return rows[0];
};

describe('gmail-synced aliases', () => {
  it("updateAlias on a gmail alias returns { error: 'alias_managed_by_gmail' } and keeps the row unchanged", async () => {
    const alias = await insertGmail(SALES, 'info@example.com');
    const result = await updateAlias(SALES, alias.id, { name: 'Changed', email: 'other@example.com' });
    expect(result).toEqual({ error: 'alias_managed_by_gmail' });
    const { rows } = await db.query('SELECT name, email FROM account_aliases WHERE id = $1', [alias.id]);
    expect(rows[0]).toEqual({ name: 'Gmail name', email: 'info@example.com' });
  });

  it("deleteAlias on a gmail alias returns { error: 'alias_managed_by_gmail' } and keeps the row", async () => {
    const alias = await insertGmail(SALES, 'info@example.com');
    expect(await deleteAlias(SALES, alias.id)).toEqual({ error: 'alias_managed_by_gmail' });
    const { rows } = await db.query('SELECT id FROM account_aliases WHERE id = $1', [alias.id]);
    expect(rows).toHaveLength(1);
  });

  it('a gmail alias of another account is still alias_not_found', async () => {
    const alias = await insertGmail(OPS, 'info@example.com');
    expect(await updateAlias(SALES, alias.id, { name: 'X', email: 'x@example.com' })).toEqual({ error: 'alias_not_found' });
    expect(await deleteAlias(SALES, alias.id)).toEqual({ error: 'alias_not_found' });
  });

  it("createAlias stores source 'manual'; listAliases returns source", async () => {
    const { alias } = await createAlias(SALES, { name: 'Support', email: 'support@example.com' });
    expect(alias.source).toBe('manual');
    await insertGmail(SALES, 'info@example.com');
    const list = await listAliases(SALES);
    expect(list.map((a) => a.source).sort()).toEqual(['gmail', 'manual']);
  });

  it('unique index refuses a second gmail alias with the same email in another case for the same account', async () => {
    await insertGmail(SALES, 'Info@Example.com');
    await expect(insertGmail(SALES, 'info@example.COM')).rejects.toThrow();
    await expect(insertGmail(OPS, 'info@example.com')).resolves.toBeTruthy();
  });

  it('createAlias refuses an address already synced from Gmail (any case)', async () => {
    await insertGmail(SALES, 'info@example.com');
    const result = await createAlias(SALES, { name: 'Dup', email: 'INFO@Example.com' });
    expect(result).toEqual({ error: 'alias_managed_by_gmail' });
    expect(ALIAS_ERRORS.alias_managed_by_gmail).toEqual([409, 'This alias is synced from Gmail: change it in Gmail']);
    const other = await createAlias(OPS, { name: 'Ok', email: 'info@example.com' });
    expect(other.alias).toBeTruthy();
  });

  it('updateAlias refuses changing a manual alias to an address synced from Gmail', async () => {
    await insertGmail(SALES, 'info@example.com');
    const { alias } = await createAlias(SALES, { name: 'Support', email: 'support@example.com' });
    const result = await updateAlias(SALES, alias.id, { name: 'Support', email: 'Info@example.com' });
    expect(result).toEqual({ error: 'alias_managed_by_gmail' });
    const { rows } = await db.query('SELECT email FROM account_aliases WHERE id = $1', [alias.id]);
    expect(rows[0].email).toBe('support@example.com');
  });
});

describe('alias order', () => {
  it('listAliases and listAliasesByAccount order aliases inserted in one transaction by id', async () => {
    // One transaction: now() is the same for every row, so created_at ties and id decides. The ids
    // are inserted out of their sorted order, so a missing id tie-break fails every run.
    const ids = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    await db.exec('BEGIN');
    for (const [i, id] of ids.entries()) {
      await db.query("INSERT INTO account_aliases (id, account_id, name, email, source) VALUES ($1, $2, 'N', $3, 'gmail')", [id, SALES, `a${i}@example.com`]);
    }
    await db.exec('COMMIT');
    const expected = [...ids].sort();
    expect((await listAliases(SALES)).map((a) => a.id)).toEqual(expected);
    const byAccount = await listAliasesByAccount([SALES, OPS]);
    expect(byAccount[SALES].map((a) => a.id)).toEqual(expected);
    expect(byAccount[OPS]).toBeUndefined();
  });
});
