# Импорт алиасов Gmail (send-as): план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** панель сама держит алиасы Gmail-ящика в `account_aliases` по send-as из Gmail, показывает в списке писем плашку алиаса-получателя и отказывает в отправке с пропавшего алиаса.

**Architecture:** чистая функция планирует изменения по ответу `users.settings.sendAs.list`, сервис применяет их в транзакции под блокировкой ящика. Запускается заданием очереди (раз в час и после подключения Google) и синхронно по кнопке. Фронтенд выбирает адрес плашки той же функцией, что и алиас для ответа.

**Tech Stack:** Node.js + Express + PostgreSQL (vitest, pglite), React (node --test, JSDOM), очередь `services/jobQueue.js`.

**Spec:** `docs/superpowers/specs/2026-11-05-gmail-send-as-import-design.md`.

## Global Constraints

- Ветка `feat/gmail-send-as-import` от `main` @ 78895951, PR в wyrtensi/MailExpert, мерж только при зелёном CI. Conventional Commits, код/комменты/PR на английском, доки на русском.
- TDD: сначала падающий тест. Существующие тесты не ослаблять. Новых зависимостей не нужно.
- Миграция только вперёд: `backend/migrations/0100_gmail_send_as.sql`.
- Источник истины - Gmail: импортированный алиас (`source = 'gmail'`) правится только синхронизацией.
- Берём send-as с `verificationStatus === 'accepted'` и `isPrimary !== true`.
- Строки `account_aliases` с `email` = адрес ящика (второе имя отправителя, `utils/senderNames.js:67`) синхронизация не трогает никогда.
- Ошибка чтения из Google не меняет алиасы.
- Токены не попадают в логи, ответы API, тексты ошибок, audit `details`.
- Новые строки интерфейса в `frontend/src/locales/en.json` и `ru.json` с одинаковыми ключами; новый путь в `api.js` - ответ в `frontend/src/demo/index.js` (иначе падает `demo/routeCoverage.test.js`).
- Backend: `cd backend && npm test && npm run lint && npm run lint:plugins`. Frontend: `cd frontend && npm test && npm run lint && npm run build`.
- Стенд <PANEL_HOST> - не в этом плане: раскатка отдельно, через `mailexpert-rollout`, после "да" владельца.

## Review Focus

1. Gmail отдаёт адрес в другом регистре (`JSmith@example.com`), а в панели он записан строчными - это тот же алиас, без дубля и без удаления (тест в Task 2).
2. Кнопка и часовое задание запустили синхронизацию одного ящика одновременно - дублей нет (тест в Task 3).
3. Ящик в состоянии "нужно переподключить" - синхронизация тихо пропускает его, алиасы на месте, задание не уходит в retry по кругу (тест в Task 3).
4. Ответ Google без поля `sendAs` или с HTTP 5xx/429 - алиасы не меняются, задание повторяется (тесты в Task 2 и Task 4).
5. Алиас пропал из Gmail, пока открыт черновик с ним в "От" - отправка и сохранение черновика отклоняются, а не уходят с основного адреса (тест в Task 6).

---

### Task 0: Ветка и документы

**Files:**
- Create: `docs/superpowers/specs/2026-11-05-gmail-send-as-import-design.md` (копия спеки из вольта)
- Create: `docs/superpowers/plans/2026-11-05-gmail-send-as-import.md` (этот план)

- [ ] **Step 1:** `git switch -c feat/gmail-send-as-import origin/main`
- [ ] **Step 2:** скопировать оба документа, `git commit -m "docs: gmail send-as import design and plan"`

### Task 1: Источник алиаса и защита импортированных

**Files:**
- Create: `backend/migrations/0100_gmail_send_as.sql`
- Modify: `backend/src/services/accountAliases.js`
- Modify: `backend/src/routes/accounts.js:69-81` (SELECT алиасов), `:48-62` (SELECT ящиков)
- Test: `backend/src/services/accountAliases.pglite.test.js` (создать)

**Interfaces:**
- Produces: колонки `account_aliases.source VARCHAR(16) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','gmail'))`, `email_accounts.gmail_send_as_synced_at TIMESTAMPTZ NULL`; уникальный индекс `idx_account_aliases_gmail_email ON account_aliases (account_id, lower(email)) WHERE source = 'gmail'`.
- Produces: `ALIAS_ERRORS.alias_managed_by_gmail = [409, 'This alias is synced from Gmail: change it in Gmail']`; `listAliases` возвращает `source`.

