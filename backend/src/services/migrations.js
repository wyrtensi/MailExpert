import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { pool } from './db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

const NO_TRANSACTION_MARKER_RE = /^--\s*no-transaction\b/i;

// A migration opts out of running inside a transaction only when the marker is the very
// first non-blank line of the file. `/^.../im` used to match that comment at ANY line
// start, so a wrapped comment line elsewhere in the file that happened to start with those
// words — not intended as the marker — silently turned an ordinary migration into a
// statement-splitting one. Leading blank lines are allowed; anything else before the
// marker means it does not count.
export function hasNoTransactionMarker(sql) {
  for (const line of String(sql ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    return NO_TRANSACTION_MARKER_RE.test(line);
  }
  return false;
}

async function getMigrationFiles() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  return Promise.all(
    files.map(async filename => ({
      version: filename.replace(/\.sql$/, ''),
      sql: await readFile(join(MIGRATIONS_DIR, filename), 'utf8'),
    }))
  );
}

export async function runMigrations() {
  const client = await pool.connect();
  try {
    // Session-level advisory lock: held across individual migration transactions,
    // unlike pg_advisory_xact_lock which releases at each COMMIT and would let
    // a second runner acquire the lock between migrations.
    await client.query('SELECT pg_advisory_lock(7418291834)');
    // Disable statement_timeout for the migration client — bulk backfill migrations
    // (0002, 0017) can take longer than the 30 s pool default on large databases.
    await client.query('SET statement_timeout = 0');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    const applied = new Set(rows.map(r => r.version));

    const migrations = await getMigrationFiles();

    let ran = 0;
    for (const { version, sql } of migrations) {
      if (applied.has(version)) continue;
      console.log(`Migrations: applying ${version}`);

      // A migration whose first line is "-- no-transaction" runs outside a
      // transaction. Use this for CREATE INDEX CONCURRENTLY or data rewrites
      // that must not hold an open transaction for minutes. The migration must
      // be idempotent (use IF NOT EXISTS / IF EXISTS / ON CONFLICT) because a
      // crash after the SQL but before the schema_migrations INSERT will cause
      // it to be retried on next startup.
      const noTransaction = hasNoTransactionMarker(sql);

      if (noTransaction) {
        // Execute each statement individually. Sending a multi-statement string
        // as one client.query() call causes pg to use PostgreSQL's simple query
        // protocol, which wraps all statements in a single implicit transaction —
        // blocking CONCURRENTLY operations. Running them one at a time avoids this.
        const statements = sql
          .replace(/--[^\n]*/g, '')  // strip single-line comments
          .split(';')
          .map(s => s.trim())
          .filter(Boolean);
        for (const stmt of statements) {
          await client.query(stmt);
        }
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version],
        );
      } else {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version) VALUES ($1)',
            [version],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }
      ran++;
    }

    if (ran > 0) console.log(`Migrations: ${ran} migration(s) applied`);
    else console.log('Migrations: schema up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock(7418291834)').catch(() => {});
    client.release();
  }
}
