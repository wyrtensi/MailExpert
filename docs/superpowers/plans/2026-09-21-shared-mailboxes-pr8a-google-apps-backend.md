# Общие ящики, PR 8a: бэкенд нескольких Google-приложений — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** выбирать Google-приложение для каждого подключения с учётом лимита в 100 пользователей, дать администратору API для приложений и новый поток «Добавить Gmail» (`start` → `launch` → callback) с переподключением по id ящика, не ломая текущий интерфейс.

**Architecture:** выбор приложения и брони живут в новом модуле `services/oauth/googleAppSelection.js` (транзакция Postgres под advisory lock + sorted set в Redis). Администрирование приложений — функции в `googleApps.js` и маршрут `/api/admin/google-apps`. Старт добавления идёт под `/api` (CSRF-заголовок, блокировка экрана), переход к Google — через одноразовый ключ `flow` под `/oauth/google/launch`. Callback знает режим потока (`add`, `reconnect`, `upsert`) из OAuth state и отказывает по новым кодам, отзывая выданный токен, когда ящика этого email в приложении нет.

**Tech Stack:** Node.js 22 (ESM), Express 5, PostgreSQL 16, Redis (node-redis 6), vitest 5, jose; фронтенд — `node --test`, react-i18next.

**Spec:** `docs/superpowers/specs/2026-09-15-google-multi-app-design.md` (разделы «Занятые места и брони», «Выбор приложения», «Потоки подключения», «Администрирование приложений», «Безопасность и логи», «Тесты», «Совместимость между PR») с поправками PR 8 из `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` (раздел «Разбиение на PR», пункт 8).

## Global Constraints

- Комментарии в коде, коммиты, тексты PR — на английском. Без эмодзи.
- Коммиты и PR от имени `wyrtensi`, без строк атрибуции; все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- Секреты, токены, коды авторизации и тексты ответов Google не попадают в логи, URL, ответы API и ошибки. Email в логах — только через `redactEmail`, в Redis-ключах и членах множеств — только SHA-256 от email в нижнем регистре.
- Ящики общие: «уже подключён» означает, что ящик с этим email (`lower(email_address)`) есть в установке. Никаких проверок «ящик принадлежит пользователю». Переподключение по id ящика доступно любому вошедшему пользователю.
- Advisory lock на создание и обновление Google-ящика — `oauth-account:<email в нижнем регистре>` (уже так в коде; в спецификации написано `<userId>:<email>`, это устарело).
- Advisory lock выбора приложения — `pg_advisory_xact_lock(hashtext('google-oauth-app-selection'))`; lock реестра приложений — `hashtext('google-oauth-app-import')` (уже используется в `googleApps.js`).
- Бронь — Redis sorted set `oauth:google:reservations:<appId>`, member — SHA-256 hex от email в нижнем регистре, score — время истечения в миллисекундах (сейчас + `OAUTH_STATE_TTL_SECONDS` × 1000).
- Ключ перехода — `oauth:google:launch:<sha256 hex от flow>`, TTL 60 секунд, `flow` — 32 случайных байта в base64url (43 символа).
- Callback возвращается на хост, с которого начато подключение: redirect URI строится через `resolveGoogleConfig({ appId, origin: allowedRequestOrigin(req) })`, как сейчас.
- Совместимость до PR 8c: `GET /oauth/google` без параметров и с `?login_hint=<email>` продолжают работать (их вызывают `GoogleIntegrationSection.jsx` и `utils/accountHealth.js`). До PR 8b `POST/DELETE /api/integrations/google` работают как сейчас.
- Доменный почтовый сервер (`domain_mail`, `kind: 'domain'`) в PR 8 не входит — перенесён в PR 9. Ограничение ручного добавления ящика администратором (`POST /api/accounts` без `kind`) делается в PR 8c вместе с новым диалогом, не здесь.
- Монки-патчинг запрещён; глобальный `fetch` подменяется только через `vi.stubGlobal`, как в `googleOAuth.test.js`.
- Не трогать запущенные контейнеры пользователя (`mailexpert-frontend`, `mailexpert-backend`, `mailexpert-postgres`, `mailexpert-redis`, контейнеры других проектов на хосте).

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

Фронтенд — локально: `cd frontend && node --test <files>`; весь набор — `cd frontend && npm test`.

## Файлы

| Файл | Что меняется |
|---|---|
| `backend/src/services/oauth/googleOAuth.js` | `revokeGoogleToken(token)` |
| `backend/src/services/oauth/googleAppSelection.js` (новый) | брони, `selectGoogleApp`, `googleHasCapacity`, `GoogleAppSelectionError` |
| `backend/src/services/oauth/googleApps.js` | `listGoogleApps`, `createGoogleApp`, `updateGoogleApp`, `deleteGoogleApp`, `findKnownGoogleEmails` |
| `backend/src/routes/googleAppsAdmin.js` (новый) | `/api/admin/google-apps` |
| `backend/src/routes/admin.js` | монтирование `googleAppsAdmin` |
| `backend/src/services/oauth/oauthState.js` | поля `mode`, `email`, `accountId` в state |
| `backend/src/services/oauth/googleLaunch.js` (новый) | одноразовый ключ перехода |
| `backend/src/routes/oauthGoogleApi.js` (новый) | `POST /api/oauth/google/start`, `GET /api/oauth/google/known-emails` |
| `backend/src/index.js` | монтирование `/api/oauth/google` |
| `backend/src/routes/oauthGoogle.js` | `launch`, переподключение по `account`, совместимость `login_hint`, новый callback |
| `backend/src/routes/integrations.js` | `google.available` в `/status` |
| `frontend/src/utils/googleOAuth.js`, `frontend/src/locales/{en,ru}.json` | тексты новых кодов callback |
| спецификации | статус и «Уточнения, принятые при реализации PR 8» |

---

### Task 1: Отзыв токена Google

**Files:**
- Modify: `backend/src/services/oauth/googleOAuth.js`
- Test: `backend/src/services/oauth/googleOAuth.test.js`

**Interfaces:**
- Produces: `export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'`; `export async function revokeGoogleToken(token): Promise<boolean>` — никогда не бросает исключений.

- [ ] **Step 1: Write the failing test** — добавить в конец `googleOAuth.test.js` (импорт `revokeGoogleToken`, `GOOGLE_REVOKE_URL` добавить к существующему импорту из `./googleOAuth.js`; `jsonRes` уже определён в файле — если его сигнатура другая, использовать `{ ok, status, json: async () => ({}) }`):

```js
describe('revokeGoogleToken', () => {
  let errorSpy;
  beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errorSpy.mockRestore(); vi.unstubAllGlobals(); });

  it('posts the token in the form body, never in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(revokeGoogleToken('tok-123')).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GOOGLE_REVOKE_URL);
    expect(url).not.toContain('tok-123');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('token=tok-123');
  });

  it('returns false and logs only the status when Google refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await expect(revokeGoogleToken('tok-123')).resolves.toBe(false);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('400');
    expect(logged).not.toContain('tok-123');
  });

  it('never throws on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down tok-123')));
    await expect(revokeGoogleToken('tok-123')).resolves.toBe(false);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('tok-123');
  });

  it('does not call Google without a token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(revokeGoogleToken(null)).resolves.toBe(false);
    await expect(revokeGoogleToken('')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/services/oauth/googleOAuth.test.js`
Expected: FAIL — `revokeGoogleToken is not a function` (или `undefined` при импорте).

- [ ] **Step 3: Write minimal implementation** — после `GOOGLE_SIGN_IN_SCOPES` добавить константу, после `refreshGoogleToken` — функцию:

```js
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
```

```js
// Revoke a token Google issued. Best effort: it never throws, and only the HTTP status or the
// error class is logged, so neither the token nor Google's response ends up in the logs.
export async function revokeGoogleToken(token) {
  if (typeof token !== 'string' || !token) return false;
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`Google token revoke failed: HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error(`Google token revoke failed: ${err?.name || 'Error'}`);
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bt src/services/oauth/googleOAuth.test.js`
Expected: PASS, все тесты файла.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/oauth/googleOAuth.js backend/src/services/oauth/googleOAuth.test.js
git commit -m "feat(google-oauth): revoke a token Google issued"
```

---

### Task 2: Выбор приложения и брони

**Files:**
- Create: `backend/src/services/oauth/googleAppSelection.js`
- Test: `backend/src/services/oauth/googleAppSelection.test.js`

**Interfaces:**
- Consumes: `withTransaction`, `query` из `../db.js`; `redisClient` из `../redis.js`; `OAUTH_STATE_TTL_SECONDS` из `./oauthState.js`.
- Produces:
  - `export class GoogleAppSelectionError extends Error` с полем `code` (`'no_app_capacity'` | `'not_configured'`);
  - `export function googleEmailDigest(email): string` — SHA-256 hex от `email.trim().toLowerCase()`;
  - `export async function countGoogleReservations(appId, now = Date.now()): Promise<number>`;
  - `export async function releaseGoogleSeat(appId, email): Promise<void>` — ничего не делает без `appId` или `email`, ошибки Redis глотает с логом класса ошибки;
  - `export async function selectGoogleApp({ email = null, account = null } = {}): Promise<{ appId: string, reserved: boolean }>`;
  - `export async function googleHasCapacity(): Promise<boolean>`.

Правила `selectGoogleApp` (спецификация, «Выбор приложения»), всё внутри `withTransaction` после `SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-selection'))`:
1. Нет приложений не в `disabled` → `not_configured`.
2. `account?.oauth_app_id` указывает на приложение не в `disabled` → оно, без брони.
3. У `email` есть запись журнала в приложении не в `disabled` → самое раннее такое, без брони.
4. У `email` есть живая бронь в `active`-приложении → оно, бронь продлевается (второе место не занимается).
5. Первое по `created_at, id` `active`-приложение, у которого `grants + живые брони < user_limit` → оно; если `email` задан, ставится бронь (`reserved: true`), иначе без брони.
6. Иначе `no_app_capacity`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
// In-memory sorted sets with the node-redis 6 method names this module uses.
const zsets = vi.hoisted(() => new Map());
vi.mock('../redis.js', () => {
  const set = (key) => { if (!zsets.has(key)) zsets.set(key, new Map()); return zsets.get(key); };
  return {
    redisClient: {
      zAdd: vi.fn(async (key, { score, value }) => { set(key).set(value, score); return 1; }),
      zRem: vi.fn(async (key, value) => (set(key).delete(value) ? 1 : 0)),
      zScore: vi.fn(async (key, value) => set(key).get(value) ?? null),
      zCard: vi.fn(async (key) => set(key).size),
      zRemRangeByScore: vi.fn(async (key, _min, max) => {
        let removed = 0;
        for (const [member, score] of set(key)) if (score <= max) { set(key).delete(member); removed += 1; }
        return removed;
      }),
      expire: vi.fn(async () => true),
    },
  };
});

const { query, withTransaction } = await import('../db.js');
const {
  GoogleAppSelectionError, googleEmailDigest, countGoogleReservations,
  releaseGoogleSeat, selectGoogleApp, googleHasCapacity,
} = await import('./googleAppSelection.js');

const app = (id, extra = {}) => ({ id, status: 'active', user_limit: 100, grants: 0, granted: false, ...extra });
const key = (id) => `oauth:google:reservations:${id}`;

