# Развёртывание, PR 7a: основа прода и CI — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** подготовить всё, на что опираются скрипты установки (7b) и бэкапа (7c): эндпоинт готовности `/api/health/ready`, имена контейнеров через `COMPOSE_PROJECT_NAME`, прод-оверлей `deploy/compose.prod.yml` (образы из GHCR, HTTP только на loopback, лимиты памяти, параметры PostgreSQL и Redis), образ края `mailexpert-edge` (Caddy с DNS-модулем Cloudflare), публикацию образов `sha-<12>` после зелёного CI и shellcheck в CI. Заодно чинится баг из PR 8d: `GOOGLE_REDIRECT_URI` не доходит до контейнера backend и стирается при старте.

**Architecture:** бэкенд — новый `routes/health.js` (роутер `/api/health` с прежним `/` и новым `/ready`; обработчик готовности — фабрика `createReadyHandler({ checkPostgres, checkRedis, timeoutMs })`, чтобы тестироваться без `index.js`); `/api/health/ready` добавляется в публичные пути `identityGate` и в `LOCK_ALLOWED`. В `routes/integrations.js` значение `GOOGLE_REDIRECT_URI`, с которым стартовал процесс, запоминается при загрузке модуля и служит запасным. Compose — только декларативные правки: `container_name` через `${COMPOSE_PROJECT_NAME:-mailexpert}`, передача `GOOGLE_REDIRECT_URI`, новый оверлей с `build: !reset null` и `ports: !override`. CI — два новых задания в `ci.yml`: `shellcheck` и `images` (сборка трёх образов на каждом прогоне, публикация только при push в `main` после `backend`, `frontend`, `shellcheck`).

**Tech Stack:** Node.js 22 (ESM), Express 5, vitest, node-redis, pg; Docker Compose ≥ 2.24.4; GitHub Actions (`docker/build-push-action@v6`, `docker/login-action@v3`, `docker/setup-buildx-action@v3`); Caddy 2 + xcaddy; shellcheck, actionlint.

**Spec:** `docs/superpowers/specs/2026-09-21-deployment-design.md` — «Принятые решения» (все пункты про образы, оверлей, имена контейнеров, loopback, край, GHCR, Compose, `GOOGLE_REDIRECT_URI`, готовность), «1. Раскладка» (порты и лимиты памяти), «8. Проверка скриптов» (shellcheck), «Разбиение на PR» — пункт 7a. Установка, край как compose-проект, таймеры, бэкап, обновление — 7b/7c, здесь не делаются.

## Global Constraints

- Проза плана и спецификаций — по-русски; код, комментарии в коде, коммиты, тексты PR — по-английски. Без эмодзи.
- Коммиты и PR от имени настроенного пользователя git (`wyrtensi`), без строк атрибуции. Все команды `gh pr` — с `--repo wyrtensi/MailExpert`. Не пушить без команды контроллера.
- В документах только заглушки (`<APP_HOST>`, `<CF_HOST>`, `<DIRECT_HOST>`, `<MAIL_HOST>`, `<OWNER>`, `example.com`); никаких реальных хостов, IP, имён серверов и секретов. Имя репозитория `wyrtensi/MailExpert` и префикс образов `ghcr.io/wyrtensi` публичны и допустимы.
- Пакеты GHCR публичные: ни `GHCR_TOKEN`, ни `docker login` на серверах. Образы `sha-*` — только `linux/amd64`, тег `sha-` + первые 12 символов коммита; `BUILD_SHA`/`VITE_BUILD_SHA` внутри образа — полный sha.
- Compose ≥ 2.24.4 (`!override`, `!reset`). Прод-оверлей без `build` (`build: !reset null`): у сервиса с `build` и `image` неудачный `pull` молча переходит в сборку на хосте (проверено на Compose 5.5), поэтому `build` убирается.
- Путь README (`docker compose up --build`, `--profile https`) должен работать как раньше; для checkout в каталоге `MailExpert` имена контейнеров остаются `mailexpert-*`.
- `/api/health` не меняется ни по пути, ни по ответу (`{"status":"ok"}`): им пользуется healthcheck контейнера. `/api/health/ready` не отдаёт текстов ошибок, только `ok`/`error` по каждой зависимости.
- Панель никогда не хранит IP почтового узла (ни в базе, ни в `.env`, ни через `extra_hosts`) — в 7a этого не касаемся, но и не добавляем.
- **Не трогать запущенные контейнеры** `mailexpert-frontend`, `mailexpert-backend`, `mailexpert-postgres`, `mailexpert-redis`, `mailexpert-backend-test` и все `amnezia-*`: не останавливать, не пересоздавать, не выполнять в них команды. Любой тестовый стек compose поднимается только с `COMPOSE_PROJECT_NAME=me7a-smoke`, только с оверлеем (иначе frontend займёт 80/443 хоста) и портом `APP_HTTP_PORT=18080`; перед `up` проверить, что под этим именем проекта нет контейнеров и томов, после проверки — `down -v` только этого проекта. `docker compose up` без `COMPOSE_PROJECT_NAME` из рабочего дерева не запускать.
- Если чистое решение упирается в препятствие (чужой падающий тест, недоступный образ, неожиданное поведение Compose) — остановиться и доложить, не обходить (не отключать тесты и проверки, не ослаблять условия).

## Как запускать тесты

Бэкенд — в отдельном изолированном контейнере `mailexpert-backend-test-7`, который монтирует **это рабочее дерево** только для чтения. Общий контейнер `mailexpert-backend-test` монтирует основной checkout и для этой ветки не подходит; его не трогать. Путь рабочего дерева — тот, где выписана ветка `feat/deployment`; для текущего исполнителя это `D:/hub/workspace/Projects/MailExpert/.claude/worktrees/agent-a3dfcd525c53fc409`.

Создать один раз (если `docker ps -a --filter name=mailexpert-backend-test-7` пуст):

```bash
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test-7 -v "D:/hub/workspace/Projects/MailExpert/.claude/worktrees/agent-a3dfcd525c53fc409:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test-7 sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && echo ready'
```

