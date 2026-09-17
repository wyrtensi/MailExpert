# Общие ящики, PR 5: интерфейс журнала — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Субагенты разрешены глобальными инструкциями пользователя: исполнители и ревьюеры не ниже Sonnet, финальное ревью ветки — Opus, одновременно не больше трёх.

**Goal:** администратор видит журнал действий в панели настроек: вкладка «Журнал» с фильтрами по ящику, пользователю, действию и датам и подгрузкой следующей страницы; подтверждение удаления ящика переведено и предупреждает, что ящик пропадёт у всех пользователей.

**Architecture:**
- Логика без интерфейса — в `frontend/src/utils/auditLog.js`: список действий и их ключей перевода, построение запроса к `GET /api/admin/audit`, описание колонки «Подробности». Её покрывает `node --test`.
- Экран — отдельный компонент `frontend/src/components/AuditLogTab.jsx` по образцу `MailboxSyncSettings.jsx`. `AdminPanel.jsx` только регистрирует вкладку `audit` в группе «Администрирование» с `adminOnly: true`.
- `api.admin.getAuditLog(params)` рядом с `getAuthEvents`.
- Демо-режим отвечает на `GET /admin/audit` фикстурами по демо-ящикам.
- Бэкенд не меняется.

**Tech Stack:** React 19, zustand, react-i18next, Vite, `node --test`, jsdom.

**Spec:** `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` — разделы «Журнал», «Разбиение на PR» (пункт 5), «Уточнения, принятые при реализации PR 4».

## Global Constraints

- Комментарии в коде — только на английском.
- Коммиты и PR — от имени `wyrtensi`, без строк атрибуции. Все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- В документах, коммитах и PR — только заглушки `<CF_HOST>`, `<DIRECT_HOST>`, `<TEAM>`, `<AUD>`. Внутренние имена других проектов не упоминаются.
- Журнал видит только администратор: вкладка `adminOnly`, API уже отвечает 403 остальным.
- Весь текст интерфейса — через `t()`, ключи есть во всех 9 локалях (`en`, `ru`, `de`, `es`, `fr`, `it`, `cs`, `pl`, `zhCN`), переводы различаются между локалями (`frontend/src/locales/i18n.test.js`).
- Локали хранятся с CRLF; правка — через разбор JSON и запись `JSON.stringify(..., null, 2)` с CRLF, это даёт файл без посторонних изменений.
- Монки-патчинг запрещён.
- Бэкенд не меняется, backend-контейнер не нужен. Frontend-тесты, lint и сборка — локально в `frontend/`.
- Пользовательские контейнеры `mailexpert-frontend`, `mailexpert-backend`, `mailexpert-postgres`, `mailexpert-redis` не пересобираются и не перезапускаются.
- Работа идёт в ветке `feat/audit-log-screen` от `main`. Первый коммит ветки — этот план.

## Уточнения спецификации в этом PR

Task 5 вносит их в спецификацию.

1. **Удаление ящика для всех пользователей** уже работает: PR 3 снял проверку владельца в `DELETE /api/accounts/:id` (тест `accounts.shared.test.js`), вкладка «Аккаунты» не `adminOnly` и не проверяет, кто добавил ящик. PR 5 только переводит подтверждение удаления и говорит в нём, что ящик пропадёт у всех.
2. **Чистка личных настроек, которые стали системными**, сделана раньше:
   - миграция 0055 удалила `syncInterval` и `folderSyncInterval` из `users.preferences`, 0056 — `categorizationEnabled`;
   - `PATCH /api/auth/preferences` эти ключи не принимает;
   - интервалы меняет администратор в `MailboxSyncSettings`, категоризацию — администратор переключателем, у остальных он неактивен;
   - `GET /api/auth/preferences` по-прежнему отдаёт `syncInterval` только для чтения — так решено в PR 2 для резервного обновления без WebSocket.
3. **Экран журнала:**
   - отдельная вкладка «Журнал» в группе «Администрирование», только для администратора;
   - фильтры: ящик (из списка ящиков), пользователь (из списка пользователей), действие (13 действий), даты «с» и «по» включительно по местному времени;
   - «по» передаётся в API как начало следующего дня: в API `to` не включительно;
   - смена фильтра загружает журнал заново с самой новой записи; «Загрузить ещё» передаёт `nextCursor` в `before`;
   - ответ 400 `invalid_filter` показывается как «проверьте фильтры», остальные ошибки — с текстом ошибки;
   - автор без email (пользователь удалён) показывается как «Удалённый пользователь»;
   - колонка «Подробности»: провайдер OAuth, имена изменённых полей, получатели, отправитель и папка удалённого письма с пометкой «в корзину» или «навсегда», email пользователя.
4. **Изменения в списке ящиков у других пользователей** (удалил один — у остальных ящик остаётся до перезагрузки страницы) в спецификации не описаны и в этот PR не входят.

## Как запускать тесты

Из корня репозитория:
- отдельные файлы: `cd frontend && node --test <files>`;
- полный прогон: `cd frontend && npm test && npm run lint && npm run build`;
- если сборка падает на отсутствующем модуле, сначала `cd frontend && npm ci`.

## Файлы

| Файл | Ответственность |
|---|---|
| Create `frontend/src/utils/auditLog.js` (+ `auditLog.test.js`) | Действия и ключи перевода, запрос к API, описание подробностей |
| Modify `frontend/src/utils/api.js` | `api.admin.getAuditLog` |
| Create `frontend/src/components/AuditLogTab.jsx` | Экран журнала |
| Modify `frontend/src/components/AdminPanel.jsx` | Вкладка `audit`; перевод подтверждения удаления ящика |
| Modify `frontend/src/locales/{en,ru,de,es,fr,it,cs,pl,zhCN}.json`, `locales/i18n.test.js` | Строки журнала и подтверждения удаления |
| Modify `frontend/src/demo/index.js` (+ `demo/index.test.js`) | Журнал в демо-режиме |
| Modify `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`, `docs/architecture/codebase-file-map.md` | Уточнения, статус, карта файлов |

---

### Task 1: Логика журнала и API-клиент

**Files:**
- Create: `frontend/src/utils/auditLog.js`
- Test: `frontend/src/utils/auditLog.test.js`
- Modify: `frontend/src/utils/api.js` (блок `admin`, после `getAuthEvents`)

**Interfaces:**
- Produces:
  - `AUDIT_ACTION_LABEL_KEYS: Readonly<Record<string, string>>` — действие → ключ перевода;
  - `AUDIT_ACTIONS: readonly string[]` — 13 действий в порядке показа;
  - `auditActionLabelKey(action: string): string | null`;
  - `auditQuery(filters: { account?, user?, action?, fromDate?, toDate?, before? }): Record<string, string>` — `fromDate`/`toDate` в формате `YYYY-MM-DD` из `<input type="date">`;
  - `auditDetail(entry): { key: string, values: object } | { text: string } | null`;
  - `api.admin.getAuditLog(params): Promise<{ entries, nextCursor }>`.

