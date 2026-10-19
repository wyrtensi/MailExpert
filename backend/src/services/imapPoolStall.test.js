// What frees a pooled connection whose command never gets a reply?
//
// imapflow has no per-command timeout; a server that read a command and never answered it is
// bounded only by socketTimeout, 5 minutes of silence. withFreshClient's duration race
// (POOLED_OPERATION_TIMEOUT_MS and friends) bounds how long an operation may RUN, but a whole-folder
// pass is allowed 5 minutes, and with a pool of one (Yahoo) a dead socket under it held the
// account's only slot for all of that. The lease's idle timer (POOL_STALL_TIMEOUT_MS) bounds how
// long a leased connection may receive NOTHING, which a healthy connection never does for long.
//
// These run a REAL ImapFlow against a local fake server, because the idle timer leans on imapflow
// internals (client.socket, client.socketTimeout) and on its socket-timeout handler: it has to
// tell an overdue command from a quiet but healthy session. An upgrade that moves those
// internals fails here. Socket timers cannot be faked, so time is scaled instead:
// socket.setTimeout(POOL_STALL_TIMEOUT_MS) becomes STALL_MS, and every other interval in these
// tests is the same fraction of its real value (SCALE).
// (upstream maathimself/mailflow@13790f8c, @7fb20acc)

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import net from 'node:net';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
vi.mock('./oauth/tokenManager.js', async (importOriginal) => ({
  OAuthTokenError: (await importOriginal()).OAuthTokenError,
  ensureFreshOAuthAccount: vi.fn(async account => account),
}));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import { ImapManager, withFreshClient, evictPool, isConnectionRefusal, POOL_STALL_TIMEOUT_MS, SLOW_COMMAND_STALL_TIMEOUT_MS } from './imapManager.js';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const STALL_MS = 150;
const SCALE = STALL_MS / POOL_STALL_TIMEOUT_MS; // real 45s -> 150ms
const scaled = (realMs) => Math.round(realMs * SCALE);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Just enough IMAP for imapflow to log in, select INBOX, fetch and append.
// stallFetch: a FETCH is read and never answered, like a hung server.
// trickleFetch: { everyMs, forMs } — the server works on a FETCH for forMs, sending an untagged
//   progress line every everyMs (null forMs: forever), then answers it.
// resetFetch: the connection is reset instead.
// appendAckMs: delays the reply to an APPEND whose message has arrived in full.
// ignoreNoop: a NOOP is read and never answered.
function startFakeImap() {
  const state = { ignoreNoop: false, stallFetch: false, trickleFetch: null, resetFetch: false, appendAckMs: 0, appended: 0, commands: [], connections: 0, sockets: new Set(), timers: new Set() };
  const server = net.createServer((socket) => {
    state.connections += 1;
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1] fake ready\r\n');
    let buffered = '';
    let literal = null; // an APPEND whose message is arriving: { tag, remaining }
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1');
      for (;;) {
        if (literal?.remaining > 0) {
          const taken = Math.min(literal.remaining, buffered.length);
          literal.remaining -= taken;
          buffered = buffered.slice(taken);
          if (literal.remaining > 0) return;
        }
        const end = buffered.indexOf('\r\n');
        if (end < 0) return;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (literal) {
          // The CRLF that ends the APPEND command after its message.
          const { tag } = literal;
          literal = null;
          state.appended += 1;
          setTimeout(() => { if (!socket.destroyed) socket.write(`${tag} OK [APPENDUID 1 7] done\r\n`); }, state.appendAckMs);
          continue;
        }
        const [tag, command = '', sub = ''] = line.split(' ');
        const verb = command.toUpperCase() === 'UID' ? sub.toUpperCase() : command.toUpperCase();
        state.commands.push(verb);
        if (verb === 'SELECT' || verb === 'EXAMINE') {
          socket.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 2] ok\r\n* FLAGS (\\Seen)\r\n${tag} OK [READ-WRITE] done\r\n`);
        } else if (verb === 'LIST') {
          socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
        } else if (verb === 'FETCH') {
          const answer = `* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n${tag} OK done\r\n`;
          if (state.resetFetch) { socket.resetAndDestroy(); return; }
          if (state.trickleFetch) {
            const { everyMs, forMs } = state.trickleFetch;
            const started = Date.now();
            const timer = setInterval(() => {
              if (socket.destroyed) { clearInterval(timer); state.timers.delete(timer); return; }
              if (forMs != null && Date.now() - started >= forMs) {
                clearInterval(timer);
                state.timers.delete(timer);
                socket.write(answer);
                return;
              }
              socket.write('* OK still working\r\n');
            }, everyMs);
            state.timers.add(timer);
            continue;
          }
          if (!state.stallFetch) socket.write(answer);
        } else if (verb === 'APPEND') {
          literal = { tag, remaining: Number(/\{(\d+)\}$/.exec(line)[1]) };
          socket.write('+ go ahead\r\n');
        } else if (verb === 'NOOP' && state.ignoreNoop) {
          // read, never answered
        } else if (verb === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK done\r\n`);
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  });
  return { server, state };
}