// The selection transaction runs the lock, then one query returning the apps.
function installApps(apps) {
  const client = {
    query: vi.fn(async (sql) => {
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/FROM google_oauth_apps/.test(sql)) return { rows: apps };
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  withTransaction.mockImplementation(async (fn) => fn(client));
  query.mockImplementation(async (sql) => {
    if (/FROM google_oauth_apps/.test(sql)) return { rows: apps };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return client;
}

beforeEach(() => {
  zsets.clear();
  query.mockReset();
  withTransaction.mockReset();
});

describe('selectGoogleApp', () => {
  it('serializes selection under the advisory lock', async () => {
    const client = installApps([app('a1')]);
    await selectGoogleApp({ email: 'x@gmail.com' });
    expect(client.query.mock.calls[0][0]).toMatch(/pg_advisory_xact_lock\(hashtext\('google-oauth-app-selection'\)\)/);
  });

  it('keeps a reconnecting mailbox on its own app while that app is not disabled', async () => {
    installApps([app('a1'), app('a2', { status: 'closed' })]);
    await expect(selectGoogleApp({ email: 'x@gmail.com', account: { oauth_app_id: 'a2' } }))
      .resolves.toEqual({ appId: 'a2', reserved: false });
  });

  it('moves a mailbox off a disabled app', async () => {
    installApps([app('a1', { status: 'disabled' }), app('a2')]);
    await expect(selectGoogleApp({ email: 'x@gmail.com', account: { oauth_app_id: 'a1' } }))
      .resolves.toEqual({ appId: 'a2', reserved: true });
  });

  it('reuses the app that already counted this email, spending no seat', async () => {
    installApps([app('a1'), app('a2', { status: 'closed', granted: true })]);
    await expect(selectGoogleApp({ email: 'x@gmail.com' })).resolves.toEqual({ appId: 'a2', reserved: false });
    expect(zsets.get(key('a1'))?.size ?? 0).toBe(0);
  });

  it('reserves a seat in the first active app with room', async () => {
    installApps([app('a1', { user_limit: 2, grants: 2 }), app('a2')]);
    await expect(selectGoogleApp({ email: 'X@Gmail.com' })).resolves.toEqual({ appId: 'a2', reserved: true });
    expect(zsets.get(key('a2')).has(googleEmailDigest('x@gmail.com'))).toBe(true);
  });

  it('counts live reservations as taken seats', async () => {
    installApps([app('a1', { user_limit: 1 }), app('a2')]);
    await selectGoogleApp({ email: 'first@gmail.com' });
    await expect(selectGoogleApp({ email: 'second@gmail.com' })).resolves.toEqual({ appId: 'a2', reserved: true });
  });

  it('a repeated start for the same email does not take a second seat', async () => {
    installApps([app('a1', { user_limit: 1 })]);
    await selectGoogleApp({ email: 'same@gmail.com' });
    await expect(selectGoogleApp({ email: 'same@gmail.com' })).resolves.toEqual({ appId: 'a1', reserved: true });
    expect(zsets.get(key('a1')).size).toBe(1);
  });

  it('ignores expired reservations', async () => {
    installApps([app('a1', { user_limit: 1 })]);
    zsets.set(key('a1'), new Map([[googleEmailDigest('old@gmail.com'), Date.now() - 1]]));
    await expect(selectGoogleApp({ email: 'new@gmail.com' })).resolves.toEqual({ appId: 'a1', reserved: true });
  });

  it('never picks a closed app for a new email', async () => {
    installApps([app('a1', { status: 'closed' })]);
    await expect(selectGoogleApp({ email: 'x@gmail.com' })).rejects.toMatchObject({ code: 'no_app_capacity' });
  });

  it('reports no_app_capacity when every active app is full', async () => {
    installApps([app('a1', { user_limit: 1, grants: 1 })]);
    const err = await selectGoogleApp({ email: 'x@gmail.com' }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAppSelectionError);
    expect(err.code).toBe('no_app_capacity');
  });

  it('reports not_configured when there is no app or every app is disabled', async () => {
    installApps([]);
    await expect(selectGoogleApp({ email: 'x@gmail.com' })).rejects.toMatchObject({ code: 'not_configured' });
    installApps([app('a1', { status: 'disabled' })]);
    await expect(selectGoogleApp({ email: 'x@gmail.com' })).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('without an email picks an app with room but reserves nothing', async () => {
    installApps([app('a1')]);
    await expect(selectGoogleApp()).resolves.toEqual({ appId: 'a1', reserved: false });
    expect(zsets.get(key('a1'))?.size ?? 0).toBe(0);
  });
});

describe('reservations', () => {
  it('stores only a hash of the email', async () => {
    installApps([app('a1')]);
    await selectGoogleApp({ email: 'secret@gmail.com' });
    const members = [...zsets.get(key('a1')).keys()];
    expect(members).toEqual([googleEmailDigest('secret@gmail.com')]);
    expect(JSON.stringify(members)).not.toContain('secret');
  });

  it('releaseGoogleSeat frees the seat and tolerates missing input', async () => {
    installApps([app('a1')]);
    await selectGoogleApp({ email: 'x@gmail.com' });
    await releaseGoogleSeat('a1', 'X@gmail.com');
    await expect(countGoogleReservations('a1')).resolves.toBe(0);
    await expect(releaseGoogleSeat(null, 'x@gmail.com')).resolves.toBeUndefined();
    await expect(releaseGoogleSeat('a1', null)).resolves.toBeUndefined();
  });
});

describe('googleHasCapacity', () => {
  it('is true only when an active app has a free seat', async () => {
    installApps([app('a1', { user_limit: 1, grants: 1 }), app('a2', { status: 'closed' })]);
    await expect(googleHasCapacity()).resolves.toBe(false);
    installApps([app('a1', { user_limit: 1, grants: 1 }), app('a2')]);
    await expect(googleHasCapacity()).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bt src/services/oauth/googleAppSelection.test.js`
Expected: FAIL — модуль `./googleAppSelection.js` не найден.

- [ ] **Step 3: Write minimal implementation** — `backend/src/services/oauth/googleAppSelection.js`:

```js
import { createHash } from 'crypto';
import { query, withTransaction } from '../db.js';
import { redisClient } from '../redis.js';
import { OAUTH_STATE_TTL_SECONDS } from './oauthState.js';

// Which Google OAuth app a consent flow goes through. An unverified app accepts at most
// user_limit distinct Google accounts for its whole life, so a seat is taken by every email the
// app has ever issued tokens to (google_oauth_grants) plus the flows started but not finished
// (reservations in Redis). Selection runs under one advisory lock so two backend processes
// cannot both hand out an app's last seat.

const SELECTION_LOCK = "SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-selection'))";
const APPS_WITH_SEATS = `
  SELECT a.id, a.status, a.user_limit,
         (SELECT count(*) FROM google_oauth_grants g WHERE g.app_id = a.id)::int AS grants,
         EXISTS (SELECT 1 FROM google_oauth_grants g WHERE g.app_id = a.id AND g.email = lower($1)) AS granted
  FROM google_oauth_apps a
  ORDER BY a.created_at, a.id`;

export class GoogleAppSelectionError extends Error {
  constructor(code) {
    super(`Google OAuth app selection failed: ${code}`);
    this.name = 'GoogleAppSelectionError';
    this.code = code;
  }
}

const reservationKey = (appId) => `oauth:google:reservations:${appId}`;

// Reservations name an email only by its hash, so Redis never holds the address itself.
export function googleEmailDigest(email) {
  return createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

// Live reservations of one app. Expired ones are dropped on every count.
export async function countGoogleReservations(appId, now = Date.now()) {
  const key = reservationKey(appId);
  await redisClient.zRemRangeByScore(key, '-inf', now);
  return redisClient.zCard(key);
}

async function hasLiveReservation(appId, email, now) {
  const expiresAt = await redisClient.zScore(reservationKey(appId), googleEmailDigest(email));
  return expiresAt !== null && Number(expiresAt) > now;
}

// A repeated start for the same email refreshes its one reservation instead of adding another.
async function reserveSeat(appId, email, now) {
  const key = reservationKey(appId);
  await redisClient.zAdd(key, { score: now + OAUTH_STATE_TTL_SECONDS * 1000, value: googleEmailDigest(email) });
  // The set itself never outlives its newest reservation.
  await redisClient.expire(key, OAUTH_STATE_TTL_SECONDS);
}

// Called on the callback whatever its outcome, before the grant is journaled, so one email is
// never counted both as a reservation and as a grant.
export async function releaseGoogleSeat(appId, email) {
  if (!appId || !email) return;
  try {
    await redisClient.zRem(reservationKey(appId), googleEmailDigest(email));
  } catch (err) {
    console.error(`Google OAuth reservation release failed: ${err?.name || 'Error'}`);
  }
}

async function hasFreeSeat(app, now) {
  return app.grants + await countGoogleReservations(app.id, now) < app.user_limit;
}

export async function selectGoogleApp({ email = null, account = null } = {}) {
  return withTransaction(async (client) => {
    await client.query(SELECTION_LOCK);
    const { rows } = await client.query(APPS_WITH_SEATS, [email]);
    const usable = rows.filter((app) => app.status !== 'disabled');
    if (!usable.length) throw new GoogleAppSelectionError('not_configured');

    // A reconnect stays where its refresh token lives.
    const own = account?.oauth_app_id ? usable.find((app) => app.id === account.oauth_app_id) : null;
    if (own) return { appId: own.id, reserved: false };

    // Google already counted this email in that app: going back there costs no seat.
    const known = email ? usable.find((app) => app.granted) : null;
    if (known) return { appId: known.id, reserved: false };

    const now = Date.now();
    const active = usable.filter((app) => app.status === 'active');
    if (email) {
      for (const app of active) {
        if (await hasLiveReservation(app.id, email, now)) {
          await reserveSeat(app.id, email, now);
          return { appId: app.id, reserved: true };
        }
      }
    }
    for (const app of active) {
      if (await hasFreeSeat(app, now)) {
        if (!email) return { appId: app.id, reserved: false };
        await reserveSeat(app.id, email, now);
        return { appId: app.id, reserved: true };
      }
    }
    throw new GoogleAppSelectionError('no_app_capacity');
  });
}

// Whether a new Gmail address can be connected right now. A hint for the UI, not a promise:
// selection itself decides under the lock.
export async function googleHasCapacity() {
  const { rows } = await query(APPS_WITH_SEATS, [null]);
  const now = Date.now();
  for (const app of rows.filter((a) => a.status === 'active')) {
    if (await hasFreeSeat(app, now)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bt src/services/oauth/googleAppSelection.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/oauth/googleAppSelection.js backend/src/services/oauth/googleAppSelection.test.js
git commit -m "feat(google-oauth): pick an app with a free seat and reserve it"
```

---

### Task 3: Реестр приложений и `/api/admin/google-apps`

**Files:**
- Modify: `backend/src/services/oauth/googleApps.js`
- Create: `backend/src/routes/googleAppsAdmin.js`
- Modify: `backend/src/routes/admin.js` (рядом с `router.use('/access-sync', accessSyncRoutes);`)
- Test: `backend/src/services/oauth/googleApps.test.js`, `backend/src/routes/googleAppsAdmin.test.js` (новый)

**Interfaces:**
- Consumes: `countGoogleReservations` из `./googleAppSelection.js` (Task 2); существующие `parseGoogleClientId`, `setGoogleAppStatus`, `GoogleAppError`, `GOOGLE_APP_STATUSES`.
- Produces (в `googleApps.js`):
  - `listGoogleApps(): Promise<Array<{ id, label, client_id, project_number, user_limit, status, created_at, grants_count, accounts_count }>>` — без `client_secret`;
  - `createGoogleApp({ label, clientId, clientSecret, userLimit }): Promise<row без client_secret>`; ошибки `GoogleAppError`: `label_invalid`, `client_id_invalid`, `client_secret_required`, `user_limit_invalid`, `app_exists`, `app_same_project`;
  - `updateGoogleApp(id, { label, clientSecret, userLimit }): Promise<row без client_secret>` — `undefined` поле не меняется, `clientSecret` `null`/`''` сохраняет прежний; ошибки `label_invalid`, `user_limit_invalid`, `app_not_found`;
  - `deleteGoogleApp(id): Promise<void>`; ошибки `app_in_use`, `app_not_found`;
  - `findKnownGoogleEmails(q): Promise<string[]>` (используется в Task 4).
- Produces (HTTP): `GET /api/admin/google-apps` → `{ apps: [{ id, label, clientId, projectNumber, userLimit, status, grantsCount, reservedCount, accountsCount, full, createdAt }] }`; `POST` → `201 { app }`; `PATCH /:id` → `{ app }`; `DELETE /:id` → `{ ok: true }`; ошибки — `{ error, code }`.

Правила полей: `label` — строка после `trim()` длиной 1–100; `userLimit` — целое > 0 (по умолчанию 100); `status` в `PATCH` — из `GOOGLE_APP_STATUSES`, иначе `app_status_invalid`. Секрет, содержащий `•`, но не равный `REDACTED_SECRET`, — `400 client_secret_redacted` (так же, как в `integrations.js`); ровно `REDACTED_SECRET` или пусто — сохранить прежний.

- [ ] **Step 1: Write the failing tests**

В `googleApps.test.js` (добавить новые имена к импорту из `./googleApps.js`; `scriptedClient` и `APP` уже есть в файле):

```js
describe('app registry for the admin screen', () => {
  it('lists apps with seat and mailbox counts and never selects the secret', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'app-1', grants_count: 3, accounts_count: 2 }] });
    const apps = await listGoogleApps();
    expect(apps).toEqual([{ id: 'app-1', grants_count: 3, accounts_count: 2 }]);
    expect(query.mock.calls[0][0]).not.toMatch(/client_secret/);
  });

  it('creates an app with an encrypted secret under the registry lock', async () => {
    const { client, calls } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/WHERE client_id = \$1/, { rows: [] }],
      [/WHERE project_number = \$1/, { rows: [] }],
      [/INSERT INTO google_oauth_apps/, (p) => ({ rows: [{ id: 'app-2', label: p[0], client_id: p[1] }] })],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    const created = await createGoogleApp({ label: ' Google 2 ', clientId: CLIENT_ID, clientSecret: 's3cret' });
    expect(created).toEqual({ id: 'app-2', label: 'Google 2', client_id: CLIENT_ID });
    const insert = calls.find(([sql]) => /INSERT INTO google_oauth_apps/.test(sql));
    expect(insert[1]).toEqual(['Google 2', CLIENT_ID, 'enc(s3cret)', '123456789012', 100]);
    expect(insert[0]).not.toMatch(/RETURNING[^;]*client_secret/);
  });

  it.each([
    [{ label: '', clientId: CLIENT_ID, clientSecret: 's' }, 'label_invalid'],
    [{ label: 'x'.repeat(101), clientId: CLIENT_ID, clientSecret: 's' }, 'label_invalid'],
    [{ label: 'G', clientId: 'nope', clientSecret: 's' }, 'client_id_invalid'],
    [{ label: 'G', clientId: CLIENT_ID, clientSecret: '' }, 'client_secret_required'],
    [{ label: 'G', clientId: CLIENT_ID, clientSecret: 's', userLimit: 0 }, 'user_limit_invalid'],
    [{ label: 'G', clientId: CLIENT_ID, clientSecret: 's', userLimit: 1.5 }, 'user_limit_invalid'],
  ])('rejects %j with %s before touching the database', async (input, code) => {
    await expect(createGoogleApp(input)).rejects.toMatchObject({ code });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('refuses a client ID already added, then a second client of the same project', async () => {
    let { client } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/WHERE client_id = \$1/, { rows: [{ id: 'app-1' }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    await expect(createGoogleApp({ label: 'G', clientId: CLIENT_ID, clientSecret: 's' })).rejects.toMatchObject({ code: 'app_exists' });

    ({ client } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/WHERE client_id = \$1/, { rows: [] }],
      [/WHERE project_number = \$1/, { rows: [{ id: 'app-1' }] }],
    ]));
    withTransaction.mockImplementation(async (fn) => fn(client));
    await expect(createGoogleApp({ label: 'G', clientId: '123456789012-other.apps.googleusercontent.com', clientSecret: 's' }))
      .rejects.toMatchObject({ code: 'app_same_project' });
  });

  it('updates only the fields given and keeps the secret when none is sent', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'app-1', label: 'Renamed' }] });
    await updateGoogleApp('app-1', { label: 'Renamed' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/COALESCE\(\$3, client_secret\)/);
    expect(params).toEqual(['app-1', 'Renamed', null, null]);
  });

  it('encrypts a new secret on update and reports a missing app', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(updateGoogleApp('app-9', { clientSecret: 'new' })).rejects.toMatchObject({ code: 'app_not_found' });
    expect(query.mock.calls[0][1]).toEqual(['app-9', null, 'enc(new)', null]);
  });

  it('deletes only an app without mailboxes', async () => {
    let { client } = scriptedClient([
      [/FROM email_accounts WHERE oauth_app_id = \$1/, { rows: [{ n: 1 }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    await expect(deleteGoogleApp('app-1')).rejects.toMatchObject({ code: 'app_in_use' });

    ({ client } = scriptedClient([
      [/FROM email_accounts WHERE oauth_app_id = \$1/, { rows: [{ n: 0 }] }],
      [/DELETE FROM google_oauth_apps/, { rows: [], rowCount: 0 }],
    ]));
    withTransaction.mockImplementation(async (fn) => fn(client));
    await expect(deleteGoogleApp('app-9')).rejects.toMatchObject({ code: 'app_not_found' });
  });
});

describe('findKnownGoogleEmails', () => {
  it('searches grants without a mailbox, escaping LIKE wildcards', async () => {
    query.mockResolvedValueOnce({ rows: [{ email: 'a_b@gmail.com' }] });
    await expect(findKnownGoogleEmails('A_B%')).resolves.toEqual(['a_b@gmail.com']);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['a\\_b\\%']);
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/LIMIT 8/);
    expect(sql).toMatch(/ESCAPE/);
  });
});
```

`backend/src/routes/googleAppsAdmin.test.js`:

```js
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const registry = vi.hoisted(() => ({
  listGoogleApps: vi.fn(),
  createGoogleApp: vi.fn(),
  updateGoogleApp: vi.fn(),
  deleteGoogleApp: vi.fn(),
  setGoogleAppStatus: vi.fn(async () => []),
}));
vi.mock('../services/oauth/googleApps.js', () => {
  class GoogleAppError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  return { ...registry, GoogleAppError, GOOGLE_APP_STATUSES: ['active', 'closed', 'disabled'] };
});
vi.mock('../services/oauth/googleAppSelection.js', () => ({
  countGoogleReservations: vi.fn(async () => 1),
}));

import express from 'express';
import googleAppsAdminRoutes from './googleAppsAdmin.js';
import { GoogleAppError } from '../services/oauth/googleApps.js';

const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const manager = { disconnectAccount: vi.fn(async () => {}) };
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.set('imapManager', manager);
  app.use('/api/admin/google-apps', googleAppsAdminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/google-apps`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  Object.values(registry).forEach((fn) => fn.mockReset());
  registry.setGoogleAppStatus.mockResolvedValue([]);
  manager.disconnectAccount.mockClear();
});

const send = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const ROW = {
  id: ID, label: 'Google 1', client_id: '1-a.apps.googleusercontent.com', project_number: '1',
  user_limit: 2, status: 'active', created_at: '2026-09-21T00:00:00.000Z', grants_count: 1, accounts_count: 1,
};

describe('/api/admin/google-apps', () => {
  it('lists apps with reservations counted and a computed full flag, never a secret', async () => {
    registry.listGoogleApps.mockResolvedValue([ROW]);
    const res = await send('GET', '');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps).toEqual([{
      id: ID, label: 'Google 1', clientId: ROW.client_id, projectNumber: '1', userLimit: 2, status: 'active',
      grantsCount: 1, reservedCount: 1, accountsCount: 1, full: true, createdAt: ROW.created_at,
    }]);
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
  });

  it('creates an app and maps registry errors to stable codes', async () => {
    registry.createGoogleApp.mockResolvedValueOnce(ROW);
    let res = await send('POST', '', { label: 'Google 1', clientId: ROW.client_id, clientSecret: 's' });
    expect(res.status).toBe(201);
    expect((await res.json()).app.clientId).toBe(ROW.client_id);

    registry.createGoogleApp.mockRejectedValueOnce(new GoogleAppError('app_same_project'));
    res = await send('POST', '', { label: 'G', clientId: ROW.client_id, clientSecret: 's' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'app_same_project' });
  });

  it('refuses a secret typed around the redaction placeholder', async () => {
    const res = await send('PATCH', `/${ID}`, { clientSecret: 'x••••••••' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'client_secret_redacted' });
    expect(registry.updateGoogleApp).not.toHaveBeenCalled();
  });

  it('keeps the stored secret when the placeholder comes back', async () => {
    registry.updateGoogleApp.mockResolvedValue(ROW);
    await send('PATCH', `/${ID}`, { label: 'Renamed', clientSecret: '••••••••' });
    expect(registry.updateGoogleApp).toHaveBeenCalledWith(ID, { label: 'Renamed', clientSecret: null, userLimit: undefined });
  });

  it('disabling drops the IMAP connections of the flagged mailboxes', async () => {
    registry.updateGoogleApp.mockResolvedValue({ ...ROW, status: 'disabled' });
    registry.setGoogleAppStatus.mockResolvedValue(['acc-1', 'acc-2']);
    const res = await send('PATCH', `/${ID}`, { status: 'disabled' });
    expect(res.status).toBe(200);
    expect(registry.setGoogleAppStatus).toHaveBeenCalledWith(ID, 'disabled');
    expect(manager.disconnectAccount.mock.calls.map((c) => c[0])).toEqual(['acc-1', 'acc-2']);
  });

  it('refuses to delete an app with mailboxes and rejects a malformed id', async () => {
    registry.deleteGoogleApp.mockRejectedValueOnce(new GoogleAppError('app_in_use'));
    let res = await send('DELETE', `/${ID}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'app_in_use' });

    res = await send('DELETE', '/not-a-uuid');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bt src/services/oauth/googleApps.test.js src/routes/googleAppsAdmin.test.js`
Expected: FAIL — новых функций нет, модуль `./googleAppsAdmin.js` не найден.

- [ ] **Step 3: Implement the registry** — в `googleApps.js` (после `setGoogleAppStatus`):

```js
const PUBLIC_APP_COLUMNS = 'id, label, client_id, project_number, user_limit, status, created_at';
const LABEL_MAX = 100;

function normalizeLabel(label) {
  const value = typeof label === 'string' ? label.trim() : '';
  if (!value || value.length > LABEL_MAX) throw new GoogleAppError('label_invalid');
  return value;
}

function normalizeUserLimit(userLimit) {
  if (!Number.isInteger(userLimit) || userLimit <= 0) throw new GoogleAppError('user_limit_invalid');
  return userLimit;
}

// Apps for the admin screen, oldest first, with the seats Google has counted and the mailboxes
// bound to each. The secret is never selected.
export async function listGoogleApps() {
  const { rows } = await query(
    `SELECT a.id, a.label, a.client_id, a.project_number, a.user_limit, a.status, a.created_at,
            (SELECT count(*) FROM google_oauth_grants g WHERE g.app_id = a.id)::int AS grants_count,
            (SELECT count(*) FROM email_accounts e WHERE e.oauth_app_id = a.id)::int AS accounts_count
     FROM google_oauth_apps a ORDER BY a.created_at, a.id`,
  );
  return rows;
}

// One app per Google Cloud project: clients of one project share its user cap, so a second
// client of the same project would only pretend to add seats.
export async function createGoogleApp({ label, clientId, clientSecret, userLimit = 100 }) {
  const normalizedLabel = normalizeLabel(label);
  const projectNumber = parseGoogleClientId(clientId);
  if (!projectNumber) throw new GoogleAppError('client_id_invalid');
  if (typeof clientSecret !== 'string' || !clientSecret.trim()) throw new GoogleAppError('client_secret_required');
  const limit = normalizeUserLimit(userLimit);
  const normalizedClientId = clientId.trim();

  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-import'))");
    const same = await client.query('SELECT id FROM google_oauth_apps WHERE client_id = $1', [normalizedClientId]);
    if (same.rows.length) throw new GoogleAppError('app_exists');
    const project = await client.query('SELECT id FROM google_oauth_apps WHERE project_number = $1', [projectNumber]);
    if (project.rows.length) throw new GoogleAppError('app_same_project');
    const inserted = await client.query(
      `INSERT INTO google_oauth_apps (label, client_id, client_secret, project_number, user_limit)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC_APP_COLUMNS}`,
      [normalizedLabel, normalizedClientId, encrypt(clientSecret.trim()), projectNumber, limit],
    );
    return inserted.rows[0];
  });
}

// The client ID never changes: another client ID is another app. A missing or empty secret
// keeps the stored one. Status changes go through setGoogleAppStatus.
export async function updateGoogleApp(appId, { label, clientSecret, userLimit } = {}) {
  const newLabel = label === undefined ? null : normalizeLabel(label);
  const newLimit = userLimit === undefined ? null : normalizeUserLimit(userLimit);
  const newSecret = typeof clientSecret === 'string' && clientSecret.trim() ? encrypt(clientSecret.trim()) : null;
  const { rows } = await query(
    `UPDATE google_oauth_apps SET
       label = COALESCE($2, label), client_secret = COALESCE($3, client_secret),
       user_limit = COALESCE($4, user_limit), updated_at = NOW()
     WHERE id = $1 RETURNING ${PUBLIC_APP_COLUMNS}`,
    [appId, newLabel, newSecret, newLimit],
  );
  if (!rows.length) throw new GoogleAppError('app_not_found');
  return rows[0];
}

// Only an app without mailboxes can go: a bound mailbox's refresh token works with no other
// client. Its grant journal goes with it (ON DELETE CASCADE).
export async function deleteGoogleApp(appId) {
  await withTransaction(async (client) => {
    const bound = await client.query(
      'SELECT count(*)::int AS n FROM email_accounts WHERE oauth_app_id = $1',
      [appId],
    );
    if (bound.rows[0].n > 0) throw new GoogleAppError('app_in_use');
    const deleted = await client.query('DELETE FROM google_oauth_apps WHERE id = $1', [appId]);
    if (!deleted.rowCount) throw new GoogleAppError('app_not_found');
  });
}

const KNOWN_EMAILS_LIMIT = 8;

// Addresses Google has issued tokens to that no mailbox uses any more, for the "connected
// before" hint of the Gmail form. Addresses only: no apps, no dates.
export async function findKnownGoogleEmails(q) {
  const pattern = String(q).trim().toLowerCase().replace(/[\\%_]/g, '\\$&');
  const { rows } = await query(
    `SELECT DISTINCT g.email FROM google_oauth_grants g
     WHERE g.email LIKE '%' || $1 || '%' ESCAPE '\\'
       AND NOT EXISTS (SELECT 1 FROM email_accounts e WHERE lower(e.email_address) = g.email)
     ORDER BY g.email LIMIT ${KNOWN_EMAILS_LIMIT}`,
    [pattern],
  );
  return rows.map((row) => row.email);
}
```

Если тест `createGoogleApp` с `userLimit` по умолчанию ожидает `100` в параметрах — он проходит, потому что значение по умолчанию подставлено в сигнатуре.

- [ ] **Step 4: Implement the route** — `backend/src/routes/googleAppsAdmin.js`:

```js
import { Router } from 'express';
import {
  GOOGLE_APP_STATUSES,
  GoogleAppError,
  createGoogleApp,
  deleteGoogleApp,
  listGoogleApps,
  setGoogleAppStatus,
  updateGoogleApp,
} from '../services/oauth/googleApps.js';
import { countGoogleReservations } from '../services/oauth/googleAppSelection.js';
import { uuidParam } from '../utils/uuid.js';

// Mounted by routes/admin.js behind requireAdmin at /api/admin/google-apps.
const router = Router();
router.param('id', uuidParam('id'));

// Placeholder the admin screen shows for a stored secret; sending it back keeps the secret.
const REDACTED_SECRET = '••••••••';

const ERRORS = {
  label_invalid: [400, 'Name must be 1 to 100 characters'],
  client_id_invalid: [400, 'Client ID is not a Google OAuth client ID'],
  client_secret_required: [400, 'Client secret is required'],
  client_secret_redacted: [400, 'Client secret contains the redaction placeholder; enter the full secret'],
  user_limit_invalid: [400, 'User limit must be a positive whole number'],
  app_status_invalid: [400, 'Unknown app status'],
  app_exists: [409, 'This client ID is already added'],
  app_same_project: [409, 'An app from this Google Cloud project is already added'],
  app_in_use: [409, 'The app still has connected mailboxes'],
  app_not_found: [404, 'App not found'],
};

function refuse(res, code) {
  const [status, error] = ERRORS[code];
  return res.status(status).json({ error, code });
}

function handleRegistryError(res, err) {
  if (err instanceof GoogleAppError && ERRORS[err.code]) return refuse(res, err.code);
  throw err;
}

// A secret field that is exactly the placeholder or empty keeps the stored value; one that
// mixes the placeholder with typed text would overwrite the real secret with junk.
function secretFromBody(value) {
  if (typeof value !== 'string' || value === '' || value === REDACTED_SECRET) return { secret: null };
  if (value.includes('•')) return { error: 'client_secret_redacted' };
  return { secret: value };
}

async function toApi(row) {
  const reservedCount = await countGoogleReservations(row.id);
  return {
    id: row.id,
    label: row.label,
    clientId: row.client_id,
    projectNumber: row.project_number,
    userLimit: row.user_limit,
    status: row.status,
    grantsCount: row.grants_count ?? 0,
    reservedCount,
    accountsCount: row.accounts_count ?? 0,
    // "Full" is not a stored status: an active app whose counted seats reached its limit.
    full: row.status === 'active' && (row.grants_count ?? 0) + reservedCount >= row.user_limit,
    createdAt: row.created_at,
  };
}

router.get('/', async (_req, res) => {
  const rows = await listGoogleApps();
  res.json({ apps: await Promise.all(rows.map(toApi)) });
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { secret, error } = secretFromBody(body.clientSecret);
  if (error) return refuse(res, error);
  try {
    const row = await createGoogleApp({
      label: body.label,
      clientId: body.clientId,
      clientSecret: secret,
      userLimit: body.userLimit ?? 100,
    });
    res.status(201).json({ app: await toApi(row) });
  } catch (err) {
    return handleRegistryError(res, err);
  }
});

router.patch('/:id', async (req, res) => {
  const body = req.body || {};
  const { secret, error } = secretFromBody(body.clientSecret);
  if (error) return refuse(res, error);
  if (body.status !== undefined && !GOOGLE_APP_STATUSES.includes(body.status)) return refuse(res, 'app_status_invalid');
  try {
    let row = await updateGoogleApp(req.params.id, { label: body.label, clientSecret: secret, userLimit: body.userLimit });
    // Always applied when sent: setGoogleAppStatus is idempotent, and disabling again re-flags
    // mailboxes a previous disable may have left half done.
    if (body.status !== undefined) {
      const flagged = await setGoogleAppStatus(req.params.id, body.status);
      // Their tokens came from a client that no longer refreshes: drop the live connections.
      const manager = req.app.get('imapManager');
      for (const accountId of flagged) {
        Promise.resolve(manager?.disconnectAccount(accountId)).catch(() => {});
      }
      row = { ...row, status: body.status };
    }
    res.json({ app: await toApi(row) });
  } catch (err) {
    return handleRegistryError(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteGoogleApp(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    return handleRegistryError(res, err);
  }
});

export default router;
```

- [ ] **Step 5: Mount the route** — в `backend/src/routes/admin.js` рядом с импортом `accessSyncRoutes`:

```js
import googleAppsAdminRoutes from './googleAppsAdmin.js';
```

и сразу после `router.use('/access-sync', accessSyncRoutes);`:

```js
router.use('/google-apps', googleAppsAdminRoutes);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bt src/services/oauth/googleApps.test.js src/routes/googleAppsAdmin.test.js src/routes/admin.users.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/oauth/googleApps.js backend/src/services/oauth/googleApps.test.js backend/src/routes/googleAppsAdmin.js backend/src/routes/googleAppsAdmin.test.js backend/src/routes/admin.js
git commit -m "feat(google-oauth): admin API for several Google OAuth apps"
```

---

### Task 4: Старт добавления Gmail, подсказка адресов и переход к Google

**Files:**
- Modify: `backend/src/services/oauth/oauthState.js`, `backend/src/services/oauth/oauthState.test.js`
- Create: `backend/src/services/oauth/googleLaunch.js`, `backend/src/services/oauth/googleLaunch.test.js`
- Create: `backend/src/routes/oauthGoogleApi.js`, `backend/src/routes/oauthGoogleApi.test.js`
- Modify: `backend/src/index.js` (импорт и `app.use` рядом с `app.use('/api/integrations', integrationsRoutes);`)
- Modify: `backend/src/routes/oauthGoogle.js` (только новый маршрут `GET /launch`), `backend/src/routes/oauth.google.test.js`

**Interfaces:**
- Consumes: `selectGoogleApp`, `releaseGoogleSeat`, `GoogleAppSelectionError` (Task 2); `findKnownGoogleEmails` (Task 3); `resolveGoogleConfig`; `buildGoogleAuthorizationUrl`, `GOOGLE_AUTH_URL`; `allowedRequestOrigin`.
- Produces:
  - `createOAuthState({ provider, userId, loginHint, appId, mode = null, email = null, accountId = null })`; `consumeOAuthState` дополнительно возвращает `mode`, `email`, `accountId` (строка или `null`);
  - `createGoogleLaunch({ userId, url }): Promise<string>` (flow), `consumeGoogleLaunch({ flow, userId }): Promise<string | null>` (URL Google), `GOOGLE_LAUNCH_TTL_SECONDS = 60`;
  - `POST /api/oauth/google/start` `{ email }` → `200 { path: '/oauth/google/launch?flow=<flow>' }`; `400 { code: 'email_invalid' }`; `409 { code: 'already_connected' | 'no_app_capacity' | 'not_configured' }`;
  - `GET /api/oauth/google/known-emails?q=` → `{ emails: string[] }`; `400 { code: 'query_invalid' }`, если `q` короче 2 или длиннее 254 символов после `trim()`;
  - `GET /oauth/google/launch?flow=` → `302` на Google или `302 /?oauth_error=invalid_state&oauth_provider=google`; без сессии — `401 { error: 'Not authenticated' }`.
  - `export const GOOGLE_EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/` в `services/oauth/googleLaunch.js` — единственная проверка формата адреса; её используют `oauthGoogleApi.js` и (в Task 5) `oauthGoogle.js` вместо локального `LOGIN_HINT_PATTERN`.

- [ ] **Step 1: Extend OAuth state (test first)** — в `oauthState.test.js` добавить:

```js
it('carries the flow mode, the expected email and the reconnect target', async () => {
  const { state } = await createOAuthState({
    provider: 'google', userId: 'u1', appId: 'app-1', mode: 'reconnect', email: 'x@gmail.com', accountId: 'acc-1',
  });
  await expect(consumeOAuthState({ provider: 'google', state })).resolves.toMatchObject({
    mode: 'reconnect', email: 'x@gmail.com', accountId: 'acc-1', appId: 'app-1',
  });
});

it('reports no mode, email or target for a flow started without them', async () => {
  const { state } = await createOAuthState({ provider: 'google', userId: 'u1' });
  await expect(consumeOAuthState({ provider: 'google', state })).resolves.toMatchObject({
    mode: null, email: null, accountId: null,
  });
});
```

Запустить `bt src/services/oauth/oauthState.test.js` — FAIL. Затем в `oauthState.js`: добавить параметры `mode = null, email = null, accountId = null` в `createOAuthState`, записывать их в JSON (`mode: mode || null, email: email ? email.toLowerCase() : null, accountId: accountId || null`), а в `consumeOAuthState` возвращать

```js
      mode: typeof data.mode === 'string' ? data.mode : null,
      email: typeof data.email === 'string' ? data.email : null,
      accountId: typeof data.accountId === 'string' ? data.accountId : null,
```

Обновить комментарий над `createOAuthState`: `mode` (`add`, `reconnect`, `upsert`) и `email` говорят callback-у, что проверять; `accountId` — какой ящик переподключается. Запустить снова — PASS.

- [ ] **Step 2: Launch key (test first)** — `googleLaunch.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => new Map());
vi.mock('../redis.js', () => ({
  redisClient: {
    set: vi.fn(async (key, value, opts) => { store.set(key, { value, opts }); return 'OK'; }),
    getDel: vi.fn(async (key) => { const v = store.get(key)?.value ?? null; store.delete(key); return v; }),
  },
}));

const { createGoogleLaunch, consumeGoogleLaunch, GOOGLE_LAUNCH_TTL_SECONDS } = await import('./googleLaunch.js');
const URL_ = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&login_hint=a%40gmail.com';

beforeEach(() => store.clear());

describe('google launch key', () => {
  it('is single use, lives 60 seconds and keys Redis by a hash of the flow', async () => {
    const flow = await createGoogleLaunch({ userId: 'u1', url: URL_ });
    expect(flow).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [[key, { opts }]] = [...store.entries()];
    expect(key).toMatch(/^oauth:google:launch:[0-9a-f]{64}$/);
    expect(key).not.toContain(flow);
    expect(opts).toEqual({ NX: true, EX: GOOGLE_LAUNCH_TTL_SECONDS });
    expect(GOOGLE_LAUNCH_TTL_SECONDS).toBe(60);
    await expect(consumeGoogleLaunch({ flow, userId: 'u1' })).resolves.toBe(URL_);
    await expect(consumeGoogleLaunch({ flow, userId: 'u1' })).resolves.toBeNull();
  });

  it('belongs to the user who started it', async () => {
    const flow = await createGoogleLaunch({ userId: 'u1', url: URL_ });
    await expect(consumeGoogleLaunch({ flow, userId: 'u2' })).resolves.toBeNull();
  });

  it('rejects a malformed flow without reaching Redis', async () => {
    await expect(consumeGoogleLaunch({ flow: 'short', userId: 'u1' })).resolves.toBeNull();
    await expect(consumeGoogleLaunch({ flow: undefined, userId: 'u1' })).resolves.toBeNull();
  });

  it('only ever hands out a Google authorization URL', async () => {
    const flow = await createGoogleLaunch({ userId: 'u1', url: 'https://evil.example/' });
    await expect(consumeGoogleLaunch({ flow, userId: 'u1' })).resolves.toBeNull();
  });
});
```

Запустить `bt src/services/oauth/googleLaunch.test.js` — FAIL. Реализация `googleLaunch.js`:

```js
import { createHash, randomBytes } from 'crypto';
import { redisClient } from '../redis.js';
import { GOOGLE_AUTH_URL } from './googleOAuth.js';

// The Gmail form gets a one-time path instead of the Google URL, so the address in login_hint
// never appears in a MailExpert URL or in the proxy logs: the URL waits in Redis for one minute.
export const GOOGLE_LAUNCH_TTL_SECONDS = 60;
export const GOOGLE_EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

const FLOW_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const launchKey = (flow) => `oauth:google:launch:${createHash('sha256').update(flow).digest('hex')}`;

export async function createGoogleLaunch({ userId, url }) {
  const flow = randomBytes(32).toString('base64url');
  await redisClient.set(launchKey(flow), JSON.stringify({ userId, url }), { NX: true, EX: GOOGLE_LAUNCH_TTL_SECONDS });
  return flow;
}

// Burned on first use whatever the outcome.
export async function consumeGoogleLaunch({ flow, userId }) {
  if (typeof flow !== 'string' || !FLOW_PATTERN.test(flow)) return null;
  const raw = await redisClient.getDel(launchKey(flow));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || data.userId !== userId) return null;
    if (typeof data.url !== 'string' || !data.url.startsWith(`${GOOGLE_AUTH_URL}?`)) return null;
    return data.url;
  } catch {
    return null;
  }
}
```

Запустить — PASS.

- [ ] **Step 3: API routes (test first)** — `oauthGoogleApi.test.js`:

```js
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    const userId = req.get('x-test-user');
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    req.session = { userId };
    next();
  },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
// googleLaunch.js is loaded for real (for GOOGLE_EMAIL_PATTERN); keep it off a real Redis client.
vi.mock('../services/redis.js', () => ({ redisClient: { set: vi.fn(), getDel: vi.fn() } }));
const selection = vi.hoisted(() => ({ result: { appId: 'app-1', reserved: true }, error: null }));
vi.mock('../services/oauth/googleAppSelection.js', () => {
  class GoogleAppSelectionError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  return {
    GoogleAppSelectionError,
    selectGoogleApp: vi.fn(async () => {
      if (selection.error) throw new GoogleAppSelectionError(selection.error);
      return selection.result;
    }),
    releaseGoogleSeat: vi.fn(async () => {}),
  };
});
const config = vi.hoisted(() => ({ value: null }));
vi.mock('../services/oauth/googleApps.js', () => ({
  resolveGoogleConfig: vi.fn(async () => config.value),
  findKnownGoogleEmails: vi.fn(async () => ['old@gmail.com']),
}));
vi.mock('../services/oauth/oauthState.js', () => ({
  createOAuthState: vi.fn(async () => ({ state: 'S'.repeat(43), codeChallenge: 'C'.repeat(43) })),
}));
vi.mock('../services/oauth/googleLaunch.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createGoogleLaunch: vi.fn(async () => 'F'.repeat(43)),
}));

