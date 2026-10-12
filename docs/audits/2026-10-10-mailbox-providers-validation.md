# Проверка провайдеров почтовых ящиков

Актуализировано 2026-10-12. **Статус: частичная проверка; Task 13 не завершена, к rollout не готово.**

## Проверенное состояние

Первоначальные проверки и визуальная матрица выполнены на `codex/mailbox-providers`, код `e3c97e36`. Исправления main `372cf016` прошли все checks CI PR #240 и с разрешения владельца слиты коммитом `e5d7e51c`. Rebase завершён без конфликтов: `b99c211c`, включая исправление обхода IPv6 SSRF. Итоговый проверенный код — `c2e26a55`: исправления ложной ошибки фильтра stderr при backup и возврата фокуса из мобильного меню. Последующие коммиты отчёта меняют только документацию. CI PR #241 на `34cab4da`: все 10 checks SUCCESS, включая Deploy e2e.

Предыдущее финальное ревью всей фичи завершено с исправлениями до `986cd08b`. Дополнительное ревью в этом продолжении охватило доработки интерфейса `986cd08b..19de8ff3`, исправления main `80e9e87b..372cf016` и fix2 `19de8ff3..e3c97e36`. Новые подтверждённые блокирующие дефекты в этих диапазонах не найдены. Это не подтверждает работу живых провайдеров.

## Автоматические проверки

| Проверка | Состояние и результат |
| --- | --- |
| Полный backend фичи | После rebase на `b99c211c`: `npm test` — 364 файла, 5803 passed, 1 существующий skipped; `npm run lint` и `npm run lint:plugins` exit 0. Backend после этого не менялся |
| Полный frontend фичи | После rebase на `b99c211c`: 5824/5824. После исправления c2e26a55: `npm test` — 5827/5827; `npm run lint` и `npm run build` exit 0. Есть предупреждение Vite о размере chunks |
| Диалог и формы | В этом продолжении: `node --test src/utils/oauthReturnWatch.test.js src/components/addAccount/ProviderForms.render.test.js src/components/AddAccountDialog.render.test.js src/components/MailApp.addAccount.render.test.js` в frontend — 87/87, 14 suites, exit 0 |
| Исправления main | В этом продолжении: `npx vitest run src/services/hostValidation.test.js src/services/safeFetch.test.js src/services/inboxRules.regex.test.js src/routes/mail.folderDelete.pglite.test.js src/routes/auth.disabledLogin.test.js src/routes/oauth.microsoft.test.js src/routes/contacts.photo.test.js src/routes/send.queue.pglite.test.js` — 8 файлов, 228/228, exit 0 |
| Worker | До rebase: 84/84 на mounted HEAD source в `me-proton-worker-dev:fix2`, exit 0. После rebase: `docker run --rm --network none --read-only --tmpfs /tmp --env PYTHONPATH=/opt/mailexpert-proton:/opt/mailexpert-proton/bridge_grpc --mount type=bind,source=<WORKER_TESTS>,target=/tests,readonly --entrypoint python me-e2e-proton/mailexpert-proton-worker:sha-b99c211cd1f3 -B -m unittest discover -s /tests -t /tests` — 84/84, exit 0. Проверялся runtime Python нового образа. Worker после этого не менялся |
| Deploy | Полный tracked-экспорт `git archive HEAD` на `f7e1a3fe`, одноразовый контейнер `mirror.gcr.io/bats/bats:1.14.0` с jq, git, util-linux и shellcheck. `shellcheck $(find scripts deploy frontend -name '*.sh') && bats scripts/deploy/test` — shellcheck exit 0, Bats 599/599, exit 0 |
| PostgreSQL creation race | После rebase: `bash scripts/deploy/test/e2e-provider-creation.sh --project me-e2e` — PostgreSQL 16, 99 migrations, шесть гонок между отдельными Node процессами, одна вставленная запись в каждой, exit 0. Ownership cleanup подтверждён |
| DinD | Четыре образа собраны из проверяемого HEAD. `E2E_ID=proton-resume-20261012 bash scripts/deploy/test/e2e.sh --version sha-b99c211cd1f3 --image-prefix me-e2e-proton` — полный install и backup/update/restore e2e, exit 0. После исправления фильтра: `E2E_ID=proton-final-20261012 bash scripts/deploy/test/e2e.sh --version sha-f7e1a3fe852b --image-prefix me-e2e-proton --only backup` — exit 0. Реального связанного ящика Proton в этих фикстурах нет |
| Tenant worker | `node --test deploy/tenant-worker/worker.test.mjs`, Git OpenSSL в PATH — 23 passed, 1 skipped, exit 0. Пропуск: импорт ExchangeOnlineManagement требует образа worker; dry-mode PowerShell выполнен |
| Whitespace | `git diff --check 986cd08b e3c97e36` и `git diff --check 80e9e87b 372cf016` — exit 0 |

