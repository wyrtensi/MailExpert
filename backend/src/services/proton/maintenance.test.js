import { describe, expect, it, vi } from 'vitest';
import { ProtonMaintenanceError, withProtonSendLease } from './maintenance.js';

const MANAGED = { id: 'a1', mail_provider: 'proton', connection_mode: 'managed' };

function worker(...answers) {
  const calls = [];
  const callWorker = vi.fn(async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === 'DELETE') return { released: true };
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { ...next, leaseId: body.leaseId };
  });
  return { calls, callWorker };
}

const LEASE = () => 'abc123';
const busy = () => Object.assign(new Error('maintenance_busy'), { code: 'maintenance_busy' });

describe('withProtonSendLease', () => {
  it('passes ordinary mailboxes straight through without the worker', async () => {
    const { callWorker } = worker();
    const result = await withProtonSendLease({ id: 'a2', mail_provider: 'gmail' }, async () => 'sent', { callWorker });
    expect(result).toBe('sent');
    expect(callWorker).not.toHaveBeenCalled();
  });

  it('holds one lease around the whole send and releases it afterwards', async () => {
    const { calls, callWorker } = worker({ leaseId: 'abc123' });
    const result = await withProtonSendLease(MANAGED, async () => {
      calls.push('send');
      return 'sent';
    }, { callWorker, newLeaseId: LEASE });
    expect(result).toBe('sent');
    expect(calls).toEqual(['POST /leases/send', 'send', 'DELETE /leases/abc123']);
  });

  it('releases the lease when the send fails, and rethrows the send error unchanged', async () => {
    const { calls, callWorker } = worker({ leaseId: 'abc123' });
    const failure = Object.assign(new Error('uncertain'), { definite: false });
    await expect(withProtonSendLease(MANAGED, async () => { throw failure; }, { callWorker, newLeaseId: LEASE })).rejects.toBe(failure);
    expect(calls).toEqual(['POST /leases/send', 'DELETE /leases/abc123']);
  });

  it('waits out a snapshot before the effect, then sends once', async () => {
    const { calls, callWorker } = worker(busy(), busy(), { leaseId: 'abc123' });
    const fn = vi.fn(async () => 'sent');
    const sleep = vi.fn(async () => {});
    expect(await withProtonSendLease(MANAGED, fn, { callWorker, sleep, waitMs: 10_000, pollMs: 1000 })).toBe('sent');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(calls.filter(call => call === 'POST /leases/send')).toHaveLength(3);
  });

  it('gives up before the effect when maintenance outlasts the wait; the send never starts', async () => {
    const { callWorker } = worker(busy(), busy(), busy(), busy());
    const fn = vi.fn();
    let now = 0;
    const sleep = async (ms) => { now += ms; };
    await expect(withProtonSendLease(MANAGED, fn, { callWorker, sleep, waitMs: 2500, pollMs: 1000, now: () => now }))
      .rejects.toBeInstanceOf(ProtonMaintenanceError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('an unavailable worker stops the send before the effect', async () => {
    const { callWorker } = worker(Object.assign(new Error('worker_unavailable'), { code: 'worker_unavailable' }));
    const fn = vi.fn();
    await expect(withProtonSendLease(MANAGED, fn, { callWorker })).rejects.toMatchObject({
      name: 'ProtonMaintenanceError', code: 'worker_unavailable',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('a failed release is logged without details and never turns a sent letter into a failure', async () => {
    const callWorker = vi.fn(async (method) => {
      if (method === 'DELETE') throw Object.assign(new Error('worker_unavailable'), { code: 'worker_unavailable' });
      return { leaseId: 'abc123' };
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await withProtonSendLease(MANAGED, async () => 'sent', { callWorker, newLeaseId: LEASE })).toBe('sent');
    expect(callWorker.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(2);
    expect(error.mock.calls.join(' ')).not.toContain('abc123');
    error.mockRestore();
  });

  it('names the lease itself, keeps the name across maintenance retries, and cancels it when it gives up', async () => {
    const requests = [];
    const callWorker = vi.fn(async (method, path, body) => {
      requests.push([method, path, body?.leaseId]);
      if (method === 'DELETE') return { released: false };
      if (requests.length === 1) throw busy();
      throw Object.assign(new Error('worker_timeout'), { code: 'worker_timeout' });
    });
    const fn = vi.fn();
    await expect(withProtonSendLease(MANAGED, fn, { callWorker, sleep: async () => {}, newLeaseId: () => 'lease0001' }))
      .rejects.toMatchObject({ name: 'ProtonMaintenanceError', code: 'worker_unavailable' });
    expect(fn).not.toHaveBeenCalled();
    // The worker may still grant the timed-out request: the DELETE cancels it, by the same name.
    expect(requests).toEqual([
      ['POST', '/leases/send', 'lease0001'], ['POST', '/leases/send', 'lease0001'], ['DELETE', '/leases/lease0001', undefined],
    ]);
  });

  it('a busy gate that outlasts the wait needs no cancel: nothing was granted', async () => {
    const { calls, callWorker } = worker(busy(), busy());
    let now = 0;
    await expect(withProtonSendLease(MANAGED, vi.fn(), {
      callWorker, sleep: async (ms) => { now += ms; }, waitMs: 1500, pollMs: 1000, now: () => now,
    })).rejects.toMatchObject({ code: 'maintenance_busy' });
    expect(calls.filter(call => call.startsWith('DELETE'))).toEqual([]);
  });
});
