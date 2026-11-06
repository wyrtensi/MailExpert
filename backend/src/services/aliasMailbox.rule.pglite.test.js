import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRealSchemaDb } from './testing/realSchema.js';

// message_reply_alias (migration 0101) on the real schema, against the fixture the frontend
// suite also runs (utils/aliasInboxParity.test.js against recipientAliasFor).

const fixture = JSON.parse(readFileSync(new URL('./aliasMailbox.fixtures.json', import.meta.url), 'utf8'));
const ALIASES = ['ivan@example.com', 'anna@example.com'];
const OWN = ['desk@example.com', 'ivan@example.com', 'anna@example.com'];

let db;
beforeAll(async () => { db = await createRealSchemaDb(); }, 120000);
afterAll(async () => { await db.close(); });

describe('message_reply_alias', () => {
  const accountIds = { desk: '80000000-0000-4000-8000-000000000001', other: '80000000-0000-4000-8000-000000000002' };

  beforeAll(async () => {
    for (const [key, a] of Object.entries(fixture.accounts)) {
      await db.query('INSERT INTO email_accounts (id, name, email_address) VALUES ($1, $2, $3)', [accountIds[key], a.name, a.email_address]);
    }
    let uid = 1;
    for (const c of fixture.cases) {
      await db.query(
        `INSERT INTO messages (account_id, uid, folder, message_id, subject, date, from_email, to_addresses, cc_addresses, delivery_addresses, category, is_read)
         VALUES ($1, $2, $3, $4, $5, now(), $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)`,
        [accountIds[c.account], uid, c.folder, `<${uid}@example.com>`, `fixture: ${c.name}`, c.from_email,
          JSON.stringify(c.to.map((email) => ({ name: '', email }))), JSON.stringify(c.cc.map((email) => ({ name: '', email }))),
          c.delivery === null ? null : JSON.stringify(c.delivery), c.category, c.is_read],
      );
      uid += 1;
    }
  });

  for (const c of fixture.cases.filter((x) => x.folder === 'INBOX' && x.account === 'desk')) {
    it(`fixture: ${c.name}`, async () => {
      const { rows } = await db.query(
        `SELECT message_reply_alias(delivery_addresses, to_addresses, cc_addresses, from_email, $2::text[], $3::text[]) AS alias
           FROM messages WHERE subject = $1`,
        [`fixture: ${c.name}`, ALIASES, OWN],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].alias).toBe(c.inbox);
    });
  }

  it('the other mailbox (no aliases) gets no alias for the same letter', async () => {
    const c = fixture.cases.find((x) => x.account === 'other');
    const { rows } = await db.query(
      `SELECT message_reply_alias(delivery_addresses, to_addresses, cc_addresses, from_email, '{}'::text[], ARRAY['science@example.com']) AS alias
         FROM messages WHERE subject = $1`,
      [`fixture: ${c.name}`],
    );
    expect(rows[0].alias).toBe(c.inbox);
  });
});

describe('message_delivery_addresses', () => {
  it('message_delivery_addresses lowercases strings and answers {} for NULL and a non-array', async () => {
    const run = async (value) => (await db.query('SELECT message_delivery_addresses($1::jsonb) AS a', [value])).rows[0].a;
    expect(await run(JSON.stringify(['Ivan@Example.com', 'anna@example.com']))).toEqual(['anna@example.com', 'ivan@example.com']);
    expect(await run(null)).toEqual([]);
    expect(await run(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(await run(JSON.stringify('ivan@example.com'))).toEqual([]);
  });
});

describe('migration 0102', () => {
  it('0102 creates idx_messages_delivery_addresses as a partial GIN index', async () => {
    const { rows } = await db.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_messages_delivery_addresses'");
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/USING gin \(message_delivery_addresses\(delivery_addresses\)\)/i);
    expect(rows[0].indexdef).toMatch(/WHERE \(?is_deleted = false\)?/i);
  });
});
