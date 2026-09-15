# Общие ящики, PR 1: вход только через Google и одобренные пользователи — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. В этом проекте пользователь выполняет планы без субагентов: использовать superpowers:executing-plans.

**Goal:** в режиме `AUTH_MODE=google` в MailExpert входят только одобренные администратором пользователи — через Cloudflare Access или прямой вход через Google; статус пользователя проверяется на каждом запросе, отключение сразу закрывает сессии и WebSocket, локальные способы входа выключены.

**Architecture:** настройки входа читаются из env модулем `authSettings.js`. Сервис `userIdentity.js` находит или создаёт пользователя по проверенному email и привязывает сессию. `cloudflareAccess.js` проверяет JWT Cloudflare Access с устойчивым кешем JWKS. Один middleware `identityGate.js` стоит перед `/api`, `/oauth`, `/auth/oidc` и CardDAV: в режиме `google` он пропускает только публичные пути, проверяет токен или сессию прямого входа и отвечает 404 на локальные способы входа. Прямой вход — роутер `/oauth/login/google`. WebSocket проверяет то же при подключении. Админка получает добавление пользователя по email, отключение и защиту последнего администратора. Фронтенд показывает отдельный экран входа и отдельный экран пользователей в режиме `google`.

**Tech Stack:** Node.js 22, Express 5, express-session + Redis, PostgreSQL 16, jose 6, vitest 5; React 19, react-i18next, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` — разделы «Режимы входа», «Пользователи», «Разбиение на PR» (пункт 1).

## Global Constraints

- Комментарии в коде — только на английском.
- Коммиты и PR от имени `wyrtensi`, без строк атрибуции; все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- В документах, коммитах и PR — только заглушки `<CF_HOST>`, `<DIRECT_HOST>`, `<TEAM>`, `<AUD>`; внутренние имена других проектов не упоминаются.
- JWT Cloudflare, коды авторизации Google, токены и client secret не попадают в логи, URL MailExpert, ответы API и тексты ошибок. В логах — только стабильный код и имя класса ошибки. Email пользователей не пишется в логи; в логах админки — id пользователя.
- `AUTH_MODE` по умолчанию `local`. В режиме `local` поведение не меняется, кроме двух вещей из спецификации: отключённый пользователь (`disabled_at`) получает 403, системные письма больше не уходят через рабочие ящики.
- Env: `AUTH_MODE`, `CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE`, `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `BOOTSTRAP_ADMIN_EMAILS`, `APP_ALT_URLS`.
- Заголовок Cloudflare — `cf-access-jwt-assertion`; ключи — `<issuer>/cdn-cgi/access/certs`; алгоритм только RS256; кеш ключей 10 минут, при ошибке обновления последний набор живёт до 24 часов.
- Callback прямого входа — `<origin>/oauth/login/google/callback`, scope `openid email`, PKCE S256, `prompt=select_account`.
- Коды ответов: `not_authenticated` (401), `user_disabled` (403), `not_allowed` (403); ошибки прямого входа передаются как `/login?auth_error=<code>`.
- Монки-патчинг запрещён.
- Backend-тесты запускаются в `node:22-bookworm-slim` (локальный Node 24 не подходит под `engines`). Frontend-тесты, lint и сборка — локально в `frontend/`.
- Работа идёт в ветке `feat/approved-google-sign-in`, созданной от `docs/shared-mailboxes-spec` (там уже лежат спецификация и этот план): `git switch docs/shared-mailboxes-spec && git switch -c feat/approved-google-sign-in`.

## Уточнения спецификации в этом PR

Task 12 вносит их в спецификацию.

1. **Redirect URI по origin** меняется только у Google-ящиков: путь из `GOOGLE_REDIRECT_URI`, origin — тот публичный адрес, через который пришёл браузер. Microsoft-ящики остаются с одним `MS_REDIRECT_URI`.
2. **Сессия, открытая через Cloudflare, принимается только вместе с токеном Access.** Без заголовка засчитывается лишь сессия прямого входа. Иначе украденная кука с хоста за Cloudflare работала бы в обход Access.
3. **WebSocket не меняет сессию:** токен Access при подключении должен принадлежать пользователю, уже записанному в сессию. HTTP-запросы страницы привязывают его раньше.
4. **Удаление пользователя, у которого есть ящики, в режиме `google` запрещено до PR 3** (409 `user_has_mailboxes`): до PR 3 каскад удалил бы его ящики.
5. **Публичные пути в режиме `google`:** `/api/health`, `/api/version`, `/api/update`, `/api/auth/config`, `/api/auth/logout`, `/oauth/login/google`, `/oauth/login/google/callback`.
6. **Отвечают 404 в режиме `google`**, кроме перечисленных в спецификации: `/api/auth/profile/recovery-email` и `/api/admin/users/:id/totp/disable`.
7. **Прямой вход пишет `sso_login`** в существующую таблицу `auth_events`.

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

Frontend (из корня репозитория): `cd frontend && node --test <files>`; полный прогон — `cd frontend && npm test && npm run lint && npm run build`.

## Файлы

| Файл | Ответственность |
|---|---|
| Create `backend/src/utils/publicOrigins.js` (+ test) | Публичные origin: `APP_URL` + `APP_ALT_URLS` |
| Modify `backend/src/services/websocket.js` (+ test) | Origin из списка; авторизация подключения; закрытие сокетов пользователя |
| Modify `backend/src/services/oauth/googleApps.js` (+ test), `backend/src/routes/oauthGoogle.js` | Redirect URI Google-ящиков по origin |
| Create `backend/src/services/auth/authSettings.js` (+ test) | `AUTH_MODE` и параметры входа |
| Create `backend/migrations/0054_users_email_status.sql` | `users.email`, `disabled_at`, `disabled_by` |
| Create `backend/src/services/auth/userIdentity.js` (+ test) | Поиск/создание пользователя по email, привязка сессии |
| Create `backend/src/services/auth/cloudflareAccess.js` (+ test) | Проверка JWT Cloudflare Access |
| Create `backend/src/middleware/identityGate.js` (+ test) | Проверка личности на каждом запросе в режиме `google` |
| Modify `backend/src/middleware/auth.js` (+ `auth.test.js`) | `disabled_at` в `requireAuth` и `requireAdmin` |
| Modify `backend/src/services/oauth/oauthState.js` (+ test), `googleOAuth.js` (+ test) | State без пользователя; URL прямого входа |
| Create `backend/src/routes/authGoogle.js` (+ test) | `GET /oauth/login/google`, callback |
| Modify `backend/src/routes/auth.js` (+ `auth.config.test.js`) | `/config`, `/me`, выход, сброс пароля только через системный SMTP |
| Modify `backend/src/routes/admin.js` (+ `admin.users.test.js`) | Пользователи по email, отключение, защита админов; приглашения только через системный SMTP |
| Modify `backend/src/index.js` | Проверка конфигурации, gate, прямой вход |
| Modify `.env.example`, `docker-compose.yml` | Новые переменные |
| Modify `frontend/src/utils/api.js`; Create `frontend/src/utils/authMode.js` (+ test) | API и помощники режима |
| Modify `frontend/src/App.jsx`; Create `frontend/src/components/GoogleLoginPage.jsx` | Экран входа через Google |
| Create `frontend/src/components/GoogleUsersPanel.jsx`; Modify `frontend/src/components/AdminPanel.jsx` | Экран пользователей, скрытие локальных настроек входа |
| Modify `frontend/src/locales/*.json` | Новые строки |
| Modify `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` | Уточнения и статус |

---

### Task 1: Публичные origin и redirect URI Google-ящиков

**Files:**
- Create: `backend/src/utils/publicOrigins.js`
- Create: `backend/src/utils/publicOrigins.test.js`
- Modify: `backend/src/services/websocket.js:1-34`
- Modify: `backend/src/services/websocket.test.js`
- Modify: `backend/src/services/oauth/googleApps.js:42-56`
- Modify: `backend/src/services/oauth/googleApps.test.js:103-135`
- Modify: `backend/src/routes/oauthGoogle.js:12,45,82`
- Modify: `.env.example`, `docker-compose.yml`

**Interfaces:**
- Produces: `getPublicOrigins(env = process.env): string[]`; `allowedRequestOrigin(req, env = process.env): string | null`; `getGoogleRedirectUri(origin = null): string | null`; `resolveGoogleConfig({ appId = null, origin = null } = {})`.

- [ ] **Step 1: Write the failing tests**

`backend/src/utils/publicOrigins.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { allowedRequestOrigin, getPublicOrigins } from './publicOrigins.js';

const fakeReq = (protocol, host) => ({
  protocol,
  get: (name) => (name.toLowerCase() === 'host' ? host : undefined),
});

describe('getPublicOrigins', () => {
  it('collects APP_URL and APP_ALT_URLS as unique origins', () => {
    expect(getPublicOrigins({
      APP_URL: 'https://mail.example.com/',
      APP_ALT_URLS: ' https://direct.example.com/login , not a url, ftp://files.example.com, https://mail.example.com',
    })).toEqual(['https://mail.example.com', 'https://direct.example.com']);
  });

  it('is empty without configured URLs', () => {
    expect(getPublicOrigins({})).toEqual([]);
  });
});

describe('allowedRequestOrigin', () => {
  const env = { APP_URL: 'https://mail.example.com', APP_ALT_URLS: 'https://direct.example.com' };

  it('returns the origin of a request that came through a public origin', () => {
    expect(allowedRequestOrigin(fakeReq('https', 'direct.example.com'), env)).toBe('https://direct.example.com');
    expect(allowedRequestOrigin(fakeReq('https', 'mail.example.com'), env)).toBe('https://mail.example.com');
  });

  it('rejects other hosts, another scheme and a missing host', () => {
    expect(allowedRequestOrigin(fakeReq('https', 'evil.example.com'), env)).toBeNull();
    expect(allowedRequestOrigin(fakeReq('http', 'direct.example.com'), env)).toBeNull();
    expect(allowedRequestOrigin(fakeReq('https', undefined), env)).toBeNull();
  });
});
```

В конец `backend/src/services/websocket.test.js` добавить:

```js
describe('WebSocket origins', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('accepts APP_URL and APP_ALT_URLS origins and closes others', async () => {
    vi.resetModules();
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    vi.stubEnv('APP_ALT_URLS', 'https://direct.example.com');
    const { setupWebSocket: setupWithOrigins } = await import('./websocket.js');
    const connect = (origin) => {
      const wss = new EventEmitter();
      const ws = Object.assign(new EventEmitter(), {
        readyState: 1, close: vi.fn(), terminate: vi.fn(), send: vi.fn(),
      });
      // Session lookup never finishes: only the origin check runs.
      setupWithOrigins(wss, () => {}, { connectAllForUser: vi.fn() });
      wss.emit('connection', ws, { headers: { origin } });
      return ws;
    };
    expect(connect('https://mail.example.com').close).not.toHaveBeenCalled();
    expect(connect('https://direct.example.com').close).not.toHaveBeenCalled();
    expect(connect('https://evil.example.com').close).toHaveBeenCalledWith(1008, 'Forbidden');
  });
});
```

В `backend/src/services/oauth/googleApps.test.js` в `describe('resolveGoogleConfig', ...)` перед последним `it` добавить:

```js
  it('sends a browser that came through another public origin back to that origin', async () => {
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [APP] });
    expect(await resolveGoogleConfig({ origin: 'https://direct.example.com' })).toMatchObject({
      redirectUri: 'https://direct.example.com/oauth/google/callback',
    });
    expect(await resolveGoogleConfig({ origin: null })).toMatchObject({ redirectUri: REDIRECT_URI });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bt src/utils/publicOrigins.test.js src/services/websocket.test.js src/services/oauth/googleApps.test.js`
Expected: FAIL — `Failed to resolve import "./publicOrigins.js"`; в `websocket.test.js` direct-origin закрывается с `Forbidden`; в `googleApps.test.js` redirectUri равен `REDIRECT_URI`.

- [ ] **Step 3: Implement**

`backend/src/utils/publicOrigins.js`:

```js
// Public origins MailExpert is served from: APP_URL plus APP_ALT_URLS (comma-separated).
// WebSocket connections accept them, and OAuth flows send the browser back to the one it
// actually came through.
function toOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function getPublicOrigins(env = process.env) {
  const values = [env.APP_URL, ...String(env.APP_ALT_URLS || '').split(',')];
  return [...new Set(values.map(toOrigin).filter(Boolean))];
}

// The origin of this request when it is a public origin, else null. The scheme comes from
// X-Forwarded-Proto through `trust proxy`, the host from the Host header.
export function allowedRequestOrigin(req, env = process.env) {
  const host = req.get('host');
  if (!host) return null;
  const origin = toOrigin(`${req.protocol}://${host}`);
  return origin && getPublicOrigins(env).includes(origin) ? origin : null;
}
```

В `backend/src/services/websocket.js` заменить строки 1–14:

```js
import { recordWsConnect, recordWsDisconnect } from './diagnosticsRing.js';
import { getPublicOrigins } from '../utils/publicOrigins.js';

// Accepted browser origins (APP_URL plus APP_ALT_URLS), read once at startup.
// Without any, origin validation is skipped — log a warning so operators know.
const ALLOWED_ORIGINS = getPublicOrigins();
if (!ALLOWED_ORIGINS.length) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: APP_URL is not set in production — WebSocket connections with an Origin header will be rejected.');
  } else {
    console.warn('WARNING: APP_URL is not set — WebSocket origin validation is disabled. Set APP_URL in .env for production.');
  }
}
```

и строки 23–34:

```js
    // Reject cross-origin WebSocket connections when public origins are configured.
    // Browsers always send Origin on WS upgrades; absence means a non-browser client.
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
      ws.close(1008, 'Forbidden');
      return;
    }
    // In production without APP_URL, reject browser connections (non-browser clients omit Origin)
    if (!ALLOWED_ORIGINS.length && process.env.NODE_ENV === 'production' && origin) {
      ws.close(1008, 'Forbidden');
      return;
    }
```

В `backend/src/services/oauth/googleApps.js` заменить строки 42–56:

```js
// The callback URL registered for every app. A browser that came through another public
// origin (APP_ALT_URLS) is sent back to that origin, on the same path.
export function getGoogleRedirectUri(origin = null) {
  const configured = process.env.GOOGLE_REDIRECT_URI || null;
  if (!configured || !origin) return configured;
  try {
    return `${origin}${new URL(configured).pathname}`;
  } catch {
    return configured;
  }
}

// Credentials for one consent flow: the given app, or the default app. Null when the
// callback URL is missing, the app is missing or disabled, or its secret cannot be decrypted.
export async function resolveGoogleConfig({ appId = null, origin = null } = {}) {
  const redirectUri = getGoogleRedirectUri(origin);
  if (!redirectUri) return null;
  const app = appId ? await getGoogleAppById(appId) : await getDefaultGoogleApp();
  if (!app || app.status === 'disabled') return null;
  const clientSecret = decrypt(app.client_secret);
  if (!clientSecret) return null;
  return { appId: app.id, clientId: app.client_id, clientSecret, redirectUri };
}
```

В `backend/src/routes/oauthGoogle.js` после строки 13 добавить импорт:

```js
import { allowedRequestOrigin } from '../utils/publicOrigins.js';
```

строку 45 заменить на:

```js
    const config = await resolveGoogleConfig({ origin: allowedRequestOrigin(req) });
```

строку 82 заменить на:

```js
    const config = await resolveGoogleConfig({ appId: pending.appId, origin: allowedRequestOrigin(req) });
```

В `.env.example` сразу после строки `APP_URL=https://your-domain-or-ip` добавить:

```bash

# Other public origins of this install, comma-separated — for example a direct host next
# to the one behind Cloudflare Access. WebSocket connections and OAuth callbacks accept
# them in addition to APP_URL; register each origin's callback URL with the OAuth client.
# APP_ALT_URLS=
```

В `docker-compose.yml` в `backend.environment` после `APP_URL: ${APP_URL:-}` добавить:

```yaml
      APP_ALT_URLS: ${APP_ALT_URLS:-}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bt src/utils/publicOrigins.test.js src/services/websocket.test.js src/services/oauth/googleApps.test.js src/routes/oauth.google.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/publicOrigins.js backend/src/utils/publicOrigins.test.js backend/src/services/websocket.js backend/src/services/websocket.test.js backend/src/services/oauth/googleApps.js backend/src/services/oauth/googleApps.test.js backend/src/routes/oauthGoogle.js .env.example docker-compose.yml
git commit -m "feat(auth): accept several public origins for WebSocket and Gmail callbacks"
```

---

### Task 2: Настройки режима входа

**Files:**
- Create: `backend/src/services/auth/authSettings.js`
- Create: `backend/src/services/auth/authSettings.test.js`
- Modify: `backend/src/index.js:79` (после проверки `ENCRYPTION_KEY`)
- Modify: `.env.example`, `docker-compose.yml`

**Interfaces:**
- Produces: `getAuthSettings(env = process.env): { mode: string, cloudflare: { issuer, audience } | null, googleSignIn: { clientId, clientSecret } | null, bootstrapAdminEmails: Set<string> }`; `authSettingsError(settings = getAuthSettings()): string | null`; `AUTH_MODES: Set<string>`.

- [ ] **Step 1: Write the failing test**

`backend/src/services/auth/authSettings.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { authSettingsError, getAuthSettings } from './authSettings.js';

describe('getAuthSettings', () => {
  it('defaults to local mode without sign-in providers', () => {
    expect(getAuthSettings({})).toEqual({
      mode: 'local', cloudflare: null, googleSignIn: null, bootstrapAdminEmails: new Set(),
    });
  });

  it('reads Cloudflare Access, Google sign-in and bootstrap admins', () => {
    const settings = getAuthSettings({
      AUTH_MODE: ' Google ',
      CF_ACCESS_ISSUER: 'https://team.cloudflareaccess.com/ ',
      CF_ACCESS_AUDIENCE: ' aud-tag ',
      AUTH_GOOGLE_CLIENT_ID: 'client-id',
      AUTH_GOOGLE_CLIENT_SECRET: 'client-secret',
      BOOTSTRAP_ADMIN_EMAILS: 'Admin@Example.com, , not-an-email, second@example.com',
    });
    expect(settings.mode).toBe('google');
    expect(settings.cloudflare).toEqual({ issuer: 'https://team.cloudflareaccess.com', audience: 'aud-tag' });
    expect(settings.googleSignIn).toEqual({ clientId: 'client-id', clientSecret: 'client-secret' });
    expect([...settings.bootstrapAdminEmails]).toEqual(['admin@example.com', 'second@example.com']);
  });

  it('needs both halves of a sign-in provider', () => {
    const settings = getAuthSettings({
      CF_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
      AUTH_GOOGLE_CLIENT_ID: 'client-id',
    });
    expect(settings.cloudflare).toBeNull();
    expect(settings.googleSignIn).toBeNull();
  });
});

describe('authSettingsError', () => {
  it('accepts local mode and google mode with at least one sign-in path', () => {
    expect(authSettingsError(getAuthSettings({}))).toBeNull();
    expect(authSettingsError(getAuthSettings({
      AUTH_MODE: 'google', CF_ACCESS_ISSUER: 'https://team.cloudflareaccess.com', CF_ACCESS_AUDIENCE: 'aud',
    }))).toBeNull();
    expect(authSettingsError(getAuthSettings({
      AUTH_MODE: 'google', AUTH_GOOGLE_CLIENT_ID: 'id', AUTH_GOOGLE_CLIENT_SECRET: 'secret',
    }))).toBeNull();
  });

  it('rejects an unknown mode and google mode without a sign-in path', () => {
    expect(authSettingsError(getAuthSettings({ AUTH_MODE: 'ldap' }))).toMatch(/AUTH_MODE must be/);
    expect(authSettingsError(getAuthSettings({ AUTH_MODE: 'google' }))).toMatch(/AUTH_MODE=google needs/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/services/auth/authSettings.test.js`
Expected: FAIL — `Failed to resolve import "./authSettings.js"`.

- [ ] **Step 3: Implement**

`backend/src/services/auth/authSettings.js`:

