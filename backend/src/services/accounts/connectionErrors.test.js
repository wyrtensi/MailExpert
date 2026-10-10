import { describe, expect, it } from 'vitest';
import { ConnectionError, connectionError } from './connectionErrors.js';

describe('connection error boundary', () => {
  it('only exposes allowlisted codes and protocols, never raw errors', () => {
    const raw = Object.assign(new Error('secret-sentinel'), { code: 'secret-sentinel', response: 'secret-sentinel' });
    const safe = connectionError(raw, 'smtp');
    expect(safe).toBeInstanceOf(ConnectionError);
    expect(safe).toMatchObject({ code: 'smtp_unavailable', protocol: 'smtp' });
    expect(`${safe.stack}${JSON.stringify(safe)}`).not.toContain('secret-sentinel');
    expect(new ConnectionError('secret-sentinel', 'secret-sentinel')).toMatchObject({ code: 'server_refused', protocol: null });
  });

  it.each([
    [{ code: 'EAUTH', command: 'AUTH PLAIN' }, 'smtp', 'smtp_auth_failed'],
    [{ code: 'EAUTH', command: 'API' }, 'smtp', 'smtp_unavailable'],
    [{ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 454 }, 'smtp', 'server_refused'],
    [{ authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'AUTHENTICATIONFAILED' }, 'imap', 'imap_auth_failed'],
    [{ authenticationFailed: true, code: 'ETIMEDOUT' }, 'imap', 'connection_timeout'],
    [{ authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'LIMIT' }, 'imap', 'server_refused'],
    [{ code: 'ECONNREFUSED' }, 'smtp', 'server_refused'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'smtp', 'tls_error'],
    [{ code: 'ETLS' }, 'smtp', 'tls_error'],
    [{ code: 'ESOCKET', message: 'self-signed certificate' }, 'smtp', 'tls_error'],
    [{ tlsFailed: true }, 'imap', 'tls_error'],
    [{ code: 'ETIMEOUT' }, 'smtp', 'connection_timeout'],
    [{ code: 'STARTTLS_NOT_SUPPORTED' }, 'imap', 'tls_error'],
  ])('maps %j for %s to %s', (raw, protocol, code) => {
    expect(connectionError({ message: 'secret-sentinel', ...raw }, protocol)).toMatchObject({ code, protocol });
  });
});