- [ ] **Step 1: Commit the plan**

```bash
git add docs/superpowers/plans/2026-09-17-shared-mailboxes-pr5-audit-screen.md
git commit -m "docs: plan the audit log screen"
```

- [ ] **Step 2: Write the failing test**

`frontend/src/utils/auditLog.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_ACTIONS, auditActionLabelKey, auditDetail, auditQuery } from './auditLog.js';

describe('AUDIT_ACTIONS', () => {
  it('lists every action the server records, each with a label', () => {
    assert.deepEqual(AUDIT_ACTIONS, [
      'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
      'mailbox.enabled', 'mailbox.disabled', 'message.sent', 'message.deleted',
      'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
    ]);
    assert.equal(auditActionLabelKey('message.sent'), 'admin.audit.actionMessageSent');
    assert.equal(auditActionLabelKey('user.admin_changed'), 'admin.audit.actionUserAdminChanged');
    assert.equal(auditActionLabelKey('message.read'), null);
  });
});

describe('auditQuery', () => {
  it('leaves empty filters out', () => {
    assert.deepEqual(auditQuery({}), {});
    assert.deepEqual(auditQuery({ account: '', user: '', action: '', fromDate: '', toDate: '', before: null }), {});
    assert.deepEqual(auditQuery(), {});
  });

  it('passes the chosen mailbox, user, action and cursor through', () => {
    assert.deepEqual(
      auditQuery({ account: 'acc-1', user: 'user-1', action: 'message.deleted', before: '2026-09-17T10:00:00.123456Z_42' }),
      { account: 'acc-1', user: 'user-1', action: 'message.deleted', before: '2026-09-17T10:00:00.123456Z_42' },
    );
  });

  it('turns local days into an inclusive range: from the start of the first day to the start of the day after the last', () => {
    assert.deepEqual(auditQuery({ fromDate: '2026-09-01', toDate: '2026-09-17' }), {
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 8, 18).toISOString(),
    });
    assert.deepEqual(auditQuery({ toDate: '2026-12-31' }), { to: new Date(2027, 0, 1).toISOString() });
  });

  it('ignores a date that is not a calendar day', () => {
    assert.deepEqual(auditQuery({ fromDate: 'yesterday', toDate: '17.09.2026' }), {});
  });
});

describe('auditDetail', () => {
  it('names the OAuth provider of an added or reconnected mailbox', () => {
    assert.deepEqual(
      auditDetail({ action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: 'google' } }),
      { key: 'admin.audit.detailProvider', values: { provider: 'google' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mailbox.reconnected', details: { oauthProvider: 'microsoft' } }),
      { key: 'admin.audit.detailProvider', values: { provider: 'microsoft' } },
    );
    assert.equal(auditDetail({ action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: null } }), null);
  });

  it('lists changed connection fields', () => {
    assert.deepEqual(
      auditDetail({ action: 'mailbox.connection_changed', details: { fields: ['imap_host', 'auth_pass'] } }),
      { key: 'admin.audit.detailFields', values: { fields: 'imap_host, auth_pass' } },
    );
    assert.equal(auditDetail({ action: 'mailbox.connection_changed', details: { fields: [] } }), null);
  });

  it('lists every recipient of a sent message', () => {
    assert.deepEqual(
      auditDetail({ action: 'message.sent', details: { messageId: '<m@x>', to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'] } }),
      { key: 'admin.audit.detailRecipients', values: { recipients: 'a@example.com, b@example.com, c@example.com' } },
    );
  });

  it('tells a move to Trash from a permanent delete', () => {
    assert.deepEqual(
      auditDetail({ action: 'message.deleted', details: { messageId: '<m@x>', folder: 'INBOX', from: 's@example.com', permanent: false } }),
      { key: 'admin.audit.detailMovedToTrash', values: { from: 's@example.com', folder: 'INBOX' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'message.deleted', details: { folder: 'Trash', from: null, permanent: true } }),
      { key: 'admin.audit.detailDeletedForever', values: { from: '', folder: 'Trash' } },
    );
  });

  it('describes user actions by email', () => {
    assert.deepEqual(
      auditDetail({ action: 'user.admin_changed', details: { userId: 'u', email: 'u@example.com', isAdmin: true } }),
      { key: 'admin.audit.detailAdminGranted', values: { email: 'u@example.com' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'user.admin_changed', details: { userId: 'u', email: 'u@example.com', isAdmin: false } }),
      { key: 'admin.audit.detailAdminRevoked', values: { email: 'u@example.com' } },
    );
    assert.deepEqual(auditDetail({ action: 'user.disabled', details: { userId: 'u', email: 'u@example.com', isAdmin: false } }), { text: 'u@example.com' });
    assert.equal(auditDetail({ action: 'user.deleted', details: { userId: 'u', email: null, isAdmin: false } }), null);
  });

  it('shows nothing for actions without details or unknown entries', () => {
    assert.equal(auditDetail({ action: 'mailbox.deleted', details: {} }), null);
    assert.equal(auditDetail({ action: 'mailbox.disabled' }), null);
    assert.equal(auditDetail(null), null);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && node --test src/utils/auditLog.test.js`
Expected: FAIL — `Cannot find module '.../utils/auditLog.js'`.

- [ ] **Step 4: Write the helpers**

`frontend/src/utils/auditLog.js`:

