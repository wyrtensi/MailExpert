import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const children = vi.hoisted(() => []);
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal();
  return { ...original, fork: vi.fn((...args) => { const child = original.fork(...args); children.push(child); return child; }) };
});
vi.mock('../connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
import { fork } from 'node:child_process';
import { probeSmtpInChild } from './smtpProbeProcess.js';
import { probeConnection } from './connectionProbe.js';
import { smtpFixture, probeCertificate, imapNoStarttlsFixture, imapFixture } from './connectionProbe.fixtures.js';

const candidate = { email_address: 'user@example.com', auth_user: 'user@example.com', auth_pass: 'secret-sentinel', smtp_auth_user: 'smtp@example.com', smtp_auth_pass: 'secret-sentinel', imap_host: 'imap.example.com', imap_port: 143, imap_tls_mode: 'starttls', smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS' };
let certificate;
const fixtures = [];
beforeAll(() => { certificate = probeCertificate(); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  vi.clearAllMocks();
});
afterAll(() => vi.restoreAllMocks());
const fixture = async options => { const result = await smtpFixture({ certificate, ...options }); fixtures.push(result); return result; };
const expectReaped = async server => {
  expect(children.length).toBeGreaterThan(0);
  for (const child of children) {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(() => process.kill(child.pid, 0)).toThrow();
  }
  await vi.waitFor(() => expect(server.sockets.size).toBe(0));
};

describe('SMTP probe with a real isolated child and socket', () => {
  it('authenticates and verifies without MAIL FROM, RCPT TO or DATA; reaps success even with stalled QUIT', async () => {
    const server = await fixture({ stallQuit: true });
    await probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 10000 });
    expect(server.commands.some(command => /^AUTH PLAIN /.test(command))).toBe(true);
    expect(server.commands.some(command => /^(MAIL FROM|RCPT TO|DATA)\b/.test(command))).toBe(false);
    expect(server.servernames).toEqual(['mail.example.com']);
    await expectReaped(server);
  });

  it('smtp_force_auth_requires_auth when the server omits AUTH', async () => {
    const server = await fixture({ advertiseAuth: false });
    await expect(probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 10000 })).rejects.toMatchObject({ code: 'smtp_auth_failed', protocol: 'smtp' });
    expect(server.commands.some(command => /^AUTH/.test(command))).toBe(true);
    await expectReaped(server);
  });

  it('bounds a real stalled greeting and closes the socket before returning timeout', async () => {
    const server = await fixture({ stall: true });
    const result = probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 10000 });
    const rejection = expect(result).rejects.toMatchObject({ code: 'connection_timeout', protocol: 'smtp' });
    await server.ready;
    await rejection;
    await expectReaped(server);
  });

  it('stalled_child_is_reaped_on_abort', async () => {
    const server = await fixture({ stall: true });
    const controller = new AbortController();
    const result = probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 20000, signal: controller.signal });
    const rejection = expect(result).rejects.toMatchObject({ code: 'connection_cancelled', protocol: 'smtp' });
    await server.ready;
    controller.abort(new Error('secret-sentinel'));
    await rejection;
    await expectReaped(server);
  });

  it('SMTP starttls_cannot_downgrade when STARTTLS is stripped', async () => {
    const server = await fixture({ mode: 'plain' });
    await expect(probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 10000 })).rejects.toMatchObject({ code: 'tls_error', protocol: 'smtp' });
    expect(server.commands.some(command => /^AUTH/.test(command))).toBe(false);
    await expectReaped(server);
  });

  it('upgrades STARTTLS with trusted CA and preserved SNI before AUTH', async () => {
    const server = await fixture({ mode: 'starttls' });
    await probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 10000 });
    const starttls = server.commands.findIndex(command => /^STARTTLS/.test(command));
    const auth = server.commands.findIndex(command => /^AUTH/.test(command));
    expect(starttls).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(starttls);
    await expectReaped(server);
  });

  it('never bypasses certificate verification through trusted resolver options', async () => {
    const server = await fixture();
    await expect(probeSmtpInChild(candidate, { ...server.endpoint, tls: { rejectUnauthorized: false } }, { timeoutMs: 10000 })).rejects.toMatchObject({ code: 'tls_error' });
    expect(server.commands.some(command => /^AUTH/.test(command))).toBe(false);
    await expectReaped(server);
  });

  it('AUTH refusal never leaks native error or credentials', async () => {
    const server = await fixture({ rejectAuth: true });
    const error = await probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 10000 }).catch(error => error);
    expect(error).toMatchObject({ code: 'smtp_auth_failed', protocol: 'smtp' });
    expect(`${error.stack}${JSON.stringify(error)}`).not.toContain('secret-sentinel');
    await expectReaped(server);
  });

  it('credentials travel only by private IPC with a minimal child environment', async () => {
    const server = await fixture();
    process.env.MAIL_PROBE_TEST_DB_SECRET = 'secret-sentinel';
    try { await probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 10000 }); }
    finally { delete process.env.MAIL_PROBE_TEST_DB_SECRET; }
    const [file, argv, options] = fork.mock.calls[0];
    expect(`${file}${JSON.stringify(argv)}${JSON.stringify(options)}`).not.toContain('secret-sentinel');
    expect(argv).toEqual([]);
    expect(options.execArgv).toEqual([]);
    expect(options.env).not.toHaveProperty('MAIL_PROBE_TEST_DB_SECRET');
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
    await expectReaped(server);
  });

  it('asynchronous OS spawn failure returns safely and releases its slot', async () => {
    const realFork = (await vi.importActual('node:child_process')).fork;
    fork.mockImplementationOnce((file, args, options) => realFork(file, args, { ...options, execPath: 'missing-mail-probe-runtime' }));
    const server = await fixture();
    await expect(probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 500 })).rejects.toMatchObject({ code: 'smtp_unavailable', protocol: 'smtp' });
    expect(server.sockets.size).toBe(0);
    await probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 10000 });
  });

  it('refuses a ninth child until abort has reaped the first eight', async () => {
    const server = await fixture({ stall: true });
    const controller = new AbortController();
    const results = Array.from({ length: 8 }, () => probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 20000, signal: controller.signal }).catch(error => error));
    await vi.waitFor(() => expect(server.sockets.size).toBe(8), { timeout: 10000 });
    await expect(probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 10000 })).rejects.toMatchObject({ code: 'server_refused', protocol: 'smtp' });
    expect(children).toHaveLength(8);
    controller.abort();
    expect(await Promise.all(results)).toEqual(Array.from({ length: 8 }, () => expect.objectContaining({ code: 'connection_cancelled' })));
    await expectReaped(server);
    await expect(probeSmtpInChild(candidate, server.endpoint, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'connection_timeout' });
    expect(children).toHaveLength(9);
  });

  it('IMAP starttls_cannot_downgrade and failure reaps a real SMTP sibling', async () => {
    const imap = await imapNoStarttlsFixture();
    fixtures.push(imap);
    const smtp = await fixture({ stall: true });
    const resolveEndpoint = async (_candidate, protocol) => {
      if (protocol === 'imap') { await smtp.ready; return imap.endpoint; }
      return smtp.endpoint;
    };
    await expect(probeConnection(candidate, { resolveEndpoint, protocolTimeoutMs: 15000 })).rejects.toMatchObject({ code: 'tls_error', protocol: 'imap' });
    expect(imap.commands.some(command => /AUTHENTICATE|LOGIN/.test(command))).toBe(false);
    await vi.waitFor(() => expect(imap.sockets.size).toBe(0));
    await expectReaped(smtp);
  });

  it.each(['implicit', 'starttls'])('real IMAP %s authenticates, lists and logs out before returning both logins', async mode => {
    const imap = await imapFixture({ certificate, mode });
    fixtures.push(imap);
    const smtp = await fixture();
    const resolveEndpoint = async (_candidate, protocol) => protocol === 'imap' ? imap.endpoint : smtp.endpoint;
    expect(await probeConnection(candidate, { resolveEndpoint })).toEqual({ imapLogin: 'user@example.com', smtpLogin: 'smtp@example.com' });
    expect(imap.commands.some(command => / AUTHENTICATE PLAIN/.test(command))).toBe(true);
    expect(imap.commands.some(command => / LIST /.test(command))).toBe(true);
    expect(imap.commands.some(command => / LOGOUT$/.test(command))).toBe(true);
    if (mode === 'starttls') expect(imap.commands.findIndex(command => / STARTTLS$/.test(command))).toBeLessThan(imap.commands.findIndex(command => / AUTHENTICATE /.test(command)));
    await vi.waitFor(() => expect(imap.sockets.size).toBe(0));
    await expectReaped(smtp);
  });

  it('cancellation of a real stalled IMAP LIST closes its socket and reaps SMTP', async () => {
    const imap = await imapFixture({ certificate, stallList: true });
    fixtures.push(imap);
    const smtp = await fixture({ stall: true });
    const controller = new AbortController();
    const resolveEndpoint = async (_candidate, protocol) => protocol === 'imap' ? imap.endpoint : smtp.endpoint;
    const result = probeConnection(candidate, { signal: controller.signal, resolveEndpoint }).catch(error => error);
    await Promise.all([imap.listReady, smtp.ready]);
    controller.abort();
    expect(await result).toMatchObject({ code: 'connection_cancelled' });
    await vi.waitFor(() => expect(imap.sockets.size).toBe(0));
    await expectReaped(smtp);
  });

  it('IMAP trusted resolver cannot disable certificate verification before AUTH', async () => {
    const imap = await imapFixture({ certificate });
    fixtures.push(imap);
    const smtp = await fixture({ stall: true });
    const resolveEndpoint = async (_candidate, protocol) => protocol === 'imap' ? { ...imap.endpoint, tls: { rejectUnauthorized: false } } : smtp.endpoint;
    await expect(probeConnection(candidate, { resolveEndpoint })).rejects.toMatchObject({ code: 'tls_error', protocol: 'imap' });
    expect(imap.commands.some(command => /AUTHENTICATE|LOGIN/.test(command))).toBe(false);
    await vi.waitFor(() => expect(imap.sockets.size).toBe(0));
    await expectReaped(smtp);
  });
});