```js
// Sign-in configuration from the environment. Read on every call: parsing is cheap and a
// changed environment (tests, a restart with new values) is never served from a stale copy.
export const AUTH_MODES = new Set(['local', 'google']);

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

const text = (value) => String(value ?? '').trim();

export function getAuthSettings(env = process.env) {
  const issuer = text(env.CF_ACCESS_ISSUER).replace(/\/+$/, '');
  const audience = text(env.CF_ACCESS_AUDIENCE);
  const clientId = text(env.AUTH_GOOGLE_CLIENT_ID);
  const clientSecret = text(env.AUTH_GOOGLE_CLIENT_SECRET);
  const bootstrap = text(env.BOOTSTRAP_ADMIN_EMAILS)
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => EMAIL_PATTERN.test(email));

  return {
    mode: (text(env.AUTH_MODE) || 'local').toLowerCase(),
    cloudflare: issuer && audience ? { issuer, audience } : null,
    googleSignIn: clientId && clientSecret ? { clientId, clientSecret } : null,
    bootstrapAdminEmails: new Set(bootstrap),
  };
}

// A startup error for a configuration the server cannot run with, or null.
export function authSettingsError(settings = getAuthSettings()) {
  if (!AUTH_MODES.has(settings.mode)) return 'AUTH_MODE must be "local" or "google".';
  if (settings.mode === 'google' && !settings.cloudflare && !settings.googleSignIn) {
    return 'AUTH_MODE=google needs CF_ACCESS_ISSUER and CF_ACCESS_AUDIENCE, or AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET.';
  }
  return null;
}
```

В `backend/src/index.js` добавить импорт после строки 45 (`import { defaultEmptyBody } ...`):

```js
import { authSettingsError } from './services/auth/authSettings.js';
```

и сразу после блока проверки `ENCRYPTION_KEY` (закрывающая `}` на строке 79):

```js
// A google sign-in mode without any way to sign in would lock everyone out.
const authConfigError = authSettingsError();
if (authConfigError) {
  console.error(`FATAL: ${authConfigError} Exiting.`);
  process.exit(1);
}
```

В `.env.example` перед блоком `# ── Google OAuth (optional — Gmail accounts)` добавить:

```bash
# ── Sign-in mode ──────────────────────────────────────────────────────────────
# local (default): username and password, 2FA, OIDC, registration and invites.
# google: only users an admin approved in Admin → Users sign in, through Cloudflare
# Access and/or "Sign in with Google" on a host without Cloudflare. Password login, 2FA,
# OIDC, registration, invites, password reset and the built-in CardDAV server are off.
# AUTH_MODE=local
#
# Cloudflare Access in front of the install: Zero Trust team domain and the AUD tag of
# the Access application.
# CF_ACCESS_ISSUER=https://<TEAM>.cloudflareaccess.com
# CF_ACCESS_AUDIENCE=<AUD>
#
# "Sign in with Google" for a host that is not behind Cloudflare Access. OAuth client of
# type "Web application", scopes openid and email, authorized redirect URI
# <origin>/oauth/login/google/callback for every public origin. This client is not one
# of the Gmail apps. Never commit a real secret.
# AUTH_GOOGLE_CLIENT_ID=
# AUTH_GOOGLE_CLIENT_SECRET=
#
# Emails that are always admins and get an account on their first sign-in, comma-separated.
# BOOTSTRAP_ADMIN_EMAILS=


```

В `docker-compose.yml` в `backend.environment` после `IMAP_MAX_PERSISTENT_PER_HOST: ${IMAP_MAX_PERSISTENT_PER_HOST:-}` добавить:

```yaml
      AUTH_MODE: ${AUTH_MODE:-local}
      CF_ACCESS_ISSUER: ${CF_ACCESS_ISSUER:-}
      CF_ACCESS_AUDIENCE: ${CF_ACCESS_AUDIENCE:-}
      AUTH_GOOGLE_CLIENT_ID: ${AUTH_GOOGLE_CLIENT_ID:-}
      AUTH_GOOGLE_CLIENT_SECRET: ${AUTH_GOOGLE_CLIENT_SECRET:-}
      BOOTSTRAP_ADMIN_EMAILS: ${BOOTSTRAP_ADMIN_EMAILS:-}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bt src/services/auth/authSettings.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/auth/authSettings.js backend/src/services/auth/authSettings.test.js backend/src/index.js .env.example docker-compose.yml
git commit -m "feat(auth): read the sign-in mode and its providers from the environment"
```

---

### Task 3: Email и статус пользователя, поиск по проверенному email

**Files:**
- Create: `backend/migrations/0054_users_email_status.sql`
- Create: `backend/src/services/auth/userIdentity.js`
- Create: `backend/src/services/auth/userIdentity.test.js`

**Interfaces:**
- Consumes: `getAuthSettings()` из Task 2 (только форма `settings.bootstrapAdminEmails`).
- Produces:
  - `USER_COLUMNS = 'id, username, email, is_admin, disabled_at, created_at'`;
  - `class UserIdentityError extends Error { code }` (код `username_taken`);
  - `normalizeEmail(value): string | null`;
  - `loadUserById(userId): Promise<UserRow | null>`;
  - `findUserByEmail(email, db = { query }): Promise<UserRow | null>` (email уже нормализован);
  - `claimOrCreateUserByEmail(client, email, { isAdmin = false } = {}): Promise<{ user, created: boolean, claimed: boolean }>`;
  - `resolveVerifiedUser({ email, source: 'cloudflare' | 'google', settings }): Promise<{ user } | { error: 'not_allowed' | 'user_disabled' }>`;
  - `SESSION_AUTH_METHODS = new Set(['cloudflare', 'google'])`;
  - `bindSessionUser(req, user, authMethod): Promise<void>` — пишет `userId`, `username`, `isAdmin`, `authMethod`.

- [ ] **Step 1: Write the migration**

`backend/migrations/0054_users_email_status.sql`:

```sql
-- Google sign-in mode identifies people by a verified email and lets an admin turn a user
-- off without deleting them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- OIDC and password reset matched addresses against username, so a username that is an
-- address becomes the email — unless another username is the same address in another case.
UPDATE users u
   SET email = lower(u.username)
 WHERE u.email IS NULL
   AND u.username ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
   AND NOT EXISTS (
     SELECT 1 FROM users o WHERE o.id <> u.id AND lower(o.username) = lower(u.username)
   );

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email)) WHERE email IS NOT NULL;
```

- [ ] **Step 2: Write the failing test**

`backend/src/services/auth/userIdentity.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

const { query, withTransaction } = await import('../db.js');
const {
  UserIdentityError,
  bindSessionUser,
  claimOrCreateUserByEmail,
  findUserByEmail,
  loadUserById,
  normalizeEmail,
  resolveVerifiedUser,
} = await import('./userIdentity.js');

const USER = {
  id: 'u1', username: 'user@example.com', email: 'user@example.com',
  is_admin: false, disabled_at: null, created_at: new Date('2026-09-15T00:00:00Z'),
};
const settings = (emails = []) => ({ bootstrapAdminEmails: new Set(emails) });

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
});

describe('normalizeEmail', () => {
  it('trims and lower-cases an address', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
  });

  it.each([['empty', ''], ['no at sign', 'user'], ['a space', 'us er@example.com'], ['a number', 42], ['too long', `${'a'.repeat(250)}@x.io`]])(
    'rejects %s', (_label, value) => {
      expect(normalizeEmail(value)).toBeNull();
    },
  );
});

describe('user lookups', () => {
  it('loads a user by id and skips the query without one', async () => {
    query.mockResolvedValue({ rows: [USER] });
    expect(await loadUserById('u1')).toEqual(USER);
    expect(query.mock.calls[0][0]).toMatch(/FROM users WHERE id = \$1/);

    query.mockClear();
    expect(await loadUserById(undefined)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('finds a user by lower-cased email', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await findUserByEmail('user@example.com')).toBeNull();
    expect(query.mock.calls[0][0]).toMatch(/FROM users WHERE lower\(email\) = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['user@example.com']);
  });
});

describe('claimOrCreateUserByEmail', () => {
  const lock = [/pg_advisory_xact_lock/, { rows: [] }];

  it('returns the user that already has the address, under a per-address lock', async () => {
    const { client, calls } = scriptedClient([lock, [/WHERE lower\(email\) = \$1/, { rows: [USER] }]]);
    expect(await claimOrCreateUserByEmail(client, 'user@example.com')).toEqual({ user: USER, created: false, claimed: false });
    expect(calls[0][1]).toEqual(['user-email:user@example.com']);
  });

  it('gives the address to a legacy user whose username it is', async () => {
    const { client, calls } = scriptedClient([
      lock,
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [USER] }],
    ]);
    expect(await claimOrCreateUserByEmail(client, 'user@example.com')).toEqual({ user: USER, created: false, claimed: true });
    expect(calls[2][0]).toMatch(/email IS NULL AND lower\(username\) = \$1/);
  });

  it('creates a passwordless user named by the address', async () => {
    const { client, calls } = scriptedClient([
      lock,
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [] }],
      [/^\s*INSERT INTO users/, { rows: [{ ...USER, is_admin: true }] }],
    ]);
    expect(await claimOrCreateUserByEmail(client, 'user@example.com', { isAdmin: true }))
      .toEqual({ user: { ...USER, is_admin: true }, created: true, claimed: false });
    expect(calls[3][0]).toMatch(/INSERT INTO users \(username, email, is_admin\) VALUES \(\$1, \$1, \$2\)/);
    expect(calls[3][1]).toEqual(['user@example.com', true]);
  });

  it('reports a username that belongs to another address', async () => {
    const { client } = scriptedClient([
      lock,
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [] }],
      [/^\s*INSERT INTO users/, () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); }],
    ]);
    const err = await claimOrCreateUserByEmail(client, 'user@example.com').catch((e) => e);
    expect(err).toBeInstanceOf(UserIdentityError);
    expect(err.code).toBe('username_taken');
  });
});

describe('resolveVerifiedUser', () => {
  it('signs in a known active user without a transaction', async () => {
    query.mockResolvedValue({ rows: [USER] });
    expect(await resolveVerifiedUser({ email: 'User@Example.com', source: 'google', settings: settings() })).toEqual({ user: USER });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('refuses a disabled user', async () => {
    query.mockResolvedValue({ rows: [{ ...USER, disabled_at: new Date() }] });
    expect(await resolveVerifiedUser({ email: 'user@example.com', source: 'cloudflare', settings: settings() }))
      .toEqual({ error: 'user_disabled' });
  });

  it('refuses an unknown address on direct sign-in and an invalid address anywhere', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await resolveVerifiedUser({ email: 'new@example.com', source: 'google', settings: settings() }))
      .toEqual({ error: 'not_allowed' });
    expect(await resolveVerifiedUser({ email: 'not an email', source: 'cloudflare', settings: settings() }))
      .toEqual({ error: 'not_allowed' });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('creates an account for a new Cloudflare Access identity', async () => {
    query.mockResolvedValue({ rows: [] });
    const { client } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [] }],
      [/^\s*INSERT INTO users/, { rows: [{ ...USER, email: 'new@example.com' }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await resolveVerifiedUser({ email: 'new@example.com', source: 'cloudflare', settings: settings() }))
      .toEqual({ user: { ...USER, email: 'new@example.com' } });
  });

  it('creates and promotes a bootstrap admin on direct sign-in', async () => {
    query.mockResolvedValue({ rows: [USER] });
    const { client, calls } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [USER] }],
      [/^\s*UPDATE users SET is_admin = true/, { rows: [{ ...USER, is_admin: true }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await resolveVerifiedUser({ email: 'user@example.com', source: 'google', settings: settings(['user@example.com']) }))
      .toEqual({ user: { ...USER, is_admin: true } });
    expect(calls.at(-1)[1]).toEqual(['u1']);
  });

  it('refuses an address whose username is taken by another user', async () => {
    query.mockResolvedValue({ rows: [] });
    const { client } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/^\s*SELECT .* WHERE lower\(email\) = \$1/, { rows: [] }],
      [/^\s*UPDATE users SET email = \$1/, { rows: [] }],
      [/^\s*INSERT INTO users/, () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await resolveVerifiedUser({ email: 'new@example.com', source: 'cloudflare', settings: settings() }))
      .toEqual({ error: 'not_allowed' });
  });
});

describe('bindSessionUser', () => {
  const session = (data) => {
    const s = { ...data };
    s.regenerate = vi.fn((cb) => {
      for (const key of Object.keys(s)) if (typeof s[key] !== 'function') delete s[key];
      cb();
    });
    return s;
  };

  it('keeps the session id for the same user and method', async () => {
    const req = { session: session({ userId: 'u1', authMethod: 'cloudflare' }) };
    await bindSessionUser(req, USER, 'cloudflare');
    expect(req.session.regenerate).not.toHaveBeenCalled();
    expect(req.session).toMatchObject({ userId: 'u1', username: 'user@example.com', isAdmin: false, authMethod: 'cloudflare' });
  });

  it('starts a new session for another user or method', async () => {
    const req = { session: session({ userId: 'u2', authMethod: 'google', locked: true }) };
    await bindSessionUser(req, USER, 'google');
    expect(req.session.regenerate).toHaveBeenCalledOnce();
    expect(req.session.locked).toBeUndefined();
    expect(req.session).toMatchObject({ userId: 'u1', authMethod: 'google' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bt src/services/auth/userIdentity.test.js`
Expected: FAIL — `Failed to resolve import "./userIdentity.js"`.

- [ ] **Step 4: Implement**

`backend/src/services/auth/userIdentity.js`:

```js
import { query, withTransaction } from '../db.js';

export const USER_COLUMNS = 'id, username, email, is_admin, disabled_at, created_at';
export const SESSION_AUTH_METHODS = new Set(['cloudflare', 'google']);

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export class UserIdentityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'UserIdentityError';
    this.code = code;
  }
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

export async function loadUserById(userId) {
  if (typeof userId !== 'string' || !userId) return null;
  const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  return rows[0] || null;
}

// `email` must already be normalized.
export async function findUserByEmail(email, db = { query }) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1`, [email]);
  return rows[0] || null;
}

// The user approved under this address: the row that already has it, else the oldest legacy
// row whose username is the address and whose email is empty, else a new passwordless row.
// Runs inside the caller's transaction, serialized per address.
export async function claimOrCreateUserByEmail(client, email, { isAdmin = false } = {}) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user-email:${email}`]);

  const existing = await findUserByEmail(email, client);
  if (existing) return { user: existing, created: false, claimed: false };

  const claimed = await client.query(
    `UPDATE users SET email = $1
      WHERE id = (SELECT id FROM users WHERE email IS NULL AND lower(username) = $1 ORDER BY created_at LIMIT 1)
      RETURNING ${USER_COLUMNS}`,
    [email],
  );
  if (claimed.rows[0]) return { user: claimed.rows[0], created: false, claimed: true };

  try {
    const inserted = await client.query(
      `INSERT INTO users (username, email, is_admin) VALUES ($1, $1, $2) RETURNING ${USER_COLUMNS}`,
      [email, isAdmin],
    );
    return { user: inserted.rows[0], created: true, claimed: false };
  } catch (err) {
    // Another user has this address as username and a different email.
    if (err?.code === '23505') throw new UserIdentityError('username_taken');
    throw err;
  }
}

// The account a verified identity signs in as, or { error }. A Cloudflare Access identity is
// already approved by the Access policy and gets an account on first sign-in; a direct Google
// sign-in needs an approved user, except for bootstrap admins. Bootstrap admins become admins
// on every sign-in.
export async function resolveVerifiedUser({ email, source, settings }) {
  const address = normalizeEmail(email);
  if (!address) return { error: 'not_allowed' };
  const bootstrap = settings.bootstrapAdminEmails.has(address);

  // Every Cloudflare request lands here, so the common case is a single read.
  const known = await findUserByEmail(address);
  if (known?.disabled_at) return { error: 'user_disabled' };
  if (known && (!bootstrap || known.is_admin)) return { user: known };
  if (!known && source !== 'cloudflare' && !bootstrap) return { error: 'not_allowed' };

  try {
    return await withTransaction(async (client) => {
      let { user } = await claimOrCreateUserByEmail(client, address, { isAdmin: bootstrap });
      if (user.disabled_at) return { error: 'user_disabled' };
      if (bootstrap && !user.is_admin) {
        ({ rows: [user] } = await client.query(
          `UPDATE users SET is_admin = true WHERE id = $1 RETURNING ${USER_COLUMNS}`,
          [user.id],
        ));
      }
      return { user };
    });
  } catch (err) {
    if (err instanceof UserIdentityError) return { error: 'not_allowed' };
    throw err;
  }
}

// Put a signed-in user into the session. Another user or sign-in method gets a fresh session
// id first, so one session never carries two identities.
export async function bindSessionUser(req, user, authMethod) {
  if (req.session.userId !== user.id || req.session.authMethod !== authMethod) {
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;
  req.session.authMethod = authMethod;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bt src/services/auth/userIdentity.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/0054_users_email_status.sql backend/src/services/auth/userIdentity.js backend/src/services/auth/userIdentity.test.js
git commit -m "feat(auth): identify users by a verified email and track disabled users"
```

---

### Task 4: Проверка JWT Cloudflare Access

**Files:**
- Create: `backend/src/services/auth/cloudflareAccess.js`
- Create: `backend/src/services/auth/cloudflareAccess.test.js`

**Interfaces:**
- Produces:
  - `CF_ACCESS_HEADER = 'cf-access-jwt-assertion'`;
  - `createResilientJwks({ fetchJwks, now = Date.now, cacheMaxAgeMs = 600000, staleMaxAgeMs = 86400000 }): JWTVerifyGetKey`;
  - `verifyCloudflareAccessToken(token, { issuer, audience }, { jwks } = {}): Promise<string | null>` — email в нижнем регистре или null, никогда не бросает.

- [ ] **Step 1: Write the failing test**

`backend/src/services/auth/cloudflareAccess.test.js`:

```js
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createResilientJwks, verifyCloudflareAccessToken } from './cloudflareAccess.js';

const ISSUER = 'https://team.cloudflareaccess.com';
const AUDIENCE = 'aud-tag';
const CONFIG = { issuer: ISSUER, audience: AUDIENCE };

let signingKey;
let foreignKey;
let jwksDocument;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  jwksDocument = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  foreignKey = (await generateKeyPair('RS256')).privateKey;
});

const sign = ({ claims = { email: 'User@Example.com' }, key = signingKey, iss = ISSUER, aud = AUDIENCE, exp = '5m' } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);

describe('verifyCloudflareAccessToken', () => {
  const local = () => ({ jwks: createLocalJWKSet(jwksDocument) });

  it('returns the lower-cased email of a valid token', async () => {
    expect(await verifyCloudflareAccessToken(await sign(), CONFIG, local())).toBe('user@example.com');
  });

  it('rejects another audience, another issuer, a foreign key and an expired token', async () => {
    expect(await verifyCloudflareAccessToken(await sign({ aud: 'other' }), CONFIG, local())).toBeNull();
    expect(await verifyCloudflareAccessToken(await sign({ iss: 'https://other.cloudflareaccess.com' }), CONFIG, local())).toBeNull();
    expect(await verifyCloudflareAccessToken(await sign({ key: foreignKey }), CONFIG, local())).toBeNull();
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(await verifyCloudflareAccessToken(await sign({ exp: past }), CONFIG, local())).toBeNull();
  });

  it('rejects a token without an email, garbage and a missing token', async () => {
    expect(await verifyCloudflareAccessToken(await sign({ claims: {} }), CONFIG, local())).toBeNull();
    expect(await verifyCloudflareAccessToken('not.a.jwt', CONFIG, local())).toBeNull();
    expect(await verifyCloudflareAccessToken(undefined, CONFIG, local())).toBeNull();
  });
});

describe('createResilientJwks', () => {
  it('caches the key set, refreshes it after max age and serves a stale copy while a refresh fails', async () => {
    let clock = 0;
    const fetchJwks = vi.fn(async () => jwksDocument);
    const jwks = createResilientJwks({ fetchJwks, now: () => clock, cacheMaxAgeMs: 1000, staleMaxAgeMs: 5000 });
    const token = await sign();

    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBe('user@example.com');
    clock = 500;
    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBe('user@example.com');
    expect(fetchJwks).toHaveBeenCalledTimes(1);

    clock = 2000;
    fetchJwks.mockRejectedValueOnce(new Error('certs unreachable'));
    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBe('user@example.com');
    expect(fetchJwks).toHaveBeenCalledTimes(2);

    clock = 10_000;
    fetchJwks.mockRejectedValueOnce(new Error('certs unreachable'));
    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBeNull();
  });

  it('shares one refresh between concurrent requests', async () => {
    let release;
    const fetchJwks = vi.fn(() => new Promise((resolve) => { release = () => resolve(jwksDocument); }));
    const jwks = createResilientJwks({ fetchJwks });
    const token = await sign();
    const pending = [
      verifyCloudflareAccessToken(token, CONFIG, { jwks }),
      verifyCloudflareAccessToken(token, CONFIG, { jwks }),
    ];
    await vi.waitFor(() => expect(fetchJwks).toHaveBeenCalledTimes(1));
    release();
    expect(await Promise.all(pending)).toEqual(['user@example.com', 'user@example.com']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/services/auth/cloudflareAccess.test.js`