Логи предыдущих полных прогонов, новое ревью и `task13-bats-shellcheck.log` сохраняются в локальном SDD-каталоге. Локальные файлы не заменяют результаты GitHub CI.

Новая находка полного DinD: успешный backup писал ложное сообщение ERR trap из `proton.sh`, потому что `grep -v` возвращал 1 на пустом/полностью отфильтрованном stderr tar. RED regression подтвердил дефект (1 failed / 1 passed). В `f7e1a3fe` фильтр заменён на `awk`; пустой вывод и пропущенные сокеты больше не запускают ERR trap, настоящие предупреждения и ненулевой код tar сохраняются. GREEN: shellcheck и 47 owning Bats tests exit 0, затем полный Bats 599 и повтор DinD exit 0. В повторном DinD прежнего ложного сообщения нет. Ошибки намеренно неработоспособной версии, неверного ключа и отказа restore поверх БД — ожидаемые отрицательные сценарии. Первый owning Bats запуск не имел git в одноразовом контейнере; повтор с git прошёл.

## Проверка интерфейса

Отдельный demo запущен с разрешения владельца: `npm run demo -- --host 127.0.0.1 --port 5199 --strictPort`. Проверка выполнена во встроенном браузере. Demo владельца на другом порту и серверные установки не менялись.

- Восемь плиток открывают отдельные формы; «Назад» возвращает к выбору, технические поля закрыты по умолчанию. Проверены 128 сочетаний: восемь провайдеров, ширины 320/390/768/1440, RU/EN, Light/Dark. DOM-замеры горизонтального переполнения диалога во всех сочетаниях отрицательные; сохранены снимки. Длинные подсказки на телефонах прокручиваются внутри диалога. Репрезентативные снимки просмотрены визуально.
- Tab с последней плитки возвращается на «Закрыть», Shift+Tab идёт обратно к последней плитке; Escape закрывает диалог. При открытии из постоянной кнопки фокус после закрытия возвращается на неё.
- Режим сотрудника demo показывает все восемь плиток и разрешает открыть расширенные IMAP/SMTP настройки «Другого».
- Кнопка копирования ссылки Яндекса показывает «Ссылка скопирована», ссылка ведёт на страницу безопасности Яндекс ID. Пароли в браузере агент не вводил.
- Поиск в настройках сотрудника фильтрует Proton до одного результата из 51; кнопка переподключения доступна. После открытия и закрытия нового диалога строка поиска сохраняется.
- На свежем живом стенде проверены состояния с нулём ящиков и одним подключённым Proton; снимки сохранены вне source. Проверка реальной мобильной клавиатуры, Android Back и внешнего OAuth на устройстве не выполнена.

Снимки и JSON матрицы сохранены вне исходников в каталоге артефактов текущей задачи; в Git не включены. Ошибок Vite overlay или пустого экрана не наблюдалось. В консоли при переключении layout есть предупреждения React о смешении `border` с `borderBottom`/`borderLeft`; в render-тесте остаётся предупреждение act. Поэтому консоль не обозначена как полностью чистая.

## Что остаётся обязательным

