// POST /messages/:id/snooze against a real (in-process) Postgres. A message moved out of
// Snoozed by hand keeps its snooze record until the wake-up sweep removes it, a few minutes
// after its wake time; until then the record must not refuse a new snooze, and the new snooze
// must be the only record so the old wake time cannot wake the message early.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const dbState = { query: null };
vi.mock('../services/db.js', () => ({ query: (...args) => dbState.query(...args) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: '00000000-0000-4000-8000-0000000000aa' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    // The real one answers the server path the folder has (a managed Proton mailbox: Folders/Snoozed).
    ensureFolder: vi.fn(async (_account, folder) => ({ path: folder, created: false })),
    moveMessage: vi.fn(async () => 500),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
  },
}));

const express = (await import('express')).default;
const mailRoutes = (await import('./mail.js')).default;
const { imapManager } = await import('../index.js');
const { ImapManager } = await import('../services/imapManager.js');

const ACCOUNT = '00000000-0000-4000-8000-00000000000a';
const MSG = '10000000-0000-4000-8000-000000000001';

let db;
let server;
let base;

beforeAll(async () => {
  db = new PGlite();
  dbState.query = async (text, params) => db.query(text, params);
  await db.exec(`
    CREATE TABLE email_accounts (id uuid PRIMARY KEY, name text, folder_mappings jsonb, enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE folders (account_id uuid NOT NULL, path text NOT NULL, name text NOT NULL,
                          delimiter varchar(10), special_use text, no_select boolean NOT NULL DEFAULT false,
                          total_count int NOT NULL DEFAULT 0, unread_count int NOT NULL DEFAULT 0);
    CREATE TABLE messages (
      id uuid PRIMARY KEY, uid int, folder text NOT NULL, message_id text, thread_id text,
      in_reply_to text, thread_references text, is_read boolean NOT NULL DEFAULT true,
      account_id uuid NOT NULL, is_deleted boolean NOT NULL DEFAULT false, read_changed_at timestamptz
    );
    CREATE TABLE snoozed_messages (
      id serial PRIMARY KEY, snoozed_by uuid, account_id uuid NOT NULL, message_id_header text NOT NULL,
      original_folder text NOT NULL, snooze_until timestamptz NOT NULL, snoozed_folder text NOT NULL
    );
  `);
  await db.query("INSERT INTO email_accounts (id, name) VALUES ($1, 'sales')", [ACCOUNT]);

  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await db?.close();
});

beforeEach(async () => {
  await db.exec('DELETE FROM messages; DELETE FROM snoozed_messages;');
});

const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
const snooze = (until) => fetch(`${base}/api/mail/messages/${MSG}/snooze`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until }),
});
const records = async () => (await db.query(
  'SELECT message_id_header, snooze_until FROM snoozed_messages ORDER BY id'
)).rows;