Expected: FAIL — `Failed to resolve import "./cloudflareAccess.js"`.

- [ ] **Step 3: Implement**

`backend/src/services/auth/cloudflareAccess.js`:

```js
import { createLocalJWKSet, jwtVerify } from 'jose';

// Cloudflare Access puts a signed assertion of the signed-in identity on every request it
// lets through. It is trusted only after checking the signature, issuer and audience.
export const CF_ACCESS_HEADER = 'cf-access-jwt-assertion';

const CACHE_MAX_AGE_MS = 10 * 60_000;
const STALE_MAX_AGE_MS = 24 * 60 * 60_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;

// A key set that survives the Access certs endpoint being briefly unreachable: a failed
// refresh keeps serving the last good document until it is too old to trust. One refresh
// runs at a time, so a burst of requests at expiry makes a single fetch.
export function createResilientJwks({
  fetchJwks,
  now = () => Date.now(),
  cacheMaxAgeMs = CACHE_MAX_AGE_MS,
  staleMaxAgeMs = STALE_MAX_AGE_MS,
}) {
  let cached = null;
  let inFlight = null;

  const refresh = async () => {
    const document = await fetchJwks();
    cached = { getKey: createLocalJWKSet(document), fetchedAt: now() };
  };

  const ensureFresh = async () => {
    if (cached && now() - cached.fetchedAt <= cacheMaxAgeMs) return;
    inFlight ??= refresh().finally(() => { inFlight = null; });
    try {
      await inFlight;
    } catch (err) {
      if (cached && now() - cached.fetchedAt <= staleMaxAgeMs) return;
      throw err;
    }
  };

  return async (protectedHeader, token) => {
    await ensureFresh();
    return cached.getKey(protectedHeader, token);
  };
}

const fetchJwksOverHttp = (issuer) => async () => {
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Access certs request failed with status ${res.status}`);
  return res.json();
};

const jwksByIssuer = new Map();
function jwksFor(issuer) {
  if (!jwksByIssuer.has(issuer)) {
    jwksByIssuer.set(issuer, createResilientJwks({ fetchJwks: fetchJwksOverHttp(issuer) }));
  }
  return jwksByIssuer.get(issuer);
}

// The lower-cased email of a valid Access token, or null. Never throws: an absent or
// unverifiable token is simply not a way in.
export async function verifyCloudflareAccessToken(token, { issuer, audience }, { jwks } = {}) {
  if (typeof token !== 'string' || !token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks ?? jwksFor(issuer), {
      issuer,
      audience,
      algorithms: ['RS256'],
    });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    return email.includes('@') ? email : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bt src/services/auth/cloudflareAccess.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/auth/cloudflareAccess.js backend/src/services/auth/cloudflareAccess.test.js
git commit -m "feat(auth): verify Cloudflare Access assertions with a resilient key cache"
```

---
### Task 5: Проверка личности на каждом запросе

**Files:**
- Create: `backend/src/middleware/identityGate.js`
- Create: `backend/src/middleware/identityGate.test.js`
- Modify: `backend/src/middleware/auth.js`
- Create: `backend/src/middleware/auth.test.js`
- Modify: `backend/src/routes/ai.test.js:96,99` (его мок базы узнаёт SQL `requireAuth`/`requireAdmin` по тексту)
- Modify: `backend/src/index.js:150`

**Interfaces:**
- Consumes: `getAuthSettings()` (Task 2); `CF_ACCESS_HEADER`, `verifyCloudflareAccessToken(token, { issuer, audience })` (Task 4); `resolveVerifiedUser`, `loadUserById`, `bindSessionUser` (Task 3).
- Produces: `isLocalOnlyPath(path): boolean`; `createIdentityGate({ getSettings, verifyToken, resolveUser, loadUser } = {})`; `identityGate` (middleware). Ответы: 401 `{ error: 'not_authenticated', code: 'not_authenticated' }`, 403 `{ error, code }` с `user_disabled` или `not_allowed`, 404 `{ error: 'Not found' }`. `requireAuth` и `requireAdmin` отвечают 403 `{ error: 'user_disabled', code: 'user_disabled' }` отключённому пользователю.

- [ ] **Step 1: Write the failing tests**

`backend/src/middleware/identityGate.test.js`:

```js
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

import express from 'express';
import { createIdentityGate, isLocalOnlyPath } from './identityGate.js';

const GOOGLE = {
  mode: 'google',
  cloudflare: { issuer: 'https://team.cloudflareaccess.com', audience: 'aud' },
  googleSignIn: { clientId: 'client-id', clientSecret: 'client-secret' },
  bootstrapAdminEmails: new Set(),
};
const USER = { id: 'u1', username: 'user@example.com', email: 'user@example.com', is_admin: false, disabled_at: null };

// Sessions persist between requests by the x-test-session header and mimic express-session.
const sessions = new Map();
function sessionFor(id) {
  if (!sessions.has(id)) {
    const session = {};
    const clear = () => {
      for (const key of Object.keys(session)) if (typeof session[key] !== 'function') delete session[key];
    };
    session.regenerate = vi.fn((cb) => { clear(); cb(); });
    session.destroy = vi.fn((cb) => { clear(); cb?.(); });
    sessions.set(id, session);
  }
  return sessions.get(id);
}

let state;
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = sessionFor(req.get('x-test-session') || 'default');
    next();
  });
  app.use(['/api', '/oauth', '/auth/oidc', '/carddav', '/.well-known/carddav'], createIdentityGate({
    getSettings: () => state.settings,
    verifyToken: (...args) => state.verifyToken(...args),
    resolveUser: (...args) => state.resolveUser(...args),
    loadUser: (...args) => state.loadUser(...args),
  }));
  app.use((req, res) => res.json({ userId: req.session.userId ?? null, authMethod: req.session.authMethod ?? null }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  sessions.clear();
  state = {
    settings: GOOGLE,
    verifyToken: vi.fn(async (token) => (token === 'good-token' ? 'user@example.com' : null)),
    resolveUser: vi.fn(async () => ({ user: USER })),
    loadUser: vi.fn(async () => USER),
  };
});

const call = (path, { session = 'default', token } = {}) => fetch(`${base}${path}`, {
  headers: { 'x-test-session': session, ...(token ? { 'cf-access-jwt-assertion': token } : {}) },
});

describe('isLocalOnlyPath', () => {
  it.each([
    '/api/auth/login', '/api/auth/register', '/api/auth/2fa/challenge', '/api/auth/forgot-password',
    '/api/auth/reset-password', '/api/auth/registration-status', '/api/auth/invite/abc',
    '/api/auth/profile/recovery-email', '/api/auth/oidc/providers', '/auth/oidc/corp/start', '/api/totp/setup',
    '/api/admin/invites', '/api/admin/invites/1', '/api/admin/oidc',
    '/api/admin/users/11111111-1111-1111-1111-111111111111/totp/disable', '/carddav/', '/.well-known/carddav',
  ])('marks %s', (path) => {
    expect(isLocalOnlyPath(path)).toBe(true);
  });

  it.each(['/api/auth/me', '/api/auth/logout', '/api/auth/lock', '/api/admin/users', '/api/auth/loginx'])('leaves %s', (path) => {
    expect(isLocalOnlyPath(path)).toBe(false);
  });
});

describe('identityGate', () => {
  it('does nothing in local mode', async () => {
    state.settings = { ...GOOGLE, mode: 'local' };
    expect((await call('/api/auth/login')).status).toBe(200);
    expect(state.verifyToken).not.toHaveBeenCalled();
  });

  it('hides local sign-in routes in google mode', async () => {
    for (const path of ['/api/auth/login', '/auth/oidc/corp/start', '/carddav/', '/.well-known/carddav']) {
      expect((await call(path, { token: 'good-token' })).status).toBe(404);
    }
    expect(state.resolveUser).not.toHaveBeenCalled();
  });

  it('lets public paths through without an identity', async () => {
    for (const path of ['/api/health', '/api/auth/config', '/api/auth/logout', '/oauth/login/google', '/oauth/login/google/callback?code=x']) {
      expect((await call(path)).status).toBe(200);
    }
  });

  it('asks for sign-in without a token or a session', async () => {
    const res = await call('/api/auth/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_authenticated', code: 'not_authenticated' });
  });

  it('signs a Cloudflare Access identity into the session once', async () => {
    const first = await call('/api/auth/me', { token: 'good-token' });
    expect(await first.json()).toEqual({ userId: 'u1', authMethod: 'cloudflare' });
    expect(state.verifyToken).toHaveBeenCalledWith('good-token', GOOGLE.cloudflare);
    expect(state.resolveUser).toHaveBeenCalledWith({ email: 'user@example.com', source: 'cloudflare', settings: GOOGLE });
    await call('/api/mail/messages', { token: 'good-token' });
    expect(sessionFor('default').regenerate).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid token even for a signed-in session', async () => {
    await call('/api/auth/me', { token: 'good-token' });
    expect((await call('/api/auth/me', { token: 'forged' })).status).toBe(401);
  });

  it('refuses and signs out an identity the user list refuses', async () => {
    await call('/api/auth/me', { token: 'good-token' });
    state.resolveUser.mockResolvedValue({ error: 'user_disabled' });
    const res = await call('/api/auth/me', { token: 'good-token' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'user_disabled', code: 'user_disabled' });
    expect(sessionFor('default').destroy).toHaveBeenCalled();
  });

  it('ignores the Access header when Cloudflare Access is not configured', async () => {
    state.settings = { ...GOOGLE, cloudflare: null };
    expect((await call('/api/auth/me', { token: 'good-token' })).status).toBe(401);
    expect(state.verifyToken).not.toHaveBeenCalled();
  });

  it('accepts a direct Google sign-in session while the user stays active', async () => {
    Object.assign(sessionFor('direct'), { userId: 'u1', authMethod: 'google' });
    expect(await (await call('/api/auth/me', { session: 'direct' })).json()).toEqual({ userId: 'u1', authMethod: 'google' });
    expect(state.loadUser).toHaveBeenCalledWith('u1');

    state.loadUser.mockResolvedValue({ ...USER, disabled_at: new Date().toISOString() });
    expect((await call('/api/auth/me', { session: 'direct' })).status).toBe(403);
    expect(sessionFor('direct').destroy).toHaveBeenCalled();
  });

  it('does not accept an email-less user, a Cloudflare session without its token or a local session', async () => {
    Object.assign(sessionFor('noemail'), { userId: 'u1', authMethod: 'google' });
    state.loadUser.mockResolvedValue({ ...USER, email: null });
    expect((await call('/api/auth/me', { session: 'noemail' })).status).toBe(401);

    Object.assign(sessionFor('edge'), { userId: 'u1', authMethod: 'cloudflare' });
    expect((await call('/api/auth/me', { session: 'edge' })).status).toBe(401);

    Object.assign(sessionFor('legacy'), { userId: 'u1' });
    expect((await call('/api/auth/me', { session: 'legacy' })).status).toBe(401);
  });

  it('passes lookup failures to the error handler', async () => {
    state.resolveUser.mockRejectedValue(new Error('database unavailable'));
    expect((await call('/api/auth/me', { token: 'good-token' })).status).toBe(500);
  });
});
```

`backend/src/middleware/auth.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));

const { query } = await import('../services/db.js');
const { requireAuth, requireAdmin } = await import('./auth.js');

async function run(middleware, session) {
  const req = { session: { ...session, destroy: vi.fn((cb) => cb?.()) } };
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const next = vi.fn();
  await middleware(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  query.mockReset();
});

