# Повторное изучение Mailbox Providers перед реализацией

Дата: 2026-10-10. Исходная ревизия: `3c93b98e`, ветка `codex/mailbox-providers`.
Этот проход меняет только документацию. Согласованные UX, права создания восьми видов ящиков
и subagent-driven исполнение сохранены. Продукт, deploy scripts и зависимости не изменялись;
контейнеры не запускались, секреты и `data/` не читались. Отдельный rollout gate сохраняется.

## Основания и исправленные решения

Таблица описывает изученный исходный код и решения для реализации, а не уже реализованные
исправления. Номера строк относятся к исходной ревизии. В последнем столбце указана цена ошибки.

| Решение | Источник и причина | Риск / задачи |
| --- | --- | --- |
| SMTP probe в отдельном Node child; public verify с forceAuth, private IPC, kill + await exit | Исходный Nodemailer 10.0.10 `lib/smtp-transport/index.js`: verify socket closure-local, close/pool.close его не отменяют. [smtpTransport.js](../../backend/src/services/smtpTransport.js) строки 129–132 | Висящие сокеты/ложная отмена; 2, 6 |
| Nullable explicit IMAP TLS mode, forced STARTTLS, bounded DNS и empty answers fail closed | [connection.js](../../backend/src/services/accounts/connection.js) строки 54–82 связывают port validation с policy; [imapManager.js](../../backend/src/services/imapManager.js) строки 1676–1692 используют boolean TLS | Downgrade или поломка legacy; 1–3, 6 |
| Общий canonical address lock: existing SQL transaction client либо matching session lock; bounded wait | [oauthGoogle.js](../../backend/src/routes/oauthGoogle.js) строки 210–229; [oauth.js](../../backend/src/routes/oauth.js) строки 232–248; [mailboxActions.js](../../backend/src/services/mailNode/mailboxActions.js) строка 200 | Дубли или deadlock между connections; 3, 5 |
| Trusted CLI legacy отдельно от employee HTTP; managed Proton immutable; safe GET и registered audit | [manualAccounts.js](../../backend/src/services/accounts/manualAccounts.js) SAFE_FIELDS; [accounts.js](../../backend/src/routes/accounts.js) строки 48, 222; [account.js](../../backend/src/cli/commands/account.js); [auditLog.js](../../backend/src/services/auditLog.js) | Обход ограничений, потерянный audit, CLI regression; 1, 3, 12 |
| Durable actor/request UUID, reconnect intent/account ID, creator_user_id | Новый SQL/native commit boundary tasks 1/5 и existing OAuth explicit reconnect contracts; creator только для аудита | Повтор login, переподключение другого native user, дубли после crash; 1, 3–5, 7, 11 |
| Native secrets base64(UTF8), BridgePass текстом; asynchronous RPC требуют terminal reconciliation | Pinned Login, RemoveUser, password response — ссылки ниже; RPC acknowledgement не означает завершённую goroutine | Ошибка AUTH или неверный cleanup; 4, 5, 8 |
| Cancel/TTL удерживает global native login slot; removal pending блокирует re-add до event и GetUserList absence | Асинхронный native lifecycle; standalone generation/fence check не устраняет TOCTOU. Stuck attempt требует controlled process recovery с Proton outage | Stale cleanup удаляет новую сессию; 4, 8, 9 |
| SetUserSplitMode с подтверждением до probes; linked user под lifecycle/reconnect | Изученный SHA начинает в Combined, адресная модель требует split | Неверный mailbox или обрыв соседних sessions; 4–8 |
| ensureFolder returned path используется в snooze/labels move/copy/storage/wakeup | [mail.js](../../backend/src/routes/mail.js) строки 2229, 2264, 2276–2298; [labels.js](../../backend/src/services/labels.js) строка 66 теряет path, строка 180 использует resolvePath | Расхождение с Folders namespace; 7 |
| Managed Proton пропускает дополнительный Sent append по trusted identity | [sendDelivery.js](../../backend/src/services/sendDelivery.js) строки 215–226, 386; предшествующий real spike с одной копией | Дубли Sent или spoofing через label; 7 |
| Snapshot gate охватывает sendDelivery, ruleForwarder, SQL commit/reconcile и native lifecycle | [sendDelivery.js](../../backend/src/services/sendDelivery.js) markEffectStarted строка 293; [ruleForwarder.js](../../backend/src/services/ruleForwarder.js) sendMail строка 394; [jobQueue.js](../../backend/src/services/jobQueue.js) at-most-once contract | Snapshot во время принятой отправки; 5, 7–9 |
| Живой stalled sender → busy за 60 s; send leases не истекают; orphan только после остановки старого backend | Таймер не отличает медленного sender от умершего. Job queue lease и worker send admission lease — разные механизмы | Потеря at-most-once; 9 |
| Исторический restore/rollback переводит все restored queued/running send_message в needs_attention с evidence | [restore.sh](../../scripts/deploy/restore.sh), [rollback.sh](../../scripts/deploy/rollback.sh) возвращают старую БД, где уже отправленное могло быть queued | Повтор письма получателю; 9, 13 |
| Fifth image inventory определяется target commit; общий recreate проверяет actual namespace | [promote-latest.sh](../../scripts/ci/promote-latest.sh) строка 26; [updater.sh](../../scripts/deploy/updater.sh), [lib/config.sh](../../scripts/deploy/lib/config.sh), [test/e2e.sh](../../scripts/deploy/test/e2e.sh) | Historical promotion/backend recreate ломает worker; 9 |
| MessageList mobile action плюс shared action в reading/contacts, modal-first input | [MessageList.jsx](../../frontend/src/components/MessageList.jsx) mobile header; [MailApp.jsx](../../frontend/src/components/MailApp.jsx) строки 536–708, 844–850 | Кнопка пропадает, background shortcut действует под modal; 10 |
| Portal theme/font/visualViewport/inert согласованы с shell | [MailApp.jsx](../../frontend/src/components/MailApp.jsx) строка 113 scale; [ComposeModal.jsx](../../frontend/src/components/ComposeModal.jsx) строки 493–503 viewport; html theme и app root | Двойной scale, потеря focus, скрытые controls; 10 |
| Optional form props, completion union и opaque OAuth attempt ID start/callback | [GmailAddForm.jsx](../../frontend/src/components/GmailAddForm.jsx) строки 35, 73, 104, 175; [DomainMailboxAddForm.jsx](../../frontend/src/components/DomainMailboxAddForm.jsx) строки 42, 110; [App.jsx](../../frontend/src/App.jsx) и MailApp callback | Late A закрывает B, ломается alias/external-browser completion; 3, 10, 11 |
| Managed save metadata-only, demo permissions совпадают, clipboard/helper и brand i18n exceptions | [accountUpdate.js](../../frontend/src/utils/accountUpdate.js), [clipboard.js](../../frontend/src/utils/clipboard.js), [demo/index.js](../../frontend/src/demo/index.js), [i18n.test.js](../../frontend/src/locales/i18n.test.js) | Employee не сохраняет metadata, demo вводит в заблуждение, copy теряет focus; 11, 12 |

