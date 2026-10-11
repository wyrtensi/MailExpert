import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loopbackCertificate, workerFingerprint } from './mailEndpoint.fixtures.js';
import { createRealSchemaDb } from '../testing/realSchema.js';

// The real schema answers every query; the worker and the mail engine are fakes. A pass asks the
// worker for each committed link's credentials ({generation, email}) and only acts on change.
const state = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({
  query: (sql, p) => state.db.query(sql, p),
  pool: { connect: async () => ({ query: (sql, p) => state.db.query(sql, p), release() {} }) },
}));
vi.mock('./workerClient.js', () => ({ callWorker: vi.fn() }));
vi.mock('../encryption.js', () => ({ encrypt: v => (v ? `enc:${v}` : null), decrypt: v => String(v).replace(/^enc:/, '') }));
vi.mock('../accounts/connection.js', async original => ({ ...(await original()), reconnectAccount: vi.fn(async () => true) }));

const { callWorker } = await import('./workerClient.js');
const { reconnectAccount } = await import('../accounts/connection.js');
const { resolveProtonEndpoint } = await import('./mailEndpoint.js');
const {
  reconcileProtonLinks, protonLinkStatus, clearProtonLinkStatus, setProtonReconcileEngine,
} = await import('./reconcile.js');

const NATIVE = 'bmF0aXZlLXVzZXI=';
const OTHER_NATIVE = 'b3RoZXItdXNlcg==';
const OLD = loopbackCertificate().cert;
const NEW = loopbackCertificate().cert;
const engine = { broadcast: vi.fn(), disconnectAccount: vi.fn(async () => {}), connectAccount: vi.fn(async () => true), clearConnectCooldown: vi.fn() };

const failure = code => Object.assign(new Error(code), { code });
// Bridge as the worker exposes it: credentials per (native user, address) of the current generation.
let bridge;
function material(userId, email, { pem = OLD, password = 'bridge-old' } = {}) {
  return { userId, email, bridgePassword: password, certificatePem: pem, certificateFingerprint: workerFingerprint(pem), tlsServername: '127.0.0.1' };
}
async function worker(method, path, body) {
  bridge.calls.push({ method, path, body });
  if (bridge.down) throw failure('worker_unavailable');
  const match = /^\/users\/([^/]+)\/credentials$/.exec(path);
  if (method !== 'POST' || !match || body?.operationId !== undefined) throw failure('worker_invalid_request');
  const user = bridge.users.get(match[1]);
  if (!user) throw failure('not_found');
  if (user.generation !== body.generation) throw failure('generation_mismatch');
  const address = user.addresses.get(body.email);
  if (!address) throw failure('address_mismatch');
  return typeof address === 'function' ? address() : address;
}

