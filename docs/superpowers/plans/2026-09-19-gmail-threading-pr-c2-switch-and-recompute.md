# Gmail threading PR C2: switching a mailbox and recomputing its threads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator preview, switch and roll back a mailbox's threading mode, with a resumable batched recompute that rekeys its stored messages — in `gmail` mode by the Gmail thread number, in `rfc` mode by the header chain, which also splits the threads that old subject grouping merged.

**Architecture:** `services/threading/recompute.js` previews with a few aggregate queries and recomputes in batches of 2000 rows, oldest first, reusing the same precedence as `computeThreading` but resolving each batch's ancestors in one query. Progress per mailbox lives in the new `thread_recompute` table, so a restart resumes. The admin panel gets preview, switch and rollback per mailbox; the switch flips `thread_mode`, reconnects the mailbox so the engine picks the new mode up, records `mailbox.threading_changed` in the audit log and starts the recompute. `normalized_subject` and its index are dropped once nothing can group by subject any more. Spec: `docs/superpowers/specs/2026-09-17-gmail-threading-design.md` (section "PR C"); this plan is its second half, after PR C1 (#54). Diagnostics for a single message or thread are a separate later PR.

**Tech Stack:** Node 22 ESM, Express 5, PostgreSQL 16, vitest (backend); React 19, zustand, react-i18next, `node --test` with jsdom (frontend).

## Global Constraints

