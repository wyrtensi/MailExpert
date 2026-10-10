import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';
import { safeAccount } from './manualAccounts.js';

const migrationUrl = new URL('../../../migrations/0099_mailbox_providers.sql', import.meta.url);
const ACTOR = '10000000-0000-4000-8000-000000000001';
const OTHER_ACTOR = '10000000-0000-4000-8000-000000000002';
const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const GENERATION = '30000000-0000-4000-8000-000000000001';
const REQUEST = '40000000-0000-4000-8000-000000000001';
let db;

beforeAll(async () => {
  db = await createRealSchemaDb({ before: '0099' });
  await db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES
      ('${ACTOR}', 'employee', 'fixture'), ('${OTHER_ACTOR}', 'other-employee', 'fixture');
    INSERT INTO email_accounts (id, name, email_address, imap_host, imap_tls, auth_pass, smtp_auth_pass, added_by) VALUES
      ('${ACCOUNT}', 'Legacy manual', 'legacy@example.com', '127.0.0.1', false, 'encrypted-fixture', 'encrypted-smtp-fixture', '${ACTOR}');
    INSERT INTO email_accounts (name, email_address, oauth_provider, mail_node) VALUES
      ('Google', 'google@example.com', 'google', false),
      ('Microsoft', 'microsoft@example.com', 'microsoft', false),
      ('Node', 'node@example.com', NULL, true);
  `);
  await db.exec(readFileSync(migrationUrl, 'utf8'));
});
afterAll(async () => { await db?.close(); });

describe('provider migration on every previous schema migration', () => {
  it('migration_preserves_legacy_accounts', async () => {
    const { rows } = await db.query('SELECT name, mail_provider, connection_mode, auth_pass, smtp_auth_pass FROM email_accounts ORDER BY name');
    expect(rows).toEqual([
      { name: 'Google', mail_provider: 'gmail', connection_mode: 'managed', auth_pass: null, smtp_auth_pass: null },
      { name: 'Legacy manual', mail_provider: null, connection_mode: 'manual', auth_pass: 'encrypted-fixture', smtp_auth_pass: 'encrypted-smtp-fixture' },
      { name: 'Microsoft', mail_provider: 'microsoft', connection_mode: 'managed', auth_pass: null, smtp_auth_pass: null },
      { name: 'Node', mail_provider: 'domain', connection_mode: 'managed', auth_pass: null, smtp_auth_pass: null },
    ]);
  });

  it('legacy_null_tls_mode_preserved', async () => {
    const { rows: [row] } = await db.query('SELECT * FROM email_accounts WHERE id = $1', [ACCOUNT]);
    expect(row.imap_tls_mode).toBeNull();
    expect(row.imap_tls).toBe(false);
    expect(safeAccount(row).imap_tls_mode).toBeNull();
  });

  it('explicit_mode_roundtrips_safe_list', async () => {
    const { rows: [row] } = await db.query(`INSERT INTO email_accounts
      (name, email_address, mail_provider, connection_mode, imap_tls_mode, auth_pass)
      VALUES ('Preset', 'preset@example.com', 'yahoo', 'preset', 'starttls', 'secret-sentinel') RETURNING *`);
    expect(safeAccount(row)).toMatchObject({ mail_provider: 'yahoo', connection_mode: 'preset', imap_tls_mode: 'starttls' });
    expect(JSON.stringify(safeAccount(row))).not.toContain('secret-sentinel');
    for (const [column, value] of [['mail_provider', 'unknown'], ['connection_mode', 'automatic'], ['imap_tls_mode', 'plaintext']]) {
      await expect(db.query(`UPDATE email_accounts SET ${column} = $1 WHERE id = $2`, [value, row.id])).rejects.toThrow(/check constraint/);
    }
  });

  it('proton_actor_request_unique', async () => {
    await db.query(`INSERT INTO proton_connections (actor_user_id, request_id, requested_email, state)
      VALUES ($1, $2, 'proton@example.com', 'pending')`, [ACTOR, REQUEST]);
    await expect(db.query(`INSERT INTO proton_connections (actor_user_id, request_id, requested_email, state)
      VALUES ($1, $2, 'proton@example.com', 'pending')`, [ACTOR, REQUEST])).rejects.toThrow(/duplicate key/);
    await db.query(`INSERT INTO proton_connections (actor_user_id, request_id, requested_email, state)
      VALUES ($1, $2, 'proton@example.com', 'pending')`, [OTHER_ACTOR, REQUEST]);
    const { rows } = await db.query('SELECT extract(epoch FROM expires_at - now())::double precision AS ttl_seconds FROM proton_connections');
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.ttl_seconds >= 590 && row.ttl_seconds <= 600)).toBe(true);
  });

  it('reconnect_target_is_durable', async () => {
    await db.query(`INSERT INTO proton_connections
      (actor_user_id, request_id, requested_email, state, reconnect_intent, reconnect_account_id)
      VALUES ($1, gen_random_uuid(), 'legacy@example.com', 'pending', true, $2)`, [ACTOR, ACCOUNT]);
    const { rows: [row] } = await db.query('SELECT user_id, reconnect_intent, reconnect_account_id FROM proton_connections WHERE reconnect_intent = true');
    expect(row).toEqual({ user_id: null, reconnect_intent: true, reconnect_account_id: ACCOUNT });
    await expect(db.query(`INSERT INTO proton_connections
      (actor_user_id, request_id, requested_email, state, reconnect_account_id)
      VALUES ($1, gen_random_uuid(), 'missing@example.com', 'pending', $2)`, [ACTOR, '99999999-0000-4000-8000-000000000001'])).rejects.toThrow(/foreign key/);
  });

  it('creation_requests_are_actor_scoped_and_outlive_account_deletion', async () => {
    const { rows: [account] } = await db.query("INSERT INTO email_accounts (name, email_address) VALUES ('Temporary', 'temporary@example.com') RETURNING id");
    await db.query(`INSERT INTO account_creation_requests
      (actor_user_id, request_id, requested_email, provider, mode, account_id, result_code)
      VALUES ($1, $2, 'temporary@example.com', 'other', 'manual', $3, 'created')`, [ACTOR, REQUEST, account.id]);
    await expect(db.query(`INSERT INTO account_creation_requests
      (actor_user_id, request_id, requested_email, provider, mode)
      VALUES ($1, $2, 'temporary@example.com', 'other', 'manual')`, [ACTOR, REQUEST])).rejects.toThrow(/duplicate key/);
    await db.query(`INSERT INTO account_creation_requests
      (actor_user_id, request_id, requested_email, provider, mode)
      VALUES ($1, $2, 'temporary@example.com', 'other', 'manual')`, [OTHER_ACTOR, REQUEST]);
    await db.query('DELETE FROM email_accounts WHERE id = $1', [account.id]);
    const { rows: [request] } = await db.query('SELECT account_id, result_code, extract(epoch FROM expires_at - now())::double precision AS ttl_seconds FROM account_creation_requests WHERE actor_user_id = $1', [ACTOR]);
    expect(request.account_id).toBeNull();
    expect(request.result_code).toBe('created');
    expect(request.ttl_seconds).toBeGreaterThanOrEqual(590);
    expect(request.ttl_seconds).toBeLessThanOrEqual(600);
  });

  it('managed_links_are_durable_generation_bound_and_cascade_with_mailbox', async () => {
    const { rows: [account] } = await db.query("INSERT INTO email_accounts (name, email_address) VALUES ('Managed', 'managed@example.com') RETURNING id");
    await db.query('INSERT INTO proton_users (user_id, generation, creator_user_id) VALUES ($1, $2, $3)', ['native-user', GENERATION, ACTOR]);
    await expect(db.query(`INSERT INTO proton_mailbox_links
      (account_id, user_id, generation, certificate_pem, certificate_fingerprint, tls_servername)
      VALUES ($1, $2, gen_random_uuid(), 'certificate-fixture', 'fingerprint-fixture', 'localhost')`, [account.id, 'native-user'])).rejects.toThrow(/foreign key/);
    await db.query(`INSERT INTO proton_mailbox_links
      (account_id, user_id, generation, certificate_pem, certificate_fingerprint, tls_servername)
      VALUES ($1, $2, $3, 'certificate-fixture', 'fingerprint-fixture', 'localhost')`, [account.id, 'native-user', GENERATION]);
    await db.query("DELETE FROM proton_connections WHERE expires_at < now() + interval '11 minutes'");
    expect((await db.query('SELECT account_id FROM proton_mailbox_links')).rows).toEqual([{ account_id: account.id }]);
    await db.query('DELETE FROM email_accounts WHERE id = $1', [account.id]);
    expect((await db.query('SELECT * FROM proton_mailbox_links')).rows).toEqual([]);
    expect((await db.query('SELECT user_id, cleanup_pending, removal_state FROM proton_users')).rows).toEqual([{ user_id: 'native-user', cleanup_pending: false, removal_state: null }]);
  });

  it('has_no_password_otp_or_credential_hash_columns_in_operation_tables', async () => {
    const { rows } = await db.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('proton_users', 'proton_connections', 'proton_mailbox_links', 'account_creation_requests')`);
    expect(rows.filter(row => /password|otp|credential|auth_pass/.test(row.column_name))).toEqual([]);
  });

  it('rotates_user_and_all_link_generations_atomically_but_rejects_stale_links', async () => {
    const { rows: [account] } = await db.query("INSERT INTO email_accounts (name, email_address) VALUES ('Rotation', 'rotation@example.com') RETURNING id");
    await db.query(`INSERT INTO proton_mailbox_links
      (account_id, user_id, generation, certificate_pem, certificate_fingerprint, tls_servername)
      VALUES ($1, 'native-user', $2, 'certificate-fixture', 'fingerprint-fixture', 'localhost')`, [account.id, GENERATION]);
    const nextGeneration = '30000000-0000-4000-8000-000000000002';
    await db.exec('BEGIN');
    await db.query('UPDATE proton_users SET generation = $1 WHERE user_id = $2', [nextGeneration, 'native-user']);
    await db.query('UPDATE proton_mailbox_links SET generation = $1 WHERE user_id = $2', [nextGeneration, 'native-user']);
    await db.exec('COMMIT');
    expect((await db.query('SELECT generation FROM proton_mailbox_links WHERE account_id = $1', [account.id])).rows).toEqual([{ generation: nextGeneration }]);
    await expect(db.query('UPDATE proton_mailbox_links SET generation = $1 WHERE account_id = $2', [GENERATION, account.id])).rejects.toThrow(/foreign key/);
  });

  it('can_apply_again_on_restart_without_rewriting_existing_metadata', async () => {
    await db.exec(readFileSync(migrationUrl, 'utf8'));
    const { rows } = await db.query("SELECT mail_provider, connection_mode, imap_tls_mode FROM email_accounts WHERE name = 'Preset'");
    expect(rows).toEqual([{ mail_provider: 'yahoo', connection_mode: 'preset', imap_tls_mode: 'starttls' }]);
    expect((await db.query('SELECT user_id FROM proton_users')).rows).toEqual([{ user_id: 'native-user' }]);
  });
});
