# Общие ящики, PR 8b: админка «Google-приложения» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** заменить карточку одного Google-клиента экраном «Google-приложения» (callback, инструкция, таблица приложений, добавление, правка, смена состояния, удаление) поверх готового `/api/admin/google-apps` и закончить совместимость настроек: `POST /api/integrations/google` принимает только `{ redirectUri }`, `DELETE /api/integrations/google` больше нет.

**Architecture:** бэкенд теряет однокарточечный путь (`saveDefaultGoogleAppCompat`, отключение приложения через `DELETE`, client ID в `GET /api/integrations`) и хранит в `integration_config` только общий callback. Фронтенд — по образцу `accessSync.js` + `AccessSyncPanel.jsx`: чистые помощники в `utils/googleApps.js` с тестами `node --test`, тонкий `components/GoogleAppsSection.jsx` только для администратора. До PR 8c добавлять Gmail по OAuth можно только через временную карточку `components/GmailConnectCard.jsx` (для всех пользователей), которая заменяет кнопку «Подключить Gmail» старой карточки и уходит в 8c вместе с появлением диалога «Добавить аккаунт».

**Tech Stack:** Node.js 22 (ESM), Express 5, vitest 5; фронтенд — React, react-i18next, `node --test`, eslint, vite.

**Spec:** `docs/superpowers/specs/2026-09-15-google-multi-app-design.md` (разделы «Администрирование приложений», «Интерфейс» — только «Настройки → Интеграции → «Google-приложения»», «Тесты», «Совместимость между PR» — PR 3 той спецификации = этот 8b) с поправками из `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` (раздел «Уточнения, принятые при реализации PR 8»).

## Global Constraints

- Комментарии в коде, коммиты, тексты PR — на английском. Без эмодзи.
- Коммиты и PR от имени `wyrtensi`, без строк атрибуции; все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- Секреты, токены, коды авторизации и тексты ответов Google не попадают в логи, URL, ответы API и ошибки. Email в логах — только через `redactEmail`, в Redis-ключах и членах множеств — только SHA-256 от email в нижнем регистре.
- Ящики общие: «уже подключён» означает, что ящик с этим email (`lower(email_address)`) есть в установке. Никаких проверок «ящик принадлежит пользователю». Переподключение по id ящика доступно любому вошедшему пользователю.
- Совместимость до PR 8c: `GET /oauth/google` без параметров и с `?login_hint=<email>` продолжают работать (их вызывают `GmailConnectCard.jsx`, кнопка «Переподключить Gmail» во вкладке «Аккаунты» и `utils/accountHealth.js`).
- **Временная карточка «Подключить Gmail» до PR 8c.** Спецификация убирает кнопку с экрана приложений («Кнопки «Подключить Gmail» здесь больше нет. Не-админ этот раздел не видит.»), но другого способа добавить Gmail по OAuth до диалога «Добавить аккаунт» (8c) во фронтенде нет: переподключение (`reconnectUrlFor`, кнопка во вкладке «Аккаунты») работает только для существующих ящиков, а пресет Gmail в `AccountForm` — это IMAP с паролем приложения. Поэтому 8b оставляет отдельную карточку `GmailConnectCard` в «Интеграции → Почтовые провайдеры», видимую всем, с одной кнопкой «Подключить Gmail» (`GET /oauth/google`, режим `upsert`). PR 8c её удаляет. `main` остаётся рабочим после каждого слияния.
- После 8b `POST /api/integrations/google` принимает только `{ redirectUri }` (остальные поля тела игнорируются), `DELETE /api/integrations/google` отвечает `400 { error: 'Unknown provider' }`, `GET /api/integrations` для `google` отдаёт только `redirectUri` и `updated_at`, без `clientId` и плейсхолдера секрета.
- Секрет приложения в форме правки не показывается и не подставляется плейсхолдером: поле пустое, пустое значение сохраняет прежний секрет (`PATCH` без `clientSecret`).
- Доменный почтовый сервер (`domain_mail`, `kind: 'domain'`) в PR 8 не входит — перенесён в PR 9. Ограничение ручного добавления ящика администратором (`POST /api/accounts` без `kind`) делается в PR 8c вместе с новым диалогом, не здесь.
- Каждая новая строка интерфейса — ключ во всех локалях (`frontend/src/locales/en.json`, `ru.json`); неиспользуемые ключи удаляются (Suite 1 в `i18n.test.js` падает на мёртвых ключах). Перевод на русский — не копия английского (Suite 3).
- Монки-патчинг запрещён; глобальный `fetch` подменяется только через `vi.stubGlobal`, как в `googleOAuth.test.js`.
- Не трогать запущенные контейнеры пользователя (`mailexpert-frontend`, `mailexpert-backend`, `mailexpert-postgres`, `mailexpert-redis`, `amnezia-*`).

## Как запускать тесты

Бэкенд — в изолированном контейнере (на Windows-хосте часть наборов падает независимо от изменений: totp, accounts.aliases, auth, archiver/bcrypt, snippet decode). Один раз за сессию:

```bash
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test -v "D:/hub/workspace/Projects/MailExpert:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && echo ready'
```

