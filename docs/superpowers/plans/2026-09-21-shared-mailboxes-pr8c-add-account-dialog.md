# Общие ящики, PR 8c: диалог «Добавить аккаунт» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** заменить временную карточку «Подключить Gmail» диалогом «Добавить аккаунт» (Gmail по email с подсказкой при вводе и ручная настройка сервера только для администратора), перевести переподключение на `GET /oauth/google?account=<id>`, закрыть ручное добавление ящика для не-администраторов и убрать старый поток `GET /oauth/google` без `account` вместе с режимом `upsert`. Новые Google-ящики создаются в режиме цепочек `gmail`.

**Architecture:** бэкенд теряет старые точки входа: `GET /oauth/google` принимает только `?account=<id>`, callback принимает state только с режимом `add` (из `POST /api/oauth/google/start`) или `reconnect`, у `selectGoogleApp` пропадает параметр `reserve` (все вызывающие теперь бронируют). `POST /api/accounts` получает `requireAdmin` на маршруте. Фронтенд — по образцу 8b: чистые помощники в `utils/addAccount.js` с тестами `node --test`, тонкие `components/AddAccountPicker.jsx` (список вариантов) и `components/GmailAddForm.jsx` (форма Gmail); `AdminPanel.jsx` связывает варианты с формами через таблицу `kind → форма`, поэтому доменный ящик PR 9 добавляется одной записью в `ADD_ACCOUNT_KINDS` и одной формой. Пункт «Добавить аккаунт» появляется в меню пользователя слева и открывает тот же диалог через флаг в store.

**Tech Stack:** Node.js 22 (ESM), Express 5, vitest; фронтенд — React, react-i18next, `node --test`, eslint, vite.

**Spec:** `docs/superpowers/specs/2026-09-15-google-multi-app-design.md` (разделы «Потоки подключения», «Интерфейс» — кнопка «Добавить аккаунт», «Список ящиков слева», «Результаты callback»; «Доменный почтовый сервер» — только последний пункт про `POST /api/accounts` без `kind`; «Тесты»; «Совместимость между PR» — PR 4 той спецификации = этот 8c) с поправками из `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` (раздел «Уточнения, принятые при реализации PR 8»: 8c, 8b-пункт про `GmailConnectCard`, режимы `add`/`reconnect`/`upsert`).

## Global Constraints

- Комментарии в коде, коммиты, тексты PR — на английском. Без эмодзи.
- Коммиты и PR от имени `wyrtensi`, без строк атрибуции; все команды `gh pr` — с `--repo wyrtensi/MailExpert`. Ветка `feat/add-account-dialog` стоит на неслитой ветке 8b `feat/google-apps-admin-screen` (PR #61): PR 8c открывается с `--base feat/google-apps-admin-screen`, после слияния #61 база меняется на `main`.
- Секреты, токены, коды авторизации и тексты ответов Google не попадают в логи, URL, ответы API и ошибки. Email в логах — только через `redactEmail`, в Redis — только SHA-256 от email в нижнем регистре. Email не попадает в URL MailExpert: добавление идёт через `POST /api/oauth/google/start` и одноразовый `path`, переподключение — через id ящика.
- Ящики общие: «уже подключён» означает, что ящик с этим email (`lower(email_address)`) есть в установке. Никаких проверок «ящик принадлежит пользователю». Переподключение по id ящика доступно любому вошедшему пользователю. Подсказка при вводе берёт все ящики из store (спецификация пишет «ящики текущего пользователя», но после PR 3 store содержит все ящики установки).
- После 8c `GET /oauth/google` без `account` и с `?login_hint=` отвечает redirect `/?oauth_error=invalid_state&oauth_provider=google`; режима `upsert` нет; state без режима `add`/`reconnect` (например, выданный до обновления) callback отклоняет как `invalid_state`.
- `selectGoogleApp({ email, account })` без параметра `reserve`: место бронируется всегда, когда выбрано приложение без записи журнала для email. Email обязателен.
- `POST /api/accounts` — только администратор (`403 { error: 'Admin access required' }` из `requireAdmin`), пока нет `kind` (он появится в PR 9 для доменного ящика). Правка, удаление, переподключение ящиков остаются всем вошедшим.
- **Решение владельца 2026-09-21:** новый Google OAuth-ящик создаётся с `thread_mode = 'gmail'`. Только `INSERT` в callback Google; существующие ящики (`UPDATE` при переподключении) не меняются; ручное добавление и Microsoft остаются на значении по умолчанию `rfc`.
- Доменный ящик (`kind: 'domain'`, `domainMail.configured`) в 8c не делается и в диалоге **не рендерится** (ни скрытым, ни неактивным): `ADD_ACCOUNT_KINDS = ['gmail', 'manual']`. PR 9 добавляет `'domain'` в этот массив и форму в таблицу `kind → форма` в `AdminPanel.jsx`.
- `openOAuthWindow` по-прежнему принимает только пути `/oauth/`.
- Каждая новая строка интерфейса — ключ во всех локалях (`frontend/src/locales/en.json`, `ru.json`); неиспользуемые ключи удаляются (Suite 1 в `i18n.test.js` падает на мёртвых ключах). Перевод на русский — не копия английского (Suite 3), кроме записей в `SAME_VALUE_ALLOWED`.
- Монки-патчинг запрещён; глобальный `fetch` подменяется только через `vi.stubGlobal`.
- Не трогать запущенные контейнеры пользователя (`mailexpert-frontend`, `mailexpert-backend`, `mailexpert-postgres`, `mailexpert-redis`, контейнеры других проектов на хосте).
- Порядок задач: сначала фронтенд (Task 1–3) переходит на API, которое есть с 8a (`POST /api/oauth/google/start`, `known-emails`, `GET /oauth/google?account=`), и удаляет карточку; затем бэкенд (Task 4–6) убирает старые пути. Так ветка рабочая после каждого коммита.
- Если чистое исправление упирается в препятствие (падающий чужой тест, неясное требование) — остановиться и доложить, не обходить (не отключать тесты, не ослаблять проверки).

## Как запускать тесты

Бэкенд — в изолированном контейнере `mailexpert-backend-test` (уже запущен; проверить `docker ps -a --filter name=mailexpert-backend-test`). Если его нет — создать один раз:

```bash
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test -v "D:/hub/workspace/Projects/MailExpert:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && echo ready'
```

Запуск файлов (синхронизирует рабочее дерево):

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npx vitest run <files>'
```

Ниже это записано как `bt <files>`. Полный прогон — `bt` без файлов, затем `npm run lint` той же командой вместо `npx vitest run`. На Windows-хосте без контейнера часть наборов падает независимо от изменений (totp, accounts.aliases, auth, archiver/bcrypt, snippet decode) — поэтому только контейнер.

Фронтенд — локально: `cd frontend && node --test <files>`; весь набор — `cd frontend && npm test`; lint — `cd frontend && npm run lint`; сборка — `cd frontend && npm run build`.

## Файлы

| Файл | Что меняется |
|---|---|
| `backend/src/services/oauth/googleAppSelection.js`, `googleAppSelection.test.js` | без `reserve`, email обязателен, исправлены комментарии о порядке снятия брони |
| `backend/src/services/oauth/oauthState.js` | комментарий: режимы только `add` и `reconnect` |
| `backend/src/routes/oauthGoogle.js`, `oauth.google.test.js` | `GET /` только `?account=`; callback только `add`/`reconnect`; `INSERT` с `thread_mode = 'gmail'` |
| `backend/src/routes/accounts.js`, `accounts.create.test.js` (новый) | `POST /` за `requireAdmin` |
| `frontend/src/utils/api.js` | `api.startGoogleOAuth(email)`, `api.knownGoogleEmails(q)` |
| `frontend/src/utils/googleOAuth.js`, `googleOAuth.test.js` | новый `buildGoogleReconnectUrl(accountId)`, удаление `buildGoogleConnectUrl` вместе с карточкой |
| `frontend/src/utils/accountHealth.js`, `accountHealth.test.js` | `reconnectUrlFor` → `/oauth/google?account=<id>` |
| `frontend/src/utils/oauthWindow.test.js` | пример пути без `login_hint` |
| `frontend/src/utils/addAccount.js` (новый), `addAccount.test.js` (новый) | варианты диалога, подсказка при вводе, клавиатура, ошибки |
| `frontend/src/components/AddAccountPicker.jsx` (новый) | список вариантов |
| `frontend/src/components/GmailAddForm.jsx` (новый) | форма Gmail с подсказкой |
| `frontend/src/components/GmailConnectCard.jsx` | удаляется |
| `frontend/src/components/AdminPanel.jsx` | подвид `add` → выбор варианта; `AccountForm` без пресета Gmail; «Переподключить Gmail» через `reconnectUrlFor`; без карточки |
| `frontend/src/store/index.js`, `frontend/src/components/Sidebar.jsx` | пункт «Добавить аккаунт» в меню пользователя |
| `frontend/src/locales/{en,ru}.json`, `frontend/src/locales/i18n.test.js` | `admin.accounts.add.*`, `sidebar.addAccount`, удаление мёртвых ключей карточки и пресета |
| спецификации | статус, «Уточнения … PR 8», пояснение про `reserve` в `selectGoogleApp` |

---

### Task 1: Фронтенд — API, переподключение по id и помощники диалога

**Files:**
- Modify: `frontend/src/utils/api.js`
- Modify: `frontend/src/utils/googleOAuth.js`, `frontend/src/utils/googleOAuth.test.js`
- Modify: `frontend/src/utils/accountHealth.js`, `frontend/src/utils/accountHealth.test.js`
- Modify: `frontend/src/utils/oauthWindow.test.js`
- Create: `frontend/src/utils/addAccount.js`, `frontend/src/utils/addAccount.test.js`

**Interfaces:**
- Consumes: `POST /api/oauth/google/start` `{ email }` → `200 { path }` | `400 { code: 'email_invalid' }` | `409 { code: 'already_connected' | 'no_app_capacity' | 'not_configured' }`; `GET /api/oauth/google/known-emails?q=` → `{ emails: string[] }` (400 при `q` короче 2 или длиннее 254); `GET /api/integrations/status` → `{ google: { configured, available } }`. `request()` кладёт `code` в `err.code`.
- Produces:
  - `api.startGoogleOAuth(email) → Promise<{ path }>`; `api.knownGoogleEmails(q) → Promise<{ emails }>`
  - `googleOAuth.js`: `buildGoogleReconnectUrl(accountId): string|null`; `buildGoogleConnectUrl` пока остаётся (его зовёт только временная карточка) и удаляется в Task 2 вместе с ней
  - `accountHealth.js`: `reconnectUrlFor(account)` — Google → `/oauth/google?account=<id>` (или `null` без id)
  - `addAccount.js`: `ADD_ACCOUNT_KINDS`, `GMAIL_EMAIL_PATTERN`, `SUGGESTION_LIMIT` (8), `KNOWN_EMAILS_MIN_QUERY` (2), `KNOWN_EMAILS_MAX_QUERY` (254), `KNOWN_EMAILS_DEBOUNCE_MS` (200), `GOOGLE_LAUNCH_TTL_MS` (60000), `SUGGESTION_BADGE_KEYS`, `addAccountOptions({ isAdmin, googleStatus })`, `mailboxSuggestion(account)`, `buildEmailSuggestions({ query, accounts, knownEmails })`, `exactMailboxMatch(email, accounts)`, `canStartGmail(email, accounts)`, `shouldFetchKnownEmails(query)`, `moveSuggestionHighlight(index, key, count)`, `suggestionAction(row)`, `gmailStartErrorKey(code)`
  - Строка подсказки: `{ email: string, kind: 'connected'|'reconnect'|'disabled'|'known', reconnectUrl: string|null }`
  - Вариант диалога: `{ kind: 'gmail'|'manual', titleKey, descriptionKey, enabled: boolean, hintKey: string|null }`

- [ ] **Step 1: Write the failing tests**

`googleOAuth.test.js`: к импорту добавить `buildGoogleReconnectUrl`, после `describe('buildGoogleConnectUrl', …)` добавить:

```js
describe('buildGoogleReconnectUrl', () => {
  it('names the mailbox by id and never carries its address', () => {
    assert.equal(buildGoogleReconnectUrl('22222222-2222-2222-2222-222222222222'),
      '/oauth/google?account=22222222-2222-2222-2222-222222222222');
  });

  it('encodes the id', () => {
    const url = buildGoogleReconnectUrl('a b&c');
    assert.equal(new URL(url, 'https://mail.example').searchParams.get('account'), 'a b&c');
    assert.deepEqual([...new URL(url, 'https://mail.example').searchParams.keys()], ['account']);
  });

  it('is null without an id', () => {
    for (const id of [undefined, null, '', '   ', 42]) assert.equal(buildGoogleReconnectUrl(id), null);
  });
});
```

`accountHealth.test.js`: `describe('reconnectUrlFor')` — первый тест заменить на:

```js
  it('reconnects a Google mailbox by its id', () => {
    assert.equal(reconnectUrlFor({ id: 'acc-1', oauth_provider: 'google', email_address: 'box+1@gmail.com' }),
      '/oauth/google?account=acc-1');
    assert.equal(reconnectUrlFor({ oauth_provider: 'google', email_address: 'box@gmail.com' }), null);
  });
```

и в тесте `reconnectMenuAction` объекту `google` (около строки 125, используется на строке 131) добавить `id: 'acc-1'`: без id `reconnectUrlFor` теперь отдаёт `null`, и ожидание `{ kind: 'oauth', url }` не выполнится.

`oauthWindow.test.js`: строку пути `'/oauth/google?login_hint=a%40gmail.com'` (оба вхождения) заменить на `'/oauth/google?account=acc-1'`.

`addAccount.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADD_ACCOUNT_KINDS,
  SUGGESTION_BADGE_KEYS,
  SUGGESTION_LIMIT,
  addAccountOptions,
  buildEmailSuggestions,
  canStartGmail,
  exactMailboxMatch,
  gmailStartErrorKey,
  mailboxSuggestion,
  moveSuggestionHighlight,
  shouldFetchKnownEmails,
  suggestionAction,
} from './addAccount.js';