```js
// Helpers for the admin audit log screen. Actions and details mirror
// backend/src/services/auditLog.js and the entries GET /api/admin/audit returns.

export const AUDIT_ACTION_LABEL_KEYS = Object.freeze({
  'mailbox.added': 'admin.audit.actionMailboxAdded',
  'mailbox.reconnected': 'admin.audit.actionMailboxReconnected',
  'mailbox.deleted': 'admin.audit.actionMailboxDeleted',
  'mailbox.connection_changed': 'admin.audit.actionMailboxConnectionChanged',
  'mailbox.enabled': 'admin.audit.actionMailboxEnabled',
  'mailbox.disabled': 'admin.audit.actionMailboxDisabled',
  'message.sent': 'admin.audit.actionMessageSent',
  'message.deleted': 'admin.audit.actionMessageDeleted',
  'user.added': 'admin.audit.actionUserAdded',
  'user.deleted': 'admin.audit.actionUserDeleted',
  'user.enabled': 'admin.audit.actionUserEnabled',
  'user.disabled': 'admin.audit.actionUserDisabled',
  'user.admin_changed': 'admin.audit.actionUserAdminChanged',
});

export const AUDIT_ACTIONS = Object.freeze(Object.keys(AUDIT_ACTION_LABEL_KEYS));

export function auditActionLabelKey(action) {
  return AUDIT_ACTION_LABEL_KEYS[action] ?? null;
}

// Start of a local calendar day (YYYY-MM-DD from a date input) as an ISO timestamp, moved
// forward by `dayOffset` days. Anything else is not a day and yields null.
function localDayStart(day, dayOffset = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + dayOffset).toISOString();
}

// Query for GET /api/admin/audit. Empty filters are left out. The admin picks both days
// inclusively, while the API's `to` is exclusive, so `to` is the start of the next day.
export function auditQuery({ account, user, action, fromDate, toDate, before } = {}) {
  const query = {};
  if (account) query.account = account;
  if (user) query.user = user;
  if (action) query.action = action;
  const from = localDayStart(fromDate);
  if (from) query.from = from;
  const to = localDayStart(toDate, 1);
  if (to) query.to = to;
  if (before) query.before = before;
  return query;
}

// What the details column shows for an entry: a translation key with its values, plain text,
// or null when there is nothing to add.
export function auditDetail(entry) {
  const details = entry?.details ?? {};
  switch (entry?.action) {
    case 'mailbox.added':
    case 'mailbox.reconnected':
      return details.oauthProvider
        ? { key: 'admin.audit.detailProvider', values: { provider: details.oauthProvider } }
        : null;
    case 'mailbox.connection_changed':
      return Array.isArray(details.fields) && details.fields.length
        ? { key: 'admin.audit.detailFields', values: { fields: details.fields.join(', ') } }
        : null;
    case 'message.sent': {
      const recipients = [...(details.to ?? []), ...(details.cc ?? []), ...(details.bcc ?? [])];
      return recipients.length
        ? { key: 'admin.audit.detailRecipients', values: { recipients: recipients.join(', ') } }
        : null;
    }
    case 'message.deleted':
      return {
        key: details.permanent ? 'admin.audit.detailDeletedForever' : 'admin.audit.detailMovedToTrash',
        values: { from: details.from ?? '', folder: details.folder ?? '' },
      };
    case 'user.admin_changed':
      return {
        key: details.isAdmin ? 'admin.audit.detailAdminGranted' : 'admin.audit.detailAdminRevoked',
        values: { email: details.email ?? '' },
      };
    case 'user.added':
    case 'user.deleted':
    case 'user.enabled':
    case 'user.disabled':
      return details.email ? { text: details.email } : null;
    default:
      return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && node --test src/utils/auditLog.test.js`
Expected: PASS, все тесты.

- [ ] **Step 6: Add the API method**

В `frontend/src/utils/api.js` в блоке `admin` после строки `getAuthEvents: ...` добавить:

```js
    getAuditLog: (params) => request('GET', '/admin/audit' + (params && Object.keys(params).length ? '?' + new URLSearchParams(params) : '')),
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/utils/auditLog.js frontend/src/utils/auditLog.test.js frontend/src/utils/api.js
git commit -m "feat(audit): add audit log helpers and API client"
```

---

### Task 2: Журнал в демо-режиме

**Files:**
- Modify: `frontend/src/demo/index.js`
- Test: `frontend/src/demo/index.test.js`

**Interfaces:**
- Consumes: демо-ящики `demo-sales` (`sales@demo.mailexpert.local`), `demo-ops` (`ops@demo.mailexpert.local`), `DEMO_USER` (`demo-user`, `demo@mailexpert.local`).
- Produces: `demoRequest('GET', '/admin/audit?...')` → `{ entries, nextCursor: null }`, записи от новых к старым, фильтры `account`, `user`, `action`.

- [ ] **Step 1: Write the failing test**

В конец `frontend/src/demo/index.test.js`:

```js
test('the demo audit log lists entries newest first and applies the mailbox, user and action filters', async () => {
  const all = await demoRequest('GET', '/admin/audit');
  assert.equal(all.nextCursor, null);
  assert.ok(all.entries.length >= 4);
  const times = all.entries.map((entry) => entry.occurredAt);
  assert.deepEqual(times, [...times].sort().reverse());

  const sales = await demoRequest('GET', '/admin/audit?account=demo-sales');
  assert.ok(sales.entries.length > 0);
  assert.ok(sales.entries.every((entry) => entry.accountId === 'demo-sales'));

  const sent = await demoRequest('GET', '/admin/audit?action=message.sent');
  assert.ok(sent.entries.length > 0);
  assert.ok(sent.entries.every((entry) => entry.action === 'message.sent'));

  const nobody = await demoRequest('GET', '/admin/audit?user=someone-else');
  assert.deepEqual(nobody.entries, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --test src/demo/index.test.js`
Expected: FAIL — `all.nextCursor` равен `undefined` (ответ по умолчанию `{ ok: true, demo: true }`).

- [ ] **Step 3: Implement**

В `frontend/src/demo/index.js`:

1. После `const DEMO_USER = { ... };`:

```js
// Audit entries for the admin journal screen, newest first. Times are fixed so the demo reads
// the same on every load.
const AUDIT_FIXTURES = [
  {
    id: '6', occurredAt: '2026-09-17T09:40:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-sales', accountEmail: 'sales@demo.mailexpert.local', action: 'message.deleted',
    details: { messageId: '<demo-archive@demo.mailexpert.local>', folder: 'INBOX', from: 'newsletter@example.com', permanent: false },
  },
  {
    id: '5', occurredAt: '2026-09-17T09:15:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-sales', accountEmail: 'sales@demo.mailexpert.local', action: 'message.sent',
    details: { messageId: '<demo-reply@demo.mailexpert.local>', to: ['buyer@example.com'], cc: [], bcc: [] },
  },
  {
    id: '4', occurredAt: '2026-09-16T16:05:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-ops', accountEmail: 'ops@demo.mailexpert.local', action: 'mailbox.connection_changed',
    details: { fields: ['smtp_port'] },
  },
  {
    id: '3', occurredAt: '2026-09-16T12:30:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: null, accountEmail: null, action: 'user.added',
    details: { userId: 'demo-colleague', email: 'colleague@demo.mailexpert.local', isAdmin: false },
  },
  {
    id: '2', occurredAt: '2026-09-15T10:00:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-ops', accountEmail: 'ops@demo.mailexpert.local', action: 'mailbox.added',
    details: { protocol: 'imap', oauthProvider: 'google' },
  },
  {
    id: '1', occurredAt: '2026-09-15T09:55:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-sales', accountEmail: 'sales@demo.mailexpert.local', action: 'mailbox.added',
    details: { protocol: 'imap', oauthProvider: 'google' },
  },
];
```

