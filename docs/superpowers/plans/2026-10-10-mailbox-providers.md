# Mailbox Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подключать общие командные ящики через восемь понятных плиток в отдельном диалоге, с минимальной формой и доступным сотрудникам расширенным режимом.

**Architecture:** Каталог фиксированных IMAP-провайдеров и единая проверка подключения используют существующие ImapFlow, Nodemailer, сетевую политику и шифрование. Proton Free обслуживает отдельный worker с проверенным Bridge и закрытым UNIX socket; Gmail и почтовый узел сохраняют свои потоки. Диалог на уровне MailApp имеет два экрана — выбор и подключение; настройки сохраняют подробности и поиск.

**Tech Stack:** Node.js 24, Express 5, PostgreSQL, Redis, React 19, Zustand, существующие Vitest/node:test/JSDOM; Docker Compose, Bash/bats, Python unittest и native gRPC внутри нового worker.

**Spec:** [2026-10-10-mailbox-providers-design.md](../specs/2026-10-10-mailbox-providers-design.md). Исполнитель читает спецификацию и AGENTS.md перед этим планом.

## Global Constraints

- Все восемь вариантов подключения, включая ручной «Другой», доступны всем одобренным сотрудникам установки.
- Подключённые ящики общие для команды, как остальные ящики MailExpert.
- Порядок плиток: «Наш ящик», Gmail, Proton, Yahoo, Яндекс, Mail.ru, iCloud, «Другой».
- IMAP/SMTP параметры скрыты по умолчанию; у каждого сервиса есть свёрнутый расширенный режим.
- Сверху слева на экране подключения — «Назад» к выбору сервисов; сетка и форма не показываются одновременно.
- Проверка подключения не отправляет письма: IMAP connect/AUTH/LIST/logout, SMTP verify без MAIL FROM/DATA.
- До 15 секунд на каждый протокол, общий бюджет 35 секунд; ресурсы закрываются при отмене, таймауте и отказе.
- Проверка TLS включена; управляемый Proton использует loopback IMAP SSL 1993 и SMTP SSL 1465 с доверием только его публичному сертификату.
- Bridge: `mnixry/proton-bridge`, коммит `eabe5b282e4b07a4fc720233fb85ddb4ab335b7f`; исходники Bridge не изменяются, Docker socket backend/worker не получают.
- Connection ID живёт 10 минут; основной пароль Proton не сохраняется после native вызова.
- Сетка: четыре колонки на широком диалоге, две на узком; максимальная ширина 760 px, высота ограничена `100dvh`, touch targets не меньше 44 × 44 px.
- Проверить 320/390/768/1440 px, обе темы, русский/английский; использовать существующие CSS variables и ручные стили.
- Все новые строки — en/ru с одинаковыми ключами; demo реализует новые API состояния без реальных соединений.
- `data/` не читать и исключать из поиска; не трогать исходный грязный checkout, чужие compose-проекты и mailcow.
- Коммиты/код/комментарии — English, документация — русский; автор `wyrtensi`, без Codex co-author и реальных адресов в документах.
- Новые миграции только forward-only. Зависимости нового worker фиксируются с проверкой advisories; существующие npm зависимости не обновлять.
- Установка/обновление только штатным rollout; согласование этого плана не заменяет отдельное согласование обновления стенда с миграцией.

## Review Focus

1. Разный регистр и пробелы в одном адресе, одновременно добавленном разными потоками: одна новая запись; прежние дубли не удаляются автоматически (задача 3).
2. Сотрудник раскрыл расширенный режим и поменял сервер пресета: применяется ручная политика, метка сервиса не даёт права на внутренний Bridge/OAuth (задачи 3, 11).
3. «Назад» или закрытие в момент успешного ответа/OAuth callback: секреты очищены, закрытая форма не воскресает, созданный ящик виден (задача 10).
4. Два адреса одного Proton user ID и устаревший cleanup после повторного входа: удаление одного ящика не отключает оставшиеся (задача 8).
5. Старый backup, потерянный worker state или новое поколение сертификата: другие ящики работают; Proton получает понятное состояние восстановления без отключения TLS (задачи 7, 9).

## File Structure

Новые backend units живут в `backend/src/services/accounts/` (каталог, проверка, сохранение) и `backend/src/services/proton/` (worker client, операции, доверие, lifecycle). Роуты остаются тонкими. `imapManager.js` меняется только в существующих точках выбора endpoints/TLS и создания папок.

Новые UI units живут в `frontend/src/components/addAccount/`: `ProviderPicker`, `ProviderIcon`, `ImapProviderAddForm`, `ManualAccountAddForm`, `ProtonAddForm`, `AdvancedConnectionFields`, `AppPasswordHelp`; оболочка — `components/AddAccountDialog.jsx`. Текущие `GmailAddForm` и `DomainMailboxAddForm` переиспользуются. Pure navigation/payload logic — `utils/addAccountFlow.js` и `utils/providerConnection.js`. AdminPanel сохраняет текущий AccountForm для редактирования.

Worker: `deploy/proton-worker/{Dockerfile,entrypoint.sh,bridge-version,requirements.in,requirements.lock,worker.py,controller.py,native.py,tests/}`. Файл `bridge-version` содержит полный SHA, `native.py` единственный знает native protobuf; generated bindings создаются из proto именно этого SHA при сборке. `scripts/deploy/lib/proton.sh` отвечает за host lifecycle/snapshot, а не за вход в аккаунт.

Каждая задача ниже включает свой цикл тест → ожидаемое падение → реализация → успешная проверка → commit. Команды запускаются из соответствующего `backend/`, `frontend/` или корня worktree. Перед первым тестом установить существующие зависимости через `npm ci` в обоих пакетах; их lockfiles не менять. Для Python использовать тестовый образ worker, а не переустанавливать Python на машине пользователя. На Windows backend TLS fixtures используют существующий OpenSSL из Git: добавить `C:/Program Files/Git/usr/bin` в PATH только тестового процесса. Preflight 14 задач/91 пары и rulings: ignored `.superpowers/sdd/2026-10-10-mailbox-providers/restudy-revision-report.md`; evidence: `docs/audits/2026-10-10-mailbox-providers-restudy.md`.

### Task 0: Ограничить i18n baseline scan исходниками

**Files:** Modify `frontend/src/locales/i18n.test.js` только source roots в `scanHardcodedStrings`, `loadSourceText`, `loadLiteralSourceTranslationKeys`.

**Interfaces:** Три сканера используют `resolve(dir, '..')`, то есть `frontend/src`, как существующий `loadSourceTranslationCalls`. Все assertions, source coverage, unused/hardcoded checks и SAME_VALUE_ALLOWED сохраняются. Task 11 позднее добавляет только обоснованные brand exceptions.

- [ ] **1. Проверить baseline и причину:** полные suites уже PASS; frontend занял 310708 ms из-за overbroad scan frontend root. Подтвердить исходные roots и предназначение source scanners; это correction области сканирования, не исправление failing assertion.
- [ ] **2. Исправить три roots** непосредственно на src; не добавлять whitelists, dependency exclusions, monkey-patches или менять assertions.
- [ ] **3. Проверить:** `node --test src/locales/i18n.test.js`, затем frontend `npm test`; ожидается exit 0 с прежними проверками. Отдельный reviewer подтверждает source-only scope и отсутствие ослабления assertions.
- [ ] **4. Commit:** `test: scope locale source scans to frontend source` от wyrtensi. Обновить ledger только после проверки/review.

### Task 1: Каталог и схема управляемых связей

**Files:** Create `backend/migrations/0099_mailbox_providers.sql`, `backend/src/services/accounts/providerCatalog.js`, `providerCatalog.test.js`, `providerMigration.pglite.test.js`; Modify `backend/src/services/accounts/manualAccounts.js` (SAFE_FIELDS). Номер 0099 занять только если перед реализацией он всё ещё свободен.

**Interfaces:** `getImapProvider(id) -> Provider | null`; `publicProviderCatalog() -> ProviderMetadata[]`. Provider: `{id, imap:{host,port,tls}, smtp:{host,port,tls}, appPasswordUrl, publicDomains, loginAlternatives}`. ProviderMetadata исключает secrets и содержит defaults для расширенной формы. SafeAccount добавляет `mail_provider`, `connection_mode`, nullable `imap_tls_mode` и рассчитанную для actor capability `can_reconnect_proton`; никакая таблица Proton не сериализуется автоматически.