const mailbox = (email, extra = {}) => ({
  id: `id-${email}`, email_address: email, oauth_provider: 'google', enabled: true,
  oauth_reconnect_required: false, sync_error: null, health: 'healthy', ...extra,
});

describe('addAccountOptions', () => {
  const available = { configured: true, available: true };

  it('offers Gmail and manual setup to an administrator, in that order', () => {
    assert.deepEqual(addAccountOptions({ isAdmin: true, googleStatus: available }), [
      { kind: 'gmail', titleKey: 'admin.accounts.add.gmailTitle', descriptionKey: 'admin.accounts.add.gmailDescription', enabled: true, hintKey: null },
      { kind: 'manual', titleKey: 'admin.accounts.add.manualTitle', descriptionKey: 'admin.accounts.add.manualDescription', enabled: true, hintKey: null },
    ]);
  });

  it('hides manual setup from everyone else', () => {
    assert.deepEqual(addAccountOptions({ isAdmin: false, googleStatus: available }).map((o) => o.kind), ['gmail']);
  });

  it('keeps Gmail listed but inactive, with the reason, while no app can take an address', () => {
    const [notConfigured] = addAccountOptions({ googleStatus: { configured: false, available: false } });
    assert.equal(notConfigured.enabled, false);
    assert.equal(notConfigured.hintKey, 'admin.integrations.google.errorNotConfigured');
    const [full] = addAccountOptions({ googleStatus: { configured: true, available: false } });
    assert.equal(full.enabled, false);
    assert.equal(full.hintKey, 'admin.integrations.google.errorNoAppCapacity');
  });

  it('keeps Gmail inactive without a reason while the status loads', () => {
    const [gmail] = addAccountOptions({ googleStatus: null });
    assert.equal(gmail.enabled, false);
    assert.equal(gmail.hintKey, null);
  });

  it('lists only the kinds this version builds (the domain mailbox comes in PR 9)', () => {
    assert.deepEqual([...ADD_ACCOUNT_KINDS], ['gmail', 'manual']);
  });
});

describe('mailboxSuggestion', () => {
  it('marks a working mailbox as connected', () => {
    assert.deepEqual(mailboxSuggestion(mailbox('A@gmail.com')), { email: 'a@gmail.com', kind: 'connected', reconnectUrl: null });
    assert.equal(mailboxSuggestion(mailbox('a@gmail.com', { health: 'failed' })).kind, 'connected');
    assert.equal(mailboxSuggestion(mailbox('a@gmail.com', { health: 'stale' })).kind, 'connected');
  });

  it('offers a reconnect by id for a mailbox that needs one', () => {
    assert.deepEqual(mailboxSuggestion(mailbox('a@gmail.com', { id: 'acc-1', health: 'oauth_reconnect_required' })),
      { email: 'a@gmail.com', kind: 'reconnect', reconnectUrl: '/oauth/google?account=acc-1' });
  });

  it('marks a mailbox disabled in settings', () => {
    assert.equal(mailboxSuggestion(mailbox('a@gmail.com', { health: 'disabled', enabled: false })).kind, 'disabled');
  });

  it('computes the health when the server did not send it', () => {
    assert.equal(mailboxSuggestion(mailbox('a@gmail.com', { health: undefined, enabled: false })).kind, 'disabled');
    assert.equal(mailboxSuggestion(mailbox('a@gmail.com', { health: undefined, oauth_reconnect_required: true })).kind, 'reconnect');
  });

  it('shows a mailbox without a reconnect route as connected', () => {
    assert.equal(mailboxSuggestion(mailbox('a@corp.example', { oauth_provider: null, health: 'oauth_reconnect_required' })).kind, 'connected');
  });
});

describe('buildEmailSuggestions', () => {
  const accounts = [mailbox('zed@gmail.com'), mailbox('Anna@gmail.com', { health: 'oauth_reconnect_required' }), mailbox('bob@corp.example', { oauth_provider: null })];

  it('matches any part of the address, case-insensitively, mailboxes first then the journal', () => {
    const rows = buildEmailSuggestions({ query: 'GMAIL', accounts, knownEmails: ['old@gmail.com'] });
    assert.deepEqual(rows.map((r) => [r.email, r.kind]), [
      ['anna@gmail.com', 'reconnect'],
      ['zed@gmail.com', 'connected'],
      ['old@gmail.com', 'known'],
    ]);
  });

  it('drops a journal address that is already a mailbox', () => {
    const rows = buildEmailSuggestions({ query: 'zed', accounts, knownEmails: ['ZED@gmail.com'] });
    assert.deepEqual(rows.map((r) => r.kind), ['connected']);
  });

  it('shows nothing for an empty query', () => {
    assert.deepEqual(buildEmailSuggestions({ query: '  ', accounts, knownEmails: ['a@gmail.com'] }), []);
  });

  it('caps the list at eight rows', () => {
    const many = Array.from({ length: 6 }, (_, i) => mailbox(`box${i}@gmail.com`));
    const known = Array.from({ length: 6 }, (_, i) => `old${i}@gmail.com`);
    const rows = buildEmailSuggestions({ query: '@gmail', accounts: many, knownEmails: known });
    assert.equal(SUGGESTION_LIMIT, 8);
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.slice(6).map((r) => r.kind), ['known', 'known']);
  });

  it('has a badge key for every kind', () => {
    for (const kind of ['connected', 'reconnect', 'disabled', 'known']) assert.match(SUGGESTION_BADGE_KEYS[kind], /^admin\.accounts\.add\.badge/);
  });
});

describe('exactMailboxMatch and canStartGmail', () => {
  const accounts = [mailbox('anna@gmail.com')];

  it('finds a mailbox whose address is typed in full, whatever the case and spaces', () => {
    assert.equal(exactMailboxMatch(' Anna@Gmail.com ', accounts)?.kind, 'connected');
    assert.equal(exactMailboxMatch('anna@gmail.co', accounts), null);
  });

  it('starts only for a valid address that is not already a mailbox', () => {
    assert.equal(canStartGmail('new@gmail.com', accounts), true);
    assert.equal(canStartGmail('ANNA@gmail.com', accounts), false);
    assert.equal(canStartGmail('not an email', accounts), false);
    assert.equal(canStartGmail('', accounts), false);
  });
});

describe('shouldFetchKnownEmails', () => {
  it('asks the journal from two characters up to the server limit', () => {
    assert.equal(shouldFetchKnownEmails('a'), false);
    assert.equal(shouldFetchKnownEmails(' ab '), true);
    assert.equal(shouldFetchKnownEmails('x'.repeat(254)), true);
    assert.equal(shouldFetchKnownEmails('x'.repeat(255)), false);
  });
});

describe('moveSuggestionHighlight', () => {
  it('walks down and up with wrap-around', () => {
    assert.equal(moveSuggestionHighlight(-1, 'ArrowDown', 3), 0);
    assert.equal(moveSuggestionHighlight(2, 'ArrowDown', 3), 0);
    assert.equal(moveSuggestionHighlight(-1, 'ArrowUp', 3), 2);
    assert.equal(moveSuggestionHighlight(0, 'ArrowUp', 3), 2);
    assert.equal(moveSuggestionHighlight(1, 'ArrowUp', 3), 0);
  });

  it('stays off the list when it is empty and ignores other keys', () => {
    assert.equal(moveSuggestionHighlight(0, 'ArrowDown', 0), -1);
    assert.equal(moveSuggestionHighlight(1, 'Tab', 3), 1);
  });
});

describe('suggestionAction', () => {
  it('fills a journal address and reconnects a broken mailbox', () => {
    assert.deepEqual(suggestionAction({ email: 'old@gmail.com', kind: 'known', reconnectUrl: null }), { type: 'fill', email: 'old@gmail.com' });
    assert.deepEqual(suggestionAction({ email: 'a@gmail.com', kind: 'reconnect', reconnectUrl: '/oauth/google?account=acc-1' }),
      { type: 'reconnect', url: '/oauth/google?account=acc-1' });
  });

  it('cannot pick a connected or disabled mailbox', () => {
    assert.equal(suggestionAction({ email: 'a@gmail.com', kind: 'connected', reconnectUrl: null }), null);
    assert.equal(suggestionAction({ email: 'a@gmail.com', kind: 'disabled', reconnectUrl: null }), null);
    assert.equal(suggestionAction(null), null);
  });
});