describe('requireAuth', () => {
  it('asks for sign-in without a session user', async () => {
    const { res, next } = await run(requireAuth, {});
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets an active user through', async () => {
    query.mockResolvedValue({ rows: [{ id: 'u1', disabled_at: null }] });
    const { next } = await run(requireAuth, { userId: 'u1' });
    expect(next).toHaveBeenCalledWith();
    expect(query.mock.calls[0][0]).toMatch(/SELECT id, disabled_at FROM users WHERE id = \$1/);
  });

  it('ends the session of a deleted user', async () => {
    query.mockResolvedValue({ rows: [] });
    const { req, res } = await run(requireAuth, { userId: 'u1' });
    expect(res.statusCode).toBe(401);
    expect(req.session.destroy).toHaveBeenCalled();
  });

  it('refuses and signs out a disabled user', async () => {
    query.mockResolvedValue({ rows: [{ id: 'u1', disabled_at: new Date() }] });
    const { req, res, next } = await run(requireAuth, { userId: 'u1' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'user_disabled', code: 'user_disabled' });
    expect(req.session.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireAdmin', () => {
  it('refuses a disabled admin and a non-admin and lets an active admin through', async () => {
    query.mockResolvedValue({ rows: [{ is_admin: true, disabled_at: new Date() }] });
    expect((await run(requireAdmin, { userId: 'u1' })).res.body).toEqual({ error: 'user_disabled', code: 'user_disabled' });

    query.mockResolvedValue({ rows: [{ is_admin: false, disabled_at: null }] });
    expect((await run(requireAdmin, { userId: 'u1' })).res.body).toEqual({ error: 'Admin access required' });

    query.mockResolvedValue({ rows: [{ is_admin: true, disabled_at: null }] });
    expect((await run(requireAdmin, { userId: 'u1' })).next).toHaveBeenCalledWith();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bt src/middleware/identityGate.test.js src/middleware/auth.test.js`
Expected: FAIL — `Failed to resolve import "./identityGate.js"`; в `auth.test.js` отключённый пользователь проходит (`next` вызван).

- [ ] **Step 3: Implement**

`backend/src/middleware/identityGate.js`:

```js
import { getAuthSettings } from '../services/auth/authSettings.js';
import { CF_ACCESS_HEADER, verifyCloudflareAccessToken } from '../services/auth/cloudflareAccess.js';
import { bindSessionUser, loadUserById, resolveVerifiedUser } from '../services/auth/userIdentity.js';

// Reachable without a signed-in user in google mode.
const PUBLIC_PATHS = new Set([
  '/api/health', '/api/version', '/api/update', '/api/auth/config', '/api/auth/logout',
  '/oauth/login/google', '/oauth/login/google/callback',
]);

// Local sign-in surfaces that do not exist in google mode.
const LOCAL_ONLY_PREFIXES = [
  '/api/auth/register', '/api/auth/login', '/api/auth/2fa', '/api/auth/forgot-password',
  '/api/auth/reset-password', '/api/auth/registration-status', '/api/auth/invite',
  '/api/auth/profile/recovery-email', '/api/auth/oidc', '/auth/oidc', '/api/totp',
  '/api/admin/invites', '/api/admin/oidc', '/carddav', '/.well-known/carddav',
];
const LOCAL_ONLY_PATTERNS = [/^\/api\/admin\/users\/[^/]+\/totp\/disable$/];

export function isLocalOnlyPath(path) {
  return LOCAL_ONLY_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    || LOCAL_ONLY_PATTERNS.some((pattern) => pattern.test(path));
}

function deny(req, res, status, code) {
  // A refused identity must not keep the session it may already hold.
  if (status === 403 && req.session?.userId) req.session.destroy(() => {});
  return res.status(status).json({ error: code, code });
}

// In google mode every request needs an approved, active user: a verified Cloudflare Access
// token, or a session opened by direct Google sign-in. The user row is read on every
// request, so turning a user off takes effect at once.
export function createIdentityGate({
  getSettings = getAuthSettings,
  verifyToken = verifyCloudflareAccessToken,
  resolveUser = resolveVerifiedUser,
  loadUser = loadUserById,
} = {}) {
  return async function identityGate(req, res, next) {
    const settings = getSettings();
    if (settings.mode !== 'google') return next();

    const path = req.originalUrl.split('?')[0];
    if (isLocalOnlyPath(path)) return res.status(404).json({ error: 'Not found' });
    if (PUBLIC_PATHS.has(path)) return next();

    try {
      const token = settings.cloudflare ? req.get(CF_ACCESS_HEADER) : undefined;
      if (token) {
        const email = await verifyToken(token, settings.cloudflare);
        if (!email) return deny(req, res, 401, 'not_authenticated');
        const result = await resolveUser({ email, source: 'cloudflare', settings });
        if (result.error) return deny(req, res, 403, result.error);
        await bindSessionUser(req, result.user, 'cloudflare');
        return next();
      }

      // Without an Access token only a direct sign-in session counts: a session opened
      // through Cloudflare must keep arriving through Cloudflare.
      if (!req.session?.userId || req.session.authMethod !== 'google') {
        return deny(req, res, 401, 'not_authenticated');
      }
      const user = await loadUser(req.session.userId);
      if (!user || !user.email) return deny(req, res, 401, 'not_authenticated');
      if (user.disabled_at) return deny(req, res, 403, 'user_disabled');
      req.session.isAdmin = user.is_admin;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export const identityGate = createIdentityGate();
```

`backend/src/middleware/auth.js` заменить целиком:

```js
import { query } from '../services/db.js';

// A disabled user loses access at the next request, whatever session they still hold.
function refuseDisabled(req, res) {
  req.session.destroy(() => {});
  return res.status(403).json({ error: 'user_disabled', code: 'user_disabled' });
}

export async function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query('SELECT id, disabled_at FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows.length) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (result.rows[0].disabled_at) return refuseDisabled(req, res);
    next();
  } catch (err) {
    next(err);
  }
}

// Always verifies against the DB so a revoked or disabled admin can't keep using
// a stale session. The extra query is cheap and only hits admin routes.
export async function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query(
      'SELECT is_admin, disabled_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = result.rows[0];
    if (user?.disabled_at) return refuseDisabled(req, res);
    if (!user?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    next(err);
  }
}
```

В `backend/src/routes/ai.test.js` строку

```js
    if (/SELECT is_admin FROM users/i.test(sql)) {
```

заменить на:

```js
    if (/SELECT is_admin, disabled_at FROM users/i.test(sql)) {
```

и строку

```js
    if (/SELECT id FROM users/i.test(sql)) return { rows: params[0] ? [{ id: params[0] }] : [] };
```

на:

```js
    if (/SELECT id, disabled_at FROM users/i.test(sql)) return { rows: params[0] ? [{ id: params[0], disabled_at: null }] : [] };
```

В `backend/src/index.js` после строки с `import { authSettingsError } ...` (Task 2) добавить:

```js
import { identityGate } from './middleware/identityGate.js';
```

и сразу после `app.use(sessionMiddleware);`:

```js

// Google sign-in mode: every request to these surfaces needs an approved, active user (a
// Cloudflare Access token or a direct Google sign-in session); local sign-in routes are 404.
app.use(['/api', '/oauth', '/auth/oidc', '/carddav', '/.well-known/carddav'], identityGate);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bt src/middleware/identityGate.test.js src/middleware/auth.test.js src/routes/ai.test.js src/plugins/gtd/routes.mount.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/middleware/identityGate.js backend/src/middleware/identityGate.test.js backend/src/middleware/auth.js backend/src/middleware/auth.test.js backend/src/routes/ai.test.js backend/src/index.js
git commit -m "feat(auth): require an approved active user on every request in Google sign-in mode"
```

---

### Task 6: Прямой вход через Google

**Files:**
- Modify: `backend/src/services/oauth/oauthState.js`
- Modify: `backend/src/services/oauth/oauthState.test.js`
- Modify: `backend/src/services/oauth/googleOAuth.js:12,53`
- Modify: `backend/src/services/oauth/googleOAuth.test.js`
- Create: `backend/src/routes/authGoogle.js`
- Create: `backend/src/routes/authGoogle.test.js`
- Modify: `backend/src/index.js:189`

**Interfaces:**
- Consumes: `getAuthSettings()` (Task 2); `resolveVerifiedUser`, `bindSessionUser` (Task 3); `allowedRequestOrigin(req)` (Task 1); `exchangeGoogleCode`, `verifyGoogleIdToken` (существуют).
- Produces:
  - `createOAuthState({ provider, userId = null, loginHint = null, appId = null })`; `consumeOAuthState({ provider, state, anonymous = false })` → `{ userId: string | null, codeVerifier, loginHint, appId } | null`;
  - `GOOGLE_SIGN_IN_SCOPES = 'openid email'`; `buildGoogleSignInUrl({ clientId, state, codeChallenge, redirectUri }): string`;
  - роутер `/oauth/login/google` (`GET /`, `GET /callback`); `SIGN_IN_CALLBACK_PATH = '/oauth/login/google/callback'`; сессия получает `authMethod: 'google'`; коды `/login?auth_error=`: `access_denied`, `invalid_state`, `not_configured`, `email_not_verified`, `not_allowed`, `user_disabled`, `authentication_failed`.

- [ ] **Step 1: Write the failing tests**

В `backend/src/services/oauth/oauthState.test.js` перед последней закрывающей `});` добавить:

```js
  it('keeps a sign-in state without a user only for an anonymous consumer', async () => {
    const first = await createOAuthState({ provider: 'auth-google' });
    expect(await consumeOAuthState({ provider: 'auth-google', state: first.state })).toBeNull();

    const second = await createOAuthState({ provider: 'auth-google' });
    expect(await consumeOAuthState({ provider: 'auth-google', state: second.state, anonymous: true }))
      .toEqual({ userId: null, codeVerifier: expect.any(String), loginHint: null, appId: null });
  });
```

В `backend/src/services/oauth/googleOAuth.test.js` в список импорта из `./googleOAuth.js` добавить `buildGoogleSignInUrl,` и `GOOGLE_AUTH_URL,`, а в конец файла:

```js
describe('buildGoogleSignInUrl', () => {
  it('asks only for the identity, with PKCE and an account picker', () => {
    const url = new URL(buildGoogleSignInUrl({
      clientId: 'client-id', state: 'st', codeChallenge: 'ch',
      redirectUri: 'https://direct.example.com/oauth/login/google/callback',
    }));
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-id',
      redirect_uri: 'https://direct.example.com/oauth/login/google/callback',
      response_type: 'code',
      scope: 'openid email',
      prompt: 'select_account',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      state: 'st',
    });
  });
});
```

`backend/src/routes/authGoogle.test.js`:

```js
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
const identity = vi.hoisted(() => ({ result: null }));
vi.mock('../services/auth/userIdentity.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveVerifiedUser: vi.fn(async () => identity.result),
}));
// In-memory Redis so the real single-use state store runs end to end.
const redisStore = vi.hoisted(() => new Map());
vi.mock('../services/redis.js', () => ({
  redisClient: {
    set: vi.fn(async (key, value) => { redisStore.set(key, value); return 'OK'; }),
    getDel: vi.fn(async (key) => {
      const value = redisStore.get(key) ?? null;
      redisStore.delete(key);
      return value;
    }),
  },
}));
vi.mock('../services/oauth/googleOAuth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  exchangeGoogleCode: vi.fn(),
  verifyGoogleIdToken: vi.fn(),
}));

import express from 'express';
import authGoogleRoutes from './authGoogle.js';
import { logAuthEvent } from '../services/authEvents.js';
import { resolveVerifiedUser } from '../services/auth/userIdentity.js';
import { GoogleOAuthError, exchangeGoogleCode, verifyGoogleIdToken } from '../services/oauth/googleOAuth.js';

const USER = { id: 'u1', username: 'user@example.com', email: 'user@example.com', is_admin: false, disabled_at: null };

const sessions = new Map();
function sessionFor(id) {
  if (!sessions.has(id)) {
    const session = {};
    const clear = () => {
      for (const key of Object.keys(session)) if (typeof session[key] !== 'function') delete session[key];
    };
    session.regenerate = vi.fn((cb) => { clear(); cb(); });
    session.destroy = vi.fn((cb) => { clear(); cb?.(); });
    sessions.set(id, session);
  }
  return sessions.get(id);
}

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = sessionFor(req.get('x-test-session') || 'browser');
    next();
  });
  app.use('/oauth/login/google', authGoogleRoutes);
  app.get('/whoami', (req, res) => res.json({ userId: req.session.userId ?? null, authMethod: req.session.authMethod ?? null }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  sessions.clear();
  redisStore.clear();
  vi.stubEnv('AUTH_MODE', 'google');
  vi.stubEnv('AUTH_GOOGLE_CLIENT_ID', 'client-id');
  vi.stubEnv('AUTH_GOOGLE_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('APP_URL', base);
  vi.stubEnv('APP_ALT_URLS', '');
  identity.result = { user: USER };
  exchangeGoogleCode.mockReset().mockResolvedValue({ accessToken: 'access', idToken: 'id-token', scope: 'openid email' });
  verifyGoogleIdToken.mockReset().mockResolvedValue({ email: 'User@Example.com', sub: 'sub-1', name: null });
  resolveVerifiedUser.mockClear();
  logAuthEvent.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const get = (path, session = 'browser') =>
  fetch(`${base}${path}`, { redirect: 'manual', headers: { 'x-test-session': session } });

async function start(session = 'browser') {
  const res = await get('/oauth/login/google', session);
  const location = new URL(res.headers.get('location'));
  return { res, location, state: location.searchParams.get('state') };
}

describe('GET /oauth/login/google', () => {
  it('is not found outside google mode or without a sign-in client', async () => {
    vi.stubEnv('AUTH_MODE', 'local');
    expect((await get('/oauth/login/google')).status).toBe(404);
    vi.stubEnv('AUTH_MODE', 'google');
    vi.stubEnv('AUTH_GOOGLE_CLIENT_SECRET', '');
    expect((await get('/oauth/login/google/callback?state=x&code=y')).status).toBe(404);
  });

  it('sends the browser to Google for its identity and binds the flow to the session', async () => {
    const { res, location, state } = await start();
    expect(res.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('scope')).toBe('openid email');
    expect(location.searchParams.get('redirect_uri')).toBe(`${base}/oauth/login/google/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('access_type')).toBeNull();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionFor('browser').googleSignInState).toBe(createHash('sha256').update(state).digest('hex'));
  });

  it('refuses a host that is not a public origin', async () => {
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    expect((await get('/oauth/login/google')).headers.get('location')).toBe('/login?auth_error=not_configured');
  });
});

describe('GET /oauth/login/google/callback', () => {
  it('signs the approved user in', async () => {
    const { location, state } = await start();
    const res = await get(`/oauth/login/google/callback?state=${state}&code=auth-code-xyz`);
    expect(res.headers.get('location')).toBe('/');

    const { codeVerifier } = exchangeGoogleCode.mock.calls[0][0];
    expect(createHash('sha256').update(codeVerifier).digest('base64url')).toBe(location.searchParams.get('code_challenge'));
    expect(exchangeGoogleCode).toHaveBeenCalledWith({
      clientId: 'client-id', clientSecret: 'client-secret', code: 'auth-code-xyz',
      codeVerifier, redirectUri: `${base}/oauth/login/google/callback`,
    });
    expect(verifyGoogleIdToken).toHaveBeenCalledWith({ idToken: 'id-token', clientId: 'client-id' });
    expect(resolveVerifiedUser).toHaveBeenCalledWith({
      email: 'User@Example.com', source: 'google', settings: expect.objectContaining({ mode: 'google' }),
    });
    expect(await (await get('/whoami')).json()).toEqual({ userId: 'u1', authMethod: 'google' });
    expect(sessionFor('browser').googleSignInState).toBeUndefined();
    expect(logAuthEvent).toHaveBeenCalledWith('sso_login', expect.objectContaining({ userId: 'u1', success: true }));
  });

  it('refuses a callback finished in another browser and a replayed state', async () => {
    const { state } = await start('browser');
    expect((await get(`/oauth/login/google/callback?state=${state}&code=c`, 'other')).headers.get('location'))
      .toBe('/login?auth_error=invalid_state');
    expect((await get(`/oauth/login/google/callback?state=${state}&code=c`, 'browser')).headers.get('location'))
      .toBe('/login?auth_error=invalid_state');
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
  });

  it('reports a cancelled consent', async () => {
    const { state } = await start();
    expect((await get(`/oauth/login/google/callback?state=${state}&error=access_denied`)).headers.get('location'))
      .toBe('/login?auth_error=access_denied');
  });

  it('does not sign in an address the user list refuses', async () => {
    identity.result = { error: 'not_allowed' };
    const { state } = await start();
    expect((await get(`/oauth/login/google/callback?state=${state}&code=c`)).headers.get('location'))
      .toBe('/login?auth_error=not_allowed');
    expect(await (await get('/whoami')).json()).toEqual({ userId: null, authMethod: null });
  });

  it('keeps Google verification codes and hides every other failure behind a generic code', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    verifyGoogleIdToken.mockRejectedValueOnce(new GoogleOAuthError('email_not_verified'));
    let { state } = await start();
    expect((await get(`/oauth/login/google/callback?state=${state}&code=secret-code-1`)).headers.get('location'))
      .toBe('/login?auth_error=email_not_verified');

    exchangeGoogleCode.mockRejectedValueOnce(new Error('token endpoint rejected secret-code-2'));
    ({ state } = await start());
    expect((await get(`/oauth/login/google/callback?state=${state}&code=secret-code-2`)).headers.get('location'))
      .toBe('/login?auth_error=authentication_failed');
    expect(error.mock.calls.flat().join(' ')).not.toMatch(/secret-code/);
    error.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bt src/services/oauth/oauthState.test.js src/services/oauth/googleOAuth.test.js src/routes/authGoogle.test.js`
Expected: FAIL — анонимный state отклоняется, `buildGoogleSignInUrl is not a function`, `Failed to resolve import "./authGoogle.js"`.

- [ ] **Step 3: Implement**

В `backend/src/services/oauth/oauthState.js` заменить строки 16–50:

```js
// Create a single-use state plus a PKCE S256 pair. The verifier stays in Redis; only
// the state and the challenge leave the server. `appId` pins the Google app whose client
// must finish the flow; a sign-in flow has no user yet.
export async function createOAuthState({ provider, userId = null, loginHint = null, appId = null }) {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  await redisClient.set(
    stateKey(provider, state),
    JSON.stringify({ userId: userId || null, codeVerifier, loginHint: loginHint || null, appId: appId || null }),
    { NX: true, EX: OAUTH_STATE_TTL_SECONDS },
  );
  return { state, codeChallenge };
}

// Atomically fetch and delete the pending flow. Returns null for missing, malformed,
// expired or already used states, and for a state without a user unless the consumer is
// a sign-in flow (`anonymous`).
export async function consumeOAuthState({ provider, state, anonymous = false }) {
  if (typeof state !== 'string' || !STATE_PATTERN.test(state)) return null;
  const raw = await redisClient.getDel(stateKey(provider, state));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data.codeVerifier !== 'string') return null;
    const userId = typeof data.userId === 'string' ? data.userId : null;
    if (!userId && !anonymous) return null;
    return {
      userId,
      codeVerifier: data.codeVerifier,
      loginHint: data.loginHint || null,
      appId: typeof data.appId === 'string' ? data.appId : null,
    };
  } catch {
    return null;
  }
}
```

В `backend/src/services/oauth/googleOAuth.js` после строки 12 (`export const GOOGLE_SCOPES = ...`) добавить:

```js
export const GOOGLE_SIGN_IN_SCOPES = 'openid email';
```

и после функции `buildGoogleAuthorizationUrl` (после строки 53):

```js

// Sign-in to MailExpert itself: only the identity, no mailbox access and no refresh token.
export function buildGoogleSignInUrl({ clientId, state, codeChallenge, redirectUri }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SIGN_IN_SCOPES,
    prompt: 'select_account',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}
```

`backend/src/routes/authGoogle.js`:

```js
import { createHash } from 'crypto';
import { Router } from 'express';
import { getAuthSettings } from '../services/auth/authSettings.js';
import { bindSessionUser, resolveVerifiedUser } from '../services/auth/userIdentity.js';
import { logAuthEvent } from '../services/authEvents.js';
import { buildGoogleSignInUrl, exchangeGoogleCode, verifyGoogleIdToken } from '../services/oauth/googleOAuth.js';
import { consumeOAuthState, createOAuthState } from '../services/oauth/oauthState.js';
import { allowedRequestOrigin } from '../utils/publicOrigins.js';

// Mounted at /oauth/login/google: sign-in to MailExpert itself with Google, for a host that
// is not behind Cloudflare Access. Redirects carry stable codes only — never provider error
// text, authorization codes or tokens.
const router = Router();

const PROVIDER = 'auth-google';
export const SIGN_IN_CALLBACK_PATH = '/oauth/login/google/callback';
const SIGN_IN_ERROR_CODES = new Set([
  'access_denied', 'invalid_state', 'not_configured', 'email_not_verified',
  'not_allowed', 'user_disabled', 'authentication_failed',
]);

class SignInError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SignInError';
    this.code = code;
  }
}

const stateDigest = (state) => createHash('sha256').update(String(state)).digest('hex');
const loginError = (code) => `/login?auth_error=${code}`;

function signInSettings() {
  const settings = getAuthSettings();
  return settings.mode === 'google' && settings.googleSignIn ? settings : null;
}

router.get('/', async (req, res) => {
  const settings = signInSettings();
  if (!settings) return res.status(404).json({ error: 'Not found' });
  const origin = allowedRequestOrigin(req);
  if (!origin) return res.redirect(loginError('not_configured'));

  try {
    const { state, codeChallenge } = await createOAuthState({ provider: PROVIDER });
    // Bind the flow to this browser, so a callback link from someone else cannot sign it in.
    req.session.googleSignInState = stateDigest(state);
    res.redirect(buildGoogleSignInUrl({
      clientId: settings.googleSignIn.clientId,
      state,
      codeChallenge,
      redirectUri: `${origin}${SIGN_IN_CALLBACK_PATH}`,
    }));
  } catch (err) {
    console.error(`Google sign-in start failed: ${err?.name || 'Error'}`);
    res.redirect(loginError('authentication_failed'));
  }
});

router.get('/callback', async (req, res) => {
  const settings = signInSettings();
  if (!settings) return res.status(404).json({ error: 'Not found' });
  const { code, state, error } = req.query;

  try {
    // Consume first so a state is burned whatever the outcome.
    const pending = await consumeOAuthState({ provider: PROVIDER, state, anonymous: true });
    const expected = req.session.googleSignInState;
    delete req.session.googleSignInState;

    if (error !== undefined) {
      throw new SignInError(error === 'access_denied' ? 'access_denied' : 'authentication_failed');
    }
    if (!pending || !expected || expected !== stateDigest(state)) throw new SignInError('invalid_state');
    const origin = allowedRequestOrigin(req);
    if (!origin) throw new SignInError('not_configured');
    if (typeof code !== 'string' || !code) throw new SignInError('authentication_failed');

    const { clientId, clientSecret } = settings.googleSignIn;
    const tokens = await exchangeGoogleCode({
      clientId,
      clientSecret,
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: `${origin}${SIGN_IN_CALLBACK_PATH}`,
    });
    const identity = await verifyGoogleIdToken({ idToken: tokens.idToken, clientId });
    const result = await resolveVerifiedUser({ email: identity.email, source: 'google', settings });
    if (result.error) throw new SignInError(result.error);

    await bindSessionUser(req, result.user, 'google');
    logAuthEvent('sso_login', { username: result.user.username, userId: result.user.id, ip: req.ip, success: true });
    res.redirect('/');
  } catch (err) {
    const stable = SIGN_IN_ERROR_CODES.has(err?.code) ? err.code : 'authentication_failed';
    // Log the stable code and error class only; messages may carry provider details.
    console.error(`Google sign-in failed: ${stable} (${err?.name || 'Error'})`);
    res.redirect(loginError(stable));
  }
});

export default router;
```

В `backend/src/index.js` после `import oauthRoutes from './routes/oauth.js';` добавить:

```js
import authGoogleRoutes from './routes/authGoogle.js';
```

и строку `app.use('/oauth', oauthRoutes);` заменить на:

```js
app.use('/oauth/login/google', authGoogleRoutes);
app.use('/oauth', oauthRoutes);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bt src/services/oauth/oauthState.test.js src/services/oauth/googleOAuth.test.js src/routes/authGoogle.test.js src/routes/oauth.google.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/oauth/oauthState.js backend/src/services/oauth/oauthState.test.js backend/src/services/oauth/googleOAuth.js backend/src/services/oauth/googleOAuth.test.js backend/src/routes/authGoogle.js backend/src/routes/authGoogle.test.js backend/src/index.js
git commit -m "feat(auth): sign in approved users with Google on a host without Cloudflare"
```

---

### Task 7: Конфигурация входа, `/me`, выход и сброс пароля

**Files:**
- Modify: `backend/src/routes/auth.js`
- Create: `backend/src/routes/auth.config.test.js`

**Interfaces:**
- Consumes: `getAuthSettings()` (Task 2), `CF_ACCESS_HEADER` (Task 4).
- Produces: `GET /api/auth/config` → `{ mode, cloudflare: boolean, googleSignIn: boolean }`; `GET /api/auth/me` → `user` дополнительно содержит `email` и `authMode`; `POST /api/auth/logout` в режиме `google` → `endSessionUrl: '/cdn-cgi/access/logout'` для запроса через Cloudflare, иначе `null`.

- [ ] **Step 1: Write the failing test**

`backend/src/routes/auth.config.test.js`:

```js
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({
  imapManager: {
    connectAllForUser: vi.fn(),
    disconnectUser: vi.fn(),
    updateSyncIntervalForUser: vi.fn(),
    updateFolderSyncIntervalForUser: vi.fn(),
  },
}));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, encrypt: (v) => v }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 10, windowMs: 900000 } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../services/redis.js', () => ({ redisClient: { scan: vi.fn(), get: vi.fn(), del: vi.fn() } }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(async () => ({ limited: false, resetMs: 0 })),
  reset: vi.fn(),
}));

import express from 'express';
import authRoutes from './auth.js';
import { query } from '../services/db.js';
import { buildEndSessionUrl } from './oidc.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    req.session = { ...(userId ? { userId } : {}), destroy: (cb) => cb() };
    next();
  });
  app.use('/api/auth', authRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  buildEndSessionUrl.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const cloudflareEnv = () => {
  vi.stubEnv('AUTH_MODE', 'google');
  vi.stubEnv('CF_ACCESS_ISSUER', 'https://team.cloudflareaccess.com');
  vi.stubEnv('CF_ACCESS_AUDIENCE', 'aud-tag');
};

describe('GET /api/auth/config', () => {
  it('describes local mode', async () => {
    expect(await (await fetch(`${base}/api/auth/config`)).json())
      .toEqual({ mode: 'local', cloudflare: false, googleSignIn: false });
  });

  it('describes google mode without exposing its settings', async () => {
    cloudflareEnv();
    vi.stubEnv('AUTH_GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('AUTH_GOOGLE_CLIENT_SECRET', 'client-secret');
    expect(await (await fetch(`${base}/api/auth/config`)).json())
      .toEqual({ mode: 'google', cloudflare: true, googleSignIn: true });
  });
});

describe('GET /api/auth/me', () => {
  it('returns the email and the sign-in mode', async () => {
    vi.stubEnv('AUTH_MODE', 'google');
    query.mockResolvedValue({ rows: [{
      id: 'u1', username: 'user@example.com', email: 'user@example.com', display_name: null, avatar: null,
      is_admin: false, totp_enabled: false, password_hash: null, lock_pin_hash: null,
    }] });
    const body = await (await fetch(`${base}/api/auth/me`, { headers: { 'x-test-user': 'u1' } })).json();
    expect(body.user).toMatchObject({ id: 'u1', email: 'user@example.com', authMode: 'google', hasPassword: false });
    expect(query.mock.calls[0][0]).toMatch(/SELECT id, username, email,/);
  });
});

describe('POST /api/auth/logout', () => {
  const logout = (headers = {}) => fetch(`${base}/api/auth/logout`, {
    method: 'POST', headers: { 'x-test-user': 'u1', ...headers },
  }).then((res) => res.json());

  it('ends the Cloudflare Access session when the request came through Access', async () => {
    cloudflareEnv();
    expect(await logout({ 'cf-access-jwt-assertion': 'token' })).toEqual({ ok: true, endSessionUrl: '/cdn-cgi/access/logout' });
    expect(await logout()).toEqual({ ok: true, endSessionUrl: null });
    expect(buildEndSessionUrl).not.toHaveBeenCalled();
  });

  it('keeps the OIDC end-session URL in local mode', async () => {
    buildEndSessionUrl.mockResolvedValue('https://idp.example.com/logout');
    expect(await logout()).toEqual({ ok: true, endSessionUrl: 'https://idp.example.com/logout' });
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('never sends the reset mail through a mailbox', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql) => {
      if (/FROM users WHERE recovery_email/.test(sql)) return { rows: [{ id: 'u1', password_hash: 'hash' }] };
      return { rows: [] };
    });
    const res = await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(query.mock.calls.some(([sql]) => /email_accounts/.test(sql))).toBe(false);
    expect(error).toHaveBeenCalledWith('forgot-password error:', 'No email transport available');
    error.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/routes/auth.config.test.js`
Expected: FAIL — `/config` отвечает 404, `/me` без `email`, выход через Cloudflare получает `endSessionUrl` из OIDC, сброс пароля делает запрос к `email_accounts`.

- [ ] **Step 3: Implement**

В `backend/src/routes/auth.js`:

1. Строку 10 заменить на:

```js
import { createSmtpTransport } from '../services/smtpTransport.js';
```

2. После строки 21 (`import { consume as rlConsume, ... }`) добавить:

```js
import { getAuthSettings } from '../services/auth/authSettings.js';
import { CF_ACCESS_HEADER } from '../services/auth/cloudflareAccess.js';
```

3. Перед `router.post('/register', authLimiter, ...` (строка 111) добавить:

```js
// Public: which sign-in screen to show. Only switches, never the configured values.
router.get('/config', (req, res) => {
  const settings = getAuthSettings();
  res.json({ mode: settings.mode, cloudflare: !!settings.cloudflare, googleSignIn: !!settings.googleSignIn });
});

```

4. В `router.post('/logout', ...)` строку

```js
  const endSessionUrl = await buildEndSessionUrl({ providerId: oidcProviderId, idToken: oidcIdToken });
```

заменить на:

```js
  const settings = getAuthSettings();
  // Leaving through Cloudflare also has to end the Access session, or the next request
  // signs the user straight back in.
  const endSessionUrl = settings.mode === 'google'
    ? (settings.cloudflare && req.get(CF_ACCESS_HEADER) ? '/cdn-cgi/access/logout' : null)
    : await buildEndSessionUrl({ providerId: oidcProviderId, idToken: oidcIdToken });
```

5. В `router.get('/me', ...)` заменить две строки запроса и ответа:

```js
  const result = await query('SELECT id, username, email, display_name, avatar, is_admin, totp_enabled, password_hash, lock_pin_hash FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.session.isAdmin = user.is_admin;
  res.json({ user: { id: user.id, username: user.username, email: user.email, authMode: getAuthSettings().mode, displayName: user.display_name, avatar: user.avatar, isAdmin: user.is_admin, totpEnabled: user.totp_enabled, hasPassword: !!user.password_hash, hasLockPin: !!user.lock_pin_hash, locked: !!req.session.locked } });
```

6. В `router.post('/forgot-password', ...)` строку комментария

```js
      // Transport preference: system SMTP → account owner's first personal SMTP account.
```

заменить на:

```js
      // Only the system SMTP sends password reset mail: mailboxes belong to the team, not to the account.
```

строку

```js
      } catch { /* fall through to personal account */ }
```

заменить на:

```js
      } catch { /* no usable system SMTP */ }
```

и удалить целиком блок от строки `      // 2. Fall back to the account owner's first personal SMTP account,` до закрывающей `      }` перед строкой `      if (!transport) throw new Error('No email transport available');` (сейчас строки 1050–1072).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bt src/routes/auth.config.test.js src/routes/auth.sessions.test.js src/routes/auth.preferences.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/auth.js backend/src/routes/auth.config.test.js
git commit -m "feat(auth): expose the sign-in mode and end the Access session on sign-out"
```

---
### Task 8: WebSocket проверяет пользователя и закрывается при отключении

**Files:**
- Modify: `backend/src/services/websocket.js`
- Modify: `backend/src/services/websocket.test.js` (заменить целиком)

**Interfaces:**
- Consumes: `getAuthSettings()` (Task 2); `CF_ACCESS_HEADER`, `verifyCloudflareAccessToken` (Task 4); `findUserByEmail`, `loadUserById` (Task 3); `getPublicOrigins` (Task 1).
- Produces:
  - `authorizeSocketUser(req, { settings, verifyToken, loadUser, findUser } = {}): Promise<string | null>`;
  - `closeUserSockets(wss, userId): void` — закрывает открытые сокеты пользователя кодом 1008 `Session ended`;
  - `setupWebSocket(wss, sessionMiddleware, imapManager, { authorize = authorizeSocketUser } = {})`: неавторизованный — `1008 Unauthorized`, ошибка авторизации — `1011 Session unavailable`.

- [ ] **Step 1: Write the failing test**

`backend/src/services/websocket.test.js` заменить целиком:

```js
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./diagnosticsRing.js', () => ({ recordWsConnect: vi.fn(), recordWsDisconnect: vi.fn() }));
vi.mock('./auth/userIdentity.js', () => ({ findUserByEmail: vi.fn(), loadUserById: vi.fn() }));
vi.mock('./auth/cloudflareAccess.js', () => ({
  CF_ACCESS_HEADER: 'cf-access-jwt-assertion',
  verifyCloudflareAccessToken: vi.fn(),
}));

import { authorizeSocketUser, closeUserSockets, setupWebSocket } from './websocket.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(sessionMiddleware, manager = { connectAllForUser: vi.fn().mockResolvedValue() }, options) {
  const wss = new EventEmitter();
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1, close: vi.fn(), terminate: vi.fn(), send: vi.fn(),
  });
  setupWebSocket(wss, sessionMiddleware, manager, options);
  wss.emit('connection', ws, { headers: {}, session: { userId: 'u1' } });
  return { ws, manager };
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
    const { ws, manager } = setup((_req, _res, next) => next(new Error('Redis unavailable')));
    expect(ws.close).toHaveBeenCalledWith(1011, 'Session unavailable');
    expect(manager.connectAllForUser).not.toHaveBeenCalled();
  });

  it('does not authenticate a socket closed during session lookup', async () => {
    let finish;
    const { ws, manager } = setup((_req, _res, next) => { finish = next; });
    ws.readyState = 3;
    finish();
    await flush();
    expect(ws.send).not.toHaveBeenCalled();
    expect(manager.connectAllForUser).not.toHaveBeenCalled();
  });

  it('handles a database failure during account reconnect without an unhandled rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws } = setup((_req, _res, next) => next(), {
      connectAllForUser: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('WebSocket account reconnect failed:', 'database unavailable'));
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'connected' }));
  });

  it('closes a socket whose user is not authorized', async () => {
    const { ws, manager } = setup((_req, _res, next) => next(), undefined, { authorize: async () => null });
    await flush();
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(manager.connectAllForUser).not.toHaveBeenCalled();
  });

  it('lets the browser retry when authorization itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws } = setup((_req, _res, next) => next(), undefined, {
      authorize: async () => { throw new Error('database unavailable'); },
    });
    await flush();
    expect(ws.close).toHaveBeenCalledWith(1011, 'Session unavailable');
    expect(error).toHaveBeenCalledWith('WebSocket authorization failed: Error');
  });
});

