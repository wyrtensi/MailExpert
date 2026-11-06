# Алиасы как ящики: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** по личному переключателю сотрудника каждый алиас ящика становится строкой бокового списка со своими "Входящими" (ровно письма с плашкой "на X"), "Отправленными" (From = X), счётчиком непрочитанных и "От" = X при "Написать" и "Ответить".

**Architecture:** правило "к какому алиасу относится письмо" повторяется на сервере одной SQL-функцией `message_reply_alias`, зеркалом фронтендового `recipientAliasFor`; одна фикстура прогоняется через обе стороны. `GET /api/mail/messages` получает `aliasId` и отбирает письма через индексы адресов (новый GIN по `delivery_addresses` и существующие по To/Cc и From), `GET /api/mail/alias-unread-counts` считает непрочитанные той же функцией. На фронтенде выбранный алиас живёт в сторе рядом с выбранным ящиком, строки строит чистая функция из `account.aliases`.

**Tech Stack:** Node.js 24 + Express 5 + PostgreSQL (vitest, pglite через `services/testing/realSchema.js`), React 19 + Zustand (node --test, JSDOM, sucrase).

**Spec:** `docs/superpowers/specs/2026-11-06-aliases-as-accounts-design.md`.

## Global Constraints

- Ветка `feat/aliases-as-accounts` от `main` @ 7d79dcd0 (v1.1.1), PR в wyrtensi/MailExpert. Мерж и релиз - только после отдельного "да" владельца (2026-11-06 он разрешил план, выполнение, PR и выкатку ветки на стенд, мерж не разрешал). Conventional Commits; код, комменты, коммиты и PR на английском, документация на русском. В репозитории только плейсхолдеры (`example.com`, `<PANEL_HOST>`), без реальных адресов и людей (AGENTS.md).
- TDD: сначала падающий тест. Существующие тесты не ослаблять. Новых зависимостей нет.
- Миграции только вперёд: `backend/migrations/0101_alias_mailbox_rule.sql` (функции, обычная транзакция) и `0102_messages_delivery_addresses_index.sql` (`-- no-transaction`, `CREATE INDEX CONCURRENTLY`). Раннер режет `-- no-transaction` файл по `;` (`services/migrations.js:79`), поэтому функций в нём нет.
- Настройка: ключ `aliasesAsAccounts` в `users.preferences`, только boolean, нет ключа = выключено. Источник истины - сервер; `localStorage.mailexpert_aliases_as_accounts` только для первой отрисовки.
- Подпись переключателя: "Алиасы как ящики" / "Display aliases as accounts".
- Одно правило: письмо из INBOX ящика-владельца лежит во "Входящих" алиаса X тогда и только тогда, когда `recipientAliasFor(письмо, ящик)` (`frontend/src/utils/mailboxBanner.js`) возвращает `{ address: X, active: true }`. На сервере это `message_reply_alias`; отбор "алиас есть где-нибудь в адресах" запрещён. Правило меняется только в обоих местах сразу и с новым кейсом в `backend/src/services/aliasMailbox.fixtures.json`.
- Порядок алиасов ящика везде `ORDER BY created_at, id`: `GET /api/accounts`, `listAliases`, серверный отбор. Алиасы одной синхронизации Gmail вставляются одной транзакцией с одинаковым `created_at`.
- Строку получает алиас ящика с `enabled !== false` и `mail_node !== true`, если его адрес без учёта регистра отличается от адреса ящика; один адрес в ящике - одна строка (первый по порядку, его же выбирает `matchReplyAlias`).
- "Входящие" алиаса - письма всех категорий, без вкладок. "Отправленные" - папка отправленных владельца (`resolveAllSentPaths`, `backend/src/utils/mailUtils.js:182`) с `lower(from_email)` = адрес алиаса. Других папок у алиаса нет.
- Без `aliasId` `listMessages` и `GET /api/mail/messages` работают как сейчас, без новых запросов (порядок вызовов в `services/messageService.test.js` прежний). "Все входящие" и ящики-владельцы не меняются.
- Строки интерфейса - в `frontend/src/locales/en.json` и `ru.json` в той задаче, где их впервые используют (`locales/i18n.test.js` падает на неиспользуемых ключах). Новый путь в `api.js` - ответ в `frontend/src/demo/index.js` в той же задаче (`demo/routeCoverage.test.js`).
- Backend: `cd backend && npm test && npm run lint && npm run lint:plugins`. Frontend: `cd frontend && npm test && npm run lint && npm run build`.
- Стенд <PANEL_HOST> вне плана: ветку выкатывает руководитель ручной сборкой, без вопроса владельцу (его решение 2026-11-06).

## Review Focus

1. Два алиаса из одной синхронизации Gmail с одинаковым `created_at`: фронтенд и сервер видят их в одном порядке, иначе письмо на оба алиаса окажется у одного, а плашка назовёт другого (тест в Task 2).
2. Большой старый ящик: "Входящие" алиаса и его счётчик отвечают по индексам, без прохода по всему INBOX (EXPLAIN-тесты в Task 3 и Task 4).
3. Выбранный алиас удалила синхронизация Gmail, или режим выключили на другом компьютере: выбор уходит во "Входящие" ящика-владельца, список не застревает на 404 (тесты в Task 6 и Task 8).
4. Сотрудник прочитал письмо во "Входящих" алиаса: счётчик у строки алиаса уменьшается без перезагрузки (тест в Task 6).
5. На телефоне переход между двумя алиасами одного ящика (тот же `accountId`, та же папка): шторка закрывается, список перечитывается (тест в Task 7).