describe('gmailStartErrorKey', () => {
  it('maps the start refusals to their messages', () => {
    assert.equal(gmailStartErrorKey('already_connected'), 'admin.integrations.google.errorAlreadyConnected');
    assert.equal(gmailStartErrorKey('no_app_capacity'), 'admin.integrations.google.errorNoAppCapacity');
    assert.equal(gmailStartErrorKey('not_configured'), 'admin.integrations.google.errorNotConfigured');
    assert.equal(gmailStartErrorKey('email_invalid'), 'admin.accounts.add.errorInvalidEmail');
  });

  it('falls back to the generic message', () => {
    assert.equal(gmailStartErrorKey(undefined), 'admin.integrations.google.errorGeneric');
    assert.equal(gmailStartErrorKey('toString'), 'admin.integrations.google.errorGeneric');
  });
});
```

Run: `cd frontend && node --test src/utils/addAccount.test.js src/utils/googleOAuth.test.js src/utils/accountHealth.test.js src/utils/oauthWindow.test.js`
Expected: FAIL — `addAccount.js` не существует, `buildGoogleReconnectUrl` не экспортируется, `reconnectUrlFor` отдаёт `login_hint`.

- [ ] **Step 2: Implement**

`api.js` — после `pollMsDeviceFlow: …` в блоке «Integrations» добавить:

```js
  // Gmail by address: start answers a one-time /oauth/google/launch path (the address stays out
  // of MailExpert URLs); known-emails lists addresses connected before that have no mailbox now.
  startGoogleOAuth: (email) => request('POST', '/oauth/google/start', { email }),
  knownGoogleEmails: (q) => request('GET', `/oauth/google/known-emails?${new URLSearchParams({ q })}`),
```

`googleOAuth.js` — после `buildGoogleConnectUrl` добавить:

```js
// Same-origin URL that reconnects one Google mailbox. The server looks the address up by id, so
// it never travels in a MailExpert URL. Adding a mailbox starts from the "Add account" dialog.
export function buildGoogleReconnectUrl(accountId) {
  const id = typeof accountId === 'string' ? accountId.trim() : '';
  if (!id) return null;
  return `${GOOGLE_OAUTH_PATH}?${new URLSearchParams({ account: id }).toString()}`;
}
```

`accountHealth.js` — импорт `buildGoogleConnectUrl` заменить на `buildGoogleReconnectUrl`, в `reconnectUrlFor` строку Google заменить на:

```js
  if (account?.oauth_provider === 'google') return buildGoogleReconnectUrl(account.id);
```

`addAccount.js`:

```js
// "Add account" dialog: which ways to add a mailbox are offered, the Gmail address suggestions and
// the form's error messages. Pure functions: no DOM, no store, no network, so they run under
// `node --test`.
import { computeAccountHealth, reconnectUrlFor } from './accountHealth.js';

// The ways to add a mailbox, in the order the dialog lists them. The dialog renders whatever
// addAccountOptions returns through a kind -> form table, so the domain mailbox (PR 9) is one
// entry here plus its form.
export const ADD_ACCOUNT_KINDS = Object.freeze(['gmail', 'manual']);

// Same check as POST /api/oauth/google/start (backend services/oauth/googleLaunch.js).
export const GMAIL_EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
export const SUGGESTION_LIMIT = 8;
export const KNOWN_EMAILS_MIN_QUERY = 2;
export const KNOWN_EMAILS_MAX_QUERY = 254;
export const KNOWN_EMAILS_DEBOUNCE_MS = 200;
// How long the one-time launch path from start stays valid (GOOGLE_LAUNCH_TTL_SECONDS).
export const GOOGLE_LAUNCH_TTL_MS = 60 * 1000;

const OPTION_KEYS = {
  gmail: { titleKey: 'admin.accounts.add.gmailTitle', descriptionKey: 'admin.accounts.add.gmailDescription' },
  manual: { titleKey: 'admin.accounts.add.manualTitle', descriptionKey: 'admin.accounts.add.manualDescription' },
};

// Spelled out literally so the i18n coverage test finds them.
export const SUGGESTION_BADGE_KEYS = Object.freeze({
  connected: 'admin.accounts.add.badgeConnected',
  reconnect: 'admin.accounts.add.badgeReconnect',
  disabled: 'admin.accounts.add.badgeDisabled',
  known: 'admin.accounts.add.badgeKnown',
});

const START_ERROR_KEYS = {
  already_connected: 'admin.integrations.google.errorAlreadyConnected',
  no_app_capacity: 'admin.integrations.google.errorNoAppCapacity',
  not_configured: 'admin.integrations.google.errorNotConfigured',
  email_invalid: 'admin.accounts.add.errorInvalidEmail',
};
const START_ERROR_FALLBACK_KEY = 'admin.integrations.google.errorGeneric';

const normalize = (email) => String(email ?? '').trim().toLowerCase();

// Why Gmail cannot be chosen right now, or null. `googleStatus` is the `google` part of
// GET /api/integrations/status, or null while it loads.
function gmailUnavailableHint(googleStatus) {
  if (!googleStatus) return null;
  if (!googleStatus.configured) return 'admin.integrations.google.errorNotConfigured';
  return 'admin.integrations.google.errorNoAppCapacity';
}

// Options the dialog lists. Manual server setup is for administrators only (the server answers
// 403 to anyone else). Gmail is listed for everyone but stays inactive, with the reason, while no
// Google app can take a new address.
export function addAccountOptions({ isAdmin = false, googleStatus = null } = {}) {
  const options = [];
  for (const kind of ADD_ACCOUNT_KINDS) {
    if (kind === 'manual' && !isAdmin) continue;
    const enabled = kind !== 'gmail' || googleStatus?.available === true;
    const hintKey = kind === 'gmail' && !enabled ? gmailUnavailableHint(googleStatus) : null;
    options.push({ kind, ...OPTION_KEYS[kind], enabled, hintKey });
  }
  return options;
}

// How a mailbox of the install shows up in the suggestions. Mailboxes are shared, so every
// mailbox in the store counts, whoever added it.
export function mailboxSuggestion(account) {
  const email = normalize(account?.email_address);
  const health = account?.health ?? computeAccountHealth(account);
  if (health === 'disabled') return { email, kind: 'disabled', reconnectUrl: null };
  if (health === 'oauth_reconnect_required') {
    const url = reconnectUrlFor(account);
    if (url) return { email, kind: 'reconnect', reconnectUrl: url };
  }
  return { email, kind: 'connected', reconnectUrl: null };
}

// Rows under the Gmail field: mailboxes of the install whose address contains the query (by
// address), then addresses from the grant journal without a mailbox (the server's order), with
// no address twice and at most SUGGESTION_LIMIT rows.
export function buildEmailSuggestions({ query, accounts = [], knownEmails = [] } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const seen = new Set();
  const mailboxes = [];
  for (const account of accounts) {
    const row = mailboxSuggestion(account);
    if (!row.email || !row.email.includes(q) || seen.has(row.email)) continue;
    seen.add(row.email);
    mailboxes.push(row);
  }
  mailboxes.sort((a, b) => a.email.localeCompare(b.email));
  const known = [];
  for (const raw of knownEmails) {
    const email = normalize(raw);
    if (!email || !email.includes(q) || seen.has(email)) continue;
    seen.add(email);
    known.push({ email, kind: 'known', reconnectUrl: null });
  }
  return [...mailboxes, ...known].slice(0, SUGGESTION_LIMIT);
}

// The mailbox whose address is typed in full, as a suggestion row, or null. Its badge shows under
// the field even with the list closed.
export function exactMailboxMatch(email, accounts = []) {
  const wanted = normalize(email);
  if (!wanted) return null;
  const account = accounts.find((a) => normalize(a?.email_address) === wanted);
  return account ? mailboxSuggestion(account) : null;
}

// "Continue with Google" is active for a valid address that is not a mailbox yet.
export function canStartGmail(email, accounts = []) {
  const value = String(email ?? '').trim();
  return GMAIL_EMAIL_PATTERN.test(value) && !exactMailboxMatch(value, accounts);
}

export function shouldFetchKnownEmails(query) {
  const q = String(query ?? '').trim();
  return q.length >= KNOWN_EMAILS_MIN_QUERY && q.length <= KNOWN_EMAILS_MAX_QUERY;
}

// Next highlighted row for an arrow key; -1 means no row. Wraps around both ends.
export function moveSuggestionHighlight(index, key, count) {
  if (!count) return -1;
  if (key === 'ArrowDown') return index < 0 || index >= count - 1 ? 0 : index + 1;
  if (key === 'ArrowUp') return index <= 0 ? count - 1 : index - 1;
  return index;
}

// What choosing a row does: a journal address fills the field (the app is picked by the journal,
// no seat is spent), a broken mailbox reconnects; connected and disabled mailboxes cannot be picked.
export function suggestionAction(row) {
  if (row?.kind === 'known') return { type: 'fill', email: row.email };
  if (row?.kind === 'reconnect' && row.reconnectUrl) return { type: 'reconnect', url: row.reconnectUrl };
  return null;
}

// Own-property lookup so codes like "toString" fall back to the generic message.
export function gmailStartErrorKey(code) {
  return typeof code === 'string' && Object.hasOwn(START_ERROR_KEYS, code) ? START_ERROR_KEYS[code] : START_ERROR_FALLBACK_KEY;
}
```

Run: `cd frontend && node --test src/utils/addAccount.test.js src/utils/googleOAuth.test.js src/utils/accountHealth.test.js src/utils/oauthWindow.test.js`
Expected: PASS.

- [ ] **Step 3: Switch the Accounts tab reconnect** — в `AdminPanel.jsx` импорт `import { buildGoogleConnectUrl, isGoogleReconnectRequired } from '../utils/googleOAuth.js';` заменить на `import { isGoogleReconnectRequired } from '../utils/googleOAuth.js';`, импорт `import { MICROSOFT_OAUTH_PATH } from '../utils/accountHealth.js';` — на `import { MICROSOFT_OAUTH_PATH, reconnectUrlFor } from '../utils/accountHealth.js';`, а кнопку «Переподключить Gmail» во вкладке «Аккаунты» — `onClick={() => openOAuthWindow(buildGoogleConnectUrl({ loginHint: account.email_address }))}` на `onClick={() => openOAuthWindow(reconnectUrlFor(account))}`. Путь `?account=` работает на бэкенде с 8a, поэтому ветка рабочая после каждого коммита.

Run: `cd frontend && npm test && npm run lint`
Expected: PASS, lint чистый. `git grep -n "buildGoogleConnectUrl" frontend/src` — только `utils/googleOAuth.js`, `utils/googleOAuth.test.js` и `components/GmailConnectCard.jsx`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/utils/api.js frontend/src/utils/googleOAuth.js frontend/src/utils/googleOAuth.test.js frontend/src/utils/accountHealth.js frontend/src/utils/accountHealth.test.js frontend/src/utils/oauthWindow.test.js frontend/src/utils/addAccount.js frontend/src/utils/addAccount.test.js frontend/src/components/AdminPanel.jsx
git commit -m "feat(add-account): reconnect Google mailboxes by id, add dialog helpers"
```

