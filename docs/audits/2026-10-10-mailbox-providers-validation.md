# Проверка провайдеров почтовых ящиков

Актуализировано 2026-10-12. **Статус: частичная проверка; Task 13 не завершена, к rollout не готово.**

## Проверенное состояние

Ветка фичи: `codex/mailbox-providers`, код `e3c97e36`. Отдельные исправления main: `fix/bughunt-main`, `372cf016`. Пока исправления main не включены в фичу, известный обход SSRF через специальные формы IPv6 сохраняется в ручном добавлении. Порядок интеграции: исправления main, затем rebase фичи и повтор затронутых проверок.

Предыдущее финальное ревью всей фичи завершено с исправлениями до `986cd08b`. Дополнительное ревью в этом продолжении охватило доработки интерфейса `986cd08b..19de8ff3`, исправления main `80e9e87b..372cf016` и fix2 `19de8ff3..e3c97e36`. Новые подтверждённые блокирующие дефекты в этих диапазонах не найдены. Это не подтверждает работу живых провайдеров.

## Автоматические проверки

| Проверка | Состояние и результат |
| --- | --- |
| Полный backend фичи | Прогон предыдущего агента на `e3c97e36`: 360 файлов, 5725 passed, 1 существующий skipped; lint и lint:plugins exit 0. Без изменения кода повторно не запускался |
| Полный frontend фичи | Прогон предыдущего агента на `e3c97e36`: 5824/5824; lint и build exit 0. Без изменения кода повторно не запускался |
| Диалог и формы | В этом продолжении: `node --test src/utils/oauthReturnWatch.test.js src/components/addAccount/ProviderForms.render.test.js src/components/AddAccountDialog.render.test.js src/components/MailApp.addAccount.render.test.js` в frontend — 87/87, 14 suites, exit 0 |
| Исправления main | В этом продолжении: `npx vitest run src/services/hostValidation.test.js src/services/safeFetch.test.js src/services/inboxRules.regex.test.js src/routes/mail.folderDelete.pglite.test.js src/routes/auth.disabledLogin.test.js src/routes/oauth.microsoft.test.js src/routes/contacts.photo.test.js src/routes/send.queue.pglite.test.js` — 8 файлов, 228/228, exit 0 |
| Worker | `docker run --rm --network none --read-only --tmpfs /tmp --mount type=bind,source=<WORKER_SOURCE>,target=/source,readonly --env PYTHONPATH=/source:/opt/mailexpert-proton:/opt/mailexpert-proton/bridge_grpc --entrypoint python me-proton-worker-dev:fix2 -B -m unittest discover -s /source/tests -t /source/tests` — 84/84, exit 0. Монтировались исходники HEAD, а не копия Python из старого образа |
| Deploy | Полный tracked-экспорт `git archive HEAD`, одноразовый контейнер `mirror.gcr.io/bats/bats:1.14.0` с jq, git, util-linux и shellcheck. `shellcheck $(find scripts deploy frontend -name '*.sh') && bats scripts/deploy/test` — shellcheck exit 0, Bats 597/597, exit 0 |
| Tenant worker | `node --test deploy/tenant-worker/worker.test.mjs`, Git OpenSSL в PATH — 23 passed, 1 skipped, exit 0. Пропуск: импорт ExchangeOnlineManagement требует образа worker; dry-mode PowerShell выполнен |
| Whitespace | `git diff --check 986cd08b e3c97e36` и `git diff --check 80e9e87b 372cf016` — exit 0 |

Логи предыдущих полных прогонов, новое ревью и `task13-bats-shellcheck.log` сохраняются в локальном SDD-каталоге. Локальные файлы не заменяют результаты GitHub CI.

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

1. Зелёный CI исправлений main и отдельно разрешённый мерж, затем rebase фичи на обновлённый main.
2. DinD install/update/backup/restore на окончательном rebased HEAD и проверка создания в реальном PostgreSQL между процессами. Предыдущие прогоны до rebase не считать доказательством итоговой ветки.
3. GitHub CI фичи, видимость опубликованного пакета worker для установки.
4. Отдельно согласованный rollout указанного стенда с миграцией `0099`, backup и планом возврата.
5. Живой Proton Free: ввод владельцем пароля и возможных challenge, sync, отправка/приём в разрешённом scope, одна копия Sent, вложение 10 MiB с проверкой hash, drafts/flags/folders/trash, рестарт и проверенный TLS. Много native users/адресов и 2FA требуют дополнительных аккаунтов. Другие провайдеры требуют предоставленных аккаунтов; реальные подключения ещё не проверены.

## Известные ограничения

Неофициальный Bridge для Proton Free остаётся зависимостью, постоянная доступность API не гарантируется. Принятые владельцем риски приватного native gRPC и focus-порта записаны в спецификации.

Открытые замечания из handoff: возврат фокуса на скрытый пункт мобильного меню; недоступные тосты под модальным диалогом; повтор snapshot begin с тем же ID во время drain преждевременно сообщает snapshot (текущий скрипт его не повторяет); избыточная рекомендация остановки сервисов при snapshot_busy; восстановление cleanup после удаления failed job через 30 дней недостаточно описано. В исправлениях main timeout-отравленный regex не совпадает до рестарта; соседние auth-маршруты открытой disabled-сессии, Google callback и push DNS rebinding остаются за рамками этого набора.