**Уточнение после повторного изучения:** миграция добавляет nullable `imap_tls_mode CHECK IN ('implicit','starttls')`; NULL сохраняет legacy поведение. Новые employee records всегда имеют explicit mode. Добавить `backend/src/routes/accounts.js` GET explicit SELECT и его safe-response tests в список файлов: SAFE_FIELDS одного недостаточно. Capability reconnect вычисляется по `proton_users.creator_user_id`/admin, не выдаёт creator secrets. Step 1 дополнить tests `legacy_null_tls_mode_preserved`, `explicit_mode_roundtrips_safe_list`, `proton_actor_request_unique`, `reconnect_target_is_durable`; step 4 включает `src/routes/accounts.shared.test.js`.

- [ ] **1. Написать тесты** `catalog_has_four_exact_presets`, `migration_preserves_legacy_accounts`, `safe_account_excludes_managed_credentials`. Точные утверждения:
  ```js
  expect(getImapProvider('mailru').imap.host).toBe('imap.mail.ru');
  expect(getImapProvider('yandex').appPasswordUrl).toBe('https://id.yandex.ru/security/app-passwords');
  expect(getImapProvider('proton')).toBeNull();
  expect(JSON.stringify(safeAccount(row))).not.toContain('secret-sentinel');
  ```
  Значения остальных пресетов/доменов сверить с таблицей спецификации; migration test прогоняет все предыдущие миграции и повторный startup.
- [ ] **2. RED:** `npx vitest run src/services/accounts/providerCatalog.test.js src/services/accounts/providerMigration.pglite.test.js`; ожидается FAIL новых assertions/отсутствующего модуля, не ошибка окружения.
- [ ] **3. Реализовать каталог и миграцию.** `mail_provider` nullable enum/check с `gmail,microsoft,domain,proton,yahoo,yandex,mailru,icloud,other`; `connection_mode` — `preset|manual|managed`, default manual. Backfill OAuth/узла из существующих признаков; ручной Proton автоматически не усыновлять. Таблицы: `proton_users(user_id PK,generation UUID,creator_user_id,cleanup_pending,removal_state)`, `proton_mailbox_links(account_id FK CASCADE,user_id FK,generation,certificate_pem,certificate_fingerprint,tls_servername)`, `proton_connections(id UUID PK,actor_user_id,request_id UUID,requested_email,user_id,state,account_id,reconnect_account_id FK,reconnect_intent boolean,error_code,expires_at)` с unique `(actor_user_id,request_id)`; reconnect intent и target account сохраняются до native login. Idempotency результатов других форм: `account_creation_requests(actor_user_id,request_id UUID,requested_email,provider,mode,account_id FK SET NULL,result_code,expires_at)` с unique actor/request_id и TTL 10 минут. Никаких полей основного пароля/OTP или хеша credentials; failed/expired operation записи удаляются после TTL, успешная mailbox связь долговечна.
- [ ] **4. GREEN:** повторить команду; PASS, существующие записи/credentials не изменились, `safeAccount` показывает только безопасные метаданные.
- [ ] **5. Commit:** `feat: add mailbox provider catalog and managed links`.

### Task 2: Ограниченная проверка IMAP и SMTP

**Files:** Create `backend/src/services/accounts/connectionProbe.js`, `connectionProbe.test.js`, `smtpProbeProcess.js`, `smtpProbeChild.js`, `smtpProbeProcess.test.js`, `connectionErrors.js`, `connectionErrors.test.js`. Existing `services/smtpTransport.test.js` runs as a regression check; send transport is not extended for probes.

**Interfaces:** `probeConnection(candidate,{signal,protocolTimeoutMs=15000,totalTimeoutMs=35000,resolveEndpoint}) -> Promise<{imapLogin,smtpLogin}>`, throws secret-free ConnectionError `{code,protocol}`. Candidate содержит серверы/TLS и credentials только в памяти. Необязательный `resolveEndpoint(candidate,protocol,{signal})` — доверенная серверная функция, не поле HTTP input; default проверяет policy/DNS. Это точка подключения managed endpoint задачи 6. `probeSmtpInChild(candidate,endpoint,{signal,timeoutMs}) -> Promise<void>` использует отдельный Node child process, private IPC и публичный Nodemailer API; send transport не меняется.

**Уточнение после повторного изучения:** DNS входит в общий бюджет; empty answers fail closed, late DNS completion after abort не создаёт клиента/process. Порты integer 1..65535 проверяются всегда, allow-list — только если policy запрещает nonstandard ports. IMAP starttls задаёт `doSTARTTLS:true`, `rejectUnauthorized:true`; implicit задаёт secure TLS. Step 1 добавить `smtp_force_auth_requires_auth`, `stalled_child_is_reaped_on_abort_and_success`, `empty_dns_never_spawns_client`, `late_dns_after_abort_never_spawns_client`, `starttls_cannot_downgrade`, `ports_validate_with_relaxed_policy`; steps 2/4 дополнить `src/services/accounts/smtpProbeProcess.test.js`. Проверка cancel требует реального child/socket fixture, одного mock close недостаточно.

- [ ] **1. Написать тесты** `probe_checks_auth_and_list_without_sending`, `smtp_failure_leaves_no_success`, `abort_closes_both_clients`, `budget_includes_dns_and_auth`, `auth_fallback_runs_once_only_after_auth_rejection`. Assertions:
  ```js
  expect(imap.list).toHaveBeenCalledOnce();
  expect(smtp.verify).toHaveBeenCalledOnce();
  expect(smtp.sendMail).not.toHaveBeenCalled();
  expect(error).toMatchObject({ code: 'smtp_auth_failed', protocol: 'smtp' });
  expect(JSON.stringify(error)).not.toContain('secret-sentinel');
  ```
  Fake clocks проверяют 15 000/35 000 ms, stalled LIST и DNS; разрешение публичного хоста фиксирует проверенные адреса/SNI. iCloud и Яндекс могут вернуть разные успешные IMAP/SMTP логины; не объединять их без проверки.
- [ ] **2. RED:** `npx vitest run src/services/accounts/connectionProbe.test.js src/services/accounts/connectionErrors.test.js src/services/smtpTransport.test.js`; новые тесты FAIL.
- [ ] **3. Реализовать probe** на ImapFlow и отдельном SMTP child process. Nodemailer 10.0.10 держит verify socket в closure; transport.close/pool.close не отменяют его. Child вызывает `createTransport({ ...options, forceAuth:true, logger:false, debug:false }).verify()` с pinned IP lookup/SNI, без sendMail; credentials только через private IPC, не argv/env/stdout. На abort/deadline/успехе завершить child и дождаться process exit; IMAP закрыть своим публичным API. Не более 8 probe children одновременно. Не импортировать composition root `index.js` из probe. Сетевые ошибки/TLS не вызывают AUTH fallback. Набор кодов: `email_invalid,login_invalid,imap_auth_failed,smtp_auth_failed,imap_unavailable,smtp_unavailable,connection_timeout,tls_error,connection_cancelled,server_refused`. Не логировать raw ответы/credentials; logger ImapFlow/Nodemailer отключён.
- [ ] **4. GREEN:** повторить команду; PASS и действующие SMTP fallback/send тесты без изменения семантики отправки.
- [ ] **5. Commit:** `feat: verify mailbox connections before saving`.

### Task 3: Создание для сотрудников и защита ручного режима

**Files:** Create `backend/src/services/accounts/accountCreation.js`, `accountCreation.pglite.test.js`, `createRequest.js`, `createRequest.test.js`, `backend/src/routes/accountProviders.js`, `accountProviders.test.js`, `scripts/deploy/test/e2e-provider-creation.sh`; Modify `routes/accounts.js`, `accounts.create.test.js`, `accounts.oauthFields.test.js`, `accounts.connectionAdmin.test.js`, `services/accounts/manualAccounts.js`, `services/accounts/connection.js`, `routes/oauthGoogle.js`, `routes/oauth.js`, `services/mailNode/mailboxActions.js`, `middleware/bodyParsers.js`, `middleware/bodyParsers.test.js`, `src/index.js` (mount).

**Interfaces:** `createVerifiedAccount(candidate,actor,{provider,mode,requestId,signal}) -> {account}|{error,code}`; `withAccountAddressLock(email,fn,{client,signal,timeoutMs}) -> Promise<Result>` uses one canonical `lower(btrim(email_address))` address key shared by every creation path. Existing transaction clients use transaction locks; node/probe paths use the matching session lock on a reserved client. Never reacquire the same lock on another connection; wait is bounded; no SQL transaction spans probe/native challenge. `parseProviderCreate(body)` accepts only spec whitelist. Manual whitelist accepts existing IMAP/SMTP form fields and optional `provider in yahoo|yandex|mailru|icloud|other`; forbids client `mail_provider,connection_mode,mail_node,oauth_*,proton_*`. Saved modes assigned by server. UI передаёт UUID в header `Idempotency-Key`; request ID относится к одной неизменной попытке, редактирование формы генерирует новый ID.