---

### Task 0: Ветка и документы

**Files:**
- Create: `docs/superpowers/specs/2026-11-06-aliases-as-accounts-design.md`
- Create: `docs/superpowers/plans/2026-11-06-aliases-as-accounts.md` (этот план)

- [ ] **Step 1:** `git switch -c feat/aliases-as-accounts origin/main`
- [ ] **Step 2:** скопировать оба документа, заменив реальные адреса, имена и хосты плейсхолдерами (`team@example.com`, `name_surname@example.com`, Name Surname, `<PANEL_HOST>`); grep по реальным именам в обоих файлах пуст.
- [ ] **Step 3:** `git commit -m "docs: aliases as accounts design and plan"`

### Task 1: Настройка aliasesAsAccounts

**Files:**
- Modify: `backend/src/routes/auth.js:871-1050` (`patchPreferences`)
- Modify: `frontend/src/store/index.js:202-225` (смена пользователя), `:1253-1258` (рядом с `sortAccountsByLatest`), `:1444-1452` (`loadPreferences`)
- Modify: `frontend/src/demo/index.js:455-465` (настройки демо), `:2117-2142` (PATCH)
- Test: `backend/src/routes/auth.preferences.test.js`, `frontend/src/store/aliasesAsAccounts.test.js` (создать), `frontend/src/demo/index.test.js`

**Interfaces:**
- Produces: `users.preferences.aliasesAsAccounts: boolean`. PATCH: не boolean -> 400 `{ error: 'aliasesAsAccounts must be a boolean' }` без запроса в базу; ключа нет -> значение не трогается. В UPDATE - `$46::boolean` после `$45`.
- Produces: стор `aliasesAsAccounts: boolean` (старт: `localStorage.mailexpert_aliases_as_accounts === 'true'`), `setAliasesAsAccounts(val: boolean)`: localStorage, `set`, `schedulePrefSave({ aliasesAsAccounts: val })`. `loadPreferences`: `prefs.aliasesAsAccounts === true`, нет ключа = `false`, зеркало перезаписывается. Смена пользователя (`leaving`): ключ `mailexpert_aliases_as_accounts` удаляется, `aliasesAsAccounts: false`.

- [ ] **Step 1: падающие тесты:**
  - backend `PATCH /auth/preferences aliasesAsAccounts`: `merges the boolean as $46, true and false alike` (SQL содержит `jsonb_build_object('aliasesAsAccounts', $46::boolean)`, `params[45]` = `false`, потом `true`); `rejects a non-boolean without querying`; `leaves the stored value untouched when the key is absent` (`params[45] === null`)
  - store: `setAliasesAsAccounts saves through the preference queue and mirrors localStorage`; `loadPreferences turns the mode off when the server has no key, even if this browser cached true`; `loadPreferences applies true from the server` - провал 3 спеки; `another user signing in on the tab starts with the mode off`
  - demo: `GET /auth/preferences has aliasesAsAccounts false by default`; `PATCH keeps a boolean and refuses 'yes' with invalid_preference`
- [ ] **Step 2:** `cd backend && npx vitest run src/routes/auth.preferences.test.js`; `cd frontend && node --test src/store/aliasesAsAccounts.test.js src/demo/index.test.js` - FAIL.
- [ ] **Step 3:** реализация по образцу `sortAccountsByLatest` во всех трёх местах.
- [ ] **Step 4:** PASS, оба пакета зелёные.
- [ ] **Step 5:** `git commit -m "feat(prefs): per-user aliasesAsAccounts preference"`

### Task 2: Правило алиаса на сервере и общая фикстура

**Files:**
- Create: `backend/migrations/0101_alias_mailbox_rule.sql`, `backend/migrations/0102_messages_delivery_addresses_index.sql`
- Create: `backend/src/services/aliasMailbox.fixtures.json`
- Modify: `backend/src/services/accountAliases.js:39-48`
- Modify: `backend/src/routes/accounts.js:69-81`
- Test: `backend/src/services/aliasMailbox.rule.pglite.test.js` (создать), `backend/src/services/accountAliases.pglite.test.js`, `frontend/src/utils/aliasInboxParity.test.js` (создать)

**Interfaces:**
- Produces (0101): `message_delivery_addresses(delivery_addresses jsonb) RETURNS text[]`, IMMUTABLE PARALLEL SAFE: строковые элементы массива в нижнем регистре, `'{}'` для NULL и не-массива (как `message_recipient_addresses` в 0071).
- Produces (0101): `message_reply_alias(delivery_addresses jsonb, to_addresses jsonb, cc_addresses jsonb, from_email text, aliases text[], own_addresses text[]) RETURNS text`, IMMUTABLE PARALLEL SAFE: адрес алиаса (нижний регистр) письма в INBOX или NULL. `aliases` - алиасы строк (см. Global Constraints) в порядке `created_at, id`, нижний регистр; `own_addresses` - адрес ящика и адреса всех его алиасов, нижний регистр.
- Produces (0102): `idx_messages_delivery_addresses ON messages USING GIN (message_delivery_addresses(delivery_addresses)) WHERE is_deleted = false`, перед ним `DROP INDEX CONCURRENTLY IF EXISTS` (как 0071).
- Produces: `listAliasesByAccount(accountIds: string[], db = { query }) -> Promise<Record<string, AliasRow[]>>` в `accountAliases.js`, где `AliasRow` - строка `account_aliases` с полями как сейчас в `routes/accounts.js:76`, `ORDER BY created_at, id`; `listAliases` тоже `ORDER BY created_at, id`; `routes/accounts.js` строит `aliasMap` через `listAliasesByAccount` (санитизация подписи на месте).
- Produces: фикстура `{ accounts: { desk, other }, folders, aliases, cases: [{ name, account, folder, from_email, to, cc, delivery, category, is_read, inbox, sent }] }`; `to`/`cc` - массивы адресов (тесты делают из них `{ name: '', email }`), `delivery` - массив или `null`, `inbox`/`sent` - ожидаемый адрес алиаса или `null`.

