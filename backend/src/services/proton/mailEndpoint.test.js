import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';
import { loopbackCertificate, workerFingerprint } from './mailEndpoint.fixtures.js';

// The real schema answers every query, so link, generation and operation rules are the database's.
const holder = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({ query: (text, params) => holder.db.query(text, params) }));
vi.mock('./workerClient.js', () => ({ callWorker: vi.fn() }));
vi.mock('../accounts/connectionProbe.js', () => ({ probeConnection: vi.fn() }));

const { callWorker } = await import('./workerClient.js');
const { probeConnection } = await import('../accounts/connectionProbe.js');
const { resolveProtonEndpoint, probeManagedProtonConnection, MANAGED_PROTON_ENDPOINT } = await import('./mailEndpoint.js');

const ACTOR = '10000000-0000-4000-8000-000000000001';
const LINKED = '20000000-0000-4000-8000-000000000001';
const UNLINKED = '20000000-0000-4000-8000-000000000002';
const RELABELED = '20000000-0000-4000-8000-000000000003';
const GENERATION = '30000000-0000-4000-8000-000000000001';
const OPERATION = '40000000-0000-4000-8000-000000000001';
const NATIVE_USER = 'native-user-1';
const OTHER_NATIVE_USER = 'native-user-2';

let publicCertificate;
let fingerprint;

beforeAll(async () => {
  publicCertificate = loopbackCertificate().cert;
  fingerprint = workerFingerprint(publicCertificate);
  holder.db = await createRealSchemaDb();
  await holder.db.query(`INSERT INTO users (id, username, password_hash) VALUES ($1, 'employee', 'fixture')`, [ACTOR]);
  await holder.db.query(`INSERT INTO proton_users (proton_user_id, generation) VALUES ($1, $2), ($3, gen_random_uuid())`, [NATIVE_USER, GENERATION, OTHER_NATIVE_USER]);
  // The stored host and port are deliberately elsewhere: a managed endpoint never reads them.
  await holder.db.query(`INSERT INTO email_accounts (id, name, email_address, imap_host, imap_port, smtp_host, smtp_port, mail_provider, connection_mode, imap_tls_mode)
    VALUES ($1, 'Linked', 'linked@proton.me', '203.0.113.9', 993, '203.0.113.9', 587, 'proton', 'managed', 'implicit'),
           ($2, 'Unlinked', 'unlinked@proton.me', '127.0.0.1', 1993, '127.0.0.1', 1465, 'proton', 'managed', 'implicit'),
           ($3, 'Relabeled', 'relabeled@proton.me', '127.0.0.1', 1993, '127.0.0.1', 1465, 'proton', 'manual', 'implicit')`,
  [LINKED, UNLINKED, RELABELED]);
  for (const account of [LINKED, RELABELED]) {
    await holder.db.query(`INSERT INTO proton_mailbox_links (account_id, proton_user_id, generation, certificate_pem, certificate_fingerprint, tls_servername)
      VALUES ($1, $2, $3, $4, $5, '127.0.0.1')`, [account, NATIVE_USER, GENERATION, publicCertificate, fingerprint]);
  }
});
afterAll(async () => { await holder.db?.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  await holder.db.query('DELETE FROM proton_connections');
});

function credentials(overrides = {}) {
  return {
    userId: NATIVE_USER, email: 'box@proton.me', bridgePassword: 'bridge-secret-sentinel',
    certificatePem: publicCertificate, certificateFingerprint: fingerprint, tlsServername: '127.0.0.1', ...overrides,
  };
}

async function operation({ state = 'checking', userId = NATIVE_USER, email = 'Box@Proton.me', expired = false } = {}) {
  await holder.db.query(`INSERT INTO proton_connections (id, actor_user_id, request_id, requested_email, state, proton_user_id, expires_at)
    VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, NOW() + ($6 || ' minutes')::interval)`,
  [OPERATION, ACTOR, email, state, userId, expired ? '-1' : '10']);
}