**Уточнение после повторного изучения:** owning files также `backend/src/cli/commands/account.js`, `backend/src/cli/mailexpert.test.js`, `backend/src/cli/args.test.js` и CLI help, `backend/src/services/auditLog.js` и audit tests, `routes/oauth.google.test.js`, `routes/oauth.microsoft.test.js`, `services/mailNode/mailboxActions.seats.pglite.test.js`. `imap_tls_mode` проходит parse → persistence → safe response → runtime; new HTTP accounts require TLS, CLI legacy сохраняется явно. Managed Proton connection fields immutable для PUT и CLI даже admin; metadata edits доступны по прежним правам. OAuth explicit reconnect/subject reset Google/Microsoft не превращать в duplicate denial. Precheck failures используют зарегистрированное audit action. Step 1 добавить `all_writers_share_trimmed_address_lock`, `oauth_uses_existing_transaction_client`, `node_session_lock_matches_oauth`, `bounded_lock_wait`, `cli_keeps_trusted_legacy_mode`, `managed_connection_update_rejected`, `failed_probe_audit_action_registered`; GREEN включает соответствующие CLI/OAuth/node/audit suites и реальный PostgreSQL race.

- [ ] **1. Написать тесты** `approved_employee_creates_manual_mailbox`, `unapproved_and_anonymous_cannot_create`, `server_only_fields_refused_before_connect`, `smtp_failure_has_no_insert`, `concurrent_address_creations_do_not_duplicate`, `legacy_duplicate_rows_remain`, `advanced_preset_uses_manual_policy`. HTTP/PGlite assertions:
  ```js
  expect(response.status).toBe(200);
  expect(account).toMatchObject({ mail_provider: 'yahoo', connection_mode: 'manual' });
  expect(await db.query('SELECT count(*)::int AS n FROM email_accounts')).toMatchObject({ rows: [{ n: 1 }] });
  expect(rejected.status).toBe(400);
  expect(probe).not.toHaveBeenCalled();
  ```
  Смена регистра/пробелы, разные provider routes и реальный PostgreSQL advisory-lock race; PGlite не выдавать за проверку блокировок PostgreSQL. Existing PUT изменения connection поля обычным сотрудником по-прежнему 403.
  Проверить отсутствующий CSRF header, JSON body >32 KiB (413 до probe), неверные типы/пустые hosts, SMTP header injection в email/login и шестую попытку за 60 s (429 без подключения). Создание обычным сотрудником разрешено, но запрет для anonymous/unapproved проверяется настоящим auth middleware, а не только разрешающим mock.
- [ ] **2. RED:** `npx vitest run src/services/accounts/createRequest.test.js src/services/accounts/accountCreation.pglite.test.js src/routes/accountProviders.test.js src/routes/accounts.create.test.js src/routes/accounts.oauthFields.test.js src/routes/accounts.connectionAdmin.test.js`; новые permission tests FAIL по прежнему контракту.
- [ ] **3. Реализовать маршруты.** `/api/accounts/provider` только четырём фиксированным пресетам; `/api/accounts` manual всем approved employees, domain ветка сохранена. `requireAuth`, CSRF identity gate и `routeActor` обязательны. Creation body ≤32 KiB через path-specific parser **до** общего JSON parser; существующие compose/body limits не менять. Этот же лимит применяется к Proton start/continue задачи 5. Existing `rateLimiter.consume` — общий bucket 5 attempts/60 s/user, максимум 2 simultaneous probes/user и 8/process. Host/port validation до сокетов; ordinary creation всегда проверяет TLS, не принимает skip verify/plaintext. Probe до INSERT, persist через encryption/signature sanitizer/audit, connect через штатный manager. CLI остаётся trusted-admin entrypoint общего creation service с явно выделенным legacy plaintext/skip режимом; HTTP entrypoints его не получают. Обновить CLI help/errors/tests под этот контракт. Общий address lock охватывает recheck+INSERT и существующие OAuth/node writer paths; не держать открытый SQL transaction во время сетевого probe. Повторный запрос с тем же actor/key возвращает прежний safe result; уже чужой/иной connection адрес — `already_connected`. Прежние дубли не удалять и не вводить миграцию, которая на них падает.
- [ ] **4. GREEN:** команда шага 2 плюс `npx vitest run src/routes/accounts.domain.test.js src/routes/accounts.shared.test.js`; PASS. `bash scripts/deploy/test/e2e-provider-creation.sh --project me-e2e` в штатном throwaway e2e fixture запускает два backend Node процесса с общим address lock и проверкой INSERT: два parallel create оставляют одну запись. Script проверяет managed fixture labels перед запросами, не обращается к пользовательскому стенду.
- [ ] **5. Commit:** `feat: let employees connect verified manual mailboxes`.

### Task 4: Worker с native Bridge и закрытым управляющим API

**Files:** Create `deploy/proton-worker/Dockerfile`, `entrypoint.sh`, `bridge-version`, `requirements.in`, `requirements.lock`, `native.py`, `controller.py`, `worker.py`, `tests/test_controller.py`, `tests/test_socket.py`, `tests/test_native_contract.py`, `backend/src/services/proton/workerClient.js`, `workerClient.test.js`.

**Interfaces:** Python `BridgeController.start_connection(operation_id,email,password) -> Operation`, `continue_connection(id,challenge,secret)`, `cancel_connection(id)`, `connection_status(id)`, `commit_connection(id,user_id,generation)`, `remove_user(user_id,generation)`. Operation `{id,state,userId?,createdByAttempt,errorCode?}`; state `starting|authenticating|needs_2fa|needs_second_password|checking|connected|failed|cancelled|expired`. Internal UNIX API `/healthz`, `/connections`, `/connections/:id`, `/connections/:id/continue`, `/connections/:id/commit`, `/connections/:id/cancel`, `/users/:id/credentials`, `/users/:id/remove`; generated credentials/certificates только backend, public routes их не проксируют.

Backend client `callWorker(method,path,body,{signal,timeoutMs})` via Node HTTP `socketPath`, default `/run/mailexpert-proton/worker.sock`; no TCP fallback. `/users/:id/credentials` выдаёт `{userId,email,bridgePassword,certificatePem,certificateFingerprint,tlsServername}` только для связанного operation ID или committed generation. Это **внутренний** контракт, не response browser API.

**Уточнение после повторного изучения:** native Login/Login2FA/Login2Passwords bytes получают base64(UTF8(secret)); `BridgePass` возвращается текстом, вторично не decode. `LoginAbort`, `RemoveUser`, `Quit` RPC асинхронны: ответ RPC не terminal event. Cancel/TTL меняет public state, но global login slot освобождается только после terminal event и reconcile attempt-owned users. Stuck attempt требует controlled native process recovery; это временно прерывает Proton connections и публикуется как unavailable, без patches. Exact SHA по умолчанию Combined: adapter вызывает `SetUserSplitMode`, подтверждает split через native state до probes. Переключение linked native user проходит lifecycle/reconnect coordination. Step 1 добавить `test_secret_bytes_encoding`, `test_bridge_password_not_decoded_twice`, `test_cancel_retains_slot_until_terminal_reconcile`, `test_stuck_login_recovers_process`, `test_split_confirmed_before_probe`, `test_quit_waits_for_process_exit`. Fake multiple-address tests не доказывают реальный multi-address scenario.

- [ ] **1. Написать unittest** `test_one_stream_survives_http_clients`, `test_two_logins_are_serialized`, `test_bad_password_and_hv_have_safe_codes`, `test_2fa_and_second_password_continue_same_attempt`, `test_cancel_does_not_remove_existing_user`, `test_socket_is_private_and_no_tcp_listener`. Fixtures: fake native adapter со счётчиками RPC/event stream и временные private state/runtime paths. Assertions: максимум один `RunEventStream`; shutdown вызывает `StopEventStream`; выбор credentials только для адреса из `GetUser.addresses`; HV/FIDO unsupported — `verification_required`, raw hvUrl не возвращается; другой user ID никогда не выдаётся; main password отсутствует в persisted operation journal и stdout/stderr.
  ```python
  self.assertEqual(native.run_event_stream_calls, 1)
  self.assertEqual(operation.errorCode, 'verification_required')
  self.assertNotIn('secret-sentinel', persisted_text + captured_logs)
  self.assertEqual(native.removed_users, [])
  ```
