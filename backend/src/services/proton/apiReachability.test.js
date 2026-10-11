import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { PROTON_API_PING, isProtonApiReachable } from './apiReachability.js';

let server;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  server = undefined;
});
async function listen(handler) {
  server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/api/tests/ping`;
}

it('pings the API host Bridge uses', () => {
  expect(PROTON_API_PING).toBe('https://mail.proton.me/api/tests/ping');
});

it('any HTTP answer means the API is reachable', async () => {
  const url = await listen((_req, res) => { res.statusCode = 422; res.end('{}'); });
  expect(await isProtonApiReachable({ url, request: http.request })).toBe(true);
});

it('a refused connection or a silent server is unreachable within the budget', async () => {
  const url = await listen(() => {});
  const startedAt = Date.now();
  expect(await isProtonApiReachable({ url, request: http.request, timeoutMs: 100 })).toBe(false);
  expect(Date.now() - startedAt).toBeLessThan(2000);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  server = undefined;
  expect(await isProtonApiReachable({ url, request: http.request, timeoutMs: 1000 })).toBe(false);
});
