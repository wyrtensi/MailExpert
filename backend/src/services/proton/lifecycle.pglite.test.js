import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRealSchemaDb } from '../testing/realSchema.js';

// Deleting managed Proton mailboxes through the shared deletion, and the durable cleanup job,
// against the real schema and job queue. The worker is a fake with the worker's link semantics
// (deploy/proton-worker/controller.py remove_user): one link per (user, address), the native user
// goes with its last link, and its removal is confirmed separately from the request.
const state = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({
  query: (sql, p) => state.db.query(sql, p),
  pool: { connect: async () => ({ query: (sql, p) => state.db.query(sql, p), release() {} }) },
  withTransaction: fn => state.db.transaction(tx => fn({ query: (sql, p) => tx.query(sql, p) })),
}));
vi.mock('./workerClient.js', () => ({ callWorker: vi.fn() }));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn() }));

const { callWorker } = await import('./workerClient.js');
const { deleteAccount } = await import('../accounts/deleteAccount.js');
const { claimDueJobs, runJob, jobKind } = await import('../jobQueue.js');
const {
  PROTON_CLEANUP_KIND, PROTON_CLEANUP_MAX_ATTEMPTS, registerProtonJobKinds, pruneOrphanProtonUsers, protonCleanupOutstanding,
} = await import('./lifecycle.js');

const ACTOR = '73000000-0000-4000-8000-000000000001';
const NATIVE = 'bmF0aXZlLXVzZXI=';
const failure = code => Object.assign(new Error(code), { code });

let worker;
function fakeWorker() {
  const fake = {
    links: new Map(), native: new Set(), removed: [], confirm: true, down: false,
    link(userId, email, generation) { fake.native.add(userId); fake.links.set(`${userId}|${email}`, generation); },
    async call(method, path, body) {
      if (fake.down) throw failure('worker_unavailable');
      const match = /^\/users\/([^/]+)\/remove$/.exec(path);
      if (method !== 'POST' || !match) throw failure('worker_invalid_request');
      const userId = decodeURIComponent(match[1]);
      const key = `${userId}|${body.email}`;
      if (!fake.links.has(key)) return { userId, state: fake.native.has(userId) && fake.removed.includes(userId) ? 'removing' : 'removed' };
      if (fake.links.get(key) !== body.generation) throw failure('generation_mismatch');
      fake.links.delete(key);
      if ([...fake.links.keys()].some(other => other.startsWith(`${userId}|`))) return { userId, state: 'unlinked' };
      fake.removed.push(userId);
      if (fake.confirm) fake.native.delete(userId);
      return { userId, state: fake.native.has(userId) ? 'removing' : 'removed' };
    },
  };
  return fake;
}

const cleanupJobs = async () => (await state.db.query(`SELECT * FROM jobs WHERE kind = $1 ORDER BY id`, [PROTON_CLEANUP_KIND])).rows;
const nativeRow = async (userId = NATIVE) => (await state.db.query('SELECT * FROM proton_users WHERE proton_user_id = $1', [userId])).rows[0];
async function runDue() {
  const claimed = await claimDueJobs(10);
  for (const job of claimed) await runJob(job);
  return claimed.length;
}
const makeDue = () => state.db.query(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);

async function linkedMailbox(email, { userId = NATIVE, generation = null } = {}) {
  await state.db.query('INSERT INTO proton_users (proton_user_id, generation) VALUES ($1, COALESCE($2, gen_random_uuid())) ON CONFLICT DO NOTHING', [userId, generation]);
  const { rows: [{ generation: current }] } = await state.db.query('SELECT generation FROM proton_users WHERE proton_user_id = $1', [userId]);
  const { rows: [account] } = await state.db.query(`INSERT INTO email_accounts (name, email_address, imap_host, imap_port, smtp_host, smtp_port, mail_provider, connection_mode, imap_tls_mode)
    VALUES ('Team', $1, '127.0.0.1', 1993, '127.0.0.1', 1465, 'proton', 'managed', 'implicit') RETURNING id, email_address`, [email]);
  await state.db.query(`INSERT INTO proton_mailbox_links (account_id, proton_user_id, generation, certificate_pem, certificate_fingerprint, tls_servername)
    VALUES ($1, $2, $3, 'pem', 'fingerprint', '127.0.0.1')`, [account.id, userId, current]);
  worker.link(userId, email.toLowerCase(), current);
  return { account, generation: current };
}

