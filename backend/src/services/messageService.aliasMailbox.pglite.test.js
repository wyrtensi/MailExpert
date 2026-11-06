// An alias as its own mailbox in the message list (listMessages with aliasId) on the real schema,
// against the fixture the list pill also runs (aliasMailbox.fixtures.json): its Inbox holds exactly
// the owner's INBOX letters whose recipient pill names the alias, its Sent the owner's Sent letters
// from the alias address. The EXPLAIN tests keep a big old mailbox off a full INBOX scan.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRealSchemaDb } from './testing/realSchema.js';

const dbState = { db: null, last: null };
vi.mock('./db.js', () => ({
  query: (sql, params) => {
    dbState.last = { sql, params };
    return dbState.db.query(sql, params);
  },
}));

const { listMessages } = await import('./messageService.js');

const fixture = JSON.parse(readFileSync(new URL('./aliasMailbox.fixtures.json', import.meta.url), 'utf8'));

const ACCOUNTS = {
  desk: '82000000-0000-4000-8000-000000000001',
  other: '82000000-0000-4000-8000-000000000002',
  node: '82000000-0000-4000-8000-000000000003',
  disabled: '82000000-0000-4000-8000-000000000004',
};
// Fixture aliases in fixture order (created_at ascending): ivan, anna, desk (the mailbox's own address).
const ALIAS_IDS = [
  '83000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000002',
  '83000000-0000-4000-8000-000000000003',
];
const NODE_ALIAS = '83000000-0000-4000-8000-000000000004';
const DISABLED_ALIAS = '83000000-0000-4000-8000-000000000005';
const UNKNOWN_ALIAS = '83000000-0000-4000-8000-0000000000ff';

const aliasId = (email) => ALIAS_IDS[fixture.aliases.findIndex((a) => a.email === email)];
const IVAN = aliasId('ivan@example.com');
const ANNA = aliasId('anna@example.com');
const DESK_OWN = aliasId('desk@example.com');

const idByCase = {};
const casesFor = (key, email) => fixture.cases.filter((c) => c.account === 'desk' && c[key] === email);
const idsOf = (cases) => cases.map((c) => idByCase[c.name]).sort();
const listedIds = (result) => result.messages.map((m) => m.id).sort();

let db;
beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;

  for (const [key, a] of Object.entries(fixture.accounts)) {
    await db.query(
      'INSERT INTO email_accounts (id, name, email_address, folder_mappings) VALUES ($1, $2, $3, $4::jsonb)',
      [ACCOUNTS[key], a.name, a.email_address, JSON.stringify(a.folder_mappings)],
    );
  }
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, mail_node, enabled)
     VALUES ($1, 'Node', 'node@example.com', true, true), ($2, 'Off', 'off@example.com', false, false)`,
    [ACCOUNTS.node, ACCOUNTS.disabled],
  );
  for (const f of fixture.folders) {
    await db.query(
      'INSERT INTO folders (account_id, path, name, special_use) VALUES ($1, $2, $3, $4)',
      [ACCOUNTS[f.account], f.path, f.name, f.special_use],
    );
  }
  // The folder's cached counters are of all its mail, never the alias's.
  await db.query("UPDATE folders SET total_count = 999, unread_count = 999 WHERE account_id = $1", [ACCOUNTS.desk]);

  for (const [i, a] of fixture.aliases.entries()) {
    await db.query(
      `INSERT INTO account_aliases (id, account_id, name, email, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)`,
      [ALIAS_IDS[i], ACCOUNTS[a.account], a.name, a.email, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()],
    );
  }
  await db.query(
    `INSERT INTO account_aliases (id, account_id, name, email)
     VALUES ($1, $3, 'Node Other', 'ivan@example.com'), ($2, $4, 'Off Alias', 'ivan@example.com')`,
    [NODE_ALIAS, DISABLED_ALIAS, ACCOUNTS.node, ACCOUNTS.disabled],
  );

  let uid = 1;
  for (const c of fixture.cases) {
    const { rows } = await db.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, subject, date, from_email, to_addresses, cc_addresses, delivery_addresses, category, is_read)
       VALUES ($1, $2, $3, $4, $5, $12::timestamptz, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)
       RETURNING id`,
      [ACCOUNTS[c.account], uid, c.folder, `<${uid}@example.com>`, `fixture: ${c.name}`, c.from_email,
        JSON.stringify(c.to.map((email) => ({ name: '', email }))), JSON.stringify(c.cc.map((email) => ({ name: '', email }))),
        c.delivery === null ? null : JSON.stringify(c.delivery), c.category, c.is_read,
        new Date(Date.UTC(2026, 9, 1, 12) - uid * 60000).toISOString()],
    );
    idByCase[c.name] = rows[0].id;
    uid += 1;
  }
}, 120000);
afterAll(async () => { await db.close(); });

const desk = (args) => listMessages({ accountId: ACCOUNTS.desk, folder: 'INBOX', ...args });

