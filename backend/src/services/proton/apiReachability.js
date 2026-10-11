import https from 'node:https';

// Bridge answers a wrong password and a missing network alike (USERNAME_PASSWORD_ERROR, seen in
// Task 4 under --network none), so a refused login is told apart by asking whether the Proton API
// answers at all. The backend shares the worker's network namespace, so its view of the network is
// Bridge's. The host is the one compiled into the pinned Bridge (https://mail.proton.me/api) and
// /tests/ping is its connectivity endpoint. Any HTTP answer over verified TLS means reachable.
export const PROTON_API_PING = 'https://mail.proton.me/api/tests/ping';

export function isProtonApiReachable({ url = PROTON_API_PING, timeoutMs = 5000, signal, request = https.request } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let req;
    const finish = reachable => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      req?.destroy();
      resolve(reachable);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { finish(false); return; }
    try {
      req = request(url, { method: 'GET', agent: false, headers: { Accept: 'application/json' } }, response => {
        response.resume();
        finish(true);
      });
    } catch {
      finish(false);
      return;
    }
    req.on('error', () => finish(false));
    req.end();
  });
}
