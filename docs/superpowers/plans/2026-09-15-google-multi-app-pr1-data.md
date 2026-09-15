# Google multi-app, PR 1: данные и привязка токенов к приложению — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. В этом проекте пользователь выполняет планы без субагентов: использовать superpowers:executing-plans.

**Goal:** хранить Google OAuth-приложения в `google_oauth_apps`, журнал выдачи токенов в `google_oauth_grants`, привязывать каждый Gmail-ящик к приложению и обновлять токены через его приложение — без изменений для пользователя.

**Architecture:** миграция `0053` создаёт схему; новый модуль `services/oauth/googleApps.js` — единственный доступ к приложениям (чтение, журнал, состояние, импорт старой настройки, совместимость старой карточки). `googleOAuth.js` больше не читает окружение: клиентские данные передаются явно, а обновление токена загружает приложение ящика. Маршруты подключения используют приложение по умолчанию (самое старое не `disabled`) и записывают его id в OAuth state; старая карточка настроек продолжает работать через режим совместимости.

**Tech Stack:** Node.js 22, Express 5, PostgreSQL 16, Redis (node-redis 6), vitest 5, jose.

**Spec:** `docs/superpowers/specs/2026-09-15-google-multi-app-design.md` (разделы «Модель данных», «Обновление токенов», «Миграция существующей установки», «Разбиение на PR → PR 1», «Совместимость между PR»).

## Global Constraints

- Комментарии в коде — только на английском.
- Коммиты и PR от имени `wyrtensi`, без строк атрибуции; все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- Секреты, токены, коды авторизации и тексты ответов Google не попадают в логи, URL, ответы API и ошибки.
- Client ID приложения соответствует `^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$`; первая группа — `project_number`.
- Состояния приложения: `active`, `closed`, `disabled`.
- Монки-патчинг запрещён.
- Backend-тесты запускаются в `node:22-bookworm-slim` (локальный Node 24 и `node_modules` не подходят, `engines: >=22.19 <23`).

## Как запускать тесты

Один раз за сессию поднять контейнер и поставить зависимости:

```bash
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test -v "D:/hub/workspace/Projects/MailExpert:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && echo ready'
```

