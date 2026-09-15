# Общие ящики, PR 2: сервер обслуживает ящики — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. В этом проекте пользователь выполняет планы без субагентов: использовать superpowers:executing-plans.

**Goal:** IMAP-ящики подключает и обслуживает сервер: при старте все включённые ящики встают в очередь, вход, выход и WebSocket больше не подключают и не отключают ящики, ручная синхронизация работает только по одному ящику с защитой от повторов, а интервалы синхронизации становятся системной настройкой администратора.

**Architecture:** `ImapManager.connectAllEnabled()` при старте ставит все включённые IMAP-ящики в очередь с ограничением `IMAP_CONNECT_CONCURRENCY` и прежним разносом запусков по провайдерам; health check не трогает ящики, ждущие очереди. Методы `connectAllForUser` и `disconnectUser` удаляются вместе со всеми вызовами из входа, выхода, OIDC и WebSocket. Новый модуль `syncSettings.js` читает `sync_interval_sec` и `folder_sync_interval_sec` из `system_settings`; менеджер держит один интервал на установку и перезапускает таймеры через `applySyncSettings`. `POST /api/mail/sync` и `/sync-folders` требуют `accountId` и спрашивают менеджер `requestSync` / `requestFolderSync`, который синхронно решает, запускать ли синхронизацию. Фронтенд всегда передаёт ящик, а выбор интервалов переезжает из личных настроек в админский раздел «Безопасность».

**Tech Stack:** Node.js 22, Express 5, PostgreSQL 16, imapflow, vitest 5; React 19, zustand, react-i18next, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` — разделы «Сервер обслуживает ящики», «Разбиение на PR» (пункт 2) и «Проверка» (тест `imapManager`).

## Global Constraints

- Комментарии в коде — только на английском.
- Коммиты и PR от имени `wyrtensi`, без строк атрибуции; все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- В документах, коммитах и PR — только заглушки `<CF_HOST>`, `<DIRECT_HOST>`, `<TEAM>`, `<AUD>`; внутренние имена других проектов не упоминаются.
- Пароли, токены и email пользователей не попадают в логи; в логах ящика — `logAccount(account)` или id ящика.
- `IMAP_CONNECT_CONCURRENCY` — сколько ящиков подключается одновременно при старте, по умолчанию 3. Это не ограничение числа ящиков: подключаются все. `IMAP_MAX_PERSISTENT_PER_HOST` не меняется.
- Вход, выход, открытие WebSocket, отключение и удаление пользователя не вызывают подключение и отключение ящиков (исключение до PR 3 — ящики, которые удаление пользователя в режиме `local` удаляет каскадом, см. уточнение 3). Восстановление упавших соединений остаётся внутри `imapManager`.
- `POST /api/mail/sync` и `POST /api/mail/sync-folders` без `accountId` отвечают 400 `{ error, code: 'account_required' }`. Повтор по ящику, у которого синхронизация идёт или завершилась меньше 15 секунд назад, отвечает `{ ok: true, skipped: true }`.
- `POST /api/accounts/:id/reconnect` при уже идущем подключении отвечает `{ ok: true, skipped: true }` и ничего не запускает.
- Системные настройки: `sync_interval_sec` из `15, 30, 60, 120` (по умолчанию 60) и `folder_sync_interval_sec` из `0, 900, 1800, 3600` (по умолчанию 1800, `0` — никогда). Меняет только администратор. Поля `syncInterval` и `folderSyncInterval` из личных настроек убираются.
- Проверка владельца ящика (`user_id = $n`) в маршрутах остаётся до PR 3.
- Монки-патчинг запрещён.
- Backend-тесты запускаются в `node:22-bookworm-slim` (локальный Node 24 не подходит под `engines`). Frontend-тесты, lint и сборка — локально в `frontend/`.
- Работа идёт в ветке `feat/server-serviced-mailboxes` от `main` (в ней уже лежит этот план).

## Уточнения спецификации в этом PR

Task 7 вносит их в спецификацию.

1. **Очередь при старте сохраняет разнос запусков по провайдерам** (`connectStaggerFor`, #218). Ящики, ждущие очереди, health check пропускает. Перед подключением строка ящика перечитывается: ящик, выключенный или изменённый за время ожидания, подключается по свежим данным или пропускается.
2. **«Синхронизация завершилась меньше 15 секунд назад»:** для писем — любая успешная синхронизация INBOX ящика (по интервалу, poll-only или ручная, `lastSyncOkAt`); для структуры папок — отметка `lastFolderSyncAt`. Выключенный ящик и ящик не по IMAP отвечают `skipped` без запуска.
3. **Удаление пользователя в режиме `local` до PR 3 каскадно удаляет его ящики.** Поэтому удаление отключает именно эти ящики, как `DELETE /api/accounts/:id`, а не «пользователя».
4. **Интервалы выбираются из фиксированных наборов**, как в прежнем интерфейсе. Настройка живёт в админке, вкладка «Безопасность», рядом с политикой подключения к почтовым серверам. Клиент получает интервал писем в `GET /api/auth/preferences` только для резервного обновления списка без WebSocket.
5. **Единая лента и действие «sync» десктопных уведомлений** запрашивают синхронизацию каждого включённого IMAP-ящика отдельным запросом.
6. **`setupWebSocket(wss, sessionMiddleware, options)`** больше не получает `imapManager`.

## Как запускать тесты

Backend. Один раз за сессию поднять контейнер и поставить зависимости (если контейнер уже есть — `docker rm -f mailexpert-backend-test` и заново):

```bash
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test -v "D:/hub/workspace/Projects/MailExpert:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && echo ready'
```

Запуск конкретных файлов (синхронизирует рабочее дерево в контейнер):

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npx vitest run <files>'
```

Ниже в шагах это записано как `bt <files>`. Полный прогон: `bt` без файлов, затем `npm run lint && npm run lint:plugins` той же командой вместо `npx vitest run`.

Frontend (из корня репозитория): `cd frontend && node --test <files>`; полный прогон — `cd frontend && npm test && npm run lint && npm run build`. Если сборка падает на отсутствующем `@tailwindcss/vite`, сначала `cd frontend && npm ci`: локальные `node_modules` устарели.

## Файлы

| Файл | Ответственность |
|---|---|
| Create `backend/src/services/syncSettings.js` (+ test) | Системные интервалы синхронизации: допустимые значения, чтение из `system_settings` |
| Create `backend/migrations/0055_system_sync_intervals.sql` | Перенос интервалов из личных настроек в `system_settings` |
| Modify `backend/src/services/imapManager.js` | Очередь при старте, удаление пользовательского жизненного цикла, системные интервалы, ручная синхронизация одного ящика |
| Create `backend/src/services/imapManager.serverMailboxes.test.js` | Тесты очереди, независимости от входа, интервалов и защиты от повторов |
| Modify `backend/src/services/imapManager.oauthRefresh.test.js` | Старт через `connectAllEnabled` |
| Modify `backend/src/index.js` | Интервалы и очередь при старте; `setupWebSocket` без менеджера |
| Modify `backend/src/services/websocket.js` (+ test) | Подключение сокета не трогает ящики |
| Modify `backend/src/routes/auth.js` (+ `auth.preferences.test.js`, `auth.config.test.js`, `auth.sessions.test.js`) | Вход и выход без ящиков; личные настройки без интервалов; интервал писем в ответе настроек |
| Modify `backend/src/routes/oidc.js` | Вход без ящиков |
| Modify `backend/src/routes/admin.js` (+ `admin.users.test.js`, new `admin.syncSettings.test.js`) | Удаление пользователя отключает удаляемые ящики; системные интервалы в `PATCH /settings` |
| Modify `backend/src/routes/mail.js` (+ new `mail.sync.test.js`) | Синхронизация одного ящика |
| Modify `backend/src/routes/accounts.js` (+ `accounts.reconnectCooldown.test.js`) | Повторное переподключение ничего не запускает |
| Modify `.env.example`, `docker-compose.yml` | `IMAP_CONNECT_CONCURRENCY` |
| Create `frontend/src/utils/mailboxSync.js` (+ test) | Какие ящики синхронизировать, пропуск, чтение интервалов |
| Modify `frontend/src/utils/api.js`, `frontend/src/components/MessageList.jsx`, `frontend/src/components/ElectronNotificationBridge.jsx` | Синхронизация всегда с ящиком |
| Modify `frontend/src/store/index.js` | Интервал писем только для чтения |
| Create `frontend/src/components/MailboxSyncSettings.jsx`; Modify `frontend/src/components/AdminPanel.jsx` | Интервалы в админке вместо личных настроек |
| Modify `frontend/src/locales/*.json` | Заголовок и описание раздела |
| Modify `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` | Уточнения и статус |

---

### Task 1: Системные интервалы синхронизации: модуль и миграция

**Files:**
- Create: `backend/src/services/syncSettings.js`
- Test: `backend/src/services/syncSettings.test.js`
- Create: `backend/migrations/0055_system_sync_intervals.sql`
- Scratch: `<scratchpad>/sync-settings-smoke.mjs` (не коммитится)

**Interfaces:**
- Produces:
  - `SYNC_INTERVAL_KEY = 'sync_interval_sec'`, `FOLDER_SYNC_INTERVAL_KEY = 'folder_sync_interval_sec'`;
  - `SYNC_INTERVAL_CHOICES_SEC = [15, 30, 60, 120]`, `FOLDER_SYNC_INTERVAL_CHOICES_SEC = [0, 900, 1800, 3600]`;
  - `DEFAULT_SYNC_INTERVAL_SEC = 60`, `DEFAULT_FOLDER_SYNC_INTERVAL_SEC = 1800`;
  - `parseSyncIntervalSec(value) → number | null`, `parseFolderSyncIntervalSec(value) → number | null` (число или строка из цифр, только из набора);
  - `loadSyncSettings(queryFn = query) → Promise<{ syncIntervalSec: number, folderSyncIntervalSec: number }>`.

- [ ] **Step 1: Write the failing test**

`backend/src/services/syncSettings.test.js`:

```js
import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import {
  DEFAULT_FOLDER_SYNC_INTERVAL_SEC, DEFAULT_SYNC_INTERVAL_SEC, FOLDER_SYNC_INTERVAL_KEY, SYNC_INTERVAL_KEY,
  loadSyncSettings, parseFolderSyncIntervalSec, parseSyncIntervalSec,
} from './syncSettings.js';

describe('parseSyncIntervalSec', () => {
  it('accepts only the offered message intervals', () => {
    expect(parseSyncIntervalSec(30)).toBe(30);
    expect(parseSyncIntervalSec('120')).toBe(120);
    for (const bad of [10, 45, 60.5, '60s', ' 60', '', null, undefined, true]) {
      expect(parseSyncIntervalSec(bad)).toBeNull();
    }
  });
});

describe('parseFolderSyncIntervalSec', () => {
  it('accepts only the offered folder intervals, never included', () => {
    expect(parseFolderSyncIntervalSec(0)).toBe(0);
    expect(parseFolderSyncIntervalSec('3600')).toBe(3600);
    for (const bad of ['', null, undefined, false, 60, '0x10']) {
      expect(parseFolderSyncIntervalSec(bad)).toBeNull();
    }
  });
});

describe('loadSyncSettings', () => {
  it('reads both settings from system_settings', async () => {
    const queryFn = vi.fn(async () => ({
      rows: [{ key: SYNC_INTERVAL_KEY, value: '30' }, { key: FOLDER_SYNC_INTERVAL_KEY, value: '0' }],
    }));
    expect(await loadSyncSettings(queryFn)).toEqual({ syncIntervalSec: 30, folderSyncIntervalSec: 0 });
    expect(queryFn.mock.calls[0][1]).toEqual([[SYNC_INTERVAL_KEY, FOLDER_SYNC_INTERVAL_KEY]]);
  });

  it('falls back to the defaults for missing or broken values', async () => {
    const queryFn = vi.fn(async () => ({ rows: [{ key: SYNC_INTERVAL_KEY, value: 'fast' }] }));
    expect(await loadSyncSettings(queryFn)).toEqual({
      syncIntervalSec: DEFAULT_SYNC_INTERVAL_SEC,
      folderSyncIntervalSec: DEFAULT_FOLDER_SYNC_INTERVAL_SEC,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/services/syncSettings.test.js`
Expected: FAIL — `Failed to resolve import "./syncSettings.js"`.

- [ ] **Step 3: Write the module**

`backend/src/services/syncSettings.js`:

```js
import { query } from './db.js';

// How often mailboxes sync is one install-wide setting: the server services every mailbox, not
// whoever happens to be signed in. Values are seconds, stored as text in system_settings.
export const SYNC_INTERVAL_KEY = 'sync_interval_sec';
export const FOLDER_SYNC_INTERVAL_KEY = 'folder_sync_interval_sec';

export const SYNC_INTERVAL_CHOICES_SEC = Object.freeze([15, 30, 60, 120]);
// 0 turns the periodic folder-structure sync off.
export const FOLDER_SYNC_INTERVAL_CHOICES_SEC = Object.freeze([0, 900, 1800, 3600]);

export const DEFAULT_SYNC_INTERVAL_SEC = 60;
export const DEFAULT_FOLDER_SYNC_INTERVAL_SEC = 1800;

// A number, or a string of digits, that is one of the offered choices; null otherwise.
function pickChoice(value, choices) {
  let seconds = Number.NaN;
  if (typeof value === 'number') seconds = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) seconds = Number(value);
  return choices.includes(seconds) ? seconds : null;
}

export const parseSyncIntervalSec = (value) => pickChoice(value, SYNC_INTERVAL_CHOICES_SEC);
export const parseFolderSyncIntervalSec = (value) => pickChoice(value, FOLDER_SYNC_INTERVAL_CHOICES_SEC);

export async function loadSyncSettings(queryFn = query) {
  const { rows } = await queryFn(
    'SELECT key, value FROM system_settings WHERE key = ANY($1::text[])',
    [[SYNC_INTERVAL_KEY, FOLDER_SYNC_INTERVAL_KEY]],
  );
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    syncIntervalSec: parseSyncIntervalSec(stored[SYNC_INTERVAL_KEY]) ?? DEFAULT_SYNC_INTERVAL_SEC,
    folderSyncIntervalSec: parseFolderSyncIntervalSec(stored[FOLDER_SYNC_INTERVAL_KEY]) ?? DEFAULT_FOLDER_SYNC_INTERVAL_SEC,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bt src/services/syncSettings.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the migration**

`backend/migrations/0055_system_sync_intervals.sql`:

```sql
-- Mailboxes are serviced by the server, so how often they sync is one install-wide setting
-- instead of a preference of whoever signed in. Seed it from the user who owns the most
-- mailboxes when their value is one the settings screen offers, then drop the per-user keys.
WITH top_owner AS (
  SELECT u.preferences
    FROM users u
    JOIN email_accounts a ON a.user_id = u.id
   GROUP BY u.id
   ORDER BY COUNT(*) DESC, u.created_at ASC, u.id ASC
   LIMIT 1
)
INSERT INTO system_settings (key, value, updated_at)
SELECT 'sync_interval_sec',
       COALESCE((SELECT o.preferences->>'syncInterval' FROM top_owner o
                  WHERE o.preferences->>'syncInterval' IN ('15', '30', '60', '120')), '60'),
       NOW()
UNION ALL
SELECT 'folder_sync_interval_sec',
       COALESCE((SELECT o.preferences->>'folderSyncInterval' FROM top_owner o
                  WHERE o.preferences->>'folderSyncInterval' IN ('0', '900', '1800', '3600')), '1800'),
       NOW()
ON CONFLICT (key) DO NOTHING;

UPDATE users
   SET preferences = preferences - 'syncInterval' - 'folderSyncInterval'
 WHERE preferences ?| ARRAY['syncInterval', 'folderSyncInterval'];
