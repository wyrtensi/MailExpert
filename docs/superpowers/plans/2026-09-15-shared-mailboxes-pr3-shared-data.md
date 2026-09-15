# Общие ящики, PR 3: общие данные — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. В этом проекте пользователь выполняет планы без субагентов: использовать superpowers:executing-plans.

**Goal:** ящики и данные вокруг них общие для всей установки. Любой вошедший пользователь видит и меняет все ящики, письма, правила, блок-лист, контакты, категории и отложенные письма. Колонки владельца превращаются в колонки автора действия, события ящиков и push о новых письмах получают все пользователи.

**Architecture:** миграция `0056_shared_mailbox_data.sql` в одной транзакции:
- заводит колонки автора `added_by`, `created_by`, `snoozed_by`, `trained_by`;
- размножает правила «для всех ящиков» и блок-лист по ящикам владельца;
- сливает локальные книги пользователей в одну общую книгу с флагом `is_default`;
- удаляет книги, импортированные из внешнего CardDAV, вместе с их контактами и подключениями;
- переносит переключатель категоризации в `system_settings`;
- удаляет `user_id` у всех этих таблиц.

Код следует за схемой:
- проверка «ящик или письмо принадлежит пользователю» становится проверкой существования;
- `imapManager.broadcast` для событий ящика вызывается без адресата;
- push уходит всем активным пользователям с подпиской;
- правила и блок-лист требуют `accountId`;
- контакты пишутся в общую книгу и живут только внутри сервиса;
- CardDAV удаляется целиком: встроенный сервер для телефонов и импорт из внешнего сервера;
- категоризацию включает администратор.

Фронтенд получает выбор ящика в правилах и блок-листе, неактивный для не-администратора переключатель категоризации и теряет карточку CardDAV.

**Tech Stack:** Node.js 22, Express 5, PostgreSQL 16, imapflow, vitest; React 19, zustand, react-i18next, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` — разделы «Общие данные», «Разбиение на PR» (пункт 3), «Проверка» (smoke миграции PR 3).

## Global Constraints

- Комментарии в коде — только на английском.
- Коммиты и PR — от имени `wyrtensi`, без строк атрибуции. Все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- В документах, коммитах и PR — только заглушки `<CF_HOST>`, `<DIRECT_HOST>`, `<TEAM>`, `<AUD>`. Внутренние имена других проектов не упоминаются.
- Пароли, токены и email пользователей не попадают в логи.
- Разграничения доступа по ящикам нет: доступ к установке — это доступ ко всем ящикам.
- Личными остаются push-подписки, `users.preferences` (кроме интервалов синхронизации и `categorizationEnabled`), PIN экрана блокировки, Todoist, активация плагинов и данные плагинов с `owner_id`.
- Миграция одна: `backend/migrations/0056_shared_mailbox_data.sql`. После неё ни одна из таблиц `email_accounts`, `inbox_rules`, `block_list`, `address_books`, `contacts`, `category_list_sources`, `snoozed_messages`, `spam_training_log` не имеет `user_id`.
- Контакты — только внутренние данные сервиса: ни импорта из внешних источников, ни отдачи наружу по CardDAV.
- Имена функций `loadOwnedMessage`, `getOwnedAccount`, `listUserAccounts` в `services/mailAccess.js` сохраняются.
- Монки-патчинг запрещён.
- Backend-тесты — в `node:22-bookworm-slim`: локальный Node 24 не подходит под `engines`. Frontend-тесты, lint и сборка — локально в `frontend/`.
- Работа идёт в ветке `feat/shared-mailbox-data` от `main`. Первый коммит ветки — этот план.

## Уточнения спецификации в этом PR

Task 9 вносит их в спецификацию.

1. **Общая книга контактов.** Контакты раньше попадали в личные книги `Personal` из четырёх мест: ручное создание, получатели отправленных писем, автоконтакты из входящих и миграция 0017. Других локальных книг код не создаёт.
   - Миграция сливает все локальные книги в одну общую книгу `Contacts` с `is_default = true`. Правило спецификации `<name> (<username>)` не нужно: других книг не остаётся.
   - Дубли по email сливаются: остаётся не автоматический контакт, затем с большим `send_count`; `send_count` суммируется, `last_sent` берётся самый поздний.
   - В общую книгу пишутся все четыре потока.
   - Название `Contacts` нигде не показывается; английское, как прежнее `Personal`.
2. **CardDAV удаляется целиком.** Это отменяет строку спецификации про системную настройку внешнего CardDAV и пункт «встроенный CardDAV-сервер не монтируется».
   - Удаляются встроенный сервер (`/carddav`, `/.well-known/carddav`), импорт из внешнего сервера (`/api/carddav`, планировщик синхронизации, клиент), карточка в интеграциях и значок «синхронизировано из CardDAV» у контакта.
   - Миграция удаляет импортированные книги (`source = 'carddav'`) с их контактами и строки `user_integrations` с `provider = 'carddav'`; колонки `address_books.source`, `external_url`, `sync_token` удаляются. Все контакты становятся редактируемыми.
   - `contacts.uid`, `vcard`, `etag` и `photo_data` остаются: это формат хранения контакта и уже сохранённые фотографии.
3. **`categorization_enabled`** меняет администратор через `PATCH /api/admin/settings`. `GET /api/auth/preferences` отдаёт `categorizationEnabled` только для чтения. У остальных переключатель неактивен. Источники социальных доменов меняет любой пользователь.
4. **Активация плагина для ящика.** Плагин считается включённым для ящика, если его включил хотя бы один активный пользователь. Личная активация по-прежнему управляет интерфейсом каждого пользователя.
5. **Адресаты событий.** Все события ящиков идут всем подключённым клиентам. Адресным остаётся только `rules_run_complete` — ответ на запуск правил.
6. **Правила и блок-лист.**
   - `POST`/`PUT /api/rules` и `POST /api/block-list` без `accountId` отвечают 400 `account_required`.
   - Ручной запуск правил без ящика проходит по всем ящикам. По одному ящику одновременно идёт один прогон, повтор отвечает 409.
   - Действие «переместить» доступно в любом правиле.
7. **OAuth-ящики до PR 8.** «Уже подключён» — ящик с тем же email в установке. Новый ящик записывает `added_by`.
8. **Удалённые изображения** в письме блокируются по настройкам того, кто письмо открыл.
9. **Удаление пользователя** больше не трогает ящики; ответ 409 `user_has_mailboxes` убран.

## Как запускать тесты

Backend. Контейнер после PR 2 удалён, поэтому один раз за сессию:

```bash
MSYS_NO_PATHCONV=1 docker run -d --name mailexpert-backend-test -v "D:/hub/workspace/Projects/MailExpert:/src:ro" node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'mkdir -p /work && cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npm ci --no-audit --no-fund >/dev/null && echo ready'
```

Запуск конкретных файлов (синхронизирует рабочее дерево в контейнер):

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && cd /work/backend && npx vitest run <files>'
```

В шагах ниже это `bt <files>`. Полный прогон — `bt` без файлов. Lint — та же команда, где вместо `npx vitest run` стоит `npm run lint && npm run lint:plugins`.

Frontend (из корня репозитория):
- отдельные файлы: `cd frontend && node --test <files>`;
- полный прогон: `cd frontend && npm test && npm run lint && npm run build`;
- если сборка падает на отсутствующем модуле, сначала `cd frontend && npm ci`.

## Файлы

| Файл | Ответственность |
|---|---|
| Create `backend/migrations/0056_shared_mailbox_data.sql` | Схема и перенос данных в общую модель |
| Modify `backend/src/routes/accounts.js`, `mail.js`, `draft.js`, `send.js`, `search.js` | Ящики и письма без проверки владельца; `added_by`, `snoozed_by`, `trained_by`; изображения по настройкам зрителя |
| Modify `backend/src/services/messageService.js`, `mailAccess.js`, `diagnosticsReport.js` | Лента, API плагинов и диагностика по всем ящикам |
| Modify `backend/src/routes/oauth.js`, `oauthGoogle.js` | OAuth-ящик ищется по email в установке |
| Modify `backend/src/routes/admin.js` | Удаление пользователя не трогает ящики; `categorization_enabled` |
| Modify `backend/src/plugins/activation.js` (+ test) | Плагин включён для ящика, если его включил хоть один активный пользователь |
| Modify `backend/src/services/imapManager.js`, `folderStatus.js`, `labelsRead.js`, `pushNotifications.js` | События ящиков всем; push всем активным пользователям; категоризация и автоконтакты без владельца |
| Modify `backend/src/plugins/api.js`, `plugins/gtd/{gtdSections,gtdTransitions,gtdGist,hooks,routes}.js` | События GTD всем |
| Modify `backend/src/routes/rules.js`, `blockList.js`, `services/inboxRules.js` | Правила и блок-лист в разрезе ящика |
| Create `backend/src/services/addressBooks.js` (+ test) | Общая книга по умолчанию |
| Modify `backend/src/routes/contacts.js` | Общие контакты, все редактируемые |
| Delete `backend/src/routes/carddav.js`, `routes/carddavAccount.js`, `services/carddavSync.js`, `services/carddavClient.js` (+ test) | CardDAV-сервер и импорт удаляются |
| Modify `backend/src/index.js`, `middleware/identityGate.js` (+ test), `utils/vcard.js`, `services/safeFetch.js`, `README.md`, `.env.example`, `docs/architecture/codebase-file-map.md` | Монтирование и упоминания CardDAV |
| Modify `backend/src/services/categorizer.js`, `routes/categories.js`, `routes/auth.js` | Общие источники и системный переключатель категоризации |
| Create `backend/src/routes/{accounts.shared,blockList,contacts.shared}.test.js`, `services/pushNotifications.test.js`, `routes/admin.categorization.test.js`, `sharedData.guard.test.js` | Новые тесты |
| Modify существующие тесты (перечислены в задачах) | SQL и адресаты событий новой модели |
| Create `frontend/src/utils/mailboxLabel.js` (+ test) | Подпись ящика в списках |
| Modify `frontend/src/utils/api.js`, `store/index.js`, `components/AdminPanel.jsx`, `ContactsPage.jsx`, `MessageList.jsx`, `MessagePane.jsx`, `hooks/useGtdTriage.js`, `locales/*.json`, `locales/i18n.test.js` | Правила и блок-лист с ящиком, переключатель категоризации, без CardDAV |
| Modify `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md` | Уточнения и статус |

---

### Task 1: Миграция 0056 и проверка на Postgres 16

**Files:**
- Create: `backend/migrations/0056_shared_mailbox_data.sql`
- Scratch, не коммитится: `<scratchpad>/shared-data-seed.mjs`, `<scratchpad>/shared-data-check.mjs`, `<scratchpad>/fresh-install-check.mjs`

**Interfaces:**
- Produces (схема, на неё опираются все следующие задачи):
  - `email_accounts.added_by UUID NULL → users ON DELETE SET NULL`;
  - `inbox_rules.account_id NOT NULL`, `inbox_rules.created_by`;
  - `block_list(account_id NOT NULL, email_address)`, `UNIQUE (account_id, email_address)`;
  - `address_books.is_default BOOLEAN`, не больше одной книги с `is_default`; колонок `user_id`, `source`, `external_url`, `sync_token` нет;
  - `contacts` без `user_id`;
  - в `user_integrations` нет строк `provider = 'carddav'`;
  - `category_list_sources` с `UNIQUE (source_type, value)`;
  - `snoozed_messages.snoozed_by`, `spam_training_log.trained_by`;
  - `system_settings`: ключ `categorization_enabled` (`'true'`/`'false'`).

- [ ] **Step 1: Create the branch and commit the plan**

```bash
git switch -c feat/shared-mailbox-data
git add docs/superpowers/plans/2026-09-15-shared-mailboxes-pr3-shared-data.md
git commit -m "docs: plan shared mailbox data"
```

- [ ] **Step 2: Write the seed script for the old model**

`<scratchpad>/shared-data-seed.mjs`:

```js
import { writeFileSync } from 'node:fs';
import { runMigrations } from './src/services/migrations.js';
import { pool, query } from './src/services/db.js';

// Runs with 0056 moved out of migrations/, so the schema is the old per-owner model.
await runMigrations();
const one = async (sql, params = []) => (await query(sql, params)).rows[0];

const alice = (await one(`INSERT INTO users (username, password_hash, preferences)
  VALUES ('alice', 'x', '{"categorizationEnabled": true, "theme": "dark"}') RETURNING id`)).id;
const bob = (await one(`INSERT INTO users (username, password_hash, preferences)
  VALUES ('bob', 'x', '{"categorizationEnabled": false}') RETURNING id`)).id;

const mailbox = async (userId, email) => (await one(
  `INSERT INTO email_accounts (user_id, name, email_address, imap_host, imap_port, auth_user, auth_pass)
   VALUES ($1, $2, $2, 'imap.example.com', 993, $2, 'x') RETURNING id`, [userId, email])).id;
const a1 = await mailbox(alice, 'a1@example.com');
const a2 = await mailbox(alice, 'a2@example.com');
const b1 = await mailbox(bob, 'b1@example.com');

const message = async (accountId, uid) => (await one(
  `INSERT INTO messages (account_id, uid, folder, message_id) VALUES ($1, $2, 'INBOX', $3) RETURNING id`,
  [accountId, uid, `<m${uid}@example.com>`])).id;
const m1 = await message(a1, 1);
const m2 = await message(a2, 2);

const rule = async (userId, accountId, name) => (await one(
  `INSERT INTO inbox_rules (user_id, account_id, name, priority, conditions, actions)
   VALUES ($1, $2, $3, 0, '[{"field":"from","operator":"contains","value":"x"}]',
           '[{"type":"forward","value":"fwd@example.com"}]') RETURNING id`, [userId, accountId, name])).id;
const aliceAll = await rule(alice, null, 'alice all');
await rule(alice, a1, 'alice a1');
await rule(bob, null, 'bob all');
// Reservations for a message of each alice mailbox, plus one for a message that no longer exists.
await query(`INSERT INTO inbox_rule_forwards (rule_id, message_id, status)
  VALUES ($1, $2, 'sent'), ($1, $3, 'sent'), ($1, gen_random_uuid(), 'sent')`, [aliceAll, m1, m2]);

await query(`INSERT INTO block_list (user_id, email_address)
  VALUES ($1, 'spam@example.com'), ($2, 'spam@example.com'), ($2, 'other@example.com')`, [alice, bob]);

const book = async (userId, name, source = 'local', externalUrl = null) => (await one(
  'INSERT INTO address_books (user_id, name, source, external_url) VALUES ($1, $2, $3, $4) RETURNING id',
  [userId, name, source, externalUrl])).id;
const alicePersonal = await book(alice, 'Personal');
const bobPersonal = await book(bob, 'Personal');
const aliceTeam = await book(alice, 'Team', 'carddav', 'https://dav.example.com/alice/team/');
const bobContacts = await book(bob, 'Contacts', 'carddav', 'https://dav.example.com/bob/contacts/');
const contact = (bookId, userId, email, isAuto, sendCount) => query(
  `INSERT INTO contacts (address_book_id, user_id, uid, display_name, primary_email, is_auto, send_count)
   VALUES ($1, $2, gen_random_uuid()::text, $3, $3, $4, $5)`, [bookId, userId, email, isAuto, sendCount]);
await contact(alicePersonal, alice, 'x@example.com', false, 2);
await contact(alicePersonal, alice, 'y@example.com', true, 0);
await contact(bobPersonal, bob, 'x@example.com', true, 1);
await contact(bobPersonal, bob, 'z@example.com', false, 0);
await contact(aliceTeam, alice, 'team@example.com', false, 0);
await contact(bobContacts, bob, 'remote@example.com', false, 0);

await query(`INSERT INTO user_integrations (user_id, provider, config, updated_at) VALUES
  ($1, 'carddav', '{"serverUrl":"https://dav.example.com/alice/","username":"alice"}', NOW()),
  ($2, 'carddav', '{"serverUrl":"https://dav.example.com/bob/","username":"bob"}', NOW() - INTERVAL '1 day'),
  ($2, 'todoist', '{"token":"t"}', NOW())`, [alice, bob]);

await query(`INSERT INTO category_list_sources (user_id, source_type, value, enabled) VALUES
  ($1, 'builtin', 'social_networks', false), ($2, 'builtin', 'social_networks', true), ($1, 'manual', 'x.com', true)`,
  [alice, bob]);

await query(`INSERT INTO snoozed_messages (user_id, account_id, message_id_header, original_folder, snooze_until)
  VALUES ($1, $2, '<m9@example.com>', 'INBOX', NOW() + INTERVAL '1 day')`, [bob, b1]);
await query(`INSERT INTO spam_training_log (user_id, account_id, message_id_header, label)
  VALUES ($1, $2, '<m1@example.com>', 'spam')`, [alice, a1]);

writeFileSync('/tmp/shared-data-ids.json', JSON.stringify({ alice, bob, a1, a2, b1, m1, m2 }));
await pool.end();
console.log('shared data seeded');
```

- [ ] **Step 3: Write the check script**

`<scratchpad>/shared-data-check.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runMigrations } from './src/services/migrations.js';
import { pool, query } from './src/services/db.js';

const ids = JSON.parse(readFileSync('/tmp/shared-data-ids.json', 'utf8'));
await runMigrations();
const rows = async (sql, params = []) => (await query(sql, params)).rows;
const sorted = (list) => [...list].sort();

for (const table of ['email_accounts', 'inbox_rules', 'block_list', 'address_books', 'contacts',
  'category_list_sources', 'snoozed_messages', 'spam_training_log']) {
  const cols = await rows('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
  assert.ok(!cols.some((c) => c.column_name === 'user_id'), `${table}.user_id is gone`);
}

// Mailboxes remember who added them.
assert.deepEqual(
  sorted((await rows('SELECT id, added_by FROM email_accounts')).map((r) => `${r.id}|${r.added_by}`)),
  sorted([`${ids.a1}|${ids.alice}`, `${ids.a2}|${ids.alice}`, `${ids.b1}|${ids.bob}`]),
);

// A rule for all of an owner's mailboxes became one rule per mailbox, each with its own forwards.
assert.deepEqual(
  sorted((await rows('SELECT name, account_id, created_by FROM inbox_rules')).map((r) => `${r.name}|${r.account_id}|${r.created_by}`)),
  sorted([
    `alice a1|${ids.a1}|${ids.alice}`, `alice all|${ids.a1}|${ids.alice}`,
    `alice all|${ids.a2}|${ids.alice}`, `bob all|${ids.b1}|${ids.bob}`,
  ]),
);
assert.deepEqual(
  sorted((await rows('SELECT r.account_id, f.message_id FROM inbox_rule_forwards f JOIN inbox_rules r ON r.id = f.rule_id'))
    .map((r) => `${r.account_id}|${r.message_id}`)),
  sorted([`${ids.a1}|${ids.m1}`, `${ids.a2}|${ids.m2}`]),
);
await assert.rejects(query("INSERT INTO inbox_rules (name) VALUES ('no mailbox')"), { code: '23502' });

// Block list entries were copied to each mailbox of their owner.
assert.deepEqual(
  sorted((await rows('SELECT account_id, email_address FROM block_list')).map((r) => `${r.account_id}|${r.email_address}`)),
  sorted([`${ids.a1}|spam@example.com`, `${ids.a2}|spam@example.com`, `${ids.b1}|spam@example.com`, `${ids.b1}|other@example.com`]),
);
await assert.rejects(query('INSERT INTO block_list (account_id, email_address) VALUES ($1, $2)', [ids.b1, 'other@example.com']), { code: '23505' });

// Local books merged into the one shared book; books imported from CardDAV are gone with their contacts.
assert.deepEqual(await rows('SELECT name, is_default FROM address_books'), [{ name: 'Contacts', is_default: true }]);
const bookCols = (await rows("SELECT column_name FROM information_schema.columns WHERE table_name = 'address_books'"))
  .map((c) => c.column_name);
for (const gone of ['source', 'external_url', 'sync_token']) assert.ok(!bookCols.includes(gone), `address_books.${gone} is gone`);
assert.deepEqual(await rows(`SELECT c.primary_email, c.is_auto, c.send_count
    FROM contacts c JOIN address_books b ON b.id = c.address_book_id
   WHERE b.is_default ORDER BY c.primary_email`), [
  { primary_email: 'x@example.com', is_auto: false, send_count: 3 },
  { primary_email: 'y@example.com', is_auto: true, send_count: 0 },
  { primary_email: 'z@example.com', is_auto: false, send_count: 0 },
]);
assert.equal((await rows('SELECT COUNT(*)::int AS n FROM contacts'))[0].n, 3);
await assert.rejects(query("INSERT INTO address_books (name, is_default) VALUES ('Another default', true)"), { code: '23505' });

// CardDAV connections are gone; other personal integrations stay.
assert.deepEqual((await rows('SELECT provider FROM user_integrations')).map((r) => r.provider), ['todoist']);

// Category sources are one install-wide set; categorization is on because someone had it on.
assert.deepEqual(await rows('SELECT source_type, value, enabled FROM category_list_sources ORDER BY source_type, value'), [
  { source_type: 'builtin', value: 'social_networks', enabled: true },
  { source_type: 'manual', value: 'x.com', enabled: true },
]);
assert.equal((await rows("SELECT value FROM system_settings WHERE key = 'categorization_enabled'"))[0].value, 'true');
assert.deepEqual((await rows('SELECT preferences FROM users WHERE id = $1', [ids.alice]))[0].preferences, { theme: 'dark' });

assert.equal((await rows('SELECT snoozed_by FROM snoozed_messages'))[0].snoozed_by, ids.bob);
assert.equal((await rows('SELECT trained_by FROM spam_training_log'))[0].trained_by, ids.alice);

// Deleting a user keeps the mailbox and everything around it.
await query('DELETE FROM users WHERE id = $1', [ids.bob]);
assert.equal((await rows('SELECT added_by FROM email_accounts WHERE id = $1', [ids.b1]))[0].added_by, null);
assert.equal((await rows("SELECT created_by FROM inbox_rules WHERE name = 'bob all'"))[0].created_by, null);
assert.equal((await rows('SELECT COUNT(*)::int AS n FROM block_list WHERE account_id = $1', [ids.b1]))[0].n, 2);
assert.equal((await rows('SELECT snoozed_by FROM snoozed_messages'))[0].snoozed_by, null);

await pool.end();
console.log('shared data check ok');
```