- [ ] **2. RED:** тестовый container `python -m unittest discover -s tests -v` и backend `npx vitest run src/services/proton/workerClient.test.js`; новые tests FAIL до реализации. Для первого RED запустить source tests в Python test image с зафиксированным окружением; отсутствие готового production Dockerfile не считать достаточным падением tests.
- [ ] **3. Реализовать adapter/controller.** Build исходного SHA без patches, native Go toolchain `go1.26.7` из pinned go.mod, headless grpc frontend проверенного spike. Проверить release notes/advisories и зафиксировать digest build/runtime images и exact hashed Python locks; не использовать floating/latest. Proto брать из `internal/frontend/grpc/bridge.proto` того же SHA. Native adapter проверяет gRPC TLS certificate/token из private config, вызывает native Login/Login2FA/Login2Passwords/LoginAbort/GetUserList/GetUser/RemoveUser; обрабатывает events, а не считает return Login успешным входом. Один login lock на всю цепочку challenge; при занятости возвращать `login_busy` без сохранения нового пароля/очереди secrets. Нет native patches, GUI, системного сертификатного импорта. Bridge lazy start; restart при существующих committed users поднимает его снова. Controller private journal атомарный, содержит operation IDs/generation, не passwords. Браузер не владеет процессом. Native logs не стримить в Docker stdout, хранить только безопасные operational codes; тестировать exception branches.
- [ ] **4. GREEN:** собрать worker image и выполнить ту же unittest команду в нём; PASS. Backend workerClient tests PASS (abort/timeout/secret-free error). Image non-root UID 1000, read-only filesystem с отдельными state/runtime/tmpfs, pass/GPG state 0700; healthz отвечает и при idle Bridge. Native запуск — `proton-bridge --grpc --no-window`, не `--noninteractive`, который не запускает gRPC frontend.
- [ ] **5. Commit:** `feat: add managed Proton Bridge worker`.

### Task 5: Backend операции входа Proton

**Files:** Create `backend/src/services/proton/connections.js`, `connections.pglite.test.js`, `backend/src/routes/accountProton.js`, `accountProton.test.js`; Modify `backend/src/index.js`, `services/accounts/accountCreation.js`. Depends on tasks 4 **and 6**, so implement after task 6.

**Interfaces:** Consumes `callWorker` from task 4 and `probeManagedProtonConnection` from task 6. `startProtonConnection(input,actor)`, `getProtonConnection(id,actor)`, `continueProtonConnection(id,input,actor)`, `cancelProtonConnection(id,actor)` return public `{id,state,errorCode?,account?}`. Start input `{email,password,requestId,reconnectAccountId?,...optional metadata}`; continuation `{challenge:'2fa'|'second_password',secret}`. Opaque UUID requestId creates one attempt per actor, not an email URL. Named exports live in `services/proton/connections.js`.

**Уточнение после повторного изучения:** DB unique actor/request ID и durable reconnect intent из task 1 обеспечивают idempotency до native call. Reconnect creator/admin сохраняет account ID и проверяет same native user; duplicate без explicit reconnect отвергается. Admission task 9 охватывает probe/SQL commit/worker commit reconciliation, не только native RPC. Step 1 добавить `duplicate_request_never_restarts_native_login`, `creator_or_admin_reconnects_same_account`, `foreign_employee_cannot_start_reconnect`, `reconnect_wrong_native_user_rejected`, `cancel_commit_race_reconciles_once`, `snapshot_waits_for_sql_commit_reconcile`; public account capability используется task 11.

- [ ] **1. Написать тесты** `login_operation_is_bound_to_actor`, `ttl_is_ten_minutes`, `address_must_belong_to_native_user`, `second_poll_does_not_create_second_mailbox`, `failed_probe_schedules_only_new_user_cleanup`, `restart_marks_incomplete_operation_safely`, `no_worker_secret_reaches_public_response`. Assertions: чужой actor 404, admin status разрешён; challenge строго соответствует state; expires_at +600000 ms; JSON response никогда не содержит `password,bridgePassword,certificatePem,grpcToken`; повтор requestId не вызывает второй native Login.
  ```js
  expect(foreignActorResponse.status).toBe(404);
  expect(Date.parse(row.expires_at) - startedAt).toBe(600000);
  expect(JSON.stringify(publicStatus)).not.toContain('secret-sentinel');
  expect(nativeLogin).toHaveBeenCalledOnce();
  ```
- [ ] **2. RED:** `npx vitest run src/services/proton/workerClient.test.js src/services/proton/connections.pglite.test.js src/routes/accountProton.test.js`; новые tests FAIL.
- [ ] **3. Реализовать `/api/accounts/proton/connect` POST, `/:id` GET, `/:id/continue` POST, `/:id/cancel` POST.** Общие creation/auth/rate limits из задачи 3; polling bounded и не расходует password-attempt bucket. Не пересылать весь req.body, не логировать worker errors. До native login проверять duplicate address; исключение только для явного reconnect существующей managed связи её creator/admin с durable reconnectAccountId. После login требовать тот же native user ID; чужой сотрудник не начинает попытку. Затем native membership и обе connection probes перед transactional account/link INSERT. Commit journal после SQL commit; startup reconciliation сравнивает operations/links и завершает interrupted commit idempotently. 2FA/second password очищаются после передачи. Existing manual Proton collision возвращает `already_connected`; никакого автоматического adoption private state. Worker missing/busy — безопасные `proton_unavailable/login_busy`.
- [ ] **4. GREEN:** повторить команду; PASS, fake two-user sessions не затрагивают соседей, отказ не сохраняет пустой account.
- [ ] **5. Commit:** `feat: connect Proton accounts through managed operations`.

### Task 6: Безопасное доверие Bridge в общем почтовом движке

**Files:** Create `backend/src/services/proton/mailEndpoint.js`, `mailEndpoint.test.js`, `backend/src/services/accounts/mailEndpoint.js`, `mailEndpoint.test.js`; Modify `services/imapManager.js` (`resolveAccountHost`, `makeClientCfg` и все варианты persistent/pool/probe), `services/smtpTransport.js`, `services/smtpTransport.test.js`; Create `services/imapManager.protonTls.test.js`. Depends on tasks 1, 2 and 4; no dependency on task 5 implementation.

**Interfaces:** `resolveMailEndpoint(account,protocol,{signal}) -> {host,port,addresses,lookup,servername,tls,secure,requireTLS}`. Обычный account использует существующие policy/DNS правила. `resolveProtonEndpoint(accountId,protocol,{signal})` проверяет DB managed link/user generation и возвращает только фиксированный loopback endpoint с trusted public certificate; если связи нет — отказ, не fallback на global insecure/private flags.

Для проверки **до** INSERT: `probeManagedProtonConnection(operationId,{signal}) -> {imapLogin,smtpLogin}` получает credentials через task 4 client, сверяет DB operation state `checking`/userId/requested_email и native membership, передаёт в task 2 probe доверенную функцию resolveEndpoint. Этот путь не требует ещё не созданного mailbox link и не доступен manual HTTP input.

**Уточнение после повторного изучения:** owning tests также `services/accounts/connection.test.js` для TLS-mode roundtrip. New verified rows при runtime DNS без answers завершаются fail closed; legacy NULL mode сохраняет прежнюю совместимость. Во всех IMAP construction paths explicit starttls требует `doSTARTTLS:true`, TLS verification true; `resolveMailEndpoint` возвращает `imapTlsMode` alongside endpoint fields. Step 1 добавить `explicit_starttls_is_forced_in_every_imap_client`, `verified_runtime_dns_empty_fails_closed`, `legacy_null_mode_preserves_behavior`; GREEN запускает эти tests и existing SMTP regression suite.

- [ ] **1. Написать тесты** `managed_link_is_required_for_loopback_exception`, `pending_operation_can_probe_only_its_verified_native_user`, `forged_mail_provider_has_no_private_access`, `all_proton_clients_verify_certificate_and_hostname`, `manual_and_oauth_endpoint_rules_unchanged`. Assertions:
  ```js
  expect(endpoint.port).toBe(1993);
  expect(endpoint.tls.rejectUnauthorized).toBe(true);
  expect(endpoint.tls.ca).toBe(publicCertificate);
  await expect(resolveProtonEndpoint(unlinkedId, 'imap')).rejects.toMatchObject({ code: 'proton_link_missing' });
  ```
  Probe, pool, backfill, persistent, snippets и SMTP используют ту же модель доверия; подмена host/port в account не расширяет разрешение.
