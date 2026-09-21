// Deploy e2e helper, run with `docker compose run` in the backend image of a test panel, so it
// has that panel's ENCRYPTION_KEY and database settings:
//   encrypt  prints encrypt($E2E_PLAIN)
//   check    prints "match" when the auth_pass of the mailbox $E2E_EMAIL decrypts to
//            $E2E_PLAIN, "mismatch" otherwise
import { decrypt, encrypt } from './src/services/encryption.js';

const mode = process.argv[2];
if (mode === 'encrypt') {
  console.log(encrypt(process.env.E2E_PLAIN));
  process.exit(0);
}
if (mode !== 'check') {
  console.log('usage: e2e-credential.mjs encrypt|check');
  process.exit(2);
}
const { pool } = await import('./src/services/db.js');
const { rows } = await pool.query('SELECT auth_pass FROM email_accounts WHERE email_address = $1', [process.env.E2E_EMAIL]);
console.error = () => {};
console.log(rows.length === 1 && decrypt(rows[0].auth_pass) === process.env.E2E_PLAIN ? 'match' : 'mismatch');
await pool.end();
process.exit(0);
