import { isIP } from 'node:net';
import { getConnectionPolicy } from '../connectionPolicy.js';
import { resolveForConnection } from '../hostValidation.js';
import { isManagedProtonAccount, resolveProtonEndpoint } from '../proton/mailEndpoint.js';

// Where a stored mailbox connects at runtime and with which TLS rules, for every IMAP client
// (imapManager: persistent, pool, backfill, poll-only, snippets) and the account SMTP transport.
// A managed Proton mailbox gets its fixed loopback endpoint from the database link; every other
// mailbox keeps the connection policy and DNS rules (resolveForConnection) unchanged.

export class MailEndpointError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MailEndpointError';
    this.code = code;
  }
}

const EXPLICIT_IMAP_MODES = new Set(['implicit', 'starttls']);

// A row with an explicit IMAP mode was verified on creation (or edited by an administrator after
// it); NULL is a legacy row that keeps the old port-implied behavior.
export function hasExplicitImapMode(account) {
  return account?.imap_tls_mode !== null && account?.imap_tls_mode !== undefined;
}

// IMAP TLS rules for a row. Explicit modes always verify the certificate; STARTTLS is mandatory
// (doSTARTTLS) so a stripped capability can never send the login in plain text. Legacy rows keep
// the port-implied boolean and the admin's insecure-TLS switches. Pure; makeClientCfg uses it too.
export function imapTlsSettings(account, policy = {}) {
  if (hasExplicitImapMode(account)) {
    if (!EXPLICIT_IMAP_MODES.has(account.imap_tls_mode)) throw new MailEndpointError('imap_tls_mode_invalid');
    const secure = account.imap_tls_mode === 'implicit';
    return { secure, requireTLS: !secure, rejectUnauthorized: true };
  }
  return {
    secure: !!account.imap_tls,
    requireTLS: false,
    rejectUnauthorized: !(policy.allowInsecureTls && account.imap_skip_tls_verify),
  };
}

// SMTP TLS rules exactly as the account transport has always applied them.
function smtpTlsSettings(account, policy) {
  const secure = account.smtp_tls === 'SSL' || (account.smtp_tls !== 'none' && account.smtp_port === 465);
  return {
    secure,
    requireTLS: account.smtp_tls === 'STARTTLS' && !secure,
    ...(account.smtp_tls === 'none' ? { ignoreTLS: true } : {}),
    rejectUnauthorized: !(policy.allowInsecureTls && account.imap_skip_tls_verify),
  };
}

function abortable(promise, signal) {
  if (!signal) return promise;
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(new MailEndpointError('connection_cancelled'));
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', listener));
}

const bareHost = host => String(host ?? '').trim().replace(/^\[|\]$/g, '');

export async function resolveMailEndpoint(account, protocol, { signal } = {}) {
  if (protocol !== 'imap' && protocol !== 'smtp') throw new MailEndpointError('protocol_invalid');
  if (signal?.aborted) throw new MailEndpointError('connection_cancelled');
  if (isManagedProtonAccount(account)) return resolveProtonEndpoint(account.id, protocol, { signal });

  const policy = await abortable(getConnectionPolicy(), signal);
  const host = account[`${protocol}_host`];
  const resolved = await abortable(resolveForConnection(host, { allowPrivate: policy.allowPrivateHosts }), signal);
  // A verified row fails closed when DNS has no answers instead of handing the hostname to an
  // unpinned resolver at connect time; a legacy row keeps failing naturally on connect.
  if (hasExplicitImapMode(account) && !resolved.addresses?.length && !isIP(bareHost(host))) {
    throw new MailEndpointError('dns_unresolved');
  }
  const { rejectUnauthorized, ...transport } = protocol === 'imap' ? imapTlsSettings(account, policy) : smtpTlsSettings(account, policy);
  return {
    ...resolved,
    port: account[`${protocol}_port`],
    ...transport,
    tls: { rejectUnauthorized, ...(resolved.servername ? { servername: resolved.servername } : {}) },
    imapTlsMode: hasExplicitImapMode(account) ? account.imap_tls_mode : null,
  };
}
