# Общие ящики, PR 4: журнал — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. В этом проекте пользователь выполняет планы без субагентов: использовать superpowers:executing-plans.

**Goal:** действия пользователей с общими ящиками, отправка и удаление писем, а также действия администратора с пользователями записываются в журнал `mailbox_audit_log` с автором; администратор читает журнал через `GET /api/admin/audit`.

**Architecture:**
- Миграция `0057_mailbox_audit_log.sql` создаёт таблицу и индексы из спецификации дословно.
- Сервис `backend/src/services/auditLog.js` экспортирует одну функцию `recordAudit(entries)`:
  - принимает одну запись или массив;
  - пишет пачку одним `INSERT ... SELECT FROM jsonb_to_recordset(...)` (кусками по 1000);
  - email автора и email ящика подставляет сама база через `LEFT JOIN users` и `LEFT JOIN email_accounts`;
  - никогда не отклоняет промис: ошибка логируется только кодом.
- Маршруты вызывают `recordAudit` без `await` сразу после того, как действие состоялось.
- `GET /api/admin/audit` в `routes/admin.js`: фильтры, страница по 100 записей, курсор по `(occurred_at, id)`.
- Только бэкенд. Экран журнала — PR 5.

**Tech Stack:** Node.js 22, Express 5, PostgreSQL 16, vitest.

**Spec:** `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` — разделы «Журнал», «Разбиение на PR» (пункт 4), «Проверка» (тест журнала).

## Global Constraints

- Комментарии в коде — только на английском.
- Коммиты и PR — от имени `wyrtensi`, без строк атрибуции. Все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- В документах, коммитах и PR — только заглушки `<CF_HOST>`, `<DIRECT_HOST>`, `<TEAM>`, `<AUD>`. Внутренние имена других проектов не упоминаются.
- Тема, текст и вложения писем, пароли, токены и секреты в журнал не попадают. В `mailbox.connection_changed` — только имена полей, без значений.
- Запись журнала не ломает действие: ошибка вставки логируется без содержимого (`err.code`), действие завершается.
- Пишутся только действия пользователей. Синхронизация, правила входящих (`inboxRules.js`, `ruleForwarder.js`, `archiveInbox.js`) журнал не пишут.
- Массовое удаление пишет запись на каждое письмо.
- Автоочистки журнала нет (раздел спецификации «Не входит»).
- Монки-патчинг запрещён.
- Backend-тесты — в `node:22-bookworm-slim`: локальный Node 24 не подходит под `engines`.
- Работа идёт в ветке `feat/mailbox-audit-log` от `main`. Первый коммит ветки — этот план.

## Уточнения спецификации в этом PR

Task 8 вносит их в спецификацию.

1. **`mailbox.added` «как доменный».** Доменных ящиков в коде ещё нет, они появятся в PR 8. Сейчас `mailbox.added` пишут ручное добавление (`POST /api/accounts`) и OAuth-коллбэки Google и Microsoft. PR 8 добавляет запись в свой поток доменного ящика.
2. **`mailbox.connection_changed`** сравнивает присланные значения с сохранёнными: экран настроек отправляет все поля сервера при любом сохранении, поэтому «поле есть в запросе» не означает изменения.
   - Поля: `imap_host`, `imap_port`, `imap_tls`, `imap_skip_tls_verify`, `smtp_host`, `smtp_port`, `smtp_tls`, `auth_user`, `auth_pass`, `smtp_auth_user`, `smtp_auth_pass`.
   - Пароль считается изменённым, если прислан непустой пароль или очищен сохранённый. Значения паролей не сравниваются и не расшифровываются.
   - `imap_tls` выводится из порта, поэтому смена порта 993 ↔ 143 даёт `imap_port` и `imap_tls`.
   - Имя, цвет, подпись, порядок, папки, категоризация и участие в общей ленте в журнал не пишутся.
   - OAuth-приложение меняется только через коллбэк Google. Переподключение на другое приложение пишет `mailbox.reconnected` и `mailbox.connection_changed` с `fields: ['oauth_app_id']`.
3. **`mailbox.enabled` / `mailbox.disabled`** пишутся, только если значение `enabled` действительно изменилось. Один `PUT` может дать и `connection_changed`, и `enabled`/`disabled`.
4. **`mailbox.deleted`**: запись делается после удаления строки, email ящика передаётся явно. `account_id` в такой записи пуст: ящика уже нет, а внешний ключ `ON DELETE SET NULL` обнулил бы его и у старых записей.
5. **`message.sent`** пишется сразу после того, как SMTP-сервер принял письмо, до сохранения копии в «Отправленные». `messageId` — заголовок `Message-ID`, `to`/`cc`/`bcc` — нормализованные адреса. Пересылка правилами не пишется.
6. **`message.deleted`**:
   - пишут `DELETE /api/mail/messages/:id` (в корзину, из корзины навсегда, черновик навсегда), `POST /api/mail/messages/bulk-delete` (запись на каждое успешно удалённое письмо) и `POST /api/mail/folders/empty` (запись на каждое письмо, удалённое из базы после очистки папки на сервере);
   - `messageId` — заголовок `Message-ID` письма, `folder` — папка, из которой удалено, `from` — `from_email`, `permanent` — `true`, если письмо удалено навсегда;
   - не пишет `DELETE /api/mail/draft/:uid`: это служебная очистка черновика окном письма после отправки или отмены, а не удаление письма пользователем;
   - перемещение в корзину перетаскиванием (`bulk-move`) — перемещение, не удаление, и не пишется.
7. **Действия с пользователями:**
   - `user.added` — `POST /api/admin/users` и при создании строки, и при записи email существующему пользователю;
   - `PATCH /api/admin/users/:id` пишет `user.disabled` / `user.enabled` и `user.admin_changed` только по реально изменившимся флагам; смена email не пишется;
   - `details` — `{ userId, email, isAdmin }`: `userId` добавлен, потому что у служебных пользователей email бывает пуст;
   - пользователи, созданные автоматически при входе через Cloudflare, не пишутся: это не действие администратора.
8. **`GET /api/admin/audit`:**
   - `account`, `user` — UUID; `action` — одно из действий таблицы; `from` — включительно, `to` — не включительно, оба ISO 8601; неверный фильтр — 400 `invalid_filter`;
   - ответ `{ entries, nextCursor }`, записи от новых к старым, `nextCursor` — `null` на последней странице;
   - курсор — строка `<occurred_at с микросекундами в UTC>_<id>`, её формирует база, клиент передаёт её в `before` без изменений.

## Как запускать тесты

Backend. Один раз за сессию:

```bash
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test -v "D:/hub/workspace/Projects/MailExpert:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && echo ready'
```

Запуск конкретных файлов (синхронизирует рабочее дерево в контейнер):

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npx vitest run <files>'
```

В шагах ниже это `bt <files>`. Полный прогон — `bt` без файлов. Lint — та же команда, где вместо `npx vitest run` стоит `npm run lint && npm run lint:plugins`.

## Файлы

| Файл | Ответственность |
|---|---|
| Create `backend/migrations/0057_mailbox_audit_log.sql` | Таблица журнала и индексы |
| Create `backend/src/services/auditLog.js` (+ `auditLog.test.js`) | Список действий, запись пачкой без отказов |
| Modify `backend/src/routes/admin.js` (+ `admin.audit.test.js`, `admin.users.test.js`) | `GET /api/admin/audit`; запись действий с пользователями |
| Modify `backend/src/routes/accounts.js` (+ `accounts.audit.test.js`) | `mailbox.added`, `connection_changed`, `enabled`/`disabled`, `deleted` |
| Modify `backend/src/routes/oauthGoogle.js`, `oauth.js` (+ `oauth.google.test.js`, `oauth.microsoft.test.js`) | `mailbox.added`, `reconnected`, смена приложения |
| Modify `backend/src/routes/send.js` (+ `send.audit.test.js`) | `message.sent` |
| Modify `backend/src/routes/mail.js` (+ `mail.deleteAudit.test.js`, `mail.emptyFolder.test.js`) | `message.deleted` |
| Modify существующие тесты маршрутов (перечислены в задачах) | Мок `auditLog.js`, новый SQL удаления ящика |
| Modify `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` | Уточнения и статус |

## Моки журнала в существующих тестах

`recordAudit` вызывает `query` из `db.js`, а тесты маршрутов подменяют `query` через `vi.fn()` с очередями `mockResolvedValueOnce` и проверяют `query.mock.calls[n]`. Фоновая запись журнала забирала бы чужой ответ из очереди и сдвигала индексы. Поэтому каждый существующий тест, который проходит через маршрут с записью журнала, получает строку:

```js
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
```

Её ставят рядом с другими `vi.mock` в начале файла. Новые файлы `send.audit.test.js` и `mail.deleteAudit.test.js` журнал не мокают: они проверяют настоящую запись через мок `query`, в том числе что ошибка вставки не ломает действие.

---

### Task 1: Таблица журнала и запись в неё

**Files:**
- Create: `backend/migrations/0057_mailbox_audit_log.sql`
- Create: `backend/src/services/auditLog.js`
- Test: `backend/src/services/auditLog.test.js`

**Interfaces:**
- Produces:
  - `AUDIT_ACTIONS: readonly string[]` — все действия таблицы спецификации;
  - `recordAudit(entries: AuditEntry | AuditEntry[]): Promise<void>` — никогда не отклоняется;
  - `AuditEntry = { actorUserId?: string|null, accountId?: string|null, accountEmail?: string|null, action: string, details?: object }`.

- [ ] **Step 1: Commit the plan**

```bash
git add docs/superpowers/plans/2026-09-17-shared-mailboxes-pr4-audit-log.md
git commit -m "docs: plan the mailbox audit log"
```

- [ ] **Step 2: Write the failing test**

`backend/src/services/auditLog.test.js`:

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import { AUDIT_ACTIONS, recordAudit } from './auditLog.js';

let errorSpy;
beforeEach(() => {
  query.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); });

const insertedRows = (call = 0) => JSON.parse(query.mock.calls[call][1][0]);

describe('recordAudit', () => {
  it('lists every action of the spec', () => {
    expect(AUDIT_ACTIONS).toEqual([
      'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
      'mailbox.enabled', 'mailbox.disabled', 'message.sent', 'message.deleted',
      'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
    ]);
  });

  it('writes a batch in one statement and lets the database resolve both emails', async () => {
    query.mockResolvedValue({ rowCount: 2 });
    await recordAudit([
      { actorUserId: 'u1', accountId: 'a1', action: 'message.deleted', details: { messageId: '<m1@example.com>', folder: 'INBOX', from: 'x@example.com', permanent: false } },
      { actorUserId: 'u1', accountEmail: 'gone@example.com', action: 'mailbox.deleted' },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO mailbox_audit_log \(actor_user_id, actor_email, account_id, account_email, action, details\)/);
    expect(sql).toMatch(/COALESCE\(NULLIF\(u\.email, ''\), u\.username\)/);
    expect(sql).toMatch(/COALESCE\(a\.email_address, e\.account_email\)/);
    expect(sql).toMatch(/LEFT JOIN users u ON u\.id = e\.actor_user_id/);
    expect(sql).toMatch(/LEFT JOIN email_accounts a ON a\.id = e\.account_id/);
    expect(insertedRows()).toEqual([
      { actor_user_id: 'u1', account_id: 'a1', account_email: null, action: 'message.deleted', details: { messageId: '<m1@example.com>', folder: 'INBOX', from: 'x@example.com', permanent: false } },
      { actor_user_id: 'u1', account_id: null, account_email: 'gone@example.com', action: 'mailbox.deleted', details: {} },
    ]);
  });

  it('accepts a single entry', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await recordAudit({ actorUserId: 'u1', accountId: 'a1', action: 'mailbox.disabled' });
    expect(insertedRows()).toEqual([
      { actor_user_id: 'u1', account_id: 'a1', account_email: null, action: 'mailbox.disabled', details: {} },
    ]);
  });

  it('writes nothing for an empty batch and drops unknown actions', async () => {
    await recordAudit([]);
    await recordAudit({ actorUserId: 'u1', action: 'message.read' });
    expect(query).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[audit] Unknown action:', 'message.read');
  });

  it('splits a large batch into statements of at most 1000 rows', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    const entries = Array.from({ length: 2500 }, (_, i) => ({ actorUserId: 'u1', accountId: 'a1', action: 'message.deleted', details: { messageId: `<${i}@example.com>` } }));
    await recordAudit(entries);
    expect(query.mock.calls.map((_, i) => insertedRows(i).length)).toEqual([1000, 1000, 500]);
  });

  it('never rejects and logs only the error code when the insert fails', async () => {
    query.mockRejectedValue(Object.assign(new Error('insert failed for secret@example.com'), { code: '23503' }));
    await expect(recordAudit({ actorUserId: 'u1', action: 'message.sent', details: { to: ['secret@example.com'] } }))
      .resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[audit] Failed to record entries:', '23503');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret@example.com');
  });

  it('survives a query that throws synchronously or resolves to nothing', async () => {
    query.mockImplementationOnce(() => { throw new TypeError('not a function'); });
    await expect(recordAudit({ action: 'mailbox.deleted' })).resolves.toBeUndefined();
    query.mockReturnValueOnce(undefined);
    await expect(recordAudit({ action: 'mailbox.deleted' })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[audit] Failed to record entries:', 'TypeError');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bt src/services/auditLog.test.js`