let fake;
let ACCOUNT;
const realSetTimeout = net.Socket.prototype.setTimeout;

beforeAll(async () => {
  fake = startFakeImap();
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  ACCOUNT = {
    id: 'acct-stall',
    user_id: 'u1',
    imap_host: '127.0.0.1',
    imap_port: fake.server.address().port,
    imap_tls: false,
    imap_skip_tls_verify: false,
    auth_user: 'user',
    auth_pass: 'enc',
    enabled: true,
  };
  vi.spyOn(net.Socket.prototype, 'setTimeout').mockImplementation(function (ms, ...rest) {
    const scaledMs = ms === POOL_STALL_TIMEOUT_MS ? STALL_MS : ms === SLOW_COMMAND_STALL_TIMEOUT_MS ? scaled(SLOW_COMMAND_STALL_TIMEOUT_MS) : ms;
    return realSetTimeout.call(this, scaledMs, ...rest);
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => fake.server.close(resolve));
});

beforeEach(() => {
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [] });
  Object.assign(fake.state, { ignoreNoop: false, stallFetch: false, trickleFetch: null, resetFetch: false, appendAckMs: 0, appended: 0, commands: [], connections: 0 });
  // connectImapClient logs every client 'error'; a stall is expected to be one.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  evictPool(ACCOUNT.id);
  for (const timer of fake.state.timers) clearInterval(timer);
  fake.state.timers.clear();
  for (const socket of fake.state.sockets) socket.destroy();
  console.error.mockRestore();
  console.warn.mockRestore();
  console.log.mockRestore();
});

const fetchFlags = async (client) => {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const rows = [];
    for await (const msg of client.fetch('1', { uid: true, flags: true }, { uid: true })) rows.push(msg.uid);
    return rows;
  } finally {
    lock.release();
  }
};

const IDLE_ERROR = `IMAP command timed out: nothing received for ${POOL_STALL_TIMEOUT_MS / 1000}s`;

describe('pooled command that gets no reply', () => {
  it('is cut off at the idle timeout, named for it, and the slot serves the next caller', async () => {
    expect(POOL_STALL_TIMEOUT_MS).toBe(45000);
    fake.state.stallFetch = true;
    let stalledClient;
    const started = Date.now();
    const outcome = await Promise.race([
      withFreshClient(ACCOUNT, (client) => { stalledClient = client; return fetchFlags(client); })
        .then(() => 'answered', (err) => err),
      sleep(3000).then(() => 'still waiting'),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(STALL_MS * 10);
    expect(stalledClient.usable).toBe(false);
    // Named for what was measured, 'timed out' (fetchMessageBody retries that), and never as
    // imapflow's 'Connection not available', which would read as the provider refusing us.
    expect(outcome.message).toBe(IDLE_ERROR);
    expect(isConnectionRefusal(outcome.message)).toBe(false);

    fake.state.stallFetch = false;
    let nextClient;
    const rows = await withFreshClient(ACCOUNT, (client) => { nextClient = client; return fetchFlags(client); });
    expect(rows).toEqual([1]);
    expect(nextClient).not.toBe(stalledClient);
    expect(fake.state.connections).toBe(2);
  });

  it('keeps a command that receives something every 10s for 4 minutes', async () => {
    fake.state.trickleFetch = { everyMs: scaled(10_000), forMs: scaled(4 * 60_000) };
    let leased;
    const rows = await withFreshClient(ACCOUNT, (client) => { leased = client; return fetchFlags(client); });
    expect(rows).toEqual([1]);
    expect(leased.usable).toBe(true);
    expect(fake.state.connections).toBe(1);
  });

  it('leaves the duration cap as the outer bound: a command that keeps receiving is cut at timeoutMs', async () => {
    fake.state.trickleFetch = { everyMs: scaled(10_000), forMs: null };
    let leased;
    const timeoutMs = scaled(2 * 60_000);
    const started = Date.now();
    const outcome = await withFreshClient(ACCOUNT, (client) => { leased = client; return fetchFlags(client); }, { timeoutMs })
      .then(() => 'answered', (err) => err);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).toBe(`Pooled IMAP operation timeout (${timeoutMs}ms)`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(timeoutMs - 5);
    // The same eviction as ever: the session is out of the pool and closed.
    await sleep(20);
    expect(leased.usable).toBe(false);
  });

  it('keeps a lease that is quiet while holding a mailbox lock, and still cuts a stall after it', async () => {
    // Between two commands (a DB write, say) nothing is owed, so a quiet socket is no stall:
    // imapflow answers the timer with a NOOP rather than closing.
    const seen = {};
    const outcome = await Promise.race([
      withFreshClient(ACCOUNT, async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          await sleep(STALL_MS * 4);
          seen.usable = client.usable;
          seen.noop = fake.state.commands.includes('NOOP');
          fake.state.stallFetch = true;
          for await (const msg of client.fetch('1', { uid: true, flags: true }, { uid: true })) seen.row = msg.uid;
        } finally {
          lock.release();
        }
      }).then(() => 'answered', (err) => err),
      sleep(3000).then(() => 'still waiting'),
    ]);

    expect(seen).toEqual({ usable: true, noop: true });
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).toBe(IDLE_ERROR);
  });

  it('does not call a connection dropped for another reason a timeout', async () => {
    fake.state.resetFetch = true;
    const outcome = await withFreshClient(ACCOUNT, fetchFlags).then(() => 'answered', (err) => err);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).not.toMatch(/timed out/);
  });
});

