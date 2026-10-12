import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let close;
afterEach(async () => { await close?.(); close = undefined; });

async function fixture(handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proton-client-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\proton-client-${process.pid}-${Date.now()}`
    : path.join(directory, 'worker.sock');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(socketPath, resolve));
  close = async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  };
  return socketPath;
}

describe('private worker client', () => {
  it('uses the private socket and sends JSON without a TCP fallback', async () => {
    let received;
    const socketPath = await fixture((request, response) => {
      received = { method: request.method, url: request.url };
      response.setHeader('Content-Type', 'application/json');
      response.end('{"state":"idle"}');
    });
    const { createWorkerClient } = await import('./workerClient.js');
    const callWorker = createWorkerClient({ socketPath });
    expect(await callWorker('GET', '/healthz')).toEqual({ state: 'idle' });
    expect(received).toEqual({ method: 'GET', url: '/healthz' });
  });

  it('bounds stalled requests with a secret-free timeout', async () => {
    const socketPath = await fixture(() => {});
    const { createWorkerClient } = await import('./workerClient.js');
    await expect(createWorkerClient({ socketPath })('POST', '/connections',
      { password: 'secret-sentinel' }, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'worker_timeout' });
  });

  it('honors caller cancellation', async () => {
    const socketPath = await fixture(() => {});
    const { createWorkerClient } = await import('./workerClient.js');
    const controller = new AbortController();
    const result = createWorkerClient({ socketPath })('GET', '/healthz', undefined, { signal: controller.signal });
    controller.abort('secret-sentinel');
    await expect(result).rejects.toMatchObject({ code: 'worker_cancelled', message: 'worker_cancelled' });
  });

  it('does not expose native error text or unknown worker codes', async () => {
    const socketPath = await fixture((request, response) => {
      response.writeHead(500);
      response.end('{"errorCode":"secret-sentinel","message":"secret-sentinel"}');
    });
    const { createWorkerClient } = await import('./workerClient.js');
    await expect(createWorkerClient({ socketPath })('POST', '/connections', { password: 'secret-sentinel' }))
      .rejects.toMatchObject({ code: 'worker_unavailable', message: 'worker_unavailable' });
  });

  it('percent-encodes a padded base64 Proton user ID in the path', async () => {
    const received = [];
    const socketPath = await fixture((request, response) => {
      received.push(request.url);
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    });
    const { createWorkerClient } = await import('./workerClient.js');
    const callWorker = createWorkerClient({ socketPath });
    const padded = 'aB3-x_Yz9Qw8LmNo+pQrStUvWxYz0123456789AbCd==';
    expect(await callWorker('POST', `/users/${padded}/credentials`, { operationId: 'attempt-a' })).toEqual({ ok: true });
    expect(await callWorker('POST', `/users/${padded}/remove`, { generation: 'g', email: 'a@b.example' })).toEqual({ ok: true });
    expect(received).toEqual([
      '/users/aB3-x_Yz9Qw8LmNo%2BpQrStUvWxYz0123456789AbCd%3D%3D/credentials',
      '/users/aB3-x_Yz9Qw8LmNo%2BpQrStUvWxYz0123456789AbCd%3D%3D/remove',
    ]);
    for (const unsafe of ['a/b', 'a.b', 'a%3D', 'a=b', '=', 'a===', 'x'.repeat(129), '..', 'a b']) {
      await expect(callWorker('POST', `/users/${unsafe}/credentials`, {})).rejects.toMatchObject({ code: 'worker_invalid_request' });
    }
    expect(received).toHaveLength(2);
  });

  it('rejects absolute URLs rather than opening TCP', async () => {
    const { callWorker } = await import('./workerClient.js');
    await expect(callWorker('GET', 'http://127.0.0.1/')).rejects.toMatchObject({ code: 'worker_invalid_request' });
  });
  it('takes and gives back send leases, but never drives the host-only snapshot gate', async () => {
    const received = [];
    const socketPath = await fixture((request, response) => {
      received.push(`${request.method} ${request.url}`);
      response.setHeader('Content-Type', 'application/json');
      response.end(request.method === 'POST' ? '{"leaseId":"abc123"}' : '{"released":true}');
    });
    const { createWorkerClient } = await import('./workerClient.js');
    const callWorker = createWorkerClient({ socketPath });
    expect(await callWorker('POST', '/leases/send')).toEqual({ leaseId: 'abc123' });
    expect(await callWorker('DELETE', '/leases/abc123')).toEqual({ released: true });
    for (const path of ['/snapshot/begin', '/snapshot/end', '/leases/../snapshot/begin']) {
      await expect(callWorker('POST', path, { snapshotId: 'x' })).rejects.toMatchObject({ code: 'worker_invalid_request' });
    }
    await expect(callWorker('PUT', '/leases/send')).rejects.toMatchObject({ code: 'worker_invalid_request' });
    expect(received).toEqual(['POST /leases/send', 'DELETE /leases/abc123']);
  });

  it('passes the maintenance code through as a safe code', async () => {
    const socketPath = await fixture((request, response) => {
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end('{"errorCode":"maintenance_busy"}');
    });
    const { createWorkerClient } = await import('./workerClient.js');
    await expect(createWorkerClient({ socketPath })('POST', '/leases/send')).rejects.toMatchObject({ code: 'maintenance_busy' });
  });
});