import express from 'express';
import routes from './oauthGoogleApi.js';
import { query } from '../services/db.js';
import { selectGoogleApp, releaseGoogleSeat } from '../services/oauth/googleAppSelection.js';
import { findKnownGoogleEmails } from '../services/oauth/googleApps.js';
import { createOAuthState } from '../services/oauth/oauthState.js';
import { createGoogleLaunch } from '../services/oauth/googleLaunch.js';

const CLIENT_ID = '123456789012-abc.apps.googleusercontent.com';
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/oauth/google', routes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/oauth/google`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  vi.clearAllMocks();
  selection.result = { appId: 'app-1', reserved: true };
  selection.error = null;
  config.value = { appId: 'app-1', clientId: CLIENT_ID, clientSecret: 's', redirectUri: 'https://mail.example.com/oauth/google/callback' };
  query.mockResolvedValue({ rows: [] });
});

const start = (email, user = 'u1') => fetch(`${base}/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
  body: JSON.stringify({ email }),
});

describe('POST /api/oauth/google/start', () => {
  it('requires a session', async () => {
    expect((await start('a@gmail.com', null)).status).toBe(401);
  });

  it('answers with a one-time launch path that does not carry the email', async () => {
    const res = await start('A@Gmail.com');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ path: `/oauth/google/launch?flow=${'F'.repeat(43)}` });
    expect(JSON.stringify(body)).not.toMatch(/gmail/i);
    expect(createOAuthState).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'google', userId: 'u1', appId: 'app-1', mode: 'add', email: 'a@gmail.com', loginHint: 'a@gmail.com',
    }));
    const { url } = createGoogleLaunch.mock.calls[0][0];
    const google = new URL(url);
    expect(google.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(google.searchParams.get('login_hint')).toBe('a@gmail.com');
  });

  it('refuses a malformed email', async () => {
    const res = await start('not an email');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'email_invalid' });
  });

  it('refuses an address that already has a mailbox, without selecting an app', async () => {
    query.mockResolvedValue({ rows: [{ id: 'acc-1' }] });
    const res = await start('a@gmail.com');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'already_connected' });
    expect(selectGoogleApp).not.toHaveBeenCalled();
  });

  it.each(['no_app_capacity', 'not_configured'])('reports %s from selection', async (code) => {
    selection.error = code;
    const res = await start('a@gmail.com');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code });
  });

  it('frees the reserved seat when the selected app cannot be used', async () => {
    config.value = null;
    const res = await start('a@gmail.com');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_configured' });
    expect(releaseGoogleSeat).toHaveBeenCalledWith('app-1', 'a@gmail.com');
  });
});

describe('GET /api/oauth/google/known-emails', () => {
  const known = (q, user = 'u1') => fetch(`${base}/known-emails?${new URLSearchParams({ q })}`, {
    headers: user ? { 'x-test-user': user } : {},
  });

  it('returns addresses only', async () => {
    const res = await known('ol');
    expect(await res.json()).toEqual({ emails: ['old@gmail.com'] });
    expect(findKnownGoogleEmails).toHaveBeenCalledWith('ol');
  });

  it.each(['a', ' a ', 'x'.repeat(255)])('refuses the query %j', async (q) => {
    const res = await known(q);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'query_invalid' });
  });

  it('requires a session', async () => {
    expect((await known('ol', null)).status).toBe(401);
  });
});
```

Запустить `bt src/routes/oauthGoogleApi.test.js` — FAIL. Реализация `backend/src/routes/oauthGoogleApi.js`:

```js
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { buildGoogleAuthorizationUrl } from '../services/oauth/googleOAuth.js';
import { findKnownGoogleEmails, resolveGoogleConfig } from '../services/oauth/googleApps.js';
import { GoogleAppSelectionError, releaseGoogleSeat, selectGoogleApp } from '../services/oauth/googleAppSelection.js';
import { createOAuthState } from '../services/oauth/oauthState.js';
import { GOOGLE_EMAIL_PATTERN, createGoogleLaunch } from '../services/oauth/googleLaunch.js';
import { allowedRequestOrigin } from '../utils/publicOrigins.js';

// Mounted at /api/oauth/google. Starting a flow reserves a seat, so it lives under /api where
// the X-Requested-With check and the screen lock apply; the browser then follows a one-time
// /oauth/google/launch path to Google.
const router = Router();
router.use(requireAuth);

const PROVIDER = 'google';
const QUERY_MIN = 2;
const QUERY_MAX = 254;

router.post('/start', async (req, res) => {
  const raw = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!GOOGLE_EMAIL_PATTERN.test(raw)) return res.status(400).json({ error: 'Enter a valid email address', code: 'email_invalid' });
  const email = raw.toLowerCase();

  // Mailboxes are shared: an address any user already connected is connected for everyone.
  const existing = await query('SELECT id FROM email_accounts WHERE lower(email_address) = $1 LIMIT 1', [email]);
  if (existing.rows.length) return res.status(409).json({ error: 'This mailbox is already connected', code: 'already_connected' });

  let selected;
  try {
    selected = await selectGoogleApp({ email });
  } catch (err) {
    if (err instanceof GoogleAppSelectionError) return res.status(409).json({ error: 'Gmail cannot be connected now', code: err.code });
    throw err;
  }

  const config = await resolveGoogleConfig({ appId: selected.appId, origin: allowedRequestOrigin(req) });
  if (!config) {
    if (selected.reserved) await releaseGoogleSeat(selected.appId, email);
    return res.status(409).json({ error: 'Gmail cannot be connected now', code: 'not_configured' });
  }

  const { state, codeChallenge } = await createOAuthState({
    provider: PROVIDER, userId: req.session.userId, loginHint: email, appId: config.appId, mode: 'add', email,
  });
  const url = buildGoogleAuthorizationUrl({
    clientId: config.clientId, state, codeChallenge, redirectUri: config.redirectUri, loginHint: email,
  });
  const flow = await createGoogleLaunch({ userId: req.session.userId, url });
  res.json({ path: `/oauth/google/launch?flow=${flow}` });
});

router.get('/known-emails', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < QUERY_MIN || q.length > QUERY_MAX) {
    return res.status(400).json({ error: 'Query must be 2 to 254 characters', code: 'query_invalid' });
  }
  res.json({ emails: await findKnownGoogleEmails(q) });
});

export default router;
```

Тест «frees the reserved seat…» ожидает освобождение и при `reserved: true`; в тесте `selection.result.reserved` равен `true`, так что условие выполняется. Запустить — PASS.

- [ ] **Step 4: Mount** — в `backend/src/index.js` импорт рядом с `integrationsRoutes`:

```js
import oauthGoogleApiRoutes from './routes/oauthGoogleApi.js';
```

и строка сразу после `app.use('/api/integrations', integrationsRoutes);`:

```js
app.use('/api/oauth/google', oauthGoogleApiRoutes);
```

Проверить, что строка стоит после middleware `X-Requested-With` (строки ~160-180 `index.js`): они объявлены раньше всех `app.use('/api/...')`, так что порядок уже верный.

- [ ] **Step 5: Launch route (test first)** — в `oauth.google.test.js`: добавить мок

```js
const launch = vi.hoisted(() => ({ url: null }));
vi.mock('../services/oauth/googleLaunch.js', async (importOriginal) => ({
  ...(await importOriginal()),
  consumeGoogleLaunch: vi.fn(async ({ userId }) => (userId === USER_ID_FOR_LAUNCH ? launch.url : null)),
}));
```

где `USER_ID_FOR_LAUNCH` — строковый литерал `'11111111-1111-1111-1111-111111111111'` (моки поднимаются выше констант, поэтому литерал, а не `USER_ID`). И тесты:

```js
describe('GET /oauth/google/launch', () => {
  it('requires a session', async () => {
    const res = await get(`/oauth/google/launch?flow=${'F'.repeat(43)}`, { user: null });
    expect(res.status).toBe(401);
  });

  it('forwards to the stored Google URL', async () => {
    launch.url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}`;
    const res = await get(`/oauth/google/launch?flow=${'F'.repeat(43)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(launch.url);
  });

  it('sends an unknown, used or foreign flow back with invalid_state', async () => {
    launch.url = null;
    const res = await get(`/oauth/google/launch?flow=${'F'.repeat(43)}`);
    expect(res.headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=google');
  });
});
```

Запустить `bt src/routes/oauth.google.test.js` — новые FAIL. В `oauthGoogle.js` импортировать `consumeGoogleLaunch` и добавить перед `router.get('/callback', …)`:

```js
// Step 1b of the Gmail form: follow the one-time path created by POST /api/oauth/google/start.
router.get('/launch', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const flow = typeof req.query.flow === 'string' ? req.query.flow : '';
  const url = await consumeGoogleLaunch({ flow, userId: req.session.userId });
  res.redirect(url || errorRedirect('invalid_state'));
});
```

Запустить — PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/oauth/oauthState.js backend/src/services/oauth/oauthState.test.js backend/src/services/oauth/googleLaunch.js backend/src/services/oauth/googleLaunch.test.js backend/src/routes/oauthGoogleApi.js backend/src/routes/oauthGoogleApi.test.js backend/src/index.js backend/src/routes/oauthGoogle.js backend/src/routes/oauth.google.test.js
git commit -m "feat(google-oauth): start a Gmail connection by email and launch it once"
```

---

### Task 5: Переподключение по id ящика и новый callback

**Files:**
- Modify: `backend/src/routes/oauthGoogle.js`
- Test: `backend/src/routes/oauth.google.test.js`

**Interfaces:**
- Consumes: `selectGoogleApp`, `releaseGoogleSeat`, `GoogleAppSelectionError` (Task 2); `revokeGoogleToken` (Task 1); `createOAuthState`/`consumeOAuthState` с `mode`/`email`/`accountId` (Task 4); `GOOGLE_EMAIL_PATTERN` (Task 4); `isUuid` из `../utils/uuid.js`; `query`, `withTransaction` из `../services/db.js`; `decrypt` из `../services/encryption.js`.
- Produces: `GET /oauth/google?account=<id>`; коды callback `already_connected`, `account_mismatch`, `no_app_capacity` (в `CALLBACK_ERROR_CODES`).

Режимы потока:

| Как начат | `mode` | `email` в state | Что делает callback |
|---|---|---|---|
| `POST /api/oauth/google/start` | `add` | введённый адрес | создаёт ящик; ящик уже есть → `already_connected` |
| `GET /oauth/google?account=<id>` | `reconnect` | адрес ящика | обновляет ящик `accountId`; его нет или он не Google → `invalid_state` |
| `GET /oauth/google?login_hint=<email>` (совместимость до 8c), Google-ящик с этим адресом есть | `reconnect` | адрес | как выше |
| то же, ящика нет | `add` | адрес | как `add` |
| `GET /oauth/google` без параметров (совместимость до 8c) | `upsert` | `null` | создаёт или обновляет ящик по адресу из ID token, как раньше |

Порядок проверок в callback (спецификация, «Callback», с поправками PR 8):
1. Потребить state; если в нём есть `appId` и `email` — `releaseGoogleSeat(appId, email)`.
2. `error` от Google → `access_denied` / `authentication_failed`.
3. Нет state или сессия не та → `invalid_state`.
4. `resolveGoogleConfig({ appId, origin })` → иначе `not_configured`. Нет `code` → `authentication_failed`.
5. Обмен кода, проверка ID token; с этого момента токены выданы.
6. `recordGoogleGrant`.
7. `pending.email` задан и `≠ lower(identity.email)` → `account_mismatch`.
8. Нет scope почты → `scope_missing`.
9. В транзакции под `oauth-account:<email>`: `add` и ящик есть → `already_connected`; `reconnect` и ящик с этим адресом не тот, что `accountId`, или не Google → `invalid_state`; у обновляемого ящика `oauth_subject` задан и `≠ identity.sub` → `account_mismatch`; нет refresh token и сохранённый нельзя оставить → `missing_refresh_token`.
10. Отказ после шага 5 → токены не сохраняются; выданный токен (refresh, иначе access) отзывается, **если** в этом приложении нет ящика с `lower(email_address) = lower(identity.email)`.
11. Успех обновления со сменой приложения → после коммита отозвать старый refresh token (best effort, без ожидания).

- [ ] **Step 1: Update the test harness** — в `oauth.google.test.js`:
  - мок `googleApps.js` оставить (`resolveGoogleConfig`, `recordGoogleGrant`);
  - добавить мок выбора:

```js
const selection = vi.hoisted(() => ({ result: { appId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', reserved: false }, error: null }));
vi.mock('../services/oauth/googleAppSelection.js', () => {
  class GoogleAppSelectionError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  return {
    GoogleAppSelectionError,
    selectGoogleApp: vi.fn(async () => {
      if (selection.error) throw new GoogleAppSelectionError(selection.error);
      return selection.result;
    }),
    releaseGoogleSeat: vi.fn(async () => {}),
  };
});
```

  - в мок `googleOAuth.js` добавить `revokeGoogleToken: vi.fn(async () => true)`;
  - `db.js` уже мокает `query`; в `beforeEach` задать `query.mockReset(); query.mockResolvedValue({ rows: [] });` и сбросить `selection`;
  - в `installDb` расширить шаблон поиска существующего ящика до нового списка колонок (`SELECT id, oauth_provider, oauth_refresh_token, oauth_app_id, oauth_subject FROM email_accounts`).

Существующие тесты callback начинали поток через `startFlow('')` или `startFlow('?login_hint=…')`. Старт без параметров — режим `upsert`, такие тесты остаются верными как есть. Старт с `login_hint` теперь спрашивает базу (`query`), есть ли Google-ящик с этим адресом: при пустом ответе это `add`. Тест, который стартовал с `login_hint` и ожидал **обновления** существующего ящика (`oauth_result=updated`), должен перед `startFlow` задать `query.mockResolvedValueOnce({ rows: [<тот же ящик с oauth_provider: 'google'>] })`, чтобы старт стал `reconnect`, и передать в `installDb({ existing })` строку с тем же `id`. Поведение, которое тест проверяет, не менять; ни один тест не удалять.

Тест «redirects with not_configured when the integration is incomplete» обнулял `googleApps.config`; теперь старт берёт приложение по `appId` из выбора, поэтому такой тест должен обнулять и `googleApps.byId` (`googleApps.byId = {}`), а случай «приложений нет вовсе» — проверять через `selection.error = 'not_configured'`. Ожидаемый redirect тот же.

- [ ] **Step 2: Write the failing tests**

```js
describe('reconnect by mailbox id', () => {
  const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';

  it('starts a reconnect for any signed-in user with the mailbox address as login_hint', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'User@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID }] });
    const { location } = await startFlow(`?account=${ACCOUNT_ID}`);
    expect(location.searchParams.get('login_hint')).toBe('user@gmail.com');
    const saved = JSON.parse([...redisStore.values()][0]);
    expect(saved).toMatchObject({ mode: 'reconnect', email: 'user@gmail.com', accountId: ACCOUNT_ID, appId: APP_ID });
    expect(selectGoogleApp).toHaveBeenCalledWith({ email: 'user@gmail.com', account: expect.objectContaining({ id: ACCOUNT_ID }) });
  });

  it.each([
    ['a malformed id', 'nope', null],
    ['a missing mailbox', ACCOUNT_ID, []],
    ['a mailbox that is not Google', ACCOUNT_ID, [{ id: ACCOUNT_ID, email_address: 'x@corp.example', oauth_provider: null }]],
  ])('refuses %s with invalid_state', async (_name, id, rows) => {
    if (rows) query.mockResolvedValueOnce({ rows });
    const res = await get(`/oauth/google?account=${id}`);
    expect(res.headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=google');
  });

  it.each(['no_app_capacity', 'not_configured'])('redirects with %s when no app can take it', async (code) => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: null }] });
    selection.error = code;
    const res = await get(`/oauth/google?account=${ACCOUNT_ID}`);
    expect(res.headers.get('location')).toBe(`/?oauth_error=${code}&oauth_provider=google`);
  });
});

describe('callback refusals after Google issued tokens', () => {
  it('refuses a different Google account than the one asked for and revokes its new token', async () => {
    const { state } = await startFlow('?login_hint=user%40gmail.com'); // no mailbox → add
    mockSuccessfulGoogle({ email: 'other@gmail.com' });
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('account_mismatch'));
    expect(recordGoogleGrant).toHaveBeenCalledWith(expect.objectContaining({ email: 'other@gmail.com' }));
    expect(revokeGoogleToken).toHaveBeenCalledWith('refresh-tok');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('does not revoke when that address already has a mailbox on this app', async () => {
    const { state } = await startFlow('?login_hint=user%40gmail.com');
    mockSuccessfulGoogle({ email: 'other@gmail.com' });
    query.mockImplementation(async (sql) => (/oauth_app_id = \$2/.test(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [] }));
    await callback({ code: 'c', state });
    expect(revokeGoogleToken).not.toHaveBeenCalled();
  });

  it('reports already_connected when the mailbox appeared between start and callback', async () => {
    const { state } = await startFlow('?login_hint=user%40gmail.com'); // add
    installDb({ existing: { id: 'acc-1', oauth_provider: 'google', oauth_refresh_token: 'enc(old)', oauth_app_id: APP_ID, oauth_subject: 'sub-1' } });
    mockSuccessfulGoogle();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('already_connected'));
  });

  it('refuses a reconnect signed in as another Google identity of the same address', async () => {
    const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID }] });
    const { state } = await startFlow(`?account=${ACCOUNT_ID}`);
    installDb({ existing: { id: ACCOUNT_ID, oauth_provider: 'google', oauth_refresh_token: 'enc(old)', oauth_app_id: APP_ID, oauth_subject: 'sub-OLD' } });
    mockSuccessfulGoogle(); // sub-1
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('account_mismatch'));
  });

  it('releases the reservation on every outcome, before the grant is journaled', async () => {
    const { state } = await startFlow('?login_hint=user%40gmail.com');
    mockSuccessfulGoogle();
    await callback({ code: 'c', state });
    expect(releaseGoogleSeat).toHaveBeenCalledWith(APP_ID, 'user@gmail.com');
    expect(releaseGoogleSeat.mock.invocationCallOrder[0]).toBeLessThan(recordGoogleGrant.mock.invocationCallOrder[0]);

    releaseGoogleSeat.mockClear();
    const second = await startFlow('?login_hint=user%40gmail.com');
    await callback({ state: second.state, error: 'access_denied' });
    expect(releaseGoogleSeat).toHaveBeenCalledWith(APP_ID, 'user@gmail.com');
  });
});