- Code, comments, commits and PR text in English; no emoji; commits as `wyrtensi`, no Claude co-author lines.
- Migrations: `backend/migrations/0064_thread_recompute.sql` (progress table) and `backend/migrations/0065_drop_normalized_subject.sql` (drop the column and its index). Neither uses the `-- no-transaction` marker; no comment line inside a migration may start with `-- no-transaction` unless it IS the marker (the runner accepts it only as the file's first non-blank line).
- Progress table: `thread_recompute(account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE, target_mode TEXT NOT NULL, cursor_date TIMESTAMPTZ, cursor_id UUID, processed BIGINT NOT NULL DEFAULT 0, changed BIGINT NOT NULL DEFAULT 0, total BIGINT NOT NULL DEFAULT 0, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ, error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`, with `target_mode` CHECK-constrained to `'rfc'` and `'gmail'`.
- Batch size: `RECOMPUTE_BATCH_SIZE = 2000` rows, ordered by `(date, id)` ascending, with a pause of `RECOMPUTE_BATCH_DELAY_MS = 200` between batches.
- Keys and reasons come from the existing exports of `services/threading/threadId.js`: `GMAIL_KEY_PREFIX`, `THREAD_MODE_GMAIL`, `parseReferences`, and the same precedence `computeThreading` uses. Reasons written by the recompute are exactly `gmail-thrid`, `rfc-root`, `rfc-ancestor`, `rfc-provisional`, `new-root`.
- A recompute never reuses a row's stored key as an input: every row is derived from scratch (Gmail number, then header chain, then its own Message-ID). Old keys must not leak into new groups.
- A row is written only when its key or its reason actually changes, and the batch counts rows the database reports as updated, never rows attempted.
- Switching to `gmail` is refused unless: the mailbox's provider profile has `gmailThreadIds`, the index `idx_messages_provider_thread` is valid (`providerThreadIndexState`), and no live row of the mailbox is missing `provider_thread_id` (`is_deleted = false`). The refusal names which check failed.
- Switching to `rfc` has no gate: it is the rollback, and it is also allowed for mailboxes that were never in `gmail` mode, because it splits threads that old subject grouping merged.
- The switch order is: flip `thread_mode`, record the audit entry, reconnect the mailbox, then start the recompute. New mail arriving during the pass already uses the new mode.
- Audit: the action `mailbox.threading_changed` is added to `AUDIT_ACTIONS` in `backend/src/services/auditLog.js`; the entry's `details` carries `{ from, to }`.
- WebSocket event: `{ type: 'thread_recompute', accountId, state }` where state is `{ status, percent, changed, error }` with `status` one of `idle`, `running`, `done`, `error`. It must not be added to the `scheduleCountRefresh` list in `broadcast`.
- Both new endpoints live in `backend/src/routes/accounts.js` behind the router's existing auth, use the `uuidParam('id')` guard, and return 404 for an unknown mailbox.
- Backend tests: `npx vitest run <files>` from `backend/`. Frontend: `node --test <files>`, `npm test`, `npm run build` from `frontend/`. The full backend suite, the migrations and the benchmark run in isolated Docker containers (`mailexpert-backend-test`, `mailexpert-pg-test`, network `mailexpert-test`) — never touch the user's running `mailexpert-*` or other containers. The Windows host fails a few unrelated suites (totp, accounts.aliases, auth, archiver/bcrypt, snippet decode); Docker is the source of truth.
- Nothing is run against a live Gmail mailbox.

---

## File Structure

- Create `backend/migrations/0064_thread_recompute.sql` — progress table.
- Create `backend/migrations/0065_drop_normalized_subject.sql` — drop the generated column and its index.
- Create `backend/src/services/threading/recompute.js` — `previewRecompute`, `runRecompute`, `recomputeState`, batch helpers.
- Create `backend/src/services/threading/recompute.test.js`.
- Create `backend/src/services/threading/recomputeStore.js` and `recomputeStore.test.js` — the progress row.
- Modify `backend/src/services/imapManager.js` — `startThreadRecompute`, its broadcast, the mode flip helper.
- Create `backend/src/services/imapManager.recompute.test.js`.
- Modify `backend/src/services/auditLog.js` and `backend/src/services/auditLog.test.js` — the new action.
- Modify `backend/src/routes/accounts.js` — `thread_mode` in the list, `POST /:id/threading/preview`, `POST /:id/threading/mode`.
- Create `backend/src/routes/accounts.threading.test.js`.
- Modify `backend/src/routes/mail.js` — the stale comment in `gatherSnoozeConversation` and the `normalized_subject` line in the relocate comment.
- Modify `frontend/src/components/AdminPanel.jsx`, `frontend/src/hooks/useWebSocket.js`, `frontend/src/utils/api.js`, `frontend/src/locales/en.json`, `frontend/src/locales/ru.json`.
- Create `frontend/src/utils/threadMode.js` and `frontend/src/utils/threadMode.test.js` — the labels and the button state.
- Modify `docs/architecture/codebase-file-map.md`, `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`.

---

### Task 1: Progress table, store and the audit action

**Files:**
- Create: `backend/migrations/0064_thread_recompute.sql`
- Create: `backend/src/services/threading/recomputeStore.js`, `backend/src/services/threading/recomputeStore.test.js`
- Modify: `backend/src/services/auditLog.js` (the `AUDIT_ACTIONS` array), `backend/src/services/auditLog.test.js`
- Modify: `backend/src/routes/accounts.js` (the `SELECT` of `router.get('/')` and the `SAFE_FIELDS` list)
- Modify: `backend/src/routes/accounts.health.test.js` (the exact-key assertion)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (each takes the `query` function as its first argument):
  - `loadRecompute(query, accountId) -> Promise<row|null>`
  - `startRecomputeRow(query, accountId, targetMode, total) -> Promise<void>` (resets cursor, counters, error and `finished_at`)
  - `saveRecomputeCursor(query, accountId, { cursorDate, cursorId, processed, changed }) -> Promise<void>`
  - `finishRecompute(query, accountId) -> Promise<void>`
  - `recordRecomputeError(query, accountId, message) -> Promise<void>` (truncates to 500 characters)
  - `recomputeState({ row = null, running = false } = {}) -> { status, percent, changed, error }` with `status` in `idle | running | done | error`, `percent` = `Math.min(100, Math.floor(processed / total * 100))` when `total > 0` else `null`
  - `AUDIT_ACTIONS` gains `'mailbox.threading_changed'`
  - `GET /api/accounts` rows gain `thread_mode`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/services/threading/recomputeStore.test.js` in the style of `providerIdBackfillStore.test.js` (read it first — same `vi.fn()` query mock, same table-driven state tests). Cover: `loadRecompute` returns the row or null and passes `[accountId]`; `startRecomputeRow` writes `target_mode`, `total`, zeroed counters and clears `finished_at`/`error` (assert the SQL contains `finished_at = NULL` and `error = NULL` and the parameter list); `saveRecomputeCursor` passes the four values and bumps `updated_at`; `finishRecompute` sets `finished_at = now()`; `recordRecomputeError` truncates a 900-character message to 500 and turns an empty message into `'Unknown error'`; and `recomputeState` for: no row → `idle`; running with `processed 1 / total 4` → `running`, 25; running with `total 0` → `running`, null; row with an error → `error` carrying the text; row with `finished_at` → `done`, 100; row without `finished_at`, not running → `idle` with the stored `changed`.

In `backend/src/services/auditLog.test.js`, extend the test that asserts the known actions so it includes `'mailbox.threading_changed'`.

- [ ] **Step 2: Run them to verify they fail**

Run from `backend/`: `npx vitest run src/services/threading/recomputeStore.test.js src/services/auditLog.test.js`
Expected: FAIL (module missing, action unknown).

- [ ] **Step 3: Write the migration**

Create `backend/migrations/0064_thread_recompute.sql`:

```sql
-- Progress of recomputing a mailbox's thread keys after its threading mode changed.
-- One row per mailbox: the target mode, how far the pass got (cursor over date, id), how many
-- rows it looked at and actually changed, and the last failure. Whether a pass is running is kept
-- in process memory only, so a crash never leaves a mailbox marked as running.
CREATE TABLE IF NOT EXISTS thread_recompute (
  account_id  UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  target_mode TEXT NOT NULL,
  cursor_date TIMESTAMPTZ,
  cursor_id   UUID,
  processed   BIGINT NOT NULL DEFAULT 0,
  changed     BIGINT NOT NULL DEFAULT 0,
  total       BIGINT NOT NULL DEFAULT 0,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE thread_recompute DROP CONSTRAINT IF EXISTS thread_recompute_target_mode_check;
ALTER TABLE thread_recompute ADD CONSTRAINT thread_recompute_target_mode_check CHECK (target_mode IN ('rfc', 'gmail'));
```

- [ ] **Step 4: Write the store**

Create `backend/src/services/threading/recomputeStore.js`, modelled on `providerIdBackfillStore.js`: the five async helpers above with plain `INSERT ... ON CONFLICT (account_id) DO UPDATE` statements, and the pure `recomputeState`. Comment each helper with one line saying what it is for, the way the sibling file does.

- [ ] **Step 5: Add the audit action and expose the mode**

In `backend/src/services/auditLog.js`, add `'mailbox.threading_changed'` to `AUDIT_ACTIONS`, next to the other `mailbox.*` entries.

In `backend/src/routes/accounts.js`, add `thread_mode` to the `SELECT` column list of `router.get('/')` and to `SAFE_FIELDS`. Update the exact-key assertion in `backend/src/routes/accounts.health.test.js` (it lists the keys a row must have) — add `thread_mode`, keeping the list's existing order convention.

- [ ] **Step 6: Run the tests to verify they pass**

Run from `backend/`: `npx vitest run src/services/threading/ src/services/auditLog.test.js src/routes/accounts`
Expected: PASS. If another `accounts.*.test.js` asserts an exact key list, extend it the same way and say so in the report.

- [ ] **Step 7: Lint and commit**

```bash
git add backend/migrations/0064_thread_recompute.sql backend/src/services/threading/recomputeStore.js backend/src/services/threading/recomputeStore.test.js backend/src/services/auditLog.js backend/src/services/auditLog.test.js backend/src/routes/accounts.js backend/src/routes/accounts.health.test.js
git commit -m "feat(threading): store thread recompute progress and expose the mailbox thread mode"
```

(Run `npm run lint` from `backend/` before committing; expected: no problems.)

---

### Task 2: Preview and the batched recompute

**Files:**
- Create: `backend/src/services/threading/recompute.js`
- Create: `backend/src/services/threading/recompute.test.js`

**Interfaces:**
- Consumes (Task 1): `loadRecompute`, `startRecomputeRow`, `saveRecomputeCursor`, `finishRecompute` from `./recomputeStore.js`. Existing: `GMAIL_KEY_PREFIX`, `THREAD_MODE_GMAIL`, `parseReferences` from `./threadId.js`.
- Produces:
  - `RECOMPUTE_BATCH_SIZE = 2000`, `RECOMPUTE_BATCH_DELAY_MS = 200`
  - `previewRecompute(query, accountId, targetMode) -> Promise<{ rows, changing, subjectOnly, threadsNow, threadsAfter }>`
  - `runRecompute({ query, accountId, targetMode, shouldContinue, onProgress = () => {}, pause = async () => {} }) -> Promise<{ outcome: 'done'|'stopped', processed, changed, total }>`
  - `threadingForRow(row, { mode, ancestorKeys })` (exported for tests) → `{ threadId, reason }`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/services/threading/recompute.test.js`. Use the same shape as `providerIdBackfill.test.js`: a `fakeDb` that routes SQL by regex over an in-memory array of rows and records the UPDATEs. Cover:

- `threadingForRow`:
  - gmail mode with `provider_thread_id` → `{ threadId: 'gmail:17', reason: 'gmail-thrid' }`;
  - gmail mode without it → the header branch;
  - rfc mode with a `provider_thread_id` present → still the header branch;
  - no headers → own Message-ID, `new-root`;
  - the first Reference resolved through `ancestorKeys` → that key, `rfc-root`;
  - only a later Reference resolved → that key, `rfc-ancestor`;
  - nothing resolved → first Reference, `rfc-provisional`;
  - `in_reply_to` already present in References is not added twice.
- `previewRecompute` for target `gmail`: counts rows whose stored key differs from `gmail:<number>`, counts rows that have no headers and a key that is not their own Message-ID (the ones old subject grouping glued), and reports the distinct key counts before and after.
- `runRecompute`:
  - rekeys a mailbox to `gmail:` keys, writes `gmail-thrid`, and reports `changed` equal to the number of rows the database reported as updated, not the number attempted (make the fake return a smaller `rowCount` for one batch and assert the reported total follows the database);
  - splits a subject-glued group in `rfc` mode: three rows sharing a stored key, none carrying headers, end up with three keys, each its own Message-ID, reason `new-root`;
  - a reply whose ancestor is recomputed earlier in the same batch follows the ancestor's new key (the batch must consult its own pending updates, not only the database);
  - rows are processed oldest first and the cursor is saved per batch, so a second run with a stored cursor starts after it;
  - `shouldContinue` returning false stops the pass with `outcome: 'stopped'` and no finish mark;
  - a run that reaches the end marks the pass finished, and running it again changes nothing (`changed: 0`) — idempotence;
  - a row whose key and reason are already correct is not written.

- [ ] **Step 2: Run them to verify they fail**

Run from `backend/`: `npx vitest run src/services/threading/recompute.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

Create `backend/src/services/threading/recompute.js`. Shape:

```js
// Recomputes the thread key of a mailbox's stored messages after its mode changed. Every row is
// derived from scratch — the Gmail thread number, else the RFC 5322 chain, else its own
// Message-ID — so a key that only ever existed because of the old subject grouping cannot
// survive, and a group that was glued by subject splits into its real conversations.
import { GMAIL_KEY_PREFIX, THREAD_MODE_GMAIL, parseReferences } from './threadId.js';
import { finishRecompute, loadRecompute, saveRecomputeCursor, startRecomputeRow } from './recomputeStore.js';

export const RECOMPUTE_BATCH_SIZE = 2000;
export const RECOMPUTE_BATCH_DELAY_MS = 200;

// ancestorKeys: Map of Message-ID -> thread key, holding both the keys already stored in the
// database and the ones this pass assigned earlier (a reply must follow its ancestor's NEW key).
export function threadingForRow(row, { mode, ancestorKeys }) {
  if (mode === THREAD_MODE_GMAIL && row.provider_thread_id) {
    return { threadId: `${GMAIL_KEY_PREFIX}${row.provider_thread_id}`, reason: 'gmail-thrid' };
  }
  if (!row.message_id) return { threadId: null, reason: null };
  const candidates = parseReferences(row.thread_references);
  if (row.in_reply_to && !candidates.includes(row.in_reply_to)) candidates.push(row.in_reply_to);
  if (candidates.length === 0) return { threadId: row.message_id, reason: 'new-root' };
  if (ancestorKeys.has(candidates[0])) return { threadId: ancestorKeys.get(candidates[0]), reason: 'rfc-root' };
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (ancestorKeys.has(candidates[i])) return { threadId: ancestorKeys.get(candidates[i]), reason: 'rfc-ancestor' };
  }
  return { threadId: candidates[0], reason: 'rfc-provisional' };
}
```

`previewRecompute(query, accountId, targetMode)` runs aggregates only — no per-row walk, so the admin gets an answer in seconds:

```sql
-- gmail target
SELECT
  count(*)::bigint AS rows,
  count(*) FILTER (
    WHERE m.provider_thread_id IS NOT NULL
      AND m.thread_id IS DISTINCT FROM $2 || m.provider_thread_id
  )::bigint AS changing,
  count(*) FILTER (
    WHERE m.in_reply_to IS NULL AND m.thread_references IS NULL
      AND m.thread_id IS DISTINCT FROM m.message_id
  )::bigint AS subject_only,
  count(DISTINCT m.thread_key)::bigint AS threads_now,
  count(DISTINCT COALESCE($2 || m.provider_thread_id, m.thread_key))::bigint AS threads_after
FROM messages m
WHERE m.account_id = $1 AND m.is_deleted = false
```

For the `rfc` target the `changing` filter is the rows that carry a `gmail:` key plus the subject-only rows, and `threads_after` is not predictable from SQL: report it as `null` and let the admin panel show a dash. Write the two statements separately rather than branching inside one SQL string, and comment what each count means.

`runRecompute` loop, per batch:

1. `if (!(await shouldContinue())) return { outcome: 'stopped', ... }`.
2. Select the next batch after the cursor:
   ```sql
   SELECT id, message_id, in_reply_to, thread_references, provider_thread_id, thread_id, threading_reason, date
   FROM messages
   WHERE account_id = $1 AND is_deleted = false
     AND (date, id) > ($2, $3)
   ORDER BY date, id
   LIMIT $4
   ```
   with the cursor starting at `('-infinity', '00000000-0000-0000-0000-000000000000')`.
3. Collect every candidate Message-ID of the batch and resolve them in one query:
   ```sql
   SELECT message_id, thread_id FROM messages
   WHERE account_id = $1 AND message_id = ANY($2) AND thread_id IS NOT NULL
   ```
   Seed `ancestorKeys` from that result, then overwrite entries with the keys this pass has already assigned (keep a `Map` that survives across batches, bounded by clearing it at the start of each batch and re-seeding from the query plus the batch's own assignments).
4. Compute each row with `threadingForRow`, in order, adding `row.message_id -> threadId` to `ancestorKeys` as you go, so a reply later in the batch follows its ancestor.
5. Write only what changed:
   ```sql
   UPDATE messages m
   SET thread_id = v.thread_id, threading_reason = v.reason
   FROM unnest($2::uuid[], $3::text[], $4::text[]) AS v(id, thread_id, reason)
   WHERE m.id = v.id AND m.account_id = $1
     AND (m.thread_id IS DISTINCT FROM v.thread_id OR m.threading_reason IS DISTINCT FROM v.reason)
   ```
   and add the statement's `rowCount` to `changed`.
6. Advance the cursor to the batch's last `(date, id)`, save it with the counters, call `onProgress({ processed, changed, total })`, `await pause()`.

The pass starts by calling `startRecomputeRow` with the mailbox's live row count as `total` (one `count(*)` over the mailbox), unless `loadRecompute` returns a row with the same `target_mode` and no `finished_at` — then it resumes from its cursor and keeps its counters.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `backend/`: `npx vitest run src/services/threading/`
Expected: PASS, every threading test file.

- [ ] **Step 5: Lint and commit**

```bash
git add backend/src/services/threading/recompute.js backend/src/services/threading/recompute.test.js
git commit -m "feat(threading): preview and recompute a mailbox's thread keys in batches"
```

---

### Task 3: Run the recompute from the mail engine

**Files:**
- Modify: `backend/src/services/imapManager.js`
- Create: `backend/src/services/imapManager.recompute.test.js`

**Interfaces:**
- Consumes (Task 1): `recomputeState`, `recordRecomputeError`, `loadRecompute`. (Task 2): `runRecompute`, `RECOMPUTE_BATCH_DELAY_MS`.
- Produces on `ImapManager`:
  - `threadRecomputeRunning: Set<accountId>`
  - `startThreadRecompute(account, targetMode) -> Promise<void>` — no IMAP connection, so it never touches `_bgConnSem`; it paces itself with `RECOMPUTE_BATCH_DELAY_MS` plus the quiet-window backoff already used by the other background jobs.
  - `threadRecomputeStates(accounts) -> Promise<Map<accountId, { status, percent, changed, error }>>`
  - broadcast `{ type: 'thread_recompute', accountId, state }`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/services/imapManager.recompute.test.js`, copying the `vi.mock(...)` header of `imapManager.providerIds.test.js` and adding `vi.mock('./threading/recompute.js', ...)`. Cover:
- a finished run marks nothing as running and broadcasts the final state;
- a second call while a run is in flight does not start a second pass;
- a failing run records the error through the store and clears the running flag;
- `shouldContinue` returns false once the mailbox is disabled or deleted;
- progress broadcasts carry `status: 'running'` with the percent from the store's `recomputeState`;
- `threadRecomputeStates` returns a state per requested mailbox and does not query when given an empty list.

- [ ] **Step 2: Run them to verify they fail**

Run from `backend/`: `npx vitest run src/services/imapManager.recompute.test.js`
Expected: FAIL — `startThreadRecompute` is not a function.

- [ ] **Step 3: Write the wiring**

In `backend/src/services/imapManager.js`:
- import `runRecompute` and the store helpers;
- add `this.threadRecomputeRunning = new Set();` next to the other job sets in the constructor;
- add `startThreadRecompute(account, targetMode)`: return early when already running; add to the set; call `runRecompute` with `query`, the account id, the target mode, a `shouldContinue` that re-reads `enabled` from `email_accounts` (and returns false when the row is gone), an `onProgress` that broadcasts, and a `pause` that waits `RECOMPUTE_BATCH_DELAY_MS` plus the quiet-window extra (`QUIET_WINDOW_MS`, as `startProviderIdBackfill` does); in `catch`, record the error through the store and log it with `logAccount(account)`; in `finally`, delete from the set and broadcast the final state;
- add `threadRecomputeStates(accounts)` mirroring `providerIdBackfillStates` (one `SELECT ... WHERE account_id = ANY($1)` plus `recomputeState`), and a private `_broadcastThreadRecompute(account)`.

- [ ] **Step 4: Run the tests, lint, commit**

Run from `backend/`: `npx vitest run src/services/imapManager.recompute.test.js src/services/imapManager.test.js src/services/imapManager.providerIds.test.js` — expected PASS; then `npm run lint`.

```bash
git add backend/src/services/imapManager.js backend/src/services/imapManager.recompute.test.js
git commit -m "feat(threading): run the thread recompute as a background job"
```

---

### Task 4: Preview and switch from the admin panel

**Files:**
- Modify: `backend/src/routes/accounts.js`
- Create: `backend/src/routes/accounts.threading.test.js`
- Modify: `frontend/src/utils/api.js`, `frontend/src/hooks/useWebSocket.js`, `frontend/src/components/AdminPanel.jsx`, `frontend/src/locales/en.json`, `frontend/src/locales/ru.json`
- Create: `frontend/src/utils/threadMode.js`, `frontend/src/utils/threadMode.test.js`

**Interfaces:**
- Consumes (Task 2): `previewRecompute`. (Task 3): `imapManager.startThreadRecompute`, `imapManager.threadRecomputeStates`, the `thread_recompute` event. Existing: `providerThreadIndexState` from `services/threading/providerThreadIndex.js`, `providerProfile` through `imapManager`, `recordAudit` from `services/auditLog.js`, the `reconnectQueue` helper already used by the settings PATCH.
- Produces:
  - `POST /api/accounts/:id/threading/preview` with body `{ mode: 'rfc'|'gmail' }` → `{ rows, changing, subjectOnly, threadsNow, threadsAfter }`, 400 on an unknown mode.
  - `POST /api/accounts/:id/threading/mode` with body `{ mode }` → `{ ok: true, mode }`, or 409 `{ error: 'threading_switch_blocked', reason }` with `reason` one of `not_gmail`, `index_invalid`, `ids_missing` (and the count for `ids_missing`).
  - `GET /api/accounts` rows gain `thread_recompute: { status, percent, changed, error } | null`.
  - `threadModeLabel(account, t)` and `threadRecomputeText(state, t)` in `frontend/src/utils/threadMode.js`.
  - Locale keys under `admin.accounts.threading`: `title`, `modeRfc`, `modeGmail`, `preview`, `previewResult`, `switchToGmail`, `switchToRfc`, `running`, `done`, `failed`, `blockedNotGmail`, `blockedIndex`, `blockedIds`.

- [ ] **Step 1: Write the failing route tests**

Create `backend/src/routes/accounts.threading.test.js` in the style of `accounts.providerIds.test.js` (same express harness, same `vi.mock('../index.js', ...)`, mocking `imapManager` with the methods the route calls). Cover: preview returns the numbers from `previewRecompute` and rejects an unknown mode with 400; the switch to `gmail` is refused with 409 and reason `not_gmail` for a non-Gmail mailbox, `index_invalid` when the index check does not return `valid`, and `ids_missing` with the count when live rows still lack `provider_thread_id`; a permitted switch updates `thread_mode`, records the audit entry with `{ from, to }`, reconnects through the queue and starts the recompute; switching to `rfc` passes every gate; an unknown mailbox is 404 and a malformed UUID is 400.

- [ ] **Step 2: Run them to verify they fail**

Run from `backend/`: `npx vitest run src/routes/accounts.threading.test.js`
Expected: FAIL — the routes do not exist.

- [ ] **Step 3: Write the routes**

Add both endpoints to `backend/src/routes/accounts.js`, after the `/:id/reindex` route. The switch endpoint, in order: load the mailbox (404 when missing); validate the mode; when the target is `gmail`, run the three gates and answer 409 with the failing reason; `UPDATE email_accounts SET thread_mode = $1 WHERE id = $2`; `recordAudit({ actorUserId: req.session.userId, accountId, action: 'mailbox.threading_changed', details: { from, to } })`; queue the reconnect the same way the settings PATCH does (disconnect, re-read the row, `connectAccount`); start `imapManager.startThreadRecompute(row, mode)` without awaiting it; answer `{ ok: true, mode }`.

Add `thread_recompute` to the `GET /` response the way `provider_ids_backfill` is added (one `threadRecomputeStates` call for the listed rows).

- [ ] **Step 4: Write the failing frontend tests**

Create `frontend/src/utils/threadMode.test.js` (node:test) covering `threadModeLabel` for both modes and `threadRecomputeText` for `idle` (null), `running` with and without a percent, `done` with the changed count, and `error` with the text; plus a check that both locale files carry every key under `admin.accounts.threading`.

Extend `frontend/src/hooks/useWebSocket.providerIds.test.js` — or add a sibling test file — asserting that a `thread_recompute` event patches the account in the store.

- [ ] **Step 5: Write the frontend**

- `frontend/src/utils/api.js`: `previewThreading: (id, mode) => request('POST', `/accounts/${id}/threading/preview`, { mode })` and `setThreadingMode: (id, mode) => request('POST', `/accounts/${id}/threading/mode`, { mode })`.
- `frontend/src/hooks/useWebSocket.js`: a `case 'thread_recompute'` that calls `updateAccount(data.accountId, { thread_recompute: data.state })`.
- `frontend/src/utils/threadMode.js`: the two pure helpers.
- `frontend/src/components/AdminPanel.jsx`: in the mailbox card's details bar, show the current mode and, for administrators, two actions: preview (calls the preview endpoint and shows the four numbers in a notification or an inline line) and switch (to the other mode, with a confirmation that names how many rows will change, taken from the preview). Show `threadRecomputeText(account.thread_recompute, t)` while a pass runs. A 409 answer is surfaced with the matching `blocked*` message. Follow the file's existing `IconBtn` / notification patterns rather than inventing new UI.
- Locale keys in `en.json` and `ru.json`, English and Russian texts, no emoji.

- [ ] **Step 6: Run everything and commit**

Run from `backend/`: `npx vitest run src/routes/accounts` then `npm run lint`. Run from `frontend/`: `node --test src/utils/threadMode.test.js`, then `npm test`, `npm run build`, `npm run lint`.

```bash
git add backend/src/routes/accounts.js backend/src/routes/accounts.threading.test.js frontend/src/utils/api.js frontend/src/utils/threadMode.js frontend/src/utils/threadMode.test.js frontend/src/hooks/useWebSocket.js frontend/src/components/AdminPanel.jsx frontend/src/locales/en.json frontend/src/locales/ru.json
git commit -m "feat(admin): preview and switch a mailbox's threading mode"
```

---

### Task 5: Drop the subject column and the stale comments

**Files:**
- Create: `backend/migrations/0065_drop_normalized_subject.sql`
- Modify: `backend/src/routes/mail.js` (the `gatherSnoozeConversation` comment around line 1786 and the `normalized_subject` line in the relocate comment around line 69)
- Modify: `docs/architecture/codebase-file-map.md`, `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`

- [ ] **Step 1: Check that nothing reads the column**

Run from the repository root: `grep -rn "normalized_subject" backend frontend --include=*.js --include=*.jsx --include=*.sql | grep -v node_modules`
Expected: only the two migrations that created it (`0002`, and any later one that touched it) and the comments named above. If any code reads it, stop and report NEEDS_CONTEXT instead of dropping the column.

- [ ] **Step 2: Write the migration**

Create `backend/migrations/0065_drop_normalized_subject.sql`:

```sql
-- Subject grouping is gone: new mail has not been threaded by subject since 0060, and the
-- recompute rekeys the rows that still carried a subject-formed key. The generated column and
-- its index only cost writes now. Dropping a column is a catalog change; the index goes with it.
DROP INDEX IF EXISTS idx_messages_norm_subject;
ALTER TABLE messages DROP COLUMN IF EXISTS normalized_subject;
```

- [ ] **Step 3: Update the comments**

In `backend/src/routes/mail.js`, the `gatherSnoozeConversation` comment explains that snoozing follows the RFC reply chain rather than `thread_id` because rows synced before the change may still carry a subject-grouped key. Keep the RFC-chain behaviour and rewrite the justification: the reply chain is the conversation the user means, and a mailbox in `gmail` mode groups by a provider key that spans folders, so the chain stays the safer bound. Remove the sentence about a later recompute.

In the relocate-columns comment, drop `normalized_subject` from the list of generated columns that must not be inserted, leaving `search_vector` and `thread_key`.

- [ ] **Step 4: Update the docs**

In `docs/architecture/codebase-file-map.md`, extend the `threading/` bullet with `recompute.js` and `recomputeStore.js` in Russian, in the style of the existing line.

In `docs/superpowers/specs/2026-09-17-gmail-threading-design.md`, replace the remaining C2 bullets with a short Russian paragraph describing what was built: предпросмотр (числа), переключение с проверками, фоновый пересчёт пачками с возобновлением, откат в режим `rfc`, который заодно разбирает старые склейки по теме, запись в журнал, удаление `normalized_subject`. Note that the per-message diagnostics view is the remaining piece and will be its own PR.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0065_drop_normalized_subject.sql backend/src/routes/mail.js docs/architecture/codebase-file-map.md docs/superpowers/specs/2026-09-17-gmail-threading-design.md
git commit -m "feat(threading): drop the subject column now that nothing groups by subject"
```

---

### Task 6: Benchmark and full verification

No production code changes unless a check fails; a failure goes back to the task that owns the code.

- [ ] **Step 1: Start the isolated containers**

```bash
docker network create mailexpert-test
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-pg-test --network mailexpert-test --shm-size=512m -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mailexpert postgres:16
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test --network mailexpert-test -v "D:/hub/workspace/Projects/MailExpert:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && echo ready'
```

The larger `--shm-size` is needed because a parallel VACUUM over the benchmark table fails with the default 64 MB.

- [ ] **Step 2: Full backend suite and lint**

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /work/backend && npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL" && npm run lint 2>&1 | tail -2 && npm run lint:plugins 2>&1 | tail -2'
```

Expected: every file passes; both lints clean.

- [ ] **Step 3: Migrations twice**

```bash
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-pg-test -e DB_USER=mailexpert -e DB_PASSWORD=test -e DB_NAME=mailexpert mailexpert-backend-test sh -c 'cd /work/backend && for i in 1 2; do node -e "import(\"./src/services/migrations.js\").then(m => m.runMigrations()).then(() => process.exit(0), e => { console.error(e); process.exit(1); })" 2>&1 | tail -2; done'
MSYS_NO_PATHCONV=1 docker exec mailexpert-pg-test psql -U mailexpert -d mailexpert -c "\d thread_recompute"
MSYS_NO_PATHCONV=1 docker exec mailexpert-pg-test psql -U mailexpert -d mailexpert -c "\d messages" | grep -c normalized_subject
```

Expected: `0064` and `0065` apply on the first run and nothing on the second; the progress table has its columns and the CHECK; the `normalized_subject` count is 0.

- [ ] **Step 4: Correctness on a seeded mailbox**

Write a script into the container that seeds one mailbox with, in a single subject-glued group: three headerless messages sharing a stored `thread_id`, one reply chain of three messages carrying `In-Reply-To`/`References`, and two messages carrying `provider_thread_id`. Then:
- run `previewRecompute` for `rfc` and print the numbers;
- run `runRecompute` for `rfc` and print, per row, `message_id`, `thread_id`, `threading_reason`;
- run it a second time and print `changed` (must be 0);
- set the mailbox's `thread_mode` to `gmail`, run `runRecompute` for `gmail`, and print the rows again.

Expected: after the `rfc` pass the three headerless rows have three distinct keys, each its own Message-ID with reason `new-root`; the reply chain keeps one key rooted at its first message (`rfc-root` / `rfc-ancestor`); the second run reports `changed: 0`; after the `gmail` pass the two rows with provider numbers carry `gmail:<number>` with reason `gmail-thrid` and the rest are unchanged.

- [ ] **Step 5: Benchmark on a large mailbox**

Seed one mailbox with a million rows (`generate_series`, half of them headerless sharing a handful of subjects, half in reply chains, all with a `provider_thread_id`), `ANALYZE`, then run the `gmail` recompute and measure: wall time per batch, total wall time, and the time of the preview query. Record the numbers in the PR body. Check `pg_stat_activity` (or simply that the suite still responds) to confirm the pass does not hold long locks, and run `VACUUM ANALYZE messages` afterwards.

Expected: the preview answers in seconds; batches are steady (no growth per batch); the pass is interruptible — stop it mid-way with `shouldContinue` returning false and confirm a resumed run continues from the cursor and finishes.

- [ ] **Step 6: Frontend suite and build**

From `frontend/` on the host: `npm test`, `npm run build`.

- [ ] **Step 7: Remove the test containers**

```bash
docker rm -f mailexpert-backend-test mailexpert-pg-test
docker network rm mailexpert-test
```

Expected: the containers and the network are gone; `docker ps` still lists the user's own containers unchanged.
