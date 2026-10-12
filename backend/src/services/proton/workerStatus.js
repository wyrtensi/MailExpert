import { existsSync } from 'node:fs';
import { callWorker as defaultCallWorker, PROTON_WORKER_SOCKET } from './workerClient.js';

// What GET /api/integrations/status says about the managed Proton worker: whether it is installed
// (its private socket exists), and whether it answers a health check now. The answer holds a
// stable code only, never a path or the worker's own text. Concurrent readers share one check, and
// a fresh answer is reused for a moment, so the add-account dialogs of a team do not each hit the
// worker.
const STATUS_TTL_MS = 2000;

export function createProtonStatus({
  socketPath = PROTON_WORKER_SOCKET,
  exists = existsSync,
  callWorker = defaultCallWorker,
  timeoutMs = 2000,
  ttlMs = STATUS_TTL_MS,
} = {}) {
  let inFlight = null;
  let cached = null;
  let cachedAt = 0;

  async function read() {
    if (!exists(socketPath)) return { configured: false, available: false, code: 'proton_unavailable' };
    try {
      await callWorker('GET', '/healthz', undefined, { timeoutMs });
      return { configured: true, available: true, code: null };
    } catch {
      return { configured: true, available: false, code: 'proton_unavailable' };
    }
  }

  return function getProtonStatus() {
    if (cached && Date.now() - cachedAt < ttlMs) return Promise.resolve({ ...cached });
    if (!inFlight) {
      inFlight = read().then((status) => {
        cached = status;
        cachedAt = Date.now();
        return status;
      }).finally(() => { inFlight = null; });
    }
    return inFlight.then((status) => ({ ...status }));
  };
}

export const getProtonStatus = createProtonStatus();