describe('the lease puts the normal timeout back', () => {
  // An unused pooled connection with no mailbox selected is closed when its timer fires, so
  // leaving the idle timeout on it would throw away pooled sessions and cost fresh logins.
  it.each([
    ['ends normally', async () => {}],
    ['throws', async () => { throw new Error('caller failed'); }],
  ])('when the lease %s, and a reused session starts from it', async (label, body) => {
    let leased;
    let socket;
    let during;
    await withFreshClient(ACCOUNT, async (client) => {
      leased = client;
      socket = client.socket;
      during = socket.timeout;
      return body();
    }).catch(() => {});
    expect(during).toBe(STALL_MS);
    // Restored on the socket before the release (which, after a throw, evicts and closes it).
    expect(socket.timeout).toBe(leased.socketTimeout);
    expect(leased.usable).toBe(label === 'ends normally');

    if (leased.usable) {
      // A session the pool kept: no idle timer while unused, one again on the next lease, and
      // no listener left behind by the first.
      const errorListeners = leased.listenerCount('error');
      await sleep(STALL_MS * 4);
      expect(leased.usable).toBe(true);
      let reused;
      let reusedDuring;
      await withFreshClient(ACCOUNT, async (client) => { reused = client; reusedDuring = client.socket.timeout; });
      expect(reused).toBe(leased);
      expect(reusedDuring).toBe(STALL_MS);
      expect(reused.socket.timeout).toBe(reused.socketTimeout);
      expect(reused.listenerCount('error')).toBe(errorListeners);
    }
  });

  it('does not put the idle timer on the NOOP that refreshes a reused session', async () => {
    // A reused session with a mailbox selected is NOOPed before it is handed out; that probe has
    // its own 5s bound and runs before the lease, on the normal timeout.
    let first;
    await withFreshClient(ACCOUNT, async (client) => { first = client; await client.getMailboxLock('INBOX').then(l => l.release()); });
    const timeoutsAtNoop = [];
    const run = first.run.bind(first);
    first.run = (command, ...rest) => {
      if (command === 'NOOP') timeoutsAtNoop.push(first.socket.timeout);
      return run(command, ...rest);
    };
    await withFreshClient(ACCOUNT, async (client) => { expect(client).toBe(first); });
    expect(timeoutsAtNoop).toEqual([first.socketTimeout]);
  });
});

describe('opting out of the idle timer', () => {
  it('leaves an APPEND on the normal timeout, because the server is quiet while it stores the message', async () => {
    // Node counts an upload as activity only while part of it is still queued in the process,
    // so the tail draining from the kernel's send buffer, and the server storing the message,
    // are silence to the timer. Here the server takes 3x the idle timeout to acknowledge.
    fake.state.appendAckMs = STALL_MS * 3;
    const manager = Object.create(ImapManager.prototype);
    const result = await manager.appendToFolder(ACCOUNT, 'Sent', Buffer.from('Subject: hi\r\n\r\nhello\r\n'), ['\\Seen']);
    expect(result).toEqual({ uid: 7, folder: 'Sent' });
    expect(fake.state.appended).toBe(1);
  });

  it('stallTimeout: false keeps a quiet command alive past the idle timeout', async () => {
    fake.state.trickleFetch = { everyMs: STALL_MS * 3, forMs: STALL_MS * 3 };
    const rows = await withFreshClient(ACCOUNT, fetchFlags, { stallTimeout: false });
    expect(rows).toEqual([1]);
  });
});

