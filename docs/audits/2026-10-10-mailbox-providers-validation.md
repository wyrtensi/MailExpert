# Проверка провайдеров почтовых ящиков

Актуализировано 2026-10-12. **Статус: частичная проверка; Task 13 не завершена, к rollout не готово.**

## Проверенное состояние

Первоначальные проверки и визуальная матрица выполнены на `codex/mailbox-providers`, код `e3c97e36`. Исправления main `372cf016` прошли все checks CI PR #240 и с разрешения владельца слиты коммитом `e5d7e51c`. Rebase завершён без конфликтов: `b99c211c`, включая исправление обхода IPv6 SSRF. Итоговый проверенный код — `f7e1a3fe`: дополнительное исправление ложной ошибки фильтра stderr при backup. Последующий коммит отчёта меняет только документацию.

Предыдущее финальное ревью всей фичи завершено с исправлениями до `986cd08b`. Дополнительное ревью в этом продолжении охватило доработки интерфейса `986cd08b..19de8ff3`, исправления main `80e9e87b..372cf016` и fix2 `19de8ff3..e3c97e36`. Новые подтверждённые блокирующие дефекты в этих диапазонах не найдены. Это не подтверждает работу живых провайдеров.

## Автоматические проверки

| Проверка | Состояние и результат |
| --- | --- |
| Полный backend фичи | После rebase на `b99c211c`: `npm test` — 364 файла, 5803 passed, 1 существующий skipped; `npm run lint` и `npm run lint:plugins` exit 0. Backend после этого не менялся |
| Полный frontend фичи | После rebase на `b99c211c`: `npm test` — 5824/5824; `npm run lint` и `npm run build` exit 0. Есть предупреждение Vite о размере chunks. Frontend после этого не менялся |
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
- Отдельных визуальных сценариев с фактически нулевым и одним подключённым ящиком пока нет; их поведение покрыто существующими render-тестами. Проверка реальной мобильной клавиатуры, Android Back и внешнего OAuth на устройстве не выполнена.

Снимки и JSON матрицы сохранены вне исходников в каталоге артефактов текущей задачи; в Git не включены. Ошибок Vite overlay или пустого экрана не наблюдалось. В консоли при переключении layout есть предупреждения React о смешении `border` с `borderBottom`/`borderLeft`; в render-тесте остаётся предупреждение act. Поэтому консоль не обозначена как полностью чистая.

## Что остаётся обязательным

1. Согласованный push и draft PR фичи, GitHub CI. CI исправлений main, разрешённый мерж, rebase и локальные проверки уже выполнены.
2. Живой Proton Free: ввод владельцем пароля и возможных challenge, sync, отправка/приём в разрешённом scope, одна копия Sent, вложение 10 MiB с проверкой hash, drafts/flags/folders/trash, рестарт и проверенный TLS. Много native users/адресов и 2FA требуют дополнительных аккаунтов. Другие провайдеры требуют предоставленных аккаунтов; реальные подключения ещё не проверены.
3. Штатный `stage.sh panel` требует опубликованные образы коммита main; CI PR их только собирает. Для живой проверки до мержа нужен отдельно согласованный одноразовый стенд со штатным installer и подготовленными exact-tag images. Обход публикации или ручное изменение существующего стенда не выполнялись.
4. Для обновления существующего стенда: видимость опубликованного пакета worker, read-only status и отдельный план/согласование rollout с миграцией `0099`, backup и возвратом по `mailexpert-rollout`.

## Известные ограничения

Неофициальный Bridge для Proton Free остаётся зависимостью, постоянная доступность API не гарантируется. Принятые владельцем риски приватного native gRPC и focus-порта записаны в спецификации.

Открытые замечания из handoff: возврат фокуса на скрытый пункт мобильного меню; недоступные тосты под модальным диалогом; повтор snapshot begin с тем же ID во время drain преждевременно сообщает snapshot (текущий скрипт его не повторяет); избыточная рекомендация остановки сервисов при snapshot_busy; восстановление cleanup после удаления failed job через 30 дней недостаточно описано. В исправлениях main timeout-отравленный regex не совпадает до рестарта; соседние auth-маршруты открытой disabled-сессии, Google callback и push DNS rebinding остаются за рамками этого набора.