async function seed({ email, userId = NATIVE, pem = OLD, password = 'bridge-old', bridgeAddress = material(userId, email, { pem, password }) }) {
  await state.db.query('INSERT INTO proton_users (proton_user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  const { rows: [{ generation }] } = await state.db.query('SELECT generation FROM proton_users WHERE proton_user_id = $1', [userId]);
  const { rows: [account] } = await state.db.query(
    `INSERT INTO email_accounts (name, email_address, imap_host, imap_port, smtp_host, smtp_port, auth_user, auth_pass, smtp_auth_user, smtp_auth_pass,
       mail_provider, connection_mode, imap_tls_mode)
     VALUES ('Team', $1, '127.0.0.1', 1993, '127.0.0.1', 1465, $1, $2, $1, $2, 'proton', 'managed', 'implicit') RETURNING *`,
    [email, `enc:${password}`],
  );
  await state.db.query(
    `INSERT INTO proton_mailbox_links (account_id, proton_user_id, generation, certificate_pem, certificate_fingerprint, tls_servername)
     VALUES ($1, $2, $3, $4, $5, '127.0.0.1')`, [account.id, userId, generation, pem, workerFingerprint(pem)],
  );
  if (!bridge.users.has(userId)) bridge.users.set(userId, { generation, addresses: new Map() });
  bridge.users.get(userId).addresses.set(email, bridgeAddress);
  return { account, generation };
}
const link = async id => (await state.db.query('SELECT * FROM proton_mailbox_links WHERE account_id = $1', [id])).rows[0];
const account = async id => (await state.db.query('SELECT * FROM email_accounts WHERE id = $1', [id])).rows[0];
const plainAccount = async () => (await state.db.query(
  `INSERT INTO email_accounts (name, email_address, imap_host, smtp_host, auth_user, auth_pass)
   VALUES ('Plain', 'plain@example.com', 'imap.example.com', 'smtp.example.com', 'plain@example.com', 'enc:plain') RETURNING *`,
)).rows[0];

beforeAll(async () => {
  state.db = await createRealSchemaDb();
  setProtonReconcileEngine(engine);
});
afterAll(async () => { await state.db.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await state.db.exec('DELETE FROM proton_connections; DELETE FROM proton_mailbox_links; DELETE FROM email_accounts; DELETE FROM proton_users;');
  bridge = { users: new Map(), calls: [], down: false };
  callWorker.mockImplementation(worker);
});

describe('reconcileProtonLinks', () => {
  it('certificate_rotation_reconnects_only_changed_links', async () => {
    const { account: changed } = await seed({ email: 'first@proton.me' });
    const { account: sibling } = await seed({ email: 'second@proton.me' });
    const { account: neighbour } = await seed({ email: 'third@proton.me', userId: OTHER_NATIVE });
    const plain = await plainAccount();
    bridge.users.get(NATIVE).addresses.set('first@proton.me', material(NATIVE, 'first@proton.me', { pem: NEW, password: 'bridge-new' }));

    const result = await reconcileProtonLinks();

    expect(result).toEqual({ changed: [changed.id], reconnectRequired: [] });
    const changedAccountId = changed.id;
    expect(reconnectAccount.mock.calls.map(([, id]) => id)).toEqual([changedAccountId]);
    expect(reconnectAccount.mock.calls[0][0]).toBe(engine);
    // Trust and the password move together; the neighbours keep theirs.
    expect(await link(changed.id)).toMatchObject({ certificate_pem: NEW, certificate_fingerprint: workerFingerprint(NEW) });
    expect(await account(changed.id)).toMatchObject({ auth_pass: 'enc:bridge-new', smtp_auth_pass: 'enc:bridge-new' });
    for (const id of [sibling.id, neighbour.id]) {
      expect(await link(id)).toMatchObject({ certificate_pem: OLD });
      expect(await account(id)).toMatchObject({ auth_pass: 'enc:bridge-old' });
    }
    expect(await account(plain.id)).toMatchObject({ auth_pass: 'enc:plain' });
    // Only committed links are asked about, by generation and address, never by operation.
    expect(bridge.calls.map(call => call.body)).toEqual(expect.arrayContaining([
      { generation: expect.any(String), email: 'first@proton.me' },
    ]));
    expect(bridge.calls).toHaveLength(3);
    // The new certificate is the one the engine now trusts.
    expect((await resolveProtonEndpoint(changed.id, 'imap')).tls).toEqual({ rejectUnauthorized: true, ca: NEW });

    // A second pass with nothing new does nothing.
    reconnectAccount.mockClear();
    expect(await reconcileProtonLinks()).toEqual({ changed: [], reconnectRequired: [] });
    expect(reconnectAccount).not.toHaveBeenCalled();
  });

  it('a new Bridge password alone is stored and reconnects that mailbox', async () => {
    const { account: changed } = await seed({ email: 'first@proton.me' });
    await seed({ email: 'second@proton.me' });
    bridge.users.get(NATIVE).addresses.set('first@proton.me', material(NATIVE, 'first@proton.me', { password: 'bridge-new' }));

    expect(await reconcileProtonLinks()).toEqual({ changed: [changed.id], reconnectRequired: [] });
    expect(await account(changed.id)).toMatchObject({ auth_pass: 'enc:bridge-new', smtp_auth_pass: 'enc:bridge-new' });
    expect(reconnectAccount.mock.calls.map(([, id]) => id)).toEqual([changed.id]);
  });

  it('never stores worker material that fails the trust checks or names another identity', async () => {
    const { account: forged } = await seed({ email: 'first@proton.me' });
    const { account: foreign } = await seed({ email: 'second@proton.me' });
    // An old fingerprint presented with a new certificate, and another native user's answer.
    bridge.users.get(NATIVE).addresses.set('first@proton.me', { ...material(NATIVE, 'first@proton.me', { pem: NEW, password: 'bridge-new' }), certificateFingerprint: workerFingerprint(OLD) });
    bridge.users.get(NATIVE).addresses.set('second@proton.me', material(OTHER_NATIVE, 'second@proton.me', { pem: NEW, password: 'bridge-new' }));

    expect(await reconcileProtonLinks()).toEqual({ changed: [], reconnectRequired: [] });
    for (const id of [forged.id, foreign.id]) {
      expect(await link(id)).toMatchObject({ certificate_pem: OLD, certificate_fingerprint: workerFingerprint(OLD) });
      expect(await account(id)).toMatchObject({ auth_pass: 'enc:bridge-old' });
      expect(protonLinkStatus(id)).toEqual({ code: 'proton_unavailable' });
    }
    expect(reconnectAccount).not.toHaveBeenCalled();
  });

  it('does not overwrite a link that changed while the worker answered', async () => {
    const { account: raced } = await seed({ email: 'first@proton.me' });
    // A Task 5 reconnect commits fresher material between the read and the write of this pass.
    bridge.users.get(NATIVE).addresses.set('first@proton.me', async () => {
      await state.db.query(`UPDATE email_accounts SET auth_pass = 'enc:bridge-reconnected', smtp_auth_pass = 'enc:bridge-reconnected' WHERE id = $1`, [raced.id]);
      return material(NATIVE, 'first@proton.me', { pem: NEW, password: 'bridge-stale' });
    });

    const result = await reconcileProtonLinks();

    expect(result.changed).toEqual([]);
    expect(await account(raced.id)).toMatchObject({ auth_pass: 'enc:bridge-reconnected' });
    expect(reconnectAccount).not.toHaveBeenCalled();
  });

  it('lost_state_requires_login_without_breaking_other_providers', async () => {
    const { account: lost } = await seed({ email: 'first@proton.me' });
    const { account: neighbour } = await seed({ email: 'third@proton.me', userId: OTHER_NATIVE });
    const plain = await plainAccount();
    // Bridge no longer holds the native user (state lost, restored from an older backup).
    bridge.users.delete(NATIVE);

    const result = await reconcileProtonLinks();

    expect(result).toEqual({ changed: [], reconnectRequired: [lost.id] });
    const unavailableStatus = protonLinkStatus(lost.id);
    expect(unavailableStatus.code).toBe('proton_reconnect_required');
    expect(protonLinkStatus(neighbour.id)).toBeNull();
    expect(protonLinkStatus(plain.id)).toBeNull();
    // Nothing is deleted or disconnected; the mailbox waits for a new sign-in by any employee.
    expect(await link(lost.id)).toMatchObject({ certificate_pem: OLD });
    expect(await account(lost.id)).toMatchObject({ auth_pass: 'enc:bridge-old' });
    expect(engine.disconnectAccount).not.toHaveBeenCalled();
    expect(reconnectAccount).not.toHaveBeenCalled();
    expect(engine.broadcast).toHaveBeenCalledWith({ type: 'account_error', accountId: lost.id, error: 'proton_reconnect_required' });
    expect(engine.broadcast).toHaveBeenCalledTimes(1);

    // A worker that does not answer is a temporary outage, never a lost session and never a
    // reason to reach the mailbox another way.
    bridge.down = true;
    expect(await reconcileProtonLinks()).toEqual({ changed: [], reconnectRequired: [lost.id] });
    expect(protonLinkStatus(lost.id)).toEqual({ code: 'proton_reconnect_required' });
    expect(protonLinkStatus(neighbour.id)).toEqual({ code: 'proton_unavailable' });
    const endpoint = await resolveProtonEndpoint(neighbour.id, 'imap');
    expect(endpoint).toMatchObject({ host: '127.0.0.1', port: 1993, tls: { rejectUnauthorized: true, ca: OLD } });
    expect(await account(neighbour.id)).toMatchObject({ auth_pass: 'enc:bridge-old' });

    // The session is back (a new sign-in or a restored state): the flag clears and the mailbox
    // reconnects; the neighbour recovers without a reconnect of its own.
    bridge.down = false;
    const { rows: [{ generation }] } = await state.db.query('SELECT generation FROM proton_users WHERE proton_user_id = $1', [NATIVE]);
    bridge.users.set(NATIVE, { generation, addresses: new Map([['first@proton.me', material(NATIVE, 'first@proton.me')]]) });
    expect(await reconcileProtonLinks()).toEqual({ changed: [], reconnectRequired: [] });
    expect(protonLinkStatus(lost.id)).toBeNull();
    expect(protonLinkStatus(neighbour.id)).toBeNull();
    expect(reconnectAccount.mock.calls.map(([, id]) => id)).toEqual([lost.id]);
  });

  it('a worker that holds another generation of the native user needs a new sign-in', async () => {
    const { account: stale } = await seed({ email: 'first@proton.me' });
    bridge.users.get(NATIVE).generation = '00000000-0000-4000-8000-0000000000ff';

    expect(await reconcileProtonLinks()).toEqual({ changed: [], reconnectRequired: [stale.id] });
    expect(await link(stale.id)).toMatchObject({ certificate_pem: OLD });
  });

  it('leaves a link alone while a connection attempt for its mailbox is in flight', async () => {
    // The SQL commit of an attempt lands before the worker records the link: until then the worker
    // answers for the old material (reconnect) or for nothing (new mailbox).
    const { rows: [actor] } = await state.db.query(`INSERT INTO users (username) VALUES ('employee') RETURNING id`);
    const { account: added } = await seed({ email: 'first@proton.me' });
    const { account: reconnecting } = await seed({ email: 'second@proton.me' });
    const { account: settled } = await seed({ email: 'third@proton.me', userId: OTHER_NATIVE });
    await state.db.query(
      `INSERT INTO proton_connections (actor_user_id, request_id, requested_email, proton_user_id, state, account_id)
       VALUES ($1, gen_random_uuid(), 'first@proton.me', $2, 'committing', $3)`, [actor.id, NATIVE, added.id]);
    await state.db.query(
      `INSERT INTO proton_connections (actor_user_id, request_id, requested_email, state, reconnect_intent, reconnect_account_id)
       VALUES ($1, gen_random_uuid(), 'second@proton.me', 'authenticating', true, $2)`, [actor.id, reconnecting.id]);
    // A finished attempt does not hold its mailbox back.
    await state.db.query(
      `INSERT INTO proton_connections (actor_user_id, request_id, requested_email, state, account_id)
       VALUES ($1, gen_random_uuid(), 'third@proton.me', 'connected', $2)`, [actor.id, settled.id]);
    bridge.users.delete(NATIVE);

    expect(await reconcileProtonLinks()).toEqual({ changed: [], reconnectRequired: [] });
    expect(bridge.calls.map(call => call.body.email)).toEqual(['third@proton.me']);
    for (const id of [added.id, reconnecting.id]) expect(protonLinkStatus(id)).toBeNull();
    expect(engine.broadcast).not.toHaveBeenCalled();
    expect(reconnectAccount).not.toHaveBeenCalled();
    await state.db.query('DELETE FROM proton_connections');
    await state.db.query('DELETE FROM users WHERE id = $1', [actor.id]);
  });

  it('keeps the known status of a mailbox while its new sign-in runs', async () => {
    const { rows: [actor] } = await state.db.query(`INSERT INTO users (username) VALUES ('employee-2') RETURNING id`);
    const { account: lost } = await seed({ email: 'first@proton.me' });
    bridge.users.delete(NATIVE);
    await reconcileProtonLinks();
    expect(protonLinkStatus(lost.id)).toEqual({ code: 'proton_reconnect_required' });
    await state.db.query(
      `INSERT INTO proton_connections (actor_user_id, request_id, requested_email, state, reconnect_intent, reconnect_account_id)
       VALUES ($1, gen_random_uuid(), 'first@proton.me', 'needs_2fa', true, $2)`, [actor.id, lost.id]);
    bridge.calls = [];
    expect(await reconcileProtonLinks()).toEqual({ changed: [], reconnectRequired: [lost.id] });
    expect(bridge.calls).toEqual([]);
    expect(protonLinkStatus(lost.id)).toEqual({ code: 'proton_reconnect_required' });
    await state.db.query('DELETE FROM proton_connections');
    await state.db.query('DELETE FROM users WHERE id = $1', [actor.id]);
  });

  it('a native user being removed is left to its cleanup', async () => {
    const { account: removing } = await seed({ email: 'first@proton.me' });
    await state.db.query(`UPDATE proton_users SET removal_state = 'removing' WHERE proton_user_id = $1`, [NATIVE]);
    bridge.users.get(NATIVE).addresses.set('first@proton.me', material(NATIVE, 'first@proton.me', { pem: NEW, password: 'bridge-new' }));

    expect(await reconcileProtonLinks()).toEqual({ changed: [], reconnectRequired: [] });
    expect(bridge.calls).toEqual([]);
    expect(await link(removing.id)).toMatchObject({ certificate_pem: OLD });
  });

  it('an aborted pass stops asking and keeps what it knew', async () => {
    await seed({ email: 'first@proton.me' });
    const controller = new AbortController();
    controller.abort();
    expect(await reconcileProtonLinks({ signal: controller.signal })).toEqual({ changed: [], reconnectRequired: [] });
    expect(bridge.calls).toEqual([]);
  });

  it('a successful reconnect clears the flag at once', async () => {
    const { account: lost } = await seed({ email: 'first@proton.me' });
    bridge.users.delete(NATIVE);
    await reconcileProtonLinks();
    expect(protonLinkStatus(lost.id)).toEqual({ code: 'proton_reconnect_required' });
    clearProtonLinkStatus(lost.id);
    expect(protonLinkStatus(lost.id)).toBeNull();
  });
});