2. Перед строкой `if (verb === 'GET' && pathname === '/admin/ai') ...`:

```js
  if (verb === 'GET' && pathname === '/admin/audit') {
    const { searchParams } = url;
    const entries = AUDIT_FIXTURES.filter((entry) => (
      (!searchParams.get('account') || entry.accountId === searchParams.get('account'))
      && (!searchParams.get('user') || entry.actorUserId === searchParams.get('user'))
      && (!searchParams.get('action') || entry.action === searchParams.get('action'))
    ));
    return { entries: clone(entries), nextCursor: null };
  }
```

`url` — результат `parsePath(path)`, то есть `URL`, поэтому `url.searchParams` доступен, как в соседних маршрутах.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --test src/demo/index.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/demo/index.js frontend/src/demo/index.test.js
git commit -m "feat(demo): serve a sample audit log"
```

---

### Task 3: Строки интерфейса на 9 языках

**Files:**
- Modify: `frontend/src/locales/{en,ru,de,es,fr,it,cs,pl,zhCN}.json`
- Modify: `frontend/src/locales/i18n.test.js` (`DYNAMIC_KEYS`)
- Scratch, не коммитится: `<scratchpad>/pr5-locales.mjs`

**Interfaces:**
- Produces ключи:
  - `admin.tabs.audit`;
  - `admin.accounts.deleteTitle`, `admin.accounts.deleteMessage`;
  - `admin.audit.description`, `mailbox`, `action`, `details`, `fromDate`, `toDate`, `allMailboxes`, `allUsers`, `allActions`, `empty`, `deletedUser`, `loadFailed` (`{{message}}`), `invalidFilter`, `detailProvider` (`{{provider}}`), `detailFields` (`{{fields}}`), `detailRecipients` (`{{recipients}}`), `detailMovedToTrash` и `detailDeletedForever` (`{{from}}`, `{{folder}}`), `detailAdminGranted` и `detailAdminRevoked` (`{{email}}`);
  - 13 ключей действий из `AUDIT_ACTION_LABEL_KEYS` (Task 1).
- Переиспользуются существующие: `admin.security.activityColTime`, `admin.security.activityColUser`, `admin.security.activityRefresh`, `admin.security.activityLoading`, `common.loadMore`, `common.remove`.

Строки добавляются до кода, который их использует: так i18n-тест ловит ошибки перевода отдельно от ошибок разметки. До Task 4 тест покрытия исходников будет падать на неиспользуемых ключах — это ожидаемо, полный зелёный прогон i18n — в конце Task 4.

- [ ] **Step 1: Write the locale script**

`<scratchpad>/pr5-locales.mjs` (запускать из корня репозитория):

```js
import { readFileSync, writeFileSync } from 'node:fs';

