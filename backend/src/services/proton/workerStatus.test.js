import { describe, it, expect, vi } from 'vitest';
import { createProtonStatus } from './workerStatus.js';

const SOCKET = '/run/example-worker/worker.sock';

function build({ socket = true, health = async () => ({ state: 'idle' }) } = {}) {
  const callWorker = vi.fn(health);
  return { callWorker, getStatus: createProtonStatus({ socketPath: SOCKET, exists: () => socket, callWorker, timeoutMs: 40 }) };
}

describe('Proton worker status for the integration status API', () => {
  it('is available when the worker answers its health check', async () => {
    const { getStatus, callWorker } = build();
    expect(await getStatus()).toEqual({ configured: true, available: true, code: null });
    expect(callWorker).toHaveBeenCalledWith('GET', '/healthz', undefined, expect.objectContaining({ timeoutMs: 40 }));
  });

  it('is configured but unavailable with a stable code when the worker fails', async () => {
    const { getStatus } = build({ health: async () => { throw Object.assign(new Error(`connect ENOENT ${SOCKET}`), { code: 'worker_unavailable' }); } });
    const status = await getStatus();
    expect(status).toEqual({ configured: true, available: false, code: 'proton_unavailable' });
    expect(JSON.stringify(status)).not.toContain(SOCKET);
  });

  it('is not configured, and the worker is not called, without the worker socket', async () => {
    const { getStatus, callWorker } = build({ socket: false });
    expect(await getStatus()).toEqual({ configured: false, available: false, code: 'proton_unavailable' });
    expect(callWorker).not.toHaveBeenCalled();
  });

  it('shares one health check between concurrent status reads', async () => {
    const { getStatus, callWorker } = build({ health: () => new Promise((resolve) => setTimeout(() => resolve({ state: 'idle' }), 10)) });
    const [a, b] = await Promise.all([getStatus(), getStatus()]);
    expect(a).toEqual(b);
    expect(callWorker).toHaveBeenCalledTimes(1);
  });

  it('answers within the timeout when the worker hangs', async () => {
    const { getStatus } = build({ health: (_m, _p, _b, options) => new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(new Error('late'), { code: 'worker_timeout' })), options.timeoutMs)) });
    const started = Date.now();
    expect((await getStatus()).available).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
