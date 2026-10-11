// Test-only fake of the private worker API (deploy/proton-worker/worker.py) after Task 4 review:
// operations by ID, commit {userId, generation}, credentials {operationId}. Secrets the backend
// must never echo carry the 'secret-sentinel' marker.
import { loopbackCertificate, workerFingerprint } from './mailEndpoint.fixtures.js';

const failure = code => Object.assign(new Error(code), { code });

export function createFakeWorker() {
  const certificatePem = loopbackCertificate().cert;
  const fake = {
    operations: new Map(),
    calls: [],
    logins: 0,
    busy: false,
    down: false,
    commitGate: null,
    certificatePem,
    credentialsEmail: null,
    credentials(operation) {
      return {
        userId: operation.userId, email: fake.credentialsEmail ?? operation.email,
        bridgePassword: 'bridge-secret-sentinel', certificatePem,
        certificateFingerprint: workerFingerprint(certificatePem), tlsServername: '127.0.0.1',
        grpcToken: 'grpc-secret-sentinel',
      };
    },
    // Native login finished and split mode confirmed for this operation.
    connect(id, userId, { createdByAttempt = true } = {}) {
      Object.assign(fake.operations.get(id), { state: 'connected', userId, createdByAttempt, errorCode: null });
    },
    set(id, patch) { Object.assign(fake.operations.get(id), patch); },
    paths(suffix) { return fake.calls.filter(call => call.path.endsWith(suffix)); },
    async call(method, path, body) {
      fake.calls.push({ method, path, body });
      if (fake.down) throw failure('worker_unavailable');
      let match;
      if (method === 'POST' && path === '/connections') {
        if (fake.busy) throw failure('login_busy');
        fake.logins++;
        const operation = { id: body.operationId, email: body.email, state: 'authenticating', userId: null, createdByAttempt: false, errorCode: null, committed: false };
        fake.operations.set(operation.id, operation);
        return view(operation);
      }
      if ((match = /^\/connections\/([^/]+)$/.exec(path))) return view(get(match[1]));
      if ((match = /^\/connections\/([^/]+)\/continue$/.exec(path))) {
        const operation = get(match[1]);
        operation.state = 'authenticating';
        return view(operation);
      }
      if ((match = /^\/connections\/([^/]+)\/cancel$/.exec(path))) {
        const operation = get(match[1]);
        if (!operation.committed && !['failed', 'cancelled', 'expired'].includes(operation.state)) operation.state = 'cancelled';
        return view(operation);
      }
      if ((match = /^\/connections\/([^/]+)\/commit$/.exec(path))) {
        const operation = get(match[1]);
        if (fake.commitGate) await fake.commitGate;
        if (operation.state !== 'connected' || operation.userId !== body.userId) throw failure('not_connected');
        operation.committed = true;
        return view(operation);
      }
      if ((match = /^\/users\/([^/]+)\/credentials$/.exec(path))) {
        const operation = get(body.operationId);
        if (operation.state !== 'connected' || operation.userId !== match[1]) throw failure('not_connected');
        return fake.credentials(operation);
      }
      throw failure('worker_invalid_request');
    },
  };
  const get = id => {
    const operation = fake.operations.get(id);
    if (!operation) throw failure('not_found');
    return operation;
  };
  const view = ({ id, state, userId, createdByAttempt, errorCode }) => ({ id, state, userId, createdByAttempt, errorCode });
  return fake;
}

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
