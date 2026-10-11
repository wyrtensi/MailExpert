import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRealSchemaDb } from '../testing/realSchema.js';
import { createFakeWorker, deferred } from './connections.fixtures.js';

// The real schema answers every query; the worker, the IMAP/SMTP probe and the Proton API
// reachability check are fakes. probeManagedProtonConnection itself is the real Task 6 code.
const state = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({
  query: (sql, p) => state.db.query(sql, p),
  pool: { connect: async () => ({ query: (sql, p) => state.db.query(sql, p), release() {} }) },
}));
vi.mock('./workerClient.js', () => ({ callWorker: vi.fn() }));
vi.mock('./apiReachability.js', () => ({ isProtonApiReachable: vi.fn(async () => true) }));
vi.mock('../accounts/connectionProbe.js', () => ({ probeConnection: vi.fn(async c => ({ imapLogin: c.auth_user, smtpLogin: c.smtp_auth_user })) }));
vi.mock('../encryption.js', () => ({ encrypt: v => v ? 'enc:' + v : null, decrypt: v => v }));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../redis.js', () => ({ redisClient: { incr: async () => { throw new Error('offline'); }, del: async () => {} } }));

const { callWorker } = await import('./workerClient.js');
const { isProtonApiReachable } = await import('./apiReachability.js');
const { probeConnection } = await import('../accounts/connectionProbe.js');
const { recordAudit } = await import('../auditLog.js');
const { reset } = await import('../rateLimiter.js');
const { closeCreationAdmission, reopenCreationAdmission } = await import('../accounts/accountCreation.js');
const {
  startProtonConnection, getProtonConnection, continueProtonConnection, cancelProtonConnection,
  reconcileProtonConnectionsAtStartup, protonConnectionWork, setProtonMailEngine, PROTON_CONNECTION_TTL_MS,
} = await import('./connections.js');

const OWNER = '70000000-0000-4000-8000-000000000001';
const OTHER = '70000000-0000-4000-8000-000000000002';
const ADMIN = '70000000-0000-4000-8000-000000000003';
const owner = { userId: OWNER, isAdmin: false };
const other = { userId: OTHER, isAdmin: false };
const admin = { userId: ADMIN, isAdmin: true };
const NATIVE = 'bmF0aXZlLXVzZXI=';
const OTHER_NATIVE = 'b3RoZXItdXNlcg==';
const SECRETS = ['main-secret-sentinel', 'bridge-secret-sentinel', 'grpc-secret-sentinel', '2fa-secret-sentinel'];
const SECRET_KEYS = ['password', 'bridgePassword', 'certificatePem', 'grpcToken', 'auth_pass', 'smtp_auth_pass'];