Native evidence относится к `mnixry/proton-bridge` SHA `eabe5b282e4b07a4fc720233fb85ddb4ab335b7f`:
[Login](https://github.com/mnixry/proton-bridge/blob/eabe5b282e4b07a4fc720233fb85ddb4ab335b7f/internal/frontend/grpc/service_methods.go#L444),
[RemoveUser](https://github.com/mnixry/proton-bridge/blob/eabe5b282e4b07a4fc720233fb85ddb4ab335b7f/internal/frontend/grpc/service_user.go#L141),
[response encoding](https://github.com/mnixry/proton-bridge/blob/eabe5b282e4b07a4fc720233fb85ddb4ab335b7f/internal/frontend/grpc/utils.go#L67),
[Bridge password](https://github.com/mnixry/proton-bridge/blob/eabe5b282e4b07a4fc720233fb85ddb4ab335b7f/internal/user/user.go#L561),
[protobuf](https://github.com/mnixry/proton-bridge/blob/eabe5b282e4b07a4fc720233fb85ddb4ab335b7f/internal/frontend/grpc/bridge.proto).
Это read-only анализ pinned source. Точная команда native assertions в переданном журнале
не сохранилась, поэтому отдельный воспроизводимый runtime pass здесь не заявляется.

## Что действительно проверено

Команды выполнены агентом повторного изучения из `frontend/` до установки зависимостей
в изолированном worktree; результаты переданы контролирующему агенту.

| Команда | Результат |
| --- | --- |
| `node --test src/utils/addAccount.test.js src/utils/accountSearch.test.js src/utils/accountUpdate.test.js src/utils/googleOAuth.test.js src/utils/latestRequest.test.js` | exit 0; 82 passed |
| `node --test src/utils/accountHealth.test.js src/utils/accountScope.test.js src/utils/resumeRefresh.test.js` | exit 0; 66 passed |
| Первая combined команда включала также `src/utils/mailNode.test.js` | 82 passed и 1 load failure: отсутствовал date-fns; ошибка окружения, не assertion regression и не успешный suite |
| Read-only pinned native source inspection | Исследованы контракты; новые provider/runtime/deploy tests не запускались |
| `git diff --quiet` в конце read-only изучения | exit 0; изучение не изменило tracked files |

Исходные npm зависимости только читались для анализа контрактов. npm ci и полный baseline
выполняются контролирующим агентом отдельно; их результаты не смешиваются с 82+66 pure tests
и не доказывают новую функциональность. Исходный real Proton spike подтверждает один account
без 2FA и single-copy Sent, но не несколько адресов/users, managed lifecycle, новый UI или snapshot.

## Выход повторного изучения

В [план](../superpowers/plans/2026-10-10-mailbox-providers.md) внесены owning files, interfaces
и дополнительные RED/GREEN проверки. В [спецификацию](../superpowers/specs/2026-10-10-mailbox-providers-design.md)
внесены технические условия совместимости. В ignored SDD ledger ни одна задача реализации
не отмечена завершённой. Матрица 14 задач (0–13) и всех 91 пары сохранена локально в
`.superpowers/sdd/2026-10-10-mailbox-providers/restudy-revision-report.md`.

## Дополнение: baseline после подготовки зависимостей

Контролирующий агент отдельно сообщил: backend npm ci exit 0 (347 packages, 0 vulnerabilities),
frontend npm ci exit 0 (598 packages, 8 existing moderate vulnerabilities); electron-winstaller
install script не разрешался. Dependency/lockfile changes не делались.
Backend npm test: 334 suites passed, 1 failed; 5404 tests passed, 3 skipped. Failure — openssl ENOENT.
С существующим Git OpenSSL в PATH команда `npx vitest run src/services/mailNode/dnsCheck.test.js`
дала exit 0, 56 passed. После этого полный backend `npm test` с Git OpenSSL в PATH завершился exit 0: 335 files, 5406 passed, 1 skipped, 73.10 s. Полный frontend `npm test` также завершился exit 0: 5481 passed, 463 suites, 0 failed/skipped, 310708 ms. Процесс не завершали принудительно.

Read-only источник причины: `frontend/src/locales/i18n.test.js` строки 318, 393, 411 используют
`resolve(dir, '../..')`, то есть сканируют frontend root вместе с node_modules/build/native files.
`loadSourceTranslationCalls` строка 541 уже использует source root `resolve(dir, '..')`.
Прямое исправление остальных трёх roots на src отнесено к task 0 как baseline prerequisite; проблема — медленный и избыточно широкий scan, не failing test;
coverage source, проверки unused/hardcoded строк и запрет ослабления тестов сохраняются.
В этом документационном коммите тестовый код не меняется.
