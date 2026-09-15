# Несколько Google OAuth-приложений и новая кнопка «Добавить аккаунт»

> Статус: дизайн одобрен 2026-09-15, реализация не начата.

## Зачем

Каждый проект Google Cloud без верификации принимает не больше 100 уникальных пользователей за всё время жизни проекта. Лимит не сбрасывается: удаление ящика или отзыв доступа место не возвращают. MailExpert должен подключать больше 100 личных Gmail-ящиков, поэтому ящики распределяются по нескольким проектам Google Cloud: каждый проект — отдельное OAuth-приложение со своим лимитом.

Одновременно появляется единая кнопка «Добавить аккаунт» с тремя вариантами: Gmail, доменный ящик и ручная настройка сервера.

## Принятые решения

- Аккаунты — личные `@gmail.com`. Режим Internal (Google Workspace) неприменим.
- Каждое приложение — отдельный проект Google Cloud с аудиторией External и статусом **In Production** без верификации. Режим Testing не используется: в нём доступ истекает через 7 дней, а тестовых пользователей нужно вносить в консоль вручную.
- Несколько OAuth-клиентов в одном проекте делят один лимит, поэтому MailExpert не принимает второе приложение из того же проекта.
- Callback-адрес общий для всех приложений.
- Для Gmail одна кнопка: пользователь вводит email, а приложение выбирает MailExpert. При вводе подсказка показывает уже известные адреса и их состояние.
- Email передаётся в Google через `login_hint`, на странице Google остаются пароль (если браузер ещё не вошёл), экран «Приложение не проверено» и согласие.
- Приложение ящика не принципиально: ящик Gmail один и тот же, через какое бы приложение ни выдан токен. MailExpert старается оставить email в том приложении, где у него уже есть доступ, и переходит в другое только если это невозможно.
- Уже подключённый Gmail повторно не добавляется. Разорванная авторизация чинится отдельным переподключением из списка ящиков слева.

## Не входит

- Верификация приложения Google и CASA.
- Несколько Microsoft-приложений.
- Автоматическое распознавание блокировки проекта или исчерпания лимита на стороне Google: Google возвращает такой отказ так же, как отказ пользователя (`access_denied`). Приложение отключает администратор.
- Сам почтовый сервер Postfix/Dovecot за Microsoft EOP. MailExpert получает только настройки подключения к нему.
- Метрики приложений в диагностическом отчёте.

## Модель данных

Миграция `backend/migrations/0053_google_oauth_apps.sql`.

```sql
CREATE TABLE IF NOT EXISTS google_oauth_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(100) NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT NOT NULL,               -- encrypted with services/encryption.js
  project_number TEXT NOT NULL UNIQUE,       -- numeric prefix of client_id
  user_limit INTEGER NOT NULL DEFAULT 100 CHECK (user_limit > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS google_oauth_grants (
  app_id UUID NOT NULL REFERENCES google_oauth_apps(id) ON DELETE CASCADE,
  email TEXT NOT NULL,                       -- lower-cased address
  google_sub TEXT,
  first_granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, email)
);

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS oauth_app_id UUID REFERENCES google_oauth_apps(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS oauth_subject TEXT;

CREATE INDEX IF NOT EXISTS idx_email_accounts_oauth_app
  ON email_accounts (oauth_app_id) WHERE oauth_app_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_accounts_lower_email
  ON email_accounts (lower(email_address));
```

**`google_oauth_apps`**
- `client_id` должен соответствовать `^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$`. Первая группа — номер проекта Google Cloud, она пишется в `project_number`. Второе приложение с тем же номером отклоняется.
- `client_id` после создания не меняется: другой client ID — это другое приложение.
- `user_limit` по умолчанию 100. Администратор уменьшает его, если проектом пользовались до MailExpert: Google считает и тех пользователей.
- Состояния:

| `status` | Новые ящики | Привязанные ящики |
|---|---|---|
| `active` | принимает, пока есть место | работают |
| `closed` | не принимает | работают и переподключаются через это приложение |
| `disabled` | не принимает | переводятся в «нужно переподключить», переподключение идёт через другое приложение |

  «Заполнено» — не отдельное состояние, а вычисляемый признак `active`-приложения, у которого занятые места ≥ `user_limit`.

**`google_oauth_grants`** — журнал «этот email хоть раз получил токен от этого приложения».
- Запись создаётся после проверки ID token, до любых отказов: Google уже засчитал пользователя.
- Записи не удаляются при удалении ящика. При удалении приложения удаляются вместе с ним.
- Ключ — email: адрес `@gmail.com` сменить нельзя, а для существующих ящиков `sub` не сохранён. `google_sub` заполняется, когда известен.

**`email_accounts`**
- `oauth_app_id` — приложение, чей токен хранится у ящика. Заполнено только для `oauth_provider = 'google'`. Удалить приложение с привязанными ящиками нельзя.
- `oauth_subject` — `sub` из ID token, сохраняется при подключении и переподключении.

## Занятые места и брони

Занято у приложения = записи журнала + действующие брони. Бронь снимается на callback до записи в журнал, поэтому один email не считается дважды.

Бронь ставится при старте подключения, когда выбрано приложение, где у email ещё нет записи:
- Redis sorted set `oauth:google:reservations:<appId>`, member — SHA-256 от email в нижнем регистре, score — время истечения (сейчас + `OAUTH_STATE_TTL_SECONDS`).
- Повторный старт для того же email обновляет ту же бронь и не занимает второе место.
- Истёкшие брони удаляются `ZREMRANGEBYSCORE` при каждом подсчёте.
- Бронь снимается на callback при любом исходе, в том числе при ошибке.

## Выбор приложения

`selectGoogleApp({ email, account })` выполняется в транзакции Postgres под `pg_advisory_xact_lock(hashtext('google-oauth-app-selection'))`. Блокировка сериализует подсчёт и бронирование между процессами backend.

1. Если это переподключение и приложение ящика в состоянии `active` или `closed` — оно.
2. Иначе, если в журнале есть запись для email в приложении `active` или `closed` — самое раннее такое приложение (место не тратится).
3. Иначе — первое по `created_at` приложение `active`, у которого занято < `user_limit`; для email ставится бронь.
4. Иначе ошибка: `no_app_capacity`, если приложения есть, и `not_configured`, если приложений нет или все отключены.

## Потоки подключения

### Добавление Gmail

1. Форма «Добавить аккаунт → Gmail» отправляет `POST /api/oauth/google/start` с `{ email }`. Маршрут находится под `/api`, а не рядом с `/oauth/google`, потому что меняет состояние (бронь): так на него действуют CSRF-проверка `X-Requested-With` и блокировка экрана из `backend/src/index.js`. `launch` и `callback` остаются под `/oauth/google`.
2. Сервер проверяет формат email и что ящика с `lower(email_address) = lower(email)` нет ни у одного пользователя MailExpert. Если есть — `409 { code: 'already_connected' }`, в Google не ходим.
3. `selectGoogleApp`. При ошибке — `409 { code: 'no_app_capacity' }` или `409 { code: 'not_configured' }`.
4. Сервер создаёт OAuth state: `{ userId, codeVerifier, mode: 'add', appId, email }`.
5. Сервер создаёт одноразовый ключ перехода (`oauth:google:launch:<hash>`, TTL 60 с) со ссылкой на state и отвечает `{ path: '/oauth/google/launch?flow=<key>' }`. Email не попадает в URL MailExpert и в журналы nginx.
6. Фронтенд открывает `path` через `openOAuthWindow`. Если браузер заблокировал вкладку, форма показывает ссылку «Открыть страницу Google» с тем же `path`; ключ действует до перехода, но не дольше TTL.
7. `GET /oauth/google/launch?flow=<key>` потребляет ключ и перенаправляет в Google: `client_id` выбранного приложения, `login_hint = email`, `prompt=consent`, `access_type=offline`, PKCE S256.

### Переподключение

