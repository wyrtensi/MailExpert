// The flag-push reconciler's marker handling against a real (in-process) Postgres engine: the
// re-assert returns the marker it wrote as text, and the clear removes only that marker. A mock
// cannot show that the text round-trips with its microseconds, or that a newer marker survives.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const dbState = { query: null };
vi.mock('./db.js', () => ({ query: (...args) => dbState.query(...args) }));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));

const { ImapManager } = await import('./imapManager.js');
const { _reassertFlagPush, _clearFlagMarker } = ImapManager.prototype;

const M1 = '20000000-0000-0000-0000-000000000001';
let pglite;

beforeAll(async () => {
  pglite = await PGlite.create();
  dbState.query = (sql, params) => pglite.query(sql, params);
  await pglite.query(`CREATE TABLE messages (
    id uuid PRIMARY KEY,
    is_read boolean NOT NULL DEFAULT false,
    read_changed_at timestamptz,
    is_starred boolean NOT NULL DEFAULT false,
    star_changed_at timestamptz
  )`);
});
afterAll(async () => { await pglite.close(); });
beforeEach(async () => {
  await pglite.query('DELETE FROM messages');
  await pglite.query('INSERT INTO messages (id) VALUES ($1)', [M1]);
});

const row = async () => (await pglite.query('SELECT is_read, read_changed_at::text AS read_at, is_starred, star_changed_at::text AS star_at FROM messages WHERE id = $1', [M1])).rows[0];

describe('flag-push marker', () => {
  it('re-asserts the value and returns the marker it wrote as text', async () => {
    const marker = await _reassertFlagPush.call({}, { messageId: M1, flag: '\\Seen', value: true });
    const r = await row();
    expect(r.is_read).toBe(true);
    expect(marker).toBe(r.read_at);                      // text, not a Date that drops microseconds
    await _clearFlagMarker.call({}, M1, '\\Seen', marker);
    expect((await row()).read_at).toBeNull();
  });

  it('matches a marker to the microsecond', async () => {
    await pglite.query("UPDATE messages SET read_changed_at = '2026-09-26 10:00:00.123456+00' WHERE id = $1", [M1]);
    const { rows: [{ marker }] } = await pglite.query('SELECT read_changed_at::text AS marker FROM messages WHERE id = $1', [M1]);
    await _clearFlagMarker.call({}, M1, '\\Seen', new Date(Date.parse(marker)).toISOString()); // milliseconds only
    expect((await row()).read_at).not.toBeNull();
    await _clearFlagMarker.call({}, M1, '\\Seen', marker);
    expect((await row()).read_at).toBeNull();
  });

  it('keeps a newer marker a route wrote after the re-assert', async () => {
    const marker = await _reassertFlagPush.call({}, { messageId: M1, flag: '\\Flagged', value: true });
    expect((await row()).is_starred).toBe(true);
    // The user unstars: the route writes its value and a newer marker.
    await pglite.query("UPDATE messages SET is_starred = false, star_changed_at = star_changed_at + interval '1 microsecond' WHERE id = $1", [M1]);

    await _clearFlagMarker.call({}, M1, '\\Flagged', marker);

    expect((await row()).star_at).not.toBeNull();
  });

  it('clears its own marker', async () => {
    const marker = await _reassertFlagPush.call({}, { messageId: M1, flag: '\\Flagged', value: true });
    await _clearFlagMarker.call({}, M1, '\\Flagged', marker);
    expect((await row()).star_at).toBeNull();
  });

  it('returns no marker for a letter that is gone, and the clear is then unconditional', async () => {
    await pglite.query('DELETE FROM messages');
    expect(await _reassertFlagPush.call({}, { messageId: M1, flag: '\\Seen', value: true })).toBeNull();
    await pglite.query("INSERT INTO messages (id, read_changed_at) VALUES ($1, NOW())", [M1]);
    await _clearFlagMarker.call({}, M1, '\\Seen', null);
    expect((await row()).read_at).toBeNull();
  });
});