1. Draft PR #241 создан от владельца и прикреплён. CI `34cab4da`: все 10 checks SUCCESS. Последующий push отчёта требует проверки состояния PR перед merge; feature merge не согласован.
2. Живой Proton Free: исправление/повторная проверка отказа IMAP AUTH после полного restore, а также timeout во время фактической SMTP передачи остаются. Исторический send quarantined до старта восстановленной installation, попыток0. Остальные функциональные проверки и scratch restore прошли ниже. Много native users/адресов и 2FA требуют дополнительных аккаунтов. Другие провайдеры требуют предоставленных аккаунтов; реальные AUTH ещё не проверены.
3. Отдельный живой стенд согласован и установлен штатным installer из exact-tag images проверяемого кода. Штатный `stage.sh panel` по-прежнему требует опубликованные образы main; CI PR их только собирает. Существующий стенд не менялся. Restic off-site и restore связанного snapshot не засчитаны.
4. Для обновления существующего стенда: видимость опубликованного пакета worker, read-only status и отдельный план/согласование rollout с миграцией `0099`, backup и возвратом по `mailexpert-rollout`.

## Известные ограничения

Неофициальный Bridge для Proton Free остаётся зависимостью, постоянная доступность API не гарантируется. Принятые владельцем риски приватного native gRPC и focus-порта записаны в спецификации.

Открытые замечания из handoff: недоступные тосты под модальным диалогом; повтор snapshot begin с тем же ID во время drain преждевременно сообщает snapshot (текущий скрипт его не повторяет); избыточная рекомендация остановки сервисов при snapshot_busy; восстановление cleanup после удаления failed job через 30 дней недостаточно описано. В исправлениях main timeout-отравленный regex не совпадает до рестарта; соседние auth-маршруты открытой disabled-сессии, Google callback и push DNS rebinding остаются за рамками этого набора.

## Дополнительная проверка c2e26a55

Исправлен возврат фокуса после мобильного меню: закрытый drawer сохраняет opener за пределами экрана. Диалог возвращает фокус на видимую постоянную кнопку; скрытые и удалённые opener не выбираются. Три regression tests: сначала два failures для скрытого/удалённого opener, затем отдельный failure для offscreen opener; после исправления 32/32 dialog/shell tests прошли. Полный frontend `npm test` — 5827/5827, exit 0; lint/build exit 0. В реальном demo браузере mobile menu → Add account → Close возвращает фокус на постоянную кнопку с видимым прямоугольником. Screenshot сохранён вне source как `mobile-focus-return-fixed.png`.

Владелец отдельно согласовал свежий стенд: exact-tag c2e26a55, штатный `install.sh`, local-auth, локальный compose overlay по образцу stage.sh, отдельные имена/volume, без изменений существующего стенда. Четыре image builds, fixture shellcheck, installer и HTTPS version check с доверенным локальным CA: exit 0. `status.sh --target sha-c2e26a5581d6 --json`: ready true, 99 migrations, pending/unknown migrations пусты, checkout clean, worker idle, problems пусты. Off-site restic не настроен; `healthcheck.sh` exit 0 сообщает `backup: not configured`. Это ограничение тестового стенда, а не успешная проверка backup со связанной учёткой.

Первый bootstrap остановился до запуска installer: Git Bash temporary path не был переведён в Windows path для Docker cp. Исправлен путь в одноразовом harness, ownership пустого fixture проверен перед продолжением. Продукт и установленные scripts не патчились.

Автоматический браузер отказался открывать локальный Caddy certificate (`ERR_CERT_AUTHORITY_INVALID`). Владелец принял предупреждение в Chrome и затем явно поручил агенту вход с ранее предоставленными учётными данными. На отдельном стенде зарегистрирован локальный администратор штатным API, вход Proton выполнен через новую плитку. Секреты не сохранялись в отчётах; installed scripts не изменялись.

### Живой Proton Free

