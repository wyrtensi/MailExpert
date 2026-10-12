import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
import { pool } from '../db.js';
import { withAccountAddressLock } from './connection.js';
const client = { query: vi.fn(), release: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); pool.connect.mockResolvedValue(client); client.query.mockResolvedValue({ rows: [{ acquired: true }] }); });
it('oauth_uses_existing_transaction_client', async () => {
  await withAccountAddressLock(' Team@Example.com ', async c => { expect(c).toBe(client); }, { client });
  expect(pool.connect).not.toHaveBeenCalled();
  expect(client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', ['account-address:team@example.com']);
  expect(client.release).not.toHaveBeenCalled();
});
it('node_session_lock_matches_oauth', async () => {
  await withAccountAddressLock(' TEAM@example.com ', async () => {});
  expect(client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', ['account-address:team@example.com']);
  expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock(hashtext($1))', ['account-address:team@example.com']);
  expect(client.release).toHaveBeenCalled();
});
it('bounded_lock_wait', async () => {
  client.query.mockResolvedValue({ rows: [{ acquired: false }] });
  await expect(withAccountAddressLock('team@example.com', async () => {}, { timeoutMs: 15 })).rejects.toMatchObject({ code: 'connection_timeout' });
  expect(client.release).toHaveBeenCalled();
});
it('aborted waiter never executes work', async () => {
  const run = vi.fn();
  await expect(withAccountAddressLock('team@example.com', run, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'connection_cancelled' });
  expect(run).not.toHaveBeenCalled();
});


it('bounds pool acquisition and releases a late reserved client', async () => {
  let releasePool;
  pool.connect.mockImplementationOnce(() => new Promise(resolve => { releasePool = resolve; }));
  await expect(withAccountAddressLock('team@example.com', async () => {}, {timeoutMs: 10})).rejects.toMatchObject({code:'connection_timeout'});
  releasePool(client);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(client.release).toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});
it('bounds a stalled lock query and destroys its reserved connection', async () => {
  client.query.mockImplementationOnce(() => new Promise(() => {}));
  await expect(withAccountAddressLock('team@example.com', async () => {}, {timeoutMs: 10})).rejects.toMatchObject({code:'connection_timeout'});
  expect(client.release).toHaveBeenCalledWith(true);
});