Тело `message_reply_alias` (повторяет `mailboxBanner` + `matchReplyAlias`; комментарии - вне `$$`):

```sql
SELECT CASE
  WHEN COALESCE(lower(from_email), '') = ANY(own_addresses)
   AND NOT (message_recipient_addresses(to_addresses, cc_addresses) && own_addresses
            OR message_delivery_addresses(delivery_addresses) && own_addresses)
    THEN NULL
  ELSE COALESCE(
    (SELECT a.email FROM unnest(aliases) WITH ORDINALITY AS a(email, ord)
      WHERE a.email = ANY(message_delivery_addresses(delivery_addresses)) ORDER BY a.ord LIMIT 1),
    (SELECT a.email FROM unnest(aliases) WITH ORDINALITY AS a(email, ord)
      WHERE a.email = ANY(message_recipient_addresses(to_addresses, cc_addresses))
         OR a.email = COALESCE(lower(from_email), '')
      ORDER BY a.ord LIMIT 1))
END
```

Первая ветка - письмо исходящее (`direction 'out'`, плашки нет). Дальше `delivery_addresses` в порядке алиасов, потом один проход To/Cc/From в порядке алиасов, как в коде `matchReplyAlias`.

Фикстура. Ящик `desk@example.com` (`folder_mappings.sent = 'Sent'`, папки INBOX и Sent с `\Sent`), ящик `other` = `science@example.com` без алиасов. Алиасы desk по порядку: `ivan@example.com` (Ivan Petrov), `anna@example.com` (Anna Belova), `desk@example.com` (второе имя отправителя). Кейсы (INBOX ящика desk, если не сказано иное; `inbox` - ожидание):

| name | from | to / cc | delivery | inbox |
|---|---|---|---|---|
| to-alias | client@corp.test | to ivan | `[]` | ivan |
| cc-alias | client | to client2, cc anna | `[]` | anna |
| delivered-only | client | to desk | `[anna]` | anna |
| delivered-beats-to | client | to ivan | `[anna]` | anna |
| two-aliases-in-to | client | to anna, ivan | `[]` | ivan |
| mixed-case | client | to `Ivan@Example.com` | `[]` | ivan |
| legacy-null-delivery | client | to anna | `null` | anna |
| own-address-only | client | to desk | `[desk]` | null |
| removed-alias | client | to olga@example.com | `[]` | null |
| neighbour-mailbox | client | to science@example.com | `[]` | null |
| bcc-without-delivery | client | to someone@corp.test | `[]` | null |
| newsletter (`category: newsletter`) | news@list.test | to ivan | `[]` | ivan |
| outgoing-copy | ivan | to client | `[]` | null |
| self-addressed-from-alias | ivan | to desk | `[]` | ivan |
| alias-to-alias | ivan | to anna | `[]` | ivan |
| other-mailbox (ящик other) | client | to ivan | `[ivan]` | null |
| sent-from-alias (Sent) | ivan | to client | - | `sent`: ivan |
| sent-mixed-case (Sent) | `Ivan@Example.com` | to client | - | `sent`: ivan |
| sent-from-mailbox (Sent) | desk | to client | - | `sent`: null |

Непрочитанные (`is_read: false`): to-alias, cc-alias, delivered-only, two-aliases-in-to, newsletter, self-addressed-from-alias. Ожидания фикстуры - то, что возвращает `recipientAliasFor` (все 16 кейсов INBOX сверены с ним на 7d79dcd0): если фронтендовый тест с ними расходится, правится фикстура, правило фронтенда не трогаем.

- [ ] **Step 1: падающие тесты:**
  - `aliasMailbox.rule.pglite.test.js`: на каждый кейс INBOX ящика desk `fixture: <name>` - `SELECT message_reply_alias(...)` по строке письма с `aliases = ['ivan@example.com','anna@example.com']`, `own_addresses = ['desk@example.com','ivan@example.com','anna@example.com']` равен `inbox`; `message_delivery_addresses lowercases strings and answers {} for NULL and a non-array`; `0102 creates idx_messages_delivery_addresses as a partial GIN index` (по `pg_indexes`)
  - `accountAliases.pglite.test.js`: `listAliases and listAliasesByAccount order aliases inserted in one transaction by id` (три вставки в одном `BEGIN ... COMMIT`, ожидается порядок отсортированных id) - Review Focus 1
  - `aliasInboxParity.test.js` (фикстура по `new URL('../../../backend/src/services/aliasMailbox.fixtures.json', import.meta.url)`, как `utils/accountHealth.test.js`): на каждый кейс INBOX `const pill = recipientAliasFor(message, account, folders)`; `assert.equal(pill?.active ? pill.address.toLowerCase() : null, c.inbox)`