```

- [ ] **Step 6: Smoke-test the migration on Postgres 16**

Сохранить в scratchpad сессии `sync-settings-smoke.mjs`:

```js
import assert from 'node:assert/strict';
import { runMigrations } from './src/services/migrations.js';
import { pool, query } from './src/services/db.js';
import { loadSyncSettings } from './src/services/syncSettings.js';

await runMigrations();
// A fresh install has no mailbox owner: the defaults are stored.
assert.deepEqual(await loadSyncSettings(), { syncIntervalSec: 60, folderSyncIntervalSec: 1800 });

const replay0055 = async () => {
  await query("DELETE FROM system_settings WHERE key IN ('sync_interval_sec', 'folder_sync_interval_sec')");
  await query("DELETE FROM schema_migrations WHERE version = '0055_system_sync_intervals'");
  await runMigrations();
};
const user = async (username, preferences) => (await query(
  'INSERT INTO users (username, password_hash, preferences) VALUES ($1, $2, $3) RETURNING id',
  [username, 'x', JSON.stringify(preferences)],
)).rows[0].id;
const mailbox = (userId, n) => query(
  'INSERT INTO email_accounts (user_id, name, email_address, imap_host, imap_port, auth_user, auth_pass) VALUES ($1, $2, $3, $4, 993, $3, $5)',
  [userId, `Mailbox ${n}`, `m${n}@example.com`, 'imap.example.com', 'x'],
);

// The owner of the most mailboxes wins; everyone loses the per-user keys.
const small = await user('small', { syncInterval: '15', folderSyncInterval: '0', theme: 'dark' });
const big = await user('big', { syncInterval: '30', folderSyncInterval: '3600' });
await mailbox(small, 1);
await mailbox(big, 2);
await mailbox(big, 3);
await replay0055();
assert.deepEqual(await loadSyncSettings(), { syncIntervalSec: 30, folderSyncIntervalSec: 3600 });
const prefsOf = async (id) => (await query('SELECT preferences FROM users WHERE id = $1', [id])).rows[0].preferences;
assert.deepEqual(await prefsOf(small), { theme: 'dark' });
assert.deepEqual(await prefsOf(big), {});

// A value the settings screen never offered is not copied.
await query(`UPDATE users SET preferences = '{"syncInterval":"45","folderSyncInterval":"900"}' WHERE id = $1`, [big]);
await replay0055();
assert.deepEqual(await loadSyncSettings(), { syncIntervalSec: 60, folderSyncIntervalSec: 900 });

await pool.end();
console.log('sync settings smoke ok');
```

Run:

```bash
docker network create mailexpert-check
docker run -d --name mailexpert-check-db --network mailexpert-check -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=check -e POSTGRES_DB=mailexpert postgres:16-alpine
docker exec mailexpert-check-db sh -c 'until pg_isready -U mailexpert >/dev/null; do sleep 1; done; sleep 2'
docker network connect mailexpert-check mailexpert-backend-test
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work'
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/sync-settings-smoke.mjs" mailexpert-backend-test:/work/backend/sync-settings-smoke.mjs
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-check-db -e DB_PASSWORD=check mailexpert-backend-test sh -c 'cd /work/backend && node sync-settings-smoke.mjs 2>&1 | tail -5'
```

Expected: последняя строка `sync settings smoke ok`.

Cleanup (Task 7 поднимает базу заново):

```bash
docker network disconnect mailexpert-check mailexpert-backend-test
docker rm -f mailexpert-check-db
docker network rm mailexpert-check
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test rm -f /work/backend/sync-settings-smoke.mjs
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/syncSettings.js backend/src/services/syncSettings.test.js backend/migrations/0055_system_sync_intervals.sql
git commit -m "feat(sync): store mailbox sync intervals as install-wide settings"
```

---

### Task 2: Подключение всех ящиков при старте через очередь

**Files:**
- Modify: `backend/src/services/imapManager.js` (константы у `PERSISTENT_CAP_ENV` ~318, конструктор ~1739, health check ~1775, новый метод перед `connectAllForUser` ~6215)
- Modify: `backend/src/index.js:295-316`
- Modify: `.env.example` (после `IMAP_MAX_PERSISTENT_PER_HOST=`), `docker-compose.yml` (после `IMAP_MAX_PERSISTENT_PER_HOST`)
- Create: `backend/src/services/imapManager.serverMailboxes.test.js`

**Interfaces:**
- Consumes: `connectStaggerFor(profile, accountCount)`, `providerProfile(account)`, `logAccount(account)` из `imapManager.js`.
- Produces:
  - `DEFAULT_CONNECT_CONCURRENCY = 3`, `parseConnectConcurrency(raw) → number` (экспорт);
  - `ImapManager#connectAllEnabled({ concurrency = IMAP_CONNECT_CONCURRENCY } = {}) → Promise<void>`;
  - `ImapManager#_needsConnect(accountId) → boolean`;
  - `ImapManager#_startupQueued: Set<accountId>`.

- [ ] **Step 1: Write the failing test**

`backend/src/services/imapManager.serverMailboxes.test.js`:

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('./oauth/tokenManager.js', async (importOriginal) => ({
  OAuthTokenError: (await importOriginal()).OAuthTokenError,
  ensureFreshOAuthAccount: vi.fn(async (account) => account),
}));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'redacted') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import { query } from './db.js';
import { ImapManager, parseConnectConcurrency } from './imapManager.js';

// Mailboxes are serviced by the server: they connect at startup and stay connected no matter
// who signs in or out.

const TIMERS = ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer'];
function newManager() {
  const mgr = new ImapManager(null);
  for (const key of TIMERS) clearInterval(mgr[key]);
  mgr.broadcast = vi.fn();
  return mgr;
}

const mailbox = (n, over = {}) => ({
  id: `mailbox-${n}`,
  user_id: 'u1',
  enabled: true,
  protocol: 'imap',
  email_address: `m${n}@example.com`,
  imap_host: 'imap.example.com',
  imap_port: 993,
  oauth_reconnect_required: false,
  ...over,
});

