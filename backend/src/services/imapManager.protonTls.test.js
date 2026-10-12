import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import { imapFixture, imapNoStarttlsFixture, probeCertificate } from './accounts/connectionProbe.fixtures.js';
import { loopbackCertificate, workerFingerprint } from './proton/mailEndpoint.fixtures.js';

// Real ImapFlow handshakes against loopback fixtures: the managed Proton trust (Bridge's public
// certificate plus its 127.0.0.1 identity) applies only with an endpoint that came from a managed
// link, and an explicit STARTTLS mailbox never authenticates over plain text.
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));

const { makeClientCfg } = await import('./imapManager.js');
const { trustedProtonEndpoint } = await import('./proton/mailEndpoint.js');

let bridge;          // the certificate the managed link trusts
let impostor;        // same 127.0.0.1 identity, different key
let renamed;         // trusted bytes, wrong identity
let fixtures = [];

beforeAll(() => {
  bridge = loopbackCertificate();
  impostor = loopbackCertificate();
  renamed = loopbackCertificate({ cn: 'bridge.example', san: 'DNS:bridge.example' });
});
afterEach(async () => {
  await Promise.all(fixtures.map(fixture => fixture.close()));
  fixtures = [];
});

const managedAccount = {
  id: 'managed-proton', mail_provider: 'proton', connection_mode: 'managed', imap_tls_mode: 'implicit',
  // Whatever the row claims about its server, the managed endpoint decides where it connects.
  imap_host: 'imap.attacker.example', imap_port: 143, imap_tls: false, imap_skip_tls_verify: true,
  auth_user: 'box@proton.me', auth_pass: 'enc',
};
const manualAccount = {
  id: 'manual-loopback', mail_provider: 'proton', connection_mode: 'manual', imap_tls_mode: 'implicit',
  imap_host: '127.0.0.1', imap_port: 1993, imap_tls: true, imap_skip_tls_verify: false, auth_user: 'box@proton.me', auth_pass: 'enc',
};

function managedEndpoint(port) {
  const endpoint = trustedProtonEndpoint({ certificatePem: bridge.cert, certificateFingerprint: workerFingerprint(bridge.cert), tlsServername: '127.0.0.1' }, 'imap');
  return { ...endpoint, port };
}

async function server(certificate, mode = 'implicit') {
  const fixture = await imapFixture({ certificate, mode });
  fixtures.push(fixture);
  return fixture;
}

async function connect(cfg) {
  const client = new ImapFlow({ ...cfg, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000 });
  client.on('error', () => {});
  try {
    await client.connect();
    const authenticated = client.authenticated;
    await client.logout();
    return authenticated;
  } finally { client.close(); }
}

const authenticated = commands => commands.some(line => /\b(LOGIN|AUTHENTICATE)\b/i.test(line));

describe('managed Proton TLS trust', () => {
  it('all_proton_clients_verify_certificate_and_hostname', async () => {
    const trusted = await server(bridge);
    const cfg = makeClientCfg(managedAccount, managedEndpoint(trusted.endpoint.port), { policy: { allowInsecureTls: true } });
    expect(cfg).toMatchObject({ host: '127.0.0.1', port: trusted.endpoint.port, secure: true });
    expect(cfg.tls).toMatchObject({ rejectUnauthorized: true, ca: bridge.cert });
    expect(cfg.doSTARTTLS).toBeUndefined();
    await expect(connect(cfg)).resolves.toBeTruthy();

    // Another key with the same identity: rejected before any credential is sent.
    const fake = await server(impostor);
    await expect(connect(makeClientCfg(managedAccount, managedEndpoint(fake.endpoint.port), { policy: { allowInsecureTls: true } }))).rejects.toThrow();
    expect(authenticated(fake.commands)).toBe(false);

    // The trusted bytes under another name: hostname verification still rejects it.
    const misnamed = await server(renamed);
    const endpoint = managedEndpoint(misnamed.endpoint.port);
    await expect(connect(makeClientCfg(managedAccount, { ...endpoint, tls: { ...endpoint.tls, ca: renamed.cert } }))).rejects.toThrow();
    expect(authenticated(misnamed.commands)).toBe(false);
  });

  it('managed_link_is_required_for_loopback_exception', async () => {
    // A managed row without its trusted endpoint (no link) never falls back to the row's own server.
    expect(() => makeClientCfg(managedAccount, { host: '127.0.0.1', servername: null })).toThrow(expect.objectContaining({ code: 'proton_link_missing' }));
    // A trusted endpoint handed to an ordinary row is refused too.
    expect(() => makeClientCfg(manualAccount, managedEndpoint(1993))).toThrow(expect.objectContaining({ code: 'proton_link_missing' }));
  });

  it('forged_mail_provider_has_no_private_access', async () => {
    // An ordinary row on 127.0.0.1 gets no CA from any link: Bridge's certificate is not trusted.
    const trusted = await server(bridge);
    const cfg = makeClientCfg({ ...manualAccount, imap_port: trusted.endpoint.port }, { host: '127.0.0.1', servername: null }, { policy: { allowPrivateHosts: true } });
    expect(cfg.tls.ca).toBeUndefined();
    await expect(connect(cfg)).rejects.toThrow();
    expect(authenticated(trusted.commands)).toBe(false);
  });
});