Expected: FAIL — `Failed to resolve import "./auditLog.js"`.

- [ ] **Step 4: Write the migration**

`backend/migrations/0057_mailbox_audit_log.sql`:

```sql
-- Journal of what users do with the shared mailboxes: who added, changed or removed a mailbox,
-- who sent or deleted a message, and what admins did to users. The actor and mailbox emails are
-- copied into the row so an entry stays readable after the user or mailbox is gone. Sync and
-- inbox rules never write here, and no subject, body, password or token is ever stored.
CREATE TABLE IF NOT EXISTS mailbox_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email   VARCHAR(255),
  account_id    UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
  account_email VARCHAR(255),
  action        VARCHAR(64) NOT NULL,
  details       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_mailbox_audit_occurred ON mailbox_audit_log (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_audit_account ON mailbox_audit_log (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_audit_actor ON mailbox_audit_log (actor_user_id, occurred_at DESC);
```

- [ ] **Step 5: Write the service**

`backend/src/services/auditLog.js`:

```js
import { query } from './db.js';

// Everything a user can do that the journal records. Sync and inbox rules never write here.
export const AUDIT_ACTIONS = Object.freeze([
  'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
  'mailbox.enabled', 'mailbox.disabled', 'message.sent', 'message.deleted',
  'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
]);
const KNOWN_ACTIONS = new Set(AUDIT_ACTIONS);

// Rows per INSERT, so emptying a large folder never builds one huge parameter.
const CHUNK_SIZE = 1000;

// The database fills in both emails: the actor's email (or username when it has none) and the
// mailbox address, falling back to the address the caller passed for a mailbox already deleted.
const INSERT_SQL = `
  INSERT INTO mailbox_audit_log (actor_user_id, actor_email, account_id, account_email, action, details)
  SELECT u.id, COALESCE(NULLIF(u.email, ''), u.username), a.id, COALESCE(a.email_address, e.account_email),
         e.action, COALESCE(e.details, '{}'::jsonb)
    FROM jsonb_to_recordset($1::jsonb)
         AS e(actor_user_id uuid, account_id uuid, account_email text, action text, details jsonb)
    LEFT JOIN users u ON u.id = e.actor_user_id
    LEFT JOIN email_accounts a ON a.id = e.account_id`;

function toRow(entry) {
  return {
    actor_user_id: entry.actorUserId ?? null,
    account_id: entry.accountId ?? null,
    account_email: entry.accountEmail ?? null,
    action: entry.action,
    details: entry.details ?? {},
  };
}

// Records journal entries. Callers do not await it: the promise never rejects, so a journal
// failure can never fail the action it describes. Errors are logged by code only, because a
// database message can quote the values being inserted.
export function recordAudit(entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter((entry) => {
    if (KNOWN_ACTIONS.has(entry?.action)) return true;
    console.error('[audit] Unknown action:', entry?.action);
    return false;
  });
  if (!list.length) return Promise.resolve();

  const rows = list.map(toRow);
  return (async () => {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      try {
        await query(INSERT_SQL, [JSON.stringify(rows.slice(i, i + CHUNK_SIZE))]);
      } catch (err) {
        console.error('[audit] Failed to record entries:', err?.code || err?.name || 'Error');
      }
    }
  })();
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bt src/services/auditLog.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 7: Check the SQL on Postgres 16**

Проверка на настоящей базе: миграции применяются, записи пачкой вставляются, email подставляются, удалённый ящик и неизвестный автор дают пустые ссылки, неверный UUID не роняет вызов.

`<scratchpad>/audit-db-check.mjs`:

```js
import assert from 'node:assert/strict';
import { pool, query } from './src/services/db.js';
import { runMigrations } from './src/services/migrations.js';
import { recordAudit } from './src/services/auditLog.js';

await runMigrations();
const { rows: [user] } = await query(
  "INSERT INTO users (username, email, password_hash) VALUES ('audit-check', 'Audit@Example.com', 'x') RETURNING id");
const { rows: [nameOnly] } = await query(
  "INSERT INTO users (username, password_hash) VALUES ('service-user', 'x') RETURNING id");
const { rows: [account] } = await query(
  "INSERT INTO email_accounts (added_by, name, email_address, protocol) VALUES ($1, 'Team', 'team@example.com', 'pop3') RETURNING id",
  [user.id]);

await recordAudit([
  { actorUserId: user.id, accountId: account.id, action: 'message.deleted', details: { messageId: '<m1@example.com>', permanent: false } },
  { actorUserId: nameOnly.id, accountEmail: 'gone@example.com', action: 'mailbox.deleted' },
  { actorUserId: '00000000-0000-4000-8000-000000000000', accountId: '00000000-0000-4000-8000-000000000001', action: 'mailbox.disabled' },
]);
await recordAudit({ actorUserId: 'not-a-uuid', action: 'mailbox.added' });

const { rows } = await query(
  'SELECT actor_user_id, actor_email, account_id, account_email, action, details FROM mailbox_audit_log ORDER BY id');
assert.equal(rows.length, 3);
assert.deepEqual(rows[0], {
  actor_user_id: user.id, actor_email: 'Audit@Example.com', account_id: account.id, account_email: 'team@example.com',
  action: 'message.deleted', details: { messageId: '<m1@example.com>', permanent: false },
});
assert.deepEqual(rows[1], {
  actor_user_id: nameOnly.id, actor_email: 'service-user', account_id: null, account_email: 'gone@example.com',
  action: 'mailbox.deleted', details: {},
});
assert.deepEqual(rows[2], {
  actor_user_id: null, actor_email: null, account_id: null, account_email: null, action: 'mailbox.disabled', details: {},
});

await query('DELETE FROM email_accounts WHERE id = $1', [account.id]);
await query('DELETE FROM users WHERE id = $1', [user.id]);
const { rows: [kept] } = await query('SELECT actor_user_id, actor_email, account_id, account_email FROM mailbox_audit_log ORDER BY id LIMIT 1');
assert.deepEqual(kept, { actor_user_id: null, actor_email: 'Audit@Example.com', account_id: null, account_email: 'team@example.com' });

await pool.end();
console.log('audit db check ok');
```

Run:

```bash
docker network create mailexpert-check
docker run -d --name mailexpert-check-db --network mailexpert-check -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=check -e POSTGRES_DB=mailexpert postgres:16-alpine
docker run -d --name mailexpert-check-redis --network mailexpert-check redis:7-alpine
docker exec mailexpert-check-db sh -c 'until pg_isready -U mailexpert >/dev/null; do sleep 1; done; sleep 2'
docker network connect mailexpert-check mailexpert-backend-test
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work'
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/audit-db-check.mjs" mailexpert-backend-test:/work/backend/audit-db-check.mjs
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-check-db -e DB_PASSWORD=check mailexpert-backend-test sh -c 'cd /work/backend && node audit-db-check.mjs 2>&1 | tail -5'
```

Expected: `Migrations: applying 0057_mailbox_audit_log` среди строк миграций, затем `[audit] Failed to record entries: 22P02` (неверный UUID) и `audit db check ok`.

Если в `users` или `email_accounts` есть другие обязательные колонки без значения по умолчанию, скрипт упадёт на `INSERT` с `null value in column`: добавить эту колонку в `INSERT` скрипта. Код сервиса не менять.

Базу и сеть не удалять: они нужны в Task 8. Файл проверки удалить:

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'rm -f /work/backend/audit-db-check.mjs'
```