---

### Task 2: Фронтенд — диалог «Добавить аккаунт» вместо карточки «Подключить Gmail»

**Files:**
- Create: `frontend/src/components/AddAccountPicker.jsx`
- Create: `frontend/src/components/GmailAddForm.jsx`
- Delete: `frontend/src/components/GmailConnectCard.jsx`
- Modify: `frontend/src/utils/googleOAuth.js`, `frontend/src/utils/googleOAuth.test.js` (удаление `buildGoogleConnectUrl`)
- Modify: `frontend/src/components/AdminPanel.jsx` (`AccountForm` без пресета Gmail, подвид `add` в `AccountsTab`, удаление карточки из «Интеграции → Почтовые провайдеры»)
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/ru.json`, `frontend/src/locales/i18n.test.js`

**Interfaces:**
- Consumes: всё из Task 1; `api.getIntegrationsStatus()`; `openOAuthWindow(href)`; `createLatestRequest()` из `utils/latestRequest.js` (`{ run(request, apply), invalidate() }`); store `accounts`, `user`.
- Produces:
  - `export default function AddAccountPicker({ options, onPick })` — `options` из `addAccountOptions`, `onPick(kind)`.
  - `export default function GmailAddForm({ accounts, onDone })` — `onDone()` после `oauth_success` от Google.
  - В `AccountsTab`: состояние `addKind` (`null` | `'gmail'` | `'manual'`), таблица `ADD_FORMS` `kind → () => JSX`.

- [ ] **Step 1: Retarget the locale test (failing first)** — в `i18n.test.js` тест `every Google key used by the temporary Gmail card exists in every locale` заменить на:

```js
    it('every key used by the add-account dialog exists in every locale', () => {
      // Option, badge and error keys come from utils/addAccount.js and reach t() through a
      // variable, so every quoted literal of the dialog files is collected.
      const source = ['../components/AddAccountPicker.jsx', '../components/GmailAddForm.jsx', '../utils/addAccount.js']
        .map(file => readFileSync(resolve(dir, file), 'utf8')).join('\n');
      const keys = [...new Set([...source.matchAll(/'((?:admin\.accounts\.add|admin\.integrations\.google)\.[\w.]+)'/g)].map(m => m[1]))];
      assert.ok(keys.length >= 20, `expected the add-account keys, found ${keys.length}`);
      const missing = [];
      for (const lang of langs) {
        for (const key of keys) {
          if (typeof locales[lang][key] !== 'string' || !locales[lang][key]) missing.push(`  - ${lang}: ${key}`);
        }
      }
      assert.equal(missing.length, 0, `Add-account keys missing from locale files:\n${missing.join('\n')}`);
    });
```

В `SAME_VALUE_ALLOWED`: удалить строку `'admin.accounts.presetGmail': 'any', // Gmail` (ключ удаляется ниже) и в блок плейсхолдеров добавить:

```js
  'admin.accounts.add.emailPh':              'any', // name@gmail.com
```

Run: `cd frontend && node --test src/locales/i18n.test.js`
Expected: FAIL — `ENOENT … AddAccountPicker.jsx`.

- [ ] **Step 2: Locale keys** — в `en.json` в объект `admin.accounts` добавить вложенный объект `add`, в `ru.json` — такой же с русскими строками:

```json
"add": {
  "chooseTitle": "How do you want to add the mailbox?",
  "backToOptions": "Other ways to add",
  "gmailTitle": "Gmail mailbox",
  "gmailDescription": "Sign in with Google. MailExpert never sees the password.",
  "manualTitle": "Other server, set up manually",
  "manualDescription": "Enter the IMAP and SMTP settings yourself.",
  "emailLabel": "Gmail address",
  "emailPh": "name@gmail.com",
  "continue": "Continue with Google",
  "starting": "Opening Google…",
  "openGoogle": "Open the Google page",
  "openGoogleNote": "If the Google tab did not open, use this link. It works once, within a minute.",
  "badgeConnected": "Already connected",
  "badgeReconnect": "Needs reconnecting",
  "badgeDisabled": "Disabled in settings",
  "badgeKnown": "Connected before",
  "reconnect": "Reconnect",
  "errorInvalidEmail": "Enter the full email address."
}
```

```json
"add": {
  "chooseTitle": "Как добавить ящик?",
  "backToOptions": "Другой способ",
  "gmailTitle": "Ящик Gmail",
  "gmailDescription": "Вход через Google. MailExpert не видит пароль.",
  "manualTitle": "Другой сервер вручную",
  "manualDescription": "Настройки IMAP и SMTP вводятся вручную.",
  "emailLabel": "Адрес Gmail",
  "emailPh": "name@gmail.com",
  "continue": "Продолжить через Google",
  "starting": "Открываем Google…",
  "openGoogle": "Открыть страницу Google",
  "openGoogleNote": "Если вкладка Google не открылась, воспользуйтесь этой ссылкой. Она работает один раз и не дольше минуты.",
  "badgeConnected": "Уже подключено",
  "badgeReconnect": "Нужно переподключить",
  "badgeDisabled": "Отключён в настройках",
  "badgeKnown": "Подключался раньше",
  "reconnect": "Переподключить",
  "errorInvalidEmail": "Введите адрес целиком."
}
```

В `admin.integrations.google` изменить тексты, которые ссылались на старую карточку или на `upsert`:
- `resultUpdated`: en `"Gmail mailbox reconnected."`, ru `"Ящик Gmail переподключён."` (результат `updated` теперь даёт только переподключение);
- `errorInvalidState`: en `"The sign-in link expired or is invalid. Please try again."`, ru `"Ссылка для входа истекла или недействительна. Попробуйте ещё раз."`.

Удалить ключи (оба файла): `admin.integrations.google.description`, `.connect`, `.redirecting`, `.userNoteConfigured`, `.userNoteNotConfigured` (их использовала только карточка) и `admin.accounts.presetGmail`. Перед удалением каждого проверить поиском, например `git grep -n "google.userNoteConfigured\|presetGmail" frontend/src -- '*.js' '*.jsx'`: если ключ упоминается где-то кроме `GmailConnectCard.jsx` и ветки пресета в `AccountForm` — оставить и доложить. `admin.integrations.google.title` остаётся (его показывает `MailApp.jsx`).

- [ ] **Step 3: Write the picker** — `frontend/src/components/AddAccountPicker.jsx`:

```jsx
import { useTranslation } from 'react-i18next';

// The first step of "Add account": one card per way to add a mailbox. The options come from
// utils/addAccount.js, which decides what is offered and why an option is inactive.
export default function AddAccountPicker({ options, onPick }) {
  const { t } = useTranslation();
  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {t('admin.accounts.add.chooseTitle')}
      </div>
      {options.map((option) => (
        <button
          key={option.kind}
          type="button"
          disabled={!option.enabled}
          onClick={() => option.enabled && onPick(option.kind)}
          style={{
            display: 'block', width: '100%', textAlign: 'left', marginBottom: 10, padding: '12px 14px',
            border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'var(--bg-tertiary)',
            cursor: option.enabled ? 'pointer' : 'not-allowed', opacity: option.enabled ? 1 : 0.6,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{t(option.titleKey)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{t(option.descriptionKey)}</div>
          {option.hintKey && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>{t(option.hintKey)}</div>
          )}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Write the Gmail form** — `frontend/src/components/GmailAddForm.jsx`:

```jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { openOAuthWindow } from '../utils/oauthWindow.js';
import { createLatestRequest } from '../utils/latestRequest.js';
import {
  GOOGLE_LAUNCH_TTL_MS,
  KNOWN_EMAILS_DEBOUNCE_MS,
  SUGGESTION_BADGE_KEYS,
  buildEmailSuggestions,
  canStartGmail,
  exactMailboxMatch,
  gmailStartErrorKey,
  moveSuggestionHighlight,
  shouldFetchKnownEmails,
  suggestionAction,
} from '../utils/addAccount.js';

const inputStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const LIST_ID = 'gmail-add-suggestions';

