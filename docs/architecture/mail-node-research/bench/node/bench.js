// me-bench: opens N ImapFlow clients against the me-bench-dovecot server, one per
// mailbox (userNNN), each doing connect -> mailboxOpen('INBOX') and then relying on
// ImapFlow's built-in auto-IDLE (armed after autoIdleDelay of quiet) — exactly the
// steady state MailExpert's persistent sync connections sit in.
//
// Client options are copied from backend/src/services/imapManager.js makeClientCfg()
// (enableIdle branch), MailExpert's imapflow@2.0.3:
//   logger: false, tls: { rejectUnauthorized }, commandTimeout: 30000,
//   maxIdleTime: 25*60*1000 (default, no idleKeepaliveMs override),
//   autoIdleDelay: AUTO_IDLE_DELAY_MS = 3000.
// The `resolved.lookup`/`autoSelectFamily` branch is skipped: that only fires when
// hostValidation pins resolved addresses, which doesn't apply to a single-address
// container hostname.
//
// Usage: node --expose-gc bench.js <N> [holdSeconds]
// Env: BENCH_HOST (default me-bench-dovecot), BENCH_PORT (default 993),
//      BENCH_CONCURRENCY (default 20)

import { ImapFlow } from 'imapflow';

const N = Number.parseInt(process.argv[2] ?? '0', 10);
const HOLD_SECONDS = Number.parseInt(process.argv[3] ?? '60', 10);
const HOST = process.env.BENCH_HOST || 'me-bench-dovecot';
const PORT = Number.parseInt(process.env.BENCH_PORT || '993', 10);
const CONCURRENCY = Number.parseInt(process.env.BENCH_CONCURRENCY || '20', 10);

function makeClientCfg(user, pass) {
  return {
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: false },
    commandTimeout: 30000,
    maxIdleTime: 25 * 60 * 1000,
    autoIdleDelay: 3000,
  };
}

function userFor(i) {
  return `user${String(i).padStart(3, '0')}`;
}

async function connectOne(i) {
  const user = userFor(i);
  const client = new ImapFlow(makeClientCfg(user, 'benchpass1'));
  client.on('error', (err) => {
    console.error(`[client ${i}] error: ${err.message}`);
  });
  await client.connect();
  await client.mailboxOpen('INBOX');
  return client;
}

// Small fixed-concurrency ramp, mirroring MailExpert's DEFAULT_CONNECT_CONCURRENCY (3)
// but a bit higher so N=500 doesn't take forever to ramp up in a benchmark run.
async function connectAll(n, concurrency) {
  const clients = [];
  let next = 1;
  let failures = 0;
  async function worker() {
    while (next <= n) {
      const i = next++;
      try {
        clients.push(await connectOne(i));
      } catch (err) {
        failures++;
        console.error(`[client ${i}] connect failed: ${err.message}`);
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, Math.max(n, 1)) }, worker);
  await Promise.all(workers);
  return { clients, failures };
}

function snapshotMemory(label) {
  if (global.gc) {
    global.gc();
    global.gc();
  }
  const mem = process.memoryUsage();
  console.log(`MEM ${label} ${JSON.stringify(mem)}`);
  return mem;
}

async function main() {
  console.log(`BENCH_START N=${N} host=${HOST}:${PORT} concurrency=${CONCURRENCY} pid=${process.pid}`);
  snapshotMemory('baseline_before_connect');

  const t0 = Date.now();
  const { clients, failures } = await connectAll(N, CONCURRENCY);
  const connectMs = Date.now() - t0;
  console.log(`CONNECTED count=${clients.length} failures=${failures} connectMs=${connectMs}`);

  // Let auto-IDLE arm (autoIdleDelay=3000ms) and let the process settle before the first
  // measurement; then hold per the task's "after 60 seconds have passed" requirement.
  await new Promise((r) => setTimeout(r, HOLD_SECONDS * 1000));

  snapshotMemory(`after_hold_${HOLD_SECONDS}s`);
  console.log(`READY_FOR_EXTERNAL_SAMPLING pid=${process.pid} count=${clients.length}`);

  // Hold well past any external sampling window (run-one.sh force-removes the container
  // once it has what it needs, rather than racing this timer) so `docker stats`/`docker
  // top` never sample mid-teardown.
  await new Promise((r) => setTimeout(r, 180 * 1000));

  snapshotMemory('final');
  console.log('BENCH_DONE');

  // Best-effort graceful logout; do not let a slow/hung logout block process exit.
  await Promise.race([
    Promise.allSettled(clients.map((c) => c.logout().catch(() => {}))),
    new Promise((r) => setTimeout(r, 10000)),
  ]);
  process.exit(0);
}

main().catch((err) => {
  console.error('BENCH_FATAL', err);
  process.exit(1);
});