Запуск конкретных файлов (синхронизирует рабочее дерево в контейнер):

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npx vitest run <files>'
```

Ниже в шагах это записано как `bt <files>`. Полный прогон: `bt` без файлов, затем `npm run lint && npm run lint:plugins` той же командой вместо `npx vitest run`.

## Файлы

| Файл | Ответственность |
|---|---|
| Create `backend/migrations/0053_google_oauth_apps.sql` | Схема приложений, журнала, колонки `email_accounts` |
| Create `backend/src/services/oauth/googleApps.js` | Реестр приложений: разбор client ID, чтение, `resolveGoogleConfig`, журнал, состояние, импорт старой настройки, совместимость старой карточки |
| Create `backend/src/services/oauth/googleApps.test.js` | Тесты реестра |
| Modify `backend/src/services/oauth/googleOAuth.js` | Явные client ID/secret, обновление через приложение ящика |
| Modify `backend/src/services/oauth/googleOAuth.test.js` | Тесты под новые сигнатуры |
| Modify `backend/src/services/oauth/tokenManager.js` (+ test) | `app_unavailable` → «нужно переподключить» |
| Modify `backend/src/services/oauth/oauthState.js` (+ test) | `appId` в state |
| Modify `backend/src/routes/oauthGoogle.js` | Подключение через приложение по умолчанию, журнал, привязка ящика |
| Modify `backend/src/routes/oauth.google.test.js` | Тесты маршрутов |
| Modify `backend/src/routes/integrations.js` | Статус, совместимость старой карточки, импорт при старте |
| Modify `backend/src/routes/integrations.status.test.js` | Тесты интеграций |
| Modify `.env.example` | Описание новой роли `GOOGLE_CLIENT_ID`/`SECRET` |
| Modify `docs/superpowers/specs/2026-09-15-google-multi-app-design.md` | Импорт при старте вместо данных в SQL-миграции |

---

### Task 1: Миграция 0053

**Files:**
- Create: `backend/migrations/0053_google_oauth_apps.sql`

**Interfaces:**
- Produces: таблицы `google_oauth_apps(id, label, client_id, client_secret, project_number, user_limit, status, created_at, updated_at)`, `google_oauth_grants(app_id, email, google_sub, first_granted_at)`, колонки `email_accounts.oauth_app_id UUID`, `email_accounts.oauth_subject TEXT`.

- [ ] **Step 1: Создать миграцию**

```sql
-- Google OAuth apps (one per Google Cloud project), the journal of Google accounts each
-- app issued tokens to, and the app a Gmail account's tokens belong to. Existing
-- single-app settings are imported at startup by services/oauth/googleApps.js, which can
-- encrypt a legacy plaintext secret.
CREATE TABLE IF NOT EXISTS google_oauth_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(100) NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT NOT NULL,
  project_number TEXT NOT NULL UNIQUE,
  user_limit INTEGER NOT NULL DEFAULT 100 CHECK (user_limit > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS google_oauth_grants (
  app_id UUID NOT NULL REFERENCES google_oauth_apps(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  google_sub TEXT,
  first_granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, email)
);

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS oauth_app_id UUID REFERENCES google_oauth_apps(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS oauth_subject TEXT;

CREATE INDEX IF NOT EXISTS idx_email_accounts_oauth_app
  ON email_accounts (oauth_app_id) WHERE oauth_app_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_accounts_lower_email
  ON email_accounts (lower(email_address));
```

- [ ] **Step 2: Применить все миграции к чистому Postgres 16**

```bash
docker run -d --name mailexpert-mig-check -e POSTGRES_PASSWORD=check postgres:16-alpine
docker exec mailexpert-mig-check sh -c 'until pg_isready -U postgres >/dev/null; do sleep 1; done'
MSYS_NO_PATHCONV=1 docker cp backend/migrations mailexpert-mig-check:/migrations
docker exec mailexpert-mig-check sh -c 'for f in /migrations/*.sql; do psql -v ON_ERROR_STOP=1 -q -U postgres -f "$f" >/dev/null || { echo "FAILED $f"; exit 1; }; done; echo applied'
docker exec mailexpert-mig-check psql -U postgres -c '\d google_oauth_apps' -c '\d google_oauth_grants' -c '\d email_accounts'
```

Expected: `applied`; в выводе `\d` есть обе таблицы, `oauth_app_id uuid`, `oauth_subject text`, `idx_email_accounts_oauth_app`, `idx_email_accounts_lower_email`, внешний ключ `ON DELETE RESTRICT`.

- [ ] **Step 3: Удалить контейнер**

```bash
docker rm -f mailexpert-mig-check
```

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/0053_google_oauth_apps.sql
git commit -m "feat(oauth): add tables for several Google OAuth apps"
```

---

### Task 2: Реестр приложений — чтение, журнал, состояние

**Files:**
- Create: `backend/src/services/oauth/googleApps.js`
- Create: `backend/src/services/oauth/googleApps.test.js`

**Interfaces:**
- Consumes: `query`, `withTransaction` из `backend/src/services/db.js`; `decrypt` из `backend/src/services/encryption.js`.
- Produces:
  - `class GoogleAppError extends Error { code: string }`
  - `GOOGLE_APP_STATUSES: readonly ['active', 'closed', 'disabled']`
  - `parseGoogleClientId(clientId: unknown): string | null` — номер проекта
  - `getGoogleAppById(appId: string | null): Promise<AppRow | null>`
  - `getDefaultGoogleApp(): Promise<AppRow | null>` — самое старое не `disabled`
  - `getGoogleRedirectUri(): string | null`
  - `resolveGoogleConfig({ appId?: string | null } = {}): Promise<{ appId, clientId, clientSecret, redirectUri } | null>`
  - `recordGoogleGrant({ appId, email, sub? }, db = { query }): Promise<void>`
  - `setGoogleAppStatus(appId: string, status: string): Promise<string[]>` — id ящиков, помеченных при `disabled`
  - `AppRow = { id, label, client_id, client_secret, project_number, user_limit, status, created_at }`

- [ ] **Step 1: Написать падающие тесты**

`backend/src/services/oauth/googleApps.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => (v ? `enc(${v})` : v),
  // 'broken' stands for a value encrypted with another key: decrypt() returns null for it.
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc(') ? v.slice(4, -1) : v === 'broken' ? null : v),
}));

const { query, withTransaction } = await import('../db.js');
const {
  GoogleAppError,
  parseGoogleClientId,
  getGoogleAppById,
  getDefaultGoogleApp,
  resolveGoogleConfig,
  recordGoogleGrant,
  setGoogleAppStatus,
} = await import('./googleApps.js');

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
const APP = {
  id: 'app-1',
  label: 'Google 1',
  client_id: CLIENT_ID,
  client_secret: 'enc(app-secret)',
  project_number: '123456789012',
  user_limit: 100,
  status: 'active',
  created_at: new Date('2026-09-15T00:00:00Z'),
};

// Transaction client that routes SQL by pattern and records every call.
function scriptedClient(handlers) {
  const calls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push([sql, params]);
      for (const [re, result] of handlers) {
        if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  return { client, calls };
}

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  delete process.env.GOOGLE_REDIRECT_URI;
});
afterEach(() => {
  delete process.env.GOOGLE_REDIRECT_URI;
});

describe('parseGoogleClientId', () => {
  it('returns the Google Cloud project number of a web client ID', () => {
    expect(parseGoogleClientId(CLIENT_ID)).toBe('123456789012');
    expect(parseGoogleClientId(`  ${CLIENT_ID}  `)).toBe('123456789012');
  });

  it.each([
    ['no project number', 'abc123.apps.googleusercontent.com'],
    ['another domain', '123-abc.apps.example.com'],
    ['an upper-case suffix', '123-ABC.apps.googleusercontent.com'],
    ['a number', 42],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(parseGoogleClientId(value)).toBeNull();
  });
});

describe('app lookups', () => {
  it('picks the oldest app that is not disabled as the default', async () => {
    query.mockResolvedValue({ rows: [APP] });
    expect(await getDefaultGoogleApp()).toEqual(APP);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/FROM google_oauth_apps/);
    expect(sql).toMatch(/status <> 'disabled'/);
    expect(sql).toMatch(/ORDER BY created_at, id LIMIT 1/);
  });

  it('returns null when there is no default app', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getDefaultGoogleApp()).toBeNull();
  });

  it('loads an app by id in any status and skips the query without an id', async () => {
    query.mockResolvedValue({ rows: [{ ...APP, status: 'disabled' }] });
    expect(await getGoogleAppById('app-1')).toMatchObject({ id: 'app-1', status: 'disabled' });
    expect(query.mock.calls[0][1]).toEqual(['app-1']);

    query.mockClear();
    expect(await getGoogleAppById(null)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('resolveGoogleConfig', () => {
  it('combines the default app with the callback URL and decrypts the secret', async () => {
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [APP] });
    expect(await resolveGoogleConfig()).toEqual({
      appId: 'app-1', clientId: CLIENT_ID, clientSecret: 'app-secret', redirectUri: REDIRECT_URI,
    });
    expect(query.mock.calls[0][0]).toMatch(/status <> 'disabled'/);
  });

  it('uses the requested app instead of the default one', async () => {
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [{ ...APP, id: 'app-2', status: 'closed' }] });
    expect(await resolveGoogleConfig({ appId: 'app-2' })).toMatchObject({ appId: 'app-2' });
    expect(query.mock.calls[0][0]).toMatch(/WHERE id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['app-2']);
  });

  it('is null without a callback URL, without an app, for a disabled app or an undecryptable secret', async () => {
    query.mockResolvedValue({ rows: [APP] });
    expect(await resolveGoogleConfig()).toBeNull();

    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [] });
    expect(await resolveGoogleConfig()).toBeNull();

    query.mockResolvedValue({ rows: [{ ...APP, status: 'disabled' }] });
    expect(await resolveGoogleConfig({ appId: 'app-1' })).toBeNull();

    query.mockResolvedValue({ rows: [{ ...APP, client_secret: 'broken' }] });
    expect(await resolveGoogleConfig()).toBeNull();
  });
});

describe('recordGoogleGrant', () => {
  it('upserts one journal row per app and lower-cased email, keeping a known subject', async () => {
    query.mockResolvedValue({ rows: [] });
    await recordGoogleGrant({ appId: 'app-1', email: 'User@Gmail.com', sub: 'sub-1' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO google_oauth_grants \(app_id, email, google_sub\) VALUES \(\$1, lower\(\$2\), \$3\)/);
    expect(sql).toMatch(/ON CONFLICT \(app_id, email\) DO UPDATE SET google_sub = COALESCE\(google_oauth_grants\.google_sub, EXCLUDED\.google_sub\)/);
    expect(params).toEqual(['app-1', 'User@Gmail.com', 'sub-1']);
  });

  it('runs on a transaction client when one is passed', async () => {
    const { client } = scriptedClient([[/INSERT INTO google_oauth_grants/, { rows: [] }]]);
    await recordGoogleGrant({ appId: 'app-1', email: 'u@gmail.com' }, client);
    expect(client.query.mock.calls[0][1]).toEqual(['app-1', 'u@gmail.com', null]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('setGoogleAppStatus', () => {
  it('flags every mailbox of a disabled app for reconnect and returns their ids', async () => {
    const { client, calls } = scriptedClient([
      [/^\s*UPDATE google_oauth_apps/, { rows: [{ id: 'app-1' }] }],
      [/^\s*UPDATE email_accounts/, { rows: [{ id: 'acc-1' }, { id: 'acc-2' }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));

    expect(await setGoogleAppStatus('app-1', 'disabled')).toEqual(['acc-1', 'acc-2']);
    expect(calls[0][1]).toEqual(['app-1', 'disabled']);
    const [accountSql, accountParams] = calls[1];
    expect(accountSql).toMatch(/oauth_reconnect_required = true/);
    expect(accountSql).toMatch(/sync_error = 'oauth_reconnect_required'/);
    expect(accountSql).toMatch(/WHERE oauth_app_id = \$1/);
    expect(accountParams).toEqual(['app-1']);
  });

  it.each(['active', 'closed'])('leaves mailboxes alone when the status becomes %s', async (status) => {
    const { client, calls } = scriptedClient([[/^\s*UPDATE google_oauth_apps/, { rows: [{ id: 'app-1' }] }]]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await setGoogleAppStatus('app-1', status)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('rejects an unknown status without a transaction', async () => {
    const err = await setGoogleAppStatus('app-1', 'paused').catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAppError);
    expect(err.code).toBe('app_status_invalid');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('reports a missing app', async () => {
    const { client } = scriptedClient([[/^\s*UPDATE google_oauth_apps/, { rows: [] }]]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    const err = await setGoogleAppStatus('app-9', 'closed').catch((e) => e);
    expect(err.code).toBe('app_not_found');
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bt src/services/oauth/googleApps.test.js`
Expected: FAIL — `Failed to load url ./googleApps.js`.

- [ ] **Step 3: Реализовать модуль**

`backend/src/services/oauth/googleApps.js`:

```js
import { query, withTransaction } from '../db.js';
import { decrypt } from '../encryption.js';

// Google OAuth apps: one row per Google Cloud project. OAuth clients of one project share
// its unverified-app user cap, so the project number in the client ID identifies an app.
const GOOGLE_CLIENT_ID_PATTERN = /^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export const GOOGLE_APP_STATUSES = Object.freeze(['active', 'closed', 'disabled']);

const APP_COLUMNS = 'id, label, client_id, client_secret, project_number, user_limit, status, created_at';

// Stable, secret-free error for app registry operations.
export class GoogleAppError extends Error {
  constructor(code) {
    super(`Google OAuth app error: ${code}`);
    this.name = 'GoogleAppError';
    this.code = code;
  }
}

export function parseGoogleClientId(clientId) {
  if (typeof clientId !== 'string') return null;
  const match = GOOGLE_CLIENT_ID_PATTERN.exec(clientId.trim());
  return match ? match[1] : null;
}

export async function getGoogleAppById(appId) {
  if (!appId) return null;
  const { rows } = await query(`SELECT ${APP_COLUMNS} FROM google_oauth_apps WHERE id = $1`, [appId]);
  return rows[0] || null;
}

// The oldest app that is not disabled. Single-app code paths use it until the connect
// flow picks an app per mailbox.
export async function getDefaultGoogleApp() {
  const { rows } = await query(
    `SELECT ${APP_COLUMNS} FROM google_oauth_apps WHERE status <> 'disabled' ORDER BY created_at, id LIMIT 1`,
  );
  return rows[0] || null;
}

export function getGoogleRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || null;
}

// Credentials for one consent flow: the given app, or the default app. Null when the
// callback URL is missing, the app is missing or disabled, or its secret cannot be decrypted.
export async function resolveGoogleConfig({ appId = null } = {}) {
  const redirectUri = getGoogleRedirectUri();
  if (!redirectUri) return null;
  const app = appId ? await getGoogleAppById(appId) : await getDefaultGoogleApp();
  if (!app || app.status === 'disabled') return null;
  const clientSecret = decrypt(app.client_secret);
  if (!clientSecret) return null;
  return { appId: app.id, clientId: app.client_id, clientSecret, redirectUri };
}

// Journal the Google account an app issued tokens to. Google counts it against the app's
// user cap from that moment, so rows are kept when the mailbox is removed.
export async function recordGoogleGrant({ appId, email, sub = null }, db = { query }) {
  await db.query(
    `INSERT INTO google_oauth_grants (app_id, email, google_sub) VALUES ($1, lower($2), $3)
     ON CONFLICT (app_id, email) DO UPDATE SET google_sub = COALESCE(google_oauth_grants.google_sub, EXCLUDED.google_sub)`,
    [appId, email, sub],
  );
}

// Change an app's status. Disabling flags its mailboxes for reconnect through another app and
// returns their ids so the caller can drop their IMAP connections.
export async function setGoogleAppStatus(appId, status) {
  if (!GOOGLE_APP_STATUSES.includes(status)) throw new GoogleAppError('app_status_invalid');
  return withTransaction(async (client) => {
    const updated = await client.query(
      'UPDATE google_oauth_apps SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING id',
      [appId, status],
    );
    if (!updated.rows.length) throw new GoogleAppError('app_not_found');
    if (status !== 'disabled') return [];
    const flagged = await client.query(
      `UPDATE email_accounts SET oauth_reconnect_required = true, sync_error = 'oauth_reconnect_required'
       WHERE oauth_app_id = $1 RETURNING id`,
      [appId],
    );
    return flagged.rows.map((row) => row.id);
  });
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `bt src/services/oauth/googleApps.test.js`
Expected: PASS, все тесты файла.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/oauth/googleApps.js backend/src/services/oauth/googleApps.test.js
git commit -m "feat(oauth): add the Google OAuth app registry"
```

---

### Task 3: Импорт старой настройки Google

**Files:**
- Modify: `backend/src/services/oauth/googleApps.js`
- Modify: `backend/src/services/oauth/googleApps.test.js`

**Interfaces:**
- Consumes: `parseGoogleClientId`, `withTransaction`, `encrypt`, `decrypt`.
- Produces: `importLegacyGoogleConfig(): Promise<string | null>` — id созданного приложения или `null`.

- [ ] **Step 1: Написать падающие тесты**

Добавить `importLegacyGoogleConfig` в импорт в начале `googleApps.test.js` и дописать в конец файла:

```js
describe('importLegacyGoogleConfig', () => {
  let errorSpy;
  let logSpy;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });
  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  function importDb({ appExists = false, config = null } = {}) {
    const { client, calls } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/^\s*SELECT 1 FROM google_oauth_apps/, { rows: appExists ? [{ '?column?': 1 }] : [] }],
      [/^\s*SELECT config FROM integration_config/, { rows: config ? [{ config }] : [] }],
      [/^\s*INSERT INTO google_oauth_apps/, { rows: [{ id: 'app-new' }] }],
      [/^\s*UPDATE email_accounts SET oauth_app_id/, { rows: [], rowCount: 2 }],
      [/^\s*INSERT INTO google_oauth_grants/, { rows: [] }],
      [/^\s*UPDATE integration_config/, { rows: [] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    return calls;
  }
  const findCall = (calls, re) => calls.find(([sql]) => re.test(sql));

  it('does nothing once an app exists', async () => {
    const calls = importDb({ appExists: true, config: { clientId: CLIENT_ID, clientSecret: 'enc(s)' } });
    expect(await importLegacyGoogleConfig()).toBeNull();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
  });

  it('imports the stored client, binds Gmail accounts, fills the journal and keeps only the callback URL', async () => {
    const calls = importDb({ config: { clientId: CLIENT_ID, clientSecret: 'enc(stored-secret)', redirectUri: REDIRECT_URI } });

    expect(await importLegacyGoogleConfig()).toBe('app-new');

    expect(findCall(calls, /pg_advisory_xact_lock/)[0]).toMatch(/hashtext\('google-oauth-app-import'\)/);
    const [insertSql, insertParams] = findCall(calls, /INSERT INTO google_oauth_apps/);
    expect(insertSql).toMatch(/'Google 1'/);
    expect(insertParams).toEqual([CLIENT_ID, 'enc(stored-secret)', '123456789012']);
    const [bindSql, bindParams] = findCall(calls, /UPDATE email_accounts SET oauth_app_id/);
    expect(bindSql).toMatch(/oauth_provider = 'google' AND oauth_app_id IS NULL/);
    expect(bindParams).toEqual(['app-new']);
    const [grantSql, grantParams] = findCall(calls, /INSERT INTO google_oauth_grants/);
    expect(grantSql).toMatch(/SELECT DISTINCT \$1::uuid, lower\(email_address\)/);
    expect(grantSql).toMatch(/ON CONFLICT \(app_id, email\) DO NOTHING/);
    expect(grantParams).toEqual(['app-new']);
    expect(findCall(calls, /UPDATE integration_config/)[0]).toMatch(/jsonb_build_object\('redirectUri', config->'redirectUri'\)/);
  });

  it('encrypts a legacy plaintext secret', async () => {
    const calls = importDb({ config: { clientId: CLIENT_ID, clientSecret: 'plain-secret' } });
    await importLegacyGoogleConfig();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)[1][1]).toBe('enc(plain-secret)');
  });

  it('falls back to the environment when nothing is stored', async () => {
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    const calls = importDb();
    expect(await importLegacyGoogleConfig()).toBe('app-new');
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)[1]).toEqual([CLIENT_ID, 'enc(env-secret)', '123456789012']);
    expect(findCall(calls, /UPDATE integration_config/)).toBeUndefined();
  });

  it('does nothing without any stored or environment client', async () => {
    const calls = importDb();
    expect(await importLegacyGoogleConfig()).toBeNull();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reports a client ID that is not a Google OAuth client ID instead of importing it', async () => {
    const calls = importDb({ config: { clientId: 'gid', clientSecret: 'enc(top-secret)' } });
    expect(await importLegacyGoogleConfig()).toBeNull();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toMatch(/not a Google OAuth client ID/);
    expect(logged).not.toMatch(/top-secret|gid/);
  });

  it('reports a stored secret that cannot be decrypted', async () => {
    const calls = importDb({ config: { clientId: CLIENT_ID, clientSecret: 'broken' } });
    expect(await importLegacyGoogleConfig()).toBeNull();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
    expect(JSON.stringify(errorSpy.mock.calls)).toMatch(/cannot be decrypted/);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bt src/services/oauth/googleApps.test.js`
Expected: FAIL — `importLegacyGoogleConfig is not a function`.

- [ ] **Step 3: Реализовать импорт**

В `googleApps.js` заменить импорт шифрования на `import { encrypt, decrypt } from '../encryption.js';` и добавить в конец файла:

```js
// One-time import of the single-app settings (Settings → Integrations, or the
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment) as the first app. Runs at every
// startup and does nothing once any app exists.
export async function importLegacyGoogleConfig() {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-import'))");
    const existing = await client.query('SELECT 1 FROM google_oauth_apps LIMIT 1');
    if (existing.rows.length) return null;

    const stored = await client.query("SELECT config FROM integration_config WHERE provider = 'google'");
    const config = stored.rows[0]?.config || {};
    let source = null;
    if (config.clientId && config.clientSecret) {
      source = { from: 'the stored integration settings', clientId: config.clientId, clientSecret: decrypt(config.clientSecret) };
    } else if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      source = { from: 'the environment', clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
    }
    if (!source) return null;

    const projectNumber = parseGoogleClientId(source.clientId);
    if (!projectNumber) {
      console.error(`Google OAuth: the client ID from ${source.from} is not a Google OAuth client ID; add the app again in Settings → Integrations`);
      return null;
    }
    if (!source.clientSecret) {
      console.error(`Google OAuth: the client secret from ${source.from} cannot be decrypted; add the app again in Settings → Integrations`);
      return null;
    }

    const inserted = await client.query(
      `INSERT INTO google_oauth_apps (label, client_id, client_secret, project_number)
       VALUES ('Google 1', $1, $2, $3) RETURNING id`,
      [source.clientId.trim(), encrypt(source.clientSecret), projectNumber],
    );
    const appId = inserted.rows[0].id;
    await client.query(
      `UPDATE email_accounts SET oauth_app_id = $1 WHERE oauth_provider = 'google' AND oauth_app_id IS NULL`,
      [appId],
    );
    await client.query(
      `INSERT INTO google_oauth_grants (app_id, email)
       SELECT DISTINCT $1::uuid, lower(email_address) FROM email_accounts WHERE oauth_app_id = $1
       ON CONFLICT (app_id, email) DO NOTHING`,
      [appId],
    );
    if (stored.rows.length) {
      await client.query(
        `UPDATE integration_config
         SET config = jsonb_strip_nulls(jsonb_build_object('redirectUri', config->'redirectUri')), updated_at = NOW()
         WHERE provider = 'google'`,
      );
    }
    console.log(`Google OAuth: imported the client from ${source.from} as app "Google 1"`);
    return appId;
  });
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `bt src/services/oauth/googleApps.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/oauth/googleApps.js backend/src/services/oauth/googleApps.test.js
git commit -m "feat(oauth): import the single Google client as the first app"
```

---

### Task 4: Google OAuth получает клиентские данные явно

**Files:**
- Modify: `backend/src/services/oauth/googleOAuth.js`
- Modify: `backend/src/services/oauth/googleOAuth.test.js`
- Modify: `backend/src/services/oauth/tokenManager.js:24-25`
- Modify: `backend/src/services/oauth/tokenManager.test.js`
- Modify: `backend/src/routes/oauthGoogle.js`
- Modify: `backend/src/routes/oauth.google.test.js`
- Modify: `backend/src/routes/integrations.js:5,53-62`
- Modify: `backend/src/routes/integrations.status.test.js`

**Interfaces:**
- Consumes: `getGoogleAppById`, `resolveGoogleConfig` (Task 2).
- Produces:
  - `buildGoogleAuthorizationUrl({ clientId, state, codeChallenge, redirectUri, loginHint }): string`
  - `exchangeGoogleCode({ clientId, clientSecret, code, codeVerifier, redirectUri }): Promise<Tokens>`
  - `refreshGoogleToken(account)` — берёт приложение по `account.oauth_app_id`; без приложения или для `disabled` бросает `GoogleOAuthError('authentication_failed', { oauthError: 'app_unavailable' })`.
  - `getGoogleConfig` и `isGoogleConfigured` удалены.

- [ ] **Step 1: Обновить тесты `googleOAuth.test.js`**

1. После `vi.mock('../encryption.js', …)` добавить мок реестра:

```js
vi.mock('./googleApps.js', () => ({ getGoogleAppById: vi.fn() }));
```

2. Заменить блок импорта и констант (от `const { SignJWT … } = await import('jose');` до конца `afterEach`) на:

```js
const { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } = await import('jose');
const { query } = await import('../db.js');
const { getGoogleAppById } = await import('./googleApps.js');
const {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  verifyGoogleIdToken,
  refreshGoogleToken,
  hasGoogleMailScope,
  GOOGLE_MAIL_SCOPE,
} = await import('./googleOAuth.js');

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const CLIENT_SECRET = 'very-secret-client-secret';
const REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
const APP = { id: 'app-1', client_id: CLIENT_ID, client_secret: `enc(${CLIENT_SECRET})`, status: 'active' };
const jsonRes = (ok, body, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  getGoogleAppById.mockReset();
  getGoogleAppById.mockResolvedValue(APP);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
```

3. Удалить `describe('isGoogleConfigured', …)`.

4. В `describe('buildGoogleAuthorizationUrl')` добавить `clientId: CLIENT_ID,` в оба вызова `buildGoogleAuthorizationUrl({ … })`.

5. В `describe('exchangeGoogleCode')` заменить три вызова на `exchangeGoogleCode({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: …, codeVerifier: …, redirectUri: REDIRECT_URI })` с прежними `code`/`codeVerifier` и добавить тест:

```js
  it('fails with not_configured without client credentials and never calls Google', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await exchangeGoogleCode({ clientId: CLIENT_ID, clientSecret: '', code: 'c', codeVerifier: 'v', redirectUri: REDIRECT_URI }).catch(e => e);
    expect(err.code).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
```

6. В `describe('refreshGoogleToken')` заменить `const account = …` на

```js
  const account = { id: 'acc-1', oauth_provider: 'google', oauth_app_id: 'app-1', oauth_refresh_token: 'enc(stored-rt)' };
```

в первом тесте после `expect(body.get('client_secret')).toBe(CLIENT_SECRET);` добавить

```js
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(getGoogleAppById).toHaveBeenCalledWith('app-1');
```

и заменить тест `'fails with not_configured when the integration is missing'` на:

```js
  it.each([
    ['no app is bound', { oauth_app_id: null }, null],
    ['the app was removed', {}, null],
    ['the app is disabled', {}, { ...APP, status: 'disabled' }],
  ])('needs reconnect when %s, without calling Google', async (_label, overrides, app) => {
    getGoogleAppById.mockResolvedValue(app);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await refreshGoogleToken({ ...account, ...overrides }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
    expect(err.oauthError).toBe('app_unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps refreshing through a closed app', async () => {
    getGoogleAppById.mockResolvedValue({ ...APP, status: 'closed' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(true, { access_token: 'new-at', expires_in: 3600 })));
    await expect(refreshGoogleToken(account)).resolves.toMatchObject({ oauth_access_token: 'new-at' });
  });

  it('fails with not_configured when the app secret cannot be decrypted', async () => {
    getGoogleAppById.mockResolvedValue({ ...APP, client_secret: null });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await refreshGoogleToken(account).catch(e => e);
    expect(err.code).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Тест token manager для `app_unavailable`**

В `tokenManager.test.js` после теста `'treats a missing refresh token as requiring reconnect'` добавить:

```js
  it('treats an unavailable Google app as requiring reconnect', async () => {
    refreshGoogleToken.mockRejectedValue(providerError('app_unavailable'));
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    const err = await refreshOAuthToken(googleAccount()).catch(e => e);
    expect(err.code).toBe('oauth_reconnect_required');
  });
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `bt src/services/oauth/googleOAuth.test.js src/services/oauth/tokenManager.test.js`
Expected: FAIL — `client_id` не совпадает, `app_unavailable` не возвращается, новый тест token manager получает `oauth_refresh_failed`.

- [ ] **Step 4: Реализовать `googleOAuth.js` и token manager**

В `googleOAuth.js`:

1. Добавить импорт `import { getGoogleAppById } from './googleApps.js';`.
2. Удалить функции `getGoogleConfig` и `isGoogleConfigured`.
3. Заменить `buildGoogleAuthorizationUrl`:

```js
export function buildGoogleAuthorizationUrl({ clientId, state, codeChallenge, redirectUri, loginHint }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${GOOGLE_AUTH_URL}?${params}`;
}
```

4. В `exchangeGoogleCode` заменить сигнатуру и первые две строки:

```js
export async function exchangeGoogleCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  if (!clientId || !clientSecret) throw new GoogleOAuthError('not_configured');
```

5. Заменить комментарий и начало `refreshGoogleToken` до строки `const storedRefreshToken = …`:

```js
// Refresh a Google access token through the app that issued it and persist the result. The
// stored refresh token is kept when Google does not return a new one. Returns the account
// with the plaintext access token, matching refreshMicrosoftToken.
export async function refreshGoogleToken(account) {
  const app = await getGoogleAppById(account.oauth_app_id);
  // A refresh token only works with its issuing client: without that app the mailbox has
  // to consent again, through another app.
  if (!app || app.status === 'disabled') {
    throw new GoogleOAuthError('authentication_failed', { oauthError: 'app_unavailable' });
  }
  const clientSecret = decrypt(app.client_secret);
  if (!clientSecret) throw new GoogleOAuthError('not_configured');
```

и в теле запроса обновления заменить `client_id: clientId,` на `client_id: app.client_id,` (строка `client_secret: clientSecret,` остаётся).

В `tokenManager.js` заменить объявление набора:

```js
// Provider error codes that no retry can fix: only a new user consent helps. app_unavailable
// means the Google app that issued the tokens was disabled or removed.
const RECONNECT_OAUTH_ERRORS = new Set(['invalid_grant', 'missing_refresh_token', 'app_unavailable']);
```

- [ ] **Step 5: Переключить маршруты на `resolveGoogleConfig`**

`oauthGoogle.js` — заменить импорт из `googleOAuth.js` и добавить импорт реестра:

```js
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  hasGoogleMailScope,
  verifyGoogleIdToken,
} from '../services/oauth/googleOAuth.js';
import { resolveGoogleConfig } from '../services/oauth/googleApps.js';
```

Заменить обработчик `router.get('/')` целиком:

```js
// Step 1: create state + PKCE and send the user to Google's consent screen.
router.get('/', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });

  const rawHint = typeof req.query.login_hint === 'string' ? req.query.login_hint.trim() : '';
  const loginHint = LOGIN_HINT_PATTERN.test(rawHint) ? rawHint : null;

  try {
    const config = await resolveGoogleConfig();
    if (!config) return res.redirect(errorRedirect('not_configured'));
    const { state, codeChallenge } = await createOAuthState({
      provider: PROVIDER,
      userId: req.session.userId,
      loginHint,
    });
    res.redirect(buildGoogleAuthorizationUrl({
      clientId: config.clientId,
      state,
      codeChallenge,
      redirectUri: config.redirectUri,
      loginHint,
    }));
  } catch (err) {
    console.error(`Google OAuth start failed: ${err?.name || 'Error'}`);
    res.redirect(errorRedirect('authentication_failed'));
  }
});
```

В callback заменить строки от `if (!isGoogleConfigured()) throw new CallbackError('not_configured');` до `const identity = await verifyGoogleIdToken(…);` на:

```js
    const config = await resolveGoogleConfig();
    if (!config) throw new CallbackError('not_configured');
    // The flow must finish in the same MailExpert session that started it.
    if (!pending || !req.session?.userId || req.session.userId !== pending.userId) {
      throw new CallbackError('invalid_state');
    }
    if (typeof code !== 'string' || !code) throw new CallbackError('authentication_failed');

    const tokens = await exchangeGoogleCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: config.redirectUri,
    });
    if (!hasGoogleMailScope(tokens.scope)) throw new CallbackError('scope_missing');

    const identity = await verifyGoogleIdToken({ idToken: tokens.idToken, clientId: config.clientId });
```

`integrations.js` — заменить импорт `isGoogleConfigured` на `import { resolveGoogleConfig } from '../services/oauth/googleApps.js';` и обработчик `/status`:

```js
router.get('/status', async (req, res) => {
  const google = await resolveGoogleConfig();
  res.json({
    microsoft: {
      configured: !!process.env.MS_CLIENT_ID,
    },
    google: {
      configured: !!google,
    },
  });
});
```

- [ ] **Step 6: Обновить тесты маршрутов**

`oauth.google.test.js`:

1. После мока `../services/encryption.js` добавить:

```js
// The registry is covered by googleApps.test.js; routes see only the resolved credentials.
const googleApps = vi.hoisted(() => ({ config: null }));
vi.mock('../services/oauth/googleApps.js', () => ({
  resolveGoogleConfig: vi.fn(async () => googleApps.config),
}));
```

2. Заменить константы `CLIENT_ID` и добавить `APP_ID`:

```js
const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const APP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
```

3. В `beforeEach` заменить три строки `process.env.GOOGLE_* = …` на

```js
  googleApps.config = { appId: APP_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI };
```

а в `afterEach` удалить три строки `delete process.env.GOOGLE_*`.

4. В тесте `'redirects with not_configured when the integration is incomplete'` заменить `delete process.env.GOOGLE_CLIENT_SECRET;` на `googleApps.config = null;`.

5. В тесте `'redirects with not_configured when the integration was removed mid-flow'` заменить `delete process.env.GOOGLE_CLIENT_ID;` на `googleApps.config = null;`.

6. В тесте `'creates a Gmail account …'` заменить ожидание вызова обмена:

```js
    expect(exchangeGoogleCode).toHaveBeenCalledWith({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: 'auth-code-xyz', codeVerifier: saved.codeVerifier, redirectUri: REDIRECT_URI,
    });
```

`integrations.status.test.js`:

1. После мока `../middleware/auth.js` добавить:

```js
const googleApps = vi.hoisted(() => ({ config: null }));
vi.mock('../services/oauth/googleApps.js', () => ({
  resolveGoogleConfig: vi.fn(async () => googleApps.config),
}));
```

2. В `afterEach` добавить `googleApps.config = null;`.

3. В тесте `'never leaks credentials in the response'` удалить три строки `process.env.GOOGLE_* = …` и вместо них поставить

```js
    googleApps.config = {
      appId: 'app-1',
      clientId: '123456789012-google-client-id.apps.googleusercontent.com',
      clientSecret: 'google-client-secret',
      redirectUri: 'https://mail.example.com/oauth/google/callback',
    };
```

(проверки `not.toContain('google-client-id')`, `'google-client-secret'`, `'mail.example.com'` остаются).

4. Заменить тест `'reports google configured only when client id, secret and redirect uri are all set'` на:

```js
  it('reports google configured when a Google app resolves', async () => {
    let res = await fetch(`${base}/api/integrations/status`);
    expect((await res.json()).google).toEqual({ configured: false });

    googleApps.config = { appId: 'app-1', clientId: 'x', clientSecret: 'y', redirectUri: 'https://mail.example.com/oauth/google/callback' };
    res = await fetch(`${base}/api/integrations/status`);
    expect((await res.json()).google).toEqual({ configured: true });
  });
```

5. В тесте `'clears env vars for fields removed from the saved config'` проверка `status … configured: false` остаётся верной без изменений.

- [ ] **Step 7: Убедиться, что все затронутые тесты проходят**

Run: `bt src/services/oauth/googleOAuth.test.js src/services/oauth/tokenManager.test.js src/routes/oauth.google.test.js src/routes/integrations.status.test.js src/services/imapManager.oauthRefresh.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/oauth/googleOAuth.js backend/src/services/oauth/googleOAuth.test.js backend/src/services/oauth/tokenManager.js backend/src/services/oauth/tokenManager.test.js backend/src/routes/oauthGoogle.js backend/src/routes/oauth.google.test.js backend/src/routes/integrations.js backend/src/routes/integrations.status.test.js
git commit -m "refactor(oauth): pass Google client credentials explicitly and refresh through the mailbox app"
```

---

### Task 5: Подключение Gmail привязывает ящик к приложению и пишет журнал

**Files:**
- Modify: `backend/src/services/oauth/oauthState.js`
- Modify: `backend/src/services/oauth/oauthState.test.js`
- Modify: `backend/src/routes/oauthGoogle.js`
- Modify: `backend/src/routes/oauth.google.test.js`

**Interfaces:**
- Consumes: `resolveGoogleConfig({ appId })`, `recordGoogleGrant({ appId, email, sub })` (Task 2).
- Produces:
  - `createOAuthState({ provider, userId, loginHint?, appId? })`; сохранённый JSON: `{ userId, codeVerifier, loginHint, appId }`.
  - `consumeOAuthState(...)` → `{ userId, codeVerifier, loginHint, appId }` (`appId: string | null`).
  - `email_accounts.oauth_app_id` и `oauth_subject` заполняются при подключении Gmail.

- [ ] **Step 1: Тесты state**

В `oauthState.test.js`:

1. В первом тесте заменить ожидание сохранённого объекта:

```js
    expect(saved).toEqual({ userId: 'u1', codeVerifier: expect.any(String), loginHint: 'x@gmail.com', appId: null });
```

2. В тесте `'consumes a state exactly once'` заменить ожидание:

```js
    expect(first).toEqual({ userId: 'u1', codeVerifier: expect.any(String), loginHint: null, appId: null });
```

3. Добавить тест после него:

```js
  it('carries the chosen Google app through the flow', async () => {
    const { state } = await createOAuthState({ provider: 'google', userId: 'u1', appId: 'app-1' });
    expect(await consumeOAuthState({ provider: 'google', state })).toMatchObject({ appId: 'app-1' });
  });
```

- [ ] **Step 2: Тесты маршрутов**

В `oauth.google.test.js`:

1. Заменить мок реестра:

```js
// The registry is covered by googleApps.test.js; routes see only the resolved credentials.
const googleApps = vi.hoisted(() => ({ config: null, byId: {} }));
vi.mock('../services/oauth/googleApps.js', () => ({
  resolveGoogleConfig: vi.fn(async ({ appId = null } = {}) => (appId ? googleApps.byId[appId] ?? null : googleApps.config)),
  recordGoogleGrant: vi.fn(async () => {}),
}));
```

2. Добавить `recordGoogleGrant` в импорт: `import { recordGoogleGrant } from '../services/oauth/googleApps.js';`.

3. В `beforeEach` после строки с `googleApps.config = …` добавить

```js
  googleApps.byId = { [APP_ID]: googleApps.config };
  recordGoogleGrant.mockClear();
```

4. В `installDb` заменить регулярку выбора существующего ящика на `/^\s*SELECT id, oauth_refresh_token, oauth_app_id FROM email_accounts/`, и так же в тесте `'updates an existing account …'` в строке `sqlCall(/^\s*SELECT id, oauth_refresh_token FROM email_accounts/)`.

5. В `describe('GET /oauth/google')` в тесте `'stores state + PKCE verifier …'` заменить ожидание сохранённого объекта:

```js
    expect(saved).toMatchObject({ userId: USER_ID, loginHint: 'user@gmail.com', appId: APP_ID });
```

6. В тесте `'creates a Gmail account …'` заменить проверки SQL вставки на:

```js
    const [insertSql, insertParams] = sqlCall(/^\s*INSERT INTO email_accounts/);
    expect(insertSql).toMatch(/'imap\.gmail\.com', 993, true/);
    expect(insertSql).toMatch(/'smtp\.gmail\.com', 465, 'SSL'/);
    expect(insertSql).toMatch(/'google'/);
    expect(insertSql).toMatch(/include_in_unified_inbox,\s*oauth_app_id, oauth_subject/);
    expect(insertSql).toMatch(/false, false, false,\s*\$8, \$9\)\s*RETURNING id/);
    expect(insertParams).toContain('enc(access-tok)');
    expect(insertParams).toContain('enc(refresh-tok)');
    expect(insertParams).not.toContain('access-tok');
    expect(insertParams).not.toContain('refresh-tok');
    expect(insertParams.slice(7)).toEqual([APP_ID, 'sub-1']);
    expect(recordGoogleGrant).toHaveBeenCalledWith({ appId: APP_ID, email: 'user@gmail.com', sub: 'sub-1' });
```

7. В тесте `'updates an existing account …'` заменить `installDb({ existing: { id: 'acc-1', oauth_refresh_token: 'enc(old-refresh)' } });` на `installDb({ existing: { id: 'acc-1', oauth_refresh_token: 'enc(old-refresh)', oauth_app_id: APP_ID } });` и после `expect(updateParams[1]).toBeNull();` добавить

```js
    expect(updateSql).toMatch(/oauth_app_id = \$4, oauth_subject = \$5/);
    expect(updateParams.slice(3)).toEqual([APP_ID, 'sub-1', 'acc-1']);
```

8. Тест `'rejects an existing account without any refresh token to keep'`: заменить `installDb` на `installDb({ existing: { id: 'acc-1', oauth_refresh_token: null, oauth_app_id: APP_ID } });`.

9. Заменить тест `'requires the full Gmail scope'` на:

```js
  it('journals the grant but refuses a consent without the full Gmail scope', async () => {
    mockSuccessfulGoogle({ scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' });
    const { state } = await startFlow();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('scope_missing'));
    expect(recordGoogleGrant).toHaveBeenCalledWith({ appId: APP_ID, email: 'user@gmail.com', sub: 'sub-1' });
    expect(withTransaction).not.toHaveBeenCalled();
  });
```

10. В тесте `'rejects an unverified Google email'` после проверки редиректа добавить `expect(recordGoogleGrant).not.toHaveBeenCalled();`.

11. Callback теперь берёт приложение из state, а не приложение по умолчанию. В тесте `'redirects with not_configured when the integration was removed mid-flow'` заменить строку `googleApps.config = null;` (из Task 4) на `googleApps.byId = {};` и добавить после проверки редиректа `expect(exchangeGoogleCode).not.toHaveBeenCalled();`.

12. Добавить в конец `describe('GET /oauth/google/callback')`:

```js
  it('finishes through the app chosen at start even when the default app changed', async () => {
    mockSuccessfulGoogle();
    const { state } = await startFlow();
    googleApps.config = { appId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', clientId: '999-other.apps.googleusercontent.com', clientSecret: 'other', redirectUri: REDIRECT_URI };

    await callback({ code: 'c', state });

    expect(exchangeGoogleCode).toHaveBeenCalledWith(expect.objectContaining({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }));
    expect(verifyGoogleIdToken).toHaveBeenCalledWith({ idToken: 'id-tok', clientId: CLIENT_ID });
  });

  it('refuses to move a mailbox to another app without a new refresh token', async () => {
    installDb({ existing: { id: 'acc-1', oauth_refresh_token: 'enc(old-refresh)', oauth_app_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' } });
    mockSuccessfulGoogle({ refreshToken: null });
    const { state } = await startFlow();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('missing_refresh_token'));
    expect(sqlCall(/^\s*UPDATE email_accounts/)).toBeUndefined();
  });
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `bt src/services/oauth/oauthState.test.js src/routes/oauth.google.test.js`
Expected: FAIL — нет `appId` в state, SQL без `oauth_app_id`, `recordGoogleGrant` не вызывается.

- [ ] **Step 4: Реализовать state**

В `oauthState.js` заменить `createOAuthState` и тело `try` в `consumeOAuthState`:

```js
// Create a single-use state plus a PKCE S256 pair. The verifier stays in Redis; only
// the state and the challenge leave the server. `appId` pins the Google app whose client
// must finish the flow.
export async function createOAuthState({ provider, userId, loginHint = null, appId = null }) {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  await redisClient.set(
    stateKey(provider, state),
    JSON.stringify({ userId, codeVerifier, loginHint: loginHint || null, appId: appId || null }),
    { NX: true, EX: OAUTH_STATE_TTL_SECONDS },
  );
  return { state, codeChallenge };
}
```

```js
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data.userId !== 'string' || typeof data.codeVerifier !== 'string') return null;
    return {
      userId: data.userId,
      codeVerifier: data.codeVerifier,
      loginHint: data.loginHint || null,
      appId: typeof data.appId === 'string' ? data.appId : null,
    };
  } catch {
    return null;
  }
```

- [ ] **Step 5: Реализовать маршруты**

В `oauthGoogle.js`:

1. Импорт реестра: `import { recordGoogleGrant, resolveGoogleConfig } from '../services/oauth/googleApps.js';`.

2. В `router.get('/')` добавить `appId: config.appId,` в вызов `createOAuthState({ … })`.

3. В callback заменить участок от `if (error !== undefined) {` до строки `reconnectAccount(account, result);` (не включая её) на:

```js
    if (error !== undefined) {
      throw new CallbackError(error === 'access_denied' ? 'access_denied' : 'authentication_failed');
    }
    // The flow must finish in the same MailExpert session that started it.
    if (!pending || !req.session?.userId || req.session.userId !== pending.userId) {
      throw new CallbackError('invalid_state');
    }
    // Finish with the app chosen at start: its client is the one Google issued the code to.
    const config = await resolveGoogleConfig({ appId: pending.appId });
    if (!config) throw new CallbackError('not_configured');
    if (typeof code !== 'string' || !code) throw new CallbackError('authentication_failed');

    const tokens = await exchangeGoogleCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: config.redirectUri,
    });
    const identity = await verifyGoogleIdToken({ idToken: tokens.idToken, clientId: config.clientId });
    // Google counts this account against the app's user cap once it issued tokens, even if
    // the consent is refused below.
    await recordGoogleGrant({ appId: config.appId, email: identity.email, sub: identity.sub });
    if (!hasGoogleMailScope(tokens.scope)) throw new CallbackError('scope_missing');

    const { account, result } = await upsertGoogleAccount(pending.userId, identity, tokens, config.appId);
```

4. Заменить `upsertGoogleAccount` целиком:

```js
// Create or update the Gmail account for (userId, email) under a transaction-scoped
// advisory lock so racing callbacks for one mailbox cannot insert duplicates. The account
// is bound to the app whose client issued the tokens.
async function upsertGoogleAccount(userId, identity, tokens, appId) {
  const email = identity.email.toLowerCase();
  const encryptedAccess = encrypt(tokens.accessToken);
  const encryptedRefresh = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth-account:${userId}:${email}`]);

    const existing = await client.query(
      `SELECT id, oauth_refresh_token, oauth_app_id FROM email_accounts
       WHERE user_id = $1 AND lower(email_address) = lower($2)
       ORDER BY created_at LIMIT 1`,
      [userId, email],
    );

    let accountId;
    let result;
    if (existing.rows.length) {
      const row = existing.rows[0];
      // A stored refresh token only works with the app that issued it, so it can be kept
      // only when the account stays on the same app.
      const canKeepStoredRefresh = !!row.oauth_refresh_token && row.oauth_app_id === appId;
      if (!encryptedRefresh && !canKeepStoredRefresh) throw new CallbackError('missing_refresh_token');
      accountId = row.id;
      result = 'updated';
      await client.query(`
        UPDATE email_accounts SET
          oauth_access_token = $1,
          oauth_refresh_token = COALESCE($2, oauth_refresh_token),
          oauth_token_expiry = $3,
          oauth_provider = 'google', oauth_public_client = false, auth_user = email_address,
          imap_host = 'imap.gmail.com', imap_port = 993, imap_tls = true,
          smtp_host = 'smtp.gmail.com', smtp_port = 465, smtp_tls = 'SSL',
          oauth_app_id = $4, oauth_subject = $5,
          oauth_reconnect_required = false, sync_error = NULL
        WHERE id = $6
      `, [encryptedAccess, encryptedRefresh, tokens.expiresAt, appId, identity.sub, accountId]);
    } else {
      if (!encryptedRefresh) throw new CallbackError('missing_refresh_token');
      const color = ACCOUNT_COLORS[Math.floor(Math.random() * ACCOUNT_COLORS.length)];
      const inserted = await client.query(`
        INSERT INTO email_accounts (
          user_id, name, email_address, color, protocol,
          imap_host, imap_port, imap_tls,
          smtp_host, smtp_port, smtp_tls,
          auth_user,
          oauth_provider, oauth_access_token, oauth_refresh_token, oauth_token_expiry,
          oauth_public_client, oauth_reconnect_required, include_in_unified_inbox,
          oauth_app_id, oauth_subject
        ) VALUES ($1, $2, $3, $4, 'imap',
          'imap.gmail.com', 993, true,
          'smtp.gmail.com', 465, 'SSL',
          $3,
          'google', $5, $6, $7,
          false, false, false,
          $8, $9)
        RETURNING id
      `, [userId, identity.name || email, email, color, encryptedAccess, encryptedRefresh, tokens.expiresAt, appId, identity.sub]);
      accountId = inserted.rows[0].id;
      result = 'created';
    }

    const accountResult = await client.query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    return { account: accountResult.rows[0], result };
  });
}
```

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `bt src/services/oauth/oauthState.test.js src/routes/oauth.google.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/oauth/oauthState.js backend/src/services/oauth/oauthState.test.js backend/src/routes/oauthGoogle.js backend/src/routes/oauth.google.test.js
git commit -m "feat(oauth): bind Gmail accounts to their Google app and journal each grant"
```

---

### Task 6: Совместимость старой карточки Google и импорт при старте

**Files:**
- Modify: `backend/src/services/oauth/googleApps.js`
- Modify: `backend/src/services/oauth/googleApps.test.js`
- Modify: `backend/src/routes/integrations.js`
- Modify: `backend/src/routes/integrations.status.test.js`

**Interfaces:**
- Consumes: `getDefaultGoogleApp`, `setGoogleAppStatus`, `importLegacyGoogleConfig`, `GoogleAppError`, `resolveGoogleConfig`; `req.app.get('imapManager')` (устанавливается в `backend/src/index.js:180`).
- Produces:
  - `saveDefaultGoogleAppCompat({ clientId, clientSecret: string | null }): Promise<string>` — id приложения; ошибки `client_id_invalid`, `client_secret_required`, `app_in_use`, `app_same_project`.
  - `GET /api/integrations` отдаёт `google: { clientId, clientSecret: '••••••••', redirectUri, updated_at }`.
  - `POST /api/integrations/google` сохраняет клиента в приложение по умолчанию, в `integration_config` — только `{ redirectUri }`.
  - `DELETE /api/integrations/google` переводит приложение по умолчанию в `disabled` и отключает его ящики.
  - `loadIntegrationConfigs()` зеркалирует только `GOOGLE_REDIRECT_URI` и вызывает `importLegacyGoogleConfig()`.

- [ ] **Step 1: Тесты `saveDefaultGoogleAppCompat`**

Добавить `saveDefaultGoogleAppCompat` в импорт `googleApps.test.js` и дописать:

```js
describe('saveDefaultGoogleAppCompat', () => {
  const OTHER_CLIENT_ID = '999999999999-zzz999.apps.googleusercontent.com';

  function compatDb({ sameClient = null, current = null, projectTaken = false } = {}) {
    const { client, calls } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/^\s*SELECT id FROM google_oauth_apps WHERE client_id = \$1/, { rows: sameClient ? [sameClient] : [] }],
      [/^\s*UPDATE google_oauth_apps SET status = 'active'/, { rows: [] }],
      [/^\s*SELECT a\.id, \(SELECT count\(\*\)/, { rows: current ? [current] : [] }],
      [/^\s*DELETE FROM google_oauth_apps/, { rows: [] }],
      [/^\s*SELECT 1 FROM google_oauth_apps WHERE project_number = \$1/, { rows: projectTaken ? [{}] : [] }],
      [/^\s*INSERT INTO google_oauth_apps/, { rows: [{ id: 'app-new' }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    return calls;
  }
  const findCall = (calls, re) => calls.find(([sql]) => re.test(sql));

  it('rejects a client ID that is not a Google OAuth client ID before touching the database', async () => {
    const err = await saveDefaultGoogleAppCompat({ clientId: 'gid', clientSecret: 's' }).catch((e) => e);
    expect(err.code).toBe('client_id_invalid');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('updates the secret of the same client and re-activates it', async () => {
    const calls = compatDb({ sameClient: { id: 'app-1' } });
    expect(await saveDefaultGoogleAppCompat({ clientId: CLIENT_ID, clientSecret: 'new-secret' })).toBe('app-1');
    expect(findCall(calls, /UPDATE google_oauth_apps SET status = 'active'/)[1]).toEqual(['app-1', 'enc(new-secret)']);
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
  });

  it('keeps the stored secret of the same client when none is given', async () => {
    const calls = compatDb({ sameClient: { id: 'app-1' } });
    await saveDefaultGoogleAppCompat({ clientId: CLIENT_ID, clientSecret: null });
    expect(findCall(calls, /UPDATE google_oauth_apps SET status = 'active'/)[1]).toEqual(['app-1', null]);
  });

  it('requires a secret for a new client', async () => {
    compatDb();
    const err = await saveDefaultGoogleAppCompat({ clientId: CLIENT_ID, clientSecret: null }).catch((e) => e);
    expect(err.code).toBe('client_secret_required');
  });

  it('creates the first app', async () => {
    const calls = compatDb();
    expect(await saveDefaultGoogleAppCompat({ clientId: CLIENT_ID, clientSecret: 's' })).toBe('app-new');
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)[1]).toEqual(['Google 1', CLIENT_ID, 'enc(s)', '123456789012']);
  });

  it('replaces a default app that has no mailboxes', async () => {
    const calls = compatDb({ current: { id: 'app-old', accounts: 0 } });
    expect(await saveDefaultGoogleAppCompat({ clientId: OTHER_CLIENT_ID, clientSecret: 's' })).toBe('app-new');
    expect(findCall(calls, /DELETE FROM google_oauth_apps/)[1]).toEqual(['app-old']);
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)[1]).toEqual(['Google 1', OTHER_CLIENT_ID, 'enc(s)', '999999999999']);
  });

  it('refuses to replace a default app that still has mailboxes', async () => {
    const calls = compatDb({ current: { id: 'app-old', accounts: 3 } });
    const err = await saveDefaultGoogleAppCompat({ clientId: OTHER_CLIENT_ID, clientSecret: 's' }).catch((e) => e);
    expect(err.code).toBe('app_in_use');
    expect(findCall(calls, /DELETE FROM google_oauth_apps/)).toBeUndefined();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
  });

  it('refuses a second client from the same Google Cloud project', async () => {
    const calls = compatDb({ projectTaken: true });
    const err = await saveDefaultGoogleAppCompat({ clientId: CLIENT_ID, clientSecret: 's' }).catch((e) => e);
    expect(err.code).toBe('app_same_project');
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bt src/services/oauth/googleApps.test.js`
Expected: FAIL — `saveDefaultGoogleAppCompat is not a function`.

- [ ] **Step 3: Реализовать `saveDefaultGoogleAppCompat`**

Дописать в `googleApps.js`:

```js
// Compatibility for the single-app settings card until the multi-app admin UI replaces it:
// saving a client ID updates that app (re-activating it), or replaces the default app when
// the default has no mailboxes yet. `clientSecret` null keeps the stored secret.
export async function saveDefaultGoogleAppCompat({ clientId, clientSecret }) {
  const projectNumber = parseGoogleClientId(clientId);
  if (!projectNumber) throw new GoogleAppError('client_id_invalid');
  const normalizedClientId = clientId.trim();

  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-import'))");

    const same = await client.query('SELECT id FROM google_oauth_apps WHERE client_id = $1', [normalizedClientId]);
    if (same.rows.length) {
      const appId = same.rows[0].id;
      await client.query(
        `UPDATE google_oauth_apps SET status = 'active', client_secret = COALESCE($2, client_secret), updated_at = NOW()
         WHERE id = $1`,
        [appId, clientSecret ? encrypt(clientSecret) : null],
      );
      return appId;
    }
    if (!clientSecret) throw new GoogleAppError('client_secret_required');

    const current = await client.query(
      `SELECT a.id, (SELECT count(*) FROM email_accounts e WHERE e.oauth_app_id = a.id)::int AS accounts
       FROM google_oauth_apps a WHERE a.status <> 'disabled' ORDER BY a.created_at, a.id LIMIT 1`,
    );
    if (current.rows.length) {
      if (current.rows[0].accounts > 0) throw new GoogleAppError('app_in_use');
      await client.query('DELETE FROM google_oauth_apps WHERE id = $1', [current.rows[0].id]);
    }

    const taken = await client.query('SELECT 1 FROM google_oauth_apps WHERE project_number = $1', [projectNumber]);
    if (taken.rows.length) throw new GoogleAppError('app_same_project');

    const inserted = await client.query(
      `INSERT INTO google_oauth_apps (label, client_id, client_secret, project_number)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Google 1', normalizedClientId, encrypt(clientSecret), projectNumber],
    );
    return inserted.rows[0].id;
  });
}
```

- [ ] **Step 4: Убедиться, что тесты реестра проходят**

Run: `bt src/services/oauth/googleApps.test.js`
Expected: PASS.

- [ ] **Step 5: Переписать Google-тесты интеграций**

В `integrations.status.test.js`:

1. Заменить мок реестра:

```js
const googleApps = vi.hoisted(() => ({ config: null }));
vi.mock('../services/oauth/googleApps.js', () => {
  class GoogleAppError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }
  return {
    GoogleAppError,
    resolveGoogleConfig: vi.fn(async () => googleApps.config),
    getDefaultGoogleApp: vi.fn(async () => null),
    saveDefaultGoogleAppCompat: vi.fn(async () => 'app-1'),
    setGoogleAppStatus: vi.fn(async () => []),
    importLegacyGoogleConfig: vi.fn(async () => null),
  };
});
```

2. Заменить импорты маршрута на:

```js
import express from 'express';
import integrationsRoutes, { loadIntegrationConfigs } from './integrations.js';
import { query } from '../services/db.js';
import {
  GoogleAppError,
  getDefaultGoogleApp,
  importLegacyGoogleConfig,
  saveDefaultGoogleAppCompat,
  setGoogleAppStatus,
} from '../services/oauth/googleApps.js';

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
const imapManagerStub = { disconnectAccount: vi.fn(async () => {}) };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.set('imapManager', imapManagerStub);
  app.use('/api/integrations', integrationsRoutes);
  app.use((err, _req, res, next) => { void err; void next; res.status(500).json({ error: 'Internal server error' }); });
  return app;
}
```

3. В `afterEach` добавить:

```js
  getDefaultGoogleApp.mockReset();
  getDefaultGoogleApp.mockImplementation(async () => null);
  saveDefaultGoogleAppCompat.mockReset();
  saveDefaultGoogleAppCompat.mockImplementation(async () => 'app-1');
  setGoogleAppStatus.mockReset();
  setGoogleAppStatus.mockImplementation(async () => []);
  importLegacyGoogleConfig.mockReset();
  importLegacyGoogleConfig.mockImplementation(async () => null);
  imapManagerStub.disconnectAccount.mockClear();
```

4. Заменить весь `describe('Google integration config (admin)', …)` на:

```js
describe('Google integration settings (admin, single-app compatibility)', () => {
  const post = (body) => fetch(`${base}/api/integrations/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('rejects non-admin writes', async () => {
    const res = await post({ clientId: CLIENT_ID, clientSecret: 's', redirectUri: REDIRECT_URI });
    expect(res.status).toBe(403);
    expect(saveDefaultGoogleAppCompat).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('saves the client into the default app and keeps only the callback URL in integration_config', async () => {
    authState.admin = true;
    const res = await post({ clientId: CLIENT_ID, clientSecret: 'gsecret', redirectUri: REDIRECT_URI, tenantId: 'ignored' });
    expect(res.status).toBe(200);

    expect(saveDefaultGoogleAppCompat).toHaveBeenCalledWith({ clientId: CLIENT_ID, clientSecret: 'gsecret' });
    const [sql, params] = query.mock.calls.find(([q]) => /INSERT INTO integration_config/.test(q));
    expect(sql).toMatch(/ON CONFLICT \(provider\)/);
    expect(params).toEqual(['google', { redirectUri: REDIRECT_URI }]);
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(REDIRECT_URI);
    expect(process.env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(process.env.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it('keeps the stored secret when the redacted placeholder is posted', async () => {
    authState.admin = true;
    const res = await post({ clientId: CLIENT_ID, clientSecret: '••••••••', redirectUri: REDIRECT_URI });
    expect(res.status).toBe(200);
    expect(saveDefaultGoogleAppCompat).toHaveBeenCalledWith({ clientId: CLIENT_ID, clientSecret: null });
  });

  it.each([
    ['client_id_invalid', 400],
    ['client_secret_required', 400],
    ['app_same_project', 409],
    ['app_in_use', 409],
  ])('maps %s to HTTP %i without touching integration_config', async (code, status) => {
    authState.admin = true;
    saveDefaultGoogleAppCompat.mockRejectedValueOnce(new GoogleAppError(code));
    const res = await post({ clientId: 'gid', clientSecret: 's', redirectUri: REDIRECT_URI });
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['google', 'microsoft'])('rejects a %s client secret that mixes the redaction placeholder with other text', async (provider) => {
    authState.admin = true;
    process.env.MS_CLIENT_ID = 'unchanged';
    for (const clientSecret of ['••••••••abc', 'abc••••••••', '•••']) {
      const res = await fetch(`${base}/api/integrations/${provider}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, clientSecret, redirectUri: 'https://x/cb' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: 'Client secret contains the redaction placeholder; enter the full secret', code: 'client_secret_redacted' });
    }
    expect(query).not.toHaveBeenCalled();
    expect(saveDefaultGoogleAppCompat).not.toHaveBeenCalled();
    expect(process.env.MS_CLIENT_ID).toBe('unchanged');
  });

  it('clears the callback URL env var when it is removed', async () => {
    authState.admin = true;
    process.env.GOOGLE_REDIRECT_URI = 'https://stale/cb';
    const res = await post({ clientId: CLIENT_ID, clientSecret: 'gsecret', redirectUri: '' });
    expect(res.status).toBe(200);
    const [, params] = query.mock.calls.find(([q]) => /INSERT INTO integration_config/.test(q));
    expect(params).toEqual(['google', {}]);
    expect(process.env.GOOGLE_REDIRECT_URI).toBeUndefined();
  });

  it('returns the default app client ID with the secret redacted and drops legacy fields', async () => {
    authState.admin = true;
    const updatedAt = '2026-09-14T00:00:00.000Z';
    query.mockResolvedValue({ rows: [{ provider: 'google', config: { clientId: 'legacy-id', clientSecret: 'enc:real-secret', redirectUri: 'https://x/cb' }, updated_at: updatedAt }] });
    getDefaultGoogleApp.mockResolvedValue({ id: 'app-1', client_id: CLIENT_ID, client_secret: 'enc:app-secret' });

    const res = await fetch(`${base}/api/integrations`);
    const text = await res.text();
    expect(text).not.toMatch(/real-secret|app-secret|legacy-id/);
    expect(JSON.parse(text).google).toEqual({ clientId: CLIENT_ID, clientSecret: '••••••••', redirectUri: 'https://x/cb', updated_at: updatedAt });
  });

  it('disables the default app, disconnects its mailboxes and clears the callback URL on delete', async () => {
    authState.admin = true;
    process.env.GOOGLE_REDIRECT_URI = 'https://x/cb';
    getDefaultGoogleApp.mockResolvedValue({ id: 'app-1', client_id: CLIENT_ID });
    setGoogleAppStatus.mockResolvedValue(['acc-1', 'acc-2']);

    const res = await fetch(`${base}/api/integrations/google`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(query.mock.calls[0]).toEqual(['DELETE FROM integration_config WHERE provider = $1', ['google']]);
    expect(setGoogleAppStatus).toHaveBeenCalledWith('app-1', 'disabled');
    expect(imapManagerStub.disconnectAccount.mock.calls.map(([id]) => id)).toEqual(['acc-1', 'acc-2']);
    expect(process.env.GOOGLE_REDIRECT_URI).toBeUndefined();
  });

  it('loads only the callback URL on startup and imports the single-app client', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-client';
    query.mockResolvedValue({ rows: [{ provider: 'google', config: { clientId: CLIENT_ID, clientSecret: 'enc:loaded-secret', redirectUri: 'https://x/cb' } }] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await loadIntegrationConfigs();
    logSpy.mockRestore();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe('https://x/cb');
    expect(process.env.GOOGLE_CLIENT_ID).toBe('env-client');
    expect(process.env.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(importLegacyGoogleConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps starting when the import fails and logs only the error code', async () => {
    importLegacyGoogleConfig.mockRejectedValueOnce(Object.assign(new Error('boom enc:secret-value'), { code: 'import_failed' }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadIntegrationConfigs()).resolves.toBeUndefined();
    const logged = JSON.stringify(errorSpy.mock.calls);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    expect(logged).toMatch(/import_failed/);
    expect(logged).not.toMatch(/boom|secret-value/);
  });
});
```

- [ ] **Step 6: Убедиться, что тесты интеграций падают**

Run: `bt src/routes/integrations.status.test.js`
Expected: FAIL — POST пишет `clientId` в `integration_config`, `saveDefaultGoogleAppCompat` не вызывается, импорт не выполняется.

- [ ] **Step 7: Реализовать совместимость в `integrations.js`**

1. Заменить импорт реестра:

```js
import {
  GoogleAppError,
  getDefaultGoogleApp,
  importLegacyGoogleConfig,
  resolveGoogleConfig,
  saveDefaultGoogleAppCompat,
  setGoogleAppStatus,
} from '../services/oauth/googleApps.js';
```

2. Заменить `GOOGLE_ENV` и `applyGoogleEnv` на:

```js
// HTTP status and message for registry errors the single-app Google card can trigger.
const GOOGLE_APP_ERRORS = {
  client_id_invalid: [400, 'Client ID is not a Google OAuth client ID'],
  client_secret_required: [400, 'Client secret is required'],
  app_same_project: [409, 'An app from this Google Cloud project is already added'],
  app_in_use: [409, 'The current Google app still has connected mailboxes'],
};

// Mirror the stored Google callback URL into process.env. Client credentials live in
// google_oauth_apps, so only the redirect URI is kept in integration_config.
function applyGoogleEnv(config) {
  if (config?.redirectUri) process.env.GOOGLE_REDIRECT_URI = config.redirectUri;
  else delete process.env.GOOGLE_REDIRECT_URI;
}

const stringField = (value) => (typeof value === 'string' ? value.trim() : '');
```

3. В `router.get('/')` перед `res.json(configs);` добавить:

```js
  // The Google card shows the default app's client; any client fields left in the legacy
  // row are ignored.
  const googleApp = await getDefaultGoogleApp();
  if (configs.google || googleApp) {
    const stored = configs.google || {};
    configs.google = {
      ...(googleApp ? { clientId: googleApp.client_id, clientSecret: REDACTED_SECRET } : {}),
      ...(stored.redirectUri ? { redirectUri: stored.redirectUri } : {}),
      ...(stored.updated_at ? { updated_at: stored.updated_at } : {}),
    };
  }
```

4. В `router.post('/:provider')` заменить блок от `let config = req.body;` до конца проверки на плейсхолдер (включая `return res.status(400)… client_secret_redacted …`) на:

```js
  const isRedactionMix = (secret) => typeof secret === 'string'
    && secret !== REDACTED_SECRET
    && secret.includes('•');

  if (provider === 'google') {
    const body = req.body || {};
    const clientSecret = stringField(body.clientSecret);
    // A secret that contains the redaction bullet but is not exactly the placeholder was typed
    // into (or around) the redacted field; storing it would replace the real secret with junk.
    if (isRedactionMix(clientSecret)) {
      return res.status(400).json({
        error: 'Client secret contains the redaction placeholder; enter the full secret',
        code: 'client_secret_redacted',
      });
    }
    try {
      await saveDefaultGoogleAppCompat({
        clientId: stringField(body.clientId),
        clientSecret: clientSecret && clientSecret !== REDACTED_SECRET ? clientSecret : null,
      });
    } catch (err) {
      const mapped = err instanceof GoogleAppError ? GOOGLE_APP_ERRORS[err.code] : null;
      if (!mapped) throw err;
      return res.status(mapped[0]).json({ error: mapped[1], code: err.code });
    }
    const redirectUri = stringField(body.redirectUri);
    const googleConfig = redirectUri ? { redirectUri } : {};
    await query(`
      INSERT INTO integration_config (provider, config)
      VALUES ($1, $2)
      ON CONFLICT (provider) DO UPDATE
      SET config = EXCLUDED.config, updated_at = NOW()
    `, [provider, googleConfig]);
    applyGoogleEnv(googleConfig);
    return res.json({ ok: true });
  }

  const config = req.body;

  // A secret that contains the redaction bullet but is not exactly the placeholder was typed into
  // (or around) the redacted field; storing it would silently replace the real secret with junk.
  if (isRedactionMix(config.clientSecret)) {
    return res.status(400).json({
      error: 'Client secret contains the redaction placeholder; enter the full secret',
      code: 'client_secret_redacted',
    });
  }
```

и в конце обработчика удалить ветку `} else if (provider === 'google') { applyGoogleEnv(config); }` (Microsoft-ветка остаётся).

5. В `router.delete('/:provider')` заменить ветку Google:

```js
  } else if (req.params.provider === 'google') {
    // The single-app card removes "the" Google app: disable it so its mailboxes ask for a
    // reconnect, and drop their connections built from its tokens.
    const app = await getDefaultGoogleApp();
    if (app) {
      const accountIds = await setGoogleAppStatus(app.id, 'disabled');
      const manager = req.app.get('imapManager');
      for (const accountId of accountIds) {
        Promise.resolve(manager?.disconnectAccount(accountId)).catch(() => {});
      }
    }
    applyGoogleEnv(null);
  }
```

6. В конец `loadIntegrationConfigs` (после внешнего `try/catch`) добавить:

```js
  // Runs after the stored callback URL is applied; logs only a code so a failure never
  // prints SQL, secrets or provider text.
  try {
    await importLegacyGoogleConfig();
  } catch (err) {
    console.error(`Google OAuth app import failed: ${err?.code || err?.name || 'Error'}`);
  }
```

- [ ] **Step 8: Убедиться, что тесты проходят**

Run: `bt src/routes/integrations.status.test.js src/services/oauth/googleApps.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/oauth/googleApps.js backend/src/services/oauth/googleApps.test.js backend/src/routes/integrations.js backend/src/routes/integrations.status.test.js
git commit -m "feat(oauth): keep the single Google settings card working on the app registry"
```

---

### Task 7: Проверка на настоящем Postgres, документация, PR

**Files:**
- Modify: `.env.example:78-98`
- Modify: `docs/superpowers/specs/2026-09-15-google-multi-app-design.md` (раздел «Миграция существующей установки»)

- [ ] **Step 1: SQL-смоук реестра на Postgres 16**

Сохранить вне репозитория (например, в scratchpad сессии) файл `google-apps-smoke.mjs`:

```js
import assert from 'node:assert/strict';
import { pool, query } from './src/services/db.js';
import { runMigrations } from './src/services/migrations.js';
import { encrypt } from './src/services/encryption.js';
import {
  importLegacyGoogleConfig, resolveGoogleConfig, recordGoogleGrant, setGoogleAppStatus, saveDefaultGoogleAppCompat,
} from './src/services/oauth/googleApps.js';

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
process.env.GOOGLE_REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';

await runMigrations();
const { rows: [user] } = await query("INSERT INTO users (username, password_hash) VALUES ('smoke', 'x') RETURNING id");
const { rows: [account] } = await query(
  "INSERT INTO email_accounts (user_id, name, email_address, oauth_provider) VALUES ($1, 'U', 'User@Gmail.com', 'google') RETURNING id",
  [user.id],
);
await query(
  "INSERT INTO integration_config (provider, config) VALUES ('google', $1)",
  [{ clientId: CLIENT_ID, clientSecret: encrypt('stored-secret'), redirectUri: process.env.GOOGLE_REDIRECT_URI }],
);

const appId = await importLegacyGoogleConfig();
assert.ok(appId);
assert.equal(await importLegacyGoogleConfig(), null);
const { rows: [bound] } = await query('SELECT oauth_app_id FROM email_accounts WHERE id = $1', [account.id]);
assert.equal(bound.oauth_app_id, appId);
const { rows: grants } = await query('SELECT email, google_sub FROM google_oauth_grants WHERE app_id = $1', [appId]);
assert.deepEqual(grants, [{ email: 'user@gmail.com', google_sub: null }]);
const { rows: [cfg] } = await query("SELECT config FROM integration_config WHERE provider = 'google'");
assert.deepEqual(cfg.config, { redirectUri: process.env.GOOGLE_REDIRECT_URI });

assert.equal((await resolveGoogleConfig()).clientSecret, 'stored-secret');
await recordGoogleGrant({ appId, email: 'USER@gmail.com', sub: 'sub-1' });
const { rows: [grant] } = await query('SELECT google_sub FROM google_oauth_grants WHERE app_id = $1', [appId]);
assert.equal(grant.google_sub, 'sub-1');

await assert.rejects(
  saveDefaultGoogleAppCompat({ clientId: '999999999999-zzz.apps.googleusercontent.com', clientSecret: 's' }),
  { code: 'app_in_use' },
);
assert.deepEqual(await setGoogleAppStatus(appId, 'disabled'), [account.id]);
assert.equal(await resolveGoogleConfig(), null);
assert.equal(await saveDefaultGoogleAppCompat({ clientId: CLIENT_ID, clientSecret: null }), appId);
assert.equal((await resolveGoogleConfig()).appId, appId);
await assert.rejects(query('DELETE FROM google_oauth_apps WHERE id = $1', [appId]), { code: '23503' });

console.log('google apps smoke: ok');
await pool.end();
```

Запуск (путь к файлу подставить свой):

```bash
docker network create mailexpert-check
docker run -d --name mailexpert-check-db --network mailexpert-check -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=check -e POSTGRES_DB=mailexpert postgres:16-alpine
docker exec mailexpert-check-db sh -c 'until pg_isready -U mailexpert >/dev/null; do sleep 1; done'
docker network connect mailexpert-check mailexpert-backend-test
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/google-apps-smoke.mjs" mailexpert-backend-test:/work/backend/google-apps-smoke.mjs
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-check-db -e DB_PASSWORD=check -e ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && node google-apps-smoke.mjs'
```

Expected: `google apps smoke: ok`. Затем убрать:

```bash
docker network disconnect mailexpert-check mailexpert-backend-test
docker rm -f mailexpert-check-db
docker network rm mailexpert-check
```

- [ ] **Step 2: Обновить `.env.example`**

Заменить первые пять строк комментария блока Google (от `# Usually configured in Admin → Integrations` до `# Google Cloud Console and add the redirect URI below as an authorized redirect URI.`) на:

```
# Usually configured in Admin → Integrations. Client credentials are stored as Google
# apps in the database (one per Google Cloud project). GOOGLE_CLIENT_ID and
# GOOGLE_CLIENT_SECRET are read once, at the first startup without any stored app, and
# imported as the first app; later changes to them are ignored. GOOGLE_REDIRECT_URI is
# the shared callback URL of every app. Create an OAuth client of type "Web application"
# in Google Cloud Console and add the redirect URI below as an authorized redirect URI.
```

- [ ] **Step 3: Уточнить спецификацию**

В разделе «Миграция существующей установки» заменить текст от `В \`0053\`, в той же транзакции:` до конца абзаца про `.env.example и README описывают это.` на:

```markdown
`0053` создаёт только схему. Перенос данных выполняет `importLegacyGoogleConfig()` при старте (`loadIntegrationConfigs`), в одной транзакции под `pg_advisory_xact_lock(hashtext('google-oauth-app-import'))` и только пока приложений нет: SQL-миграция не может зашифровать секрет, сохранённый открытым текстом старыми версиями.

1. Источник — `integration_config` (`provider = 'google'`, `clientId` и `clientSecret`), иначе `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`.
2. Client ID не по шаблону или нерасшифровываемый secret — ошибка в логе без значений, импорт не выполняется.
3. Создать приложение «Google 1» (secret шифруется), привязать к нему все ящики `oauth_provider = 'google'` без приложения, заполнить журнал `(app_id, lower(email_address))`.
4. Оставить в записи `integration_config` только `redirectUri`.

После импорта `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` не читаются; `GOOGLE_REDIRECT_URI` остаётся общим callback. `.env.example` описывает это.
```

И в описании PR 1 в «Разбиение на PR» заменить `getGoogleConfig()`/`isGoogleConfigured()` берут` на `\`resolveGoogleConfig()\` берёт`.

- [ ] **Step 4: Полный backend-gate**

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npx vitest run 2>&1 | tail -5 && npm run lint && npm run lint:plugins'
```

Expected: `Test Files … passed`, `Tests … passed` без `failed`; линтеры без ошибок и предупреждений.

- [ ] **Step 5: Commit документации**

```bash
git add .env.example docs/superpowers/specs/2026-09-15-google-multi-app-design.md
git commit -m "docs: describe the Google app import and the shared callback URL"
```

- [ ] **Step 6: Push и PR**

Ветка `feat/google-oauth-apps-data` от `main` (план и спецификация сливаются отдельным docs-PR до неё). Тело PR — на английском, без атрибуции: что меняется (схема, реестр, импорт, привязка токенов, совместимость старой карточки), что не меняется для пользователя, как проверено (unit-тесты, смоук на Postgres 16, gate).

```bash
git push -u origin feat/google-oauth-apps-data
gh pr create --repo wyrtensi/MailExpert --base main --head feat/google-oauth-apps-data --title "feat(oauth): store Google OAuth apps and bind Gmail tokens to them" --body-file <scratchpad>/pr-google-apps-data.md
```

- [ ] **Step 7: Дождаться CI и слить**

```bash
gh pr checks --repo wyrtensi/MailExpert --watch
gh pr merge --repo wyrtensi/MailExpert --merge --delete-branch
```

Expected: все проверки зелёные, PR слит. Затем `git checkout main && git pull` и запись в `agent-changes/2026-09-14-deps-oauth-handoff.md`.

- [ ] **Step 8: Убрать тестовый контейнер**

```bash
docker rm -f mailexpert-backend-test
```

---

## Self-review

- **Покрытие спецификации для PR 1:** схема (Task 1); `client_id`/`project_number`, состояния, журнал (Task 2); импорт из `integration_config` и env со шифрованием и строкой `redirectUri` (Task 3, Task 7 — уточнение спецификации); обновление через приложение ящика, `app_unavailable` → переподключение, `not_configured` при нерасшифровываемом секрете (Task 4); привязка ящика и `oauth_subject`, журнал после ID token до отказов, callback через приложение из state (Task 5); совместимость старой карточки: GET/POST/DELETE, отключение ящиков (Task 6). Выбор приложения, брони, `start`/`launch`/переподключение, админский API, доменный сервер — PR 2 и следующие планы.
- **Плейсхолдеры:** `<files>`, `<scratchpad>` — параметры команд, а не недописанный код.
- **Согласованность имён:** `resolveGoogleConfig({ appId })`, `recordGoogleGrant({ appId, email, sub })`, `setGoogleAppStatus(appId, status)`, `saveDefaultGoogleAppCompat({ clientId, clientSecret })`, `importLegacyGoogleConfig()`, `getDefaultGoogleApp()`, `getGoogleAppById(appId)` одинаковы во всех задачах и тестах.