1. Кнопка «Переподключить» у ящика в списке слева открывает `GET /oauth/google?account=<id>`. Email не передаётся в URL.
2. Сервер проверяет, что ящик принадлежит пользователю сессии и это Google-ящик. Иначе — redirect с `invalid_state`.
3. `selectGoogleApp({ email: account.email_address, account })`. При ошибке — redirect с `no_app_capacity` или `not_configured`.
4. State: `{ userId, codeVerifier, mode: 'reconnect', appId, email, accountId }`, redirect в Google как в шаге 7 выше.

### Callback `GET /oauth/google/callback`

1. Потребить state (как сейчас: одноразовый, та же сессия). Снять бронь `(appId, email)`.
2. Ошибка от Google — `access_denied` или `authentication_failed`, как сейчас.
3. Загрузить приложение `appId`. Если его нет — `authentication_failed`.
4. Обменять код через `client_id`/`client_secret` этого приложения. Проверить ID token с `audience = client_id`, `email_verified = true`.
5. Записать в журнал `(appId, lower(identity.email), identity.sub)`: `ON CONFLICT (app_id, email) DO UPDATE SET google_sub = COALESCE(google_oauth_grants.google_sub, EXCLUDED.google_sub)`.
6. Проверки, по первой неудачной — отказ:
   - `lower(identity.email) ≠ email` → `account_mismatch`;
   - нет scope `https://mail.google.com/` → `scope_missing`;
   - нет refresh token → `missing_refresh_token`;
   - `mode = 'add'` и ящик с этим email уже существует (гонка между стартом и callback) → `already_connected`;
   - `mode = 'reconnect'`: ящика нет или он не принадлежит пользователю → `invalid_state`; у ящика есть `oauth_subject` и он ≠ `identity.sub` → `account_mismatch`.
7. **Отказ после выдачи токена.** Токены не сохраняются. Новый токен отзывается, если в этом приложении нет ящика с `lower(email_address) = lower(identity.email)`. Если такой ящик есть, отзыв не выполняется: Google отзывает доступ человека ко всему проекту, и рабочий ящик тоже отключился бы.
8. **Успех `add`.** В транзакции под существующим advisory lock `oauth-account:<userId>:<email>` создаётся ящик: как сейчас, плюс `oauth_app_id`, `oauth_subject`. Результат `created`.
9. **Успех `reconnect`.** Обновить токены, `oauth_app_id`, `oauth_subject`, снять `oauth_reconnect_required` и `sync_error`. Результат `updated`. Если приложение сменилось, после коммита отозвать старый refresh token (best effort: ошибки только логируются кодом, без текста ответа).
10. Переподключить IMAP, как сейчас (`reconnectAccount`).

### Отзыв токена

`revokeGoogleToken(token)` — `POST https://oauth2.googleapis.com/revoke`, токен в теле формы, таймаут `PROVIDER_FETCH_TIMEOUT_MS`. Не бросает исключений, возвращает `true`/`false`. В лог пишется только HTTP-статус.

## Обновление токенов

- `refreshGoogleToken(account)` берёт `client_id`/`client_secret` из `google_oauth_apps` по `account.oauth_app_id`. Запрос в БД на каждое обновление; кэша нет (обновления раз в час на ящик).
- Если приложения нет (`oauth_app_id` пуст) или оно `disabled` — `GoogleOAuthError('authentication_failed', { oauthError: 'app_unavailable' })`. `app_unavailable` добавляется в `RECONNECT_OAUTH_ERRORS` token manager'а: ящик переходит в «нужно переподключить».
- Если secret не расшифровывается — `oauth_refresh_failed` (проблема ключа шифрования, а не пользователя).

## Администрирование приложений

Маршруты `/api/admin/google-apps`, только `requireAdmin`.