`<scratchpad>/fresh-install-check.mjs`:

```js
import assert from 'node:assert/strict';
import { runMigrations } from './src/services/migrations.js';
import { pool, query } from './src/services/db.js';

await runMigrations();
assert.deepEqual((await query('SELECT name, is_default FROM address_books')).rows, [{ name: 'Contacts', is_default: true }]);
assert.equal((await query("SELECT value FROM system_settings WHERE key = 'categorization_enabled'")).rows[0].value, 'false');
await pool.end();
console.log('fresh install check ok');
```

- [ ] **Step 4: Run the check against the old schema and see it fail**

```bash
docker network create mailexpert-check
docker run -d --name mailexpert-check-db --network mailexpert-check -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=check -e POSTGRES_DB=mailexpert postgres:16-alpine
docker run -d --name mailexpert-check-redis --network mailexpert-check redis:7-alpine
docker exec mailexpert-check-db sh -c 'until pg_isready -U mailexpert >/dev/null; do sleep 1; done; sleep 2'
docker network connect mailexpert-check mailexpert-backend-test
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work'
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/shared-data-seed.mjs" mailexpert-backend-test:/work/backend/shared-data-seed.mjs
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/shared-data-check.mjs" mailexpert-backend-test:/work/backend/shared-data-check.mjs
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-check-db -e DB_PASSWORD=check mailexpert-backend-test sh -c 'cd /work/backend && node shared-data-seed.mjs 2>&1 | tail -3 && node shared-data-check.mjs 2>&1 | tail -5'
```

Expected: `shared data seeded`, затем `AssertionError`: `email_accounts.user_id is gone`. Файла 0056 ещё нет.

- [ ] **Step 5: Write the migration**

`backend/migrations/0056_shared_mailbox_data.sql`:

```sql
-- Mailboxes and the data around them are shared by every user of the install. Owner columns
-- become "who did it" columns that outlive the user, and per-user copies of what is now one
-- install-wide set are merged. The owner columns go last: the copy steps enumerate each
-- owner's mailboxes and books through them.

-- Mailboxes remember who added them.
ALTER TABLE email_accounts ADD COLUMN added_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE email_accounts SET added_by = user_id;

-- A rule for "all my mailboxes" becomes one rule per mailbox of its owner. Each copy keeps the
-- forward reservations for messages of its own mailbox, so nothing is forwarded twice.
ALTER TABLE inbox_rules ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE inbox_rules ADD COLUMN copied_from UUID;
UPDATE inbox_rules SET created_by = user_id;
INSERT INTO inbox_rules (user_id, created_by, account_id, name, enabled, stop_processing, priority,
                         condition_logic, conditions, actions, created_at, updated_at, copied_from)
SELECT r.user_id, r.created_by, a.id, r.name, r.enabled, r.stop_processing, r.priority,
       r.condition_logic, r.conditions, r.actions, r.created_at, r.updated_at, r.id
  FROM inbox_rules r
  JOIN email_accounts a ON a.user_id = r.user_id
 WHERE r.account_id IS NULL;
INSERT INTO inbox_rule_forwards (rule_id, message_id, status, created_at, sent_at)
SELECT n.id, f.message_id, f.status, f.created_at, f.sent_at
  FROM inbox_rules n
  JOIN inbox_rule_forwards f ON f.rule_id = n.copied_from
  JOIN messages m ON m.id = f.message_id AND m.account_id = n.account_id
ON CONFLICT (rule_id, message_id) DO NOTHING;
DELETE FROM inbox_rules WHERE account_id IS NULL;
ALTER TABLE inbox_rules DROP COLUMN copied_from;
ALTER TABLE inbox_rules ALTER COLUMN account_id SET NOT NULL;

-- A block list entry applies to each mailbox of its owner.
ALTER TABLE block_list DROP CONSTRAINT block_list_user_id_email_address_key;
ALTER TABLE block_list ADD COLUMN account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE;
INSERT INTO block_list (user_id, account_id, email_address, created_at)
SELECT b.user_id, a.id, b.email_address, b.created_at
  FROM block_list b
  JOIN email_accounts a ON a.user_id = b.user_id
 WHERE b.account_id IS NULL;
DELETE FROM block_list WHERE account_id IS NULL;
ALTER TABLE block_list ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE block_list ADD CONSTRAINT block_list_account_id_email_address_key UNIQUE (account_id, email_address);

-- Snoozes and spam decisions remember who made them.
ALTER TABLE snoozed_messages ADD COLUMN snoozed_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE snoozed_messages SET snoozed_by = user_id;
ALTER TABLE spam_training_log ADD COLUMN trained_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE spam_training_log SET trained_by = user_id;

-- Contacts live only inside the install: books imported from an external CardDAV server go
-- with their contacts, and so do the connections that filled them.
DELETE FROM address_books WHERE source = 'carddav';
DELETE FROM user_integrations WHERE provider = 'carddav';

-- Address books: one shared book holds every contact.
ALTER TABLE address_books DROP CONSTRAINT address_books_user_id_name_key;
ALTER TABLE address_books ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE address_books ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ALTER COLUMN user_id DROP NOT NULL;

-- Each user's books hold what they sent to, created by hand or learned from inbound mail.
-- They merge into the shared book; a contact present in several keeps its best copy with the
-- sends of all of them.
CREATE TEMP TABLE merged_books ON COMMIT DROP AS
  SELECT id FROM address_books;
INSERT INTO address_books (name, is_default) VALUES ('Contacts', true);
CREATE TEMP TABLE merged_contacts ON COMMIT DROP AS
  SELECT c.id,
         row_number() OVER same_contact AS keep_rank,
         SUM(c.send_count) OVER (PARTITION BY COALESCE(c.primary_email, c.id::text)) AS send_count,
         MAX(c.last_sent) OVER (PARTITION BY COALESCE(c.primary_email, c.id::text)) AS last_sent
    FROM contacts c
   WHERE c.address_book_id IN (SELECT id FROM merged_books)
  WINDOW same_contact AS (PARTITION BY COALESCE(c.primary_email, c.id::text)
                          ORDER BY c.is_auto, c.send_count DESC, c.updated_at DESC, c.id);
DELETE FROM contacts WHERE id IN (SELECT id FROM merged_contacts WHERE keep_rank > 1);
UPDATE contacts c
   SET send_count = m.send_count, last_sent = m.last_sent
  FROM merged_contacts m
 WHERE c.id = m.id AND m.keep_rank = 1;
-- A card written with the same vCard UID into two users' books keeps its newest copy.
DELETE FROM contacts c
 WHERE c.address_book_id IN (SELECT id FROM merged_books)
   AND EXISTS (SELECT 1 FROM contacts o
                WHERE o.address_book_id IN (SELECT id FROM merged_books)
                  AND o.uid = c.uid
                  AND (o.updated_at, o.id) > (c.updated_at, c.id));
UPDATE contacts SET address_book_id = (SELECT id FROM address_books WHERE is_default)
 WHERE address_book_id IN (SELECT id FROM merged_books);
DELETE FROM address_books WHERE id IN (SELECT id FROM merged_books);
CREATE UNIQUE INDEX address_books_single_default_idx ON address_books (is_default) WHERE is_default;
-- These columns served CardDAV sync only.
ALTER TABLE address_books DROP COLUMN source;
ALTER TABLE address_books DROP COLUMN external_url;
ALTER TABLE address_books DROP COLUMN sync_token;

-- Category sources are one install-wide set; duplicates keep the enabled, freshest copy.
DELETE FROM category_list_sources s
 USING (SELECT id,
               row_number() OVER (PARTITION BY source_type, value
                                  ORDER BY enabled DESC, last_fetched_at DESC NULLS LAST, created_at, id) AS keep_rank
          FROM category_list_sources) r
 WHERE s.id = r.id AND r.keep_rank > 1;
ALTER TABLE category_list_sources DROP COLUMN user_id;
ALTER TABLE category_list_sources ADD CONSTRAINT category_list_sources_source_type_value_key UNIQUE (source_type, value);

-- Categorization is on for the install when anyone had it on.
INSERT INTO system_settings (key, value, updated_at)
SELECT 'categorization_enabled',
       CASE WHEN EXISTS (SELECT 1 FROM users WHERE preferences->>'categorizationEnabled' = 'true')
            THEN 'true' ELSE 'false' END,
       NOW()
ON CONFLICT (key) DO NOTHING;
UPDATE users SET preferences = preferences - 'categorizationEnabled' WHERE preferences ? 'categorizationEnabled';

-- Owner columns go; dropping a column also drops the indexes and constraints built on it.
ALTER TABLE inbox_rules DROP COLUMN user_id;
DROP INDEX IF EXISTS idx_inbox_rules_account;
CREATE INDEX idx_inbox_rules_account ON inbox_rules (account_id, enabled, priority);
ALTER TABLE block_list DROP COLUMN user_id;
ALTER TABLE snoozed_messages DROP COLUMN user_id;
ALTER TABLE spam_training_log DROP COLUMN user_id;
CREATE INDEX idx_spam_training_account ON spam_training_log (account_id, created_at DESC);
CREATE INDEX idx_spam_training_account_label ON spam_training_log (account_id, label);
CREATE INDEX idx_spam_training_account_message ON spam_training_log (account_id, message_id_header)
  WHERE message_id_header IS NOT NULL;
ALTER TABLE contacts DROP COLUMN user_id;
CREATE INDEX contacts_primary_email_lookup_idx ON contacts (primary_email) WHERE primary_email IS NOT NULL;
CREATE INDEX contacts_display_name_idx ON contacts (lower(display_name));
ALTER TABLE address_books DROP COLUMN user_id;
ALTER TABLE email_accounts DROP COLUMN user_id;
```

- [ ] **Step 6: Replay the old model and run the check**

База после Step 4 уже содержит 0056-less схему с данными. Пересоздать базу, засеять данные без 0056 и прогнать проверку с 0056:

```bash
docker exec mailexpert-check-db sh -c 'dropdb -U mailexpert --force mailexpert && createdb -U mailexpert mailexpert'
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work && mv /work/backend/migrations/0056_shared_mailbox_data.sql /tmp/'
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-check-db -e DB_PASSWORD=check mailexpert-backend-test sh -c 'cd /work/backend && node shared-data-seed.mjs 2>&1 | tail -3 && mv /tmp/0056_shared_mailbox_data.sql migrations/ && node shared-data-check.mjs 2>&1 | tail -5'
```

Expected: `shared data seeded`, `Migrations: applying 0056_shared_mailbox_data`, `shared data check ok`.

Если падает `DROP CONSTRAINT` из-за имени ограничения — посмотреть настоящее имя (`docker exec mailexpert-check-db psql -U mailexpert -c '\d block_list'`), остановиться и сообщить. Имя угадывать нельзя.

- [ ] **Step 7: Fresh install**

```bash
docker exec mailexpert-check-db createdb -U mailexpert fresh
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/fresh-install-check.mjs" mailexpert-backend-test:/work/backend/fresh-install-check.mjs
MSYS_NO_PATHCONV=1 docker exec -e DB_HOST=mailexpert-check-db -e DB_PASSWORD=check -e DB_NAME=fresh mailexpert-backend-test sh -c 'cd /work/backend && node fresh-install-check.mjs 2>&1 | tail -3'
```

Expected: `fresh install check ok`.

Контейнеры `mailexpert-check-*` не удалять: база `mailexpert` понадобится в Task 9. Удалённый пользователь `bob` там уже учтён.

- [ ] **Step 8: Commit**

```bash
git add backend/migrations/0056_shared_mailbox_data.sql
git commit -m "feat(db): share mailboxes and the data around them across the install"
```

### Task 2: Ящики и письма без проверки владельца

**Files:**
- Modify: `backend/src/routes/accounts.js`, `backend/src/routes/mail.js`, `backend/src/routes/draft.js`, `backend/src/routes/send.js` (строки 185, 227–232), `backend/src/routes/search.js`, `backend/src/services/messageService.js`, `backend/src/services/mailAccess.js`, `backend/src/services/diagnosticsReport.js`, `backend/src/routes/oauth.js`, `backend/src/routes/oauthGoogle.js`, `backend/src/routes/admin.js`, `backend/src/plugins/activation.js`, `backend/src/plugins/gtd/routes.js` (комментарий)
- Create: `backend/src/routes/accounts.shared.test.js`
- Modify tests: `routes/mail.createFolder.test.js`, `routes/mail.emptyFolder.test.js`, `routes/mail.sync.test.js`, `routes/mail.resolve.test.js`, `routes/mail.unifiedInbox.test.js`, `routes/send.forwarded.test.js`, `routes/admin.users.test.js`, `routes/oauth.google.test.js`, `services/diagnosticsReport.test.js`, `plugins/gtd/gtdSections.test.js`, `plugins/activation.test.js`

**Interfaces:**
- Consumes: схема из Task 1 (`email_accounts.added_by`, `snoozed_messages.snoozed_by`, `spam_training_log.trained_by`).
- Produces:
  - `listMessages({ accountId, folder, limit, offset, unreadOnly, threaded, category })` — без `userId`;
  - `buildServerReport(userId, salt)` — прежняя сигнатура, `userId` нужен только для активации плагинов и признака администратора;
  - `isPluginActivatedForAccount(pluginId)` — лишние аргументы игнорируются, вызовы с `(pluginId, accountId)` остаются рабочими;
  - `loadOwnedMessage(userId, messageId)`, `getOwnedAccount(userId, accountId)`, `listUserAccounts(userId)` — сигнатуры прежние, `userId` не используется.

- [ ] **Step 1: Write the failing route test**

`backend/src/routes/accounts.shared.test.js`:

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

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ID = '66666666-6666-4666-8666-666666666666';

// Mailboxes belong to the install: whoever is signed in lists, changes and deletes all of them,
// and a new mailbox only remembers who added it.
describe('mailboxes are shared by every user', () => {
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
    query.mockReset().mockImplementation(async () => ({ rows: [{ id: ID, protocol: 'pop3' }] }));
  });

  const ownerFilters = () => query.mock.calls.filter(([sql]) => /user_id/.test(sql));

  it('lists every mailbox', async () => {
    const res = await fetch(`${base}/api/accounts`);
    expect(res.status).toBe(200);
    expect(query.mock.calls[0][0]).toMatch(/FROM email_accounts\s+ORDER BY sort_order, created_at/);
    expect(query.mock.calls[0][1]).toBeUndefined();
    expect(ownerFilters()).toEqual([]);
  });

  it('records who added a mailbox', async () => {
    const res = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Team', email_address: 'team@example.com', protocol: 'pop3' }),
    });
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls.find(([s]) => /INSERT INTO email_accounts/.test(s));
    expect(sql).toMatch(/INSERT INTO email_accounts \(\s*added_by, name/);
    expect(params[0]).toBe('user-2');
  });

  it('deletes a mailbox someone else added', async () => {
    const res = await fetch(`${base}/api/accounts/${ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith('SELECT id FROM email_accounts WHERE id = $1', [ID]);
    expect(query).toHaveBeenCalledWith('DELETE FROM email_accounts WHERE id = $1', [ID]);
    expect(imapManager.disconnectAccount).toHaveBeenCalledWith(ID);
    expect(ownerFilters()).toEqual([]);
  });

  it('checks aliases against the mailbox only', async () => {
    await fetch(`${base}/api/accounts/${ID}/aliases/${ID}`, { method: 'DELETE' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE a\.id = \$1 AND e\.id = \$2/);
    expect(params).toEqual([ID, ID]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bt src/routes/accounts.shared.test.js`
Expected: FAIL — запросы содержат `user_id`, `INSERT` начинается с `user_id`.

- [ ] **Step 3: `accounts.js` without owner checks**

В `backend/src/routes/accounts.js`:

1. `GET /` (строки 67–76): заменить

```js
            categorization_enabled
     FROM email_accounts WHERE user_id = $1 ORDER BY sort_order, created_at`,
    [req.session.userId]
  );
```

на

```js
            categorization_enabled
     FROM email_accounts
     ORDER BY sort_order, created_at`
  );
```

2. `POST /` (строки 147–159): в списке колонок `user_id, name, sender_name, ...` заменить `user_id` на `added_by`; первый параметр `req.session.userId` остаётся.

3. Везде, где проверяется ящик по id, — `PUT /:id` (182), `DELETE /:id` (325), `POST /:id/reconnect` (344), `GET /:id/aliases` (359), `POST /:id/aliases` (380), `GET /:id/folders` (433):

```js
query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId])
```

→

```js
query('SELECT id FROM email_accounts WHERE id = $1', [id])
```

Для `reconnect` в той же форме `SELECT * FROM email_accounts WHERE id = $1`. В `PUT /:id` комментарий `// Verify ownership.` заменить на `// The mailbox must exist.`

4. `PUT` и `DELETE /:id/aliases/:aliasId` (строки 398–403 и 417–423):

```js
    `SELECT a.id, a.account_id FROM account_aliases a
     JOIN email_accounts e ON a.account_id = e.id
     WHERE a.id = $1 AND e.id = $2`,
    [aliasId, id]
```

5. `POST /:id/reindex` (строки 447–450):

```js
      "SELECT * FROM email_accounts WHERE id = $1 AND enabled = true AND protocol = 'imap'",
      [req.params.id]
```

Run: `bt src/routes/accounts.shared.test.js src/routes/accounts.reconnectCooldown.test.js src/routes/accounts.aliases.test.js src/routes/accounts.health.test.js src/routes/accounts.oauthFields.test.js src/routes/accounts.unifiedInbox.test.js`
Expected: PASS.

- [ ] **Step 4: `mail.js` without owner checks**

В `backend/src/routes/mail.js` (номера строк — по `main` 8f200de):

| Строки | Было | Стало |
|---|---|---|
| 147–156 | `listMessages({ userId: req.session.userId, accountId, ...` | `listMessages({ accountId, ...` (строку `userId` удалить) |
| 190–194 | `WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false` + `[id, req.session.userId]` | `WHERE m.id = $1 AND m.is_deleted = false` + `[id]` |
| 207–209 | комментарий `...Columns and the user-scoping (a.user_id, is_deleted) mirror GET /messages/:id.` | `...Columns and the is_deleted filter mirror GET /messages/:id.` |
| 231–239 | `AND a.user_id = $2` / `AND ($3::uuid IS NULL OR m.account_id = $3)` / `[ref, req.session.userId, accountId]` | строку `a.user_id` удалить, `$3` → `$2`, `[ref, accountId]` |
| 244–250 | то же для поиска по UUID | то же |
| 281–284 | `'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true', [req.session.userId]` | `'SELECT id, include_in_unified_inbox FROM email_accounts WHERE enabled = true'` без параметров |
| 328 | `WHERE a.user_id=$1 AND a.enabled`, [req.session.userId]);` | `WHERE a.enabled`);` |
| 820–823 | `'SELECT id, enabled, protocol FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]` | `'SELECT id, enabled, protocol FROM email_accounts WHERE id = $1', [accountId]` |
| 808 | комментарий `The mailbox a manual sync targets: one the user can reach.` | `The mailbox a manual sync targets, if it exists.` |
| 860–863, 878–881 | `'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]` | `'SELECT * FROM email_accounts WHERE id = $1', [accountId]` |
| 901, 941, 961, 1034 | `query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId])` | `query('SELECT * FROM email_accounts WHERE id = $1', [accountId])` |
| 1367 | `'SELECT id, folder_mappings FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]` | `'SELECT id, folder_mappings FROM email_accounts WHERE id = $1', [accountId]` |
| 1422 | `'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]` | `'SELECT id FROM email_accounts WHERE id = $1', [accountId]` |
| 1841 | `// Ownership check` | `// The message must exist` |
| 2157–2160 | как 281–284 | как 281–284 |

Запросы писем по id (одиночные). Для `/messages/:id/headers` (513–518), `attachments.zip` (565–570), `attachments/:part` (649–654), `/messages/:id/snooze` (1842–1847) и `DELETE /messages/:id` (1926–1930) заменить

```js
    SELECT m.*, a.user_id FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);
```

на

```js
    SELECT m.* FROM messages m
    WHERE m.id = $1
  `, [id]);
