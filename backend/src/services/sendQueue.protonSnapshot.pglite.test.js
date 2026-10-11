// The Proton snapshot admission gate on the real send queue (PGlite, real migrations): a send job of
// a managed Proton mailbox takes the worker's send lease before markEffectStarted and gives it back
// only after the job's SQL completion committed, so a backup's /snapshot/begin drains it whole. A
// maintenance wait retries only before the effect; an unknown SMTP outcome is never sent again.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from './testing/realSchema.js';

const dbState = { db: null };
vi.mock('./db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => null) }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn(), oauthRefreshFailureResult: vi.fn() }));
const worker = vi.hoisted(() => ({ callWorker: null }));
vi.mock('./proton/workerClient.js', () => ({ callWorker: (...args) => worker.callWorker(...args) }));

const { createAccountSmtpTransport } = await import('./smtpTransport.js');
const { enqueueOutgoingSend, registerSendJobKind } = await import('./sendQueue.js');
const { runDueJobs } = await import('./jobQueue.js');

const imapManager = { broadcast: () => {}, syncFolderOnDemand: async () => {}, findUidByMessageId: async () => null };
const PROTON = '40000000-0000-4000-8000-000000000021';
const PLAIN = '40000000-0000-4000-8000-000000000022';
const USER = '42000000-0000-4000-8000-000000000021';
let db;
let events;
let smtpSendMail;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

async function jobRow(id) {
  return (await db.query('SELECT status, effect_started_at, error_code, attempts FROM jobs WHERE id = $1', [id])).rows[0];
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  registerSendJobKind({ imapManager });
  await db.exec('DELETE FROM outgoing_messages; DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM email_accounts; DELETE FROM users;');
  await db.query("INSERT INTO users (id, username) VALUES ($1, 'anna')", [USER]);
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, smtp_host, smtp_port, mail_provider, connection_mode)
     VALUES ($1, 'Proton', 'me@example.com', '127.0.0.1', 1465, 'proton', 'managed'),
            ($2, 'Plain', 'plain@example.com', 'smtp.example.com', 465, 'other', 'manual')`,
    [PROTON, PLAIN]
  );
  events = [];
  smtpSendMail = vi.fn(async () => {
    events.push('smtp');
    return { messageId: '<m@example.com>', accepted: ['you@example.com'], rejected: [] };
  });
  createAccountSmtpTransport.mockImplementation(async (account) => ({ account, transport: { sendMail: smtpSendMail } }));
  worker.callWorker = vi.fn(async (method, path) => {
    events.push(`${method} ${path}`);
    if (method === 'DELETE') {
      const { rows: [job] } = await db.query('SELECT status FROM jobs LIMIT 1');
      events.push(`job ${job.status} at release`);
      return { released: true };
    }
    return { leaseId: 'lease1' };
  });
});

async function enqueue(accountId) {
  const { job } = await enqueueOutgoingSend({
    userId: USER,
    accountId,
    compose: { to: ['you@example.com'], subject: 'Test' },
    mail: {
      options: { from: 'me@example.com', to: ['you@example.com'], subject: 'Test', text: 'Hello', messageId: '<m@example.com>' },
      meta: { to: ['you@example.com'], cc: [], bcc: [], subject: 'Test', fromEmail: 'me@example.com', snippet: 'Hello' },
    },
  });
  await db.query("UPDATE jobs SET run_at = now() - interval '1 second'");
  return job.id;
}

describe('send queue under the Proton snapshot gate', () => {
  it('takes the lease before the effect and releases it after the completion committed', async () => {
    const id = await enqueue(PROTON);
    await runDueJobs({ wait: true });
    expect(events).toEqual(['POST /leases/send', 'smtp', 'DELETE /leases/lease1', 'job done at release']);
    expect((await jobRow(id)).status).toBe('done');
  });

  it('a snapshot that holds the gate leaves the job queued with no effect started', async () => {
    worker.callWorker = vi.fn(async () => { throw Object.assign(new Error('worker_unavailable'), { code: 'worker_unavailable' }); });
    const id = await enqueue(PROTON);
    await runDueJobs({ wait: true });
    expect(smtpSendMail).not.toHaveBeenCalled();
    const row = await jobRow(id);
    expect(row.status).toBe('queued');
    expect(row.effect_started_at).toBeNull();
    expect(row.error_code).toBe('proton_maintenance');
  });

  it('an unknown SMTP outcome under the lease needs attention and is never sent again', async () => {
    smtpSendMail.mockImplementation(async () => {
      events.push('smtp');
      throw Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION' });
    });
    const id = await enqueue(PROTON);
    await runDueJobs({ wait: true });
    expect(events.filter(event => event === 'smtp')).toHaveLength(1);
    expect(events).toContain('DELETE /leases/lease1');
    const row = await jobRow(id);
    expect(row.effect_started_at).not.toBeNull();
    expect(row.status).toBe('needs_attention');
    await db.query("UPDATE jobs SET run_at = now() - interval '1 second'");
    await runDueJobs({ wait: true });
    expect(smtpSendMail).toHaveBeenCalledTimes(1);
  });

  it('ordinary mailboxes never ask the worker', async () => {
    const id = await enqueue(PLAIN);
    await runDueJobs({ wait: true });
    expect(worker.callWorker).not.toHaveBeenCalled();
    expect((await jobRow(id)).status).toBe('done');
  });
});
