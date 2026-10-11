import http from 'node:http';

const SAFE_CODES = new Set([
  'login_busy', 'invalid_credentials', 'verification_required', 'invalid_challenge',
  'not_connected', 'not_found', 'generation_mismatch', 'address_mismatch',
  'worker_unavailable', 'worker_invalid_request', 'operation_conflict',
]);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

export function createWorkerClient({ socketPath = '/run/mailexpert-proton/worker.sock' } = {}) {
  return async function callWorker(method, path, body, { signal, timeoutMs = 15000 } = {}) {
    if (!['GET', 'POST'].includes(method) || typeof path !== 'string' ||
        !/^\/(?:healthz|connections(?:\/[a-zA-Z0-9_-]+(?:\/(?:continue|commit|cancel))?)?|users\/[a-zA-Z0-9_-]+\/(?:credentials|remove))$/.test(path) ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
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
      const request = http.request({ socketPath, method, path, agent: false,
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
