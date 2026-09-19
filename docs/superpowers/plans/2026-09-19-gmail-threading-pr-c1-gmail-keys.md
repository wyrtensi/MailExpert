# Gmail threading PR C1: Gmail thread keys behind a per-mailbox mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread new mail of a mailbox in `thread_mode = 'gmail'` by its Gmail thread number (`gmail:<X-GM-THRID>`), record why every row got its key, and group thread rows by `(account_id, thread_key)` everywhere, without any way to switch a mailbox from the UI yet.

**Architecture:** `services/threading/threadId.js` gains `computeThreading(...)` returning `{ threadId, reason }`; the Gmail branch is taken only when the mailbox is in `gmail` mode and the message carries a Gmail thread number. The sync, the backfill and the Sent/Drafts writers store the reason, the `ON CONFLICT` rule lets a `gmail:` key replace a non-`gmail:` one, and the id backfill of PR B rekeys rows in `gmail` mode. Thread lists, the thread route and the frontend thread cache are keyed by mailbox plus thread key, so one conversation in two mailboxes is two rows that open separately. `thread_mode` stays `'rfc'` for every mailbox: only SQL can set `'gmail'` in this PR, because switching a mailbox with old rows needs the recompute that PR C2 adds. Spec: `docs/superpowers/specs/2026-09-17-gmail-threading-design.md` (section "PR C"); this plan is its first half.

**Tech Stack:** Node 22 ESM, Express 5, PostgreSQL 16, imapflow 1.7.8, vitest (backend); React 19, zustand, `node --test` with jsdom (frontend).

## Global Constraints

- Code, comments, commits and PR text in English; no emoji; commits as `wyrtensi`, no Claude co-author lines.
- Migration `backend/migrations/0063_thread_mode.sql`: `email_accounts.thread_mode TEXT NOT NULL DEFAULT 'rfc'` with a CHECK constraint allowing exactly `'rfc'` and `'gmail'`; `messages.threading_reason TEXT` nullable, no default.
- Thread key prefix: the exported constant `GMAIL_KEY_PREFIX = 'gmail:'`. Never write the literal `'gmail:'` anywhere else, in JS or SQL: SQL takes it as a parameter.
- Reasons stored in `messages.threading_reason`: `gmail-thrid`, `rfc-root`, `rfc-ancestor`, `rfc-provisional`, `new-root`. No other value is ever written.
- The Gmail branch applies only when the mailbox row has `thread_mode = 'gmail'` AND the message has a provider thread id. Everything else takes the RFC branch, which never falls back to subject.
- No UI, route or admin action sets `thread_mode` in this PR.
- `rerootThreadChildren` is not called for a mailbox in `gmail` mode.
- `ON CONFLICT` precedence: a `gmail:` key from the sync replaces a stored non-`gmail:` key; a stored `gmail:` key is never replaced by a different key; the #378 self-rooted heal stays as the next case.
- The id backfill (`services/threading/providerIdBackfill.js`) sets `thread_id` and `threading_reason` for the rows it fills only when the mailbox is in `gmail` mode and the fetched row has a Gmail thread number.
- Thread grouping is by the pair `(account_id, thread_key)` in `services/messageService.js`, and every `api.getThread` call from the frontend passes the row's `account_id`, including the unified inbox.
- Frontend thread cache keys and `expandedThreadId` use `threadCacheKey(message)` = `` `${account_id}:${thread_id or id}` ``.
- Every `messages` column that relocation must carry goes into `RELOCATE_COPY_COLS` (`backend/src/routes/mail.js`) and into `insertCopiedSibling` (`backend/src/services/imapManager.js`).
- Backend tests: `npx vitest run <files>` from `backend/`. Frontend: `node --test <files>` and `npm test` from `frontend/`. The full backend suite runs in isolated Docker containers (`mailexpert-backend-test`, `mailexpert-pg-test`, network `mailexpert-test`) — never touch the user's running `mailexpert-*` or other containers. The Windows host fails a few unrelated suites (totp, accounts.aliases, auth, archiver/bcrypt, snippet decode); Docker is the source of truth.
- Nothing is run against a live Gmail mailbox.

---

## File Structure

- Create `backend/migrations/0063_thread_mode.sql` — the mode column and the reason column.
- Modify `backend/src/routes/mail.js` — `RELOCATE_COPY_COLS`.
- Modify `backend/src/routes/mail.relocate.test.js` — the new column is carried.
- Modify `backend/src/services/imapManager.js` — `insertCopiedSibling`; the three threading call sites; the live and backfill inserts; the `ON CONFLICT` rule; the reroot skip; the id backfill call.
- Modify `backend/src/services/threading/threadId.js` — `computeThreading`, `GMAIL_KEY_PREFIX`, reasons; `computeThreadId` is removed.
- Modify `backend/src/services/threading/threadId.test.js` — tests for both branches and every reason.
- Modify `backend/src/services/threading/providerIdBackfill.js` and its test — rekey in `gmail` mode.
- Modify `backend/src/services/imapManager.test.js` — insert and conflict tests by column name.
- Modify `backend/src/services/imapManager.providerIds.test.js` — the mode is passed to the runner.
- Modify `backend/src/services/messageService.js` and `messageService.test.js` — pair grouping.
- Modify `backend/src/routes/mail.js` (thread route comment) and `backend/src/routes/mail.thread.test.js`.
- Create `frontend/src/utils/threadKey.js` and `frontend/src/utils/threadKey.test.js`.
- Modify `frontend/src/components/MessageList.jsx`, `frontend/src/components/Sidebar.jsx`, `frontend/src/components/ComposeModal.jsx`, `frontend/src/utils/api.thread.test.js`.
- Modify `docs/architecture/codebase-file-map.md`, `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`.