- [ ] **Step 2:** `cd backend && npx vitest run src/services/aliasMailbox.rule.pglite.test.js src/services/accountAliases.pglite.test.js` - FAIL (нет функций); `cd frontend && node --test src/utils/aliasInboxParity.test.js` - PASS сразу (это проверка фикстуры по действующему правилу).
- [ ] **Step 3:** миграции, `listAliasesByAccount`, ORDER BY в `listAliases` и `routes/accounts.js`.
- [ ] **Step 4:** PASS, backend зелёный целиком; тесты `routes/accounts.*.test.js` (моки `query` по порядку вызовов) не тронуты: `listAliasesByAccount` делает ровно один запрос, как прежний код.
- [ ] **Step 5:** `git commit -m "feat(aliases): server-side recipient alias rule shared with the list pill"`

### Task 3: Письма ящика алиаса в GET /api/mail/messages

**Files:**
- Create: `backend/src/services/aliasMailbox.js`
- Modify: `backend/src/services/messageService.js:6-90`
- Modify: `backend/src/routes/mail.js:133-165`
- Test: `backend/src/services/messageService.aliasMailbox.pglite.test.js` (создать), `backend/src/routes/mail.aliasMessages.test.js` (создать)

**Interfaces:**
- Consumes: `message_reply_alias`, `message_delivery_addresses`, `idx_messages_delivery_addresses`, `listAliasesByAccount` (Task 2); `resolveAllSentPaths(accountId, folderMappings)`.
- Produces (`aliasMailbox.js`):
  - `AliasMailbox = { accountId: string, folderMappings: object | null, aliases: Array<{ id: string, email: string }>, ownAddresses: string[] }`: `aliases` - алиасы строк в порядке `created_at, id`, адрес в нижнем регистре; `ownAddresses` - адрес ящика и все адреса алиасов, нижний регистр.
  - `replyAliases(account: { email_address, mail_node }, aliases: AliasRow[]) -> Array<{ id, email }>` (`[]` при `mail_node`).
  - `loadAliasMailboxes(accountIds?: string[]) -> Promise<AliasMailbox[]>`: ящики `enabled = true AND mail_node = false` хотя бы с одним алиасом строки, алиасы через `listAliasesByAccount`.
  - `aliasInboxCondition(mailbox: AliasMailbox, aliasEmail: string, p: number) -> { sql: string, values: [aliasEmail, aliasEmails[], ownAddresses[]] }`:
    ```
    (message_delivery_addresses(m.delivery_addresses) @> ARRAY[$p::text]
     OR message_recipient_addresses(m.to_addresses, m.cc_addresses) @> ARRAY[$p::text]
     OR lower(m.from_email) = $p::text)
    AND message_reply_alias(m.delivery_addresses, m.to_addresses, m.cc_addresses, m.from_email,
                            $(p+1)::text[], $(p+2)::text[]) = $p::text
    ```
    Первая скобка следует из второй и результата не меняет: она даёт планировщику BitmapOr по трём индексам (выражения слово в слово как в индексах 0071, 0102, 0068).
  - `aliasSentCondition(aliasEmail: string, p: number) -> { sql: 'lower(m.from_email) = $p::text', values: [aliasEmail] }`.
- Produces: `listMessages({ ..., aliasId })`. С `aliasId`:
  - нужен `resolvedAccountId === accountId`, и алиас есть в `aliases` его `AliasMailbox`; иначе `{ error: 'alias_gone' }`;
  - `folder === 'INBOX'` -> `aliasInboxCondition`; `folder` из `resolveAllSentPaths(...)` -> `aliasSentCondition`; иначе `{ error: 'alias_folder' }`;
  - `category` игнорируется;
  - `total` в обычном виде - `COUNT(*)` по тем же условиям (как путь с `category`, `:59-64`), в тредовом - существующий `threadCountResult`.
- Produces (роут): `aliasId` не UUID -> 400 `{ error: 'Invalid alias id' }`; `aliasId` без `accountId` -> 400 `{ error: 'aliasId needs accountId' }`; `alias_gone` -> 404 `{ error: 'This alias is no longer a mailbox here', code: 'alias_gone' }`; `alias_folder` -> 400 `{ error: 'An alias has only Inbox and Sent', code: 'alias_folder' }`.

- [ ] **Step 1: падающие тесты** (pglite на реальной схеме как `messageService.eopCategory.pglite.test.js`, фикстура из Task 2, `dbState` запоминает последний SQL):
  - `alias Inbox lists exactly the fixture letters of that alias, flat and threaded` (ivan и anna: множества id равны кейсам с `inbox` = алиас) - провал 1 спеки
  - `letters of every category are listed even when category is passed` (с `category: 'primary'` кейс newsletter на месте)
  - `unreadOnly lists and counts only the alias's unread letters`
  - `total counts the alias's letters, not the folder` (строка `folders` с `total_count = 999`, `limit: 1` -> `total` = число кейсов алиаса)
  - `alias Sent lists letters from the alias address in the Sent folder, any case`
  - `another mailbox's letter to the alias address is not listed`
  - `refuses the mailbox's own address, an unknown alias, a mail node and a disabled mailbox with alias_gone`
  - `refuses a folder other than INBOX and Sent with alias_folder`
  - `alias Inbox is answered from the address indexes` (3000 писем INBOX на `other@corp.test`, `ANALYZE messages`, `SET enable_seqscan = off`, `EXPLAIN` записанного SQL: есть `idx_messages_delivery_addresses` и `idx_messages_recipient_addresses`, нет `Seq Scan on messages`; образец `routes/search.pglite.test.js:55-63`) - Review Focus 2
  - `alias Sent is answered from idx_messages_account_from_date`
  - роут (мок `../services/messageService.js`, обвязка как `mail.unifiedInbox.test.js`): `400 for a malformed aliasId`, `400 for aliasId without accountId`, `404 alias_gone`, `400 alias_folder`, `passes aliasId to listMessages`