Запуск файлов (каждый раз синхронизирует рабочее дерево):

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test-7 sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npx vitest run <files>'
```

Ниже это записано как `bt <files>`. Полный прогон — `bt` без файлов; lint — та же команда с `npm run lint && npm run lint:plugins && node --check src/index.js` вместо `npx vitest run`. На Windows-хосте без контейнера часть наборов падает независимо от изменений — поэтому только контейнер. В конце PR контейнер удаляется: `docker rm -f mailexpert-backend-test-7`.

Shell и workflow — через Docker (локально ничего ставить не нужно):

```bash
# shellcheck
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/mnt:ro" -w /mnt koalaman/shellcheck:stable <files>
# actionlint (only ci.yml: publish-apps.yml has three pre-existing findings, out of scope)
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo rhysd/actionlint:latest -no-color .github/workflows/ci.yml
```

Команды с `$(pwd -W)` запускаются в Git Bash из корня рабочего дерева.

## Файлы

| Файл | Что меняется |
|---|---|
| `backend/src/routes/health.js` (новый), `health.test.js` (новый) | роутер `/api/health`: `/` без изменений, `/ready` — PostgreSQL `SELECT 1` и Redis `PING` с таймаутом, 200 или 503 |
| `backend/src/index.js` | `app.use('/api/health', healthRoutes)` вместо `app.get('/api/health')`; `/api/health/ready` в `LOCK_ALLOWED` |
| `backend/src/middleware/identityGate.js`, `identityGate.test.js` | `/api/health/ready` в `PUBLIC_PATHS` |
| `backend/src/routes/integrations.js`, `integrations.envFallback.test.js` (новый) | `GOOGLE_REDIRECT_URI` процесса — запасное значение, строка без callback его не стирает |
| `docker-compose.yml` | `container_name` через `COMPOSE_PROJECT_NAME`; `GOOGLE_REDIRECT_URI` в environment backend |
| `.env.example`, `docs/operations/google-oauth.md` | описание `GOOGLE_REDIRECT_URI` в Docker после исправления |
| `deploy/compose.prod.yml` (новый) | прод-оверлей |
| `deploy/edge/Dockerfile` (новый) | Caddy с `dns.providers.cloudflare` |
| `.github/workflows/ci.yml` | `permissions`, задания `shellcheck` и `images` |
| `docs/superpowers/specs/2026-09-21-deployment-design.md` | статус «7a реализован» и уточнения реализации |

---

### Task 1: Бэкенд — эндпоинт готовности `/api/health/ready`

**Files:**
- Create: `backend/src/routes/health.js`
- Create: `backend/src/routes/health.test.js`
- Modify: `backend/src/index.js` (импорт роутов; `LOCK_ALLOWED` около строки 160; `app.get('/api/health', …)` около строки 220)
- Modify: `backend/src/middleware/identityGate.js:6-9`
- Test: `backend/src/middleware/identityGate.test.js:99-103`

**Interfaces:**
- Consumes: `query(text, params)` из `services/db.js`; `redisClient` из `services/redis.js` (node-redis: свойство `isReady`, метод `ping()`).
- Produces: `GET /api/health` → `200 {"status":"ok"}` (как раньше); `GET /api/health/ready` → `200 {"status":"ready","postgres":"ok","redis":"ok"}` или `503 {"status":"not_ready","postgres":"ok"|"error","redis":"ok"|"error"}`. Экспорт `createReadyHandler({ checkPostgres, checkRedis, timeoutMs = 2000 })` и `pingRedis()`. Его используют `install.sh`, `update.sh`, `healthcheck.sh` (7b/7c) через `127.0.0.1:${APP_HTTP_PORT}` — путь публичный и в режиме `google`.

Почему таймаут: node-redis ставит команды в очередь, пока соединения нет, и `ping()` не завершается вместо ошибки; `pingRedis` сначала смотрит `isReady`, а `createReadyHandler` дополнительно ограничивает каждую проверку `timeoutMs`. Сервер начинает слушать только после `await runMigrations()`, поэтому 200 от `ready` означает и актуальную схему.

- [ ] **Step 1: Проверить API node-redis в образе зависимостей**

Run: `MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test-7 sh -c 'cd /work/backend && node -e "import(\"redis\").then(({createClient})=>{const c=createClient();console.log(typeof c.isReady, typeof c.ping)})"'`
Expected: `boolean function`. Если иначе — остановиться и доложить (реализация `pingRedis` опирается на эти два члена).

- [ ] **Step 2: Написать падающие тесты**

`backend/src/routes/health.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// db and redis are stubbed: the readiness probe is exercised without real services.
const db = vi.hoisted(() => ({ fail: null }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async () => {
    if (db.fail) throw db.fail;
    return { rows: [{ ok: 1 }] };
  }),
}));
const redis = vi.hoisted(() => ({ ready: true, ping: null }));
vi.mock('../services/redis.js', () => ({
  redisClient: {
    get isReady() { return redis.ready; },
    ping: (...args) => redis.ping(...args),
  },
}));

import express from 'express';
import healthRoutes, { createReadyHandler, pingRedis } from './health.js';
import { query } from '../services/db.js';