// "Add account -> Gmail": the user types the address, MailExpert picks the Google app. The start
// answer is a one-time path; the address itself never goes into a MailExpert URL. The callback
// reports back to this window (App.jsx forwards it), and MailApp announces the result.
export default function GmailAddForm({ accounts, onDone }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [known, setKnown] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState(null);
  const [launchPath, setLaunchPath] = useState(null);
  const knownRequest = useRef(createLatestRequest());

  // Addresses connected before, from the grant journal: from two characters, debounced.
  useEffect(() => {
    const q = email.trim();
    if (!shouldFetchKnownEmails(q)) {
      knownRequest.current.invalidate();
      setKnown([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      knownRequest.current.run(
        () => api.knownGoogleEmails(q).then((data) => data?.emails ?? []).catch(() => []),
        setKnown,
      );
    }, KNOWN_EMAILS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [email]);

  useEffect(() => {
    const handleMessage = (e) => {
      if (e.origin !== window.location.origin || e.data?.provider !== 'google') return;
      if (e.data?.type === 'oauth_success') {
        setLaunchPath(null);
        onDone();
      } else if (e.data?.type === 'oauth_error') {
        setLaunchPath(null);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onDone]);

  // The fallback link lives as long as the launch key behind it.
  useEffect(() => {
    if (!launchPath) return undefined;
    const timer = setTimeout(() => setLaunchPath(null), GOOGLE_LAUNCH_TTL_MS);
    return () => clearTimeout(timer);
  }, [launchPath]);

  const rows = useMemo(() => buildEmailSuggestions({ query: email, accounts, knownEmails: known }), [email, accounts, known]);
  const exact = useMemo(() => exactMailboxMatch(email, accounts), [email, accounts]);
  const canStart = !busy && canStartGmail(email, accounts);
  const listOpen = open && rows.length > 0;

  const closeList = () => { setOpen(false); setHighlight(-1); };

  const choose = (row) => {
    const action = suggestionAction(row);
    if (!action) return;
    if (action.type === 'fill') {
      setEmail(action.email);
      closeList();
    } else {
      openOAuthWindow(action.url);
    }
  };

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setErrorKey(null);
    setLaunchPath(null);
    try {
      const { path } = await api.startGoogleOAuth(email.trim());
      // The tab is opened after an await, so a popup blocker may stop it and the page cannot
      // tell: the link below is always offered while the path is valid.
      setLaunchPath(path);
      openOAuthWindow(path);
    } catch (err) {
      setErrorKey(gmailStartErrorKey(err?.code));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (listOpen) { e.preventDefault(); closeList(); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setHighlight((i) => moveSuggestionHighlight(i, e.key, rows.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (listOpen && highlight >= 0 && rows[highlight]) choose(rows[highlight]);
      else start();
    }
  };

  const badge = (row) => (
    <span style={{ fontSize: 11, color: row.kind === 'known' ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}>
      {t(SUGGESTION_BADGE_KEYS[row.kind])}
    </span>
  );
  const reconnectButton = (row) => (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => openOAuthWindow(row.reconnectUrl)}
      style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: 'pointer' }}
    >
      {t('admin.accounts.add.reconnect')}
    </button>
  );

  return (
    <div>
      <label htmlFor="gmail-add-email" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
        {t('admin.accounts.add.emailLabel')}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          id="gmail-add-email"
          type="email"
          autoComplete="off"
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={LIST_ID}
          aria-activedescendant={listOpen && highlight >= 0 ? `${LIST_ID}-${highlight}` : undefined}
          value={email}
          placeholder={t('admin.accounts.add.emailPh')}
          onChange={(e) => { setEmail(e.target.value); setOpen(true); setHighlight(-1); setErrorKey(null); }}
          onFocus={() => setOpen(true)}
          onBlur={closeList}
          onKeyDown={onKeyDown}
          style={inputStyle}
        />
        {listOpen && (
          <ul id={LIST_ID} role="listbox" style={{
            position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 5, margin: '4px 0 0', padding: 4, listStyle: 'none',
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8,
          }}>
            {rows.map((row, i) => (
              <li
                key={row.email}
                id={`${LIST_ID}-${i}`}
                role="option"
                aria-selected={i === highlight}
                aria-disabled={!suggestionAction(row)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => row.kind === 'known' && choose(row)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6,
                  background: i === highlight ? 'var(--bg-hover)' : 'transparent',
                  cursor: row.kind === 'known' ? 'pointer' : 'default',
                }}
              >
                <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.email}</span>
                {badge(row)}
                {row.kind === 'reconnect' && reconnectButton(row)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {exact && !listOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {badge(exact)}
          {exact.kind === 'reconnect' && reconnectButton(exact)}
        </div>
      )}
      {errorKey && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{t(errorKey)}</div>}

      <button
        type="button"
        onClick={start}
        disabled={!canStart}
        style={{
          marginTop: 14, padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, border: 'none',
          background: canStart ? 'var(--accent)' : 'var(--bg-elevated)', color: canStart ? 'var(--accent-text)' : 'var(--text-tertiary)',
          cursor: canStart ? 'pointer' : 'not-allowed',
        }}
      >
        {busy ? t('admin.accounts.add.starting') : t('admin.accounts.add.continue')}
      </button>

      {launchPath && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 12 }}>
          {t('admin.accounts.add.openGoogleNote')}{' '}
          <a href={launchPath} target="_blank" rel="opener" onClick={() => setLaunchPath(null)}>
            {t('admin.accounts.add.openGoogle')}
          </a>
        </div>
      )}
    </div>
  );
}
```

(`rel="opener"` — как в `openOAuthWindow`: вкладка Google должна вернуть результат этому окну через `postMessage`. Ссылка ведёт на тот же одноразовый путь; если вкладка уже открылась, повторный переход даст `invalid_state` — это ожидаемо.)

- [ ] **Step 5: Wire AdminPanel and delete the card**

`AdminPanel.jsx`:

1. Импорты: `import GmailConnectCard from './GmailConnectCard.jsx';` удалить; добавить

```js
import AddAccountPicker from './AddAccountPicker.jsx';
import GmailAddForm from './GmailAddForm.jsx';
import { addAccountOptions } from '../utils/addAccount.js';
```

2. `PRESETS`: удалить строку `gmail: { label: 'Gmail', … }` (Gmail добавляется через Google; пресет был IMAP с паролем приложения). В `AccountForm` выражение `presetLabel` заменить на:

```js
            const presetLabel = key === 'yahoo' ? t('admin.accounts.presetYahoo') : key === 'icloud' ? t('admin.accounts.presetIcloud') : t('admin.accounts.presetCustom');
```

3. В `AccountsTab` после `const [confirmDialog, setConfirmDialog] = useState(null);` добавить:

```js
  // "Add account": first the way (utils/addAccount.js decides which are offered), then its form.
  const [addKind, setAddKind] = useState(null);
  const [googleStatus, setGoogleStatus] = useState(null);
  useEffect(() => {
    if (subview !== 'add') return;
    setGoogleStatus(null);
    api.getIntegrationsStatus()
      .then((data) => setGoogleStatus(data?.google || { configured: false, available: false }))
      .catch(() => setGoogleStatus({ configured: false, available: false }));
  }, [subview]);
  const closeAdd = useCallback(() => { setAddKind(null); setSubview('list'); }, []);
```

`handleAdd` — `setSubview('list');` заменить на `closeAdd();`.

4. Блок `if (subview === 'add') { return (…) }` заменить на:

```jsx
  if (subview === 'add') {
    // One form per way to add a mailbox; PR 9 adds `domain` here and in ADD_ACCOUNT_KINDS.
    const ADD_FORMS = {
      gmail: () => <GmailAddForm accounts={accounts} onDone={closeAdd} />,
      manual: () => <AccountForm onSave={handleAdd} onCancel={closeAdd} />,
    };
    const renderForm = addKind ? ADD_FORMS[addKind] : null;
    return (
      <div>
        <button onClick={() => (renderForm ? setAddKind(null) : closeAdd())} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', color: 'var(--text-secondary)',
          cursor: 'pointer', fontSize: 13, padding: '0 0 16px 0',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          {renderForm ? t('admin.accounts.add.backToOptions') : t('sidebar.backToAccounts')}
        </button>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>
          {t('admin.accounts.addTitle')}
        </div>
        {renderForm
          ? renderForm()
          : <AddAccountPicker options={addAccountOptions({ isAdmin, googleStatus })} onPick={setAddKind} />}
      </div>
    );
  }
```

(`useCallback` уже импортирован в `AdminPanel.jsx`; `isAdmin` уже объявлен в `AccountsTab`.)

5. В `IntegrationsTab` строку `<GmailConnectCard />` удалить (остаётся `{isAdmin && <GoogleAppsSection />}`).

6. `git rm frontend/src/components/GmailConnectCard.jsx`.

7. `googleOAuth.js`: удалить `buildGoogleConnectUrl` с комментарием (последний вызывающий ушёл с карточкой); `googleOAuth.test.js`: убрать `buildGoogleConnectUrl` из импорта и удалить `describe('buildGoogleConnectUrl', …)`.

- [ ] **Step 6: Run tests, lint, build**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: весь набор PASS (Suite 1 — нет неиспользуемых ключей; Suite 3 — русские строки не совпадают с английскими, кроме `emailPh`; тест ключей диалога находит ≥ 20 ключей), lint без предупреждений, сборка успешна. `git grep -n "GmailConnectCard\|presetGmail\|google.userNote\|buildGoogleConnectUrl" frontend/src` — пусто.

- [ ] **Step 7: Commit**

```bash
git add -A frontend/src/components/AddAccountPicker.jsx frontend/src/components/GmailAddForm.jsx frontend/src/components/GmailConnectCard.jsx frontend/src/components/AdminPanel.jsx frontend/src/utils/googleOAuth.js frontend/src/utils/googleOAuth.test.js frontend/src/locales/en.json frontend/src/locales/ru.json frontend/src/locales/i18n.test.js
git commit -m "feat(add-account): add the Add account dialog, remove the temporary Gmail card"
```

---

### Task 3: Фронтенд — пункт «Добавить аккаунт» в меню слева

Спецификация: кнопка «Добавить аккаунт» есть «на вкладке «Аккаунты» и пунктом меню слева». Сейчас в левой панели такого пункта нет; он добавляется в меню пользователя (десктоп — выпадающее меню внизу панели, мобильный — меню панели) над «Настройками» и открывает админку на вкладке «Аккаунты» сразу в выборе варианта.

**Files:**
- Modify: `frontend/src/store/index.js`
- Modify: `frontend/src/components/Sidebar.jsx`
- Modify: `frontend/src/components/AdminPanel.jsx` (`AccountsTab` читает флаг)
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/ru.json`

**Interfaces:**
- Consumes: `AccountsTab` из Task 2 (`subview`, `setSubview`).
- Produces: store `addAccountRequested: boolean`, `openAddAccount()`, `clearAddAccountRequest()`; ключ `sidebar.addAccount`.

- [ ] **Step 1: Store** — в `store/index.js` в блоке «Admin panel» после `setAdminTab: …` добавить:

```js
  // Set by the sidebar's "Add account" item; the accounts tab opens its add view and clears it.
  addAccountRequested: false,
  openAddAccount: () => set({ showAdmin: true, adminTab: 'accounts', addAccountRequested: true }),
  clearAddAccountRequest: () => set({ addAccountRequested: false }),
```

- [ ] **Step 2: AccountsTab** — в `AdminPanel.jsx` в `AccountsTab` к деструктуризации `useStore()` добавить `addAccountRequested, clearAddAccountRequest` и после объявления `closeAdd` добавить:

```js
  useEffect(() => {
    if (!addAccountRequested) return;
    clearAddAccountRequest();
    setAddKind(null);
    setSubview('add');
  }, [addAccountRequested, clearAddAccountRequest]);
```

- [ ] **Step 3: Sidebar** — оба меню живут в компоненте `Sidebar` (`export default function Sidebar()`, строка 263). К деструктуризации store (строка 268, где `setShowAdmin, setAdminTab`) добавить `openAddAccount`. В объект `ICONS` на уровне модуля (строка 24) после `settings: (…),` добавить:

```js
  addAccount: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
```

Десктопное меню пользователя: перед строкой `<CtxMenuItem icon={ICONS.settings} label={t('sidebar.settings')}` (около строки 2106) добавить:

```jsx
          <CtxMenuItem icon={ICONS.addAccount} label={t('sidebar.addAccount')}
            onClick={() => { setUserMenuOpen(false); openAddAccount(); }} />
```

Мобильное меню: перед комментарием `{/* Settings */}` (около строки 1841) добавить:

```jsx
          {/* Add account */}
          <div
            onClick={() => { openAddAccount(); setMobileSidebarOpen(false); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 14px', cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
            onTouchStart={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
            onTouchEnd={e => e.currentTarget.style.background = ''}
            onTouchCancel={e => e.currentTarget.style.background = ''}
          >
            <span style={{ color: 'var(--text-tertiary)', display: 'flex', flexShrink: 0 }}>{ICONS.addAccount}</span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{t('sidebar.addAccount')}</span>
          </div>
```

- [ ] **Step 4: Locale keys** — в объект `sidebar` добавить: en `"addAccount": "Add account"`, ru `"addAccount": "Добавить аккаунт"`.

- [ ] **Step 5: Run tests, lint, build**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: PASS, lint чистый, сборка успешна.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store/index.js frontend/src/components/Sidebar.jsx frontend/src/components/AdminPanel.jsx frontend/src/locales/en.json frontend/src/locales/ru.json
git commit -m "feat(add-account): open the Add account dialog from the sidebar menu"
```

---

### Task 4: Бэкенд — конец старого `GET /oauth/google` и параметра `reserve`

Закрывает три хвоста из PR 8a (#58): старый путь `login_hint` без брони, который к тому же не видел чужих действующих броней, уходит целиком; устаревшие комментарии в `googleAppSelection.js` исправляются; сигнатура в спецификации снова верна (`reserve` удалён, см. Task 7).

**Files:**
- Modify: `backend/src/services/oauth/googleAppSelection.js`
- Modify: `backend/src/services/oauth/oauthState.js` (только комментарий)
- Modify: `backend/src/routes/oauthGoogle.js`
- Test: `backend/src/services/oauth/googleAppSelection.test.js`, `backend/src/routes/oauth.google.test.js`

**Interfaces:**
- Consumes: `createOAuthState`, `consumeOAuthState` (`oauthState.js`, без изменений в коде), `resolveGoogleConfig`, `recordGoogleGrant` (`googleApps.js`), `isUuid` (`utils/uuid.js`).
- Produces:
  - `selectGoogleApp({ email, account = null }) → Promise<{ appId: string, reserved: boolean }>`; без `email` бросает `TypeError('selectGoogleApp needs an email')`; ошибки выбора — `GoogleAppSelectionError` с `code` `not_configured` | `no_app_capacity`.
  - `GET /oauth/google?account=<uuid>` — единственная форма старта в этом роутере; всё остальное → `302 /?oauth_error=invalid_state&oauth_provider=google`.
  - Callback: state с `mode` не `add`/`reconnect` или без `email` → `invalid_state`.

- [ ] **Step 1: Write the failing selection tests** — в `googleAppSelection.test.js` удалить тесты `without an email picks an app with room but reserves nothing`, `reserve: false picks the first app with room and leaves Redis untouched`, `reserve: false still reports no_app_capacity when no active app has grant room`, `reserve: false returns an app with an existing live reservation without extending it` и на их место в `describe('selectGoogleApp')` добавить:

```js
  it('requires an email: every flow names the address it connects', async () => {
    installApps([app('a1')]);
    await expect(selectGoogleApp()).rejects.toThrow(TypeError);
    await expect(selectGoogleApp({ email: '' })).rejects.toThrow(TypeError);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('a repeated start for the same email keeps its app and refreshes the one reservation', async () => {
    installApps([app('a1', { user_limit: 1 })]);
    await selectGoogleApp({ email: 'x@gmail.com' });
    const before = zsets.get(key('a1')).get(googleEmailDigest('x@gmail.com'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(selectGoogleApp({ email: 'x@gmail.com' })).resolves.toEqual({ appId: 'a1', reserved: true });
    expect(zsets.get(key('a1')).size).toBe(1);
    expect(zsets.get(key('a1')).get(googleEmailDigest('x@gmail.com'))).toBeGreaterThan(before);
  });
```

Run: `bt src/services/oauth/googleAppSelection.test.js`
Expected: FAIL — `requires an email` (сейчас без email функция возвращает `{ appId: 'a1', reserved: false }`).

- [ ] **Step 2: Implement** — в `googleAppSelection.js`:

Комментарий над `releaseGoogleSeat` заменить на:

```js
// Called on the callback once the grant is journaled (so a seat never looks free while the code
// exchange is in flight), on every callback path that ends before that, and by a start that fails
// after reserving. A brief double count (reservation + grant) is intended.
```

Комментарий `// \`reserve: false\` picks an app …` и функцию `selectGoogleApp` заменить на:

```js
// Picks the app for one address and, when that costs a new seat, reserves it. Every caller names
// the address: adding goes through POST /api/oauth/google/start (under the CSRF check), and a
// reconnect names the mailbox. Returns { appId, reserved }; `reserved` tells the caller to release
// the seat if it gives up before the callback.
export async function selectGoogleApp({ email, account = null } = {}) {
  if (!email) throw new TypeError('selectGoogleApp needs an email');
  return withTransaction(async (client) => {
    await client.query(SELECTION_LOCK);
    const { rows } = await client.query(APPS_WITH_SEATS, [email]);
    const usable = rows.filter((app) => app.status !== 'disabled');
    if (!usable.length) throw new GoogleAppSelectionError('not_configured');

    // A reconnect stays where its refresh token lives.
    const own = account?.oauth_app_id ? usable.find((app) => app.id === account.oauth_app_id) : null;
    if (own) return { appId: own.id, reserved: false };

    // Google already counted this email in that app: going back there costs no seat.
    const known = usable.find((app) => app.granted);
    if (known) return { appId: known.id, reserved: false };

    const now = Date.now();
    const active = usable.filter((app) => app.status === 'active');
    // A repeated start for the same email keeps its app and refreshes its one reservation.
    for (const app of active) {
      if (await hasLiveReservation(app.id, email, now)) {
        await reserveSeat(app.id, email, now);
        return { appId: app.id, reserved: true };
      }
    }
    for (const app of active) {
      if (await hasFreeSeat(app, now)) {
        await reserveSeat(app.id, email, now);
        return { appId: app.id, reserved: true };
      }
    }
    throw new GoogleAppSelectionError('no_app_capacity');
  });
}
```

`googleHasCapacity` не меняется (он передаёт `null` в `APPS_WITH_SEATS`, а не в `selectGoogleApp`).

Run: `bt src/services/oauth/googleAppSelection.test.js`
Expected: PASS.

- [ ] **Step 3: Rewrite the route tests (failing first)** — в `oauth.google.test.js`:

1. Добавить импорт настоящего хранилища state (Redis в файле уже подменён памятью) и константу id ящика на верхнем уровне, после `const MAIL_SCOPE = …`:

```js
import { createOAuthState } from '../services/oauth/oauthState.js';
```

```js
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
```

Внутренние объявления `const ACCOUNT_ID = '22222222-…'` в `describe('reconnect by mailbox id')`, в тесте `refuses a reconnect signed in as another Google identity of the same address` и в `describe('reconnect onto another app')` удалить.

2. После `startFlow` добавить помощники:

```js
// The add flow starts at POST /api/oauth/google/start (covered by oauthGoogleApi.test.js). Here its
// state is created the way that route creates it, through the real single-use store.
async function seedAddState(email = 'user@gmail.com') {
  const { state } = await createOAuthState({
    provider: 'google', userId: USER_ID, loginHint: email, appId: APP_ID, mode: 'add', email,
  });
  return { state };
}

// A reconnect of ACCOUNT_ID started through GET /oauth/google?account=.
function startReconnect(row = {}) {
  query.mockResolvedValueOnce({
    rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID, ...row }],
  });
  return startFlow(`?account=${ACCOUNT_ID}`);
}

// An existing Gmail mailbox as the callback transaction sees it.
const existingMailbox = (extra = {}) => ({
  id: ACCOUNT_ID, oauth_provider: 'google', oauth_refresh_token: 'enc(old-refresh)', oauth_app_id: APP_ID, ...extra,
});
```

3. `describe('GET /oauth/google')` целиком заменить на:

```js
describe('GET /oauth/google', () => {
  it('requires an authenticated MailExpert session', async () => {
    const res = await get(`/oauth/google?account=${ACCOUNT_ID}`, { user: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
  });

  it.each([
    ['no parameters', ''],
    ['a login_hint', '?login_hint=user%40gmail.com'],
    ['an empty account', '?account='],
  ])('refuses a start with %s: adding goes through POST /api/oauth/google/start', async (_name, qs) => {
    query.mockResolvedValue({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google' }] });
    const res = await get(`/oauth/google${qs}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?oauth_error=invalid_state&oauth_provider=google');
    expect(selectGoogleApp).not.toHaveBeenCalled();
    expect(redisStore.size).toBe(0);
  });

  it('stores state + PKCE verifier server-side and redirects to Google with the challenge only', async () => {
    const { res, location, state } = await startReconnect();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = location.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('login_hint')).toBe('user@gmail.com');
    expect(p.has('code_verifier')).toBe(false);
    const saved = JSON.parse([...redisStore.values()][0]);
    expect(saved).toMatchObject({ userId: USER_ID, appId: APP_ID, mode: 'reconnect', email: 'user@gmail.com', accountId: ACCOUNT_ID });
    expect(p.get('code_challenge')).toBe(createHash('sha256').update(saved.codeVerifier).digest('base64url'));
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('redirects with not_configured when the chosen app is gone', async () => {
    googleApps.byId = {};
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, email_address: 'user@gmail.com', oauth_provider: 'google', oauth_app_id: APP_ID }] });
    const res = await get(`/oauth/google?account=${ACCOUNT_ID}`);
    expect(res.headers.get('location')).toBe('/?oauth_error=not_configured&oauth_provider=google');
  });
});
```

(Если в старом тесте `stores state + PKCE …` проверялись ещё параметры — `redirect_uri`, `access_type`, `prompt`, `scope`, — перенести эти `expect` в новый тест без изменений.)

4. Механическая замена в остальных тестах добавления: каждое `await startFlow()` и `await startFlow('?login_hint=user%40gmail.com')` заменить на `await seedAddState()` (в том числе `const second = await startFlow('?login_hint=user%40gmail.com');` → `const second = await seedAddState();`). Исключения — тесты, где уже есть ящик и ожидается `updated`/`UPDATE`: они становятся переподключениями, их тело заменить так:

`updates an existing account, keeps the stored refresh token and clears the reconnect flag`:

```js
  it('updates an existing account, keeps the stored refresh token and clears the reconnect flag', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox() });
    mockSuccessfulGoogle({ refreshToken: null, email: 'User@Gmail.com' });

    const res = await callback({ code: 'c', state });

    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=updated');
    const lock = sqlCall(/pg_advisory_xact_lock/);
    expect(lock[1]).toEqual([`oauth-account:user@gmail.com`]);
    expect(sqlCall(/^\s*SELECT id, oauth_provider, oauth_refresh_token, oauth_app_id, oauth_subject FROM email_accounts/)[0]).toMatch(/lower\(email_address\) = lower\(\$1\)/);
    const [updateSql, updateParams] = sqlCall(/^\s*UPDATE email_accounts/);
    expect(updateSql).toMatch(/oauth_refresh_token = COALESCE\(\$2, oauth_refresh_token\)/);
    expect(updateSql).toMatch(/oauth_reconnect_required = false/);
    expect(updateSql).toMatch(/sync_error = NULL/);
    expect(updateSql).toMatch(/oauth_provider = 'google'/);
    expect(updateParams[0]).toBe('enc(access-tok)');
    expect(updateParams[1]).toBeNull();
    expect(updateSql).toMatch(/oauth_app_id = \$4, oauth_subject = \$5/);
    expect(updateParams.slice(3)).toEqual([APP_ID, 'sub-1', ACCOUNT_ID]);
    expect(sqlCall(/^\s*INSERT INTO email_accounts/)).toBeUndefined();
    await vi.waitFor(() => expect(imapManager.connectAccount).toHaveBeenCalled());
    expectCooldownClearedBeforeConnect(ACCOUNT_ID);
  });