const LOCALES = ['en', 'ru', 'de', 'es', 'fr', 'it', 'cs', 'pl', 'zhCN'];
// key -> [en, ru, de, es, fr, it, cs, pl, zhCN]
const STRINGS = {
  'admin.tabs.audit': ['Audit log', 'Журнал', 'Protokoll', 'Registro de auditoría', "Journal d'audit", 'Registro attività', 'Auditní protokol', 'Dziennik zdarzeń', '审计日志'],
  'admin.accounts.deleteTitle': ['Remove mailbox?', 'Удалить ящик?', 'Postfach entfernen?', '¿Quitar el buzón?', 'Retirer la boîte aux lettres ?', 'Rimuovere la casella?', 'Odebrat schránku?', 'Usunąć skrzynkę?', '移除邮箱？'],
  'admin.accounts.deleteMessage': [
    'The mailbox and all its synced messages will be removed for every user. This cannot be undone.',
    'Ящик и все его синхронизированные письма пропадут у всех пользователей. Это нельзя отменить.',
    'Das Postfach und alle synchronisierten Nachrichten werden für alle Benutzer entfernt. Das lässt sich nicht rückgängig machen.',
    'El buzón y todos sus mensajes sincronizados se quitarán para todos los usuarios. No se puede deshacer.',
    'La boîte aux lettres et tous ses messages synchronisés seront retirés pour tous les utilisateurs. Cette action est irréversible.',
    "La casella e tutti i messaggi sincronizzati verranno rimossi per tutti gli utenti. L'operazione non si può annullare.",
    'Schránka a všechny její synchronizované zprávy zmizí všem uživatelům. Tuto akci nelze vrátit.',
    'Skrzynka i wszystkie jej zsynchronizowane wiadomości znikną u wszystkich użytkowników. Tej operacji nie można cofnąć.',
    '该邮箱及其所有已同步的邮件将对所有用户移除，且无法撤销。',
  ],
  'admin.audit.description': [
    'What users did with mailboxes, messages and users, newest first.',
    'Что пользователи делали с ящиками, письмами и пользователями, сначала новые.',
    'Was Benutzer mit Postfächern, Nachrichten und Benutzern getan haben, neueste zuerst.',
    'Lo que los usuarios hicieron con buzones, mensajes y usuarios, primero lo más reciente.',
    'Ce que les utilisateurs ont fait avec les boîtes aux lettres, les messages et les utilisateurs, du plus récent au plus ancien.',
    'Cosa hanno fatto gli utenti con caselle, messaggi e utenti, dal più recente.',
    'Co uživatelé dělali se schránkami, zprávami a uživateli, od nejnovějšího.',
    'Co użytkownicy robili ze skrzynkami, wiadomościami i użytkownikami, od najnowszych.',
    '用户对邮箱、邮件和用户执行的操作，按时间从新到旧排列。',
  ],
  'admin.audit.mailbox': ['Mailbox', 'Ящик', 'Postfach', 'Buzón', 'Boîte aux lettres', 'Casella', 'Schránka', 'Skrzynka', '邮箱'],
  'admin.audit.action': ['Action', 'Действие', 'Aktion', 'Acción', 'Opération', 'Azione', 'Akce', 'Działanie', '操作'],
  'admin.audit.details': ['Details', 'Подробности', 'Einzelheiten', 'Detalles', 'Détails', 'Dettagli', 'Podrobnosti', 'Szczegóły', '详情'],
  'admin.audit.fromDate': ['From date', 'С даты', 'Ab Datum', 'Desde', 'Du', 'Dal', 'Od data', 'Od dnia', '开始日期'],
  'admin.audit.toDate': ['To date', 'По дату', 'Bis Datum', 'Hasta', 'Au', 'Al', 'Do data', 'Do dnia', '结束日期'],
  'admin.audit.allMailboxes': ['All mailboxes', 'Все ящики', 'Alle Postfächer', 'Todos los buzones', 'Toutes les boîtes aux lettres', 'Tutte le caselle', 'Všechny schránky', 'Wszystkie skrzynki', '全部邮箱'],
  'admin.audit.allUsers': ['All users', 'Все пользователи', 'Alle Benutzer', 'Todos los usuarios', 'Tous les utilisateurs', 'Tutti gli utenti', 'Všichni uživatelé', 'Wszyscy użytkownicy', '全部用户'],
  'admin.audit.allActions': ['All actions', 'Все действия', 'Alle Aktionen', 'Todas las acciones', 'Toutes les opérations', 'Tutte le azioni', 'Všechny akce', 'Wszystkie działania', '全部操作'],
  'admin.audit.empty': ['No entries match these filters.', 'Нет записей по этим фильтрам.', 'Keine Einträge für diese Filter.', 'No hay entradas con estos filtros.', 'Aucune entrée ne correspond à ces filtres.', 'Nessuna voce corrisponde a questi filtri.', 'Těmto filtrům neodpovídají žádné záznamy.', 'Brak wpisów dla tych filtrów.', '没有符合这些筛选条件的记录。'],
  'admin.audit.deletedUser': ['Deleted user', 'Удалённый пользователь', 'Gelöschter Benutzer', 'Usuario eliminado', 'Utilisateur supprimé', 'Utente eliminato', 'Smazaný uživatel', 'Usunięty użytkownik', '已删除的用户'],
  'admin.audit.loadFailed': ['Could not load the audit log: {{message}}', 'Не удалось загрузить журнал: {{message}}', 'Protokoll konnte nicht geladen werden: {{message}}', 'No se pudo cargar el registro: {{message}}', 'Impossible de charger le journal : {{message}}', 'Impossibile caricare il registro: {{message}}', 'Protokol se nepodařilo načíst: {{message}}', 'Nie udało się wczytać dziennika: {{message}}', '无法加载审计日志：{{message}}'],
  'admin.audit.invalidFilter': ['Check the filters: a date or value is not valid.', 'Проверьте фильтры: дата или значение указаны неверно.', 'Filter prüfen: Ein Datum oder Wert ist ungültig.', 'Revisa los filtros: una fecha o un valor no es válido.', "Vérifiez les filtres : une date ou une valeur n'est pas valide.", 'Controlla i filtri: una data o un valore non è valido.', 'Zkontrolujte filtry: datum nebo hodnota je neplatná.', 'Sprawdź filtry: data lub wartość jest nieprawidłowa.', '请检查筛选条件：日期或数值无效。'],
  'admin.audit.detailProvider': ['Signed in with {{provider}}', 'Вход через {{provider}}', 'Angemeldet über {{provider}}', 'Conectado con {{provider}}', 'Connecté via {{provider}}', 'Accesso con {{provider}}', 'Přihlášeno přes {{provider}}', 'Zalogowano przez {{provider}}', '通过 {{provider}} 登录'],
  'admin.audit.detailFields': ['Fields: {{fields}}', 'Поля: {{fields}}', 'Felder: {{fields}}', 'Campos: {{fields}}', 'Champs : {{fields}}', 'Campi: {{fields}}', 'Pole: {{fields}}', 'Pola: {{fields}}', '字段：{{fields}}'],
  'admin.audit.detailRecipients': ['To: {{recipients}}', 'Кому: {{recipients}}', 'An: {{recipients}}', 'Para: {{recipients}}', 'À : {{recipients}}', 'A: {{recipients}}', 'Komu: {{recipients}}', 'Do: {{recipients}}', '收件人：{{recipients}}'],
  'admin.audit.detailMovedToTrash': ['From {{from}}, {{folder}}, moved to Trash', 'От {{from}}, {{folder}}, перемещено в корзину', 'Von {{from}}, {{folder}}, in den Papierkorb verschoben', 'De {{from}}, {{folder}}, movido a la papelera', 'De {{from}}, {{folder}}, déplacé dans la corbeille', 'Da {{from}}, {{folder}}, spostato nel cestino', 'Od {{from}}, {{folder}}, přesunuto do koše', 'Od {{from}}, {{folder}}, przeniesiono do kosza', '发件人 {{from}}，{{folder}}，已移至回收站'],
  'admin.audit.detailDeletedForever': ['From {{from}}, {{folder}}, deleted permanently', 'От {{from}}, {{folder}}, удалено навсегда', 'Von {{from}}, {{folder}}, endgültig gelöscht', 'De {{from}}, {{folder}}, eliminado definitivamente', 'De {{from}}, {{folder}}, supprimé définitivement', 'Da {{from}}, {{folder}}, eliminato definitivamente', 'Od {{from}}, {{folder}}, trvale smazáno', 'Od {{from}}, {{folder}}, usunięto trwale', '发件人 {{from}}，{{folder}}，已永久删除'],
  'admin.audit.detailAdminGranted': ['{{email}} is now an admin', '{{email}} теперь администратор', '{{email}} ist jetzt Administrator', '{{email}} ahora es administrador', '{{email}} est maintenant administrateur', '{{email}} ora è amministratore', '{{email}} je nyní správce', '{{email}} jest teraz administratorem', '{{email}} 现在是管理员'],
  'admin.audit.detailAdminRevoked': ['{{email}} is no longer an admin', '{{email}} больше не администратор', '{{email}} ist kein Administrator mehr', '{{email}} ya no es administrador', "{{email}} n'est plus administrateur", '{{email}} non è più amministratore', '{{email}} už není správce', '{{email}} nie jest już administratorem', '{{email}} 不再是管理员'],
  'admin.audit.actionMailboxAdded': ['Mailbox added', 'Ящик добавлен', 'Postfach hinzugefügt', 'Buzón añadido', 'Boîte aux lettres ajoutée', 'Casella aggiunta', 'Schránka přidána', 'Dodano skrzynkę', '已添加邮箱'],
  'admin.audit.actionMailboxReconnected': ['Mailbox reconnected', 'Ящик переподключён', 'Postfach neu verbunden', 'Buzón reconectado', 'Boîte aux lettres reconnectée', 'Casella riconnessa', 'Schránka znovu připojena', 'Ponownie połączono skrzynkę', '已重新连接邮箱'],
  'admin.audit.actionMailboxDeleted': ['Mailbox deleted', 'Ящик удалён', 'Postfach gelöscht', 'Buzón eliminado', 'Boîte aux lettres supprimée', 'Casella eliminata', 'Schránka smazána', 'Usunięto skrzynkę', '已删除邮箱'],
  'admin.audit.actionMailboxConnectionChanged': ['Connection settings changed', 'Изменены настройки подключения', 'Verbindungseinstellungen geändert', 'Ajustes de conexión cambiados', 'Paramètres de connexion modifiés', 'Impostazioni di connessione modificate', 'Změněno nastavení připojení', 'Zmieniono ustawienia połączenia', '已更改连接设置'],
  'admin.audit.actionMailboxEnabled': ['Mailbox enabled', 'Ящик включён', 'Postfach aktiviert', 'Buzón activado', 'Boîte aux lettres activée', 'Casella attivata', 'Schránka zapnuta', 'Włączono skrzynkę', '已启用邮箱'],
  'admin.audit.actionMailboxDisabled': ['Mailbox disabled', 'Ящик выключен', 'Postfach deaktiviert', 'Buzón desactivado', 'Boîte aux lettres désactivée', 'Casella disattivata', 'Schránka vypnuta', 'Wyłączono skrzynkę', '已停用邮箱'],
  'admin.audit.actionMessageSent': ['Message sent', 'Письмо отправлено', 'Nachricht gesendet', 'Mensaje enviado', 'Message envoyé', 'Messaggio inviato', 'Zpráva odeslána', 'Wysłano wiadomość', '已发送邮件'],
  'admin.audit.actionMessageDeleted': ['Message deleted', 'Письмо удалено', 'Nachricht gelöscht', 'Mensaje eliminado', 'Message supprimé', 'Messaggio eliminato', 'Zpráva smazána', 'Usunięto wiadomość', '已删除邮件'],
  'admin.audit.actionUserAdded': ['User added', 'Пользователь добавлен', 'Benutzer hinzugefügt', 'Usuario añadido', 'Utilisateur ajouté', 'Utente aggiunto', 'Uživatel přidán', 'Dodano użytkownika', '已添加用户'],
  'admin.audit.actionUserDeleted': ['User deleted', 'Пользователь удалён', 'Benutzer gelöscht', 'Usuario eliminado', 'Utilisateur supprimé', 'Utente eliminato', 'Uživatel smazán', 'Usunięto użytkownika', '已删除用户'],
  'admin.audit.actionUserEnabled': ['User enabled', 'Пользователь включён', 'Benutzer aktiviert', 'Usuario activado', 'Utilisateur activé', 'Utente attivato', 'Uživatel zapnut', 'Włączono użytkownika', '已启用用户'],
  'admin.audit.actionUserDisabled': ['User disabled', 'Пользователь отключён', 'Benutzer deaktiviert', 'Usuario desactivado', 'Utilisateur désactivé', 'Utente disattivato', 'Uživatel vypnut', 'Wyłączono użytkownika', '已停用用户'],
  'admin.audit.actionUserAdminChanged': ['Admin rights changed', 'Изменены права администратора', 'Administratorrechte geändert', 'Permisos de administrador cambiados', "Droits d'administrateur modifiés", 'Diritti di amministratore modificati', 'Změněna práva správce', 'Zmieniono uprawnienia administratora', '已更改管理员权限'],
};