async function serve(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function healthApp() {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
}

beforeEach(() => {
  db.fail = null;
  redis.ready = true;
  redis.ping = vi.fn(async () => 'PONG');
});

afterEach(() => {
  query.mockClear();
});

describe('GET /api/health', () => {
  it('keeps answering {status: ok} without touching PostgreSQL or Redis', async () => {
    await serve(healthApp(), async (base) => {
      const res = await fetch(`${base}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });
    expect(query).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });
});

describe('GET /api/health/ready', () => {
  it('is 200 when PostgreSQL and Redis answer', async () => {
    await serve(healthApp(), async (base) => {
      const res = await fetch(`${base}/api/health/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ready', postgres: 'ok', redis: 'ok' });
    });
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('is 503 when PostgreSQL fails, without the error text', async () => {
    db.fail = new Error('password authentication failed for user "mailexpert"');
    await serve(healthApp(), async (base) => {
      const res = await fetch(`${base}/api/health/ready`);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ status: 'not_ready', postgres: 'error', redis: 'ok' });
      expect(text).not.toMatch(/password|mailexpert/);
    });
  });

  it('is 503 when Redis is not connected, without queueing a PING', async () => {
    redis.ready = false;
    await serve(healthApp(), async (base) => {
      const res = await fetch(`${base}/api/health/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready', postgres: 'ok', redis: 'error' });
    });
    expect(redis.ping).not.toHaveBeenCalled();
  });

  it('is 503 when PING rejects', async () => {
    redis.ping = vi.fn(async () => { throw new Error('READONLY'); });
    await serve(healthApp(), async (base) => {
      const res = await fetch(`${base}/api/health/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready', postgres: 'ok', redis: 'error' });
    });
  });
});

describe('createReadyHandler', () => {
  it('reports a check that never settles as an error after the timeout', async () => {
    const app = express();
    app.get('/ready', createReadyHandler({
      checkPostgres: () => new Promise(() => {}),
      checkRedis: async () => {},
      timeoutMs: 20,
    }));
    await serve(app, async (base) => {
      const started = Date.now();
      const res = await fetch(`${base}/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready', postgres: 'error', redis: 'ok' });
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  it('reports a check that throws synchronously as an error', async () => {
    const app = express();
    app.get('/ready', createReadyHandler({
      checkPostgres: async () => {},
      checkRedis: () => { throw new Error('boom'); },
    }));
    await serve(app, async (base) => {
      const res = await fetch(`${base}/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready', postgres: 'ok', redis: 'error' });
    });
  });
});

describe('pingRedis', () => {
  it('rejects without sending PING while the client is not ready', async () => {
    redis.ready = false;
    await expect(pingRedis()).rejects.toThrow();
    expect(redis.ping).not.toHaveBeenCalled();
  });
});
```

В `backend/src/middleware/identityGate.test.js` в тесте `lets public paths through without an identity` (строка 100) добавить `'/api/health/ready'` в список путей:

```js
    for (const path of ['/api/health', '/api/health/ready', '/api/auth/config', '/api/auth/logout', '/oauth/login/google', '/oauth/login/google/callback?code=x']) {
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `bt src/routes/health.test.js src/middleware/identityGate.test.js`
Expected: FAIL — `health.test.js` не находит `./health.js`; в `identityGate.test.js` падает `lets public paths through without an identity` (для `/api/health/ready` статус 401).

- [ ] **Step 4: Реализация**

`backend/src/routes/health.js`:

```js
import { Router } from 'express';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';

// Each dependency check gets this long before it counts as failed.
const CHECK_TIMEOUT_MS = 2000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 'ok' or 'error' only: error texts can carry connection details and never reach the response.
async function probe(check, timeoutMs) {
  try {
    await withTimeout(Promise.resolve().then(check), timeoutMs);
    return 'ok';
  } catch {
    return 'error';
  }
}

// Readiness for deploy scripts: PostgreSQL and Redis answer. The server listens only after
// migrations ran, so a 200 also means the schema is current.
export function createReadyHandler({ checkPostgres, checkRedis, timeoutMs = CHECK_TIMEOUT_MS }) {
  return async (_req, res) => {
    const [postgres, redis] = await Promise.all([
      probe(checkPostgres, timeoutMs),
      probe(checkRedis, timeoutMs),
    ]);
    const ready = postgres === 'ok' && redis === 'ok';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', postgres, redis });
  };
}

// node-redis queues commands while disconnected, so a bare PING would wait instead of failing.
export async function pingRedis() {
  if (!redisClient.isReady) throw new Error('Redis is not connected');
  await redisClient.ping();
}

const router = Router();

// Liveness for the container healthcheck: answers as long as the process serves HTTP.
router.get('/', (_req, res) => res.json({ status: 'ok' }));
router.get('/ready', createReadyHandler({
  checkPostgres: () => query('SELECT 1'),
  checkRedis: pingRedis,
}));

export default router;
```

`backend/src/index.js`:

1. После строки `import diagnosticsRoutes from './routes/diagnostics.js';` добавить `import healthRoutes from './routes/health.js';`.
2. В `LOCK_ALLOWED` добавить путь:

```js
const LOCK_ALLOWED = new Set(['/api/auth/unlock', '/api/auth/logout', '/api/auth/me', '/api/health', '/api/health/ready', '/api/version']);
```

3. Строку `app.get('/api/health', (req, res) => res.json({ status: 'ok' }));` заменить на:

```js
app.use('/api/health', healthRoutes);
```

`backend/src/middleware/identityGate.js`, `PUBLIC_PATHS`:

```js
const PUBLIC_PATHS = new Set([
  '/api/health', '/api/health/ready', '/api/version', '/api/update', '/api/auth/config', '/api/auth/logout',
  '/oauth/login/google', '/oauth/login/google/callback',
]);
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `bt src/routes/health.test.js src/middleware/identityGate.test.js src/plugins/gtd/routes.mount.test.js`
Expected: PASS все файлы.

Run: lint-команда из «Как запускать тесты».
Expected: без ошибок.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/health.js backend/src/routes/health.test.js backend/src/index.js backend/src/middleware/identityGate.js backend/src/middleware/identityGate.test.js
git commit -m "feat(backend): add /api/health/ready readiness probe"
```

---

### Task 2: `GOOGLE_REDIRECT_URI` в Docker и как запасное значение

**Files:**
- Modify: `backend/src/routes/integrations.js:13-18`
- Create: `backend/src/routes/integrations.envFallback.test.js`
- Modify: `docker-compose.yml` (environment сервиса `backend`)
- Modify: `.env.example:128-135`
- Modify: `docs/operations/google-oauth.md:50`

**Interfaces:**
- Consumes: `loadIntegrationConfigs()` и роутер по умолчанию из `routes/integrations.js`.
- Produces: `process.env.GOOGLE_REDIRECT_URI` = сохранённый `integration_config.google.redirectUri`, иначе значение, с которым стартовал процесс, иначе переменная удалена. `docker-compose.yml` передаёт `GOOGLE_REDIRECT_URI` в backend (пустая строка, если не задана: `process.env.GOOGLE_REDIRECT_URI || null` даёт `null`). 7b может записать `GOOGLE_REDIRECT_URI=${APP_URL}/oauth/google/callback` в `.env` при установке.

Когда строка без callback бывает на практике: `integration_config` с `provider = 'google'`, записанная до 8a (там лежали `clientId`/`clientSecret` без `redirectUri`). Через API сохранённый callback очистить нельзя (`DELETE /api/integrations/google` отвечает 400, `POST` требует адрес), поэтому «возврат к переменной» случается только при старте с такой строкой. Новых путей очистки не придумывать.

`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` в compose **не** передаются (решение в спецификации): их читает только разовый импорт `importLegacyGoogleConfig` при установке без приложений; Docker-установки добавляют приложения на экране, а переезд переносит их с базой.

- [ ] **Step 1: Написать падающие тесты**

`backend/src/routes/integrations.envFallback.test.js`:

```js
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

// integrations.js remembers GOOGLE_REDIRECT_URI once, when the module loads. Every test sets the
// environment the process "started" with and then loads a fresh copy of the module. Stub state
// lives in vi.hoisted objects so it is shared by every fresh copy of the mocked modules.
const db = vi.hoisted(() => ({ rows: [] }));
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: db.rows })) }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
  isEncrypted: (v) => typeof v === 'string' && v.startsWith('enc:'),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../services/oauth/googleApps.js', () => ({
  resolveGoogleConfig: vi.fn(async () => null),
  importLegacyGoogleConfig: vi.fn(async () => null),
}));
vi.mock('../services/oauth/googleAppSelection.js', () => ({
  googleHasCapacity: vi.fn(async () => true),
}));

import express from 'express';

const ENV_URI = 'https://env.example.com/oauth/google/callback';
const STORED_URI = 'https://stored.example.com/oauth/google/callback';
// A google row written before PR 8a: client fields, no callback URL.
const LEGACY_ROW = { provider: 'google', config: { clientId: 'legacy-client', clientSecret: 'enc:legacy' }, updated_at: '2026-09-01T00:00:00.000Z' };

let savedEnv;
let logSpy;

beforeAll(() => { savedEnv = process.env.GOOGLE_REDIRECT_URI; });
afterAll(() => {
  if (savedEnv === undefined) delete process.env.GOOGLE_REDIRECT_URI;
  else process.env.GOOGLE_REDIRECT_URI = savedEnv;
});
afterEach(() => {
  db.rows = [];
  logSpy?.mockRestore();
});

async function loadModule(startEnv) {
  vi.resetModules();
  if (startEnv === undefined) delete process.env.GOOGLE_REDIRECT_URI;
  else process.env.GOOGLE_REDIRECT_URI = startEnv;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return import('./integrations.js');
}

async function withApp(router, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('GOOGLE_REDIRECT_URI as the fallback callback URL', () => {
  it('keeps the startup value when the stored google row has no callback URL', async () => {
    const { loadIntegrationConfigs } = await loadModule(ENV_URI);
    db.rows = [LEGACY_ROW];
    await loadIntegrationConfigs();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(ENV_URI);
  });

  it('lets a stored callback URL override the startup value', async () => {
    const { loadIntegrationConfigs } = await loadModule(ENV_URI);
    db.rows = [{ provider: 'google', config: { redirectUri: STORED_URI } }];
    await loadIntegrationConfigs();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(STORED_URI);
  });

  it('returns to the startup value once the stored row carries no callback URL', async () => {
    const { default: router, loadIntegrationConfigs } = await loadModule(ENV_URI);
    await withApp(router, async (base) => {
      const res = await fetch(`${base}/api/integrations/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectUri: STORED_URI }),
      });
      expect(res.status).toBe(200);
    });
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(STORED_URI);

    db.rows = [LEGACY_ROW];
    await loadIntegrationConfigs();
    expect(process.env.GOOGLE_REDIRECT_URI).toBe(ENV_URI);
  });

  it('shows the startup value on the settings screen when the row has no callback URL', async () => {
    const { default: router, loadIntegrationConfigs } = await loadModule(ENV_URI);
    db.rows = [LEGACY_ROW];
    await loadIntegrationConfigs();
    await withApp(router, async (base) => {
      const body = await (await fetch(`${base}/api/integrations`)).json();
      expect(body.google).toEqual({ redirectUri: ENV_URI, updated_at: LEGACY_ROW.updated_at });
    });
  });

  it('still clears the variable when the process started without one', async () => {
    const { loadIntegrationConfigs } = await loadModule(undefined);
    process.env.GOOGLE_REDIRECT_URI = STORED_URI; // left by an earlier save in this process
    db.rows = [LEGACY_ROW];
    await loadIntegrationConfigs();
    expect(process.env.GOOGLE_REDIRECT_URI).toBeUndefined();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bt src/routes/integrations.envFallback.test.js`
Expected: FAIL три теста — `keeps the startup value…`, `returns to the startup value…`, `shows the startup value…` (переменная удалена, `undefined` вместо `ENV_URI`). Два других проходят уже сейчас: это страховка от регрессии. Если `vi.resetModules()` не даёт свежую копию модуля (все пять тестов ведут себя как один), остановиться и доложить.

- [ ] **Step 3: Реализация**

В `backend/src/routes/integrations.js` заменить комментарий и `applyGoogleEnv` (строки 13-18):

```js
// GOOGLE_REDIRECT_URI as the process started with it (docker-compose.yml passes it through).
// Captured once: applyGoogleEnv overwrites process.env, and the startup value must stay the
// fallback for a stored google row without a callback URL (rows written before PR 8a).
const STARTUP_GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || null;

// Mirror the stored Google callback URL into process.env, falling back to the startup value.
// Client credentials live in google_oauth_apps, so only the redirect URI is kept in
// integration_config.
function applyGoogleEnv(config) {
  const redirectUri = config?.redirectUri || STARTUP_GOOGLE_REDIRECT_URI;
  if (redirectUri) process.env.GOOGLE_REDIRECT_URI = redirectUri;
  else delete process.env.GOOGLE_REDIRECT_URI;
}
```

Порядок загрузки в проде верен: в `index.js` `import './loadEnv.js'` стоит раньше импорта роутов, поэтому для установки без Docker `.env` уже прочитан, когда `integrations.js` запоминает значение. В Docker переменная приходит из environment контейнера.

`docker-compose.yml`, сервис `backend`, после строки `      BOOTSTRAP_ADMIN_EMAILS: ${BOOTSTRAP_ADMIN_EMAILS:-}` добавить:

```yaml
      # Fallback Google callback URL; the one saved on the Google apps screen takes precedence.
      GOOGLE_REDIRECT_URI: ${GOOGLE_REDIRECT_URI:-}
```

`.env.example` — абзацы про `GOOGLE_REDIRECT_URI` и Docker (строки 128-135, от `# GOOGLE_REDIRECT_URI is the shared callback URL` до `# to a native install. The client secret is sensitive: never commit a real value.`) заменить на:

```bash
# GOOGLE_REDIRECT_URI is the shared callback URL of every app. The value saved on the
# Google apps screen takes precedence; without a saved value the backend uses this
# variable as it was at startup, so it is a fallback for an install that never saved one.
# The path is kept and the host follows the request for every origin in APP_URL and
# APP_ALT_URLS: register <origin>/oauth/google/callback for each of them in every app.
#
# docker-compose.yml passes GOOGLE_REDIRECT_URI to the backend container. It does not pass
# GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET: they apply to a native install only.
# The client secret is sensitive: never commit a real value.
```

`docs/operations/google-oauth.md`, строку 50 (абзац «Переменная `GOOGLE_REDIRECT_URI` — только запасной вариант…») заменить на:

```markdown
Переменная `GOOGLE_REDIRECT_URI` — запасной вариант, если callback ни разу не сохраняли на экране: сохранённый callback имеет приоритет, без него backend берёт значение переменной, с которым стартовал. `docker-compose.yml` передаёт в контейнер backend только `GOOGLE_REDIRECT_URI`; `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` действуют только при установке без Docker.
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `bt src/routes/integrations.envFallback.test.js src/routes/integrations.status.test.js src/services/oauth`
Expected: PASS все файлы (старые тесты `integrations.status.test.js` импортируют модуль без переменной, для них поведение прежнее).

Run: `GOOGLE_REDIRECT_URI=https://example.com/oauth/google/callback docker compose -f docker-compose.yml config 2>/dev/null | grep GOOGLE_REDIRECT_URI`
Expected: `      GOOGLE_REDIRECT_URI: https://example.com/oauth/google/callback`. Команда `config` ничего не запускает.

Run: lint-команда.
Expected: без ошибок.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/integrations.js backend/src/routes/integrations.envFallback.test.js docker-compose.yml .env.example docs/operations/google-oauth.md
git commit -m "fix(backend): keep GOOGLE_REDIRECT_URI as the fallback and pass it through compose"
```

---

### Task 3: Имена контейнеров через `COMPOSE_PROJECT_NAME`

**Files:**
- Modify: `docker-compose.yml` (`container_name` у `frontend`, `backend`, `postgres`, `redis`, `caddy`)

**Interfaces:**
- Produces: `container_name: ${COMPOSE_PROJECT_NAME:-mailexpert}-<service>` для всех пяти сервисов. Compose подставляет имя проекта в `${COMPOSE_PROJECT_NAME}`, даже если переменная не задана (проверено на Compose 5.5): `-p`, переменная или имя каталога в нижнем регистре. Для checkout в каталоге `MailExpert` это `mailexpert`, т. е. имена прежние. Скрипты 7b/7c обращаются к сервисам только через `docker compose exec <service>`.

- [ ] **Step 1: Правка**

В `docker-compose.yml` заменить пять строк:

```yaml
    container_name: ${COMPOSE_PROJECT_NAME:-mailexpert}-frontend
```
```yaml
    container_name: ${COMPOSE_PROJECT_NAME:-mailexpert}-backend
```
```yaml
    container_name: ${COMPOSE_PROJECT_NAME:-mailexpert}-postgres
```
```yaml
    container_name: ${COMPOSE_PROJECT_NAME:-mailexpert}-redis
```
```yaml
    container_name: ${COMPOSE_PROJECT_NAME:-mailexpert}-caddy
```

- [ ] **Step 2: Проверка конфигурации (ничего не запускает)**

Предусловие: рабочая установка принадлежит проекту `mailexpert`, иначе правка переименует её контейнеры при следующем `up`. Команда только читает метку.

Run: `docker inspect mailexpert-backend --format '{{index .Config.Labels "com.docker.compose.project"}}'`
Expected: `mailexpert` (проверено при написании плана). Иначе — остановиться и доложить.


Run: `COMPOSE_PROJECT_NAME=me7a-cfg docker compose -f docker-compose.yml -f docker-compose.https.yml --profile https config 2>/dev/null | grep container_name`
Expected: пять строк `me7a-cfg-frontend`, `me7a-cfg-backend`, `me7a-cfg-postgres`, `me7a-cfg-redis`, `me7a-cfg-caddy`.

Run: `docker compose -p mailexpert -f docker-compose.yml --profile https config 2>/dev/null | grep container_name`
Expected: `mailexpert-frontend`, `mailexpert-backend`, `mailexpert-postgres`, `mailexpert-redis`, `mailexpert-caddy` — как у рабочей установки.

Run: `git grep -n "container_name" docker-compose.yml`
Expected: все пять строк начинаются с `${COMPOSE_PROJECT_NAME:-mailexpert}-`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(compose): derive container names from the compose project name"
```

---

### Task 4: Прод-оверлей `deploy/compose.prod.yml`

**Files:**
- Create: `deploy/compose.prod.yml`

**Interfaces:**
- Consumes: `docker-compose.yml` после Task 2-3; `/api/health/ready` из Task 1.
- Produces: оверлей для `docker compose --env-file <.env> -f docker-compose.yml -f deploy/compose.prod.yml …`. Переменные: `MAILEXPERT_VERSION` (обязательна, тег образа `sha-<12>`), `MAILEXPERT_IMAGE_PREFIX` (по умолчанию `ghcr.io/wyrtensi`), `APP_HTTP_PORT` (по умолчанию `8080`). Образы: `${MAILEXPERT_IMAGE_PREFIX}/mailexpert-frontend:${MAILEXPERT_VERSION}`, `${MAILEXPERT_IMAGE_PREFIX}/mailexpert-backend:${MAILEXPERT_VERSION}`. Frontend публикует только `127.0.0.1:${APP_HTTP_PORT}:80`.

- [ ] **Step 1: Создать `deploy/compose.prod.yml`**

```yaml
# Production overlay for a single host (4 vCPU / 8 GB, next to a mail node).
#
#   docker compose --env-file /opt/mailexpert/.env \
#     -f docker-compose.yml -f deploy/compose.prod.yml up -d
#
# Requires Docker Compose 2.24.4+ (!override, !reset).
#
# - Images come from GHCR, tagged sha-<first 12 characters of the commit>; MAILEXPERT_VERSION
#   must name the commit that is checked out next to this file.
# - build is removed on purpose: with both build and image, a failed pull silently falls back
#   to building on the host. Emergency build from source: `docker build -f backend/Dockerfile
#   -t <image>:<MAILEXPERT_VERSION> .` (same for frontend/Dockerfile), then `up` uses the local
#   image.
# - The frontend serves plain HTTP on loopback only; the edge (Caddy or cloudflared) terminates
#   TLS and sends X-Forwarded-Proto. PostgreSQL and Redis publish no host ports.

services:
  frontend:
    image: ${MAILEXPERT_IMAGE_PREFIX:-ghcr.io/wyrtensi}/mailexpert-frontend:${MAILEXPERT_VERSION:?set MAILEXPERT_VERSION to the sha-<commit> image tag}
    build: !reset null
    ports: !override
      - "127.0.0.1:${APP_HTTP_PORT:-8080}:80"

  backend:
    image: ${MAILEXPERT_IMAGE_PREFIX:-ghcr.io/wyrtensi}/mailexpert-backend:${MAILEXPERT_VERSION:?set MAILEXPERT_VERSION to the sha-<commit> image tag}
    build: !reset null
    mem_limit: 1536m
    environment:
      NODE_OPTIONS: --max-old-space-size=1024

  postgres:
    mem_limit: 2g
    command:
      - postgres
      - -c
      - shared_buffers=1GB
      - -c
      - effective_cache_size=3GB
      - -c
      - random_page_cost=1.1

  redis:
    # The base command plus a memory cap. noeviction: sessions must never be dropped silently;
    # at the cap Redis refuses writes instead.
    command: redis-server --save 60 1 --loglevel warning --maxmemory 256mb --maxmemory-policy noeviction
```

- [ ] **Step 2: Проверка конфигурации**

Подготовить env-файл стенда в каталоге scratchpad сессии, вне репозитория. `SCRATCH` — путь к scratchpad в Git Bash (`SCRATCH="$(cygpath -u '<путь scratchpad из системного промпта>')"`):

```bash
SMOKE="$SCRATCH/me7a-smoke.env"
cat > "$SMOKE" <<EOF
COMPOSE_PROJECT_NAME=me7a-smoke
APP_HTTP_PORT=18080
MAILEXPERT_VERSION=sha-local7a
APP_URL=http://127.0.0.1:18080
AUTH_MODE=local
SESSION_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
DB_PASSWORD=$(openssl rand -hex 24)
EOF
```

Run: `docker compose --env-file "$SMOKE" -f docker-compose.yml -f deploy/compose.prod.yml config > "$SCRATCH/me7a-config.yml" && grep -nE "container_name|image:|published|host_ip|target|mem_limit|NODE_OPTIONS|shared_buffers|maxmemory|build" "$SCRATCH/me7a-config.yml"`
Expected:
- `container_name: me7a-smoke-{frontend,backend,postgres,redis}`;
- `image: ghcr.io/wyrtensi/mailexpert-frontend:sha-local7a` и `…-backend:sha-local7a`;
- у frontend ровно один порт: `host_ip: 127.0.0.1`, `target: 80`, `published: "18080"`; порта 443 нет; у postgres и redis портов нет;
- `mem_limit` у backend и postgres, `NODE_OPTIONS: --max-old-space-size=1024`, `shared_buffers=1GB`, `--maxmemory 256mb`;
- ни одного `build:` у frontend и backend.

Run: `: > "$SCRATCH/empty.env"; docker compose --env-file "$SCRATCH/empty.env" -f docker-compose.yml -f deploy/compose.prod.yml config >/dev/null; echo "exit $?"`
Expected: ошибка с текстом `set MAILEXPERT_VERSION to the sha-<commit> image tag`, `exit 1`.

- [ ] **Step 3: Собрать образы локально под тегом стенда**

Run (из корня рабочего дерева; сборка frontend занимает несколько минут):

```bash
SHA=$(git rev-parse HEAD)
docker build -f backend/Dockerfile --build-arg BUILD_SHA="$SHA" -t ghcr.io/wyrtensi/mailexpert-backend:sha-local7a .
docker build -f frontend/Dockerfile --build-arg VITE_BUILD_SHA="$SHA" -t ghcr.io/wyrtensi/mailexpert-frontend:sha-local7a .
```

Expected: обе сборки успешны.

- [ ] **Step 4: Поднять стенд и проверить**

Сначала убедиться, что проект `me7a-smoke` пуст:

Run: `docker ps -a --filter label=com.docker.compose.project=me7a-smoke --format '{{.Names}}'; docker volume ls --filter label=com.docker.compose.project=me7a-smoke --format '{{.Name}}'`
Expected: пусто. Если нет — остановиться и доложить (не удалять чужое).

Run: `docker compose --env-file "$SMOKE" -f docker-compose.yml -f deploy/compose.prod.yml up -d --wait --wait-timeout 240`
Expected: четыре контейнера `me7a-smoke-*` в состоянии healthy; `docker ps` по-прежнему показывает рабочие `mailexpert-*` и `amnezia-*` без изменений (сравнить `docker ps --format '{{.Names}} {{.Status}}'` до и после — их uptime не сбросился).

Проверки:

```bash
curl -s -w ' %{http_code}\n' http://127.0.0.1:18080/api/health/ready
curl -s http://127.0.0.1:18080/api/version
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/
docker port me7a-smoke-frontend
docker port me7a-smoke-postgres; docker port me7a-smoke-redis
docker compose --env-file "$SMOKE" -f docker-compose.yml -f deploy/compose.prod.yml exec -T postgres psql -U mailexpert -d mailexpert -tAc 'SHOW shared_buffers'
docker compose --env-file "$SMOKE" -f docker-compose.yml -f deploy/compose.prod.yml exec -T redis redis-cli CONFIG GET maxmemory-policy
docker inspect -f '{{.HostConfig.Memory}}' me7a-smoke-backend me7a-smoke-postgres
```

Expected, по порядку: `{"status":"ready","postgres":"ok","redis":"ok"} 200`; `sha` равен `git rev-parse HEAD`; `200`; `80/tcp -> 127.0.0.1:18080` и ничего больше; пусто для postgres и redis; `1GB`; `maxmemory-policy` / `noeviction`; `1610612736` и `2147483648`.

Проверка 503 (затрагивает только стенд):

```bash
docker compose --env-file "$SMOKE" -f docker-compose.yml -f deploy/compose.prod.yml stop redis
curl -s -m 10 -w ' %{http_code}\n' http://127.0.0.1:18080/api/health/ready
docker compose --env-file "$SMOKE" -f docker-compose.yml -f deploy/compose.prod.yml start redis
```

Expected: `{"status":"not_ready","postgres":"ok","redis":"error"} 503` за время меньше 5 с; после `start` через несколько секунд `ready` снова 200. Если `curl -m 10` уходит в таймаут — запросить при остановленном Redis `/api/health`: если висит и он, запрос держит сессионное хранилище (connect-redis перед всеми маршрутами `/api`), это поведение было и до 7a — доложить, в этом PR не чинить.

- [ ] **Step 5: Убрать стенд**

Run: `docker compose --env-file "$SMOKE" -f docker-compose.yml -f deploy/compose.prod.yml down -v && docker ps -a --filter label=com.docker.compose.project=me7a-smoke --format '{{.Names}}'`
Expected: пусто. Образы `sha-local7a` оставить до Task 6 (Step 5 пересобирает их с тегом CI), удалить в Task 7.

- [ ] **Step 6: Commit**

```bash
git add deploy/compose.prod.yml
git commit -m "feat(deploy): add the production compose overlay"
```

---

### Task 5: Образ края `mailexpert-edge`

**Files:**
- Create: `deploy/edge/Dockerfile`

**Interfaces:**
- Produces: образ Caddy с модулем `dns.providers.cloudflare` (открытый вопрос 1 спецификации решён по умолчанию: зона `<DIRECT_HOST>` в Cloudflare DNS). Контекст сборки — `deploy/edge`. Версии Caddy и модуля закреплены аргументами `CADDY_VERSION` и `CADDY_DNS_CLOUDFLARE_VERSION`. Caddyfile, compose-проект `edge` и закрепление по digest — 7b.

- [ ] **Step 1: Проверить закреплённые версии**

При написании плана (2026-09-21) последние стабильные: Caddy `2.11.4`, `caddy-dns/cloudflare` `v0.2.4`; образы `caddy:2.11.4-builder` и `caddy:2.11.4` существуют.

Run: `docker manifest inspect caddy:2.11.4-builder >/dev/null && docker manifest inspect caddy:2.11.4 >/dev/null && echo ok; git ls-remote --tags --refs https://github.com/caddyserver/caddy 'v2.*' | awk -F/ '{print $3}' | grep -v -- - | sort -V | tail -1; git ls-remote --tags --refs https://github.com/caddy-dns/cloudflare | awk -F/ '{print $3}' | sort -V | tail -1`
Expected: `ok`, `v2.11.4`, `v0.2.4`. Если к моменту реализации вышли более новые версии и их образы существуют — взять их и указать в отчёте.

- [ ] **Step 2: Создать `deploy/edge/Dockerfile`**

```dockerfile
# Edge proxy: stock Caddy plus the Cloudflare DNS provider for DNS-01 certificates
# (stock Caddy ships no DNS modules). Built in CI, never on the host.
ARG CADDY_VERSION=2.11.4

FROM caddy:${CADDY_VERSION}-builder AS builder
ARG CADDY_DNS_CLOUDFLARE_VERSION=v0.2.4
RUN xcaddy build --with github.com/caddy-dns/cloudflare@${CADDY_DNS_CLOUDFLARE_VERSION}

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

- [ ] **Step 3: Собрать и проверить модуль**

Run: `docker build -t ghcr.io/wyrtensi/mailexpert-edge:sha-local7a deploy/edge && docker run --rm ghcr.io/wyrtensi/mailexpert-edge:sha-local7a caddy list-modules | grep -x dns.providers.cloudflare && docker run --rm ghcr.io/wyrtensi/mailexpert-edge:sha-local7a caddy version`
Expected: сборка успешна, строка `dns.providers.cloudflare`, версия совпадает с `CADDY_VERSION`.

- [ ] **Step 4: Commit**

```bash
git add deploy/edge/Dockerfile
git commit -m "feat(deploy): add the edge image with the Cloudflare DNS module"
```

---

### Task 6: CI — shellcheck и публикация образов `sha-*`

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `backend/Dockerfile`, `frontend/Dockerfile`, `deploy/edge/Dockerfile`.
- Produces: на каждом push в `main` после зелёных `backend`, `frontend`, `shellcheck` — образы `ghcr.io/<owner>/mailexpert-backend`, `mailexpert-frontend`, `mailexpert-edge` с тегом `sha-<12>` и метками `org.opencontainers.image.source`/`revision`. На pull request те же образы собираются без публикации (сломанный Dockerfile не попадёт в `main`). `publish.yml` (теги `v*`, мультиархитектура) не меняется.

Область shellcheck: `git ls-files` по `scripts/`, `deploy/` и `frontend/*.sh`. Не весь репозиторий: `docs/architecture/mail-node-research/bench/run-one.sh` — материал исследования с замечанием SC2129. `scripts/release.sh` и `frontend/generate-cert.sh` уже чисты (проверено `koalaman/shellcheck:stable`). Скрипты 7b/7c в `scripts/deploy/` попадут в проверку автоматически.

- [ ] **Step 1: Правка `ci.yml`**

После блока `on:` добавить права по умолчанию:

```yaml
permissions:
  contents: read
```

В конец `jobs:` (после задания `frontend`) добавить:

```yaml
  shellcheck:
    name: Shellcheck
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v6

      - name: Shellcheck
        run: |
          mapfile -t files < <(git ls-files 'scripts/*.sh' 'deploy/*.sh' 'frontend/*.sh')
          printf '%s\n' "${files[@]}"
          shellcheck "${files[@]}"

  images:
    name: Images
    needs: [backend, frontend, shellcheck]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    env:
      # Images are published only for commits on main; pull requests build them without pushing.
      PUSH: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}

    steps:
      - uses: actions/checkout@v6

      - uses: docker/setup-buildx-action@v3

      - name: Image tag
        id: image
        run: |
          echo "tag=sha-${GITHUB_SHA::12}" >> "$GITHUB_OUTPUT"
          echo "prefix=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}" >> "$GITHUB_OUTPUT"

      - name: Log in to GHCR
        if: env.PUSH == 'true'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Backend image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./backend/Dockerfile
          platforms: linux/amd64
          push: ${{ env.PUSH == 'true' }}
          tags: ${{ steps.image.outputs.prefix }}/mailexpert-backend:${{ steps.image.outputs.tag }}
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}
          provenance: false
          build-args: |
            BUILD_SHA=${{ github.sha }}
          cache-from: type=gha,scope=backend
          cache-to: type=gha,mode=max,scope=backend

      - name: Frontend image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./frontend/Dockerfile
          platforms: linux/amd64
          push: ${{ env.PUSH == 'true' }}
          tags: ${{ steps.image.outputs.prefix }}/mailexpert-frontend:${{ steps.image.outputs.tag }}
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}
          provenance: false
          build-args: |
            VITE_BUILD_SHA=${{ github.sha }}
          cache-from: type=gha,scope=frontend
          cache-to: type=gha,mode=max,scope=frontend

      - name: Edge image
        uses: docker/build-push-action@v6
        with:
          context: ./deploy/edge
          platforms: linux/amd64
          push: ${{ env.PUSH == 'true' }}
          tags: ${{ steps.image.outputs.prefix }}/mailexpert-edge:${{ steps.image.outputs.tag }}
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}
          provenance: false
          cache-from: type=gha,scope=edge
          cache-to: type=gha,mode=max,scope=edge
```

- [ ] **Step 2: actionlint**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo rhysd/actionlint:latest -no-color .github/workflows/ci.yml; echo "exit $?"`
Expected: без замечаний, `exit 0`. Замечания в `publish-apps.yml` (`inputs.version`, три штуки, были до 7a) не чинить, а упомянуть в отчёте.

- [ ] **Step 3: shellcheck тем же набором файлов, что в CI**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/mnt:ro" -w /mnt koalaman/shellcheck:stable $(git ls-files 'scripts/*.sh' 'deploy/*.sh' 'frontend/*.sh'); echo "exit $?"`
Expected: `exit 0`, файлы `scripts/release.sh` и `frontend/generate-cert.sh`.

Run: `git ls-files 'docs/*.sh'`
Expected: два вложенных файла `docs/architecture/mail-node-research/bench/...` — подтверждение, что шаблон `'<каталог>/*.sh'` в `git ls-files` захватывает вложенные каталоги, т. е. будущие `scripts/deploy/*.sh` попадут в проверку.

- [ ] **Step 4: Проверить вычисление тега так же, как в шаге CI**

Run: `GITHUB_SHA=$(git rev-parse HEAD) GITHUB_REPOSITORY_OWNER=wyrtensi bash -c 'echo "tag=sha-${GITHUB_SHA::12}"; echo "prefix=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}"'`
Expected: `tag=sha-` + 12 шестнадцатеричных символов, `prefix=ghcr.io/wyrtensi`.

- [ ] **Step 5: Пробная сборка трёх образов с тегом CI (без публикации)**

```bash
SHA=$(git rev-parse HEAD); TAG="sha-${SHA:0:12}-dryrun"
docker build -f backend/Dockerfile --build-arg BUILD_SHA="$SHA" -t "ghcr.io/wyrtensi/mailexpert-backend:$TAG" .
docker build -f frontend/Dockerfile --build-arg VITE_BUILD_SHA="$SHA" -t "ghcr.io/wyrtensi/mailexpert-frontend:$TAG" .
docker build -t "ghcr.io/wyrtensi/mailexpert-edge:$TAG" deploy/edge
docker run --rm "ghcr.io/wyrtensi/mailexpert-backend:$TAG" node -e 'console.log(process.env.BUILD_SHA)'
```

Expected: три сборки успешны; последняя команда печатает полный sha из `git rev-parse HEAD`. Суффикс `-dryrun` гарантирует, что локальный тег не совпадёт с настоящим. Ничего не пушить (`docker push` в этом PR не выполняется).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run shellcheck and publish sha-tagged images from main"
```

---

### Task 7: Спецификация и полная проверка

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-deployment-design.md`

**Interfaces:**
- Consumes: всё из Task 1-6.
- Produces: статус 7a в спецификации; чистое локальное окружение.

- [ ] **Step 1: Спецификация**

В строке статуса (строка 3) после `Настройка Google Cloud описана отдельно в [google-oauth.md](../../operations/google-oauth.md).` добавить предложение: `PR 7a (основа прода и CI) реализован.`

В разделе «## Разбиение на PR» после списка (перед «## Открытые вопросы») добавить:

```markdown
### Уточнения, принятые при реализации 7a

- `/api/health/ready` отвечает `{"status":"ready"|"not_ready","postgres":"ok"|"error","redis":"ok"|"error"}`, каждая проверка ограничена 2 с; тексты ошибок не отдаются. Путь публичный в режиме `google` и при заблокированном экране, как `/api/health`.
- Прод-оверлей: образы `${MAILEXPERT_IMAGE_PREFIX:-ghcr.io/wyrtensi}/mailexpert-{frontend,backend}:${MAILEXPERT_VERSION}`; без `MAILEXPERT_VERSION` compose завершается ошибкой. `build` убран, порты frontend заменены целиком (`!override`).
- Образ края собирается из `deploy/edge/Dockerfile` с закреплёнными версиями Caddy и `caddy-dns/cloudflare`; публикуется вместе с образами панели под тем же тегом `sha-*`.
- CI собирает все три образа и на pull request (без публикации), публикует — только при push в `main` после `backend`, `frontend` и `shellcheck`. shellcheck проверяет `scripts/`, `deploy/` и `frontend/*.sh`.
```

- [ ] **Step 2: Полная проверка**

Run: `bt` (весь бэкенд), затем lint-команда.
Expected: все тесты проходят, lint без ошибок. Если падают файлы, которые PR не трогал, — прогнать тот же набор на `origin/main`: отдельный worktree `main` и отдельный тестовый контейнер с его путём (`git stash` не использовать), затем доложить, не чинить обходом.

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: проходит (фронтенд не менялся; проверка, что сборка README-пути цела).

Run: `docker compose -p mailexpert -f docker-compose.yml config >/dev/null && docker compose -p mailexpert -f docker-compose.yml -f docker-compose.https.yml --profile https config >/dev/null && echo ok`
Expected: `ok` — путь README разбирается как раньше.

Run: `git grep -nE "GHCR_TOKEN|docker login" -- deploy docs/superpowers/specs/2026-09-21-deployment-design.md`
Expected: пусто.

- [ ] **Step 3: Уборка**

```bash
docker rmi ghcr.io/wyrtensi/mailexpert-backend:sha-local7a ghcr.io/wyrtensi/mailexpert-frontend:sha-local7a ghcr.io/wyrtensi/mailexpert-edge:sha-local7a
docker images --format '{{.Repository}}:{{.Tag}}' | grep -- '-dryrun$' | xargs -r docker rmi
docker rm -f mailexpert-backend-test-7
```

Удалить `$SCRATCH/me7a-smoke.env`, `$SCRATCH/empty.env` и `$SCRATCH/me7a-config.yml`. Рабочие контейнеры `mailexpert-*`, `mailexpert-backend-test` и `amnezia-*` не трогать.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-21-deployment-design.md
git commit -m "docs: record PR 7a implementation notes in the deployment spec"
```

- [ ] **Step 5: После слияния в `main` (делает владелец, в отчёте напомнить)**

- Дождаться зелёного прогона CI на `main`: задание `Images` публикует три пакета.
- В GitHub → профиль → Packages проверить видимость `mailexpert-backend`, `mailexpert-frontend`, `mailexpert-edge`; если пакет закрыт — Package settings → Change visibility → Public (один раз).
- Проверка без входа в реестр: `docker logout ghcr.io; docker pull ghcr.io/wyrtensi/mailexpert-backend:sha-<12 символов коммита слияния>` — успешно.
