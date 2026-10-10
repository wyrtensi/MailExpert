import { ImapFlow } from 'imapflow';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { getConnectionPolicy } from '../connectionPolicy.js';
import { createPinnedLookup, validateHostLiteral } from '../hostValidation.js';
import { ConnectionError, connectionError } from './connectionErrors.js';
import { probeSmtpInChild } from './smtpProbeProcess.js';

const allowedPorts = { imap: new Set([143, 993]), smtp: new Set([465, 587]) };

function cancelled(signal, protocol) {
  const reason = signal?.reason;
  return reason instanceof ConnectionError
    ? new ConnectionError(reason.code, reason.protocol)
    : new ConnectionError('connection_cancelled', protocol);
}

function checkAbort(signal, protocol) {
  if (signal?.aborted) throw cancelled(signal, protocol);
}

function abortable(operation, signal, protocol) {
  checkAbort(signal, protocol);
  if (!signal) return operation;
  let listener;
  const abort = new Promise((_, reject) => {
    listener = () => reject(cancelled(signal, protocol));
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([operation, abort]).finally(() => signal.removeEventListener('abort', listener));
}

function scope(parent, timeoutMs, protocol) {
  const controller = new AbortController();
  const listener = () => controller.abort(cancelled(parent, protocol));
  if (parent?.aborted) listener();
  else parent?.addEventListener('abort', listener, { once: true });
  const timer = setTimeout(() => controller.abort(new ConnectionError('connection_timeout', protocol)), timeoutMs);
  return { controller, signal: controller.signal, dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', listener); } };
}

function validatePort(port, protocol) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConnectionError('server_refused', protocol);
}

function tlsMode(candidate, protocol) {
  const mode = protocol === 'imap' ? candidate.imap_tls_mode : candidate.smtp_tls;
  if (protocol === 'imap' && mode !== 'implicit' && mode !== 'starttls'
    || protocol === 'smtp' && mode !== 'SSL' && mode !== 'STARTTLS') throw new ConnectionError('tls_error', protocol);
  return mode === 'implicit' || mode === 'SSL';
}

function credentials(candidate, protocol) {
  return protocol === 'imap'
    ? { user: candidate.auth_user, pass: candidate.auth_pass }
    : { user: candidate.smtp_auth_user || candidate.auth_user, pass: candidate.smtp_auth_pass || candidate.auth_pass };
}

function validateCandidate(candidate) {
  if (typeof candidate?.email_address !== 'string' || candidate.email_address.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.email_address)) throw new ConnectionError('email_invalid');
  for (const protocol of ['imap', 'smtp']) {
    validatePort(candidate[`${protocol}_port`], protocol);
    tlsMode(candidate, protocol);
    const { user, pass } = credentials(candidate, protocol);
    if (typeof user !== 'string' || !user || user.length > 320 || /[\r\n\0]/.test(user)
      || typeof pass !== 'string' || !pass) throw new ConnectionError('login_invalid', protocol);
  }
}

// Unlike the legacy host validator, onboarding fails closed when DNS has no usable answers.
// The returned IPs are the only connection targets; SNI still authenticates the original host.
async function resolveEndpoint(candidate, protocol, signal) {
  checkAbort(signal, protocol);
  const port = candidate[`${protocol}_port`];
  validatePort(port, protocol);
  const secure = tlsMode(candidate, protocol);
  const hostname = candidate[`${protocol}_host`];
  if (typeof hostname !== 'string' || !hostname.trim() || /[\s/\\@\0]/.test(hostname)) throw new ConnectionError('server_refused', protocol);
  const policy = await abortable(getConnectionPolicy(), signal, protocol);
  checkAbort(signal, protocol);
  if (!policy.allowNonstandardPorts && !allowedPorts[protocol].has(port)) throw new ConnectionError('server_refused', protocol);
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (validateHostLiteral(host, { allowPrivate: policy.allowPrivateHosts })) throw new ConnectionError('server_refused', protocol);
  const addresses = isIP(host) ? [host] : [...new Set((await abortable(Promise.all([
    dns.resolve4(host).catch(() => []), dns.resolve6(host).catch(() => []),
  ]), signal, protocol)).flat())];
  checkAbort(signal, protocol);
  if (!addresses.length) throw new ConnectionError(`${protocol}_unavailable`, protocol);
  if (addresses.some(address => !isIP(address) || validateHostLiteral(address, { allowPrivate: policy.allowPrivateHosts }))) throw new ConnectionError('server_refused', protocol);
  return {
    host: addresses[0], port, addresses, lookup: createPinnedLookup(addresses),
    servername: isIP(host) ? null : host,
    tls: { rejectUnauthorized: true }, secure, requireTLS: !secure,
  };
}

export async function resolveProbeEndpoint(candidate, protocol, { signal } = {}) {
  try { return await resolveEndpoint(candidate, protocol, signal); }
  catch (error) { throw connectionError(error, protocol); }
}

function pinnedEndpoint(endpoint, candidate, protocol) {
  const addresses = endpoint?.addresses?.length ? endpoint.addresses : [endpoint?.host];
  if (addresses.some(address => !isIP(address))) throw new ConnectionError('server_refused', protocol);
  const port = endpoint.port ?? candidate[`${protocol}_port`];
  validatePort(port, protocol);
  // A trusted managed resolver may supply a CA and TLS mode, but can never disable verification.
  const secure = endpoint.secure ?? tlsMode(candidate, protocol);
  return { ...endpoint, host: addresses[0], addresses, port, secure, requireTLS: !secure,
    tls: { ...endpoint.tls, rejectUnauthorized: true, ...(endpoint.servername ? { servername: endpoint.servername } : {}) } };
}

function alternativeLogin(candidate, protocol, initialLogin) {
  if (candidate.explicitLogin || initialLogin !== candidate.email_address) return null;
  const provider = candidate.provider;
  const [local, domain] = candidate.email_address.split('@');
  if (!provider?.publicDomains?.includes(domain.toLowerCase())) return null;
  const tokens = provider.loginAlternatives?.[protocol] || [];
  return tokens.some(token => token === 'local_part_public_domain' || token === 'local_part') ? local : null;
}

async function probeProtocol(candidate, protocol, parent, timeoutMs, resolveEndpoint) {
  const budget = scope(parent, timeoutMs, protocol);
  const expiresAt = Date.now() + timeoutMs;
  try {
    checkAbort(budget.signal, protocol);
    const resolved = await abortable(resolveEndpoint(candidate, protocol, { signal: budget.signal }), budget.signal, protocol);
    checkAbort(budget.signal, protocol);
    const endpoint = pinnedEndpoint(resolved, candidate, protocol);
    let { user } = credentials(candidate, protocol);
    const alternative = alternativeLogin(candidate, protocol, user);
    for (let attempt = 0; attempt < 2; attempt++) {
      checkAbort(budget.signal, protocol);
      try {
        if (protocol === 'smtp') {
          await probeSmtpInChild({ ...candidate, smtp_auth_user: user }, endpoint, { signal: budget.signal, timeoutMs: Math.max(1, expiresAt - Date.now()) });
        } else {
          const client = new ImapFlow({
            host: endpoint.host, port: endpoint.port, secure: endpoint.secure,
            ...(endpoint.secure ? {} : { doSTARTTLS: true }),
            tls: endpoint.tls, auth: { user, pass: candidate.auth_pass },
            logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true,
            connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
          });
          client.on('error', () => {});
          try {
            await abortable(client.connect(), budget.signal, protocol);
            checkAbort(budget.signal, protocol);
            await abortable(client.list(), budget.signal, protocol);
            await abortable(client.logout(), budget.signal, protocol);
          } finally { client.close(); }
        }
        checkAbort(budget.signal, protocol);
        return user;
      } catch (raw) {
        const error = budget.signal.aborted ? cancelled(budget.signal, protocol) : connectionError(raw, protocol);
        if (attempt === 0 && alternative && error.code === `${protocol}_auth_failed`) { user = alternative; continue; }
        throw error;
      }
    }
  } catch (raw) {
    throw budget.signal.aborted ? cancelled(budget.signal, protocol) : connectionError(raw, protocol);
  } finally { budget.dispose(); }
}

export async function probeConnection(candidate, { signal, protocolTimeoutMs = 15000, totalTimeoutMs = 35000, resolveEndpoint = resolveProbeEndpoint } = {}) {
  validateCandidate(candidate);
  for (const timeout of [protocolTimeoutMs, totalTimeoutMs]) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new ConnectionError('server_refused');
  }
  const budget = scope(signal, totalTimeoutMs, null);
  const probes = ['imap', 'smtp'].map(protocol => probeProtocol(candidate, protocol, budget.signal, protocolTimeoutMs, resolveEndpoint));
  try {
    const [imapLogin, smtpLogin] = await Promise.all(probes);
    return { imapLogin, smtpLogin };
  } catch (error) {
    budget.controller.abort(error);
    await Promise.allSettled(probes);
    throw connectionError(error, error.protocol);
  } finally { budget.dispose(); }
}