---

### Task 1: Mode and reason columns

**Files:**
- Create: `backend/migrations/0063_thread_mode.sql`
- Modify: `backend/src/routes/mail.js` (the `RELOCATE_COPY_COLS` array, around line 79)
- Modify: `backend/src/routes/mail.relocate.test.js`
- Modify: `backend/src/services/imapManager.js` (`insertCopiedSibling`, around line 1098)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the columns `email_accounts.thread_mode` (values `'rfc'` / `'gmail'`, default `'rfc'`) and `messages.threading_reason` (nullable text), both carried by relocation and by the copied-sibling insert.

- [ ] **Step 1: Write the failing tests**

In `backend/src/routes/mail.relocate.test.js`, find the test that asserts the carried columns (it names `bcc_addresses`, `provider_thread_id`, `provider_message_id`) and add `threading_reason` to the same assertion list. In the same file, add:

```js
it('carries the threading reason to the relocated row', () => {
  expect(RELOCATE_INSERT_COLS).toContain('threading_reason');
  expect(RELOCATE_SELECT_COLS).toContain('d.threading_reason');
});
```

In `backend/src/services/imapManager.test.js`, find the test that checks the columns `insertCopiedSibling` writes (it asserts `bcc_addresses` and the provider ids) and add `threading_reason` to its expectations, keeping the existing style of that test.

- [ ] **Step 2: Run them to verify they fail**

Run from `backend/`: `npx vitest run src/routes/mail.relocate.test.js src/services/imapManager.test.js -t "threading reason"`
Expected: FAIL — `threading_reason` is not in the column lists.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/0063_thread_mode.sql`:

```sql
-- How a mailbox keys its conversations. 'rfc' threads by the RFC 5322 References chain (what every
-- mailbox does today); 'gmail' keys them by Gmail's own thread number (X-GM-THRID, stored in
-- messages.provider_thread_id by 0060). Only SQL sets 'gmail' for now: switching a mailbox whose
-- rows still carry RFC keys needs the batched recompute that comes with the admin switch.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS thread_mode TEXT NOT NULL DEFAULT 'rfc';
ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_thread_mode_check;
ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_thread_mode_check CHECK (thread_mode IN ('rfc', 'gmail'));

-- Why this row got its thread key: gmail-thrid, rfc-root, rfc-ancestor, rfc-provisional, new-root.
-- Read by the threading diagnostics; NULL for rows stored before this migration.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS threading_reason TEXT;
```

- [ ] **Step 4: Carry the column on relocation and on a copied sibling**

In `backend/src/routes/mail.js`, add `'threading_reason'` to the end of the `RELOCATE_COPY_COLS` array, and extend the comment above the array that lists what is covered so it also names `threading_reason (0063)`.

In `backend/src/services/imapManager.js`, in `insertCopiedSibling`, add `threading_reason` to the INSERT column list and to the SELECT projection, next to `provider_thread_id` / `provider_message_id`, keeping the existing formatting.

- [ ] **Step 5: Run the tests to verify they pass**

Run from `backend/`: `npx vitest run src/routes/mail.relocate.test.js src/routes/mail.relocateProviderIds.test.js src/services/imapManager.test.js`
Expected: PASS.

- [ ] **Step 6: Lint**

Run from `backend/`: `npm run lint`
Expected: no problems.

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/0063_thread_mode.sql backend/src/routes/mail.js backend/src/routes/mail.relocate.test.js backend/src/services/imapManager.js backend/src/services/imapManager.test.js
git commit -m "feat(threading): add the per-mailbox thread mode and the threading reason column"
```

---

### Task 2: Thread computation with a Gmail branch

**Files:**
- Modify: `backend/src/services/threading/threadId.js`
- Modify: `backend/src/services/threading/threadId.test.js`

**Interfaces:**
- Consumes (Task 1): the values of `thread_mode` (`'rfc'` / `'gmail'`).
- Produces:
  - `GMAIL_KEY_PREFIX = 'gmail:'`
  - `THREAD_MODE_GMAIL = 'gmail'`
  - `parseReferences(refHeader) -> string[]` (unchanged)
  - `computeThreading(accountId, messageId, inReplyTo, references, { mode = 'rfc', providerThreadId = null } = {}) -> Promise<{ threadId: string|null, reason: string|null }>`
  - `computeThreadId` is removed; callers use `computeThreading`.

- [ ] **Step 1: Write the failing tests**

Replace the body of `backend/src/services/threading/threadId.test.js` with tests for the new function, keeping the file's existing mock of `../db.js` and its fixture style. The suite must cover:

```js
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

const { query } = await import('../db.js');
import { GMAIL_KEY_PREFIX, THREAD_MODE_GMAIL, computeThreading, parseReferences } from './threadId.js';

beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

describe('computeThreading — Gmail branch', () => {
  it('keys by the Gmail thread number in gmail mode', async () => {
    expect(await computeThreading('a1', '<m@example.com>', null, null, { mode: THREAD_MODE_GMAIL, providerThreadId: '1700000000000000001' }))
      .toEqual({ threadId: `${GMAIL_KEY_PREFIX}1700000000000000001`, reason: 'gmail-thrid' });
    expect(query).not.toHaveBeenCalled();
  });

  it('keys by the Gmail number even when the message has no Message-ID', async () => {
    expect(await computeThreading('a1', null, null, null, { mode: THREAD_MODE_GMAIL, providerThreadId: '17' }))
      .toEqual({ threadId: `${GMAIL_KEY_PREFIX}17`, reason: 'gmail-thrid' });
  });

  it('falls back to the RFC chain in gmail mode when the number is missing', async () => {
    expect(await computeThreading('a1', '<m@example.com>', null, null, { mode: THREAD_MODE_GMAIL, providerThreadId: null }))
      .toEqual({ threadId: '<m@example.com>', reason: 'new-root' });
  });

  it('ignores a Gmail number in rfc mode', async () => {
    expect(await computeThreading('a1', '<m@example.com>', null, null, { providerThreadId: '17' }))
      .toEqual({ threadId: '<m@example.com>', reason: 'new-root' });
  });
});

describe('computeThreading — RFC branch', () => {
  it('returns nothing for a message without a Message-ID', async () => {
    expect(await computeThreading('a1', null, null, null)).toEqual({ threadId: null, reason: null });
  });

  it('adopts the stored root named first in References', async () => {
    query.mockResolvedValue({ rows: [
      { message_id: '<root@example.com>', thread_id: '<root@example.com>' },
      { message_id: '<mid@example.com>', thread_id: '<root@example.com>' },
    ] });
    expect(await computeThreading('a1', '<new@example.com>', '<mid@example.com>', '<root@example.com> <mid@example.com>'))
      .toEqual({ threadId: '<root@example.com>', reason: 'rfc-root' });
  });

  it('adopts the newest stored ancestor when the root is not stored', async () => {
    query.mockResolvedValue({ rows: [{ message_id: '<mid@example.com>', thread_id: `${GMAIL_KEY_PREFIX}17` }] });
    expect(await computeThreading('a1', '<new@example.com>', '<mid@example.com>', '<root@example.com> <mid@example.com>'))
      .toEqual({ threadId: `${GMAIL_KEY_PREFIX}17`, reason: 'rfc-ancestor' });
  });

  it('uses the referenced root provisionally when no ancestor is stored', async () => {
    expect(await computeThreading('a1', '<new@example.com>', '<mid@example.com>', '<root@example.com> <mid@example.com>'))
      .toEqual({ threadId: '<root@example.com>', reason: 'rfc-provisional' });
  });

  it('starts a new thread when the message has no threading headers', async () => {
    expect(await computeThreading('a1', '<new@example.com>', null, null))
      .toEqual({ threadId: '<new@example.com>', reason: 'new-root' });
    expect(query).not.toHaveBeenCalled();
  });

  it('adds In-Reply-To to the candidates only once', async () => {
    await computeThreading('a1', '<new@example.com>', '<mid@example.com>', '<mid@example.com>');
    expect(query.mock.calls[0][1]).toEqual(['a1', ['<mid@example.com>']]);
  });
});

describe('parseReferences', () => {
  it('reads the angle-bracketed ids in order', () => {
    expect(parseReferences('<a@x> <b@x>')).toEqual(['<a@x>', '<b@x>']);
    expect(parseReferences(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run from `backend/`: `npx vitest run src/services/threading/threadId.test.js`
Expected: FAIL — `computeThreading` is not exported.

- [ ] **Step 3: Rewrite the module**

Replace `computeThreadId` in `backend/src/services/threading/threadId.js` with:

```js
// A mailbox in gmail mode keys its conversations by Gmail's own thread number; everything else
// keys them by the RFC 5322 References chain inside one mailbox.
export const GMAIL_KEY_PREFIX = 'gmail:';
export const THREAD_MODE_GMAIL = 'gmail';

// Thread key and the reason it was chosen, for one incoming message. The Gmail branch needs both
// the mailbox mode and a Gmail thread number: a mailbox switched to gmail mode still receives
// messages whose number has not been loaded yet, and those thread by their headers. A message
// without threading headers starts its own thread: grouping by subject merged unrelated mail that
// shares a subject such as "Invoice" or "Report".
export async function computeThreading(accountId, messageId, inReplyTo, references, { mode = 'rfc', providerThreadId = null } = {}) {
  if (mode === THREAD_MODE_GMAIL && providerThreadId) {
    return { threadId: `${GMAIL_KEY_PREFIX}${providerThreadId}`, reason: 'gmail-thrid' };
  }
  if (!messageId) return { threadId: null, reason: null };

  const candidates = parseReferences(references);
  if (inReplyTo && !candidates.includes(inReplyTo)) candidates.push(inReplyTo);
  if (candidates.length === 0) return { threadId: messageId, reason: 'new-root' };

  const rows = await query(
    `SELECT message_id, thread_id FROM messages
     WHERE account_id = $1 AND message_id = ANY($2) AND thread_id IS NOT NULL`,
    [accountId, candidates]
  );
  if (rows.rows.length > 0) {
    const found = new Map(rows.rows.map(r => [r.message_id, r.thread_id]));
    // Prefer the thread root (first Reference per RFC 5322), then the newest stored ancestor.
    if (found.has(candidates[0])) return { threadId: found.get(candidates[0]), reason: 'rfc-root' };
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (found.has(candidates[i])) return { threadId: found.get(candidates[i]), reason: 'rfc-ancestor' };
    }
  }

  // An ancestor is referenced but not stored yet: use the root provisionally. When the root
  // arrives its thread_id equals its own Message-ID, so the thread converges.
  return { threadId: candidates[0], reason: 'rfc-provisional' };
}
```

Keep `parseReferences` as it is. Remove `computeThreadId` entirely (Task 3 moves its callers).

- [ ] **Step 4: Run the tests to verify they pass**

Run from `backend/`: `npx vitest run src/services/threading/threadId.test.js`
Expected: PASS. `npx vitest run src/services/imapManager.test.js` will fail until Task 3 — that is expected; do not patch `imapManager.js` here.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/threading/threadId.js backend/src/services/threading/threadId.test.js
git commit -m "feat(threading): compute a Gmail thread key and the reason for it"
```

---

### Task 3: Sync, conflicts and the id backfill honour the mode