- [ ] **Step 2:** `cd backend && npx vitest run src/services/messageService.aliasMailbox.pglite.test.js src/routes/mail.aliasMessages.test.js` - FAIL.
- [ ] **Step 3:** реализация. Если BitmapOr не складывается (план идёт по `idx_messages_list`), сделать ветку From самостоятельной для индекса 0068: `(m.account_id = $(p+3)::uuid AND lower(m.from_email) = $p::text)`, четвёртое значение - `mailbox.accountId`.
- [ ] **Step 4:** PASS, backend зелёный целиком (включая `messageService.test.js`).
- [ ] **Step 5:** `git commit -m "feat(mail): alias mailbox Inbox and Sent in the message list API"`

### Task 4: Непрочитанные алиасов

**Files:**
- Modify: `backend/src/services/messageService.js`
- Modify: `backend/src/routes/mail.js` (рядом с `/unread-counts`, `:342-363`)
- Test: `backend/src/services/messageService.aliasMailbox.pglite.test.js`, `backend/src/routes/mail.aliasMessages.test.js`

**Interfaces:**
- Consumes: `loadAliasMailboxes` (Task 3), функции и индексы (Task 2).
- Produces: `LISTED_ROW_SQL` - экспорт из `messageService.js`: условие #407 (`:49`) теперь одно на `listMessages` и счётчики.
- Produces: `aliasUnreadCounts() -> Promise<Record<string, number>>`: ключ - id алиаса, есть для каждого алиаса из `loadAliasMailboxes()` (0, если писем нет). Один запрос на ящик, `Promise.all`:
  ```sql
  SELECT message_reply_alias(m.delivery_addresses, m.to_addresses, m.cc_addresses, m.from_email,
                             $2::text[], $3::text[]) AS email, COUNT(*)::int AS n
  FROM messages m
  WHERE m.account_id = $1 AND m.folder = 'INBOX' AND m.is_deleted = false AND m.is_read = false
    AND ${LISTED_ROW_SQL}
    AND (message_delivery_addresses(m.delivery_addresses) && $2::text[]
         OR message_recipient_addresses(m.to_addresses, m.cc_addresses) && $2::text[]
         OR lower(m.from_email) = ANY($2::text[]))
  GROUP BY 1
  ```
- Produces: `GET /api/mail/alias-unread-counts` -> 200 `{ byAlias: Record<aliasId, number> }`, `Cache-Control: no-store`.

- [ ] **Step 1: падающие тесты:**
  - `each alias's unread count equals its unreadOnly Inbox total` (для каждого алиаса desk: `aliasUnreadCounts()[id] === (await listMessages({ accountId, folder: 'INBOX', aliasId: id, unreadOnly: true })).total`) - провал 5 спеки
  - `has every current alias, 0 without unread letters, and nothing for the mailbox's own address, a mail node or a disabled mailbox`
  - `counts without a scan of the mailbox` (те же 3000 писем, часть непрочитанных, EXPLAIN: нет `Seq Scan on messages`) - Review Focus 2
  - роут: `GET /alias-unread-counts answers byAlias with no-store`
- [ ] **Step 2:** FAIL. **Step 3:** реализация. **Step 4:** PASS, backend зелёный.
- [ ] **Step 5:** `git commit -m "feat(mail): unread counts per alias mailbox"`

### Task 5: Строки алиасов, параметры списка, API и демо

**Files:**
- Create: `frontend/src/utils/aliasMailboxes.js`, `frontend/src/utils/messageListParams.js`
- Modify: `frontend/src/utils/api.js:602` (рядом с `getUnreadCounts`)
- Modify: `frontend/src/demo/index.js:669-695` (`listMessages`), `:2402-2403`
- Test: `frontend/src/utils/aliasMailboxes.test.js`, `frontend/src/utils/messageListParams.test.js` (создать), `frontend/src/demo/index.test.js`

**Interfaces:**
- Consumes: `sortAliasesByName` (`utils/aliasSort.js`), `recipientAliasFor` (`utils/mailboxBanner.js`), `normalizeAccountFilter` (`utils/accountFilter.js`).
- Produces (`aliasMailboxes.js`):
  - `replyAliasesOf(account) -> alias[]`: `account.aliases` без адреса ящика (без учёта регистра), первый по порядку на адрес; `[]` при `mail_node === true` или `enabled === false`.
  - `aliasMailboxRows(accounts) -> AliasMailboxRow[]`, `AliasMailboxRow = { key: '<accountId>:<aliasId>', accountId, aliasId, name, email, color }`; `name` - `alias.name` или локальная часть адреса, `color` - цвет ящика; алиасы всех ящиков вперемешку в порядке `sortAliasesByName`.
  - `filterAliasRows(rows, query) -> AliasMailboxRow[]`: подстрока без учёта регистра по `name` и `email`, пустой запрос возвращает `rows`.
  - `resolveSelectedAlias({ accounts, accountsReady, selectedAccountId, selectedAliasId, enabled }) -> string | null`: при `!enabled` - `null`; пока `accountsReady === false`, список неизвестен - `selectedAliasId` как есть (как `resolveSelectedAccount`, `utils/accountScope.js:20`); иначе `selectedAliasId`, если в `aliasMailboxRows(accounts)` есть строка с этими `accountId` и `aliasId`, или `null`.
  - `aliasSentFolder(account, folderList) -> string | null`: `folder_mappings.sent`, если такая папка есть в `folderList`; иначе первая с `special_use === '\\Sent'`; иначе `null` (как `resolveAllSentPaths`).
  - `composeDataForView({ selectedAccountId, selectedAliasId }) -> { accountId?: string, aliasId?: string }`.
  - `viewReplyAliasId(message, { selectedAccountId, selectedAliasId }) -> string | null`: `selectedAliasId`, если алиас выбран и `message.account_id === selectedAccountId`; иначе `null`.