describe('reconnect onto another app', () => {
  it('revokes the old refresh token after the move', async () => {
    const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
    const NEW_APP = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    googleApps.byId[NEW_APP] = { ...googleApps.config, appId: NEW_APP };
    selection.result = { appId: NEW_APP, reserved: true };
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID }] });
    const { state } = await startFlow(`?account=${ACCOUNT_ID}`);
    installDb({ existing: { id: ACCOUNT_ID, oauth_provider: 'google', oauth_refresh_token: 'old-refresh', oauth_app_id: APP_ID, oauth_subject: 'sub-1' } });
    mockSuccessfulGoogle();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=updated');
    await vi.waitFor(() => expect(revokeGoogleToken).toHaveBeenCalledWith('old-refresh'));
  });
});
```

Имена `callback`, `errorLocation`, `startFlow`, `mockSuccessfulGoogle`, `installDb` уже есть в файле; `callback`/`errorLocation` объявлены внутри `describe('GET /oauth/google/callback')` — вынести их на верхний уровень файла, чтобы новые `describe` их видели. Импортировать `query` из `../services/db.js`, `selectGoogleApp`/`releaseGoogleSeat` из `../services/oauth/googleAppSelection.js`, `revokeGoogleToken` из `../services/oauth/googleOAuth.js`. `decrypt` в моке `encryption.js` возвращает значение как есть, поэтому `'old-refresh'` доходит до `revokeGoogleToken` без изменений.

- [ ] **Step 3: Run tests to verify they fail**

Run: `bt src/routes/oauth.google.test.js`
Expected: FAIL — новые тесты (нет `account`, нет новых кодов, нет отзыва).

- [ ] **Step 4: Implement** — в `oauthGoogle.js`:

Импорты:

```js
import { query, withTransaction } from '../services/db.js';
import { encrypt, decrypt } from '../services/encryption.js';
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  hasGoogleMailScope,
  revokeGoogleToken,
  verifyGoogleIdToken,
} from '../services/oauth/googleOAuth.js';
import { GoogleAppSelectionError, releaseGoogleSeat, selectGoogleApp } from '../services/oauth/googleAppSelection.js';
import { GOOGLE_EMAIL_PATTERN, consumeGoogleLaunch } from '../services/oauth/googleLaunch.js';
import { isUuid } from '../utils/uuid.js';
```

Коды и удалить `LOGIN_HINT_PATTERN`:

```js
const CALLBACK_ERROR_CODES = new Set([
  'access_denied', 'invalid_state', 'not_configured', 'email_not_verified',
  'missing_refresh_token', 'scope_missing', 'authentication_failed',
  'already_connected', 'account_mismatch', 'no_app_capacity',
]);
```

Старт:

```js
// What a start request asks for. `?account=<id>` reconnects that mailbox. Until the new
// "Add account" dialog ships, the old entry points keep working: `?login_hint=<email>` reconnects
// the Gmail mailbox with that address or adds it, and no parameter at all adds or updates
// whichever account the user picks at Google.
async function resolveStartTarget(req) {
  if (req.query.account !== undefined) {
    const id = typeof req.query.account === 'string' ? req.query.account : '';
    if (!isUuid(id)) throw new CallbackError('invalid_state');
    const { rows } = await query(
      'SELECT id, email_address, oauth_provider, oauth_app_id FROM email_accounts WHERE id = $1',
      [id],
    );
    const account = rows[0];
    if (!account || account.oauth_provider !== PROVIDER) throw new CallbackError('invalid_state');
    return { mode: 'reconnect', email: account.email_address.toLowerCase(), account };
  }

  const rawHint = typeof req.query.login_hint === 'string' ? req.query.login_hint.trim() : '';
  if (!GOOGLE_EMAIL_PATTERN.test(rawHint)) return { mode: 'upsert', email: null, account: null };
  const email = rawHint.toLowerCase();
  const { rows } = await query(
    `SELECT id, email_address, oauth_provider, oauth_app_id FROM email_accounts
     WHERE lower(email_address) = $1 ORDER BY created_at LIMIT 1`,
    [email],
  );
  const account = rows[0];
  if (account?.oauth_provider === PROVIDER) return { mode: 'reconnect', email, account };
  return { mode: 'add', email, account: null };
}