- [ ] **2. RED:** `npx vitest run src/services/proton/mailEndpoint.test.js src/services/accounts/mailEndpoint.test.js src/services/smtpTransport.test.js`; новые assertions FAIL.
- [ ] **3. Реализовать endpoint helper и хирургически подключить его к существующим точкам.** CA только из доверенного UDS worker, servername из native Hostname и проверенного сертификата; private key/gRPC TLS token backend не получает. Сгенерированный Bridge пароль шифруется стандартным encryption, используется для IMAP/SMTP независимо от основного Proton пароля. Runtime использует только DB managed identity; fixed preset/ручной provider label не разрешает managed endpoint. Existing OAuth refresh/send и IMAP failover сохраняются.
- [ ] **4. GREEN:** указанная команда плюс `npx vitest run src/services/imapManager.protonTls.test.js`; PASS. Fake certificate rejection остаётся rejection, обычный account на 127.0.0.1 не получает исключение.
- [ ] **5. Commit:** `feat: scope Proton TLS trust to managed mailbox links`.

### Task 7: Сертификаты, восстановление и папки Proton

**Files:** Create `backend/src/services/proton/reconcile.js`, `reconcile.pglite.test.js`, `folders.js`, `folders.test.js`; Modify `backend/src/index.js` (start/stop), `services/imapManager.js` (`ensureFolder`/rename), `routes/mail.js` (public folder validation), `routes/accounts.js` (sanitized health), `frontend/src/utils/accountHealth.js`, locales en/ru.

**Interfaces:** `reconcileProtonLinks({signal}) -> {changed,reconnectRequired}` bounded poll при startup и каждые 60 s; `normalizeProtonFolderPath(path,{parent=null}) -> string`. Reconcile получает credentials/certificates по managed user/address, обновляет encrypted credentials и reconnectQueue только при fingerprint/password change. Missing native state — `proton_reconnect_required`, worker offline — временное unavailable, не plaintext fallback.

**Уточнение после повторного изучения:** owning files дополнить `backend/src/services/labels.js`, `labels.test.js`, `routes/mail.snooze.test.js`, `mail.snooze.pglite.test.js`, `services/sendDelivery.js`, `services/sendDelivery.test.js`. Snooze/labels используют `{path}` из `ensureFolder(...,{resolvePath:true})` для move/copy, DB folder storage и wakeup, не исходную строку. Bridge сам сохраняет Sent (в real spike одна копия); trusted managed-link predicate исключает дополнительный append в `sendDelivery`, client provider label не влияет. Step 1 добавить `snooze_uses_translated_path_through_wakeup`, `labels_copy_and_storage_use_resolved_path`, `managed_proton_sent_is_single_copy`, `spoofed_label_keeps_normal_sent_append`; steps 2/4 включают эти owning suites. UI reconnect показывает creator/admin capability; seed dialog существующими account/email, другие сотрудники не начинают login.

- [ ] **1. Написать тесты** `certificate_rotation_reconnects_only_changed_links`, `lost_state_requires_login_without_breaking_other_providers`, `root_folder_gets_folders_namespace`, `already_prefixed_folder_not_double_prefixed`, `labels_are_not_creatable_as_folders`, `drafts_sent_and_flags_keep_existing_behavior`. `Folders/Work` не меняется; `Labels/Work` отвергается с stable code; rollback старого fingerprint не принимается из браузера; другой native user/обычный IMAP не disconnect.
  ```js
  expect(normalizeProtonFolderPath('Work')).toBe('Folders/Work');
  expect(normalizeProtonFolderPath('Folders/Work')).toBe('Folders/Work');
  expect(reconnectAccount.mock.calls.map(([, id]) => id)).toEqual([changedAccountId]);
  expect(unavailableStatus.code).toBe('proton_reconnect_required');
  ```
- [ ] **2. RED:** `npx vitest run src/services/proton/reconcile.pglite.test.js src/services/proton/folders.test.js`; новые tests FAIL.
- [ ] **3. Реализовать reconcile/folder adapter.** Проверять membership повторно и работать с текущим generation, обновлять публичный cert и password атомарно. Использовать существующий reconnectQueue и cooldown, не запускать второй manager. Proton root folder creation переводить в Folders namespace на уровне account-aware MailExpert ensureFolder, чтобы работали также правила/snooze; не менять общий ensureMailbox для других провайдеров. В UI отобразить reconnect_required safe code с доступным владельцу/admin входом; успешный повторный login обновляет существующую связь, не создаёт дубликат.
- [ ] **4. GREEN:** повторить команду плюс backend `npx vitest run src/routes/mail.folderMoves.pglite.test.js src/services/imapManager.serverMailboxes.test.js src/services/imapRenameFolder.test.js` и frontend `node --test src/utils/accountHealth.test.js`; PASS. Для реального Bridge повторить creation root-folder после разрешённого rollout в задаче 13.
- [ ] **5. Commit:** `feat: reconcile Proton sessions and folder namespaces`.

### Task 8: Удаление, поколения и durable cleanup

**Files:** Create `backend/src/services/proton/lifecycle.js`, `lifecycle.pglite.test.js`; Modify `routes/accounts.js` DELETE, `src/index.js` job registration; worker controller tests из задачи 4.

**Interfaces:** `deleteProtonMailbox(accountId,actor)` выполняет удаление link/account и enqueue cleanup в одной DB transaction. `registerProtonJobKinds()` регистрирует `proton_cleanup` `{userId,generation}` с idempotent worker remove; никаких credentials в payload. Повторы используют текущую jobQueue backoff, cap 30 min, maxAttempts `Number.MAX_SAFE_INTEGER`; stale generation — successful no-op.

**Уточнение после повторного изучения:** persist removal-in-progress до RPC; lifecycle lock сохраняется до user-removal terminal event И `GetUserList` absence. Timeout оставляет pending retry и блокирует re-add того же user, не освобождает право на destructive stale cleanup. Step 1 добавить `remove_rpc_ack_does_not_release_lock`, `removal_event_requires_list_absence`, `removal_timeout_blocks_readd`, `recovery_reconciles_pending_removal`; worker tests и DB tests проверяют generation вместе с lifecycle, без отдельного fence-check с TOCTOU.

- [ ] **1. Написать тесты** `deleting_one_of_two_linked_addresses_keeps_native_user`, `last_link_enqueues_cleanup_atomically`, `offline_worker_leaves_cleanup_pending`, `old_generation_cannot_remove_readded_user`, `cancelled_login_only_cleans_attempt_owned_user`. Assertions: remove_user не вызван при одном оставшемся link; последняя связь создаёт один queued job; rollback не оставляет delete без job; failed worker повторяет тот же ключ; stale cleanup job `done` без native remove.
  ```js
  expect(removeUser).not.toHaveBeenCalled(); // another linked address or stale generation
  expect(cleanupJobs).toHaveLength(1);
  expect(cleanupJobs[0].payload).toEqual({ userId, generation });
  expect(staleJob.status).toBe('done');
  ```
- [ ] **2. RED:** `npx vitest run src/services/proton/lifecycle.pglite.test.js`; новые tests FAIL.
- [ ] **3. Реализовать lifecycle.** Account deletion сохраняет прежние shared permissions, failJobsOfDeletedAccount и disconnect behavior. Cleanup не использует cascade-потерянный user ID — payload фиксируется до delete. Native RemoveUser = локальная Bridge сессия, не Proton remote account. Повторное создание блокируется/сверяется с cleanup того же user/generation; worker commit/removal serializes вместе с login lifecycle. Reconcile orphan attempts после crash сначала сверяет все SQL links, никогда не удаляет account только по email browser attempt.
- [ ] **4. GREEN:** повторить команду плюс `npx vitest run src/routes/accounts.shared.test.js src/services/jobQueue.pglite.test.js`; PASS; worker lifecycle unittest PASS.
- [ ] **5. Commit:** `feat: clean up Proton sessions through durable jobs`.

### Task 9: Штатная установка, CI, backup/restore и update

**Files:** Modify `docker-compose.yml`, `deploy/compose.prod.yml`, `.github/workflows/ci.yml`, `scripts/ci/promote-latest.sh`, `scripts/deploy/{install,update,updater,rollback,status,healthcheck,backup,restore}.sh`, `scripts/deploy/lib/{app,system,config}.sh`, `scripts/deploy/test/{promote,status,health,restore,backup-files}.bats`, `scripts/deploy/test/{e2e,e2e-install,e2e-backup}.sh`, `docs/operations/{deployment,local-stand}.md`; Create `scripts/deploy/lib/proton.sh`, `scripts/deploy/test/proton-worker.bats`, `backend/src/services/proton/maintenance.js`, `maintenance.test.js`, `backend/src/services/sendQueue.protonSnapshot.pglite.test.js`; Modify worker/controller, `backend/src/services/proton/workerClient.js`, `backend/src/services/sendQueue.js`, `sendDelivery.js`, `sendDelivery.test.js`, `ruleForwarder.js`, `ruleForwarder.test.js` for snapshot admission and delivery boundary.