describe('authorizeSocketUser', () => {
  const GOOGLE = {
    mode: 'google',
    cloudflare: { issuer: 'https://team.cloudflareaccess.com', audience: 'aud' },
    googleSignIn: null,
    bootstrapAdminEmails: new Set(),
  };
  const USER = { id: 'u1', email: 'user@example.com', disabled_at: null };
  const deps = (overrides = {}) => ({
    settings: GOOGLE,
    verifyToken: vi.fn(async (token) => (token === 'good' ? 'user@example.com' : null)),
    findUser: vi.fn(async () => USER),
    loadUser: vi.fn(async () => USER),
    ...overrides,
  });
  const req = (session, headers = {}) => ({ session, headers });

  it('uses the session user in local mode', async () => {
    const local = { settings: { ...GOOGLE, mode: 'local' } };
    expect(await authorizeSocketUser(req({ userId: 'u1' }), local)).toBe('u1');
    expect(await authorizeSocketUser(req({}), local)).toBeNull();
  });

  it('accepts an Access token of the session user', async () => {
    const d = deps();
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'cloudflare' }, { 'cf-access-jwt-assertion': 'good' }), d)).toBe('u1');
    expect(d.findUser).toHaveBeenCalledWith('user@example.com');
  });

  it('refuses a token of someone else, an invalid token and a Cloudflare session without its token', async () => {
    expect(await authorizeSocketUser(req({ userId: 'u2', authMethod: 'cloudflare' }, { 'cf-access-jwt-assertion': 'good' }), deps())).toBeNull();
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'cloudflare' }, { 'cf-access-jwt-assertion': 'bad' }), deps())).toBeNull();
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'cloudflare' }), deps())).toBeNull();
  });

  it('accepts an active direct sign-in session and refuses a disabled or email-less user', async () => {
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'google' }), deps())).toBe('u1');
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'google' }), deps({
      loadUser: vi.fn(async () => ({ ...USER, disabled_at: new Date() })),
    }))).toBeNull();
    expect(await authorizeSocketUser(req({ userId: 'u1', authMethod: 'google' }), deps({
      loadUser: vi.fn(async () => ({ ...USER, email: null })),
    }))).toBeNull();
  });
});

describe('closeUserSockets', () => {
  it('closes only the open sockets of that user', () => {
    const mine = { userId: 'u1', readyState: 1, close: vi.fn() };
    const closing = { userId: 'u1', readyState: 3, close: vi.fn() };
    const other = { userId: 'u2', readyState: 1, close: vi.fn() };
    closeUserSockets({ clients: new Set([mine, closing, other]) }, 'u1');
    expect(mine.close).toHaveBeenCalledWith(1008, 'Session ended');
    expect(closing.close).not.toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });
});

