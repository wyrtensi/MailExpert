// The free-text search against a real (in-process) Postgres: every branch of a term's condition
// must be answerable from an index. One branch that is not makes the planner read the whole
// messages table and compute a body's tsvector for every letter on every search (about 12 s per
// search at 100 000 letters), which is what happened while the body index was built on a
// different expression than the one the search uses.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { freeTextTermCondition } from './search.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

// As services/migrations.js runs a "-- no-transaction" migration: one statement at a time.
async function runMigrationFile(db, filename) {
  const statements = readFileSync(join(migrationsDir, filename), 'utf8')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.query(statement);
}

let db;

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    CREATE TABLE messages (
      id serial PRIMARY KEY, subject text, from_name varchar(500), from_email varchar(500),
      snippet text, body_text text, date timestamptz
    );
    -- The body index as the baseline migration creates it.
    CREATE INDEX idx_messages_body ON messages USING gin(to_tsvector('english', coalesce(body_text, '')));
  `);
  await runMigrationFile(db, '0008_search_indexes.sql');
  await runMigrationFile(db, '0072_search_body_index.sql');
  await db.query(`INSERT INTO messages (subject, from_name, from_email, snippet, body_text, date)
    SELECT 'Order ' || g, 'Sender ' || g, 'sender' || g || '@example.com', 'snippet ' || g,
           'body text of letter ' || g || CASE WHEN g = 7 THEN ' waybill' ELSE '' END,
           now() - (g || ' hours')::interval
    FROM generate_series(1, 3000) g`);
  await db.query('ANALYZE messages');
});

afterAll(async () => { await db?.close(); });

const termSql = `SELECT id FROM messages m WHERE ${freeTextTermCondition(1, 2)}`;

describe('free-text search term', () => {
  it('finds a word that is only in the body', async () => {
    const { rows } = await db.query(termSql, ['%waybill%', 'waybill']);
    expect(rows).toHaveLength(1);
  });

  it('is answered from indexes, never by reading every letter', async () => {
    await db.query('SET enable_seqscan = off');
    const { rows } = await db.query(`EXPLAIN ${termSql}`, ['%waybill%', 'waybill']);
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toContain('idx_messages_body_capped');
    expect(plan).not.toMatch(/Seq Scan on messages/);
  });

  it('drops the body index no search could use', async () => {
    const { rows } = await db.query("SELECT indexname FROM pg_indexes WHERE indexname = 'idx_messages_body'");
    expect(rows).toEqual([]);
  });
});
