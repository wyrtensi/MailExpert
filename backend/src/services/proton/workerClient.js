import http from 'node:http';

const SAFE_CODES = new Set([
  'login_busy', 'invalid_credentials', 'verification_required', 'invalid_challenge',
  'not_connected', 'not_found', 'generation_mismatch', 'address_mismatch',
  'worker_unavailable', 'worker_invalid_request', 'operation_conflict',
]);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

// Operation IDs (UUIDs) and native Proton user IDs: base64/base64url with optional '=' padding,
// never '/', '.', '%' or whitespace. The worker decodes the percent-encoded path segment and
// checks the same rule before use.
const ID = /^(?=[A-Za-z0-9+_=-]{1,128}$)[A-Za-z0-9+_-]+={0,2}$/;
const ROUTES = [
  /^\/(healthz|connections)()()$/,
  /^\/(connections)\/([^/]+)((?:\/(?:continue|commit|cancel))?)$/,
  /^\/(users)\/([^/]+)(\/(?:credentials|remove))$/,
];

// The request path with its ID percent-encoded, or null for anything outside the worker API.
function workerPath(path) {
  if (typeof path !== 'string') return null;
  for (const route of ROUTES) {
    const match = route.exec(path);
    if (!match) continue;
    const [, resource, id, action] = match;
    if (!id) return `/${resource}`;
    return ID.test(id) ? `/${resource}/${encodeURIComponent(id)}${action}` : null;
  }
  return null;
}

export function createWorkerClient({ socketPath = '/run/mailexpert-proton/worker.sock' } = {}) {
  return async function callWorker(method, path, body, { signal, timeoutMs = 15000 } = {}) {
    const requestPath = workerPath(path);
    if (!['GET', 'POST'].includes(method) || !requestPath || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw failure('worker_invalid_request');
    }
    if (signal?.aborted) throw failure('worker_cancelled');
    let payload;
    try { payload = body === undefined ? undefined : JSON.stringify(body); }
    catch { throw failure('worker_invalid_request'); }
    if (payload && Buffer.byteLength(payload) > 65536) throw failure('worker_invalid_request');
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const request = http.request({ socketPath, method, path: requestPath, agent: false,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      }, response => {
        const chunks = [];
        let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 65536) {
            finish(failure('worker_unavailable'));
            response.destroy();
            request.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', () => finish(failure('worker_unavailable')));
        response.on('end', () => {
          let result;
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { finish(failure('worker_unavailable')); return; }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            finish(failure(SAFE_CODES.has(result?.errorCode) ? result.errorCode : 'worker_unavailable'));
          } else finish(undefined, result);
        });
      });
      const abort = () => {
        finish(failure('worker_cancelled'));
        request.destroy();
      };
      signal?.addEventListener('abort', abort, { once: true });
      request.on('error', () => finish(failure('worker_unavailable')));
      timer = setTimeout(() => {
        finish(failure('worker_timeout'));
        request.destroy();
      }, timeoutMs);
      request.end(payload);
    });
  };
}

export const callWorker = createWorkerClient();