- Login без 2FA успешно завершён, одна managed учётка healthy, девять прежних входящих синхронизировались. Через интерфейс сохранён отдельный тестовый черновик; в БД одна запись Drafts с его темой. Редактирование/повторное сохранение и flags/folders/trash остаются.
- Одна отправка через штатный `/api/mail/send` на согласованный внешний ящик: durable job `1`, `done`, `attempts=1`; одна копия с тестовой темой в Sent. Подтверждение получения на стороне адресата и ответ ещё не получены; SMTP acceptance не выдаётся за подтверждённую доставку.
- Вложение 10 MiB получено обратно из Sent методом установленного `ImapManager.fetchAttachment`: 10485760 байт, SHA-256 `62be011d59b684394b8316bb24bc0e272982f487875524da82e5ea6876b2baba`, совпадение, exit 0. BODYSTRUCTURE сообщает 14348936 байт MIME/base64, поэтому UI показывает 13.7 MB: отображаемый размер завышен, данные не повреждены. Через UI загрузка файла не проверена: Chrome extension требует разрешения доступа к file URLs; скачивание прервало управление браузером.
- Штатный `backup.sh --tag manual --keep-dump <PREFIX>/backups/proton-live-check.dump`: exit 0, snapshot gate закрыт, Bridge остановлен, одна связанная учётка, 38 файлов worker state добавлено, gate открыт. БД: 99 migrations, один user и один mailbox, dump 196640 байт. Worker archive остаётся рядом с dump внутри стенда, не читался. Off-site restic и restore этого снимка не проверены.
- Перезапуск через установленный `app_compose`: одновременный restart backend/worker оставил Bridge в прежнем network namespace (IMAP ECONNREFUSED). После завершения старта backend и отдельного restart worker подключение восстановилось без пароля. Fetch attachment повторно прошёл; штатная синхронизация возобновилась, `sync_error IS NULL`, свежий `last_sync`, `imap_skip_tls_verify=false`. Для ручной операции соблюдать порядок backend → worker; deploy scripts также имеют `ensure_proton_namespace` для пересоздания worker после пересоздания backend.
- Worker health: HTTP 200, `state=running`, linkedAddresses=1, sendLeases=0, snapshotId=null, pending/stuck removals=0. `status.sh` exit 0, ready=true, problems пусты. Поздний `healthcheck.sh` exit 1: backup не настроен. Первоначальный exit 0 не означает настроенный off-site backup.
- Из сети стенда TLS verification прошёл для Yahoo IMAP/SMTP, Mail.ru IMAP/SMTP, iCloud IMAP/SMTP, Yandex IMAP. Yandex SMTP 465 timeout воспроизведён OpenSSL и Node IPv4; авторизация другими провайдерами не проверена, аккаунтов нет. Не выдавать network smoke за полноценное подключение.

Управление Chrome остановилось при скачивании, затем восстановилось. Владелец отдельно разрешил агенту отправить контрольный ответ из Gmail. Пароль для выполненного входа повторно не требуется.

### Продолжение живой проверки

- На `bc581033` все 11 checks GitHub CI SUCCESS, включая Images и Deploy e2e. Далее изменён только отчёт.
- В Gmail открыт доставленный тест: правильная тема, одно вложение 10 MB, mailed-by/signed-by `proton.me`, Standard encryption (TLS). Снимок `live-gmail-delivered.png` вне source. Download event и downloadMedia браузерного инструмента завершились timeout; наличие ранее скачанного совпадающего файла не выдаётся за новый download из Gmail. Hash подтверждён из Sent выше, Gmail byte-for-byte download не засчитан.
- После отдельного явного разрешения отправлен один контрольный ответ Gmail → Proton; Gmail показал Message sent. Входящие увеличились с 9 до 10, ответ появился в панели с правильным контрольным текстом. SQL сравнение: `in_reply_to = original.message_id`, References содержит original.message_id, body содержит контрольный token — все true. Панель предлагает цепочку из двух сообщений. Снимок `live-gmail-reply-in-proton.png` вне source.
- Тестовый draft открыт, тема изменена и повторно сохранена. В Drafts ровно одна запись с новой темой. Действие Close предлагает удаление draft, поэтому выбрано продолжение редактирования и сворачивание: сохранённый draft оставлен владельцу, не удалялся.
- Создана и переименована отдельная QA папка. На единственном новом тестовом письме проверены unread/starred (серверные значения false/true), перенос Sent → QA folder, Delete → Trash, восстановление Trash → Sent. Чужие прежние письма не менялись. Итог: одна Sent копия, Trash/QA копии этого теста отсутствуют. Повторный hash после восстановления совпал, exit 0. Пустая QA папка оставлена; снимок `live-restored-sent.png` вне source.
- Установленный `withProtonSendLease` удерживал настоящую worker lease 90 s без SMTP передачи. Штатный backup получил snapshot_busy через 60 s, exit 1; новый dump не создан. Lease release exit 0; worker HTTP 200/running, sendLeases=0, snapshotId=null. Job queue содержит только исходный done send_message, нового job/повторной отправки нет. Это проверка admission/drain на реальном worker, не timeout передачи SMTP и не restore исторического dump.
- Отдельные план и runner локального S3/restic `backup --verify` согласованы владельцем и выполнены, результат ниже. Живая БД при verify не заменяется. Task 13 остаётся частичной из-за указанных выше непроверенных runtime сценариев.