**Interfaces:** Compose service `proton-worker`, `network_mode: service:backend`, no published ports/Docker socket, depends on backend **service_started**, not backend healthy. Shared private runtime volume mounts at `/run/mailexpert-proton` only backend/worker; persistent `proton_state` mounted only worker. `ensure_proton_paths`, `proton_snapshot_begin`, `proton_snapshot_end`, `stage_proton_state`, `restore_proton_state` host helpers use only installed compose project. Worker internal snapshot lease `/snapshot/begin|end` blocks login/remove/certificate changes, drains outbound leases, stops native Bridge cleanly before state capture and restarts afterward. Internal `/leases/send` POST and `/leases/:id` DELETE reserve/release actual sends, живые send leases не истекают по времени. Зависший живой sender удерживает lease; snapshot за 60 s возвращает busy. Timeout не доказывает смерть backend. Orphan leases очищаются только при контролируемом пересоздании backend/worker после подтверждённой остановки старого backend. `withProtonSendLease(accountId,fn)` in maintenance.js acquired **before** `markEffectStarted`; no change to at-most-once send boundary. A maintenance wait may retry only before irreversible effect, never replay accepted/unknown deliveries.

**Уточнение после повторного изучения:** admission gate атомарно закрывает новые sends/lifecycle operations, ждёт active sends, backend SQL commit/reconcile и native work, затем `Quit` и process EXIT. Gate охватывает `sendDelivery` и `ruleForwarder`; очередь берёт send lease до `markEffectStarted`. Живой stalled sender → snapshot busy через 60 s, lease не истекает. Никакой проверки fence отдельно от защищаемого эффекта. Restore/rollback исторического dump переводит ВСЕ восстановленные `send_message` со status queued/running в `needs_attention`, сохраняя accepted/uncertain evidence; автоматической отправки нет, решение принимает человек. Fifth-image inventory выводится из целевого commit и для historical promotion; worker recreation после общего backend recreation проверяет фактический namespace, не только compose text. Step 1 добавить `living_stalled_sender_makes_snapshot_busy`, `orphan_lease_cleared_only_after_old_backend_stopped`, `rule_forwarder_drains_before_snapshot`, `sql_commit_reconcile_drains_before_quit`, `quit_ack_is_not_exit`, `historical_restore_quarantines_all_outgoing_jobs`, `historical_promotion_uses_target_inventory`, `updater_common_recreate_checks_actual_namespace`; RED/GREEN включают sendDelivery/ruleForwarder и restore/rollback/e2e coverage.

- [ ] **1. Написать tests** `worker_ports_are_private`, `worker_follows_recreated_backend_namespace`, `missing_worker_image_stops_update_before_backup`, `snapshot_failure_releases_gate`, `restore_old_snapshot_keeps_proton_unavailable_safely`, `promotion_checks_fifth_image`. Native e2e asserts no port publishing, safe UID/runtime modes, controller idle healthy, backend/container recreate restores UDS and loopback. Backup test covers credentials/session journal captured with DB and ENCRYPTION_KEY without printing values; sender waits/retries only before effect started, never resends after an unknown SMTP outcome.
  ```bash
  [ "$status" -eq 0 ]
  [ "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$worker_id")" -eq 0 ]
  [ "$missing_image_update_status" -ne 0 ]
  [ "$backup_called_before_missing_image_failure" -eq 0 ]
  ```
- [ ] **2. RED:** `bats scripts/deploy/test/proton-worker.bats scripts/deploy/test/promote.bats scripts/deploy/test/status.bats scripts/deploy/test/backup-files.bats scripts/deploy/test/restore.bats`; новые tests FAIL; backend sendQueue snapshot-gate test FAIL.
- [ ] **3. Реализовать deploy/CI.** UID 1000 runtime ownership 0700/socket 0600; backend получает socket path env, не worker state. Worker image `mailexpert-proton-worker:sha-<12>`, та же версия/promotion как остальные образы; PR builds без push, publication только green main. Добавить CI worker unit/build/non-root smoke job и image к promote проверки/release tags; release version не bump этой feature. Install/update/rollback смотрят **целевой commit** на наличие worker: старые версии/backup остаются совместимыми. Pull нового образа до изменения установки; пересоздать worker после backend без dependency cycle. Status показывает worker idle/ready/error, память: production cap 1 GiB, discovery сообщает дополнительный 1 GiB резерв; backend readiness не блокирует обычную почту из-за Proton provider outage. Snapshot begin bounded 60 s: сначала gate/drain отправок, затем native Quit; DB dump и state snapshot под lease, finally restart/release при любой ошибке. На update хранить worker snapshot рядом с предмиграционным dump для штатного rollback; никакой подмены compose файлов вручную. Restore до запуска worker, state/mode проверяются; старый backup без state => reconnect required. Согласованный snapshot не делает отправку at-least-once. Логи содержат counts/status, не raw keychain/секреты.
- [ ] **4. GREEN:** повторить bats; shellcheck как в CI для изменённых scripts; backend sendQueue tests PASS. Собрать все image fixtures и запустить штатные install/update/backend-recreate/backup/restore e2e внутри выделенного Docker-in-Docker fixture; exit 0, readiness true, опубликованных Proton портов нет. Fixtures не используют пользовательский `me-stage`.
- [ ] **5. Commit:** `feat: ship Proton worker with deploy and recovery lifecycle`.

### Task 10: Отдельный диалог и постоянные точки входа

**Files:** Create `frontend/src/components/AddAccountDialog.jsx`, `AddAccountDialog.render.test.js`, `addAccount/ProviderPicker.jsx`, `ProviderIcon.jsx`, `frontend/src/utils/addAccountFlow.js`, `addAccountFlow.test.js`, `frontend/src/store/addAccountDialog.test.js`; Modify `components/MailApp.jsx`, `Sidebar.jsx`, `AdminPanel.jsx`, `components/AddAccountTabs.jsx` (remove after no callers), `store/index.js`, `utils/addAccount.js`, `utils/addAccount.test.js`, `index.css`, locales en/ru, `Sidebar.accounts.render.test.js`, `AccountsTab.render.test.js`.

**Interfaces:** store `showAddAccountDialog:boolean`, `openAddAccount()`, `closeAddAccount()` independent of showAdmin/adminTab; remove addAccountRequested/clearAddAccountRequest only after updating all callers/tests. `ADD_ACCOUNT_KINDS = ['domain','gmail','proton','yahoo','yandex','mailru','icloud','other']`; old manual kind becomes other in every caller/test, no hidden admin-only filtering. Local flow `initialAddAccountFlow() -> {screen:'picker',provider:null,email:''}`, `transitionAddAccountFlow(state,event)` for select/back/email/close; **no passwords** in this state or Zustand. Dialog `{onClose}` portal in document.body; `ProviderPicker({providers,onSelect})`. Form contracts: `onConnected({kind:"account",account:safeAccount,attemptId})` or `onConnected({kind:"oauth",attemptId})`, and `onCancel()`; OAuth completion refreshes accounts, never invents an account. Existing forms accept optional `initialEmail,onEmailChange,signal,attemptId`, preserving standalone callers and Domain foreign aliases contract.

**Уточнение после повторного изучения:** owning files дополнить `frontend/src/components/MessageList.jsx`, `MessageList.render.test.js`, `App.jsx`, new `components/MailApp.addAccount.render.test.js`, `utils/googleOAuth.js`/tests, `utils/oauthWindow.js`/tests; backend `routes/oauthGoogle.js`, `oauth.js`, `services/oauth/oauthState.js`/tests и callback tests для opaque attempt correlation. Mobile list header принадлежит MessageList; shared shell action остаётся видимым также в reading/contacts views. MailApp keyboard shortcuts, Cmd+K и native Android Back сначала проверяют modal. Escape сначала закрывает suggestions и stopPropagation, иначе modal. Portal наследует theme от html; font-size preference применяется без двойного viewport transform; visualViewport sizing повторяет подход ComposeModal с учётом portal. Inert только app root; сохранять/restoring прежние inert/scroll значения. Upsert строится от latest state и вызывает стандартный `setAccounts`, сохраняя его семантику. OAuth start/callback несут opaque attempt ID: late A не закрывает B; central refresh безопасен после close. Electron external-browser return запускает bounded generation-aware accounts reconciliation; same-tab onboarding callback refresh/toast сохраняет mail context. Step 1 добавить tests для перечисленных сценариев, особенно `late_oauth_a_cannot_close_b`, `mobile_reading_contacts_keep_add_action`, `dialog_blocks_shell_shortcuts_and_native_back`, `escape_dismisses_suggestions_first`, `portal_font_scale_and_inert_restore`; RED/GREEN включает owning tests.

