// Run by backup.sh --verify and restore.sh in the backend image, against a database restored
// from a backup: applies pending migrations (a backup of the running version has none) and
// decrypts every stored credential with ENCRYPTION_KEY from the same backup. Prints one line of
// counts, never a value. Exits 1 on any failure.
//
// VERIFY_EXPECT_MAILBOX=1: the backup has mailboxes, so at least one mailbox credential must
// decrypt (a key check that decrypted nothing proves nothing).
import { pool } from './src/services/db.js';
import { runMigrations } from './src/services/migrations.js';
import { decrypt } from './src/services/encryption.js';

// Values written by encrypt(): enc:v1:<iv hex>:<tag hex>:<ciphertext hex>.
const ENCRYPTED = /enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]*/g;
// Tables that hold values encrypted with ENCRYPTION_KEY. Whole rows are scanned as text, so a new
// encrypted column, or a token inside a JSON setting, in one of them needs no change here.
const TABLES = ['email_accounts', 'google_oauth_apps', 'users', 'system_settings', 'integration_config',
  'user_integrations', 'ai_codex_credentials', 'oidc_providers'];

const result = { migrationsApplied: 0, decrypted: 0, failed: 0, mailboxValues: 0 };
const print = console.log;
const quiet = () => {};
let ok = true;
try {
  const count = async () => Number((await pool.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n);
  const before = await count();
  console.log = quiet; // runMigrations reports progress on stdout; this script prints one line
  await runMigrations();
  console.log = print;
  result.migrationsApplied = (await count()) - before;
  if (result.migrationsApplied !== 0) ok = false;
  console.error = quiet; // decrypt() explains each failure on stderr; failures are counted instead
  for (const table of TABLES) {
    const { rows: [{ reg }] } = await pool.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
    if (!reg) continue;
    const { rows } = await pool.query(`SELECT t::text AS row FROM ${table} t`);
    for (const { row } of rows) {
      for (const value of row.match(ENCRYPTED) ?? []) {
        if (table === 'email_accounts') result.mailboxValues++;
        if (decrypt(value) === null) result.failed++;
        else result.decrypted++;
      }
    }
  }
  if (result.failed > 0) ok = false;
  if (process.env.VERIFY_EXPECT_MAILBOX === '1' && result.mailboxValues === 0) ok = false;
} catch (err) {
  console.log = print;
  result.error = err.code || err.name; // no message: it may quote data
  ok = false;
}
print(JSON.stringify(result));
await pool.end().catch(quiet);
process.exit(ok ? 0 : 1);
