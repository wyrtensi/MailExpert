// The body prefetch loop's per-letter read against a real (in-process) Postgres engine: which
// letters it fetches and stores. A mock cannot show that the join drops a disabled or deleted
// mailbox's letters, or which row the loop reads.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const dbState = { query: null };
vi.mock('./db.js', () => ({ query: (...args) => dbState.query(...args) }));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));

const { ImapManager } = await import('./imapManager.js');

const ACCOUNT = '30000000-0000-0000-0000-000000000001';
const letter = n => `40000000-0000-0000-0000-00000000000${n}`;
let pglite;

beforeAll(async () => {
  pglite = await PGlite.create();
  dbState.query = (sql, params) => pglite.query(sql, params);
  await pglite.query(`CREATE TABLE email_accounts (
    id uuid PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT true
  )`);
  await pglite.query(`CREATE TABLE messages (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    uid bigint NOT NULL,
    folder text NOT NULL,
    body_html text,
    body_text text,
    attachments jsonb,
    snippet text,
    is_deleted boolean NOT NULL DEFAULT false
  )`);
});
afterAll(async () => { await pglite.close(); });

beforeEach(async () => {
  await pglite.query('DELETE FROM messages');
  await pglite.query('DELETE FROM email_accounts');
  await pglite.query('INSERT INTO email_accounts (id) VALUES ($1)', [ACCOUNT]);
  for (const n of [1, 2, 3]) {
    await pglite.query('INSERT INTO messages (id, account_id, uid, folder) VALUES ($1, $2, $3, $4)', [letter(n), ACCOUNT, 100 + n, 'INBOX']);
  }
});

const account = { id: ACCOUNT, imap_host: 'mail.example.com', mail_node: true };
const queued = [1, 2, 3].map(n => ({ id: letter(n), uid: 100 + n, folder: 'INBOX' }));

const manager = () => {
  const mgr = Object.create(ImapManager.prototype);
  mgr._prefetchGeneration = new Map();
  mgr.lastUserActivity = new Map();
  mgr._secondaryLoginBlocked = () => null;
  mgr.fetchMessageBody = vi.fn(async (_a, uid) => ({ html: null, text: `Body of ${uid}`, attachments: [] }));
  return mgr;
};
const run = mgr => ImapManager.prototype._prefetchBodyLoop.call(mgr, account, queued, { waitForQuiet: false });
const stored = async () => (await pglite.query('SELECT uid::int AS uid FROM messages WHERE body_text IS NOT NULL ORDER BY uid')).rows.map(r => r.uid);

describe('body prefetch reads each letter before fetching it', () => {
  it('fetches and stores the letters of an enabled mailbox', async () => {
    const mgr = manager();
    await run(mgr);
    expect(mgr.fetchMessageBody.mock.calls.map(c => c[1])).toEqual([101, 102, 103]);
    expect(await stored()).toEqual([101, 102, 103]);
  });

  it('fetches nothing of a mailbox disabled meanwhile: no login a node could only reject', async () => {
    await pglite.query('UPDATE email_accounts SET enabled = false');
    const mgr = manager();
    await run(mgr);
    expect(mgr.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('fetches nothing of a mailbox deleted meanwhile', async () => {
    await pglite.query('DELETE FROM email_accounts');
    const mgr = manager();
    await run(mgr);
    expect(mgr.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('skips a letter a click has already fetched', async () => {
    await pglite.query("UPDATE messages SET body_text = 'opened' WHERE id = $1", [letter(2)]);
    const mgr = manager();
    await run(mgr);
    expect(mgr.fetchMessageBody.mock.calls.map(c => c[1])).toEqual([101, 103]);
  });
});