describe('POST /api/mail/messages/:id/snooze in Postgres', () => {
  it('snoozes again a message moved out of Snoozed by hand, replacing the leftover record', async () => {
    // Snoozed earlier until tomorrow, then moved back to INBOX by hand.
    await db.query(`INSERT INTO messages (id, uid, folder, message_id, account_id) VALUES ($1, 7, 'INBOX', '<a@x>', $2)`, [MSG, ACCOUNT]);
    await db.query(`INSERT INTO snoozed_messages (account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
      VALUES ($1, '<a@x>', 'INBOX', $2, 'Snoozed')`, [ACCOUNT, inDays(1)]);

    const until = inDays(3);
    const res = await snooze(until);
    expect(res.status).toBe(200);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].snooze_until).toISOString()).toBe(until);
  });

  it('still refuses a message whose snooze is live, i.e. that sits in its Snoozed folder', async () => {
    // A second row of the same letter is still in Snoozed under its live record.
    await db.query(`INSERT INTO messages (id, uid, folder, message_id, account_id) VALUES ($1, 7, 'INBOX', '<a@x>', $2)`, [MSG, ACCOUNT]);
    await db.query(`INSERT INTO messages (id, uid, folder, message_id, account_id)
      VALUES ('10000000-0000-4000-8000-000000000002', 8, 'Snoozed', '<a@x>', $1)`, [ACCOUNT]);
    await db.query(`INSERT INTO snoozed_messages (account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
      VALUES ($1, '<a@x>', 'INBOX', $2, 'Snoozed')`, [ACCOUNT, inDays(1)]);

    const res = await snooze(inDays(3));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Message is already snoozed');
    expect(await records()).toHaveLength(1);
  });

  it('snooze_uses_translated_path_through_wakeup', async () => {
    // A managed Proton mailbox keeps user folders under Folders/: ensureFolder answers that path.
    imapManager.ensureFolder.mockImplementationOnce(async () => ({ path: 'Folders/Snoozed', created: true }));
    imapManager.moveMessage.mockClear();
    await db.query(`INSERT INTO messages (id, uid, folder, message_id, account_id, is_read) VALUES ($1, 7, 'INBOX', '<p@x>', $2, false)`, [MSG, ACCOUNT]);

    const res = await snooze(inDays(2));

    expect(res.status).toBe(200);
    expect(imapManager.ensureFolder).toHaveBeenLastCalledWith(expect.objectContaining({ id: ACCOUNT }), 'Snoozed', { resolvePath: true });
    expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), 7, 'INBOX', 'Folders/Snoozed');
    expect((await db.query('SELECT folder, uid FROM messages WHERE id = $1', [MSG])).rows).toEqual([{ folder: 'Folders/Snoozed', uid: 500 }]);
    expect((await db.query('SELECT original_folder, snoozed_folder FROM snoozed_messages')).rows)
      .toEqual([{ original_folder: 'INBOX', snoozed_folder: 'Folders/Snoozed' }]);

    // The snooze is live where the letter really is: a second snooze is refused.
    imapManager.ensureFolder.mockImplementationOnce(async () => ({ path: 'Folders/Snoozed', created: false }));
    const again = await snooze(inDays(3));
    expect(again.status).toBe(400);

    // Wake-up finds the letter in Folders/Snoozed and moves it back from there.
    await db.query(`UPDATE snoozed_messages SET snooze_until = now() - interval '1 minute'`);
    const engine = {
      _secondaryLoginBlocked: () => false, _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), broadcast: vi.fn(),
      moveMessageGetNewUid: vi.fn(async () => 900), setFlag: vi.fn(async () => {}),
    };
    await ImapManager.prototype._runSnoozeWakeup.call(engine);
    expect(engine.moveMessageGetNewUid).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), 500, 'Folders/Snoozed', 'INBOX', { background: true });
    expect((await db.query('SELECT folder, uid FROM messages WHERE id = $1', [MSG])).rows).toEqual([{ folder: 'INBOX', uid: 900 }]);
    expect(await records()).toEqual([]);
  });

  it('refuses a letter already in the translated Snoozed folder', async () => {
    imapManager.ensureFolder.mockImplementationOnce(async () => ({ path: 'Folders/Snoozed', created: false }));
    imapManager.moveMessage.mockClear();
    await db.query(`INSERT INTO messages (id, uid, folder, message_id, account_id) VALUES ($1, 7, 'Folders/Snoozed', '<q@x>', $2)`, [MSG, ACCOUNT]);
    const res = await snooze(inDays(2));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Message is already in Snoozed folder');
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });
});

// The sweep reads every due snooze first and wakes them one by one, each over IMAP. The reader can
// move a letter out of Snoozed by hand in between; waking it then would move a UID that is no
// longer there and count the letter back into its folder a second time.
describe('snooze wakeup sweep in Postgres', () => {
  it('wakes a snooze only while it is still live when its turn comes', async () => {
    const second = '10000000-0000-4000-8000-000000000002';
    await db.query(`INSERT INTO messages (id, uid, folder, message_id, account_id) VALUES ($1, 7, 'Snoozed', '<a@x>', $2)`, [MSG, ACCOUNT]);
    await db.query(`INSERT INTO messages (id, uid, folder, message_id, account_id) VALUES ($1, 8, 'Snoozed', '<b@x>', $2)`, [second, ACCOUNT]);
    await db.query(`INSERT INTO snoozed_messages (account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
      VALUES ($1, '<a@x>', 'INBOX', now() - interval '1 minute', 'Snoozed'), ($1, '<b@x>', 'INBOX', now() - interval '1 minute', 'Snoozed')`, [ACCOUNT]);
    const engine = {
      _secondaryLoginBlocked: () => false, _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), broadcast: vi.fn(),
      setFlag: vi.fn(async () => {}),
      // While one letter wakes, the reader moves the other one to Archive by hand.
      moveMessageGetNewUid: vi.fn(async (_account, uid) => {
        await db.query(`UPDATE messages SET folder = 'Archive' WHERE folder = 'Snoozed' AND uid <> $1`, [uid]);
        return 900;
      }),
    };
    await ImapManager.prototype._runSnoozeWakeup.call(engine);
    expect(engine.moveMessageGetNewUid).toHaveBeenCalledTimes(1);
    expect((await db.query('SELECT folder FROM messages ORDER BY folder')).rows.map(r => r.folder)).toEqual(['Archive', 'INBOX']);
    // The letter moved by hand keeps its record for the orphan cleanup; the woken one's is gone.
    expect(await records()).toHaveLength(1);
    expect(engine.broadcast).toHaveBeenCalledTimes(1);
  });
});
