import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../hostValidation.js', async importOriginal => {
  const real = await importOriginal();
  return { ...real, resolveForConnection: vi.fn(real.resolveForConnection) };
});
vi.mock('../proton/mailEndpoint.js', async importOriginal => ({
  ...(await importOriginal()),
  resolveProtonEndpoint: vi.fn(),
}));

const { getConnectionPolicy } = await import('../connectionPolicy.js');
const { resolveForConnection } = await import('../hostValidation.js');
const { resolveProtonEndpoint, MANAGED_PROTON_ENDPOINT } = await import('../proton/mailEndpoint.js');
const { resolveMailEndpoint } = await import('./mailEndpoint.js');

const strict = { allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false };
const resolved = { host: '203.0.113.10', servername: 'imap.example.com', addresses: ['203.0.113.10', '203.0.113.11'], lookup: () => {} };

beforeEach(() => {
  vi.clearAllMocks();
  getConnectionPolicy.mockResolvedValue(strict);
});

const manual = {
  id: 'manual', mail_provider: null, connection_mode: 'manual', imap_tls_mode: null,
  imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, imap_skip_tls_verify: false,
  smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
};

describe('resolveMailEndpoint', () => {
  it('manual_and_oauth_endpoint_rules_unchanged', async () => {
    resolveForConnection.mockResolvedValueOnce(resolved);
    const imap = await resolveMailEndpoint(manual, 'imap');
    expect(resolveForConnection).toHaveBeenLastCalledWith('imap.example.com', { allowPrivate: false });
    expect(imap).toMatchObject({ ...resolved, port: 993, secure: true, requireTLS: false, imapTlsMode: null, tls: { rejectUnauthorized: true, servername: 'imap.example.com' } });
    expect(imap[MANAGED_PROTON_ENDPOINT]).toBeUndefined();

    resolveForConnection.mockResolvedValueOnce({ ...resolved, servername: 'smtp.example.com' });
    const smtp = await resolveMailEndpoint(manual, 'smtp');
    expect(resolveForConnection).toHaveBeenLastCalledWith('smtp.example.com', { allowPrivate: false });
    expect(smtp).toMatchObject({ port: 587, secure: false, requireTLS: true, tls: { rejectUnauthorized: true, servername: 'smtp.example.com' } });

    // OAuth rows (Gmail, Microsoft) keep the ordinary policy path; the policy flags still apply.
    getConnectionPolicy.mockResolvedValue({ ...strict, allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValueOnce(resolved);
    const oauth = await resolveMailEndpoint({ ...manual, mail_provider: 'gmail', connection_mode: 'managed', oauth_provider: 'google', imap_skip_tls_verify: true }, 'imap');
    expect(resolveForConnection).toHaveBeenLastCalledWith('imap.example.com', { allowPrivate: true });
    expect(oauth.tls.rejectUnauthorized).toBe(false);
    expect(resolveProtonEndpoint).not.toHaveBeenCalled();
  });

  it('managed_link_is_required_for_loopback_exception', async () => {
    const managed = { ...manual, id: 'proton-1', mail_provider: 'proton', connection_mode: 'managed', imap_tls_mode: 'implicit', imap_host: '127.0.0.1' };
    const endpoint = { host: '127.0.0.1', port: 1993, [MANAGED_PROTON_ENDPOINT]: true };
    resolveProtonEndpoint.mockResolvedValueOnce(endpoint);
    const signal = new AbortController().signal;
    await expect(resolveMailEndpoint(managed, 'imap', { signal })).resolves.toBe(endpoint);
    expect(resolveProtonEndpoint).toHaveBeenCalledWith('proton-1', 'imap', { signal });
    expect(resolveForConnection).not.toHaveBeenCalled();

    resolveProtonEndpoint.mockRejectedValueOnce(Object.assign(new Error('proton_link_missing'), { code: 'proton_link_missing' }));
    await expect(resolveMailEndpoint(managed, 'smtp')).rejects.toMatchObject({ code: 'proton_link_missing' });
    // No fallback to the ordinary path, whatever the global flags say.
    expect(resolveForConnection).not.toHaveBeenCalled();
  });

  it('forged_mail_provider_has_no_private_access', async () => {
    // A Proton label without the managed mode, or any preset label, is an ordinary mailbox.
    for (const labels of [
      { mail_provider: 'proton', connection_mode: 'manual' },
      { mail_provider: 'proton', connection_mode: 'preset' },
      { mail_provider: 'yahoo', connection_mode: 'preset' },
      { mail_provider: 'other', connection_mode: 'managed' },
    ]) {
      const forged = { ...manual, ...labels, imap_tls_mode: 'implicit', imap_host: '127.0.0.1', imap_port: 1993, smtp_host: '127.0.0.1', smtp_port: 1465 };
      await expect(resolveMailEndpoint(forged, 'imap')).rejects.toThrow(/private or reserved/);
      await expect(resolveMailEndpoint(forged, 'smtp')).rejects.toThrow(/private or reserved/);
    }
    expect(resolveProtonEndpoint).not.toHaveBeenCalled();

    // With private hosts allowed the row connects, but under ordinary rules: no Bridge CA.
    getConnectionPolicy.mockResolvedValue({ ...strict, allowPrivateHosts: true });
    const allowed = await resolveMailEndpoint({ ...manual, mail_provider: 'proton', imap_tls_mode: 'implicit', imap_host: '127.0.0.1', imap_port: 1993 }, 'imap');
    expect(allowed.tls.ca).toBeUndefined();
    expect(allowed[MANAGED_PROTON_ENDPOINT]).toBeUndefined();
  });

  it('verified_runtime_dns_empty_fails_closed', async () => {
    const unresolved = { host: 'imap.example.com', servername: null };
    resolveForConnection.mockResolvedValueOnce(unresolved);
    await expect(resolveMailEndpoint({ ...manual, imap_tls_mode: 'implicit' }, 'imap')).rejects.toMatchObject({ code: 'dns_unresolved' });
    resolveForConnection.mockResolvedValueOnce(unresolved);
    await expect(resolveMailEndpoint({ ...manual, imap_tls_mode: 'starttls', imap_port: 143 }, 'smtp')).rejects.toMatchObject({ code: 'dns_unresolved' });
    // A literal address needs no DNS.
    const literal = await resolveMailEndpoint({ ...manual, imap_tls_mode: 'implicit', imap_host: '203.0.113.20' }, 'imap');
    expect(literal).toMatchObject({ host: '203.0.113.20', port: 993 });
  });

  it('legacy_null_mode_preserves_behavior', async () => {
    // A NULL mode row keeps connecting by hostname when DNS has no answers, as before.
    resolveForConnection.mockResolvedValueOnce({ host: 'imap.example.com', servername: null });
    const legacy = await resolveMailEndpoint(manual, 'imap');
    expect(legacy).toMatchObject({ host: 'imap.example.com', servername: null, port: 993, secure: true, imapTlsMode: null });

    getConnectionPolicy.mockResolvedValue({ ...strict, allowInsecureTls: true });
    resolveForConnection.mockResolvedValueOnce(resolved);
    const plain = await resolveMailEndpoint({ ...manual, imap_port: 143, imap_tls: false, imap_skip_tls_verify: true }, 'imap');
    expect(plain).toMatchObject({ secure: false, requireTLS: false, tls: { rejectUnauthorized: false } });

    resolveForConnection.mockResolvedValueOnce(resolved);
    const smtpNone = await resolveMailEndpoint({ ...manual, smtp_tls: 'none', smtp_port: 25 }, 'smtp');
    expect(smtpNone).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
  });

  it('explicit_starttls_is_forced_in_every_imap_client', async () => {
    getConnectionPolicy.mockResolvedValue({ ...strict, allowInsecureTls: true });
    resolveForConnection.mockResolvedValueOnce(resolved);
    const endpoint = await resolveMailEndpoint({ ...manual, imap_tls_mode: 'starttls', imap_port: 143, imap_tls: false, imap_skip_tls_verify: true }, 'imap');
    expect(endpoint).toMatchObject({ secure: false, requireTLS: true, imapTlsMode: 'starttls', tls: { rejectUnauthorized: true } });
  });

  it('honours cancellation before connecting', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolveMailEndpoint(manual, 'imap', { signal: controller.signal })).rejects.toMatchObject({ code: 'connection_cancelled' });
    expect(resolveForConnection).not.toHaveBeenCalled();
  });
});