| Метод | Назначение |
|---|---|
| `GET /` | Список: `id`, `label`, `clientId`, `projectNumber`, `userLimit`, `status`, `grantsCount`, `reservedCount`, `accountsCount`, `full`, `createdAt`. Secret не возвращается. |
| `POST /` | `{ label, clientId, clientSecret, userLimit? }`. Ошибки: `client_id_invalid`, `app_same_project` (номер проекта занят), `app_exists` (client ID занят). |
| `PATCH /:id` | `{ label?, clientSecret?, userLimit?, status? }`. Пустой secret или плейсхолдер `REDACTED_SECRET` сохраняет прежний. |
| `DELETE /:id` | Только без привязанных ящиков, иначе `409 app_in_use`. |

При переходе в `disabled` в одной транзакции всем ящикам приложения ставится `oauth_reconnect_required = true`, `sync_error = 'oauth_reconnect_required'`; после коммита они отключаются в `imapManager`. Возврат в `active` или `closed` флаги не снимает: ящики переподключаются вручную.

`GET /api/oauth/google/known-emails?q=<text>` для любого вошедшего пользователя: адреса из `google_oauth_grants`, для которых нет ни одного ящика в `email_accounts`, содержащие `q` (без учёта регистра, `q` от 2 до 254 символов, спецсимволы `LIKE` экранируются), уникальные, по алфавиту, не больше 8. Ответ — `{ emails: string[] }`, без приложений и дат.

`GET /api/integrations/status` для любого пользователя:
- `google.configured` — есть хотя бы одно приложение не в `disabled`;
- `google.available` — у какого-то `active`-приложения есть место;
- `domainMail.configured` — задан доменный сервер.

Общий callback-адрес хранится в `integration_config` (`provider = 'google'`, `config = { redirectUri }`). После перехода на новый интерфейс `POST /api/integrations/google` принимает только `{ redirectUri }`, а `DELETE /api/integrations/google` удаляется; до этого они работают в режиме совместимости (см. «Разбиение на PR»).

## Доменный почтовый сервер

- `integration_config` с `provider = 'domain_mail'`: `{ imapHost, imapPort, smtpHost, smtpPort, smtpTls, skipTlsVerify }`.
- Сохранение — `POST /api/integrations/domain_mail`, только админ; хосты и порты проверяются `validateHost`/`validatePort` так же, как в `routes/accounts.js`. Удаление — `DELETE`.
- `POST /api/accounts` с `{ kind: 'domain', name, email_address, auth_pass }` создаёт ящик с хостами и портами из настроек, `auth_user = email_address`. Если сервер не задан — `400 { code: 'domain_mail_not_configured' }`.
- `POST /api/accounts` без `kind` (ручная настройка) — только для администратора, иначе `403`.

## Интерфейс

**Настройки → Интеграции → «Google-приложения»** (только админ; заменяет `GoogleIntegrationSection`):
- Общий callback-адрес с копированием и инструкция: отдельный проект Google Cloud на каждое приложение, External, In Production, scopes `openid email profile https://mail.google.com/`, этот callback.
- Таблица: название, сокращённый client ID, «занято / лимит», ящиков, состояние («активно», «заполнено», «закрыто», «отключено»).
- «Добавить приложение», редактирование, смена состояния с подтверждением для «Отключить» (текст: сколько ящиков потребуют переподключения), удаление.
- Кнопки «Подключить Gmail» здесь больше нет. Не-админ этот раздел не видит.

**Настройки → Интеграции → «Доменный почтовый сервер»** (только админ): поля IMAP/SMTP, сохранить, удалить.

**Кнопка «Добавить аккаунт»** (вкладка «Аккаунты» и пункт меню слева) открывает выбор:
- **Gmail** — поле email и «Продолжить через Google». Ответы `already_connected`, `no_app_capacity`, `not_configured` показываются в форме без открытия вкладки. Вариант неактивен, если `google.available = false`.
  - **Подсказка при вводе.** Под полем выпадающий список до 8 строк: совпадение по любой части адреса без учёта регистра, стрелки и Enter выбирают строку, Escape закрывает. Источники и пометки:

    | Источник | Условие | Пометка | Действие |
    |---|---|---|---|
    | ящики текущего пользователя (store, запрос не нужен) | `health` не `oauth_reconnect_required` и не `disabled` | «Уже подключено» | выбрать нельзя, «Продолжить» неактивна |
    | то же | `health = 'oauth_reconnect_required'` | «Нужно переподключить» | кнопка «Переподключить» в строке открывает `/oauth/google?account=<id>` |
    | то же | `health = 'disabled'` | «Отключён в настройках» | выбрать нельзя |
    | журнал без ящика: `GET /api/oauth/google/known-emails?q=` | запрос от 2 символов, debounce 200 мс | «Подключался раньше» | подставляет адрес; приложение выберется по журналу, место не тратится |

  - Если введённый адрес целиком совпадает с ящиком из первых трёх строк таблицы, пометка показывается под полем и без открытого списка.