- Produces (`messageListParams.js`): `messageListParams({ selectedAccountId, selectedFolder, selectedAliasId, unreadOnly, threaded, categoryActive, activeCategory, limit, offset }) -> Record<string, string | number>`: правила четырёх мест `MessageList.jsx` (`:449-456`, `:512-517`, `:556-559`, `:730-733`) плюс `aliasId` при выбранном алиасе; с `aliasId` нет `category`.
- Produces: `api.getAliasUnreadCounts() -> Promise<{ byAlias }>` = `request('GET', '/mail/alias-unread-counts')`.
- Produces (демо): `/mail/messages` с `aliasId` - во "Входящих" письма, где `recipientAliasFor(item, account, foldersFor(account.id))` активен и равен адресу алиаса; в "Отправленных" - `from_email` равен адресу алиаса без учёта регистра. `/mail/alias-unread-counts` - тот же отбор по непрочитанным INBOX для всех строк `aliasMailboxRows(ACCOUNT_FIXTURES)`.

- [ ] **Step 1: падающие тесты:**
  - `aliasMailboxRows lists aliases of all mailboxes in sortAliasesByName order with the mailbox color` (два ящика вперемешку; алиас без имени сортируется по локальной части)
  - `aliasMailboxRows skips the mailbox's own address in any case, a mail node mailbox, a disabled mailbox and a second alias with the same address`
  - `resolveSelectedAlias keeps a current alias and drops a removed one, one of another mailbox, and any when the mode is off`; `keeps the alias while the mailbox list is not loaded yet`
  - `aliasSentFolder prefers the mapping present in the folder list, then the \\Sent folder, else null`
  - `composeDataForView carries aliasId only with an account`; `viewReplyAliasId answers only for a letter of the open alias's mailbox`
  - `filterAliasRows matches name and address, case-insensitive`
  - `messageListParams`: `mailbox Inbox with categories sends category`, `unified inbox sends no accountId`, `alias view sends aliasId and never category`, `limit and offset pass through`
  - демо: `GET /mail/messages with aliasId lists only letters whose pill names the alias` (алиас Vendor Desk ящика `demo-ops`: письмо на vendors есть, `demo-alias-902` нет); `GET /mail/alias-unread-counts answers byAlias for demo-ops-alias-vendors`
- [ ] **Step 2:** `cd frontend && node --test src/utils/aliasMailboxes.test.js src/utils/messageListParams.test.js src/demo/index.test.js` - FAIL.
- [ ] **Step 3:** реализация. **Step 4:** frontend `npm test` зелёный (включая routeCoverage).
- [ ] **Step 5:** `git commit -m "feat(ui): alias mailbox rows, list params and demo answers"`

### Task 6: Выбранный алиас и счётчики в сторе

**Files:**
- Modify: `frontend/src/store/index.js:202-235` (смена пользователя), `:310-330` (`setAccounts`), `:337-365` (`setSelectedAccount`), `:492-512` (`setUnreadCounts`, `adjustUnread`), `setAliasesAsAccounts` и `loadPreferences` (Task 1)
- Test: `frontend/src/store/aliasMailboxes.test.js` (создать)

**Interfaces:**
- Consumes: `resolveSelectedAlias` (Task 5), `api.getAliasUnreadCounts` (Task 5), `aliasesAsAccounts` (Task 1).
- Produces: `selectedAliasId: string | null` (старт из `localStorage.mailexpert_selected_alias`, `''` = `null`); `setSelectedAccount(accountId, folder = 'INBOX', aliasId = null)` пишет `mailexpert_selected_alias`, `navChanged` учитывает смену алиаса; прежние вызовы с двумя аргументами сбрасывают алиас.
- Produces: `aliasUnreadCounts: Record<string, number>`; `refreshAliasUnreadCounts() -> Promise<void>`: при выключенном режиме `{}` без запроса, из нескольких ответов применяется самый новый (счётчик поколений, как `reconcileAccounts`); `scheduleAliasCountRefresh()` - таймер модуля 400 мс, вызывается после `setUnreadCounts`, `adjustUnread`, `setAccounts` и при включении режима.
- Produces: откат выбора: `setAccounts`, `loadPreferences` и `setAliasesAsAccounts(false)` прогоняют `resolveSelectedAlias`; если он дал `null` при выбранном алиасе - `selectedAliasId: null`, `selectedFolder: 'INBOX'`, `selectedAccountId` остаётся ящиком-владельцем, localStorage как в `setAccounts`.
- Смена пользователя: `mailexpert_selected_alias` удаляется, `selectedAliasId: null`, `aliasUnreadCounts: {}`.

- [ ] **Step 1: падающие тесты:**
  - `setSelectedAccount with an alias stores it; a two-argument call clears it`
  - `an alias removed by a mailbox list refresh falls back to the owner's Inbox` (так приходит `aliases_changed`: `reconcileAccounts` -> `setAccounts`) - Review Focus 3
  - `turning the mode off with an alias selected opens the owner's Inbox`; `server preferences with the mode off drop a cached alias selection` - Review Focus 3
  - `a cached alias survives preferences arriving before the mailbox list` (старт: `loadPreferences` с режимом `true` при `accountsReady: false`, потом `setAccounts` со списком, где алиас есть)
  - `server counts arriving refresh alias counts when the mode is on, never when it is off` (шпион `api.getAliasUnreadCounts`)
  - `a local read change on the owner refreshes alias counts` (`adjustUnread`) - Review Focus 4
  - `an older alias count answer does not overwrite a newer one`
