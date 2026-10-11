import { randomUUID } from 'node:crypto';
import { callWorker as defaultCallWorker } from './workerClient.js';
import { isManagedProtonAccount } from './mailEndpoint.js';

// The snapshot admission gate of the managed Proton worker, seen from the backend.
//
// A backup stops native Bridge to capture its state (/snapshot/begin in the worker, driven by the
// host's backup.sh). Every actual send of a managed Proton mailbox runs inside a send lease the
// worker hands out (POST /leases/send) and takes back (DELETE /leases/:id): the snapshot waits for
// the leases to drain and refuses new ones while it holds the gate.
//
// withProtonSendLease(account, fn) wraps the whole send, from before the caller's
// markEffectStarted to after its SQL completion, so a snapshot never sees a send half recorded.
// While the gate is closed it waits (maintenance_busy) and retries the lease only: fn has not run,
// nothing irreversible happened. Once fn runs, its outcome is the caller's, unchanged: a lease never
// turns an accepted or unknown delivery into a retry. A lease has no time limit; a release that
// fails leaves it with the worker until the worker is recreated after this backend stopped.
//
// The backend names each lease. A request it gave up on (a timeout while the worker was busy) may
// still be granted later, so the name is cancelled with DELETE: the worker remembers the cancel and
// refuses that late grant.

export const MAINTENANCE_WAIT_MS = 120_000;
export const MAINTENANCE_POLL_MS = 2_000;

export class ProtonMaintenanceError extends Error {
  constructor(code) {
    super(code === 'maintenance_busy'
      ? 'Proton maintenance (a backup) is in progress; the letter was not sent yet'
      : 'The Proton worker is unavailable; the letter was not sent yet');
    this.name = 'ProtonMaintenanceError';
    this.code = code;
  }
}

const delay = (ms) => new Promise(resolve => { setTimeout(resolve, ms); });

async function acquire(leaseId, { callWorker, sleep, waitMs, pollMs, now }) {
  const deadline = now() + waitMs;
  for (;;) {
    let answer;
    try {
      answer = await callWorker('POST', '/leases/send', { leaseId }, { timeoutMs: 15_000 });
    } catch (err) {
      if (err?.code !== 'maintenance_busy') {
        // Refused for good, or the outcome is unknown: cancel the name either way.
        await release(callWorker, leaseId);
        throw new ProtonMaintenanceError('worker_unavailable');
      }
      if (now() + pollMs > deadline) throw new ProtonMaintenanceError('maintenance_busy');
      await sleep(pollMs);
      continue;
    }
    if (answer?.leaseId !== leaseId) {
      await release(callWorker, leaseId);
      throw new ProtonMaintenanceError('worker_unavailable');
    }
    return leaseId;
  }
}

async function release(callWorker, leaseId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await callWorker('DELETE', `/leases/${leaseId}`, undefined, { timeoutMs: 15_000 });
      return;
    } catch (err) {
      if (attempt === 1) {
        // The lease stays with the worker: a snapshot reports busy until the worker is recreated.
        console.error(`[proton] Releasing a send lease failed (${err?.code || 'error'}); backups wait for a worker restart`);
      }
    }
  }
}

export async function withProtonSendLease(account, fn, {
  callWorker = defaultCallWorker, sleep = delay, waitMs = MAINTENANCE_WAIT_MS, pollMs = MAINTENANCE_POLL_MS,
  now = Date.now, newLeaseId = () => randomUUID().replace(/-/g, ''),
} = {}) {
  if (!isManagedProtonAccount(account)) return fn();
  const leaseId = await acquire(newLeaseId(), { callWorker, sleep, waitMs, pollMs, now });
  try {
    return await fn();
  } finally {
    await release(callWorker, leaseId);
  }
}