- **Доменный ящик** — имя, email, пароль. Неактивен с подсказкой, если `domainMail.configured = false`.
- **Другой сервер вручную** — нынешняя `AccountForm` без пресета Gmail; виден только администратору.

**Список ящиков слева:** «Переподключить» у Google-ящика открывает `/oauth/google?account=<id>` (`reconnectUrlFor`).

**Результаты callback** — существующий механизм `parseOAuthResult`; новые коды с ключами во всех локалях: `already_connected`, `account_mismatch`, `no_app_capacity`. Ошибки админского API: `client_id_invalid`, `app_same_project`, `app_exists`, `app_in_use`, `domain_mail_not_configured`.

## Миграция существующей установки

В `0053`, в той же транзакции:
1. Если в `integration_config` есть `provider = 'google'` с `clientId`, соответствующим шаблону, и `clientSecret` — создать приложение «Google 1» (secret копируется как есть, он уже зашифрован).
2. Привязать к нему все ящики `oauth_provider = 'google'`.
3. Заполнить журнал: `(app_id, lower(email_address), NULL)` для этих ящиков.
4. Оставить в записи `integration_config` только `redirectUri`.

При старте (`loadIntegrationConfigs`): если приложений нет, а заданы `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET` — выполнить шаги 1–3 из переменных окружения (secret шифруется). После этого `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` не читаются; `GOOGLE_REDIRECT_URI` остаётся значением callback по умолчанию. `.env.example` и README описывают это.

Google-ящики без приложения (Google не был настроен) при обновлении токена получают «нужно переподключить».

## Безопасность и логи

- Client secret шифруется при записи и никогда не возвращается API.
- Email не пишется в логи открытым текстом (`redactEmail`), в Redis хранится только его хэш.
- Токены, коды авторизации и тексты ответов Google не попадают в логи, URL, ответы API и ошибки — как в текущей реализации.
- Ключ перехода `flow` одноразовый, 32 случайных байта, в Redis хранится хэш.
- `openOAuthWindow` по-прежнему принимает только пути `/oauth/`.
- Ответ `already_connected` от `start` позволяет любому вошедшему пользователю узнать, подключён ли конкретный Gmail у другого пользователя MailExpert, а `known-emails` — увидеть адреса удалённых Google-ящиков. Для схемы «администратор и один общий пользователь» это приемлемо; при появлении отдельных менеджеров проверку нужно пересмотреть.

## Тесты

**Backend (vitest):**
- выбор приложения: своё приложение ящика → запись журнала → первое свободное; `closed` и `disabled`; брони учитываются, истекают, повторный старт того же email не занимает второе место; два параллельных старта у последнего места получают разные приложения или `no_app_capacity`;
- `POST /api/oauth/google/start`: `already_connected` и `no_app_capacity` без обращения к Google; ответ не содержит email;
- `known-emails`: только адреса без ящика, поиск по подстроке, экранирование `%`/`_`, лимит 8, минимум 2 символа, требуется сессия;
- launch: одноразовость ключа, истечение, `login_hint`, `client_id` выбранного приложения;
- callback: успех `add` с привязкой; `account_mismatch` (с отзывом и без него); `already_connected` при гонке; `scope_missing`; переподключение со сменой приложения и отзывом старого токена; несовпадение `oauth_subject`; журнал пишется при всех отказах после ID token;
- обновление токена через приложение ящика; `app_unavailable` → «нужно переподключить»;
- админский API: шаблон client ID, `app_same_project`, `app_exists`, `app_in_use`, секрет не возвращается, `disabled` помечает ящики;
- миграция из `integration_config` и импорт из переменных окружения;
- доменный сервер: сохранение с проверкой хостов, `kind: 'domain'`, `domain_mail_not_configured`, `403` для ручного добавления не-админом.