```

В `snooze` отступы на два пробела меньше, но форма та же.

`/messages/:id/body` (строки 370–375):

```js
  // Remote images follow the preferences of whoever opens the message.
  const result = await query(`
    SELECT m.*, u.preferences FROM messages m
    LEFT JOIN users u ON u.id = $2
    WHERE m.id = $1
  `, [id, req.session.userId]);
```

`/messages/:id/read` (697–706) и `/messages/:id/star` (760–769):

```js
  const result = await query(`
    SELECT m.*,
           CASE WHEN m.message_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM messages s
                       WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
           END AS sibling_count
    FROM messages m
    WHERE m.id = $1
  `, [id]);
```

Массовые операции:
- `bulk-read` (1080–1085): `SELECT m.id, m.uid, m.folder, m.is_read, m.account_id, m.message_id FROM messages m WHERE m.id = ANY($1::uuid[])`, параметры `[ids]`;
- `bulk-delete` (1180–1185) и `bulk-archive` (1590–1595): `SELECT m.*, a.folder_mappings FROM messages m JOIN email_accounts a ON m.account_id = a.id WHERE m.id = ANY($1::uuid[])`, параметры `[ids]`;
- `bulk-move` (1451–1456): `SELECT m.* FROM messages m WHERE m.id = ANY($1::uuid[])`, параметры `[ids]`.

Вставка в `snoozed_messages` (1903–1906):

```js
        `INSERT INTO snoozed_messages (snoozed_by, account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
         VALUES ($1, $2, $3, $4, $5, $6)`,
```

Параметры те же.

`moveForSpamLabel` (2022–2026):

```js
  const result = await query(`
    SELECT m.*, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1
  `, [messageId]);