beforeAll(async () => {
  state.db = await createRealSchemaDb();
  await state.db.query(`INSERT INTO users (id, username) VALUES ($1, 'actor')`, [ACTOR]);
  registerProtonJobKinds();
}, 120000);
afterAll(async () => { await state.db.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await state.db.exec(`DROP TRIGGER IF EXISTS refuse_delete ON email_accounts;
    DELETE FROM jobs; DELETE FROM proton_connections; DELETE FROM email_accounts; DELETE FROM proton_users;`);
  worker = fakeWorker();
  callWorker.mockImplementation((...args) => worker.call(...args));
});

describe('deleting managed Proton mailboxes', () => {
  it('deleting_one_of_two_linked_addresses_keeps_native_user', async () => {
    const first = await linkedMailbox('box@proton.me');
    const second = await linkedMailbox('alias@proton.me');
    await deleteAccount(first.account, { actor: { userId: ACTOR } });

    const [job] = await cleanupJobs();
    expect(job.payload).toEqual({ userId: NATIVE, generation: first.generation, email: 'box@proton.me' });
    expect((await nativeRow()).cleanup_pending).toBe(false);
    expect(await runDue()).toBe(1);
    expect(callWorker).toHaveBeenCalledWith('POST', `/users/${NATIVE}/remove`, { generation: first.generation, email: 'box@proton.me' }, expect.any(Object));
    expect(worker.removed).toEqual([]); // the native user still serves the other address
    expect((await cleanupJobs())[0].status).toBe('done');
    expect(await nativeRow()).toBeDefined();
    expect((await state.db.query('SELECT proton_user_id FROM proton_mailbox_links WHERE account_id = $1', [second.account.id])).rows).toEqual([{ proton_user_id: NATIVE }]);
  });

  it('last_link_enqueues_cleanup_atomically', async () => {
    const { account, generation } = await linkedMailbox('box@proton.me');
    await deleteAccount(account, { actor: { userId: ACTOR } });
    const jobs = await cleanupJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'queued', max_attempts: PROTON_CLEANUP_MAX_ATTEMPTS, account_id: null });
    expect(jobs[0].payload).toEqual({ userId: NATIVE, generation, email: 'box@proton.me' });
    expect(JSON.stringify(jobs[0].payload)).not.toMatch(/pass|pem|secret/i);
    expect((await nativeRow()).cleanup_pending).toBe(true);
    expect(await protonCleanupOutstanding({ query: (sql, p) => state.db.query(sql, p) }, NATIVE)).toBe(true);
  });

  it('a failed deletion leaves neither the deletion nor the job', async () => {
    const { account } = await linkedMailbox('box@proton.me');
    await state.db.exec(`CREATE OR REPLACE FUNCTION refuse_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_delete BEFORE DELETE ON email_accounts FOR EACH ROW EXECUTE FUNCTION refuse_delete();`);
    await expect(deleteAccount(account, { actor: { userId: ACTOR } })).rejects.toThrow('refused');
    expect(await cleanupJobs()).toHaveLength(0);
    expect((await state.db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(1);
    expect((await nativeRow()).cleanup_pending).toBe(false);
  });

  it('offline_worker_leaves_cleanup_pending', async () => {
    const { account, generation } = await linkedMailbox('box@proton.me');
    await deleteAccount(account, { actor: { userId: ACTOR } });
    worker.down = true;
    await runDue();
    let [job] = await cleanupJobs();
    expect(job).toMatchObject({ status: 'queued', attempts: 1, error_code: 'worker_unavailable', dedupe_key: `${PROTON_CLEANUP_KIND}:${account.id}` });
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now());
    expect((await nativeRow()).cleanup_pending).toBe(true);

    // The worker answers, but Bridge has not confirmed the removal: the lock stays.
    worker.down = false;
    worker.confirm = false;
    await makeDue();
    await runDue();
    [job] = await cleanupJobs();
    expect(job).toMatchObject({ status: 'queued', attempts: 2, error_code: 'removal_pending' });
    expect(worker.removed).toEqual([NATIVE]);
    expect((await nativeRow()).cleanup_pending).toBe(true);

    // Removal event and GetUserList absence: the same job finishes and the user row goes.
    worker.native.delete(NATIVE);
    await makeDue();
    await runDue();
    [job] = await cleanupJobs();
    expect(job).toMatchObject({ status: 'done', payload: { userId: NATIVE, generation, email: 'box@proton.me' } });
    expect(await nativeRow()).toBeUndefined();
    expect(await cleanupJobs()).toHaveLength(1);
  });

  it('old_generation_cannot_remove_readded_user', async () => {
    const { account } = await linkedMailbox('box@proton.me');
    await deleteAccount(account, { actor: { userId: ACTOR } });
    // The cleanup ran, then its job is run again (an at-least-once retry after the user came back).
    await runDue();
    const [first] = await cleanupJobs();
    expect(first.status).toBe('done');
    const readded = await linkedMailbox('box@proton.me');
    await state.db.query(`UPDATE jobs SET status = 'queued', run_at = now(), finished_at = NULL WHERE id = $1`, [first.id]);
    callWorker.mockClear();
    await runDue();
    const [staleJob] = await cleanupJobs();
    expect(staleJob.status).toBe('done');
    expect(callWorker).not.toHaveBeenCalled(); // another linked address or stale generation
    expect(worker.links.get(`${NATIVE}|box@proton.me`)).toBe(readded.generation);
    expect(readded.generation).not.toBe(first.payload.generation);
  });

  it('a worker that holds another generation fails the job and keeps the lock', async () => {
    const { account } = await linkedMailbox('box@proton.me');
    worker.links.set(`${NATIVE}|box@proton.me`, randomUUID());
    await deleteAccount(account, { actor: { userId: ACTOR } });
    await runDue();
    expect((await cleanupJobs())[0]).toMatchObject({ status: 'failed', error_code: 'generation_mismatch' });
    expect(worker.removed).toEqual([]);
    expect((await nativeRow()).cleanup_pending).toBe(true);
  });

  it('registers the cleanup kind with endless retries', () => {
    expect(jobKind(PROTON_CLEANUP_KIND)).toMatchObject({ maxAttempts: PROTON_CLEANUP_MAX_ATTEMPTS });
  });
});

