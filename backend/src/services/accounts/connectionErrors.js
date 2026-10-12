const codes = new Set([
  'email_invalid', 'login_invalid', 'imap_auth_failed', 'smtp_auth_failed',
  'imap_unavailable', 'smtp_unavailable', 'connection_timeout', 'tls_error',
  'connection_cancelled', 'server_refused',
]);
const timeoutCodes = new Set(['ETIMEDOUT', 'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT']);
const tlsCodes = new Set([
  'ETLS', 'STARTTLS_NOT_SUPPORTED', 'TLSFailed', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
const refusalCodes = new Set(['LIMIT', 'UNAVAILABLE', 'SERVERBUG', 'CONTACTADMIN', 'INUSE']);

export class ConnectionError extends Error {
  constructor(code, protocol = null) {
    const safeCode = codes.has(code) ? code : 'server_refused';
    super(safeCode);
    this.name = 'ConnectionError';
    this.code = safeCode;
    this.protocol = protocol === 'imap' || protocol === 'smtp' ? protocol : null;
  }
}

export function connectionError(error, protocol) {
  if (error instanceof ConnectionError) return new ConnectionError(error.code, error.protocol);
  let code = `${protocol === 'imap' ? 'imap' : 'smtp'}_unavailable`;
  const responseCode = typeof error?.serverResponseCode === 'string' ? error.serverResponseCode.toUpperCase() : '';
  if (timeoutCodes.has(error?.code)) code = 'connection_timeout';
  else if (error?.tlsFailed === true || tlsCodes.has(error?.code) || /^ERR_(TLS|SSL)_/.test(String(error?.code || ''))
    // Nodemailer replaces Node's certificate code with ESOCKET for implicit TLS.
    || error?.code === 'ESOCKET' && /certificate|self.signed|unable to verify|ssl routines/i.test(String(error?.message || ''))) code = 'tls_error';
  else if (error?.code === 'ECONNREFUSED' || refusalCodes.has(responseCode)) code = 'server_refused';
  else if (protocol === 'smtp' && error?.code === 'EAUTH' && error?.responseCode >= 400 && error.responseCode < 500) code = 'server_refused';
  else if (protocol === 'smtp' && error?.code === 'EAUTH' && /^AUTH\b/i.test(String(error?.command || ''))) code = 'smtp_auth_failed';
  else if (protocol === 'imap' && !error?.code && error?.responseStatus === 'NO'
    && (error?.authenticationFailed === true || responseCode === 'AUTHENTICATIONFAILED' || responseCode === 'AUTHORIZATIONFAILED')) code = 'imap_auth_failed';
  return new ConnectionError(code, protocol);
}