- [ ] **Step 1: падающие тесты** в `accountAliases.pglite.test.js` (setup как в `services/accountReceived.pglite.test.js`, `createRealSchemaDb`):
  - `updateAlias on a gmail alias returns { error: 'alias_managed_by_gmail' } and keeps the row unchanged`
  - `deleteAlias on a gmail alias returns { error: 'alias_managed_by_gmail' } and keeps the row`
  - `createAlias stores source 'manual'; listAliases returns source`
  - `unique index refuses a second gmail alias with the same email in another case for the same account`
- [ ] **Step 2:** `cd backend && npx vitest run src/services/accountAliases.pglite.test.js` - FAIL (нет колонки).
- [ ] **Step 3:** миграция; в `updateAlias`/`deleteAlias` проверка `source = 'gmail'` до изменения; `source` в SELECT `listAliases` и в `routes/accounts.js:73`; `gmail_send_as_synced_at` в SELECT ящиков.
- [ ] **Step 4:** тест PASS, весь `npm test` backend зелёный.
- [ ] **Step 5:** `git commit -m "feat(aliases): mark alias source and protect gmail-synced aliases"`

### Task 2: Чтение send-as и план изменений

**Files:**
- Create: `backend/src/services/gmailSendAs.js`
- Test: `backend/src/services/gmailSendAs.test.js`

**Interfaces:**
- Produces: `GMAIL_SEND_AS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs'`
- Produces: `fetchGmailSendAs({ accessToken, signal }) -> Promise<Array<{ sendAsEmail, displayName, replyToAddress, signature, isPrimary, verificationStatus }>>`. Бросает `GmailSendAsError` с `.status` (HTTP-код или `null` при сетевой ошибке) и `.code` (`unauthorized` для 401, `rate_limited` для 429, `upstream` для 5xx/сети, `bad_response` если в JSON нет массива `sendAs`). В сообщении ошибки нет токена.
- Produces: `planSendAsSync({ accountEmail, existing, sendAs }) -> { create: Fields[], update: Array<{ id, fields: Fields }>, adopt: Array<{ id, fields: Fields }>, remove: string[] }`, где `Fields = { name, email, reply_to, signature }`, `existing` - строки `account_aliases` ящика (`id, name, email, reply_to, signature, source`).

Правила `planSendAsSync` (сравнение адресов в нижнем регистре):
- кандидаты = `sendAs` с `verificationStatus === 'accepted'`, без `isPrimary`, без адреса ящика;
- `name` = `displayName.trim()` или локальная часть адреса; `email` - как в Gmail; `reply_to` = `replyToAddress || null`; `signature` = `sanitizeSignature(signature) || null`;
- кандидат совпал с `gmail`-строкой: `update`, только если поля отличаются;
- кандидат совпал с `manual`-строкой (не адрес ящика): `adopt` (строка становится `gmail`, `id` сохраняется);
- нет совпадения: `create`;
- `gmail`-строка без кандидата: `remove`.

- [ ] **Step 1: падающие тесты** (мок `global.fetch` как в `gmailApiSender.test.js:164-172`):
  - `fetchGmailSendAs sends Bearer token and returns sendAs array`
  - `fetchGmailSendAs maps 401/429/503 to codes unauthorized/rate_limited/upstream`
  - `fetchGmailSendAs throws bad_response when sendAs is missing`; `returns [] for { sendAs: [] }`
  - `planSendAsSync skips primary, pending and the mailbox address`
  - `planSendAsSync treats JSmith@ and jsmith@ as the same alias` (Review Focus 1)
  - `planSendAsSync updates only changed gmail rows, adopts matching manual rows, removes vanished gmail rows, never touches other manual rows`
  - `planSendAsSync falls back to local part when displayName is blank`
- [ ] **Step 2:** `npx vitest run src/services/gmailSendAs.test.js` - FAIL.
- [ ] **Step 3:** реализация.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** `git commit -m "feat(gmail): read send-as list and plan alias sync"`

### Task 3: Применение синхронизации

**Files:**
- Modify: `backend/src/services/gmailSendAs.js`
- Modify: `backend/src/services/auditLog.js:23-51` (`AUDIT_ACTIONS`)
- Test: `backend/src/services/gmailSendAs.pglite.test.js`

**Interfaces:**
- Consumes: `ensureFreshOAuthAccount(account, { force })`, `OAuthTokenError` (`services/oauth/tokenManager.js`), `decrypt` (`services/encryption.js`), `PROVIDER_FETCH_TIMEOUT_MS` (`services/oauth/constants.js`), `insertAuditEntries` (`services/auditLog.js:118`).
- Produces: `syncGmailSendAs(accountId, { actor = null } = {}) -> Promise<{ status: 'synced', added, updated, removed, syncedAt } | { status: 'skipped', reason: 'not_google' | 'reconnect_required' | 'not_found' }>`. Ошибки `GmailSendAsError` пробрасывает.
- Produces: audit action `mailbox.aliases_synced`, `details = { added: string[], updated: string[], removed: string[] }` (адреса), пишется только если есть изменения.