- [ ] **Step 2:** `node --test src/store/aliasMailboxes.test.js` - FAIL. **Step 3:** реализация. **Step 4:** frontend зелёный.
- [ ] **Step 5:** `git commit -m "feat(ui): selected alias mailbox and its unread counts in the store"`

### Task 7: Боковой список

**Files:**
- Create: `frontend/src/components/AliasMailboxRows.jsx`
- Modify: `frontend/src/components/Sidebar.jsx`: `:343-360` (стор), `:374-377` (закрытие шторки), `:1098-1107` (под "Все входящие"), после цикла `visibleAccounts.map` (`:1414`), подсветка `:1160`, `:1418-1465`, `:1729`
- Modify: `frontend/src/locales/en.json`, `ru.json` (`sidebar.aliases.*`)
- Test: `frontend/src/components/Sidebar.aliases.render.test.js` (создать, обвязка как `Sidebar.accounts.render.test.js`)

**Interfaces:**
- Consumes: `aliasMailboxRows`, `filterAliasRows`, `aliasSentFolder` (Task 5); `aliasesAsAccounts`, `setAliasesAsAccounts`, `selectedAliasId`, `aliasUnreadCounts`, `setSelectedAccount(accountId, folder, aliasId)` (Task 1, 6).
- Produces: `AliasesAsAccountsSwitch()` и `AliasMailboxRows({ rows, collapsed })` из `AliasMailboxRows.jsx`.
- Produces: ключи `sidebar.aliases.toggle` = "Алиасы как ящики" / "Display aliases as accounts", `sidebar.aliases.inbox` = "Входящие" / "Inbox", `sidebar.aliases.sent` = "Отправленные" / "Sent".

Поведение:
- Переключатель - строка сразу под NavItem "Все входящие", `role="switch"` и вид как у `sidebar.blockImages` (`:2025-2045`). Виден, если есть хоть одна строка алиаса или режим уже включён; в свёрнутом боковом списке скрыт.
- Строки алиасов идут после последнего ящика, только при включённом режиме: `aliasMailboxRows(accounts)`, при показанном фильтре ящиков ещё `filterAliasRows(rows, accountFilter)`. Вид строки ящика: точка цвета ящика, имя, под ним адрес, без имени ящика-владельца, справа `unreadBadge` по `aliasUnreadCounts[aliasId]`. В свёрнутом виде - плитка 28 px с первой буквой имени, `title` = "имя - адрес". Контекстного меню и закрепления нет.
- Клик - `setSelectedAccount(accountId, 'INBOX', aliasId)`; если `folders[accountId]` нет, `api.getFolders(accountId)` как в `toggleAccount` (`:613`). У выбранной строки раскрыты "Входящие" (со счётчиком) и "Отправленные" -> `setSelectedAccount(accountId, aliasSentFolder(account, folders[accountId]), aliasId)`; пока `aliasSentFolder` даёт `null`, пункта "Отправленные" нет.
- Пока выбран алиас, ящик-владелец, его папки и избранное не активны: `const ownerSelectedId = selectedAliasId ? null : selectedAccountId` во всех проверках активности.
- Эффект закрытия шторки (`:374-377`) зависит и от `selectedAliasId`.

- [ ] **Step 1: падающие тесты:**
  - `the switch sits right under All inboxes and is hidden when no mailbox has an alias`
  - `with the mode on, alias rows follow the mailboxes, alphabetical across mailboxes, name above address`
  - `the mailbox's own address, a mail node and a disabled mailbox give no alias rows`
  - `clicking an alias opens its Inbox; Inbox and Sent show under it; the owner row and the owner's Inbox are not aria-current`
  - `Sent opens the owner's Sent folder for the alias, loading the owner's folders first`
  - `an alias row shows its unread count`
  - `the mailbox filter narrows alias rows by alias name and address`
  - `on a phone, choosing another alias of the same mailbox closes the drawer` (`matchMedia` с `matches: true`) - Review Focus 5
  - `switching the mode off removes the alias rows at once`
- [ ] **Step 2:** `node --test src/components/Sidebar.aliases.render.test.js` - FAIL. **Step 3:** реализация. **Step 4:** frontend `npm test`, `lint`, `build` зелёные.
- [ ] **Step 5:** `git commit -m "feat(ui): aliases as accounts in the sidebar"`

### Task 8: Список писем в ящике алиаса

**Files:**
- Modify: `frontend/src/components/MessageList.jsx`: `:164` (выбранный алиас), `:302` (`categorizationActive`), `:321-337` (счётчики категорий), четыре загрузки `:434-499`, `:503-537`, `:541-600`, `:724-750`, шапка `:2786-2806`, вкладки `:3413`
- Modify: `frontend/src/utils/threadedArchive.js:14-45` (`archiveViewKey`)
- Modify: locales (`messageList.aliasViewLabel` = "{{name}}: {{folder}}")
- Test: `frontend/src/components/MessageList.render.test.js`, `frontend/src/utils/threadedArchive.test.js`

**Interfaces:**
- Consumes: `messageListParams`, `aliasMailboxRows` (Task 5); `selectedAliasId`, `aliasUnreadCounts`, `setSelectedAccount` (Task 6); `isAliasGone` (`utils/aliasGone.js`); `reconcileAccounts` (`utils/accountsReconcile.js`).
- Produces: `archiveViewKey({ ..., selectedAliasId })`.