- [ ] **1. Написать render/store tests** `button_visible_with_zero_one_many_accounts_and_collapsed_sidebar`, `opening_does_not_change_current_mail_context`, `settings_opens_same_dialog_and_keeps_filter`, `tile_replaces_picker_with_full_form`, `back_is_top_left_and_restores_tile_focus`, `escape_traps_and_restores_focus`, `late_completion_never_reopens_form`. Assertions:
  ```js
  assert.equal(useStore.getState().showAdmin, before.showAdmin);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(dialog.querySelectorAll('[data-provider-tile]').length, 8);
  assert.equal(dialog.querySelector('[data-provider-picker]'), null); // after selection
  assert.equal(document.activeElement, trigger); // after close
  ```
  Test late success reconciles accounts while dialog remains closed; settings search stays same. Mobile topbar has direct action, no hidden menu prerequisite.
- [ ] **2. RED:** `node --test src/utils/addAccountFlow.test.js src/store/addAccountDialog.test.js src/components/AddAccountDialog.render.test.js src/components/Sidebar.accounts.render.test.js src/components/AccountsTab.render.test.js`; новые tests FAIL.
- [ ] **3. Реализовать shell/navigation.** Permanent desktop top Sidebar action; collapsed icon with tooltip/label, mobile topbar action. Picker order from spec, each service own bundled SVG via React component, no remote image/CDN/runtime SVG HTML injection. Selected form replaces grid, title includes icon/name and left Back/right Close. Local lifecycle AbortController invalidates form results; restore focus/context, background inert and scroll lock scoped/restored (including opening over AdminPanel). Success upserts account by ID against latest store, never stale captured array; late close success/OAuth callback refreshes list without resurrecting form. Preserve Gmail global callback behavior. CSS from spec with both themes, keyboard focus/reduced motion. AccountsTab add button calls store action and no longer switches subview add; edit form stays.
- [ ] **4. GREEN:** повторить command; PASS plus i18n coverage. No JSX/registerHooks new monkey-patches: reuse existing render-test harness pattern.
- [ ] **5. Commit:** `feat: add standalone mailbox onboarding dialog`.

### Task 11: Минимальные формы и расширенный режим

**Files:** Create `frontend/src/components/addAccount/{ImapProviderAddForm,ManualAccountAddForm,ProtonAddForm,AdvancedConnectionFields,AppPasswordHelp}.jsx`, `ProviderForms.render.test.js`, `frontend/src/utils/providerConnection.js`, `providerConnection.test.js`, `frontend/src/utils/api.providers.test.js`; Modify `components/AddAccountDialog.jsx`, `GmailAddForm.jsx`, `DomainMailboxAddForm.jsx`, `utils/api.js`, `utils/api.errors.test.js`, `utils/api.demo.test.js`, locales en/ru, backend `routes/integrations.js`, `integrations.status.test.js`.

**Interfaces:** `providerConnectionPayload({provider,email,appPassword,login,advanced,metadata},defaults) -> {mode:'preset'|'manual',body}`; exact manual body uses existing snake_case account fields, provider body uses task 3 whitelist. `api.addProviderAccount(body,{signal,requestId})`, `api.addAccount(body,{signal,requestId})` send `Idempotency-Key` header; `api.startProtonConnection(body,{signal})`, `api.getProtonConnection(id,{signal})`, `api.continueProtonConnection(id,body,{signal})`, `api.cancelProtonConnection(id)`; extend direct request options without weakening CSRF/locked handling or demo transport. Public integration status adds `{mailProviders,proton:{configured,available,code},manual:{allowPrivateHosts,allowNonstandardPorts}}`; manual object contains booleans only, never admin config, mailProviders contains task 1 safe metadata.

**Уточнение после повторного изучения:** optional existing-form props `initialEmail,onEmailChange,signal,attemptId` не меняют Domain foreign aliases; guard generation/signal после каждого awaited OAuth launch/created callback. Completion union из task 10 не требует fake SafeAccount для OAuth. Proton reconnect UI получает server `can_reconnect_proton`, seed account/email и отправляет `reconnectAccountId`; других сотрудников к start не допускает. Owning files дополнить `frontend/src/utils/clipboard.js`, `clipboard.test.js`, `locales/i18n.test.js`; использовать existing helper без подмены focus, selectable-link fallback внутри non-inert dialog. Brand equal translations зарегистрировать в `SAME_VALUE_ALLOWED`, не ослабляя coverage. Step 1 добавить `cancel_during_oauth_launch_never_reopens`, `domain_foreign_alias_contract_preserved`, `reconnect_seed_requires_capability`, `clipboard_fallback_keeps_dialog_focus`, `help_links_secure_oauth_opener_preserved`; GREEN запускает clipboard/OAuth/form/i18n tests.

- [ ] **1. Написать tests** `two_required_fields_for_each_preset`, `advanced_is_collapsed_for_all_eight`, `unchanged_advanced_uses_fixed_provider`, `server_edit_switches_to_manual_and_preserves_label`, `managed_fields_are_not_editable`, `known_alternate_domains_keep_full_address`, `unknown_domain_never_changes_server`, `app_password_link_copy_failure_is_accessible`, `proton_challenge_is_conditional`, `back_close_clear_secrets`. Assertions:
  ```js
  assert.equal(payload.mode, 'manual');
  assert.equal(payload.body.provider, 'mailru');
  assert.equal(payload.body.email_address, 'team@bk.ru');
  assert.equal(payload.body.imap_host, 'imap.example.com');
  assert.equal(JSON.stringify(useStore.getState()).includes('secret-sentinel'), false);
  ```
  Provider metadata from backend not inferred from arbitrary domain. AUTH rejection enables optional login field, not password echo. Managed technical details contain no Bridge password/token. For Other the submit is disabled until advanced server values complete; fields open only on explicit user click, missing-values hint explains action.
- [ ] **2. RED:** `node --test src/utils/providerConnection.test.js src/components/addAccount/ProviderForms.render.test.js src/utils/api.providers.test.js`; backend `npx vitest run src/routes/integrations.status.test.js`; новые tests FAIL.
- [ ] **3. Реализовать forms/API/status.** Fixed Yahoo/Yandex/Mail.ru/iCloud forms two fields plus official app-password link/copy URL; Apple path hint next to documented root link. Advanced manual fields prefilled, changed server settings submit to `/accounts`, TLS verification bypass absent. Defaults reset button restores provider route; merely opening advanced does not convert mode. Other shares same field editor with no invented hosts. Optional name/color/sender/signature are collapsed in same block. Gmail retains OAuth, advanced existing sender metadata and safe connection explanation; node retains domains/seats/current confirmation flow, advanced safe details; Proton main credentials/challenges local only, advanced metadata and managed explanation. Poll every 1 s while active, expire at 10 min, stop on back/close/unmount; send explicit cancel as well as abort; unsupported HV clear translated message. Clipboard failure renders selectable link, URL contains no input. Help links target blank with noopener/noreferrer; OAuth popup retains its required opener. All strings in locales; reuse clipboard helpers and test focus/inert fallback.
- [ ] **4. GREEN:** повторить commands плюс `node --test src/utils/addAccount.test.js src/utils/mailNode.test.js src/utils/api.errors.test.js src/utils/api.demo.test.js`; direct API CSRF/locked handling PASS. Public integration status response secret sentinel test PASS.
- [ ] **5. Commit:** `feat: simplify provider forms with advanced connection settings`.

### Task 12: Поиск, подробности ящиков и demo

**Files:** Modify `frontend/src/utils/accountSearch.js`, `accountSearch.test.js`, `components/AdminPanel.jsx` AccountsTab cards/search and existing edit AccountForm, `components/AccountsTab.render.test.js`, `demo/index.js`, `demo/index.test.js`, `demo/routeCoverage.test.js`, locales en/ru; Create `frontend/src/demo/providers.js`, `providers.test.js`. Update `docs/user-guide/README.md` and linked existing accounts guide located with `rg --files docs/user-guide`.