Поведение:
- ящик не найден / `oauth_provider !== 'google'` / `oauth_reconnect_required` → `skipped` без запросов в Google; `OAuthTokenError('oauth_reconnect_required')` из `ensureFreshOAuthAccount` → тоже `skipped`;
- 401 → один повтор с `ensureFreshOAuthAccount(account, { force: true })`;
- таймаут запроса `PROVIDER_FETCH_TIMEOUT_MS` через `AbortController`;
- после ответа Google: транзакция, `SELECT ... FROM email_accounts WHERE id = $1 FOR UPDATE`, перечитать алиасы, `planSendAsSync`, применить (update/adopt по `id`, insert с `source = 'gmail'`, delete), `gmail_send_as_synced_at = NOW()`, audit через `insertAuditEntries` в той же транзакции;
- при изменениях после коммита - `pluginRegistry.runHook('onAccountIdentityChanged', { accountId })` (как `identityChanged` в `routes/accounts.js`).

- [ ] **Step 1: падающие тесты** (pglite + `vi.mock('./oauth/tokenManager.js')` как в `mailSendTransport.test.js:7-8`, мок `fetch`):
  - `creates gmail aliases from send-as and sets gmail_send_as_synced_at`
  - `second run with the same send-as changes nothing and writes no audit`
  - `removes a vanished gmail alias, keeps manual aliases and the second sender name row`
  - `keeps alias ids on update`
  - `skips reconnect_required account without calling fetch` (Review Focus 3)
  - `retries once with force refresh on 401`
  - `upstream error leaves aliases untouched` (Review Focus 4)
  - `two concurrent syncs of one account produce no duplicate aliases` (Review Focus 2: `Promise.all` двух вызовов)
- [ ] **Step 2:** FAIL. **Step 3:** реализация. **Step 4:** PASS, весь backend зелёный.
- [ ] **Step 5:** `git commit -m "feat(gmail): apply send-as alias sync with audit"`

### Task 4: Задание очереди, часовой обход, запуск после подключения

**Files:**
- Create: `backend/src/services/gmailSendAsJobs.js`
- Modify: `backend/src/index.js:282-302` (регистрация), `:349` (старт), `:404` (стоп)
- Modify: `backend/src/routes/oauthGoogle.js` (после `reconnectAccount(account, result)` в `/callback`)
- Test: `backend/src/services/gmailSendAsJobs.test.js`

**Interfaces:**
- Consumes: `syncGmailSendAs`, `GmailSendAsError` (Task 3, 2); `registerJobKind`, `enqueueJob`, `JobError` (`services/jobQueue.js`).
- Produces: `GMAIL_SEND_AS_SYNC_KIND = 'gmail_send_as_sync'`; `registerGmailSendAsJobKind()`; `enqueueGmailSendAsSync(accountId, { reason: 'connect' | 'poll', now = Date.now() }) -> Promise<{ job, created }>`; `startGmailSendAsPoll()`, `stopGmailSendAsPoll()`.

Поведение:
- handler: `syncGmailSendAs(job.accountId)`; `GmailSendAsError` с `rate_limited`/`upstream`/`unauthorized` → `JobError(..., { outcome: 'retry' })`; `bad_response` → `outcome: 'fail'`; `skipped` - успешное завершение;
- `dedupeKey`: для `poll` - `` `${accountId}:slot-${Math.floor(now / GMAIL_SEND_AS_POLL_MS)}` ``, для `connect` - `` `${accountId}:connect-${now}` ``; `GMAIL_SEND_AS_POLL_MS = 60 * 60 * 1000`;
- обход: как `startTenantPoll` (`services/tenant/tenantJobs.js:415-470`) - `setTimeout` первого прогона через 2 минуты + `setInterval` раз в час, оба `.unref()`; тик выбирает `id` ящиков `oauth_provider = 'google' AND oauth_reconnect_required = false` и ставит `enqueueGmailSendAsSync(id, { reason: 'poll' })`;
- OAuth callback: `enqueueGmailSendAsSync(account.id, { reason: 'connect' })` без `await` на результат синхронизации, ошибка постановки - в лог, на редирект не влияет.

- [ ] **Step 1: падающие тесты:**
  - `poll enqueues one job per google account per hour slot` (два тика в одном часу → один job на ящик)
  - `handler maps rate_limited and upstream to retry, bad_response to fail, skipped to success` (Review Focus 4)
  - `connect reason always creates a new job`
