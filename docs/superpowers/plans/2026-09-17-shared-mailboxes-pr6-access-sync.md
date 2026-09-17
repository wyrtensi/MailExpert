# Общие ящики, PR 6: синхронизация с Cloudflare Access — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Субагенты разрешены глобальными инструкциями пользователя: исполнители и ревьюеры не ниже Sonnet, финальное ревью ветки — Opus, одновременно не больше трёх.

**Goal:** MailExpert становится единственным местом одобрения: фоновая синхронизация держит список `include` Allow-политики Access-приложения в соответствии с активными пользователями, отключает пользователей, которых убрали в Cloudflare, и показывает администратору состояние последнего прогона.

**Architecture:**
- `backend/src/services/accessSync/` — пять модулей с одной задачей каждый:
  - `cloudflareAccessClient.js` — чтение и запись политики через API Cloudflare (`fetch`, таймаут 10 с, в ошибках только коды);
  - `reconcile.js` — чистые функции трёхсторонней сверки: кого убрали в Cloudflare, превышен ли порог отключений, какой `include` записать;
  - `settings.js` — настройки и состояние в `system_settings` (токен зашифрован), порог `ACCESS_SYNC_MAX_DISABLES`;
  - `runner.js` — один прогон: читает политику и пользователей, отключает, пишет политику, baseline, состояние и журнал;
  - `scheduler.js` + `index.js` — один исполнитель на процесс: дребезг запросов, прогон раз в час, прогоны и сохранение настроек никогда не пересекаются.
- `backend/src/services/auth/userStatus.js` — проверки «последнего активного администратора» переезжают сюда из `routes/admin.js`, рядом `disableUsersByEmail` для отключения без сессии администратора.
- `backend/src/routes/accessSync.js` — `GET/PUT /api/admin/access-sync`, `POST /api/admin/access-sync/run`, подключается в `routes/admin.js`. Добавление, отключение, смена email и удаление пользователя в `admin.js` запрашивают синхронизацию.
- Фронтенд: третья вкладка «Синхронизация с Access» в разделе «Пользователи» в режиме `google` (`AccessSyncPanel.jsx`), логика формы в `utils/accessSync.js`, демо-ответы, строки на 9 языках, новое действие журнала на экране журнала.

**Tech Stack:** Node 22, Express 5, PostgreSQL 16, vitest; React 19, react-i18next, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` — разделы «Синхронизация с Cloudflare Access», «Не входит», «Журнал», «Разбиение на PR» (пункт 6).

**Cloudflare API** (проверено по документации Cloudflare):
- `GET/PUT /accounts/{account_id}/access/apps/{app_id}/policies/{policy_id}` — политика приложения; `GET/PUT /accounts/{account_id}/access/policies/{policy_id}` — reusable-политика. Запись reusable-политики через эндпоинт приложения отвечает 400.
- Ответ: `{ success, errors: [{ code, message }], messages, result }`. `PUT` заменяет документ целиком, `PATCH` не поддерживается.
- Обязательные поля тела: `name`, `decision`, `include`. Только для чтения: `id`, `uid`, `created_at`, `updated_at`, `reusable`, `app_count`.
- Правила: `{ email: { email } }`, `{ email_domain: { domain } }`, `{ group: { id } }` и другие типы.
- Право токена в панели Cloudflare сейчас называется «Access: Apps and Policies Write»; в спецификации — «Edit».

## Global Constraints

- Комментарии в коде — только на английском.
- Коммиты и PR — от имени `wyrtensi`, без строк атрибуции. Все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- В документах, коммитах и PR — только заглушки `<CF_HOST>`, `<DIRECT_HOST>`, `<TEAM>`, `<AUD>`. Внутренние имена других проектов не упоминаются. Настоящих account id, app id, policy id и токенов нет нигде, в тестах — выдуманные значения.
- Токен API, email пользователей и тексты ответов Cloudflare не попадают в логи, URL и тексты ошибок; в логах — только коды ошибок. Токен никогда не возвращается из API.
- Источник правды — активные пользователи MailExpert (спецификация).
- `email_domain`-правила MailExpert только читает: не добавляет, не удаляет и не меняет (спецификация, «Не входит»).
- `BOOTSTRAP_ADMIN_EMAILS` никогда не удаляются из политики и не отключаются. Пустой итоговый `include` не записывается.
- Порог: прогон, который отключил бы больше `ACCESS_SYNC_MAX_DISABLES` (10) пользователей или больше половины активных, останавливается и пишет событие в журнал.
- Весь текст интерфейса — через `t()`, ключи есть во всех 9 локалях (`en`, `ru`, `de`, `es`, `fr`, `it`, `cs`, `pl`, `zhCN`), переводы различаются между локалями (`frontend/src/locales/i18n.test.js`). Локали хранятся с CRLF; правка — через разбор JSON и запись `JSON.stringify(..., null, 2)` с CRLF.
- Монки-патчинг запрещён.
- Новые исходники бэкенда не содержат слова `user_id` (`backend/src/sharedData.guard.test.js`).
- Пользовательские контейнеры `mailexpert-frontend`, `mailexpert-backend`, `mailexpert-postgres`, `mailexpert-redis` не пересобираются и не перезапускаются.
- Работа идёт в ветке `feat/access-policy-sync` от `main`. Первый коммит ветки — этот план.

## Уточнения спецификации в этом PR

Task 13 вносит их в спецификацию.

1. **Хранение без миграции.** `system_settings` хранит два ключа:
   - `access_sync_config` — `{ enabled, accountId, appId, policyId, apiToken }`, токен зашифрован `encrypt()`;
   - `access_sync_state` — `{ baseline, abortedCandidates, lastRun }`.
   Миграция `0058` не нужна. Смена account id, app id или policy id сбрасывает baseline: иначе адреса, которые MailExpert записал в старую политику, выглядели бы удалёнными в новой и отключали бы пользователей.
2. **API вместо маски.** `GET` отдаёт `apiTokenSet: true/false`, а не маску `••••••••`: токен только записывается. Пустое поле токена при сохранении оставляет сохранённый токен.
3. **Сверка:**
   - `email_domain`-правила и все правила, кроме `email`, сохраняются как есть; домены используются только чтобы не отключать пользователя, которого домен всё ещё пропускает;
   - «пропускает домен» — домен email есть в `include` как `email_domain`, а сам email и его домен не перечислены в `exclude`;
   - если в политике нет ни одного `email`-правила, никто не считается удалённым: так выглядит стёртая или неверно прочитанная политика;
   - порог «больше половины активных» — `кандидаты × 2 > активные`; `ACCESS_SYNC_MAX_DISABLES=0` останавливает любой прогон с отключениями;
   - остановленный прогон ничего не отключает и не пишет политику, baseline не меняется; событие журнала пишется, только если набор кандидатов отличается от прошлой остановки;
   - политика, у которой `decision` не `allow`, не записывается: прогон завершается ошибкой `policy_not_allow`.
4. **Отключение из Cloudflare** не оставляет установку без администратора: активный администратор, у которого нет другого активного администратора, не отключается и остаётся в политике. Отключённый пользователь теряет сессии и WebSocket, как при отключении в админке.
5. **Журнал.**
   - Новое действие `access.sync_aborted`, `details: { candidates, activeUsers, maxDisables }`.
   - Отключение из Cloudflare пишет `user.disabled` с `details.source = 'cloudflare_access'`.
   - У обеих записей нет пользователя-автора; автор записан как `Cloudflare Access` через новое поле `actorEmail` у `recordAudit`.
6. **Запуск.**
   - Воркер работает только при `AUTH_MODE=google` и включённой синхронизации с заполненными настройками.
   - Добавление, отключение, включение, смена email и удаление пользователя запрашивают прогон; запросы в течение 10 секунд сливаются в один.
   - Сохранение настроек с включённой синхронизацией и старт сервера тоже запрашивают прогон; полная сверка идёт раз в час; кнопка «Синхронизировать сейчас» ждёт прогон и показывает результат.
   - Прогоны и сохранение настроек выполняются по одному в процессе: MailExpert работает одним контейнером, блокировка в базе не нужна.
7. **Пользователи, созданные входом через Cloudflare** (`resolveVerifiedUser` создаёт их при первом входе), становятся активными пользователями MailExpert и при следующем прогоне попадают в политику отдельным `email`-правилом.
8. **`CF_API_BASE`** — необязательная переменная для проверки на тестовом сервере; по умолчанию `https://api.cloudflare.com/client/v4`.
9. **Право токена** в панели Cloudflare называется «Access: Apps and Policies Write» (в спецификации — «Edit»).

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

Frontend, из корня репозитория:
- отдельные файлы: `cd frontend && node --test <files>`;
- полный прогон: `cd frontend && npm test && npm run lint && npm run build`;
- если сборка падает на отсутствующем модуле, сначала `cd frontend && npm ci`.

## Файлы

| Файл | Ответственность |
|---|---|
| Modify `backend/src/services/auditLog.js` (+ `auditLog.test.js`) | `access.sync_aborted`, автор без пользователя (`actorEmail`) |
| Create `backend/src/services/auth/userStatus.js` (+ `userStatus.test.js`) | Проверки активного администратора, отключение по email |
| Modify `backend/src/routes/admin.js` (+ `admin.users.test.js`) | Импорт проверок, запрос синхронизации, подключение маршрутов синхронизации |
| Create `backend/src/services/accessSync/cloudflareAccessClient.js` (+ test) | API Cloudflare Access |
| Create `backend/src/services/accessSync/reconcile.js` (+ test) | Чистая трёхсторонняя сверка |
| Create `backend/src/services/accessSync/settings.js` (+ test) | Настройки, состояние, порог |
| Create `backend/src/services/accessSync/runner.js` (+ test) | Один прогон |
| Create `backend/src/services/accessSync/scheduler.js` (+ test), `index.js` | Один исполнитель, дребезг, раз в час |
| Create `backend/src/routes/accessSync.js` (+ test) | Admin API |
| Modify `backend/src/index.js` | Запуск воркера в режиме `google` |
| Modify `.env.example` | `ACCESS_SYNC_MAX_DISABLES`, `CF_API_BASE` |
| Create `frontend/src/utils/accessSync.js` (+ test); Modify `utils/api.js` | Форма, итог прогона, API-клиент |
| Modify `frontend/src/utils/auditLog.js` (+ test) | Действие `access.sync_aborted` |
| Modify `frontend/src/demo/index.js` (+ `index.test.js`) | Синхронизация в демо-режиме |
| Modify `frontend/src/locales/*.json` | Строки на 9 языках |
| Create `frontend/src/components/AccessSyncPanel.jsx`; Modify `AdminPanel.jsx` | Вкладка синхронизации |
| Modify спецификация, `docs/architecture/codebase-file-map.md` | Уточнения, статус, карта файлов |

---

### Task 1: Журнал: действие остановленной синхронизации и автор без пользователя

**Files:**
- Modify: `backend/src/services/auditLog.js`
- Test: `backend/src/services/auditLog.test.js`

**Interfaces:**
- Produces:
  - `AUDIT_ACTIONS` заканчивается на `'access.sync_aborted'` (14 действий);
  - `recordAudit(entries)` принимает у записи необязательное `actorEmail: string`: автор без пользователя, например `'Cloudflare Access'`. Если `actorUserId` указывает на существующего пользователя, его email важнее.

- [ ] **Step 1: Update the tests**

В `backend/src/services/auditLog.test.js`:

1. В тесте `lists every action of the spec` заменить ожидание на:

```js
    expect(AUDIT_ACTIONS).toEqual([
      'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
      'mailbox.enabled', 'mailbox.disabled', 'message.sent', 'message.deleted',
      'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
      'access.sync_aborted',
    ]);
```

2. В тесте `writes a batch in one statement...` заменить строку с `COALESCE\(NULLIF` на:

```js
    expect(sql).toMatch(/COALESCE\(NULLIF\(u\.email, ''\), u\.username, e\.actor_email\)/);
```

и ожидание `insertedRows()` на:

```js
    expect(insertedRows()).toEqual([
      { actor_user_id: 'u1', actor_email: null, account_id: 'a1', account_email: null, action: 'message.deleted', details: { messageId: '<m1@example.com>', folder: 'INBOX', from: 'x@example.com', permanent: false } },
      { actor_user_id: 'u1', actor_email: null, account_id: null, account_email: 'gone@example.com', action: 'mailbox.deleted', details: {} },
    ]);
```

3. В тесте `accepts a single entry` ожидание заменить на:

```js
    expect(insertedRows()).toEqual([
      { actor_user_id: 'u1', actor_email: null, account_id: 'a1', account_email: null, action: 'mailbox.disabled', details: {} },
    ]);
```

4. После теста `accepts a single entry` добавить:

```js
  it('names an actor that is not a user', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await recordAudit({
      actorEmail: 'Cloudflare Access', action: 'access.sync_aborted',
      details: { candidates: ['a@example.com'], activeUsers: 1, maxDisables: 10 },
    });
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/AS e\(actor_user_id uuid, actor_email text, account_id uuid, account_email text, action text, details jsonb\)/);
    expect(insertedRows()).toEqual([{
      actor_user_id: null, actor_email: 'Cloudflare Access', account_id: null, account_email: null,
      action: 'access.sync_aborted', details: { candidates: ['a@example.com'], activeUsers: 1, maxDisables: 10 },
    }]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bt src/services/auditLog.test.js`
Expected: FAIL — список действий без `access.sync_aborted`, в SQL нет `e.actor_email`, в строках нет `actor_email`.

- [ ] **Step 3: Implement**

В `backend/src/services/auditLog.js`:

1. Заменить комментарий и список действий на:

```js
// Everything a user can do that the journal records, plus the Cloudflare Access sync stopping
// itself. Mail sync and inbox rules never write here.
export const AUDIT_ACTIONS = Object.freeze([
  'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
  'mailbox.enabled', 'mailbox.disabled', 'message.sent', 'message.deleted',
  'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
  'access.sync_aborted',
]);
```

2. Заменить комментарий над `INSERT_SQL` и сам `INSERT_SQL` на:

```js
// The database fills in both emails: the actor's email (or username when it has none, or the
// name the caller passed for an actor that is not a user) and the mailbox address, falling back
// to the address the caller passed for a mailbox already deleted.
const INSERT_SQL = `
  INSERT INTO mailbox_audit_log (actor_user_id, actor_email, account_id, account_email, action, details)
  SELECT u.id, COALESCE(NULLIF(u.email, ''), u.username, e.actor_email), a.id, COALESCE(a.email_address, e.account_email),
         e.action, COALESCE(e.details, '{}'::jsonb)
    FROM jsonb_to_recordset($1::jsonb)
         AS e(actor_user_id uuid, actor_email text, account_id uuid, account_email text, action text, details jsonb)
    LEFT JOIN users u ON u.id = e.actor_user_id
    LEFT JOIN email_accounts a ON a.id = e.account_id`;
```

3. В `toRow` после `actor_user_id` добавить строку:

```js
    actor_email: entry.actorEmail ?? null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bt src/services/auditLog.test.js src/routes/admin.audit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/auditLog.js backend/src/services/auditLog.test.js
git commit -m "feat(audit): record actors that are not users and a stopped Access sync"
```

---

### Task 2: Отключение пользователей без сессии администратора

**Files:**
- Create: `backend/src/services/auth/userStatus.js`
- Test: `backend/src/services/auth/userStatus.test.js`
- Modify: `backend/src/routes/admin.js:53-69` (перенос `countsAsActiveAdmin`, `otherActiveAdminExists`, `lockAdminGuard`)

**Interfaces:**
- Produces (`services/auth/userStatus.js`):
  - `countsAsActiveAdmin(row: { is_admin, disabled_at, email }, googleMode: boolean): boolean`;
  - `otherActiveAdminExists(client, userId: string, googleMode: boolean): Promise<boolean>`;
  - `lockAdminGuard(client): Promise`;
  - `disableUsersByEmail(client, emails: string[], { googleMode: boolean, bootstrapAdminEmails: Set<string> }): Promise<{ disabled: Array<{ id, email, is_admin }>, keptLastAdmin: string[] }>` — вызывается внутри транзакции; `emails` в нижнем регистре.

- [ ] **Step 1: Write the failing test**

`backend/src/services/auth/userStatus.test.js`:

```js
import { describe, expect, it, vi } from 'vitest';
import { countsAsActiveAdmin, disableUsersByEmail } from './userStatus.js';

// Transaction client over an in-memory users table that records the SQL it sees.
function fakeClient(users) {
  const calls = [];
  const client = {
    calls,
    query: vi.fn(async (sql, params = []) => {
      calls.push(sql);
      if (/pg_advisory_xact_lock\(hashtext\('users-admin-guard'\)\)/.test(sql)) return { rows: [] };
      if (/FROM users WHERE lower\(email\) = \$1 AND disabled_at IS NULL FOR UPDATE/.test(sql)) {
        return { rows: users.filter((u) => u.email === params[0] && !u.disabled_at) };
      }
      if (/SELECT COUNT\(\*\)::int AS count FROM users/.test(sql)) {
        const count = users.filter((u) => u.is_admin && !u.disabled_at && u.id !== params[0]
          && (!/email IS NOT NULL/.test(sql) || u.email)).length;
        return { rows: [{ count }] };
      }
      if (/UPDATE users SET disabled_at = NOW\(\), disabled_by = NULL WHERE id = \$1/.test(sql)) {
        const user = users.find((u) => u.id === params[0]);
        user.disabled_at = new Date();
        return { rows: [{ id: user.id, email: user.email, is_admin: user.is_admin }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  return client;
}

const user = (id, email, isAdmin = false) => ({ id, email, is_admin: isAdmin, disabled_at: null });
const options = (bootstrap = []) => ({ googleMode: true, bootstrapAdminEmails: new Set(bootstrap) });

describe('countsAsActiveAdmin', () => {
  it('needs an email only in google mode', () => {
    const noEmail = { is_admin: true, disabled_at: null, email: null };
    expect(countsAsActiveAdmin(noEmail, false)).toBe(true);
    expect(countsAsActiveAdmin(noEmail, true)).toBe(false);
    expect(countsAsActiveAdmin({ ...noEmail, email: 'a@example.com', disabled_at: new Date() }, true)).toBe(false);
  });
});

describe('disableUsersByEmail', () => {
  it('takes the admin guard lock first and disables active users', async () => {
    const users = [user('1', 'a@example.com'), user('2', 'b@example.com'), user('3', 'admin@example.com', true)];
    const client = fakeClient(users);
    const result = await disableUsersByEmail(client, ['a@example.com', 'b@example.com'], options());
    expect(client.calls[0]).toMatch(/pg_advisory_xact_lock/);
    expect(result).toEqual({
      disabled: [{ id: '1', email: 'a@example.com', is_admin: false }, { id: '2', email: 'b@example.com', is_admin: false }],
      keptLastAdmin: [],
    });
    expect(users.map((u) => !!u.disabled_at)).toEqual([true, true, false]);
  });

  it('never touches a bootstrap admin and skips unknown or already disabled users', async () => {
    const users = [user('1', 'boot@example.com', true), { ...user('2', 'off@example.com'), disabled_at: new Date() }];
    const client = fakeClient(users);
    const result = await disableUsersByEmail(client, ['boot@example.com', 'off@example.com', 'nobody@example.com'], options(['boot@example.com']));
    expect(result).toEqual({ disabled: [], keptLastAdmin: [] });
    expect(client.query.mock.calls.some(([, params]) => params?.[0] === 'boot@example.com')).toBe(false);
  });

  it('keeps the last active admin and disables an admin when another one remains', async () => {
    const lone = [user('1', 'admin@example.com', true)];
    expect(await disableUsersByEmail(fakeClient(lone), ['admin@example.com'], options()))
      .toEqual({ disabled: [], keptLastAdmin: ['admin@example.com'] });
    expect(lone[0].disabled_at).toBeNull();

    const pair = [user('1', 'one@example.com', true), user('2', 'two@example.com', true)];
    const result = await disableUsersByEmail(fakeClient(pair), ['one@example.com', 'two@example.com'], options());
    expect(result).toEqual({ disabled: [{ id: '1', email: 'one@example.com', is_admin: true }], keptLastAdmin: ['two@example.com'] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bt src/services/auth/userStatus.test.js`