describe('listMessages with aliasId', () => {
  it('alias Inbox lists exactly the fixture letters of that alias, flat and threaded', async () => {
    for (const [id, email] of [[IVAN, 'ivan@example.com'], [ANNA, 'anna@example.com']]) {
      const expected = idsOf(casesFor('inbox', email));
      expect(expected.length).toBeGreaterThan(0);
      expect(listedIds(await desk({ aliasId: id }))).toEqual(expected);
      expect(listedIds(await desk({ aliasId: id, threaded: true }))).toEqual(expected);
    }
  });

  it('letters of every category are listed even when category is passed', async () => {
    const flat = await desk({ aliasId: IVAN, category: 'primary' });
    const threaded = await desk({ aliasId: IVAN, category: 'primary', threaded: true });
    for (const result of [flat, threaded]) {
      expect(listedIds(result)).toContain(idByCase.newsletter);
      expect(listedIds(result)).toEqual(idsOf(casesFor('inbox', 'ivan@example.com')));
    }
  });

  it("unreadOnly lists and counts only the alias's unread letters", async () => {
    const expected = idsOf(casesFor('inbox', 'ivan@example.com').filter((c) => !c.is_read));
    expect(expected.length).toBeGreaterThan(0);
    const flat = await desk({ aliasId: IVAN, unreadOnly: 'true' });
    expect(listedIds(flat)).toEqual(expected);
    expect(flat.total).toBe(expected.length);
    const threaded = await desk({ aliasId: IVAN, unreadOnly: 'true', threaded: true });
    expect(listedIds(threaded)).toEqual(expected);
    expect(threaded.total).toBe(expected.length);
  });

  it("total counts the alias's letters, not the folder", async () => {
    const count = casesFor('inbox', 'ivan@example.com').length;
    const flat = await desk({ aliasId: IVAN, limit: 1 });
    expect(flat.messages).toHaveLength(1);
    expect(flat.total).toBe(count);
    const threaded = await desk({ aliasId: IVAN, limit: 1, threaded: true });
    expect(threaded.messages).toHaveLength(1);
    expect(threaded.total).toBe(count);
  });

  it('alias Sent lists letters from the alias address in the Sent folder, any case', async () => {
    const expected = idsOf(casesFor('sent', 'ivan@example.com'));
    expect(expected).toHaveLength(2);
    const flat = await desk({ aliasId: IVAN, folder: 'Sent' });
    expect(listedIds(flat)).toEqual(expected);
    expect(flat.total).toBe(2);
    expect(listedIds(await desk({ aliasId: IVAN, folder: 'Sent', threaded: true }))).toEqual(expected);
    expect((await desk({ aliasId: ANNA, folder: 'Sent' })).messages).toEqual([]);
  });

  it("another mailbox's letter to the alias address is not listed", async () => {
    const ids = listedIds(await desk({ aliasId: IVAN }));
    expect(ids).not.toContain(idByCase['other-mailbox']);
    expect(await listMessages({ accountId: ACCOUNTS.other, folder: 'INBOX', aliasId: IVAN })).toEqual({ error: 'alias_gone' });
  });

  it("refuses the mailbox's own address, an unknown alias, a mail node and a disabled mailbox with alias_gone", async () => {
    expect(await desk({ aliasId: DESK_OWN })).toEqual({ error: 'alias_gone' });
    expect(await desk({ aliasId: UNKNOWN_ALIAS })).toEqual({ error: 'alias_gone' });
    expect(await listMessages({ accountId: ACCOUNTS.node, folder: 'INBOX', aliasId: NODE_ALIAS })).toEqual({ error: 'alias_gone' });
    expect(await listMessages({ accountId: ACCOUNTS.disabled, folder: 'INBOX', aliasId: DISABLED_ALIAS })).toEqual({ error: 'alias_gone' });
    expect(await listMessages({ folder: 'INBOX', aliasId: IVAN })).toEqual({ error: 'alias_gone' });
  });

  it('refuses a folder other than INBOX and Sent with alias_folder', async () => {
    expect(await desk({ aliasId: IVAN, folder: 'Archive' })).toEqual({ error: 'alias_folder' });
    expect(await desk({ aliasId: IVAN, folder: 'Drafts', threaded: true })).toEqual({ error: 'alias_folder' });
  });
});

describe('alias mailbox query plans', () => {
  beforeAll(async () => {
    // A big old mailbox: letters to someone else in INBOX, the mailbox's own letters in Sent.
    await db.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, subject, date, from_email, to_addresses, delivery_addresses, is_read)
       SELECT $1, 10000 + g, 'INBOX', '<bulk-in-' || g || '@example.com>', 'Bulk ' || g, now() - (g || ' minutes')::interval,
              'client' || g || '@corp.test', '[{"name":"","email":"other@corp.test"}]'::jsonb, '["other@corp.test"]'::jsonb, true
       FROM generate_series(1, 3000) g`,
      [ACCOUNTS.desk],
    );
    await db.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, subject, date, from_email, to_addresses, is_read)
       SELECT $1, 20000 + g, 'Sent', '<bulk-out-' || g || '@example.com>', 'Reply ' || g, now() - (g || ' minutes')::interval,
              'desk@example.com', '[{"name":"","email":"client@corp.test"}]'::jsonb, true
       FROM generate_series(1, 3000) g`,
      [ACCOUNTS.desk],
    );
    await db.query('ANALYZE messages');
    await db.query('SET enable_seqscan = off');
  });
  afterAll(async () => { await db.query('RESET enable_seqscan'); });

  const planOf = async (args) => {
    await desk(args);
    const { sql, params } = dbState.last;
    const { rows } = await db.query(`EXPLAIN ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  };

  it('alias Inbox is answered from the address indexes', async () => {
    const plan = await planOf({ aliasId: IVAN });
    expect(plan).toContain('idx_messages_delivery_addresses');
    expect(plan).toContain('idx_messages_recipient_addresses');
    expect(plan).not.toMatch(/Seq Scan on messages/);
  });

  it('alias Sent is answered from idx_messages_account_from_date', async () => {
    const plan = await planOf({ aliasId: IVAN, folder: 'Sent' });
    expect(plan).toContain('idx_messages_account_from_date');
    expect(plan).not.toMatch(/Seq Scan on messages/);
  });
});