- [ ] **Step 2:** FAIL. **Step 3:** реализация + подключение в `index.js` и `oauthGoogle.js`. **Step 4:** PASS, backend зелёный.
- [ ] **Step 5:** `git commit -m "feat(gmail): hourly and on-connect send-as sync jobs"`

### Task 5: Кнопка синхронизации в API

**Files:**
- Modify: `backend/src/routes/accounts.js` (рядом с alias CRUD, `:479-521`)
- Modify: `frontend/src/utils/api.js:548-551`
- Modify: `frontend/src/demo/index.js:2123-2156`
- Test: `backend/src/routes/accounts.aliasSync.test.js`, существующий `frontend/src/demo/routeCoverage.test.js`

**Interfaces:**
- Produces: `POST /api/accounts/:id/aliases/sync-gmail` → 200 `{ added, updated, removed, synced_at, aliases }` (свежий `listAliases`); `skipped` → 409 `{ error, code: 'not_google' | 'reconnect_required' }`, `not_found` → 404; `GmailSendAsError` → 502 `{ error: 'Gmail did not answer, try later', code: 'gmail_unavailable' }`. Доступ - как у остальных alias-роутов (`requireAuth`, без `requireAdmin`): решение руководителя, сотрудник может подключать Gmail сам. Актор для audit - пользователь сессии.
- Produces: `api.syncGmailAliases(accountId)`.
- Produces: демо-ответ для `POST /accounts/:id/aliases/sync-gmail` - `{ added: [], updated: [], removed: [], synced_at: <now>, aliases: <текущие> }`.

- [ ] **Step 1:** падающие тесты роута (мок `syncGmailSendAs`): 200 с результатом, 409 для `reconnect_required`, 502 без текста ошибки Google в ответе.
- [ ] **Step 2:** FAIL. **Step 3:** реализация. **Step 4:** backend и frontend `npm test` зелёные (включая routeCoverage).
- [ ] **Step 5:** `git commit -m "feat(aliases): sync-gmail endpoint"`

### Task 6: Отказ при пропавшем алиасе

**Files:**
- Modify: `backend/src/routes/send.js:193-218`, `backend/src/routes/draft.js:57-67`
- Modify: компонент окна письма, где показываются ошибки отправки (`frontend/src/components/ComposeModal.jsx`)
- Test: существующие `send*.test.js` / `draft*.test.js` в `backend/src/routes/` - добавить кейсы

**Interfaces:**
- Produces: `aliasId` передан, строки нет → 409 `{ error: 'The sender alias no longer exists: choose From again', code: 'alias_gone' }` и в `send.js`, и в `buildRawDraft` (`draft.js`).
- Produces: в окне письма по `code === 'alias_gone'` - текст `compose.aliasGone` ("Этот алиас удалён. Выберите «От» заново.") и перезагрузка списка ящиков.

- [ ] **Step 1:** падающие тесты: `send with unknown aliasId returns 409 alias_gone and sends nothing`, `draft save with unknown aliasId returns 409 alias_gone` (Review Focus 5).
- [ ] **Step 2:** FAIL. **Step 3:** реализация. **Step 4:** PASS, оба пакета зелёные.
- [ ] **Step 5:** `git commit -m "fix(send): refuse a vanished sender alias instead of sending as the mailbox"`

### Task 7: Алиасы Gmail в настройках ящика

**Files:**
- Modify: `frontend/src/components/AdminPanel.jsx` (`AccountsTab`, подвид `aliases`, `:916-1117`)
- Modify: `frontend/src/locales/en.json`, `ru.json` (`admin.aliases.*`)
- Test: `frontend/src/components/AccountsTab.render.test.js`

**Interfaces:**
- Consumes: `api.syncGmailAliases` (Task 5), `alias.source`, `account.gmail_send_as_synced_at`, `account.oauth_provider`.
- Produces: ключи `admin.aliases.syncGmail` ("Обновить алиасы из Gmail"), `admin.aliases.syncing`, `admin.aliases.syncResult` ("Добавлено {{added}}, обновлено {{updated}}, удалено {{removed}}"), `admin.aliases.syncedAt` ("Синхронизировано из Gmail: {{date}}"), `admin.aliases.gmailManaged` ("Синхронизируется из Gmail, правьте в Gmail"), `admin.aliases.syncError`.

- [ ] **Step 1: падающие тесты:**
  - `google mailbox shows the sync button; non-google does not`
  - `gmail alias row has no edit and delete buttons and shows the gmail-managed note; manual alias keeps them`
  - `pressing sync calls syncGmailAliases, shows the result and replaces the alias list`