- [ ] **Step 8: Commit**

```bash
git add backend/migrations/0057_mailbox_audit_log.sql backend/src/services/auditLog.js backend/src/services/auditLog.test.js
git commit -m "feat(audit): add the mailbox audit log table and writer"
```

---

### Task 2: `GET /api/admin/audit`

**Files:**
- Modify: `backend/src/routes/admin.js` (после `router.get('/auth-events', ...)`, строка ~264)
- Test: `backend/src/routes/admin.audit.test.js`

**Interfaces:**
- Consumes: `AUDIT_ACTIONS` из `services/auditLog.js`; `UUID_RE` из `utils/uuid.js`.
- Produces: `GET /api/admin/audit?account=&user=&action=&from=&to=&before=` → `200 { entries: AuditRow[], nextCursor: string|null }`, `400 { error, code: 'invalid_filter' }`.
  - `AuditRow = { id: string, occurredAt: string, actorUserId, actorEmail, accountId, accountEmail, action, details }`.

- [ ] **Step 1: Write the failing test**

`backend/src/routes/admin.audit.test.js`:

```js
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Same mock surface as admin.users.test.js so importing admin.js is side-effect free.
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAdmin: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({
  imapManager: { disconnectAccount: vi.fn(async () => {}), wss: { clients: new Set() } },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({})),
  invalidateConnectionPolicyCache: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));

import express from 'express';
import adminRoutes from './admin.js';
import { query } from '../services/db.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const row = (id, cursorAt) => ({
  id: String(id), occurred_at: new Date('2026-09-17T10:00:00.000Z'), cursor_at: cursorAt,
  actor_user_id: USER_ID, actor_email: 'user@example.com', account_id: ACCOUNT_ID, account_email: 'team@example.com',
  action: 'message.sent', details: { messageId: `<${id}@example.com>`, to: ['a@example.com'], cc: [], bcc: [] },
});

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: USER_ID }; next(); });
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { query.mockReset(); });

const get = async (qs = '') => {
  const res = await fetch(`${base}/api/admin/audit${qs}`);
  return { status: res.status, body: await res.json() };
};

describe('GET /api/admin/audit', () => {
  it('returns the newest 100 entries and a cursor when more remain', async () => {
    query.mockResolvedValue({ rows: Array.from({ length: 101 }, (_, i) => row(500 - i, `2026-09-17T10:00:00.${String(999999 - i).padStart(6, '0')}Z`)) });

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body.entries).toHaveLength(100);
    expect(body.entries[0]).toEqual({
      id: '500', occurredAt: '2026-09-17T10:00:00.000Z', actorUserId: USER_ID, actorEmail: 'user@example.com',
      accountId: ACCOUNT_ID, accountEmail: 'team@example.com', action: 'message.sent',
      details: { messageId: '<500@example.com>', to: ['a@example.com'], cc: [], bcc: [] },
    });
    expect(body.nextCursor).toBe('2026-09-17T10:00:00.999900Z_401');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM mailbox_audit_log\s+ORDER BY occurred_at DESC, id DESC\s+LIMIT \$1/);
    expect(sql).toMatch(/to_char\(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS cursor_at/);
    expect(params).toEqual([101]);
  });

  it('returns no cursor on the last page', async () => {
    query.mockResolvedValue({ rows: [row(1, '2026-09-17T10:00:00.000001Z')] });
    expect((await get()).body.nextCursor).toBeNull();
  });

  it('applies every filter and the cursor', async () => {
    query.mockResolvedValue({ rows: [] });
    const qs = new URLSearchParams({
      account: ACCOUNT_ID, user: USER_ID, action: 'message.deleted',
      from: '2026-09-01T00:00:00Z', to: '2026-09-18T00:00:00Z', before: '2026-09-17T10:00:00.123456Z_42',
    });

    expect((await get(`?${qs}`)).status).toBe(200);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE account_id = \$1 AND actor_user_id = \$2 AND action = \$3 AND occurred_at >= \$4 AND occurred_at < \$5 AND \(occurred_at, id\) < \(\$6::timestamptz, \$7::bigint\)/);
    expect(params).toEqual([
      ACCOUNT_ID, USER_ID, 'message.deleted', '2026-09-01T00:00:00.000Z', '2026-09-18T00:00:00.000Z',
      '2026-09-17T10:00:00.123456Z', '42', 101,
    ]);
  });

  it.each([
    ['account', 'not-a-uuid'],
    ['user', 'nope'],
    ['action', 'message.read'],
    ['from', 'yesterday'],
    ['to', '2026-13-45'],
    ['before', '42'],
  ])('rejects an invalid %s filter', async (name, value) => {
    const { status, body } = await get(`?${new URLSearchParams({ [name]: value })}`);
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_filter');
    expect(query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/routes/admin.audit.test.js`
Expected: FAIL — `GET /api/admin/audit` отвечает 404, `res.json()` у страницы Express падает или `status` равен 404.

- [ ] **Step 3: Implement the route**

В `backend/src/routes/admin.js` добавить импорты:

```js
import { AUDIT_ACTIONS } from '../services/auditLog.js';
import { UUID_RE, uuidParam } from '../utils/uuid.js';
```

(заменить существующую строку `import { uuidParam } from '../utils/uuid.js';`).

После обработчика `router.get('/auth-events', ...)` добавить:

```js
// ── Audit log ─────────────────────────────────────────────────────────────────

const AUDIT_PAGE_SIZE = 100;
const AUDIT_ACTION_SET = new Set(AUDIT_ACTIONS);
// The cursor is produced by the database with microsecond precision, which a JS Date would lose.
const AUDIT_CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_(\d{1,19})$/;

class AuditFilterError extends Error {}

function parseAuditTime(value) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.getTime())) throw new AuditFilterError();
  return date.toISOString();
}

// Newest first, 100 per page. `from` is inclusive, `to` exclusive; `before` is the nextCursor
// of the previous page.
router.get('/audit', async (req, res) => {
  const { account, user, action, from, to, before } = req.query;
  const where = [];
  const params = [];
  const add = (clause, ...values) => {
    const placeholders = values.map((value) => { params.push(value); return `$${params.length}`; });
    where.push(clause(...placeholders));
  };

  try {
    if (account !== undefined) {
      if (typeof account !== 'string' || !UUID_RE.test(account)) throw new AuditFilterError();
      add((p) => `account_id = ${p}`, account);
    }
    if (user !== undefined) {
      if (typeof user !== 'string' || !UUID_RE.test(user)) throw new AuditFilterError();
      add((p) => `actor_user_id = ${p}`, user);
    }
    if (action !== undefined) {
      if (!AUDIT_ACTION_SET.has(action)) throw new AuditFilterError();
      add((p) => `action = ${p}`, action);
    }
    if (from !== undefined) add((p) => `occurred_at >= ${p}`, parseAuditTime(from));
    if (to !== undefined) add((p) => `occurred_at < ${p}`, parseAuditTime(to));
    if (before !== undefined) {
      const match = typeof before === 'string' ? AUDIT_CURSOR_RE.exec(before) : null;
      if (!match) throw new AuditFilterError();
      add((at, id) => `(occurred_at, id) < (${at}::timestamptz, ${id}::bigint)`, match[1], match[2]);
    }
  } catch (err) {
    if (!(err instanceof AuditFilterError)) throw err;
    return res.status(400).json({ error: 'Invalid audit filter', code: 'invalid_filter' });
  }

  params.push(AUDIT_PAGE_SIZE + 1);
  const { rows } = await query(
    `SELECT id::text AS id, occurred_at,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
            actor_user_id, actor_email, account_id, account_email, action, details
       FROM mailbox_audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = page[page.length - 1];
  res.json({
    entries: page.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actorUserId: r.actor_user_id,
      actorEmail: r.actor_email,
      accountId: r.account_id,
      accountEmail: r.account_email,
      action: r.action,
      details: r.details,
    })),
    nextCursor: rows.length > AUDIT_PAGE_SIZE ? `${last.cursor_at}_${last.id}` : null,
  });
});
```

Без фильтров SQL не содержит `WHERE`: между `FROM mailbox_audit_log` и `ORDER BY` остаётся пустая строка, регулярное выражение первого теста это допускает (`\s+`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bt src/routes/admin.audit.test.js src/routes/admin.users.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/admin.js backend/src/routes/admin.audit.test.js
git commit -m "feat(audit): let admins read the audit log page by page"
```

---

### Task 3: Журнал действий с ящиками

**Files:**
- Modify: `backend/src/routes/accounts.js:115-340`
- Test: `backend/src/routes/accounts.audit.test.js`
- Modify tests: `accounts.aliases.test.js`, `accounts.health.test.js`, `accounts.oauthFields.test.js`, `accounts.reconnectCooldown.test.js`, `accounts.shared.test.js`, `accounts.unifiedInbox.test.js`

**Interfaces:**
- Consumes: `recordAudit` из Task 1.
- Produces: записи `mailbox.added`, `mailbox.connection_changed`, `mailbox.enabled`, `mailbox.disabled`, `mailbox.deleted`.

- [ ] **Step 1: Write the failing test**

`backend/src/routes/accounts.audit.test.js`:

```js
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-2' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    clearConnectCooldown: vi.fn(),
    isConnecting: vi.fn(() => false),
    connectAccount: vi.fn(() => Promise.resolve(true)),
    disconnectAccount: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: vi.fn((v) => (v ? `enc:${v}` : v)), decrypt: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: true }),
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn(async () => []) } }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { recordAudit } from '../services/auditLog.js';

const ID = '66666666-6666-4666-8666-666666666666';
const STORED = {
  id: ID, protocol: 'pop3', enabled: true, email_address: 'team@example.com', oauth_provider: null,
  imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, imap_skip_tls_verify: false,
  smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
  auth_user: 'team@example.com', auth_pass: 'enc:old', smtp_auth_user: null, smtp_auth_pass: null,
};

let stored;
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  stored = { ...STORED };
  query.mockReset().mockImplementation(async (sql) => {
    if (/^\s*INSERT INTO email_accounts/.test(sql)) return { rows: [{ ...STORED }] };
    if (/^\s*UPDATE email_accounts/.test(sql)) return { rows: [stored] };
    if (sql === 'SELECT id, email_address FROM email_accounts WHERE id = $1') return { rows: stored ? [{ id: ID, email_address: stored.email_address }] : [] };
    if (sql === 'SELECT * FROM email_accounts WHERE id = $1') return { rows: stored ? [stored] : [] };
    return { rows: [] };
  });
});

const send = (method, path, body) => fetch(`${base}/api/accounts${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

describe('mailbox actions are journaled', () => {
  it('records a new mailbox', async () => {
    const res = await send('POST', '', { name: 'Team', email_address: 'team@example.com', protocol: 'pop3' });
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-2', accountId: ID, action: 'mailbox.added', details: { protocol: 'pop3', oauthProvider: null },
    });
  });

  it('records nothing when the settings form saves unchanged server fields', async () => {
    const res = await send('PUT', `/${ID}`, {
      name: 'Renamed', color: '#000000', signature: null, imap_host: 'imap.example.com', imap_port: '993',
      imap_skip_tls_verify: false, smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
    });
    expect(res.status).toBe(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('records the names of changed connection fields without their values', async () => {
    const res = await send('PUT', `/${ID}`, { imap_host: 'mail.example.net', imap_port: 143, auth_pass: 'new-secret', smtp_auth_pass: '' });
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: 'user-2', accountId: ID, action: 'mailbox.connection_changed', details: { fields: ['imap_host', 'imap_port', 'imap_tls', 'auth_pass'] } },
    ]);
    expect(JSON.stringify(recordAudit.mock.calls)).not.toMatch(/new-secret|mail\.example\.net|143/);
  });

  it('records a cleared stored password as a change', async () => {
    stored = { ...STORED, smtp_auth_pass: 'enc:smtp' };
    await send('PUT', `/${ID}`, { smtp_auth_pass: '' });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: 'user-2', accountId: ID, action: 'mailbox.connection_changed', details: { fields: ['smtp_auth_pass'] } },
    ]);
  });

  it('records disabling and enabling only when the state changes', async () => {
    await send('PUT', `/${ID}`, { enabled: true });
    expect(recordAudit).not.toHaveBeenCalled();

    await send('PUT', `/${ID}`, { enabled: false, auth_user: 'other@example.com' });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: 'user-2', accountId: ID, action: 'mailbox.connection_changed', details: { fields: ['auth_user'] } },
      { actorUserId: 'user-2', accountId: ID, action: 'mailbox.disabled', details: {} },
    ]);

    recordAudit.mockClear();
    stored = { ...STORED, enabled: false };
    await send('PUT', `/${ID}`, { enabled: true });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: 'user-2', accountId: ID, action: 'mailbox.enabled', details: {} },
    ]);
  });

  it('records a deleted mailbox by address after the row is gone', async () => {
    const res = await send('DELETE', `/${ID}`);
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-2', accountEmail: 'team@example.com', action: 'mailbox.deleted', details: {},
    });
    const deleteOrder = query.mock.invocationCallOrder[query.mock.calls.findIndex(([sql]) => sql === 'DELETE FROM email_accounts WHERE id = $1')];
    expect(recordAudit.mock.invocationCallOrder[0]).toBeGreaterThan(deleteOrder);
  });

  it('records nothing for a mailbox that does not exist', async () => {
    stored = null;
    expect((await send('DELETE', `/${ID}`)).status).toBe(404);
    expect((await send('PUT', `/${ID}`, { enabled: false })).status).toBe(404);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/routes/accounts.audit.test.js`
Expected: FAIL — `recordAudit` не вызывался (6 из 7 тестов), тест «does not exist» может пройти.

- [ ] **Step 3: Implement**

В `backend/src/routes/accounts.js`:

1. Импорт рядом с другими сервисами:

```js
import { recordAudit } from '../services/auditLog.js';
```

2. Над `router.post('/', ...)`:

```js
// Server and credential settings whose change the audit log records, by name only. The settings
// form sends every server field on each save, so a field counts only when its value differs.
const CONNECTION_FIELDS = [
  'imap_host', 'imap_port', 'imap_tls', 'imap_skip_tls_verify', 'smtp_host', 'smtp_port', 'smtp_tls',
  'auth_user', 'auth_pass', 'smtp_auth_user', 'smtp_auth_pass',
];
const PASSWORD_FIELDS = new Set(['auth_pass', 'smtp_auth_pass']);

function changedConnectionFields(stored, updates) {
  return CONNECTION_FIELDS.filter((key) => {
    if (!(key in updates)) return false;
    // Passwords are stored encrypted and never compared: a new one or a cleared one is a change.
    if (PASSWORD_FIELDS.has(key)) return !!updates[key] || !!stored[key];
    return String(stored[key] ?? '') !== String(updates[key] ?? '');
  });
}
```

3. В `router.post('/', ...)` после `const account = result.rows[0];`:

```js
    recordAudit({
      actorUserId: req.session.userId,
      accountId: account.id,
      action: 'mailbox.added',
      details: { protocol: account.protocol, oauthProvider: account.oauth_provider ?? null },
    });
```

4. В `router.put('/:id', ...)` заменить проверку существования:

```js
  // The mailbox must exist. The stored row tells the audit log what actually changed.
  const storedResult = await query('SELECT * FROM email_accounts WHERE id = $1', [id]);
  if (!storedResult.rows.length) return res.status(404).json({ error: 'Account not found' });
  const stored = storedResult.rows[0];
```

и перед `const payload = { ...safeAccount(updated), ...pluginPatch };`:

```js
  if (sets.length) {
    const auditEntries = [];
    const fields = changedConnectionFields(stored, updates);
    if (fields.length) {
      auditEntries.push({ actorUserId: req.session.userId, accountId: id, action: 'mailbox.connection_changed', details: { fields } });
    }
    if ('enabled' in updates && !!updates.enabled !== !!stored.enabled) {
      auditEntries.push({ actorUserId: req.session.userId, accountId: id, action: updates.enabled ? 'mailbox.enabled' : 'mailbox.disabled', details: {} });
    }
    if (auditEntries.length) recordAudit(auditEntries);
  }
```

`updates.imap_tls` к этому месту уже вычислен из порта (строка `if ('imap_port' in updates) updates.imap_tls = ...`), поэтому сравнение `imap_tls` работает без особого случая.

5. В `router.delete('/:id', ...)`:

```js
    const check = await query('SELECT id, email_address FROM email_accounts WHERE id = $1', [id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

    // Delete from DB first (cascades to messages and folders immediately).
    // Disconnect IMAP afterward — fire-and-forget so a slow server logout
    // doesn't block the response.
    await query('DELETE FROM email_accounts WHERE id = $1', [id]);
    // The row is gone, so the entry names the mailbox by the address read above.
    recordAudit({
      actorUserId: req.session.userId,
      accountEmail: check.rows[0].email_address,
      action: 'mailbox.deleted',
      details: {},
    });
```

- [ ] **Step 4: Add the journal mock to existing account tests**

В каждый из файлов `backend/src/routes/accounts.aliases.test.js`, `accounts.health.test.js`, `accounts.oauthFields.test.js`, `accounts.reconnectCooldown.test.js`, `accounts.shared.test.js`, `accounts.unifiedInbox.test.js` рядом с другими `vi.mock` добавить:

```js
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
```

В `accounts.shared.test.js` в тесте `deletes a mailbox someone else added` заменить:

```js
    expect(query).toHaveBeenCalledWith('SELECT id FROM email_accounts WHERE id = $1', [ID]);
```

на:

```js
    expect(query).toHaveBeenCalledWith('SELECT id, email_address FROM email_accounts WHERE id = $1', [ID]);
```

- [ ] **Step 5: Run the account tests**

Run: `bt src/routes/accounts.audit.test.js src/routes/accounts.aliases.test.js src/routes/accounts.health.test.js src/routes/accounts.oauthFields.test.js src/routes/accounts.reconnectCooldown.test.js src/routes/accounts.shared.test.js src/routes/accounts.unifiedInbox.test.js`
Expected: PASS.

Если тест `PUT` в `accounts.reconnectCooldown.test.js` или `accounts.unifiedInbox.test.js` отдаёт строки по порядку вызовов (`mockResolvedValueOnce`) и первым ответом возвращает `{ rows: [{ id }] }`, он продолжает работать: `SELECT *` получает ту же строку, а поля, которых в ней нет, сравниваются как пустые. Если тест проверяет точный SQL `SELECT id FROM email_accounts WHERE id = $1` для `PUT`, заменить ожидание на `SELECT * FROM email_accounts WHERE id = $1` — это прямое следствие шага 3.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/accounts.js backend/src/routes/accounts.audit.test.js backend/src/routes/accounts.*.test.js
git commit -m "feat(audit): journal mailbox additions, connection changes and deletions"
```

---

### Task 4: Журнал OAuth-подключений

**Files:**
- Modify: `backend/src/routes/oauthGoogle.js:100-183`
- Modify: `backend/src/routes/oauth.js:114-212`
- Test: `backend/src/routes/oauth.google.test.js`, `backend/src/routes/oauth.microsoft.test.js`

**Interfaces:**
- Consumes: `recordAudit` из Task 1.
- Produces:
  - `upsertGoogleAccount(...)` возвращает `{ account, result, previousAppId }`; `previousAppId` — `oauth_app_id` ящика до обновления, `null` для нового ящика;
  - записи `mailbox.added`, `mailbox.reconnected`, `mailbox.connection_changed` (`fields: ['oauth_app_id']`).

- [ ] **Step 1: Write the failing Google tests**

В `backend/src/routes/oauth.google.test.js`:

1. Рядом с другими `vi.mock`:

```js
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
```

2. Импорт после остальных:

```js
import { recordAudit } from '../services/auditLog.js';
```

3. В конец файла:

```js
describe('Google consent is journaled', () => {
  const OLD_APP_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const callback = (params) => get(`/oauth/google/callback?${new URLSearchParams(params)}`);
  beforeEach(() => { recordAudit.mockClear(); });

  it('records a new mailbox as added by the user who started the flow', async () => {
    mockSuccessfulGoogle();
    const { state } = await startFlow();
    await callback({ code: 'c', state });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: USER_ID, accountId: 'new-acc', action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: 'google' } },
    ]);
  });

  it('records a reconsent through the same app as a reconnect only', async () => {
    installDb({ existing: { id: 'acc-1', oauth_refresh_token: 'enc(old-refresh)', oauth_app_id: APP_ID } });
    mockSuccessfulGoogle({ refreshToken: null });
    const { state } = await startFlow();
    await callback({ code: 'c', state });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: USER_ID, accountId: 'acc-1', action: 'mailbox.reconnected', details: { oauthProvider: 'google' } },
    ]);
  });

  it('records a move to another app as a connection change', async () => {
    installDb({ existing: { id: 'acc-1', oauth_refresh_token: 'enc(old-refresh)', oauth_app_id: OLD_APP_ID } });
    mockSuccessfulGoogle();
    const { state } = await startFlow();
    await callback({ code: 'c', state });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: USER_ID, accountId: 'acc-1', action: 'mailbox.reconnected', details: { oauthProvider: 'google' } },
      { actorUserId: USER_ID, accountId: 'acc-1', action: 'mailbox.connection_changed', details: { fields: ['oauth_app_id'] } },
    ]);
  });

  it('records nothing when the consent is refused', async () => {
    mockSuccessfulGoogle({ scope: 'openid email' });
    const { state } = await startFlow();
    await callback({ code: 'c', state });
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing Microsoft tests**

В `backend/src/routes/oauth.microsoft.test.js`:

1. Рядом с другими `vi.mock`:

```js
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
```

2. Импорт после остальных:

```js
import { recordAudit } from '../services/auditLog.js';
```

3. `installDb` принимает признак существующего ящика и умеет вставку:

```js
// Transaction client for the mailbox the consent names; it already exists unless told otherwise.
let dbCalls;
function installDb({ existing = true } = {}) {
  dbCalls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      dbCalls.push([sql, params]);
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/^\s*SELECT id FROM email_accounts/.test(sql)) return { rows: existing ? [{ id: 'ms-acc' }] : [] };
      if (/^\s*UPDATE email_accounts/.test(sql)) return { rows: [], rowCount: 1 };
      if (/^\s*INSERT INTO email_accounts/.test(sql)) return { rows: [{ id: 'ms-new' }] };
      if (/^\s*SELECT \* FROM email_accounts WHERE id = \$1/.test(sql)) {
        return { rows: [{ id: params[0], email_address: 'user@contoso.com', oauth_provider: 'microsoft' }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  withTransaction.mockImplementation(async (fn) => fn(client));
}
```

4. В `beforeEach` после `imapManager.clearConnectCooldown.mockClear();` добавить `recordAudit.mockClear();`.

5. Новый блок после `describe('Microsoft reconsent clears ...')`:

```js
describe('Microsoft consent is journaled', () => {
  const callback = () => fetch(`${base}/oauth/microsoft/callback?code=auth-code&state=${NONCE}`, {
    redirect: 'manual', headers: { 'x-test-user': USER_ID },
  });

  it('records a reconsent of an existing mailbox as a reconnect', async () => {
    stubMicrosoft(() => json(true, TOKENS));
    await callback();
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: USER_ID, accountId: 'ms-acc', action: 'mailbox.reconnected', details: { oauthProvider: 'microsoft' },
    });
  });

  it('records a new mailbox as added', async () => {
    installDb({ existing: false });
    stubMicrosoft(() => json(true, TOKENS));
    await callback();
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: USER_ID, accountId: 'ms-new', action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: 'microsoft' },
    });
  });

  it('records nothing when the token exchange fails', async () => {
    stubMicrosoft(() => json(false, { error: 'invalid_grant' }));
    await callback();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bt src/routes/oauth.google.test.js src/routes/oauth.microsoft.test.js`
Expected: FAIL — новые тесты, кроме «records nothing ...», падают: `recordAudit` не вызывался.

- [ ] **Step 4: Implement Google**

В `backend/src/routes/oauthGoogle.js`:

1. Импорт:

```js
import { recordAudit } from '../services/auditLog.js';
```

2. В коллбэке заменить:

```js
    const { account, result } = await upsertGoogleAccount(pending.userId, identity, tokens, config.appId);

    reconnectAccount(account, result);
```

на:

```js
    const { account, result, previousAppId } = await upsertGoogleAccount(pending.userId, identity, tokens, config.appId);
    recordGoogleConsent({ userId: pending.userId, account, result, previousAppId, appId: config.appId });

    reconnectAccount(account, result);
```

3. В `upsertGoogleAccount`: объявить `let previousAppId = null;` рядом с `let result;`, в ветке существующего ящика после `accountId = row.id;` присвоить `previousAppId = row.oauth_app_id;`, последнюю строку транзакции заменить на `return { account: accountResult.rows[0], result, previousAppId };`.

4. После `upsertGoogleAccount`:

```js
// Journal the consent: a new mailbox is an addition, an existing one a reconnect, and moving the
// mailbox to another Google app also changes its connection.
function recordGoogleConsent({ userId, account, result, previousAppId, appId }) {
  const entry = { actorUserId: userId, accountId: account.id };
  if (result === 'created') {
    recordAudit([{ ...entry, action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: PROVIDER } }]);
    return;
  }
  const entries = [{ ...entry, action: 'mailbox.reconnected', details: { oauthProvider: PROVIDER } }];
  if (previousAppId !== appId) {
    entries.push({ ...entry, action: 'mailbox.connection_changed', details: { fields: ['oauth_app_id'] } });
  }
  recordAudit(entries);
}
```

`PROVIDER` в этом файле равен `'google'`: его уже использует редирект `oauth_success=${PROVIDER}`.

- [ ] **Step 5: Implement Microsoft**

В `backend/src/routes/oauth.js`:

1. Импорт:

```js
import { recordAudit } from '../services/auditLog.js';
```

2. В `processMicrosoftTokens` заменить `const account = await withTransaction(async (client) => {` на `const { account, created } = await withTransaction(async (client) => {`; внутри объявить `let created = false;` рядом с `let accountId;`, в ветке вставки после `accountId = result.rows[0].id;` присвоить `created = true;`, последнюю строку транзакции заменить на `return { account: accountResult.rows[0], created };`.

3. Сразу после транзакции, перед `imapManager.clearConnectCooldown(account.id);`:

```js
  recordAudit({
    actorUserId: userId,
    accountId: account.id,
    action: created ? 'mailbox.added' : 'mailbox.reconnected',
    details: created ? { protocol: 'imap', oauthProvider: 'microsoft' } : { oauthProvider: 'microsoft' },
  });
```

Функция по-прежнему возвращает `email`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bt src/routes/oauth.google.test.js src/routes/oauth.microsoft.test.js src/routes/oauth.refresh.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/oauthGoogle.js backend/src/routes/oauth.js backend/src/routes/oauth.google.test.js backend/src/routes/oauth.microsoft.test.js
git commit -m "feat(audit): journal OAuth mailbox connections and reconnects"
```

---

### Task 5: Журнал отправки

**Files:**
- Modify: `backend/src/routes/send.js:383-385`
- Test: `backend/src/routes/send.audit.test.js`
- Modify tests: `send.forwarded.test.js`, `send.reliability.test.js`, `send.signature.test.js`

**Interfaces:**
- Consumes: `recordAudit` из Task 1.
- Produces: запись `message.sent` с `details: { messageId, to, cc, bcc }`.

- [ ] **Step 1: Write the failing test**

`backend/src/routes/send.audit.test.js` (журнал не мокается: проверяется настоящая вставка):

```js
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));

import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';

const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'google' };
const sendMail = vi.fn();
let server;
let base;
let errorSpy;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  query.mockImplementation(async (sql) => {
    if (sql.includes('INSERT INTO mailbox_audit_log')) throw Object.assign(new Error('journal down'), { code: '57P01' });
    return { rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] };
  });
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue('OK');
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});
afterEach(() => { errorSpy.mockRestore(); });

const auditInsert = () => query.mock.calls.find(([sql]) => sql.includes('INSERT INTO mailbox_audit_log'));
const post = (body) => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ accountId: 'a1', subject: 'Quarterly numbers', body: 'Confidential body text', ...body }),
});

describe('sending is journaled', () => {
  it('records the accepted message without subject or body, and a journal failure keeps the send successful', async () => {
    const res = await post({ to: ['you@example.com'], cc: ['cc@example.com'], bcc: ['hidden@example.com'] });

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    await vi.waitFor(() => expect(auditInsert()).toBeTruthy());
    const [, [payload]] = auditInsert();
    expect(JSON.parse(payload)).toEqual([{
      actor_user_id: 'u1', account_id: 'a1', account_email: null, action: 'message.sent',
      details: {
        messageId: sendMail.mock.calls[0][0].messageId,
        to: ['you@example.com'], cc: ['cc@example.com'], bcc: ['hidden@example.com'],
      },
    }]);
    expect(payload).not.toMatch(/Quarterly numbers|Confidential body text/);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith('[audit] Failed to record entries:', '57P01'));
  });

  it('records nothing when the SMTP server rejects the message', async () => {
    sendMail.mockRejectedValueOnce(new Error('550 rejected'));
    expect((await post({ to: ['you@example.com'] })).status).toBe(500);
    expect(auditInsert()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/routes/send.audit.test.js`
Expected: FAIL — первый тест: `vi.waitFor` истекает, вставки в журнал нет.

- [ ] **Step 3: Implement**

В `backend/src/routes/send.js`:

1. Импорт:

```js
import { recordAudit } from '../services/auditLog.js';
```

2. После `delivered = true;`:

```js
    // Journal the accepted message by its Message-ID and recipients; never its subject or body.
    recordAudit({
      actorUserId: req.session.userId,
      accountId: account.id,
      action: 'message.sent',
      details: { messageId: mailOptions.messageId, to: normalizedTo, cc: normalizedCc, bcc: normalizedBcc },
    });
```

- [ ] **Step 4: Add the journal mock to existing send tests**

В `backend/src/routes/send.forwarded.test.js`, `send.reliability.test.js`, `send.signature.test.js` рядом с другими `vi.mock`:

```js
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bt src/routes/send.audit.test.js src/routes/send.forwarded.test.js src/routes/send.reliability.test.js src/routes/send.signature.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/send.js backend/src/routes/send.audit.test.js backend/src/routes/send.*.test.js
git commit -m "feat(audit): journal sent messages without their content"
```

---

### Task 6: Журнал удаления писем

**Files:**
- Modify: `backend/src/routes/mail.js` — `router.post('/folders/empty', ...)` (~1020), `router.post('/messages/bulk-delete', ...)` (~1155), `router.delete('/messages/:id', ...)` (~1909)
- Test: `backend/src/routes/mail.deleteAudit.test.js`
- Modify tests: `backend/src/routes/mail.emptyFolder.test.js`

**Interfaces:**
- Consumes: `recordAudit` из Task 1.
- Produces: записи `message.deleted` с `details: { messageId, folder, from, permanent }`.

- [ ] **Step 1: Write the failing test for single and bulk delete**

`backend/src/routes/mail.deleteAudit.test.js` (журнал не мокается):

```js
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
    moveMessage: vi.fn(async () => 900),
    permanentDeleteMessage: vi.fn(async () => {}),
    bulkMoveMessages: vi.fn(),
    bulkPermanentDelete: vi.fn(),
    syncFolderOnDemand: vi.fn(async () => {}),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    scheduleCountRefresh: vi.fn(),
  },
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}), collectHook: vi.fn(async () => []) } }));
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveTrashFolder: vi.fn(async () => 'Trash'),
  resolveAllTrashPaths: vi.fn(async () => new Set(['Trash'])),
  resolveAllDraftsPaths: vi.fn(async () => new Set(['Drafts'])),
  adjustFolderCounts: vi.fn(),
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const MSG = (id, folder, uid) => ({
  id, account_id: ACCOUNT_ID, uid, folder, is_read: true, message_id: `<${uid}@example.com>`,
  subject: 'Board minutes', from_name: 'Sender', from_email: 'sender@example.com', folder_mappings: null,
});
const INBOX_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const TRASH_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const DRAFT_ID = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
const rows = { [INBOX_ID]: MSG(INBOX_ID, 'INBOX', 11), [TRASH_ID]: MSG(TRASH_ID, 'Trash', 22), [DRAFT_ID]: MSG(DRAFT_ID, 'Drafts', 33) };

let server;
let base;
let errorSpy;
let failJournal;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  failJournal = false;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  query.mockReset().mockImplementation(async (sql, params) => {
    if (sql.includes('INSERT INTO mailbox_audit_log')) {
      if (failJournal) throw Object.assign(new Error('journal down'), { code: '57P01' });
      return { rowCount: 1 };
    }
    if (/FROM messages m\s+WHERE m\.id = \$1/.test(sql)) return { rows: rows[params[0]] ? [rows[params[0]]] : [] };
    if (/FROM messages m\s+JOIN email_accounts a/.test(sql)) return { rows: params[0].map((id) => rows[id]) };
    if (sql.includes('FROM email_accounts WHERE id = $1')) return { rows: [{ id: ACCOUNT_ID, folder_mappings: null }] };
    return { rows: [] };
  });
});
afterEach(() => { errorSpy.mockRestore(); });

const journaled = () => query.mock.calls
  .filter(([sql]) => sql.includes('INSERT INTO mailbox_audit_log'))
  .flatMap(([, [payload]]) => JSON.parse(payload));
const deleted = (messageId, folder, permanent) => ({
  actor_user_id: 'u1', account_id: ACCOUNT_ID, account_email: null, action: 'message.deleted',
  details: { messageId, folder, from: 'sender@example.com', permanent },
});

describe('deleting messages is journaled', () => {
  it('records a move to Trash, a delete from Trash and a draft delete without the subject', async () => {
    for (const id of [INBOX_ID, TRASH_ID, DRAFT_ID]) {
      expect((await fetch(`${base}/api/mail/messages/${id}`, { method: 'DELETE' })).status).toBe(200);
    }
    await vi.waitFor(() => expect(journaled()).toHaveLength(3));
    expect(journaled()).toEqual([
      deleted('<11@example.com>', 'INBOX', false),
      deleted('<22@example.com>', 'Trash', true),
      deleted('<33@example.com>', 'Drafts', true),
    ]);
    expect(JSON.stringify(journaled())).not.toContain('Board minutes');
  });

  it('records nothing when the server refuses the delete', async () => {
    imapManager.moveMessage.mockRejectedValueOnce(new Error('NO'));
    expect((await fetch(`${base}/api/mail/messages/${INBOX_ID}`, { method: 'DELETE' })).status).toBe(500);
    expect(journaled()).toEqual([]);
  });

  it('records one entry per message that bulk delete removed', async () => {
    imapManager.bulkPermanentDelete.mockResolvedValue({ succeeded: [22], failed: [] });
    imapManager.bulkMoveMessages.mockResolvedValue({ uidMap: new Map([[11, 901]]), succeeded: [11], failed: [] });
    const res = await fetch(`${base}/api/mail/messages/bulk-delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [INBOX_ID, TRASH_ID] }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(journaled()).toHaveLength(2));
    expect(journaled()).toEqual([
      deleted('<22@example.com>', 'Trash', true),
      deleted('<11@example.com>', 'INBOX', false),
    ]);
  });

  it('skips messages the server failed to delete and keeps the delete successful when the journal fails', async () => {
    failJournal = true;
    imapManager.bulkPermanentDelete.mockResolvedValue({ succeeded: [], failed: [22] });
    imapManager.bulkMoveMessages.mockResolvedValue({ uidMap: new Map([[11, 901]]), succeeded: [11], failed: [] });
    const res = await fetch(`${base}/api/mail/messages/bulk-delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [INBOX_ID, TRASH_ID] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toEqual([INBOX_ID]);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith('[audit] Failed to record entries:', '57P01'));
    expect(JSON.parse(query.mock.calls.find(([sql]) => sql.includes('INSERT INTO mailbox_audit_log'))[1][0]))
      .toEqual([deleted('<11@example.com>', 'INBOX', false)]);
  });
});
```

- [ ] **Step 2: Extend the empty-folder test**

В `backend/src/routes/mail.emptyFolder.test.js`:

1. Рядом с другими `vi.mock`:

```js
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
```

2. Импорт после остальных:

```js
import { recordAudit } from '../services/auditLog.js';
```

3. В `beforeEach` добавить `recordAudit.mockClear();` и в `query.mockImplementation` перед последним `return` добавить ветку:

```js
      if (sql.startsWith('DELETE FROM messages WHERE account_id = $1 AND folder = $2')) {
        return Promise.resolve({ rows: [
          { message_id: '<1@example.com>', from_email: 'a@example.com' },
          { message_id: '<2@example.com>', from_email: 'b@example.com' },
        ] });
      }
```

4. Новый тест в блоке `describe`:

```js
  it('journals every message removed from the emptied folder', async () => {
    imapManager.emptyFolder.mockResolvedValue(undefined);
    await empty('Trash');
    await tick();
    const entry = (messageId, from) => ({
      actorUserId: 'user-1', accountId: ACCOUNT_ID, action: 'message.deleted',
      details: { messageId, folder: 'Trash', from, permanent: true },
    });
    expect(recordAudit).toHaveBeenCalledWith([entry('<1@example.com>', 'a@example.com'), entry('<2@example.com>', 'b@example.com')]);
  });

  it('journals nothing when the server empty fails', async () => {
    imapManager.emptyFolder.mockRejectedValue(new Error('throttled'));
    await empty('Trash');
    await tick();
    expect(recordAudit).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bt src/routes/mail.deleteAudit.test.js src/routes/mail.emptyFolder.test.js`
Expected: FAIL — записей журнала нет (`vi.waitFor` истекает, `recordAudit` не вызывался). Тесты «records nothing» и «journals nothing» проходят.

Если `mail.deleteAudit.test.js` падает раньше, на 500 из-за недостающего метода мока `imapManager` или SQL, который мок не знает, — дополнить мок в тесте (добавить метод `vi.fn()` или ветку `query`), не меняя маршрут, и запустить снова до ожидаемого падения на журнале.

- [ ] **Step 4: Implement**

В `backend/src/routes/mail.js`:

1. Импорт:

```js
import { recordAudit } from '../services/auditLog.js';
```

2. Рядом с `notifyMailMutation`:

```js
// Journal entries for messages a user deleted. Rows are the pre-delete message rows; only the
// Message-ID, folder and sender are recorded, never the subject or body.
function deletedMessageEntries(userId, rows, permanent) {
  return rows.map((m) => ({
    actorUserId: userId,
    accountId: m.account_id,
    action: 'message.deleted',
    details: { messageId: m.message_id ?? null, folder: m.folder, from: m.from_email ?? null, permanent },
  }));
}
```

3. `POST /folders/empty`, в фоновой задаче заменить:

```js
      await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [accountId, path]);
```

на:

```js
      // Every row removed here is a message the user deleted for good; journal each one.
      const removed = await query(
        'DELETE FROM messages WHERE account_id = $1 AND folder = $2 RETURNING message_id, from_email',
        [accountId, path],
      );
      recordAudit(deletedMessageEntries(
        req.session.userId,
        (removed.rows ?? []).map((m) => ({ ...m, account_id: accountId, folder: path })),
        true,
      ));
```

Ветка мока `sql.startsWith('DELETE FROM messages WHERE account_id = $1 AND folder = $2')` из Step 2 совпадает с новым SQL, а `clearedDb()` в этом файле сравнивает через `includes` и остаётся верным.

4. `POST /messages/bulk-delete`, перед `// Refresh GTD section data for any deleted thread ...`:

```js
    recordAudit([
      ...deletedMessageEntries(req.session.userId, expungeSucceeded, true),
      ...deletedMessageEntries(req.session.userId, trashMoveSucceeded.map((u) => u.msg), false),
    ]);
```

5. `DELETE /messages/:id`:
   - в ветке черновика перед `return res.json({ ok: true });`:

```js
    recordAudit(deletedMessageEntries(req.session.userId, [message], true));
```

   - перед финальным `imapManager.broadcast({ type: 'folder_updated', folder: message.folder, ... })`:

```js
  recordAudit(deletedMessageEntries(req.session.userId, [message], strategy.action === 'expunge'));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bt src/routes/mail.deleteAudit.test.js src/routes/mail.emptyFolder.test.js`
Expected: PASS.

- [ ] **Step 6: Run every mail route test**

Run: `bt src/routes/mail`
Expected: PASS. Ни один другой `mail.*.test.js` не вызывает удаление, поэтому мок журнала им не нужен; если какой-то файл упал на `INSERT INTO mailbox_audit_log`, добавить в него строку мока из раздела «Моки журнала в существующих тестах».

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/mail.js backend/src/routes/mail.deleteAudit.test.js backend/src/routes/mail.emptyFolder.test.js
git commit -m "feat(audit): journal every message a user deletes"
```

---

### Task 7: Журнал действий с пользователями

**Files:**
- Modify: `backend/src/routes/admin.js:107-241`
- Test: `backend/src/routes/admin.users.test.js`

**Interfaces:**
- Consumes: `recordAudit` из Task 1; `lockTargetUser` возвращает `{ id, email, is_admin, disabled_at }`.
- Produces: записи `user.added`, `user.enabled`, `user.disabled`, `user.admin_changed`, `user.deleted` с `details: { userId, email, isAdmin }`.

- [ ] **Step 1: Write the failing tests**

В `backend/src/routes/admin.users.test.js`:

1. Рядом с другими `vi.mock`:

```js
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
```

2. Импорт после остальных:

```js
import { recordAudit } from '../services/auditLog.js';
```

3. В `beforeEach` добавить `recordAudit.mockClear();`.

4. В конец файла (до блока `POST /api/admin/invites` или после него — порядок не важен):

```js
describe('user administration is journaled', () => {
  const emailLookup = [/^\s*SELECT .* FROM users WHERE lower\(email\) = \$1/, { rows: [] }];
  const claim = (row) => [/^\s*UPDATE users SET email = \$1/, { rows: row ? [row] : [] }];
  const update = (row) => [/^\s*UPDATE users\s+SET is_admin = \$2/, (params) => ({
    rows: [{ ...row, is_admin: params[1], email: params[2], disabled_at: params[3] }],
  })];
  const entry = (action, isAdmin = false) => ({
    actorUserId: ADMIN_ID, action, details: { userId: USER_ID, email: 'user@example.com', isAdmin },
  });

  it('records an approved user whether created or claimed', async () => {
    installTransaction([lock, emailLookup, claim(null), [/^\s*INSERT INTO users/, { rows: [USER_ROW] }]]);
    await send('POST', '/users', { email: 'user@example.com' });
    installTransaction([lock, emailLookup, claim(USER_ROW)]);
    await send('POST', '/users', { email: 'user@example.com' });
    expect(recordAudit.mock.calls).toEqual([[[entry('user.added')]], [[entry('user.added')]]]);
  });

  it('records nothing for an address that is already approved', async () => {
    installTransaction([lock, [/^\s*SELECT .* FROM users WHERE lower\(email\) = \$1/, { rows: [USER_ROW] }]]);
    await send('POST', '/users', { email: 'user@example.com' });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('records only the flags that changed', async () => {
    installTransaction([lock, target(USER_ROW), update(USER_ROW)]);
    await send('PATCH', `/users/${USER_ID}`, { disabled: true, isAdmin: true });
    expect(recordAudit).toHaveBeenCalledWith([entry('user.disabled', true), entry('user.admin_changed', true)]);

    recordAudit.mockClear();
    const disabledRow = { ...USER_ROW, disabled_at: '2026-09-16T00:00:00.000Z' };
    installTransaction([lock, target(disabledRow), update(disabledRow)]);
    await send('PATCH', `/users/${USER_ID}`, { disabled: false, isAdmin: false });
    expect(recordAudit).toHaveBeenCalledWith([entry('user.enabled')]);

    recordAudit.mockClear();
    installTransaction([lock, target(USER_ROW), update(USER_ROW)]);
    await send('PATCH', `/users/${USER_ID}`, { email: 'new@example.com' });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('records a deleted user with the email and role it had', async () => {
    installTransaction([lock, target(USER_ROW)]);
    query.mockResolvedValue({ rows: [] });
    await send('DELETE', `/users/${USER_ID}`);
    expect(recordAudit).toHaveBeenCalledWith([entry('user.deleted')]);
  });

  it('records nothing when a guard refuses the change', async () => {
    installTransaction([lock, target({ ...USER_ROW, is_admin: true }), otherAdmins(0)]);
    await send('DELETE', `/users/${USER_ID}`);
    installTransaction([lock, target({ ...USER_ROW, is_admin: true }), otherAdmins(0)]);
    await send('PATCH', `/users/${USER_ID}`, { isAdmin: false });
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/routes/admin.users.test.js`
Expected: FAIL — 3 теста журнала (`records an approved user`, `records only the flags that changed`, `records a deleted user`) не видят вызовов `recordAudit`.

- [ ] **Step 3: Implement**

В `backend/src/routes/admin.js`:

1. Импорт (к импорту `AUDIT_ACTIONS` из Task 2):

```js
import { AUDIT_ACTIONS, recordAudit } from '../services/auditLog.js';
```

2. Рядом с `signOutEverywhere`:

```js
// Journal entry for an admin action on a user. The id is kept because service users may have no
// email to name them by.
const userAuditEntry = (req, action, user) => ({
  actorUserId: req.session.userId,
  action,
  details: { userId: user.id, email: user.email ?? null, isAdmin: !!user.is_admin },
});
```

3. `POST /users`, перед `console.log(\`[admin] ${req.session.userId} approved user ${user.id}\`);`:

```js
    recordAudit([userAuditEntry(req, 'user.added', user)]);
```

4. `PATCH /users/:id`: транзакция возвращает и прежнюю строку — заменить `return { row: updated, lostAccess: lost };` на `return { row: updated, lostAccess: lost, previous: current };`, деструктуризацию — на `const { row, lostAccess, previous } = await withTransaction(...)`. Перед `console.log(\`[admin] ${req.session.userId} updated user ${id}\`);`:

```js
    const auditEntries = [];
    if (!!previous.disabled_at !== !!row.disabled_at) {
      auditEntries.push(userAuditEntry(req, row.disabled_at ? 'user.disabled' : 'user.enabled', row));
    }
    if (!!previous.is_admin !== !!row.is_admin) auditEntries.push(userAuditEntry(req, 'user.admin_changed', row));
    if (auditEntries.length) recordAudit(auditEntries);
```

5. `DELETE /users/:id`: транзакция возвращает удаляемого пользователя — заменить `await withTransaction(async (client) => {` на `deleted = await withTransaction(async (client) => {`, объявить `let deleted;` перед `try`, в конце колбэка транзакции добавить `return current;`. После `await query('DELETE FROM users WHERE id = $1', [id]);`:

```js
  recordAudit([userAuditEntry(req, 'user.deleted', deleted)]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bt src/routes/admin.users.test.js src/routes/admin.audit.test.js src/routes/admin.categorization.test.js src/routes/admin.syncSettings.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/admin.js backend/src/routes/admin.users.test.js
git commit -m "feat(audit): journal admin actions on users"
```

---

### Task 8: Полный прогон, проверка на сервере, спецификация, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`
- Scratch, не коммитится: `<scratchpad>/audit-users.mjs`, `<scratchpad>/audit-http.mjs`, `<scratchpad>/boot-pr4.sh`, `<scratchpad>/pr4-body.md`

- [ ] **Step 1: Full backend run and lint**

Run: `bt`, затем lint (`npm run lint && npm run lint:plugins` в той же команде).
Expected: все тесты PASS, lint без ошибок. Записать число тестов для описания PR.

- [ ] **Step 2: Journal on a running server**

База `mailexpert` из Task 1 уже содержит таблицу журнала. Сервер стартует на ней, затем администратор делает действия с ящиком и пользователем по HTTP и читает журнал постранично.

`<scratchpad>/audit-users.mjs`:

```js
import bcrypt from 'bcryptjs';
import { pool, query } from './src/services/db.js';

const hash = bcrypt.hashSync('Sm0ke-password-123', 10);
await query(`INSERT INTO users (username, email, password_hash, is_admin) VALUES ('audit-admin', 'audit-admin@example.com', $1, true)
             ON CONFLICT (username) DO UPDATE SET password_hash = $1, is_admin = true`, [hash]);
await pool.end();
console.log('audit users ready');
```

`<scratchpad>/audit-http.mjs`:

```js
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:3000';
const H = { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: H, body: JSON.stringify({ username: 'audit-admin', password: 'Sm0ke-password-123' }),
});
assert.equal(login.status, 200, 'admin signs in');
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...H, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const added = await call('POST', '/api/accounts', { name: 'Audit', email_address: 'audit-box@example.com', protocol: 'pop3', smtp_port: 587 });
assert.equal(added.status, 200);
const id = added.body.id;
assert.equal((await call('PUT', `/api/accounts/${id}`, { name: 'Audit renamed', smtp_port: 587 })).status, 200);
assert.equal((await call('PUT', `/api/accounts/${id}`, { smtp_port: 465, auth_pass: 'smoke-secret' })).status, 200);
assert.equal((await call('PUT', `/api/accounts/${id}`, { enabled: false })).status, 200);
assert.equal((await call('DELETE', `/api/accounts/${id}`)).status, 200);

const user = await call('POST', '/api/admin/users', { email: 'audit-user@example.com' });
assert.equal(user.status, 201);
assert.equal((await call('PATCH', `/api/admin/users/${user.body.user.id}`, { isAdmin: true })).status, 200);
assert.equal((await call('DELETE', `/api/admin/users/${user.body.user.id}`)).status, 200);

// The journal is written in the background; give the last inserts a moment.
await new Promise((resolve) => setTimeout(resolve, 500));
const firstPage = await call('GET', '/api/admin/audit');
assert.equal(firstPage.status, 200);
const actions = firstPage.body.entries.map((e) => e.action);
assert.deepEqual(actions.slice(0, 7), [
  'user.deleted', 'user.admin_changed', 'user.added',
  'mailbox.deleted', 'mailbox.disabled', 'mailbox.connection_changed', 'mailbox.added',
]);
const [change] = firstPage.body.entries.filter((e) => e.action === 'mailbox.connection_changed');
assert.deepEqual(change.details, { fields: ['smtp_port', 'auth_pass'] });
assert.equal(change.actorEmail, 'audit-admin@example.com');
assert.equal(change.accountEmail, 'audit-box@example.com');
assert.equal(change.accountId, null, 'the deleted mailbox no longer links');
assert.ok(!JSON.stringify(firstPage.body).includes('smoke-secret'));

const deletedOnly = await call('GET', '/api/admin/audit?action=mailbox.deleted');
assert.ok(deletedOnly.body.entries.every((e) => e.action === 'mailbox.deleted'));
assert.equal((await call('GET', '/api/admin/audit?action=message.read')).body.code, 'invalid_filter');

// Fewer than 100 entries fit on one page, so there is no next page. A cursor at the newest
// entry's millisecond (rounded down to microseconds) with its id must exclude that entry and
// keep the older ones.
assert.equal(firstPage.body.nextCursor, null);
const newest = firstPage.body.entries[0];
const cursor = `${newest.occurredAt.replace(/\.(\d{3})Z$/, '.$1000Z')}_${newest.id}`;
const cursorPage = await call('GET', `/api/admin/audit?before=${encodeURIComponent(cursor)}`);
assert.equal(cursorPage.status, 200);
assert.ok(!cursorPage.body.entries.some((e) => e.id === newest.id), 'the cursor excludes the entry it names');
assert.ok(cursorPage.body.entries.some((e) => e.action === 'mailbox.added'), 'older entries remain');

console.log('audit http ok');
```

`<scratchpad>/boot-pr4.sh`:

```sh
cd /work/backend
# Stop a server left over from an earlier run; the slim image has no pkill.
node -e "
const fs=require('fs');
for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue;
  try { if (fs.readFileSync('/proc/'+d+'/cmdline','utf8').replace(/\0/g,' ').trim()==='node src/index.js') process.kill(+d); } catch {} }"
sleep 2
export DB_HOST=mailexpert-check-db DB_USER=mailexpert DB_NAME=mailexpert DB_PASSWORD=check
node audit-users.mjs || exit 1
env SESSION_SECRET=0123456789abcdef0123456789abcdef0123 \
  REDIS_URL=redis://mailexpert-check-redis:6379 ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  NODE_ENV=development PORT=3000 IMAP_CONNECT_CONCURRENCY=1 node src/index.js > /tmp/boot.log 2>&1 &
PID=$!
for i in $(seq 1 60); do
  if ! kill -0 $PID 2>/dev/null; then echo "process exited"; tail -20 /tmp/boot.log; exit 1; fi
  if node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done
node audit-http.mjs 2>&1 | tail -5
echo "--- errors after requests"
grep -E "\[audit\]|column .* does not exist|relation .* does not exist|syntax error" /tmp/boot.log | head -5
kill $PID
```

Run:

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work'
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/audit-users.mjs" mailexpert-backend-test:/work/backend/audit-users.mjs
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/audit-http.mjs" mailexpert-backend-test:/work/backend/audit-http.mjs
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/boot-pr4.sh" mailexpert-backend-test:/work/backend/boot-pr4.sh
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh /work/backend/boot-pr4.sh
```

Expected: `audit users ready`, `audit http ok`; после `--- errors after requests` пусто.

Если сервер отвечает 400 на `POST /api/accounts` из-за политики портов или 403 на логин (например, включён MFA), поправить скрипт проверки (другой порт, выключенный MFA у тестового админа), а не маршруты. Если отказ указывает на ошибку в коде журнала — остановиться и разобраться по superpowers:systematic-debugging.

Отправка и удаление писем на сервере не проверяются: для них нужен настоящий SMTP- и IMAP-сервер. Их покрывают `send.audit.test.js` и `mail.deleteAudit.test.js`; в описании PR это указать.

Cleanup:

```bash
docker network disconnect mailexpert-check mailexpert-backend-test
docker rm -f mailexpert-check-db mailexpert-check-redis
docker network rm mailexpert-check
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /work/backend && rm -f audit-users.mjs audit-http.mjs boot-pr4.sh'
```

- [ ] **Step 3: Record the clarifications in the spec**

В `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`:

1. Строку статуса заменить на:

```markdown
> Статус: дизайн одобрен 2026-09-15; PR 1 (вход), PR 2 (сервер обслуживает ящики), PR 3 (общие данные) и PR 4 (журнал) реализованы. Работы по нескольким Google OAuth-приложениям (PR 2–5 из `2026-09-15-google-multi-app-design.md`) переписываются под общий список ящиков в PR 8.
```

2. После последнего пункта раздела «Уточнения, принятые при реализации PR 3» (`- Удаление пользователя не трогает ящики; ответ 409 \`user_has_mailboxes\` убран.`) добавить:

```markdown

## Уточнения, принятые при реализации PR 4

- Миграция журнала — `0057_mailbox_audit_log.sql`. Записи пишет `services/auditLog.js` пачкой, email автора и ящика подставляет база; ошибка вставки логируется кодом и не ломает действие.
- `mailbox.added` пишут ручное добавление и OAuth-коллбэки Google и Microsoft. Доменных ящиков пока нет, запись для них добавляет PR 8.
- `mailbox.connection_changed` сравнивает присланные значения с сохранёнными: экран настроек присылает все поля сервера при любом сохранении.
  - Поля: `imap_host`, `imap_port`, `imap_tls`, `imap_skip_tls_verify`, `smtp_host`, `smtp_port`, `smtp_tls`, `auth_user`, `auth_pass`, `smtp_auth_user`, `smtp_auth_pass`.
  - Пароль считается изменённым, если прислан новый или очищен сохранённый.
  - Переподключение Google-ящика на другое приложение пишет `mailbox.reconnected` и `mailbox.connection_changed` с `fields: ['oauth_app_id']`.
- `mailbox.enabled` и `mailbox.disabled` пишутся, только если состояние изменилось.
- У `mailbox.deleted` пустой `account_id`: запись делается после удаления строки, ящик назван по `account_email`.
- `message.deleted` пишут удаление письма, массовое удаление и очистка папки — по записи на письмо. Служебная очистка черновика окном письма (`DELETE /api/mail/draft/:uid`) и перемещение в корзину перетаскиванием не пишутся.
- `details` действий с пользователями — `{ userId, email, isAdmin }`. `PATCH` пишет только изменившиеся флаги, смена email не пишется. Пользователи, созданные при входе через Cloudflare, не пишутся.
- `GET /api/admin/audit`: `from` включительно, `to` не включительно; неверный фильтр — 400 `invalid_filter`; ответ `{ entries, nextCursor }`, курсор — `<occurred_at с микросекундами в UTC>_<id>`.
```

- [ ] **Step 4: Commit the spec**

```bash
git add docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md
git commit -m "docs: record the audit log clarifications"
```

- [ ] **Step 5: Push and open the PR**

`<scratchpad>/pr4-body.md`:

```markdown
PR 4 of the shared mailboxes series: an audit log of what users do with the shared mailboxes.

## What changes

- Migration `0057_mailbox_audit_log.sql` adds `mailbox_audit_log` as designed in the spec.
- `services/auditLog.js` records entries in batches. The database fills in the actor and mailbox emails. A failed insert is logged by error code only and never fails the action.
- Recorded actions:
  - mailboxes: added (manual, Google, Microsoft), OAuth reconnected, connection settings changed (field names only), enabled, disabled, deleted;
  - messages: sent (Message-ID and recipients), deleted (single, bulk, emptied folder; one entry per message);
  - users: added, enabled, disabled, admin flag changed, deleted.
- `GET /api/admin/audit` (admins only): filters `account`, `user`, `action`, `from`, `to`; 100 entries per page with a `(occurred_at, id)` cursor.
- No subject, body, attachment, password or token is ever written.

## Not yet

- The audit screen is PR 5.
- Domain mailboxes do not exist yet; PR 8 records their addition.

## Checks

- Backend: <N> tests, lint clean.
- Postgres 16: migration applied; batch insert resolves emails; a deleted user or mailbox keeps the copied emails; a bad UUID does not break the caller.
- Running server: mailbox add/change/disable/delete and user add/promote/delete over HTTP show up in `GET /api/admin/audit` in order, without the password that was set.
- Send and delete journaling are covered by route tests with the real writer (`send.audit.test.js`, `mail.deleteAudit.test.js`); they need real SMTP/IMAP servers to check live.
```

Подставить число тестов из Step 1 вместо `<N>`.

```bash
git push -u origin feat/mailbox-audit-log
gh pr create --repo wyrtensi/MailExpert --base main --head feat/mailbox-audit-log --title "feat(audit): journal mailbox, message and user actions" --body-file "<scratchpad>/pr4-body.md"
```

---

## Self-review

- **Покрытие спецификации:** таблица и индексы — Task 1; все 13 действий таблицы — Tasks 3–7; «только действия пользователей», «запись на каждое письмо», «без темы, текста и секретов», «ошибка не ломает действие» — Global Constraints и тесты Tasks 1, 3, 5, 6; API с фильтрами, 100 записями и курсором — Task 2; тест журнала из раздела «Проверка» — `send.audit.test.js` и `mail.deleteAudit.test.js`.
- **Заглушки:** нет.
- **Согласованность имён:** `recordAudit`, `AUDIT_ACTIONS`, `changedConnectionFields`, `deletedMessageEntries`, `userAuditEntry`, `recordGoogleConsent`, `previousAppId` используются одинаково во всех задачах.