Поведение:
- Все четыре загрузки строят параметры через `messageListParams`; их эффекты и колбэки зависят от `selectedAliasId`.
- `categorizationActive = !selectedAliasId && (...)`; при выбранном алиасе панели вкладок (`:3413`) нет совсем, ни категорий, ни GTD.
- Шапка: `label` = `t('messageList.aliasViewLabel', { name, folder })`, где `folder` - `sidebar.aliases.inbox` или `sidebar.aliases.sent`; непрочитанные - `aliasUnreadCounts[aliasId]` во "Входящих", 0 в "Отправленных"; число писем - `total` ответа списка, снимки IMAP ящика не используются.
- Ответ списка 404 с `isAliasGone(err)` -> `setSelectedAccount(accountId, 'INBOX')` и `reconcileAccounts()`.
- Действия над письмами без изменений: это письма ящика-владельца.

- [ ] **Step 1: падающие тесты:**
  - `an alias Inbox asks for aliasId without category and shows no tabs even with categorization on` (шпион `api.getMessages`)
  - `load more and a page change keep aliasId`
  - `the header names the alias and shows its unread count`
  - `alias_gone from the list opens the owner's Inbox` - Review Focus 3
  - `archiveViewKey differs between an alias view and its owner's Inbox`
- [ ] **Step 2:** FAIL. **Step 3:** реализация. **Step 4:** frontend `npm test`, `lint`, `build` зелёные.
- [ ] **Step 5:** `git commit -m "feat(ui): message list of an alias mailbox"`

### Task 9: "От" при "Написать" и "Ответить" из ящика алиаса

**Files:**
- Modify: `frontend/src/components/Sidebar.jsx:1076`, `frontend/src/components/MessageList.jsx:3714`, `:4291`, `frontend/src/components/MailApp.jsx:688`
- Modify: `frontend/src/utils/composeFromMessage.js:39-60`, `frontend/src/components/MessageList.jsx:1367-1392` (`handleSwipeReply`) и `:2322`, `frontend/src/components/MessagePane.jsx:1196`
- Test: `frontend/src/utils/composeFromMessage.test.js`, `frontend/src/components/ComposeModal.render.test.js`

**Interfaces:**
- Consumes: `composeDataForView`, `viewReplyAliasId` (Task 5); `resolveInitialFrom` (`utils/defaultSender.js:84`), ступень 1 "алиас из запроса", без изменений.
- Produces: четыре кнопки и клавиша "Написать" открывают `openCompose(composeDataForView(useStore.getState()))`.
- Produces: `openReplyFromMessage(message, { ..., view = null })`, `view = { selectedAccountId, selectedAliasId }`; во всех трёх путях ответа `aliasId = viewReplyAliasId(message, view) ?? pickReplyAlias(...)`. "Переслать" не меняется.

- [ ] **Step 1: падающие тесты:**
  - `a reply from an alias view goes out from that alias even when the letter's addresses pick another` (вид "Отправленные" anna, письмо от anna к ivan: `pickReplyAlias` дал бы ivan, ожидается anna)
  - `a reply outside an alias view keeps pickReplyAlias`
  - ComposeModal: `compose opened from an alias view starts with From alias:<aliasId>:<accountId>` - провал 4 спеки
- [ ] **Step 2:** FAIL. **Step 3:** реализация. **Step 4:** frontend зелёный.
- [ ] **Step 5:** `git commit -m "feat(ui): compose and reply from an alias mailbox send from the alias"`

### Task 10: Руководство пользователя

**Files:**
- Modify: `docs/user-guide/README.md`: новый §4.5 "Алиасы как ящики" после §4.4 (`:164-170`), §5.2 (`:182-187`), §7.1 (`:354-378`)

- [ ] **Step 1:** по-русски, с плейсхолдерами: где переключатель и что он делает; режим хранится у пользователя и одинаков на любом компьютере; какие алиасы получают строку; "Входящие" алиаса - письма с его жёлтой плашкой, одно письмо у одного алиаса, все категории без вкладок; "Отправленные" - письма с его адреса; действия над письмом те же, что в ящике; раскрытая переписка показывает всю цепочку, как в ящике; "Написать" и "Ответить" ставят "От" = алиас, "Переслать" как раньше; ограничения: Bcc без Delivered-To, отправленные с неполным конвертом, поиск ищет по папке ящика-владельца.
- [ ] **Step 2:** `git commit -m "docs: aliases as accounts in the user guide"`

### Task 11: Итоговая проверка и PR

- [ ] **Step 1:** `cd backend && npm ci && npm test && npm run lint && npm run lint:plugins` - зелёное.
- [ ] **Step 2:** `cd frontend && npm ci && npm test && npm run lint && npm run build` - зелёное.
- [ ] **Step 3:** `git push -u origin feat/aliases-as-accounts`, PR против `main` со ссылкой на спеку, дождаться зелёного CI.
- [ ] **Step 4:** отчёт руководителю: PR, коммиты, тесты, sha образа после мержа. Мерж и раскатку без "да" владельца не делать.

Живая проверка после раскатки (руководитель, на <PANEL_HOST>): включить режим - 79 строк алиасов; у `name_surname@` во "Входящих" письма клиента и только с плашкой name_surname; "Отправленные" - тестовые письма с него; ответ уходит с `Name Surname <name_surname@example.com>`; перезагрузка и вход из другого браузера - режим на месте; "Входящие" алиаса у `team@` открываются не дольше "Входящих" самого ящика.