```

`rejects an existing account without any refresh token to keep`:

```js
  it('rejects an existing account without any refresh token to keep', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox({ oauth_refresh_token: null }) });
    mockSuccessfulGoogle({ refreshToken: null });
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('missing_refresh_token'));
    expect(sqlCall(/^\s*UPDATE email_accounts/)).toBeUndefined();
  });
```

`refuses to move a mailbox to another app without a new refresh token`:

```js
  it('refuses to move a mailbox to another app without a new refresh token', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox({ oauth_app_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }) });
    mockSuccessfulGoogle({ refreshToken: null });
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('missing_refresh_token'));
    expect(sqlCall(/^\s*UPDATE email_accounts/)).toBeUndefined();
  });
```

`records a reconsent through the same app as a reconnect only`:

```js
  it('records a reconsent through the same app as a reconnect only', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox() });
    mockSuccessfulGoogle({ refreshToken: null });
    await callback({ code: 'c', state });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: USER_ID, accountId: ACCOUNT_ID, action: 'mailbox.reconnected', details: { oauthProvider: 'google' } },
    ]);
  });
```

`records a move to another app as a connection change`:

```js
  it('records a move to another app as a connection change', async () => {
    const { state } = await startReconnect();
    installDb({ existing: existingMailbox({ oauth_app_id: OLD_APP_ID }) });
    mockSuccessfulGoogle();
    await callback({ code: 'c', state });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: USER_ID, accountId: ACCOUNT_ID, action: 'mailbox.reconnected', details: { oauthProvider: 'google' } },
      { actorUserId: USER_ID, accountId: ACCOUNT_ID, action: 'mailbox.connection_changed', details: { fields: ['oauth_app_id'] } },
    ]);
  });