**Files:**
- Modify: `backend/src/services/imapManager.js`
  - the import from `./threading/threadId.js` (line ~25)
  - live sync threading and insert (around lines 3464 and 3500-3545)
  - the reroot call after the live insert (around line 3584)
  - backfill threading and insert (around lines 4139 and 4239)
  - `upsertSentMessageRecord` (around line 4930) and `upsertDraftMessageRecord`
  - `startProviderIdBackfill` (the `runProviderIdBackfill` call)
- Modify: `backend/src/services/threading/providerIdBackfill.js`
- Modify: `backend/src/services/threading/providerIdBackfill.test.js`
- Modify: `backend/src/services/imapManager.test.js`, `backend/src/services/imapManager.providerIds.test.js`

**Interfaces:**
- Consumes (Task 1): `email_accounts.thread_mode`, `messages.threading_reason`. (Task 2): `computeThreading`, `GMAIL_KEY_PREFIX`, `THREAD_MODE_GMAIL`.
- Produces:
  - every `messages` insert writes `threading_reason`;
  - `runProviderIdBackfill({ ..., threadMode })` — `'gmail'` makes the fill rekey the rows it touches;
  - `rerootThreadChildren` is skipped in `gmail` mode.

- [ ] **Step 1: Write the failing tests**

In `backend/src/services/imapManager.providerIds.test.js`, add to the `startProviderIdBackfill` describe:

```js
  it('passes the mailbox thread mode to the runner', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockResolvedValue({ outcome: 'done', processed: 0, total: 0, failedFolders: [], skippedFolders: [] });
    await mgr.startProviderIdBackfill({ ...gmail, thread_mode: 'gmail' });
    expect(runProviderIdBackfill.mock.calls[0][0]).toMatchObject({ threadMode: 'gmail' });
  });
```