LOCALES.forEach((locale, index) => {
  const file = `frontend/src/locales/${locale}.json`;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const [key, values] of Object.entries(STRINGS)) {
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
node "<scratchpad>/pr5-locales.mjs"
git diff --stat -- frontend/src/locales
```

Expected: `added 36 keys to 9 locales`; в каждом файле локали только добавленные строки (36 ключей, открытие и закрытие раздела `audit`) и запятые на строках перед ними — других удалений нет.

- [ ] **Step 3: Register the tab label as a dynamic key**

В `frontend/src/locales/i18n.test.js` в `DYNAMIC_KEYS` после `'admin.tabs.categories',` добавить:

```js
  'admin.tabs.audit',
```

- [ ] **Step 4: Run the key and uniqueness suites**

Run: `cd frontend && node --test src/locales/i18n.test.js`
Expected:
- набор «Key coverage» проходит (ключи есть во всех локалях);
- набор уникальности значений проходит; если он называет пару локалей с действительно одинаковым правильным переводом, добавить ключ в `SAME_VALUE_ALLOWED` с группой этих локалей и комментарием, как у соседних записей;
- набор «Source coverage» падает только на ключах `admin.audit.*`, `admin.accounts.deleteTitle` и `admin.accounts.deleteMessage`: их использует код Task 4.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/locales
git commit -m "feat(audit): add audit log strings in every language"
```

---

### Task 4: Вкладка «Журнал» и перевод подтверждения удаления

**Files:**
- Create: `frontend/src/components/AuditLogTab.jsx`
- Modify: `frontend/src/components/AdminPanel.jsx` (импорты ~строка 34, `AccountsTab.handleDelete` ~строка 503, `TAB_GROUPS` ~6451, `TABS` ~6514, `tabContent` ~8135)

**Interfaces:**
- Consumes: `AUDIT_ACTIONS`, `auditActionLabelKey`, `auditDetail`, `auditQuery` (Task 1); `api.admin.getAuditLog`, `api.admin.getUsers`; ключи Task 3; `useStore` → `accounts`.
- Produces: `export default function AuditLogTab()`.

- [ ] **Step 1: Write the component**

`frontend/src/components/AuditLogTab.jsx`:

```jsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { AUDIT_ACTIONS, auditActionLabelKey, auditDetail, auditQuery } from '../utils/auditLog.js';

const EMPTY_FILTERS = { account: '', user: '', action: '', fromDate: '', toDate: '' };

const controlStyle = {
  padding: '7px 10px', fontSize: 13, background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 7, outline: 'none', minWidth: 0,
};
const headCellStyle = {
  padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textAlign: 'left',
  textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const cellStyle = {
  padding: '8px 10px', fontSize: 13, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)',
  verticalAlign: 'top', wordBreak: 'break-word',
};
const buttonStyle = {
  padding: '7px 14px', fontSize: 13, fontWeight: 500, background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 7, cursor: 'pointer',
};

// Admin-only: what users did with the shared mailboxes, messages and users, newest first.
export default function AuditLogTab() {
  const { t } = useTranslation();
  const accounts = useStore((state) => state.accounts);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [users, setUsers] = useState([]);
  const [entries, setEntries] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  // Only the newest request may fill the list: a slow page for old filters must not land late.
  const requestSeq = useRef(0);

  useEffect(() => {
    api.admin.getUsers({ limit: 200, offset: 0 })
      .then((data) => setUsers(Array.isArray(data?.users) ? data.users : []))
      .catch(() => setUsers([]));
  }, []);

  const describeError = useCallback((err) => (
    err?.code === 'invalid_filter' ? t('admin.audit.invalidFilter') : t('admin.audit.loadFailed', { message: err?.message ?? '' })
  ), [t]);

  // A filter change starts over from the newest entry.
  const reload = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await api.admin.getAuditLog(auditQuery(filters));
      if (seq !== requestSeq.current) return;
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
      setNextCursor(data?.nextCursor ?? null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setEntries([]);
      setNextCursor(null);
      setError(describeError(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [filters, describeError]);

  useEffect(() => { reload(); }, [reload]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setError('');
    try {
      const data = await api.admin.getAuditLog(auditQuery({ ...filters, before: nextCursor }));
      if (seq !== requestSeq.current) return;
      setEntries((previous) => [...previous, ...(Array.isArray(data?.entries) ? data.entries : [])]);
      setNextCursor(data?.nextCursor ?? null);
    } catch (err) {
      if (seq === requestSeq.current) setError(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const setFilter = (name) => (event) => {
    const { value } = event.target;
    setFilters((previous) => ({ ...previous, [name]: value }));
  };

  const detailText = (entry) => {
    const detail = auditDetail(entry);
    if (!detail) return '';
    return detail.key ? t(detail.key, detail.values) : detail.text;
  };

  const actionText = (action) => {
    const key = auditActionLabelKey(action);
    return key ? t(key) : action;
  };

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '20px 24px', marginBottom: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            {t('admin.tabs.audit')}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.audit.description')}</div>
        </div>
        <button type="button" onClick={reload} disabled={loading} style={buttonStyle}>
          {t('admin.security.activityRefresh')}
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <select aria-label={t('admin.audit.mailbox')} value={filters.account} onChange={setFilter('account')} style={{ ...controlStyle, flex: '1 1 180px' }}>
          <option value="">{t('admin.audit.allMailboxes')}</option>
          {(accounts || []).map((account) => (
            <option key={account.id} value={account.id}>{account.name || account.email_address}</option>
          ))}
        </select>
        <select aria-label={t('admin.security.activityColUser')} value={filters.user} onChange={setFilter('user')} style={{ ...controlStyle, flex: '1 1 180px' }}>
          <option value="">{t('admin.audit.allUsers')}</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>{user.email || user.username}</option>
          ))}
        </select>
        <select aria-label={t('admin.audit.action')} value={filters.action} onChange={setFilter('action')} style={{ ...controlStyle, flex: '1 1 180px' }}>
          <option value="">{t('admin.audit.allActions')}</option>
          {AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action}>{actionText(action)}</option>
          ))}
        </select>
        <input type="date" aria-label={t('admin.audit.fromDate')} title={t('admin.audit.fromDate')} value={filters.fromDate} onChange={setFilter('fromDate')} style={{ ...controlStyle, flex: '0 1 150px' }} />
        <input type="date" aria-label={t('admin.audit.toDate')} title={t('admin.audit.toDate')} value={filters.toDate} onChange={setFilter('toDate')} style={{ ...controlStyle, flex: '0 1 150px' }} />
      </div>

      {error && <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--red)' }}>{error}</div>}

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.security.activityLoading')}</div>
      ) : entries.length === 0 ? (
        !error && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.audit.empty')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>{t('admin.security.activityColTime')}</th>
                <th style={headCellStyle}>{t('admin.security.activityColUser')}</th>
                <th style={headCellStyle}>{t('admin.audit.mailbox')}</th>
                <th style={headCellStyle}>{t('admin.audit.action')}</th>
                <th style={headCellStyle}>{t('admin.audit.details')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{new Date(entry.occurredAt).toLocaleString()}</td>
                  <td style={cellStyle}>{entry.actorEmail || t('admin.audit.deletedUser')}</td>
                  <td style={cellStyle}>{entry.accountEmail || ''}</td>
                  <td style={{ ...cellStyle, color: 'var(--text-primary)' }}>{actionText(entry.action)}</td>
                  <td style={cellStyle}>{detailText(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && nextCursor && (
        <button type="button" onClick={loadMore} disabled={loadingMore} style={{ ...buttonStyle, marginTop: 12 }}>
          {loadingMore ? t('admin.security.activityLoading') : t('common.loadMore')}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Register the tab**

В `frontend/src/components/AdminPanel.jsx`:

1. После `import MailboxSyncSettings from './MailboxSyncSettings.jsx';`:

```js
import AuditLogTab from './AuditLogTab.jsx';
```

2. В `TAB_GROUPS` заменить группу администрирования:

```js
  { id: 'admin', labelKey: 'admin.tabs.groupAdmin', tabIds: ['users', 'audit', 'sso'] },
```

3. В `TABS` после записи `id: 'users'` (перед `id: 'sso'`):

```jsx
  {
    id: 'audit', labelKey: 'admin.tabs.audit',
    adminOnly: true,
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  },
```

4. В `tabContent` после `{adminTab === 'users' && <UsersTab />}`:

```jsx
      {adminTab === 'audit' && user?.isAdmin && <AuditLogTab />}
```

Проверка `user?.isAdmin` дублирует `adminOnly`: вкладку можно открыть сохранённым `adminTab`, минуя список вкладок.

- [ ] **Step 3: Translate the mailbox delete confirmation**

В `AccountsTab.handleDelete` заменить:

```js
      title: 'Remove account?',
      message: 'All synced messages for this account will be deleted. This cannot be undone.',
      confirmLabel: 'Remove',
```

на:

```js
      title: t('admin.accounts.deleteTitle'),
      message: t('admin.accounts.deleteMessage'),
      confirmLabel: t('common.remove'),
```

`t` в `AccountsTab` уже объявлен (`const { t } = useTranslation();`).

- [ ] **Step 4: Run the i18n suite**

Run: `cd frontend && node --test src/locales/i18n.test.js`
Expected: PASS все наборы. Если набор «No hardcoded strings» назовёт строку из `AuditLogTab.jsx`, заменить её на `t()` с существующим или новым ключом (новый ключ — во все 9 локалей), а не добавлять в `HARDCODED_OK`.

- [ ] **Step 5: Full frontend run**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: все тесты PASS, lint без предупреждений, сборка успешна.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/AuditLogTab.jsx frontend/src/components/AdminPanel.jsx frontend/src/locales/i18n.test.js
git commit -m "feat(audit): show the audit log to admins in settings"
```

---

### Task 5: Проверка в браузере, спецификация, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`
- Modify: `docs/architecture/codebase-file-map.md`
- Scratch, не коммитится: `frontend/.env.local` (игнорируется `*.env.local`), `.claude/launch.json`, `<scratchpad>/pr5-body.md`

- [ ] **Step 1: Run the demo build in the browser pane**

`frontend/.env.local`:

```
VITE_DEMO_MODE=true
```

`.claude/launch.json` (не коммитить):

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

Запустить `preview_start` с `name: "frontend-demo"`. Проверить в панели браузера:
1. Открыть настройки, в группе «Администрирование» есть вкладка «Audit log» (язык интерфейса по умолчанию английский).
2. Вкладка показывает 6 демо-записей от новых к старым; в «Details» — «From newsletter@example.com, INBOX, moved to Trash», «To: buyer@example.com», «Fields: smtp_port», «colleague@demo.mailexpert.local», «Signed in with google».
3. Фильтр «Mailbox» = Sales Team оставляет только записи `sales@demo.mailexpert.local`; фильтр действия «Message sent» — одну запись; сброс фильтров возвращает все 6.
4. Кнопки «Load more» нет (`nextCursor: null`).
5. Во вкладке «Accounts» кнопка удаления ящика открывает подтверждение с заголовком «Remove mailbox?» и текстом про всех пользователей; нажать «Cancel».
6. Сменить язык на русский в «Appearance → Language & Font»: вкладка называется «Журнал», действия и подробности на русском. Вернуть английский.
7. В консоли браузера нет ошибок (`read_console_messages` с `onlyErrors: true`).
8. Ширина 375 px (`resize_window` `preset: "mobile"`): вкладка открывается, фильтры переносятся, таблица прокручивается по горизонтали внутри карточки, у страницы горизонтальной прокрутки нет. Вернуть `preset: "desktop"`.

Экран против настоящего бэкенда не проверяется: для этого нужно поднять весь стек. Это указать в PR.

После проверки: `preview_stop`, удалить `frontend/.env.local` и `.claude/launch.json` (они созданы этим шагом), убедиться, что `git status --short` их не показывает.

- [ ] **Step 2: Record the clarifications in the spec**

В `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`:

1. В строке статуса заменить `PR 3 (общие данные) и PR 4 (журнал) реализованы.` на `PR 3 (общие данные), PR 4 (журнал) и PR 5 (интерфейс журнала) реализованы.`

2. После последнего пункта раздела «Уточнения, принятые при реализации PR 4» добавить:

```markdown

## Уточнения, принятые при реализации PR 5

- Удаление ящика любым пользователем сделано в PR 3 (`DELETE /api/accounts/:id` без проверки владельца, вкладка «Аккаунты» не только для администратора). PR 5 перевёл подтверждение удаления и предупреждает в нём, что ящик пропадёт у всех пользователей.
- Личные настройки, ставшие системными, убраны раньше: миграция 0055 — интервалы синхронизации, 0056 — `categorizationEnabled`; `PATCH /api/auth/preferences` их не принимает. `GET /api/auth/preferences` отдаёт `syncInterval` только для чтения, как решено в PR 2.
- Журнал — вкладка «Журнал» в группе «Администрирование», только для администратора.
  - Фильтры: ящик, пользователь, действие, даты «с» и «по» включительно по местному времени; «по» уходит в API как начало следующего дня.
  - Смена фильтра загружает журнал с самой новой записи, «Загрузить ещё» передаёт `nextCursor`.
  - Автор без email показывается как «Удалённый пользователь».
- Список ящиков у других пользователей после удаления или добавления ящика обновляется только при перезагрузке страницы; живое обновление в спецификации не описано и в PR 5 не входит.
```

- [ ] **Step 3: Update the file map**

В `docs/architecture/codebase-file-map.md` найти раздел с компонентами фронтенда (`grep -n "MailboxSyncSettings\|AdminPanel" docs/architecture/codebase-file-map.md`) и добавить рядом строку в том же стиле:

```markdown
- `AuditLogTab.jsx` — экран журнала для администратора: фильтры и подгрузка по курсору; логика запроса и подписей в `utils/auditLog.js`.
```

Если в карте нет раздела с компонентами фронтенда, пропустить шаг.

- [ ] **Step 4: Commit the docs**

```bash
git add docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md docs/architecture/codebase-file-map.md
git commit -m "docs: record the audit log screen clarifications"
```

- [ ] **Step 5: Push, open the PR, wait for CI, merge**

`<scratchpad>/pr5-body.md`:

```markdown
PR 5 of the shared mailboxes series: the audit log screen.

## What changes

- Settings get an admin-only "Audit log" tab in the Administration group.
  - Filters: mailbox, user, action, and an inclusive local date range.
  - Entries come newest first; "Load more" follows the API cursor.
  - The details column shows the OAuth provider, changed field names, recipients, the sender and folder of a deleted message (moved to Trash or deleted permanently), and user emails.
- `utils/auditLog.js` holds the query building, action labels and details, with tests.
- The mailbox delete confirmation is translated and says the mailbox is removed for every user.
- Demo mode serves a sample audit log.
- Strings are added in all 9 languages.

## Already done in earlier PRs

- Any user can delete a mailbox since PR 3.
- Personal settings that became install-wide were removed by migrations 0055 and 0056.

## Not in this PR

- Other users' mailbox lists still refresh only on reload after a mailbox is added or deleted.

## Checks

- Frontend: <N> tests pass, lint clean, build OK.
- Browser, demo mode: the tab lists the sample entries, filters narrow them, Russian labels render, the delete confirmation shows the new text, no console errors, works at 375 px.
- Not checked against a running backend.
```

Подставить число тестов из Task 4 Step 5 вместо `<N>`.

```bash
git push -u origin feat/audit-log-screen
gh pr create --repo wyrtensi/MailExpert --base main --head feat/audit-log-screen --title "feat(audit): show the audit log to admins" --body-file "<scratchpad>/pr5-body.md"
gh pr checks <PR> --repo wyrtensi/MailExpert --watch --interval 30
gh pr merge <PR> --repo wyrtensi/MailExpert --merge --delete-branch
git switch main && git pull --ff-only && git branch -d feat/audit-log-screen
```

- [ ] **Step 6: Local handoff**

В `agent-changes/2026-09-14-deps-oauth-handoff.md` (не коммитить) добавить строку: номер PR, merge-коммит, что сделано, что живое обновление списка ящиков не входит, что дальше PR 6 (синхронизация с Cloudflare Access).

---

## Self-review

- **Покрытие спецификации:** экран журнала — Tasks 1–4; удаление ящика для всех — уточнение 1 и Task 4 Step 3; чистка личных настроек — уточнение 2, в коде работы нет; фильтры из раздела «Журнал» (ящик, пользователь, действие, дата) — Task 4; доступ только администратору — `adminOnly` и `user?.isAdmin`.
- **Заглушки:** `<N>` и `<PR>` в Task 5 заполняются по результатам команд, остальное конкретно.
- **Согласованность имён:** `AUDIT_ACTIONS`, `AUDIT_ACTION_LABEL_KEYS`, `auditActionLabelKey`, `auditQuery`, `auditDetail`, `api.admin.getAuditLog`, `AuditLogTab`, ключи `admin.audit.*` совпадают в Tasks 1–5.