let fake;
const engine = { connectAccount: vi.fn(async () => true), disconnectAccount: vi.fn(async () => {}), clearConnectCooldown: vi.fn() };
const count = async (table, where = 'true') => (await state.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;
const row = async id => (await state.db.query('SELECT * FROM proton_connections WHERE id = $1', [id])).rows[0];
const start = (patch = {}, actor = owner) => startProtonConnection({ email: 'Box@Proton.me', password: 'main-secret-sentinel', requestId: randomUUID(), ...patch }, actor);
const poll = async (id, actor = owner) => { const status = await getProtonConnection(id, actor); await protonConnectionWork(); return status; };
const expectNoSecrets = value => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  for (const key of SECRET_KEYS) expect(text).not.toContain(`"${key}"`);
  expect(text).not.toContain('BEGIN CERTIFICATE');
};
async function connectFully(patch = {}, actor = owner, userId = NATIVE) {
  const started = await start(patch, actor);
  fake.connect(started.id, userId);
  await poll(started.id, actor);
  return getProtonConnection(started.id, actor);
}
async function seedLinkedAccount({ email = 'box@proton.me', userId = NATIVE, addedBy = OWNER } = {}) {
  const generation = randomUUID();
  await state.db.query('INSERT INTO proton_users (proton_user_id, generation) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, generation]);
  const { rows: [{ generation: current }] } = await state.db.query('SELECT generation FROM proton_users WHERE proton_user_id = $1', [userId]);
  const { rows: [account] } = await state.db.query(`INSERT INTO email_accounts (added_by, name, email_address, imap_host, imap_port, smtp_host, smtp_port, auth_user, auth_pass, mail_provider, connection_mode, imap_tls_mode)
    VALUES ($1, 'Team', $2, '127.0.0.1', 1993, '127.0.0.1', 1465, $2, 'enc:old-bridge', 'proton', 'managed', 'implicit') RETURNING *`, [addedBy, email]);
  await state.db.query(`INSERT INTO proton_mailbox_links (account_id, proton_user_id, generation, certificate_pem, certificate_fingerprint, tls_servername)
    VALUES ($1, $2, $3, 'old-pem', 'old-fingerprint', '127.0.0.1')`, [account.id, userId, current]);
  return { account, generation: current };
}

beforeAll(async () => {
  state.db = await createRealSchemaDb();
  await state.db.query(`INSERT INTO users (id, username, is_admin) VALUES ($1, 'owner', false), ($2, 'other', false), ($3, 'admin', true)`, [OWNER, OTHER, ADMIN]);
  setProtonMailEngine(engine);
});
afterAll(async () => { await state.db.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  for (const user of [OWNER, OTHER, ADMIN]) { await reset(`account-create:${user}`); await reset(`proton-poll:${user}`); }
  await state.db.exec('DELETE FROM proton_connections; DELETE FROM proton_mailbox_links; DELETE FROM email_accounts; DELETE FROM proton_users;');
  fake = createFakeWorker();
  callWorker.mockImplementation(fake.call);
  isProtonApiReachable.mockResolvedValue(true);
  probeConnection.mockImplementation(async c => ({ imapLogin: c.auth_user, smtpLogin: c.smtp_auth_user }));
});
afterEach(async () => { reopenCreationAdmission(); await protonConnectionWork(); vi.useRealTimers(); });

describe('Proton connection operations', () => {
  it('login_operation_is_bound_to_actor', async () => {
    const started = await start();
    expect(started).toEqual({ id: started.id, state: 'authenticating' });
    expect(await getProtonConnection(started.id, other)).toEqual({ error: 'not_found', code: 'not_found' });
    expect(await continueProtonConnection(started.id, { challenge: '2fa', secret: '123456' }, other)).toMatchObject({ code: 'not_found' });
    expect(await cancelProtonConnection(started.id, other)).toMatchObject({ code: 'not_found' });
    expect(await cancelProtonConnection(started.id, admin)).toMatchObject({ code: 'not_found' });
    expect(await getProtonConnection(started.id, admin)).toEqual({ id: started.id, state: 'authenticating' });
    expect(await getProtonConnection(randomUUID(), owner)).toMatchObject({ code: 'not_found' });
    expect(fake.paths('/cancel')).toHaveLength(0);
  });

  it('ttl_is_ten_minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
    const startedAt = Date.now();
    const started = await start();
    expect(PROTON_CONNECTION_TTL_MS).toBe(600000);
    expect(Date.parse((await row(started.id)).expires_at) - startedAt).toBe(600000);
    vi.useRealTimers();
    await state.db.query("UPDATE proton_connections SET expires_at = now() - interval '1 second' WHERE id = $1", [started.id]);
    expect(await poll(started.id)).toEqual({ id: started.id, state: 'expired' });
    expect(fake.paths(`/connections/${started.id}/cancel`)).toHaveLength(1);
  });

  it('address_must_belong_to_native_user', async () => {
    fake.credentialsEmail = 'someone-else@proton.me';
    const started = await start();
    fake.connect(started.id, NATIVE);
    await poll(started.id);
    expect(await getProtonConnection(started.id, owner)).toEqual({ id: started.id, state: 'failed', errorCode: 'address_mismatch' });
    expect(await count('email_accounts')).toBe(0);
    expect(fake.paths(`/connections/${started.id}/cancel`)).toHaveLength(1);
    expect(fake.paths('/commit')).toHaveLength(0);

    fake.credentialsEmail = null;
    const second = await start();
    fake.set(second.id, { state: 'failed', errorCode: 'address_mismatch' });
    expect(await poll(second.id)).toEqual({ id: second.id, state: 'failed', errorCode: 'address_mismatch' });
  });

  it('second_poll_does_not_create_second_mailbox', async () => {
    const started = await start({ name: 'Team box', color: '#112233' });
    fake.connect(started.id, NATIVE);
    await Promise.all([getProtonConnection(started.id, owner), getProtonConnection(started.id, owner), getProtonConnection(started.id, admin)]);
    await protonConnectionWork();
    const done = await poll(started.id);
    await poll(started.id);
    expect(done).toMatchObject({ id: started.id, state: 'connected', account: { email_address: 'box@proton.me', name: 'Team box', color: '#112233', mail_provider: 'proton', connection_mode: 'managed', can_reconnect_proton: true } });
    expect(await count('email_accounts')).toBe(1);
    expect(await count('proton_mailbox_links')).toBe(1);
    expect(probeConnection).toHaveBeenCalledOnce();
    expect(fake.paths('/commit')).toHaveLength(1);
    expect(engine.connectAccount).toHaveBeenCalledOnce();
    const { rows: [account] } = await state.db.query('SELECT * FROM email_accounts');
    expect(account).toMatchObject({ imap_host: '127.0.0.1', imap_port: 1993, smtp_host: '127.0.0.1', smtp_port: 1465, smtp_tls: 'SSL', auth_pass: 'enc:bridge-secret-sentinel', smtp_auth_pass: 'enc:bridge-secret-sentinel', imap_tls_mode: 'implicit', added_by: OWNER });
    const { rows: [link] } = await state.db.query('SELECT l.*, u.generation AS user_generation FROM proton_mailbox_links l JOIN proton_users u USING (proton_user_id)');
    expect(link).toMatchObject({ account_id: account.id, proton_user_id: NATIVE, certificate_pem: fake.certificatePem, tls_servername: '127.0.0.1' });
    expect(fake.paths('/commit')[0].body).toEqual({ userId: NATIVE, generation: link.user_generation });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mailbox.added', accountId: account.id }));
  });

  it('failed_probe_schedules_only_new_user_cleanup', async () => {
    const { account: existing } = await seedLinkedAccount({ email: 'first@proton.me' });
    probeConnection.mockRejectedValueOnce(Object.assign(new Error('raw server text'), { code: 'imap_auth_failed' }));
    const started = await start({ email: 'second@proton.me' });
    fake.connect(started.id, NATIVE, { createdByAttempt: false });
    await poll(started.id);
    expect(await getProtonConnection(started.id, owner)).toEqual({ id: started.id, state: 'failed', errorCode: 'imap_auth_failed' });
    expect(fake.paths('/cancel').map(call => call.path)).toEqual([`/connections/${started.id}/cancel`]);
    expect(fake.calls.filter(call => call.path.endsWith('/remove'))).toHaveLength(0);
    expect((await state.db.query('SELECT id FROM email_accounts')).rows).toEqual([{ id: existing.id }]);
    expect(await count('proton_mailbox_links')).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mailbox.connection_failed', details: expect.objectContaining({ code: 'imap_auth_failed' }) }));
  });

  it('restart_marks_incomplete_operation_safely', async () => {
    const { account, generation } = await seedLinkedAccount();
    const ids = {};
    for (const stateName of ['authenticating', 'needs_2fa', 'checking', 'committing', 'connected', 'failed']) {
      const id = randomUUID();
      ids[stateName] = id;
      await state.db.query(`INSERT INTO proton_connections (id, actor_user_id, request_id, requested_email, state, proton_user_id, account_id)
        VALUES ($1, $2, gen_random_uuid(), 'box@proton.me', $3, $4, $5)`,
      [id, OWNER, stateName, ['checking', 'committing', 'connected'].includes(stateName) ? NATIVE : null, ['committing', 'connected'].includes(stateName) ? account.id : null]);
      fake.operations.set(id, { id, email: 'box@proton.me', state: ['checking', 'committing', 'connected'].includes(stateName) ? 'connected' : stateName, userId: NATIVE, committed: false });
    }
    await reconcileProtonConnectionsAtStartup();
    await protonConnectionWork();
    for (const name of ['authenticating', 'needs_2fa', 'checking']) {
      expect(await row(ids[name])).toMatchObject({ state: 'failed', error_code: 'proton_unavailable' });
      expect(fake.paths(`/connections/${ids[name]}/cancel`)).toHaveLength(1);
    }
    expect(await row(ids.committing)).toMatchObject({ state: 'connected', account_id: account.id });
    expect(fake.paths('/commit').map(call => [call.path, call.body])).toEqual([[`/connections/${ids.committing}/commit`, { userId: NATIVE, generation }]]);
    expect(await row(ids.connected)).toMatchObject({ state: 'connected' });
    expect(await row(ids.failed)).toMatchObject({ state: 'failed' });
    expect(fake.logins).toBe(0);
  });

  it('no_worker_secret_reaches_public_response', async () => {
    const seen = [];
    const started = await start();
    seen.push(started);
    fake.set(started.id, { state: 'needs_2fa' });
    seen.push(await poll(started.id));
    expect(seen.at(-1)).toEqual({ id: started.id, state: 'needs_2fa' });
    seen.push(await continueProtonConnection(started.id, { challenge: '2fa', secret: '2fa-secret-sentinel' }, owner));
    fake.connect(started.id, NATIVE);
    seen.push(await poll(started.id));
    seen.push(await poll(started.id));
    seen.push(await getProtonConnection(started.id, admin));
    expect(seen.at(-1)).toMatchObject({ state: 'connected', account: { email_address: 'box@proton.me' } });
    expectNoSecrets(seen);
    expectNoSecrets(await row(started.id));
    expectNoSecrets(recordAudit.mock.calls);
  });

  it('duplicate_request_never_restarts_native_login', async () => {
    const requestId = randomUUID();
    const [a, b] = await Promise.all([start({ requestId }), start({ requestId })]);
    const c = await start({ requestId, password: 'another-password' });
    expect(a.id).toBe(b.id);
    expect(c.id).toBe(a.id);
    expect(fake.logins).toBe(1);
    expect(await start({ requestId, email: 'other@proton.me' })).toEqual({ error: 'idempotency_conflict', code: 'idempotency_conflict' });
    expect(await count('proton_connections')).toBe(1);
    // The same key from another employee is a separate attempt.
    expect((await start({ requestId }, other)).id).not.toBe(a.id);
    expect(fake.logins).toBe(2);
  });

  it('any_employee_reconnects_same_account', async () => {
    const { account, generation } = await seedLinkedAccount({ addedBy: OWNER });
    expect(await start({}, other)).toMatchObject({ state: 'failed', errorCode: 'already_connected' });
    expect(fake.logins).toBe(0);
    const done = await connectFully({ reconnectAccountId: account.id }, other);
    expect(done).toMatchObject({ state: 'connected', account: { id: account.id, can_reconnect_proton: true } });
    expect(await count('email_accounts')).toBe(1);
    expect((await state.db.query('SELECT auth_pass, smtp_auth_pass, added_by FROM email_accounts')).rows[0]).toEqual({ auth_pass: 'enc:bridge-secret-sentinel', smtp_auth_pass: 'enc:bridge-secret-sentinel', added_by: OWNER });
    expect((await state.db.query('SELECT certificate_pem, generation FROM proton_mailbox_links')).rows[0]).toEqual({ certificate_pem: fake.certificatePem, generation });
    expect(fake.paths('/commit')[0].body).toEqual({ userId: NATIVE, generation });
    expect(engine.disconnectAccount).toHaveBeenCalledWith(account.id);
    expect(engine.connectAccount).toHaveBeenCalledOnce();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mailbox.reconnected', accountId: account.id, actorUserId: OTHER }));
  });

  it('reconnect needs a managed link and the same address', async () => {
    const { rows: [manual] } = await state.db.query(`INSERT INTO email_accounts (name, email_address, imap_host, smtp_host, mail_provider, connection_mode)
      VALUES ('Manual', 'box@proton.me', 'imap.example.com', 'smtp.example.com', 'proton', 'manual') RETURNING id`);
    expect(await start({ reconnectAccountId: manual.id })).toMatchObject({ state: 'failed', errorCode: 'already_connected' });
    expect(await start()).toMatchObject({ state: 'failed', errorCode: 'already_connected' });
    const { account } = await seedLinkedAccount({ email: 'linked@proton.me' });
    expect(await start({ reconnectAccountId: account.id })).toMatchObject({ state: 'failed', errorCode: 'already_connected' });
    expect(await start({ email: 'free@proton.me', reconnectAccountId: account.id })).toMatchObject({ state: 'failed', errorCode: 'reconnect_unavailable' });
    expect(fake.logins).toBe(0);
  });

  it('reconnect_wrong_native_user_rejected', async () => {
    const { account } = await seedLinkedAccount();
    const started = await start({ reconnectAccountId: account.id }, other);
    fake.connect(started.id, OTHER_NATIVE, { createdByAttempt: true });
    await poll(started.id, other);
    expect(await getProtonConnection(started.id, other)).toEqual({ id: started.id, state: 'failed', errorCode: 'reconnect_mismatch' });
    expect(fake.paths(`/connections/${started.id}/cancel`)).toHaveLength(1);
    expect(fake.paths('/credentials')).toHaveLength(0);
    expect((await state.db.query('SELECT auth_pass FROM email_accounts')).rows[0].auth_pass).toBe('enc:old-bridge');
    expect(await count('proton_users', `proton_user_id = '${OTHER_NATIVE}'`)).toBe(0);
  });

  it('cancel_commit_race_reconciles_once: cancel during the probe wins', async () => {
    const probing = deferred();
    const released = deferred();
    probeConnection.mockImplementationOnce(async c => { probing.resolve(); await released.promise; return { imapLogin: c.auth_user, smtpLogin: c.smtp_auth_user }; });
    const started = await start();
    fake.connect(started.id, NATIVE);
    await getProtonConnection(started.id, owner);
    await probing.promise;
    expect(await getProtonConnection(started.id, owner)).toEqual({ id: started.id, state: 'checking' });
    expect(await cancelProtonConnection(started.id, owner)).toEqual({ id: started.id, state: 'cancelled' });
    released.resolve();
    await protonConnectionWork();
    expect(await getProtonConnection(started.id, owner)).toEqual({ id: started.id, state: 'cancelled' });
    expect(await count('email_accounts')).toBe(0);
    expect(fake.paths('/commit')).toHaveLength(0);
    expect(fake.paths('/cancel')).toHaveLength(1);
  });

  it.each([
    ['a cancel from another process', "state = 'cancelled'", { state: 'cancelled' }, 0],
    ['the TTL', "expires_at = now() - interval '1 second'", { state: 'expired' }, 1],
  ])('the commit transaction re-checks the operation: %s during the probe', async (_name, change, expected, workerCancels) => {
    const probing = deferred();
    const released = deferred();
    probeConnection.mockImplementationOnce(async c => { probing.resolve(); await released.promise; return { imapLogin: c.auth_user, smtpLogin: c.smtp_auth_user }; });
    const started = await start();
    fake.connect(started.id, NATIVE);
    await getProtonConnection(started.id, owner);
    await probing.promise;
    await state.db.query(`UPDATE proton_connections SET ${change} WHERE id = $1`, [started.id]);
    released.resolve();
    await protonConnectionWork();
    expect(await row(started.id)).toMatchObject(expected);
    expect(await count('email_accounts')).toBe(0);
    expect(await count('proton_mailbox_links')).toBe(0);
    expect(fake.paths('/commit')).toHaveLength(0);
    expect(fake.paths('/cancel')).toHaveLength(workerCancels);
  });

  it('cancel_commit_race_reconciles_once: cancel after the SQL commit keeps the mailbox', async () => {
    const gate = deferred();
    fake.commitGate = gate.promise;
    const started = await start();
    fake.connect(started.id, NATIVE);
    await getProtonConnection(started.id, owner);
    await vi.waitFor(() => expect(fake.paths('/commit')).toHaveLength(1));
    const cancelling = cancelProtonConnection(started.id, owner);
    gate.resolve();
    expect(await cancelling).toMatchObject({ id: started.id, state: 'connected' });
    await protonConnectionWork();
    expect(await count('email_accounts')).toBe(1);
    expect(fake.paths('/commit')).toHaveLength(1);
    expect(fake.paths('/cancel')).toHaveLength(0);
  });

  it('snapshot_waits_for_sql_commit_reconcile', async () => {
    const gate = deferred();
    fake.commitGate = gate.promise;
    const started = await start();
    fake.connect(started.id, NATIVE);
    await getProtonConnection(started.id, owner);
    await vi.waitFor(() => expect(fake.paths('/commit')).toHaveLength(1));
    expect((await row(started.id)).state).toBe('committing');
    let drained = false;
    const drain = closeCreationAdmission().then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(drained).toBe(false);
    expect(await start({ email: 'later@proton.me' })).toEqual({ error: 'proton_unavailable', code: 'proton_unavailable' });
    gate.resolve();
    await drain;
    expect((await row(started.id)).state).toBe('connected');
    expect(fake.logins).toBe(1);
  });

  it('bad_password with an unreachable Proton API is a connection failure', async () => {
    isProtonApiReachable.mockResolvedValueOnce(false);
    const offline = await start();
    fake.set(offline.id, { state: 'failed', errorCode: 'invalid_credentials' });
    expect(await poll(offline.id)).toEqual({ id: offline.id, state: 'failed', errorCode: 'connection' });

    isProtonApiReachable.mockResolvedValueOnce(true);
    const online = await start();
    fake.set(online.id, { state: 'failed', errorCode: 'invalid_credentials' });
    expect(await poll(online.id)).toEqual({ id: online.id, state: 'failed', errorCode: 'invalid_credentials' });
    expect(isProtonApiReachable).toHaveBeenCalledTimes(2);
  });

  it('challenge strictly matches the state and the secret is not kept', async () => {
    const started = await start();
    fake.set(started.id, { state: 'needs_2fa' });
    await poll(started.id);
    expect(await continueProtonConnection(started.id, { challenge: 'second_password', secret: 'x' }, owner)).toEqual({ error: 'invalid_challenge', code: 'invalid_challenge' });
    expect(fake.paths('/continue')).toHaveLength(0);
    expect(await continueProtonConnection(started.id, { challenge: '2fa', secret: '2fa-secret-sentinel' }, owner)).toEqual({ id: started.id, state: 'authenticating' });
    expect(fake.paths('/continue')[0].body).toEqual({ challenge: '2fa', secret: '2fa-secret-sentinel' });
    expect(await continueProtonConnection(started.id, { challenge: '2fa', secret: 'again' }, owner)).toMatchObject({ code: 'invalid_challenge' });
    expectNoSecrets(await row(started.id));
    fake.set(started.id, { state: 'needs_2fa', errorCode: 'invalid_challenge' });
    expect(await poll(started.id)).toEqual({ id: started.id, state: 'needs_2fa', errorCode: 'invalid_challenge' });
  });

  it('worker missing or busy gives safe codes and stores no mailbox', async () => {
    fake.busy = true;
    expect(await start()).toMatchObject({ state: 'failed', errorCode: 'login_busy' });
    fake.busy = false;
    fake.down = true;
    expect(await start()).toMatchObject({ state: 'failed', errorCode: 'proton_unavailable' });
    expect(await count('email_accounts')).toBe(0);
  });

  it('two employees connecting different Proton users do not touch each other', async () => {
    const a = await start({ email: 'a@proton.me' }, owner);
    const b = await start({ email: 'b@proton.me' }, other);
    fake.connect(a.id, NATIVE);
    probeConnection.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'smtp_auth_failed' }));
    await poll(a.id, owner);
    fake.connect(b.id, OTHER_NATIVE);
    await poll(b.id, other);
    expect(await getProtonConnection(a.id, owner)).toMatchObject({ state: 'failed', errorCode: 'smtp_auth_failed' });
    expect(await getProtonConnection(b.id, other)).toMatchObject({ state: 'connected', account: { email_address: 'b@proton.me' } });
    expect(fake.paths('/cancel').map(call => call.path)).toEqual([`/connections/${a.id}/cancel`]);
    expect((await state.db.query('SELECT proton_user_id FROM proton_mailbox_links')).rows).toEqual([{ proton_user_id: OTHER_NATIVE }]);
  });
});