Если контейнер уже есть (`docker ps -a --filter name=mailexpert-backend-test`), использовать его, а не создавать заново. Запуск файлов (синхронизирует рабочее дерево; в worktree подставить его путь вместо `D:/hub/workspace/Projects/MailExpert` при создании контейнера):

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npx vitest run <files>'
```

Ниже это записано как `bt <files>`. Полный прогон — `bt` без файлов, затем `npm run lint` той же командой вместо `npx vitest run`.

Фронтенд — локально: `cd frontend && node --test <files>`; весь набор — `cd frontend && npm test`; lint — `cd frontend && npm run lint`; сборка — `cd frontend && npm run build`.

## Файлы

| Файл | Что меняется |
|---|---|
| `backend/src/routes/integrations.js` | `POST google` — только `{ redirectUri }` с проверкой; `DELETE` — только `microsoft`; `GET /` — `google` без client ID |
| `backend/src/routes/integrations.status.test.js` | тесты настроек Google переписаны под конец совместимости |
| `backend/src/services/oauth/googleApps.js`, `googleApps.test.js` | удаление `saveDefaultGoogleAppCompat` |
| `frontend/src/utils/api.js` | `api.admin.googleApps.{list,create,update,remove}` |
| `frontend/src/utils/googleApps.js` (новый), `googleApps.test.js` (новый) | состояния, сокращённый client ID, места, форма, ошибки, callback |
| `frontend/src/utils/googleOAuth.js`, `googleOAuth.test.js` | удаление помощников плейсхолдера секрета |
| `frontend/src/components/GoogleAppsSection.jsx` (новый) | экран «Google-приложения» (только админ) |
| `frontend/src/components/GmailConnectCard.jsx` (новый) | временная кнопка «Подключить Gmail» до 8c |
| `frontend/src/components/GoogleIntegrationSection.jsx` | удаляется |
| `frontend/src/components/AdminPanel.jsx` | монтирование, переподключение без `openGoogleOAuth`, пункт поиска |
| `frontend/src/locales/{en,ru}.json`, `frontend/src/locales/i18n.test.js` | ключи `admin.integrations.googleApps.*`, удаление мёртвых ключей `admin.integrations.google.*` |
| спецификации | статус и «Уточнения, принятые при реализации PR 8» |

---

### Task 1: Бэкенд — конец совместимости настроек Google

**Files:**
- Modify: `backend/src/routes/integrations.js`
- Modify: `backend/src/services/oauth/googleApps.js`
- Test: `backend/src/routes/integrations.status.test.js`, `backend/src/services/oauth/googleApps.test.js`

**Interfaces:**
- Consumes: `resolveGoogleConfig`, `importLegacyGoogleConfig` из `googleApps.js` (без изменений).
- Produces:
  - `GET /api/integrations` (админ) → `google: { redirectUri?, updated_at? }` — `redirectUri` из `integration_config`, иначе `process.env.GOOGLE_REDIRECT_URI`; ключ `google` есть, только если известен хоть один из них; `clientId`/`clientSecret` не отдаются никогда.
  - `POST /api/integrations/google` (админ) `{ redirectUri }` → `200 { ok: true }`; не абсолютный `http(s)` URL (в том числе пустой) → `400 { error: 'Callback URL must be a full http or https address', code: 'redirect_uri_invalid' }`. Другие поля тела игнорируются.
  - `DELETE /api/integrations/:provider` (админ) — только `microsoft`; иначе `400 { error: 'Unknown provider' }`.
  - `saveDefaultGoogleAppCompat` удалён из `googleApps.js`.

- [ ] **Step 1: Write the failing tests** — в `integrations.status.test.js`:

1. Сузить мок `googleApps.js` (эти функции роутер больше не импортирует):

```js
const googleApps = vi.hoisted(() => ({ config: null }));
vi.mock('../services/oauth/googleApps.js', () => ({
  resolveGoogleConfig: vi.fn(async () => googleApps.config),
  importLegacyGoogleConfig: vi.fn(async () => null),
}));
```

2. Импорт заменить на:

```js
import { importLegacyGoogleConfig } from '../services/oauth/googleApps.js';
```

3. В `afterEach` удалить сбросы `getDefaultGoogleApp`, `saveDefaultGoogleAppCompat`, `setGoogleAppStatus`; сброс `importLegacyGoogleConfig` и `imapManagerStub.disconnectAccount.mockClear()` оставить.

4. Весь `describe('Google integration settings (admin, single-app compatibility)', …)` заменить на:

```js
describe('Google integration settings (admin, callback URL only)', () => {
  const post = (body) => fetch(`${base}/api/integrations/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('rejects non-admin writes', async () => {
    const res = await post({ redirectUri: REDIRECT_URI });
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('stores only the callback URL and ignores client fields', async () => {
    authState.admin = true;
    const res = await post({ clientId: CLIENT_ID, clientSecret: 'gsecret', redirectUri: ` ${REDIRECT_URI} `, tenantId: 'x' });
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls.find(([q]) => /INSERT INTO integration_config/.test(q));
    expect(sql).toMatch(/ON CONFLICT \(provider\)/);
    expect(params).toEqual(['google', { redirectUri: REDIRECT_URI }]);
    expect(JSON.stringify(query.mock.calls)).not.toMatch(/gsecret|123456789012/);
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(REDIRECT_URI);
    expect(process.env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(process.env.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it.each([
    [''],
    ['   '],
    ['not a url'],
    ['/oauth/google/callback'],
    ['ftp://mail.example.com/oauth/google/callback'],
    ['javascript:alert(1)'],
  ])('refuses the callback URL %j without touching integration_config', async (redirectUri) => {
    authState.admin = true;
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    const res = await post({ redirectUri });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('redirect_uri_invalid');
    expect(query).not.toHaveBeenCalled();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(REDIRECT_URI);
  });

  it('refuses a body without a callback URL', async () => {
    authState.admin = true;
    const res = await post({ clientId: CLIENT_ID, clientSecret: 's' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('redirect_uri_invalid');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns only the callback URL for google, dropping legacy client fields', async () => {
    authState.admin = true;
    const updatedAt = '2026-09-14T00:00:00.000Z';
    query.mockResolvedValue({ rows: [{ provider: 'google', config: { clientId: 'legacy-id', clientSecret: 'enc:real-secret', redirectUri: 'https://x/cb' }, updated_at: updatedAt }] });
    const res = await fetch(`${base}/api/integrations`);
    const text = await res.text();
    expect(text).not.toMatch(/real-secret|legacy-id|clientId|clientSecret/);
    expect(JSON.parse(text).google).toEqual({ redirectUri: 'https://x/cb', updated_at: updatedAt });
  });

  it('falls back to GOOGLE_REDIRECT_URI when no row is stored', async () => {
    authState.admin = true;
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    const body = await (await fetch(`${base}/api/integrations`)).json();
    expect(body.google).toEqual({ redirectUri: REDIRECT_URI });
  });

  it('has no google entry when no callback URL is known', async () => {
    authState.admin = true;
    const body = await (await fetch(`${base}/api/integrations`)).json();
    expect(body.google).toBeUndefined();
  });

  it('no longer deletes the google settings', async () => {
    authState.admin = true;
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    const res = await fetch(`${base}/api/integrations/google`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown provider' });
    expect(query).not.toHaveBeenCalled();
    expect(imapManagerStub.disconnectAccount).not.toHaveBeenCalled();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(REDIRECT_URI);
  });

  it('still deletes the microsoft settings', async () => {
    authState.admin = true;
    process.env.MS_CLIENT_ID = 'ms-id';
    const res = await fetch(`${base}/api/integrations/microsoft`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(query.mock.calls[0]).toEqual(['DELETE FROM integration_config WHERE provider = $1', ['microsoft']]);
    expect(process.env.MS_CLIENT_ID).toBeUndefined();
  });

  it('rejects a microsoft client secret that mixes the redaction placeholder with other text', async () => {
    authState.admin = true;
    process.env.MS_CLIENT_ID = 'unchanged';
    for (const clientSecret of ['••••••••abc', 'abc••••••••', '•••']) {
      const res = await fetch(`${base}/api/integrations/microsoft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'ms-id', clientSecret, redirectUri: 'https://x/cb' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Client secret contains the redaction placeholder; enter the full secret', code: 'client_secret_redacted' });
    }
    expect(query).not.toHaveBeenCalled();
    expect(process.env.MS_CLIENT_ID).toBe('unchanged');
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

(Последние два теста — перенос существующих без изменений, чтобы описание блока было честным.)

В `googleApps.test.js` удалить `saveDefaultGoogleAppCompat` из деструктуризации импорта и весь `describe('saveDefaultGoogleAppCompat', …)`. `scriptedClient` и `withTransaction` используются другими тестами файла — оставить.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bt src/routes/integrations.status.test.js src/services/oauth/googleApps.test.js`
Expected: FAIL в `integrations.status.test.js` — `redirect_uri_invalid` не отдаётся (200 вместо 400), `GET` отдаёт `clientId`, `DELETE google` отвечает 200; импорт роутера может упасть раньше с `getDefaultGoogleApp is not a function`/отсутствующим экспортом мока — это тоже ожидаемый провал. `googleApps.test.js` — PASS (тесты только удалены).

- [ ] **Step 3: Implement** — `integrations.js`:

Импорт заменить на:

```js
import { importLegacyGoogleConfig, resolveGoogleConfig } from '../services/oauth/googleApps.js';
```

Удалить `GOOGLE_APP_ERRORS` и `stringField`. После `applyGoogleEnv` добавить:

```js
// The shared Google callback URL: an absolute http(s) address, trimmed. Null for anything else,
// so a relative path or a script URL never reaches process.env or the OAuth redirect.
function parseRedirectUri(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? trimmed : null;
  } catch {
    return null;
  }
}
```

В `GET /` блок Google заменить на:

```js
  // Google clients live in google_oauth_apps (/api/admin/google-apps); only the shared
  // callback URL is a setting here. Legacy client fields left in the row are never returned.
  const stored = configs.google || {};
  const redirectUri = stored.redirectUri || process.env.GOOGLE_REDIRECT_URI || null;
  delete configs.google;
  if (redirectUri || stored.updated_at) {
    configs.google = {
      ...(redirectUri ? { redirectUri } : {}),
      ...(stored.updated_at ? { updated_at: stored.updated_at } : {}),
    };
  }
```

В `POST /:provider` ветку `if (provider === 'google') { … }` заменить на:

```js
  if (provider === 'google') {
    // Only the shared callback URL is stored here: apps are managed at /api/admin/google-apps,
    // so any client ID or secret in the body is ignored.
    const redirectUri = parseRedirectUri(req.body?.redirectUri);
    if (!redirectUri) {
      return res.status(400).json({ error: 'Callback URL must be a full http or https address', code: 'redirect_uri_invalid' });
    }
    const googleConfig = { redirectUri };
    await query(`
      INSERT INTO integration_config (provider, config)
      VALUES ($1, $2)
      ON CONFLICT (provider) DO UPDATE
      SET config = EXCLUDED.config, updated_at = NOW()
    `, [provider, googleConfig]);
    applyGoogleEnv(googleConfig);
    return res.json({ ok: true });
  }
```

`isRedactionMix` остаётся (им пользуется ветка Microsoft).

`DELETE /:provider` заменить на:

```js
// Delete integration config — admin only. Google has no deletable settings any more: its apps
// are disabled or removed at /api/admin/google-apps, and the callback URL is only replaced.
router.delete('/:provider', requireAdmin, async (req, res) => {
  if (req.params.provider !== 'microsoft') return res.status(400).json({ error: 'Unknown provider' });
  await query(
    'DELETE FROM integration_config WHERE provider = $1',
    [req.params.provider]
  );
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;
  delete process.env.MS_TENANT_ID;
  delete process.env.MS_REDIRECT_URI;
  res.json({ ok: true });
});
```

`googleApps.js`: удалить `saveDefaultGoogleAppCompat` вместе с комментарием над ней. Комментарий у `getDefaultGoogleApp` заменить на:

```js
// The oldest app that is not disabled. Used by the legacy `GET /oauth/google` flow without a
// selected app (until PR 8c) and by callers that do not pass an appId.
```

Проверить, что `encrypt` в `googleApps.js` ещё используется (`createGoogleApp`, `updateGoogleApp`, `importLegacyGoogleConfig`) — импорт не трогать.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bt src/routes/integrations.status.test.js src/services/oauth/googleApps.test.js src/routes/googleAppsAdmin.test.js`
Expected: PASS. Затем `npm run lint` той же командой — без ошибок (нет неиспользуемых импортов).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/integrations.js backend/src/routes/integrations.status.test.js backend/src/services/oauth/googleApps.js backend/src/services/oauth/googleApps.test.js
git commit -m "feat(integrations): keep only the Google callback URL in the settings API"
```

---

### Task 2: Фронтенд — API и чистые помощники экрана приложений

**Files:**
- Modify: `frontend/src/utils/api.js`
- Create: `frontend/src/utils/googleApps.js`
- Test: `frontend/src/utils/googleApps.test.js`

**Interfaces:**
- Consumes: ответы `/api/admin/google-apps` из `backend/src/routes/googleAppsAdmin.js`: `GET` → `{ apps: App[] }`, `POST` → `201 { app }`, `PATCH` → `{ app }`, `DELETE` → `{ ok: true }`; `App = { id, label, clientId, projectNumber, userLimit, status: 'active'|'closed'|'disabled', grantsCount, reservedCount, accountsCount, full: boolean, createdAt }`; ошибки `{ error, code }` с кодами `label_invalid`, `client_id_invalid`, `client_secret_required`, `client_secret_redacted`, `user_limit_invalid`, `app_status_invalid`, `app_exists`, `app_same_project`, `app_in_use`, `app_not_found`. `request()` в `api.js` кладёт `code` в `err.code`.
- Produces (все экспорты `utils/googleApps.js`):
  - `GOOGLE_APP_SCOPES: string` = `'openid email profile https://mail.google.com/'`
  - `googleAppState(app): 'active'|'full'|'closed'|'disabled'|null`
  - `googleAppStateKey(app): string|null`
  - `shortClientId(clientId): string`
  - `googleAppSeatsText(app): string` — `'<занято> / <лимит>'`, занято = `grantsCount + reservedCount`
  - `googleAppStatusActions(app): Array<{ status, labelKey, confirm: boolean }>`
  - `canDeleteGoogleApp(app): boolean`
  - `googleAppForm(app|null): { label, clientId, clientSecret, userLimit: string }`
  - `googleAppFormError(form, { editing }): string|null` — ключ перевода
  - `googleAppPayload(form, { editing }): object` — тело `POST`/`PATCH`
  - `googleAppErrorKey(code): string|null`
  - `googleCallbackFormError(value): string|null`
  - `googleCallbackAltUri(configured, origin): string|null`
  - `api.admin.googleApps.list()`, `.create(data)`, `.update(id, data)`, `.remove(id)`

- [ ] **Step 1: Write the failing test** — `frontend/src/utils/googleApps.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_APP_SCOPES,
  canDeleteGoogleApp,
  googleAppErrorKey,
  googleAppForm,
  googleAppFormError,
  googleAppPayload,
  googleAppSeatsText,
  googleAppState,
  googleAppStateKey,
  googleAppStatusActions,
  googleCallbackAltUri,
  googleCallbackFormError,
  shortClientId,
} from './googleApps.js';

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const APP = {
  id: 'a1', label: 'Google 1', clientId: CLIENT_ID, projectNumber: '123456789012', userLimit: 100,
  status: 'active', grantsCount: 40, reservedCount: 2, accountsCount: 38, full: false, createdAt: '2026-09-21T00:00:00.000Z',
};

