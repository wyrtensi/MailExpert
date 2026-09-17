# Gmail threading PR B: backfill Gmail ids for cached messages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill `messages.provider_thread_id` and `messages.provider_message_id` for Gmail rows cached before PR A (and for Sent/Drafts rows written locally after a send or draft save), resumably, with the progress visible per mailbox in the admin panel.

**Architecture:** A background job per Gmail mailbox walks each folder's rows that still lack ids, in batches of 500 UIDs taken from the database, asks Gmail only for `UID X-GM-MSGID X-GM-THRID`, and writes the ids with one `UPDATE ... FROM unnest(...)` per batch. A per-folder cursor `{ lastUid, uidValidity }` in the new table `provider_id_backfill` makes the job resumable; "running" lives only in process memory. The logic lives in `backend/src/services/threading/`; `imapManager.js` supplies the connection, the per-host background budget and the triggers. `thread_id` is not touched: PR C uses these ids to rekey threads. Spec: `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`.

**Tech Stack:** Node 22 ESM, Express 5, PostgreSQL 16, imapflow 1.7.8, vitest (backend); React 19, zustand, react-i18next, `node --test` with jsdom (frontend).

## Global Constraints

- Code, comments, commits and PR text in English; no emoji; commits as `wyrtensi`, no Claude co-author lines.
- The job runs only for accounts whose provider profile has `gmailThreadIds: true` (`providerProfile(account).gmailThreadIds`). Other providers never run it and have `provider_ids_backfill: null` in the API.
- `thread_id`, `thread_key` and every other `messages` column except `provider_thread_id` and `provider_message_id` stay unchanged by this PR.
- A row is "missing ids" when `provider_message_id IS NULL AND is_deleted = false`. The UPDATE only writes rows that are still missing ids, so a known id is never overwritten.
- Ids are accepted only through `gmailProviderIds(msg)` (`backend/src/services/threading/providerIds.js`): decimal strings of 1 to 20 digits. A response without a valid `providerMessageId` writes nothing for that UID.
- Batch size: `PROVIDER_ID_BATCH_SIZE = 500` UIDs per FETCH. FETCH query: `{ uid: true, threadId: true }` with options `{ uid: true }`.
- Migration: `backend/migrations/0062_provider_id_backfill.sql`, table `provider_id_backfill(account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE, cursors JSONB NOT NULL DEFAULT '{}'::jsonb, finished_at TIMESTAMPTZ, error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.
- Cursor shape per folder path: `{ "lastUid": <number>, "uidValidity": <string or null> }`. A cursor whose `uidValidity` differs from `folders.uid_validity` (as a string) is ignored.
- State values returned by `providerIdBackfillState`: `{ status, percent, error }` with `status` one of `not_started`, `running`, `paused`, `done`, `error`.
- WebSocket event: `{ type: 'provider_ids_backfill', accountId, state }`. It must not be added to the `scheduleCountRefresh` list in `broadcast`.
- Background connections come from `this._bgConnSem` keyed by the lowercased `imap_host`, acquired only when the job actually needs IMAP.
- Timers: scheduler `_providerIdSchedulerTimer` every `PROVIDER_ID_SCHEDULER_MS = 10 * 60 * 1000`; nudge after a local Sent/Drafts write `PROVIDER_ID_NUDGE_DELAY_MS = 60 * 1000`.
- Index check: `idx_messages_provider_thread` validity via `pg_index.indisvalid`, states `valid`, `invalid`, `missing`; checked once at startup, warning logged when not `valid`.
- Threading logic lives in `backend/src/services/threading/`; `imapManager.js` keeps only wiring.
- Backend tests: `npx vitest run <files>` from `backend/`. Frontend tests: `node --test <files>` from `frontend/`. The full backend suite runs in Docker (isolated `mailexpert-backend-test` / `mailexpert-pg-test` containers) or CI. Never touch the user's running `mailexpert-*` or other containers.
- Nothing is run against a live Gmail mailbox in this PR.

---

## File Structure

- Create `backend/migrations/0062_provider_id_backfill.sql` — progress table.
- Create `backend/src/services/threading/providerIdBackfillStore.js` — read and write the progress row, derive the admin state.
- Create `backend/src/services/threading/providerIdBackfillStore.test.js`.
- Create `backend/src/services/threading/providerThreadIndex.js` — `providerThreadIndexState(query)`.
- Create `backend/src/services/threading/providerThreadIndex.test.js`.
- Modify `backend/src/index.js` — log the index state after migrations.
- Create `backend/src/services/threading/providerIdBackfill.js` — `uidSet`, `planProviderIdBackfill`, `runProviderIdBackfill`.
- Create `backend/src/services/threading/providerIdBackfill.test.js`.
- Modify `backend/src/services/imapManager.js` — job wiring, scheduler, triggers, state lookup for the API.
- Create `backend/src/services/imapManager.providerIds.test.js`.
- Modify `backend/src/services/imapManager.test.js`, `backend/src/services/imapManager.serverMailboxes.test.js`, `backend/src/services/imapManager.oauthRefresh.test.js` — clear the new timer where the other timers are cleared.
- Modify `backend/src/routes/accounts.js` — `provider_ids_backfill` in `GET /accounts`.
- Create `backend/src/routes/accounts.providerIds.test.js`.
- Modify existing `backend/src/routes/accounts.*.test.js` mocks only where `GET /` now needs `imapManager.providerIdBackfillStates`.
- Create `frontend/src/utils/providerIdsBackfill.js` and `frontend/src/utils/providerIdsBackfill.test.js`.
- Modify `frontend/src/hooks/useWebSocket.js`; create `frontend/src/hooks/useWebSocket.providerIds.test.js`.
- Modify `frontend/src/components/AdminPanel.jsx`.
- Modify `frontend/src/locales/en.json`, `frontend/src/locales/ru.json`.
- Modify `docs/architecture/codebase-file-map.md`, `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`.

---

### Task 1: Progress table, state store and index check

**Files:**
- Create: `backend/migrations/0062_provider_id_backfill.sql`
- Create: `backend/src/services/threading/providerIdBackfillStore.js`
- Create: `backend/src/services/threading/providerIdBackfillStore.test.js`
- Create: `backend/src/services/threading/providerThreadIndex.js`
- Create: `backend/src/services/threading/providerThreadIndex.test.js`
- Modify: `backend/src/index.js` (right after `await runMigrations();`, around line 251)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (every function takes the `query(sql, params)` function from `services/db.js` as its first argument):
  - `loadProviderIdBackfill(query, accountId) -> Promise<{ account_id, cursors, finished_at, error, updated_at } | null>`
  - `saveProviderIdCursor(query, accountId, folder: string, cursor: { lastUid: number, uidValidity: string|null }) -> Promise<void>`
  - `markProviderIdBackfillFinished(query, accountId) -> Promise<void>`
  - `recordProviderIdBackfillError(query, accountId, message) -> Promise<void>`
  - `providerIdBackfillState({ row = null, running = false, progress = null } = {}) -> { status, percent, error }` where `progress` is `{ processed: number, total: number }`
  - `providerThreadIndexState(query) -> Promise<'valid'|'invalid'|'missing'>`

- [ ] **Step 1: Write the failing store tests**

Create `backend/src/services/threading/providerIdBackfillStore.test.js`:

```js
import { describe, expect, it, vi } from 'vitest';
import {
  loadProviderIdBackfill,
  markProviderIdBackfillFinished,
  providerIdBackfillState,
  recordProviderIdBackfillError,
  saveProviderIdCursor,
} from './providerIdBackfillStore.js';

describe('provider id backfill store', () => {
  it('loads the row of one account, or null', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ account_id: 'a1', cursors: {} }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await loadProviderIdBackfill(query, 'a1')).toEqual({ account_id: 'a1', cursors: {} });
    expect(await loadProviderIdBackfill(query, 'a2')).toBeNull();
    expect(query.mock.calls[0][1]).toEqual(['a1']);
  });

  it('merges one folder cursor into the stored cursors', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await saveProviderIdCursor(query, 'a1', 'INBOX', { lastUid: 42, uidValidity: '7' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/provider_id_backfill\.cursors \|\| EXCLUDED\.cursors/);
    expect(params).toEqual(['a1', 'INBOX', '{"lastUid":42,"uidValidity":"7"}']);
  });

  it('clears the error when a run finishes', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await markProviderIdBackfillFinished(query, 'a1');
    expect(query.mock.calls[0][0]).toMatch(/finished_at = now\(\), error = NULL/);
    expect(query.mock.calls[0][1]).toEqual(['a1']);
  });

  it('stores a bounded error text', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await recordProviderIdBackfillError(query, 'a1', 'x'.repeat(900));
    expect(query.mock.calls[0][1]).toEqual(['a1', 'x'.repeat(500)]);
    await recordProviderIdBackfillError(query, 'a1', '');
    expect(query.mock.calls[1][1]).toEqual(['a1', 'Unknown error']);
  });
});