### Restic со связанной учёткой

По отдельному явному разрешению внутри того же DinD запущен S3 stand-in из pinned `rclone/rclone:1.71.1`, уже используемого repository e2e. Image передан из host cache, версия не менялась; порт опубликован только на внутреннем loopback. Тестовые ключи созданы внутри fixture и переданы штатному `configure.sh` на stdin, значения не печатались. Existing установки и зависимости не менялись.

Штатные `ensure_backup_repo` и `backup.sh --prefix <PREFIX> --tag manual --verify`: **exit 0**. Gate закрыт, Bridge остановлен, linkedAddresses=1, worker archive содержит 38 файлов, gate открыт. DB dump 2564944 байт; counts: 99 migrations, user=1, mailbox=1. Restic snapshot `0ee723a7` stored. Restore в scratch PostgreSQL без сети занял 2 s; counts совпали; штатный verifier: `migrationsApplied=0`, `decrypted=2`, `failed=0`, `mailboxValues=2`. Живая БД не заменялась, backend/job worker восстановленного snapshot не запускался. Scratch контейнеров после cleanup нет.

Post-check: `healthcheck.sh` **exit 0**, healthy. Worker HTTP 200/running, linkedAddresses=1, sendLeases=0, snapshotId=null, pending/stuck removals=0. Свежий last_sync, sync_error NULL, imap_skip_tls_verify=false; в очереди тот же единственный done send_message. Повторный fetch attachment из одной Sent копии: 10485760 байт, прежний SHA-256, matches=true, exit 0. Повторных писем после verification не возникло.

Это проверенный encrypted backup/DB restore в локальном test S3. Он не обеспечивает off-site защиту и не доказывает запуск исторической копии с работающим job worker или восстановление native Bridge state в другой installation. Для последнего нужен отдельный согласованный first-install/restore rehearsal; `restore.sh` штатно отказывается работать рядом с существующей БД. Не обходить этот guard и не заменять реставрацию ручным pg_restore.

### Полное восстановление: найденный сбой

Для rehearsal штатный installer подготовил вторую installation в том же изолированном Docker daemon с `--no-start`, exit0, standby=true, без запущенного backend. На запрос restore владелец уточнил, что нужен один рабочий стенд. Проверка выполнена с временным переключением: A остановлен до старта B, после теста A возвращён; все контейнеры B остановлены. Дополнительных host ports нет, private state/volumes не удалены.

Через установленный enqueueOutgoingSend создан job2 на+24h с отдельным test dedupe key. Штатный backup сохранил snapshot `207bfe86`, dump2566713bytes, 38 worker files; затем cancelScheduled подтвердил cancelled на A. Штатный restore.sh восстановил новую DB, keys и 37 worker files, counts99migrations/user1/mailbox1, verifier decrypted2/failed0. До запуска backend historical job2 стал `needs_attention`, `error_code=restored_from_backup`, attempts0. B ready=true, worker running/linked1, TLS verification не отключалась.