describe('googleAppState', () => {
  it('shows a full active app as its own state and keeps the stored ones', () => {
    assert.equal(googleAppState(APP), 'active');
    assert.equal(googleAppState({ ...APP, full: true }), 'full');
    assert.equal(googleAppState({ ...APP, status: 'closed', full: false }), 'closed');
    assert.equal(googleAppState({ ...APP, status: 'disabled' }), 'disabled');
  });

  it('only an active app is ever full', () => {
    assert.equal(googleAppState({ ...APP, status: 'closed', full: true }), 'closed');
  });

  it('is null for an unknown status', () => {
    assert.equal(googleAppState({ ...APP, status: 'weird' }), null);
    assert.equal(googleAppState(null), null);
    assert.equal(googleAppStateKey({ ...APP, status: 'weird' }), null);
  });

  it('maps each state to a key', () => {
    assert.equal(googleAppStateKey(APP), 'admin.integrations.googleApps.stateActive');
    assert.equal(googleAppStateKey({ ...APP, full: true }), 'admin.integrations.googleApps.stateFull');
    assert.equal(googleAppStateKey({ ...APP, status: 'closed' }), 'admin.integrations.googleApps.stateClosed');
    assert.equal(googleAppStateKey({ ...APP, status: 'disabled' }), 'admin.integrations.googleApps.stateDisabled');
  });
});

describe('shortClientId', () => {
  it('keeps the project number and the start of the client hash', () => {
    assert.equal(shortClientId(CLIENT_ID), '123456789012-abc123…');
    assert.equal(shortClientId('1-a.apps.googleusercontent.com'), '1-a…');
  });

  it('cuts anything else to 24 characters', () => {
    assert.equal(shortClientId('short'), 'short');
    assert.equal(shortClientId('x'.repeat(30)), `${'x'.repeat(24)}…`);
    assert.equal(shortClientId(null), '');
  });
});

describe('googleAppSeatsText', () => {
  it('counts the journal and the live reservations against the limit', () => {
    assert.equal(googleAppSeatsText(APP), '42 / 100');
    assert.equal(googleAppSeatsText({ ...APP, grantsCount: undefined, reservedCount: undefined }), '0 / 100');
  });
});

describe('googleAppStatusActions', () => {
  it('offers the two other states and asks to confirm only disabling', () => {
    assert.deepEqual(googleAppStatusActions(APP), [
      { status: 'closed', labelKey: 'admin.integrations.googleApps.close', confirm: false },
      { status: 'disabled', labelKey: 'admin.integrations.googleApps.disable', confirm: true },
    ]);
    assert.deepEqual(googleAppStatusActions({ ...APP, status: 'disabled' }).map((a) => a.status), ['active', 'closed']);
    assert.deepEqual(googleAppStatusActions({ ...APP, status: 'closed' }).map((a) => a.status), ['active', 'disabled']);
  });

  it('keeps offering the other states for a full app', () => {
    assert.deepEqual(googleAppStatusActions({ ...APP, full: true }).map((a) => a.status), ['closed', 'disabled']);
  });
});

describe('canDeleteGoogleApp', () => {
  it('allows deleting only an app without mailboxes', () => {
    assert.equal(canDeleteGoogleApp(APP), false);
    assert.equal(canDeleteGoogleApp({ ...APP, accountsCount: 0 }), true);
  });
});

describe('googleAppForm', () => {
  it('starts a new app with the default limit', () => {
    assert.deepEqual(googleAppForm(null), { label: '', clientId: '', clientSecret: '', userLimit: '100' });
  });

  it('fills an edit form from the app and never from a secret', () => {
    assert.deepEqual(googleAppForm(APP), { label: 'Google 1', clientId: CLIENT_ID, clientSecret: '', userLimit: '100' });
  });
});

describe('googleAppFormError', () => {
  const form = { label: 'Google 2', clientId: CLIENT_ID, clientSecret: 'GOCSPX-x', userLimit: '100' };

  it('accepts a complete new app', () => {
    assert.equal(googleAppFormError(form, { editing: false }), null);
    assert.equal(googleAppFormError({ ...form, clientId: ` ${CLIENT_ID} ` }, { editing: false }), null);
  });

  it('names the first problem of a new app', () => {
    assert.equal(googleAppFormError({ ...form, label: '  ' }, { editing: false }), 'admin.integrations.googleApps.errorLabelInvalid');
    assert.equal(googleAppFormError({ ...form, label: 'x'.repeat(101) }, { editing: false }), 'admin.integrations.googleApps.errorLabelInvalid');
    assert.equal(googleAppFormError({ ...form, clientId: 'abc' }, { editing: false }), 'admin.integrations.googleApps.errorClientIdInvalid');
    assert.equal(googleAppFormError({ ...form, clientSecret: ' ' }, { editing: false }), 'admin.integrations.googleApps.errorClientSecretRequired');
    assert.equal(googleAppFormError({ ...form, clientSecret: '••••••••' }, { editing: false }), 'admin.integrations.googleApps.errorClientSecretRedacted');
    for (const userLimit of ['', '0', '-1', '1.5', 'abc', '2147483648']) {
      assert.equal(googleAppFormError({ ...form, userLimit }, { editing: false }), 'admin.integrations.googleApps.errorUserLimitInvalid', userLimit);
    }
  });

  it('lets an edit keep the stored secret and ignores the fixed client ID', () => {
    assert.equal(googleAppFormError({ ...form, clientId: 'abc', clientSecret: '' }, { editing: true }), null);
    assert.equal(googleAppFormError({ ...form, clientSecret: 'x•' }, { editing: true }), 'admin.integrations.googleApps.errorClientSecretRedacted');
  });
});

describe('googleAppPayload', () => {
  const form = { label: ' Google 2 ', clientId: ` ${CLIENT_ID} `, clientSecret: ' GOCSPX-x ', userLimit: ' 50 ' };

  it('sends every field of a new app, trimmed, with a numeric limit', () => {
    assert.deepEqual(googleAppPayload(form, { editing: false }), {
      label: 'Google 2', clientId: CLIENT_ID, clientSecret: 'GOCSPX-x', userLimit: 50,
    });
  });

  it('never sends the client ID of an edited app and leaves a blank secret out', () => {
    assert.deepEqual(googleAppPayload(form, { editing: true }), { label: 'Google 2', userLimit: 50, clientSecret: 'GOCSPX-x' });
    assert.deepEqual(googleAppPayload({ ...form, clientSecret: '  ' }, { editing: true }), { label: 'Google 2', userLimit: 50 });
  });
});