Expected: FAIL — модуль `./userStatus.js` не найден.

- [ ] **Step 3: Implement the module**

`backend/src/services/auth/userStatus.js`:

```js
// Who keeps the install reachable, and turning users off outside an admin request.

// Whether the user can still reach the admin panel: an admin, not disabled, and — in google
// mode, where sign-in is by email — with an email.
export function countsAsActiveAdmin({ is_admin: isAdmin, disabled_at: disabledAt, email }, googleMode) {
  return !!isAdmin && !disabledAt && (!googleMode || !!email);
}

export async function otherActiveAdminExists(client, userId, googleMode) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS count FROM users
      WHERE is_admin = true AND disabled_at IS NULL AND id <> $1${googleMode ? ' AND email IS NOT NULL' : ''}`,
    [userId],
  );
  return rows[0].count > 0;
}

// Serializes changes that could leave the install without a reachable admin.
export const lockAdminGuard = (client) => client.query("SELECT pg_advisory_xact_lock(hashtext('users-admin-guard'))");

// Disables active users by email inside the caller's transaction, for changes that come from
// outside the admin panel (the Cloudflare Access sync). Bootstrap admins are never touched, and
// an admin stays active when turning them off would leave no active admin.
export async function disableUsersByEmail(client, emails, { googleMode, bootstrapAdminEmails }) {
  await lockAdminGuard(client);
  const disabled = [];
  const keptLastAdmin = [];
  for (const email of emails) {
    if (bootstrapAdminEmails.has(email)) continue;
    const { rows: [current] } = await client.query(
      'SELECT id, email, is_admin, disabled_at FROM users WHERE lower(email) = $1 AND disabled_at IS NULL FOR UPDATE',
      [email],
    );
    if (!current) continue;
    if (countsAsActiveAdmin(current, googleMode) && !(await otherActiveAdminExists(client, current.id, googleMode))) {
      keptLastAdmin.push(email);
      continue;
    }
    const { rows: [row] } = await client.query(
      'UPDATE users SET disabled_at = NOW(), disabled_by = NULL WHERE id = $1 RETURNING id, email, is_admin',
      [current.id],
    );
    disabled.push(row);
  }
  return { disabled, keptLastAdmin };
}
```

- [ ] **Step 4: Use the moved guards in `admin.js`**

В `backend/src/routes/admin.js` удалить функции `countsAsActiveAdmin`, `otherActiveAdminExists` и константу `lockAdminGuard` вместе с их комментариями (строки между `publicUser` и `lockTargetUser`), а после строки `import { UserIdentityError, claimOrCreateUserByEmail, normalizeEmail } from '../services/auth/userIdentity.js';` добавить:

```js
import { countsAsActiveAdmin, lockAdminGuard, otherActiveAdminExists } from '../services/auth/userStatus.js';
```

Тексты SQL не меняются, поэтому `admin.users.test.js` проходит без правок.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bt src/services/auth/userStatus.test.js src/routes/admin.users.test.js src/sharedData.guard.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/auth/userStatus.js backend/src/services/auth/userStatus.test.js backend/src/routes/admin.js
git commit -m "refactor(auth): share admin guards and disable users by email"
```

---

### Task 3: Клиент API Cloudflare Access

**Files:**
- Create: `backend/src/services/accessSync/cloudflareAccessClient.js`
- Test: `backend/src/services/accessSync/cloudflareAccessClient.test.js`

**Interfaces:**
- Produces:
  - `class CloudflareAccessError extends Error` с полями `status: number | 'network' | 'timeout' | 'not_attached'` и `codes: number[]`; `message` вида `Cloudflare getPolicy failed (403): error 10000` — без текстов ответа;
  - `cloudflareApiBase(env = process.env): string`;
  - `createCloudflareAccessClient({ accountId, appId, apiToken, apiBase?, fetchImpl? })` → `{ getPolicy(policyId): Promise<object>, updatePolicy(policy): Promise<object> }`.

- [ ] **Step 1: Write the failing test**

`backend/src/services/accessSync/cloudflareAccessClient.test.js`:

```js
import { describe, expect, it, vi } from 'vitest';
import { CloudflareAccessError, cloudflareApiBase, createCloudflareAccessClient } from './cloudflareAccessClient.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';
const BASE = 'https://cf.test/client/v4';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const client = (fetchImpl) => createCloudflareAccessClient({ accountId: ACCOUNT, appId: APP, apiToken: 'tok-secret', apiBase: BASE, fetchImpl });

describe('cloudflareApiBase', () => {
  it('defaults to the public API and trims a trailing slash from an override', () => {
    expect(cloudflareApiBase({})).toBe('https://api.cloudflare.com/client/v4');
    expect(cloudflareApiBase({ CF_API_BASE: ' http://127.0.0.1:4010/ ' })).toBe('http://127.0.0.1:4010');
  });
});

describe('getPolicy', () => {
  it('reads the policy through the application with the bearer token and a timeout', async () => {
    const policy = { id: POLICY, name: 'Allow', decision: 'allow', include: [] };
    const fetchImpl = vi.fn(async () => reply(200, { success: true, errors: [], result: policy }));
    expect(await client(fetchImpl).getPolicy(POLICY)).toEqual(policy);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/accounts/${ACCOUNT}/access/apps/${APP}/policies/${POLICY}`);
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer tok-secret');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports only the status and error codes, never the response text', async () => {
    const fetchImpl = vi.fn(async () => reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error for person@example.com' }] }));
    const err = await client(fetchImpl).getPolicy(POLICY).catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareAccessError);
    expect(err.message).toBe('Cloudflare getPolicy failed (403): error 10000');
    expect(err.status).toBe(403);
    expect(err.codes).toEqual([10000]);
    expect(err.message).not.toContain('person@example.com');
  });

  it('treats success: false or an unreadable body as a failure', async () => {
    await expect(client(async () => reply(200, { success: false, errors: [] })).getPolicy(POLICY))
      .rejects.toThrow('Cloudflare getPolicy failed (200)');
    await expect(client(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } })).getPolicy(POLICY))
      .rejects.toThrow('Cloudflare getPolicy failed (200)');
  });

  it('says a policy exists but is not attached when only the account knows it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(404, { success: false, errors: [{ code: 12130 }] }))
      .mockResolvedValueOnce(reply(200, { success: true, result: { id: POLICY } }));
    const err = await client(fetchImpl).getPolicy(POLICY).catch((e) => e);
    expect(err.status).toBe('not_attached');
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/accounts/${ACCOUNT}/access/policies/${POLICY}`);

    const missing = vi.fn(async () => reply(404, { success: false, errors: [{ code: 12130 }] }));
    const notFound = await client(missing).getPolicy(POLICY).catch((e) => e);
    expect(notFound.status).toBe(404);
  });

  it('names network failures and timeouts', async () => {
    const network = await client(async () => { throw new TypeError('fetch failed'); }).getPolicy(POLICY).catch((e) => e);
    expect(network.status).toBe('network');
    const timeout = await client(async () => { throw new DOMException('timed out', 'TimeoutError'); }).getPolicy(POLICY).catch((e) => e);
    expect(timeout.status).toBe('timeout');
  });
});

describe('updatePolicy', () => {
  const stored = {
    id: POLICY, uid: 'u', created_at: 'c', updated_at: 'u', app_count: 1, name: 'Allow', decision: 'allow',
    include: [{ email: { email: 'a@example.com' } }], precedence: 1,
  };

  it('writes an application policy whole, without read-only fields', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { success: true, result: {} }));
    await client(fetchImpl).updatePolicy({ ...stored, reusable: false });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/accounts/${ACCOUNT}/access/apps/${APP}/policies/${POLICY}`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      name: 'Allow', decision: 'allow', include: [{ email: { email: 'a@example.com' } }], precedence: 1, exclude: [], require: [],
    });
  });

  it('writes a reusable policy through the account', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { success: true, result: {} }));
    await client(fetchImpl).updatePolicy({ ...stored, reusable: true, exclude: [{ email: { email: 'x@example.com' } }] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/accounts/${ACCOUNT}/access/policies/${POLICY}`);
    expect(JSON.parse(init.body).exclude).toEqual([{ email: { email: 'x@example.com' } }]);
    expect(JSON.parse(init.body)).not.toHaveProperty('reusable');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bt src/services/accessSync/cloudflareAccessClient.test.js`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Implement**

`backend/src/services/accessSync/cloudflareAccessClient.js`:

```js
// Reads and writes one Cloudflare Access policy. Errors carry the HTTP status and Cloudflare
// error codes only: response texts can quote emails or other account details.
const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 10_000;
const READ_ONLY_FIELDS = new Set(['id', 'uid', 'created_at', 'updated_at', 'reusable', 'app_count']);

export class CloudflareAccessError extends Error {
  constructor(action, status, codes = []) {
    super(`Cloudflare ${action} failed (${status})${codes.length ? `: error ${codes.join(', ')}` : ''}`);
    this.name = 'CloudflareAccessError';
    this.status = status;
    this.codes = codes;
  }
}

// CF_API_BASE points the client at a test server; production uses the public API.
export function cloudflareApiBase(env = process.env) {
  return String(env.CF_API_BASE ?? '').trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
}

export function createCloudflareAccessClient({
  accountId, appId, apiToken, apiBase = cloudflareApiBase(), fetchImpl = fetch,
}) {
  const accessUrl = `${apiBase}/accounts/${accountId}/access`;

  async function call(action, method, url, body) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new CloudflareAccessError(action, err?.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.success === false) {
      const codes = (Array.isArray(payload?.errors) ? payload.errors : [])
        .map((error) => error?.code)
        .filter(Number.isInteger);
      throw new CloudflareAccessError(action, res.status, codes);
    }
    return payload.result;
  }

  return {
    async getPolicy(policyId) {
      try {
        return await call('getPolicy', 'GET', `${accessUrl}/apps/${appId}/policies/${policyId}`);
      } catch (err) {
        if (err.status !== 404) throw err;
        // Reusable policies are readable through the application they are attached to, so a 404
        // there with the policy present on the account means it is not attached to this app.
        const onAccount = await call('getPolicy', 'GET', `${accessUrl}/policies/${policyId}`).then(() => true, () => false);
        throw onAccount ? new CloudflareAccessError('getPolicy', 'not_attached') : err;
      }
    },

    // PUT replaces the whole policy, so every field read is written back except read-only ones.
    updatePolicy(policy) {
      const body = Object.fromEntries(Object.entries(policy).filter(([key]) => !READ_ONLY_FIELDS.has(key)));
      body.exclude = policy.exclude ?? [];
      body.require = policy.require ?? [];
      const url = policy.reusable === true
        ? `${accessUrl}/policies/${policy.id}`
        : `${accessUrl}/apps/${appId}/policies/${policy.id}`;
      return call('updatePolicy', 'PUT', url, body);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bt src/services/accessSync/cloudflareAccessClient.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/accessSync/cloudflareAccessClient.js backend/src/services/accessSync/cloudflareAccessClient.test.js
git commit -m "feat(access-sync): add a Cloudflare Access policy client"
```

---

### Task 4: Трёхсторонняя сверка

**Files:**
- Create: `backend/src/services/accessSync/reconcile.js`
- Test: `backend/src/services/accessSync/reconcile.test.js`

**Interfaces:**
- Produces:
  - `domainAdmits(policy): (email: string) => boolean`;
  - `removedInCloudflare({ policy, baseline: string[], activeEmails: string[], pinned: Set<string> }): string[]` — отсортированные email;
  - `exceedsDisableLimit(count: number, activeCount: number, maxDisables: number): boolean`;
  - `buildInclude({ policy, baseline: string[], desired: string[] }): { include: object[], changed: boolean, added: string[], removed: string[] }`.
- Все email на входе и выходе — в нижнем регистре; правила политики сравниваются без учёта регистра.

- [ ] **Step 1: Write the failing test**

`backend/src/services/accessSync/reconcile.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { buildInclude, domainAdmits, exceedsDisableLimit, removedInCloudflare } from './reconcile.js';

const email = (address) => ({ email: { email: address } });
const domain = (name) => ({ email_domain: { domain: name } });
const group = { group: { id: 'g-1' } };
const policy = (include, exclude = []) => ({ id: 'p', name: 'Allow', decision: 'allow', include, exclude, require: [] });
const none = new Set();

describe('domainAdmits', () => {
  it('admits an email at an included domain unless the email or domain is excluded', () => {
    const admits = domainAdmits(policy([domain('Team.example')], [email('out@team.example'), domain('gone.example')]));
    expect(admits('in@team.example')).toBe(true);
    expect(admits('out@team.example')).toBe(false);
    expect(admits('in@other.example')).toBe(false);
    expect(domainAdmits(policy([domain('gone.example')], [domain('gone.example')]))('a@gone.example')).toBe(false);
  });
});

describe('removedInCloudflare', () => {
  const base = { baseline: ['a@example.com', 'b@example.com'], activeEmails: ['a@example.com', 'b@example.com', 'new@example.com'], pinned: none };

  it('finds an email MailExpert wrote that Cloudflare no longer lists', () => {
    expect(removedInCloudflare({ ...base, policy: policy([email('A@example.com')]) })).toEqual(['b@example.com']);
  });

  it('never treats a user added in MailExpert since the last run as removed', () => {
    expect(removedInCloudflare({ ...base, policy: policy([email('a@example.com'), email('b@example.com')]) })).toEqual([]);
  });

  it('keeps a user a domain rule still admits, but not one the policy excludes', () => {
    expect(removedInCloudflare({ ...base, policy: policy([email('a@example.com'), domain('example.com')]) })).toEqual([]);
    expect(removedInCloudflare({ ...base, policy: policy([email('a@example.com'), domain('example.com')], [email('b@example.com')]) }))
      .toEqual(['b@example.com']);
  });

  it('ignores inactive users, bootstrap admins and a policy without any email rule', () => {
    expect(removedInCloudflare({ ...base, activeEmails: ['a@example.com'], policy: policy([email('a@example.com')]) })).toEqual([]);
    expect(removedInCloudflare({ ...base, pinned: new Set(['b@example.com']), policy: policy([email('a@example.com')]) })).toEqual([]);
    expect(removedInCloudflare({ ...base, policy: policy([group]) })).toEqual([]);
  });
});

describe('exceedsDisableLimit', () => {
  it('stops above the absolute limit or above half of the active users', () => {
    expect(exceedsDisableLimit(0, 0, 10)).toBe(false);
    expect(exceedsDisableLimit(10, 100, 10)).toBe(false);
    expect(exceedsDisableLimit(11, 100, 10)).toBe(true);
    expect(exceedsDisableLimit(2, 4, 10)).toBe(false);
    expect(exceedsDisableLimit(2, 3, 10)).toBe(true);
    expect(exceedsDisableLimit(1, 1, 10)).toBe(true);
    expect(exceedsDisableLimit(1, 100, 0)).toBe(true);
  });
});

describe('buildInclude', () => {
  it('adds wanted emails, drops emails MailExpert wrote and no longer wants, keeps everything else', () => {
    const current = policy([group, domain('example.org'), email('foreign@example.net'), email('old@example.com'), email('keep@example.com')]);
    const result = buildInclude({ policy: current, baseline: ['old@example.com', 'keep@example.com'], desired: ['keep@example.com', 'new@example.com'] });
    expect(result.include).toEqual([
      group, domain('example.org'), email('foreign@example.net'), email('keep@example.com'), email('new@example.com'),
    ]);
    expect(result).toMatchObject({ changed: true, added: ['new@example.com'], removed: ['old@example.com'] });
  });

  it('reports no change when the policy already lists exactly the wanted emails', () => {
    const current = policy([email('Keep@example.com'), domain('example.org')]);
    expect(buildInclude({ policy: current, baseline: ['keep@example.com'], desired: ['keep@example.com'] }))
      .toMatchObject({ changed: false, added: [], removed: [] });
  });

  it('takes over a wanted email someone listed by hand without duplicating it', () => {
    const current = policy([email('Person@example.com')]);
    const result = buildInclude({ policy: current, baseline: [], desired: ['person@example.com'] });
    expect(result.include).toEqual([email('person@example.com')]);
    expect(result.changed).toBe(false);
  });

  it('leaves a foreign email that MailExpert never wrote even when no user has it', () => {
    const current = policy([email('contractor@example.net'), email('gone@example.com')]);
    const result = buildInclude({ policy: current, baseline: ['gone@example.com'], desired: ['a@example.com'] });
    expect(result.include).toEqual([email('contractor@example.net'), email('a@example.com')]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bt src/services/accessSync/reconcile.test.js`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Implement**

`backend/src/services/accessSync/reconcile.js`:

```js
// Three-way reconcile of an Access policy's include list with MailExpert's active users. The
// baseline is the set of emails MailExpert itself wrote last time: only those are MailExpert's to
// remove, and one missing from Cloudflare means someone removed it there. Every other rule —
// foreign emails, groups, email domains — is left exactly as it is.

const lower = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const ruleEmail = (rule) => lower(rule?.email?.email);
const ruleDomain = (rule) => lower(rule?.email_domain?.domain);
const isEmailRule = (rule) => !!ruleEmail(rule);

// Whether an email_domain rule of the policy still lets an email in.
export function domainAdmits(policy) {
  const domains = new Set((policy.include ?? []).map(ruleDomain).filter(Boolean));
  const excludedEmails = new Set((policy.exclude ?? []).map(ruleEmail).filter(Boolean));
  const excludedDomains = new Set((policy.exclude ?? []).map(ruleDomain).filter(Boolean));
  return (email) => {
    const at = email.slice(email.lastIndexOf('@') + 1);
    return domains.has(at) && !excludedEmails.has(email) && !excludedDomains.has(at);
  };
}

// Active users whose email MailExpert wrote but Cloudflare no longer lists or admits.
export function removedInCloudflare({ policy, baseline, activeEmails, pinned }) {
  const listed = new Set((policy.include ?? []).map(ruleEmail).filter(Boolean));
  // A policy without a single email looks wiped or misread, not like a decision about each user.
  if (listed.size === 0) return [];
  const active = new Set(activeEmails);
  const admits = domainAdmits(policy);
  return [...new Set(baseline)]
    .filter((email) => active.has(email) && !listed.has(email) && !pinned.has(email) && !admits(email))
    .sort();
}

// Whether a run would disable too many users to trust it.
export function exceedsDisableLimit(count, activeCount, maxDisables) {
  return count > 0 && (count > maxDisables || count * 2 > activeCount);
}

export function buildInclude({ policy, baseline, desired }) {
  const current = policy.include ?? [];
  const owned = new Set(baseline);
  const wanted = [...new Set(desired)].sort();
  const wantedSet = new Set(wanted);
  const listed = new Set(current.map(ruleEmail).filter(Boolean));

  const kept = current.filter((rule) => {
    if (!isEmailRule(rule)) return true;
    const email = ruleEmail(rule);
    return !owned.has(email) && !wantedSet.has(email);
  });
  const include = [...kept, ...wanted.map((email) => ({ email: { email } }))];
  const added = wanted.filter((email) => !listed.has(email));
  const removed = [...listed].filter((email) => owned.has(email) && !wantedSet.has(email)).sort();
  return { include, changed: added.length > 0 || removed.length > 0, added, removed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bt src/services/accessSync/reconcile.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/accessSync/reconcile.js backend/src/services/accessSync/reconcile.test.js
git commit -m "feat(access-sync): reconcile the policy include list with approved users"
```

---
### Task 5: Настройки и состояние синхронизации

**Files:**
- Create: `backend/src/services/accessSync/settings.js`
- Test: `backend/src/services/accessSync/settings.test.js`

**Interfaces:**
- Consumes: `encrypt`, `decrypt` из `services/encryption.js`; `UUID_RE` из `utils/uuid.js`.
- Produces:
  - `ACCESS_SYNC_CONFIG_KEY = 'access_sync_config'`, `ACCESS_SYNC_STATE_KEY = 'access_sync_state'`, `DEFAULT_MAX_DISABLES = 10`;
  - `class AccessSyncConfigError extends Error` с `code: 'invalid_field' | 'invalid_id' | 'incomplete'`;
  - `accessSyncMaxDisables(env = process.env): number`;
  - `loadStoredConfig(): Promise<{ enabled, accountId, appId, policyId, apiToken: string | null }>` — токен зашифрован;
  - `publicConfig(stored): { enabled, accountId, appId, policyId, apiTokenSet: boolean }`;
  - `loadRunConfig(): Promise<null | { accountId, appId, policyId, apiToken: string | null }>` — `null`, если выключено или не заполнено; `apiToken: null`, если токен не расшифровался;
  - `saveConfig(input): Promise<storedConfig>`;
  - `loadState(): Promise<{ baseline: string[], abortedCandidates: string[] | null, lastRun: object | null }>`;
  - `saveState(state): Promise`.

- [ ] **Step 1: Write the failing test**

`backend/src/services/accessSync/settings.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../encryption.js', () => ({
  encrypt: vi.fn((value) => `enc:${value}`),
  decrypt: vi.fn((value) => (value.startsWith('enc:') ? value.slice(4) : null)),
}));

import { query } from '../db.js';
import {
  ACCESS_SYNC_CONFIG_KEY, ACCESS_SYNC_STATE_KEY, accessSyncMaxDisables, loadRunConfig, loadState,
  loadStoredConfig, publicConfig, saveConfig, saveState,
} from './settings.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';
const OTHER_POLICY = '66666666-7777-4888-9999-000000000001';
const full = { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'tok-secret' };

// system_settings as a map, reached only through the two statements the module may use.
let store;
beforeEach(() => {
  store = new Map();
  query.mockReset();
  query.mockImplementation(async (sql, params) => {
    if (/^SELECT value FROM system_settings WHERE key = \$1$/.test(sql)) {
      return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
    }
    if (/^INSERT INTO system_settings \(key, value, updated_at\) VALUES \(\$1, \$2, NOW\(\)\)\s+ON CONFLICT \(key\) DO UPDATE SET value = \$2, updated_at = NOW\(\)$/.test(sql)) {
      store.set(params[0], params[1]);
      return { rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
});
const stored = (key) => JSON.parse(store.get(key));

describe('accessSyncMaxDisables', () => {
  it('reads a non-negative integer and falls back to 10', () => {
    expect(accessSyncMaxDisables({})).toBe(10);
    expect(accessSyncMaxDisables({ ACCESS_SYNC_MAX_DISABLES: ' 3 ' })).toBe(3);
    expect(accessSyncMaxDisables({ ACCESS_SYNC_MAX_DISABLES: '0' })).toBe(0);
    expect(accessSyncMaxDisables({ ACCESS_SYNC_MAX_DISABLES: '-1' })).toBe(10);
    expect(accessSyncMaxDisables({ ACCESS_SYNC_MAX_DISABLES: 'many' })).toBe(10);
  });
});

describe('settings', () => {
  it('starts off, with no token and no state', async () => {
    const config = await loadStoredConfig();
    expect(publicConfig(config)).toEqual({ enabled: false, accountId: '', appId: '', policyId: '', apiTokenSet: false });
    expect(await loadRunConfig()).toBeNull();
    expect(await loadState()).toEqual({ baseline: [], abortedCandidates: null, lastRun: null });
  });

  it('stores the token encrypted and never shows it', async () => {
    await saveConfig({ ...full, accountId: ACCOUNT.toUpperCase() });
    expect(stored(ACCESS_SYNC_CONFIG_KEY)).toEqual({ ...full, apiToken: 'enc:tok-secret' });
    const shown = publicConfig(await loadStoredConfig());
    expect(shown).toEqual({ enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiTokenSet: true });
    expect(JSON.stringify(shown)).not.toContain('tok-secret');
    expect(await loadRunConfig()).toEqual({ accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'tok-secret' });
  });

  it('keeps the stored token when the field is blank and replaces it when a new one is given', async () => {
    await saveConfig(full);
    await saveConfig({ ...full, apiToken: '  ' });
    expect(stored(ACCESS_SYNC_CONFIG_KEY).apiToken).toBe('enc:tok-secret');
    await saveConfig({ ...full, apiToken: 'tok-new' });
    expect(stored(ACCESS_SYNC_CONFIG_KEY).apiToken).toBe('enc:tok-new');
  });

  it('refuses malformed or incomplete settings and saves incomplete ones while off', async () => {
    await expect(saveConfig({ ...full, enabled: 'yes' })).rejects.toMatchObject({ code: 'invalid_field' });
    await expect(saveConfig({ ...full, accountId: 'not-an-id' })).rejects.toMatchObject({ code: 'invalid_id' });
    await expect(saveConfig({ ...full, policyId: '1234' })).rejects.toMatchObject({ code: 'invalid_id' });
    await expect(saveConfig({ ...full, apiToken: '' })).rejects.toMatchObject({ code: 'incomplete' });
    expect(store.size).toBe(0);
    await saveConfig({ enabled: false, accountId: ACCOUNT });
    expect(await loadRunConfig()).toBeNull();
  });

  it('forgets the baseline when the sync points at another policy', async () => {
    await saveConfig(full);
    await saveState({ baseline: ['a@example.com'], abortedCandidates: ['b@example.com'], lastRun: { outcome: 'updated' } });
    await saveConfig({ ...full, apiToken: '' });
    expect(stored(ACCESS_SYNC_STATE_KEY).baseline).toEqual(['a@example.com']);
    await saveConfig({ ...full, apiToken: '', policyId: OTHER_POLICY });
    expect(stored(ACCESS_SYNC_STATE_KEY)).toEqual({ baseline: [], abortedCandidates: null, lastRun: { outcome: 'updated' } });
  });

  it('hands a run a null token it cannot decrypt, and survives a corrupt state', async () => {
    store.set(ACCESS_SYNC_CONFIG_KEY, JSON.stringify({ ...full, apiToken: 'garbage' }));
    expect(await loadRunConfig()).toEqual({ accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: null });
    store.set(ACCESS_SYNC_STATE_KEY, 'not json');
    expect(await loadState()).toEqual({ baseline: [], abortedCandidates: null, lastRun: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bt src/services/accessSync/settings.test.js`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Implement**

`backend/src/services/accessSync/settings.js`:

```js
import { query } from '../db.js';
import { decrypt, encrypt } from '../encryption.js';
import { UUID_RE } from '../../utils/uuid.js';

// Cloudflare Access sync settings and the state between runs, stored in system_settings. The API
// token is stored encrypted and only ever written: nothing here returns it to a client.
export const ACCESS_SYNC_CONFIG_KEY = 'access_sync_config';
export const ACCESS_SYNC_STATE_KEY = 'access_sync_state';
export const DEFAULT_MAX_DISABLES = 10;

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const EMPTY_CONFIG = Object.freeze({ enabled: false, accountId: '', appId: '', policyId: '', apiToken: null });

export class AccessSyncConfigError extends Error {
  constructor(code) {
    super(`Invalid Access sync settings: ${code}`);
    this.name = 'AccessSyncConfigError';
    this.code = code;
  }
}

// ACCESS_SYNC_MAX_DISABLES: the most users one run may disable. 0 stops every run that would
// disable anyone.
export function accessSyncMaxDisables(env = process.env) {
  const raw = String(env.ACCESS_SYNC_MAX_DISABLES ?? '').trim();
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_DISABLES;
}

async function readJson(key) {
  const { rows } = await query('SELECT value FROM system_settings WHERE key = $1', [key]);
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return null;
  }
}

async function writeJson(key, value) {
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

export async function loadStoredConfig() {
  const stored = await readJson(ACCESS_SYNC_CONFIG_KEY);
  return { ...EMPTY_CONFIG, ...(stored && typeof stored === 'object' ? stored : {}) };
}

// What the admin screen sees: whether a token is stored, never the token.
export function publicConfig(stored) {
  return {
    enabled: !!stored.enabled,
    accountId: stored.accountId,
    appId: stored.appId,
    policyId: stored.policyId,
    apiTokenSet: !!stored.apiToken,
  };
}

// Settings a run can use, or null while the sync is off or not filled in. A token that no longer
// decrypts (a changed ENCRYPTION_KEY) comes back as null so the run can report it.
export async function loadRunConfig() {
  const stored = await loadStoredConfig();
  if (!stored.enabled || !stored.accountId || !stored.appId || !stored.policyId || !stored.apiToken) return null;
  return {
    accountId: stored.accountId,
    appId: stored.appId,
    policyId: stored.policyId,
    apiToken: decrypt(stored.apiToken),
  };
}

export async function loadState() {
  const stored = await readJson(ACCESS_SYNC_STATE_KEY);
  return {
    baseline: Array.isArray(stored?.baseline) ? stored.baseline.filter((email) => typeof email === 'string') : [],
    abortedCandidates: Array.isArray(stored?.abortedCandidates) ? stored.abortedCandidates : null,
    lastRun: stored?.lastRun && typeof stored.lastRun === 'object' ? stored.lastRun : null,
  };
}

export function saveState(state) {
  return writeJson(ACCESS_SYNC_STATE_KEY, state);
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

// Saves settings from the admin screen. A blank token keeps the stored one. Pointing the sync at
// another account, application or policy forgets the baseline: the emails written to the old
// policy would otherwise look removed from the new one and disable their users.
export async function saveConfig(input) {
  if (typeof input?.enabled !== 'boolean') throw new AccessSyncConfigError('invalid_field');
  const stored = await loadStoredConfig();
  const next = {
    enabled: input.enabled,
    accountId: text(input.accountId).toLowerCase(),
    appId: text(input.appId).toLowerCase(),
    policyId: text(input.policyId).toLowerCase(),
    apiToken: stored.apiToken,
  };
  if ((next.accountId && !ACCOUNT_ID_RE.test(next.accountId))
    || (next.appId && !UUID_RE.test(next.appId))
    || (next.policyId && !UUID_RE.test(next.policyId))) {
    throw new AccessSyncConfigError('invalid_id');
  }
  const token = text(input.apiToken);
  if (next.enabled && !(next.accountId && next.appId && next.policyId && (token || next.apiToken))) {
    throw new AccessSyncConfigError('incomplete');
  }
  if (token) next.apiToken = encrypt(token);

  await writeJson(ACCESS_SYNC_CONFIG_KEY, next);
  if (next.accountId !== stored.accountId || next.appId !== stored.appId || next.policyId !== stored.policyId) {
    await saveState({ ...(await loadState()), baseline: [], abortedCandidates: null });
  }
  return next;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bt src/services/accessSync/settings.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/accessSync/settings.js backend/src/services/accessSync/settings.test.js
git commit -m "feat(access-sync): store sync settings with an encrypted token"
```

---

### Task 6: Прогон синхронизации

**Files:**
- Create: `backend/src/services/accessSync/runner.js`
- Test: `backend/src/services/accessSync/runner.test.js`

**Interfaces:**
- Consumes: `recordAudit` (Task 1, поле `actorEmail`); `disableUsersByEmail` (Task 2); `createCloudflareAccessClient`, `CloudflareAccessError` (Task 3); `removedInCloudflare`, `exceedsDisableLimit`, `buildInclude` (Task 4); `loadRunConfig`, `loadState`, `saveState`, `accessSyncMaxDisables` (Task 5).
- Produces:
  - `ACCESS_SYNC_ACTOR = 'Cloudflare Access'`;
  - `runAccessSync({ trigger, signOutUser, createClient?, settings?, env?, now? }): Promise<result>`:
    - без прогона: `{ outcome: 'not_google_mode' }` или `{ outcome: 'not_configured' }`, состояние не пишется;
    - иначе возвращает и сохраняет в `state.lastRun` запись `{ trigger, startedAt, finishedAt, outcome, added, removed, disabled, wouldDisable, error }`, где `outcome` — `'updated' | 'unchanged' | 'aborted' | 'empty' | 'failed'`, `error` — `null`, `'token_unreadable'`, `'policy_not_allow'`, `'internal_error'` или текст `CloudflareAccessError`.

- [ ] **Step 1: Write the failing test**

`backend/src/services/accessSync/runner.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../auth/userStatus.js', () => ({ disableUsersByEmail: vi.fn() }));
vi.mock('./settings.js', () => ({
  loadRunConfig: vi.fn(), loadState: vi.fn(), saveState: vi.fn(), accessSyncMaxDisables: vi.fn(),
}));

import { query, withTransaction } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { disableUsersByEmail } from '../auth/userStatus.js';
import { accessSyncMaxDisables, loadRunConfig, loadState, saveState } from './settings.js';
import { CloudflareAccessError } from './cloudflareAccessClient.js';
import { runAccessSync } from './runner.js';

const CONFIG = { accountId: 'acc', appId: 'app', policyId: 'pol', apiToken: 'tok' };
const NOW = '2026-09-17T10:00:00.000Z';
const email = (address) => ({ email: { email: address } });
const group = { group: { id: 'g-1' } };
const policyWith = (include, extra = {}) => ({ id: 'pol', name: 'Allow', decision: 'allow', include, exclude: [], require: [], ...extra });

let cf;
let signOutUser;
let createClient;
const cloudflare = (policy) => {
  cf = { getPolicy: vi.fn(async () => structuredClone(policy)), updatePolicy: vi.fn(async () => ({})) };
};
const state = (baseline, abortedCandidates = null) => loadState.mockResolvedValue({ baseline, abortedCandidates, lastRun: null });
const activeUsers = (...emails) => query.mockResolvedValue({ rows: emails.map((address) => ({ email: address })) });
const run = (options = {}) => runAccessSync({
  trigger: 'test', signOutUser, createClient, settings: { mode: 'google', bootstrapAdminEmails: new Set() },
  env: {}, now: () => new Date(NOW), ...options,
});
const saved = () => saveState.mock.calls.at(-1)[0];
const lastRun = (fields) => ({
  trigger: 'test', startedAt: NOW, finishedAt: NOW, added: 0, removed: 0, disabled: 0, wouldDisable: 0, error: null, ...fields,
});

beforeEach(() => {
  vi.clearAllMocks();
  loadRunConfig.mockResolvedValue(CONFIG);
  state([]);
  saveState.mockResolvedValue(undefined);
  accessSyncMaxDisables.mockReturnValue(10);
  withTransaction.mockImplementation(async (fn) => fn('tx'));
  disableUsersByEmail.mockResolvedValue({ disabled: [], keptLastAdmin: [] });
  signOutUser = vi.fn(async () => {});
  createClient = vi.fn(() => cf);
});

describe('runAccessSync', () => {
  it('does nothing outside google mode or without complete settings', async () => {
    expect(await run({ settings: { mode: 'local', bootstrapAdminEmails: new Set() } })).toEqual({ outcome: 'not_google_mode' });
    loadRunConfig.mockResolvedValue(null);
    expect(await run()).toEqual({ outcome: 'not_configured' });
    expect(createClient).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('adds approved users, keeps rules it does not own and remembers what it wrote', async () => {
    cloudflare(policyWith([group, email('contractor@example.net')]));
    activeUsers('b@example.com', 'a@example.com');
    const result = await run();
    expect(createClient).toHaveBeenCalledWith(CONFIG);
    expect(cf.updatePolicy).toHaveBeenCalledWith(policyWith([group, email('contractor@example.net'), email('a@example.com'), email('b@example.com')]));
    expect(result).toEqual(lastRun({ outcome: 'updated', added: 2 }));
    expect(saved()).toEqual({ baseline: ['a@example.com', 'b@example.com'], abortedCandidates: null, lastRun: result });
    expect(query.mock.calls[0][0]).toBe('SELECT email FROM users WHERE disabled_at IS NULL AND email IS NOT NULL');
  });

  it('writes nothing when the policy is already in line', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com']);
    activeUsers('a@example.com');
    expect(await run()).toEqual(lastRun({ outcome: 'unchanged' }));
    expect(cf.updatePolicy).not.toHaveBeenCalled();
  });

  it('removes emails it wrote for users who are no longer active', async () => {
    cloudflare(policyWith([email('a@example.com'), email('b@example.com')]));
    state(['a@example.com', 'b@example.com']);
    activeUsers('a@example.com');
    expect(await run()).toEqual(lastRun({ outcome: 'updated', removed: 1 }));
    expect(cf.updatePolicy.mock.calls[0][0].include).toEqual([email('a@example.com')]);
    expect(saved().baseline).toEqual(['a@example.com']);
  });

  it('disables a user removed in Cloudflare, signs them out and journals it', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com', 'b@example.com']);
    activeUsers('a@example.com', 'b@example.com');
    disableUsersByEmail.mockResolvedValue({ disabled: [{ id: 'u-b', email: 'b@example.com', is_admin: false }], keptLastAdmin: [] });
    expect(await run()).toEqual(lastRun({ outcome: 'unchanged', disabled: 1 }));
    expect(disableUsersByEmail).toHaveBeenCalledWith('tx', ['b@example.com'], { googleMode: true, bootstrapAdminEmails: new Set() });
    expect(signOutUser).toHaveBeenCalledWith('u-b');
    expect(recordAudit).toHaveBeenCalledWith([{
      actorEmail: 'Cloudflare Access', action: 'user.disabled',
      details: { userId: 'u-b', email: 'b@example.com', isAdmin: false, source: 'cloudflare_access' },
    }]);
    expect(saved().baseline).toEqual(['a@example.com']);
  });

  it('puts back the last admin that Cloudflare removed', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com', 'admin@example.com']);
    activeUsers('a@example.com', 'admin@example.com');
    disableUsersByEmail.mockResolvedValue({ disabled: [], keptLastAdmin: ['admin@example.com'] });
    expect(await run()).toEqual(lastRun({ outcome: 'updated', added: 1 }));
    expect(cf.updatePolicy.mock.calls[0][0].include).toEqual([email('a@example.com'), email('admin@example.com')]);
    expect(signOutUser).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('stops above the limit without changing anything and journals each new set of users once', async () => {
    accessSyncMaxDisables.mockReturnValue(1);
    cloudflare(policyWith([email('a@example.com')]));
    const baseline = ['a@example.com', 'b@example.com', 'c@example.com'];
    state(baseline);
    activeUsers('a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com');
    expect(await run()).toEqual(lastRun({ outcome: 'aborted', wouldDisable: 2 }));
    expect(disableUsersByEmail).not.toHaveBeenCalled();
    expect(cf.updatePolicy).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith({
      actorEmail: 'Cloudflare Access', action: 'access.sync_aborted',
      details: { candidates: ['b@example.com', 'c@example.com'], activeUsers: 5, maxDisables: 1 },
    });
    expect(saved()).toMatchObject({ baseline, abortedCandidates: ['b@example.com', 'c@example.com'] });

    recordAudit.mockClear();
    state(baseline, ['b@example.com', 'c@example.com']);
    await run();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('never removes or disables a bootstrap admin and lists one without a user', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com', 'boot@example.com']);
    activeUsers('a@example.com', 'boot@example.com');
    await run({ settings: { mode: 'google', bootstrapAdminEmails: new Set(['boot@example.com', 'later@example.com']) } });
    expect(disableUsersByEmail).not.toHaveBeenCalled();
    expect(cf.updatePolicy.mock.calls[0][0].include).toEqual([
      email('a@example.com'), email('boot@example.com'), email('later@example.com'),
    ]);
  });

  it('never writes an empty include list', async () => {
    cloudflare(policyWith([email('a@example.com')]));
    state(['a@example.com']);
    activeUsers();
    expect(await run()).toEqual(lastRun({ outcome: 'empty' }));
    expect(cf.updatePolicy).not.toHaveBeenCalled();
    expect(saved().baseline).toEqual(['a@example.com']);

    cloudflare(policyWith([email('contractor@example.net'), email('a@example.com')]));
    expect(await run()).toEqual(lastRun({ outcome: 'updated', removed: 1 }));
    expect(cf.updatePolicy.mock.calls[0][0].include).toEqual([email('contractor@example.net')]);
  });

  it('refuses to write a policy that is not an Allow policy', async () => {
    cloudflare(policyWith([email('a@example.com')], { decision: 'bypass' }));
    activeUsers('a@example.com');
    expect(await run()).toEqual(lastRun({ outcome: 'failed', error: 'policy_not_allow' }));
    expect(cf.updatePolicy).not.toHaveBeenCalled();
  });

  it('reports a Cloudflare failure and keeps the baseline', async () => {
    cloudflare(policyWith([]));
    cf.getPolicy.mockRejectedValue(new CloudflareAccessError('getPolicy', 403, [10000]));
    state(['a@example.com']);
    expect(await run()).toEqual(lastRun({ outcome: 'failed', error: 'Cloudflare getPolicy failed (403): error 10000' }));
    expect(saved().baseline).toEqual(['a@example.com']);
  });

  it('reports an unexpected error without its message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare(policyWith([]));
    query.mockRejectedValue(Object.assign(new Error('boom near a@example.com'), { code: '57P01' }));
    expect(await run()).toEqual(lastRun({ outcome: 'failed', error: 'internal_error' }));
    expect(errorSpy).toHaveBeenCalledWith('[access-sync] Run failed:', '57P01');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('a@example.com');
    errorSpy.mockRestore();
  });

  it('reports a token that no longer decrypts without calling Cloudflare', async () => {
    loadRunConfig.mockResolvedValue({ ...CONFIG, apiToken: null });
    expect(await run()).toEqual(lastRun({ outcome: 'failed', error: 'token_unreadable' }));
    expect(createClient).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bt src/services/accessSync/runner.test.js`
Expected: FAIL — модуль `./runner.js` не найден.

- [ ] **Step 3: Implement**

`backend/src/services/accessSync/runner.js`:

```js
import { query, withTransaction } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { getAuthSettings } from '../auth/authSettings.js';
import { disableUsersByEmail } from '../auth/userStatus.js';
import { CloudflareAccessError, createCloudflareAccessClient } from './cloudflareAccessClient.js';
import { buildInclude, exceedsDisableLimit, removedInCloudflare } from './reconcile.js';
import { accessSyncMaxDisables, loadRunConfig, loadState, saveState } from './settings.js';

// The name the audit log shows for changes the sync makes on its own.
export const ACCESS_SYNC_ACTOR = 'Cloudflare Access';

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);

// One reconcile of the Access policy with MailExpert's active users (see reconcile.js). Every run
// that reaches Cloudflare leaves its result in state.lastRun for the admin screen.
export async function runAccessSync({
  trigger,
  signOutUser,
  createClient = createCloudflareAccessClient,
  settings = getAuthSettings(),
  env = process.env,
  now = () => new Date(),
}) {
  if (settings.mode !== 'google') return { outcome: 'not_google_mode' };
  const config = await loadRunConfig();
  if (!config) return { outcome: 'not_configured' };
  const state = await loadState();
  const startedAt = now().toISOString();

  const finish = async (result, statePatch = {}) => {
    const lastRun = {
      trigger, startedAt, finishedAt: now().toISOString(),
      added: 0, removed: 0, disabled: 0, wouldDisable: 0, error: null, ...result,
    };
    await saveState({ ...state, ...statePatch, lastRun });
    return lastRun;
  };

  try {
    if (!config.apiToken) return await finish({ outcome: 'failed', error: 'token_unreadable' });
    const client = createClient(config);
    const policy = await client.getPolicy(config.policyId);
    if (policy?.decision !== 'allow') return await finish({ outcome: 'failed', error: 'policy_not_allow' });

    const pinned = settings.bootstrapAdminEmails;
    const { rows } = await query('SELECT email FROM users WHERE disabled_at IS NULL AND email IS NOT NULL');
    const activeEmails = rows.map((row) => row.email.toLowerCase());

    const candidates = removedInCloudflare({ policy, baseline: state.baseline, activeEmails, pinned });
    const maxDisables = accessSyncMaxDisables(env);
    if (exceedsDisableLimit(candidates.length, activeEmails.length, maxDisables)) {
      if (!sameList(state.abortedCandidates, candidates)) {
        recordAudit({
          actorEmail: ACCESS_SYNC_ACTOR, action: 'access.sync_aborted',
          details: { candidates, activeUsers: activeEmails.length, maxDisables },
        });
      }
      return await finish({ outcome: 'aborted', wouldDisable: candidates.length }, { abortedCandidates: candidates });
    }

    const { disabled } = candidates.length
      ? await withTransaction((tx) => disableUsersByEmail(tx, candidates, { googleMode: true, bootstrapAdminEmails: pinned }))
      : { disabled: [] };
    for (const user of disabled) await signOutUser(user.id);
    if (disabled.length) {
      recordAudit(disabled.map((user) => ({
        actorEmail: ACCESS_SYNC_ACTOR, action: 'user.disabled',
        details: { userId: user.id, email: user.email, isAdmin: !!user.is_admin, source: 'cloudflare_access' },
      })));
    }

    const turnedOff = new Set(disabled.map((user) => user.email.toLowerCase()));
    const desired = [...new Set([...activeEmails.filter((address) => !turnedOff.has(address)), ...pinned])].sort();
    const { include, changed, added, removed } = buildInclude({ policy, baseline: state.baseline, desired });
    if (include.length === 0) {
      return await finish({ outcome: 'empty', disabled: disabled.length }, { abortedCandidates: null });
    }
    if (changed) await client.updatePolicy({ ...policy, include });
    return await finish(
      { outcome: changed ? 'updated' : 'unchanged', added: added.length, removed: removed.length, disabled: disabled.length },
      { baseline: desired, abortedCandidates: null },
    );
  } catch (err) {
    if (err instanceof CloudflareAccessError) return finish({ outcome: 'failed', error: err.message });
    console.error('[access-sync] Run failed:', err?.code || err?.name || 'Error');
    return finish({ outcome: 'failed', error: 'internal_error' });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bt src/services/accessSync/runner.test.js src/sharedData.guard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/accessSync/runner.js backend/src/services/accessSync/runner.test.js
git commit -m "feat(access-sync): run the reconcile against the Access policy"
```

---

### Task 7: Один исполнитель, запуск раз в час и при старте сервера

**Files:**
- Create: `backend/src/services/accessSync/scheduler.js`
- Test: `backend/src/services/accessSync/scheduler.test.js`
- Create: `backend/src/services/accessSync/index.js`
- Modify: `backend/src/index.js` (импорты; запуск после `imapManager.startSnoozeWatcher();`)
- Modify: `.env.example` (раздел «Sign-in mode», после `# BOOTSTRAP_ADMIN_EMAILS=`)

**Interfaces:**
- Consumes: `runAccessSync` (Task 6).
- Produces:
  - `createAccessSyncScheduler({ run, debounceMs = 10_000, intervalMs = 3_600_000 })` → `{ start(), stop(), request(trigger), runNow(trigger = 'manual'): Promise<result>, exclusive(op): Promise }`;
  - `services/accessSync/index.js`: `startAccessSync({ signOutUser })`, `requestAccessSync(trigger)`, `runAccessSyncNow(): Promise<result>`, `withAccessSyncLock(op): Promise`.

- [ ] **Step 1: Write the failing test**

`backend/src/services/accessSync/scheduler.test.js`:

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccessSyncScheduler } from './scheduler.js';

const DEBOUNCE = 1_000;
const INTERVAL = 60_000;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const instantRun = () => vi.fn(async (trigger) => ({ outcome: 'unchanged', trigger }));

// Runs that stay in progress until the test finishes them.
function heldRuns() {
  const pending = [];
  const run = vi.fn((trigger) => new Promise((resolve) => { pending.push(() => resolve({ outcome: 'unchanged', trigger })); }));
  const finish = async () => {
    pending.shift()();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { run, finish };
}

const scheduler = (run) => createAccessSyncScheduler({ run, debounceMs: DEBOUNCE, intervalMs: INTERVAL });

describe('access sync scheduler', () => {
  it('ignores requests until started, then runs shortly after start and every interval', async () => {
    const run = instantRun();
    const s = scheduler(run);
    s.request('user_added');
    await vi.advanceTimersByTimeAsync(5 * DEBOUNCE);
    expect(run).not.toHaveBeenCalled();

    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.mock.calls).toEqual([['startup']]);

    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(run.mock.calls).toEqual([['startup'], ['schedule'], ['schedule']]);
    s.stop();
  });

  it('merges a burst of requests into one run', async () => {
    const run = instantRun();
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    s.request('a');
    await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
    s.request('b');
    s.request('c');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(run.mock.calls).toEqual([['startup'], ['c']]);
    s.stop();
  });

  it('runs once more after a run when asked during it, however often', async () => {
    const { run, finish } = heldRuns();
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    s.request('user_added');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    s.request('user_changed');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(run).toHaveBeenCalledTimes(1);

    await finish();
    expect(run.mock.calls).toEqual([['startup'], ['user_added']]);
    await finish();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('runs now on demand, joining a run that has not started, even when not started', async () => {
    const { run, finish } = heldRuns();
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const first = s.runNow();
    const second = s.runNow();
    expect(second).toBe(first);
    await finish();
    await finish();
    expect(await first).toEqual({ outcome: 'unchanged', trigger: 'manual' });
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();

    const idle = scheduler(instantRun());
    expect(await idle.runNow()).toEqual({ outcome: 'unchanged', trigger: 'manual' });
  });

  it('never lets a settings change overlap a run', async () => {
    const { run, finish } = heldRuns();
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const order = [];
    const saved = s.exclusive(async () => { order.push('save'); });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);
    await finish();
    await saved;
    expect(order).toEqual(['save']);
    s.stop();
  });

  it('keeps going after a failed run and logs only the error code', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('failed for a@example.com'), { code: 'ECONNREFUSED' }))
      .mockResolvedValue({ outcome: 'unchanged' });
    const s = scheduler(run);
    s.start();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(errorSpy).toHaveBeenCalledWith('[access-sync] Run failed:', 'ECONNREFUSED');
    s.request('user_added');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();
    errorSpy.mockRestore();
  });

  it('stops every timer', async () => {
    const run = instantRun();
    const s = scheduler(run);
    s.start();
    s.stop();
    s.request('user_added');
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bt src/services/accessSync/scheduler.test.js`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Implement the scheduler and the process-wide instance**

`backend/src/services/accessSync/scheduler.js`:

```js
// Runs the Access sync one at a time in this process: user changes request a run, which waits a
// few seconds so a burst of changes becomes one run; a full reconcile runs every hour. MailExpert
// runs as a single backend container, so an in-process queue is enough.
export const DEBOUNCE_MS = 10_000;
export const INTERVAL_MS = 60 * 60_000;

const logFailure = (err) => console.error('[access-sync] Run failed:', err?.code || err?.name || 'Error');

export function createAccessSyncScheduler({ run, debounceMs = DEBOUNCE_MS, intervalMs = INTERVAL_MS }) {
  let tail = Promise.resolve();
  let queuedRun = null;
  let debounceTimer = null;
  let intervalTimer = null;

  // Runs op after everything queued before it, so runs and settings changes never overlap.
  function exclusive(op) {
    const result = tail.then(() => op());
    tail = result.then(() => {}, () => {});
    return result;
  }

  // A run that has not started yet serves every later request: it reads the users when it starts.
  function queueRun(trigger) {
    if (!queuedRun) {
      queuedRun = exclusive(() => {
        queuedRun = null;
        return run(trigger);
      });
    }
    return queuedRun;
  }

  function request(trigger) {
    if (!intervalTimer) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      queueRun(trigger).catch(logFailure);
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function start() {
    if (intervalTimer) return;
    intervalTimer = setInterval(() => { queueRun('schedule').catch(logFailure); }, intervalMs);
    intervalTimer.unref?.();
    request('startup');
  }

  function stop() {
    clearInterval(intervalTimer);
    clearTimeout(debounceTimer);
    intervalTimer = null;
    debounceTimer = null;
  }

  function runNow(trigger = 'manual') {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    return queueRun(trigger);
  }

  return { start, stop, request, runNow, exclusive };
}
```

`backend/src/services/accessSync/index.js`:

```js
import { runAccessSync } from './runner.js';
import { createAccessSyncScheduler } from './scheduler.js';

// The process-wide Access sync. Requests before startAccessSync are ignored: only google mode
// starts it. A manual run works either way and reports why it did nothing.
let signOutUser = async () => {};
const scheduler = createAccessSyncScheduler({ run: (trigger) => runAccessSync({ trigger, signOutUser }) });

// signOutUser ends the sessions and sockets of a user the sync disabled.
export function startAccessSync(options) {
  signOutUser = options.signOutUser;
  scheduler.start();
}

export const requestAccessSync = (trigger) => scheduler.request(trigger);
export const runAccessSyncNow = () => scheduler.runNow('manual');
export const withAccessSyncLock = (op) => scheduler.exclusive(op);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bt src/services/accessSync/scheduler.test.js`
Expected: PASS.

- [ ] **Step 5: Start the sync with the server**

Сначала проверить, какие имена уже импортированы: `grep -n "destroyUserSessions\|closeUserSockets\|getAuthSettings" backend/src/index.js`. Не дублировать импорт, который уже есть.

В `backend/src/index.js`:

1. Заменить `import authRoutes from './routes/auth.js';` на:

```js
import authRoutes, { destroyUserSessions } from './routes/auth.js';
```

2. Заменить `import { setupWebSocket } from './services/websocket.js';` на:

```js
import { closeUserSockets, setupWebSocket } from './services/websocket.js';
```

3. Заменить `import { authSettingsError } from './services/auth/authSettings.js';` на:

```js
import { authSettingsError, getAuthSettings } from './services/auth/authSettings.js';
import { startAccessSync } from './services/accessSync/index.js';
```

4. После строки `imapManager.startSnoozeWatcher();` добавить:

```js

// Keep the Cloudflare Access policy in line with approved users; only google mode approves users.
if (getAuthSettings().mode === 'google') {
  startAccessSync({
    signOutUser: async (userId) => {
      await destroyUserSessions(userId);
      closeUserSockets(wss, userId);
    },
  });
}
```

- [ ] **Step 6: Document the settings**

В `.env.example` после строки `# BOOTSTRAP_ADMIN_EMAILS=` добавить:

```
#
# Cloudflare Access policy sync is set up in Admin → Users → Access policy sync. A run that
# would disable more users than this, or more than half of the active users, stops and writes
# the audit log. 0 stops every run that would disable anyone.
# ACCESS_SYNC_MAX_DISABLES=10
#
# Cloudflare API base URL. Change it only to point the sync at a test server.
# CF_API_BASE=https://api.cloudflare.com/client/v4
```

- [ ] **Step 7: Check that the server module still parses**

Run: `bt src/services/accessSync`, затем:

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && node --check src/index.js && echo syntax-ok'
```

Expected: тесты PASS, `syntax-ok`. Запуск сервера проверяется в Task 13.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/accessSync/scheduler.js backend/src/services/accessSync/scheduler.test.js backend/src/services/accessSync/index.js backend/src/index.js .env.example
git commit -m "feat(access-sync): run the sync hourly and on request in google mode"
```

---

### Task 8: Admin API и запуск синхронизации при изменении пользователей

**Files:**
- Create: `backend/src/routes/accessSync.js`
- Test: `backend/src/routes/accessSync.test.js`
- Modify: `backend/src/routes/admin.js` (импорты, `router.use('/access-sync', ...)`, `POST/PATCH/DELETE /users`)
- Test: `backend/src/routes/admin.users.test.js`

**Interfaces:**
- Consumes: `requestAccessSync`, `runAccessSyncNow`, `withAccessSyncLock` (Task 7); `loadStoredConfig`, `publicConfig`, `loadState`, `saveConfig`, `accessSyncMaxDisables`, `AccessSyncConfigError` (Task 5).
- Produces (только администратор, через `requireAdmin` роутера `admin.js`):
  - `GET /api/admin/access-sync` → `{ config: { enabled, accountId, appId, policyId, apiTokenSet }, lastRun: object | null, maxDisables: number, googleMode: boolean }`;
  - `PUT /api/admin/access-sync`, тело `{ enabled, accountId, appId, policyId, apiToken? }` → тот же ответ; ошибка — 400 `{ error: 'Invalid Cloudflare Access settings', code }`;
  - `POST /api/admin/access-sync/run` → `{ result, config, lastRun, maxDisables, googleMode }`, где `result` — ответ `runAccessSync`;
  - триггеры: `user_added`, `user_changed` (отключение, включение, смена email), `user_deleted`.

- [ ] **Step 1: Write the failing route test**

`backend/src/routes/accessSync.test.js`:

```js
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => `enc:${v}`, decrypt: (v) => v }));
vi.mock('../services/accessSync/index.js', () => ({
  requestAccessSync: vi.fn(), runAccessSyncNow: vi.fn(), withAccessSyncLock: vi.fn((op) => op()),
}));
vi.mock('../services/accessSync/settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadStoredConfig: vi.fn(), loadState: vi.fn(), saveConfig: vi.fn(),
}));

import express from 'express';
import accessSyncRoutes from './accessSync.js';
import { requestAccessSync, runAccessSyncNow, withAccessSyncLock } from '../services/accessSync/index.js';
import { AccessSyncConfigError, loadState, loadStoredConfig, saveConfig } from '../services/accessSync/settings.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';
const STORED = { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'enc:tok-secret' };
const LAST_RUN = {
  trigger: 'schedule', startedAt: '2026-09-17T09:00:00.000Z', finishedAt: '2026-09-17T09:00:01.000Z',
  outcome: 'updated', added: 1, removed: 0, disabled: 0, wouldDisable: 0, error: null,
};

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: 'admin-id' }; next(); });
  app.use('/api/admin/access-sync', accessSyncRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_MODE', 'google');
  vi.stubEnv('ACCESS_SYNC_MAX_DISABLES', '5');
  loadStoredConfig.mockResolvedValue(STORED);
  loadState.mockResolvedValue({ baseline: ['person@example.com'], abortedCandidates: null, lastRun: LAST_RUN });
});
afterEach(() => { vi.unstubAllEnvs(); });

const send = async (method, path, body) => {
  const res = await fetch(`${base}/api/admin/access-sync${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

const SNAPSHOT = {
  config: { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiTokenSet: true },
  lastRun: LAST_RUN, maxDisables: 5, googleMode: true,
};

describe('Access sync admin API', () => {
  it('shows the settings and the last run without the token or the baseline', async () => {
    const { status, body, text } = await send('GET', '');
    expect(status).toBe(200);
    expect(body).toEqual(SNAPSHOT);
    expect(text).not.toContain('tok-secret');
    expect(text).not.toContain('person@example.com');
  });

  it('saves settings under the sync lock and asks for a run when the sync is on', async () => {
    saveConfig.mockResolvedValue(STORED);
    const input = { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'tok-new' };
    const { status, body } = await send('PUT', '', input);
    expect(status).toBe(200);
    expect(body).toEqual(SNAPSHOT);
    expect(withAccessSyncLock).toHaveBeenCalledTimes(1);
    expect(saveConfig).toHaveBeenCalledWith(input);
    expect(requestAccessSync).toHaveBeenCalledWith('config');
  });

  it('does not ask for a run when the sync is saved off', async () => {
    saveConfig.mockResolvedValue({ ...STORED, enabled: false });
    await send('PUT', '', { enabled: false });
    expect(requestAccessSync).not.toHaveBeenCalled();
  });

  it('answers 400 with the reason for invalid settings', async () => {
    saveConfig.mockRejectedValue(new AccessSyncConfigError('invalid_id'));
    expect(await send('PUT', '', { enabled: true, accountId: 'x' })).toMatchObject({
      status: 400, body: { error: 'Invalid Cloudflare Access settings', code: 'invalid_id' },
    });
  });

  it('runs the sync now and returns its result with the new state', async () => {
    runAccessSyncNow.mockResolvedValue({ outcome: 'not_configured' });
    const { status, body } = await send('POST', '/run');
    expect(status).toBe(200);
    expect(body).toEqual({ result: { outcome: 'not_configured' }, ...SNAPSHOT });
  });
});
```

- [ ] **Step 2: Add the trigger tests to the users routes**

В `backend/src/routes/admin.users.test.js`:

1. После строки `vi.mock('../services/auditLog.js', ...)` добавить:

```js
vi.mock('../services/accessSync/index.js', () => ({
  requestAccessSync: vi.fn(), runAccessSyncNow: vi.fn(), withAccessSyncLock: vi.fn((op) => op()),
}));
```

2. После строки `import { recordAudit } from '../services/auditLog.js';` добавить:

```js
import { requestAccessSync } from '../services/accessSync/index.js';
```

3. В `beforeEach` после `recordAudit.mockClear();` добавить `requestAccessSync.mockClear();`.

4. Перед `describe('POST /api/admin/invites', ...)` добавить:

```js
describe('user changes request an Access sync', () => {
  const emailLookup = (row) => [/^\s*SELECT .* FROM users WHERE lower\(email\) = \$1/, { rows: row ? [row] : [] }];
  const update = (row) => [/^\s*UPDATE users\s+SET is_admin = \$2/, (params) => ({
    rows: [{ ...row, is_admin: params[1], email: params[2], disabled_at: params[3] }],
  })];

  it('requests a sync when a user is approved, disabled, enabled, readdressed or deleted', async () => {
    installTransaction([lock, emailLookup(null), [/^\s*UPDATE users SET email = \$1/, { rows: [] }], [/^\s*INSERT INTO users/, { rows: [USER_ROW] }]]);
    await send('POST', '/users', { email: 'user@example.com' });

    installTransaction([lock, target(USER_ROW), update(USER_ROW)]);
    await send('PATCH', `/users/${USER_ID}`, { disabled: true });

    const disabledRow = { ...USER_ROW, disabled_at: '2026-09-16T00:00:00.000Z' };
    installTransaction([lock, target(disabledRow), update(disabledRow)]);
    await send('PATCH', `/users/${USER_ID}`, { disabled: false });

    installTransaction([lock, target(USER_ROW), update(USER_ROW), [/SELECT id FROM users WHERE lower\(email\) = \$1 AND id <> \$2/, { rows: [] }]]);
    await send('PATCH', `/users/${USER_ID}`, { email: 'new@example.com' });

    installTransaction([lock, target(USER_ROW)]);
    query.mockResolvedValue({ rows: [] });
    await send('DELETE', `/users/${USER_ID}`);

    expect(requestAccessSync.mock.calls).toEqual([
      ['user_added'], ['user_changed'], ['user_changed'], ['user_changed'], ['user_deleted'],
    ]);
  });

  it('does not request a sync for an admin flag change or a refused change', async () => {
    installTransaction([lock, target(USER_ROW), update(USER_ROW)]);
    await send('PATCH', `/users/${USER_ID}`, { isAdmin: true });
    installTransaction([lock, emailLookup(USER_ROW)]);
    await send('POST', '/users', { email: 'user@example.com' });
    installTransaction([lock, target({ ...USER_ROW, is_admin: true }), otherAdmins(0)]);
    await send('DELETE', `/users/${USER_ID}`);
    expect(requestAccessSync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bt src/routes/accessSync.test.js src/routes/admin.users.test.js`
Expected: FAIL — `./accessSync.js` не найден; новые тесты в `admin.users.test.js` падают: `requestAccessSync` не вызывается.

- [ ] **Step 4: Implement the routes**

`backend/src/routes/accessSync.js`:

```js
import { Router } from 'express';
import { getAuthSettings } from '../services/auth/authSettings.js';
import { requestAccessSync, runAccessSyncNow, withAccessSyncLock } from '../services/accessSync/index.js';
import {
  AccessSyncConfigError, accessSyncMaxDisables, loadState, loadStoredConfig, publicConfig, saveConfig,
} from '../services/accessSync/settings.js';

// Cloudflare Access sync settings for admins; mounted by routes/admin.js behind requireAdmin.
const router = Router();

async function snapshot() {
  const [stored, state] = await Promise.all([loadStoredConfig(), loadState()]);
  return {
    config: publicConfig(stored),
    lastRun: state.lastRun,
    maxDisables: accessSyncMaxDisables(),
    googleMode: getAuthSettings().mode === 'google',
  };
}

router.get('/', async (_req, res) => {
  res.json(await snapshot());
});

router.put('/', async (req, res) => {
  try {
    const saved = await withAccessSyncLock(() => saveConfig(req.body));
    if (saved.enabled) requestAccessSync('config');
  } catch (err) {
    if (!(err instanceof AccessSyncConfigError)) throw err;
    return res.status(400).json({ error: 'Invalid Cloudflare Access settings', code: err.code });
  }
  console.log(`[admin] ${req.session.userId} changed the Cloudflare Access sync settings`);
  return res.json(await snapshot());
});

router.post('/run', async (_req, res) => {
  const result = await runAccessSyncNow();
  res.json({ result, ...(await snapshot()) });
});

export default router;
```

- [ ] **Step 5: Wire the routes and triggers into `admin.js`**

В `backend/src/routes/admin.js`:

1. После строки `import { destroyUserSessions } from './auth.js';` добавить:

```js
import accessSyncRoutes from './accessSync.js';
import { requestAccessSync } from '../services/accessSync/index.js';
```

2. После строки `router.param('id', uuidParam('id'));` добавить:

```js
router.use('/access-sync', accessSyncRoutes);
```

3. В `router.post('/users', ...)` после `recordAudit([userAuditEntry(req, 'user.added', user)]);` добавить:

```js
    requestAccessSync('user_added');
```

4. В `router.patch('/users/:id', ...)` после `if (auditEntries.length) recordAudit(auditEntries);` добавить:

```js
    // Who may sign in changed: the Access policy follows.
    if (!!previous.disabled_at !== !!row.disabled_at || previous.email !== row.email) requestAccessSync('user_changed');
```

5. В `router.delete('/users/:id', ...)` после `recordAudit([userAuditEntry(req, 'user.deleted', deleted)]);` добавить:

```js
  requestAccessSync('user_deleted');
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bt src/routes/accessSync.test.js src/routes/admin.users.test.js src/routes/admin.audit.test.js src/routes/admin.categorization.test.js src/routes/admin.syncSettings.test.js src/sharedData.guard.test.js`
Expected: PASS. Остальные `admin.*.test.js` синхронизацию не мокают: до `startAccessSync` запросы ничего не делают, а модули синхронизации при импорте не обращаются к базе.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/accessSync.js backend/src/routes/accessSync.test.js backend/src/routes/admin.js backend/src/routes/admin.users.test.js
git commit -m "feat(access-sync): add the admin API and sync on user changes"
```

---

### Task 9: Логика вкладки, API-клиент и новое действие на экране журнала

**Files:**
- Create: `frontend/src/utils/accessSync.js`
- Test: `frontend/src/utils/accessSync.test.js`
- Modify: `frontend/src/utils/api.js` (блок `admin`, после `getAuditLog`)
- Modify: `frontend/src/utils/auditLog.js`
- Test: `frontend/src/utils/auditLog.test.js`

**Interfaces:**
- Consumes: ответы `GET/PUT /api/admin/access-sync`, `POST /api/admin/access-sync/run` (Task 8).
- Produces:
  - `api.admin.getAccessSync()`, `api.admin.saveAccessSync(data)`, `api.admin.runAccessSync()`; ошибка API несёт `err.code`;
  - `ACCESS_SYNC_OUTCOME_KEYS`, `ACCESS_SYNC_ERROR_KEYS`;
  - `accessSyncForm(config) → { enabled, accountId, appId, policyId, apiToken: '' }`;
  - `accessSyncFormError(form, apiTokenSet) → translationKey | null`;
  - `accessSyncPayload(form) → body`;
  - `accessSyncSaveErrorKey(code) → translationKey | null`;
  - `accessSyncRunSummary(lastRun, maxDisables) → { key, values: { added, removed, disabled, wouldDisable, max, error }, errorKey } | null`;
  - `accessSyncIdleKey(result) → translationKey | null`;
  - в `utils/auditLog.js`: `'access.sync_aborted' → 'admin.audit.actionAccessSyncAborted'`; подробности `{ key: 'admin.audit.detailAccessSyncAborted', values: { wouldDisable, emails } }`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/utils/accessSync.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessSyncForm, accessSyncFormError, accessSyncIdleKey, accessSyncPayload, accessSyncRunSummary, accessSyncSaveErrorKey,
} from './accessSync.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';

describe('accessSyncForm', () => {
  it('fills the form from the settings and never from a token', () => {
    assert.deepEqual(accessSyncForm(null), { enabled: false, accountId: '', appId: '', policyId: '', apiToken: '' });
    assert.deepEqual(
      accessSyncForm({ enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiTokenSet: true }),
      { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: '' },
    );
  });
});

describe('accessSyncFormError', () => {
  const form = { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: '' };

  it('accepts complete settings with a stored or a new token', () => {
    assert.equal(accessSyncFormError(form, true), null);
    assert.equal(accessSyncFormError({ ...form, apiToken: 'tok' }, false), null);
    assert.equal(accessSyncFormError({ ...form, accountId: ` ${ACCOUNT.toUpperCase()} ` }, true), null);
  });

  it('names malformed ids and incomplete settings while the sync is on', () => {
    assert.equal(accessSyncFormError({ ...form, accountId: 'abc' }, true), 'admin.accessSync.errorInvalidId');
    assert.equal(accessSyncFormError({ ...form, policyId: 'not-a-uuid' }, true), 'admin.accessSync.errorInvalidId');
    assert.equal(accessSyncFormError(form, false), 'admin.accessSync.errorIncomplete');
    assert.equal(accessSyncFormError({ ...form, appId: '' }, true), 'admin.accessSync.errorIncomplete');
    assert.equal(accessSyncFormError({ ...form, enabled: false, appId: '' }, false), null);
  });
});

describe('accessSyncPayload', () => {
  it('trims the fields and leaves a blank token out so the stored one is kept', () => {
    assert.deepEqual(
      accessSyncPayload({ enabled: true, accountId: ` ${ACCOUNT} `, appId: APP, policyId: POLICY, apiToken: '  ' }),
      { enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY },
    );
    assert.equal(accessSyncPayload({ enabled: true, accountId: '', appId: '', policyId: '', apiToken: ' tok ' }).apiToken, 'tok');
  });
});

describe('accessSyncSaveErrorKey', () => {
  it('translates the codes the server gives for invalid settings', () => {
    assert.equal(accessSyncSaveErrorKey('invalid_id'), 'admin.accessSync.errorInvalidId');
    assert.equal(accessSyncSaveErrorKey('incomplete'), 'admin.accessSync.errorIncomplete');
    assert.equal(accessSyncSaveErrorKey('invalid_field'), null);
    assert.equal(accessSyncSaveErrorKey(undefined), null);
  });
});

describe('accessSyncRunSummary', () => {
  const run = { trigger: 'schedule', outcome: 'updated', added: 2, removed: 1, disabled: 0, wouldDisable: 0, error: null };

  it('describes each outcome with its counts', () => {
    assert.equal(accessSyncRunSummary(null, 10), null);
    assert.deepEqual(accessSyncRunSummary(run, 10), {
      key: 'admin.accessSync.outcomeUpdated',
      values: { added: 2, removed: 1, disabled: 0, wouldDisable: 0, max: 10, error: '' },
      errorKey: null,
    });
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'unchanged' }, 10).key, 'admin.accessSync.outcomeUnchanged');
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'aborted', wouldDisable: 12 }, 10).values.wouldDisable, 12);
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'empty' }, 10).key, 'admin.accessSync.outcomeEmpty');
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'surprise' }, 10), null);
  });

  it('translates the errors the server names and passes Cloudflare status text through', () => {
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'failed', error: 'token_unreadable' }, 10).errorKey, 'admin.accessSync.errorTokenUnreadable');
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'failed', error: 'policy_not_allow' }, 10).errorKey, 'admin.accessSync.errorPolicyNotAllow');
    assert.equal(accessSyncRunSummary({ ...run, outcome: 'failed', error: 'internal_error' }, 10).errorKey, 'admin.accessSync.errorInternal');
    const cloudflare = accessSyncRunSummary({ ...run, outcome: 'failed', error: 'Cloudflare getPolicy failed (403): error 10000' }, 10);
    assert.equal(cloudflare.key, 'admin.accessSync.outcomeFailed');
    assert.equal(cloudflare.errorKey, null);
    assert.equal(cloudflare.values.error, 'Cloudflare getPolicy failed (403): error 10000');
  });
});