describe('a quiet lease whose keepalive NOOP gets no answer', () => {
  it('is cut off within about two idle timeouts', async () => {
    // Holding a lock, the session is quiet for a reason, so the first timeout sends a NOOP. A dead
    // server never answers it; the next timeout finds that NOOP stuck and closes the session.
    fake.state.ignoreNoop = true;
    let leased;
    let closedAfter = null;
    const started = Date.now();
    const outcome = await withFreshClient(ACCOUNT, async (client) => {
      leased = client;
      client.once('close', () => { closedAfter = Date.now() - started; });
      const lock = await client.getMailboxLock('INBOX');
      try {
        await sleep(STALL_MS * 4);
        return await fetchFlags(client);
      } finally {
        lock.release();
      }
    }).then(() => 'answered', (err) => err);
    expect(fake.state.commands).toContain('NOOP');
    expect(closedAfter).not.toBeNull();
    expect(closedAfter).toBeLessThan(STALL_MS * 3);
    expect(leased.usable).toBe(false);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).toBe(IDLE_ERROR);
  });
});

describe('a numeric stallTimeout', () => {
  const slowError = `IMAP command timed out: nothing received for ${SLOW_COMMAND_STALL_TIMEOUT_MS / 1000}s`;

  it('is the idle limit for that lease: quiet past the default survives, quiet past it is cut', async () => {
    expect(SLOW_COMMAND_STALL_TIMEOUT_MS).toBe(120000);
    const slowMs = scaled(SLOW_COMMAND_STALL_TIMEOUT_MS);
    // Silent for twice the default idle limit, under the slow one: answered.
    fake.state.trickleFetch = { everyMs: STALL_MS * 2, forMs: STALL_MS * 2 };
    let during;
    const rows = await withFreshClient(ACCOUNT, (client) => { during = client.socket.timeout; return fetchFlags(client); },
      { stallTimeout: SLOW_COMMAND_STALL_TIMEOUT_MS });
    expect(rows).toEqual([1]);
    expect(during).toBe(slowMs);

    // Silent for good: cut at the slow limit, and the error names it.
    fake.state.trickleFetch = null;
    fake.state.stallFetch = true;
    const started = Date.now();
    const outcome = await withFreshClient(ACCOUNT, fetchFlags, { stallTimeout: SLOW_COMMAND_STALL_TIMEOUT_MS })
      .then(() => 'answered', (err) => err);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).toBe(slowError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(slowMs - 5);
  });
});

describe('ending a lease whose socket is already gone', () => {
  it('does not touch a destroyed socket', async () => {
    let socket;
    await withFreshClient(ACCOUNT, async (client) => {
      socket = client.socket;
      socket.destroy();
      await sleep(10);
    }).catch(() => {});
    expect(socket.destroyed).toBe(true);
    const spy = net.Socket.prototype.setTimeout;
    const callsOnIt = spy.mock.contexts.filter(c => c === socket).length;
    // Once by imapflow at connect, once by the lease at its start; none after the destroy.
    expect(callsOnIt).toBe(2);
  });
});

describe('which pooled work takes the longer idle limit', () => {
  // The spy records the limit asked for, before scaling.
  const limitsSet = () => net.Socket.prototype.setTimeout.mock.calls.map(([ms]) => ms);
  it.each([
    ['findUidByMessageId (header SEARCH)', (m) => m.findUidByMessageId(ACCOUNT, 'INBOX', '<a@x>')],
    ['findMessageIdInFolders (header SEARCH per folder)', (m) => m.findMessageIdInFolders(ACCOUNT, ['INBOX'], '<a@x>')],
    ['markAllReadImap (chunked STORE)', (m) => m.markAllReadImap(ACCOUNT, 'INBOX')],
    ['emptyFolder (chunked STORE and EXPUNGE)', (m) => m.emptyFolder(ACCOUNT, 'INBOX')],
  ])('%s', async (_label, run) => {
    net.Socket.prototype.setTimeout.mockClear();
    const manager = Object.create(ImapManager.prototype);
    await run(manager).catch(() => {});
    expect(limitsSet()).toContain(SLOW_COMMAND_STALL_TIMEOUT_MS);
    expect(limitsSet()).not.toContain(POOL_STALL_TIMEOUT_MS);
  });
});