describe('googleAppErrorKey', () => {
  it('maps every admin API code and nothing else', () => {
    const codes = {
      label_invalid: 'admin.integrations.googleApps.errorLabelInvalid',
      client_id_invalid: 'admin.integrations.googleApps.errorClientIdInvalid',
      client_secret_required: 'admin.integrations.googleApps.errorClientSecretRequired',
      client_secret_redacted: 'admin.integrations.googleApps.errorClientSecretRedacted',
      user_limit_invalid: 'admin.integrations.googleApps.errorUserLimitInvalid',
      app_status_invalid: 'admin.integrations.googleApps.errorStatusInvalid',
      app_exists: 'admin.integrations.googleApps.errorAppExists',
      app_same_project: 'admin.integrations.googleApps.errorSameProject',
      app_in_use: 'admin.integrations.googleApps.errorInUse',
      app_not_found: 'admin.integrations.googleApps.errorNotFound',
      redirect_uri_invalid: 'admin.integrations.googleApps.errorCallbackInvalid',
    };
    for (const [code, key] of Object.entries(codes)) assert.equal(googleAppErrorKey(code), key, code);
    for (const code of [undefined, null, '', 'toString', '__proto__', 'other']) assert.equal(googleAppErrorKey(code), null);
  });
});

describe('googleCallbackFormError', () => {
  it('accepts only an absolute http(s) address', () => {
    assert.equal(googleCallbackFormError('https://mail.example.com/oauth/google/callback'), null);
    assert.equal(googleCallbackFormError(' http://localhost:8080/oauth/google/callback '), null);
    for (const value of ['', '  ', '/oauth/google/callback', 'mail.example.com', 'ftp://x/cb', 'javascript:alert(1)']) {
      assert.equal(googleCallbackFormError(value), 'admin.integrations.googleApps.errorCallbackInvalid', value);
    }
  });
});

describe('googleCallbackAltUri', () => {
  const configured = 'https://mail.example.com/oauth/google/callback';

  it('is null when the panel is open on the configured host', () => {
    assert.equal(googleCallbackAltUri(configured, 'https://mail.example.com'), null);
    assert.equal(googleCallbackAltUri(configured, 'https://mail.example.com/'), null);
  });

  it('names the callback of the host the panel is open on', () => {
    assert.equal(googleCallbackAltUri(configured, 'https://alt.example.net'), 'https://alt.example.net/oauth/google/callback');
  });

  it('is null without a usable configured callback', () => {
    assert.equal(googleCallbackAltUri('', 'https://alt.example.net'), null);
    assert.equal(googleCallbackAltUri('not a url', 'https://alt.example.net'), null);
    assert.equal(googleCallbackAltUri(configured, ''), null);
  });
});