describe('resolveProtonEndpoint', () => {
  it('managed_link_is_required_for_loopback_exception', async () => {
    const endpoint = await resolveProtonEndpoint(LINKED, 'imap');
    expect(endpoint.port).toBe(1993);
    expect(endpoint.tls.rejectUnauthorized).toBe(true);
    expect(endpoint.tls.ca).toBe(publicCertificate);
    expect(endpoint).toMatchObject({ host: '127.0.0.1', addresses: ['127.0.0.1'], secure: true, requireTLS: false, imapTlsMode: 'implicit' });
    expect(endpoint[MANAGED_PROTON_ENDPOINT]).toBe(true);
    const smtp = await resolveProtonEndpoint(LINKED, 'smtp');
    expect(smtp.port).toBe(1465);
    expect(smtp.tls).toMatchObject({ rejectUnauthorized: true, ca: publicCertificate });

    await expect(resolveProtonEndpoint(UNLINKED, 'imap')).rejects.toMatchObject({ code: 'proton_link_missing' });
    // A link row behind an account that is not a managed Proton mailbox grants nothing.
    await expect(resolveProtonEndpoint(RELABELED, 'imap')).rejects.toMatchObject({ code: 'proton_link_missing' });
    await expect(resolveProtonEndpoint('20000000-0000-4000-8000-0000000000ff', 'smtp')).rejects.toMatchObject({ code: 'proton_link_missing' });
  });

  it('all_proton_clients_verify_certificate_and_hostname', async () => {
    const endpoint = await resolveProtonEndpoint(LINKED, 'imap');
    // An IP identity is verified against the connected host, never sent as SNI (RFC 6066).
    expect(endpoint.servername).toBeNull();
    expect(endpoint.tls.servername).toBeUndefined();
    const looked = await new Promise(resolve => endpoint.lookup('bridge.attacker.example', {}, (_err, address) => resolve(address)));
    expect(looked).toBe('127.0.0.1');

    // A stored certificate whose fingerprint or identity does not match is refused, not trusted.
    const other = loopbackCertificate({ cn: 'bridge.example', san: 'DNS:bridge.example' }).cert;
    await holder.db.query('UPDATE proton_mailbox_links SET certificate_fingerprint = $1 WHERE account_id = $2', ['0'.repeat(64), LINKED]);
    await expect(resolveProtonEndpoint(LINKED, 'imap')).rejects.toMatchObject({ code: 'proton_certificate_invalid' });
    await holder.db.query('UPDATE proton_mailbox_links SET certificate_pem = $1, certificate_fingerprint = $2 WHERE account_id = $3', [other, workerFingerprint(other), LINKED]);
    await expect(resolveProtonEndpoint(LINKED, 'imap')).rejects.toMatchObject({ code: 'proton_certificate_invalid' });
    await holder.db.query('UPDATE proton_mailbox_links SET certificate_pem = $1, certificate_fingerprint = $2 WHERE account_id = $3', [publicCertificate, fingerprint, LINKED]);
    await holder.db.query(`UPDATE proton_mailbox_links SET tls_servername = '127.0.0.2' WHERE account_id = $1`, [LINKED]);
    await expect(resolveProtonEndpoint(LINKED, 'imap')).rejects.toMatchObject({ code: 'proton_certificate_invalid' });
    await holder.db.query(`UPDATE proton_mailbox_links SET tls_servername = '127.0.0.1' WHERE account_id = $1`, [LINKED]);
  });
});

describe('probeManagedProtonConnection', () => {
  it('pending_operation_can_probe_only_its_verified_native_user', async () => {
    await operation();
    callWorker.mockResolvedValue(credentials());
    probeConnection.mockResolvedValue({ imapLogin: 'box@proton.me', smtpLogin: 'box@proton.me' });
    const signal = new AbortController().signal;

    await expect(probeManagedProtonConnection(OPERATION, { signal })).resolves.toEqual({ imapLogin: 'box@proton.me', smtpLogin: 'box@proton.me' });
    expect(callWorker).toHaveBeenCalledWith('POST', `/users/${NATIVE_USER}/credentials`, { operationId: OPERATION }, expect.objectContaining({ signal }));
    const [candidate, options] = probeConnection.mock.calls[0];
    expect(candidate).toMatchObject({
      email_address: 'box@proton.me', imap_host: '127.0.0.1', imap_port: 1993, imap_tls_mode: 'implicit',
      smtp_host: '127.0.0.1', smtp_port: 1465, smtp_tls: 'SSL', auth_user: 'box@proton.me', auth_pass: 'bridge-secret-sentinel', explicitLogin: true,
    });
    expect(options.signal).toBe(signal);
    // The trusted resolver ignores whatever host/port a candidate claims.
    const forged = { ...candidate, imap_host: '10.0.0.5', imap_port: 143, smtp_host: '10.0.0.5', smtp_port: 25 };
    const imap = await options.resolveEndpoint(forged, 'imap', { signal });
    expect(imap).toMatchObject({ host: '127.0.0.1', port: 1993, secure: true, tls: { rejectUnauthorized: true, ca: publicCertificate } });
    expect((await options.resolveEndpoint(forged, 'smtp', { signal })).port).toBe(1465);

    for (const [returned, code] of [
      [credentials({ userId: OTHER_NATIVE_USER }), 'proton_identity_mismatch'],
      [credentials({ email: 'someone-else@proton.me' }), 'proton_identity_mismatch'],
      [credentials({ bridgePassword: '' }), 'proton_identity_mismatch'],
      [credentials({ certificateFingerprint: 'f'.repeat(64) }), 'proton_certificate_invalid'],
      [credentials({ certificatePem: `${publicCertificate}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n` }), 'proton_certificate_invalid'],
    ]) {
      probeConnection.mockClear();
      callWorker.mockResolvedValueOnce(returned);
      await expect(probeManagedProtonConnection(OPERATION)).rejects.toMatchObject({ code });
      expect(probeConnection).not.toHaveBeenCalled();
    }

    // Only an operation in the checking state, unexpired and bound to a native user may ask.
    for (const shape of [{ state: 'authenticating' }, { state: 'connected' }, { userId: null }, { expired: true }]) {
      await holder.db.query('DELETE FROM proton_connections');
      await operation(shape);
      callWorker.mockClear();
      await expect(probeManagedProtonConnection(OPERATION)).rejects.toMatchObject({ code: 'proton_operation_invalid' });
      expect(callWorker).not.toHaveBeenCalled();
    }
    await expect(probeManagedProtonConnection('not-a-uuid')).rejects.toMatchObject({ code: 'proton_operation_invalid' });
  });

  it('keeps secrets out of its errors', async () => {
    await operation();
    callWorker.mockResolvedValue(credentials({ userId: OTHER_NATIVE_USER }));
    const error = await probeManagedProtonConnection(OPERATION).catch(err => err);
    expect(JSON.stringify(error)).not.toContain('secret-sentinel');
    expect(String(error.message)).not.toContain('secret-sentinel');
  });
});