// Step 1: pick the app, create state + PKCE and send the user to Google's consent screen.
router.get('/', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });

  let selected = null;
  let target = null;
  try {
    target = await resolveStartTarget(req);
    selected = await selectGoogleApp({ email: target.email, account: target.account });
    const config = await resolveGoogleConfig({ appId: selected.appId, origin: allowedRequestOrigin(req) });
    if (!config) throw new CallbackError('not_configured');
    const { state, codeChallenge } = await createOAuthState({
      provider: PROVIDER,
      userId: req.session.userId,
      loginHint: target.email,
      appId: config.appId,
      mode: target.mode,
      email: target.email,
      accountId: target.account?.id ?? null,
    });
    res.redirect(buildGoogleAuthorizationUrl({
      clientId: config.clientId,
      state,
      codeChallenge,
      redirectUri: config.redirectUri,
      loginHint: target.email,
    }));
  } catch (err) {
    if (selected?.reserved) await releaseGoogleSeat(selected.appId, target.email);
    const known = err instanceof CallbackError || err instanceof GoogleAppSelectionError;
    if (!known) console.error(`Google OAuth start failed: ${err?.name || 'Error'}`);
    res.redirect(errorRedirect(known ? err.code : 'authentication_failed'));
  }
});
```

Callback:

```js
// Step 2: Google redirects back with a code (or an error) and the state.
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  let issued = null;

  try {
    // Consume first so a state is burned whatever the outcome, and free the seat reserved at
    // start before the grant is journaled so one email never counts twice.
    const pending = await consumeOAuthState({ provider: PROVIDER, state });
    if (pending?.appId && pending.email) await releaseGoogleSeat(pending.appId, pending.email);

    if (error !== undefined) {
      throw new CallbackError(error === 'access_denied' ? 'access_denied' : 'authentication_failed');
    }
    // The flow must finish in the same MailExpert session that started it.
    if (!pending || !req.session?.userId || req.session.userId !== pending.userId) {
      throw new CallbackError('invalid_state');
    }
    // Finish with the app chosen at start: its client is the one Google issued the code to.
    const config = await resolveGoogleConfig({ appId: pending.appId, origin: allowedRequestOrigin(req) });
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
    issued = { appId: config.appId, tokens, email: identity.email };
    // Google counts this account against the app's user cap once it issued tokens, even if
    // the consent is refused below.
    await recordGoogleGrant({ appId: config.appId, email: identity.email, sub: identity.sub });
    // The user may pick another Google account on Google's page than the one asked for.
    if (pending.email && identity.email.toLowerCase() !== pending.email) throw new CallbackError('account_mismatch');
    if (!hasGoogleMailScope(tokens.scope)) throw new CallbackError('scope_missing');

    const { account, result, previousAppId, previousRefreshToken } =
      await upsertGoogleAccount(pending, identity, tokens, config.appId);
    issued = null; // the tokens are stored now: nothing to revoke
    recordGoogleConsent({ userId: pending.userId, account, result, previousAppId, appId: config.appId });
    if (result === 'updated' && previousAppId && previousAppId !== config.appId) {
      // The old token belongs to a client the mailbox left; best effort, the reply does not wait.
      revokeGoogleToken(decrypt(previousRefreshToken)).catch(() => {});
    }

    reconnectAccount(account, result);
    res.redirect(`/?oauth_success=${PROVIDER}&oauth_result=${result}`);
  } catch (err) {
    const stable = typeof err?.code === 'string' && CALLBACK_ERROR_CODES.has(err.code)
      ? err.code
      : 'authentication_failed';
    // Log the stable code and error class only; messages may carry provider details.
    console.error(`Google OAuth callback failed: ${stable} (${err?.name || 'Error'})`);
    if (issued) await revokeRefusedGrant(issued);
    res.redirect(errorRedirect(stable));
  }
});