describe('GOOGLE_APP_SCOPES', () => {
  it('lists the scopes the consent screen needs', () => {
    assert.equal(GOOGLE_APP_SCOPES, 'openid email profile https://mail.google.com/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --test src/utils/googleApps.test.js`
Expected: FAIL — `Cannot find module './googleApps.js'`.

- [ ] **Step 3: Write minimal implementation** — `frontend/src/utils/googleApps.js`:

```js
// Helpers for the "Google apps" admin screen. Shapes mirror /api/admin/google-apps
// (backend/src/routes/googleAppsAdmin.js). Pure: no DOM, no store, no network.
const CLIENT_ID_RE = /^(\d+)-([a-z0-9]+)\.apps\.googleusercontent\.com$/;
const LABEL_MAX = 100;
// user_limit is a Postgres INTEGER.
const USER_LIMIT_MAX = 2147483647;
const DEFAULT_USER_LIMIT = 100;
const STATUSES = ['active', 'closed', 'disabled'];

export const GOOGLE_APP_SCOPES = 'openid email profile https://mail.google.com/';

// Keys are spelled out literally so the i18n coverage tests can find them.
const STATE_KEYS = Object.freeze({
  active: 'admin.integrations.googleApps.stateActive',
  full: 'admin.integrations.googleApps.stateFull',
  closed: 'admin.integrations.googleApps.stateClosed',
  disabled: 'admin.integrations.googleApps.stateDisabled',
});

const STATUS_ACTION_KEYS = Object.freeze({
  active: 'admin.integrations.googleApps.activate',
  closed: 'admin.integrations.googleApps.close',
  disabled: 'admin.integrations.googleApps.disable',
});

const ERROR_KEYS = Object.freeze({
  label_invalid: 'admin.integrations.googleApps.errorLabelInvalid',
  client_id_invalid: 'admin.integrations.googleApps.errorClientIdInvalid',
  client_secret_required: 'admin.integrations.googleApps.errorClientSecretRequired',
  client_secret_redacted: 'admin.integrations.googleApps.errorClientSecretRedacted',
  user_limit_invalid: 'admin.integrations.googleApps.errorUserLimitInvalid',
  app_status_invalid: 'admin.integrations.googleApps.errorStatusInvalid',
  app_exists: 'admin.integrations.googleApps.errorAppExists',
  app_same_project: 'admin.integrations.googleApps.errorSameProject',
  app_in_use: 'admin.integrations.googleApps.errorInUse',
  app_not_found: 'admin.integrations.googleApps.errorNotFound',
  redirect_uri_invalid: 'admin.integrations.googleApps.errorCallbackInvalid',
});

// "Full" is not stored: the server computes it for an active app whose seats reached the limit.
export function googleAppState(app) {
  if (!STATUSES.includes(app?.status)) return null;
  return app.status === 'active' && app.full === true ? 'full' : app.status;
}

export function googleAppStateKey(app) {
  const state = googleAppState(app);
  return state ? STATE_KEYS[state] : null;
}

export function shortClientId(clientId) {
  if (typeof clientId !== 'string') return '';
  const match = CLIENT_ID_RE.exec(clientId.trim());
  if (match) return `${match[1]}-${match[2].slice(0, 6)}…`;
  return clientId.length > 24 ? `${clientId.slice(0, 24)}…` : clientId;
}

// Seats Google has counted plus live reservations, against the app's limit.
export function googleAppSeatsText(app) {
  const used = (app?.grantsCount ?? 0) + (app?.reservedCount ?? 0);
  return `${used} / ${app?.userLimit ?? 0}`;
}

// Disabling sends the app's mailboxes to "needs reconnect", so only it asks for confirmation.
export function googleAppStatusActions(app) {
  return STATUSES
    .filter((status) => status !== app?.status)
    .map((status) => ({ status, labelKey: STATUS_ACTION_KEYS[status], confirm: status === 'disabled' }));
}

// The server refuses to delete an app with bound mailboxes (409 app_in_use).
export function canDeleteGoogleApp(app) {
  return (app?.accountsCount ?? 0) === 0;
}

// The secret field always starts empty: the server never returns it, and an empty value keeps it.
export function googleAppForm(app) {
  return {
    label: app?.label ?? '',
    clientId: app?.clientId ?? '',
    clientSecret: '',
    userLimit: String(app?.userLimit ?? DEFAULT_USER_LIMIT),
  };
}

function parseUserLimit(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n <= USER_LIMIT_MAX ? n : null;
}

// The first problem that stops the form from saving, as a translation key, or null. The client
// ID of an existing app never changes, so an edit does not check it.
export function googleAppFormError(form, { editing }) {
  const label = form.label.trim();
  if (!label || label.length > LABEL_MAX) return ERROR_KEYS.label_invalid;
  if (!editing && !CLIENT_ID_RE.test(form.clientId.trim())) return ERROR_KEYS.client_id_invalid;
  const secret = form.clientSecret.trim();
  if (!editing && !secret) return ERROR_KEYS.client_secret_required;
  if (secret.includes('•')) return ERROR_KEYS.client_secret_redacted;
  if (parseUserLimit(form.userLimit) === null) return ERROR_KEYS.user_limit_invalid;
  return null;
}

// Body for POST (new app) or PATCH (edit). A blank secret on edit is left out, which keeps the
// stored one; the client ID is never sent on edit.
export function googleAppPayload(form, { editing }) {
  const body = { label: form.label.trim(), userLimit: parseUserLimit(form.userLimit) };
  const secret = form.clientSecret.trim();
  if (!editing) return { label: body.label, clientId: form.clientId.trim(), clientSecret: secret, userLimit: body.userLimit };
  if (secret) body.clientSecret = secret;
  return body;
}

export function googleAppErrorKey(code) {
  return typeof code === 'string' && Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : null;
}

// Same rule as the server: an absolute http(s) address.
export function googleCallbackFormError(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:') return null;
  } catch {
    // fall through
  }
  return ERROR_KEYS.redirect_uri_invalid;
}

// When the panel is open on another public host (APP_ALT_URLS), Google must also know that
// host's callback: the backend sends the browser back to the host the flow started on.
export function googleCallbackAltUri(configured, origin) {
  if (typeof configured !== 'string' || typeof origin !== 'string' || !origin) return null;
  let url;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  const base = origin.replace(/\/+$/, '');
  return url.origin === base ? null : `${base}${url.pathname}`;
}
```

`frontend/src/utils/api.js` — внутри объекта `admin` после `runAccessSync` добавить:

```js
    googleApps: {
      list: () => request('GET', '/admin/google-apps'),
      create: (data) => request('POST', '/admin/google-apps', data),
      update: (id, data) => request('PATCH', `/admin/google-apps/${id}`, data),
      remove: (id) => request('DELETE', `/admin/google-apps/${id}`),
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --test src/utils/googleApps.test.js`
Expected: PASS. `cd frontend && node --test src/locales/i18n.test.js` тоже PASS: Suite 1 ищет в исходниках ключи из локалей, а не наоборот, а проверка литералов источника работает только для отдельных префиксов (`admin.ai.` и т. п.); ключи `admin.integrations.googleApps.*` попадут в локали в Task 3.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/googleApps.js frontend/src/utils/googleApps.test.js frontend/src/utils/api.js
git commit -m "feat(google-apps): add admin API client and screen helpers"
```

---

### Task 3: Фронтенд — экран «Google-приложения»

**Files:**
- Create: `frontend/src/components/GoogleAppsSection.jsx`
- Modify: `frontend/src/components/AdminPanel.jsx` (монтирование рядом с `<GoogleIntegrationSection …/>`, пункт поиска)
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/ru.json` (новый объект `admin.integrations.googleApps`)
- Modify: `frontend/src/locales/i18n.test.js` (тест покрытия ключей экрана, `SAME_VALUE_ALLOWED`)

**Interfaces:**
- Consumes: всё из Task 2; `api.getIntegrations()` (→ `google?.redirectUri`), `api.saveIntegration('google', { redirectUri })` (Task 1), `buildGoogleRedirectUri(location)` из `utils/googleOAuth.js`, `copyToClipboard(text)` из `utils/clipboard.js`, `ConfirmOverlay` (`dialog = { title, message, confirmLabel, onConfirm }`, `onConfirm` бросает `Error` с текстом, чтобы диалог остался открытым с ошибкой).
- Produces: `export default function GoogleAppsSection()` — без пропсов, монтируется только для администратора.

- [ ] **Step 1: Write the failing test** — в `i18n.test.js` рядом с тестом `every Google integration key used in GoogleIntegrationSection.jsx …` добавить:

```js
    it('every Google apps key used by the admin screen exists in every locale', () => {
      // State, action and error keys come from utils/googleApps.js and are translated through
      // a variable, so every quoted literal of both files is collected.
      const source = ['../components/GoogleAppsSection.jsx', '../utils/googleApps.js']
        .map(file => readFileSync(resolve(dir, file), 'utf8')).join('\n');
      const keys = [...new Set([...source.matchAll(/'(admin\.integrations\.googleApps\.[\w.]+)'/g)].map(m => m[1]))];
      assert.ok(keys.length >= 40, `expected the Google apps keys, found ${keys.length}`);
      const missing = [];
      for (const lang of langs) {
        for (const key of keys) {
          if (typeof locales[lang][key] !== 'string' || !locales[lang][key]) missing.push(`  - ${lang}: ${key}`);
        }
      }
      assert.equal(missing.length, 0, `Google apps keys missing from locale files:\n${missing.join('\n')}`);
    });
```

(`locales[lang]` в этом блоке — плоская карта «ключ с точками → строка», как в соседних тестах; если соседи используют другое имя переменной, взять его.)

В `SAME_VALUE_ALLOWED` в блок «Universal placeholders / brand names» добавить:

```js
  'admin.integrations.googleApps.clientIdPh': 'any', // 1234567890-abc123.apps.googleusercontent.com
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --test src/locales/i18n.test.js`
Expected: FAIL — `ENOENT … GoogleAppsSection.jsx`.

- [ ] **Step 3: Write the component** — `frontend/src/components/GoogleAppsSection.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { buildGoogleRedirectUri } from '../utils/googleOAuth.js';
import {
  GOOGLE_APP_SCOPES,
  canDeleteGoogleApp,
  googleAppErrorKey,
  googleAppForm,
  googleAppFormError,
  googleAppPayload,
  googleAppSeatsText,
  googleAppStateKey,
  googleAppStatusActions,
  googleCallbackAltUri,
  googleCallbackFormError,
  shortClientId,
} from '../utils/googleApps.js';
import ConfirmOverlay from './ConfirmOverlay.jsx';

const fieldStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const monoFieldStyle = { ...fieldStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4 };
const hintStyle = { display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 };
const buttonStyle = {
  padding: '7px 12px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const primaryButtonStyle = { ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' };
const noteBoxStyle = {
  padding: '12px 14px', borderRadius: 8, marginBottom: 16, background: 'rgba(124,106,247,0.06)',
  border: '1px solid rgba(124,106,247,0.15)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7,
};
const cellStyle = { padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', fontSize: 13, textAlign: 'left' };
const headCellStyle = { ...cellStyle, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' };

// Settings -> Integrations -> "Google apps" (admins only). Each app is one Google Cloud project
// with its own 100-user cap; MailExpert picks the app per mailbox. Secrets are only ever sent.
export default function GoogleAppsSection() {
  const { t } = useTranslation();
  const [apps, setApps] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [callback, setCallback] = useState('');
  const [storedCallback, setStoredCallback] = useState('');
  const [editing, setEditing] = useState(null); // null | { app: App|null, form }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDialog, setConfirmDialog] = useState(null);

  const suggestedCallback = buildGoogleRedirectUri(window.location);

  const messageFor = (err) => {
    const key = googleAppErrorKey(err?.code);
    return key ? t(key) : (err?.message || t('admin.integrations.googleApps.errorGeneric'));
  };

  const reload = () => api.admin.googleApps.list()
    .then((data) => { setApps(data.apps); setLoadError(''); })
    .catch((err) => setLoadError(err.message));

  useEffect(() => {
    reload();
    api.getIntegrations()
      .then((data) => {
        const stored = data?.google?.redirectUri || '';
        setStoredCallback(stored);
        setCallback(stored || suggestedCallback);
      })
      .catch(() => setCallback(suggestedCallback));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- load once; reload/suggestedCallback are stable for the page

  const act = async (action) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const callbackErrorKey = googleCallbackFormError(callback);
  const saveCallback = () => act(async () => {
    const redirectUri = callback.trim();
    await api.saveIntegration('google', { redirectUri });
    setStoredCallback(redirectUri);
    setCallback(redirectUri);
    setNotice(t('admin.integrations.googleApps.callbackSaved'));
  });

  const copyCallback = () => act(async () => {
    await copyToClipboard(callback.trim());
    setNotice(t('admin.integrations.googleApps.callbackCopied'));
  });

  const replaceApp = (next) => setApps((list) => list.map((a) => (a.id === next.id ? next : a)));

  const formErrorKey = editing ? googleAppFormError(editing.form, { editing: !!editing.app }) : null;
  const updateForm = (field, value) => setEditing((cur) => ({ ...cur, form: { ...cur.form, [field]: value } }));

  const saveApp = () => act(async () => {
    const isEdit = !!editing.app;
    const body = googleAppPayload(editing.form, { editing: isEdit });
    if (isEdit) {
      replaceApp((await api.admin.googleApps.update(editing.app.id, body)).app);
    } else {
      const { app } = await api.admin.googleApps.create(body);
      setApps((list) => [...list, app]);
    }
    setEditing(null);
    setNotice(t('admin.integrations.googleApps.saved'));
  });

  const setStatus = (app, status) => api.admin.googleApps.update(app.id, { status })
    .then(({ app: next }) => replaceApp(next));

  const changeStatus = (app, action) => {
    if (!action.confirm) {
      act(() => setStatus(app, action.status));
      return;
    }
    setConfirmDialog({
      title: t('admin.integrations.googleApps.disableConfirmTitle', { label: app.label }),
      message: t('admin.integrations.googleApps.disableConfirm', { count: app.accountsCount }),
      confirmLabel: t('admin.integrations.googleApps.disable'),
      onConfirm: async () => {
        try {
          await setStatus(app, action.status);
        } catch (err) {
          throw new Error(messageFor(err));
        }
      },
    });
  };

  const removeApp = (app) => setConfirmDialog({
    title: t('admin.integrations.googleApps.deleteConfirmTitle', { label: app.label }),
    message: t('admin.integrations.googleApps.deleteConfirm'),
    confirmLabel: t('common.delete'),
    onConfirm: async () => {
      try {
        await api.admin.googleApps.remove(app.id);
      } catch (err) {
        throw new Error(messageFor(err));
      }
      setApps((list) => list.filter((a) => a.id !== app.id));
    },
  });

  const altCallback = googleCallbackAltUri(storedCallback, window.location.origin);

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
        {t('admin.integrations.googleApps.title')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 16 }}>
        {t('admin.integrations.googleApps.description')}
      </div>

      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />

      <label style={{ display: 'block', marginBottom: 16 }}>
        <span style={labelStyle}>{t('admin.integrations.googleApps.callbackLabel')}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={callback} onChange={(e) => setCallback(e.target.value)} spellCheck={false} style={monoFieldStyle} />
          <button type="button" onClick={copyCallback} disabled={busy || !!callbackErrorKey} style={buttonStyle}>
            {t('common.copy')}
          </button>
          <button type="button" onClick={saveCallback} disabled={busy || !!callbackErrorKey || callback.trim() === storedCallback} style={primaryButtonStyle}>
            {t('common.save')}
          </button>
        </div>
        <span style={hintStyle}>
          {storedCallback ? t('admin.integrations.googleApps.callbackNote') : t('admin.integrations.googleApps.callbackNotSaved')}
        </span>
        {altCallback && (
          <span style={hintStyle}>{t('admin.integrations.googleApps.callbackOtherHost', { uri: altCallback })}</span>
        )}
      </label>

      <div style={noteBoxStyle}>
        <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: 6 }}>
          {t('admin.integrations.googleApps.setupTitle')}
        </div>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>{t('admin.integrations.googleApps.step1')}</li>
          <li>{t('admin.integrations.googleApps.step2')}</li>
          <li>{t('admin.integrations.googleApps.step3', { scopes: GOOGLE_APP_SCOPES })}</li>
          <li>{t('admin.integrations.googleApps.step4')}</li>
          <li>{t('admin.integrations.googleApps.step5')}</li>
        </ol>
      </div>

      {!apps && (
        <div style={{ color: loadError ? 'var(--red)' : 'var(--text-tertiary)', fontSize: 13 }}>
          {loadError ? t('admin.integrations.googleApps.loadFailed', { message: loadError }) : t('common.loading')}
        </div>
      )}

      {apps && apps.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 12 }}>
          {t('admin.integrations.googleApps.empty')}
        </div>
      )}

      {apps && apps.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>{t('admin.integrations.googleApps.columnLabel')}</th>
                <th style={headCellStyle}>{t('admin.integrations.googleApps.clientId')}</th>
                <th style={headCellStyle}>{t('admin.integrations.googleApps.columnSeats')}</th>
                <th style={headCellStyle}>{t('admin.integrations.googleApps.columnAccounts')}</th>
                <th style={headCellStyle}>{t('admin.integrations.googleApps.columnState')}</th>
                <th style={headCellStyle} />
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => {
                const stateKey = googleAppStateKey(app);
                return (
                  <tr key={app.id}>
                    <td style={cellStyle}>{app.label}</td>
                    <td style={{ ...cellStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }} title={app.clientId}>
                      {shortClientId(app.clientId)}
                    </td>
                    <td style={cellStyle}>{googleAppSeatsText(app)}</td>
                    <td style={cellStyle}>{app.accountsCount}</td>
                    <td style={cellStyle}>{stateKey ? t(stateKey) : app.status}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <button type="button" disabled={busy} style={buttonStyle}
                          onClick={() => { setError(''); setEditing({ app, form: googleAppForm(app) }); }}>
                          {t('common.edit')}
                        </button>
                        {googleAppStatusActions(app).map((action) => (
                          <button key={action.status} type="button" disabled={busy} style={buttonStyle}
                            onClick={() => changeStatus(app, action)}>
                            {t(action.labelKey)}
                          </button>
                        ))}
                        <button type="button" disabled={busy || !canDeleteGoogleApp(app)} style={buttonStyle}
                          title={canDeleteGoogleApp(app) ? undefined : t('admin.integrations.googleApps.deleteInUse')}
                          onClick={() => removeApp(app)}>
                          {t('common.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <form
          onSubmit={(e) => { e.preventDefault(); if (!formErrorKey && !busy) saveApp(); }}
          style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520, marginTop: 8 }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {editing.app ? t('admin.integrations.googleApps.formTitleEdit') : t('admin.integrations.googleApps.formTitleAdd')}
          </div>
          <label>
            <span style={labelStyle}>{t('admin.integrations.googleApps.columnLabel')}</span>
            <input value={editing.form.label} onChange={(e) => updateForm('label', e.target.value)} style={fieldStyle} />
          </label>
          <label>
            <span style={labelStyle}>{t('admin.integrations.googleApps.clientId')}</span>
            <input value={editing.form.clientId} onChange={(e) => updateForm('clientId', e.target.value)}
              disabled={!!editing.app} spellCheck={false} autoComplete="off"
              placeholder={t('admin.integrations.googleApps.clientIdPh')} style={monoFieldStyle} />
            {editing.app && <span style={hintStyle}>{t('admin.integrations.googleApps.clientIdFixed')}</span>}
          </label>
          <label>
            <span style={labelStyle}>{t('admin.integrations.googleApps.clientSecret')}</span>
            <input type="password" autoComplete="new-password" value={editing.form.clientSecret}
              onChange={(e) => updateForm('clientSecret', e.target.value)} style={fieldStyle} />
            {editing.app && <span style={hintStyle}>{t('admin.integrations.googleApps.clientSecretKeep')}</span>}
          </label>
          <label>
            <span style={labelStyle}>{t('admin.integrations.googleApps.userLimit')}</span>
            <input inputMode="numeric" value={editing.form.userLimit} onChange={(e) => updateForm('userLimit', e.target.value)} style={fieldStyle} />
            <span style={hintStyle}>{t('admin.integrations.googleApps.userLimitHint')}</span>
          </label>
          {formErrorKey && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t(formErrorKey)}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy || !!formErrorKey} style={primaryButtonStyle}>{t('common.save')}</button>
            <button type="button" disabled={busy} style={buttonStyle} onClick={() => setEditing(null)}>{t('common.cancel')}</button>
          </div>
        </form>
      ) : (
        <button type="button" disabled={busy || !apps} style={primaryButtonStyle}
          onClick={() => { setError(''); setNotice(''); setEditing({ app: null, form: googleAppForm(null) }); }}>
          {t('admin.integrations.googleApps.add')}
        </button>
      )}

      {error && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--red)' }}>{error}</div>}
      {notice && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>{notice}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Locales** — в `en.json` и `ru.json` внутри `admin.integrations` (рядом с объектом `google`) добавить объект `googleApps`:

`en.json`:
```json
"googleApps": {
  "title": "Google apps",
  "description": "OAuth apps that Gmail mailboxes connect through. An unverified Google Cloud project accepts at most 100 users over its lifetime, so MailExpert spreads mailboxes across several apps.",
  "callbackLabel": "Callback URL",
  "callbackNote": "The same for every app. Register it in each app's OAuth client.",
  "callbackNotSaved": "Not saved yet: this is the address of the page you are on. Save it before adding apps.",
  "callbackOtherHost": "You opened the panel through another address. If people connect Gmail from here, also register: {{uri}}",
  "callbackSaved": "Callback URL saved.",
  "callbackCopied": "Callback URL copied.",
  "setupTitle": "How to add an app",
  "step1": "Create a separate Google Cloud project for each app: OAuth clients of one project share its 100-user limit.",
  "step2": "On the OAuth consent screen choose the External audience and publish the app (In Production). Do not use Testing: access there expires after 7 days.",
  "step3": "Add the scopes: {{scopes}}",
  "step4": "Credentials → Create credentials → OAuth client ID → Web application; add the callback URL above to Authorized redirect URIs.",
  "step5": "Add the app below with its client ID and client secret.",
  "empty": "No apps yet. Gmail cannot be connected until one is added.",
  "columnLabel": "Name",
  "clientId": "Client ID",
  "clientIdPh": "1234567890-abc123.apps.googleusercontent.com",
  "clientIdFixed": "The client ID of an app does not change. Another client ID is another app.",
  "clientSecret": "Client secret",
  "clientSecretKeep": "Leave empty to keep the stored secret.",
  "userLimit": "User limit",
  "userLimitHint": "Lower it if the project had users before MailExpert: Google counts them too.",
  "columnSeats": "Used / limit",
  "columnAccounts": "Mailboxes",
  "columnState": "State",
  "stateActive": "Active",
  "stateFull": "Full",
  "stateClosed": "Closed",
  "stateDisabled": "Disabled",
  "activate": "Activate",
  "close": "Close to new mailboxes",
  "disable": "Disable",
  "add": "Add app",
  "formTitleAdd": "New Google app",
  "formTitleEdit": "Edit Google app",
  "saved": "Google app saved.",
  "disableConfirmTitle": "Disable \"{{label}}\"?",
  "disableConfirm": "Mailboxes that will need a reconnect: {{count}}. They reconnect through another app.",
  "deleteConfirmTitle": "Delete \"{{label}}\"?",
  "deleteConfirm": "The record of addresses this app has served is deleted with it.",
  "deleteInUse": "An app can be deleted once no mailbox uses it.",
  "loadFailed": "Could not load Google apps: {{message}}",
  "errorGeneric": "The request failed. Please try again.",
  "errorLabelInvalid": "Enter a name of 1 to 100 characters.",
  "errorClientIdInvalid": "This is not a Google OAuth client ID. It ends with .apps.googleusercontent.com.",
  "errorClientSecretRequired": "Enter the client secret.",
  "errorClientSecretRedacted": "The client secret contains a hidden-value character. Paste the full secret.",
  "errorUserLimitInvalid": "The user limit must be a positive whole number.",
  "errorStatusInvalid": "Unknown app state.",
  "errorAppExists": "This client ID is already added.",
  "errorSameProject": "An app from this Google Cloud project is already added. Clients of one project share its limit.",
  "errorInUse": "The app still has connected mailboxes.",
  "errorNotFound": "The app no longer exists. Reload the page.",
  "errorCallbackInvalid": "Enter a full address starting with https:// or http://."
}
```

`ru.json`:
```json
"googleApps": {
  "title": "Google-приложения",
  "description": "OAuth-приложения, через которые подключаются ящики Gmail. Непроверенный проект Google Cloud принимает не больше 100 пользователей за всё время, поэтому MailExpert распределяет ящики по нескольким приложениям.",
  "callbackLabel": "Callback-адрес",
  "callbackNote": "Общий для всех приложений. Зарегистрируйте его в OAuth-клиенте каждого приложения.",
  "callbackNotSaved": "Ещё не сохранён: это адрес открытой страницы. Сохраните его до добавления приложений.",
  "callbackOtherHost": "Панель открыта через другой адрес. Если Gmail подключают отсюда, зарегистрируйте ещё: {{uri}}",
  "callbackSaved": "Callback-адрес сохранён.",
  "callbackCopied": "Callback-адрес скопирован.",
  "setupTitle": "Как добавить приложение",
  "step1": "Создайте отдельный проект Google Cloud на каждое приложение: OAuth-клиенты одного проекта делят его лимит в 100 пользователей.",
  "step2": "На экране согласия OAuth выберите аудиторию External и опубликуйте приложение (In Production). Режим Testing не подходит: доступ в нём истекает через 7 дней.",
  "step3": "Добавьте области доступа: {{scopes}}",
  "step4": "Credentials → Create credentials → OAuth client ID → Web application; добавьте callback-адрес выше в Authorized redirect URIs.",
  "step5": "Добавьте приложение ниже с его client ID и client secret.",
  "empty": "Приложений пока нет. Gmail нельзя подключить, пока не добавлено хотя бы одно.",
  "columnLabel": "Название",
  "clientId": "Идентификатор клиента",
  "clientIdPh": "1234567890-abc123.apps.googleusercontent.com",
  "clientIdFixed": "Идентификатор клиента у приложения не меняется. Другой идентификатор — другое приложение.",
  "clientSecret": "Секрет клиента",
  "clientSecretKeep": "Оставьте пустым, чтобы сохранить прежний секрет.",
  "userLimit": "Лимит пользователей",
  "userLimitHint": "Уменьшите, если проектом пользовались до MailExpert: Google учитывает и тех пользователей.",
  "columnSeats": "Занято / лимит",
  "columnAccounts": "Ящиков",
  "columnState": "Состояние",
  "stateActive": "Активно",
  "stateFull": "Заполнено",
  "stateClosed": "Закрыто",
  "stateDisabled": "Отключено",
  "activate": "Сделать активным",
  "close": "Закрыть для новых ящиков",
  "disable": "Отключить",
  "add": "Добавить приложение",
  "formTitleAdd": "Новое Google-приложение",
  "formTitleEdit": "Изменить Google-приложение",
  "saved": "Google-приложение сохранено.",
  "disableConfirmTitle": "Отключить «{{label}}»?",
  "disableConfirm": "Ящиков, которые потребуют переподключения: {{count}}. Они переподключатся через другое приложение.",
  "deleteConfirmTitle": "Удалить «{{label}}»?",
  "deleteConfirm": "Вместе с приложением удаляется журнал адресов, которые оно обслуживало.",
  "deleteInUse": "Приложение можно удалить, когда к нему не привязан ни один ящик.",
  "loadFailed": "Не удалось загрузить Google-приложения: {{message}}",
  "errorGeneric": "Запрос не выполнен. Повторите попытку.",
  "errorLabelInvalid": "Введите название длиной от 1 до 100 символов.",
  "errorClientIdInvalid": "Это не идентификатор OAuth-клиента Google. Он заканчивается на .apps.googleusercontent.com.",
  "errorClientSecretRequired": "Введите секрет клиента.",
  "errorClientSecretRedacted": "В секрете есть символ скрытого значения. Вставьте секрет целиком.",
  "errorUserLimitInvalid": "Лимит пользователей — целое положительное число.",
  "errorStatusInvalid": "Неизвестное состояние приложения.",
  "errorAppExists": "Этот идентификатор клиента уже добавлен.",
  "errorSameProject": "Приложение из этого проекта Google Cloud уже добавлено. Клиенты одного проекта делят его лимит.",
  "errorInUse": "К приложению ещё привязаны ящики.",
  "errorNotFound": "Приложения больше нет. Обновите страницу.",
  "errorCallbackInvalid": "Введите полный адрес, начинающийся с https:// или http://."
}
```

Проверить `common.copy`, `common.save`, `common.edit`, `common.delete`, `common.cancel`, `common.loading` — есть в обеих локалях (есть на момент написания плана).

- [ ] **Step 5: Mount** — в `AdminPanel.jsx`:

Импорт рядом с `GoogleIntegrationSection`:

```js
import GoogleAppsSection from './GoogleAppsSection.jsx';
```

Строку `<GoogleIntegrationSection isAdmin={isAdmin} />` (сейчас около строки 2787) заменить на:

```jsx
          {isAdmin && <GoogleAppsSection />}
          <GoogleIntegrationSection isAdmin={isAdmin} />
```

(Старая карточка уходит в Task 4; до тех пор оба блока на экране — промежуточное состояние внутри ветки.)

В индекс поиска настроек после строки `{ label: t('admin.integrations.google.title'), … }` добавить:

```js
    { label: t('admin.integrations.googleApps.title'), keywords: ['google', 'gmail', 'oauth', 'client id', 'google cloud', 'project', 'callback', 'limit'], tab: 'integrations', adminOnly: true, breadcrumb: tabLabel('integrations') },
```

- [ ] **Step 6: Run tests, lint, build**

Run: `cd frontend && node --test src/locales/i18n.test.js src/utils/googleApps.test.js && npm run lint && npm run build`
Expected: PASS; lint без предупреждений (`--max-warnings 0`); сборка успешна. Если Suite 4 (hardcoded strings) ругается на строку компонента — вынести её в ключ, а не в `HARDCODED_OK`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/GoogleAppsSection.jsx frontend/src/components/AdminPanel.jsx frontend/src/locales/en.json frontend/src/locales/ru.json frontend/src/locales/i18n.test.js
git commit -m "feat(google-apps): add the Google apps admin screen"
```

---

### Task 4: Фронтенд — временная карточка «Подключить Gmail» и удаление старой карточки

**Files:**
- Create: `frontend/src/components/GmailConnectCard.jsx`
- Delete: `frontend/src/components/GoogleIntegrationSection.jsx`
- Modify: `frontend/src/components/AdminPanel.jsx` (импорты, кнопка «Переподключить Gmail», монтирование)
- Modify: `frontend/src/utils/googleOAuth.js`, `frontend/src/utils/googleOAuth.test.js` (удаление помощников секрета)
- Modify: `frontend/src/locales/en.json`, `ru.json`, `i18n.test.js` (удаление мёртвых ключей, перенацеливание теста)

**Interfaces:**
- Consumes: `api.getIntegrationsStatus()` → `{ google: { configured, available } }` (8a); `buildGoogleConnectUrl({ loginHint? })` из `utils/googleOAuth.js`; `openOAuthWindow(href)` из `utils/oauthWindow.js`.
- Produces: `export default function GmailConnectCard()` — без пропсов, для всех пользователей. Удаляются: `GoogleIntegrationSection.jsx` с экспортом `openGoogleOAuth`; из `googleOAuth.js` — `REDACTED_CLIENT_SECRET`, `secretFieldOnFocus`, `secretFieldOnBlur`, `resolveClientSecretForSave`.

- [ ] **Step 1: Retarget the locale test (failing first)** — в `i18n.test.js` тест `every Google integration key used in GoogleIntegrationSection.jsx exists in every locale` заменить на:

```js
    it('every Google key used by the temporary Gmail card exists in every locale', () => {
      // Until PR 8c this card is the only way to add a Gmail mailbox over OAuth.
      const source = readFileSync(resolve(dir, '../components/GmailConnectCard.jsx'), 'utf8');
      const keys = [...new Set([...source.matchAll(/'(admin\.integrations\.google\.[\w.]+)'/g)].map(m => m[1]))];
      assert.ok(keys.length >= 6, `expected the Gmail card keys, found ${keys.length}`);
      const missing = [];
      for (const lang of langs) {
        for (const key of keys) {
          if (typeof locales[lang][key] !== 'string' || !locales[lang][key]) missing.push(`  - ${lang}: ${key}`);
        }
      }
      assert.equal(missing.length, 0, `Gmail card keys missing from locale files:\n${missing.join('\n')}`);
    });
```

Из `SAME_VALUE_ALLOWED` удалить строку `'admin.integrations.google.clientIdPh': 'any', …` (ключ удаляется ниже; `admin.integrations.google.title` остаётся).

В `googleOAuth.test.js` удалить из импорта `REDACTED_CLIENT_SECRET`, `resolveClientSecretForSave`, `secretFieldOnBlur`, `secretFieldOnFocus` и весь `describe('client secret field', …)`.

Run: `cd frontend && node --test src/locales/i18n.test.js`
Expected: FAIL — `ENOENT … GmailConnectCard.jsx`.

- [ ] **Step 2: Write the card** — `frontend/src/components/GmailConnectCard.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { buildGoogleConnectUrl } from '../utils/googleOAuth.js';
import { openOAuthWindow } from '../utils/oauthWindow.js';

const noteBoxStyle = {
  padding: '12px 14px', borderRadius: 8, marginBottom: 12, background: 'rgba(124,106,247,0.06)',
  border: '1px solid rgba(124,106,247,0.15)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
};

// Temporary "Connect Gmail" card for every user. It starts the legacy `GET /oauth/google` flow
// (the backend creates or updates the mailbox of the Google account the user picks). PR 8c
// removes it together with that flow, when the "Add account" dialog takes over. The callback
// result is announced by MailApp.
export default function GmailConnectCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null); // { configured, available }
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    api.getIntegrationsStatus()
      .then((data) => setStatus(data?.google || { configured: false, available: false }))
      .catch(() => setStatus({ configured: false, available: false }));
    const handleMessage = (e) => {
      if (e.origin !== window.location.origin) return;
      if ((e.data?.type === 'oauth_success' || e.data?.type === 'oauth_error') && e.data?.provider === 'google') {
        setConnecting(false);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const available = status?.available === true;
  let noteKey = 'admin.integrations.google.userNoteConfigured';
  if (status && !status.configured) noteKey = 'admin.integrations.google.userNoteNotConfigured';
  else if (status && !available) noteKey = 'admin.integrations.google.errorNoAppCapacity';

  const connect = () => {
    if (!available) return;
    setConnecting(true);
    openOAuthWindow(buildGoogleConnectUrl());
    setTimeout(() => setConnecting(false), 5000);
  };

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
        {t('admin.integrations.google.title')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1, marginBottom: 12 }}>
        {t('admin.integrations.google.description')}
      </div>
      {status && <div style={noteBoxStyle}>{t(noteKey)}</div>}
      <button
        type="button"
        onClick={connect}
        disabled={!available || connecting}
        style={{
          padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: available ? 'var(--accent)' : 'var(--bg-elevated)',
          border: `1px solid ${available ? 'var(--accent)' : 'var(--border)'}`,
          color: available ? 'white' : 'var(--text-tertiary)',
          cursor: available && !connecting ? 'pointer' : 'not-allowed',
          opacity: !available || connecting ? 0.6 : 1,
        }}
      >
        {connecting ? t('admin.integrations.google.redirecting') : t('admin.integrations.google.connect')}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Wire AdminPanel and delete the old card**

`AdminPanel.jsx`:
- импорт `import GoogleIntegrationSection, { openGoogleOAuth } from './GoogleIntegrationSection.jsx';` заменить на `import GmailConnectCard from './GmailConnectCard.jsx';`;
- `import { isGoogleReconnectRequired } from '../utils/googleOAuth.js';` заменить на `import { buildGoogleConnectUrl, isGoogleReconnectRequired } from '../utils/googleOAuth.js';`;
- кнопку «Переподключить Gmail» (около строки 1092) `onClick={() => openGoogleOAuth({ loginHint: account.email_address })}` заменить на `onClick={() => openOAuthWindow(buildGoogleConnectUrl({ loginHint: account.email_address }))}` (`openOAuthWindow` уже импортирован);
- блок из Task 3

```jsx
          {isAdmin && <GoogleAppsSection />}
          <GoogleIntegrationSection isAdmin={isAdmin} />
```

заменить на

```jsx
          {isAdmin && <GoogleAppsSection />}
          <GmailConnectCard />
```

Удалить файл: `git rm frontend/src/components/GoogleIntegrationSection.jsx`.

`googleOAuth.js`: удалить `REDACTED_CLIENT_SECRET` (с комментарием), `secretFieldOnFocus`, `secretFieldOnBlur`, `resolveClientSecretForSave` и комментарии над ними. `buildGoogleRedirectUri` остаётся (им пользуется `GoogleAppsSection`).

- [ ] **Step 4: Remove dead locale keys** — из `admin.integrations.google` в `en.json` и `ru.json` удалить ключи, которые после удаления карточки нигде не упоминаются:

`configured`, `notConfigured`, `setupTitle`, `step1`, `step2`, `step3`, `step4`, `step5`, `clientId`, `clientIdPh`, `clientSecret`, `clientSecretPh`, `clientSecretStoredNote`, `redirectUri`, `redirectUriNote`, `save`, `remove`, `savedNote`, `removedNote`, `saveError`, `removeError`, `removeConfirm`, `clientSecretInvalid`, `requiredFields`, `notConfiguredAdminNote`.

Остаются: `title`, `description`, `connect`, `redirecting`, `userNoteConfigured`, `userNoteNotConfigured` (карточка) и все `result*`/`error*` (`utils/googleOAuth.js`). Перед удалением проверить каждый ключ поиском по `frontend/src` (например `grep -rn "google.step1" frontend/src --include=*.js --include=*.jsx`): если ключ где-то ещё упоминается — оставить и доложить.

`errorInvalidState` говорит «start "Connect Gmail" again» — кнопка с таким названием осталась в карточке, текст верен до 8c.

- [ ] **Step 5: Run tests, lint, build**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: весь набор PASS (включая Suite 1 — нет неиспользуемых ключей, `googleOAuth.test.js` без удалённых тестов), lint без предупреждений, сборка успешна. `grep -rn "GoogleIntegrationSection\|openGoogleOAuth\|REDACTED_CLIENT_SECRET" frontend/src` — пусто.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src/components/GmailConnectCard.jsx frontend/src/components/GoogleIntegrationSection.jsx frontend/src/components/AdminPanel.jsx frontend/src/utils/googleOAuth.js frontend/src/utils/googleOAuth.test.js frontend/src/locales/en.json frontend/src/locales/ru.json frontend/src/locales/i18n.test.js
git commit -m "feat(google-apps): replace the single-client Google card, keep Connect Gmail until the new dialog"
```

---

### Task 5: Спецификации и полная проверка

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`

**Interfaces:**
- Consumes: всё из Task 1–4.
- Produces: статус серии и уточнения 8b в спецификации.

- [ ] **Step 1: Specs** — в `2026-09-15-shared-mailboxes-google-login-design.md` в строке статуса «PR 8a (бэкенд Google-приложений) реализован.» заменить на «PR 8a (бэкенд Google-приложений) и PR 8b (админка «Google-приложения») реализованы.». В конец раздела «## Уточнения, принятые при реализации PR 8» (перед «## Проверка») добавить:

```markdown
- 8b: `POST /api/integrations/google` принимает только `{ redirectUri }` — абсолютный `http(s)` адрес, иначе `400 redirect_uri_invalid`; `clientId`/`clientSecret` в теле игнорируются. Очистить callback через API больше нельзя: `DELETE /api/integrations/:provider` работает только для `microsoft`, для остальных — `400 Unknown provider`. `GET /api/integrations` отдаёт для `google` только `redirectUri` (из `integration_config`, иначе `GOOGLE_REDIRECT_URI`) и `updated_at`. `saveDefaultGoogleAppCompat` удалён.
- 8b: экран «Google-приложения» виден только администратору. Секрет в форме правки не показывается и не подставляется плейсхолдером: поле пустое, пустое значение сохраняет прежний. Если панель открыта через другой хост (`APP_ALT_URLS`), экран подсказывает callback этого хоста для регистрации в Google.
- 8b: кнопка «Подключить Gmail» ушла с экрана приложений, но до 8c остаётся отдельной карточкой для всех пользователей в «Интеграции → Почтовые провайдеры» (`GmailConnectCard`, старый поток `GET /oauth/google`): другого способа добавить Gmail по OAuth до диалога «Добавить аккаунт» нет. 8c удаляет карточку вместе с этим потоком.
```

- [ ] **Step 2: Full verification**

Run: `bt` (весь бэкенд), затем в том же контейнере `npm run lint`; `cd frontend && npm test && npm run lint && npm run build`.
Expected: все тесты проходят, lint без ошибок, сборка успешна. Если бэкенд-набор падает в файлах, которые эта серия не трогала, — сравнить с прогоном на `main` в том же контейнере и доложить, не чинить обходом.

- [ ] **Step 3: Manual check** (если поднят тестовый стенд; иначе явно доложить, что не выполнялось) — под администратором: callback сохраняется и копируется; добавление приложения с чужим client ID даёт «уже добавлено из этого проекта»; «Отключить» показывает число ящиков; удаление недоступно при привязанных ящиках. Под обычным пользователем: экрана «Google-приложения» нет, карточка «Подключить Gmail» есть и открывает вкладку Google.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md
git commit -m "docs: record PR 8b decisions for the Google apps admin screen"
```