describe('WebSocket origins', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('accepts APP_URL and APP_ALT_URLS origins and closes others', async () => {
    vi.resetModules();
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    vi.stubEnv('APP_ALT_URLS', 'https://direct.example.com');
    const { setupWebSocket: setupWithOrigins } = await import('./websocket.js');
    const connect = (origin) => {
      const wss = new EventEmitter();
      const ws = Object.assign(new EventEmitter(), {
        readyState: 1, close: vi.fn(), terminate: vi.fn(), send: vi.fn(),
      });
      // Session lookup never finishes: only the origin check runs.
      setupWithOrigins(wss, () => {}, { connectAllForUser: vi.fn() });
      wss.emit('connection', ws, { headers: { origin } });
      return ws;
    };
    expect(connect('https://mail.example.com').close).not.toHaveBeenCalled();
    expect(connect('https://direct.example.com').close).not.toHaveBeenCalled();
    expect(connect('https://evil.example.com').close).toHaveBeenCalledWith(1008, 'Forbidden');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/services/websocket.test.js`
Expected: FAIL — `authorizeSocketUser is not a function` / `closeUserSockets is not a function`.

- [ ] **Step 3: Implement**

В `backend/src/services/websocket.js` после строки `import { getPublicOrigins } from '../utils/publicOrigins.js';` (Task 1) добавить:

```js
import { getAuthSettings } from './auth/authSettings.js';
import { CF_ACCESS_HEADER, verifyCloudflareAccessToken } from './auth/cloudflareAccess.js';
import { findUserByEmail, loadUserById } from './auth/userIdentity.js';
```

Перед `export function setupWebSocket(` добавить:

```js
// The user a WebSocket upgrade belongs to, or null. Google mode applies the rules of the HTTP
// identity gate but cannot change the session: an Access token must belong to the user the
// page's HTTP requests already put into the session.
export async function authorizeSocketUser(req, {
  settings = getAuthSettings(),
  verifyToken = verifyCloudflareAccessToken,
  loadUser = loadUserById,
  findUser = findUserByEmail,
} = {}) {
  const sessionUserId = req.session?.userId;
  if (!sessionUserId) return null;
  if (settings.mode !== 'google') return sessionUserId;

  const token = settings.cloudflare ? req.headers[CF_ACCESS_HEADER] : undefined;
  let user;
  if (token) {
    if (req.session.authMethod !== 'cloudflare') return null;
    const email = await verifyToken(token, settings.cloudflare);
    user = email ? await findUser(email) : null;
    if (!user || user.id !== sessionUserId) return null;
  } else {
    if (req.session.authMethod !== 'google') return null;
    user = await loadUser(sessionUserId);
  }
  return user && user.email && !user.disabled_at ? user.id : null;
}

// Close every live socket of a user whose access just ended.
export function closeUserSockets(wss, userId) {
  for (const ws of wss.clients) {
    if (ws.userId === userId && ws.readyState === 1) ws.close(1008, 'Session ended');
  }
}

```

Сигнатуру `export function setupWebSocket(wss, sessionMiddleware, imapManager) {` заменить на:

```js
export function setupWebSocket(wss, sessionMiddleware, imapManager, { authorize = authorizeSocketUser } = {}) {
```

и тело колбэка `sessionMiddleware(req, fakeRes, (err) => { ... });` заменить на:

```js
    sessionMiddleware(req, fakeRes, (err) => {
      if (ws.readyState !== 1) return;
      if (err) {
        // A temporary session-store outage should be retried, not treated as
        // invalid credentials (1008 disables automatic browser reconnects).
        ws.close(1011, 'Session unavailable');
        return;
      }
      authorize(req)
        .then((userId) => {
          if (ws.readyState !== 1) return;
          if (!userId) {
            ws.close(1008, 'Unauthorized');
            return;
          }
          if (req.session.locked) {
            // Screen lock (#235) is server-enforced: don't stream live mail to a locked
            // session. The client closes its own socket on lock; this blocks a new one.
            ws.close(1008, 'Locked');
            return;
          }
          ws.userId = userId;
          recordWsConnect();
          ws._diagCounted = true;
          console.log(`WebSocket connected for user ${userId}`);
          ws.send(JSON.stringify({ type: 'connected' }));
          // Re-establish IMAP connections if the server restarted (skips already-connected accounts)
          imapManager.connectAllForUser(userId).catch(reconnectErr => {
            console.error('WebSocket account reconnect failed:', reconnectErr.message);
          });
        })
        .catch((authErr) => {
          // Only the error class: a lookup failure must not end in a message with details.
          console.error(`WebSocket authorization failed: ${authErr?.name || 'Error'}`);
          if (ws.readyState === 1) ws.close(1011, 'Session unavailable');
        });
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bt src/services/websocket.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/websocket.js backend/src/services/websocket.test.js
git commit -m "feat(auth): authorize WebSocket users like HTTP requests and close them on sign-out"
```

---

### Task 9: Пользователи в админке: добавление по email, отключение, защита админов

**Files:**
- Modify: `backend/src/routes/admin.js:1-88` (импорты и раздел Users), `:273-324` (приглашения)
- Create: `backend/src/routes/admin.users.test.js`

**Interfaces:**
- Consumes: `getAuthSettings()` (Task 2); `normalizeEmail`, `claimOrCreateUserByEmail`, `UserIdentityError` (Task 3); `closeUserSockets(wss, userId)` (Task 8); `destroyUserSessions(userId)` (есть в `routes/auth.js`).
- Produces (все под `requireAdmin`):
  - `GET /api/admin/users` → `{ users: PublicUser[], total }`, где `PublicUser = { id, username, email, isAdmin, totpEnabled, disabledAt, created_at, isBootstrapAdmin }`;
  - `POST /api/admin/users { email }` → 201 `{ user }` (создан) | 200 `{ user }` (email присвоен пользователю с таким `username`) | 400 `email_invalid` | 409 `user_exists` | 409 `username_taken`;
  - `PATCH /api/admin/users/:id { isAdmin?, disabled?, email? }` → `{ ok: true, user }` | 400 `invalid_field` | `email_invalid` | `no_fields` | `self_change` | 404 `not_found` | 409 `bootstrap_admin` | `last_admin` | `email_taken`;
  - `DELETE /api/admin/users/:id` → `{ ok: true }` | 400 (себя) | 404 `not_found` | 409 `bootstrap_admin` | `last_admin` | `user_has_mailboxes` (только режим `google`).
  - Ошибки — `{ error: <English message>, code }`.

- [ ] **Step 1: Write the failing test**

`backend/src/routes/admin.users.test.js`:

```js
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAdmin: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({
  imapManager: { disconnectUser: vi.fn(async () => {}), wss: { clients: new Set() } },
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
import { query, withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { destroyUserSessions } from './auth.js';
import { closeUserSockets } from '../services/websocket.js';

const ADMIN_ID = '00000000-0000-0000-0000-00000000000a';
const USER_ID = '00000000-0000-0000-0000-00000000000b';
const USER_ROW = {
  id: USER_ID, username: 'user@example.com', email: 'user@example.com', is_admin: false,
  totp_enabled: false, disabled_at: null, created_at: '2026-09-15T00:00:00.000Z',
};

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: ADMIN_ID, username: 'admin@example.com' };
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

// Transaction client that routes SQL by pattern and records every call.
let calls;
function installTransaction(handlers) {
  calls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push([sql, params]);
      for (const [re, result] of handlers) {
        if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  withTransaction.mockImplementation(async (fn) => fn(client));
}
const sqlCall = (re) => calls.find(([sql]) => re.test(sql));
const lock = [/pg_advisory_xact_lock/, { rows: [] }];
const target = (row) => [/SELECT id, email, is_admin, disabled_at FROM users WHERE id = \$1 FOR UPDATE/, { rows: row ? [row] : [] }];
const otherAdmins = (count) => [/SELECT COUNT\(\*\)::int AS count FROM users/, { rows: [{ count }] }];

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  destroyUserSessions.mockClear();
  closeUserSockets.mockClear();
  imapManager.disconnectUser.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const send = (method, path, body) => fetch(`${base}/api/admin${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

describe('GET /api/admin/users', () => {
  it('lists email, status and bootstrap admins', async () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'user@example.com');
    query.mockImplementation(async (sql) => (/COUNT/.test(sql)
      ? { rows: [{ total: '1' }] }
      : { rows: [{ ...USER_ROW, disabled_at: '2026-09-16T00:00:00.000Z' }] }));
    const { body } = await send('GET', '/users');
    expect(body).toEqual({
      total: 1,
      users: [{
        id: USER_ID, username: 'user@example.com', email: 'user@example.com', isAdmin: false, totpEnabled: false,
        disabledAt: '2026-09-16T00:00:00.000Z', created_at: '2026-09-15T00:00:00.000Z', isBootstrapAdmin: true,
      }],
    });
  });
});

describe('POST /api/admin/users', () => {
  const emailLookup = (row) => [/^\s*SELECT .* FROM users WHERE lower\(email\) = \$1/, { rows: row ? [row] : [] }];
  const claim = (row) => [/^\s*UPDATE users SET email = \$1/, { rows: row ? [row] : [] }];

  it('rejects an invalid address', async () => {
    expect(await send('POST', '/users', { email: 'nope' })).toEqual({
      status: 400, body: { error: 'A valid email address is required', code: 'email_invalid' },
    });
  });

  it('approves a new person', async () => {
    installTransaction([lock, emailLookup(null), claim(null), [/^\s*INSERT INTO users/, { rows: [USER_ROW] }]]);
    const { status, body } = await send('POST', '/users', { email: ' User@Example.com ' });
    expect(status).toBe(201);
    expect(body.user).toMatchObject({ id: USER_ID, email: 'user@example.com', isAdmin: false, disabledAt: null });
    expect(sqlCall(/INSERT INTO users/)[1]).toEqual(['user@example.com', false]);
  });

  it('gives the email to a legacy user named by it', async () => {
    installTransaction([lock, emailLookup(null), claim(USER_ROW)]);
    expect((await send('POST', '/users', { email: 'user@example.com' })).status).toBe(200);
  });

  it('refuses an address that is already approved or taken as a username', async () => {
    installTransaction([lock, emailLookup(USER_ROW)]);
    expect((await send('POST', '/users', { email: 'user@example.com' })).body.code).toBe('user_exists');

    installTransaction([lock, emailLookup(null), claim(null), [/^\s*INSERT INTO users/, () => {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    }]]);
    expect(await send('POST', '/users', { email: 'user@example.com' })).toMatchObject({ status: 409, body: { code: 'username_taken' } });
  });
});

describe('PATCH /api/admin/users/:id', () => {
  const update = (row) => [/^\s*UPDATE users\s+SET is_admin = \$2/, (params) => ({
    rows: [{ ...row, is_admin: params[1], email: params[2], disabled_at: params[3] }],
  })];

  it('validates the fields and refuses to lock the admin out of their own account', async () => {
    expect((await send('PATCH', `/users/${USER_ID}`, { isAdmin: 'yes' })).body.code).toBe('invalid_field');
    expect((await send('PATCH', `/users/${USER_ID}`, { email: 'nope' })).body.code).toBe('email_invalid');
    expect((await send('PATCH', `/users/${USER_ID}`, {})).body.code).toBe('no_fields');
    expect((await send('PATCH', `/users/${ADMIN_ID}`, { disabled: true })).body.code).toBe('self_change');
    expect((await send('PATCH', `/users/${ADMIN_ID}`, { isAdmin: false })).body.code).toBe('self_change');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('disables a user and ends their sessions and sockets', async () => {
    installTransaction([lock, target(USER_ROW), update(USER_ROW)]);
    const { status, body } = await send('PATCH', `/users/${USER_ID}`, { disabled: true });
    expect(status).toBe(200);
    expect(body.user.disabledAt).toEqual(expect.any(String));
    const [, params] = sqlCall(/^\s*UPDATE users/);
    expect(params[0]).toBe(USER_ID);
    expect(params[3]).toEqual(expect.any(Date));
    expect(params[4]).toBe(ADMIN_ID);
    expect(destroyUserSessions).toHaveBeenCalledWith(USER_ID);
    expect(closeUserSockets).toHaveBeenCalledWith(imapManager.wss, USER_ID);
  });

  it('enables a user without touching sessions', async () => {
    const disabledRow = { ...USER_ROW, disabled_at: '2026-09-16T00:00:00.000Z' };
    installTransaction([lock, target(disabledRow), update(disabledRow)]);
    const { body } = await send('PATCH', `/users/${USER_ID}`, { disabled: false });
    expect(body.user.disabledAt).toBeNull();
    expect(destroyUserSessions).not.toHaveBeenCalled();
  });

  it('keeps at least one active admin', async () => {
    const adminRow = { ...USER_ROW, is_admin: true };
    installTransaction([lock, target(adminRow), otherAdmins(0)]);
    expect(await send('PATCH', `/users/${USER_ID}`, { isAdmin: false })).toMatchObject({ status: 409, body: { code: 'last_admin' } });
    expect(sqlCall(/^\s*UPDATE users/)).toBeUndefined();

    vi.stubEnv('AUTH_MODE', 'google');
    installTransaction([lock, target(adminRow), otherAdmins(0)]);
    expect((await send('PATCH', `/users/${USER_ID}`, { email: null })).body.code).toBe('last_admin');
    expect(sqlCall(/COUNT/)[0]).toMatch(/AND email IS NOT NULL/);
  });

  it('refuses to change a bootstrap admin', async () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'user@example.com');
    installTransaction([lock, target({ ...USER_ROW, is_admin: true })]);
    expect(await send('PATCH', `/users/${USER_ID}`, { disabled: true })).toMatchObject({ status: 409, body: { code: 'bootstrap_admin' } });
  });

  it('refuses an email another user already has', async () => {
    installTransaction([lock, target(USER_ROW), [/SELECT id FROM users WHERE lower\(email\) = \$1 AND id <> \$2/, { rows: [{ id: ADMIN_ID }] }]]);
    expect((await send('PATCH', `/users/${USER_ID}`, { email: 'admin@example.com' })).body.code).toBe('email_taken');
  });

  it('signs a user out when google mode loses their email', async () => {
    vi.stubEnv('AUTH_MODE', 'google');
    installTransaction([lock, target(USER_ROW), update(USER_ROW)]);
    expect((await send('PATCH', `/users/${USER_ID}`, { email: '' })).body.user.email).toBeNull();
    expect(destroyUserSessions).toHaveBeenCalledWith(USER_ID);
  });
});

describe('DELETE /api/admin/users/:id', () => {
  const mailboxes = (count) => [/FROM email_accounts WHERE user_id = \$1/, { rows: [{ count }] }];

  it('keeps mailbox owners in google mode until mailboxes are shared', async () => {
    vi.stubEnv('AUTH_MODE', 'google');
    installTransaction([lock, target(USER_ROW), mailboxes(2)]);
    expect(await send('DELETE', `/users/${USER_ID}`)).toMatchObject({ status: 409, body: { code: 'user_has_mailboxes' } });
    expect(imapManager.disconnectUser).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a bootstrap admin and the last active admin', async () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'user@example.com');
    installTransaction([lock, target(USER_ROW)]);
    expect((await send('DELETE', `/users/${USER_ID}`)).body.code).toBe('bootstrap_admin');

    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', '');
    installTransaction([lock, target({ ...USER_ROW, is_admin: true }), otherAdmins(0)]);
    expect((await send('DELETE', `/users/${USER_ID}`)).body.code).toBe('last_admin');
  });

  it('signs the user out everywhere and deletes them', async () => {
    installTransaction([lock, target(USER_ROW)]);
    query.mockResolvedValue({ rows: [] });
    expect(await send('DELETE', `/users/${USER_ID}`)).toEqual({ status: 200, body: { ok: true } });
    expect(imapManager.disconnectUser).toHaveBeenCalledWith(USER_ID);
    expect(destroyUserSessions).toHaveBeenCalledWith(USER_ID);
    expect(closeUserSockets).toHaveBeenCalledWith(imapManager.wss, USER_ID);
    expect(query).toHaveBeenCalledWith('DELETE FROM users WHERE id = $1', [USER_ID]);
  });
});

describe('POST /api/admin/invites', () => {
  it('sends invites through the system SMTP only', async () => {
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    query.mockResolvedValue({ rows: [] });
    const { body } = await send('POST', '/invites', { email: 'new@example.com' });
    expect(body).toMatchObject({ ok: true, emailSent: false, emailError: null });
    expect(query.mock.calls.some(([sql]) => /email_accounts/.test(sql))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/routes/admin.users.test.js`
Expected: FAIL — нет `POST /users`, в списке нет `email`, приглашение запрашивает `email_accounts`.

- [ ] **Step 3: Implement**

В `backend/src/routes/admin.js`:

1. Импорты (строки 1–13) заменить на:

```js
import { Router } from 'express';
import crypto from 'crypto';
import { query, withTransaction } from '../services/db.js';
import { requireAdmin } from '../middleware/auth.js';
import { decrypt, encrypt } from '../services/encryption.js';
import { validateHost, resolveForConnection } from '../services/hostValidation.js';
import { createSmtpTransport } from '../services/smtpTransport.js';
import { getConnectionPolicy, invalidateConnectionPolicyCache } from '../services/connectionPolicy.js';
import { reloadAuthSettings } from '../services/authLimiter.js';
import { imapManager } from '../index.js';
import { stopCardavUser } from '../services/carddavSync.js';
import { pluginRegistry } from '../plugins/registry.js';
import { uuidParam } from '../utils/uuid.js';
import { getAuthSettings } from '../services/auth/authSettings.js';
import { UserIdentityError, claimOrCreateUserByEmail, normalizeEmail } from '../services/auth/userIdentity.js';
import { closeUserSockets } from '../services/websocket.js';
import { destroyUserSessions } from './auth.js';
```

Если после этой замены `decrypt`, `encrypt`, `validateHost`, `resolveForConnection`, `getConnectionPolicy` или `invalidateConnectionPolicyCache` окажутся неиспользуемыми, `npm run lint` это покажет: такой импорт удалить (сейчас они используются в разделах системных настроек и системной почты).

2. Раздел `// ── Users ──` — от `router.get('/users', ...)` до конца `router.delete('/users/:id', ...)` (строки 22–88), **кроме** `router.post('/users/:id/totp/disable', ...)` (строки 38–48, оставить без изменений между новыми `POST /users` и `PATCH`), — заменить на:

```js
class AdminUserError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const USER_LIST_COLUMNS = 'id, username, email, is_admin, totp_enabled, disabled_at, created_at';

function publicUser(row, bootstrapAdminEmails = getAuthSettings().bootstrapAdminEmails) {
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? null,
    isAdmin: row.is_admin,
    totpEnabled: !!row.totp_enabled,
    disabledAt: row.disabled_at ?? null,
    created_at: row.created_at,
    isBootstrapAdmin: !!row.email && bootstrapAdminEmails.has(row.email.toLowerCase()),
  };
}

// Whether the user can still reach the admin panel: an admin, not disabled, and — in google
// mode, where sign-in is by email — with an email.
function countsAsActiveAdmin({ is_admin: isAdmin, disabled_at: disabledAt, email }, googleMode) {
  return !!isAdmin && !disabledAt && (!googleMode || !!email);
}

async function otherActiveAdminExists(client, userId, googleMode) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS count FROM users
      WHERE is_admin = true AND disabled_at IS NULL AND id <> $1${googleMode ? ' AND email IS NOT NULL' : ''}`,
    [userId],
  );
  return rows[0].count > 0;
}

// Serializes changes that could leave the install without a reachable admin.
const lockAdminGuard = (client) => client.query("SELECT pg_advisory_xact_lock(hashtext('users-admin-guard'))");

const lockTargetUser = async (client, id) => {
  const { rows } = await client.query('SELECT id, email, is_admin, disabled_at FROM users WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new AdminUserError(404, 'not_found', 'User not found');
  return rows[0];
};

const isBootstrapEmail = (settings, email) => !!email && settings.bootstrapAdminEmails.has(email.toLowerCase());

function sendAdminUserError(res, err) {
  if (!(err instanceof AdminUserError)) throw err;
  return res.status(err.status).json({ error: err.message, code: err.code });
}

// End every session and live socket of a user who just lost access.
async function signOutEverywhere(userId) {
  await destroyUserSessions(userId);
  closeUserSockets(imapManager.wss, userId);
}

router.get('/users', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 100, 200);
  const offset = Math.max(parseInt(req.query.offset) || 0,   0);
  const [result, countResult] = await Promise.all([
    query(
      `SELECT ${USER_LIST_COLUMNS} FROM users ORDER BY created_at ASC LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    query('SELECT COUNT(*) AS total FROM users'),
  ]);
  const { bootstrapAdminEmails } = getAuthSettings();
  res.json({
    users: result.rows.map((row) => publicUser(row, bootstrapAdminEmails)),
    total: parseInt(countResult.rows[0].total),
  });
});

// Approving an email is what lets a person sign in when AUTH_MODE=google.
router.post('/users', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'A valid email address is required', code: 'email_invalid' });
  try {
    const { user, created, claimed } = await withTransaction((client) => claimOrCreateUserByEmail(client, email));
    if (!created && !claimed) {
      return res.status(409).json({ error: 'A user with this email already exists', code: 'user_exists' });
    }
    console.log(`[admin] ${req.session.userId} approved user ${user.id}`);
    return res.status(created ? 201 : 200).json({ user: publicUser(user) });
  } catch (err) {
    if (err instanceof UserIdentityError) {
      return res.status(409).json({ error: 'Another user already has this address as a username', code: err.code });
    }
    throw err;
  }
});
```

(здесь остаётся существующий `router.post('/users/:id/totp/disable', ...)`)

```js
router.patch('/users/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const { isAdmin, disabled } = body;
  const emailGiven = Object.hasOwn(body, 'email');
  const clearingEmail = emailGiven && (body.email === null || body.email === '');
  const email = emailGiven && !clearingEmail ? normalizeEmail(body.email) : null;

  if (isAdmin !== undefined && typeof isAdmin !== 'boolean') {
    return res.status(400).json({ error: 'isAdmin must be a boolean', code: 'invalid_field' });
  }
  if (disabled !== undefined && typeof disabled !== 'boolean') {
    return res.status(400).json({ error: 'disabled must be a boolean', code: 'invalid_field' });
  }
  if (emailGiven && !clearingEmail && !email) {
    return res.status(400).json({ error: 'A valid email address is required', code: 'email_invalid' });
  }
  if (isAdmin === undefined && disabled === undefined && !emailGiven) {
    return res.status(400).json({ error: 'No valid fields to update', code: 'no_fields' });
  }
  if (id === req.session.userId && isAdmin === false) {
    return res.status(400).json({ error: 'Cannot remove your own admin status', code: 'self_change' });
  }
  if (id === req.session.userId && disabled === true) {
    return res.status(400).json({ error: 'Cannot disable your own account', code: 'self_change' });
  }

  const settings = getAuthSettings();
  const googleMode = settings.mode === 'google';
  try {
    const { row, lostAccess } = await withTransaction(async (client) => {
      await lockAdminGuard(client);
      const current = await lockTargetUser(client, id);
      const after = {
        is_admin: isAdmin ?? current.is_admin,
        disabled_at: disabled === undefined ? current.disabled_at : (disabled ? (current.disabled_at ?? new Date()) : null),
        email: emailGiven ? email : current.email,
      };

      if (isBootstrapEmail(settings, current.email)
        && (!after.is_admin || after.disabled_at || after.email !== current.email)) {
        throw new AdminUserError(409, 'bootstrap_admin', 'Admins from BOOTSTRAP_ADMIN_EMAILS cannot be changed here');
      }
      if (countsAsActiveAdmin(current, googleMode) && !countsAsActiveAdmin(after, googleMode)
        && !(await otherActiveAdminExists(client, id, googleMode))) {
        throw new AdminUserError(409, 'last_admin', 'At least one active admin must remain');
      }
      if (email && email !== current.email) {
        const { rows: taken } = await client.query('SELECT id FROM users WHERE lower(email) = $1 AND id <> $2', [email, id]);
        if (taken.length) throw new AdminUserError(409, 'email_taken', 'Another user already has this email');
      }

      const { rows: [updated] } = await client.query(
        `UPDATE users
            SET is_admin = $2, email = $3, disabled_at = $4,
                disabled_by = CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE COALESCE(disabled_by, $5::uuid) END
          WHERE id = $1
          RETURNING ${USER_LIST_COLUMNS}`,
        [id, after.is_admin, after.email, after.disabled_at, req.session.userId],
      );
      // Losing the way in: turned off, or in google mode left without an email to sign in with.
      const lost = (!current.disabled_at && !!after.disabled_at) || (googleMode && !!current.email && !after.email);
      return { row: updated, lostAccess: lost };
    });

    if (lostAccess) await signOutEverywhere(id);
    console.log(`[admin] ${req.session.userId} updated user ${id}`);
    return res.json({ ok: true, user: publicUser(row, settings.bootstrapAdminEmails) });
  } catch (err) {
    return sendAdminUserError(res, err);
  }
});

router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const settings = getAuthSettings();
  const googleMode = settings.mode === 'google';
  try {
    await withTransaction(async (client) => {
      await lockAdminGuard(client);
      const current = await lockTargetUser(client, id);
      if (isBootstrapEmail(settings, current.email)) {
        throw new AdminUserError(409, 'bootstrap_admin', 'Admins from BOOTSTRAP_ADMIN_EMAILS cannot be deleted here');
      }
      if (countsAsActiveAdmin(current, googleMode) && !(await otherActiveAdminExists(client, id, googleMode))) {
        throw new AdminUserError(409, 'last_admin', 'At least one active admin must remain');
      }
      // Mailboxes still belong to one user: deleting the owner would delete them with it.
      if (googleMode) {
        const { rows: [{ count }] } = await client.query(
          'SELECT COUNT(*)::int AS count FROM email_accounts WHERE user_id = $1',
          [id],
        );
        if (count > 0) throw new AdminUserError(409, 'user_has_mailboxes', 'This user still owns mailboxes');
      }
    });
  } catch (err) {
    return sendAdminUserError(res, err);
  }

  // Stop live per-user workers BEFORE the delete — disconnectUser looks up the
  // user's accounts, which the cascade delete would remove.
  await imapManager.disconnectUser(id).catch(err => console.warn('disconnectUser on delete:', err.message));
  stopCardavUser(id);
  await signOutEverywhere(id);
  await query('DELETE FROM users WHERE id = $1', [id]);
  // Let plugins clean up any user-scoped data the FK cascade can't reach (GTD removes the
  // imported pet, stored under a slug derived from the user id rather than an FK). Best-effort
  // and after the delete: the user row is already gone, so a hook failure must not misreport a
  // completed delete as a 500. The hook swallows per-plugin errors.
  await pluginRegistry.runHook('onUserDelete', { userId: id });
  console.log(`[admin] ${req.session.userId} deleted user ${id}`);
  res.json({ ok: true });
});
```

3. В `router.post('/invites', ...)` строку комментария

```js
  // Try to send an invite email — prefer system SMTP, fall back to admin's first SMTP account
```

заменить на:

```js
  // Send the invite through the system SMTP only: mailboxes belong to the team, not to the admin.
```

строку `      } catch { /* fall through to personal account */ }` заменить на `      } catch { /* no usable system SMTP */ }` и удалить целиком блок от `    // 2. Fall back to admin's first SMTP-enabled personal account` до его закрывающей `    }` перед `    if (transport) {` (сейчас строки 304–324).

- [ ] **Step 4: Run tests and lint**

Run: `bt src/routes/admin.users.test.js`
Expected: PASS.

Затем в контейнере вместо `npx vitest run`: `npx eslint src/routes/admin.js src/routes/auth.js src/services/websocket.js src/middleware src/services/auth src/routes/authGoogle.js src/utils/publicOrigins.js --max-warnings 0`
Expected: без ошибок (неиспользуемый импорт — удалить и повторить).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/admin.js backend/src/routes/admin.users.test.js
git commit -m "feat(admin): approve users by email, disable them and keep a reachable admin"
```

---
### Task 10: Экран входа через Google

**Files:**
- Modify: `frontend/src/utils/api.js:148,190`
- Create: `frontend/src/utils/authMode.js`
- Create: `frontend/src/utils/authMode.test.js`
- Create: `frontend/src/components/GoogleLoginPage.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/locales/{cs,de,en,es,fr,it,pl,ru,zhCN}.json` (блок `login.google`)

**Interfaces:**
- Consumes: `GET /api/auth/config` → `{ mode, cloudflare, googleSignIn }`; `GET /api/auth/me` → `user.authMode`, `user.email` (Task 7); `/oauth/login/google` и `/login?auth_error=` (Task 6); `POST /api/admin/users` (Task 9).
- Produces: `api.authConfig()`; `api.admin.createUser(email)`; `SIGN_IN_PATH = '/oauth/login/google'`; `isGoogleAuthMode(userOrConfig): boolean`; `signInErrorKey(code): string | null`; компонент `GoogleLoginPage({ config })`; ключи `login.google.title|desc|button|cloudflareOnly|errorNotAllowed|errorDisabled|errorGeneric`.

- [ ] **Step 1: Write the failing test**

`frontend/src/utils/authMode.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SIGN_IN_PATH, isGoogleAuthMode, signInErrorKey } from './authMode.js';

describe('isGoogleAuthMode', () => {
  it('reads the mode from a user or from the sign-in config', () => {
    assert.equal(isGoogleAuthMode({ authMode: 'google' }), true);
    assert.equal(isGoogleAuthMode({ mode: 'google' }), true);
    assert.equal(isGoogleAuthMode({ authMode: 'local' }), false);
    assert.equal(isGoogleAuthMode(null), false);
  });
});

describe('signInErrorKey', () => {
  it('maps known codes and falls back to a generic message', () => {
    assert.equal(signInErrorKey('not_allowed'), 'login.google.errorNotAllowed');
    assert.equal(signInErrorKey('user_disabled'), 'login.google.errorDisabled');
    assert.equal(signInErrorKey('invalid_state'), 'login.google.errorGeneric');
    assert.equal(signInErrorKey(''), null);
    assert.equal(signInErrorKey(null), null);
  });

  it('points the sign-in button at the backend route', () => {
    assert.equal(SIGN_IN_PATH, '/oauth/login/google');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --test src/utils/authMode.test.js`
Expected: FAIL — `Cannot find module '.../authMode.js'`.

- [ ] **Step 3: Implement helpers and API**

`frontend/src/utils/authMode.js`:

```js
// Sign-in mode helpers shared by the login screen and the admin panel.
export const SIGN_IN_PATH = '/oauth/login/google';

export function isGoogleAuthMode(value) {
  return value?.authMode === 'google' || value?.mode === 'google';
}

const ERROR_KEYS = {
  not_allowed: 'login.google.errorNotAllowed',
  user_disabled: 'login.google.errorDisabled',
};

// Translation key for an ?auth_error= code, or null when there is none.
export function signInErrorKey(code) {
  if (typeof code !== 'string' || !code) return null;
  return ERROR_KEYS[code] || 'login.google.errorGeneric';
}
```

В `frontend/src/utils/api.js` после строки `  me: () => request('GET', '/auth/me'),` добавить:

```js
  authConfig: () => request('GET', '/auth/config'),
```

и в объекте `admin` после строки `    getUsers: (params) => ...,` добавить:

```js
    createUser: (email) => request('POST', '/admin/users', { email }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --test src/utils/authMode.test.js`
Expected: PASS.

- [ ] **Step 5: Add the login screen**

`frontend/src/components/GoogleLoginPage.jsx`:

```jsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import LogoMark from './LogoMark.jsx';
import { SIGN_IN_PATH, signInErrorKey } from '../utils/authMode.js';

// Sign-in screen for AUTH_MODE=google. Through Cloudflare Access the user is already signed in
// and never sees it; on a host without Cloudflare it offers Google sign-in.
export default function GoogleLoginPage({ config }) {
  const { t } = useTranslation();
  const [errorKey] = useState(() => signInErrorKey(new URLSearchParams(window.location.search).get('auth_error')));

  return (
    <div style={{
      minHeight: 'var(--app-height, 100svh)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'var(--bg-primary)', padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ marginBottom: 40, textAlign: 'center' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <LogoMark size={44} />
            <span style={{ display: 'flex', alignItems: 'baseline' }}>
              <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 30, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>Mail</span>
              <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 30, fontWeight: 600, color: 'var(--accent)', letterSpacing: '-0.03em' }}>Expert</span>
            </span>
          </div>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 14, margin: 0 }}>{t('login.tagline')}</p>
        </div>

        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 16, padding: 32 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 500, color: 'var(--text-primary)' }}>
            {t('login.google.title')}
          </h2>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-tertiary)' }}>
            {config?.googleSignIn ? t('login.google.desc') : t('login.google.cloudflareOnly')}
          </p>
          {errorKey && (
            <div style={{
              marginBottom: 16, padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
              border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8, color: 'var(--red)', fontSize: 13,
            }}>{t(errorKey)}</div>
          )}
          {config?.googleSignIn && (
            <a
              href={SIGN_IN_PATH}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '11px 24px', background: 'var(--accent)', borderRadius: 8,
                color: 'var(--accent-text)', fontSize: 14, fontWeight: 500, textDecoration: 'none',
              }}
            >
              {t('login.google.button')}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
```

В `frontend/src/App.jsx`:

1. После `import LoginPage from './components/LoginPage.jsx';` добавить:

```jsx
import GoogleLoginPage from './components/GoogleLoginPage.jsx';
import { isGoogleAuthMode } from './utils/authMode.js';
```

2. После `const [checking, setChecking] = useState(true);` добавить:

```jsx
  const [authConfig, setAuthConfig] = useState(null);
```

3. Строки

```jsx
    api.me()
      .then(async (data) => {
```

заменить на:

```jsx
    // The sign-in screen depends on the server's mode; an unreachable config means local.
    const configLoaded = api.authConfig()
      .then(setAuthConfig)
      .catch(() => setAuthConfig({ mode: 'local' }));
    const userLoaded = api.me()
      .then(async (data) => {
```

4. Строки

```jsx
      })
      .finally(() => setChecking(false));
```

заменить на:

```jsx
      });
    Promise.all([configLoaded, userLoaded]).finally(() => setChecking(false));
```

5. Перед `return (\n    <Routes>` добавить:

```jsx
  const loginPage = isGoogleAuthMode(authConfig) ? <GoogleLoginPage config={authConfig} /> : <LoginPage />;

```

и в двух маршрутах `/login` и `/register` заменить `<LoginPage />` на `loginPage`.

- [ ] **Step 6: Add the translations**

Создать временный `frontend/add-login-locale-keys.mjs` (в git не добавлять):

```js
// One-off: insert the login.google block into every locale file without reformatting it.
import { readFileSync, writeFileSync } from 'node:fs';

const VALUES = {
  en: {
    title: 'Sign in to MailExpert',
    desc: 'Use the Google account your administrator approved.',
    button: 'Sign in with Google',
    cloudflareOnly: "Open MailExpert through your organization's Cloudflare Access link.",
    errorNotAllowed: 'This Google account is not approved for MailExpert. Ask an administrator to add it.',
    errorDisabled: 'Your access to MailExpert has been turned off.',
    errorGeneric: 'Google sign-in failed. Try again.',
  },
  ru: {
    title: 'Вход в MailExpert',
    desc: 'Войдите Google-аккаунтом, который одобрил администратор.',
    button: 'Войти через Google',
    cloudflareOnly: 'Откройте MailExpert по ссылке Cloudflare Access вашей организации.',
    errorNotAllowed: 'Этот Google-аккаунт не одобрен для MailExpert. Попросите администратора добавить его.',
    errorDisabled: 'Ваш доступ к MailExpert отключён.',
    errorGeneric: 'Не удалось войти через Google. Попробуйте ещё раз.',
  },
  de: {
    title: 'Bei MailExpert anmelden',
    desc: 'Verwenden Sie das Google-Konto, das Ihr Administrator freigegeben hat.',
    button: 'Mit Google anmelden',
    cloudflareOnly: 'Öffnen Sie MailExpert über den Cloudflare-Access-Link Ihrer Organisation.',
    errorNotAllowed: 'Dieses Google-Konto ist für MailExpert nicht freigegeben. Bitten Sie einen Administrator, es hinzuzufügen.',
    errorDisabled: 'Ihr Zugang zu MailExpert wurde deaktiviert.',
    errorGeneric: 'Die Anmeldung mit Google ist fehlgeschlagen. Versuchen Sie es erneut.',
  },
  fr: {
    title: 'Connexion à MailExpert',
    desc: 'Utilisez le compte Google approuvé par votre administrateur.',
    button: 'Se connecter avec Google',
    cloudflareOnly: 'Ouvrez MailExpert via le lien Cloudflare Access de votre organisation.',
    errorNotAllowed: "Ce compte Google n'est pas approuvé pour MailExpert. Demandez à un administrateur de l'ajouter.",
    errorDisabled: 'Votre accès à MailExpert a été désactivé.',
    errorGeneric: 'La connexion avec Google a échoué. Réessayez.',
  },
  es: {
    title: 'Iniciar sesión en MailExpert',
    desc: 'Usa la cuenta de Google que aprobó tu administrador.',
    button: 'Iniciar sesión con Google',
    cloudflareOnly: 'Abre MailExpert mediante el enlace de Cloudflare Access de tu organización.',
    errorNotAllowed: 'Esta cuenta de Google no está aprobada para MailExpert. Pide a un administrador que la añada.',
    errorDisabled: 'Tu acceso a MailExpert se ha desactivado.',
    errorGeneric: 'No se pudo iniciar sesión con Google. Inténtalo de nuevo.',
  },
  it: {
    title: 'Accedi a MailExpert',
    desc: "Usa l'account Google approvato dal tuo amministratore.",
    button: 'Accedi con Google',
    cloudflareOnly: 'Apri MailExpert tramite il link Cloudflare Access della tua organizzazione.',
    errorNotAllowed: 'Questo account Google non è approvato per MailExpert. Chiedi a un amministratore di aggiungerlo.',
    errorDisabled: 'Il tuo accesso a MailExpert è stato disattivato.',
    errorGeneric: 'Accesso con Google non riuscito. Riprova.',
  },
  pl: {
    title: 'Logowanie do MailExpert',
    desc: 'Użyj konta Google zatwierdzonego przez administratora.',
    button: 'Zaloguj się przez Google',
    cloudflareOnly: 'Otwórz MailExpert przez link Cloudflare Access swojej organizacji.',
    errorNotAllowed: 'To konto Google nie jest zatwierdzone w MailExpert. Poproś administratora o dodanie go.',
    errorDisabled: 'Twój dostęp do MailExpert został wyłączony.',
    errorGeneric: 'Logowanie przez Google nie powiodło się. Spróbuj ponownie.',
  },
  cs: {
    title: 'Přihlášení do MailExpert',
    desc: 'Použijte účet Google, který schválil váš administrátor.',
    button: 'Přihlásit se přes Google',
    cloudflareOnly: 'Otevřete MailExpert přes odkaz Cloudflare Access vaší organizace.',
    errorNotAllowed: 'Tento účet Google není pro MailExpert schválen. Požádejte administrátora o jeho přidání.',
    errorDisabled: 'Váš přístup do MailExpert byl vypnut.',
    errorGeneric: 'Přihlášení přes Google se nezdařilo. Zkuste to znovu.',
  },
  zhCN: {
    title: '登录 MailExpert',
    desc: '请使用管理员已批准的 Google 账号。',
    button: '使用 Google 登录',
    cloudflareOnly: '请通过贵组织的 Cloudflare Access 链接打开 MailExpert。',
    errorNotAllowed: '此 Google 账号未获准使用 MailExpert。请联系管理员添加。',
    errorDisabled: '你的 MailExpert 访问权限已被关闭。',
    errorGeneric: 'Google 登录失败，请重试。',
  },
};

for (const [locale, values] of Object.entries(VALUES)) {
  const file = new URL(`./src/locales/${locale}.json`, import.meta.url);
  const text = readFileSync(file, 'utf8');
  if (JSON.parse(text).login.google) throw new Error(`${locale}: login.google already exists`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parent = text.match(/^( *)"login": \{\r?$/m);
  if (!parent) throw new Error(`${locale}: login block not found`);
  const indent = `${parent[1]}  `;
  const lines = Object.entries(values).map(([key, value]) => `${indent}  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  const block = `${indent}"google": {${eol}${lines.join(`,${eol}`)}${eol}${indent}},${eol}`;
  const at = text.indexOf('\n', parent.index) + 1;
  const updated = text.slice(0, at) + block + text.slice(at);
  const parsed = JSON.parse(updated).login.google;
  for (const [key, value] of Object.entries(values)) {
    if (parsed[key] !== value) throw new Error(`${locale}: login.google.${key} did not round-trip`);
  }
  writeFileSync(file, updated);
}
console.log('login.google added');
```

Run: `cd frontend && node add-login-locale-keys.mjs && rm add-login-locale-keys.mjs`
Expected: `login.google added`.

- [ ] **Step 7: Run frontend checks**

Run: `cd frontend && node --test src/utils/authMode.test.js src/locales/i18n.test.js src/branding.test.js && npx eslint src/App.jsx src/components/GoogleLoginPage.jsx src/utils/authMode.js src/utils/api.js --max-warnings 0`
Expected: PASS, lint без ошибок.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/utils/authMode.js frontend/src/utils/authMode.test.js frontend/src/utils/api.js frontend/src/components/GoogleLoginPage.jsx frontend/src/App.jsx frontend/src/locales
git commit -m "feat(auth): show a Google sign-in screen in Google sign-in mode"
```

---

### Task 11: Экран пользователей и скрытие локальных настроек входа

**Files:**
- Create: `frontend/src/components/GoogleUsersPanel.jsx`
- Modify: `frontend/src/components/AdminPanel.jsx` (импорты, `UsersTab`, `SecurityTab`, `TABS`, индекс поиска, рендер вкладок)
- Modify: `frontend/src/locales/{cs,de,en,es,fr,it,pl,ru,zhCN}.json` (ключи в `admin.users`)

**Interfaces:**
- Consumes: `api.admin.getUsers`, `api.admin.createUser`, `api.admin.updateUser` (ответ `{ ok, user }`), `api.admin.deleteUser`; `isGoogleAuthMode(user)` (Task 10); `PublicUser` (Task 9).
- Produces: компонент `GoogleUsersPanel`; ключи `admin.users.googleDesc|addPh|add|disabledBadge|bootstrapBadge|noEmail|disable|enable`; флаг `localAuthOnly` у вкладки SSO и пунктов поиска.

- [ ] **Step 1: Add the users panel**

`frontend/src/components/GoogleUsersPanel.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import ConfirmOverlay from './ConfirmOverlay.jsx';

const PAGE_SIZE = 200;

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8,
  background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
};
const badgeStyle = {
  fontSize: 10, padding: '2px 6px', borderRadius: 20, fontWeight: 600,
  letterSpacing: '0.04em', textTransform: 'uppercase',
};
const actionStyle = {
  padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
};

// Users screen for AUTH_MODE=google: approving an email is what lets a person sign in, and every
// signed-in user works with all mailboxes.
export default function GoogleUsersPanel() {
  const { t } = useTranslation();
  const { user: currentUser } = useStore();
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    api.admin.getUsers({ limit: PAGE_SIZE, offset: 0 })
      .then((data) => { setUsers(data.users); setTotal(data.total); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const upsert = (next) => setUsers((list) => (list.some((u) => u.id === next.id)
    ? list.map((u) => (u.id === next.id ? next : u))
    : [...list, next]));

  const run = async (action) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const approve = () => run(async () => {
    const data = await api.admin.createUser(email.trim());
    if (!users.some((u) => u.id === data.user.id)) setTotal((count) => count + 1);
    upsert(data.user);
    setEmail('');
  });

  const toggleAdmin = (u) => run(async () => {
    upsert((await api.admin.updateUser(u.id, { isAdmin: !u.isAdmin })).user);
  });

  const toggleDisabled = (u) => run(async () => {
    upsert((await api.admin.updateUser(u.id, { disabled: !u.disabledAt })).user);
  });

  const loadMore = () => run(async () => {
    const data = await api.admin.getUsers({ limit: PAGE_SIZE, offset: users.length });
    setUsers((list) => [...list, ...data.users]);
    setTotal(data.total);
  });

  const remove = (u) => setConfirmDialog({
    title: t('admin.users.deleteConfirmTitle', { username: u.email || u.username }),
    message: t('admin.users.deleteConfirmBody'),
    confirmLabel: t('admin.users.deleteConfirmLabel'),
    onConfirm: async () => {
      await api.admin.deleteUser(u.id);
      setUsers((list) => list.filter((x) => x.id !== u.id));
      setTotal((count) => count - 1);
    },
  });

  if (loading) {
    return <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('common.loading')}</div>;
  }

  const canApprove = email.includes('@') && !busy;

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.users.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        {t('admin.users.googleDesc')}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); if (canApprove) approve(); }}
        style={{ display: 'flex', gap: 8, marginBottom: 12 }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('admin.users.addPh')}
          style={{
            flex: 1, padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
          }}
        />
        <button
          type="submit"
          disabled={!canApprove}
          style={{
            padding: '9px 16px', background: 'var(--accent)', border: 'none', borderRadius: 7,
            color: 'var(--accent-text)', fontSize: 13, fontWeight: 500, flexShrink: 0,
            cursor: canApprove ? 'pointer' : 'not-allowed', opacity: canApprove ? 1 : 0.6,
          }}
        >
          {t('admin.users.add')}
        </button>
      </form>

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13,
          background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--red)',
        }}>{error}</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {users.map((u) => {
          const self = u.id === currentUser?.id;
          return (
            <div key={u.id} style={{ ...rowStyle, opacity: u.disabledAt ? 0.6 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {u.email || u.username}
                  </span>
                  {u.isAdmin && (
                    <span style={{ ...badgeStyle, background: 'rgba(124,106,247,0.15)', color: 'var(--accent)' }}>
                      {t('admin.users.adminBadge')}
                    </span>
                  )}
                  {u.disabledAt && (
                    <span style={{ ...badgeStyle, background: 'rgba(248,113,113,0.12)', color: 'var(--red)' }}>
                      {t('admin.users.disabledBadge')}
                    </span>
                  )}
                  {self && <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{t('admin.users.you')}</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
                  {!u.email
                    ? t('admin.users.noEmail')
                    : u.isBootstrapAdmin
                      ? t('admin.users.bootstrapBadge')
                      : t('admin.users.joined', { date: new Date(u.created_at).toLocaleDateString() })}
                </div>
              </div>
              {!self && !u.isBootstrapAdmin && (
                <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                  <button type="button" disabled={busy} onClick={() => toggleAdmin(u)} style={actionStyle}>
                    {u.isAdmin ? t('admin.users.removeAdmin') : t('admin.users.makeAdmin')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => toggleDisabled(u)} style={actionStyle}>
                    {u.disabledAt ? t('admin.users.enable') : t('admin.users.disable')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => remove(u)} style={{ ...actionStyle, color: 'var(--red)' }}>
                    {t('admin.users.deleteUser')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {users.length < total && (
        <button type="button" disabled={busy} onClick={loadMore} style={{ ...actionStyle, marginTop: 10 }}>
          {t('common.loadMore')}
        </button>
      )}
      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the admin panel**

В `frontend/src/components/AdminPanel.jsx`:

1. После `import ConfirmOverlay from './ConfirmOverlay.jsx';` добавить:

```jsx
import GoogleUsersPanel from './GoogleUsersPanel.jsx';
import { isGoogleAuthMode } from '../utils/authMode.js';
```

2. `function UsersTab()` заменить на:

```jsx
function UsersTab() {
  const { t } = useTranslation();
  const { user } = useStore();
  return (
    <SubTabs tabs={[
      { id: 'users', label: t('admin.systemEmail.tabUsers'), content: isGoogleAuthMode(user) ? <GoogleUsersPanel /> : <UsersAndInvitesPanel /> },
      { id: 'systememail', label: t('admin.systemEmail.tabEmail'), content: <SystemEmailSection /> },
    ]} />
  );
}
```

3. В `function SecurityTab()` после `const totpEnabled = user?.totpEnabled;` добавить:

```jsx
  // Google sign-in mode has no passwords, 2FA, recovery email or linked SSO identities.
  const googleAuth = isGoogleAuthMode(user);
```

4. В `SecurityTab` заменить:

```jsx
      {/* Login Protection — admin only */}
      {user?.isAdmin && (
```

на:

```jsx
      {/* Login Protection — admin only */}
      {user?.isAdmin && !googleAuth && (
```

5. Заменить:

```jsx
      {/* Status card */}
      <div style={{
```

на:

```jsx
      {/* Status card */}
      {!googleAuth && (
      <div style={{
```

и:

```jsx
        )}
      </div>

      {/* MFA enforcement — admin only */}
      {user?.isAdmin && (
```

на:

```jsx
        )}
      </div>
      )}

      {/* MFA enforcement — admin only */}
      {user?.isAdmin && !googleAuth && (
```

6. Заменить:

```jsx
      {/* Recovery email — all users */}
      <div style={{
```

на:

```jsx
      {/* Recovery email — all users */}
      {!googleAuth && (
      <div style={{
```

и:

```jsx
        </button>
      </div>

      <LinkedIdentitiesSection />
```

на:

```jsx
        </button>
      </div>
      )}

      {!googleAuth && <LinkedIdentitiesSection />}
```

7. В массиве `TABS` у вкладки `sso` заменить:

```jsx
    id: 'sso', labelKey: 'admin.tabs.sso',
    adminOnly: true,
```

на:

```jsx
    id: 'sso', labelKey: 'admin.tabs.sso',
    adminOnly: true,
    localAuthOnly: true,
```

8. В `makeSearchIndex` заменить `{ label: t('admin.security.totpTitle'), keywords:` на `{ label: t('admin.security.totpTitle'), localAuthOnly: true, keywords:`, `{ label: t('admin.security.ssoTitle'), keywords:` на `{ label: t('admin.security.ssoTitle'), localAuthOnly: true, keywords:`, `{ label: t('admin.sso.title'), keywords:` на `{ label: t('admin.sso.title'), localAuthOnly: true, keywords:`.

9. Строку

```jsx
  const visibleTabs = TABS.filter(tab => (!tab.adminOnly || user?.isAdmin) && (!tab.mobileHidden || !isMobile));
```

заменить на:

```jsx
  const visibleTabs = TABS.filter(tab => (!tab.adminOnly || user?.isAdmin) && (!tab.mobileHidden || !isMobile)
    && (!tab.localAuthOnly || !isGoogleAuthMode(user)));
```

10. В фильтре `searchResults` после строки `        if (item.mobileHidden && isMobile) return false;` добавить:

```jsx
        if (item.localAuthOnly && isGoogleAuthMode(user)) return false;
```

11. Строку `      {adminTab === 'sso' && <SSOTab />}` заменить на:

```jsx
      {adminTab === 'sso' && !isGoogleAuthMode(user) && <SSOTab />}
```

- [ ] **Step 3: Add the translations**

Создать временный `frontend/add-users-locale-keys.mjs` (в git не добавлять):

```js
// One-off: insert the Google users keys at the top of admin.users without reformatting files.
import { readFileSync, writeFileSync } from 'node:fs';

const VALUES = {
  en: {
    googleDesc: 'People listed here can sign in with Google. Every signed-in user works with all mailboxes.',
    addPh: 'Email address to approve',
    add: 'Approve',
    disabledBadge: 'Disabled',
    bootstrapBadge: 'From BOOTSTRAP_ADMIN_EMAILS',
    noEmail: 'No email — cannot sign in',
    disable: 'Disable',
    enable: 'Enable',
  },
  ru: {
    googleDesc: 'Эти люди могут входить через Google. Каждый вошедший пользователь работает со всеми ящиками.',
    addPh: 'Email для одобрения',
    add: 'Одобрить',
    disabledBadge: 'Отключён',
    bootstrapBadge: 'Из BOOTSTRAP_ADMIN_EMAILS',
    noEmail: 'Нет email — вход невозможен',
    disable: 'Отключить',
    enable: 'Включить',
  },
  de: {
    googleDesc: 'Die hier aufgeführten Personen können sich mit Google anmelden. Jeder angemeldete Benutzer arbeitet mit allen Postfächern.',
    addPh: 'Freizugebende E-Mail-Adresse',
    add: 'Freigeben',
    disabledBadge: 'Deaktiviert',
    bootstrapBadge: 'Aus BOOTSTRAP_ADMIN_EMAILS',
    noEmail: 'Keine E-Mail – Anmeldung nicht möglich',
    disable: 'Deaktivieren',
    enable: 'Aktivieren',
  },
  fr: {
    googleDesc: 'Les personnes listées ici peuvent se connecter avec Google. Chaque utilisateur connecté travaille avec toutes les boîtes aux lettres.',
    addPh: 'Adresse e-mail à approuver',
    add: 'Approuver',
    disabledBadge: 'Désactivé',
    bootstrapBadge: 'Issu de BOOTSTRAP_ADMIN_EMAILS',
    noEmail: "Pas d'e-mail — connexion impossible",
    disable: 'Désactiver',
    enable: 'Activer',
  },
  es: {
    googleDesc: 'Las personas de esta lista pueden iniciar sesión con Google. Cada usuario que inicia sesión trabaja con todos los buzones.',
    addPh: 'Correo electrónico que aprobar',
    add: 'Aprobar',
    disabledBadge: 'Desactivado',
    bootstrapBadge: 'Desde BOOTSTRAP_ADMIN_EMAILS',
    noEmail: 'Sin correo: no puede iniciar sesión',
    disable: 'Desactivar',
    enable: 'Activar',
  },
  it: {
    googleDesc: 'Le persone elencate qui possono accedere con Google. Ogni utente che accede lavora con tutte le caselle di posta.',
    addPh: 'Indirizzo email da approvare',
    add: 'Approva',
    disabledBadge: 'Disattivato',
    bootstrapBadge: 'Da BOOTSTRAP_ADMIN_EMAILS',
    noEmail: 'Nessuna email: accesso impossibile',
    disable: 'Disattiva',
    enable: 'Attiva',
  },
  pl: {
    googleDesc: 'Osoby z tej listy mogą logować się przez Google. Każdy zalogowany użytkownik pracuje ze wszystkimi skrzynkami.',
    addPh: 'Adres e-mail do zatwierdzenia',
    add: 'Zatwierdź',
    disabledBadge: 'Wyłączony',
    bootstrapBadge: 'Z listy BOOTSTRAP_ADMIN_EMAILS',
    noEmail: 'Brak e-maila — logowanie niemożliwe',
    disable: 'Wyłącz',
    enable: 'Włącz',
  },
  cs: {
    googleDesc: 'Lidé v tomto seznamu se mohou přihlásit přes Google. Každý přihlášený uživatel pracuje se všemi schránkami.',
    addPh: 'E-mailová adresa ke schválení',
    add: 'Schválit',
    disabledBadge: 'Vypnutý',
    bootstrapBadge: 'Ze seznamu BOOTSTRAP_ADMIN_EMAILS',
    noEmail: 'Bez e-mailu — přihlášení není možné',
    disable: 'Vypnout',
    enable: 'Zapnout',
  },
  zhCN: {
    googleDesc: '此处列出的人员可以使用 Google 登录。每个登录的用户都能处理所有邮箱。',
    addPh: '要批准的邮箱地址',
    add: '批准',
    disabledBadge: '已停用',
    bootstrapBadge: '来自 BOOTSTRAP_ADMIN_EMAILS',
    noEmail: '无邮箱，无法登录',
    disable: '停用',
    enable: '启用',
  },
};

for (const [locale, values] of Object.entries(VALUES)) {
  const file = new URL(`./src/locales/${locale}.json`, import.meta.url);
  const text = readFileSync(file, 'utf8');
  const existing = JSON.parse(text).admin.users;
  for (const key of Object.keys(values)) {
    if (key in existing) throw new Error(`${locale}: admin.users.${key} already exists`);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parent = text.match(/^( {4})"users": \{\r?$/m);
  if (!parent) throw new Error(`${locale}: admin.users block not found`);
  const indent = `${parent[1]}  `;
  const lines = Object.entries(values).map(([key, value]) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)},${eol}`);
  const at = text.indexOf('\n', parent.index) + 1;
  const updated = text.slice(0, at) + lines.join('') + text.slice(at);
  const parsed = JSON.parse(updated).admin.users;
  for (const [key, value] of Object.entries(values)) {
    if (parsed[key] !== value) throw new Error(`${locale}: admin.users.${key} did not round-trip`);
  }
  writeFileSync(file, updated);
}
console.log('admin.users keys added');
```

Run: `cd frontend && node add-users-locale-keys.mjs && rm add-users-locale-keys.mjs`
Expected: `admin.users keys added`.

- [ ] **Step 4: Run frontend checks**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: все тесты проходят (включая `src/locales/i18n.test.js`), lint без предупреждений, сборка успешна.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/GoogleUsersPanel.jsx frontend/src/components/AdminPanel.jsx frontend/src/locales
git commit -m "feat(admin): manage approved users and hide local sign-in settings in Google mode"
```

---

### Task 12: Проверка на настоящей базе, спецификация, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`
- Scratch: `<scratchpad>/auth-smoke.mjs` (не коммитится)

- [ ] **Step 1: Smoke test against Postgres 16**

Сохранить в scratchpad сессии `auth-smoke.mjs`:

```js
import assert from 'node:assert/strict';
import { runMigrations } from './src/services/migrations.js';
import { pool, query, withTransaction } from './src/services/db.js';
import { claimOrCreateUserByEmail, resolveVerifiedUser } from './src/services/auth/userIdentity.js';
import { getAuthSettings } from './src/services/auth/authSettings.js';

await runMigrations();

// Replay 0054 over users created before it.
await query('DROP INDEX IF EXISTS users_email_lower_key');
await query('ALTER TABLE users DROP COLUMN IF EXISTS disabled_by, DROP COLUMN IF EXISTS disabled_at, DROP COLUMN IF EXISTS email');
await query("DELETE FROM schema_migrations WHERE version = '0054_users_email_status'");
await query(`INSERT INTO users (username, password_hash) VALUES
  ('admin@example.com', 'x'), ('team-mail', 'x'), ('Dup@Example.com', 'x'), ('dup@example.com', 'x')`);
await runMigrations();

const emailOf = async (username) => (await query('SELECT email FROM users WHERE username = $1', [username])).rows[0].email;
assert.equal(await emailOf('admin@example.com'), 'admin@example.com');
assert.equal(await emailOf('team-mail'), null);
assert.equal(await emailOf('Dup@Example.com'), null);
assert.equal(await emailOf('dup@example.com'), null);
await assert.rejects(query("UPDATE users SET email = 'ADMIN@example.com' WHERE username = 'team-mail'"), { code: '23505' });

// Approving by email: claim a legacy row, create a new one, refuse a taken username.
await query("INSERT INTO users (username, password_hash) VALUES ('claim@example.com', 'x')");
const claimed = await withTransaction((client) => claimOrCreateUserByEmail(client, 'claim@example.com'));
assert.equal(claimed.claimed, true);
const created = await withTransaction((client) => claimOrCreateUserByEmail(client, 'new@example.com', { isAdmin: true }));
assert.equal(created.created, true);
assert.equal(created.user.is_admin, true);
assert.equal((await query('SELECT password_hash FROM users WHERE id = $1', [created.user.id])).rows[0].password_hash, null);
await query("INSERT INTO users (username, email, password_hash) VALUES ('taken@example.com', 'other@example.com', 'x')");
await assert.rejects(withTransaction((client) => claimOrCreateUserByEmail(client, 'taken@example.com')), { code: 'username_taken' });

// Signing in.
const settings = getAuthSettings({ AUTH_MODE: 'google', BOOTSTRAP_ADMIN_EMAILS: 'boot@example.com' });
assert.deepEqual(await resolveVerifiedUser({ email: 'stranger@example.com', source: 'google', settings }), { error: 'not_allowed' });
const viaEdge = await resolveVerifiedUser({ email: 'Edge@Example.com', source: 'cloudflare', settings });
assert.equal(viaEdge.user.email, 'edge@example.com');
assert.equal(viaEdge.user.is_admin, false);
const boot = await resolveVerifiedUser({ email: 'boot@example.com', source: 'google', settings });
assert.equal(boot.user.is_admin, true);
await query('UPDATE users SET disabled_at = NOW(), disabled_by = $1 WHERE id = $2', [created.user.id, viaEdge.user.id]);
assert.deepEqual(await resolveVerifiedUser({ email: 'edge@example.com', source: 'cloudflare', settings }), { error: 'user_disabled' });

// Concurrent first sign-ins of one address create one user.
const racing = await Promise.all([1, 2, 3].map(() => resolveVerifiedUser({ email: 'race@example.com', source: 'cloudflare', settings })));
assert.equal(new Set(racing.map((result) => result.user.id)).size, 1);

// Deleting the admin who disabled someone keeps the disabled user.
await query('DELETE FROM users WHERE id = $1', [created.user.id]);
const edgeRow = (await query('SELECT disabled_at, disabled_by FROM users WHERE id = $1', [viaEdge.user.id])).rows[0];
assert.ok(edgeRow.disabled_at);
assert.equal(edgeRow.disabled_by, null);

await pool.end();
console.log('auth smoke ok');
```

Run:

```bash
docker network create mailexpert-check
docker run -d --name mailexpert-check-db --network mailexpert-check -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=check -e POSTGRES_DB=mailexpert postgres:16-alpine
docker exec mailexpert-check-db sh -c 'until pg_isready -U mailexpert >/dev/null; do sleep 1; done; sleep 2'
docker network connect mailexpert-check mailexpert-backend-test
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work'
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/auth-smoke.mjs" mailexpert-backend-test:/work/backend/auth-smoke.mjs
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-check-db -e DB_PASSWORD=check mailexpert-backend-test sh -c 'cd /work/backend && node auth-smoke.mjs 2>&1 | tail -5'
```

Expected: последняя строка `auth smoke ok`.

Cleanup:

```bash
docker network disconnect mailexpert-check mailexpert-backend-test
docker rm -f mailexpert-check-db
docker network rm mailexpert-check
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test rm -f /work/backend/auth-smoke.mjs
```

- [ ] **Step 2: Record the clarifications in the spec**

В `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`:

1. Первую строку статуса заменить на:

```markdown
> Статус: дизайн одобрен 2026-09-15; PR 1 (вход) реализован. Работы по нескольким Google OAuth-приложениям (PR 2–5 из `2026-09-15-google-multi-app-design.md`) приостановлены до PR 3 этого документа и затем переписываются под общий список ящиков.
```

2. Перед разделом `## Проверка` добавить:

```markdown
## Уточнения, принятые при реализации PR 1

- Redirect URI по origin запроса меняется только у Google-ящиков: путь берётся из `GOOGLE_REDIRECT_URI`. Microsoft-ящики остаются с одним `MS_REDIRECT_URI`.
- Сессия, открытая через Cloudflare, принимается только вместе с токеном Access. Без заголовка засчитывается лишь сессия прямого входа.
- WebSocket не меняет сессию: токен Access при подключении должен принадлежать пользователю, уже записанному в сессию.
- До PR 3 в режиме `google` нельзя удалить пользователя, у которого есть ящики (409 `user_has_mailboxes`): каскад удалил бы его ящики.
- Публичные пути в режиме `google`: `/api/health`, `/api/version`, `/api/update`, `/api/auth/config`, `/api/auth/logout`, `/oauth/login/google`, `/oauth/login/google/callback`.
- В режиме `google` также отвечают 404 `/api/auth/profile/recovery-email` и `/api/admin/users/:id/totp/disable`.
- Прямой вход пишет событие `sso_login` в `auth_events`.
```

- [ ] **Step 3: Full gate**

Run: `bt` (все backend-тесты), затем та же команда с `npm run lint && npm run lint:plugins` вместо `npx vitest run`.
Expected: все тесты проходят, lint чистый.

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: PASS.

`git status --short` не должен показывать `agent-changes/`, `.superpowers/` или временные `.mjs`.

- [ ] **Step 4: Commit, push, PR**

```bash
git add docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md
git commit -m "docs: record the sign-in details settled while building it"
git push -u origin HEAD
gh pr create --repo wyrtensi/MailExpert --base main --title "feat(auth): sign in only approved users through Google and Cloudflare Access" --body-file <scratchpad>/pr1-body.md
```

`<scratchpad>/pr1-body.md`:

```markdown
First step of `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`: mailboxes become shared and people sign in only after an admin approves them. This PR covers sign-in; mailboxes still belong to their owner until PR 3.

## What changes

- `AUTH_MODE=google` (default stays `local`):
  - Cloudflare Access assertions are verified on every request (RS256 against the team's certs, issuer and audience from env, with a resilient key cache);
  - "Sign in with Google" works on a host without Cloudflare (`/oauth/login/google`, PKCE, `openid email`);
  - only users an admin approved by email get in, `BOOTSTRAP_ADMIN_EMAILS` are always admins;
  - the user row is read on every request, so disabling someone ends their access, sessions and WebSockets at once;
  - password login, 2FA, OIDC, registration, invites, password reset and the built-in CardDAV server answer 404.
- Admin → Users in Google mode: approve by email, disable/enable, admin toggle, delete. The last reachable admin and bootstrap admins are protected.
- `APP_ALT_URLS`: WebSocket origins and the Gmail OAuth callback accept a second public origin.
- Both modes: disabled users get 403; password reset and invite mail no longer fall back to a team mailbox.

## Not yet

- Mailboxes, rules, contacts and events are still per owner (PR 2–3). Do not switch production to `AUTH_MODE=google` before PR 3.
- Access policy sync (PR 6) and the two-host runbook (PR 7).

## Checks

- Backend: unit tests for settings, identity, Access verification, the identity gate, direct sign-in, WebSocket authorization and the admin user API; full suite and lint.
- Postgres 16 smoke: migration backfill over existing users, approval by email, sign-in resolution, concurrent first sign-in, disabled users.
- Frontend: tests, lint, build.
```

- [ ] **Step 5: Watch checks and merge**

```bash
gh pr checks --repo wyrtensi/MailExpert --watch
gh pr merge --repo wyrtensi/MailExpert --merge --delete-branch
git switch main && git pull --ff-only
```

Expected: все проверки зелёные до merge; после pull `main` содержит merge-коммит PR.

- [ ] **Step 6: Handoff and cleanup**

Дописать в локальный `agent-changes/2026-09-14-deps-oauth-handoff.md` (не коммитить) строку с номером PR, merge-коммитом и напоминанием: не включать `AUTH_MODE=google` до PR 3. Удалить тестовый контейнер: `docker rm -f mailexpert-backend-test`.

---

## Self-review

**Покрытие спецификации (пункт 1 «Разбиения на PR»):**
- `AUTH_MODE`, переменные окружения, отказ старта без способа входа — Task 2.
- Проверка JWT Cloudflare Access с кешем ключей — Task 4; применение на каждом запросе, 401/403, пересоздание сессии — Task 3 (`bindSessionUser`) и Task 5.
- Прямой вход через Google, `email_verified`, redirect по origin из `APP_URL`/`APP_ALT_URLS` — Task 1 и Task 6.
- Автосоздание через Cloudflare, `not_allowed` на прямом входе, bootstrap-админы — Task 3.
- `users.email`, `disabled_at`, `disabled_by`, перенос `username` → `email` — Task 3 (миграция), Task 12 (проверка на Postgres).
- Статус на каждом запросе — Task 5 (`identityGate`, `requireAuth`, `requireAdmin`); закрытие WebSocket — Task 8 и Task 9.
- Выход через `/cdn-cgi/access/logout` — Task 7.
- Отключение локальных входов и CardDAV-сервера в режиме `google` — Task 5; скрытие в интерфейсе — Task 11.
- Удаление резервной отправки системных писем через ящики — Task 7 (сброс пароля) и Task 9 (приглашения).
- Экран входа — Task 10; управление пользователями и защита последнего/bootstrap-админа — Task 9 и Task 11.
- `APP_ALT_URLS` для WebSocket и OAuth-ящиков — Task 1.

**Проверка на заглушки:** «TBD», «TODO», «аналогично Task N» и шагов без кода нет; единственные «условные» правки — удаление неиспользуемых импортов, которые показывает lint (Task 9, Step 3).

**Согласованность имён:** `getAuthSettings` → `{ mode, cloudflare, googleSignIn, bootstrapAdminEmails }` одинаково в Task 2, 5, 6, 7, 8, 9; `resolveVerifiedUser({ email, source, settings })` → `{ user } | { error }` в Task 3, 5, 6; `bindSessionUser(req, user, authMethod)` и `authMethod ∈ { 'cloudflare', 'google' }` в Task 3, 5, 6, 8; `verifyCloudflareAccessToken(token, { issuer, audience }, { jwks })` в Task 4, 5, 8; `claimOrCreateUserByEmail(client, email, { isAdmin })` → `{ user, created, claimed }` в Task 3, 9 и smoke; `closeUserSockets(wss, userId)` в Task 8, 9; `PublicUser.disabledAt`/`isBootstrapAdmin` в Task 9 и Task 11; `/api/auth/config` → `googleSignIn` в Task 7 и `GoogleLoginPage`.