describe('accessSyncIdleKey', () => {
  it('explains a manual run that did nothing', () => {
    assert.equal(accessSyncIdleKey({ outcome: 'not_configured' }), 'admin.accessSync.notConfigured');
    assert.equal(accessSyncIdleKey({ outcome: 'not_google_mode' }), 'admin.accessSync.notGoogleMode');
    assert.equal(accessSyncIdleKey({ outcome: 'updated' }), null);
    assert.equal(accessSyncIdleKey(undefined), null);
  });
});
```

В `frontend/src/utils/auditLog.test.js`:

1. В тесте `lists every action the server records, each with a label` заменить ожидаемый список и добавить проверку подписи:

```js
    assert.deepEqual(AUDIT_ACTIONS, [
      'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
      'mailbox.enabled', 'mailbox.disabled', 'message.sent', 'message.deleted',
      'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
      'access.sync_aborted',
    ]);
    assert.equal(auditActionLabelKey('access.sync_aborted'), 'admin.audit.actionAccessSyncAborted');
```

2. В `describe('auditDetail', ...)` добавить тест:

```js
  it('lists the users a stopped Access sync would have disabled', () => {
    assert.deepEqual(
      auditDetail({ action: 'access.sync_aborted', details: { candidates: ['a@example.com', 'b@example.com'], activeUsers: 3, maxDisables: 1 } }),
      { key: 'admin.audit.detailAccessSyncAborted', values: { wouldDisable: 2, emails: 'a@example.com, b@example.com' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'access.sync_aborted', details: {} }),
      { key: 'admin.audit.detailAccessSyncAborted', values: { wouldDisable: 0, emails: '' } },
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node --test src/utils/accessSync.test.js src/utils/auditLog.test.js`
Expected: FAIL — модуля `accessSync.js` нет; в `AUDIT_ACTIONS` нет `access.sync_aborted`.

- [ ] **Step 3: Implement**

`frontend/src/utils/accessSync.js`:

```js
// Helpers for the Cloudflare Access sync tab. Shapes mirror GET/PUT /api/admin/access-sync and
// the lastRun record of backend/src/services/accessSync/runner.js.
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACCESS_SYNC_OUTCOME_KEYS = Object.freeze({
  updated: 'admin.accessSync.outcomeUpdated',
  unchanged: 'admin.accessSync.outcomeUnchanged',
  aborted: 'admin.accessSync.outcomeAborted',
  empty: 'admin.accessSync.outcomeEmpty',
  failed: 'admin.accessSync.outcomeFailed',
});

// Run errors the server names by code. Any other error is Cloudflare's status and error codes,
// shown as they are.
export const ACCESS_SYNC_ERROR_KEYS = Object.freeze({
  token_unreadable: 'admin.accessSync.errorTokenUnreadable',
  policy_not_allow: 'admin.accessSync.errorPolicyNotAllow',
  internal_error: 'admin.accessSync.errorInternal',
});

const SAVE_ERROR_KEYS = Object.freeze({
  invalid_id: 'admin.accessSync.errorInvalidId',
  incomplete: 'admin.accessSync.errorIncomplete',
});

const IDLE_KEYS = Object.freeze({
  not_configured: 'admin.accessSync.notConfigured',
  not_google_mode: 'admin.accessSync.notGoogleMode',
});

// The form starts from the stored settings; the token field always starts empty.
export function accessSyncForm(config) {
  return {
    enabled: !!config?.enabled,
    accountId: config?.accountId ?? '',
    appId: config?.appId ?? '',
    policyId: config?.policyId ?? '',
    apiToken: '',
  };
}

// The first problem that stops the form from saving, as a translation key, or null.
export function accessSyncFormError(form, apiTokenSet) {
  const accountId = form.accountId.trim();
  const appId = form.appId.trim();
  const policyId = form.policyId.trim();
  if ((accountId && !ACCOUNT_ID_RE.test(accountId)) || (appId && !UUID_RE.test(appId)) || (policyId && !UUID_RE.test(policyId))) {
    return 'admin.accessSync.errorInvalidId';
  }
  if (form.enabled && !(accountId && appId && policyId && (apiTokenSet || form.apiToken.trim()))) {
    return 'admin.accessSync.errorIncomplete';
  }
  return null;
}

// Body for PUT /api/admin/access-sync. A blank token is left out, which keeps the stored one.
export function accessSyncPayload(form) {
  const body = {
    enabled: form.enabled,
    accountId: form.accountId.trim(),
    appId: form.appId.trim(),
    policyId: form.policyId.trim(),
  };
  const token = form.apiToken.trim();
  if (token) body.apiToken = token;
  return body;
}

export function accessSyncSaveErrorKey(code) {
  return SAVE_ERROR_KEYS[code] ?? null;
}

// The last run line: the outcome's key with its values, and a key for a named error.
export function accessSyncRunSummary(lastRun, maxDisables) {
  const key = ACCESS_SYNC_OUTCOME_KEYS[lastRun?.outcome];
  if (!key) return null;
  return {
    key,
    values: {
      added: lastRun.added ?? 0,
      removed: lastRun.removed ?? 0,
      disabled: lastRun.disabled ?? 0,
      wouldDisable: lastRun.wouldDisable ?? 0,
      max: maxDisables,
      error: lastRun.error ?? '',
    },
    errorKey: ACCESS_SYNC_ERROR_KEYS[lastRun.error] ?? null,
  };
}

// Why a manual run did nothing, or null when it ran.
export function accessSyncIdleKey(result) {
  return IDLE_KEYS[result?.outcome] ?? null;
}
```

В `frontend/src/utils/api.js` после строки с `getAuditLog:` добавить:

```js
    getAccessSync: () => request('GET', '/admin/access-sync'),
    saveAccessSync: (data) => request('PUT', '/admin/access-sync', data),
    runAccessSync: () => request('POST', '/admin/access-sync/run'),
```

В `frontend/src/utils/auditLog.js`:

1. В `AUDIT_ACTION_LABEL_KEYS` после `'user.admin_changed': 'admin.audit.actionUserAdminChanged',` добавить:

```js
  'access.sync_aborted': 'admin.audit.actionAccessSyncAborted',
```

2. В `auditDetail` перед `default:` добавить:

```js
    case 'access.sync_aborted': {
      const candidates = Array.isArray(details.candidates) ? details.candidates : [];
      return {
        key: 'admin.audit.detailAccessSyncAborted',
        values: { wouldDisable: candidates.length, emails: candidates.join(', ') },
      };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && node --test src/utils/accessSync.test.js src/utils/auditLog.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/accessSync.js frontend/src/utils/accessSync.test.js frontend/src/utils/api.js frontend/src/utils/auditLog.js frontend/src/utils/auditLog.test.js
git commit -m "feat(access-sync): add the sync tab logic and the stopped-sync audit entry"
```

---

### Task 10: Синхронизация в демо-режиме

**Files:**
- Modify: `frontend/src/demo/index.js`
- Test: `frontend/src/demo/index.test.js`

**Interfaces:**
- Consumes: формы ответов Task 8.
- Produces: демо отвечает на `GET/PUT /admin/access-sync` и `POST /admin/access-sync/run`; в демо-журнале есть запись `access.sync_aborted`.

- [ ] **Step 1: Write the failing test**

В конец `frontend/src/demo/index.test.js` добавить:

```js
test('the demo Access sync keeps the token hidden and reports a manual run', async () => {
  const initial = await demoRequest('GET', '/admin/access-sync');
  assert.equal(initial.googleMode, true);
  assert.equal(initial.config.apiTokenSet, true);
  assert.equal('apiToken' in initial.config, false);
  assert.equal(initial.lastRun.outcome, 'updated');

  const off = await demoRequest('PUT', '/admin/access-sync', { ...initial.config, enabled: false, apiToken: 'demo-token' });
  assert.equal(off.config.enabled, false);
  assert.equal(JSON.stringify(off).includes('demo-token'), false);
  assert.equal((await demoRequest('POST', '/admin/access-sync/run')).result.outcome, 'not_configured');

  await demoRequest('PUT', '/admin/access-sync', { ...initial.config, enabled: true });
  const ran = await demoRequest('POST', '/admin/access-sync/run');
  assert.equal(ran.result.outcome, 'unchanged');
  assert.equal(ran.lastRun.trigger, 'manual');
  assert.deepEqual(ran.config, { ...initial.config, enabled: true });
});

test('the demo audit log shows a stopped Access sync', async () => {
  const { entries } = await demoRequest('GET', '/admin/audit?action=access.sync_aborted');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actorEmail, 'Cloudflare Access');
  assert.ok(entries[0].details.candidates.length > 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node --test src/demo/index.test.js`
Expected: FAIL — `GET /admin/access-sync` отвечает `{ ok: true, demo: true }`, записи `access.sync_aborted` нет.

- [ ] **Step 3: Implement**

В `frontend/src/demo/index.js`:

1. В начало массива `AUDIT_FIXTURES` (перед записью с `id: '6'`) добавить:

```js
  {
    id: '7', occurredAt: '2026-09-17T10:05:00.000Z', actorUserId: null, actorEmail: 'Cloudflare Access',
    accountId: null, accountEmail: null, action: 'access.sync_aborted',
    details: { candidates: ['colleague@demo.mailexpert.local', 'former@demo.mailexpert.local'], activeUsers: 3, maxDisables: 10 },
  },
```

2. После закрывающей `];` массива `AUDIT_FIXTURES` добавить:

```js

// Cloudflare Access sync settings as an admin sees them. The ids are made up.
const ACCESS_SYNC_FIXTURE = {
  config: {
    enabled: true,
    accountId: '0123456789abcdef0123456789abcdef',
    appId: '11111111-2222-4333-8444-555555555555',
    policyId: '66666666-7777-4888-9999-000000000000',
    apiTokenSet: true,
  },
  lastRun: {
    trigger: 'schedule', startedAt: '2026-09-17T09:00:00.000Z', finishedAt: '2026-09-17T09:00:01.000Z',
    outcome: 'updated', added: 1, removed: 0, disabled: 0, wouldDisable: 0, error: null,
  },
  maxDisables: 10,
  googleMode: true,
};
```

3. После строки `let nextMessageSequence = 10;` добавить:

```js
let accessSync = structuredClone(ACCESS_SYNC_FIXTURE);
```

4. После обработчика `GET /admin/audit` (перед `if (verb === 'GET' && pathname === '/admin/ai')`) добавить:

```js
  if (verb === 'GET' && pathname === '/admin/access-sync') return clone(accessSync);
  if (verb === 'PUT' && pathname === '/admin/access-sync') {
    accessSync.config = {
      enabled: !!body.enabled,
      accountId: String(body.accountId ?? '').trim(),
      appId: String(body.appId ?? '').trim(),
      policyId: String(body.policyId ?? '').trim(),
      apiTokenSet: accessSync.config.apiTokenSet || !!String(body.apiToken ?? '').trim(),
    };
    return clone(accessSync);
  }
  if (verb === 'POST' && pathname === '/admin/access-sync/run') {
    if (!accessSync.config.enabled) return { result: { outcome: 'not_configured' }, ...clone(accessSync) };
    const now = new Date().toISOString();
    accessSync.lastRun = {
      trigger: 'manual', startedAt: now, finishedAt: now, outcome: 'unchanged',
      added: 0, removed: 0, disabled: 0, wouldDisable: 0, error: null,
    };
    return { result: clone(accessSync.lastRun), ...clone(accessSync) };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node --test src/demo/index.test.js`
Expected: PASS, включая существующий тест демо-журнала.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/demo/index.js frontend/src/demo/index.test.js
git commit -m "feat(access-sync): answer the Access sync API in demo mode"
```

---

### Task 11: Строки интерфейса на 9 языках

**Files:**
- Modify: `frontend/src/locales/{en,ru,de,es,fr,it,cs,pl,zhCN}.json`
- Scratch, не коммитится: `<scratchpad>/pr6-locales.mjs`

**Interfaces:**
- Produces ключи `admin.accessSync.*` (30 ключей, перечислены в скрипте) и `admin.audit.actionAccessSyncAborted`, `admin.audit.detailAccessSyncAborted` (`{{wouldDisable}}`, `{{emails}}`).
- Переиспользуется существующий `common.loading`.

Ключи из `utils/accessSync.js` и `utils/auditLog.js` уже упомянуты в исходниках, поэтому `DYNAMIC_KEYS` не меняется. До Task 12 набор «Source coverage» падает на ключах, которые использует только вкладка: `tab`, `title`, `description`, `enabled`, `accountId`, `appId`, `policyId`, `apiToken`, `apiTokenHint`, `apiTokenStored`, `save`, `saved`, `runNow`, `running`, `lastRun`, `neverRun`, `limit`, `loadFailed`.

- [ ] **Step 1: Write the locale script**

`<scratchpad>/pr6-locales.mjs` (запускать из корня репозитория):

```js
import { readFileSync, writeFileSync } from 'node:fs';

const LOCALES = ['en', 'ru', 'de', 'es', 'fr', 'it', 'cs', 'pl', 'zhCN'];
// key -> [en, ru, de, es, fr, it, cs, pl, zhCN]
const STRINGS = {
  'admin.accessSync.tab': ['Access policy sync', 'Синхронизация с Access', 'Access-Richtlinie abgleichen', 'Sincronización con Access', 'Synchronisation Access', 'Sincronizzazione Access', 'Synchronizace s Access', 'Synchronizacja z Access', 'Access 策略同步'],
  'admin.accessSync.title': ['Cloudflare Access policy sync', 'Синхронизация политики Cloudflare Access', 'Abgleich der Cloudflare-Access-Richtlinie', 'Sincronización de la política de Cloudflare Access', 'Synchronisation de la stratégie Cloudflare Access', 'Sincronizzazione del criterio Cloudflare Access', 'Synchronizace zásady Cloudflare Access', 'Synchronizacja zasady Cloudflare Access', 'Cloudflare Access 策略同步'],
  'admin.accessSync.description': [
    'MailExpert keeps the Allow policy of the Cloudflare Access application in line with approved users: user changes reach the policy within seconds, and the whole list is checked every hour. Emails added in Cloudflare by hand, groups and domain rules stay as they are. A user whose email is removed in Cloudflare is disabled here.',
    'MailExpert приводит Allow-политику приложения Cloudflare Access в соответствие с одобренными пользователями: изменения пользователей попадают в политику за несколько секунд, весь список сверяется раз в час. Адреса, добавленные в Cloudflare вручную, группы и доменные правила не меняются. Пользователь, чей адрес удалили в Cloudflare, отключается здесь.',
    'MailExpert hält die Allow-Richtlinie der Cloudflare-Access-Anwendung mit den freigegebenen Benutzern im Einklang: Änderungen an Benutzern erreichen die Richtlinie binnen Sekunden, die ganze Liste wird stündlich geprüft. Von Hand in Cloudflare eingetragene Adressen, Gruppen und Domainregeln bleiben unverändert. Ein Benutzer, dessen Adresse in Cloudflare entfernt wurde, wird hier deaktiviert.',
    'MailExpert mantiene la política Allow de la aplicación de Cloudflare Access al día con los usuarios aprobados: los cambios de usuarios llegan a la política en segundos y la lista completa se revisa cada hora. Las direcciones añadidas a mano en Cloudflare, los grupos y las reglas de dominio no se tocan. Un usuario cuya dirección se quita en Cloudflare se desactiva aquí.',
    "MailExpert aligne la stratégie Allow de l'application Cloudflare Access sur les utilisateurs approuvés : les changements d'utilisateurs atteignent la stratégie en quelques secondes et la liste complète est vérifiée toutes les heures. Les adresses ajoutées à la main dans Cloudflare, les groupes et les règles de domaine restent inchangés. Un utilisateur dont l'adresse est retirée dans Cloudflare est désactivé ici.",
    "MailExpert mantiene il criterio Allow dell'applicazione Cloudflare Access allineato agli utenti approvati: le modifiche agli utenti arrivano al criterio in pochi secondi e l'elenco completo viene controllato ogni ora. Gli indirizzi aggiunti a mano in Cloudflare, i gruppi e le regole di dominio restano invariati. Un utente il cui indirizzo viene rimosso in Cloudflare viene disattivato qui.",
    'MailExpert udržuje zásadu Allow aplikace Cloudflare Access v souladu se schválenými uživateli: změny uživatelů se do zásady dostanou během několika sekund a celý seznam se kontroluje každou hodinu. Adresy přidané v Cloudflare ručně, skupiny a doménová pravidla zůstávají beze změny. Uživatel, jehož adresa byla v Cloudflare odebrána, je zde deaktivován.',
    'MailExpert utrzymuje zasadę Allow aplikacji Cloudflare Access zgodną z zatwierdzonymi użytkownikami: zmiany użytkowników trafiają do zasady w ciągu kilku sekund, a pełna lista jest sprawdzana co godzinę. Adresy dodane ręcznie w Cloudflare, grupy i reguły domen pozostają bez zmian. Użytkownik, którego adres usunięto w Cloudflare, zostaje tu wyłączony.',
    'MailExpert 让 Cloudflare Access 应用的 Allow 策略与已批准的用户保持一致：用户变更会在几秒内写入策略，完整列表每小时核对一次。在 Cloudflare 中手动添加的地址、组和域规则保持不变。在 Cloudflare 中被移除地址的用户会在这里被停用。',
  ],
  'admin.accessSync.enabled': ['Sync approved users to the policy', 'Синхронизировать одобренных пользователей с политикой', 'Freigegebene Benutzer mit der Richtlinie abgleichen', 'Sincronizar los usuarios aprobados con la política', 'Synchroniser les utilisateurs approuvés avec la stratégie', 'Sincronizza gli utenti approvati con il criterio', 'Synchronizovat schválené uživatele se zásadou', 'Synchronizuj zatwierdzonych użytkowników z zasadą', '将已批准的用户同步到策略'],
  'admin.accessSync.accountId': ['Account ID', 'ID аккаунта', 'Konto-ID', 'ID de cuenta', 'ID du compte', 'ID account', 'ID účtu', 'ID konta', '账户 ID'],
  'admin.accessSync.appId': ['Application ID', 'ID приложения', 'Anwendungs-ID', 'ID de aplicación', "ID de l'application", 'ID applicazione', 'ID aplikace', 'ID aplikacji', '应用 ID'],
  'admin.accessSync.policyId': ['Policy ID', 'ID политики', 'Richtlinien-ID', 'ID de política', 'ID de la stratégie', 'ID criterio', 'ID zásady', 'ID zasady', '策略 ID'],
  'admin.accessSync.apiToken': ['API token', 'API-токен', 'API-Token', 'Token de API', "Jeton d'API", 'Token API', 'Token pro API', 'Token interfejsu API', 'API 令牌'],
  'admin.accessSync.apiTokenHint': [
    'Needs the "Access: Apps and Policies" write permission for this account only. The token is stored encrypted and never shown.',
    'Нужно право «Access: Apps and Policies» на запись только для этого аккаунта. Токен хранится зашифрованным и никогда не показывается.',
    'Benötigt die Schreibberechtigung „Access: Apps and Policies“ nur für dieses Konto. Das Token wird verschlüsselt gespeichert und nie angezeigt.',
    'Necesita el permiso de escritura «Access: Apps and Policies» solo para esta cuenta. El token se guarda cifrado y nunca se muestra.',
    "Nécessite l'autorisation d'écriture « Access: Apps and Policies » sur ce seul compte. Le jeton est stocké chiffré et n'est jamais affiché.",
    'Richiede il permesso di scrittura «Access: Apps and Policies» solo per questo account. Il token è salvato cifrato e non viene mai mostrato.',
    'Vyžaduje oprávnění k zápisu „Access: Apps and Policies“ pouze pro tento účet. Token je uložen šifrovaně a nikdy se nezobrazuje.',
    'Wymaga uprawnienia zapisu „Access: Apps and Policies” tylko dla tego konta. Token jest przechowywany w postaci zaszyfrowanej i nigdy nie jest pokazywany.',
    '需要仅针对此账户的“Access: Apps and Policies”写入权限。令牌加密保存，永不显示。',
  ],
  'admin.accessSync.apiTokenStored': ['A token is stored. Enter a new one to replace it.', 'Токен сохранён. Введите новый, чтобы заменить его.', 'Ein Token ist gespeichert. Geben Sie ein neues ein, um es zu ersetzen.', 'Hay un token guardado. Introduce uno nuevo para reemplazarlo.', 'Un jeton est enregistré. Saisissez-en un nouveau pour le remplacer.', 'Un token è salvato. Inseriscine uno nuovo per sostituirlo.', 'Token je uložen. Zadejte nový, pokud ho chcete nahradit.', 'Token jest zapisany. Wpisz nowy, aby go zastąpić.', '已保存令牌。输入新令牌即可替换。'],
  'admin.accessSync.save': ['Save settings', 'Сохранить настройки', 'Einstellungen speichern', 'Guardar ajustes', 'Enregistrer les paramètres', 'Salva impostazioni', 'Uložit nastavení', 'Zapisz ustawienia', '保存设置'],
  'admin.accessSync.saved': ['Settings saved', 'Настройки сохранены', 'Einstellungen gespeichert', 'Ajustes guardados', 'Paramètres enregistrés', 'Impostazioni salvate', 'Nastavení uloženo', 'Ustawienia zapisane', '设置已保存'],
  'admin.accessSync.runNow': ['Sync now', 'Синхронизировать сейчас', 'Jetzt abgleichen', 'Sincronizar ahora', 'Synchroniser maintenant', 'Sincronizza ora', 'Synchronizovat nyní', 'Synchronizuj teraz', '立即同步'],
  'admin.accessSync.running': ['Syncing…', 'Синхронизация…', 'Abgleich läuft…', 'Sincronizando…', 'Synchronisation en cours…', 'Sincronizzazione in corso…', 'Probíhá synchronizace…', 'Trwa synchronizacja…', '正在同步…'],
  'admin.accessSync.lastRun': ['Last run {{time}}', 'Последний прогон {{time}}', 'Letzter Lauf {{time}}', 'Última ejecución {{time}}', 'Dernière exécution {{time}}', 'Ultima esecuzione {{time}}', 'Poslední běh {{time}}', 'Ostatnie uruchomienie {{time}}', '上次运行 {{time}}'],
  'admin.accessSync.neverRun': ['No run yet', 'Прогонов ещё не было', 'Noch kein Lauf', 'Aún no se ha ejecutado', "Aucune exécution pour l'instant", 'Nessuna esecuzione finora', 'Zatím žádný běh', 'Jeszcze nie uruchomiono', '尚未运行'],
  'admin.accessSync.limit': [
    'A run stops instead of disabling more than {{max}} users or more than half of the active users.',
    'Прогон останавливается, если отключил бы больше {{max}} пользователей или больше половины активных.',
    'Ein Lauf bricht ab, statt mehr als {{max}} Benutzer oder mehr als die Hälfte der aktiven Benutzer zu deaktivieren.',
    'Una ejecución se detiene en lugar de desactivar más de {{max}} usuarios o más de la mitad de los usuarios activos.',
    "Une exécution s'arrête plutôt que de désactiver plus de {{max}} utilisateurs ou plus de la moitié des utilisateurs actifs.",
    "Un'esecuzione si ferma invece di disattivare più di {{max}} utenti o più della metà degli utenti attivi.",
    'Běh se zastaví, místo aby deaktivoval více než {{max}} uživatelů nebo více než polovinu aktivních uživatelů.',
    'Uruchomienie zatrzymuje się, zamiast wyłączać więcej niż {{max}} użytkowników lub więcej niż połowę aktywnych użytkowników.',
    '如果一次运行会停用超过 {{max}} 个用户或超过一半的活跃用户，运行将停止。',
  ],
  'admin.accessSync.outcomeUpdated': [
    'Policy updated: {{added}} added, {{removed}} removed, {{disabled}} users disabled.',
    'Политика обновлена: добавлено {{added}}, удалено {{removed}}, отключено пользователей: {{disabled}}.',
    'Richtlinie aktualisiert: {{added}} hinzugefügt, {{removed}} entfernt, {{disabled}} Benutzer deaktiviert.',
    'Política actualizada: {{added}} añadidos, {{removed}} quitados, {{disabled}} usuarios desactivados.',
    'Stratégie mise à jour : {{added}} ajoutés, {{removed}} retirés, {{disabled}} utilisateurs désactivés.',
    'Criterio aggiornato: {{added}} aggiunti, {{removed}} rimossi, {{disabled}} utenti disattivati.',
    'Zásada aktualizována: přidáno {{added}}, odebráno {{removed}}, deaktivováno uživatelů: {{disabled}}.',
    'Zasada zaktualizowana: dodano {{added}}, usunięto {{removed}}, wyłączono użytkowników: {{disabled}}.',
    '策略已更新：新增 {{added}}，移除 {{removed}}，停用用户 {{disabled}} 个。',
  ],
  'admin.accessSync.outcomeUnchanged': [
    'Policy was already up to date; {{disabled}} users disabled.',
    'Политика уже была актуальной; отключено пользователей: {{disabled}}.',
    'Richtlinie war bereits aktuell; {{disabled}} Benutzer deaktiviert.',
    'La política ya estaba al día; {{disabled}} usuarios desactivados.',
    'La stratégie était déjà à jour ; {{disabled}} utilisateurs désactivés.',
    'Il criterio era già aggiornato; {{disabled}} utenti disattivati.',
    'Zásada už byla aktuální; deaktivováno uživatelů: {{disabled}}.',
    'Zasada była już aktualna; wyłączono użytkowników: {{disabled}}.',
    '策略已是最新；停用用户 {{disabled}} 个。',
  ],
  'admin.accessSync.outcomeAborted': [
    'Stopped: {{wouldDisable}} users would have been disabled. Nothing was changed; see the audit log.',
    'Остановлено: отключились бы пользователи ({{wouldDisable}}). Ничего не изменено, подробности в журнале.',
    'Abgebrochen: {{wouldDisable}} Benutzer wären deaktiviert worden. Nichts wurde geändert; siehe Protokoll.',
    'Detenido: se habrían desactivado {{wouldDisable}} usuarios. No se cambió nada; consulta el registro de auditoría.',
    "Arrêtée : {{wouldDisable}} utilisateurs auraient été désactivés. Rien n'a changé ; voir le journal d'audit.",
    'Interrotta: sarebbero stati disattivati {{wouldDisable}} utenti. Nulla è stato modificato; vedi il registro attività.',
    'Zastaveno: deaktivovalo by se uživatelů: {{wouldDisable}}. Nic se nezměnilo; viz auditní protokol.',
    'Zatrzymano: wyłączonych zostałoby użytkowników: {{wouldDisable}}. Nic nie zmieniono; zobacz dziennik zdarzeń.',
    '已停止：将会停用 {{wouldDisable}} 个用户。未做任何更改，请查看审计日志。',
  ],
  'admin.accessSync.outcomeEmpty': ['Skipped: the policy would have no rules left.', 'Пропущено: в политике не осталось бы правил.', 'Übersprungen: Die Richtlinie hätte keine Regeln mehr.', 'Omitido: la política se quedaría sin reglas.', "Ignorée : la stratégie n'aurait plus aucune règle.", 'Saltata: il criterio resterebbe senza regole.', 'Přeskočeno: v zásadě by nezůstalo žádné pravidlo.', 'Pominięto: w zasadzie nie zostałaby żadna reguła.', '已跳过：策略将不剩任何规则。'],
  'admin.accessSync.outcomeFailed': ['Failed: {{error}}', 'Ошибка: {{error}}', 'Fehlgeschlagen: {{error}}', 'Error: {{error}}', 'Échec : {{error}}', 'Errore: {{error}}', 'Chyba: {{error}}', 'Błąd: {{error}}', '失败：{{error}}'],
  'admin.accessSync.errorTokenUnreadable': ['the stored token cannot be decrypted, enter it again', 'сохранённый токен не расшифровывается, введите его заново', 'das gespeicherte Token lässt sich nicht entschlüsseln, bitte neu eingeben', 'el token guardado no se puede descifrar, vuelve a introducirlo', 'le jeton enregistré ne peut pas être déchiffré, saisissez-le à nouveau', 'il token salvato non si può decifrare, inseriscilo di nuovo', 'uložený token nelze dešifrovat, zadejte ho znovu', 'zapisanego tokenu nie da się odszyfrować, wpisz go ponownie', '无法解密已保存的令牌，请重新输入'],
  'admin.accessSync.errorPolicyNotAllow': ['the policy is not an Allow policy', 'это не Allow-политика', 'die Richtlinie ist keine Allow-Richtlinie', 'la política no es de tipo Allow', "la stratégie n'est pas de type Allow", 'il criterio non è di tipo Allow', 'zásada není typu Allow', 'zasada nie jest typu Allow', '该策略不是 Allow 策略'],
  'admin.accessSync.errorInternal': ['internal error, see the server log', 'внутренняя ошибка, подробности в логе сервера', 'interner Fehler, siehe Serverprotokoll', 'error interno, consulta el registro del servidor', 'erreur interne, voir le journal du serveur', 'errore interno, vedi il log del server', 'interní chyba, viz protokol serveru', 'błąd wewnętrzny, zobacz dziennik serwera', '内部错误，请查看服务器日志'],
  'admin.accessSync.errorInvalidId': [
    'The account ID is 32 hexadecimal characters; the application and policy IDs are UUIDs.',
    'ID аккаунта — 32 шестнадцатеричных символа, ID приложения и политики — UUID.',
    'Die Konto-ID besteht aus 32 Hexadezimalzeichen, Anwendungs- und Richtlinien-ID sind UUIDs.',
    'El ID de cuenta tiene 32 caracteres hexadecimales; los ID de aplicación y de política son UUID.',
    "L'ID du compte compte 32 caractères hexadécimaux ; les ID d'application et de stratégie sont des UUID.",
    "L'ID account è di 32 caratteri esadecimali; gli ID di applicazione e criterio sono UUID.",
    'ID účtu má 32 šestnáctkových znaků; ID aplikace a zásady jsou UUID.',
    'ID konta ma 32 znaki szesnastkowe; ID aplikacji i zasady to identyfikatory UUID.',
    '账户 ID 为 32 个十六进制字符；应用 ID 和策略 ID 为 UUID。',
  ],
  'admin.accessSync.errorIncomplete': ['To turn the sync on, fill in every ID and the API token.', 'Чтобы включить синхронизацию, заполните все ID и API-токен.', 'Um den Abgleich einzuschalten, alle IDs und das API-Token ausfüllen.', 'Para activar la sincronización, rellena todos los ID y el token de API.', "Pour activer la synchronisation, renseignez tous les ID et le jeton d'API.", 'Per attivare la sincronizzazione compila tutti gli ID e il token API.', 'Chcete-li synchronizaci zapnout, vyplňte všechna ID a token pro API.', 'Aby włączyć synchronizację, uzupełnij wszystkie ID i token interfejsu API.', '要开启同步，请填写所有 ID 和 API 令牌。'],
  'admin.accessSync.notConfigured': ['The sync is off or not filled in.', 'Синхронизация выключена или не настроена.', 'Der Abgleich ist aus oder nicht eingerichtet.', 'La sincronización está desactivada o sin configurar.', 'La synchronisation est désactivée ou non configurée.', 'La sincronizzazione è disattivata o non configurata.', 'Synchronizace je vypnutá nebo nenastavená.', 'Synchronizacja jest wyłączona lub nieskonfigurowana.', '同步已关闭或尚未配置。'],
  'admin.accessSync.notGoogleMode': ['The sync works only with AUTH_MODE=google.', 'Синхронизация работает только при AUTH_MODE=google.', 'Der Abgleich funktioniert nur mit AUTH_MODE=google.', 'La sincronización solo funciona con AUTH_MODE=google.', 'La synchronisation ne fonctionne qu’avec AUTH_MODE=google.', 'La sincronizzazione funziona solo con AUTH_MODE=google.', 'Synchronizace funguje jen s AUTH_MODE=google.', 'Synchronizacja działa tylko z AUTH_MODE=google.', '同步仅在 AUTH_MODE=google 时可用。'],
  'admin.accessSync.loadFailed': ['Could not load the sync settings: {{message}}', 'Не удалось загрузить настройки синхронизации: {{message}}', 'Abgleich-Einstellungen konnten nicht geladen werden: {{message}}', 'No se pudieron cargar los ajustes de sincronización: {{message}}', 'Impossible de charger les paramètres de synchronisation : {{message}}', 'Impossibile caricare le impostazioni di sincronizzazione: {{message}}', 'Nastavení synchronizace se nepodařilo načíst: {{message}}', 'Nie udało się wczytać ustawień synchronizacji: {{message}}', '无法加载同步设置：{{message}}'],
  'admin.audit.actionAccessSyncAborted': ['Access sync stopped', 'Синхронизация с Access остановлена', 'Access-Abgleich abgebrochen', 'Sincronización con Access detenida', 'Synchronisation Access arrêtée', 'Sincronizzazione Access interrotta', 'Synchronizace s Access zastavena', 'Synchronizacja z Access zatrzymana', 'Access 同步已停止'],
  'admin.audit.detailAccessSyncAborted': ['Would disable ({{wouldDisable}}): {{emails}}', 'Отключились бы ({{wouldDisable}}): {{emails}}', 'Würde deaktivieren ({{wouldDisable}}): {{emails}}', 'Desactivaría ({{wouldDisable}}): {{emails}}', 'Désactiverait ({{wouldDisable}}) : {{emails}}', 'Disattiverebbe ({{wouldDisable}}): {{emails}}', 'Deaktivovalo by se ({{wouldDisable}}): {{emails}}', 'Wyłączyłaby ({{wouldDisable}}): {{emails}}', '将停用（{{wouldDisable}}）：{{emails}}'],
};

LOCALES.forEach((locale, index) => {
  const file = `frontend/src/locales/${locale}.json`;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const [key, values] of Object.entries(STRINGS)) {
    if (values.length !== LOCALES.length) throw new Error(`${key} has ${values.length} values`);
    const path = key.split('.');
    let node = data;
    for (const part of path.slice(0, -1)) node = node[part] ??= {};
    node[path.at(-1)] = values[index];
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`.replace(/\n/g, '\r\n'));
});
console.log(`added ${Object.keys(STRINGS).length} keys to ${LOCALES.length} locales`);
```

- [ ] **Step 2: Run it and check the diff**

```bash
node "<scratchpad>/pr6-locales.mjs"
git diff --stat -- frontend/src/locales
```

Expected: `added 32 keys to 9 locales`; в каждом файле локали только добавленные строки (раздел `accessSync` и два ключа в `audit`) и запятые на строках перед ними — других удалений нет.

- [ ] **Step 3: Run the key and uniqueness suites**

Run: `cd frontend && node --test src/locales/i18n.test.js`
Expected:
- набор «Key coverage» проходит;
- набор уникальности значений проходит; если он называет пару локалей с действительно одинаковым правильным переводом, добавить ключ в `SAME_VALUE_ALLOWED` с группой этих локалей и комментарием, как у соседних записей, а не копировать английский текст;
- набор «Source coverage» падает только на 18 ключах `admin.accessSync.*`, перечисленных выше: их использует Task 12.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/locales
git commit -m "feat(access-sync): add Access sync strings in every language"
```

---

### Task 12: Вкладка «Синхронизация с Access»

**Files:**
- Create: `frontend/src/components/AccessSyncPanel.jsx`
- Modify: `frontend/src/components/AdminPanel.jsx` (импорт рядом с `GoogleUsersPanel`; `function UsersTab`)

**Interfaces:**
- Consumes: `api.admin.getAccessSync/saveAccessSync/runAccessSync` и функции `utils/accessSync.js` (Task 9); строки Task 11.
- Produces: в режиме `google` раздел «Пользователи» получает подвкладку `accesssync` между «Пользователи» и «Системная почта».

- [ ] **Step 1: Write the component**

`frontend/src/components/AccessSyncPanel.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  accessSyncForm, accessSyncFormError, accessSyncIdleKey, accessSyncPayload, accessSyncRunSummary, accessSyncSaveErrorKey,
} from '../utils/accessSync.js';

const fieldStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4 };
const buttonStyle = {
  padding: '9px 16px', borderRadius: 7, fontSize: 13, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const primaryButtonStyle = { ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' };

const ID_FIELDS = [
  { field: 'accountId', labelKey: 'admin.accessSync.accountId' },
  { field: 'appId', labelKey: 'admin.accessSync.appId' },
  { field: 'policyId', labelKey: 'admin.accessSync.policyId' },
];

// Cloudflare Access sync settings and the last run (AUTH_MODE=google). The API token is only ever
// sent to the server; the form learns just whether one is stored.
export default function AccessSyncPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(() => accessSyncForm(null));
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const apply = (next) => {
    setData(next);
    setForm(accessSyncForm(next.config));
  };

  useEffect(() => {
    api.admin.getAccessSync()
      .then(apply)
      .catch((err) => setLoadError(err.message));
  }, []);

  if (!data) {
    return (
      <div style={{ color: loadError ? 'var(--red)' : 'var(--text-tertiary)', fontSize: 13 }}>
        {loadError ? t('admin.accessSync.loadFailed', { message: loadError }) : t('common.loading')}
      </div>
    );
  }

  const update = (field, value) => {
    setNotice('');
    setForm((current) => ({ ...current, [field]: value }));
  };

  const act = async (action) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err) {
      const key = accessSyncSaveErrorKey(err.code);
      setError(key ? t(key) : err.message);
    } finally {
      setBusy(false);
    }
  };

  const save = () => act(async () => {
    apply(await api.admin.saveAccessSync(accessSyncPayload(form)));
    setNotice(t('admin.accessSync.saved'));
  });

  // A manual run refreshes the status but keeps unsaved edits in the form.
  const runNow = () => act(async () => {
    const next = await api.admin.runAccessSync();
    setData(next);
    const idleKey = accessSyncIdleKey(next.result);
    if (idleKey) setNotice(t(idleKey));
  });

  const formErrorKey = accessSyncFormError(form, data.config.apiTokenSet);
  const summary = accessSyncRunSummary(data.lastRun, data.maxDisables);
  const troubled = data.lastRun?.outcome === 'failed' || data.lastRun?.outcome === 'aborted';

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.accessSync.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        {t('admin.accessSync.description')}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); if (!formErrorKey && !busy) save(); }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)' }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => update('enabled', e.target.checked)} />
          {t('admin.accessSync.enabled')}
        </label>
        {ID_FIELDS.map(({ field, labelKey }) => (
          <label key={field}>
            <span style={labelStyle}>{t(labelKey)}</span>
            <input
              type="text"
              value={form[field]}
              onChange={(e) => update(field, e.target.value)}
              autoComplete="off"
              spellCheck={false}
              style={fieldStyle}
            />
          </label>
        ))}
        <label>
          <span style={labelStyle}>{t('admin.accessSync.apiToken')}</span>
          <input
            type="password"
            value={form.apiToken}
            onChange={(e) => update('apiToken', e.target.value)}
            autoComplete="new-password"
            placeholder={data.config.apiTokenSet ? t('admin.accessSync.apiTokenStored') : undefined}
            style={fieldStyle}
          />
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
            {t('admin.accessSync.apiTokenHint')}
          </span>
        </label>
        {formErrorKey && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t(formErrorKey)}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="submit" disabled={busy || !!formErrorKey} style={primaryButtonStyle}>
            {t('admin.accessSync.save')}
          </button>
          <button type="button" onClick={runNow} disabled={busy} style={buttonStyle}>
            {busy ? t('admin.accessSync.running') : t('admin.accessSync.runNow')}
          </button>
        </div>
      </form>

      <div
        style={{
          marginTop: 20, padding: '12px 14px', borderRadius: 8, background: 'var(--bg-tertiary)',
          border: '1px solid var(--border-subtle)', fontSize: 13, maxWidth: 520, boxSizing: 'border-box',
        }}
      >
        <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>
          {data.lastRun
            ? t('admin.accessSync.lastRun', { time: new Date(data.lastRun.finishedAt).toLocaleString() })
            : t('admin.accessSync.neverRun')}
        </div>
        {summary && (
          <div style={{ color: troubled ? 'var(--red)' : 'var(--text-primary)', overflowWrap: 'anywhere' }}>
            {t(summary.key, { ...summary.values, error: summary.errorKey ? t(summary.errorKey) : summary.values.error })}
          </div>
        )}
        <div style={{ color: 'var(--text-tertiary)', fontSize: 12, marginTop: 6 }}>
          {t('admin.accessSync.limit', { max: data.maxDisables })}
        </div>
      </div>

      {!data.googleMode && (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.accessSync.notGoogleMode')}</div>
      )}
      {error && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--red)' }}>{error}</div>}
      {notice && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>{notice}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Add the tab in google mode**

В `frontend/src/components/AdminPanel.jsx`:

1. После строки `import GoogleUsersPanel from './GoogleUsersPanel.jsx';` добавить:

```jsx
import AccessSyncPanel from './AccessSyncPanel.jsx';
```

2. Заменить функцию `UsersTab` на:

```jsx
function UsersTab() {
  const { t } = useTranslation();
  const { user } = useStore();
  const googleAuth = isGoogleAuthMode(user);
  return (
    <SubTabs tabs={[
      { id: 'users', label: t('admin.systemEmail.tabUsers'), content: googleAuth ? <GoogleUsersPanel /> : <UsersAndInvitesPanel /> },
      // Approved users are kept in the Cloudflare Access policy only in google mode.
      ...(googleAuth ? [{ id: 'accesssync', label: t('admin.accessSync.tab'), content: <AccessSyncPanel /> }] : []),
      { id: 'systememail', label: t('admin.systemEmail.tabEmail'), content: <SystemEmailSection /> },
    ]} />
  );
}
```

- [ ] **Step 3: Run the frontend suite, lint and build**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: все тесты PASS, включая `src/locales/i18n.test.js` (все четыре набора); lint без ошибок; сборка проходит.

Если lint ругается на зависимости `useEffect` в `AccessSyncPanel.jsx`, сравнить с `GoogleUsersPanel.jsx`, где тот же эффект с `[]` проходит lint, и привести к тому же виду, не отключая правило.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AccessSyncPanel.jsx frontend/src/components/AdminPanel.jsx
git commit -m "feat(access-sync): add the Access policy sync tab for admins"
```

---

### Task 13: Полный прогон, проверка на сервере и в браузере, документы, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`
- Modify: `docs/architecture/codebase-file-map.md`
- Scratch, не коммитится: `<scratchpad>/fake-cloudflare.mjs`, `<scratchpad>/access-http.mjs`, `<scratchpad>/boot-pr6.sh`, `<scratchpad>/pr6-body.md`; временно `frontend/.env.local`, `.claude/launch.json` и правка `frontend/src/demo/index.js` для проверки в браузере

- [ ] **Step 1: Full backend run and lint**

Run: `bt`, затем lint (`npm run lint && npm run lint:plugins` в той же команде).
Expected: все тесты PASS, lint без ошибок. Записать число тестов для описания PR.

- [ ] **Step 2: Sync against a fake Cloudflare on a running server**

Сервер стартует в режиме `google` с Postgres 16 и Redis. Поддельный Cloudflare на `127.0.0.1:4010` отдаёт ключи для токена Access (`CF_ACCESS_ISSUER`) и API политики (`CF_API_BASE`). Администратор входит токеном Access как bootstrap-админ.

Сеть и базы:

```bash
docker network create mailexpert-check
docker run -d --name mailexpert-check-db --network mailexpert-check -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=check -e POSTGRES_DB=mailexpert postgres:16-alpine
docker run -d --name mailexpert-check-redis --network mailexpert-check redis:7-alpine
docker network connect mailexpert-check mailexpert-backend-test
```

`<scratchpad>/fake-cloudflare.mjs`:

```js
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const ISSUER = 'http://127.0.0.1:4010';
const POLICY_PATH = '/accounts/0123456789abcdef0123456789abcdef/access/apps/11111111-2222-4333-8444-555555555555/policies/66666666-7777-4888-9999-000000000000';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'smoke', alg: 'RS256', use: 'sig' };
const adminToken = await new SignJWT({ email: 'admin@example.com' })
  .setProtectedHeader({ alg: 'RS256', kid: 'smoke' })
  .setIssuer(ISSUER).setAudience('smoke-aud').setIssuedAt().setExpirationTime('1h')
  .sign(privateKey);
writeFileSync('/tmp/cf-admin-token', adminToken);

let policy = {
  id: '66666666-7777-4888-9999-000000000000', uid: 'uid-1', name: 'Allow approved', decision: 'allow',
  reusable: false, precedence: 1, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  include: [{ email: { email: 'admin@example.com' } }, { email: { email: 'contractor@example.net' } }, { email_domain: { domain: 'partner.example' } }],
  exclude: [], require: [],
};
let puts = 0;

const readBody = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
};

http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/cdn-cgi/access/certs') return send(200, { keys: [jwk] });
  // Test hooks: read the policy and the number of writes, or edit it as an admin would in Cloudflare.
  if (req.url === '/_smoke/policy' && req.method === 'GET') return send(200, { policy, puts });
  if (req.url === '/_smoke/policy' && req.method === 'POST') {
    policy = { ...policy, ...(await readBody(req)) };
    return send(200, {});
  }
  if (req.headers.authorization !== 'Bearer smoke-token') {
    return send(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
  }
  if (req.url === POLICY_PATH && req.method === 'GET') return send(200, { success: true, errors: [], result: policy });
  if (req.url === POLICY_PATH && req.method === 'PUT') {
    const body = await readBody(req);
    if (['id', 'uid', 'created_at', 'updated_at', 'reusable'].some((field) => field in body) || !body.name || !body.decision) {
      return send(400, { success: false, errors: [{ code: 12000, message: 'bad policy' }] });
    }
    puts += 1;
    policy = { ...policy, ...body, updated_at: new Date().toISOString() };
    return send(200, { success: true, errors: [], result: policy });
  }
  return send(404, { success: false, errors: [{ code: 7003 }] });
}).listen(4010, '127.0.0.1', () => console.log('fake cloudflare ready'));
```

`<scratchpad>/access-http.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const base = 'http://127.0.0.1:3000';
const cf = 'http://127.0.0.1:4010';
const H = {
  'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json',
  'cf-access-jwt-assertion': readFileSync('/tmp/cf-admin-token', 'utf8'),
};
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
};
const cfState = async () => (await fetch(`${cf}/_smoke/policy`)).json();
const setInclude = (include) => fetch(`${cf}/_smoke/policy`, { method: 'POST', body: JSON.stringify({ include }) });
const listed = (policy) => policy.include.filter((rule) => rule.email).map((rule) => rule.email.email).sort();
// Background runs requested by user changes may do the work first, so checks look at the
// resulting state, not at which run changed it.
const runNow = async () => {
  const { status, body } = await call('POST', '/api/admin/access-sync/run');
  assert.equal(status, 200);
  assert.notEqual(body.result.outcome, 'failed', JSON.stringify(body.result));
  return body;
};
const active = async () => (await call('GET', '/api/admin/users')).body.users.filter((u) => !u.disabledAt).map((u) => u.email).sort();
const pause = () => new Promise((resolve) => setTimeout(resolve, 500));

assert.equal((await call('GET', '/api/auth/me')).status, 200, 'the bootstrap admin signs in through Access');

const empty = await call('GET', '/api/admin/access-sync');
assert.deepEqual(empty.body.config, { enabled: false, accountId: '', appId: '', policyId: '', apiTokenSet: false });
assert.equal(empty.body.googleMode, true);
assert.equal(empty.body.maxDisables, 1);

const saved = await call('PUT', '/api/admin/access-sync', {
  enabled: true, accountId: '0123456789abcdef0123456789abcdef', appId: '11111111-2222-4333-8444-555555555555',
  policyId: '66666666-7777-4888-9999-000000000000', apiToken: 'smoke-token',
});
assert.equal(saved.status, 200);
assert.equal(saved.body.config.apiTokenSet, true);
assert.ok(!saved.text.includes('smoke-token'), 'the token is never returned');

for (const email of ['one@example.com', 'two@example.com', 'three@example.com']) {
  assert.equal((await call('POST', '/api/admin/users', { email })).status, 201);
}
await runNow();
let state = await cfState();
assert.deepEqual(listed(state.policy), ['admin@example.com', 'contractor@example.net', 'one@example.com', 'three@example.com', 'two@example.com']);
assert.ok(state.policy.include.some((rule) => rule.email_domain?.domain === 'partner.example'), 'domain rules stay');

const again = await runNow();
assert.equal(again.result.outcome, 'unchanged');
assert.equal((await cfState()).puts, state.puts, 'a run in line writes nothing');

// two@ is removed in Cloudflare: the user is disabled and the journal names the sync.
await setInclude(state.policy.include.filter((rule) => rule.email?.email !== 'two@example.com'));
await runNow();
assert.deepEqual(await active(), ['admin@example.com', 'one@example.com', 'three@example.com'].sort());
await pause();
const disabledEntry = (await call('GET', '/api/admin/audit?action=user.disabled')).body.entries[0];
assert.equal(disabledEntry.actorEmail, 'Cloudflare Access');
assert.equal(disabledEntry.details.email, 'two@example.com');
assert.equal(disabledEntry.details.source, 'cloudflare_access');

// one@ is disabled in MailExpert: its email leaves the policy, the foreign email stays.
const users = (await call('GET', '/api/admin/users')).body.users;
assert.equal((await call('PATCH', `/api/admin/users/${users.find((u) => u.email === 'one@example.com').id}`, { disabled: true })).status, 200);
await runNow();
assert.deepEqual(listed((await cfState()).policy), ['admin@example.com', 'contractor@example.net', 'three@example.com']);

// Removing three users in Cloudflare is above ACCESS_SYNC_MAX_DISABLES=1: nothing changes.
for (const email of ['four@example.com', 'five@example.com']) {
  assert.equal((await call('POST', '/api/admin/users', { email })).status, 201);
}
await runNow();
state = await cfState();
const gone = ['three@example.com', 'four@example.com', 'five@example.com'];
await setInclude(state.policy.include.filter((rule) => !gone.includes(rule.email?.email)));
const stopped = await runNow();
assert.equal(stopped.result.outcome, 'aborted');
assert.equal(stopped.result.wouldDisable, 3);
assert.equal((await cfState()).puts, state.puts, 'a stopped run writes nothing');
assert.deepEqual(await active(), ['admin@example.com', 'five@example.com', 'four@example.com', 'three@example.com']);
await runNow();
await pause();
const aborted = (await call('GET', '/api/admin/audit?action=access.sync_aborted')).body.entries;
assert.equal(aborted.length, 1, 'the same stop is journaled once');
assert.deepEqual(aborted[0].details.candidates, ['five@example.com', 'four@example.com', 'three@example.com']);
assert.ok(listed((await cfState()).policy).includes('admin@example.com'), 'the bootstrap admin stays');

console.log('access sync http ok');
```

`<scratchpad>/boot-pr6.sh`:

```sh
cd /work/backend
# Stop processes left over from an earlier run; the slim image has no pkill.
node -e "
const fs=require('fs');
for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue;
  try { const c=fs.readFileSync('/proc/'+d+'/cmdline','utf8').replace(/\0/g,' ').trim();
    if (c==='node src/index.js' || c==='node fake-cloudflare.mjs') process.kill(+d); } catch {} }"
sleep 2
node fake-cloudflare.mjs > /tmp/fake-cf.log 2>&1 &
CF=$!
sleep 2
env DB_HOST=mailexpert-check-db DB_USER=mailexpert DB_NAME=mailexpert DB_PASSWORD=check \
  SESSION_SECRET=0123456789abcdef0123456789abcdef0123 \
  REDIS_URL=redis://mailexpert-check-redis:6379 ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  NODE_ENV=development PORT=3000 IMAP_CONNECT_CONCURRENCY=1 \
  AUTH_MODE=google CF_ACCESS_ISSUER=http://127.0.0.1:4010 CF_ACCESS_AUDIENCE=smoke-aud \
  BOOTSTRAP_ADMIN_EMAILS=admin@example.com CF_API_BASE=http://127.0.0.1:4010 ACCESS_SYNC_MAX_DISABLES=1 \
  node src/index.js > /tmp/boot.log 2>&1 &
PID=$!
for i in $(seq 1 60); do
  if ! kill -0 $PID 2>/dev/null; then echo "process exited"; tail -20 /tmp/boot.log; kill $CF; exit 1; fi
  if node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done
node access-http.mjs 2>&1 | tail -8
echo "--- errors after requests"
grep -E "\[access-sync\]|\[audit\]|column .* does not exist|relation .* does not exist|syntax error" /tmp/boot.log | head -5
echo "--- secrets in the log"
grep -c "smoke-token" /tmp/boot.log
kill $PID $CF
```

Run:

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work'
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/fake-cloudflare.mjs" mailexpert-backend-test:/work/backend/fake-cloudflare.mjs
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/access-http.mjs" mailexpert-backend-test:/work/backend/access-http.mjs
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/boot-pr6.sh" mailexpert-backend-test:/work/backend/boot-pr6.sh
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh /work/backend/boot-pr6.sh
```

`<scratchpad>` в `docker cp` — Windows-путь с прямыми слэшами (`C:/Users/.../scratchpad/file`).

Expected: `access sync http ok`; после `--- errors after requests` пусто; после `--- secrets in the log` — `0`.

Если проверка падает на входе (401/403 на `/api/auth/me`), сначала проверить скрипт и переменные окружения, а не маршруты. Если отказ указывает на ошибку в коде синхронизации — остановиться и разобраться по superpowers:systematic-debugging.

Cleanup:

```bash
docker network disconnect mailexpert-check mailexpert-backend-test
docker rm -f mailexpert-check-db mailexpert-check-redis
docker network rm mailexpert-check
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /work/backend && rm -f fake-cloudflare.mjs access-http.mjs boot-pr6.sh'
```

- [ ] **Step 3: Check the tab in the browser pane**

Демо-режим работает в режиме входа `local`, а вкладка есть только в `google`. Для проверки временно (не коммитить):
- в `frontend/src/demo/index.js` у `DEMO_USER` поменять `authMode: 'local'` на `authMode: 'google'`;
- там же перед обработчиком `GET /admin/audit` добавить `if (verb === 'GET' && pathname === '/admin/users') return { users: [], total: 0 };` — без него вкладка «Пользователи» в режиме `google` не загрузится.

`frontend/.env.local`:

```
VITE_DEMO_MODE=true
```

`.claude/launch.json`:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "frontend-demo",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["--prefix", "frontend", "run", "dev", "--", "--port", "5174", "--strictPort"],
      "port": 5174
    }
  ]
}
```

Запустить `preview_start` с `name: "frontend-demo"`. Настройки открываются через Ctrl+K → «Open Settings». Проверить:
1. «Users» → подвкладки «Users», «Access policy sync», «System email».
2. «Access policy sync»: переключатель включён, три ID заполнены, поле токена пустое с подсказкой «A token is stored…», строка «Last run …» и «Policy updated: 1 added, 0 removed, 0 users disabled.», строка про лимит с числом 10.
3. Account ID `abc` — под формой «The account ID is 32 hexadecimal characters…», кнопка «Save settings» неактивна; вернуть прежнее значение.
4. «Sync now» — строка итога меняется на «Policy was already up to date; 0 users disabled.».
5. Выключить переключатель, «Save settings» — «Settings saved»; «Sync now» — «The sync is off or not filled in.»; включить и сохранить обратно.
6. «Audit log»: первая запись — «Access sync stopped», автор «Cloudflare Access», подробности «Would disable (2): …».
7. Язык «Appearance → Language & Font» → русский: подвкладка «Синхронизация с Access», строки на русском. Вернуть английский.
8. В консоли нет ошибок (`read_console_messages` с `onlyErrors: true`).
9. Ширина 375 px (`resize_window` `preset: "mobile"`, затем перезагрузка): поля и кнопки помещаются, горизонтальной прокрутки страницы нет. Вернуть `preset: "desktop"`.

После проверки: `preview_stop`; откатить временную правку демо (`git diff frontend/src/demo/index.js` пуст); удалить `frontend/.env.local` и `.claude/launch.json`; `git status --short` чистый.

- [ ] **Step 4: Record the clarifications in the spec and the file map**

В `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`:

1. В строке статуса заменить `PR 4 (журнал) и PR 5 (интерфейс журнала) реализованы.` на `PR 4 (журнал), PR 5 (интерфейс журнала) и PR 6 (синхронизация с Cloudflare Access) реализованы.`

2. После последнего пункта раздела «Уточнения, принятые при реализации PR 5» добавить:

```markdown

## Уточнения, принятые при реализации PR 6

- Миграции нет: `system_settings` хранит `access_sync_config` (`enabled`, `accountId`, `appId`, `policyId`, зашифрованный `apiToken`) и `access_sync_state` (`baseline`, `abortedCandidates`, `lastRun`). Смена account id, app id или policy id сбрасывает baseline.
- `GET /api/admin/access-sync` отдаёт `apiTokenSet` вместо токена; пустое поле токена при сохранении оставляет сохранённый. `PUT` сохраняет, `POST /api/admin/access-sync/run` запускает прогон и ждёт результат.
- Право токена в панели Cloudflare называется «Access: Apps and Policies Write».
- `email_domain`-правила MailExpert только читает. Домен пропускает email, если он есть в `include`, а email и домен не перечислены в `exclude`.
- Политика без единого `email`-правила не считается удалением пользователей. Политика с `decision` не `allow` не записывается.
- Порог «больше половины активных» — `кандидаты × 2 > активные`; `ACCESS_SYNC_MAX_DISABLES=0` останавливает любой прогон с отключениями. Остановленный прогон ничего не меняет и пишет `access.sync_aborted` (`details: { candidates, activeUsers, maxDisables }`) только при новом наборе кандидатов.
- Отключение из Cloudflare пишет `user.disabled` с `details.source = 'cloudflare_access'`, автор записей синхронизации — `Cloudflare Access` (`actorEmail` без пользователя). Последний активный администратор не отключается и остаётся в политике.
- Запуск: при старте сервера, раз в час, после сохранения включённых настроек и после добавления, отключения, включения, смены email и удаления пользователя; запросы в течение 10 секунд сливаются. Прогоны и сохранение настроек идут по одному в процессе. Воркер запускается только при `AUTH_MODE=google`.
- Пользователи, созданные первым входом через Cloudflare, попадают в политику отдельным `email`-правилом при следующем прогоне.
- `CF_API_BASE` переопределяет адрес API Cloudflare для проверки на тестовом сервере.
- Вкладка — «Пользователи → Синхронизация с Access», только в режиме `google`.
```

В `docs/architecture/codebase-file-map.md`:

1. В списке «Безопасность и инфраструктура backend» после строки про `auditLog.js` добавить:

```markdown
- `accessSync/` — синхронизация одобренных пользователей с Allow-политикой Cloudflare Access: клиент API (`cloudflareAccessClient.js`), чистая трёхсторонняя сверка (`reconcile.js`), настройки с зашифрованным токеном (`settings.js`), прогон (`runner.js`) и один исполнитель на процесс (`scheduler.js`, `index.js`). `auth/userStatus.js` — проверки последнего администратора и отключение по email.
```

2. В таблице маршрутов после строки `routes/admin.js` добавить:

```markdown
| `routes/accessSync.js` | Настройки и ручной запуск синхронизации с Cloudflare Access; монтируется в `routes/admin.js` |
```

3. После строки про `AuditLogTab.jsx` добавить:

```markdown
- `AccessSyncPanel.jsx` — вкладка синхронизации с Cloudflare Access в режиме `google`; логика формы и итога прогона в `utils/accessSync.js`.
```

- [ ] **Step 5: Commit the docs**

```bash
git add docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md docs/architecture/codebase-file-map.md
git commit -m "docs: record the Access policy sync clarifications"
```

- [ ] **Step 6: Push and open the PR**

`<scratchpad>/pr6-body.md`:

```markdown
PR 6 of the shared mailboxes series: MailExpert becomes the only place where users are approved. A background sync keeps the Allow policy of the Cloudflare Access application in line with active users.

## What changes

- `services/accessSync/`:
  - Cloudflare Access client: reads and writes the policy whole (`PUT`, reusable policies through the account endpoint), strips read-only fields, reports only status and error codes.
  - Three-way reconcile against a stored baseline: MailExpert removes only emails it wrote; foreign emails, groups and `email_domain` rules stay; an email removed in Cloudflare disables the user unless a domain rule still admits them; bootstrap admins are never removed or disabled; an empty include list is never written.
  - Safety stop: a run that would disable more than `ACCESS_SYNC_MAX_DISABLES` (10) users or more than half of the active users changes nothing and writes `access.sync_aborted` to the audit log.
  - One runner per process: user changes request a run (debounced 10 s), a full reconcile runs hourly, manual runs and settings changes never overlap. Starts only with `AUTH_MODE=google`.
- Settings live in `system_settings`; the API token is stored encrypted and never returned.
- Admin API: `GET`/`PUT /api/admin/access-sync`, `POST /api/admin/access-sync/run`.
- Users disabled by the sync lose their sessions and sockets and are journaled as `user.disabled` by `Cloudflare Access`. The last active admin is never disabled.
- Admin guards moved to `services/auth/userStatus.js`.
- Frontend: "Users → Access policy sync" tab in google mode, demo mode answers, strings in all 9 languages, the new audit action on the audit screen.

## Checks

- Backend: <N> tests, lint clean.
- Frontend: <M> tests, lint, build.
- Running server in google mode against a fake Cloudflare API: approved users join the policy with foreign rules kept; a second run writes nothing; removing a user in Cloudflare disables them and journals it; disabling a user in MailExpert removes their email; removing three users is stopped by the limit with one audit entry; the token never appears in responses or logs.
- Browser (demo mode switched to google mode locally): the tab, validation, manual run, off state, the audit entry, Russian strings, 375 px width.
- Not checked against a real Cloudflare account.
```

Подставить числа тестов из Step 1 и Task 12.

```bash
git push -u origin feat/access-policy-sync
gh pr create --repo wyrtensi/MailExpert --base main --head feat/access-policy-sync --title "feat(access-sync): keep the Cloudflare Access policy in line with approved users" --body-file "<scratchpad>/pr6-body.md"
```

---

## Self-review

- **Покрытие спецификации:**
  - источник правды и приведение `include` — Tasks 4, 6;
  - учётные данные в `system_settings`, зашифрованный токен только на запись — Tasks 5, 8, 12;
  - `PUT` целиком, эндпоинты reusable и приложения, read-only поля — Task 3;
  - трёхсторонняя сверка, чужие правила, отключение с учётом `email_domain` — Tasks 4, 6;
  - `BOOTSTRAP_ADMIN_EMAILS`, пустой `include` — Tasks 4, 6;
  - порог и событие журнала — Tasks 1, 4, 6, 9;
  - немедленный запуск при добавлении и отключении, раз в час — Tasks 7, 8;
  - состояние последнего прогона для администратора — Tasks 8, 12;
  - «Не входит: управление `email_domain`» — Global Constraints, Task 4.
- **Заглушки:** нет; в тестах выдуманные id и адреса `example.com`.
- **Согласованность имён:** `recordAudit({ actorEmail })`, `disableUsersByEmail`, `createCloudflareAccessClient`, `CloudflareAccessError`, `removedInCloudflare`, `exceedsDisableLimit`, `buildInclude`, `loadRunConfig`, `saveConfig`, `runAccessSync`, `createAccessSyncScheduler`, `startAccessSync`, `requestAccessSync`, `runAccessSyncNow`, `withAccessSyncLock`, `accessSyncRunSummary`, `accessSyncIdleKey` одинаковы во всех задачах; поля `lastRun` (`added`, `removed`, `disabled`, `wouldDisable`, `error`) совпадают на бэкенде, во фронтенде и в демо.
