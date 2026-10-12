import { fork } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ConnectionError } from './connectionErrors.js';

const childFile = fileURLToPath(new URL('./smtpProbeChild.js', import.meta.url));
let activeChildren = 0;

function minimalEnvironment() {
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}

function payload(candidate, endpoint, timeoutMs) {
  const addresses = endpoint?.addresses?.length ? [...endpoint.addresses] : [endpoint?.host];
  if (addresses.some(address => !isIP(address)) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new ConnectionError('server_refused', 'smtp');
  const user = candidate.smtp_auth_user || candidate.auth_user;
  const pass = candidate.smtp_auth_pass || candidate.auth_pass;
  if (typeof user !== 'string' || !user || /[\r\n\0]/.test(user) || typeof pass !== 'string' || !pass) throw new ConnectionError('login_invalid', 'smtp');
  const secure = endpoint.secure ?? candidate.smtp_tls === 'SSL';
  if (typeof secure !== 'boolean') throw new ConnectionError('tls_error', 'smtp');
  return { type: 'probe', endpoint: {
    host: addresses[0], addresses, port: endpoint.port, servername: endpoint.servername || null,
    tls: { ...(endpoint.tls?.ca ? { ca: endpoint.tls.ca } : {}), rejectUnauthorized: true },
    secure, requireTLS: !secure,
  }, auth: { user, pass }, timeoutMs };
}

// Nodemailer's public verify API keeps its socket outside transport.close(). A dedicated
// process gives every terminal path an enforceable cancellation boundary without internals.
export async function probeSmtpInChild(candidate, endpoint, { signal, timeoutMs = 15000 } = {}) {
  if (signal?.aborted) throw new ConnectionError(signal.reason instanceof ConnectionError ? signal.reason.code : 'connection_cancelled', 'smtp');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ConnectionError('connection_timeout', 'smtp');
  const message = payload(candidate, endpoint, timeoutMs);
  if (activeChildren >= 8) throw new ConnectionError('server_refused', 'smtp');
  activeChildren++;
  try {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = fork(childFile, [], { execPath: process.execPath, execArgv: [], env: minimalEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
      } catch { reject(new ConnectionError('smtp_unavailable', 'smtp')); return; }
      let result;
      let terminal = false;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (!terminal) result = new ConnectionError('smtp_unavailable', 'smtp');
        if (result) reject(result); else resolve();
      };
      const finish = error => {
        if (terminal) return;
        terminal = true;
        result = error;
        // Keep the slot until exit, including on success: QUIT may leave a live verify socket.
        if (child.pid) child.kill('SIGKILL');
        // An OS spawn error has no process and therefore never emits exit.
        else settle();
      };
      const abort = () => finish(new ConnectionError(signal?.reason instanceof ConnectionError ? signal.reason.code : 'connection_cancelled', 'smtp'));
      const timer = setTimeout(() => finish(new ConnectionError('connection_timeout', 'smtp')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.once('exit', settle);
      child.on('error', () => finish(new ConnectionError('smtp_unavailable', 'smtp')));
      child.once('message', response => {
        if (response?.ok === true) finish();
        else finish(new ConnectionError(response?.code, 'smtp'));
      });
      if (signal?.aborted) abort();
      else child.send(message, error => { if (error) finish(new ConnectionError('smtp_unavailable', 'smtp')); });
    });
  } finally { activeChildren--; }
}