```

В `starts a reconnect for any signed-in user with the mailbox address as login_hint` ожидание вызова выбора заменить на:

```js
    expect(selectGoogleApp).toHaveBeenCalledWith({ email: 'user@gmail.com', account: expect.objectContaining({ id: ACCOUNT_ID }) });
```

и удалить комментарий `// A reconnect keeps reserving as before: …`.

5. В `describe('GET /oauth/google/callback')` добавить тесты:

```js
  it.each([
    ['the removed upsert mode', { mode: 'upsert', email: null }],
    ['no mode (a state from before the modes)', { mode: null, email: null }],
    ['an add without an address', { mode: 'add', email: null }],
  ])('refuses a state with %s as invalid_state before talking to Google', async (_name, extra) => {
    const { state } = await createOAuthState({ provider: 'google', userId: USER_ID, appId: APP_ID, ...extra });
    mockSuccessfulGoogle();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('invalid_state'));
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

```

Run: `bt src/routes/oauth.google.test.js`
Expected: FAIL — `refuses a start with no parameters …` (старый код стартует `upsert`), `refuses a state with the removed upsert mode …`, `starts a reconnect …` (вызов с `reserve: true`).

- [ ] **Step 4: Implement the route** — в `oauthGoogle.js`:

Комментарий и функцию `resolveStartTarget` заменить на:

```js
// `?account=<id>` names the Gmail mailbox to reconnect; nothing else starts a flow here. Adding a
// mailbox goes through POST /api/oauth/google/start, where the CSRF check covers the seat it
// reserves, and the address never travels in a MailExpert URL.
async function resolveReconnectTarget(req) {
  const id = typeof req.query.account === 'string' ? req.query.account : '';
  if (!isUuid(id)) throw new CallbackError('invalid_state');
  const { rows } = await query(
    'SELECT id, email_address, oauth_provider, oauth_app_id FROM email_accounts WHERE id = $1',
    [id],
  );
  const account = rows[0];
  if (!account || account.oauth_provider !== PROVIDER) throw new CallbackError('invalid_state');
  return { email: account.email_address.toLowerCase(), account };
}
```

В `router.get('/')`: комментарий над маршрутом — `// Step 1 of a reconnect: pick the app, create state + PKCE and send the user to Google.`; тело `try`:

```js
    target = await resolveReconnectTarget(req);
    selected = await selectGoogleApp({ email: target.email, account: target.account });
    const config = await resolveGoogleConfig({ appId: selected.appId, origin: allowedRequestOrigin(req) });
    if (!config) throw new CallbackError('not_configured');
    const { state, codeChallenge } = await createOAuthState({
      provider: PROVIDER,
      userId: req.session.userId,
      loginHint: target.email,
      appId: config.appId,
      mode: 'reconnect',
      email: target.email,
      accountId: target.account.id,
    });
```

(остальное тело и `catch` без изменений; три строки комментария про legacy login_hint удалить).

В callback сразу после проверки сессии (`if (!pending || !req.session?.userId || …) throw …`) добавить:

```js
    // Only the two flows this version starts: a state issued before the update (the removed
    // upsert mode) or without an address cannot say what to check, so it is refused.
    if (!FLOW_MODES.has(pending.mode) || !pending.email) throw new CallbackError('invalid_state');
```

рядом с `CALLBACK_ERROR_CODES`:

```js
const FLOW_MODES = new Set(['add', 'reconnect']);
```

Проверку адреса сделать безусловной:

```js
    // The user may pick another Google account on Google's page than the one asked for.
    if (identity.email.toLowerCase() !== pending.email) throw new CallbackError('account_mismatch');
```

и условие снятия брони — `if (pending.appId) { await releaseGoogleSeat(pending.appId, pending.email); released = true; }`.

В `upsertGoogleAccount` (переименовать в `saveGoogleAccount`, обновить вызов) после `const row = existing.rows[0] || null;` проверки заменить на:

```js
    if (pending.mode === 'add' && row) throw new CallbackError('already_connected');
    if (pending.mode === 'reconnect' && (!row || row.id !== pending.accountId || row.oauth_provider !== PROVIDER)) {
      throw new CallbackError('invalid_state');
    }
```

(проверка `oauth_subject` остаётся как есть; ветвление `if (row) { UPDATE } else { INSERT }` теперь означает `reconnect`/`add`, комментарий над функцией заменить на:)

```js
// Create the mailbox of an `add` flow or refresh the one a `reconnect` names, under a
// transaction-scoped advisory lock so racing callbacks for one address cannot insert duplicates.
// Mailboxes are shared, so the address alone names one; userId only records who added it. The
// account is bound to the app whose client issued the tokens.
```

Импорт `import { GOOGLE_EMAIL_PATTERN, consumeGoogleLaunch } from '../services/oauth/googleLaunch.js';` заменить на `import { consumeGoogleLaunch } from '../services/oauth/googleLaunch.js';` (`GOOGLE_EMAIL_PATTERN` здесь больше не нужен, иначе lint `no-unused-vars`).

В `oauthState.js` в комментарии над `createOAuthState` фразу `` `mode` (`add`, `reconnect`, `upsert`) `` заменить на `` `mode` (`add` from the Gmail form, `reconnect` by mailbox id) ``.

Run: `bt src/routes/oauth.google.test.js src/services/oauth/googleAppSelection.test.js src/routes/oauthGoogleApi.test.js`
Expected: PASS. `oauthGoogleApi.test.js` не меняется: `/start` уже вызывает `selectGoogleApp({ email })`.

- [ ] **Step 5: Check nothing else uses the removed paths**

Run: `git grep -n "reserve:\|'upsert'\|login_hint=" -- backend/src`
Expected: только `buildGoogleAuthorizationUrl`/тесты launch, где `login_hint` — параметр URL Google, а не MailExpert; `reserve:` и `'upsert'` не встречаются.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/oauth/googleAppSelection.js backend/src/services/oauth/googleAppSelection.test.js backend/src/services/oauth/oauthState.js backend/src/routes/oauthGoogle.js backend/src/routes/oauth.google.test.js
git commit -m "feat(google-oauth): start only reconnects by mailbox id, drop the legacy add paths"
```

---

### Task 5: Бэкенд — новые Google-ящики в режиме цепочек `gmail`

Что уже обеспечивает правильные цепочки с первой синхронизации — прочитано в коде и покрыто существующими тестами, менять не нужно:
- у нового ящика нет кэша писем, поэтому `connectAccount` запускает `backfillAllFolders` (`imapManager.js` около строки 2315), а тот в `finally` — догрузку идентификаторов `startProviderIdBackfill` (около строки 4578; она работает только для хоста Gmail, `providerProfile(...).gmailThreadIds`);
- синхронизация и догрузка писем запрашивают `X-GM-THRID` для хоста Gmail, а `computeThreading` в режиме `gmail` ставит ключ `gmail:<thrid>` с причиной `gmail-thrid` — тесты `sync keys a new message by the Gmail thread number in gmail mode` и `backfill keys a new message by the Gmail thread number in gmail mode` в `imapManager.test.js` (блок `gmail thread mode (PR C1)`);
- строки, которые приложение записало само (Sent/Drafts после APPEND), приходят без номеров; догрузка идентификаторов перекладывает их в ключи `gmail:` по текущему режиму (`rekeyNow`) — `imapManager.providerIds.test.js` (вызов `startProviderIdBackfill({ ...gmail, thread_mode: 'gmail' })`) и `threading/providerIdBackfill.test.js`;
- callback подключает ящик строкой `SELECT *` после вставки, поэтому `thread_mode` уже в памяти `imapManager`;
- `_resumeThreadRecompute` без строки `thread_recompute` ничего не делает; флаги пересчёта и состояние догрузки для нового ящика не нужны.

Условия ручного переключения (`not_gmail`, `ids_missing`) для нового Google-ящика выполняются тривиально; условие `index_invalid` — открытый вопрос владельцу: по умолчанию режим ставится безусловно, сервер при старте уже предупреждает о неисправном индексе `idx_messages_provider_thread`.

**Files:**
- Modify: `backend/src/routes/oauthGoogle.js`
- Test: `backend/src/routes/oauth.google.test.js`

**Interfaces:**
- Consumes: `THREAD_MODE_GMAIL` из `backend/src/services/threading/threadId.js`.
- Produces: `INSERT INTO email_accounts` в `saveGoogleAccount` пишет `thread_mode = 'gmail'` (параметр `$10`); `UPDATE` не трогает `thread_mode`.

- [ ] **Step 1: Write the failing test** — в `oauth.google.test.js` в тесте `creates a Gmail account with fixed hosts, encrypted tokens and unified inbox off` заменить три ожидания:

```js
    expect(insertSql).toMatch(/include_in_unified_inbox,\s*oauth_app_id, oauth_subject, thread_mode/);
    expect(insertSql).toMatch(/false, false, false,\s*\$8, \$9, \$10\)\s*RETURNING id/);
```

и

```js
    expect(insertParams.slice(7)).toEqual([APP_ID, 'sub-1', 'gmail']);
```

В тест `updates an existing account, keeps the stored refresh token and clears the reconnect flag` добавить после `const [updateSql, updateParams] = …`:

```js
    // An existing mailbox keeps the threading mode it has; only a new one starts in gmail mode.
    expect(updateSql).not.toMatch(/thread_mode/);