```

Обе вставки в `spam_training_log` (2036–2039 и 2096–2099): `(user_id, account_id, ...` → `(trained_by, account_id, ...`. Параметры те же, первым остаётся `userId`.

Поиски перед `spam` (2132–2136) и `ham` (2286–2290): удалить `AND a.user_id = $2`, параметры `[id]`.

`PATCH /messages/:id/category` (2194–2202):

```js
  const result = await query(
    `UPDATE messages SET category = $1
     WHERE id = $2
     RETURNING id`,
    [category === 'primary' ? null : category, id]
  );
```

`POST /messages/:id/unsubscribe` (2213–2219):

```js
  const result = await query(`
    SELECT m.list_unsubscribe, m.list_unsubscribe_post
    FROM messages m
    WHERE m.id = $1 AND m.is_deleted = false
  `, [id]);
```

Проверка: `grep -n "user_id" backend/src/routes/mail.js` показывает только три вызова `broadcast` с `check.rows[0].user_id` и `account.user_id` (строки 891, 1052, 1053, 1056). Их меняет Task 3.

- [ ] **Step 5: `draft.js`, `send.js`, `search.js`, `messageService.js`**

`backend/src/routes/draft.js`, строки 134–137 и 197–200:

```js
  const ownerCheck = await query(
    'SELECT id FROM email_accounts WHERE id = $1',
    [accountId]
  );
```

(во втором месте — `SELECT *`).

`backend/src/routes/send.js`:
- строка 185: `query('SELECT * FROM email_accounts WHERE id = $1', [accountId]),`;
- строки 226–232:

```js
      // Resolve every referenced message in a SINGLE query so a large forwardedAttachments
      // array can't fan out into one DB round-trip per entry.
      const distinctMsgIds = [...new Set(forwardedAttachments.map(fa => fa.messageId))];
      const msgRows = await query(
        `SELECT m.id, m.uid, m.folder, m.attachments, m.account_id FROM messages m
         WHERE m.id = ANY($1::uuid[])`,
        [distinctMsgIds]
      );
```

Контакты в `send.js` меняет Task 5.

`backend/src/routes/search.js`:
- строки 133–136: `'SELECT id, include_in_unified_inbox FROM email_accounts WHERE enabled = true'` без параметров;
- строки 273–278:

```js
  const accountsResult = await query('SELECT id FROM email_accounts WHERE enabled = true');
  const mailboxIds = accountsResult.rows.map(r => r.id);
  if (!mailboxIds.length) return res.json({ contacts: [] });
```

- запрос подсказок (279–336) переписать без владельца, `$1` — шаблон, `$2` — ящики:

```js
    const result = await query(`
      WITH known AS (
        -- Contacts someone sent to or created by hand (is_auto = false)
        SELECT primary_email AS email, display_name AS name, send_count, last_sent
        FROM contacts
        WHERE is_auto = false
          AND primary_email IS NOT NULL
          AND (display_name ILIKE $1 OR primary_email ILIKE $1)
      ),
      auto AS (
        -- Auto-discovered inbound contacts not already in known
        SELECT primary_email AS email, display_name AS name, 0 AS send_count, last_sent
        FROM contacts
        WHERE is_auto = true
          AND primary_email IS NOT NULL
          AND (display_name ILIKE $1 OR primary_email ILIKE $1)
          AND lower(primary_email) NOT IN (SELECT lower(email) FROM known)
      ),
      inbound AS (
        -- Fallback: senders not yet in contacts table, excluding bulk/robot
        SELECT email, name, send_count, last_sent
        FROM (
          SELECT DISTINCT ON (from_email)
            from_email AS email,
            from_name  AS name,
            0          AS send_count,
            date       AS last_sent,
            is_bulk
          FROM messages
          WHERE account_id = ANY($2)
            AND is_deleted = false
            AND from_email IS NOT NULL AND from_email != ''
            AND (from_email ILIKE $1 OR from_name ILIKE $1)
            AND lower(from_email) NOT IN (
              SELECT lower(primary_email) FROM contacts WHERE primary_email IS NOT NULL
            )
            AND from_email !~* '^(noreply|no-reply|donotreply|mailer-daemon|notifications?|bounce[^@]*)@'
          ORDER BY from_email, date DESC
        ) latest
        WHERE is_bulk IS NOT TRUE
      )
      SELECT email, name
      FROM (
        SELECT email, name, 1 AS priority, send_count, last_sent FROM known
        UNION ALL
        SELECT email, name, 2 AS priority, 0, last_sent FROM auto
        UNION ALL
        SELECT email, name, 3 AS priority, 0, last_sent FROM inbound
      ) combined
      ORDER BY priority, send_count DESC, last_sent DESC NULLS LAST
      LIMIT 10
    `, [pattern, mailboxIds]);
```

Комментарий над маршрутом, если в нём есть «the user's contacts», заменить на «contacts».

`backend/src/services/messageService.js`:
- сигнатура: `export async function listMessages({ accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly, threaded, category }) {`;
- строки 5–8: `const accountsResult = await query('SELECT id, include_in_unified_inbox FROM email_accounts WHERE enabled = true');`;
- в обоих местах (116–120 и 194–198) заменить `LEFT JOIN contacts co ...` и `(co.id IS NOT NULL) AS has_contact_photo`. Контакты теперь общие и уникальны только внутри книги, поэтому JOIN размножал бы строки. Колонка:

```sql
               EXISTS (SELECT 1 FROM contacts co
                        WHERE co.primary_email = lower(m.from_email)
                          AND co.photo_data IS NOT NULL) AS has_contact_photo
```

Сами строки `LEFT JOIN contacts co ON co.user_id = a.user_id` и два следующих `AND ...` удаляются.

- [ ] **Step 6: `mailAccess.js`, `diagnosticsReport.js`, GTD comment**

`backend/src/services/mailAccess.js`. Заголовочный абзац `// Scoping: ...` (строки 7–10) заменить на:

```js
// Scoping: every mailbox is shared by all users of the install, so the entry reads
// (loadOwnedMessage, listUserAccounts, getOwnedAccount) check only that the message or mailbox
// exists. They keep their userId parameter and names so plugins need no change. Account-scoped
// reads take an accountId from one of the entry reads and only ever read within that account.
```

Функции:

```js
// A message by id, or null. Full row (m.*).
export async function loadOwnedMessage(userId, messageId) {
  const { rows } = await query('SELECT m.* FROM messages m WHERE m.id = $1', [messageId]);
  return rows[0] || null;
}

// A mailbox by id, or null. Full row.
export async function getOwnedAccount(userId, accountId) {
  const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  return rows[0] || null;
}

// Every mailbox (light columns for listing/iteration). The caller filters by its own
// per-account config (e.g. which accounts have a feature enabled).
export async function listUserAccounts(userId) {
  const { rows } = await query(
    `SELECT id, email_address, folder_mappings, include_in_unified_inbox, enabled
       FROM email_accounts
      ORDER BY sort_order, created_at`
  );
  return rows;
}
```

`backend/src/services/diagnosticsReport.js`:
- комментарий над `buildServerReport`: `// Assemble the server-owned sections of the report. Mailboxes are shared, so every mailbox is in it.`;
- три запроса (108–134) без владельца:

```js
  const accRes = await query(
    `SELECT id, protocol, oauth_provider, imap_host, enabled, include_in_unified_inbox, last_sync, sync_error
     FROM email_accounts ORDER BY sort_order NULLS LAST, created_at`,
  );
  const folRes = await query(
    `SELECT f.account_id, f.name, f.special_use, f.total_count, f.unread_count
     FROM folders f JOIN email_accounts a ON a.id = f.account_id`,
  );
```

```js
  const unreadRes = await query(
    `SELECT m.account_id, COUNT(*)::int AS count
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE a.enabled = true
        AND m.folder = 'INBOX' AND m.is_read = false AND m.is_deleted = false
      GROUP BY m.account_id`,
  );
```

- `userAccountIds` переименовать в `mailboxIds`, комментарии `scoped to this user's accounts` → `for the install's mailboxes`;
- комментарий над `imap`: `They describe every account on the server...` оставить, `userId` для `is_admin` и `getActivatedPlugins` остаётся.

`backend/src/plugins/gtd/routes.js`, комментарий на строках 138–140:

```js
// Load a message by id, or send a 404. The message row carries everything the callers need
// (account_id, uid, folder, message_id), so no account column is selected.
```

- [ ] **Step 7: OAuth mailboxes are matched by email across the install**

`backend/src/routes/oauth.js`, строки 155–166:

```js
  // Serialize the check-then-insert per mailbox address with a transaction-scoped advisory
  // lock. Two OAuth callbacks racing for the same mailbox would otherwise both miss the SELECT
  // and each INSERT, producing duplicate account rows. The second waiter blocks until the first
  // commits, then sees the row and updates it. Mailboxes are shared, so the address alone names one.
  const account = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`oauth-account:${email.toLowerCase()}`]);

    const existing = await client.query(
      'SELECT id FROM email_accounts WHERE lower(email_address) = lower($1) ORDER BY created_at LIMIT 1',
      [email]
    );
```

В `INSERT` (184–186) `user_id, name, email_address, ...` → `added_by, name, email_address, ...`. Параметры те же, первым остаётся `userId`.

`backend/src/routes/oauthGoogle.js`:
- комментарий над `upsertGoogleAccount`: `// Create or update the Gmail mailbox with this address under a transaction-scoped advisory lock so racing callbacks for one mailbox cannot insert duplicates. Mailboxes are shared, so the address alone names one; userId only records who added it. The account is bound to the app whose client issued the tokens.`;
- строки 124–130:

```js
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth-account:${email}`]);

    const existing = await client.query(
      `SELECT id, oauth_refresh_token, oauth_app_id FROM email_accounts
       WHERE lower(email_address) = lower($1)
       ORDER BY created_at LIMIT 1`,
      [email],
    );
```

- в `INSERT` (158–160) `user_id, name, ...` → `added_by, name, ...`.

`backend/src/routes/oauth.google.test.js`:
- строки 213 и 241: `[\`oauth-account:user@gmail.com\`]`;
- строка 242: `/lower\(email_address\) = lower\(\$1\)/`.

- [ ] **Step 8: Deleting a user leaves mailboxes alone**

`backend/src/routes/admin.js`, в `DELETE /users/:id`:
- удалить блок `// Mailboxes still belong to one user: ...` с `if (googleMode) { ... user_has_mailboxes ... }` (строки 227–234);
- удалить комментарий `// While mailboxes still belong to one user, the FK cascade ...`, строку `const { rows: ownedMailboxes } = ...` и цикл `for (const mailbox of ownedMailboxes) { ... }` (строки 238–249). Остаётся:

```js
  stopCardavUser(id);
  await signOutEverywhere(id);
  await query('DELETE FROM users WHERE id = $1', [id]);
```

`stopCardavUser` уберёт Task 5. Переменные `settings` и `googleMode` остаются: их используют проверки администратора выше.

`backend/src/routes/admin.users.test.js`:
- удалить `const mailboxes = ...` и тест `keeps mailbox owners in google mode until mailboxes are shared`;
- тест `signs the user out everywhere, deletes them and disconnects the mailboxes the delete removes` переименовать в `signs the user out everywhere and deletes them, keeping the mailboxes`;
- в нём заменить `query.mockImplementation(...)` на `query.mockResolvedValue({ rows: [] });`, убрать `MAILBOX_ID` и ожидание `disconnectAccount`, добавить `expect(imapManager.disconnectAccount).not.toHaveBeenCalled();`.

- [ ] **Step 9: Plugin activation for a shared mailbox**

Тест в `backend/src/plugins/activation.test.js` — новый `describe` в конце файла, импорт дополнить `isPluginActivatedForAccount`:

```js
describe('plugin activation for a mailbox', () => {
  beforeEach(() => query.mockReset());

  it('is on when any active user turned the plugin on, cached per plugin', async () => {
    query.mockResolvedValueOnce({ rows: [{ activated: true }] });
    expect(await isPluginActivatedForAccount('gtd-any', 'acct-1')).toBe(true);
    expect(await isPluginActivatedForAccount('gtd-any', 'acct-2')).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/disabled_at IS NULL/);
    expect(sql).toMatch(/preferences->'enabledPlugins' \? \$1/);
    expect(params).toEqual(['gtd-any']);
  });

  it('forgets the answer when someone toggles the plugin', async () => {
    query.mockResolvedValueOnce({ rows: [{ activated: false }] });
    expect(await isPluginActivatedForAccount('gtd-toggle', 'acct-1')).toBe(false);
    query.mockResolvedValueOnce({ rows: [{ list: [] }] }).mockResolvedValueOnce({ rows: [] });
    await setPluginActivated('u1', 'gtd-toggle', true);
    query.mockResolvedValueOnce({ rows: [{ activated: true }] });
    expect(await isPluginActivatedForAccount('gtd-toggle', 'acct-1')).toBe(true);
  });
});
```

Run: `bt src/plugins/activation.test.js`
Expected: FAIL — функция читает `email_accounts.user_id`.

`backend/src/plugins/activation.js`. Заменить `isPluginActivatedForAccount`:

```js
const activatedByAnyoneCache = new Map(); // pluginId -> { value: boolean, expiry }

// Whether a plugin is on for a mailbox. Mailboxes are shared by every user, so it is on when any
// active user has activated it. Plugins keep passing the account id; the answer does not depend on it.
export async function isPluginActivatedForAccount(pluginId) {
  const cached = activatedByAnyoneCache.get(pluginId);
  if (cached && cached.expiry > Date.now()) return cached.value;
  let value = false;
  try {
    const { rows } = await query(
      `SELECT EXISTS (
         SELECT 1 FROM users
          WHERE disabled_at IS NULL AND preferences->'enabledPlugins' ? $1
       ) AS activated`,
      [pluginId]
    );
    value = rows[0]?.activated === true;
  } catch {
    // A prefs read blip degrades to "not activated" rather than throwing on a hot path.
    value = false;
  }
  activatedByAnyoneCache.set(pluginId, { value, expiry: Date.now() + CACHE_TTL_MS });
  return value;
}
```

В `setPluginActivated` после `invalidateActivationCache(userId);` добавить `activatedByAnyoneCache.delete(pluginId);`.

В заголовочном комментарии файла после абзаца про `users.preferences.enabledPlugins` добавить предложение: `Per-mailbox gates ask whether any active user activated the plugin, because mailboxes are shared.`

- [ ] **Step 10: Update the tests that matched owner SQL**

- `routes/mail.createFolder.test.js:36`, `routes/mail.emptyFolder.test.js:34`, `routes/send.forwarded.test.js:53`: `sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')` → `sql.includes('FROM email_accounts WHERE id = $1')`.
- `routes/mail.sync.test.js:37–41`: условие `sql.includes('FROM email_accounts WHERE id = $1') && params[0] === ACCOUNT_ID && mailboxRow`; тест `answers 404 for a mailbox the user cannot reach` переименовать в `answers 404 for a mailbox that does not exist`.
- `routes/mail.resolve.test.js`: тест на строке 44 переименовать в `scopes a durable Message-ID lookup to the requested account`; ожидания `sql` `toContain('m.account_id = $2')`, `params` `[MESSAGE_ID, ACCOUNT_ID]` и `[MESSAGE_ID, null]`.
- `routes/mail.unifiedInbox.test.js:70`: `expect(query.mock.calls[0][1]).toBeUndefined();`, название теста `...with uncached responses`.
- `services/diagnosticsReport.test.js`:
  - `/FROM email_accounts WHERE user_id/` (строки 104, 209) → `/FROM email_accounts ORDER BY/`;
  - блок `// scoped: every account query filtered by the requesting user` (130–133) → `expect(query.mock.calls.some(c => /user_id/.test(c[0]))).toBe(false);`;
  - название первого теста `produces a hashed, PII-free report of every mailbox from the allowlist`;
  - последний тест переименовать в `counts unread in INBOX of every enabled mailbox`, `toMatch(/a\.user_id = \$1/)` → `toMatch(/a\.enabled = true/)`, `expect(unreadCall[1]).toEqual(['user-9'])` → `expect(unreadCall[1]).toBeUndefined()`.
- `plugins/gtd/gtdSections.test.js:67–75`: тест `reads every mailbox (via the listUserAccounts capability)`, ожидания `expect(sql).not.toContain('user_id')` и `expect(params).toBeUndefined()`.

- [ ] **Step 11: Run the affected tests and the full suite**

Run: `bt src/routes src/services/messageService.test.js src/services/diagnosticsReport.test.js src/plugins`
Expected: PASS.

Run: `bt`
Expected: PASS. Код правил, контактов, категорий и событий эта задача не трогает, поэтому их тесты не меняются. Любое падение — пропущенный мок с SQL владельца; исправить здесь.

Проверка: `grep -rn "user_id" backend/src/routes/{accounts,mail,draft,search,oauth,oauthGoogle}.js backend/src/services/{messageService,mailAccess,diagnosticsReport}.js backend/src/plugins/activation.js`. В выводе допустимы только `broadcast` в `mail.js` (Task 3).

- [ ] **Step 12: Commit**

```bash
git add backend/src
git commit -m "feat(mailboxes): let every user reach every mailbox and message"
```

### Task 3: События ящиков всем, push всем активным пользователям

**Files:**
- Modify: `backend/src/services/imapManager.js`, `backend/src/services/folderStatus.js`, `backend/src/services/labelsRead.js`, `backend/src/services/pushNotifications.js`, `backend/src/routes/mail.js`, `backend/src/plugins/api.js`, `backend/src/plugins/gtd/gtdSections.js`, `backend/src/plugins/gtd/gtdTransitions.js`, `backend/src/plugins/gtd/gtdGist.js`, `backend/src/plugins/gtd/hooks.js`, `backend/src/plugins/gtd/routes.js`
- Create: `backend/src/services/pushNotifications.test.js`
- Modify tests: `services/labelsRead.test.js`, `services/imapManager.test.js`, `services/imapManager.oauthRefresh.test.js`, `services/imapManager.serverMailboxes.test.js`, `services/imapManager.authErrors.test.js`, `routes/mail.emptyFolder.test.js`, `plugins/gtd/{gtdGist,gtdSections,gtdTransitions,hooks,routes.done,tick}.test.js`

**Interfaces:**
- Produces:
  - `sendPushToActiveUsers(payload) → Promise<void>` вместо `sendPushToUser(userId, payload)`;
  - `notifyOnLabelTouch(imapManager, { accountId, messageIds, actedFolders, labelFolders, event })` — без `userId`;
  - `emitGtdIfRelevant(imapManager, accountId, messageIds, actedFolders)`;
  - хук `onMailMutation({ imapManager, accountId, messageIds, actedFolders })`;
  - `queueGistGeneration({ sections, broadcast })`;
  - `broadcast(data, userId = null)` в менеджере не меняется. События ящика вызывают его с одним аргументом. Вторым аргументом адресуется только `rules_run_complete` (`routes/rules.js`).

- [ ] **Step 1: Write the failing push test**

`backend/src/services/pushNotifications.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
vi.mock('./db.js', () => ({ query: vi.fn() }));

process.env.VAPID_PUBLIC_KEY = 'test-public';
process.env.VAPID_PRIVATE_KEY = 'test-private';
const { default: webPush } = await import('web-push');
const { query } = await import('./db.js');
const { sendPushToActiveUsers } = await import('./pushNotifications.js');

beforeEach(() => {
  query.mockReset();
  webPush.sendNotification.mockReset();
});

// Mailboxes are shared, so new mail reaches every active user who subscribed a device.
describe('sendPushToActiveUsers', () => {
  it('notifies every device of every active user and prunes gone subscriptions', async () => {
    query
      .mockResolvedValueOnce({ rows: [
        { id: 1, endpoint: 'https://push.example.com/a', p256dh: 'k1', auth: 'a1' },
        { id: 2, endpoint: 'https://push.example.com/b', p256dh: 'k2', auth: 'a2' },
      ] })
      .mockResolvedValueOnce({ rows: [] });
    webPush.sendNotification
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));

    await sendPushToActiveUsers({ title: 'New mail' });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/JOIN users u ON u\.id = s\.user_id/);
    expect(sql).toMatch(/u\.disabled_at IS NULL/);
    expect(params).toBeUndefined();
    expect(webPush.sendNotification).toHaveBeenCalledTimes(2);
    expect(webPush.sendNotification.mock.calls[0][1]).toBe(JSON.stringify({ title: 'New mail' }));
    expect(query).toHaveBeenLastCalledWith('DELETE FROM push_subscriptions WHERE id = ANY($1)', [[2]]);
  });

  it('sends nothing when nobody subscribed', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await sendPushToActiveUsers({ title: 'New mail' });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });
});
```

Run: `bt src/services/pushNotifications.test.js`
Expected: FAIL — `sendPushToActiveUsers is not a function`.

- [ ] **Step 2: `pushNotifications.js`**

Функцию `sendPushToUser` вместе с JSDoc заменить на:

```js
/**
 * Send a Web Push notification to every subscribed device of every active user. Mailboxes are
 * shared, so new mail concerns everyone who subscribed a device.
 * Stale subscriptions (410 / 404 from the push service) are pruned automatically.
 * Errors from individual devices never throw — they are logged and skipped so
 * one bad subscription can't block delivery to the rest.
 */
export async function sendPushToActiveUsers(payload) {
  if (!pushConfigured) return;

  const result = await query(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth
       FROM push_subscriptions s
       JOIN users u ON u.id = s.user_id
      WHERE u.disabled_at IS NULL`
  );
  if (result.rows.length === 0) return;
```

Дальше тело прежнее. Единственное отличие — строка лога:

```js
        console.warn(`Push send failed for endpoint ${row.endpoint.slice(0, 40)}…:`, err.message);
```

Run: `bt src/services/pushNotifications.test.js`
Expected: PASS.

- [ ] **Step 3: Update the broadcast expectations first (they go red)**

Во всех ожиданиях ниже убрать последний аргумент-адресата `broadcast` (`'u1'`, `'user-1'`, `acct.user_id`). Проверяется вызов с одним аргументом.

- `services/labelsRead.test.js`: в `base` убрать `userId: 'u1', `; строка 40 → `toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' })`; название теста на строке 32 → `broadcasts to every client when an acted message has a live sibling in a label folder`.
- `services/imapManager.test.js`: 1740–1741, 1770–1771 → `expect(self.broadcast).toHaveBeenCalledWith(expect.objectContaining({...}))`; 2084–2086, 2111, 3107, 3141, 3160.
- `services/imapManager.oauthRefresh.test.js`: 234, 380–381, 614.
- `services/imapManager.serverMailboxes.test.js`: 300, 344.
- `plugins/gtd/gtdGist.test.js`: во всех вызовах `queueGistGeneration({...})` убрать `userId: 'u1', `; строка 144 → `toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' })`.
- `plugins/gtd/gtdSections.test.js`: в вызовах `emitGtdIfRelevant(mgr, 'acc-1', 'u1', ...)` (399, 412, 419, 426, 432, 438) убрать `'u1', `; ожидания 407 и 421.
- `plugins/gtd/gtdTransitions.test.js`: 107, 282.
- `plugins/gtd/hooks.test.js`: 51, 147, 187, 195, 202. На строках 212–213:

```js
    await onMailMutation({ imapManager: mgr, accountId: 'a1', messageIds: ['<m1>'], actedFolders: ['INBOX'] });
    expect(emitGtdIfRelevant).toHaveBeenCalledWith(mgr, 'a1', ['<m1>'], ['INBOX']);
```

- `plugins/gtd/routes.done.test.js`: 120, 168.
- `plugins/gtd/tick.test.js`: 105, 120.
- Моки `vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }))` в `imapManager.test.js`, `imapManager.oauthRefresh.test.js`, `imapManager.serverMailboxes.test.js`, `imapManager.authErrors.test.js` → `({ sendPushToActiveUsers: vi.fn() })`.
- `services/imapManager.test.js:1080`: `if (sql.includes("preferences->>'categorizationEnabled'"))` → `if (sql.includes("key = 'categorization_enabled'")) return Promise.resolve({ rows: [{ value: 'false' }] });`. Сам запрос появится в Task 6, до него мок не срабатывает и не мешает.
- `routes/mail.emptyFolder.test.js`: в первом успешном тесте (после `expect(imapManager.emptyFolder).toHaveBeenCalledWith(ACCOUNT, 'Trash');`) добавить:

```js
    // Folder events reach every client, not only the user who emptied the folder.
    expect(imapManager.broadcast.mock.calls.every((call) => call.length === 1)).toBe(true);
```

Run: `bt src/services/labelsRead.test.js src/services/imapManager.test.js src/services/imapManager.oauthRefresh.test.js src/services/imapManager.serverMailboxes.test.js src/services/imapManager.authErrors.test.js src/routes/mail.emptyFolder.test.js src/plugins/gtd`
Expected: FAIL. В ожиданиях один аргумент, код ещё передаёт адресата.

- [ ] **Step 4: Manager and folder status**

`backend/src/services/imapManager.js`:

1. Импорт: `import { sendPushToActiveUsers } from './pushNotifications.js';`.
2. В каждом вызове `this.broadcast(...)` убрать второй аргумент. Места: 2185–2188 (многострочный, привести к `this.broadcast({ type: 'exists_hint', accountId: account.id, delta: count - prevCount });`), 2375, 2455, 2500, 2513, 2638, 2667, 2834, 2849 (`syncAccount.user_id`), 3012, 3264, 3705, 3806–3810 (`}, account.user_id);` → `});`), 4073–4076, 4290–4293, 4332, 4494, 4559, 4951, 4986, 5957, 5982, 6085 (`row.user_id`), 6243.
3. Push о новых письмах (3830–3843):

```js
            query(
              `SELECT COUNT(*)::int AS total FROM messages m
               JOIN email_accounts a ON a.id = m.account_id
               WHERE a.enabled = true AND m.folder = 'INBOX' AND m.is_read = false AND m.is_deleted = false`
            ).then(r => {
              sendPushToActiveUsers({ ...basePayload, unreadCount: r.rows[0]?.total ?? 0 })
                .catch(err => console.warn('Push notification error:', err.message));
            }).catch(() => {
              sendPushToActiveUsers(basePayload)
                .catch(err => console.warn('Push notification error:', err.message));
            });
```

Комментарий над ним: `// Include the unread count across every enabled mailbox for the home screen badge.` Вторая строка комментария про отправку без счётчика остаётся.

4. `_runSnoozeWakeup` (6003): `SELECT sm.id AS snooze_id, sm.account_id,` (без `sm.user_id`). Комментарий на 6084: `// Notify open clients so the message reappears`.

Проверка: `grep -n "user_id" backend/src/services/imapManager.js` выводит только места Task 5 и Task 6: `getGlobalCategorizationEnabled(account.user_id)`, `loadSocialDomains(account.user_id)` ×2, `upsertAutoContacts(account.user_id, ...)` и тело `upsertAutoContacts`.

`backend/src/services/folderStatus.js:262`: `this.broadcast({ type: 'folder_counts', accountId: account.id });`.

- [ ] **Step 5: Mail routes**

`backend/src/routes/mail.js`:

1. `notifyMailMutation`:

```js
function notifyMailMutation(rows) {
```

В вызове хука (131–133) убрать `userId, `:

```js
    pluginRegistry.runHook('onMailMutation', {
      imapManager: imapManager.pluginFacade, accountId, messageIds: [...mids], actedFolders: [...folders],
    }).catch(err => console.warn('onMailMutation hook failed:', err.message));
```

2. Все вызовы `notifyMailMutation(x, req.session.userId)` → `notifyMailMutation(x)`: строки 749, 799, 1156, 1346, 1564, 1731, 1916, 2006. В `moveForSpamLabel` (2119) → `notifyMailMutation([message]);`.
3. Во вызовах `imapManager.broadcast(...)` убрать второй аргумент: 724, 802, 891 (`check.rows[0].user_id`), 1052, 1053, 1056 (`account.user_id`), 1130, 1341, 1559, 1725, 1950, 2003. В `moveForSpamLabel` (2110–2113):

```js
  imapManager.broadcast({ type: 'folder_updated', folder: destinationFolder, accountId: account.id });
```

4. Комментарии:
   - 722–723: `// Notify other open clients so a read/unread on one device reflects on the rest in place, without a full folder refetch (the originating device already applied it).`
   - 801: `// Reflect the star change on other open clients in place (no full refetch).`
   - 1129: `// Reflect the bulk read/unread change on other open clients in place (no full refetch).`

Проверка: `grep -n "user_id\|userId" backend/src/routes/mail.js` показывает только `moveForSpamLabel(messageId, userId, ...)` с `trained_by` и вызовы `moveForSpamLabel(id, req.session.userId, ...)`.

- [ ] **Step 6: Label touch and GTD**

`backend/src/services/labelsRead.js`. В комментарии над `notifyOnLabelTouch`:
- `ask core to broadcast a scoped refresh event to the owning user IFF` → `ask core to broadcast a refresh event to every client IFF`;
- `the plugin never names another user — the broadcast is scoped to \`userId\`.` → `mailboxes are shared, so the event goes to every client.`

Функция:

```js
export async function notifyOnLabelTouch(imapManager, { accountId, messageIds, actedFolders, labelFolders, event }) {
  if (!accountId || !event) return false;
```

и `imapManager.broadcast({ type: event, accountId });`.

`backend/src/plugins/api.js`:
- строка 27: `// "Did an ordinary mail mutation touch one of my labelled threads?" → refresh broadcast.`;
- строки 45–48:

```js
// ── Realtime broadcast ────────────────────────────────────────────────────────
// Push a payload to live sessions: every client for a mailbox event, or one user's sessions when
// a userId is given. The engine itself is never exposed.
export const broadcast = (payload, userId) => getMailEngine().broadcast(payload, userId);
```

`backend/src/plugins/gtd/gtdSections.js`:

```js
export async function emitGtdIfRelevant(imapManager, accountId, messageIds, actedFolders) {
  if (!accountId) return;
```

и в `notifyOnLabelTouch(imapManager, {...})` убрать `userId,`. Если в комментарии над функцией упоминается scoped/user broadcast — заменить на «broadcast to every client».

`backend/src/plugins/gtd/hooks.js`:
- 53, 132, 151, 169, 178: `...broadcast({ type: 'gtd_sections_updated', accountId: account.id });`;
- `onMailMutation`:

```js
export async function onMailMutation({ imapManager, accountId, messageIds, actedFolders }) {
  await emitGtdIfRelevant(imapManager, accountId, messageIds, actedFolders);
}
```

В комментарии над ним `scoped broadcast` → `broadcast`.

`backend/src/plugins/gtd/gtdTransitions.js:158`: `imapManager.broadcast({ type: 'gtd_sections_updated', accountId: account.id });`.

`backend/src/plugins/gtd/gtdGist.js`: `export async function queueGistGeneration({ sections, broadcast } = {}) {`, строка 127: `broadcast({ type: 'gtd_sections_updated', accountId });`.

`backend/src/plugins/gtd/routes.js`:
- 334: `broadcast({ type: 'gtd_sections_updated', accountId: msg.account_id });`;
- 77–81: убрать `userId: req.session.userId,` из `queueGistGeneration({...})`;
- комментарий над `/sections`: `accountId absent => unified across the gtd_enabled mailboxes; present => scoped to that mailbox.` Вызов `getGtdSections({ userId: ..., ... })` не менять.

- [ ] **Step 7: Run the tests**

Run: `bt src/services/pushNotifications.test.js src/services/labelsRead.test.js src/services/imapManager.test.js src/services/imapManager.oauthRefresh.test.js src/services/imapManager.serverMailboxes.test.js src/services/imapManager.authErrors.test.js src/services/folderStatus.test.js src/routes/mail.emptyFolder.test.js src/routes/rules.run.test.js src/plugins`
Expected: PASS. `rules.run.test.js` по-прежнему видит `completion()?.[1] === 'user-1'`.

Проверка: `grep -rn "broadcast(.*user_id\|sendPushToUser" backend/src` — пусто.

- [ ] **Step 8: Commit**

```bash
git add backend/src
git commit -m "feat(events): send mailbox events and new-mail push to every user"
```

### Task 4: Правила и блок-лист в разрезе ящика

**Files:**
- Create: `backend/src/utils/requireMailbox.js`
- Modify: `backend/src/routes/rules.js`, `backend/src/routes/blockList.js` (переписывается целиком), `backend/src/services/inboxRules.js`
- Create tests: `backend/src/routes/rules.mailbox.test.js`, `backend/src/routes/blockList.test.js`
- Modify tests: `backend/src/routes/rules.run.test.js`, `backend/src/services/inboxRules.test.js`

**Interfaces:**
- Consumes: `inbox_rules.account_id NOT NULL`, `inbox_rules.created_by`, `block_list(account_id, email_address)` из Task 1.
- Produces:
  - `requireMailbox(accountId, res) → Promise<string | null>` — id ящика, или `null` после ответа 400 `account_required` / 400 `Invalid account id` / 404;
  - `POST /api/block-list { accountId, emailAddress }` → 201 строка `block_list`;
  - `GET /api/block-list` → все записи с `account_id`;
  - `POST`/`PUT /api/rules` требуют `accountId`;
  - `POST /api/rules/run { accountId? }` — 409, если хоть один из ящиков уже в прогоне; `rules_run_complete` адресован запустившему.

- [ ] **Step 1: Write the failing tests**

`backend/src/routes/rules.mailbox.test.js`:

```js
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-2' }; next(); },
}));
vi.mock('../services/inboxRules.js', () => ({ applyInboxRules: vi.fn(), isDangerousRegex: () => false }));

import express from 'express';
import rulesRoutes from './rules.js';
import { query } from '../services/db.js';

const MAILBOX = 'f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6';
const RULE = {
  name: 'Move invoices',
  conditions: [{ field: 'from', operator: 'contains', value: 'billing@' }],
  actions: [{ type: 'move', value: 'Invoices' }],
};

// Rules are shared by every user and each one applies to exactly one mailbox.
describe('rules belong to one mailbox', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/rules', rulesRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset().mockImplementation(async (sql) => {
      if (sql === 'SELECT id FROM email_accounts WHERE id = $1') return { rows: [{ id: MAILBOX }] };
      if (sql.includes('FROM folders')) return { rows: [{ total: '2', match: '1' }] };
      if (sql.includes('COUNT(*) AS cnt FROM inbox_rules')) return { rows: [{ cnt: '3' }] };
      if (sql.includes('INSERT INTO inbox_rules') || sql.includes('UPDATE inbox_rules')) return { rows: [{ id: 'rule-1' }] };
      return { rows: [] };
    });
  });

  const send = (method, path, body) => fetch(`${base}/api/rules${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('lists the rules of every mailbox', async () => {
    expect((await send('GET', '/')).status).toBe(200);
    expect(query).toHaveBeenCalledWith('SELECT * FROM inbox_rules ORDER BY priority ASC, created_at ASC');
  });

  it('requires a mailbox to create or change a rule', async () => {
    expect(await send('POST', '/', RULE)).toMatchObject({ status: 400, body: { code: 'account_required' } });
    expect(await send('PUT', '/rule-1', RULE)).toMatchObject({ status: 400, body: { code: 'account_required' } });
    expect(query.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql))).toBe(false);
  });

  it('answers 404 for a mailbox that does not exist', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    expect((await send('POST', '/', { ...RULE, accountId: MAILBOX })).status).toBe(404);
  });

  it('stores the mailbox, the author and the move action', async () => {
    expect((await send('POST', '/', { ...RULE, accountId: MAILBOX })).status).toBe(201);
    const [sql, params] = query.mock.calls.find(([s]) => s.includes('INSERT INTO inbox_rules'));
    expect(sql).toMatch(/\(created_by, account_id, name/);
    expect(params.slice(0, 3)).toEqual(['user-2', MAILBOX, 'Move invoices']);
    expect(JSON.parse(params[8])).toEqual([{ type: 'move', value: 'Invoices' }]);
  });

  it('changes and deletes a rule whoever created it', async () => {
    expect((await send('PUT', '/rule-1', { ...RULE, accountId: MAILBOX })).status).toBe(200);
    const [updateSql, updateParams] = query.mock.calls.find(([s]) => s.includes('UPDATE inbox_rules'));
    expect(updateSql).toMatch(/WHERE id = \$8\s+RETURNING \*/);
    expect(updateParams).toHaveLength(8);
    query.mockResolvedValueOnce({ rows: [{ id: 'rule-1' }] });
    expect((await send('DELETE', '/rule-1')).status).toBe(200);
    expect(query).toHaveBeenLastCalledWith('DELETE FROM inbox_rules WHERE id = $1 RETURNING id', ['rule-1']);
  });
});
```

`backend/src/routes/blockList.test.js`:

```js
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-2' }; next(); },
}));