In `backend/src/services/threading/providerIdBackfill.test.js`, add to the `runProviderIdBackfill` describe (the file's `fakeDb` already routes the UPDATE; extend its UPDATE branch so it also applies `thread_id` / `threading_reason` when the SQL carries them, and record the parameters it received):

```js
  it('rekeys the rows it fills when the mailbox is in gmail mode', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1), row('INBOX', 2)] });
    const client = fakeClient({ INBOX: [gm(1), gm(2, { threadId: undefined })] });

    await run(db, client, { threadMode: 'gmail' });

    expect(db.db.messages.map(m => [m.uid, m.thread_id, m.threading_reason])).toEqual([
      [1, 'gmail:1700000000000000001', 'gmail-thrid'],
      [2, undefined, undefined], // no Gmail thread number: the row keeps its RFC key
    ]);
  });

  it('never touches thread_id in rfc mode', async () => {
    const db = fakeDb({ folders: FOLDERS, messages: [row('INBOX', 1)] });
    const client = fakeClient({ INBOX: [gm(1)] });

    await run(db, client);

    expect(db.db.messages[0].thread_id).toBeUndefined();
    expect(db.db.messages[0].provider_thread_id).toBe('1700000000000000001');
  });
```

In `backend/src/services/imapManager.test.js`, add a describe that drives the insert SQL by column name instead of positional index. Put this helper next to the tests and use it in every new assertion:

```js
// Column lists in these inserts change whenever a migration adds a column; read the value by
// column name so a shifted position fails loudly instead of silently asserting the wrong field.
function insertedValue(sql, params, column) {
  const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(c => c.trim());
  const index = columns.indexOf(column);
  if (index === -1) throw new Error(`column ${column} is not in the insert`);
  return params[index];
}
```

Write them inside the existing `describe('Gmail label memberships (#418)', ...)` block (around line 2322), which already has everything needed: the `acct` fixture (`imap_host: 'imap.gmail.com'`), the `clientFor(folder)` fake whose fetch yields `threadId: '9000<uid>'` and `emailId: '8000<uid>'`, the `sync(mgr, folder)` and `backfill(mgr, folder)` helpers, the `query` mock and the captured `inserts` array (`{ sql, params }` per INSERT). The new tests set `acct.thread_mode` before calling `sync` / `backfill` and read values with `insertedValue(inserts[0].sql, inserts[0].params, '<column>')`:

- `acct.thread_mode = 'gmail'`, then `sync(manager(), 'INBOX')`: `thread_id` is `gmail:90001` and `threading_reason` is `gmail-thrid`;
- the same through `backfill(manager(), 'INBOX')`: same two values;
- `acct.thread_mode = 'rfc'` (and with the field absent): `thread_id` is the message's own `<self@example.com>` and `threading_reason` is `new-root`;
- in `gmail` mode no `UPDATE messages SET thread_id = $1 ... WHERE ... thread_id = $3` reroot statement reaches the `query` mock (capture the SQL texts the mock saw and assert none matches `/UPDATE messages SET thread_id/`); in `rfc` mode one does;
- the insert SQL's `ON CONFLICT` clause contains both `thread_id` and `threading_reason` CASE branches that compare with a parameter, and that parameter's value in `params` is `gmail:` (`expect(inserts[0].params).toContain(GMAIL_KEY_PREFIX)`), with `GMAIL_KEY_PREFIX` imported from `./threading/threadId.js`.

Add one test of the conflict rule's semantics against the real PostgreSQL expectations by asserting the CASE text exactly once (a string match of the two conditions), since the mock cannot evaluate SQL; the end-to-end behaviour is checked against a real database in Task 5.

- [ ] **Step 2: Run them to verify they fail**

Run from `backend/`: `npx vitest run src/services/imapManager.test.js src/services/imapManager.providerIds.test.js src/services/threading/providerIdBackfill.test.js`
Expected: FAIL — `computeThreadId` is gone (Task 2), `threadMode` is not passed, the conflict rule has no prefix.

- [ ] **Step 3: Wire the live sync**

In `backend/src/services/imapManager.js`, change the threading import to:

```js
import { GMAIL_KEY_PREFIX, THREAD_MODE_GMAIL, computeThreading } from './threading/threadId.js';
```

In the live sync, replace the `computeThreadId` call with:

```js
            const providerIds = provider.gmailThreadIds ? gmailProviderIds(msg) : NO_PROVIDER_IDS;
            const { threadId, reason: threadingReason } = await computeThreading(account.id, msgId, inReplyTo, refs, {
              mode: account.thread_mode,
              providerThreadId: providerIds.providerThreadId,
            });
```

(The existing `const providerIds = ...` line moves above the threading call; delete the old one.)

Add `threading_reason` as the last column of that INSERT with a new positional parameter after the provider ids, and pass `threadingReason` in the values array.

In the same statement's `ON CONFLICT ... DO UPDATE SET`, replace the `thread_id` assignment with:

```sql
                  -- A Gmail thread key is the mailbox's own grouping: it replaces a key computed
                  -- from headers. A stored Gmail key stays, including against a different one.
                  thread_id = CASE
                    WHEN EXCLUDED.thread_id LIKE $N || '%'
                         AND (messages.thread_id IS NULL OR messages.thread_id NOT LIKE $N || '%')
                      THEN EXCLUDED.thread_id
                    -- #378: heal a row that was self-rooted (thread_id = its own Message-ID, e.g. a
                    -- Sent copy) once the conversation root is known.
                    WHEN messages.thread_id = messages.message_id
                         AND EXCLUDED.thread_id IS NOT NULL
                         AND EXCLUDED.thread_id <> messages.message_id
                      THEN EXCLUDED.thread_id
                    ELSE COALESCE(messages.thread_id, EXCLUDED.thread_id)
                  END,
                  threading_reason = CASE
                    WHEN EXCLUDED.thread_id LIKE $N || '%'
                         AND (messages.thread_id IS NULL OR messages.thread_id NOT LIKE $N || '%')
                      THEN EXCLUDED.threading_reason
                    WHEN messages.thread_id = messages.message_id
                         AND EXCLUDED.thread_id IS NOT NULL
                         AND EXCLUDED.thread_id <> messages.message_id
                      THEN EXCLUDED.threading_reason
                    ELSE COALESCE(messages.threading_reason, EXCLUDED.threading_reason)
                  END,
```

where `$N` is one new parameter appended to the values array with the value `GMAIL_KEY_PREFIX`. Keep the existing `provider_thread_id` / `provider_message_id` COALESCE lines untouched.

Guard the reroot call that follows the insert:

```js
            // A mailbox keyed by Gmail thread numbers has no provisional roots to move.
            if (account.thread_mode !== THREAD_MODE_GMAIL) {
              await rerootThreadChildren(account.id, threadId, msgId);
            }
```

- [ ] **Step 4: Wire the backfill insert and the Sent/Drafts writers**

In `fetchBackfillBatch`'s consumer (the backfill insert around line 4139), make the same four changes: compute `bfProviderIds` before threading, call `computeThreading` with `{ mode: account.thread_mode, providerThreadId: bfProviderIds.providerThreadId }`, store the reason in the insert (new positional parameter plus the prefix parameter in its own `ON CONFLICT` clause, identical to Step 3), and guard its `rerootThreadChildren` call the same way.

In `upsertSentMessageRecord` and `upsertDraftMessageRecord`, replace the `computeThreadId` call with:

```js
    const { threadId, reason: threadingReason } = msgId
      ? await computeThreading(account.id, msgId, sanitizeStr(inReplyTo), sanitizeStr(references), { mode: account.thread_mode })
      : { threadId: null, reason: null };
```

(the draft writer passes its own `inReplyTo`; it has no References parameter — pass `null` there), add `threading_reason` to both INSERT column lists and values, and add it to their `ON CONFLICT ... DO UPDATE SET` next to the existing `thread_id` case, mirroring that case's condition. These two writers never have a Gmail thread number, so they always take the RFC branch; a reply inherits its ancestor's `gmail:` key through References.

- [ ] **Step 5: Rekey the rows the id backfill fills**

In `backend/src/services/threading/providerIdBackfill.js`:

```js
import { GMAIL_KEY_PREFIX, THREAD_MODE_GMAIL } from './threadId.js';
```

`runProviderIdBackfill` takes `threadMode = 'rfc'` in its options object. Compute once:

```js
  // In gmail mode the thread key follows the number the fill just learned; the sync will not
  // revisit these UIDs, so this UPDATE is where an old row joins its Gmail conversation.
  const rekey = threadMode === THREAD_MODE_GMAIL;
```

and change the UPDATE to:

```js
        await query(
          `UPDATE messages m
           SET provider_thread_id = v.thread_id,
               provider_message_id = v.message_id,
               thread_id = CASE WHEN $6::boolean AND v.thread_id IS NOT NULL
                                THEN $7::text || v.thread_id ELSE m.thread_id END,
               threading_reason = CASE WHEN $6::boolean AND v.thread_id IS NOT NULL
                                       THEN 'gmail-thrid' ELSE m.threading_reason END
           FROM unnest($3::bigint[], $4::text[], $5::text[]) AS v(uid, thread_id, message_id)
           WHERE m.account_id = $1 AND m.folder = $2 AND m.uid = v.uid
             AND m.provider_message_id IS NULL`,
          [accountId, folder.path, found.map(f => f.uid), found.map(f => f.providerThreadId), found.map(f => f.providerMessageId), rekey, GMAIL_KEY_PREFIX],
        );
```

In `imapManager.js`, `startProviderIdBackfill` passes `threadMode: account.thread_mode` in the `runProviderIdBackfill` options.

- [ ] **Step 6: Run the tests to verify they pass**

Run from `backend/`: `npx vitest run src/services/threading/ src/services/imapManager.test.js src/services/imapManager.providerIds.test.js src/services/imapManager.serverMailboxes.test.js src/routes/draft.test.js src/routes/send.reliability.test.js`
Expected: PASS. Fix any test that failed because it still expects the old column count or `computeThreadId`.

- [ ] **Step 7: Lint**

Run from `backend/`: `npm run lint`
Expected: no problems.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/imapManager.js backend/src/services/threading/providerIdBackfill.js backend/src/services/threading/providerIdBackfill.test.js backend/src/services/imapManager.test.js backend/src/services/imapManager.providerIds.test.js
git commit -m "feat(threading): key new Gmail mail by its thread number in gmail mode"
```

---

### Task 4: One thread row per mailbox

**Files:**
- Modify: `backend/src/services/messageService.js` (the threaded branch, lines ~80-168)
- Modify: `backend/src/services/messageService.test.js`
- Modify: `backend/src/routes/mail.js` (the comment above the thread route, around line 300)
- Modify: `backend/src/routes/mail.thread.test.js`
- Create: `frontend/src/utils/threadKey.js`, `frontend/src/utils/threadKey.test.js`
- Modify: `frontend/src/components/MessageList.jsx`, `frontend/src/components/Sidebar.jsx`, `frontend/src/components/ComposeModal.jsx`
- Modify: `frontend/src/utils/api.thread.test.js`

**Interfaces:**
- Consumes: nothing from Tasks 1-3 (this grouping is mode-independent).
- Produces: `threadCacheKey(message) -> string` in `frontend/src/utils/threadKey.js`, used for the store's `threadMessages` keys and `expandedThreadId`.

- [ ] **Step 1: Write the failing backend tests**

In `backend/src/services/messageService.test.js`, add a describe that asserts the threaded SQL groups by the pair (the file already inspects `query.mock.calls[n][0]` SQL text):

```js
describe('listMessages — threaded grouping is per mailbox', () => {
  it('groups, counts and ranks threads by account and thread key', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', include_in_unified_inbox: true }, { id: 'acc-2', include_in_unified_inbox: true }] })
      .mockResolvedValueOnce({ rows: [{ n: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', threaded: 'true' });

    const sql = query.mock.calls[2][0];
    expect(sql).toMatch(/GROUP BY m\.account_id, m\.thread_key/);
    expect(sql).toMatch(/PARTITION BY d\.account_id, d\.thread_id/);
    expect(sql).toContain('(m.account_id, m.thread_key) IN (SELECT account_id, thread_id FROM paged_threads)');
    expect(query.mock.calls[3][0]).toContain('COUNT(DISTINCT (m.account_id, m.thread_key))');
  });
});
```

Check the argument order of `listMessages` in the file's other tests and match it; if the threaded branch issues a different number of queries, adjust the mock chain, not the assertions.

In `backend/src/routes/mail.thread.test.js`, add a test that a request without `accountId` and without `unified=true` still scopes to every enabled mailbox (existing behaviour) and one that `accountId` restricts the query parameter list to that one mailbox — if such tests already exist, leave them and skip this step, noting it in the report.

- [ ] **Step 2: Run them to verify they fail**

Run from `backend/`: `npx vitest run src/services/messageService.test.js src/routes/mail.thread.test.js`
Expected: FAIL on the grouping assertions.

- [ ] **Step 3: Group by the pair in the list query**

In `backend/src/services/messageService.js`, threaded branch:

- `paged_threads` becomes:

```sql
      WITH paged_threads AS (
        SELECT m.account_id, m.thread_key AS thread_id
        FROM messages m
        WHERE ${where}
        GROUP BY m.account_id, m.thread_key
        -- One conversation delivered to two mailboxes is one row per mailbox: the mailboxes are
        -- separate, and a Gmail thread number only means anything inside its own mailbox.
        -- account_id and thread_key break exact date ties so paging is stable (see the flat query).
        ORDER BY MAX(m.date) DESC, m.account_id, m.thread_key
        LIMIT $${p + 1} OFFSET $${p + 2}
      ),
```

- in `deduped`, replace `AND m.thread_key IN (SELECT thread_id FROM paged_threads)` with `AND (m.account_id, m.thread_key) IN (SELECT account_id, thread_id FROM paged_threads)`;
- `thread_totals` selects `m.account_id, m.thread_key AS thread_id`, filters with the same pair predicate and groups by `m.account_id, m.thread_key`;
- the `LEFT JOIN thread_totals tt` condition becomes `ON tt.thread_id = d.thread_id AND tt.account_id = d.account_id`;
- every `OVER (PARTITION BY d.thread_id ...)` in `ranked` becomes `OVER (PARTITION BY d.account_id, d.thread_id ...)` (five windows: the unread count, three `FIRST_VALUE`s and the `ROW_NUMBER`);
- the count query becomes `SELECT COUNT(DISTINCT (m.account_id, m.thread_key))::int AS total`.

- [ ] **Step 4: Run the backend tests to verify they pass**

Run from `backend/`: `npx vitest run src/services/messageService.test.js src/routes/mail.thread.test.js src/routes/mail.unifiedInbox.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing frontend tests**

Create `frontend/src/utils/threadKey.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { threadCacheKey } from './threadKey.js';

describe('threadCacheKey', () => {
  it('separates the same thread key in two mailboxes', () => {
    assert.equal(threadCacheKey({ account_id: 'a1', thread_id: 'gmail:17' }), 'a1:gmail:17');
    assert.notEqual(
      threadCacheKey({ account_id: 'a1', thread_id: '<m@example.com>' }),
      threadCacheKey({ account_id: 'a2', thread_id: '<m@example.com>' }),
    );
  });

  it('falls back to the row id when the row has no thread key', () => {
    assert.equal(threadCacheKey({ account_id: 'a1', id: 'row-1' }), 'a1:row-1');
  });
});
```

In `frontend/src/utils/api.thread.test.js`, add a case asserting that `api.getThread(tid, folder, true, 'acc-1')` puts `accountId=acc-1` in the query string even with `unified` true (follow the file's existing fetch stub).

- [ ] **Step 6: Run them to verify they fail**

Run from `frontend/`: `node --test src/utils/threadKey.test.js src/utils/api.thread.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 7: Key the frontend cache by mailbox and always send the account**

Create `frontend/src/utils/threadKey.js`:

```js
// Cache key for a thread row. The same conversation in two mailboxes has the same thread key in
// both, and each mailbox shows its own row, so the mailbox has to be part of the key: without it
// opening one row would expand the other and serve it the wrong messages.
export function threadCacheKey(message) {
  return `${message?.account_id || 'unknown'}:${message?.thread_id || message?.id}`;
}
```

In `frontend/src/components/MessageList.jsx`:
- import `threadCacheKey`;
- everywhere a thread row's cache or expansion id is computed as `message.thread_id || message.id` (the `tid` locals around lines 798, 817, 824, 1006, 1226, 1741, 2111, 2418 and the `threadMsgs` prop around line 3648), use `threadCacheKey(message)` for `threadMessages[...]`, `setThreadMessages`, `clearThreadMessages`, `invalidateThreadCache` and `expandedThreadId`, and keep the bare thread id for what goes to the API (`api.getThread`'s first argument) and for the row's own data;
- every `api.getThread(...)` call passes the row's account: `api.getThread(tid, effectiveFolder, isUnified, message.account_id)` — drop the `isUnified ? null : ...` conditional.

In `frontend/src/components/Sidebar.jsx`, the drop handler's `api.getThread(payload.threadId, payload.threadFolder, payload.threadUnified, row.account_id)` — drop the conditional the same way.

In `frontend/src/components/ComposeModal.jsx` (around line 828), pass the compose account to `api.getThread(replyThreadId, undefined, false, <account id>)` and store the result under `threadCacheKey({ account_id: <account id>, thread_id: replyThreadId })`. Use whatever field of `composeData` holds the mailbox the reply is written from; if there is none, keep the call as it is and say so in the report instead of guessing.

- [ ] **Step 8: Run the frontend tests and build**

Run from `frontend/`: `node --test src/utils/threadKey.test.js src/utils/api.thread.test.js`, then `npm test`, then `npm run build`.
Expected: all pass, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/messageService.js backend/src/services/messageService.test.js backend/src/routes/mail.js backend/src/routes/mail.thread.test.js frontend/src/utils/threadKey.js frontend/src/utils/threadKey.test.js frontend/src/utils/api.thread.test.js frontend/src/components/MessageList.jsx frontend/src/components/Sidebar.jsx frontend/src/components/ComposeModal.jsx
git commit -m "feat(threading): show one thread row per mailbox and open it scoped to that mailbox"
```

---

### Task 5: Documentation and full verification

**Files:**
- Modify: `docs/architecture/codebase-file-map.md`
- Modify: `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`

- [ ] **Step 1: Update the file map**

In `docs/architecture/codebase-file-map.md`, replace the bullet that starts with ``- `threading/` —`` with:

```markdown
- `threading/` — цепочки писем: `threadId.js` вычисляет ключ цепочки и причину (`computeThreading`: номер Gmail в режиме `gmail`, иначе цепочка `References`/`In-Reply-To`, без склейки по теме), `providerIds.js` читает `X-GM-THRID`/`X-GM-MSGID` из ответа imapflow, `providerIdBackfill.js` догружает эти номера для уже сохранённых писем и в режиме `gmail` переключает их ключ, `providerIdBackfillStore.js` хранит прогресс догрузки, `providerThreadIndex.js` проверяет, что индекс по номеру цепочки валиден.
```

- [ ] **Step 2: Record PR C1 in the design doc**

In `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`, replace the status line after the title with:

```markdown
Статус: решения приняты 2026-09-17. PR A слит (#52), PR B слит (#53). PR C разделён на две части: C1 (ключи Gmail за флагом режима, план `docs/superpowers/plans/2026-09-19-gmail-threading-pr-c1-gmail-keys.md`) и C2 (переключение ящика: пробный пересчёт, фоновый пересчёт, откат, диагностика, аудит), план C2 пишется после слияния C1.
```

In the section `### PR C. Группировка по цепочкам Gmail и диагностика`, put this line first, before the existing bullets:

```markdown
**C1 (сделано):** миграция `0063_thread_mode.sql` (`email_accounts.thread_mode` со значениями `rfc`/`gmail`, `messages.threading_reason`), `computeThreading` возвращает ключ и причину, `ON CONFLICT` отдаёт приоритет ключу `gmail:`, в режиме `gmail` перенос детей выключен, догрузка номеров переключает ключ у заполненных строк, списки и счётчики группируются по паре «ящик + ключ цепочки», чтение цепочки всегда ограничено ящиком строки. Режим ящика в C1 меняется только через SQL. **C2 (осталось):** пункты ниже про переключение, пересчёт, откат, диагностику, журнал и удаление `normalized_subject`.
```

- [ ] **Step 3: Full backend suite and lint in Docker**

From the repository root (Git Bash), with Docker running:

```bash
docker network create mailexpert-test
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-pg-test --network mailexpert-test -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mailexpert postgres:16
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test --network mailexpert-test -v "D:/hub/workspace/Projects/MailExpert:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL" && npm run lint 2>&1 | tail -2 && npm run lint:plugins 2>&1 | tail -2'
```

Expected: every test file passes; both lint runs print no problems.

- [ ] **Step 4: Migrations on a real PostgreSQL**

```bash
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-pg-test -e DB_USER=mailexpert -e DB_PASSWORD=test -e DB_NAME=mailexpert mailexpert-backend-test sh -c 'cd /work/backend && for i in 1 2; do node -e "import(\"./src/services/migrations.js\").then(m => m.runMigrations()).then(() => process.exit(0), e => { console.error(e); process.exit(1); })" 2>&1 | tail -2; done'
MSYS_NO_PATHCONV=1 docker exec mailexpert-pg-test psql -U mailexpert -d mailexpert -c "\d email_accounts" | grep thread_mode
MSYS_NO_PATHCONV=1 docker exec mailexpert-pg-test psql -U mailexpert -d mailexpert -c "INSERT INTO email_accounts (name, email_address, imap_host, thread_mode) VALUES ('Bad', 'bad@example.com', 'imap.example.com', 'nonsense')"
```

Expected: the first run applies `0063`, the second applies nothing; `thread_mode` is `text not null default 'rfc'`; the third command fails with a check-constraint violation.

- [ ] **Step 5: Gmail keys end to end against the real database**

Write this script into the container and run it. It drives the real `computeThreading` and the real id backfill against PostgreSQL with a fake IMAP client:

```bash
MSYS_NO_PATHCONV=1 docker exec -i mailexpert-backend-test sh -c 'cat > /work/backend/verify-gmail-keys.mjs' <<'EOF'
import { query, pool } from './src/services/db.js';
import { computeThreading } from './src/services/threading/threadId.js';
import { runProviderIdBackfill } from './src/services/threading/providerIdBackfill.js';

const account = (await query(
  "INSERT INTO email_accounts (name, email_address, imap_host, thread_mode) VALUES ('Verify', 'verify@gmail.com', 'imap.gmail.com', 'gmail') RETURNING id")).rows[0].id;
await query("INSERT INTO folders (account_id, path, name, uid_validity) VALUES ($1, 'INBOX', 'INBOX', 7)", [account]);

// A message with a Gmail number is keyed by it; its reply without a number inherits that key.
const first = await computeThreading(account, '<a@example.com>', null, null, { mode: 'gmail', providerThreadId: '17' });
await query(
  `INSERT INTO messages (account_id, uid, folder, message_id, thread_id, threading_reason, provider_thread_id, provider_message_id)
   VALUES ($1, 1, 'INBOX', '<a@example.com>', $2, $3, '17', '99')`,
  [account, first.threadId, first.reason]);
const reply = await computeThreading(account, '<b@example.com>', '<a@example.com>', '<a@example.com>', { mode: 'gmail' });
console.log('first', JSON.stringify(first), 'reply', JSON.stringify(reply));

// An old row without ids, filled by the backfill in gmail mode, is rekeyed.
await query(
  `INSERT INTO messages (account_id, uid, folder, message_id, thread_id, threading_reason)
   VALUES ($1, 2, 'INBOX', '<c@example.com>', '<c@example.com>', 'new-root')`, [account]);
const client = {
  mailbox: null,
  async getMailboxLock(path) { this.mailbox = { path, uidValidity: 7n }; return { release() {} }; },
  async *fetch() { yield { uid: 2, threadId: '17', emailId: '100' }; },
};
console.log('backfill', JSON.stringify(await runProviderIdBackfill({
  query, accountId: account, threadMode: 'gmail',
  getClient: async () => client, shouldContinue: async () => true,
})));
console.log('rows', JSON.stringify((await query(
  'SELECT uid, thread_id, thread_key, threading_reason FROM messages WHERE account_id = $1 ORDER BY uid', [account])).rows));
console.log('threads', JSON.stringify((await query(
  'SELECT COUNT(DISTINCT (account_id, thread_key))::int AS threads FROM messages WHERE account_id = $1', [account])).rows[0]));
await query('DELETE FROM email_accounts WHERE id = $1', [account]);
await pool.end();
EOF
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-pg-test -e DB_USER=mailexpert -e DB_PASSWORD=test -e DB_NAME=mailexpert mailexpert-backend-test sh -c 'cd /work/backend && node verify-gmail-keys.mjs'
```

Expected:
- `first {"threadId":"gmail:17","reason":"gmail-thrid"} reply {"threadId":"gmail:17","reason":"rfc-root"}`;
- `backfill` reports `"outcome":"done","processed":1`;
- rows: uid 1 and uid 2 both have `thread_id` and `thread_key` `gmail:17` and reason `gmail-thrid`;
- `threads` is 1.

If an INSERT fails because a later migration added a required column, read that migration and extend the script's INSERT.

Not covered by this script: the `ON CONFLICT` precedence between a stored key and an incoming `gmail:` key is asserted only as SQL text in Task 3, because it lives inside the sync's insert. Say so in the PR body; the recompute of PR C2 exercises it on real data.

- [ ] **Step 6: Frontend suite and build**

From `frontend/` on the host: `npm test` and `npm run build`.
Expected: all tests pass; the build succeeds.

- [ ] **Step 7: Commit the docs**

```bash
git add docs/architecture/codebase-file-map.md docs/superpowers/specs/2026-09-17-gmail-threading-design.md
git commit -m "docs: record the Gmail thread keys and the per-mailbox thread rows"
```

- [ ] **Step 8: Remove the test containers**

```bash
docker rm -f mailexpert-backend-test mailexpert-pg-test
docker network rm mailexpert-test
```

Expected: both containers and the network are gone; `docker ps` still lists the user's own containers unchanged.
