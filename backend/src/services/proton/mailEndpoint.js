import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { query } from '../db.js';
import { createPinnedLookup } from '../hostValidation.js';
import { probeConnection } from '../accounts/connectionProbe.js';
import { callWorker } from './workerClient.js';

// The managed Proton mailbox talks to Bridge inside the worker, reachable from the backend only
// on loopback (the two share a network namespace). This is the single place that grants that
// exception: a fixed loopback endpoint whose TLS trusts only the public certificate the worker
// handed over for a managed link. Global allow_private_hosts / allow_insecure_tls never apply.

export const PROTON_LOOPBACK_HOST = '127.0.0.1';
export const PROTON_PORTS = Object.freeze({ imap: 1993, smtp: 1465 });

// Marks an endpoint built here. Data read from a row or a request cannot carry a Symbol key, so
// a mailbox row cannot claim the managed trust by its fields alone.
export const MANAGED_PROTON_ENDPOINT = Symbol('managedProtonEndpoint');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProtonEndpointError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProtonEndpointError';
    this.code = code;
  }
}

// Routing only: whether a row asks for the managed endpoint. resolveProtonEndpoint still requires
// the database link, so a forged label ends in proton_link_missing, never in ordinary rules.
export function isManagedProtonAccount(account) {
  return account?.mail_provider === 'proton' && account?.connection_mode === 'managed';
}

function normalizedFingerprint(value) {
  return typeof value === 'string' ? value.replace(/:/g, '').toLowerCase() : '';
}

// The certificate must be a public certificate only, match its recorded fingerprint and carry the
// identity Bridge serves on loopback. The identity is verified again by TLS on every connection.
function verifiedIdentity({ certificatePem, certificateFingerprint, tlsServername }) {
  if (typeof certificatePem !== 'string' || /PRIVATE KEY/.test(certificatePem) || typeof tlsServername !== 'string') {
    throw new ProtonEndpointError('proton_certificate_invalid');
  }
  let certificate;
  try { certificate = new X509Certificate(certificatePem); }
  catch { throw new ProtonEndpointError('proton_certificate_invalid'); }
  const fingerprint = normalizedFingerprint(certificateFingerprint);
  if (!/^[0-9a-f]{64}$/.test(fingerprint) || fingerprint !== normalizedFingerprint(certificate.fingerprint256)) {
    throw new ProtonEndpointError('proton_certificate_invalid');
  }
  const ipIdentity = isIP(tlsServername) !== 0;
  const matches = ipIdentity
    ? tlsServername === PROTON_LOOPBACK_HOST && certificate.checkIP(tlsServername) !== undefined
    : /^[a-z0-9.-]+$/i.test(tlsServername) && certificate.checkHost(tlsServername, { wildcards: false }) !== undefined;
  if (!matches) throw new ProtonEndpointError('proton_certificate_invalid');
  return ipIdentity ? null : tlsServername;
}

// Builds the fixed endpoint for one protocol from link or worker material. An IP identity is
// checked by Node against the connected host; it is never sent as SNI (RFC 6066).
export function trustedProtonEndpoint(material, protocol) {
  if (!Object.hasOwn(PROTON_PORTS, protocol)) throw new ProtonEndpointError('proton_endpoint_invalid');
  const servername = verifiedIdentity(material);
  return {
    host: PROTON_LOOPBACK_HOST,
    port: PROTON_PORTS[protocol],
    addresses: [PROTON_LOOPBACK_HOST],
    lookup: createPinnedLookup([PROTON_LOOPBACK_HOST]),
    servername,
    tls: { rejectUnauthorized: true, ca: material.certificatePem, ...(servername ? { servername } : {}) },
    secure: true,
    requireTLS: false,
    imapTlsMode: 'implicit',
    [MANAGED_PROTON_ENDPOINT]: true,
  };
}

function checkAbort(signal) {
  if (signal?.aborted) throw new ProtonEndpointError('connection_cancelled');
}

// The account's own host/port are never read: only a database link of a managed Proton mailbox,
// bound to the native user's current generation, yields the loopback endpoint.
export async function resolveProtonEndpoint(accountId, protocol, { signal } = {}) {
  if (!Object.hasOwn(PROTON_PORTS, protocol)) throw new ProtonEndpointError('proton_endpoint_invalid');
  checkAbort(signal);
  if (typeof accountId !== 'string' || !UUID.test(accountId)) throw new ProtonEndpointError('proton_link_missing');
  const { rows: [link] } = await query(
    `SELECT l.certificate_pem, l.certificate_fingerprint, l.tls_servername
       FROM proton_mailbox_links l
       JOIN proton_users u ON u.user_id = l.user_id AND u.generation = l.generation
       JOIN email_accounts a ON a.id = l.account_id
      WHERE l.account_id = $1 AND a.mail_provider = 'proton' AND a.connection_mode = 'managed'`,
    [accountId],
  );
  checkAbort(signal);
  if (!link) throw new ProtonEndpointError('proton_link_missing');
  return trustedProtonEndpoint({
    certificatePem: link.certificate_pem,
    certificateFingerprint: link.certificate_fingerprint,
    tlsServername: link.tls_servername,
  }, protocol);
}

const normalizedEmail = value => (typeof value === 'string' ? value.trim().toLowerCase() : '');

// Pre-INSERT check of a pending Proton operation (Task 5 consumes it): the operation must be in
// `checking`, unexpired and bound to a native user; the worker's credentials must name that user
// and the requested address. Both protocols are then probed against the fixed loopback endpoint
// with the trusted resolver. There is no mailbox link yet, and no HTTP input reaches this path.
export async function probeManagedProtonConnection(operationId, { signal } = {}) {
  checkAbort(signal);
  if (typeof operationId !== 'string' || !UUID.test(operationId)) throw new ProtonEndpointError('proton_operation_invalid');
  const { rows: [operation] } = await query(
    `SELECT user_id, requested_email FROM proton_connections
      WHERE id = $1 AND state = 'checking' AND user_id IS NOT NULL AND expires_at > NOW()`,
    [operationId],
  );
  checkAbort(signal);
  if (!operation) throw new ProtonEndpointError('proton_operation_invalid');

  const returned = await callWorker('POST', `/users/${operation.user_id}/credentials`, { operationId }, { signal });
  checkAbort(signal);
  const email = normalizedEmail(returned?.email);
  if (returned?.userId !== operation.user_id || !email || email !== normalizedEmail(operation.requested_email)
    || typeof returned.bridgePassword !== 'string' || !returned.bridgePassword) {
    throw new ProtonEndpointError('proton_identity_mismatch');
  }
  const material = {
    certificatePem: returned.certificatePem,
    certificateFingerprint: returned.certificateFingerprint,
    tlsServername: returned.tlsServername,
  };
  verifiedIdentity(material);

  const candidate = {
    email_address: email,
    imap_host: PROTON_LOOPBACK_HOST, imap_port: PROTON_PORTS.imap, imap_tls_mode: 'implicit',
    smtp_host: PROTON_LOOPBACK_HOST, smtp_port: PROTON_PORTS.smtp, smtp_tls: 'SSL',
    auth_user: email, auth_pass: returned.bridgePassword,
    smtp_auth_user: email, smtp_auth_pass: returned.bridgePassword,
    // Bridge accepts exactly the address; no login alternatives.
    explicitLogin: true,
  };
  const resolveEndpoint = async (_candidate, protocol) => trustedProtonEndpoint(material, protocol);
  return probeConnection(candidate, { signal, resolveEndpoint });
}