// A refused consent must not leave a live grant behind. Google revokes a person's access to the
// whole project, not to one token, so skip it when that address already has a working mailbox on
// this app: revoking would cut that mailbox off too.
async function revokeRefusedGrant({ appId, tokens, email }) {
  try {
    const { rows } = await query(
      'SELECT 1 FROM email_accounts WHERE lower(email_address) = lower($1) AND oauth_app_id = $2 LIMIT 1',
      [email, appId],
    );
    if (rows.length) return;
    await revokeGoogleToken(tokens.refreshToken || tokens.accessToken);
  } catch (err) {
    console.error(`Google OAuth refused-grant cleanup failed: ${err?.name || 'Error'}`);
  }
}
```

`upsertGoogleAccount(pending, identity, tokens, appId)` — поменять сигнатуру (первым параметром теперь `pending`, из него `userId`, `mode`, `accountId`), запрос существующего ящика и проверки:

```js
async function upsertGoogleAccount(pending, identity, tokens, appId) {
  const email = identity.email.toLowerCase();
  const encryptedAccess = encrypt(tokens.accessToken);
  const encryptedRefresh = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth-account:${email}`]);

    const existing = await client.query(
      `SELECT id, oauth_provider, oauth_refresh_token, oauth_app_id, oauth_subject FROM email_accounts
       WHERE lower(email_address) = lower($1)
       ORDER BY created_at LIMIT 1`,
      [email],
    );
    const row = existing.rows[0] || null;
    if (pending.mode === 'add' && row) throw new CallbackError('already_connected');
    if (pending.mode === 'reconnect' && (!row || row.id !== pending.accountId || row.oauth_provider !== PROVIDER)) {
      throw new CallbackError('invalid_state');
    }
    // A Gmail address is never reissued, so another subject means another Google account.
    if (row?.oauth_subject && row.oauth_subject !== identity.sub) throw new CallbackError('account_mismatch');
    ...
```

Далее ветки `if (row) { … UPDATE … } else { … INSERT … }` — как сейчас (`existing.rows.length` → `row`, `userId` → `pending.userId`), а возвращаемое значение дополнить: `return { account: accountResult.rows[0], result, previousAppId, previousRefreshToken: row?.oauth_refresh_token ?? null };`.

Маршрут `/launch` из Task 4 остаётся без изменений.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bt src/routes/oauth.google.test.js src/routes/oauth.refresh.test.js src/routes/oauth.microsoft.test.js`
Expected: PASS все три файла.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/oauthGoogle.js backend/src/routes/oauth.google.test.js
git commit -m "feat(google-oauth): reconnect by mailbox id and refuse mismatched consents"
```

---

### Task 6: Статус интеграций, тексты новых кодов, спецификации

**Files:**
- Modify: `backend/src/routes/integrations.js` (`GET /status`), `backend/src/routes/integrations.status.test.js`
- Modify: `frontend/src/utils/googleOAuth.js`, `frontend/src/utils/googleOAuth.test.js`, `frontend/src/locales/en.json`, `frontend/src/locales/ru.json`
- Modify: `docs/superpowers/specs/2026-09-15-google-multi-app-design.md` (строка статуса), `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` (строка статуса и новый раздел)

**Interfaces:**
- Consumes: `googleHasCapacity` (Task 2).
- Produces: `GET /api/integrations/status` → `{ microsoft: { configured }, google: { configured, available } }`; `parseOAuthResult` знает `already_connected`, `account_mismatch`, `no_app_capacity`.

- [ ] **Step 1: Status (test first)** — в `integrations.status.test.js` добавить мок

```js
const capacity = vi.hoisted(() => ({ value: true }));
vi.mock('../services/oauth/googleAppSelection.js', () => ({
  googleHasCapacity: vi.fn(async () => capacity.value),
}));
```

и тесты (использовать имеющиеся в файле `base`/хелперы запроса; если их имена другие — по образцу соседних тестов `/status`):

```js
it('reports whether a new Gmail can be connected, without any credential', async () => {
  googleApps.config = { appId: 'app-1', clientId: CLIENT_ID, clientSecret: 's', redirectUri: REDIRECT_URI };
  capacity.value = false;
  const body = await (await fetch(`${base}/api/integrations/status`)).json();
  expect(body.google).toEqual({ configured: true, available: false });
  expect(JSON.stringify(body)).not.toContain(CLIENT_ID);
});

it('is never available while Google is not configured', async () => {
  googleApps.config = null;
  capacity.value = true;
  const body = await (await fetch(`${base}/api/integrations/status`)).json();
  expect(body.google).toEqual({ configured: false, available: false });
});
```

Если существующий тест проверяет `google` через `toEqual({ configured: … })`, дополнить его ожидание полем `available`. Запустить `bt src/routes/integrations.status.test.js` — FAIL. Реализация в `integrations.js`:

```js
import { googleHasCapacity } from '../services/oauth/googleAppSelection.js';
```

```js
router.get('/status', async (req, res) => {
  const configured = !!(await resolveGoogleConfig());
  res.json({
    microsoft: {
      configured: !!process.env.MS_CLIENT_ID,
    },
    google: {
      configured,
      // Whether an active app still has a free seat: the Gmail option is offered only then.
      available: configured && await googleHasCapacity(),
    },
  });
});
```

Запустить — PASS.

- [ ] **Step 2: Frontend codes (test first)** — в `frontend/src/utils/googleOAuth.test.js` добавить:

```js
test('maps the multi-app callback codes to their own messages', () => {
  const cases = {
    already_connected: 'admin.integrations.google.errorAlreadyConnected',
    account_mismatch: 'admin.integrations.google.errorAccountMismatch',
    no_app_capacity: 'admin.integrations.google.errorNoAppCapacity',
  };
  for (const [code, key] of Object.entries(cases)) {
    const parsed = parseOAuthResult(`?oauth_error=${code}&oauth_provider=google`);
    assert.deepEqual(parsed, { provider: 'google', status: 'error', messageKey: key });
  }
});
```

(Если файл использует `describe`/`it` вместо `test` — по образцу соседей.) Запустить `cd frontend && node --test src/utils/googleOAuth.test.js` — FAIL. Добавить в `GOOGLE_ERROR_KEYS`:

```js
  already_connected: 'admin.integrations.google.errorAlreadyConnected',
  account_mismatch: 'admin.integrations.google.errorAccountMismatch',
  no_app_capacity: 'admin.integrations.google.errorNoAppCapacity',
```

и ключи рядом с `errorScopeMissing` в обеих локалях:

`en.json`:
```json
"errorAlreadyConnected": "This Gmail address is already connected.",
"errorAccountMismatch": "You signed in to Google with a different account than the one you asked to connect. Try again and choose the right account.",
"errorNoAppCapacity": "No Google app has room for another Gmail address. Ask an administrator to add one.",
```

`ru.json`:
```json
"errorAlreadyConnected": "Этот адрес Gmail уже подключён.",
"errorAccountMismatch": "Вы вошли в Google не тем аккаунтом, который подключали. Повторите и выберите нужный аккаунт.",
"errorNoAppCapacity": "Ни в одном Google-приложении нет места для нового адреса Gmail. Попросите администратора добавить приложение.",
```

Запустить `cd frontend && node --test src/utils/googleOAuth.test.js src/locales/i18n.test.js` — PASS.

- [ ] **Step 3: Specs** — в `2026-09-15-google-multi-app-design.md` строку статуса заменить на:

```markdown
> Статус: дизайн одобрен 2026-09-15. PR 1 (данные) слит как #35; PR 2–5 переписаны под общие ящики и выполняются как PR 8a–8c серии `2026-09-15-shared-mailboxes-google-login-design.md`. Доменный почтовый сервер перенесён в PR 9 той же серии.
```

В `2026-09-15-shared-mailboxes-google-login-design.md` в строке статуса после «…PR 6 (синхронизация с Cloudflare Access) реализованы.» добавить «PR 8a (бэкенд Google-приложений) реализован.», и в конец файла перед «## Проверка» добавить раздел:

```markdown
## Уточнения, принятые при реализации PR 8

- PR 8 разбит на серию: 8a — бэкенд (выбор приложения и брони, `start`/`launch`, переподключение по id, callback, `/api/admin/google-apps`, `known-emails`, `google.available`); 8b — админка «Google-приложения», конец совместимости `POST/DELETE /api/integrations/google`; 8c — диалог «Добавить аккаунт» (Gmail и ручная настройка), переподключение слева по `account`, ограничение ручного добавления администратором, конец совместимости `GET /oauth/google` без `account`; 8d — документация.
- Доменный почтовый сервер (`domain_mail`, `kind: 'domain'`) из PR 8 убран и станет PR 9: MailExpert будет заводить ящики на почтовом узле через API готовой сборки Postfix/Dovecot (кандидат — mailcow), а не только подключаться к уже заведённым. Модель и права решаются отдельным дизайном.
- Advisory lock создания Google-ящика — `oauth-account:<email>`, без id пользователя.
- Режимы потока в OAuth state: `add` (форма Gmail), `reconnect` (`?account=<id>`, а до 8c — `?login_hint=` с существующим Google-ящиком), `upsert` (`GET /oauth/google` без параметров до 8c: создаёт или обновляет ящик по адресу из ID token).
- Несовпадение `oauth_subject` с `sub` из ID token отклоняется при любом обновлении ящика, не только при переподключении.
- Ключ перехода хранит готовый URL Google; `launch` отдаёт только URL, начинающийся с адреса авторизации Google.
- `GET /api/integrations/status` в 8a отдаёт `google.available`; `domainMail.configured` появится в PR 9.
```

- [ ] **Step 4: Full verification**

Run: `bt` (весь бэкенд), затем в том же контейнере `npm run lint`; `cd frontend && npm test`.
Expected: все тесты проходят, lint без ошибок. Если бэкенд-набор падает в файлах, которые эта серия не трогала, — сравнить с прогоном на `main` в том же контейнере и доложить, не чинить обходом.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/integrations.js backend/src/routes/integrations.status.test.js frontend/src/utils/googleOAuth.js frontend/src/utils/googleOAuth.test.js frontend/src/locales/en.json frontend/src/locales/ru.json docs/superpowers/specs/2026-09-15-google-multi-app-design.md docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md
git commit -m "feat(google-oauth): report Gmail availability and explain the new refusals"
```