import express from 'express';
import blockListRoutes from './blockList.js';
import { query } from '../services/db.js';

const MAILBOX = 'a7a7a7a7-7777-4777-8777-a7a7a7a7a7a7';
const OTHER = 'b8b8b8b8-8888-4888-8888-b8b8b8b8b8b8';

// Every user sees and edits the block list; each entry blocks a sender for one mailbox.
describe('block list per mailbox', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/block-list', blockListRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset().mockImplementation(async (sql, params = []) => {
      if (sql === 'SELECT id FROM email_accounts WHERE id = $1') return { rows: params[0] === MAILBOX ? [{ id: MAILBOX }] : [] };
      if (sql.includes('INSERT INTO block_list')) return { rows: [{ id: 'entry-1', account_id: params[0], email_address: params[1] }] };
      return { rows: [] };
    });
  });

  const send = (method, path, body) => fetch(`${base}/api/block-list${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('lists the entries of every mailbox', async () => {
    expect((await send('GET', '')).status).toBe(200);
    expect(query).toHaveBeenCalledWith('SELECT * FROM block_list ORDER BY created_at DESC');
  });

  it('requires an existing mailbox', async () => {
    expect(await send('POST', '', { emailAddress: 'spam@example.com' })).toMatchObject({ status: 400, body: { code: 'account_required' } });
    expect((await send('POST', '', { accountId: OTHER, emailAddress: 'spam@example.com' })).status).toBe(404);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  it('blocks a sender for one mailbox', async () => {
    const res = await send('POST', '', { accountId: MAILBOX, emailAddress: ' Spam@Example.com ' });
    expect(res).toMatchObject({ status: 201, body: { account_id: MAILBOX, email_address: 'spam@example.com' } });
    const [sql] = query.mock.calls.find(([s]) => s.includes('INSERT INTO block_list'));
    expect(sql).toMatch(/ON CONFLICT \(account_id, email_address\) DO NOTHING/);
  });

  it('removes an entry whoever added it', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'entry-1' }] });
    expect((await send('DELETE', '/entry-1')).status).toBe(200);
    expect(query).toHaveBeenCalledWith('DELETE FROM block_list WHERE id = $1 RETURNING id', ['entry-1']);
  });
});
```

В `backend/src/services/inboxRules.test.js`:
- импорт: `import { applyInboxRules, applyBlockList } from './inboxRules.js';`;
- `account` (строка 26): `{ id: 'acc-1', folder_mappings: {} }`;
- в `mkRule` (строка 37): `id: 'rule-1', account_id: 'acc-1', enabled: true,`;
- в конец файла:

```js
describe('rules and block list are per mailbox', () => {
  it('loads the enabled rules of the mailbox only', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await applyInboxRules([mkMsg()], account, mockImap);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/WHERE account_id = \$1 AND enabled = true/), ['acc-1']);
  });

  it('reads the block list of the mailbox only', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const remaining = await applyBlockList([mkMsg()], account, mockImap);
    expect(query).toHaveBeenCalledWith('SELECT email_address FROM block_list WHERE account_id = $1', ['acc-1']);
    expect(remaining).toHaveLength(1);
  });
});
```

В `backend/src/routes/rules.run.test.js`:
- `ACCOUNT` (строка 18): `{ id: ACCOUNT_ID }`;
- строка 42: `if (sql === 'SELECT id FROM email_accounts') return Promise.resolve({ rows: [{ id: ACCOUNT_ID }] });`;
- название 409-теста: `rejects a second run while a mailbox is still being swept with 409, then accepts again`;
- название последнего теста: `completes with zero totals and no rule evaluation when the mailbox has no rules`.

Run: `bt src/routes/rules.mailbox.test.js src/routes/blockList.test.js src/routes/rules.run.test.js src/services/inboxRules.test.js`
Expected: FAIL — `account_required` не возвращается, SQL содержит `user_id`.

- [ ] **Step 2: `requireMailbox`**

`backend/src/utils/requireMailbox.js`:

```js
import { query } from '../services/db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rules and block list entries each belong to one mailbox. Returns the mailbox id, or answers
// 400 / 404 itself and returns null when the request names no mailbox or one that does not exist.
export async function requireMailbox(accountId, res) {
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required', code: 'account_required' });
    return null;
  }
  if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
    res.status(400).json({ error: 'Invalid account id' });
    return null;
  }
  const { rows } = await query('SELECT id FROM email_accounts WHERE id = $1', [accountId]);
  if (!rows.length) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  return rows[0].id;
}
```

- [ ] **Step 3: `rules.js`**

Импорт: `import { requireMailbox } from '../utils/requireMailbox.js';`.

`GET /`:

```js
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM inbox_rules ORDER BY priority ASC, created_at ASC');
    res.json(result.rows);
```

`POST /run` целиком до `runRulesSweep` включительно:

```js
router.post('/run', async (req, res) => {
  const imapMgr = req.app.get('imapManager');
  const { accountId } = req.body;

  let accountIds;
  try {
    if (accountId) {
      const mailboxId = await requireMailbox(accountId, res);
      if (!mailboxId) return;
      accountIds = [mailboxId];
    } else {
      const mailboxes = await query('SELECT id FROM email_accounts');
      accountIds = mailboxes.rows.map(r => r.id);
    }
  } catch (err) {
    console.error('POST /rules/run account lookup error:', err.message);
    return res.status(500).json({ error: 'Failed to run rules' });
  }

  // The sweep can take minutes on a large mailbox — well past any proxy
  // timeout, which used to surface as a 504 while the run kept going
  // server-side. Respond immediately and run in the background; the
  // rules_run_complete WebSocket event delivers the result to whoever started
  // it. A mailbox is swept by one run at a time, whoever started it.
  if (accountIds.some(id => runInFlight.has(id))) return res.status(409).json({ error: 'Rules are already running' });
  accountIds.forEach(id => runInFlight.add(id));
  const userId = req.session.userId;
  res.status(202).json({ ok: true, started: true });

  (async () => {
    try {
      const { processed, matched } = await runRulesSweep(accountIds, imapMgr);
      imapMgr?.broadcast?.({ type: 'rules_run_complete', ok: true, processed, matched }, userId);
    } catch (err) {
      console.error('POST /rules/run sweep error:', err.message);
      imapMgr?.broadcast?.({ type: 'rules_run_complete', ok: false }, userId);
    } finally {
      accountIds.forEach(id => runInFlight.delete(id));
    }
  })();
});

// Mailboxes with a background "Run rules on inbox" sweep in flight.
const runInFlight = new Set();

// Applies each mailbox's rules to every INBOX message of the given mailboxes, in
// batches. Per-account failures are logged and skipped so one bad account
// never aborts the rest. Returns the totals for the completion notice.
async function runRulesSweep(accountIds, imapMgr) {
  let processed = 0;
  let matched = 0;

  for (const acctId of accountIds) {
    try {
      const rulesCheck = await query(
        'SELECT COUNT(*) AS cnt FROM inbox_rules WHERE enabled = true AND account_id = $1',
        [acctId]
      );
```

Остальное тело `runRulesSweep` не меняется.

`POST /` целиком:

```js
router.post('/', async (req, res) => {
  const { name, accountId, conditionLogic, conditions, actions, enabled, stopProcessing } = req.body;
  if (!Array.isArray(conditions) || !Array.isArray(actions)) {
    return res.status(400).json({ error: 'conditions and actions must be arrays' });
  }
  const conditionError = validateConditions(conditions);
  if (conditionError) return res.status(400).json({ error: conditionError });
  const normalizedActions = normalizeActions(actions);
  const actionError = validateActions(normalizedActions);
  if (actionError) return res.status(400).json({ error: actionError });
  try {
    const mailboxId = await requireMailbox(accountId, res);
    if (!mailboxId) return;
    const moveAction = normalizedActions.find(a => a.type === 'move' && a.value?.trim());
    if (moveAction) {
      const folderResult = await query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE path = $2) AS match
         FROM folders WHERE account_id = $1`,
        [mailboxId, moveAction.value.trim()]
      );
      const { total, match } = folderResult.rows[0];
      if (parseInt(total) > 0 && parseInt(match) === 0) {
        return res.status(400).json({ error: 'Move destination folder not found for this account' });
      }
    }
    const countResult = await query('SELECT COUNT(*) AS cnt FROM inbox_rules');
    const priority = parseInt(countResult.rows[0].cnt);
    const result = await query(
      `INSERT INTO inbox_rules
         (created_by, account_id, name, enabled, stop_processing, priority, condition_logic, conditions, actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.session.userId,
        mailboxId,
        name || '',
        enabled !== false,
        !!stopProcessing,
        priority,
        conditionLogic === 'OR' ? 'OR' : 'AND',
        JSON.stringify(conditions),
        JSON.stringify(normalizedActions),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /rules error:', err.message);
    res.status(500).json({ error: 'Failed to create rule' });
  }
});
```

`PUT /:id` целиком:

```js
router.put('/:id', async (req, res) => {
  const { name, accountId, conditionLogic, conditions, actions, enabled, stopProcessing } = req.body;
  if (!Array.isArray(conditions) || !Array.isArray(actions)) {
    return res.status(400).json({ error: 'conditions and actions must be arrays' });
  }
  const conditionError = validateConditions(conditions);
  if (conditionError) return res.status(400).json({ error: conditionError });
  const normalizedActions = normalizeActions(actions);
  const actionError = validateActions(normalizedActions);
  if (actionError) return res.status(400).json({ error: actionError });
  try {
    const mailboxId = await requireMailbox(accountId, res);
    if (!mailboxId) return;
    const moveAction = normalizedActions.find(a => a.type === 'move' && a.value?.trim());
    if (moveAction) {
      const folderResult = await query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE path = $2) AS match
         FROM folders WHERE account_id = $1`,
        [mailboxId, moveAction.value.trim()]
      );
      const { total, match } = folderResult.rows[0];
      if (parseInt(total) > 0 && parseInt(match) === 0) {
        return res.status(400).json({ error: 'Move destination folder not found for this account' });
      }
    }
    const result = await query(
      `UPDATE inbox_rules
       SET name = $1, account_id = $2, enabled = $3, stop_processing = $4,
           condition_logic = $5, conditions = $6, actions = $7, updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        name || '',
        mailboxId,
        enabled !== false,
        !!stopProcessing,
        conditionLogic === 'OR' ? 'OR' : 'AND',
        JSON.stringify(conditions),
        JSON.stringify(normalizedActions),
        req.params.id,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /rules/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update rule' });
  }
});
```

`DELETE /:id`:

```js
    const result = await query(
      'DELETE FROM inbox_rules WHERE id = $1 RETURNING id',
      [req.params.id]
    );
```

`PATCH /reorder`:

```js
    // Every id must be an existing rule before anything is renumbered
    const found = await query(
      'SELECT id FROM inbox_rules WHERE id = ANY($1::uuid[])',
      [ids]
    );
    if (found.rows.length !== ids.length) {
```

- [ ] **Step 4: `blockList.js` and `inboxRules.js`**

`backend/src/routes/blockList.js` целиком:

```js
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireMailbox } from '../utils/requireMailbox.js';

const router = Router();
router.use(requireAuth);

// The block list of every mailbox; each entry names the mailbox it applies to.
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM block_list ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /block-list error:', err.message);
    res.status(500).json({ error: 'Failed to load block list' });
  }
});

router.post('/', async (req, res) => {
  const { accountId, emailAddress } = req.body;
  if (!emailAddress || typeof emailAddress !== 'string' || !emailAddress.trim()) {
    return res.status(400).json({ error: 'emailAddress is required' });
  }
  const email = emailAddress.trim().toLowerCase();
  try {
    const mailboxId = await requireMailbox(accountId, res);
    if (!mailboxId) return;
    const result = await query(
      `INSERT INTO block_list (account_id, email_address)
       VALUES ($1, $2)
       ON CONFLICT (account_id, email_address) DO NOTHING
       RETURNING *`,
      [mailboxId, email]
    );
    const row = result.rows[0] ?? (
      await query('SELECT * FROM block_list WHERE account_id = $1 AND email_address = $2', [mailboxId, email])
    ).rows[0];
    res.status(201).json(row);
  } catch (err) {
    console.error('POST /block-list error:', err.message);
    res.status(500).json({ error: 'Failed to add to block list' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM block_list WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /block-list/:id error:', err.message);
    res.status(500).json({ error: 'Failed to remove from block list' });
  }
});

export default router;
```

`backend/src/services/inboxRules.js`:

```js
async function getRulesForAccount(accountId) {
  const result = await query(
    `SELECT * FROM inbox_rules
     WHERE account_id = $1 AND enabled = true
     ORDER BY priority ASC, created_at ASC`,
    [accountId]
  );
  return result.rows;
}
```

Вызов (строка 153): `rules = await getRulesForAccount(account.id);`. В `applyBlockList` (333–336):

```js
    const res = await query(
      'SELECT email_address FROM block_list WHERE account_id = $1',
      [account.id]
    );
```

- [ ] **Step 5: Run the tests**

Run: `bt src/routes/rules.mailbox.test.js src/routes/blockList.test.js src/routes/rules.run.test.js src/routes/rules.test.js src/services/inboxRules.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src
git commit -m "feat(rules): keep rules and the block list per mailbox for everyone"
```

---

### Task 5: Общие контакты без CardDAV

**Files:**
- Create: `backend/src/services/addressBooks.js` (+ `addressBooks.test.js`), `backend/src/routes/contacts.shared.test.js`
- Modify: `backend/src/routes/contacts.js`, `backend/src/routes/send.js` (строки 386–451), `backend/src/services/imapManager.js` (`upsertAutoContacts` и вызов), `backend/src/routes/admin.js`, `backend/src/index.js`, `backend/src/middleware/identityGate.js`, `backend/src/middleware/identityGate.test.js`, `backend/src/routes/admin.users.test.js`, `backend/src/routes/admin.syncSettings.test.js`, `backend/src/utils/vcard.js`, `backend/src/services/safeFetch.js`, `README.md`, `.env.example`, `docs/architecture/codebase-file-map.md`
- Delete: `backend/src/routes/carddav.js`, `backend/src/routes/carddavAccount.js`, `backend/src/services/carddavSync.js`, `backend/src/services/carddavClient.js`, `backend/src/services/carddavClient.test.js`

**Interfaces:**
- Consumes: `address_books.is_default` и индекс одной книги по умолчанию, `contacts` без `user_id`, отсутствие `address_books.source`/`sync_token` из Task 1.
- Produces:
  - `DEFAULT_ADDRESS_BOOK_NAME = 'Contacts'`, `defaultAddressBookId(queryFn = query) → Promise<string>`;
  - `imapManager.upsertAutoContacts(messages)`;
  - ответы `/api/contacts` без поля `read_only`;
  - маршрутов `/carddav`, `/.well-known/carddav`, `/api/carddav` нет.

- [ ] **Step 1: Write the failing tests**

`backend/src/services/addressBooks.test.js`:

```js
import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { defaultAddressBookId } from './addressBooks.js';

describe('defaultAddressBookId', () => {
  it('returns the shared book', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'book-1' }] });
    expect(await defaultAddressBookId(queryFn)).toBe('book-1');
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0]).toBe('SELECT id FROM address_books WHERE is_default');
  });

  it('creates the shared book when it is missing', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({ rows: [] })                  // no shared book
      .mockResolvedValueOnce({ rows: [] })                  // insert (or a concurrent request won)
      .mockResolvedValueOnce({ rows: [{ id: 'book-2' }] }); // read it back
    expect(await defaultAddressBookId(queryFn)).toBe('book-2');
    expect(queryFn.mock.calls[1][0]).toBe('INSERT INTO address_books (name, is_default) VALUES ($1, true) ON CONFLICT DO NOTHING');
    expect(queryFn.mock.calls[1][1]).toEqual(['Contacts']);
  });
});
```

`backend/src/routes/contacts.shared.test.js`:

```js
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-2' }; next(); },
}));
vi.mock('../services/addressBooks.js', () => ({ defaultAddressBookId: vi.fn(async () => 'shared-book') }));

import express from 'express';
import contactRoutes from './contacts.js';
import { query } from '../services/db.js';

// Contacts are one install-wide set kept inside the install; every contact is editable.
describe('contacts are shared', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/contacts', contactRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset().mockImplementation(async (sql) => (
      sql.includes('COUNT(*)')
        ? { rows: [{ count: '0' }] }
        : { rows: [{ id: 'c1', uid: 'u1', address_book_id: 'shared-book', emails: [], phones: [] }] }
    ));
  });

  const send = (method, path, body) => fetch(`${base}/api/contacts${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const noOwnerOrSync = () => query.mock.calls.every(([sql]) => !/user_id|address_books|sync_token|source/.test(sql));

  it('lists every contact', async () => {
    const res = await send('GET', '');
    expect(res.status).toBe(200);
    expect(noOwnerOrSync()).toBe(true);
    expect(query.mock.calls[0][1]).toEqual([50, 0]);
    expect(query.mock.calls[0][0]).not.toMatch(/read_only/);
  });

  it('creates a contact in the shared book', async () => {
    const res = await send('POST', '', { displayName: 'Dana', emails: [{ value: 'Dana@Example.com' }] });
    expect(res.status).toBe(201);
    const [sql, params] = query.mock.calls.find(([s]) => s.includes('INSERT INTO contacts'));
    expect(sql).toMatch(/address_book_id, uid, vcard, etag/);
    expect(params[0]).toBe('shared-book');
    expect(params).toContain('dana@example.com');
    expect(noOwnerOrSync()).toBe(true);
  });

  it('edits a contact whoever created it', async () => {
    const res = await send('PATCH', '/c1', { displayName: 'Dana B' });
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith('SELECT * FROM contacts WHERE id = $1', ['c1']);
    const [, params] = query.mock.calls.find(([s]) => s.includes('UPDATE contacts SET'));
    expect(params).toHaveLength(11);
    expect(params[10]).toBe('c1');
    expect(noOwnerOrSync()).toBe(true);
  });

  it('deletes a contact whoever created it', async () => {
    expect((await send('DELETE', '/c1')).status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('DELETE FROM contacts WHERE id = $1 RETURNING id', ['c1']);
  });
});
```

Run: `bt src/services/addressBooks.test.js src/routes/contacts.shared.test.js`
Expected: FAIL — модуля `addressBooks.js` нет, маршруты читают `user_id`, `address_books.source` и обновляют `sync_token`.

- [ ] **Step 2: `addressBooks.js`**

`backend/src/services/addressBooks.js`:

```js
import { query } from './db.js';

export const DEFAULT_ADDRESS_BOOK_NAME = 'Contacts';

// The shared address book that contacts created by hand, recipients of sent mail and senders
// learned from inbound mail go to. Migration 0056 creates it; if it is ever missing it is
// created again. A concurrent request creating it first hits the single-default index, so
// the insert becomes a no-op and the read below finds that book.
export async function defaultAddressBookId(queryFn = query) {
  const existing = await queryFn('SELECT id FROM address_books WHERE is_default');
  if (existing.rows.length) return existing.rows[0].id;
  await queryFn('INSERT INTO address_books (name, is_default) VALUES ($1, true) ON CONFLICT DO NOTHING', [DEFAULT_ADDRESS_BOOK_NAME]);
  const created = await queryFn('SELECT id FROM address_books WHERE is_default');
  return created.rows[0].id;
}
```

- [ ] **Step 3: `contacts.js`**

`backend/src/routes/contacts.js`:

1. Удалить `defaultAddressBook(userId)` и `bumpSyncToken(addressBookId)` (строки 26–45) и все вызовы `bumpSyncToken` (строки 264, 341, 369). Импорт: `import { defaultAddressBookId } from '../services/addressBooks.js';`.
2. Во всех обработчиках удалить `const userId = req.session.userId;`.
3. `GET /` (строки 49–106):

```js
  const conditions = [];
  const params = [];
  let p = 1;
```

После формирования условий:

```js
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
```

Основной запрос:

```js
    const result = await query(`
      SELECT
        c.id, c.uid, c.display_name, c.first_name, c.last_name,
        c.primary_email, c.emails, c.phones, c.organization,
        c.notes, c.is_auto, c.send_count, c.last_sent,
        c.etag, c.created_at, c.updated_at,
        (c.photo_data IS NOT NULL) AS has_contact_photo
      FROM contacts c
      ${where}
      ORDER BY
        c.is_auto ASC,
        c.send_count DESC,
        lower(coalesce(c.display_name, c.primary_email, '')) ASC
      LIMIT $${p} OFFSET $${p + 1}
    `, [...params, cap, off]);

    const total = await query(
      `SELECT COUNT(*) FROM contacts c ${where}`,
      params
    );
```

4. `GET /photo`:

```js
    const result = await query(
      `SELECT photo_data FROM contacts
       WHERE primary_email = lower($1) AND photo_data IS NOT NULL
       LIMIT 1`,
      [email.trim()]
    );
```

5. `GET /:id`:

```js
    const result = await query(
      `SELECT c.id, c.uid, c.display_name, c.first_name, c.last_name,
              c.primary_email, c.emails, c.phones, c.organization,
              c.notes, c.photo_data, c.is_auto, c.send_count, c.last_sent,
              c.etag, c.vcard, c.created_at, c.updated_at
       FROM contacts c
       WHERE c.id = $1`,
      [req.params.id]
    );
```

6. `POST /`:

```js
    const addressBookId = await defaultAddressBookId();
    const uid = crypto.randomUUID();
    const vcard = generateVCard({ uid, displayName, firstName, lastName, emails, phones, organization, notes });
    const etag = crypto.createHash('md5').update(vcard).digest('hex');

    const result = await query(`
      INSERT INTO contacts (
        address_book_id, uid, vcard, etag,
        display_name, first_name, last_name, primary_email,
        emails, phones, organization, notes, is_auto
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, false)
      RETURNING id, uid, display_name, first_name, last_name,
                primary_email, emails, phones, organization, notes,
                is_auto, send_count, last_sent, etag, created_at, updated_at
    `, [
      addressBookId, uid, vcard, etag,
      displayName || null, firstName || null, lastName || null, primaryEmail,
      JSON.stringify(emails), JSON.stringify(phones),
      organization || null, notes || null,
    ]);

    res.status(201).json(result.rows[0]);
```

7. `PATCH /:id`. Загрузка и проверка (строки 285–296):

```js
    const cur = await query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Contact not found' });
    const c = cur.rows[0];
```

В `UPDATE` условие `WHERE id = $11`, в массиве параметров последний элемент `req.params.id` (без `userId`). После запроса сразу `res.json(result.rows[0]);`.

8. `DELETE /:id` целиком:

```js
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM contacts WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Contact not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact delete error:', err);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});
```

- [ ] **Step 4: Contacts from sent and inbound mail**

`backend/src/routes/send.js`. Импорт `import { defaultAddressBookId } from '../services/addressBooks.js';`. Блок автоконтактов (386–451) целиком:

```js
    // Auto-learn sent recipients so they rank above inbound-only senders in autocomplete.
    // Fire-and-forget — a DB error here must never affect the send response.
    const allRecipients = [...normalizedTo, ...normalizedCc, ...normalizedBcc];
    if (allRecipients.length) {
      const now = new Date();
      setImmediate(async () => {
        try {
          const addressBookId = await defaultAddressBookId();

          const results = await Promise.allSettled(allRecipients.map(addr => {
            const { name, email } = parseAddress(addr);
            if (!email) return Promise.resolve();
            const primaryEmail = email.toLowerCase();
            const displayName = name || primaryEmail;
            const uid    = randomUUID();
            const emails = [{ value: primaryEmail, type: 'other', primary: true }];
            const vcard  = generateVCard({ uid, displayName, emails });
            const etag   = createHash('md5').update(vcard).digest('hex');
            // Upsert by (address book, primary_email) — bump send_count and promote from is_auto.
            // On conflict, preserve an existing vcard; only fill it in if the row had none.
            return query(`
              INSERT INTO contacts (
                address_book_id, uid, vcard, etag,
                display_name, primary_email, emails, is_auto, send_count, last_sent
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, false, 1, $8)
              ON CONFLICT (address_book_id, primary_email) WHERE primary_email IS NOT NULL DO UPDATE
                SET send_count   = contacts.send_count + 1,
                    last_sent    = $8,
                    is_auto      = false,
                    display_name = CASE WHEN contacts.is_auto THEN $5 ELSE contacts.display_name END,
                    vcard        = COALESCE(contacts.vcard, EXCLUDED.vcard),
                    etag         = COALESCE(contacts.etag,  EXCLUDED.etag),
                    updated_at   = NOW()
            `, [addressBookId, uid, vcard, etag, displayName, primaryEmail, JSON.stringify(emails), now]);
          }));

          const failed = results.filter(r => r.status === 'rejected');
          if (failed.length) console.warn('Contact upsert errors:', failed.map(r => r.reason?.message));
        } catch (err) {
          console.warn('Contact upsert setup error:', err.message);
        }
      });
    }
```

`backend/src/services/imapManager.js`. Импорт `import { defaultAddressBookId } from './addressBooks.js';`. Вызов на строке 3869: `this.upsertAutoContacts(inboundSenders)`. Метод целиком:

```js
  // Insert auto-discovered contacts for inbound senders that don't already have a contact record
  // in the shared address book. Existing contacts (manual or sent-to) are never modified;
  // is_auto=true entries are never downgraded by this path.
  async upsertAutoContacts(messages) {
    try {
      const addressBookId = await defaultAddressBookId();

      await Promise.allSettled(
        messages
          .filter(msg => msg.fromEmail)
          .map(msg => {
            const primaryEmail = msg.fromEmail.toLowerCase();
            const displayName  = (msg.fromName || '').trim() || primaryEmail;
            const uid          = randomUUID();
            const emails       = JSON.stringify([{ value: primaryEmail, type: 'other', primary: true }]);
            const vcard        = generateVCard({ uid, displayName, emails: [{ value: primaryEmail, type: 'other', primary: true }] });
            return query(`
              INSERT INTO contacts (
                address_book_id, uid, vcard, etag,
                display_name, primary_email, emails, is_auto
              )
              VALUES ($1, $2, $3, md5($3), $4, $5, $6::jsonb, true)
              ON CONFLICT (address_book_id, primary_email) WHERE primary_email IS NOT NULL DO NOTHING
            `, [addressBookId, uid, vcard, displayName, primaryEmail, emails]);
          })
      );
    } catch (err) {
      console.warn('upsertAutoContacts error:', err.message);
    }
  }
```

- [ ] **Step 5: Remove CardDAV**

```bash
git rm backend/src/routes/carddav.js backend/src/routes/carddavAccount.js backend/src/services/carddavSync.js backend/src/services/carddavClient.js backend/src/services/carddavClient.test.js
```

`backend/src/index.js`:
- удалить импорты `carddavRouter`, `carddavAccountRouter`, `startCardavScheduler` (строки 35–37);
- строка 164: `app.use(['/api', '/oauth', '/auth/oidc'], identityGate);`;
- комментарий CSRF (строки 170–172) заканчивается так:

```js
// this closes same-site/subdomain and legacy-browser gaps. OAuth flows (/oauth) are
// mounted outside /api and use their own auth, so they are intentionally not gated here.
```

- удалить `app.use('/api/carddav', carddavAccountRouter);` (строка 217);
- удалить блок сервера CardDAV с комментариями (строки 233–236);
- комментарий бэкфилла фотографий (строки 262–263):

```js
// One-time backfill: populate photo_data from the stored vcard for contacts saved
// before photo_data was persisted.
```

- удалить `startCardavScheduler();` с комментарием (строки 293–294).

`backend/src/middleware/identityGate.js`: из `LOCAL_ONLY_PREFIXES` убрать `'/carddav', '/.well-known/carddav'`; последняя строка массива — `'/api/admin/invites', '/api/admin/oidc',`.

`backend/src/middleware/identityGate.test.js`:
- строка 41: `app.use(['/api', '/oauth', '/auth/oidc'], createIdentityGate({`;
- строка 75: `'/api/admin/users/11111111-1111-1111-1111-111111111111/totp/disable',`;
- строка 93: `for (const path of ['/api/auth/login', '/auth/oidc/corp/start']) {`.

`backend/src/routes/admin.js`: удалить `import { stopCardavUser } from '../services/carddavSync.js';` и вызов `stopCardavUser(id);` в `DELETE /users/:id`. В `admin.users.test.js` и `admin.syncSettings.test.js` удалить строку `vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));`.

Комментарии:
- `backend/src/utils/vcard.js`, строка 2: `// Used by the contacts REST API.`;
- `backend/src/services/safeFetch.js`, строка 14: `// (one-click unsubscribe, category list sources). Admin-configured`.

Документы:
- `README.md`: строка 40 — `real manual/CardDAV contact photos` → `saved contact photos`; удалить строку 71 (пункт **CardDAV**);
- `.env.example`, строка 87: `# OIDC, registration, invites and password reset are off.`;
- `docs/architecture/codebase-file-map.md`: удалить строки таблицы `routes/carddav.js` и `routes/carddavAccount.js`; `Контакты и CardDAV-derived data` → `Контакты`. Строку истории миграций `0019–0029` не трогать.

- [ ] **Step 6: Run the tests**

Run: `bt src/services/addressBooks.test.js src/routes/contacts.shared.test.js src/middleware/identityGate.test.js src/routes/admin.users.test.js src/routes/admin.syncSettings.test.js src/services/imapManager.test.js src/routes/send.forwarded.test.js src/routes/send.reliability.test.js src/routes/send.signature.test.js`
Expected: PASS.

Если какой-то тест `send.*` или `imapManager.test.js` проверяет вставку контакта с `user_id` или обновление `sync_token` — поправить ожидание на новую форму запроса.

Проверки:
- `grep -rni "carddav\|cardav\|sync_token" backend/src README.md .env.example` — пусто;
- `grep -ni carddav docs/architecture/codebase-file-map.md` — только строка истории миграций `0019–0029`;
- `grep -n "user_id" backend/src/routes/contacts.js` — пусто; в `imapManager.js` остаются только места Task 6.

- [ ] **Step 7: Commit**

```bash
git add -A backend/src README.md .env.example docs/architecture/codebase-file-map.md
git commit -m "feat(contacts): share contacts across the install and remove CardDAV"
```

---

### Task 6: Общая категоризация

**Files:**
- Modify: `backend/src/services/categorizer.js`, `backend/src/routes/categories.js`, `backend/src/services/imapManager.js` (строки 3512–3514, 4180–4182), `backend/src/routes/auth.js`, `backend/src/routes/admin.js`
- Create: `backend/src/routes/admin.categorization.test.js`
- Modify tests: `services/categorizer.test.js`, `routes/auth.preferences.test.js`, `routes/auth.config.test.js`, `routes/auth.sessions.test.js`, `routes/admin.syncSettings.test.js`, `routes/admin.users.test.js`

**Interfaces:**
- Consumes: `category_list_sources` без `user_id`, ключ `categorization_enabled` из Task 1.
- Produces:
  - `getGlobalCategorizationEnabled() → Promise<boolean>`, `invalidateGlobalCategorizationCache()`;
  - `loadSocialDomains() → Promise<Set<string>>`, `invalidateSocialDomainCache()`;
  - `backfillCategories(accountId)`, `categorizeAndStore(messageId, parsedHeaders, fromEmail)`;
  - `PATCH /api/admin/settings { categorization_enabled: boolean }`, иначе 400 `invalid_field`;
  - `GET /api/auth/preferences` → `categorizationEnabled` из системной настройки;
  - `PATCH /api/auth/preferences` — 39 параметров, без `categorizationEnabled`.

- [ ] **Step 1: Write the failing tests**

В `backend/src/services/categorizer.test.js`:
- импорт: `import { aiClassifyMessage, backfillCategories, getGlobalCategorizationEnabled, invalidateGlobalCategorizationCache, loadSocialDomains, invalidateSocialDomainCache } from './categorizer.js';`;
- во всех вызовах `backfillCategories('acct-1', 'user-1')` убрать второй аргумент;
- в конец файла:

```js
describe('install-wide categorization', () => {
  it('reads the system switch once per cache window', async () => {
    invalidateGlobalCategorizationCache();
    query.mockResolvedValueOnce({ rows: [{ value: 'true' }] });
    expect(await getGlobalCategorizationEnabled()).toBe(true);
    expect(await getGlobalCategorizationEnabled()).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("key = 'categorization_enabled'");

    invalidateGlobalCategorizationCache();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getGlobalCategorizationEnabled()).toBe(false);
  });

  it('builds one social domain set from every enabled source', async () => {
    invalidateSocialDomainCache();
    query.mockResolvedValueOnce({ rows: [{ source_type: 'manual', value: 'Example.com', resolved_domains: null }] });
    expect(await loadSocialDomains()).toEqual(new Set(['example.com']));
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('user_id');
    expect(params).toBeUndefined();
  });
});
```

`backend/src/routes/admin.categorization.test.js`. Моки и сервер как в `admin.syncSettings.test.js`, плюс мок категоризатора:

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
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));

import express from 'express';
import adminRoutes from './admin.js';
import { query } from '../services/db.js';
import { invalidateGlobalCategorizationCache } from '../services/categorizer.js';

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
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const stored = new Map();
beforeEach(() => {
  stored.clear();
  query.mockReset();
  invalidateGlobalCategorizationCache.mockClear();
  query.mockImplementation(async (sql, params = []) => {
    if (/INSERT INTO system_settings \(key, value, updated_at\) VALUES \(\$1, \$2, NOW\(\)\)/.test(sql)) {
      stored.set(params[0], params[1]);
    }
    return { rows: [] };
  });
});

const patch = (body) => fetch(`${base}/api/admin/settings`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

describe('PATCH /api/admin/settings categorization', () => {
  it('switches categorization for the whole install', async () => {
    expect(await patch({ categorization_enabled: true })).toEqual({ status: 200, body: { ok: true } });
    expect(Object.fromEntries(stored)).toEqual({ categorization_enabled: 'true' });
    expect(invalidateGlobalCategorizationCache).toHaveBeenCalledTimes(1);
  });

  it('rejects anything but a boolean before writing', async () => {
    expect(await patch({ categorization_enabled: 'yes', registration_open: true })).toMatchObject({ status: 400, body: { code: 'invalid_field' } });
    expect(stored.size).toBe(0);
    expect(invalidateGlobalCategorizationCache).not.toHaveBeenCalled();
  });
});
```

`backend/src/routes/auth.preferences.test.js`:
- мок категоризатора (строки 23–25): `vi.mock('../services/categorizer.js', () => ({ getGlobalCategorizationEnabled: vi.fn(async () => true) }));`;
- `folderOrder`: `$37` → `$36`, `params[36]` → `params[35]`;
- `senderFavicons`: `$38` → `$37`, `params[37]` → `params[36]`;
- `defaultSender`: `$40` → `$39`, `params[39]` → `params[38]` (строки 108, 109, 115, 122, 127);
- строка 147: `toHaveLength(39)`;
- строка 159: `toHaveBeenCalledWith({ theme: 'dark', syncInterval: 120, categorizationEnabled: true })`;
- в `describe('sync intervals are install-wide')` добавить тест:

```js
  it('PATCH ignores the old per-user categorization switch', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await patchPreferences({ session: { userId: 'user-1' }, body: { categorizationEnabled: true } }, res);
    expect(query.mock.calls[0][0]).not.toContain('categorizationEnabled');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
```

`routes/auth.config.test.js:14` и `routes/auth.sessions.test.js:25–27`: мок → `({ getGlobalCategorizationEnabled: vi.fn(async () => false) })`.
`routes/admin.syncSettings.test.js` и `routes/admin.users.test.js`: добавить `vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));` рядом с остальными моками.

Run: `bt src/services/categorizer.test.js src/routes/admin.categorization.test.js src/routes/auth.preferences.test.js`
Expected: FAIL — нет системного переключателя, 40 параметров, `categorization_enabled` не обрабатывается.

- [ ] **Step 2: `categorizer.js`**

Верх файла до `SHIPPING_DOMAINS`:

```js
import { query } from './db.js';
import { completeText } from './aiProvider.js';
import { detectCategoryFromHeaders } from './messageParser.js';

// Social domains and the categorization switch are install-wide. Both are cached briefly and
// dropped when someone changes category_list_sources or an admin flips the switch.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let socialDomainCache = null;         // { domains: Set<string>, expiry: number }
let globalCategorizationCache = null; // { value: boolean, expiry: number }

export function invalidateSocialDomainCache() {
  socialDomainCache = null;
}

export async function getGlobalCategorizationEnabled() {
  if (globalCategorizationCache && globalCategorizationCache.expiry > Date.now()) return globalCategorizationCache.value;
  const result = await query("SELECT value FROM system_settings WHERE key = 'categorization_enabled'");
  const value = result.rows[0]?.value === 'true';
  globalCategorizationCache = { value, expiry: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidateGlobalCategorizationCache() {
  globalCategorizationCache = null;
}
```

`loadSocialDomains`:

```js
async function loadSocialDomains() {
  if (socialDomainCache && socialDomainCache.expiry > Date.now()) return socialDomainCache.domains;

  const result = await query(
    `SELECT source_type, value, resolved_domains
     FROM category_list_sources
     WHERE enabled = true`
  );
```

В конце функции: `socialDomainCache = { domains, expiry: Date.now() + CACHE_TTL_MS };`. Остальное тело прежнее.

Остальные функции:
- комментарий `the user's social domain set` → `the install's social domain set`;
- `export async function categorizeAndStore(messageId, parsedHeaders, fromEmail) {` → `const socialDomains = await loadSocialDomains();`;
- `export async function backfillCategories(accountId) {` → `const socialDomains = await loadSocialDomains();`.

`backend/src/services/imapManager.js`, в обоих местах (3512–3514 и 4180–4182):

```js
            if (account.categorization_enabled || await getGlobalCategorizationEnabled()) {
              try {
                const socialDomains = await loadSocialDomains();
```

(во втором месте отступы на 8 пробелов больше).

- [ ] **Step 3: `categories.js`**

- `GET /categories/sources`:

```js
  const result = await query(
    `SELECT id, source_type, value, label, enabled,
            array_length(resolved_domains, 1) AS domain_count,
            last_fetched_at, fetch_ok, fetch_error, created_at
     FROM category_list_sources
     ORDER BY source_type, created_at`
  );
```

- `POST /categories/sources`:

```js
    const result = await query(
      `INSERT INTO category_list_sources (source_type, value, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (source_type, value) DO UPDATE SET enabled = true
       RETURNING id, source_type, value, label, enabled, last_fetched_at, fetch_ok, fetch_error, created_at`,
      [sourceType, trimmedValue, label?.trim() || null]
    );
```

- все вызовы `invalidateSocialDomainCache(req.session.userId)` → `invalidateSocialDomainCache()`;
- `PATCH /categories/sources/:id`: `WHERE id = $2`, параметры `[enabled, req.params.id]`;
- `DELETE`: `'DELETE FROM category_list_sources WHERE id = $1 RETURNING id', [req.params.id]`;
- `refresh`: `'SELECT id, source_type, value FROM category_list_sources WHERE id = $1', [req.params.id]`;
- `recategorize` целиком:

```js
router.post('/categories/recategorize/:accountId', requireAuth, async (req, res) => {
  const check = await query(
    'SELECT id, categorization_enabled FROM email_accounts WHERE id = $1',
    [req.params.accountId]
  );
  const mailbox = check.rows[0];
  if (!mailbox || !(mailbox.categorization_enabled || await getGlobalCategorizationEnabled())) {
    return res.status(404).json({ error: 'Account not found or categorization not enabled' });
  }

  // Run in background — large inboxes can take a while
  const accountId = req.params.accountId;
  (async () => {
    try {
      const processed = await backfillCategories(accountId);
      console.log(`Re-categorization complete: ${processed} messages for account ${accountId}`);
    } catch (err) {
      console.error(`Re-categorization error for account ${accountId}:`, err.message);
    }
  })();

  res.status(202).json({ ok: true });
});
```

- импорт дополнить `getGlobalCategorizationEnabled`;
- `ai-classify`:

```js
  const msgResult = await query(`
    SELECT m.subject, m.from_email, m.snippet
    FROM messages m
    WHERE m.id = $1 AND m.is_deleted = false
  `, [messageId]);
```

```js
  await query(
    'UPDATE messages SET category = $1 WHERE id = $2',
    [category === 'primary' ? null : category, messageId]
  );
```

- [ ] **Step 4: Preferences and admin settings**

`backend/src/routes/auth.js`:
- импорт: `import { getGlobalCategorizationEnabled } from '../services/categorizer.js';`;
- `getPreferences`:

```js
  const [userResult, cssResult, syncSettings, categorizationEnabled] = await Promise.all([
    query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]),
    query("SELECT value FROM system_settings WHERE key = 'custom_css'"),
    loadSyncSettings(),
    getGlobalCategorizationEnabled(),
  ]);
```

и после `prefs.syncInterval = ...`:

```js
  // Install-wide and read-only here too: admins switch categorization through PATCH /api/admin/settings.
  prefs.categorizationEnabled = categorizationEnabled;
```

- `patchPreferences`:
  - из деструктуризации `req.body` убрать `categorizationEnabled, `;
  - строку SQL `|| CASE WHEN $26::boolean ... 'categorizationEnabled' ...` удалить;
  - номера `$27`…`$40` в следующих строках уменьшить на один (`markReadBehavior` → `$26`, …, `defaultSender` → `$39`);
  - из массива параметров убрать `categorizationEnabled ?? null, `;
  - удалить блок `if (categorizationEnabled != null) { invalidateGlobalCategorizationCache(...); }`.

Проверка номеров: `grep -o '\$[0-9]\+::' backend/src/routes/auth.js | sort -t'$' -k2 -n | uniq | tail -3` в пределах `patchPreferences` даёт `$39` последним; в массиве 39 элементов.

`backend/src/routes/admin.js`:
- импорт: `import { invalidateGlobalCategorizationCache } from '../services/categorizer.js';`;
- в деструктуризации `PATCH /settings` добавить `categorization_enabled`;
- после проверки `folder_sync_interval_sec` (до первой записи):

```js
  if (categorization_enabled !== undefined && typeof categorization_enabled !== 'boolean') {
    return res.status(400).json({ error: 'categorization_enabled must be a boolean', code: 'invalid_field' });
  }
```

- перед `invalidateConnectionPolicyCache();`:

```js
  if (typeof categorization_enabled === 'boolean') {
    await query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      ['categorization_enabled', categorization_enabled ? 'true' : 'false']
    );
    invalidateGlobalCategorizationCache();
    console.log(`[admin] ${req.session.userId} set categorization_enabled=${categorization_enabled}`);
  }
```

- [ ] **Step 5: Run the tests**

Run: `bt src/services/categorizer.test.js src/routes/admin.categorization.test.js src/routes/admin.syncSettings.test.js src/routes/admin.users.test.js src/routes/auth.preferences.test.js src/routes/auth.config.test.js src/routes/auth.sessions.test.js src/services/imapManager.test.js`
Expected: PASS.

Проверка: `grep -rn "user_id\|userId" backend/src/services/categorizer.js backend/src/routes/categories.js` — пусто; `grep -n "user_id" backend/src/services/imapManager.js` — пусто.

- [ ] **Step 6: Commit**

```bash
git add backend/src
git commit -m "feat(categories): make categorization sources and its switch install-wide"
```

---

### Task 7: Фронтенд: правила и блок-лист с ящиком, переключатель категоризации, без CardDAV

**Files:**
- Create: `frontend/src/utils/accountLabel.js` (+ `accountLabel.test.js`)
- Modify: `frontend/src/utils/api.js`, `frontend/src/store/index.js`, `frontend/src/components/AdminPanel.jsx`, `frontend/src/components/ContactsPage.jsx`, `frontend/src/components/MessageList.jsx`, `frontend/src/components/MessagePane.jsx`, `frontend/src/hooks/useGtdTriage.js`, `frontend/src/locales/*.json`, `frontend/src/locales/i18n.test.js`
- Scratch, не коммитится: `<scratchpad>/pr3-locales.mjs`

**Interfaces:**
- Consumes: `POST /api/block-list { accountId, emailAddress }`, `POST/PUT /api/rules` с обязательным `accountId`, `PATCH /api/admin/settings { categorization_enabled }`, `GET /api/auth/preferences → categorizationEnabled`, контакты без `read_only`, маршрутов `/api/carddav` нет (Task 5).
- Produces:
  - `accountLabel(accounts, accountId) → string`;
  - `api.addToBlockList(accountId, email)`;
  - `rulesPreFill` получает поле `accountId`;
  - новые ключи локалей `common.adminOnly`, `admin.rules.errorAccount`;
  - удалённые ключи `admin.rules.accountAll`, `admin.rules.actionMoveRequiresAccount`, объект `admin.integrations.carddav`, `contacts.carddavBadge`;
  - новый текст `admin.security.allowPrivateHostsDesc` без упоминания CardDAV;
  - `api.carddav` и компонента `CardDavCard` нет.

- [ ] **Step 1: Write the failing helper test**

`frontend/src/utils/accountLabel.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountLabel } from './accountLabel.js';

describe('accountLabel', () => {
  const accounts = [
    { id: 'a', name: 'Sales', email_address: 'sales@example.com' },
    { id: 'b', name: '', email_address: 'help@example.com' },
  ];

  it('names an account by its display name, then its address', () => {
    assert.equal(accountLabel(accounts, 'a'), 'Sales');
    assert.equal(accountLabel(accounts, 'b'), 'help@example.com');
  });

  it('is empty for an unknown account', () => {
    assert.equal(accountLabel(accounts, 'missing'), '');
    assert.equal(accountLabel(undefined, 'a'), '');
  });
});
```

Run: `cd frontend && node --test src/utils/accountLabel.test.js`
Expected: FAIL — модуля нет.

- [ ] **Step 2: Helper and API**

`frontend/src/utils/accountLabel.js`:

```js
// How an account is named in lists that show several accounts' items (rules, block list).
export function accountLabel(accounts, accountId) {
  const account = (accounts || []).find((a) => a.id === accountId);
  return account ? (account.name || account.email_address || '') : '';
}
```

`frontend/src/utils/api.js`, блок Block List:

```js
  // Block List — each entry blocks a sender for one account
  getBlockList:          ()                 => request('GET',    '/block-list'),
  addToBlockList:        (accountId, email) => request('POST',   '/block-list', { accountId, emailAddress: email }),
  removeFromBlockList:   (id)               => request('DELETE', `/block-list/${id}`),
```

Run: `cd frontend && node --test src/utils/accountLabel.test.js`
Expected: PASS.

- [ ] **Step 3: Rule and block actions from a message name its account**

`frontend/src/components/MessageList.jsx` (2231–2249) и `frontend/src/components/MessagePane.jsx` (1766–1782):

```js
        store.setRulesPreFill({ accountId: message.account_id, fromEmail: message.from_email, fromName: message.from_name });
```

(в `MessagePane` — `store.setRulesPreFill?.(...)` с тем же объектом) и

```js
        api.addToBlockList(message.account_id, email).then(() => {
```

`frontend/src/hooks/useGtdTriage.js` (239–251):

```js
        store.setRulesPreFill({ accountId: thread.account_id, fromEmail: thread.from_email, fromName: thread.from_name });
```

```js
          api.addToBlockList(thread.account_id, thread.from_email)
```

`frontend/src/store/index.js`, строка 540: комментарий `// { accountId, fromEmail, fromName } — transient, set by context menu`.

- [ ] **Step 4: RulesTab**

`frontend/src/components/AdminPanel.jsx`. Импорт после `folderParentLabel`: `import { accountLabel } from '../utils/accountLabel.js';`.

В `RulesTab`:

1. `blankForm` (5693–5707):

```js
  function blankForm(prefill = {}) {
    return {
      name: prefill.name || '',
      // A rule applies to one account: the one the message came from, or the first one.
      accountId: prefill.accountId || accounts[0]?.id || '',
```

2. `openEdit` (5716–5739): у `actions` убрать хвост `.filter(a => !(a.type === 'move' && !rule.account_id))`; `accountId: rule.account_id,`.
3. `handleToggle` (5753): `accountId: rule.account_id,`.
4. `handleSave`. После проверки `errorRequired`:

```js
    if (!accountId) {
      setFormError(t('admin.rules.errorAccount'));
      return;
    }
```

В `payload` — `accountId,`.

5. Поле аккаунта (5939–5959):

```jsx
        <Field label={t('admin.rules.accountLabel')} required>
          <select
            style={inputStyle}
            value={fd.accountId}
            // A move destination belongs to one account, so switching accounts clears it.
            onChange={e => setFormData(p => ({
              ...p,
              accountId: e.target.value,
              actions: p.actions.map(a => a.type === 'move' ? { ...a, value: '' } : a),
            }))}
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.name || a.email_address}</option>
            ))}
          </select>
        </Field>
```

6. Список действий (6069–6083):
   - удалить `const moveDisabled = type === 'move' && !fd.accountId;`;
   - `label` — `style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}`;
   - `input` — без `disabled`;
   - удалить блок `{moveDisabled && (...)}` с `actionMoveRequiresAccount`;
   - строка 6085: `const allFolders = storeFolders[fd.accountId] || [];`.
7. Строка правила в списке (6286–6288):

```jsx
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {accountLabel(accounts, rule.account_id)} · {conditionSummary(rule)} → {actionSummary(rule)}
                  </div>
```

- [ ] **Step 5: BlockListTab**

`BlockListTab` (6314–6391):

1. Начало:

```jsx
function BlockListTab() {
  const { t } = useTranslation();
  const { accounts } = useStore();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [accountId, setAccountId] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  // An entry blocks a sender for one account; until one is picked, the first account.
  const selectedAccountId = accountId || accounts[0]?.id || '';
```

2. `handleAdd`:

```js
  async function handleAdd(e) {
    e.preventDefault();
    const email = newEmail.trim();
    if (!email || !selectedAccountId) return;
    setAdding(true);
    setError('');
    try {
      const entry = await api.addToBlockList(selectedAccountId, email);
```

Дальше как было.

3. Форма:

```jsx
      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <select
          style={{ ...inputStyle, flex: '0 1 220px' }}
          aria-label={t('admin.rules.accountLabel')}
          value={selectedAccountId}
          onChange={e => setAccountId(e.target.value)}
        >
          {accounts.map(a => (
            <option key={a.id} value={a.id}>{a.name || a.email_address}</option>
          ))}
        </select>
        <input
          style={{ ...inputStyle, flex: 1, minWidth: 180 }}
          type="email"
          value={newEmail}
          onChange={e => setNewEmail(e.target.value)}
          placeholder={t('admin.blockList.emailPlaceholder')}
        />
        <button
          type="submit"
          disabled={adding || !newEmail.trim() || !selectedAccountId}
```

Стиль кнопки прежний.

4. Строка записи — после `<span ...>{entry.email_address}</span>`:

```jsx
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>{accountLabel(accounts, entry.account_id)}</span>
```

- [ ] **Step 6: Install-wide switches**

`frontend/src/store/index.js` (707–711):

```js
  categorizationEnabled: false,
  // Install-wide: only an admin can switch it, so a refused change reverts the toggle.
  setCategorizationEnabled: (val) => {
    const previous = get().categorizationEnabled;
    set({ categorizationEnabled: val });
    api.admin.updateSettings({ categorization_enabled: val })
      .catch(() => set({ categorizationEnabled: previous }));
  },
```

`CategoriesSection` в `AdminPanel.jsx`:
- `const { accounts, categorizationEnabled, setCategorizationEnabled, user } = useStore();` и `const isAdmin = !!user?.isAdmin;`;
- кнопка переключателя (4213–4226):

```jsx
        <button
          type="button"
          disabled={!isAdmin}
          onClick={() => isAdmin && setCategorizationEnabled(!categorizationEnabled)}
          style={{
            width: 36, height: 20, borderRadius: 10, border: 'none', cursor: isAdmin ? 'pointer' : 'not-allowed', padding: 0,
            background: categorizationEnabled ? 'var(--accent)' : TOGGLE_OFF_BACKGROUND,
            position: 'relative', transition: 'background 0.2s', flexShrink: 0, marginTop: 1,
            opacity: isAdmin ? 1 : 0.5,
          }}
        >
```

- под `globalEnabledDesc`:

```jsx
          {!isAdmin && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{t('common.adminOnly')}</div>
          )}
```

Удаление CardDAV из интерфейса (после правки `CategoriesSection`: строки ниже указаны по `main` и расположены выше неё):
- `AdminPanel.jsx`: удалить комментарий `// CardDAV contact sync (e.g. Nextcloud). One-way, read-only pull.` и функцию `CardDavCard` целиком (строки 2128–2270, до пустой строки перед `function IntegrationsTab()`); заголовок `// ─── Integrations Tab ───` остаётся. В `IntegrationsTab` удалить `<CardDavCard />` и пустую строку перед ним (строка 2936). Если после этого `npm run lint` сообщает о неиспользуемом импорте или переменной — удалить именно их.
- `utils/api.js`: удалить блок `// CardDAV contact sync (Nextcloud etc.)` и объект `carddav: { ... },` (строки 336–343) вместе с пустой строкой после него.
- `ContactsPage.jsx`, `ContactDetail`:
  - `{!c.read_only && (` (строка 565) → блок кнопок без условия: строки `{!c.read_only && (` и соответствующая `)}` удаляются, `<div style={{ position: 'absolute', ... }}>` остаётся;
  - строка 571: `paddingRight: c.read_only ? 0 : 128` → `paddingRight: 128`;
  - удалить комментарий про значок CardDAV и блок `{c.read_only && (<span ...>{t('contacts.carddavBadge')}</span>)}` (строки 585–591);
  - комментарий на строке 564: `{/* Edit/Delete — out of flow, top-right (fixed width). */}`.
- `locales/i18n.test.js`: удалить строки исключений `'admin.integrations.carddav.serverPh': 'any',` и `'admin.integrations.carddav.title': [['cs', 'pl']],`.

Проверка (после Step 7): `grep -rni "carddav\|read_only" frontend/src` — пусто.

- [ ] **Step 7: Locales**

`<scratchpad>/pr3-locales.mjs`:

```js
// usage: node pr3-locales.mjs <frontend/src/locales>
import { readFileSync, writeFileSync } from 'node:fs';

const dir = process.argv[2];
const LOCALES = ['en', 'ru', 'de', 'es', 'fr', 'it', 'pl', 'cs', 'zhCN'];
const ADD = [
  ['common.loadMore', 'adminOnly', {
    en: 'Only an administrator can change this.',
    ru: 'Изменить это может только администратор.',
    de: 'Nur ein Administrator kann das ändern.',
    es: 'Solo un administrador puede cambiar esto.',
    fr: 'Seul un administrateur peut modifier ce réglage.',
    it: 'Solo un amministratore può modificarlo.',
    pl: 'Tylko administrator może to zmienić.',
    cs: 'Změnit to může pouze správce.',
    zhCN: '只有管理员可以更改此项。',
  }],
  ['admin.rules.errorRequired', 'errorAccount', {
    en: 'Choose an account for this rule.',
    ru: 'Выберите аккаунт для правила.',
    de: 'Wählen Sie ein Konto für diese Regel.',
    es: 'Elige una cuenta para esta regla.',
    fr: 'Choisissez un compte pour cette règle.',
    it: 'Scegli un account per questa regola.',
    pl: 'Wybierz konto dla tej reguły.',
    cs: 'Vyberte účet pro toto pravidlo.',
    zhCN: '请为此规则选择账户。',
  }],
];
const REMOVE = [
  'admin.rules.accountAll', 'admin.rules.actionMoveRequiresAccount',
  'admin.integrations.carddav', 'contacts.carddavBadge',
];
const SET = [
  ['admin.security.allowPrivateHostsDesc', {
    en: 'Permits connecting to IMAP/SMTP mail servers and AI providers at private or local addresses (e.g. 127.0.0.1, 192.168.x.x). Required for protonmail-bridge or a local AI model.',
    ru: 'Разрешает подключение к почтовым серверам IMAP/SMTP и провайдерам ИИ по частным или локальным адресам (например, 127.0.0.1, 192.168.x.x). Требуется для protonmail-bridge или локальной модели ИИ.',
    de: 'Ermöglicht Verbindungen zu IMAP-/SMTP-Mailservern und KI-Anbietern unter privaten oder lokalen Adressen (z.B. 127.0.0.1, 192.168.x.x). Erforderlich für protonmail-bridge oder ein lokales KI-Modell.',
    es: 'Permite conectarse a servidores de correo IMAP/SMTP y proveedores de IA en direcciones privadas o locales (p. ej. 127.0.0.1, 192.168.x.x). Necesario para protonmail-bridge o un modelo de IA local.',
    fr: "Permet de se connecter aux serveurs de messagerie IMAP/SMTP et aux fournisseurs d'IA sur des adresses privées ou locales (p. ex. 127.0.0.1, 192.168.x.x). Nécessaire pour protonmail-bridge ou un modèle d'IA local.",
    it: 'Consente di connettersi a server di posta IMAP/SMTP e provider IA a indirizzi privati o locali (es. 127.0.0.1, 192.168.x.x). Necessario per protonmail-bridge o un modello IA locale.',
    pl: 'Zezwala na łączenie się z serwerami poczty IMAP/SMTP i dostawcami AI pod prywatnymi lub lokalnymi adresami (np. 127.0.0.1, 192.168.x.x). Wymagane dla protonmail-bridge lub lokalnego modelu AI.',
    cs: 'Umožňuje připojení k poštovním serverům IMAP/SMTP a poskytovatelům AI na soukromých nebo místních adresách (např. 127.0.0.1, 192.168.x.x). Je vyžadováno pro protonmail-bridge nebo místní model AI.',
    zhCN: '允许连接到私有或本地地址的 IMAP/SMTP 邮件服务器和 AI 提供商（例如 127.0.0.1、192.168.x.x）。protonmail-bridge 或本地 AI 模型需要此选项。',
  }],
];
const nodeAt = (obj, path) => path.reduce((node, key) => node[key], obj);

for (const loc of LOCALES) {
  const file = `${dir}/${loc}.json`;
  const raw = readFileSync(file, 'utf8');
  const obj = JSON.parse(raw);
  for (const [dotted, values] of SET) {
    const path = dotted.split('.');
    const leaf = path.pop();
    const parent = nodeAt(obj, path);
    if (!(leaf in parent)) throw new Error(`${loc}: missing ${dotted}`);
    parent[leaf] = values[loc];
  }
  for (const dotted of REMOVE) {
    const path = dotted.split('.');
    const leaf = path.pop();
    const parent = nodeAt(obj, path);
    if (!(leaf in parent)) throw new Error(`${loc}: missing ${dotted}`);
    delete parent[leaf];
  }
  for (const [afterKey, name, values] of ADD) {
    const path = afterKey.split('.');
    const after = path.pop();
    const parent = nodeAt(obj, path);
    if (!(after in parent)) throw new Error(`${loc}: missing ${afterKey}`);
    if (name in parent) throw new Error(`${loc}: exists ${name}`);
    const rebuilt = {};
    for (const [key, value] of Object.entries(parent)) {
      rebuilt[key] = value;
      if (key === after) rebuilt[name] = values[loc];
    }
    for (const key of Object.keys(parent)) delete parent[key];
    Object.assign(parent, rebuilt);
  }
  const out = JSON.stringify(obj, null, 2) + '\n';
  writeFileSync(file, raw.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out);
}
console.log('locales updated');
```

Run: `node "<scratchpad>/pr3-locales.mjs" frontend/src/locales`
Expected: `locales updated`. `git diff frontend/src/locales/en.json` показывает только: новые `adminOnly` и `errorAccount`, удалённые `accountAll`, `actionMoveRequiresAccount`, объект `carddav` и `carddavBadge`, новый текст `allowPrivateHostsDesc`. Остальной файл не переформатирован.

- [ ] **Step 8: Frontend gate**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: PASS. Если `i18n.test.js` ругается на `common.adminOnly`/`admin.rules.errorAccount` (одинаковые значения в двух локалях) — перевести различающимися словами, не добавлять в исключения.

- [ ] **Step 9: Commit**

```bash
git add frontend/src
git commit -m "feat(ui): pick the account for rules and blocked senders, lock categorization, drop CardDAV"
```

---

### Task 8: Страховочный тест и полный прогон бэкенда

**Files:**
- Create: `backend/src/sharedData.guard.test.js`

- [ ] **Step 1: Write the guard test**

`backend/src/sharedData.guard.test.js`:

```js
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

// Migration 0056 dropped the owner column of mailboxes and the data around them. Route tests
// mock the database, so a query that still names it would only fail against a real one. These
// files handle genuinely personal tables (sessions, identities, auth events, push subscriptions,
// personal integrations); no other file may mention user_id.
const PERSONAL_DATA_FILES = new Set([
  'routes/admin.js',
  'routes/auth.js',
  'routes/oidc.js',
  'routes/todoist.js',
  'services/authEvents.js',
  'services/pushNotifications.js',
]);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [path] : [];
  });
}

describe('shared mailbox data', () => {
  it('names no owner column outside the files about personal data', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file).split(sep).join('/'))
      .filter((file) => !PERSONAL_DATA_FILES.has(file))
      .filter((file) => /\buser_id\b/.test(readFileSync(join(SRC, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bt src/sharedData.guard.test.js`
Expected: PASS.

Если в списке нарушителей оказался файл, не затронутый задачами 2–6, — это пропущенное место. Исправить в духе соответствующей задачи. Добавлять файл в `PERSONAL_DATA_FILES` можно только тогда, когда он работает с личной таблицей: так же проверить `grep -nw user_id <file>`.

- [ ] **Step 3: Full backend gate**

Run: `bt`, затем та же команда с `npm run lint && npm run lint:plugins` вместо `npx vitest run`.
Expected: все тесты проходят, lint чистый.

- [ ] **Step 4: Commit**

```bash
git add backend/src/sharedData.guard.test.js
git commit -m "test: guard against owner columns on shared mailbox data"
```

---

### Task 9: Проверка на настоящей базе и запуск сервера, спецификация, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`
- Scratch, не коммитится: `<scratchpad>/shared-data-users.mjs`, `<scratchpad>/shared-data-http.mjs`, `<scratchpad>/boot-pr3.sh`, `<scratchpad>/pr3-body.md`

- [ ] **Step 1: Two users on the migrated database**

База `mailexpert` из Task 1 содержит три ящика после 0056, пользователь `bob` удалён. Перед запуском сервера задать пароль `alice` и создать `carol`.

`<scratchpad>/shared-data-users.mjs`:

```js
import bcrypt from 'bcryptjs';
import { pool, query } from './src/services/db.js';

const hash = bcrypt.hashSync('Sm0ke-password-123', 10);
await query("UPDATE users SET password_hash = $1 WHERE username = 'alice'", [hash]);
await query(`INSERT INTO users (username, password_hash) VALUES ('carol', $1)
             ON CONFLICT (username) DO UPDATE SET password_hash = $1`, [hash]);
await pool.end();
console.log('smoke users ready');
```

`<scratchpad>/shared-data-http.mjs`:

```js
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:3000';
const H = { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };

async function login(username) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: H, body: JSON.stringify({ username, password: 'Sm0ke-password-123' }),
  });
  assert.equal(res.status, 200, `${username} signs in`);
  return res.headers.get('set-cookie').split(';')[0];
}
const call = async (cookie, method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { ...H, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const alice = await login('alice');
const carol = await login('carol');

// Both users see the same mailboxes and the data around them.
for (const cookie of [alice, carol]) {
  const accounts = await call(cookie, 'GET', '/api/accounts');
  assert.equal(accounts.status, 200);
  assert.deepEqual(accounts.body.map((a) => a.email_address).sort(), ['a1@example.com', 'a2@example.com', 'b1@example.com']);
  assert.equal((await call(cookie, 'GET', '/api/rules')).body.length, 4);
  assert.equal((await call(cookie, 'GET', '/api/block-list')).body.length, 4);
  assert.equal((await call(cookie, 'GET', '/api/contacts')).body.total, 3);
  assert.equal((await call(cookie, 'GET', '/api/categories/sources')).body.sources.length, 2);
  assert.equal((await call(cookie, 'GET', '/api/auth/preferences')).body.categorizationEnabled, true);
  assert.equal((await call(cookie, 'GET', '/api/mail/messages')).status, 200);
  assert.equal((await call(cookie, 'GET', '/api/mail/unread-counts')).status, 200);
  assert.equal((await call(cookie, 'GET', '/api/search/contacts?q=example')).status, 200);
}

// Changes by one user are visible to the other.
const b1 = (await call(carol, 'GET', '/api/accounts')).body.find((a) => a.email_address === 'b1@example.com');
assert.equal((await call(carol, 'POST', '/api/block-list', { emailAddress: 'x@example.com' })).body.code, 'account_required');
assert.equal((await call(carol, 'POST', '/api/block-list', { accountId: b1.id, emailAddress: 'new@example.com' })).status, 201);
assert.equal((await call(alice, 'GET', '/api/block-list')).body.length, 5);
assert.equal((await call(carol, 'POST', '/api/contacts', { displayName: 'Dana', emails: [{ value: 'dana@example.com' }] })).status, 201);
assert.equal((await call(alice, 'GET', '/api/contacts?q=dana')).body.total, 1);
const dana = (await call(alice, 'GET', '/api/contacts?q=dana')).body.contacts[0];
assert.equal((await call(alice, 'PATCH', `/api/contacts/${dana.id}`, { displayName: 'Dana B' })).status, 200);

// CardDAV is gone: no server for phones, no import.
for (const [method, path] of [['GET', '/api/carddav'], ['PROPFIND', '/carddav/'], ['GET', '/.well-known/carddav']]) {
  const res = await fetch(`${base}${path}`, { method, headers: { ...H, Cookie: carol }, redirect: 'manual' });
  assert.equal(res.status, 404, `${method} ${path}`);
}
assert.equal((await call(carol, 'DELETE', `/api/accounts/${b1.id}`)).status, 200);
assert.equal((await call(alice, 'GET', '/api/accounts')).body.length, 2);

console.log('shared data http ok');
```

`<scratchpad>/boot-pr3.sh`:

```sh
cd /work/backend
# Stop a server left over from an earlier run; the slim image has no pkill.
node -e "
const fs=require('fs');
for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue;
  try { if (fs.readFileSync('/proc/'+d+'/cmdline','utf8').replace(/\0/g,' ').trim()==='node src/index.js') process.kill(+d); } catch {} }"
sleep 2
export DB_HOST=mailexpert-check-db DB_USER=mailexpert DB_NAME=mailexpert DB_PASSWORD=check
node shared-data-users.mjs || exit 1
env SESSION_SECRET=0123456789abcdef0123456789abcdef0123 \
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
grep -E "mailbox\(es\) on startup|CardDAV|Startup mailbox connection error|FATAL|Unhandled|column .* does not exist" /tmp/boot.log
node shared-data-http.mjs 2>&1 | tail -5
echo "--- errors after requests"
grep -E "column .* does not exist|relation .* does not exist|syntax error" /tmp/boot.log | head -5
kill $PID
```

Run:

```bash
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /src && tar cf - --exclude=node_modules backend | tar xf - -C /work'
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/shared-data-users.mjs" mailexpert-backend-test:/work/backend/shared-data-users.mjs
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/shared-data-http.mjs" mailexpert-backend-test:/work/backend/shared-data-http.mjs
MSYS_NO_PATHCONV=1 docker cp "<scratchpad>/boot-pr3.sh" mailexpert-backend-test:/work/backend/boot-pr3.sh
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh /work/backend/boot-pr3.sh
```

Expected:
- `smoke users ready`;
- среди startup lines — `Connecting 3 mailbox(es) on startup, 1 at a time`; строк с `CardDAV`, `Startup mailbox connection error`, `FATAL`, `Unhandled`, `column ... does not exist` нет;
- `shared data http ok`;
- после `--- errors after requests` пусто.

Ошибки подключения к `imap.example.com` в логе ожидаемы.

Cleanup:

```bash
docker network disconnect mailexpert-check mailexpert-backend-test
docker rm -f mailexpert-check-db mailexpert-check-redis
docker network rm mailexpert-check
MSYS_NO_PATHCONV=1 docker exec mailexpert-backend-test sh -c 'cd /work/backend && rm -f shared-data-seed.mjs shared-data-check.mjs fresh-install-check.mjs shared-data-users.mjs shared-data-http.mjs boot-pr3.sh'
```

- [ ] **Step 2: Record the clarifications in the spec**

В `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`:

1. Первую строку статуса заменить на:

```markdown
> Статус: дизайн одобрен 2026-09-15; PR 1 (вход), PR 2 (сервер обслуживает ящики) и PR 3 (общие данные) реализованы. Работы по нескольким Google OAuth-приложениям (PR 2–5 из `2026-09-15-google-multi-app-design.md`) переписываются под общий список ящиков в PR 8.
```

1a. Решение удалить CardDAV внести в сам дизайн:
- в разделе «Не входит» строку `- Встроенный CardDAV-сервер для телефонов в режиме входа через Google: у клиентов нет пароля для Basic Auth.` заменить на `- Обмен контактами по CardDAV: встроенный сервер и импорт из внешнего сервера удалены в PR 3, контакты живут только внутри сервиса.`;
- в разделе «Что отключается в режиме `google`» удалить строку `- Встроенный CardDAV-сервер не монтируется.`;
- в таблице данных ячейку «Стало» строки «Адресные книги и контакты» заменить на `Колонки удаляются. Все локальные книги сливаются в одну общую книгу с флагом is_default, дубли по email сливаются`;
- строку таблицы «Синхронизация с внешним CardDAV» — ячейку «Стало» заменить на `Удаляется вместе со встроенным CardDAV-сервером: импортированные книги, их контакты и подключения удаляются`.

2. После строки `- \`setupWebSocket\` больше не получает \`imapManager\`.` (последний пункт раздела PR 2) добавить:

```markdown

## Уточнения, принятые при реализации PR 3

- Локальные книги пользователей сливаются в одну общую книгу `Contacts` с флагом `is_default`; правило `<name> (<username>)` не понадобилось.
  - В неё пишутся контакты, созданные вручную, получатели отправленных писем и автоконтакты.
  - Дубли по email сливаются: остаётся не автоматический контакт с большим `send_count`, отправки суммируются.
- Контакты — только внутренние данные сервиса. CardDAV удалён целиком, это заменяет строку таблицы про внешний CardDAV и пункт о немонтируемом CardDAV-сервере в режиме Google:
  - нет встроенного сервера (`/carddav`, `/.well-known/carddav`), импорта из внешнего сервера (`/api/carddav`) и карточки в интеграциях;
  - миграция 0056 удаляет импортированные книги с их контактами, подключения `user_integrations` с `provider = 'carddav'` и колонки `address_books.source`, `external_url`, `sync_token`;
  - все контакты редактируемые.
- `categorization_enabled` меняет администратор через `PATCH /api/admin/settings`. `GET /api/auth/preferences` отдаёт `categorizationEnabled` только для чтения. Источники социальных доменов меняет любой пользователь.
- Плагин включён для ящика, если его включил хотя бы один активный пользователь.
- Адресным остаётся только событие `rules_run_complete`, остальные события ящиков получают все клиенты.
- Правила и блок-лист без `accountId` отвечают 400 `account_required`. Ручной запуск правил без ящика проходит по всем ящикам; один ящик одновременно обрабатывает один прогон.
- До PR 8 OAuth-ящик считается подключённым, если ящик с тем же email есть в установке. Новый ящик записывает `added_by`.
- Удалённые изображения в письме блокируются по настройкам того, кто письмо открыл.
- Удаление пользователя не трогает ящики; ответ 409 `user_has_mailboxes` убран.
```

- [ ] **Step 3: Full gate**

Run: `bt`, затем `npm run lint && npm run lint:plugins` той же командой.
Expected: PASS.

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: PASS.

`git status --short` не должен показывать `agent-changes/`, `.superpowers/`, временные `.mjs` и `.sh`.

- [ ] **Step 4: Commit, push, PR**

`<scratchpad>/pr3-body.md`:

```markdown
Third step of `docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md`: mailboxes and the data around them belong to the install, so every signed-in user works with the same mailboxes, rules, block list, contacts and categories.

## What changes

- Migration 0056:
  - owner columns become author columns that survive user deletion (`added_by`, `created_by`, `snoozed_by`, `trained_by`);
  - "all my mailboxes" rules and block list entries are copied to each of the owner's mailboxes, forward reservations included;
  - users' local address books merge into one shared `Contacts` book, with duplicates merged by email;
  - books imported from CardDAV, their contacts and the CardDAV connections are removed;
  - the categorization switch moves to system settings;
  - `user_id` is dropped from every shared table.
- Mailbox, message, snooze, spam, search, diagnostics and plugin mail-access queries no longer filter by owner. OAuth mailboxes are matched by address across the install. Deleting a user leaves mailboxes alone.
- Mailbox events reach every WebSocket client; only `rules_run_complete` stays addressed. New-mail push goes to every active user with a subscription, and the badge counts all enabled mailboxes.
- Rules and block list entries require `accountId` (400 `account_required`). A rules run sweeps one mailbox once at a time.
- Contacts from compose, sent mail and inbound mail go to the shared book, and every contact is editable. Contacts stay inside the install: the built-in CardDAV server (`/carddav`, `/.well-known/carddav`) and the CardDAV import (`/api/carddav`, its scheduler and client) are removed.
- Categorization sources are shared; an admin flips the install-wide switch.
- Frontend:
  - rules and blocked senders name their account, and "all accounts" is gone;
  - context-menu actions pass the message's account;
  - non-admins see the categorization switch locked;
  - the CardDAV card and the "synced from CardDAV" badge are gone.

## Not yet

- Audit log of who did what (PR 4) and the audit screen with cleanup of personal settings (PR 5).

## Checks

- Backend unit tests:
  - shared account and contact routes;
  - rules and block list per mailbox;
  - push to active users;
  - shared contacts and the shared address book;
  - install-wide categorization;
  - plugin activation;
  - a guard against owner columns;
  - full suite and lint.
- Postgres 16: migration 0056 on old-model data (two users, rules for all mailboxes with forwards, block lists, personal and imported address books, two CardDAV connections, snooze, spam log) and on a fresh install.
- Real server boot on the migrated database; two users sign in and see and change the same data over HTTP; CardDAV paths answer 404.
- Frontend: tests, lint, build.
```

```bash
git add docs/superpowers/specs/2026-09-15-shared-mailboxes-google-login-design.md
git commit -m "docs: record the shared data details settled while building it"
git push -u origin HEAD
gh pr create --repo wyrtensi/MailExpert --base main --title "feat: share mailboxes and their data across the install" --body-file <scratchpad>/pr3-body.md
```

- [ ] **Step 5: Watch checks and merge**

```bash
gh pr checks --repo wyrtensi/MailExpert --watch
gh pr merge --repo wyrtensi/MailExpert --merge --delete-branch
git switch main && git pull --ff-only
```

Expected: все проверки зелёные до merge; после pull `main` содержит merge-коммит PR.

- [ ] **Step 6: Handoff and cleanup**

Дописать в локальный `agent-changes/2026-09-14-deps-oauth-handoff.md` (не коммитить) строку с номером PR и merge-коммитом. В ней:
- после PR 3 режим `AUTH_MODE=google` технически можно включать, но журнал действий появится только в PR 4;
- при выкатке миграция 0056 сливает книги пользователей в общую и удаляет импортированные из CardDAV контакты вместе с подключениями;
- телефоны, синхронизировавшие контакты с MailExpert по CardDAV, теряют эту учётную запись: сервера больше нет.

Удалить тестовый контейнер: `docker rm -f mailexpert-backend-test`.

---

## Self-review

**Покрытие спецификации (раздел «Общие данные» и пункт 3 «Разбиения на PR»):**

Таблица данных:
- `email_accounts.added_by`, `user_id` удалён — Task 1, запись при создании — Task 2.
- Правила `account_id NOT NULL`, `created_by`, копии правил «для всех ящиков» с `inbox_rule_forwards` — Task 1; API — Task 4.
- Блок-лист `(account_id, email_address)` с копированием — Task 1; API и применение — Task 4.
- Адресные книги и контакты без `user_id`:
  - общая книга — Task 1 (уточнение 1: слияние всех локальных книг, переименование не нужно);
  - код — Task 5.
- Строка про внешний CardDAV заменена удалением CardDAV (уточнение 2): миграция — Task 1, бэкенд — Task 5, интерфейс — Task 7, проверка 404 — Task 9.
- `category_list_sources` с уникальностью `(source_type, value)` — Task 1; код — Task 6.
- `categorization_enabled` — Task 1 и Task 6; интерфейс — Task 7.
- `snoozed_messages.snoozed_by`, `spam_training_log.trained_by` и индексы по ящику — Task 1; вставки — Task 2.
- Личные данные не меняются; страховочный список файлов — Task 8.

Изменения в коде:
- Условия владельца убраны во всех маршрутах и сервисах — Task 2, Task 4–6; страховка — Task 8.
- `mailAccess.js` проверяет существование, имена сохранены — Task 2.
- События ящиков всем клиентам, адресные остаются адресными — Task 3.
- Push всем активным пользователям, счётчик по всем включённым ящикам — Task 3.
- Автоконтакты в общую книгу — Task 5.
- Диагностический отчёт по всем ящикам — Task 2.
- `DELETE /api/accounts/:id` для любого пользователя — Task 2.
- Фронтенд правил, блок-листа, контактов и системных переключателей — Task 7. Интервалы сделаны в PR 2.

Раздел «Проверка»:
- Smoke миграции PR 3 на Postgres 16 со старой моделью (два пользователя, ящики у обоих, правило для всех ящиков с пересылками, блок-лист, одноимённые книги, CardDAV у двоих, отложенное письмо) — Task 1.
- «Оба пользователя видят все ящики, правила и блок-лист размножены, данные не потеряны» — Task 1 (база) и Task 9 (HTTP).

**Проверка на заглушки:**
- «TBD», «TODO» и «аналогично Task N» нет.
- Массовые механические правки (`mail.js`, `imapManager.js`, ожидания `broadcast`) заданы точными строками и формой замены.
- Каждая задача заканчивается проверкой `grep`, которая ловит пропуск.

**Согласованность имён:**
- `requireMailbox(accountId, res)` — Task 4 (правила, блок-лист).
- `defaultAddressBookId()` и `DEFAULT_ADDRESS_BOOK_NAME` — Task 5 (контакты, отправка, автоконтакты).
- `upsertAutoContacts(messages)` — Task 5 (метод и вызов).
- `sendPushToActiveUsers` — Task 3 (сервис, менеджер, моки).
- `notifyOnLabelTouch`/`emitGtdIfRelevant`/`onMailMutation` без `userId` — Task 3.
- `getGlobalCategorizationEnabled()`, `invalidateGlobalCategorizationCache()`, `loadSocialDomains()`, `invalidateSocialDomainCache()`, `backfillCategories(accountId)` — Task 6 (сервис, маршруты, менеджер, настройки, тесты).
- `isPluginActivatedForAccount(pluginId)` — Task 2.
- `accountLabel(accounts, accountId)` и `api.addToBlockList(accountId, email)` — Task 7.
- Ключи `common.adminOnly` и `admin.rules.errorAccount` — Task 7 (компоненты и скрипт локалей).