describe('explicit IMAP TLS mode', () => {
  const resolved = { host: '127.0.0.1', servername: null };
  const starttls = { ...manualAccount, mail_provider: 'other', imap_tls_mode: 'starttls', imap_port: 143, imap_tls: false, imap_skip_tls_verify: true };

  it('explicit_starttls_is_forced_in_every_imap_client', async () => {
    for (const policy of [{}, { allowInsecureTls: false }, { allowInsecureTls: true }]) {
      const cfg = makeClientCfg(starttls, resolved, { policy });
      expect(cfg).toMatchObject({ secure: false, doSTARTTLS: true, port: 143 });
      expect(cfg.tls.rejectUnauthorized).toBe(true);
    }
    const implicit = makeClientCfg({ ...starttls, imap_tls_mode: 'implicit', imap_port: 993 }, resolved, { policy: { allowInsecureTls: true } });
    expect(implicit).toMatchObject({ secure: true, port: 993 });
    expect(implicit.doSTARTTLS).toBeUndefined();
    expect(implicit.tls.rejectUnauthorized).toBe(true);
    expect(() => makeClientCfg({ ...starttls, imap_tls_mode: 'plaintext' }, resolved)).toThrow();

    // A server that strips STARTTLS never receives the login.
    const stripped = await imapNoStarttlsFixture();
    fixtures.push(stripped);
    await expect(connect(makeClientCfg({ ...starttls, imap_port: stripped.endpoint.port }, resolved, { policy: { allowInsecureTls: true } }))).rejects.toThrow();
    expect(authenticated(stripped.commands)).toBe(false);

    // A real upgrade still verifies the certificate: untrusted -> refused before the login.
    const upgrade = await server(probeCertificate(), 'starttls');
    await expect(connect(makeClientCfg({ ...starttls, imap_port: upgrade.endpoint.port }, resolved, { policy: { allowInsecureTls: true } }))).rejects.toThrow();
    expect(authenticated(upgrade.commands)).toBe(false);
  });

  it('every IMAP connection path builds its client through makeClientCfg and resolveMailEndpoint', () => {
    const source = readFileSync(new URL('./imapManager.js', import.meta.url), 'utf8');
    expect(source.match(/new ImapFlow\(/g)).toHaveLength(1);
    expect(source).toContain('new ImapFlow(makeClientCfg(account, res, cfgOpts))');
    expect(source).not.toMatch(/resolveForConnection\(/);
    expect(source).toMatch(/resolveMailEndpoint\(account, 'imap'\)/);
  });

  it('legacy_null_mode_preserves_behavior', () => {
    const legacy = { ...manualAccount, mail_provider: null, imap_tls_mode: null, imap_port: 143, imap_tls: false, imap_skip_tls_verify: true };
    expect(() => makeClientCfg(legacy, resolved, { policy: { allowInsecureTls: false } })).toThrow(/Plain-text IMAP is not allowed/);
    const insecure = makeClientCfg(legacy, resolved, { policy: { allowInsecureTls: true } });
    expect(insecure).toMatchObject({ secure: false, port: 143 });
    expect(insecure.doSTARTTLS).toBeUndefined();
    expect(insecure.tls.rejectUnauthorized).toBe(false);
    const tlsLegacy = makeClientCfg({ ...legacy, imap_tls: true, imap_port: 993 }, resolved, { policy: { allowInsecureTls: false } });
    expect(tlsLegacy).toMatchObject({ secure: true, port: 993 });
    expect(tlsLegacy.tls.rejectUnauthorized).toBe(true);
  });
});