**Interfaces:** Preserve `buildAccountSearchIndex(accounts,options)`, `searchAccounts(index,query)`; expand provider keywords RU/EN from mail_provider and connection_mode, not loopback host. Demo `/accounts/provider`, `/accounts/proton/connect`, GET/continue/cancel simulate same safe response shape as tasks 3/5; secret input discarded, no external fetch.

**Уточнение после повторного изучения:** owning files дополнить `frontend/src/utils/accountUpdate.js`, `accountUpdate.test.js`. Baseline prerequisite i18n roots вынесен в task 0; эта задача сохраняет проверки source coverage. Managed ordinary Gmail/Proton/node save формирует metadata-only payload, не disabled connection fields; сохраняет Google/Microsoft reconnect/subject-reset/device actions. Demo разрешает employee Other create, но PUT connection restrictions и Proton reconnect capability повторяют backend; state upsert соблюдает `setAccounts`. Step 1 добавить `managed_employee_edit_sends_only_metadata`, `oauth_reconnect_reset_device_actions_remain`, `demo_employee_other_allowed_put_restricted`, `demo_reconnect_capability_matches_actor`; GREEN включает accountUpdate tests.

- [ ] **1. Написать tests** `search_is_visible_with_empty_single_and_many_accounts`, `search_matches_provider_email_sender_alias`, `opening_dialog_retains_query_and_selection`, `manual_override_card_shows_mode`, `demo_all_eight_flows_and_safe_proton_errors`. Assertions: searching "Яндекс"/"yandex" returns same matching account; store accounts array/order/unread unchanged; zero/empty-results differ; ordinary user sees detailed safe metadata but cannot save existing connection fields; demo handles all API paths without credential persistence.
  ```js
  assert.deepEqual(searchAccounts(index, 'Яндекс').map(a => a.id), searchAccounts(index, 'yandex').map(a => a.id));
  assert.equal(useStore.getState().accounts, originalAccounts);
  assert.deepEqual(useStore.getState().unreadCounts, originalUnreadCounts);
  assert.equal(JSON.stringify(demoState).includes('secret-sentinel'), false);
  ```
- [ ] **2. RED:** `node --test src/utils/accountSearch.test.js src/components/AccountsTab.render.test.js src/demo/providers.test.js src/demo/index.test.js src/demo/routeCoverage.test.js`; новые tests FAIL.
- [ ] **3. Реализовать search/details/demo.** Always-visible search, count/clear/empty/results, current index reused. Cards show provider, connection mode, health, existing details/actions; managed/provisioned fields not editable, ordinary employees keep existing edit restriction. Demo state deterministic and secret-free, including disabled worker, 2FA, second password, verification_required, failed SMTP and already_connected. Russian user guide explains ordinary/advanced forms, exact official password paths, team visibility and managed Proton limitations without real accounts/hosts.
- [ ] **4. GREEN:** повторить command plus `node --test src/locales/i18n.test.js`; PASS with no unused/hardcoded texts and missing demo routes.
- [ ] **5. Commit:** `feat: show searchable provider accounts and demo onboarding`.

### Task 13: Полная проверка, review и разрешённый rollout

**Files:** Create `docs/audits/2026-10-10-mailbox-providers-validation.md`; Modify только найденные дефекты в их owning task, затем повторить затронутые tests. Do not bump release version or change unrelated files.

**Interfaces:** Итоговый отчёт с командами/exit codes, подтверждёнными сценариями, screenshots без credentials, ограничениями реальных провайдеров; feature branch PR от `wyrtensi` после review/зелёных checks, PR attachment tool после создания. Никакого main merge до green CI.

**Уточнение после повторного изучения:** исходный baseline и границы проверки записаны в `docs/audits/2026-10-10-mailbox-providers-restudy.md`; это не тесты новой реализации. Реальная multi-address/split/2FA проверка требует предоставленных аккаунтов. Обязательная snapshot validation включает timeout с живым sender и отсутствие автоматических отправок из исторического dump; approval на реализацию уже дан, server rollout gate остаётся отдельным.

- [ ] **1. Запустить полные команды AGENTS:** backend `npm test`, `npm run lint`, `npm run lint:plugins`; frontend `npm test`, `npm run lint`, `npm run build`; worker unittest внутри image; shellcheck/bats deploy suite; tenant-worker existing `node --test deploy/tenant-worker/worker.test.mjs`; CI install e2e. Требование PASS/exit 0, не только targeted checks. Реальный PostgreSQL fixture проверяет creation lock concurrency.
- [ ] **2. Chrome demo validation:** widths 320/390/768/1440, RU/EN, светлая/тёмная тема, все плитки, полный form/back, hidden/expanded configs, 0/1/many accounts, collapsed Sidebar, settings/filter continuity, keyboard trap/return, long address/link wrap, mobile scrolling/keyboard. Сохранить screenshots outside source и описать конкретные результаты; чинить layout defects до ready claim.
- [ ] **3. Выполнить независимый whole-branch review** методом, выбранным владельцем; проверить secret boundaries, manual SSRF/TLS policy, cleanup generations, migration upgrade, snapshot send boundary, native API source pin. Fix validated findings with owning tests. Не использовать monkey-patching как обход review failure.
- [ ] **4. Обновление пользовательского стенда — отдельный gate:** прочитать `.claude/skills/mailexpert-rollout/SKILL.md`, выполнить read-only `status.sh --target sha-<12> --json` для **указанного** стенда и показать конкретный план/миграцию/backup перед запросом согласования. Пока нет отдельного ответа — rollout не выполнять. После разрешения использовать штатный deploy и опубликованные/штатно подготовленные exact-tag images; report commands/exit/readiness. Существующий экспериментальный Proton conflict показывает already_connected; не удалить вручную private state для красивого теста. Владельцу предложить штатное удаление старой локальной связи/повторное добавление с сохранением удалённой почты; этот шаг только в согласованном rollout плане.
- [ ] **5. Реальная проверка:** существующий разрешённый Proton Free — UI login, sync, sends/receives к разрешённым адресатам, Sent single-copy, reply headers, 10 MiB attachment hash, drafts/flags/folders/trash, worker/backend restart without password, TLS stays verified. Проверку IMAP/SMTP при добавлении доказать отсутствием тестового письма. Несколько native users/2FA требуют доступных дополнительных аккаунтов; fake не выдавать за real. Yahoo/Yandex/Mail.ru/iCloud реальные AUTH/send/receive проверять только с предоставленными аккаунтами и явным scope для отправки; при их отсутствии отметить непроверенную доставку. Не обещать отсутствие всех багов или постоянную доступность Proton API.
- [ ] **6. Зафиксировать отчёт и открыть PR:** commands/exit outputs и remaining limitations в аудите, Conventional Commit `docs: record mailbox provider validation`; PR problem/result/validation in English, no real addresses/secrets, attach created PR to task. Release/promotion и migration rollout исполняются только по своим действующим правилам.

## Self-Review and Execution Handoff

Coverage: каталог/домены/TLS/precheck — 1–3; worker/native login — 4–5; runtime trust/certificate recovery/folders — 6–7; deletion/generations — 8; install/CI/backup/update — 9; permanent entry/standalone flow — 10; simple/advanced/app-password forms — 11; settings/search/demo/docs — 12; full/browser/real validation — 13. Review Focus каждый имеет tests в owning task. Контракты `mail_provider`, `connection_mode`, public states и callback названия одинаковы между задачами.

Порядок: 0 → 1 → 2 → 3 → 4 → **6 → 5** → 7 → 8 → 9 → 10 → 11 → 12 → 13. Endpoint trust должен быть готов до managed login persistence; task 4 уже предоставляет worker client. Отдельные tasks можно реализовать параллельно только при выборе этого способа владельцем и после фиксации общих интерфейсов; один владелец для каждого общего файла. План целостный: shipped результат включает работающие подключения, а не только плитки.

Владелец уже согласовал план и **subagent-driven** исполнение, затем запросил повторное изучение. Уточнения ниже исправляют технические контракты без изменения согласованного UX/scope; повторное согласование обычных деталей реализации не требуется. Отдельный gate для изменения сервера сохраняется.

Источники native контракта: [pinned bridge.proto](https://github.com/mnixry/proton-bridge/blob/eabe5b282e4b07a4fc720233fb85ddb4ab335b7f/internal/frontend/grpc/bridge.proto), [pinned go.mod](https://github.com/mnixry/proton-bridge/blob/eabe5b282e4b07a4fc720233fb85ddb4ab335b7f/go.mod). Официальные настройки провайдеров и ограничения источников перечислены в спецификации; перед выпуском проверить актуальность ссылок, не заменять неизвестный deep link догадкой.