describe('orphan native user rows', () => {
  it('deletes rows nothing links, keeps those an attempt, a link or a cleanup still holds', async () => {
    const ids = ['b3JwaGFu', 'bGl2ZQ==', 'bGlua2Vk', 'cGVuZGluZw==', 'cXVldWVk', 'c3RhbGU='];
    const [orphan, live, linked, pending, queued, stale] = ids;
    for (const id of [orphan, live, pending, queued, stale]) await state.db.query('INSERT INTO proton_users (proton_user_id) VALUES ($1)', [id]);
    await linkedMailbox('box@proton.me', { userId: linked });
    await state.db.query('UPDATE proton_users SET cleanup_pending = true WHERE proton_user_id = $1', [pending]);
    await state.db.query(`INSERT INTO proton_connections (actor_user_id, request_id, requested_email, state, proton_user_id, expires_at)
      VALUES ($1, $2, 'a@proton.me', 'checking', $3, now() + interval '5 minutes'),
             ($1, $4, 'b@proton.me', 'checking', $5, now() - interval '5 minutes')`, [ACTOR, randomUUID(), live, randomUUID(), stale]);
    await state.db.query(`INSERT INTO jobs (kind, payload) VALUES ($1, $2::jsonb)`, [PROTON_CLEANUP_KIND, JSON.stringify({ userId: queued, generation: randomUUID(), email: 'q@proton.me' })]);
    expect(await pruneOrphanProtonUsers()).toBe(2);
    const { rows } = await state.db.query('SELECT proton_user_id FROM proton_users ORDER BY proton_user_id');
    expect(rows.map(row => row.proton_user_id).sort()).toEqual([live, linked, pending, queued].sort());
    expect(await pruneOrphanProtonUsers()).toBe(0);
  });
});
