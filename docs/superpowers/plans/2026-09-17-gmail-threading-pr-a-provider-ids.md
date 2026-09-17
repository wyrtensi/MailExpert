# Gmail threading PR A: provider thread ids and no subject threading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store Gmail's thread and message ids (`X-GM-THRID`, `X-GM-MSGID`) on every synced Gmail message and stop grouping messages into threads by subject, without changing how threads are keyed yet.

**Architecture:** Two new nullable `messages` columns filled by the live sync and the backfill for the Gmail provider profile only. Thread computation moves out of `imapManager.js` into `backend/src/services/threading/threadId.js` and loses its subject fallback. Later PRs (B: backfill ids for old rows, C: `gmail:` keys, recompute, diagnostics) build on these columns. Spec: `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`.

**Tech Stack:** Node 22 ESM, Express 5, PostgreSQL 16, imapflow 1.7.8, vitest (backend).

## Global Constraints

- Code, comments, commits and PR text in English; no emoji; commits as `wyrtensi`, no Claude co-author lines.
- New columns: `messages.provider_thread_id TEXT`, `messages.provider_message_id TEXT`, both nullable with no default.
- Index: `idx_messages_provider_thread ON messages (account_id, provider_thread_id) WHERE provider_thread_id IS NOT NULL`, created with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` in a `-- no-transaction` migration.
- Migration numbers: `0060_message_provider_ids.sql`, `0061_message_provider_thread_index.sql`.
- Ids are written only for accounts whose provider profile is Gmail (`providerProfile(account)` returns `PROVIDERS.google`). Other providers write `NULL`.
- A stored id is a decimal string of 1 to 20 digits; anything else is stored as `NULL`.
- On conflict a known id is never replaced by `NULL`: `COALESCE(EXCLUDED.x, messages.x)`.
- `thread_id` values are unchanged by this PR except that the subject fallback no longer applies to newly synced messages.
- Every `messages` column that relocation must carry goes into `RELOCATE_COPY_COLS` (`backend/src/routes/mail.js`) and into `insertCopiedSibling` (`backend/src/services/imapManager.js`).
- Threading logic lives in `backend/src/services/threading/`; `imapManager.js` keeps only calls.
- Backend tests run with `npx vitest run <files>` from `backend/`. The full suite runs in Docker (`mailexpert-backend-test` container) or CI.

---

## File Structure

- Create `backend/migrations/0060_message_provider_ids.sql` — the two columns.
- Create `backend/migrations/0061_message_provider_thread_index.sql` — the concurrent index.
- Create `backend/src/services/threading/threadId.js` — `computeThreadId(accountId, messageId, inReplyTo, references)`, `parseReferences(header)`.
- Create `backend/src/services/threading/threadId.test.js`.
- Create `backend/src/services/threading/providerIds.js` — `gmailProviderIds(msg)`.
- Create `backend/src/services/threading/providerIds.test.js`.
- Modify `backend/src/services/imapManager.js` — remove the local `parseReferences`, `SUBJECT_PREFIX_RE`, `normalizeSubject`, `computeThreadId`; import the new ones; Gmail profile flag; fetch queries; live and backfill inserts; `insertCopiedSibling`.
- Modify `backend/src/services/imapManager.test.js` — Gmail id tests in the `Gmail label memberships (#418)` describe; `insertCopiedSibling` column test.
- Modify `backend/src/routes/mail.js` — `RELOCATE_COPY_COLS`.
- Modify `backend/src/routes/mail.relocate.test.js` — new columns carried.
- Modify `docs/superpowers/specs/2026-09-17-gmail-threading-design.md` — PR A scope as built.
- Modify `docs/architecture/codebase-file-map.md` — `services/threading/`.

---

### Task 1: Migrations and relocation carry the provider id columns

**Files:**
- Create: `backend/migrations/0060_message_provider_ids.sql`
- Create: `backend/migrations/0061_message_provider_thread_index.sql`
- Modify: `backend/src/routes/mail.js` (`RELOCATE_COPY_COLS`, around line 79)
- Modify: `backend/src/services/imapManager.js` (`insertCopiedSibling`, around line 1087)
- Test: `backend/src/routes/mail.relocate.test.js`, `backend/src/services/imapManager.test.js` (`describe('insertCopiedSibling'`, around line 345)

**Interfaces:**
- Produces: columns `messages.provider_thread_id`, `messages.provider_message_id` used by Tasks 3 and later PRs.

- [ ] **Step 1: Write the failing tests**

In `backend/src/routes/mail.relocate.test.js`, add after the test `carries the columns that previously went stale (migrations 0037/0044/0050)`:

```js
  it('carries the provider thread and message ids (migration 0060)', () => {
    for (const col of ['provider_thread_id', 'provider_message_id', 'bcc_addresses']) {
      expect(insertCols).toContain(col);
      expect(selectCols).toContain(`d.${col}`);
    }
  });
```

In `backend/src/services/imapManager.test.js`, inside `describe('insertCopiedSibling'`, add after the first `it`:

```js
  it('copies the provider ids and draft Bcc recipients with the row', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: true }] });
    query.mockResolvedValue({ rows: [] });
    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001);
    const ins = findCall('INSERT INTO messages');
    const [insertList, selectList] = ins[0].split('SELECT');
    for (const col of ['provider_thread_id', 'provider_message_id', 'bcc_addresses']) {
      expect(insertList).toContain(col);
      expect(selectList).toContain(col);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/routes/mail.relocate.test.js src/services/imapManager.test.js -t "provider"` (from `backend/`)
Expected: 2 FAIL — the columns are not in the lists.

- [ ] **Step 3: Write the migrations**

`backend/migrations/0060_message_provider_ids.sql`:

```sql
-- Gmail's own ids for a message: X-GM-THRID (the conversation Gmail shows) and X-GM-MSGID (one
-- logical message across all its label folders). Filled by the sync for Gmail accounts only;
-- NULL for other providers and for rows synced before this migration. Nullable with no default,
-- so adding them does not rewrite the table.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
```

`backend/migrations/0061_message_provider_thread_index.sql`:

```sql
-- no-transaction
-- Lookup of a mailbox's messages by Gmail thread id, used when threads are keyed by X-GM-THRID.
-- Partial: only Gmail rows carry the id. Built concurrently so a large messages table stays writable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_provider_thread
  ON messages (account_id, provider_thread_id)
  WHERE provider_thread_id IS NOT NULL;
```

- [ ] **Step 4: Carry the columns on relocation and copy**

In `backend/src/routes/mail.js`, change the last line of `RELOCATE_COPY_COLS`:

```js
  'sender_name', 'sender_email', 'bcc_addresses', 'provider_thread_id', 'provider_message_id',
];
```

In `backend/src/services/imapManager.js`, `insertCopiedSibling`: in both the INSERT column list and the SELECT list, replace the final line

```sql
      category, list_unsubscribe, list_unsubscribe_post, unsubscribed_at, delivery_addresses, sender_name, sender_email
```

with

```sql
      category, list_unsubscribe, list_unsubscribe_post, unsubscribed_at, delivery_addresses, sender_name, sender_email,
      bcc_addresses, provider_thread_id, provider_message_id
```

(`bcc_addresses` from migration 0058 was missing from this copy as well.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/routes/mail.relocate.test.js src/services/imapManager.test.js`
Expected: PASS, no failures in either file.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/0060_message_provider_ids.sql backend/migrations/0061_message_provider_thread_index.sql backend/src/routes/mail.js backend/src/routes/mail.relocate.test.js backend/src/services/imapManager.js backend/src/services/imapManager.test.js
git commit -m "feat(threading): add Gmail thread and message id columns to messages

Relocation and label copies carry them, and the copy now also carries
bcc_addresses, which it dropped since migration 0058."
```

---

### Task 2: Thread computation module without subject threading

**Files:**
- Create: `backend/src/services/threading/threadId.js`
- Create: `backend/src/services/threading/threadId.test.js`
- Modify: `backend/src/services/imapManager.js` (remove lines around 1242-1334: `parseReferences`, `SUBJECT_PREFIX_RE`, `normalizeSubject`, `computeThreadId`; update the three call sites around 3503, 4173, 4796)

**Interfaces:**
- Produces: `computeThreadId(accountId: string, messageId: string|null, inReplyTo: string|null, references: string|null): Promise<string|null>` and `parseReferences(header: string|null): string[]`, both exported from `backend/src/services/threading/threadId.js`.

- [ ] **Step 1: Write the failing tests**

`backend/src/services/threading/threadId.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import { computeThreadId, parseReferences } from './threadId.js';

describe('parseReferences', () => {
  it('returns the bracketed Message-IDs in order', () => {
    expect(parseReferences('<a@x> <b@x>\r\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(parseReferences(null)).toEqual([]);
  });
});

describe('computeThreadId', () => {
  beforeEach(() => query.mockReset());

  it('returns null without a Message-ID', async () => {
    expect(await computeThreadId('acct', null, null, null)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('prefers the thread of the root reference', async () => {
    query.mockResolvedValueOnce({ rows: [
      { message_id: '<root@x>', thread_id: 'T-root' },
      { message_id: '<parent@x>', thread_id: 'T-parent' },
    ] });
    expect(await computeThreadId('acct', '<new@x>', '<parent@x>', '<root@x> <parent@x>')).toBe('T-root');
    expect(query.mock.calls[0][1]).toEqual(['acct', ['<root@x>', '<parent@x>']]);
  });

  it('falls back to the newest known ancestor', async () => {
    query.mockResolvedValueOnce({ rows: [{ message_id: '<parent@x>', thread_id: 'T-parent' }] });
    expect(await computeThreadId('acct', '<new@x>', '<parent@x>', '<root@x> <parent@x>')).toBe('T-parent');
  });

  it('uses the root reference provisionally when no ancestor is stored yet', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await computeThreadId('acct', '<new@x>', '<parent@x>', '<root@x> <parent@x>')).toBe('<root@x>');
  });

  it('starts its own thread without threading headers and never looks up the subject', async () => {
    // Messages without References or In-Reply-To used to join the earliest message with the same
    // normalised subject from the last 90 days, merging unrelated "Invoice" or "Report" mail.
    expect(await computeThreadId('acct', '<lonely@x>', null, null)).toBe('<lonely@x>');
    expect(query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/threading/threadId.test.js`
Expected: FAIL — cannot resolve `./threadId.js`.

- [ ] **Step 3: Write the module**

`backend/src/services/threading/threadId.js`:

```js
import { query } from '../db.js';

// Parse an RFC 5322 References header into its angle-bracketed Message-IDs, in order.
export function parseReferences(refHeader) {
  if (!refHeader) return [];
  return refHeader.match(/<[^>]+>/g) || [];
}

// Thread id for an incoming message, from the RFC 5322 References / In-Reply-To chain inside
// one mailbox. A message without threading headers starts its own thread: grouping by subject
// merged unrelated mail that shares a subject such as "Invoice" or "Report".
export async function computeThreadId(accountId, messageId, inReplyTo, references) {
  if (!messageId) return null;

  const candidates = parseReferences(references);
  if (inReplyTo && !candidates.includes(inReplyTo)) candidates.push(inReplyTo);
  if (candidates.length === 0) return messageId;

  const rows = await query(
    `SELECT message_id, thread_id FROM messages
     WHERE account_id = $1 AND message_id = ANY($2) AND thread_id IS NOT NULL`,
    [accountId, candidates]
  );
  if (rows.rows.length > 0) {
    const found = new Map(rows.rows.map(r => [r.message_id, r.thread_id]));
    // Prefer the thread root (first Reference per RFC 5322), then the newest stored ancestor.
    if (found.has(candidates[0])) return found.get(candidates[0]);
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (found.has(candidates[i])) return found.get(candidates[i]);
    }
  }

  // An ancestor is referenced but not stored yet: use the root provisionally. When the root
  // arrives its thread_id equals its own Message-ID, so the thread converges.
  return candidates[0];
}
```

- [ ] **Step 4: Use the module in imapManager.js**

In `backend/src/services/imapManager.js`:

1. Add to the imports at the top (after `import { generateVCard } from '../utils/vcard.js';`):

```js
import { computeThreadId } from './threading/threadId.js';
```

2. Delete the local `parseReferences` function and its comment, the `SUBJECT_PREFIX_RE` constant, the `normalizeSubject` function and its comment, and the whole local `computeThreadId` function with its comment block (`// Compute the thread_id for an incoming message.` through its closing brace). Keep `rerootThreadChildren` and its comment in place.

3. Update the three call sites to drop the subject argument:

```js
            const threadId = await computeThreadId(account.id, msgId, inReplyTo, refs);
```

```js
                const bfThreadId = await computeThreadId(account.id, bfMsgId, bfReplyTo, bfRefs);
```

```js
      ? await computeThreadId(account.id, msgId, sanitizeStr(inReplyTo), sanitizeStr(references))
```

4. Check nothing else used the removed helpers:

Run: `grep -n "parseReferences\|normalizeSubject\|SUBJECT_PREFIX_RE" src/services/imapManager.js`
Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/services/threading/threadId.test.js src/services/imapManager.test.js src/routes/send src/routes/draft.test.js && npx eslint src/services/imapManager.js src/services/threading`
Expected: PASS; lint prints nothing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/threading/threadId.js backend/src/services/threading/threadId.test.js backend/src/services/imapManager.js
git commit -m "refactor(threading): move thread computation to its own module and drop subject threading

A message without References or In-Reply-To joined the earliest message
with the same normalised subject from the last 90 days, merging unrelated
mail such as separate invoices. It now starts its own thread. Existing
rows keep their thread ids until the recompute in a later change."
```

---

### Task 3: Sync stores Gmail thread and message ids

**Files:**
- Create: `backend/src/services/threading/providerIds.js`
- Create: `backend/src/services/threading/providerIds.test.js`
- Modify: `backend/src/services/imapManager.js` — `PROVIDERS.google` (around line 928), live sync `fetchQuery` (around 3437) and insert (around 3515-3602), backfill `bfQuery` (around 4139) and insert (around 4182-4260)
- Test: `backend/src/services/imapManager.test.js` (`describe('Gmail label memberships (#418)'`, around line 2307)

**Interfaces:**
- Consumes: columns from Task 1.
- Produces: `gmailProviderIds(msg): { providerThreadId: string|null, providerMessageId: string|null }` from `backend/src/services/threading/providerIds.js`; profile flag `PROVIDERS.google.gmailThreadIds === true`.

- [ ] **Step 1: Write the failing unit test**

`backend/src/services/threading/providerIds.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { gmailProviderIds } from './providerIds.js';

describe('gmailProviderIds', () => {
  it('reads X-GM-THRID and X-GM-MSGID as imapflow returns them', () => {
    expect(gmailProviderIds({ threadId: '1778226461893543920', emailId: '1778226461893543921' }))
      .toEqual({ providerThreadId: '1778226461893543920', providerMessageId: '1778226461893543921' });
  });

  it('accepts numbers and bigints and ignores anything that is not a plain decimal id', () => {
    expect(gmailProviderIds({ threadId: 17n, emailId: 18 })).toEqual({ providerThreadId: '17', providerMessageId: '18' });
    expect(gmailProviderIds({ threadId: 'M12abc', emailId: '' })).toEqual({ providerThreadId: null, providerMessageId: null });
    expect(gmailProviderIds({ threadId: '123456789012345678901' })).toEqual({ providerThreadId: null, providerMessageId: null });
    expect(gmailProviderIds({})).toEqual({ providerThreadId: null, providerMessageId: null });
    expect(gmailProviderIds(null)).toEqual({ providerThreadId: null, providerMessageId: null });
  });
});
```

- [ ] **Step 2: Write the failing sync tests**

In `backend/src/services/imapManager.test.js`, inside `describe('Gmail label memberships (#418)'`:

1. Change the `fetch` of `clientFor` so every message carries Gmail ids:

```js
      fetch: vi.fn(async function* (range) {
        const uids = range.includes(':') ? serverUids : range.split(',').map(Number);
        for (const uid of uids) yield { uid, folder, threadId: `9000${uid}`, emailId: `8000${uid}` };
      }),
```

2. Replace the `INSERT INTO messages` branch of the `query.mockImplementation` in `beforeEach` so it also records the SQL and parameters:

```js
      if (sql.includes('INSERT INTO messages')) {
        inserts.push({ sql, params });
        const exists = rows.some(r => r.folder === params[2] && r.uid === params[1]);
        if (!exists) rows.push({ folder: params[2], uid: params[1], messageId: params[3] });
        return { rows: [{ id: `row-${rows.length}`, is_new: !exists }] };
      }
```

and declare `inserts` with the other variables: change `let rows, acct, serverUids;` to `let rows, acct, serverUids, inserts;` and add `inserts = [];` next to `rows = []; serverUids = [1];` in `beforeEach`.

3. Add these tests at the end of the describe:

```js
  for (const mode of ['sync', 'backfill']) {
    it(`${mode} asks Gmail for thread ids and stores both ids`, async () => {
      const mgr = manager();
      const client = clientFor('INBOX');
      if (mode === 'sync') {
        await ImapManager.prototype.syncMessages.call(mgr, acct, client, 'INBOX', 20, false, true);
      } else {
        ImapFlow.mockImplementation(function () { return client; });
        const pending = ImapManager.prototype.backfillMessages.call(mgr, acct, 'INBOX');
        await vi.runAllTimersAsync();
        await pending;
      }
      expect(client.fetch.mock.calls.some(([, q]) => q?.threadId === true)).toBe(true);
      const insert = inserts.find(i => i.params[1] === 1);
      expect(insert.sql).toMatch(/provider_thread_id, provider_message_id/);
      expect(insert.params).toContain('90001');
      expect(insert.params).toContain('80001');
      expect(insert.sql).toMatch(/provider_thread_id = COALESCE\(EXCLUDED\.provider_thread_id, messages\.provider_thread_id\)/);
    });

    it(`${mode} stores no provider ids for a server that is not Gmail`, async () => {
      acct.imap_host = 'imap.example.com';
      const mgr = manager();
      const client = clientFor('INBOX');
      if (mode === 'sync') {
        await ImapManager.prototype.syncMessages.call(mgr, acct, client, 'INBOX', 20, false, true);
      } else {
        ImapFlow.mockImplementation(function () { return client; });
        const pending = ImapManager.prototype.backfillMessages.call(mgr, acct, 'INBOX');
        await vi.runAllTimersAsync();
        await pending;
      }
      expect(client.fetch.mock.calls.every(([, q]) => q?.threadId !== true)).toBe(true);
      const insert = inserts.find(i => i.params[1] === 1);
      expect(insert.params).not.toContain('90001');
      expect(insert.params).not.toContain('80001');
    });
  }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/services/threading/providerIds.test.js src/services/imapManager.test.js -t "provider ids|thread ids|gmailProviderIds"`
Expected: FAIL — `providerIds.js` missing; the sync tests fail on `threadId === true` and on the SQL.

- [ ] **Step 4: Write the id reader**

`backend/src/services/threading/providerIds.js`:

```js
// Gmail's ids for a fetched message, as imapflow returns them: X-GM-THRID in `threadId` (only when
// the FETCH asked for `threadId: true`) and X-GM-MSGID in `emailId` (always requested on Gmail).
// Both are unsigned 64-bit integers; anything that is not a plain decimal id is ignored.
const DECIMAL_ID = /^\d{1,20}$/;

function decimalId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return DECIMAL_ID.test(text) ? text : null;
}

export function gmailProviderIds(msg) {
  return {
    providerThreadId: decimalId(msg?.threadId),
    providerMessageId: decimalId(msg?.emailId),
  };
}

export const NO_PROVIDER_IDS = Object.freeze({ providerThreadId: null, providerMessageId: null });
```

- [ ] **Step 5: Ask Gmail for thread ids and store them**

In `backend/src/services/imapManager.js`:

1. Import (next to the Task 2 import):

```js
import { gmailProviderIds, NO_PROVIDER_IDS } from './threading/providerIds.js';
```

2. In `PROVIDERS.google`, add as the first property after `labelStore: true,`:

```js
    // X-GM-THRID / X-GM-MSGID are fetched and stored per message (Gmail threading).
    gmailThreadIds: true,
```

3. Live sync: after the `fetchQuery` object literal (`headers: true,\n        };`), add:

```js
        if (provider.gmailThreadIds) fetchQuery.threadId = true;
```

4. Live sync: after `const threadId = await computeThreadId(account.id, msgId, inReplyTo, refs);` add:

```js
            const providerIds = provider.gmailThreadIds ? gmailProviderIds(msg) : NO_PROVIDER_IDS;
```

In the live sync `INSERT INTO messages` of this block:
- column list: change `sender_name, sender_email` (last line of the list) to `sender_name, sender_email, provider_thread_id, provider_message_id`;
- `VALUES`: append `,$30,$31` after `$29`;
- in `DO UPDATE SET`, after `sender_email = COALESCE(EXCLUDED.sender_email, messages.sender_email)` add:

```sql
,
                  provider_thread_id = COALESCE(EXCLUDED.provider_thread_id, messages.provider_thread_id),
                  provider_message_id = COALESCE(EXCLUDED.provider_message_id, messages.provider_message_id)
```

(the comma goes at the end of the `sender_email` line, before `RETURNING`);
- parameter array: after `sanitizeStr(parsed.senderName), sanitizeStr(parsed.senderEmail),` add `providerIds.providerThreadId, providerIds.providerMessageId,`.

5. Backfill: after the `bfQuery` object literal add:

```js
            if (cfg.gmailThreadIds) bfQuery.threadId = true;
```

After `const bfThreadId = await computeThreadId(account.id, bfMsgId, bfReplyTo, bfRefs);` add:

```js
                const bfProviderIds = cfg.gmailThreadIds ? gmailProviderIds(msg) : NO_PROVIDER_IDS;
```

Make the same three SQL changes in the backfill `INSERT INTO messages` (columns, `$30,$31`, the two `COALESCE` lines after `sender_email = ...`) and append `bfProviderIds.providerThreadId, bfProviderIds.providerMessageId,` after the backfill's `sanitizeStr(parsed.senderName), sanitizeStr(parsed.senderEmail),` parameters.

6. The backfill fetches through `fetchBackfillBatch(sess.client, batch, bfQuery)` (`imapManager.js:1181`), which passes `bfQuery` to `client.fetch` unchanged, so setting `bfQuery.threadId` is enough.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/services/threading src/services/imapManager.test.js src/routes/mail.relocate.test.js && npx eslint src/services/imapManager.js src/services/threading`
Expected: PASS; lint prints nothing.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/threading/providerIds.js backend/src/services/threading/providerIds.test.js backend/src/services/imapManager.js backend/src/services/imapManager.test.js
git commit -m "feat(threading): store Gmail thread and message ids during sync

Gmail accounts ask for X-GM-THRID on the live sync and the backfill and
store it with X-GM-MSGID, which imapflow already fetched and the sync
dropped. A known id is never replaced by NULL. Other providers are
unchanged."
```

---

### Task 4: Documentation and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`
- Modify: `docs/architecture/codebase-file-map.md`

- [ ] **Step 1: Record PR A as built in the spec**

In the spec, section `### PR A. Номера Gmail при синке`, replace the first two bullets (the migration bullet and the `email_accounts.thread_mode` bullet) with:

```markdown
- Миграции `0060_message_provider_ids.sql` (`messages.provider_thread_id`, `messages.provider_message_id`, nullable без default) и `0061_message_provider_thread_index.sql` (индекс `(account_id, provider_thread_id)` через `CONCURRENTLY`). `threading_reason` и `email_accounts.thread_mode` / `thread_backfill` появятся в PR B и C, где используются.
```

and replace `- Модуль \`services/threading/providerIds.js\`: чтение номеров из сообщения imapflow.` with:

```markdown
- Модули `services/threading/threadId.js` (`computeThreadId` без склейки по теме, перенесён из `imapManager.js`) и `services/threading/providerIds.js` (`gmailProviderIds`).
```

- [ ] **Step 2: Add the module to the file map**

In `docs/architecture/codebase-file-map.md`, in the `## Backend` table, add a row after the `routes/oauth.js` row:

```markdown
| `services/threading/` | Цепочки писем: `threadId.js` вычисляет `thread_id` по `References`/`In-Reply-To` без склейки по теме, `providerIds.js` читает `X-GM-THRID`/`X-GM-MSGID` из ответа imapflow для ящиков Gmail |
```

- [ ] **Step 3: Run the full backend suite and lint**

With Docker running, from the repository root:

```bash
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test -v "D:/hub/workspace/Projects/MailExpert:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && npx vitest run 2>&1 | tail -5 && npm run lint 2>&1 | tail -3 && npm run lint:plugins 2>&1 | tail -3'
```

Expected: all test files pass, lint and plugin lint print no problems.

- [ ] **Step 4: Apply the migrations to a real PostgreSQL**

```bash
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-pg-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mailexpert postgres:16
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'apt-get update >/dev/null && apt-get install -y postgresql-client >/dev/null'
```

Then run the backend migration runner against it (read `backend/src/services/migrations.js` for the connection environment variables it uses, typically `DATABASE_URL`), with the container on the same Docker network (`docker network create mailexpert-test` and `docker network connect` both containers). Check:

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-pg-test psql -U postgres -d mailexpert -c "\d messages" | grep provider_
MSYS_NO_PATHCONV=1 docker exec mailexpert-pg-test psql -U postgres -d mailexpert -c "\di idx_messages_provider_thread"
```

Expected: both columns listed as `text`; the index exists and is valid.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-17-gmail-threading-design.md docs/architecture/codebase-file-map.md
git commit -m "docs: record Gmail provider ids and the threading module"
```

- [ ] **Step 6: Clean up the test containers**

```bash
docker rm -f mailexpert-backend-test mailexpert-pg-test
docker network rm mailexpert-test
```