Однако установленный ImapManager.fetchAttachment на B получил IMAP authentication rejection и не восстановился за бюджет60s: **первый rehearsal runner exit1**. На момент этого запуска причина была неизвестна. CLI probe на ошибке также пишет предупреждение из-за headless `ImapManager(null)`; это недостаток harness, отдельно от наблюдаемого IMAP AUTH rejection. Не менять пароль/worker state вручную и не маскировать результат bypass TLS или monkey-patching. Продолжение расследования приведено ниже.

Finally остановил B backend/worker и запустил A; далее все остальные контейнеры B также остановлены по уточнению владельца об одном стенде. На A healthcheck exit0/healthy, last_sync свежий, sync_error NULL, исходный job2 cancelled, attachment hash совпал из одной Sent копии, exit0. Работа владельца осталась на исходном локальном stand. SMTP fault test не запускался: по правилу владельца о неуспехе прямого пути дальнейшее выполнение остановлено с отчётом.

Первый запуск harness остановился до enqueue/изменения БД из-за CRLF в destination на stdin; SQL подтвердил отсутствие test job и healthy A. Исправлено чтение CR в одноразовом runner, не в продукте; повтор начал описанный выше rehearsal. Это не замена failing product checks.

### AUTH после restore: штатное переподключение проверено

После явного поручения продолжить исправление проверили уже восстановленную installation, без
нового restore или изменения private state. Read-only клиент штатного Bridge gRPC вывел только
enum и boolean: `state=0` (SignedOut), `splitMode=true`, один адрес, `passwordPresent=false`.
API worker возвращал `not_connected`, в том числе после ожидания40s. Таким образом причиной
отказа IMAP была отсутствующая авторизованная native-сессия, а не ошибка TLS или расшифровки
сохранённого IMAP-пароля. Готовность HTTP панели и работа процесса worker этого не обнаруживают.

В [закреплённом исходнике Bridge](https://github.com/mnixry/proton-bridge/blob/eabe5b282e4b07a4fc720233fb85ddb4ab335b7f/internal/bridge/user.go)
`loadUser` при запуске выполняет refresh и очищает auth secrets при `AuthRefreshTokenInvalid`.
Устаревший refresh token после продолжения работы исходной installation — вероятное объяснение
состояния снимка, **не доказанный ответ Proton API**: его raw logs и токены не извлекались.
Снимок локального состояния не гарантирует действительность сессии на стороне провайдера.

На B выполнен штатный `startProtonConnection` с `reconnectAccountId` существующего ящика и
последующие `getProtonConnection`, через установленный backend SDK. Ранее предоставленный
тестовый пароль прошёл только по stdin; файл с паролем, ручная замена BridgePass, изменения
Bridge и TLS bypass не применялись. Runner завершился0 и проверил сохранение того же mailbox ID.

Независимый post-check runner завершился0. После перезапуска native state стал Connected (`2`),
split mode сохранился, IMAP/SMTP-пароли, сертификат и login совпали с текущими данными worker.
`ImapManager.fetchAttachment` вернул10485760bytes с прежним SHA-256
`62be011d59b684394b8316bb24bc0e272982f487875524da82e5ea6876b2baba`, одна Sent копия.
Фоновая синхронизация дала `sync_error IS NULL=true`, свежий `last_sync=true`.
Historical job остался `needs_attention/restored_from_backup/attempts=0` после работающего
backend и повторного запуска; переподключение не снимает карантин отправки.
Все B containers снова остановлены; исходный stand возвращён и healthcheck healthy.

Существующие owning tests `reconcile.pglite.test.js` и `connections.pglite.test.js`:35/35,
exit0. Первый локальный запуск отказал из-за отсутствующего в PATH OpenSSL; повтор использовал
уже установленный Git OpenSSL, без установки/обновления зависимостей. Продуктовый код не менялся.
Инструкция восстановления дополнена повторным входом через существующий ящик и проверками
почты. **Restore с повторным входом проверен; автоматическое восстановление старой сессии без
пароля не обещается.** Actual SMTP timeout остаётся отдельной незавершённой проверкой Task13.