- [ ] **Step 2:** FAIL. **Step 3:** реализация (после синка - `updateAccount(id, { aliases, gmail_send_as_synced_at })`, как после `handleAliasSave`). **Step 4:** frontend `npm test`, `lint`, `build` зелёные.
- [ ] **Step 5:** `git commit -m "feat(ui): gmail-synced aliases in mailbox settings"`

### Task 8: Плашка алиаса в списке писем

**Files:**
- Modify: `frontend/src/utils/replyAlias.js`
- Create: `frontend/src/components/RecipientAliasBadge.jsx`
- Modify: `frontend/src/components/MessageList.jsx` (`ThreadRow` `:4711-4728` и `:4832-4845`, `MessageRow` `:5050-5076`)
- Modify: locales (`message.recipientAlias` = "на {{address}}")
- Test: `frontend/src/utils/replyAlias.test.js`, `frontend/src/components/MessageList.render.test.js`

**Interfaces:**
- Produces: `matchReplyAlias({ aliases, deliveryAddresses, toAddresses, ccAddresses, fromEmail, accountEmail, mailNode }) -> alias | null` - текущий алгоритм `pickReplyAlias`, но возвращает объект; `pickReplyAlias(args)` = `matchReplyAlias(args)?.id ?? null` (поведение не меняется).
- Produces: `recipientAliasFor(message, account) -> string | null`: `null`, если нет `account`, ящик узла, письмо исходящее (`mailboxBanner(message, account).direction !== 'in'`); иначе `matchReplyAlias` по полям письма (`delivery_addresses`, `to_addresses`, `cc_addresses`, `from_email`, `account.aliases`, `account.email_address`, `account.mail_node`), результат - `alias.email`.
- Produces: `<RecipientAliasBadge address compact />` - пилюля в стиле `DirectionBadge`; в `compact` - локальная часть адреса, полный адрес в `title` и `aria-label`.

- [ ] **Step 1: падающие тесты:**
  - `pickReplyAlias returns the same ids as before` (существующие кейсы остаются, плюс `matchReplyAlias returns the alias object`)
  - `recipientAliasFor returns the alias email for an incoming letter addressed to it in To or Cc`
  - `recipientAliasFor returns null for the mailbox's own address, an outgoing letter, an address that is not a current alias, a node mailbox`
  - `recipientAliasFor and pickReplyAlias agree on the same message` (одна фикстура, `recipientAliasFor(...) === aliases.find(a => a.id === pickReplyAlias(...)).email`)
  - render: `message row shows the recipient alias badge for a letter to an alias; none for a letter to the mailbox itself`
- [ ] **Step 2:** FAIL. **Step 3:** реализация, плашка рядом с `DirectionBadge` во всех трёх местах. **Step 4:** frontend зелёный.
- [ ] **Step 5:** `git commit -m "feat(ui): recipient alias badge in the message list"`

### Task 9: Документация

**Files:**
- Modify: `docs/user-guide/README.md` §7.1 (`:354-364`), §12.1 (`:598-600`)
- Modify: `docs/architecture/job-queue.md` (новый раздел о `gmail_send_as_sync` после `:231`)
- Modify: `docs/operations/google-oauth.md` (после `:250`: send-as читаются тем же токеном, повторного согласия нет)
- Modify: `docs/operations/cli.md:187-195` (вид задания в списке `jobs list --kind`)

- [ ] **Step 1:** по-русски: что синхронизируется и когда, что импортированные алиасы только для чтения, плашка, ограничение Bcc, отказ `alias_gone`.
- [ ] **Step 2:** `git commit -m "docs: gmail send-as alias sync"`

### Task 10: Итоговая проверка и PR

- [ ] **Step 1:** `cd backend && npm ci && npm test && npm run lint && npm run lint:plugins` - всё зелёное.
- [ ] **Step 2:** `cd frontend && npm ci && npm test && npm run lint && npm run build` - всё зелёное.
- [ ] **Step 3:** `git push -u origin feat/gmail-send-as-import`, PR против `main` с описанием и ссылкой на спеку; дождаться зелёного CI.
- [ ] **Step 4:** отчёт руководителю: ссылка на PR, коммиты, тесты, sha образа после мержа. Мерж и раскатку на стенд не делать без "да" владельца.

Живая проверка после раскатки (делает руководитель): у `team@` 23 алиаса с именами; письмо на алиас в списке с плашкой; "Ответить" открывает "От" = `Имя Фамилия <алиас@example.com>`; тестовое письмо наружу пришло с алиаса, From не переписан.