// Database rows by id. List queries honour the enabled/IMAP/reconsent filter the way Postgres would.
const rows = new Map();
const enabledImap = (row) => row.enabled && row.protocol === 'imap' && !row.oauth_reconnect_required;
function installDb() {
  query.mockImplementation(async (sql, params = []) => {
    if (/WHERE enabled = true AND protocol = 'imap' AND oauth_reconnect_required = false/.test(sql)) {
      return { rows: [...rows.values()].filter(enabledImap) };
    }
    if (/^\s*SELECT \* FROM email_accounts WHERE id = \$1/.test(sql)) {
      const row = rows.get(params[0]);
      const onlyEnabledImap = /enabled = true AND protocol = 'imap'/.test(sql);
      return { rows: row && (!onlyEnabledImap || (row.enabled && row.protocol === 'imap')) ? [row] : [] };
    }
    if (/WHERE id = ANY\(\$1::uuid\[\]\)/.test(sql)) {
      return { rows: params[0].map((id) => rows.get(id)).filter(Boolean) };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  installDb();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// connectAccount stand-in that keeps each connect open until the test releases it, marking the
// mailbox connecting and then connected the way the real method does.
function holdConnects(mgr) {
  const pending = [];
  let inFlight = 0;
  let maxInFlight = 0;
  vi.spyOn(mgr, 'connectAccount').mockImplementation((account) => {
    mgr.connectingAccounts.add(account.id);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => pending.push(() => {
      mgr.connectingAccounts.delete(account.id);
      mgr.connections.set(account.id, {});
      inFlight -= 1;
      resolve(true);
    }));
  });
  return { pending, maxInFlight: () => maxInFlight };
}

async function releaseAll(held) {
  while (held.pending.length) {
    held.pending.shift()();
    await vi.advanceTimersByTimeAsync(10_000);
  }
}

describe('connectAllEnabled', () => {
  it('connects every enabled mailbox, at most `concurrency` at a time', async () => {
    vi.useFakeTimers();
    for (let n = 1; n <= 5; n += 1) rows.set(`mailbox-${n}`, mailbox(n));
    rows.set('mailbox-6', mailbox(6, { enabled: false }));
    rows.set('mailbox-7', mailbox(7, { oauth_reconnect_required: true }));
    const mgr = newManager();
    const held = holdConnects(mgr);

    const done = mgr.connectAllEnabled({ concurrency: 2 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mgr.connectAccount).toHaveBeenCalledTimes(2);

    await releaseAll(held);
    await done;
    expect(mgr.connectAccount.mock.calls.map(([account]) => account.id))
      .toEqual(['mailbox-1', 'mailbox-2', 'mailbox-3', 'mailbox-4', 'mailbox-5']);
    expect(held.maxInFlight()).toBe(2);
    expect(mgr._startupQueued.size).toBe(0);
  });

  it('leaves mailboxes waiting in the queue to the queue when the health check runs', async () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    for (let n = 1; n <= 3; n += 1) rows.set(`mailbox-${n}`, mailbox(n));
    const mgr = newManager();
    const healthCheck = intervalSpy.mock.calls.find(([, ms]) => ms === 90000)[0];
    const held = holdConnects(mgr);

    const done = mgr.connectAllEnabled({ concurrency: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    await healthCheck();
    expect(mgr.connectAccount).toHaveBeenCalledTimes(1);

    await releaseAll(held);
    await done;
    expect(mgr.connectAccount).toHaveBeenCalledTimes(3);
  });

  it('re-reads a mailbox at its turn and skips one disabled while it waited', async () => {
    vi.useFakeTimers();
    rows.set('mailbox-1', mailbox(1));
    rows.set('mailbox-2', mailbox(2));
    const mgr = newManager();
    const held = holdConnects(mgr);

    const done = mgr.connectAllEnabled({ concurrency: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    rows.set('mailbox-2', mailbox(2, { enabled: false }));
    await releaseAll(held);
    await done;

    expect(mgr.connectAccount.mock.calls.map(([account]) => account.id)).toEqual(['mailbox-1']);
  });

  it('skips a mailbox that is already connected', async () => {
    vi.useFakeTimers();
    rows.set('mailbox-1', mailbox(1));
    rows.set('mailbox-2', mailbox(2));
    const mgr = newManager();
    mgr.connections.set('mailbox-1', {});
    vi.spyOn(mgr, 'connectAccount').mockResolvedValue(true);

    const done = mgr.connectAllEnabled();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(mgr.connectAccount.mock.calls.map(([account]) => account.id)).toEqual(['mailbox-2']);
  });

  it('reads IMAP_CONNECT_CONCURRENCY and falls back to 3', () => {
    expect(parseConnectConcurrency('5')).toBe(5);
    for (const raw of [undefined, '', '0', '-2', 'many']) expect(parseConnectConcurrency(raw)).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/services/imapManager.serverMailboxes.test.js`
Expected: FAIL — `parseConnectConcurrency is not a function` / `mgr.connectAllEnabled is not a function`.

- [ ] **Step 3: Add the concurrency setting**

В `backend/src/services/imapManager.js` сразу после строки `const PERSISTENT_CAP_ENV = parsePersistentCap(process.env.IMAP_MAX_PERSISTENT_PER_HOST);` добавить:

```js

// How many mailboxes the startup queue connects at the same time. Not a cap on mailboxes: every
// enabled one connects, the queue only spreads the logins out. Empty or invalid = 3.
export const DEFAULT_CONNECT_CONCURRENCY = 3;
export function parseConnectConcurrency(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CONNECT_CONCURRENCY;
}
const IMAP_CONNECT_CONCURRENCY = parseConnectConcurrency(process.env.IMAP_CONNECT_CONCURRENCY);
```

- [ ] **Step 4: Track queued mailboxes and skip them in the health check**

В конструкторе после строки `this.connectingAccounts = new Set(); // prevent concurrent connectAccount calls for same account` добавить:

```js
    this._startupQueued = new Set(); // accountId — waiting for its turn in connectAllEnabled's queue
```

В health check заменить начало цикла:

```js
        for (const row of result.rows) {
          // A poll-only account (per-host budget) holds no persistent connection by design; while
```

на:

```js
        for (const row of result.rows) {
          // The startup queue will connect it; reconnecting here would bypass the queue's limit.
          if (this._startupQueued.has(row.id)) continue;
          // A poll-only account (per-host budget) holds no persistent connection by design; while
```

- [ ] **Step 5: Add `connectAllEnabled` and `_needsConnect`**

В `backend/src/services/imapManager.js` непосредственно перед `  async connectAllForUser(userId) {` вставить:

```js
  // Connects every enabled IMAP mailbox; called once at startup. At most `concurrency` connects run
  // at the same time and successive launches keep each provider's spacing (#218), so a large
  // install storms neither its mail servers nor the DB pool. The health check leaves queued
  // mailboxes alone, and each row is re-read at its turn so a change made while it waited counts.
  async connectAllEnabled({ concurrency = IMAP_CONNECT_CONCURRENCY } = {}) {
    const { rows } = await query(
      `SELECT * FROM email_accounts
        WHERE enabled = true AND protocol = 'imap' AND oauth_reconnect_required = false
        ORDER BY created_at ASC NULLS FIRST, id ASC`
    );
    const queue = rows.filter(account => this._needsConnect(account.id));
    if (!queue.length) return;
    const total = queue.length;
    for (const account of queue) this._startupQueued.add(account.id);
    const workers = Math.min(Math.max(1, concurrency), total);
    console.log(`Connecting ${total} mailbox(es) on startup, ${workers} at a time`);

    let nextLaunchAt = Date.now();
    const work = async () => {
      while (queue.length) {
        const queued = queue.shift();
        const launchAt = Math.max(nextLaunchAt, Date.now());
        nextLaunchAt = launchAt + connectStaggerFor(providerProfile(queued), total);
        const wait = launchAt - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        this._startupQueued.delete(queued.id);
        try {
          if (!this._needsConnect(queued.id)) continue;
          const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [queued.id]);
          if (!account?.enabled || account.protocol !== 'imap' || account.oauth_reconnect_required) continue;
          await this.connectAccount(account);
        } catch (err) {
          console.error(`Startup connect failed for ${logAccount(queued)}:`, err.message);
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, work));
  }

  // Whether nothing holds or is opening this mailbox's connection. A poll-only mailbox with a live
  // timer holds no connection by design and counts as connected.
  _needsConnect(accountId) {
    if (this.connections.has(accountId) || this.connectingAccounts.has(accountId)) return false;
    return !(this._pollOnlyAccounts.has(accountId) && this.syncIntervals.has(accountId));
  }

```

- [ ] **Step 6: Run test to verify it passes**

Run: `bt src/services/imapManager.serverMailboxes.test.js`
Expected: PASS (5 tests).

- [ ] **Step 7: Use the queue at startup**

В `backend/src/index.js` заменить блок:

```js
// Re-connect all enabled IMAP accounts on startup with bounded concurrency so a
// large user base doesn't hammer IMAP servers and the DB connection pool at once.
try {
  const startupResult = await query(
    "SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true AND protocol = 'imap'"
  );
  if (startupResult.rows.length) {
    console.log(`Reconnecting accounts for ${startupResult.rows.length} user(s) on startup`);
    const MAX_CONCURRENT = 3;
    const queue = [...startupResult.rows];
    function connectNext() {
      if (!queue.length) return;
      const { user_id } = queue.shift();
      imapManager.connectAllForUser(user_id)
        .catch(err => console.error(`Startup connect failed for user ${user_id}:`, err.message))
        .finally(connectNext);
    }
    for (let i = 0; i < Math.min(MAX_CONCURRENT, queue.length); i++) connectNext();
  }
} catch (err) {
  console.error('Startup account connection error:', err.message);
}
```

на:

```js
// Mailboxes are serviced by the server: every enabled IMAP mailbox connects through a bounded
// queue (IMAP_CONNECT_CONCURRENCY). Signing in, signing out and sockets never connect them.
imapManager.connectAllEnabled()
  .catch(err => console.error('Startup mailbox connection error:', err.message));
```

Импорт `query` в `index.js` остаётся: его использует `backfillContactPhotos`.

- [ ] **Step 8: Document the variable**

В `.env.example` после строки `IMAP_MAX_PERSISTENT_PER_HOST=` добавить:

```
# How many mailboxes connect at the same time when the server starts. Every
# enabled mailbox connects; this only spreads the logins out. Empty = 3.
IMAP_CONNECT_CONCURRENCY=
```

В `docker-compose.yml` после строки `      IMAP_MAX_PERSISTENT_PER_HOST: ${IMAP_MAX_PERSISTENT_PER_HOST:-}` добавить:

```yaml
      IMAP_CONNECT_CONCURRENCY: ${IMAP_CONNECT_CONCURRENCY:-}
```

- [ ] **Step 9: Run the affected suites**

Run: `bt src/services/imapManager.serverMailboxes.test.js src/services/imapManager.test.js src/services/imapManager.oauthRefresh.test.js`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/src/services/imapManager.js backend/src/services/imapManager.serverMailboxes.test.js backend/src/index.js .env.example docker-compose.yml
git commit -m "feat(imap): connect every enabled mailbox at startup through a bounded queue"
```

---
### Task 3: Вход, выход и WebSocket больше не трогают ящики

**Files:**
- Modify: `backend/src/services/imapManager.js` (удалить `disconnectUser` ~2513 и `connectAllForUser` ~6215; комментарий в `connectAccount` ~2231)
- Modify: `backend/src/routes/auth.js` (строки ~226, ~290, ~336-337, ~403, ~519, ~589, ~628)
- Modify: `backend/src/routes/oidc.js` (импорт строка 9; строки ~488, ~543, ~607)
- Modify: `backend/src/services/websocket.js:52`, `:105-108`
- Modify: `backend/src/index.js:256`
- Modify: `backend/src/routes/admin.js:237-242`
- Test: `backend/src/services/imapManager.serverMailboxes.test.js`, `backend/src/services/websocket.test.js`, `backend/src/routes/admin.users.test.js`, `backend/src/services/imapManager.oauthRefresh.test.js`

**Interfaces:**
- Consumes: `ImapManager#connectAllEnabled()` из Task 2; `ImapManager#disconnectAccount(accountId)`.
- Produces: `setupWebSocket(wss, sessionMiddleware, { authorize } = {})`; у `ImapManager` больше нет `connectAllForUser` и `disconnectUser`.

- [ ] **Step 1: Write the failing tests**

В `backend/src/services/imapManager.serverMailboxes.test.js` первой строкой файла добавить:

```js
import { readFile } from 'node:fs/promises';
```

и в конец файла:

```js
describe('mailboxes do not follow sign-in', () => {
  it('has no per-user connect or disconnect', () => {
    expect(ImapManager.prototype.connectAllForUser).toBeUndefined();
    expect(ImapManager.prototype.disconnectUser).toBeUndefined();
  });

  it.each(['routes/auth.js', 'routes/oidc.js', 'routes/authGoogle.js', 'services/websocket.js', 'middleware/identityGate.js'])(
    '%s never connects or disconnects mailboxes',
    async (file) => {
      const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/connectAllForUser|disconnectUser|imapManager\.(connect|disconnect)/);
    },
  );
});
```

В `backend/src/services/websocket.test.js` заменить функцию `setup` и весь блок `describe('WebSocket failure recovery', ...)` на:

```js
function setup(sessionMiddleware, options) {
  const wss = new EventEmitter();
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1, close: vi.fn(), terminate: vi.fn(), send: vi.fn(),
  });
  setupWebSocket(wss, sessionMiddleware, options);
  wss.emit('connection', ws, { headers: {}, session: { userId: 'u1' } });
  return { ws };
}
afterEach(() => vi.restoreAllMocks());

describe('WebSocket failure recovery', () => {
  it('absorbs transport errors even while session lookup is pending', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ws } = setup(() => {});
    expect(() => ws.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it('allows the browser to retry a session-store outage', () => {
    const { ws } = setup((_req, _res, next) => next(new Error('Redis unavailable')));
    expect(ws.close).toHaveBeenCalledWith(1011, 'Session unavailable');
  });

  it('does not authenticate a socket closed during session lookup', async () => {
    let finish;
    const { ws } = setup((_req, _res, next) => { finish = next; });
    ws.readyState = 3;
    finish();
    await flush();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('greets an authorized socket and leaves mailbox connections to the server', async () => {
    const { ws } = setup((_req, _res, next) => next(), { authorize: async () => 'u1' });
    await flush();
    expect(ws.userId).toBe('u1');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'connected' }));
  });

  it('closes a socket whose user is not authorized', async () => {
    const { ws } = setup((_req, _res, next) => next(), { authorize: async () => null });
    await flush();
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
  });

  it('lets the browser retry when authorization itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws } = setup((_req, _res, next) => next(), {
      authorize: async () => { throw new Error('database unavailable'); },
    });
    await flush();
    expect(ws.close).toHaveBeenCalledWith(1011, 'Session unavailable');
    expect(error).toHaveBeenCalledWith('WebSocket authorization failed: Error');
  });
});
```

В том же файле, в тесте `accepts APP_URL and APP_ALT_URLS origins and closes others`, заменить строку:

```js
      setupWithOrigins(wss, () => {}, { connectAllForUser: vi.fn() });
```

на:

```js
      setupWithOrigins(wss, () => {});
```

В `backend/src/routes/admin.users.test.js`:

1. В `vi.mock('../index.js', ...)` заменить `imapManager: { disconnectUser: vi.fn(async () => {}), wss: { clients: new Set() } },` на:

```js
  imapManager: { disconnectAccount: vi.fn(async () => {}), wss: { clients: new Set() } },
```

2. В `beforeEach` заменить `imapManager.disconnectUser.mockClear();` на `imapManager.disconnectAccount.mockClear();`.
3. В тесте `keeps mailbox owners in google mode until mailboxes are shared` заменить `expect(imapManager.disconnectUser).not.toHaveBeenCalled();` на `expect(imapManager.disconnectAccount).not.toHaveBeenCalled();`.
4. Тест `signs the user out everywhere and deletes them` заменить на:

```js
  it('signs the user out everywhere, deletes them and disconnects the mailboxes the delete removes', async () => {
    const MAILBOX_ID = '00000000-0000-0000-0000-0000000000c1';
    installTransaction([lock, target(USER_ROW)]);
    query.mockImplementation(async (sql) => (
      sql.startsWith('SELECT id FROM email_accounts WHERE user_id') ? { rows: [{ id: MAILBOX_ID }] } : { rows: [] }
    ));
    expect(await send('DELETE', `/users/${USER_ID}`)).toEqual({ status: 200, body: { ok: true } });
    expect(destroyUserSessions).toHaveBeenCalledWith(USER_ID);
    expect(closeUserSockets).toHaveBeenCalledWith(imapManager.wss, USER_ID);
    expect(query).toHaveBeenCalledWith('DELETE FROM users WHERE id = $1', [USER_ID]);
    expect(imapManager.disconnectAccount).toHaveBeenCalledWith(MAILBOX_ID);
    const deleteCall = query.mock.calls.findIndex(([sql]) => sql.startsWith('DELETE FROM users'));
    expect(imapManager.disconnectAccount.mock.invocationCallOrder[0])
      .toBeGreaterThan(query.mock.invocationCallOrder[deleteCall]);
  });
```

В `backend/src/services/imapManager.oauthRefresh.test.js`, тест `skips flagged accounts in the health check and at startup`: заменить две строки

```js
      if (sql.startsWith('SELECT preferences')) return { rows: [] };
      if (sql.startsWith('SELECT * FROM email_accounts WHERE user_id')) return { rows: visible };
```

на:

```js
      if (/^\s*SELECT \* FROM email_accounts\s+WHERE enabled = true/.test(sql)) return { rows: visible };
```

и строку `    await mgr.connectAllForUser('u1');` на `    await mgr.connectAllEnabled();`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bt src/services/imapManager.serverMailboxes.test.js src/services/websocket.test.js src/routes/admin.users.test.js`
Expected: FAIL — `connectAllForUser` ещё определён; исходники `auth.js`, `oidc.js`, `websocket.js` содержат `connectAllForUser`/`disconnectUser`; удаление пользователя не вызывает `disconnectAccount`; тесты WebSocket с `authorize` в опциях падают, потому что до правки опции попадают в параметр `imapManager`.

- [ ] **Step 3: Remove the calls from sign-in and sign-out**

В `backend/src/routes/auth.js` удалить строки (каждая стоит отдельно):

- в регистрации: `    imapManager.connectAllForUser(newUser.id);`
- во входе с доверенным устройством: `        imapManager.connectAllForUser(user.id);`
- во входе по паролю: пустую строку перед комментарием, комментарий `    // Start IMAP connections for this user` и строку `    imapManager.connectAllForUser(user.id);`
- в трёх обработчиках TOTP: `  imapManager.connectAllForUser(user.id);`
- в выходе: `  if (userId) imapManager.disconnectUser(userId);`

Импорт `imapManager` в `auth.js` пока остаётся: его ещё использует `PATCH /preferences` (Task 4 убирает).

В `backend/src/routes/oidc.js` удалить импорт `import { imapManager } from '../index.js';` и три строки `imapManager.connectAllForUser(user.id);` (две с отступом 6 пробелов, одна с отступом 8).

Проверка: `grep -n "connectAllForUser\|disconnectUser" backend/src/routes backend/src/services/websocket.js -r` ничего не выводит, кроме тестов.

- [ ] **Step 4: WebSocket without the mailbox manager**

В `backend/src/services/websocket.js` заменить:

```js
export function setupWebSocket(wss, sessionMiddleware, imapManager, { authorize = authorizeSocketUser } = {}) {
```

на:

```js
export function setupWebSocket(wss, sessionMiddleware, { authorize = authorizeSocketUser } = {}) {
```

и удалить блок:

```js
          // Re-establish IMAP connections if the server restarted (skips already-connected accounts)
          imapManager.connectAllForUser(userId).catch(reconnectErr => {
            console.error('WebSocket account reconnect failed:', reconnectErr.message);
          });
```

В `backend/src/index.js` заменить `setupWebSocket(wss, sessionMiddleware, imapManager);` на:

```js
setupWebSocket(wss, sessionMiddleware);
```

- [ ] **Step 5: Deleting a user disconnects the mailboxes the cascade removes**

В `backend/src/routes/admin.js` в `router.delete('/users/:id', ...)` заменить:

```js
  // Stop live per-user workers BEFORE the delete — disconnectUser looks up the
  // user's accounts, which the cascade delete would remove.
  await imapManager.disconnectUser(id).catch(err => console.warn('disconnectUser on delete:', err.message));
  stopCardavUser(id);
  await signOutEverywhere(id);
  await query('DELETE FROM users WHERE id = $1', [id]);
```

на:

```js
  // While mailboxes still belong to one user, the FK cascade deletes this user's mailboxes too:
  // stop their live connections after the delete, as DELETE /api/accounts/:id does.
  const { rows: ownedMailboxes } = await query('SELECT id FROM email_accounts WHERE user_id = $1', [id]);
  stopCardavUser(id);
  await signOutEverywhere(id);
  await query('DELETE FROM users WHERE id = $1', [id]);
  for (const mailbox of ownedMailboxes) {
    imapManager.disconnectAccount(mailbox.id)
      .catch(err => console.warn(`Disconnect after user delete for ${mailbox.id}:`, err.message));
  }
```

- [ ] **Step 6: Delete the per-user lifecycle from the manager**

В `backend/src/services/imapManager.js`:

1. Удалить метод целиком:

```js
  async disconnectUser(userId) {
    try {
      const result = await query(
        "SELECT id FROM email_accounts WHERE user_id = $1 AND protocol = 'imap'",
        [userId]
      );
      await Promise.all(result.rows.map(a => this.disconnectAccount(a.id)));
    } catch (err) {
      console.error(`disconnectUser error for user ${userId}:`, err.message);
    }
  }
```

2. Удалить метод `async connectAllForUser(userId) { ... }` целиком — от `  async connectAllForUser(userId) {` до его закрывающей `  }` перед последней `}` класса.

3. В `connectAccount` заменить комментарий:

```js
    // Guard against concurrent connect calls for the same account.
    // This happens when startup and a WebSocket connection both call connectAllForUser
    // before the first connectAccount completes — without this, both would connect the
    // same account in parallel, leaving one interval/client permanently orphaned.
```

на:

```js
    // Guard against concurrent connect calls for the same account.
    // This happens when the startup queue, the health check or a manual reconnect reach the
    // same account before the first connectAccount completes — without this, both would connect
    // the same account in parallel, leaving one interval/client permanently orphaned.
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bt src/services/imapManager.serverMailboxes.test.js src/services/websocket.test.js src/routes/admin.users.test.js src/services/imapManager.oauthRefresh.test.js src/routes/auth.config.test.js src/routes/oidc.endsession.test.js src/routes/oidc.match.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/imapManager.js backend/src/services/imapManager.serverMailboxes.test.js backend/src/services/imapManager.oauthRefresh.test.js backend/src/services/websocket.js backend/src/services/websocket.test.js backend/src/index.js backend/src/routes/auth.js backend/src/routes/oidc.js backend/src/routes/admin.js backend/src/routes/admin.users.test.js
git commit -m "feat(imap): keep mailboxes connected regardless of sign-in, sign-out and sockets"
```

---

### Task 4: Системные интервалы в менеджере, админке и личных настройках

**Files:**
- Modify: `backend/src/services/imapManager.js` (импорт; `DEFAULT_FOLDER_SYNC_INTERVAL_MS` ~383-395; `MIN_SYNC_INTERVAL_MS` ~413-416; конструктор ~1740-1741; `connectAccount` ~2343; `_startPollOnly` ~2438; `_pollOnlyTick` ~2470; `_syncTick` ~2830; `updateSyncIntervalForUser`/`updateFolderSyncIntervalForUser` ~3101-3123)
- Modify: `backend/src/index.js` (импорт, старт)
- Modify: `backend/src/routes/auth.js` (импорт `imapManager`; `GET /preferences` ~765; `patchPreferences` ~777-913)
- Modify: `backend/src/routes/admin.js` (импорт; `PATCH /settings` ~275-391)
- Test: `backend/src/services/imapManager.serverMailboxes.test.js`, `backend/src/routes/auth.preferences.test.js`, `backend/src/routes/auth.config.test.js`, `backend/src/routes/auth.sessions.test.js`
- Create: `backend/src/routes/admin.syncSettings.test.js`

**Interfaces:**
- Consumes: из Task 1 — `loadSyncSettings`, `parseSyncIntervalSec`, `parseFolderSyncIntervalSec`, `SYNC_INTERVAL_KEY`, `FOLDER_SYNC_INTERVAL_KEY`, `SYNC_INTERVAL_CHOICES_SEC`, `DEFAULT_SYNC_INTERVAL_SEC`, `DEFAULT_FOLDER_SYNC_INTERVAL_SEC`.
- Produces:
  - `ImapManager#syncIntervalMs: number`, `ImapManager#folderSyncIntervalMs: number`;
  - `ImapManager#applySyncSettings({ syncIntervalSec, folderSyncIntervalSec }) → Promise<void>`;
  - `ImapManager#_armPollOnlyTimer(account)`;
  - `getPreferences(req, res)` из `routes/auth.js`; ответ `GET /api/auth/preferences` содержит `syncInterval: number` (секунды, системное значение);
  - `PATCH /api/admin/settings` принимает `sync_interval_sec` и `folder_sync_interval_sec`, неверное значение — 400 `code: 'invalid_field'`.

- [ ] **Step 1: Write the failing manager tests**

В `backend/src/services/imapManager.serverMailboxes.test.js` заменить строку `import { ImapManager, parseConnectConcurrency } from './imapManager.js';` на:

```js
import { ImapManager, MIN_SYNC_INTERVAL_MS, parseConnectConcurrency } from './imapManager.js';
import { SYNC_INTERVAL_CHOICES_SEC } from './syncSettings.js';
```

и добавить в конец файла:

```js
describe('install-wide sync intervals', () => {
  it('keeps the fastest tick in step with the sync setting choices', () => {
    expect(MIN_SYNC_INTERVAL_MS).toBe(Math.min(...SYNC_INTERVAL_CHOICES_SEC) * 1000);
  });

  it('starts with the defaults', () => {
    const mgr = newManager();
    expect(mgr.syncIntervalMs).toBe(60_000);
    expect(mgr.folderSyncIntervalMs).toBe(30 * 60_000);
  });

  it('has no per-user interval methods', () => {
    expect(ImapManager.prototype.updateSyncIntervalForUser).toBeUndefined();
    expect(ImapManager.prototype.updateFolderSyncIntervalForUser).toBeUndefined();
  });

  it('re-arms running timers with the new interval, poll-only mailboxes included', async () => {
    const mgr = newManager();
    rows.set('mailbox-1', mailbox(1));
    rows.set('mailbox-2', mailbox(2));
    mgr.syncIntervals.set('mailbox-1', setTimeout(() => {}, 60_000));
    mgr.syncIntervals.set('mailbox-2', setTimeout(() => {}, 60_000));
    mgr._pollOnlyAccounts.add('mailbox-2');
    const startSync = vi.spyOn(mgr, '_startSyncInterval').mockImplementation(() => {});
    const armPoll = vi.spyOn(mgr, '_armPollOnlyTimer').mockImplementation(() => {});

    await mgr.applySyncSettings({ syncIntervalSec: 30, folderSyncIntervalSec: 0 });

    expect(mgr.syncIntervalMs).toBe(30_000);
    expect(mgr.folderSyncIntervalMs).toBe(0);
    expect(startSync).toHaveBeenCalledWith(expect.objectContaining({ id: 'mailbox-1' }), 30_000);
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(armPoll).toHaveBeenCalledWith(expect.objectContaining({ id: 'mailbox-2' }));
    expect(mgr.syncIntervals.size).toBe(0);
  });

  it('leaves timers alone when only the folder interval changes', async () => {
    const mgr = newManager();
    mgr.syncIntervals.set('mailbox-1', setTimeout(() => {}, 60_000));
    const startSync = vi.spyOn(mgr, '_startSyncInterval');

    await mgr.applySyncSettings({ syncIntervalSec: 60, folderSyncIntervalSec: 900 });

    expect(mgr.folderSyncIntervalMs).toBe(900_000);
    expect(startSync).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    clearTimeout(mgr.syncIntervals.get('mailbox-1'));
  });
});
```

- [ ] **Step 2: Write the failing route tests**

В `backend/src/routes/auth.preferences.test.js`:

1. Заменить мок `../index.js` на `vi.mock('../index.js', () => ({ imapManager: {} }));`.
2. Заменить `import { patchPreferences } from './auth.js';` на `import { getPreferences, patchPreferences } from './auth.js';`.
3. В тесте `merges folderOrder into existing preferences as JSONB` заменить `$39::jsonb` на `$37::jsonb` и `params[38]` на `params[36]`.
4. В тесте `merges the senderFavicons boolean into preferences as JSONB` заменить `$40::boolean` на `$38::boolean` и `params[39]` на `params[37]`.
5. В блоке `PATCH /auth/preferences defaultSender (#417)` заменить `$42::text` на `$40::text` и все `[41]` на `[39]` (четыре места). Пункты 3–5 выполнять именно в этом порядке: иначе замена `[39]` из пункта 4 заденет уже исправленные строки.
6. Добавить в конец файла:

```js
describe('sync intervals are install-wide', () => {
  it('PATCH ignores the old per-user interval fields', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await patchPreferences({ session: { userId: 'user-1' }, body: { syncInterval: '15', folderSyncInterval: '0' } }, res);
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toMatch(/syncInterval|folderSyncInterval/);
    expect(params).toHaveLength(40);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('GET reports the install-wide message interval over a stale personal value', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT preferences')) return { rows: [{ preferences: { theme: 'dark', syncInterval: '15' } }] };
      if (sql.includes('key = ANY')) return { rows: [{ key: 'sync_interval_sec', value: '120' }] };
      return { rows: [] };
    });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await getPreferences({ session: { userId: 'user-1' } }, res);
    expect(res.json).toHaveBeenCalledWith({ theme: 'dark', syncInterval: 120 });
  });
});
```

В `backend/src/routes/auth.config.test.js` и `backend/src/routes/auth.sessions.test.js` заменить мок `../index.js` (объект с методами `connectAllForUser`, `disconnectUser`, `updateSyncIntervalForUser`, `updateFolderSyncIntervalForUser`) на:

```js
vi.mock('../index.js', () => ({ imapManager: {} }));
```

Создать `backend/src/routes/admin.syncSettings.test.js`:

```js
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAdmin: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({
  imapManager: { applySyncSettings: vi.fn(async () => {}), disconnectAccount: vi.fn(async () => {}), wss: { clients: new Set() } },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({})),
  invalidateConnectionPolicyCache: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));

import express from 'express';
import adminRoutes from './admin.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: '00000000-0000-0000-0000-00000000000a', username: 'admin@example.com' };
    next();
  });
  app.use('/api/admin', adminRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// system_settings as a map: written by the key/value upsert, read back by loadSyncSettings.
const stored = new Map();
beforeEach(() => {
  stored.clear();
  query.mockReset();
  imapManager.applySyncSettings.mockClear();
  query.mockImplementation(async (sql, params = []) => {
    if (/INSERT INTO system_settings \(key, value, updated_at\) VALUES \(\$1, \$2, NOW\(\)\)/.test(sql)) {
      stored.set(params[0], params[1]);
      return { rows: [] };
    }
    if (sql.includes('FROM system_settings WHERE key = ANY')) {
      return { rows: params[0].filter((key) => stored.has(key)).map((key) => ({ key, value: stored.get(key) })) };
    }
    return { rows: [] };
  });
});

const patch = (body) => fetch(`${base}/api/admin/settings`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

describe('PATCH /api/admin/settings mailbox sync intervals', () => {
  it('stores both intervals and applies them to the running mailboxes', async () => {
    expect(await patch({ sync_interval_sec: 30, folder_sync_interval_sec: 0 })).toEqual({ status: 200, body: { ok: true } });
    expect(Object.fromEntries(stored)).toEqual({ sync_interval_sec: '30', folder_sync_interval_sec: '0' });
    expect(imapManager.applySyncSettings).toHaveBeenCalledWith({ syncIntervalSec: 30, folderSyncIntervalSec: 0 });
  });

  it('changes one interval and keeps the other', async () => {
    stored.set('folder_sync_interval_sec', '3600');
    expect((await patch({ sync_interval_sec: '120' })).status).toBe(200);
    expect(imapManager.applySyncSettings).toHaveBeenCalledWith({ syncIntervalSec: 120, folderSyncIntervalSec: 3600 });
  });

  it('rejects values the settings screen does not offer before writing anything', async () => {
    for (const body of [{ sync_interval_sec: 45 }, { folder_sync_interval_sec: 'never' }, { sync_interval_sec: 30, folder_sync_interval_sec: 61 }]) {
      expect(await patch(body)).toMatchObject({ status: 400, body: { code: 'invalid_field' } });
    }
    expect(stored.size).toBe(0);
    expect(imapManager.applySyncSettings).not.toHaveBeenCalled();
  });

  it('leaves mailbox timers alone when no interval is sent', async () => {
    expect((await patch({ registration_open: true })).status).toBe(200);
    expect(imapManager.applySyncSettings).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bt src/services/imapManager.serverMailboxes.test.js src/routes/auth.preferences.test.js src/routes/admin.syncSettings.test.js`
Expected: FAIL — нет `applySyncSettings`/`syncIntervalMs`, нет экспорта `getPreferences`, SQL настроек всё ещё содержит `syncInterval`, админка не знает новых ключей.

- [ ] **Step 4: Install-wide intervals in the manager**

В `backend/src/services/imapManager.js`:

1. После строки `import { query } from './db.js';` добавить:

```js
import { DEFAULT_FOLDER_SYNC_INTERVAL_SEC, DEFAULT_SYNC_INTERVAL_SEC, SYNC_INTERVAL_CHOICES_SEC } from './syncSettings.js';
```

2. Заменить:

```js
// Default folder-structure sync cadence (LIST + folders-table upsert). Folders
// created/renamed in other clients otherwise only appear when a connection is
// re-established. User-configurable via the folderSyncInterval preference
// (seconds; 0 = never).
const DEFAULT_FOLDER_SYNC_INTERVAL_MS = 30 * 60 * 1000;

// Whether a periodic folder-structure sync is due. Time-based rather than
// tick-based because the sync-tick cadence is itself user-configurable.
```

на:

```js
// Default folder-structure sync cadence (LIST + folders-table upsert). Folders
// created/renamed in other clients otherwise only appear when a connection is
// re-established. Admins change it through the folder_sync_interval_sec system
// setting (seconds; 0 = never).
const DEFAULT_FOLDER_SYNC_INTERVAL_MS = DEFAULT_FOLDER_SYNC_INTERVAL_SEC * 1000;

// Whether a periodic folder-structure sync is due. Time-based rather than
// tick-based because the sync-tick cadence is itself configurable.
```

3. Заменить:

```js
// The fastest sync interval the settings UI offers (AdminPanel's 15s/30s/60s/2min selector)
// and the floor connectAllForUser accepts from user preferences. Anything that must not
// collide with a sync tick is defined against this.
export const MIN_SYNC_INTERVAL_MS = 15 * 1000;
```

на:

```js
// The fastest interval the sync_interval_sec system setting offers. Anything that must not
// collide with a sync tick is defined against this.
export const MIN_SYNC_INTERVAL_MS = Math.min(...SYNC_INTERVAL_CHOICES_SEC) * 1000;
```

4. В конструкторе заменить:

```js
    this.userSyncIntervalMs = new Map(); // userId -> interval ms (user-configurable)
    this.userFolderSyncIntervalMs = new Map(); // userId -> folder-structure sync ms (0 = never)
```

на:

```js
    this.syncIntervalMs = DEFAULT_SYNC_INTERVAL_SEC * 1000; // install-wide message sync cadence, see applySyncSettings
    this.folderSyncIntervalMs = DEFAULT_FOLDER_SYNC_INTERVAL_MS; // install-wide folder-structure cadence, 0 = never
```

5. В `connectAccount` заменить:

```js
      const intervalMs = this.userSyncIntervalMs.get(account.user_id) || 60000;
      this._startSyncInterval(account, intervalMs);
```

на:

```js
      this._startSyncInterval(account, this.syncIntervalMs);
```

6. В `_startPollOnly` заменить хвост метода:

```js
    const ms = effectiveSyncIntervalMs(account, this.userSyncIntervalMs.get(account.user_id) || 60000);
    const jitter = Math.floor(Math.random() * Math.min(ms, 30000));
    const t = setTimeout(() => {
      if (!this._pollOnlyAccounts.has(account.id)) return; // disconnected/promoted during the jitter window
      const interval = setInterval(() => {
        this._pollOnlyTick(account).catch(err => console.warn(`Poll-only sync failed for ${logAccount(account)}: ${err.message}`));
      }, ms);
      this.syncIntervals.set(account.id, interval);
    }, jitter);
    this.syncIntervals.set(account.id, t);
  }
```

на:

```js
    this._armPollOnlyTimer(account);
  }

  // The poll-only timer on the install-wide interval, with a jittered first tick. Also used to
  // re-arm it when the interval changes. The timer lives in syncIntervals like a sync interval.
  _armPollOnlyTimer(account) {
    const ms = effectiveSyncIntervalMs(account, this.syncIntervalMs);
    const jitter = Math.floor(Math.random() * Math.min(ms, 30000));
    const t = setTimeout(() => {
      if (!this._pollOnlyAccounts.has(account.id)) return; // disconnected/promoted during the jitter window
      const interval = setInterval(() => {
        this._pollOnlyTick(account).catch(err => console.warn(`Poll-only sync failed for ${logAccount(account)}: ${err.message}`));
      }, ms);
      this.syncIntervals.set(account.id, interval);
    }, jitter);
    this.syncIntervals.set(account.id, t);
  }
```

7. В `_pollOnlyTick` заменить:

```js
      const folderMs = this.userFolderSyncIntervalMs.has(account.user_id)
        ? this.userFolderSyncIntervalMs.get(account.user_id)
        : DEFAULT_FOLDER_SYNC_INTERVAL_MS;
      if (folderSyncDue(folderMs, this.lastFolderSyncAt.get(account.id))) {
```

на:

```js
      if (folderSyncDue(this.folderSyncIntervalMs, this.lastFolderSyncAt.get(account.id))) {
```

8. В `_syncTick` заменить:

```js
      const folderMs = this.userFolderSyncIntervalMs.has(syncAccount.user_id)
        ? this.userFolderSyncIntervalMs.get(syncAccount.user_id)
        : DEFAULT_FOLDER_SYNC_INTERVAL_MS;
      if (folderSyncDue(folderMs, this.lastFolderSyncAt.get(account.id))) {
```

на:

```js
      if (folderSyncDue(this.folderSyncIntervalMs, this.lastFolderSyncAt.get(account.id))) {
```

9. Заменить оба метода `updateSyncIntervalForUser` и `updateFolderSyncIntervalForUser` вместе с их комментариями (от `  // Called when a user changes their sync interval preference — replaces running` до закрывающей `  }` метода `updateFolderSyncIntervalForUser`) на:

```js
  // Applies the install-wide sync cadence. Running message-sync and poll-only timers are re-armed
  // without disconnecting; the folder-structure sync reads folderSyncIntervalMs on its next tick,
  // so it has no timers to re-arm.
  async applySyncSettings({ syncIntervalSec, folderSyncIntervalSec }) {
    const syncIntervalMs = syncIntervalSec * 1000;
    const changed = syncIntervalMs !== this.syncIntervalMs;
    this.syncIntervalMs = syncIntervalMs;
    this.folderSyncIntervalMs = folderSyncIntervalSec * 1000;
    if (!changed || !this.syncIntervals.size) return;
    const { rows } = await query(
      "SELECT * FROM email_accounts WHERE id = ANY($1::uuid[]) AND enabled = true AND protocol = 'imap'",
      [[...this.syncIntervals.keys()]]
    );
    for (const account of rows) {
      const timer = this.syncIntervals.get(account.id);
      if (!timer) continue;
      clearTimeout(timer);
      this.syncIntervals.delete(account.id);
      if (this._pollOnlyAccounts.has(account.id)) this._armPollOnlyTimer(account);
      else this._startSyncInterval(account, this.syncIntervalMs);
    }
  }
```

Проверка: `grep -n "userSyncIntervalMs\|userFolderSyncIntervalMs" backend/src -r` ничего не выводит.

- [ ] **Step 5: Apply the intervals at startup**

В `backend/src/index.js` после строки `import { ImapManager } from './services/imapManager.js';` добавить:

```js
import { loadSyncSettings } from './services/syncSettings.js';
```

и заменить блок из Task 2:

```js
// Mailboxes are serviced by the server: every enabled IMAP mailbox connects through a bounded
// queue (IMAP_CONNECT_CONCURRENCY). Signing in, signing out and sockets never connect them.
imapManager.connectAllEnabled()
  .catch(err => console.error('Startup mailbox connection error:', err.message));
```

на:

```js
// Mailboxes are serviced by the server: apply the install-wide sync cadence, then connect every
// enabled IMAP mailbox through a bounded queue (IMAP_CONNECT_CONCURRENCY). Signing in, signing
// out and sockets never connect them.
try {
  await imapManager.applySyncSettings(await loadSyncSettings());
} catch (err) {
  console.error('Loading mailbox sync intervals failed, using the defaults:', err.message);
}
imapManager.connectAllEnabled()
  .catch(err => console.error('Startup mailbox connection error:', err.message));
```

- [ ] **Step 6: Personal preferences without the intervals**

В `backend/src/routes/auth.js`:

1. Заменить `import { imapManager } from '../index.js';` на:

```js
import { loadSyncSettings } from '../services/syncSettings.js';
```

2. Заменить обработчик:

```js
router.get('/preferences', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const [userResult, cssResult] = await Promise.all([
    query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]),
    query("SELECT value FROM system_settings WHERE key = 'custom_css'"),
  ]);
  const prefs = userResult.rows[0]?.preferences || {};
  const customCss = cssResult.rows[0]?.value;
  if (customCss) prefs.customCss = customCss;
  res.json(prefs);
});
```

на:

```js
export async function getPreferences(req, res) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const [userResult, cssResult, syncSettings] = await Promise.all([
    query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]),
    query("SELECT value FROM system_settings WHERE key = 'custom_css'"),
    loadSyncSettings(),
  ]);
  const prefs = userResult.rows[0]?.preferences || {};
  const customCss = cssResult.rows[0]?.value;
  if (customCss) prefs.customCss = customCss;
  // Install-wide and read-only here: the client uses it only to refresh the list while the
  // WebSocket is down. Admins change it through PATCH /api/admin/settings.
  prefs.syncInterval = syncSettings.syncIntervalSec;
  res.json(prefs);
}

router.get('/preferences', getPreferences);
```

3. В `patchPreferences` убрать `syncInterval` и `folderSyncInterval` из деструктуризации `req.body`:

```js
  const { theme, font, layout, notificationSound, pageSize, scrollMode,
          blockRemoteImages, imageWhitelist, shortcuts, hiddenFolders, language,
          threadedView, plaintextEmail, hoverQuickActions, swipeActions,
          expandedAccounts, collapsedFolders, favoriteFolders, recentFolders, fontSize,
          showAppBadge, showFaviconBadge, replyDefault, sidebarWidth,
          categorizationEnabled, markReadBehavior, markReadDelay, aiActions,
          autoLockMinutes, showMobileAvatars, gravatarAvatars,
          folderOrder, senderFavicons, showMessagePreviews, defaultSender } = req.body;
```

4. Удалить строки:

```js
  // Folder-structure sync cadence in seconds; 0 = never.
  const folderSyncIntervalVal = folderSyncInterval != null && [0, 900, 1800, 3600].includes(Number(folderSyncInterval)) ? String(Number(folderSyncInterval)) : null;
```

5. Заменить весь вызов `await query(\`UPDATE users SET preferences = preferences ...\`, [...]);` на:

```js
  await query(`
    UPDATE users
    SET preferences = preferences
      || CASE WHEN $2::text IS NOT NULL THEN jsonb_build_object('theme',  $2::text) ELSE '{}'::jsonb END
      || CASE WHEN $3::text IS NOT NULL THEN jsonb_build_object('font',   $3::text) ELSE '{}'::jsonb END
      || CASE WHEN $4::text IS NOT NULL THEN jsonb_build_object('layout', $4::text) ELSE '{}'::jsonb END
      || CASE WHEN $5::text IS NOT NULL THEN jsonb_build_object('notificationSound', $5::text) ELSE '{}'::jsonb END
      || CASE WHEN $6::text IS NOT NULL THEN jsonb_build_object('pageSize', $6::text) ELSE '{}'::jsonb END
      || CASE WHEN $7::text IS NOT NULL THEN jsonb_build_object('scrollMode', $7::text) ELSE '{}'::jsonb END
      || CASE WHEN $8::boolean IS NOT NULL THEN jsonb_build_object('blockRemoteImages', $8::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $9::jsonb IS NOT NULL THEN jsonb_build_object('imageWhitelist', $9::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $10::jsonb IS NOT NULL THEN jsonb_build_object('shortcuts', $10::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $11::jsonb IS NOT NULL THEN jsonb_build_object('hiddenFolders', $11::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $12::text IS NOT NULL THEN jsonb_build_object('language', $12::text) ELSE '{}'::jsonb END
      || CASE WHEN $13::boolean IS NOT NULL THEN jsonb_build_object('threadedView', $13::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $14::boolean IS NOT NULL THEN jsonb_build_object('plaintextEmail', $14::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $15::boolean IS NOT NULL THEN jsonb_build_object('hoverQuickActions', $15::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $16::jsonb IS NOT NULL THEN jsonb_build_object('swipeActions', $16::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $17::jsonb IS NOT NULL THEN jsonb_build_object('expandedAccounts', $17::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $18::jsonb IS NOT NULL THEN jsonb_build_object('collapsedFolders', $18::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $19::jsonb IS NOT NULL THEN jsonb_build_object('favoriteFolders', $19::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $20::jsonb IS NOT NULL THEN jsonb_build_object('recentFolders', $20::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $21::text IS NOT NULL THEN jsonb_build_object('fontSize', $21::text) ELSE '{}'::jsonb END
      || CASE WHEN $22::boolean IS NOT NULL THEN jsonb_build_object('showAppBadge', $22::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $23::boolean IS NOT NULL THEN jsonb_build_object('showFaviconBadge', $23::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $24::text IS NOT NULL THEN jsonb_build_object('replyDefault', $24::text) ELSE '{}'::jsonb END
      || CASE WHEN $25::text IS NOT NULL THEN jsonb_build_object('sidebarWidth', $25::text) ELSE '{}'::jsonb END
      || CASE WHEN $26::boolean IS NOT NULL THEN jsonb_build_object('categorizationEnabled', $26::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $27::text IS NOT NULL THEN jsonb_build_object('markReadBehavior', $27::text) ELSE '{}'::jsonb END
      || CASE WHEN $28::text IS NOT NULL THEN jsonb_build_object('markReadDelay', $28::text) ELSE '{}'::jsonb END
      || CASE WHEN $29::jsonb IS NOT NULL THEN jsonb_build_object('aiActions', $29::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $30::int IS NOT NULL THEN jsonb_build_object('rightSidebarWidth', $30::int) ELSE '{}'::jsonb END
      || CASE WHEN $31::boolean IS NOT NULL THEN jsonb_build_object('rightSidebarHidden', $31::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $32::jsonb IS NOT NULL THEN jsonb_build_object('gtdCollapsedSections', $32::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $33::text IS NOT NULL THEN jsonb_build_object('gtdPetSlug', $33::text) ELSE '{}'::jsonb END
      || CASE WHEN $34::text IS NOT NULL THEN jsonb_build_object('autoLockMinutes', $34::text) ELSE '{}'::jsonb END
      || CASE WHEN $35::boolean IS NOT NULL THEN jsonb_build_object('showMobileAvatars', $35::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $36::boolean IS NOT NULL THEN jsonb_build_object('gravatarAvatars', $36::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $37::jsonb IS NOT NULL THEN jsonb_build_object('folderOrder', $37::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $38::boolean IS NOT NULL THEN jsonb_build_object('senderFavicons', $38::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $39::boolean IS NOT NULL THEN jsonb_build_object('showMessagePreviews', $39::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $40::text IS NOT NULL THEN jsonb_build_object('defaultSender', $40::text) ELSE '{}'::jsonb END
    WHERE id = $1
  `, [req.session.userId, theme ?? null, font ?? null, layout ?? null, notificationSound ?? null,
      pageSize ?? null, scrollMode ?? null,
      blockRemoteImages ?? null, imageWhitelistJson, shortcutsJson, hiddenFoldersJson,
      language ?? null, threadedView ?? null, plaintextEmail ?? null, hoverQuickActions ?? null,
      swipeActionsJson, expandedAccountsJson, collapsedFoldersJson, favoriteFoldersJson, recentFoldersJson, fontSizeVal,
      showAppBadge ?? null, showFaviconBadge ?? null, replyDefaultVal, sidebarWidthVal,
      categorizationEnabled ?? null, markReadBehaviorVal, markReadDelayVal, aiActionsJson,
      rightSidebarWidth, rightSidebarHidden, gtdCollapsedSectionsJson, gtdPetSlug, autoLockMinutesVal,
      showMobileAvatars ?? null, gravatarAvatars ?? null, folderOrderJson, senderFaviconsVal,
      showMessagePreviews ?? null, defaultSenderVal]);
```

6. Удалить блок после запроса:

```js
  if (syncInterval != null) {
    const ms = parseInt(syncInterval) * 1000;
    if (ms >= 15000 && ms <= 120000) {
      imapManager.updateSyncIntervalForUser(req.session.userId, ms).catch(console.error);
    }
  }
  if (folderSyncIntervalVal != null) {
    imapManager.updateFolderSyncIntervalForUser(req.session.userId, parseInt(folderSyncIntervalVal) * 1000);
  }
```

Проверка: `grep -n "imapManager" backend/src/routes/auth.js` ничего не выводит.

- [ ] **Step 7: Admin sets the intervals**

В `backend/src/routes/admin.js` после строки `import { destroyUserSessions } from './auth.js';` добавить:

```js
import {
  FOLDER_SYNC_INTERVAL_KEY, SYNC_INTERVAL_KEY, loadSyncSettings, parseFolderSyncIntervalSec, parseSyncIntervalSec,
} from '../services/syncSettings.js';
```

В `router.patch('/settings', ...)` заменить деструктуризацию:

```js
  const { registration_open, internal_auth_disabled, auth_max_attempts, auth_window_minutes,
    allow_private_hosts, allow_insecure_tls, allow_nonstandard_ports,
    mfa_enforcement, mfa_device_trust, custom_css } = req.body;
```

на:

```js
  const { registration_open, internal_auth_disabled, auth_max_attempts, auth_window_minutes,
    allow_private_hosts, allow_insecure_tls, allow_nonstandard_ports,
    mfa_enforcement, mfa_device_trust, custom_css,
    sync_interval_sec, folder_sync_interval_sec } = req.body;
  // Checked before anything is written, so a bad interval never leaves a half-applied update.
  const syncIntervalSec = sync_interval_sec === undefined ? null : parseSyncIntervalSec(sync_interval_sec);
  if (sync_interval_sec !== undefined && syncIntervalSec === null) {
    return res.status(400).json({ error: 'sync_interval_sec must be 15, 30, 60 or 120', code: 'invalid_field' });
  }
  const folderSyncIntervalSec = folder_sync_interval_sec === undefined ? null : parseFolderSyncIntervalSec(folder_sync_interval_sec);
  if (folder_sync_interval_sec !== undefined && folderSyncIntervalSec === null) {
    return res.status(400).json({ error: 'folder_sync_interval_sec must be 0, 900, 1800 or 3600', code: 'invalid_field' });
  }
```

И в том же обработчике заменить последние строки:

```js
  invalidateConnectionPolicyCache();
  res.json({ ok: true });
});
```

на:

```js
  if (syncIntervalSec !== null || folderSyncIntervalSec !== null) {
    for (const [key, seconds] of [[SYNC_INTERVAL_KEY, syncIntervalSec], [FOLDER_SYNC_INTERVAL_KEY, folderSyncIntervalSec]]) {
      if (seconds === null) continue;
      await query(
        `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, String(seconds)]
      );
    }
    // Running mailboxes pick the new cadence up without reconnecting.
    try {
      await imapManager.applySyncSettings(await loadSyncSettings());
    } catch (err) {
      console.error('Applying mailbox sync intervals failed:', err.message);
    }
    console.log(`[admin] ${req.session.userId} changed mailbox sync intervals`);
  }
  invalidateConnectionPolicyCache();
  res.json({ ok: true });
});
```

Внимание: строка `invalidateConnectionPolicyCache();\n  res.json({ ok: true });\n});` должна встречаться в файле один раз; если Edit сообщает о неоднозначности, взять как якорь предыдущий блок `custom_css` целиком.

- [ ] **Step 8: Run tests to verify they pass**

Run: `bt src/services/imapManager.serverMailboxes.test.js src/services/imapManager.test.js src/services/imapManager.oauthRefresh.test.js src/routes/auth.preferences.test.js src/routes/auth.config.test.js src/routes/auth.sessions.test.js src/routes/admin.syncSettings.test.js src/routes/admin.users.test.js src/services/syncSettings.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/imapManager.js backend/src/services/imapManager.serverMailboxes.test.js backend/src/index.js backend/src/routes/auth.js backend/src/routes/auth.preferences.test.js backend/src/routes/auth.config.test.js backend/src/routes/auth.sessions.test.js backend/src/routes/admin.js backend/src/routes/admin.syncSettings.test.js
git commit -m "feat(sync): apply install-wide sync intervals set by an admin"
```

---
### Task 5: Ручная синхронизация и переподключение одного ящика

**Files:**
- Modify: `backend/src/services/imapManager.js` (после `folderSyncDue` ~395; конструктор ~1732; методы `syncNow` ~5861 и `syncFoldersNow` ~5924)
- Modify: `backend/src/routes/mail.js:808-843`
- Modify: `backend/src/routes/accounts.js:342-351`
- Test: `backend/src/services/imapManager.serverMailboxes.test.js`, `backend/src/routes/accounts.reconnectCooldown.test.js`
- Create: `backend/src/routes/mail.sync.test.js`

**Interfaces:**
- Consumes: `ImapManager#syncingAccounts`, `#connectingAccounts`, `#lastSyncOkAt`, `#lastFolderSyncAt`, `#connectAccount`, `#syncMessages`, `#syncFolders`.
- Produces:
  - `MANUAL_SYNC_MIN_GAP_MS = 15000`, `manualSyncDue(lastAt, now = Date.now()) → boolean` (экспорт);
  - `ImapManager#isConnecting(accountId) → boolean`;
  - `ImapManager#requestSync(accountId, now = Date.now()) → { started: boolean }`;
  - `ImapManager#requestFolderSync(accountId, now = Date.now()) → { started: boolean }`;
  - `ImapManager#syncNow(accountId) → Promise<void>`, `ImapManager#syncFoldersNow(accountId) → Promise<void>` (один ящик; прежний аргумент `userId` убран);
  - `POST /api/mail/sync`, `POST /api/mail/sync-folders`: `{ accountId }` → `{ ok: true }` | `{ ok: true, skipped: true }` | 400 `account_required` | 404;
  - `POST /api/accounts/:id/reconnect` → `{ ok: true }` | `{ ok: true, skipped: true }`.

- [ ] **Step 1: Write the failing manager tests**

В `backend/src/services/imapManager.serverMailboxes.test.js` заменить строку `import { ImapManager, MIN_SYNC_INTERVAL_MS, parseConnectConcurrency } from './imapManager.js';` на:

```js
import {
  ImapManager, MANUAL_SYNC_MIN_GAP_MS, MIN_SYNC_INTERVAL_MS, manualSyncDue, parseConnectConcurrency,
} from './imapManager.js';
```

и добавить в конец файла:

```js
describe('manual sync of one mailbox', () => {
  const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

  it('waits MANUAL_SYNC_MIN_GAP_MS after the last sync', () => {
    expect(MANUAL_SYNC_MIN_GAP_MS).toBe(15_000);
    expect(manualSyncDue(undefined, 1_000_000)).toBe(true);
    expect(manualSyncDue(1_000_000 - 14_999, 1_000_000)).toBe(false);
    expect(manualSyncDue(1_000_000 - 15_000, 1_000_000)).toBe(true);
  });

  it('starts one sync and turns away a repeat while it runs', async () => {
    const mgr = newManager();
    let finish;
    const syncNow = vi.spyOn(mgr, 'syncNow').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    expect(mgr.requestSync('mailbox-1')).toEqual({ started: true });
    expect(mgr.requestSync('mailbox-1')).toEqual({ started: false });
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledWith('mailbox-1');

    finish();
    await flushPromises();
    expect(mgr.requestSync('mailbox-1')).toEqual({ started: true });
  });

  it('turns away a mailbox that is syncing, connecting or synced less than 15 seconds ago', () => {
    const mgr = newManager();
    const syncNow = vi.spyOn(mgr, 'syncNow').mockResolvedValue();
    const now = 5_000_000;
    mgr.syncingAccounts.add('a');
    mgr.connectingAccounts.add('b');
    mgr.lastSyncOkAt.set('c', now - 10_000);
    mgr.lastSyncOkAt.set('d', now - 20_000);

    expect(mgr.requestSync('a', now)).toEqual({ started: false });
    expect(mgr.requestSync('b', now)).toEqual({ started: false });
    expect(mgr.requestSync('c', now)).toEqual({ started: false });
    expect(mgr.requestSync('d', now)).toEqual({ started: true });
    expect(syncNow.mock.calls.map(([id]) => id)).toEqual(['d']);
  });

  it('syncs the INBOX, records the success and tells clients', async () => {
    const mgr = newManager();
    rows.set('mailbox-1', mailbox(1));
    const client = {};
    mgr.connections.set('mailbox-1', client);
    const syncMessages = vi.spyOn(mgr, 'syncMessages').mockResolvedValue({ insertedCount: 0 });

    await mgr.syncNow('mailbox-1');

    expect(syncMessages).toHaveBeenCalledWith(expect.objectContaining({ id: 'mailbox-1' }), client, 'INBOX', 20, false, true);
    expect(mgr.lastSyncOkAt.has('mailbox-1')).toBe(true);
    expect(mgr.syncingAccounts.has('mailbox-1')).toBe(false);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'sync_complete', accountId: 'mailbox-1' }, 'u1');
  });

  it('does nothing for a mailbox disabled after the request', async () => {
    const mgr = newManager();
    rows.set('mailbox-1', mailbox(1, { enabled: false }));
    const connect = vi.spyOn(mgr, 'connectAccount').mockResolvedValue(true);

    await mgr.syncNow('mailbox-1');

    expect(connect).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('folder sync: one at a time, not while connecting and not within 15 seconds of the last one', async () => {
    const mgr = newManager();
    let finish;
    const syncFoldersNow = vi.spyOn(mgr, 'syncFoldersNow').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const now = 5_000_000;

    expect(mgr.requestFolderSync('a', now)).toEqual({ started: true });
    expect(mgr.requestFolderSync('a', now)).toEqual({ started: false });
    mgr.lastFolderSyncAt.set('b', now - 5_000);
    expect(mgr.requestFolderSync('b', now)).toEqual({ started: false });
    mgr.connectingAccounts.add('c');
    expect(mgr.requestFolderSync('c', now)).toEqual({ started: false });
    expect(syncFoldersNow).toHaveBeenCalledTimes(1);

    finish();
    await flushPromises();
    expect(mgr.requestFolderSync('a', now)).toEqual({ started: true });
  });

  it('refreshes the folder list of a connected mailbox', async () => {
    const mgr = newManager();
    rows.set('mailbox-1', mailbox(1));
    const client = {};
    mgr.connections.set('mailbox-1', client);
    const syncFolders = vi.spyOn(mgr, 'syncFolders').mockResolvedValue();

    await mgr.syncFoldersNow('mailbox-1');

    expect(syncFolders).toHaveBeenCalledWith(expect.objectContaining({ id: 'mailbox-1' }), client);
    expect(mgr.lastFolderSyncAt.has('mailbox-1')).toBe(true);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'folders_synced', accountId: 'mailbox-1' }, 'u1');
  });

  it('reports a connect in progress', () => {
    const mgr = newManager();
    expect(mgr.isConnecting('a')).toBe(false);
    mgr.connectingAccounts.add('a');
    expect(mgr.isConnecting('a')).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing route tests**

Создать `backend/src/routes/mail.sync.test.js`:

```js
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { requestSync: vi.fn(), requestFolderSync: vi.fn() } }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';

describe.each([
  ['/sync', 'requestSync'],
  ['/sync-folders', 'requestFolderSync'],
])('POST /api/mail%s syncs one mailbox', (path, method) => {
  let server;
  let base;
  let mailboxRow;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  beforeEach(() => {
    query.mockReset();
    imapManager[method].mockReset().mockReturnValue({ started: true });
    mailboxRow = { id: ACCOUNT_ID, enabled: true, protocol: 'imap' };
    query.mockImplementation(async (sql, params = []) => (
      sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')
        && params[0] === ACCOUNT_ID && params[1] === 'user-1' && mailboxRow
        ? { rows: [mailboxRow] }
        : { rows: [] }
    ));
  });

  const post = (body) => fetch(`${base}/api/mail${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('requires a mailbox', async () => {
    expect(await post({})).toMatchObject({ status: 400, body: { code: 'account_required' } });
    expect(imapManager[method]).not.toHaveBeenCalled();
  });

  it('answers 404 for a mailbox the user cannot reach', async () => {
    mailboxRow = null;
    expect((await post({ accountId: ACCOUNT_ID })).status).toBe(404);
    expect(imapManager[method]).not.toHaveBeenCalled();
  });

  it('starts a sync of that mailbox', async () => {
    expect(await post({ accountId: ACCOUNT_ID })).toEqual({ status: 200, body: { ok: true } });
    expect(imapManager[method]).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('reports a repeat the manager turned away', async () => {
    imapManager[method].mockReturnValue({ started: false });
    expect(await post({ accountId: ACCOUNT_ID })).toEqual({ status: 200, body: { ok: true, skipped: true } });
  });

  it('skips a disabled mailbox without asking the manager', async () => {
    mailboxRow = { ...mailboxRow, enabled: false };
    expect(await post({ accountId: ACCOUNT_ID })).toEqual({ status: 200, body: { ok: true, skipped: true } });
    expect(imapManager[method]).not.toHaveBeenCalled();
  });
});
```

В `backend/src/routes/accounts.reconnectCooldown.test.js`:

1. В моке `imapManager` после строки `    clearConnectCooldown: vi.fn(),` добавить `    isConnecting: vi.fn(() => false),`.
2. После теста `POST /:id/reconnect clears the cooldown, then connects` добавить:

```js
  it('POST /:id/reconnect while the mailbox is still connecting starts nothing', async () => {
    imapManager.isConnecting.mockReturnValueOnce(true);
    const res = await fetch(`${base}/api/accounts/${ID}/reconnect`, { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(imapManager.isConnecting).toHaveBeenCalledWith(ID);
    expect(imapManager.clearConnectCooldown).not.toHaveBeenCalled();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bt src/services/imapManager.serverMailboxes.test.js src/routes/mail.sync.test.js src/routes/accounts.reconnectCooldown.test.js`
Expected: FAIL — нет `manualSyncDue`, `requestSync`, `requestFolderSync`, `isConnecting`; маршрут без `accountId` отвечает 200; повторное переподключение запускает подключение.

- [ ] **Step 4: Gate manual syncs in the manager**

В `backend/src/services/imapManager.js`:

1. Сразу после функции

```js
export function folderSyncDue(intervalMs, lastAt, now = Date.now()) {
  return intervalMs > 0 && now - (lastAt || 0) >= intervalMs;
}
```

добавить:

```js

// A manual "sync now" within this long of the mailbox's last sync starts nothing: the mail is
// already that fresh, and several people pressing the button must not stack syncs.
export const MANUAL_SYNC_MIN_GAP_MS = 15 * 1000;

export function manualSyncDue(lastAt, now = Date.now()) {
  return !Number.isFinite(lastAt) || now - lastAt >= MANUAL_SYNC_MIN_GAP_MS;
}
```

2. В конструкторе после строки `    this.onDemandSyncing = new Set(); // \`${accountId}:${folder}\` — prevent duplicate on-demand syncs` добавить:

```js
    this._manualSyncs = new Set();       // accountId — manual INBOX sync requested and still running
    this._manualFolderSyncs = new Set(); // accountId — manual folder-structure sync requested and still running
```

3. Заменить методы `syncNow(userId, accountId = null)` и `syncFoldersNow(userId, accountId = null)` вместе с комментарием над `syncFoldersNow` (от `  async syncNow(userId, accountId = null) {` до закрывающей `  }` метода `syncFoldersNow`, перед `  startSnoozeWatcher() {`) на:

```js
  isConnecting(accountId) {
    return this.connectingAccounts.has(accountId);
  }

  // Manual "sync now" of one mailbox. Decides synchronously, so the route can report a repeat:
  // nothing starts while a sync or connect of the mailbox runs, or within MANUAL_SYNC_MIN_GAP_MS
  // of its last successful INBOX sync. The sync itself runs in the background.
  requestSync(accountId, now = Date.now()) {
    if (this._manualSyncs.has(accountId) || this.syncingAccounts.has(accountId)
      || this.connectingAccounts.has(accountId) || !manualSyncDue(this.lastSyncOkAt.get(accountId), now)) {
      return { started: false };
    }
    this._manualSyncs.add(accountId);
    this.syncNow(accountId)
      .catch(err => console.error(`syncNow error for account ${accountId}:`, err.message))
      .finally(() => this._manualSyncs.delete(accountId));
    return { started: true };
  }

  // Manual folder-structure resync of one mailbox, gated like requestSync against the last
  // folder-structure sync.
  requestFolderSync(accountId, now = Date.now()) {
    if (this._manualFolderSyncs.has(accountId) || this.connectingAccounts.has(accountId)
      || !manualSyncDue(this.lastFolderSyncAt.get(accountId), now)) {
      return { started: false };
    }
    this._manualFolderSyncs.add(accountId);
    this.syncFoldersNow(accountId)
      .catch(err => console.error(`syncFoldersNow error for account ${accountId}:`, err.message))
      .finally(() => this._manualFolderSyncs.delete(accountId));
    return { started: true };
  }

  // INBOX sync of one mailbox for requestSync. The syncingAccounts check still covers an interval
  // tick that started after the request was accepted. Ends with sync_complete so the client stops
  // its spinner.
  async syncNow(accountId) {
    const { rows: [account] } = await query(
      "SELECT * FROM email_accounts WHERE id = $1 AND enabled = true AND protocol = 'imap'",
      [accountId]
    );
    if (!account) return;
    try {
      if (this.syncingAccounts.has(account.id)) {
        console.log(`syncNow: ${logAccount(account)} already syncing, skipping`);
        return;
      }
      const client = this.connections.get(account.id);
      if (!client) {
        console.log(`syncNow: ${logAccount(account)} not connected, reconnecting`);
        await this.connectAccount(account);
        return;
      }
      this.syncingAccounts.add(account.id);
      this.syncStartedAt.set(account.id, Date.now());
      let usedFreshSyncClient = false;
      try {
        // noBodyParts=true: metadata-only, same as the periodic interval sync.
        // Bodies are cached on first open; fetching them here would slow manual refresh.
        // For freshInboxSync providers (PurelyMail) the persistent connection can be "deaf"
        // to new mail, so a manual refresh must use a brand-new login too — otherwise the
        // button is less reliable than the automatic poll it's meant to shortcut.
        if (providerProfile(account).freshInboxSync) {
          usedFreshSyncClient = true;
          await this._syncInboxWithFreshLogin(account);
        } else {
          await this.syncMessages(account, client, 'INBOX', 20, false, true);
        }
        this.lastSyncOkAt.set(account.id, Date.now());
        console.log(`syncNow complete: ${logAccount(account)}`);
      } catch (err) {
        console.error(`syncNow error for ${logAccount(account)}:`, err.message);
        // Identity-guard: if this manual refresh hung and the staleness check meanwhile
        // reconnected a fresh client into the map slot, tear down ONLY the client this
        // syncNow used — never the healthy successor. Skip teardown entirely when the error
        // came from a fresh login (its own connection), not the persistent one.
        if (!usedFreshSyncClient) {
          const conn = this.connections.get(account.id);
          if (conn && conn === client) {
            try { await conn.logout(); } catch { /* already disconnected */ }
            this.connections.delete(account.id);
          }
        }
      } finally {
        this.syncingAccounts.delete(account.id);
        this.syncStartedAt.delete(account.id);
      }
    } finally {
      this.broadcast({ type: 'sync_complete', accountId: account.id }, account.user_id);
    }
  }

  // Folder-structure resync of one mailbox for requestFolderSync (sidebar "Sync folders now" /
  // accounts page). Metadata-only LIST + upsert, so it skips the syncingAccounts lock — safe to run
  // alongside a message sync. A disconnected mailbox reconnects instead, which runs syncFolders as
  // part of connectAccount's startup sequence.
  async syncFoldersNow(accountId) {
    const { rows: [account] } = await query(
      "SELECT * FROM email_accounts WHERE id = $1 AND enabled = true AND protocol = 'imap'",
      [accountId]
    );
    if (!account) return;
    try {
      const client = this.connections.get(account.id);
      if (!client) {
        console.log(`syncFoldersNow: ${logAccount(account)} not connected, reconnecting`);
        await this.connectAccount(account);
      } else {
        // Timeboxed like the initial connect sync (see connectAccount) so a
        // hung LIST can't wedge the manual resync.
        await raceTimeout(this.syncFolders(account, client), 20000, 'Manual folder sync');
      }
      this.lastFolderSyncAt.set(account.id, Date.now());
      this.broadcast({ type: 'folders_synced', accountId: account.id }, account.user_id);
    } catch (err) {
      console.error(`syncFoldersNow error for ${logAccount(account)}:`, err.message);
    }
  }
```

- [ ] **Step 5: Routes sync one mailbox**

В `backend/src/routes/mail.js` заменить оба обработчика — от комментария `// Manual sync (INBOX)` до конца `router.post('/sync-folders', ...)` (перед комментарием `// On-demand folder sync`) — на:

```js
// The mailbox a manual sync targets: one the user can reach. Answers 400/404 itself and returns
// null then.
async function findManualSyncTarget(req, res) {
  const accountId = req.body?.accountId;
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required', code: 'account_required' });
    return null;
  }
  if (!UUID_RE.test(accountId)) {
    res.status(400).json({ error: 'Invalid account id' });
    return null;
  }
  const { rows } = await query(
    'SELECT id, enabled, protocol FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!rows.length) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  return rows[0];
}

const manualSyncable = (account) => account.enabled && account.protocol === 'imap';

// Manual sync (INBOX) of one mailbox. The server services every mailbox, so a request while its
// sync runs or right after one finished starts nothing and says so.
router.post('/sync', async (req, res) => {
  const account = await findManualSyncTarget(req, res);
  if (!account) return;
  const { started } = manualSyncable(account) ? imapManager.requestSync(account.id) : { started: false };
  res.json(started ? { ok: true } : { ok: true, skipped: true });
});

// Manual folder-structure resync of one mailbox ("Sync folders now" in the sidebar account menu
// and on the accounts settings page). Refreshes the folder LIST so folders created or renamed in
// other clients appear without waiting for a reconnect; the folders_synced broadcast tells clients
// when to refetch the folder list.
router.post('/sync-folders', async (req, res) => {
  const account = await findManualSyncTarget(req, res);
  if (!account) return;
  const { started } = manualSyncable(account) ? imapManager.requestFolderSync(account.id) : { started: false };
  res.json(started ? { ok: true } : { ok: true, skipped: true });
});
```

Проверка: `grep -n "syncNow\|syncFoldersNow" backend/src/routes backend/src/plugins -r` выводит только тесты или ничего.

В `backend/src/routes/accounts.js` заменить обработчик:

```js
router.post('/:id/reconnect', async (req, res) => {
  const { id } = req.params;
  const result = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });

  // An explicit user request overrides any refusal/auth cooldown for one attempt.
  imapManager.clearConnectCooldown(id);
  imapManager.connectAccount(result.rows[0]).catch(console.error);
  res.json({ ok: true });
});
```

на:

```js
router.post('/:id/reconnect', async (req, res) => {
  const { id } = req.params;
  const result = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });

  // A second press while this mailbox is still connecting starts nothing.
  if (imapManager.isConnecting(id)) return res.json({ ok: true, skipped: true });
  // An explicit user request overrides any refusal/auth cooldown for one attempt.
  imapManager.clearConnectCooldown(id);
  imapManager.connectAccount(result.rows[0]).catch(console.error);
  res.json({ ok: true });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bt src/services/imapManager.serverMailboxes.test.js src/routes/mail.sync.test.js src/routes/accounts.reconnectCooldown.test.js src/routes/mail.createFolder.test.js src/services/imapManager.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/imapManager.js backend/src/services/imapManager.serverMailboxes.test.js backend/src/routes/mail.js backend/src/routes/mail.sync.test.js backend/src/routes/accounts.js backend/src/routes/accounts.reconnectCooldown.test.js
git commit -m "feat(sync): sync and reconnect one mailbox at a time and skip repeats"
```

---

### Task 6: Фронтенд: синхронизация с ящиком и интервалы в админке

**Files:**
- Create: `frontend/src/utils/mailboxSync.js`
- Test: `frontend/src/utils/mailboxSync.test.js`
- Modify: `frontend/src/utils/api.js:299-301`
- Modify: `frontend/src/components/MessageList.jsx` (импорты; `handleSync` ~680-702)
- Modify: `frontend/src/components/ElectronNotificationBridge.jsx` (импорты; действие `sync` ~284)
- Modify: `frontend/src/store/index.js` (~435-451, ~1096-1107)
- Create: `frontend/src/components/MailboxSyncSettings.jsx`
- Modify: `frontend/src/components/AdminPanel.jsx` (импорт; `LayoutsTab` ~1533 и ~1912-1983; `SecurityTab` перед «Status card»; поисковые пункты ~8189-8190 и ~8210)
- Modify: `frontend/src/locales/{cs,de,en,es,fr,it,pl,ru,zhCN}.json` (ключи в `admin.security`)

**Interfaces:**
- Consumes: `POST /api/mail/sync` и `/sync-folders` из Task 5; `GET /api/auth/preferences` → `syncInterval` и `PATCH /api/admin/settings` из Task 4.
- Produces:
  - `SYNC_INTERVAL_CHOICES_SEC`, `FOLDER_SYNC_INTERVAL_CHOICES_SEC`, `DEFAULT_SYNC_INTERVAL_SEC`, `DEFAULT_FOLDER_SYNC_INTERVAL_SEC`;
  - `manualSyncAccountIds(accounts, selectedAccountId = null) → string[]`;
  - `noSyncStarted(results) → boolean`;
  - `readSyncIntervals(settings) → { syncIntervalSec, folderSyncIntervalSec }`;
  - компонент `MailboxSyncSettings` (default export).

- [ ] **Step 1: Write the failing test**

`frontend/src/utils/mailboxSync.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { manualSyncAccountIds, noSyncStarted, readSyncIntervals } from './mailboxSync.js';

const accounts = [
  { id: 'a', enabled: true, protocol: 'imap' },
  { id: 'b', enabled: false, protocol: 'imap' },
  { id: 'c', enabled: true, protocol: 'pop3' },
  { id: 'd', enabled: true, protocol: 'imap' },
];

describe('manualSyncAccountIds', () => {
  it('syncs the open mailbox', () => {
    assert.deepEqual(manualSyncAccountIds(accounts, 'd'), ['d']);
  });

  it('syncs every enabled IMAP mailbox from the unified inbox', () => {
    assert.deepEqual(manualSyncAccountIds(accounts, null), ['a', 'd']);
    assert.deepEqual(manualSyncAccountIds(undefined), []);
  });

  it('asks for nothing when the open mailbox cannot sync', () => {
    assert.deepEqual(manualSyncAccountIds(accounts, 'b'), []);
    assert.deepEqual(manualSyncAccountIds(accounts, 'missing'), []);
  });
});

describe('noSyncStarted', () => {
  it('is true only when every request was skipped', () => {
    assert.equal(noSyncStarted([]), true);
    assert.equal(noSyncStarted([{ ok: true, skipped: true }]), true);
    assert.equal(noSyncStarted([{ ok: true, skipped: true }, { ok: true }]), false);
  });
});

describe('readSyncIntervals', () => {
  it('reads the stored text values', () => {
    assert.deepEqual(
      readSyncIntervals({ sync_interval_sec: '30', folder_sync_interval_sec: '0' }),
      { syncIntervalSec: 30, folderSyncIntervalSec: 0 },
    );
  });

  it('falls back to the defaults', () => {
    assert.deepEqual(readSyncIntervals({ sync_interval_sec: '45' }), { syncIntervalSec: 60, folderSyncIntervalSec: 1800 });
    assert.deepEqual(readSyncIntervals(undefined), { syncIntervalSec: 60, folderSyncIntervalSec: 1800 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --test src/utils/mailboxSync.test.js`
Expected: FAIL — `Cannot find module './mailboxSync.js'`.

- [ ] **Step 3: Write the helpers**

`frontend/src/utils/mailboxSync.js`:

```js
// Helpers for the mailbox sync the server runs. Choices and defaults mirror
// backend/src/services/syncSettings.js.

export const SYNC_INTERVAL_CHOICES_SEC = Object.freeze([15, 30, 60, 120]);
export const FOLDER_SYNC_INTERVAL_CHOICES_SEC = Object.freeze([0, 900, 1800, 3600]);
export const DEFAULT_SYNC_INTERVAL_SEC = 60;
export const DEFAULT_FOLDER_SYNC_INTERVAL_SEC = 1800;

// Mailboxes a manual "sync now" asks for: the open mailbox, or every enabled IMAP mailbox from the
// unified inbox. The server syncs one mailbox per request.
export function manualSyncAccountIds(accounts, selectedAccountId = null) {
  const syncable = (accounts || []).filter((account) => account?.enabled && account.protocol === 'imap');
  if (!selectedAccountId) return syncable.map((account) => account.id);
  return syncable.some((account) => account.id === selectedAccountId) ? [selectedAccountId] : [];
}

// True when no request started a sync, so no sync_complete event will follow.
export function noSyncStarted(results) {
  return (results || []).every((result) => result?.skipped === true);
}

function readChoice(raw, choices, fallback) {
  const seconds = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  return choices.includes(seconds) ? seconds : fallback;
}

// Sync intervals from GET /api/admin/settings, where values are text, with the defaults for
// anything missing or unexpected.
export function readSyncIntervals(settings) {
  return {
    syncIntervalSec: readChoice(settings?.sync_interval_sec, SYNC_INTERVAL_CHOICES_SEC, DEFAULT_SYNC_INTERVAL_SEC),
    folderSyncIntervalSec: readChoice(
      settings?.folder_sync_interval_sec, FOLDER_SYNC_INTERVAL_CHOICES_SEC, DEFAULT_FOLDER_SYNC_INTERVAL_SEC,
    ),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --test src/utils/mailboxSync.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Always send the mailbox**

В `frontend/src/utils/api.js` заменить:

```js
  syncNow: (accountId) => request('POST', '/mail/sync', accountId ? { accountId } : {}),
  syncFolder: (accountId, folder) => request('POST', '/mail/sync-folder', { accountId, folder }),
  syncFoldersNow: (accountId) => request('POST', '/mail/sync-folders', accountId ? { accountId } : {}),
```

на:

```js
  // Manual sync is per mailbox: the server answers { ok, skipped } and rejects a request without one.
  syncNow: (accountId) => request('POST', '/mail/sync', { accountId }),
  syncFolder: (accountId, folder) => request('POST', '/mail/sync-folder', { accountId, folder }),
  syncFoldersNow: (accountId) => request('POST', '/mail/sync-folders', { accountId }),
```

В `frontend/src/components/MessageList.jsx` после строки `import { shouldSyncFolder, folderSyncKey } from '../utils/folderSync.js';` добавить:

```js
import { manualSyncAccountIds, noSyncStarted } from '../utils/mailboxSync.js';
```

и заменить `handleSync`:

```js
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await api.syncNow(selectedAccountId || undefined);
```

и далее до конца функции на:

```js
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      // Sync is per mailbox: the unified inbox asks for each enabled IMAP mailbox.
      const results = await Promise.all(
        manualSyncAccountIds(accounts, selectedAccountId).map((accountId) => api.syncNow(accountId)),
      );
      // syncNow only covers INBOX. Without this, pressing sync while looking at Sent or any
      // other folder appeared to do nothing to that folder at all, which is the more
      // surprising half of the same gap. Forced: the user asked, so the interval does not
      // apply.
      if (shouldSyncFolder({ accountId: selectedAccountId, folder: selectedFolder, force: true })) {
        folderSyncedAtRef.current.set(folderSyncKey(selectedAccountId, selectedFolder), Date.now());
        api.syncFolder(selectedAccountId, selectedFolder)
          .catch(err => console.error('syncFolder failed:', err.message));
      }
      // A skipped request (a sync is running or has just finished) sends no sync_complete, so the
      // spinner stops here. Otherwise the server sends sync_complete via WebSocket, which triggers
      // mailexpert:refresh (list reload) and mailexpert:sync_done (spinner off).
      // Safety fallback: stop spinner after 15s in case WS event never arrives.
      if (noSyncStarted(results)) setSyncing(false);
      else setTimeout(() => setSyncing(false), 15000);
    } catch (err) {
      console.error('Sync failed:', err);
      setSyncing(false);
    }
  };
```

В `frontend/src/components/ElectronNotificationBridge.jsx` после строки `import { api } from '../utils/api.js';` добавить:

```js
import { manualSyncAccountIds } from '../utils/mailboxSync.js';
```

и в действии `sync` заменить `            await api.syncNow();` на:

```js
            // Sync is per mailbox: ask for every enabled IMAP mailbox.
            const { accounts } = useStore.getState();
            await Promise.all(manualSyncAccountIds(accounts).map((accountId) => api.syncNow(accountId)));
```

- [ ] **Step 6: Read-only interval in the store**

В `frontend/src/store/index.js` заменить:

```js
  syncInterval: parseInt(localStorage.getItem('mailexpert_sync_interval')) || 60,
  setSyncInterval: (seconds) => {
    localStorage.setItem('mailexpert_sync_interval', String(seconds));
    set({ syncInterval: seconds });
    schedulePrefSave({ syncInterval: String(seconds) });
  },
  // Folder-structure sync cadence in seconds; 0 = never. Explicit Number.isFinite
  // check because 0 is a valid stored value that `|| default` would clobber.
  folderSyncInterval: (() => {
    const v = parseInt(localStorage.getItem('mailexpert_folder_sync_interval'));
    return Number.isFinite(v) ? v : 1800;
  })(),
  setFolderSyncInterval: (seconds) => {
    localStorage.setItem('mailexpert_folder_sync_interval', String(seconds));
    set({ folderSyncInterval: seconds });
    schedulePrefSave({ folderSyncInterval: String(seconds) });
  },
```

на:

```js
  // Install-wide message sync interval in seconds, from GET /auth/preferences. Only MailApp's
  // refresh fallback while the WebSocket is down reads it; admins change it in security settings.
  syncInterval: 60,
```

и заменить:

```js
      if (prefs.syncInterval) {
        const n = parseInt(prefs.syncInterval) || 60;
        localStorage.setItem('mailexpert_sync_interval', String(n));
        set({ syncInterval: n });
      }
      if (prefs.folderSyncInterval != null) {
        const n = parseInt(prefs.folderSyncInterval);
        if ([0, 900, 1800, 3600].includes(n)) {
          localStorage.setItem('mailexpert_folder_sync_interval', String(n));
          set({ folderSyncInterval: n });
        }
      }
```

на:

```js
      if (prefs.syncInterval) set({ syncInterval: parseInt(prefs.syncInterval) || 60 });
```

- [ ] **Step 7: Admin section for the intervals**

`frontend/src/components/MailboxSyncSettings.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { FOLDER_SYNC_INTERVAL_CHOICES_SEC, SYNC_INTERVAL_CHOICES_SEC, readSyncIntervals } from '../utils/mailboxSync.js';

const SETTING_KEYS = { syncIntervalSec: 'sync_interval_sec', folderSyncIntervalSec: 'folder_sync_interval_sec' };
const SYNC_LABELS = { 15: '15s', 30: '30s', 60: '60s', 120: '2 min' };
const FOLDER_LABELS = { 900: '15 min', 1800: '30 min', 3600: '1 hour' };

// Admin-only: how often the server syncs every mailbox. Mailboxes are serviced by the server, so
// this is one install-wide setting rather than a personal preference.
export default function MailboxSyncSettings() {
  const { t } = useTranslation();
  const [values, setValues] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.admin.getSettings()
      .then((data) => setValues(readSyncIntervals(data.settings)))
      .catch((err) => setError(err.message));
  }, []);

  const choose = async (field, seconds) => {
    if (!values || values[field] === seconds) return;
    const previous = values;
    setValues({ ...values, [field]: seconds });
    setError('');
    try {
      await api.admin.updateSettings({ [SETTING_KEYS[field]]: seconds });
      // This browser's refresh fallback follows the message interval right away.
      if (field === 'syncIntervalSec') useStore.setState({ syncInterval: seconds });
    } catch (err) {
      setValues(previous);
      setError(err.message);
    }
  };

  const renderChoices = (field, title, desc, choices, labelFor) => (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 10 }}>{desc}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        {choices.map((seconds) => {
          const active = values?.[field] === seconds;
          return (
            <button
              key={seconds}
              type="button"
              disabled={!values}
              onClick={() => choose(field, seconds)}
              style={{
                flex: 1, padding: '7px 4px', fontSize: 13, fontWeight: 500,
                background: active ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                border: `2px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
                borderRadius: 7, cursor: values ? 'pointer' : 'default', outline: 'none',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {labelFor(seconds)}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '20px 24px', marginBottom: 20,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.security.mailboxSyncTitle')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
        {t('admin.security.mailboxSyncDesc')}
      </div>
      {renderChoices('syncIntervalSec', t('admin.messageList.syncFrequency'), t('admin.messageList.syncFrequencyDesc'),
        SYNC_INTERVAL_CHOICES_SEC, (seconds) => SYNC_LABELS[seconds])}
      {renderChoices('folderSyncIntervalSec', t('admin.messageList.folderSyncFrequency'), t('admin.messageList.folderSyncFrequencyDesc'),
        FOLDER_SYNC_INTERVAL_CHOICES_SEC, (seconds) => (seconds === 0 ? t('common.never') : FOLDER_LABELS[seconds]))}
      {error && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>{error}</div>}
    </div>
  );
}
```

В `frontend/src/components/AdminPanel.jsx`:

1. После строки `import GoogleUsersPanel from './GoogleUsersPanel.jsx';` добавить `import MailboxSyncSettings from './MailboxSyncSettings.jsx';`.
2. В `LayoutsTab` в деструктуризации `useStore()` заменить `swipeActions, setSwipeAction, syncInterval, setSyncInterval, folderSyncInterval, setFolderSyncInterval, threadedView,` на `swipeActions, setSwipeAction, threadedView,`.
3. В `LayoutsTab` удалить два блока разметки: от строки `      {/* Sync interval */}` включительно до строки `      {/* Threading mode */}`, не включая её (это блоки «Sync interval» и «Folder-structure sync interval», около 72 строк).
4. В `SecurityTab` перед строками

```jsx
      {/* Status card */}
      {!googleAuth && (
```

вставить:

```jsx
      {/* Mailbox sync intervals — admin only */}
      {user?.isAdmin && <MailboxSyncSettings />}

```

5. В списке поиска удалить две строки с `label: t('admin.messageList.syncFrequency')` и `label: t('admin.messageList.folderSyncFrequency')`, а после строки с `label: t('admin.security.mailPolicyTitle')` добавить:

```js
    { label: t('admin.security.mailboxSyncTitle'), keywords: ['sync', 'interval', 'frequency', 'refresh', 'poll', 'check mail', 'folder', 'structure', '15s', '30s', '60s', '15 min', '30 min', '1 hour', 'never'], tab: 'security', subtab: 'security', adminOnly: true, breadcrumb: secCrumb },
```

- [ ] **Step 8: Add the locale strings**

Создать временный `frontend/add-mailbox-sync-locale-keys.mjs`:

```js
import { readFileSync, writeFileSync } from 'node:fs';

const VALUES = {
  en: { mailboxSyncTitle: 'Mailbox Sync', mailboxSyncDesc: 'How often the server syncs every mailbox. One setting for the whole installation.' },
  ru: { mailboxSyncTitle: 'Синхронизация ящиков', mailboxSyncDesc: 'Как часто сервер синхронизирует все ящики. Настройка общая для всей установки.' },
  de: { mailboxSyncTitle: 'Postfach-Synchronisierung', mailboxSyncDesc: 'Wie oft der Server alle Postfächer synchronisiert. Gilt für die gesamte Installation.' },
  fr: { mailboxSyncTitle: 'Synchronisation des boîtes mail', mailboxSyncDesc: "Fréquence à laquelle le serveur synchronise toutes les boîtes mail. Ce réglage s'applique à toute l'installation." },
  es: { mailboxSyncTitle: 'Sincronización de buzones', mailboxSyncDesc: 'Con qué frecuencia el servidor sincroniza todos los buzones. El ajuste se aplica a toda la instalación.' },
  it: { mailboxSyncTitle: 'Sincronizzazione delle caselle', mailboxSyncDesc: "Ogni quanto il server sincronizza tutte le caselle di posta. L'impostazione vale per l'intera installazione." },
  pl: { mailboxSyncTitle: 'Synchronizacja skrzynek', mailboxSyncDesc: 'Jak często serwer synchronizuje wszystkie skrzynki. Ustawienie dotyczy całej instalacji.' },
  cs: { mailboxSyncTitle: 'Synchronizace schránek', mailboxSyncDesc: 'Jak často server synchronizuje všechny schránky. Nastavení platí pro celou instalaci.' },
  zhCN: { mailboxSyncTitle: '邮箱同步', mailboxSyncDesc: '服务器同步所有邮箱的频率。此设置适用于整个安装。' },
};

for (const [locale, values] of Object.entries(VALUES)) {
  const file = new URL(`./src/locales/${locale}.json`, import.meta.url);
  const text = readFileSync(file, 'utf8');
  if (JSON.parse(text).admin.security.mailboxSyncTitle) throw new Error(`${locale}: keys already exist`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const anchor = text.match(/^( *)"mailPolicyDesc": .*,\r?$/m);
  if (!anchor) throw new Error(`${locale}: mailPolicyDesc not found`);
  const lines = Object.entries(values)
    .map(([key, value]) => `${anchor[1]}${JSON.stringify(key)}: ${JSON.stringify(value)},${eol}`)
    .join('');
  const at = text.indexOf('\n', anchor.index) + 1;
  const updated = text.slice(0, at) + lines + text.slice(at);
  const parsed = JSON.parse(updated).admin.security;
  for (const [key, value] of Object.entries(values)) {
    if (parsed[key] !== value) throw new Error(`${locale}: admin.security.${key} did not round-trip`);
  }
  writeFileSync(file, updated);
}
console.log('admin.security mailbox sync keys added');
```

Run: `cd frontend && node add-mailbox-sync-locale-keys.mjs && rm add-mailbox-sync-locale-keys.mjs`
Expected: `admin.security mailbox sync keys added`.

- [ ] **Step 9: Run frontend checks**

Run: `cd frontend && node --test src/utils/mailboxSync.test.js src/locales/i18n.test.js && npx eslint src/components/MailboxSyncSettings.jsx src/components/AdminPanel.jsx src/components/MessageList.jsx src/components/ElectronNotificationBridge.jsx src/store/index.js src/utils/api.js src/utils/mailboxSync.js --max-warnings 0`
Expected: PASS, lint без ошибок.

Проверка остатков: `grep -rn "setSyncInterval\|setFolderSyncInterval\|folderSyncInterval\|api.syncNow()" frontend/src` ничего не выводит.

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/utils/mailboxSync.js frontend/src/utils/mailboxSync.test.js frontend/src/utils/api.js frontend/src/components/MessageList.jsx frontend/src/components/ElectronNotificationBridge.jsx frontend/src/store/index.js frontend/src/components/MailboxSyncSettings.jsx frontend/src/components/AdminPanel.jsx frontend/src/locales
git commit -m "feat(ui): sync one mailbox at a time and move sync intervals to admin settings"
```

---
### Task 7: Проверка на настоящей базе и запуск сервера, спецификация, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`
- Scratch: `<scratchpad>/sync-settings-smoke.mjs` (из Task 1), `<scratchpad>/boot-pr2.sh`, `<scratchpad>/pr2-body.md` (не коммитятся)

- [ ] **Step 1: Migration smoke on a fresh Postgres 16**

```bash
docker network create mailexpert-check
docker run -d --name mailexpert-check-db --network mailexpert-check -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=check -e POSTGRES_DB=mailexpert postgres:16-alpine
docker run -d --name mailexpert-check-redis --network mailexpert-check redis:7-alpine
docker exec mailexpert-check-db sh -c 'until pg_isready -U mailexpert >/dev/null; do sleep 1; done; sleep 2'
docker network connect mailexpert-check mailexpert-backend-test
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work'
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/sync-settings-smoke.mjs" mailexpert-backend-test:/work/backend/sync-settings-smoke.mjs
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-check-db -e DB_PASSWORD=check mailexpert-backend-test sh -c 'cd /work/backend && node sync-settings-smoke.mjs 2>&1 | tail -5'
```

Expected: последняя строка `sync settings smoke ok`. После неё в базе три ящика у двух пользователей.

- [ ] **Step 2: Boot the real server against that database**

CI сервер не запускает, поэтому запуск проверяется вручную. Сохранить `<scratchpad>/boot-pr2.sh`:

```sh
cd /work/backend
env SESSION_SECRET=0123456789abcdef0123456789abcdef0123 DB_HOST=mailexpert-check-db DB_USER=mailexpert DB_NAME=mailexpert DB_PASSWORD=check \
  REDIS_URL=redis://mailexpert-check-redis:6379 ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  NODE_ENV=development PORT=3000 IMAP_CONNECT_CONCURRENCY=1 node src/index.js > /tmp/boot.log 2>&1 &
PID=$!
for i in $(seq 1 60); do
  if ! kill -0 $PID 2>/dev/null; then echo "process exited"; tail -20 /tmp/boot.log; exit 1; fi
  if node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done
sleep 3
echo "--- startup lines"
grep -E "mailbox\(es\) on startup|Loading mailbox sync intervals failed|Startup mailbox connection error|FATAL|Unhandled" /tmp/boot.log
node -e "fetch('http://127.0.0.1:3000/api/auth/me').then(r=>console.log('/api/auth/me', r.status))"
kill $PID
```

Run:

```bash
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/boot-pr2.sh" mailexpert-backend-test:/work/backend/boot-pr2.sh
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh /work/backend/boot-pr2.sh
```

Expected:
- среди startup lines ровно одна строка `Connecting 3 mailbox(es) on startup, 1 at a time` и нет строк `Loading mailbox sync intervals failed`, `Startup mailbox connection error`, `FATAL`, `Unhandled`;
- `/api/auth/me 401`.

Ошибки подключения к `imap.example.com` в логе ожидаемы: это ненастоящий сервер.

Cleanup:

```bash
docker network disconnect mailexpert-check mailexpert-backend-test
docker rm -f mailexpert-check-db mailexpert-check-redis
docker network rm mailexpert-check
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test rm -f /work/backend/sync-settings-smoke.mjs /work/backend/boot-pr2.sh
```

- [ ] **Step 3: Record the clarifications in the spec**

В `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`:

1. Первую строку статуса заменить на:

```markdown
> Статус: дизайн одобрен 2026-09-15; PR 1 (вход) и PR 2 (сервер обслуживает ящики) реализованы. Работы по нескольким Google OAuth-приложениям (PR 2–5 из `2026-09-15-google-multi-app-design.md`) приостановлены до PR 3 этого документа и затем переписываются под общий список ящиков.
```

2. После строки `- Прямой вход пишет событие \`sso_login\` в \`auth_events\`.` (последний пункт раздела «Уточнения, принятые при реализации PR 1»; якорь выбран потому, что заголовок `## Проверка` совпадает с `### Проверка личности`) добавить:

```markdown

## Уточнения, принятые при реализации PR 2

- Очередь подключения при старте сохраняет разнос запусков по провайдерам (`connectStaggerFor`). Ящики, ждущие очереди, health check пропускает, а строка ящика перечитывается перед подключением.
- «Синхронизация завершилась меньше 15 секунд назад»: для писем — любая успешная синхронизация INBOX ящика (по интервалу, poll-only или ручная), для структуры папок — последняя синхронизация структуры папок. Выключенный ящик и ящик не по IMAP отвечают `skipped`.
- Пока ящики принадлежат пользователю (до PR 3), удаление пользователя в режиме `local` каскадно удаляет его ящики, поэтому отключает именно эти ящики, как `DELETE /api/accounts/:id`.
- Интервалы выбираются из наборов 15/30/60/120 секунд для писем и 0/900/1800/3600 секунд для структуры папок. Настройка — в админке, раздел «Безопасность». `GET /api/auth/preferences` отдаёт системный `syncInterval` только для резервного обновления списка без WebSocket.
- Единая лента и действие «sync» десктопных уведомлений запрашивают синхронизацию каждого включённого IMAP-ящика отдельно.
- `setupWebSocket` больше не получает `imapManager`.
```

- [ ] **Step 4: Full gate**

Run: `bt` (все backend-тесты), затем та же команда с `npm run lint && npm run lint:plugins` вместо `npx vitest run`.
Expected: все тесты проходят, lint чистый.

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: PASS.

`git status --short` не должен показывать `agent-changes/`, `.superpowers/`, временные `.mjs` и `.sh`.

- [ ] **Step 5: Commit, push, PR**

`<scratchpad>/pr2-body.md`:

```markdown
Second step of `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`: the server services mailboxes, so one person signing in or out no longer connects or drops anyone's mail.

## What changes

- Startup connects every enabled IMAP mailbox through a queue, `IMAP_CONNECT_CONCURRENCY` at a time (default 3), keeping the per-provider launch spacing. The health check leaves queued mailboxes to the queue.
- Sign-in (password, 2FA, OIDC), sign-out and WebSocket connections no longer connect or disconnect mailboxes; `connectAllForUser` and `disconnectUser` are gone. Deleting a user in local mode still disconnects the mailboxes its cascade removes.
- `POST /api/mail/sync` and `/sync-folders` take one mailbox. Without `accountId` they answer 400 `account_required`; a repeat while the mailbox syncs, connects or synced less than 15 seconds ago answers `{ ok: true, skipped: true }`. A second reconnect press while connecting starts nothing.
- Sync intervals are install-wide system settings (`sync_interval_sec`, `folder_sync_interval_sec`) that admins change under Settings → Security. Migration 0055 seeds them from the user who owns the most mailboxes and drops the personal keys.
- Frontend: sync always names a mailbox (the unified inbox asks for each one), the spinner stops on a skipped request, and the interval pickers moved from personal layout settings to the admin section.

## Not yet

- Mailboxes, rules, contacts and events are still per owner (PR 3). Do not switch production to `AUTH_MODE=google` before PR 3.

## Checks

- Backend: startup queue (concurrency, health check, re-read at its turn), no mailbox calls from sign-in modules, install-wide intervals and timer re-arming, manual sync gating, sync and reconnect routes, admin settings; full suite and lint.
- Postgres 16 smoke of migration 0055; real server boot with `IMAP_CONNECT_CONCURRENCY=1`.
- Frontend: tests, lint, build.
```

```bash
git add docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md
git commit -m "docs: record the mailbox servicing details settled while building it"
git push -u origin HEAD
gh pr create --repo wyrtensi/MailExpert --base main --title "feat(imap): let the server service mailboxes independently of sign-in" --body-file <scratchpad>/pr2-body.md
```

- [ ] **Step 6: Watch checks and merge**

```bash
gh pr checks --repo wyrtensi/MailExpert --watch
gh pr merge --repo wyrtensi/MailExpert --merge --delete-branch
git switch main && git pull --ff-only
```

Expected: все проверки зелёные до merge; после pull `main` содержит merge-коммит PR.

- [ ] **Step 7: Handoff and cleanup**

Дописать в локальный `agent-changes/2026-09-14-deps-oauth-handoff.md` (не коммитить) строку с номером PR, merge-коммитом и напоминанием: не включать `AUTH_MODE=google` до PR 3. Удалить тестовый контейнер: `docker rm -f mailexpert-backend-test`.

---

## Self-review

**Покрытие спецификации (раздел «Сервер обслуживает ящики» и пункт 2 «Разбиения на PR»):**
- Все включённые IMAP-ящики при старте ставятся в очередь и подключаются по `IMAP_CONNECT_CONCURRENCY` (по умолчанию 3), `IMAP_MAX_PERSISTENT_PER_HOST` не меняется — Task 2; проверка на настоящем запуске — Task 7.
- Вход, выход, открытие WebSocket не подключают и не отключают ящики; вызовы `connectAllForUser` из `auth.js`, `oidc.js`, `websocket.js` и `disconnectUser` из выхода и удаления пользователя убраны — Task 3. Отключение пользователя ящики и раньше не трогало (PR 1), удаление — уточнение 3.
- Восстановление упавших соединений остаётся в `imapManager` — health check не меняется, кроме пропуска ящиков в очереди (Task 2).
- `POST /api/mail/sync` и `/sync-folders` только с ящиком, 400 `account_required`, пропуск повторов в течение 15 секунд — Task 5; фронтенд всегда передаёт ящик — Task 6.
- Повторное «Переподключить» во время подключения ничего не запускает — Task 5.
- Системные `sync_interval_sec` и `folder_sync_interval_sec`, по умолчанию 60 секунд и 30 минут, меняет администратор — Task 1 и Task 4; интерфейс — Task 6; миграция из настроек владельца большинства ящиков — Task 1 (smoke — Task 1 и Task 7); поля убраны из личных настроек — Task 4 и Task 6.
- Тест `imapManager` из раздела «Проверка»: вход, выход и WebSocket не вызывают подключение и отключение ящиков (Task 3), повторный sync одного ящика пропускается (Task 5).

**Проверка на заглушки:** «TBD», «TODO», «аналогично Task N» и шагов без кода нет. Удаление крупных блоков (`connectAllForUser`, два блока в `LayoutsTab`) описано по точным якорям начала и конца, а не текстом целиком.

**Согласованность имён:** `loadSyncSettings() → { syncIntervalSec, folderSyncIntervalSec }` в Task 1, 4 и smoke; `applySyncSettings({ syncIntervalSec, folderSyncIntervalSec })` в Task 4 (менеджер, `index.js`, админка, тест); `connectAllEnabled({ concurrency })`, `_startupQueued`, `_needsConnect` в Task 2 и Task 3; `requestSync`/`requestFolderSync(accountId, now) → { started }`, `syncNow(accountId)`, `syncFoldersNow(accountId)`, `isConnecting(accountId)` в Task 5 и маршрутах; `setupWebSocket(wss, sessionMiddleware, { authorize })` в Task 3; `manualSyncAccountIds`, `noSyncStarted`, `readSyncIntervals` в Task 6; ключи `admin.security.mailboxSyncTitle`/`mailboxSyncDesc` в компоненте, поиске и локалях.
