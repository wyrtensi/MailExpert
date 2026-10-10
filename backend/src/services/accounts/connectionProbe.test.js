import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('node:dns', () => ({ promises: { resolve4: vi.fn(), resolve6: vi.fn() } }));
vi.mock('./smtpProbeProcess.js', () => ({ probeSmtpInChild: vi.fn() }));

import { ImapFlow } from 'imapflow';
import { promises as dns } from 'node:dns';
import { getConnectionPolicy } from '../connectionPolicy.js';
import { probeSmtpInChild } from './smtpProbeProcess.js';
import { probeConnection, resolveProbeEndpoint } from './connectionProbe.js';
import { getImapProvider } from './providerCatalog.js';

const candidate = {
  email_address: 'user@yandex.ru', auth_user: 'user@yandex.ru', auth_pass: 'secret-sentinel',
  imap_host: 'imap.example.com', imap_port: 993, imap_tls_mode: 'implicit',
  smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
  smtp_auth_user: 'user@yandex.ru', smtp_auth_pass: 'secret-sentinel',
};
let client;
beforeEach(() => {
  vi.resetAllMocks();
  client = { connect: vi.fn().mockResolvedValue(), list: vi.fn().mockResolvedValue([]), logout: vi.fn().mockResolvedValue(), close: vi.fn(), on: vi.fn() };
  ImapFlow.mockImplementation(function () { return client; });
  probeSmtpInChild.mockResolvedValue();
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowNonstandardPorts: false, allowInsecureTls: true });
  dns.resolve4.mockResolvedValue(['203.0.113.10', '203.0.113.11']);
  dns.resolve6.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe('bounded connection probe', () => {
  it('probe_checks_auth_and_list_without_sending', async () => {
    expect(await probeConnection(candidate)).toEqual({ imapLogin: 'user@yandex.ru', smtpLogin: 'user@yandex.ru' });
    expect(client.list).toHaveBeenCalledOnce();
    expect(client.logout).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(ImapFlow.mock.calls[0][0]).toMatchObject({ host: '203.0.113.10', secure: true, auth: { user: 'user@yandex.ru', pass: 'secret-sentinel' }, logger: false, tls: { servername: 'imap.example.com', rejectUnauthorized: true } });
    expect(probeSmtpInChild.mock.calls[0][1]).toMatchObject({ host: '203.0.113.10', addresses: ['203.0.113.10', '203.0.113.11'], servername: 'smtp.example.com', secure: false, requireTLS: true });
  });

  it('smtp_failure_leaves_no_success', async () => {
    probeSmtpInChild.mockRejectedValue(Object.assign(new Error('secret-sentinel'), { code: 'EAUTH', command: 'AUTH PLAIN' }));
    await expect(probeConnection(candidate)).rejects.toMatchObject({ code: 'smtp_auth_failed', protocol: 'smtp' });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('abort_closes_both_clients', async () => {
    client.list.mockImplementation(() => new Promise(() => {}));
    let childSignal;
    probeSmtpInChild.mockImplementation((_candidate, _endpoint, { signal }) => {
      childSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('closed')), { once: true }));
    });
    const controller = new AbortController();
    const result = probeConnection(candidate, { signal: controller.signal });
    await vi.waitFor(() => expect(client.list).toHaveBeenCalledOnce());
    controller.abort(new Error('secret-sentinel'));
    await expect(result).rejects.toMatchObject({ code: 'connection_cancelled' });
    expect(childSignal.aborted).toBe(true);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('bounds stalled LIST and the protocol budget includes DNS and AUTH', async () => {
    vi.useFakeTimers();
    dns.resolve4.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(['203.0.113.10']), 10000)));
    client.list.mockImplementation(() => new Promise(() => {}));
    const result = probeConnection(candidate);
    const rejection = expect(result).rejects.toMatchObject({ code: 'connection_timeout', protocol: 'imap' });
    await vi.advanceTimersByTimeAsync(14999);
    expect(client.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('total 35000 ms budget includes a stalled trusted resolver', async () => {
    vi.useFakeTimers();
    const resolver = vi.fn(() => new Promise(() => {}));
    const result = probeConnection(candidate, { protocolTimeoutMs: 60000, resolveEndpoint: resolver });
    const rejection = expect(result).rejects.toMatchObject({ code: 'connection_timeout' });
    await vi.advanceTimersByTimeAsync(34999);
    expect(ImapFlow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(probeSmtpInChild).not.toHaveBeenCalled();
  });

  it('empty_dns_never_spawns_client', async () => {
    dns.resolve4.mockResolvedValue([]);
    await expect(probeConnection(candidate)).rejects.toMatchObject({ code: 'imap_unavailable' });
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(probeSmtpInChild).not.toHaveBeenCalled();
  });

  it('late_dns_after_abort_never_spawns_client', async () => {
    const completions = [];
    dns.resolve4.mockImplementation(() => new Promise(resolve => completions.push(resolve)));
    const controller = new AbortController();
    const result = probeConnection(candidate, { signal: controller.signal });
    const rejection = expect(result).rejects.toMatchObject({ code: 'connection_cancelled' });
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    controller.abort();
    await rejection;
    completions.forEach(resolve => resolve(['203.0.113.10']));
    await Promise.resolve();
    await Promise.resolve();
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(probeSmtpInChild).not.toHaveBeenCalled();
  });

  it('forced IMAP STARTTLS never uses opportunistic TLS', async () => {
    await probeConnection({ ...candidate, imap_port: 143, imap_tls_mode: 'starttls', imap_skip_tls_verify: true });
    expect(ImapFlow.mock.calls[0][0]).toMatchObject({ secure: false, doSTARTTLS: true, tls: { rejectUnauthorized: true } });
  });

  it('auth_fallback_runs_once_only_after_auth_rejection with independent logins', async () => {
    client.connect.mockRejectedValueOnce({ authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'AUTHENTICATIONFAILED' });
    expect(await probeConnection({ ...candidate, provider: getImapProvider('yandex') })).toEqual({ imapLogin: 'user', smtpLogin: 'user@yandex.ru' });
    expect(ImapFlow.mock.calls.map(([options]) => options.auth.user)).toEqual(['user@yandex.ru', 'user']);
    expect(probeSmtpInChild).toHaveBeenCalledOnce();
  });

  it.each([
    [{ code: 'ECONNREFUSED' }, {}, 'server_refused'],
    [{ code: 'CERT_HAS_EXPIRED' }, {}, 'tls_error'],
    [{ authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'LIMIT' }, {}, 'server_refused'],
    [{ authenticationFailed: true, responseStatus: 'NO' }, { explicitLogin: true }, 'imap_auth_failed'],
    [{ authenticationFailed: true, responseStatus: 'NO' }, { email_address: 'user@custom.example.com' }, 'imap_auth_failed'],
    [{ authenticationFailed: true, responseStatus: 'NO' }, { email_address: 'user@yandex.ru.example.com' }, 'imap_auth_failed'],
  ])('does not fallback on %j with %j', async (error, extra, code) => {
    client.connect.mockRejectedValue(error);
    await expect(probeConnection({ ...candidate, provider: getImapProvider('yandex'), ...extra })).rejects.toMatchObject({ code });
    expect(ImapFlow).toHaveBeenCalledOnce();
  });

  it('rejects after one fallback and returns a secret-free error', async () => {
    client.connect.mockRejectedValue({ authenticationFailed: true, responseStatus: 'NO', message: 'secret-sentinel' });
    const error = await probeConnection({ ...candidate, provider: getImapProvider('yandex') }).catch(error => error);
    expect(ImapFlow).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ code: 'imap_auth_failed' });
    expect(`${error.stack}${JSON.stringify(error)}`).not.toContain('secret-sentinel');
  });

  it('SMTP fallback can independently succeed with a different login', async () => {
    probeSmtpInChild.mockRejectedValueOnce({ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 });
    expect(await probeConnection({ ...candidate, provider: getImapProvider('yandex') })).toEqual({ imapLogin: 'user@yandex.ru', smtpLogin: 'user' });
    expect(probeSmtpInChild.mock.calls.map(([account]) => account.smtp_auth_user)).toEqual(['user@yandex.ru', 'user']);
  });

  it('iCloud local-part fallback changes only IMAP', async () => {
    client.connect.mockRejectedValueOnce({ authenticationFailed: true, responseStatus: 'NO' });
    expect(await probeConnection({ ...candidate, email_address: 'user@icloud.com', auth_user: 'user@icloud.com', smtp_auth_user: 'user@icloud.com', provider: getImapProvider('icloud') })).toEqual({ imapLogin: 'user', smtpLogin: 'user@icloud.com' });
  });

  it('temporary SMTP AUTH refusal does not retry an alternative login', async () => {
    probeSmtpInChild.mockRejectedValue({ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 454 });
    await expect(probeConnection({ ...candidate, provider: getImapProvider('yandex') })).rejects.toMatchObject({ code: 'server_refused', protocol: 'smtp' });
    expect(probeSmtpInChild).toHaveBeenCalledOnce();
  });

  it('one protocol budget bounds both authentication attempts', async () => {
    vi.useFakeTimers();
    client.connect.mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject({ authenticationFailed: true, responseStatus: 'NO' }), 10000)));
    client.list.mockImplementation(() => new Promise(() => {}));
    const result = probeConnection({ ...candidate, provider: getImapProvider('yandex') }).catch(error => error);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toMatchObject({ code: 'connection_timeout', protocol: 'imap' });
    expect(ImapFlow).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it('already aborted requests never resolve DNS or spawn clients', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(probeConnection(candidate, { signal: controller.signal })).rejects.toMatchObject({ code: 'connection_cancelled' });
    expect(dns.resolve4).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(probeSmtpInChild).not.toHaveBeenCalled();
  });

  it('sanitizes policy/resolver failures even when called directly', async () => {
    getConnectionPolicy.mockRejectedValue(new Error('secret-sentinel'));
    const error = await resolveProbeEndpoint(candidate, 'imap').catch(error => error);
    expect(error).toMatchObject({ code: 'imap_unavailable', protocol: 'imap' });
    expect(`${error.stack}${JSON.stringify(error)}`).not.toContain('secret-sentinel');
  });

  it('rejects private DNS answers and preserves policy port allowlists', async () => {
    dns.resolve4.mockResolvedValue(['203.0.113.10', '127.0.0.1']);
    await expect(probeConnection(candidate)).rejects.toMatchObject({ code: 'server_refused' });
    expect(ImapFlow).not.toHaveBeenCalled();
    await expect(resolveProbeEndpoint({ ...candidate, smtp_port: 2525 }, 'smtp')).rejects.toMatchObject({ code: 'server_refused', protocol: 'smtp' });
  });

  it.each([0, -1, 65536, 3.5, '993', NaN])('ports_validate_with_relaxed_policy: %s', async port => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowNonstandardPorts: true });
    await expect(probeConnection({ ...candidate, imap_port: port })).rejects.toMatchObject({ code: 'server_refused', protocol: 'imap' });
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('validates email, login and TLS before any network access', async () => {
    await expect(probeConnection({ ...candidate, email_address: 'bad' })).rejects.toMatchObject({ code: 'email_invalid' });
    await expect(probeConnection({ ...candidate, auth_user: 'bad\r\nlogin' })).rejects.toMatchObject({ code: 'login_invalid' });
    await expect(probeConnection({ ...candidate, smtp_tls: 'none' })).rejects.toMatchObject({ code: 'tls_error' });
    expect(dns.resolve4).not.toHaveBeenCalled();
  });
});