describe('providerIdBackfillState', () => {
  it.each([
    [{}, { status: 'not_started', percent: null, error: null }],
    [{ running: true, progress: { processed: 1, total: 3 } }, { status: 'running', percent: 33, error: null }],
    [{ running: true, progress: { processed: 0, total: 0 } }, { status: 'running', percent: null, error: null }],
    [{ running: true, row: { error: 'old failure' } }, { status: 'running', percent: null, error: null }],
    [{ row: { cursors: {}, finished_at: null, error: 'Command failed' } }, { status: 'error', percent: null, error: 'Command failed' }],
    [{ row: { cursors: {}, finished_at: '2026-09-17T10:00:00Z', error: null } }, { status: 'done', percent: 100, error: null }],
    [{ row: { cursors: { INBOX: { lastUid: 5 } }, finished_at: null, error: null } }, { status: 'paused', percent: null, error: null }],
  ])('%j -> %j', (input, expected) => {
    expect(providerIdBackfillState(input)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Write the failing index check test**

Create `backend/src/services/threading/providerThreadIndex.test.js`:

```js
import { describe, expect, it, vi } from 'vitest';
import { providerThreadIndexState } from './providerThreadIndex.js';

describe('providerThreadIndexState', () => {
  it.each([
    [[], 'missing'],
    [[{ indisvalid: true }], 'valid'],
    [[{ indisvalid: false }], 'invalid'],
  ])('%j -> %s', async (rows, expected) => {
    const query = vi.fn(async () => ({ rows }));
    expect(await providerThreadIndexState(query)).toBe(expected);
    expect(query.mock.calls[0][0]).toMatch(/relname = 'idx_messages_provider_thread'/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run from `backend/`: `npx vitest run src/services/threading/providerIdBackfillStore.test.js src/services/threading/providerThreadIndex.test.js`
Expected: FAIL, both modules cannot be resolved.

- [ ] **Step 4: Write the migration**

Create `backend/migrations/0062_provider_id_backfill.sql`:

```sql
-- Progress of loading Gmail ids (0060) for messages cached before the sync stored them.
-- One row per mailbox: a { lastUid, uidValidity } cursor per folder path, when the last
-- complete run finished, and the last failure. Whether a run is in progress is kept in
-- process memory only, so a crash never leaves a mailbox marked as running.
CREATE TABLE IF NOT EXISTS provider_id_backfill (
  account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  cursors JSONB NOT NULL DEFAULT '{}'::jsonb,
  finished_at TIMESTAMPTZ,
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 5: Write the store module**

Create `backend/src/services/threading/providerIdBackfillStore.js`:

```js
// Progress of the Gmail id backfill, one provider_id_backfill row per mailbox (see migration 0062).
const ERROR_MAX_LENGTH = 500;

export async function loadProviderIdBackfill(query, accountId) {
  const { rows } = await query(
    'SELECT account_id, cursors, finished_at, error, updated_at FROM provider_id_backfill WHERE account_id = $1',
    [accountId],
  );
  return rows[0] || null;
}

export async function saveProviderIdCursor(query, accountId, folder, cursor) {
  await query(
    `INSERT INTO provider_id_backfill (account_id, cursors, updated_at)
     VALUES ($1, jsonb_build_object($2::text, $3::jsonb), now())
     ON CONFLICT (account_id) DO UPDATE
       SET cursors = provider_id_backfill.cursors || EXCLUDED.cursors, updated_at = now()`,
    [accountId, folder, JSON.stringify(cursor)],
  );
}

export async function markProviderIdBackfillFinished(query, accountId) {
  await query(
    `INSERT INTO provider_id_backfill (account_id, finished_at, error, updated_at)
     VALUES ($1, now(), NULL, now())
     ON CONFLICT (account_id) DO UPDATE SET finished_at = now(), error = NULL, updated_at = now()`,
    [accountId],
  );
}

export async function recordProviderIdBackfillError(query, accountId, message) {
  const text = String(message || 'Unknown error').slice(0, ERROR_MAX_LENGTH);
  await query(
    `INSERT INTO provider_id_backfill (account_id, error, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (account_id) DO UPDATE SET error = EXCLUDED.error, updated_at = now()`,
    [accountId, text],
  );
}

// What the admin panel shows for a Gmail mailbox. `running` and `progress` come from process
// memory; the row holds what survives a restart. A row without finished_at and without an error
// is a run that stopped early (cooldown, disabled mailbox, restart) and resumes on its own.
export function providerIdBackfillState({ row = null, running = false, progress = null } = {}) {
  if (running) {
    const percent = progress?.total > 0
      ? Math.min(100, Math.floor((progress.processed / progress.total) * 100))
      : null;
    return { status: 'running', percent, error: null };
  }
  if (!row) return { status: 'not_started', percent: null, error: null };
  if (row.error) return { status: 'error', percent: null, error: row.error };
  if (row.finished_at) return { status: 'done', percent: 100, error: null };
  return { status: 'paused', percent: null, error: null };
}
```

- [ ] **Step 6: Write the index check module**

Create `backend/src/services/threading/providerThreadIndex.js`:

```js
// Whether idx_messages_provider_thread (migration 0061) is usable. A CREATE INDEX CONCURRENTLY
// that failed leaves an INVALID index behind, and the migration is recorded as applied anyway.
// Switching a mailbox to Gmail threading (PR C) needs this index to be valid.
export async function providerThreadIndexState(query) {
  const { rows } = await query(
    `SELECT i.indisvalid
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_messages_provider_thread'`,
  );
  if (!rows.length) return 'missing';
  return rows[0].indisvalid ? 'valid' : 'invalid';
}
```

- [ ] **Step 7: Log the index state at startup**

In `backend/src/index.js`, add the import next to the other service imports:

```js
import { providerThreadIndexState } from './services/threading/providerThreadIndex.js';
```

and directly after `await runMigrations();` add:

```js
// A failed concurrent build (migration 0061) leaves an unusable index that no later migration repairs.
providerThreadIndexState(query)
  .then(state => {
    if (state !== 'valid') {
      console.warn(`Index idx_messages_provider_thread is ${state}: drop it and rerun the CREATE INDEX CONCURRENTLY from migration 0061`);
    }
  })
  .catch(err => console.warn('Provider thread index check failed:', err.message));
```

Confirm `query` is already imported in `index.js` (it is used by `backfillContactPhotos`); if not, import it from `./services/db.js`.

- [ ] **Step 8: Run the tests to verify they pass**

Run from `backend/`: `npx vitest run src/services/threading/providerIdBackfillStore.test.js src/services/threading/providerThreadIndex.test.js`
Expected: PASS, 2 files.

- [ ] **Step 9: Lint**

Run from `backend/`: `npm run lint`
Expected: no problems.

- [ ] **Step 10: Commit**

```bash
git add backend/migrations/0062_provider_id_backfill.sql backend/src/services/threading/providerIdBackfillStore.js backend/src/services/threading/providerIdBackfillStore.test.js backend/src/services/threading/providerThreadIndex.js backend/src/services/threading/providerThreadIndex.test.js backend/src/index.js
git commit -m "feat(threading): store Gmail id backfill progress and check the provider thread index"
```

---

### Task 2: Backfill runner

**Files:**
- Create: `backend/src/services/threading/providerIdBackfill.js`
- Create: `backend/src/services/threading/providerIdBackfill.test.js`
- Modify: `docs/architecture/codebase-file-map.md` (the `threading/` bullet, around line 103)

**Interfaces:**
- Consumes (Task 1): `loadProviderIdBackfill`, `saveProviderIdCursor`, `markProviderIdBackfillFinished` from `./providerIdBackfillStore.js`. Existing: `gmailProviderIds(msg) -> { providerThreadId, providerMessageId }` from `./providerIds.js`.
- Produces:
  - `PROVIDER_ID_BATCH_SIZE = 500`
  - `uidSet(uids: number[]) -> string` (ascending input, compact IMAP set)
  - `planProviderIdBackfill(query, accountId) -> Promise<{ folders: Array<{ path, uidValidity: string|null, lastUid: number, remaining: number }>, total: number }>`
  - `runProviderIdBackfill({ query, accountId, getClient, shouldContinue, onProgress = () => {}, pause = async () => {} }) -> Promise<{ outcome: 'done'|'stopped', processed: number, total: number }>`
    - `getClient: () => Promise<ImapFlow-like>`; called only when a batch needs IMAP; the caller owns logout.
    - `shouldContinue: () => Promise<boolean>`; checked before every batch.
    - Errors from IMAP or the database propagate to the caller; the cursor of every finished batch is already saved.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/services/threading/providerIdBackfill.test.js`:

```js
import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_ID_BATCH_SIZE, planProviderIdBackfill, runProviderIdBackfill, uidSet,
} from './providerIdBackfill.js';

const THREAD = '1700000000000000001';
const gm = (uid, over = {}) => ({ uid, threadId: THREAD, emailId: String(1800000000000000000n + BigInt(uid)), ...over });

// An in-memory stand-in for the SQL this module issues. Each branch mirrors one statement.
function fakeDb({ folders, messages, state = null }) {
  const db = { state, messages, updates: [], finished: 0 };
  const query = vi.fn(async (sql, params = []) => {
    if (/FROM provider_id_backfill/.test(sql)) return { rows: db.state ? [db.state] : [] };
    if (/FROM folders/.test(sql)) return { rows: folders };
    if (/AS remaining/.test(sql)) {
      const cursors = JSON.parse(params[1]);
      const counts = new Map();
      for (const m of db.messages) {
        if (m.provider_message_id || m.is_deleted) continue;
        if (m.uid <= Number(cursors[m.folder]?.lastUid || 0)) continue;
        counts.set(m.folder, (counts.get(m.folder) || 0) + 1);
      }
      return { rows: [...counts].map(([folder, remaining]) => ({ folder, remaining })) };
    }
    if (/^\s*SELECT uid FROM messages/.test(sql)) {
      const [, folder, after, limit] = params;
      return {
        rows: db.messages
          .filter(m => m.folder === folder && !m.is_deleted && !m.provider_message_id && m.uid > after)
          .sort((a, b) => a.uid - b.uid)
          .slice(0, limit)
          .map(m => ({ uid: String(m.uid) })),
      };
    }
    if (/^\s*UPDATE messages m/.test(sql)) {
      const [, folder, uids, threads, ids] = params;
      uids.forEach((uid, i) => {
        const row = db.messages.find(m => m.folder === folder && m.uid === uid && !m.provider_message_id);
        if (row) Object.assign(row, { provider_thread_id: threads[i], provider_message_id: ids[i] });
      });
      db.updates.push({ folder, uids });
      return { rows: [] };
    }
    if (/jsonb_build_object/.test(sql)) {
      const [, folder, cursor] = params;
      db.state = { ...(db.state || {}), cursors: { ...(db.state?.cursors || {}), [folder]: JSON.parse(cursor) } };
      return { rows: [] };
    }
    if (/finished_at = now\(\)/.test(sql)) {
      db.finished += 1;
      db.state = { cursors: {}, ...(db.state || {}), finished_at: new Date(), error: null };
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { db, query };
}

function expandSet(range) {
  const set = new Set();
  for (const part of range.split(',')) {
    const [from, to] = part.split(':').map(Number);
    for (let uid = from; uid <= (to ?? from); uid++) set.add(uid);
  }
  return set;
}

// server: { [folderPath]: fetch responses }. uidValidity is a BigInt, as imapflow reports it.
function fakeClient(server, { uidValidity = 7n } = {}) {
  const client = {
    mailbox: null,
    getMailboxLock: vi.fn(async (path) => {
      client.mailbox = { path, uidValidity };
      return { release: vi.fn() };
    }),
    fetch: vi.fn((range) => (async function* () {
      const wanted = expandSet(range);
      for (const msg of server[client.mailbox.path] || []) if (wanted.has(msg.uid)) yield msg;
    })()),
  };
  return client;
}

const row = (folder, uid, over = {}) => ({ folder, uid, provider_message_id: null, provider_thread_id: null, is_deleted: false, ...over });
const FOLDERS = [{ path: 'INBOX', uid_validity: '7' }, { path: '[Gmail]/Sent Mail', uid_validity: '7' }];

async function run(db, client, over = {}) {
  return runProviderIdBackfill({
    query: db.query,
    accountId: 'a1',
    getClient: vi.fn(async () => client),
    shouldContinue: vi.fn(async () => true),
    ...over,
  });
}

describe('uidSet', () => {
  it.each([
    [[], ''],
    [[5], '5'],
    [[1, 2, 3], '1:3'],
    [[1, 2, 3, 7, 9, 10], '1:3,7,9:10'],
  ])('%j -> %s', (uids, expected) => {
    expect(uidSet(uids)).toBe(expected);
  });
});

describe('planProviderIdBackfill', () => {
  it('counts rows missing ids above each cursor, INBOX first', async () => {
    const { query } = fakeDb({
      folders: FOLDERS,
      messages: [row('[Gmail]/Sent Mail', 1), row('INBOX', 1), row('INBOX', 2), row('INBOX', 3, { provider_message_id: '9' })],
      state: { cursors: { INBOX: { lastUid: 1, uidValidity: '7' } } },
    });
    expect(await planProviderIdBackfill(query, 'a1')).toEqual({
      folders: [
        { path: 'INBOX', uidValidity: '7', lastUid: 1, remaining: 1 },
        { path: '[Gmail]/Sent Mail', uidValidity: '7', lastUid: 0, remaining: 1 },
      ],
      total: 2,
    });
  });

  it('ignores a cursor recorded under another UIDVALIDITY and folders that are no longer known', async () => {
    const { query } = fakeDb({
      folders: [{ path: 'INBOX', uid_validity: '8' }],
      messages: [row('INBOX', 1), row('INBOX', 2), row('Old label', 1)],
      state: { cursors: { INBOX: { lastUid: 2, uidValidity: '7' } } },
    });
    expect(await planProviderIdBackfill(query, 'a1')).toEqual({
      folders: [{ path: 'INBOX', uidValidity: '8', lastUid: 0, remaining: 2 }],
      total: 2,
    });
  });
});

describe('runProviderIdBackfill', () => {
  it('fills ids, saves the cursor per folder and marks the run finished', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1), row('INBOX', 2), row('[Gmail]/Sent Mail', 4)] });
    const client = fakeClient({ INBOX: [gm(1), gm(2)], '[Gmail]/Sent Mail': [gm(4)] });
    const progress = [];

    const result = await run(db, client, { onProgress: p => progress.push(p) });

    expect(result).toEqual({ outcome: 'done', processed: 3, total: 3 });
    expect(db.db.messages.map(m => [m.folder, m.uid, m.provider_thread_id, m.provider_message_id])).toEqual([
      ['INBOX', 1, THREAD, '1800000000000000001'],
      ['INBOX', 2, THREAD, '1800000000000000002'],
      ['[Gmail]/Sent Mail', 4, THREAD, '1800000000000000004'],
    ]);
    expect(client.fetch.mock.calls).toEqual([
      ['1:2', { uid: true, threadId: true }, { uid: true }],
      ['4', { uid: true, threadId: true }, { uid: true }],
    ]);
    expect(db.db.state.cursors).toEqual({
      INBOX: { lastUid: 2, uidValidity: '7' },
      '[Gmail]/Sent Mail': { lastUid: 4, uidValidity: '7' },
    });
    expect(db.db.finished).toBe(1);
    expect(progress).toEqual([
      { processed: 0, total: 3 },
      { processed: 2, total: 3 },
      { processed: 3, total: 3 },
    ]);
  });

  it('passes rows the server no longer has, so a second run finds nothing to do', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1), row('INBOX', 2)] });
    const client = fakeClient({ INBOX: [gm(2)] });

    await run(db, client);
    const getClient = vi.fn(async () => client);
    const second = await run(db, client, { getClient });

    expect(db.db.messages[0].provider_message_id).toBeNull();
    expect(db.db.messages[1].provider_message_id).toBe('1800000000000000002');
    expect(second).toEqual({ outcome: 'done', processed: 0, total: 0 });
    expect(getClient).not.toHaveBeenCalled();
    expect(db.db.finished).toBe(2);
  });

  it('resumes after the saved cursor', async () => {
    const db = fakeDb({
      folders: FOLDERS,
      messages: [row('INBOX', 1), row('INBOX', 2), row('INBOX', 3)],
      state: { cursors: { INBOX: { lastUid: 2, uidValidity: '7' } } },
    });
    const client = fakeClient({ INBOX: [gm(1), gm(2), gm(3)] });

    expect(await run(db, client)).toEqual({ outcome: 'done', processed: 1, total: 1 });
    expect(client.fetch.mock.calls.map(c => c[0])).toEqual(['3']);
  });

  it('fetches in batches of PROVIDER_ID_BATCH_SIZE UIDs', async () => {
    const messages = Array.from({ length: PROVIDER_ID_BATCH_SIZE + 1 }, (_, i) => row('INBOX', i + 1));
    const db = fakeDb({ folders: FOLDERS, messages });
    const client = fakeClient({ INBOX: messages.map(m => gm(m.uid)) });

    await run(db, client);

    expect(client.fetch.mock.calls.map(c => c[0])).toEqual([`1:${PROVIDER_ID_BATCH_SIZE}`, `${PROVIDER_ID_BATCH_SIZE + 1}`]);
    expect(db.db.messages.every(m => m.provider_message_id)).toBe(true);
  });

  it('ignores unrequested UIDs and responses without a valid Gmail message id', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1), row('INBOX', 3)] });
    const client = fakeClient({ INBOX: [gm(1, { emailId: 'not-a-number' }), gm(2), gm(3, { threadId: undefined })] });
    client.fetch.mockImplementation(() => (async function* () { yield* [gm(1, { emailId: 'not-a-number' }), gm(2), gm(3, { threadId: undefined })]; })());

    await run(db, client);

    expect(db.db.updates).toEqual([{ folder: 'INBOX', uids: [3] }]);
    expect(db.db.messages.map(m => [m.uid, m.provider_thread_id, m.provider_message_id])).toEqual([
      [1, null, null],
      [3, null, '1800000000000000003'],
    ]);
  });

  it('skips a folder whose server UIDVALIDITY no longer matches the cached rows', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1)] });
    const client = fakeClient({ INBOX: [gm(1)] }, { uidValidity: 9n });

    const result = await run(db, client);

    expect(result.outcome).toBe('done');
    expect(client.fetch).not.toHaveBeenCalled();
    expect(db.db.updates).toEqual([]);
    expect(db.db.state?.cursors?.INBOX).toBeUndefined();
  });

  it('stops before the next batch when asked, without marking the run finished', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1)] });
    const client = fakeClient({ INBOX: [gm(1)] });

    const result = await run(db, client, { shouldContinue: vi.fn(async () => false) });

    expect(result).toEqual({ outcome: 'stopped', processed: 0, total: 1 });
    expect(client.fetch).not.toHaveBeenCalled();
    expect(db.db.finished).toBe(0);
  });

  it('releases the mailbox lock and keeps earlier cursors when a fetch fails', async () => {
    const messages = Array.from({ length: PROVIDER_ID_BATCH_SIZE + 1 }, (_, i) => row('INBOX', i + 1));
    const db = fakeDb({ folders: FOLDERS, messages });
    const client = fakeClient({ INBOX: messages.map(m => gm(m.uid)) });
    const releases = [];
    client.getMailboxLock.mockImplementation(async (path) => {
      client.mailbox = { path, uidValidity: 7n };
      const lock = { release: vi.fn() };
      releases.push(lock.release);
      return lock;
    });
    const realFetch = client.fetch.getMockImplementation();
    client.fetch.mockImplementationOnce(realFetch).mockImplementationOnce(() => (async function* () { yield* []; throw new Error('Connection closed'); })());

    await expect(run(db, client)).rejects.toThrow('Connection closed');

    expect(releases).toHaveLength(2);
    for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
    expect(db.db.state.cursors.INBOX).toEqual({ lastUid: PROVIDER_ID_BATCH_SIZE, uidValidity: '7' });
    expect(db.db.finished).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `backend/`: `npx vitest run src/services/threading/providerIdBackfill.test.js`
Expected: FAIL, module `./providerIdBackfill.js` cannot be resolved.

- [ ] **Step 3: Write the runner**

Create `backend/src/services/threading/providerIdBackfill.js`:

```js
// Loads Gmail's X-GM-THRID / X-GM-MSGID for cached messages that were stored without them:
// rows synced before migration 0060, and Sent/Drafts rows the app wrote itself after an APPEND.
// Rows are taken from the database in UID order, so a cursor per folder makes the walk resumable
// and later runs only look at rows above it. thread_id is never touched here.
import { gmailProviderIds } from './providerIds.js';
import { loadProviderIdBackfill, markProviderIdBackfillFinished, saveProviderIdCursor } from './providerIdBackfillStore.js';

export const PROVIDER_ID_BATCH_SIZE = 500;

// Ascending UIDs as a compact IMAP set: [1, 2, 3, 7, 9, 10] -> "1:3,7,9:10".
export function uidSet(uids) {
  const parts = [];
  let start = null;
  let prev = null;
  const flush = () => { if (start !== null) parts.push(start === prev ? `${start}` : `${start}:${prev}`); };
  for (const uid of uids) {
    if (start !== null && uid === prev + 1) {
      prev = uid;
      continue;
    }
    flush();
    start = uid;
    prev = uid;
  }
  flush();
  return parts.join(',');
}

const validityText = (value) => (value === null || value === undefined ? null : String(value));

// Folders that still have rows without ids above their cursor. A cursor saved under another
// UIDVALIDITY is dropped: the folder was renumbered and the sync refetches its rows with ids.
// Rows in folders the account no longer lists are left alone.
export async function planProviderIdBackfill(query, accountId) {
  const state = await loadProviderIdBackfill(query, accountId);
  const { rows: folderRows } = await query(
    'SELECT path, uid_validity FROM folders WHERE account_id = $1',
    [accountId],
  );
  const validity = new Map();
  const cursors = {};
  for (const folder of folderRows) {
    const uidValidity = validityText(folder.uid_validity);
    validity.set(folder.path, uidValidity);
    const saved = state?.cursors?.[folder.path];
    if (saved && validityText(saved.uidValidity) === uidValidity) cursors[folder.path] = saved;
  }
  const { rows } = await query(
    `SELECT m.folder, COUNT(*)::int AS remaining
     FROM messages m
     WHERE m.account_id = $1 AND m.is_deleted = false AND m.provider_message_id IS NULL
       AND m.uid > COALESCE((($2::jsonb -> m.folder) ->> 'lastUid')::bigint, 0)
     GROUP BY m.folder`,
    [accountId, JSON.stringify(cursors)],
  );
  const folders = rows
    .filter(r => validity.has(r.folder))
    .map(r => ({
      path: r.folder,
      uidValidity: validity.get(r.folder),
      lastUid: Number(cursors[r.folder]?.lastUid || 0),
      remaining: Number(r.remaining),
    }))
    .sort((a, b) => {
      if (a.path === 'INBOX') return -1;
      if (b.path === 'INBOX') return 1;
      return a.path.localeCompare(b.path);
    });
  return { folders, total: folders.reduce((sum, f) => sum + f.remaining, 0) };
}

export async function runProviderIdBackfill({
  query, accountId, getClient, shouldContinue, onProgress = () => {}, pause = async () => {},
}) {
  const plan = await planProviderIdBackfill(query, accountId);
  let processed = 0;
  onProgress({ processed, total: plan.total });

  for (const folder of plan.folders) {
    let lastUid = folder.lastUid;
    for (;;) {
      if (!(await shouldContinue())) return { outcome: 'stopped', processed, total: plan.total };

      const { rows } = await query(
        `SELECT uid FROM messages
         WHERE account_id = $1 AND folder = $2 AND is_deleted = false
           AND provider_message_id IS NULL AND uid > $3
         ORDER BY uid
         LIMIT $4`,
        [accountId, folder.path, lastUid, PROVIDER_ID_BATCH_SIZE],
      );
      if (!rows.length) break;

      const uids = rows.map(r => Number(r.uid));
      const wanted = new Set(uids);
      const found = [];
      const client = await getClient();
      let renumbered = false;
      const lock = await client.getMailboxLock(folder.path);
      try {
        // The cached rows belong to the stored UIDVALIDITY; if the server moved on, the sync
        // purges and refetches this folder with ids, so its UIDs must not be matched here.
        renumbered = validityText(client.mailbox?.uidValidity) !== folder.uidValidity;
        if (!renumbered) {
          for await (const msg of client.fetch(uidSet(uids), { uid: true, threadId: true }, { uid: true })) {
            const uid = Number(msg.uid);
            const ids = gmailProviderIds(msg);
            if (wanted.has(uid) && ids.providerMessageId) found.push({ uid, ...ids });
          }
        }
      } finally {
        lock.release();
      }
      if (renumbered) break;

      if (found.length) {
        await query(
          `UPDATE messages m
           SET provider_thread_id = v.thread_id, provider_message_id = v.message_id
           FROM unnest($3::bigint[], $4::text[], $5::text[]) AS v(uid, thread_id, message_id)
           WHERE m.account_id = $1 AND m.folder = $2 AND m.uid = v.uid
             AND m.provider_message_id IS NULL`,
          [accountId, folder.path, found.map(f => f.uid), found.map(f => f.providerThreadId), found.map(f => f.providerMessageId)],
        );
      }
      lastUid = uids[uids.length - 1];
      await saveProviderIdCursor(query, accountId, folder.path, { lastUid, uidValidity: folder.uidValidity });
      processed += uids.length;
      onProgress({ processed, total: plan.total });
      await pause();
    }
  }

  await markProviderIdBackfillFinished(query, accountId);
  return { outcome: 'done', processed, total: plan.total };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run from `backend/`: `npx vitest run src/services/threading/`
Expected: PASS, all threading test files.

- [ ] **Step 5: Update the file map**

In `docs/architecture/codebase-file-map.md`, replace the bullet that starts with ``- `threading/` —`` with:

```markdown
- `threading/` — цепочки писем: `threadId.js` вычисляет `thread_id` по `References`/`In-Reply-To` без склейки по теме, `providerIds.js` читает `X-GM-THRID`/`X-GM-MSGID` из ответа imapflow для ящиков Gmail, `providerIdBackfill.js` догружает эти номера для уже сохранённых писем, `providerIdBackfillStore.js` хранит прогресс догрузки, `providerThreadIndex.js` проверяет, что индекс по номеру цепочки валиден.
```

- [ ] **Step 6: Lint**

Run from `backend/`: `npm run lint`
Expected: no problems.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/threading/providerIdBackfill.js backend/src/services/threading/providerIdBackfill.test.js docs/architecture/codebase-file-map.md
git commit -m "feat(threading): backfill Gmail ids for cached messages in resumable batches"
```

---

### Task 3: Run the backfill from the mail engine

**Files:**
- Modify: `backend/src/services/imapManager.js`
  - imports (lines 25-26)
  - constants near `QUIET_WINDOW_MS` (line ~389)
  - constructor: the `Set`s near `this.backfillAllRunning` (line ~1666) and the timers near `_snippetSchedulerTimer` (line ~1789)
  - connect path: the `else` branch of `if (shouldBackfill)` (line ~2285)
  - `backfillAllFolders` `finally` (line ~4476)
  - new methods after `startSnippetIndexer` (ends line ~4698)
  - `upsertSentMessageRecord` (line ~4718) and `upsertDraftMessageRecord` (line ~4785)
- Create: `backend/src/services/imapManager.providerIds.test.js`
- Modify: `backend/src/services/imapManager.test.js`, `backend/src/services/imapManager.serverMailboxes.test.js`, `backend/src/services/imapManager.oauthRefresh.test.js` — add `'_providerIdSchedulerTimer'` wherever those files clear `_snippetSchedulerTimer`

**Interfaces:**
- Consumes (Task 1): `recordProviderIdBackfillError(query, accountId, message)`, `providerIdBackfillState({ row, running, progress })`. (Task 2): `runProviderIdBackfill({ query, accountId, getClient, shouldContinue, onProgress, pause })`.
- Existing in `imapManager.js`: `providerProfile(account)`, `this._bgConnSem.acquire(host)` / `.release(host)`, `ensureFreshToken(row)`, `resolveAccountHost(account) -> { resolved, policy }`, `connectImapClient(account, resolved, cfgOpts, timeoutMs, label)`, `this._connectCooldown` (Map of `{ until }`), `this._handleOAuthRefreshFailure(account, err) -> Promise<boolean>`, `extractImapError(err)`, `isConnectionRefusal(detail)`, `this._noteConnectionRefusal(account)`, `this.lastUserActivity`, `QUIET_WINDOW_MS`, `logAccount(account)`, `this.connections` (Map keyed by account id), `this.backfillAllRunning` (Set).
- Produces on `ImapManager`:
  - `providerIdBackfillRunning: Set<accountId>`, `providerIdBackfillClean: Set<accountId>`, `providerIdProgress: Map<accountId, { processed, total }>`
  - `startProviderIdBackfill(account) -> Promise<void>`
  - `providerIdBackfillStates(accounts: Array<account row>) -> Promise<Map<accountId, { status, percent, error }>>` (Gmail accounts only)
  - `_scheduleProviderIdBackfill(account) -> void`
  - `_nudgeProviderIdBackfills() -> Promise<void>`
  - broadcast `{ type: 'provider_ids_backfill', accountId, state }`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/services/imapManager.providerIds.test.js`. Copy the `vi.mock(...)` block from the top of `backend/src/services/imapManager.serverMailboxes.test.js` verbatim (imapflow, `./db.js`, messageParser, tokenManager, emailSanitizer, encryption, aiProvider, pushNotifications, redact, hostValidation, connectionPolicy), then add the two threading mocks and the tests:

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ... the vi.mock block copied from imapManager.serverMailboxes.test.js ...
vi.mock('./threading/providerIdBackfill.js', () => ({ runProviderIdBackfill: vi.fn() }));
vi.mock('./threading/providerIdBackfillStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  recordProviderIdBackfillError: vi.fn(async () => {}),
}));

import { query } from './db.js';
import { runProviderIdBackfill } from './threading/providerIdBackfill.js';
import { recordProviderIdBackfillError } from './threading/providerIdBackfillStore.js';
import { ImapManager } from './imapManager.js';

const TIMERS = ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer'];
function newManager() {
  const mgr = new ImapManager(null);
  for (const key of TIMERS) clearInterval(mgr[key]);
  mgr.broadcast = vi.fn();
  return mgr;
}

const gmail = {
  id: 'g1', user_id: 'u1', enabled: true, protocol: 'imap', email_address: 'box@gmail.com',
  imap_host: 'imap.gmail.com', imap_port: 993, oauth_reconnect_required: false,
};
const other = { ...gmail, id: 'o1', email_address: 'box@example.com', imap_host: 'imap.example.com' };

let backfillRows;
beforeEach(() => {
  backfillRows = [];
  query.mockReset();
  query.mockImplementation(async (sql, params = []) => {
    if (/FROM provider_id_backfill/.test(sql)) return { rows: backfillRows };
    if (/FROM email_accounts WHERE id = \$1/.test(sql)) return { rows: [params[0] === gmail.id ? gmail : other] };
    return { rows: [] };
  });
  runProviderIdBackfill.mockReset();
  recordProviderIdBackfillError.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

const broadcasts = (mgr) => mgr.broadcast.mock.calls.map(c => c[0]).filter(e => e.type === 'provider_ids_backfill');

describe('startProviderIdBackfill', () => {
  it('does nothing for a mailbox that is not on Gmail', async () => {
    await newManager().startProviderIdBackfill(other);
    expect(runProviderIdBackfill).not.toHaveBeenCalled();
  });

  it('leaves the start to a running full backfill', async () => {
    const mgr = newManager();
    mgr.backfillAllRunning.add(gmail.id);
    await mgr.startProviderIdBackfill(gmail);
    expect(runProviderIdBackfill).not.toHaveBeenCalled();
  });

  it('marks the mailbox clean after a complete run and skips it next time', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockResolvedValue({ outcome: 'done', processed: 3, total: 3 });
    await mgr.startProviderIdBackfill(gmail);
    await mgr.startProviderIdBackfill(gmail);
    await new Promise(resolve => setImmediate(resolve)); // the final state broadcast is not awaited
    expect(runProviderIdBackfill).toHaveBeenCalledTimes(1);
    expect(runProviderIdBackfill.mock.calls[0][0]).toMatchObject({ query, accountId: gmail.id });
    expect(mgr.providerIdBackfillRunning.has(gmail.id)).toBe(false);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(true);
    expect(broadcasts(mgr).at(-1)).toMatchObject({ accountId: gmail.id, state: { status: 'not_started' } });
  });

  it('keeps a stopped run eligible for the scheduler', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockResolvedValue({ outcome: 'stopped', processed: 0, total: 3 });
    await mgr.startProviderIdBackfill(gmail);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });

  it('does not mark the mailbox clean when a local write happened during the run', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    runProviderIdBackfill.mockImplementation(async () => {
      mgr._scheduleProviderIdBackfill(gmail);
      return { outcome: 'done', processed: 1, total: 1 };
    });
    await mgr.startProviderIdBackfill(gmail);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });

  it('broadcasts progress while running', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockImplementation(async ({ onProgress }) => {
      onProgress({ processed: 1, total: 4 });
      await new Promise(resolve => setImmediate(resolve));
      return { outcome: 'done', processed: 4, total: 4 };
    });
    await mgr.startProviderIdBackfill(gmail);
    expect(broadcasts(mgr)).toContainEqual({
      type: 'provider_ids_backfill', accountId: gmail.id, state: { status: 'running', percent: 25, error: null },
    });
  });

  it('takes no background connection when the run never needs IMAP', async () => {
    const mgr = newManager();
    const acquire = vi.spyOn(mgr._bgConnSem, 'acquire');
    runProviderIdBackfill.mockResolvedValue({ outcome: 'done', processed: 0, total: 0 });
    await mgr.startProviderIdBackfill(gmail);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('records the failure and frees the mailbox', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockRejectedValue(new Error('Connection closed'));
    await mgr.startProviderIdBackfill(gmail);
    expect(recordProviderIdBackfillError).toHaveBeenCalledWith(query, gmail.id, expect.stringContaining('Connection closed'));
    expect(mgr.providerIdBackfillRunning.has(gmail.id)).toBe(false);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });
});

describe('providerIdBackfillStates', () => {
  it('returns a state for Gmail mailboxes only', async () => {
    const mgr = newManager();
    backfillRows = [{ account_id: gmail.id, cursors: {}, finished_at: '2026-09-17T10:00:00Z', error: null }];
    const states = await mgr.providerIdBackfillStates([gmail, other]);
    expect([...states.entries()]).toEqual([[gmail.id, { status: 'done', percent: 100, error: null }]]);
  });

  it('does not query the database when no mailbox is on Gmail', async () => {
    const mgr = newManager();
    expect((await mgr.providerIdBackfillStates([other])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Gmail id backfill triggers', () => {
  it('a local Sent copy starts a run a minute later', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    mgr.providerIdBackfillClean.add(gmail.id);
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr.upsertSentMessageRecord(gmail, '[Gmail]/Sent Mail', 12, { subject: 'Hello' });
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(59 * 1000);
    expect(mgr.startProviderIdBackfill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledWith(gmail);
  });

  it('a local draft on another provider starts nothing', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr.upsertDraftMessageRecord(other, 'Drafts', 5, { subject: 'Hello' });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(mgr.startProviderIdBackfill).not.toHaveBeenCalled();
  });

  it('the scheduler starts connected mailboxes that are not clean', async () => {
    const mgr = newManager();
    mgr.connections.set(gmail.id, {});
    mgr.connections.set(other.id, {});
    mgr.providerIdBackfillClean.add(other.id);
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr._nudgeProviderIdBackfills();
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledTimes(1);
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledWith(gmail);
  });

  it('a finished full backfill starts the id backfill', async () => {
    const mgr = newManager();
    mgr._connectCooldown.set(gmail.id, { until: Date.now() + 60 * 1000 });
    mgr.refreshBulkFlags = vi.fn(async () => {});
    mgr.startSnippetIndexer = vi.fn(async () => {});
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr.backfillAllFolders(gmail);
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledWith(gmail);
  });
});
```

If `mgr.connections` is not a `Map` or `upsertDraftMessageRecord` needs other arguments, read the constructor and the method and adapt the fixture, not the production code.

- [ ] **Step 2: Run the tests to verify they fail**

Run from `backend/`: `npx vitest run src/services/imapManager.providerIds.test.js`
Expected: FAIL (`startProviderIdBackfill` is not a function, and the other missing members).

- [ ] **Step 3: Imports and constants**

In `backend/src/services/imapManager.js`, after the line `import { gmailProviderIds, NO_PROVIDER_IDS } from './threading/providerIds.js';` add:

```js
import { runProviderIdBackfill } from './threading/providerIdBackfill.js';
import { providerIdBackfillState, recordProviderIdBackfillError } from './threading/providerIdBackfillStore.js';
```

After `const QUIET_WINDOW_MS = 8000;` add:

```js
// Gmail id backfill (threading/providerIdBackfill.js): how often connected Gmail mailboxes that
// may still have rows without ids are retried, and how long after a local Sent/Drafts write the
// new row's ids are loaded (the sync never refetches a UID the app already stored).
const PROVIDER_ID_SCHEDULER_MS = 10 * 60 * 1000;
const PROVIDER_ID_NUDGE_DELAY_MS = 60 * 1000;
```

- [ ] **Step 4: Constructor state and scheduler**

Next to `this.backfillAllRunning = new Set();` add:

```js
    this.providerIdBackfillRunning = new Set(); // accountId — Gmail id backfill in progress
    this.providerIdBackfillClean = new Set(); // accountId — last run finished and no local write since
    this.providerIdProgress = new Map(); // accountId -> { processed, total } of the running backfill
    this._providerIdGeneration = new Map(); // accountId -> bumped by every local write that needs ids
    this._providerIdNudges = new Map(); // accountId -> pending timeout after a local write
```

After the `this._snippetSchedulerTimer = setInterval(...)` statement add:

```js
    // Resumes Gmail id backfills that stopped early or failed, and catches rows written while a run
    // was already past their folder. Mailboxes whose last run finished cleanly are skipped.
    this._providerIdSchedulerTimer = setInterval(() => {
      this._nudgeProviderIdBackfills().catch(err => console.error('Provider id scheduler error:', err.message));
    }, PROVIDER_ID_SCHEDULER_MS);
```

- [ ] **Step 5: The job methods**

After the end of `startSnippetIndexer` add:

```js
  // Loads Gmail thread and message ids for cached rows that lack them. Gmail mailboxes only.
  // The plan is read from the database first; a background connection is taken only when a batch
  // needs IMAP. Progress is saved per batch, so any stop resumes on the next trigger.
  async startProviderIdBackfill(account) {
    const cfg = providerProfile(account);
    if (!cfg.gmailThreadIds) return;
    if (this.providerIdBackfillClean.has(account.id) || this.providerIdBackfillRunning.has(account.id)) return;
    // backfillAllFolders starts this job from its finally; running both would split the host budget.
    if (this.backfillAllRunning.has(account.id)) return;
    const cooldown = this._connectCooldown.get(account.id);
    if (cooldown && Date.now() < cooldown.until) return;

    this.providerIdBackfillRunning.add(account.id);
    const generation = this._providerIdGeneration.get(account.id) || 0;
    const host = (account.imap_host || '').toLowerCase();
    let client = null;
    let slotHeld = false;
    try {
      const result = await runProviderIdBackfill({
        query,
        accountId: account.id,
        getClient: async () => {
          if (client) return client;
          if (!slotHeld) {
            await this._bgConnSem.acquire(host);
            slotHeld = true;
          }
          const row = (await query('SELECT * FROM email_accounts WHERE id = $1', [account.id])).rows[0];
          if (!row || !row.enabled) throw Object.assign(new Error('Account deleted or disabled'), { accountUnavailable: true });
          const fresh = await ensureFreshToken(row);
          const { resolved, policy } = await resolveAccountHost(fresh);
          client = await connectImapClient(fresh, resolved, { policy }, 30000, 'Provider id backfill connect');
          return client;
        },
        shouldContinue: async () => {
          const row = (await query('SELECT enabled, oauth_reconnect_required FROM email_accounts WHERE id = $1', [account.id])).rows[0];
          if (!row || !row.enabled || row.oauth_reconnect_required) return false;
          const cd = this._connectCooldown.get(account.id);
          return !(cd && Date.now() < cd.until);
        },
        onProgress: (progress) => {
          this.providerIdProgress.set(account.id, progress);
          this._broadcastProviderIdBackfill(account).catch(() => {});
        },
        pause: async () => {
          // Same courtesy as the snippet indexer: back off while the user is opening messages.
          const quietFor = Date.now() - (this.lastUserActivity.get(account.id) || 0);
          const extraDelay = quietFor < QUIET_WINDOW_MS ? QUIET_WINDOW_MS - quietFor : 0;
          await new Promise(resolve => setTimeout(resolve, cfg.batchDelay + extraDelay));
        },
      });
      if (result.outcome === 'done' && (this._providerIdGeneration.get(account.id) || 0) === generation) {
        this.providerIdBackfillClean.add(account.id);
      }
      logger.debug(`Provider id backfill ${result.outcome} for ${logAccount(account)}: ${result.processed}/${result.total} rows`);
    } catch (err) {
      if (err?.accountUnavailable) return;
      if (await this._handleOAuthRefreshFailure(account, err)) return;
      const detail = extractImapError(err);
      if (isConnectionRefusal(detail)) this._noteConnectionRefusal(account);
      console.warn(`Provider id backfill failed for ${logAccount(account)}: ${detail}`);
      await recordProviderIdBackfillError(query, account.id, detail).catch(() => {});
    } finally {
      if (client) { try { await client.logout(); } catch { /* already disconnected */ } }
      if (slotHeld) this._bgConnSem.release(host);
      this.providerIdBackfillRunning.delete(account.id);
      this.providerIdProgress.delete(account.id);
      this._broadcastProviderIdBackfill(account).catch(() => {});
    }
  }

  // Admin state of the Gmail id backfill for the Gmail mailboxes among `accounts`.
  async providerIdBackfillStates(accounts) {
    const states = new Map();
    const gmail = accounts.filter(account => providerProfile(account).gmailThreadIds);
    if (!gmail.length) return states;
    const { rows } = await query(
      'SELECT account_id, cursors, finished_at, error FROM provider_id_backfill WHERE account_id = ANY($1)',
      [gmail.map(account => account.id)],
    );
    const byAccount = new Map(rows.map(row => [row.account_id, row]));
    for (const account of gmail) {
      states.set(account.id, providerIdBackfillState({
        row: byAccount.get(account.id) || null,
        running: this.providerIdBackfillRunning.has(account.id),
        progress: this.providerIdProgress.get(account.id) || null,
      }));
    }
    return states;
  }

  async _broadcastProviderIdBackfill(account) {
    const state = (await this.providerIdBackfillStates([account])).get(account.id);
    if (state) this.broadcast({ type: 'provider_ids_backfill', accountId: account.id, state });
  }

  // A row the app wrote itself after an APPEND has no Gmail ids, and the sync never refetches its
  // UID. Load them shortly after; a burst of writes collapses into one run.
  _scheduleProviderIdBackfill(account) {
    if (!providerProfile(account).gmailThreadIds) return;
    this._providerIdGeneration.set(account.id, (this._providerIdGeneration.get(account.id) || 0) + 1);
    this.providerIdBackfillClean.delete(account.id);
    clearTimeout(this._providerIdNudges.get(account.id));
    const timer = setTimeout(() => {
      this._providerIdNudges.delete(account.id);
      query('SELECT * FROM email_accounts WHERE id = $1', [account.id])
        .then(result => result.rows[0] && this.startProviderIdBackfill(result.rows[0]))
        .catch(err => console.warn(`Provider id backfill after a local write failed for ${logAccount(account)}:`, err.message));
    }, PROVIDER_ID_NUDGE_DELAY_MS);
    timer.unref?.();
    this._providerIdNudges.set(account.id, timer);
  }

  async _nudgeProviderIdBackfills() {
    for (const accountId of this.connections.keys()) {
      if (this.providerIdBackfillClean.has(accountId) || this.providerIdBackfillRunning.has(accountId)) continue;
      const result = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      if (!result.rows.length) continue;
      this.startProviderIdBackfill(result.rows[0]).catch(err =>
        console.warn(`Scheduled provider id backfill failed for account ${accountId}:`, err.message)
      );
    }
  }
```

If `_handleOAuthRefreshFailure` or `extractImapError` throw on a plain `Error`, read them and adjust the order of checks in the `catch`; do not swallow the error without recording it.

- [ ] **Step 6: Triggers**

1. In the connect path, the `else` branch of `if (shouldBackfill)` currently only logs `Backfill deferred on connect ...`. Add after that log line:

```js
        // Established mailboxes skip the full backfill, so start the Gmail id backfill directly.
        this.startProviderIdBackfill(account).catch(err =>
          console.warn(`Provider id backfill failed to start for ${logAccount(account)}:`, err.message)
        );
```

2. In `backfillAllFolders`, inside `finally`, after the `this.startSnippetIndexer(account).catch(...)` statement add:

```js
      this.startProviderIdBackfill(account).catch(err =>
        console.warn(`Provider id backfill failed to start for ${logAccount(account)}:`, err.message)
      );
```

3. At the end of `upsertSentMessageRecord` (after its `await query(...)`) and at the end of `upsertDraftMessageRecord` (after its INSERT), add:

```js
    this._scheduleProviderIdBackfill(account);
```

- [ ] **Step 7: Clear the new timer in existing tests**

In `backend/src/services/imapManager.test.js`, `backend/src/services/imapManager.serverMailboxes.test.js` and `backend/src/services/imapManager.oauthRefresh.test.js`, find every place that clears `_snippetSchedulerTimer` (`grep -n _snippetSchedulerTimer`) and clear `_providerIdSchedulerTimer` there too: add it to the key arrays, or add `clearInterval(mgr._providerIdSchedulerTimer);` next to a single `clearInterval(mgr._snippetSchedulerTimer);` (use that call's variable name).

- [ ] **Step 8: Run the tests to verify they pass**

Run from `backend/`: `npx vitest run src/services/imapManager.providerIds.test.js src/services/imapManager.test.js src/services/imapManager.serverMailboxes.test.js src/services/imapManager.oauthRefresh.test.js src/services/threading/`
Expected: PASS, all files.

- [ ] **Step 9: Lint**

Run from `backend/`: `npm run lint`
Expected: no problems.

- [ ] **Step 10: Commit**

```bash
git add backend/src/services/imapManager.js backend/src/services/imapManager.providerIds.test.js backend/src/services/imapManager.test.js backend/src/services/imapManager.serverMailboxes.test.js backend/src/services/imapManager.oauthRefresh.test.js
git commit -m "feat(threading): run the Gmail id backfill for connected Gmail mailboxes"
```

---

### Task 4: Backfill state in the admin panel

**Files:**
- Modify: `backend/src/routes/accounts.js` (`router.get('/')`, lines ~68-110)
- Create: `backend/src/routes/accounts.providerIds.test.js`
- Modify: other `backend/src/routes/accounts.*.test.js` only where their `imapManager` mock lacks `providerIdBackfillStates` and a `GET /` test now fails
- Create: `frontend/src/utils/providerIdsBackfill.js`, `frontend/src/utils/providerIdsBackfill.test.js`
- Modify: `frontend/src/hooks/useWebSocket.js` (next to `case 'backfill_all_complete'`)
- Create: `frontend/src/hooks/useWebSocket.providerIds.test.js`
- Modify: `frontend/src/components/AdminPanel.jsx` (connection details bar, around line 1068)
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/ru.json` (inside `admin.accounts`)
- Modify: `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`

**Interfaces:**
- Consumes (Task 3): `imapManager.providerIdBackfillStates(accounts) -> Promise<Map<id, { status, percent, error }>>`; WebSocket event `{ type: 'provider_ids_backfill', accountId, state }`.
- Produces:
  - `GET /api/accounts` rows gain `provider_ids_backfill: { status, percent, error } | null`.
  - `providerIdsBackfillText(state, t) -> string | null` in `frontend/src/utils/providerIdsBackfill.js`.
  - Locale keys `admin.accounts.providerIds.{notStarted,running,runningPercent,paused,done,error}`.

- [ ] **Step 1: Write the failing route test**

Create `backend/src/routes/accounts.providerIds.test.js`:

```js
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: { providerIdBackfillStates: vi.fn() } }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn(async () => []) } }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ROW = {
  name: 'Mailbox', protocol: 'imap', oauth_reconnect_required: false, enabled: true,
  sync_error: null, signature: null, last_sync: new Date(),
};

describe('GET /api/accounts Gmail id backfill', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); imapManager.providerIdBackfillStates.mockReset(); });

  it('adds the state for Gmail mailboxes and null for the others', async () => {
    const running = { status: 'running', percent: 40, error: null };
    imapManager.providerIdBackfillStates.mockResolvedValue(new Map([['g1', running]]));
    query
      .mockResolvedValueOnce({ rows: [
        { ...ROW, id: 'g1', email_address: 'box@gmail.com', imap_host: 'imap.gmail.com' },
        { ...ROW, id: 'o1', email_address: 'box@example.com', imap_host: 'imap.example.com' },
      ] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await fetch(`${base}/api/accounts`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map(a => [a.id, a.provider_ids_backfill])).toEqual([['g1', running], ['o1', null]]);
    expect(imapManager.providerIdBackfillStates).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'g1' }), expect.objectContaining({ id: 'o1' }),
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run from `backend/`: `npx vitest run src/routes/accounts.providerIds.test.js`
Expected: FAIL, `provider_ids_backfill` is `undefined`.

- [ ] **Step 3: Add the field to the route**

In `backend/src/routes/accounts.js`, `router.get('/')`: after the alias map is built and before `const now = Date.now();` add:

```js
  // Gmail id backfill state (threading/providerIdBackfill.js); absent for other providers.
  const providerIdStates = await imapManager.providerIdBackfillStates(result.rows);
```

and in the object returned for each account, after `health: computeAccountHealth(a, now),` add:

```js
      provider_ids_backfill: providerIdStates.get(a.id) ?? null,
```

- [ ] **Step 4: Run the account route tests**

Run from `backend/`: `npx vitest run src/routes/accounts`
Expected: the new test passes. Any other `accounts.*.test.js` whose `GET /` test now fails with a 500 has a `vi.mock('../index.js', ...)` without `providerIdBackfillStates`: add `providerIdBackfillStates: vi.fn(async () => new Map())` to that mock object (keep the rest of the mock unchanged) and rerun until every file passes.

- [ ] **Step 5: Write the failing frontend tests**

Create `frontend/src/utils/providerIdsBackfill.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providerIdsBackfillText } from './providerIdsBackfill.js';

const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const KEYS = ['notStarted', 'running', 'runningPercent', 'paused', 'done', 'error'];

describe('providerIdsBackfillText', () => {
  it('shows nothing for a mailbox without the backfill', () => {
    assert.equal(providerIdsBackfillText(null, t), null);
    assert.equal(providerIdsBackfillText(undefined, t), null);
    assert.equal(providerIdsBackfillText({ status: 'something-else' }, t), null);
  });

  it('names each state', () => {
    assert.equal(providerIdsBackfillText({ status: 'not_started' }, t), 'admin.accounts.providerIds.notStarted');
    assert.equal(providerIdsBackfillText({ status: 'running', percent: null }, t), 'admin.accounts.providerIds.running');
    assert.equal(providerIdsBackfillText({ status: 'running', percent: 40 }, t), 'admin.accounts.providerIds.runningPercent {"percent":40}');
    assert.equal(providerIdsBackfillText({ status: 'paused' }, t), 'admin.accounts.providerIds.paused');
    assert.equal(providerIdsBackfillText({ status: 'done', percent: 100 }, t), 'admin.accounts.providerIds.done');
    assert.equal(providerIdsBackfillText({ status: 'error', error: 'Command failed' }, t), 'admin.accounts.providerIds.error {"error":"Command failed"}');
  });

  it('has English and Russian texts for every state', () => {
    for (const locale of ['en', 'ru']) {
      const messages = JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8'));
      for (const key of KEYS) {
        assert.equal(typeof messages.admin.accounts.providerIds?.[key], 'string', `${locale} admin.accounts.providerIds.${key}`);
      }
    }
  });
});
```

Create `frontend/src/hooks/useWebSocket.providerIds.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json')
    ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true }
    : nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});

let socket;
class FakeSocket {
  static CLOSED = 3;
  constructor() { socket = this; this.readyState = 1; }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeSocket;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { useWebSocket } = await import('./useWebSocket.js');

function App() { useWebSocket(); return null; }

test('a Gmail id backfill event updates the mailbox state', async () => {
  const root = createRoot(document.getElementById('root'));
  useStore.getState().setAccounts([{ id: 'a', enabled: true }, { id: 'b', enabled: true }]);
  try {
    await React.act(async () => { root.render(React.createElement(App)); });
    const state = { status: 'running', percent: 40, error: null };
    await React.act(async () => {
      socket.onmessage({ data: JSON.stringify({ type: 'provider_ids_backfill', accountId: 'a', state }) });
    });
    const accounts = useStore.getState().accounts;
    assert.deepEqual(accounts.find(a => a.id === 'a').provider_ids_backfill, state);
    assert.equal(accounts.find(a => a.id === 'b').provider_ids_backfill, undefined);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
```

- [ ] **Step 6: Run them to verify they fail**

Run from `frontend/`: `node --test src/utils/providerIdsBackfill.test.js src/hooks/useWebSocket.providerIds.test.js`
Expected: FAIL (module not found; the event is ignored).

- [ ] **Step 7: Write the util, the event and the locale keys**

Create `frontend/src/utils/providerIdsBackfill.js`:

```js
// Admin line for loading Gmail thread ids of a mailbox. null when the mailbox has no such job
// (not on Gmail) or the state is unknown to this client.
export function providerIdsBackfillText(state, t) {
  switch (state?.status) {
    case 'not_started':
      return t('admin.accounts.providerIds.notStarted');
    case 'running':
      return state.percent == null
        ? t('admin.accounts.providerIds.running')
        : t('admin.accounts.providerIds.runningPercent', { percent: state.percent });
    case 'paused':
      return t('admin.accounts.providerIds.paused');
    case 'done':
      return t('admin.accounts.providerIds.done');
    case 'error':
      return t('admin.accounts.providerIds.error', { error: state.error || '' });
    default:
      return null;
  }
}
```

In `frontend/src/hooks/useWebSocket.js`, after the `case 'backfill_all_complete': { ... }` block add:

```js
      case 'provider_ids_backfill': {
        updateAccount(data.accountId, { provider_ids_backfill: data.state });
        break;
      }
```

In `frontend/src/locales/en.json`, inside `admin.accounts` (next to `reindexProgress`), add:

```json
      "providerIds": {
        "notStarted": "Gmail thread ids: not loaded yet",
        "running": "Gmail thread ids: loading",
        "runningPercent": "Gmail thread ids: loading, {{percent}}%",
        "paused": "Gmail thread ids: paused, resumes automatically",
        "done": "Gmail thread ids: loaded",
        "error": "Gmail thread ids: failed ({{error}}), retries automatically"
      },
```

In `frontend/src/locales/ru.json`, in the same place:

```json
      "providerIds": {
        "notStarted": "Номера цепочек Gmail: ещё не загружены",
        "running": "Номера цепочек Gmail: загрузка",
        "runningPercent": "Номера цепочек Gmail: загрузка, {{percent}}%",
        "paused": "Номера цепочек Gmail: приостановлено, продолжится автоматически",
        "done": "Номера цепочек Gmail: загружены",
        "error": "Номера цепочек Gmail: ошибка ({{error}}), повтор автоматически"
      },
```

Keep the JSON valid (commas) and the key order of the surrounding block.

- [ ] **Step 8: Show the line in the admin panel**

In `frontend/src/components/AdminPanel.jsx`, import the util next to the other `../utils/` imports:

```js
import { providerIdsBackfillText } from '../utils/providerIdsBackfill.js';
```

In the connection details bar, directly after the `].map(([label, val]) => ( ... ))}` list of IMAP / SMTP / last sync and before `{backfillProgress[account.id] && (`, add:

```jsx
            {providerIdsBackfillText(account.provider_ids_backfill, t) && (
              <div style={{
                fontSize: 11,
                color: account.provider_ids_backfill.status === 'error' ? 'var(--red)' : 'var(--text-tertiary)',
              }}>
                {providerIdsBackfillText(account.provider_ids_backfill, t)}
              </div>
            )}
```

- [ ] **Step 9: Run the frontend tests**

Run from `frontend/`: `node --test src/utils/providerIdsBackfill.test.js src/hooks/useWebSocket.providerIds.test.js src/locales/i18n.test.js`
Expected: PASS, 3 files. Then run the whole frontend suite: `npm test`. Expected: all pass. Then `npm run build` and expect a successful build (catches JSX errors that no test renders).

- [ ] **Step 10: Record PR B as built in the spec**

In `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`:

Replace the first line after the title (`Статус: ...`) with:

```markdown
Статус: решения приняты 2026-09-17. PR A слит (#52). План PR B в `docs/superpowers/plans/2026-09-17-gmail-threading-pr-b-provider-id-backfill.md`, план PR C пишется после его слияния.
```

Replace the three bullets under `### PR B. Догрузка номеров для старых писем` with:

```markdown
- Таблица `provider_id_backfill` (миграция `0062`): по ящику курсор `{ lastUid, uidValidity }` на папку, `finished_at`, `error`. Состояние «идёт» хранится только в памяти процесса, поэтому падение не оставляет ящик «зависшим».
- Модули `services/threading/providerIdBackfill.js` (план и проход) и `providerIdBackfillStore.js` (прогресс). Проход берёт из базы строки без номеров выше курсора пачками по 500 UID, запрашивает `UID FETCH <набор> (UID X-GM-MSGID X-GM-THRID)` и пишет номера одним `UPDATE ... FROM unnest(...)`. Курсор сохраняется после каждой пачки. `thread_id` не меняется.
- Запуск только для ящиков Gmail: после полной догрузки, при подключении ящика, у которого полная догрузка не нужна, через минуту после записи копии в «Отправленных» или черновика (синк не перезапрашивает уже сохранённый UID), и планировщиком раз в 10 минут, пока последний проход не закончился чисто. Соединение берётся из общего фонового бюджета хоста и только если есть что запрашивать.
- Статус в админке у ящика: не начато, идёт (процент), приостановлено, готово, ошибка. Событие WebSocket `provider_ids_backfill`.
- При старте сервер проверяет `indisvalid` индекса `idx_messages_provider_thread` и пишет предупреждение, если индекс невалиден или отсутствует. Переключение на цепочки Gmail в PR C требует валидного индекса.
```

- [ ] **Step 11: Commit**

```bash
git add backend/src/routes/accounts.js backend/src/routes/accounts.providerIds.test.js backend/src/routes/accounts.*.test.js frontend/src/utils/providerIdsBackfill.js frontend/src/utils/providerIdsBackfill.test.js frontend/src/hooks/useWebSocket.js frontend/src/hooks/useWebSocket.providerIds.test.js frontend/src/components/AdminPanel.jsx frontend/src/locales/en.json frontend/src/locales/ru.json docs/superpowers/specs/2026-09-17-gmail-threading-design.md
git commit -m "feat(admin): show Gmail id backfill progress per mailbox"
```

---

### Task 5: Real database check and full verification

No production code changes in this task unless a check fails; a failure goes back to the task that owns the code.

**Files:**
- Scratch only: `verify-provider-ids.mjs` inside the test container, not committed.

- [ ] **Step 1: Start the isolated containers**

With Docker running, from the repository root (Git Bash):

```bash
docker network create mailexpert-test
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-pg-test --network mailexpert-test -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mailexpert postgres:16
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test --network mailexpert-test -v "D:/hub/workspace/Projects/MailExpert:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && echo ready'
```

Expected: `ready`.

- [ ] **Step 2: Full backend suite and lint**

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /work/backend && npx vitest run 2>&1 | tail -5 && npm run lint 2>&1 | tail -3 && npm run lint:plugins 2>&1 | tail -3'
```

Expected: every test file passes; lint and plugin lint report no problems.

- [ ] **Step 3: Apply migrations twice**

Read `backend/src/services/migrations.js` for how it is invoked, then run it twice against the test database:

```bash
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-pg-test -e DB_USER=mailexpert -e DB_PASSWORD=test -e DB_NAME=mailexpert mailexpert-backend-test sh -c 'cd /work/backend && for i in 1 2; do node -e "import(\"./src/services/migrations.js\").then(m => m.runMigrations()).then(() => process.exit(0))"; done'
MSYS_NO_PATHCONV=1 docker exec mailexpert-pg-test psql -U mailexpert -d mailexpert -c "\d provider_id_backfill"
MSYS_NO_PATHCONV=1 docker exec mailexpert-pg-test psql -U mailexpert -d mailexpert -c "SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_messages_provider_thread'"
```

Expected: both runs succeed, the second applies nothing; the table has the five columns from Global Constraints; the index row shows `indisvalid = t`.

- [ ] **Step 4: Run the runner against real PostgreSQL**

This checks the SQL that the unit tests only fake (the jsonb cursor lookup, `unnest`, the cursor merge). Write the script into the container:

```bash
MSYS_NO_PATHCONV=1 docker exec -i mailexpert-backend-test sh -c 'cat > /work/backend/verify-provider-ids.mjs' <<'EOF'
import { query, pool } from './src/services/db.js';
import { runProviderIdBackfill } from './src/services/threading/providerIdBackfill.js';
import { providerThreadIndexState } from './src/services/threading/providerThreadIndex.js';

const user = (await query("INSERT INTO users (username) VALUES ('verify-' || gen_random_uuid()) RETURNING id")).rows[0].id;
const account = (await query(
  "INSERT INTO email_accounts (user_id, name, email_address, imap_host) VALUES ($1, 'Verify', 'verify@gmail.com', 'imap.gmail.com') RETURNING id",
  [user])).rows[0].id;
await query("INSERT INTO folders (account_id, path, name, uid_validity) VALUES ($1, 'INBOX', 'INBOX', 7), ($1, '[Gmail]/Sent Mail', 'Sent Mail', 7)", [account]);
for (const [folder, uid] of [['INBOX', 1], ['INBOX', 2], ['INBOX', 3], ['[Gmail]/Sent Mail', 10]]) {
  await query('INSERT INTO messages (account_id, uid, folder, message_id, thread_id) VALUES ($1, $2, $3, $4, $4)', [account, uid, folder, `<m${uid}@example.com>`]);
}
await query("INSERT INTO provider_id_backfill (account_id, cursors) VALUES ($1, '{\"INBOX\": {\"lastUid\": 1, \"uidValidity\": \"7\"}}')", [account]);

const server = { INBOX: [2, 3], '[Gmail]/Sent Mail': [10] };
const client = {
  mailbox: null,
  async getMailboxLock(path) { this.mailbox = { path, uidValidity: 7n }; return { release() {} }; },
  async *fetch(range) {
    console.log('fetch', this.mailbox.path, range);
    for (const uid of server[this.mailbox.path]) yield { uid, threadId: '1700000000000000001', emailId: String(1800000000000000000n + BigInt(uid)) };
  },
};
const result = await runProviderIdBackfill({ query, accountId: account, getClient: async () => client, shouldContinue: async () => true });
console.log('result', JSON.stringify(result));
console.log('rows', JSON.stringify((await query('SELECT folder, uid, thread_id, provider_thread_id, provider_message_id FROM messages WHERE account_id = $1 ORDER BY folder, uid', [account])).rows));
console.log('state', JSON.stringify((await query('SELECT cursors, finished_at IS NOT NULL AS finished, error FROM provider_id_backfill WHERE account_id = $1', [account])).rows[0]));
console.log('second', JSON.stringify(await runProviderIdBackfill({ query, accountId: account, getClient: async () => { throw new Error('no IMAP expected'); }, shouldContinue: async () => true })));
console.log('index', await providerThreadIndexState(query));
await query('DELETE FROM users WHERE id = $1', [user]);
await pool.end();
EOF
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-pg-test -e DB_USER=mailexpert -e DB_PASSWORD=test -e DB_NAME=mailexpert mailexpert-backend-test sh -c 'cd /work/backend && node verify-provider-ids.mjs'
```

If an `INSERT` fails because a later migration added a required column, read that migration and add the column to the script's `INSERT`.

Expected output:
- `fetch INBOX 2:3` and `fetch [Gmail]/Sent Mail 10` (INBOX row 1 is below the saved cursor and is not fetched);
- `result {"outcome":"done","processed":3,"total":3}`;
- rows: INBOX uid 1 keeps `provider_message_id` null; uids 2, 3 and Sent uid 10 have `provider_thread_id` `1700000000000000001` and their `18000000000000000xx` ids; every `thread_id` still equals its `<mN@example.com>` message id;
- state: cursors `INBOX` lastUid 3 and `[Gmail]/Sent Mail` lastUid 10, both `uidValidity` `"7"`, `finished` true, `error` null;
- `second {"outcome":"done","processed":0,"total":0}`;
- `index valid`.

- [ ] **Step 5: Frontend suite and build**

From `frontend/` on the host: `npm test` and `npm run build`.
Expected: all tests pass; the build succeeds.

- [ ] **Step 6: Remove the test containers**

```bash
docker rm -f mailexpert-backend-test mailexpert-pg-test
docker network rm mailexpert-test
```

Expected: both containers and the network are gone; `docker ps` still lists the user's own containers unchanged.