```

Run: `bt src/routes/oauth.google.test.js`
Expected: FAIL — в `INSERT` нет `thread_mode`.

- [ ] **Step 2: Implement** — в `oauthGoogle.js` импорт:

```js
import { THREAD_MODE_GMAIL } from '../services/threading/threadId.js';
```

В `saveGoogleAccount` ветку `INSERT` заменить на:

```js
      // A new Gmail mailbox threads by Gmail's own thread number from its first sync: the sync
      // stores X-GM-THRID for every message of a Gmail host, and rows the app appends itself are
      // rekeyed by the provider id backfill. Existing mailboxes keep their mode (owner decision
      // 2026-09-21); switching one is the admin's threading action.
      const inserted = await client.query(`
        INSERT INTO email_accounts (
          added_by, name, email_address, color, protocol,
          imap_host, imap_port, imap_tls,
          smtp_host, smtp_port, smtp_tls,
          auth_user,
          oauth_provider, oauth_access_token, oauth_refresh_token, oauth_token_expiry,
          oauth_public_client, oauth_reconnect_required, include_in_unified_inbox,
          oauth_app_id, oauth_subject, thread_mode
        ) VALUES ($1, $2, $3, $4, 'imap',
          'imap.gmail.com', 993, true,
          'smtp.gmail.com', 465, 'SSL',
          $3,
          'google', $5, $6, $7,
          false, false, false,
          $8, $9, $10)
        RETURNING id
      `, [pending.userId, identity.name || email, email, color, encryptedAccess, encryptedRefresh, tokens.expiresAt, appId, identity.sub, THREAD_MODE_GMAIL]);
```

Run: `bt src/routes/oauth.google.test.js src/services/threading/threadId.test.js`
Expected: PASS.

- [ ] **Step 3: Confirm the first-sync coverage** — существующие тесты, на которые опирается решение (не меняются):

Run: `bt src/services/imapManager.test.js src/services/imapManager.providerIds.test.js src/services/threading/providerIdBackfill.test.js`
Expected: PASS, в том числе `sync keys a new message by the Gmail thread number in gmail mode` и `backfill keys a new message by the Gmail thread number in gmail mode`. Если какого-то из названных тестов нет или он проверяет не это — остановиться и доложить, а не считать поведение покрытым.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/oauthGoogle.js backend/src/routes/oauth.google.test.js
git commit -m "feat(google-oauth): create new Gmail mailboxes in gmail threading mode"
```

---

### Task 6: Бэкенд — ручное добавление ящика только администратору

**Files:**
- Modify: `backend/src/routes/accounts.js`
- Create: `backend/src/routes/accounts.create.test.js`

**Interfaces:**
- Consumes: `requireAdmin` из `middleware/auth.js` (уже импортирован в `accounts.js`).
- Produces: `POST /api/accounts` — `403 { error: 'Admin access required' }` не-администратору (ответ реального `requireAdmin`); администратору — как раньше, `thread_mode` не задаётся (остаётся `rfc` по умолчанию).

- [ ] **Step 1: Write the failing test** — `backend/src/routes/accounts.create.test.js`:

```js
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
// Stands in for the real requireAdmin (which checks the users table): flip `session.isAdmin`
// to run a request as an ordinary signed-in user.
const session = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
  requireAdmin: (_req, res, next) => (
    session.isAdmin ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));
vi.mock('../index.js', () => ({
  imapManager: { connectAccount: vi.fn(() => Promise.resolve(true)) },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: vi.fn((v) => (v ? `enc:${v}` : v)), decrypt: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: true }),
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn(async () => []) } }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ID = '77777777-7777-4777-8777-777777777777';
const BODY = {
  name: 'Team', email_address: 'team@example.com', protocol: 'imap',
  imap_host: 'imap.example.com', imap_port: 993, smtp_host: 'smtp.example.com', smtp_port: 587,
  auth_user: 'team@example.com', auth_pass: 'secret',
};

// Setting up a server by hand is an admin task until PR 9 adds the domain mailbox kind; everyone
// else adds Gmail through the Google flow.
describe('POST /api/accounts (manual server setup)', () => {
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
    session.isAdmin = true;
    query.mockReset().mockResolvedValue({ rows: [{ id: ID, protocol: 'imap', email_address: BODY.email_address }] });
  });

  const post = (body) => fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('refuses an ordinary user without touching the database', async () => {
    session.isAdmin = false;
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admin access required' });
    expect(query).not.toHaveBeenCalled();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('lets an administrator add a mailbox, which keeps the default rfc threading', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    const [sql] = query.mock.calls.find(([s]) => /INSERT INTO email_accounts/.test(s));
    expect(sql).not.toMatch(/thread_mode/);
  });
});
```

Run: `bt src/routes/accounts.create.test.js`
Expected: FAIL — `refuses an ordinary user …` получает 200.

- [ ] **Step 2: Implement** — в `accounts.js` строку `router.post('/', async (req, res) => {` заменить на:

```js
// Manual server setup is an admin task: an ordinary user adds Gmail through the Google flow.
// PR 9 opens this route to everyone for `kind: 'domain'` (a mailbox on the configured mail node).
router.post('/', requireAdmin, async (req, res) => {
```

Run: `bt src/routes/accounts.create.test.js src/routes/accounts.shared.test.js src/routes/accounts.audit.test.js src/routes/accounts.reconnectCooldown.test.js`
Expected: PASS (в остальных файлах `requireAdmin` подменён пропуском).

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/accounts.js backend/src/routes/accounts.create.test.js
git commit -m "feat(accounts): restrict manual mailbox setup to administrators"
```

---

### Task 7: Спецификации и полная проверка

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`
- Modify: `docs/superpowers/specs/2026-09-15-google-multi-app-design.md`

**Interfaces:**
- Consumes: всё из Task 1–6.
- Produces: статус серии, уточнения 8c, пояснение к `selectGoogleApp`.

- [ ] **Step 1: Shared-mailboxes spec** — в строке статуса «PR 8a (бэкенд Google-приложений) и PR 8b (админка «Google-приложения») реализованы.» заменить на «PR 8a (бэкенд Google-приложений), PR 8b (админка «Google-приложения») и PR 8c (диалог «Добавить аккаунт») реализованы.». В конец раздела «## Уточнения, принятые при реализации PR 8» (перед «## Проверка») добавить:

```markdown
- 8c: `GET /oauth/google` принимает только `?account=<id>`; без него и с `?login_hint=` — redirect с `invalid_state`. Режим `upsert` удалён. Callback принимает state только с режимом `add` или `reconnect` и с адресом, иначе `invalid_state` (так отклоняются и state, выданные до обновления). Адрес на callback сверяется всегда.
- 8c: `selectGoogleApp({ email, account })` — email обязателен, место бронируется всегда, когда выбрано приложение без записи журнала. Параметр `reserve` из 8a был нужен только старому GET-пути добавления и удалён вместе с ним; вместе с этим путём ушла и его неточность — он не видел действующих броней других потоков.
- 8c: новые Google-ящики создаются с `thread_mode = 'gmail'` (решение владельца 2026-09-21). Переподключение режим не меняет; ручное добавление и Microsoft остаются `rfc`. Правильные цепочки с первой синхронизации обеспечивает существующий код: `X-GM-THRID` загружается для любого ящика Gmail, строки, записанные самим приложением, перекладываются догрузкой идентификаторов. Исправность индекса `idx_messages_provider_thread` при создании не проверяется: о неисправном индексе сервер предупреждает при старте.
- 8c: `POST /api/accounts` — только для администратора (`403`), пока нет `kind`; PR 9 откроет `kind: 'domain'`. Не-администратор добавляет ящики только через Gmail; правка, удаление и переподключение остаются всем.
- 8c: диалог «Добавить аккаунт» — вариант, затем его форма; варианты задаёт `addAccountOptions` (`utils/addAccount.js`), формы — таблица `kind → форма` в `AdminPanel.jsx`. Доменный ящик не рендерится до PR 9. Подсказка при вводе берёт все ящики установки из store: ящики общие. Вкладку Google браузер может заблокировать незаметно для страницы (она открывается после ответа сервера), поэтому ссылка «Открыть страницу Google» показывается после каждого старта, пока действует ключ перехода (60 с). Пресет Gmail (IMAP с паролем приложения) из ручной формы убран.
- 8c: пункт «Добавить аккаунт» слева — в меню пользователя над «Настройками» (десктоп и мобильный); открывает вкладку «Аккаунты» сразу в выборе варианта.
- 8c: временная карточка `GmailConnectCard` удалена; «Переподключить Gmail» во вкладке «Аккаунты» и в списке слева идут через `reconnectUrlFor` → `/oauth/google?account=<id>`. Текст результата `updated` — «Ящик Gmail переподключён»: без `upsert` его даёт только переподключение.
```

- [ ] **Step 2: Multi-app spec** — в `2026-09-15-google-multi-app-design.md` в разделе «## Выбор приложения» после первого абзаца (`` `selectGoogleApp({ email, account })` выполняется … ``) добавить абзац:

```markdown
Email обязателен: добавление передаёт адрес из формы, переподключение — адрес ящика. Место бронируется всегда, когда выбрано приложение без записи журнала (шаг 3); отдельного флага «без брони» нет. В PR 8a–8b такой флаг (`reserve: false`) был у старого GET-пути добавления, в 8c он удалён вместе с этим путём.
```

- [ ] **Step 3: Full verification**

Run: `bt` (весь бэкенд), затем в том же контейнере `npm run lint`; `cd frontend && npm test && npm run lint && npm run build`.
Expected: все тесты проходят, lint без ошибок, сборка успешна. Если бэкенд-набор падает в файлах, которые эта серия не трогала, — сравнить с прогоном на `feat/google-apps-admin-screen` в том же контейнере и доложить, не чинить обходом.

Run: `git grep -n "login_hint=\|buildGoogleConnectUrl\|GmailConnectCard\|'upsert'\|reserve: false" -- backend/src frontend/src`
Expected: пусто (кроме `login_hint` как параметра URL Google в `services/oauth/googleOAuth.js` и его тестах).

- [ ] **Step 4: Manual check** (если поднят тестовый стенд; иначе явно доложить, что не выполнялось) — под обычным пользователем: «Добавить аккаунт» во вкладке «Аккаунты» и в меню слева показывает только «Ящик Gmail»; при вводе части адреса подключённого ящика — «Уже подключено», «Продолжить» неактивна; адрес из журнала — «Подключался раньше» и подставляется Enter; новый адрес открывает вкладку Google и ссылку «Открыть страницу Google»; `POST /api/accounts` из консоли — 403. Под администратором: есть «Другой сервер вручную» без пресета Gmail. У ящика с «нужно переподключить» кнопка слева открывает `/oauth/google?account=<id>`. Новый Gmail-ящик после первой синхронизации: `SELECT thread_mode FROM email_accounts WHERE email_address = …` → `gmail`, у писем `threading_reason = 'gmail-thrid'`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md docs/superpowers/specs/2026-09-15-google-multi-app-design.md
git commit -m "docs: record PR 8c decisions for the Add account dialog"
```