**Frontend (`node --test`):** утилиты формы Gmail и выбора варианта, построение строк подсказки (совпадение по подстроке, пометки по `health`, объединение с журналом без дублей, лимит 8, клавиатурная навигация), `reconnectUrlFor`, `parseOAuthResult` для новых кодов, отображение состояний приложений, покрытие ключей i18n во всех локалях.

**Вживую** (часть Task 9.1): два проекта Google Cloud и один-два тестовых Gmail — добавление, повторное добавление, вход в другой аккаунт, отключение первого приложения и переподключение через второе, обновление токена после перезапуска.

## Разбиение на PR

1. **Backend: данные.** Миграция, импорт из env, `refreshGoogleToken` по приложению ящика, `app_unavailable`. Поведение для пользователя не меняется: единственное приложение работает как раньше. Для этого в PR 1 `getGoogleConfig()`/`isGoogleConfigured()` берут `client_id`/`client_secret` из самого раннего приложения не в `disabled` (`redirectUri` — из `integration_config`, затем `GOOGLE_REDIRECT_URI`), `applyGoogleEnv` больше не пишет и не удаляет `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, а старый callback привязывает созданный ящик к этому приложению и пишет журнал. Миграции уже выполняются до `loadIntegrationConfigs()` (`backend/src/index.js`), поэтому импорт из env видит новые таблицы.
2. **Backend: потоки и API.** `start`/`launch`/переподключение/callback, `known-emails`, выбор и брони, отзыв, новые коды; `/api/admin/google-apps`; статус; доменный сервер и `kind: 'domain'`; ограничение ручного добавления.
3. **Frontend: админка.** «Google-приложения» и «Доменный почтовый сервер».
4. **Frontend: пользователь.** «Добавить аккаунт» с тремя вариантами и подсказкой при вводе email, переподключение слева, новые ключи локалей.
5. **Документация.** Инструкция по проектам Google Cloud для этой схемы (часть Task 6), ROADMAP и статусы плана.

**Совместимость между PR** — `main` рабочий после каждого слияния:
- с PR 1 до PR 3 старая карточка Google продолжает работать: `GET /api/integrations` отдаёт `clientId` самого раннего приложения (secret — плейсхолдером), `POST /api/integrations/google` с `clientId`/`clientSecret` создаёт или обновляет это приложение, `DELETE` переводит его в `disabled`;
- с PR 2 до PR 4 старые `GET /oauth/google` и `GET /oauth/google?login_hint=<email>` работают как прежде: если ящик с таким email есть у пользователя — это переподключение, иначе добавление; приложение выбирается по `selectGoogleApp`, бронь ставится по `login_hint`, без него — без брони; совпадение email на callback проверяется, только если `login_hint` был передан;
- PR 3 убирает совместимость настроек, PR 4 — совместимость `GET /oauth/google` без `account`.

## Риски

- **Правила Google.** Google может ограничить или заблокировать проекты, распределяющие пользователей сверх лимита неверифицированного приложения (условия Google APIs запрещают обходить документированные ограничения). При блокировке все ящики проекта теряют доступ; переподключение через другое приложение сохраняет данные в MailExpert, но требует входа каждого затронутого сотрудника.
- **Расхождение счёта с Google.** Google может засчитать пользователей, которых MailExpert не видел (использование проекта до MailExpert, прерванные попытки). Смягчение — `user_limit` меньше 100 и состояние `closed`.
- **Отзыв не возвращает место** и может не пройти для заблокированного проекта; это не ошибка.
- **Экран «Приложение не проверено»** остаётся при каждом первом подключении к приложению.
