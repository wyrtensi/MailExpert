# Развёртывание, PR 7c: бэкап, восстановление, обновление и откат — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** зашифрованный бэкап панели в любое S3-совместимое хранилище через restic с проверкой восстановлением (`backup.sh`, `--verify`), проверка здоровья с пингами во внешний сервис (`healthcheck.sh`), восстановление на чистом сервере, включая переезд с заменой сгенерированных ключей (`restore.sh`), обновление с бэкапом и автоматическим откатом без миграций (`update.sh`), откат с восстановлением дампа (`rollback.sh`), инициализация репозитория и однократный показ ключа восстановления в `install.sh`, включённые таймеры; bats для чистых функций и e2e в Docker-in-Docker: установка → данные с зашифрованным паролем ящика → бэкап и проверка → уничтожение → восстановление на «втором сервере» → обновление на другой тег → откат.

**Architecture:** новые скрипты — тонкие оркестраторы над библиотеками `scripts/deploy/lib/*.sh`, как `install.sh` в 7b. Новые библиотеки: `app.sh` (установленная панель: `install.conf`, пути, compose, образы, база, маркер standby; вынесено из `install.sh`), `backup.sh` (restic в закреплённом контейнере, пинги, `backup-last.json`), `health.sh` (проверки здоровья), `ops.sh` (решения обновления, слияние ключей при восстановлении, состояние обновления). Внутриконтейнерные части — отдельные файлы, которые монтируются в контейнер: `lib/pg-dump.sh` (дамп и подсчёт строк в одном экспортированном снимке PostgreSQL), `lib/counts.sql`, `lib/verify-restore.mjs` (миграции и расшифровка в образе backend). restic работает в контейнере `restic/restic` с `--network host`; секреты попадают в контейнеры только как имена унаследованных переменных окружения. `update.sh`, `restore.sh` и `rollback.sh` делегируют переключение версии и запуск `install.sh` (checkout, образы, `up`, готовность, `exec` установщика нужного коммита). e2e — второй сценарий `e2e-backup.sh` в том же одноразовом dind-контейнере, что и 7b; S3 изображает MinIO внутри dind, «второй сервер» — другой compose-проект и префикс после полного удаления первого.

**Tech Stack:** bash 5, Docker Engine + Compose ≥ 2.24.4, restic 0.18.0 (`restic/restic:0.18.0`, репозиторий v2), PostgreSQL 16 (`pg_dump --snapshot`, `pg_restore`), Node 22 (образ backend, `services/encryption.js`, `services/migrations.js`), MinIO (`minio/minio:RELEASE.2025-04-22T22-12-26Z`, только e2e), bats 1.14, shellcheck, actionlint, `docker:29.8.1-dind`, systemd timers.

**Spec:** `docs/superpowers/specs/2026-09-21-deployment-design.md` — «3. Обновление», «4. Бэкап и восстановление», «5. Переезд панели» (шаги 1-5 и 8 в части скриптов), «7. Мониторинг», «8. Проверка скриптов», «Принятые решения» (restic, откат без миграций, проверка восстановлением, dead man's switch), «Уточнения, принятые при реализации 7a» и «… 7b» (ключи restic в `configure.sh` — 7c; печать ключа восстановления — 7c; таймер включается, только если скрипт есть в коммите; `HEALTHCHECK_PING_URL` → внешний сервис → Telegram, токена бота на сервере нет), «Открытые вопросы» (провайдер S3). Runbook — 7d.

## Global Constraints

- Проза плана и спецификаций — по-русски; код, комментарии в коде, коммиты, тексты PR — по-английски. Без эмодзи.
- Коммиты от имени настроенного пользователя git (`wyrtensi`), без строк атрибуции. Не пушить без команды контроллера. Все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- В документах и тестах только заглушки: `<APP_HOST>`, `<CF_HOST>`, `<DIRECT_HOST>`, `<MAIL_HOST>`, `<TEAM>`, `<AUD>`, `<OWNER>`; в коде тестов — зарезервированные домены `example.com`, `example.test`, `.invalid`. Никаких реальных хостов, IP, секретов и названий S3-провайдеров. Имя репозитория `wyrtensi/MailExpert` и префикс `ghcr.io/wyrtensi` публичны и допустимы.
- **Безопасность хоста (жёстко).** На хосте работают рабочие контейнеры `mailexpert-frontend`, `mailexpert-backend`, `mailexpert-postgres`, `mailexpert-redis` и контейнеры других проектов на хосте. Их не останавливать, не пересоздавать, не выполнять в них команды, не удалять; чужие контейнеры не перечислять и не называть. В 7c на демоне хоста **не выполняется ни одна** команда `docker compose up/down/restart/rm/run/exec` и ни один из скриптов `install.sh`, `backup.sh`, `restore.sh`, `update.sh`, `rollback.sh`, `healthcheck.sh` — они запускаются только внутри одноразового dind-контейнера e2e. Разрешено на хосте: `docker build` с тегами только под `local.invalid/`; `docker pull` публичных образов инструментов (`restic/restic:0.18.0`, `minio/minio:RELEASE.2025-04-22T22-12-26Z`, `bats/bats:1.14.0`, `koalaman/shellcheck:stable`, `rhysd/actionlint:latest`, `docker:29.8.1-dind`, `postgres:16-alpine`, `redis:7-alpine`); одноразовые `docker run --rm` инструментов (bats, shellcheck, actionlint); `docker compose ... config` (только чтение); один контейнер e2e `me-e2e-<id>`, который удаляется в конце. До и после каждого прогона e2e сравнить время старта запущенных контейнеров (`docker inspect -f '{{.Name}} {{.State.StartedAt}}'`, снимок только в `$SCRATCH`, не в отчёт) — ни одно не изменилось, ни один контейнер не пропал.
- **`restore.sh` работает только на сервере без базы:** если существует том `<проект>_postgres_data` или у compose-проекта есть контейнеры, он завершается с кодом 2, ничего не меняя. Это и защита от запуска на живом сервере, и условие, при котором замена сгенерированных ключей безопасна (ими ещё ничего не зашифровано).
- Секреты никогда не передаются флагами и аргументами — ни скриптам, ни `docker run` (`-e KEY=value` запрещено, только `-e KEY` с унаследованной переменной или префикс `KEY=value docker ...`, который попадает в окружение, а не в argv), ни `curl` (URL пинга содержит ключ проверки и передаётся через `-K <(...)`). Сообщения об ошибках называют ключ, но не значение. Единственный санкционированный вывод секрета — ключ восстановления (`RESTIC_REPOSITORY`, `RESTIC_PASSWORD`): `install.sh` печатает его в stderr один раз и только в терминал (`[ -t 2 ]`), `backup.sh --show-recovery-key` — по явной команде владельца.
- Сгенерированные ключи (`SESSION_SECRET`, `ENCRYPTION_KEY`, `DB_PASSWORD`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) и `RESTIC_PASSWORD` `configure.sh` пишет только в отсутствующие или пустые ключи и никогда не перезаписывает. Сгенерированные ключи заменяет только `restore.sh` — значениями из снимка и только при условии из пункта выше.
- **Хранилище бэкапов не выбрано владельцем:** всё работает с любым S3-совместимым хранилищем. `RESTIC_REPOSITORY` — `s3:https://<endpoint>/<bucket>[/<path>]`; `s3:http://` допускается только для `127.0.0.1`/`localhost` (MinIO в e2e). Ни в коде, ни в документах нет названия конкретного провайдера.
- Пакеты GHCR публичные: ни `GHCR_TOKEN`, ни `docker login`. Compose ≥ 2.24.4. Образ, который уже есть локально, не скачивается.
- Исполняемые скрипты начинаются с `#!/usr/bin/env bash` и `set -euo pipefail`, вызывают `exit_on_unexpected_failure` и заканчиваются строкой `main "$@"; exit $?` (bash прочёл файл целиком до `main`, поэтому checkout, который переписывает скрипт во время работы, не меняет исполняемое). Библиотеки — `# shellcheck shell=bash`, без `set`. Скрипт внутри контейнера postgres — `# shellcheck shell=sh`, POSIX sh (busybox). Концы строк LF. Результат `$(...)` с возможной ошибкой присваивается отдельной командой (`x=$(f)`), не подставляется в аргументы. Новые скрипты в git с режимом `100755` (`git add --chmod=+x`): таймеры включаются по `[ -x ]`.
- Коды выхода: 0 — готово, 1 — сбой, 2 — неверный ввод или неподходящее состояние (до изменений), 3 — только `install.sh` (ждёт секретов); `update.sh` дополнительно: 4 — новая версия не поднялась, прежняя работает снова (автоматический откат), 5 — новая версия применила миграции и не поднялась, backend и frontend остановлены, нужен `rollback.sh`.
- `backend/`, `frontend/`, `docker-compose.yml` и `deploy/compose.prod.yml` в 7c не меняются.
- Если чистое решение упирается в препятствие (падающий чужой тест, недоступный образ, неожиданное поведение restic, MinIO, Compose, PostgreSQL или busybox, код выхода restic не тот, что описан ниже) — остановиться и доложить, не обходить (не отключать проверки, не ослаблять условия, не расширять `case` под фактический код, не подставлять ожидаемые значения).

## Как запускать проверки

Все команды — в Git Bash из корня рабочего дерева `D:/hub/workspace/Projects/MailExpert/.claude/worktrees/agent-a3dfcd525c53fc409`. Локально ничего не ставится: инструменты работают в контейнерах.

```bash
# shellcheck: the same file set as CI (new files must be `git add`-ed to be listed)
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/mnt:ro" -w /mnt koalaman/shellcheck:stable $(git ls-files 'scripts/*.sh' 'deploy/*.sh' 'frontend/*.sh')
# bats: every scripts/deploy/test/*.bats
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/code:ro" -w /code bats/bats:1.14.0 scripts/deploy/test
# actionlint (ci.yml only; publish-apps.yml has pre-existing findings, out of scope)
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo rhysd/actionlint:latest -no-color .github/workflows/ci.yml
```

Ниже они записаны как `SC`, `BATS` и `AL`. Для временных файлов: `SCRATCH=$(mktemp -d)`.

e2e (`E2E`) ставит HEAD из git bundle, поэтому запускается только на закоммиченном дереве. Образы собираются из HEAD под `local.invalid/`:

```bash
SHA=$(git rev-parse HEAD); TAG=sha-${SHA:0:12}
docker build -f backend/Dockerfile --build-arg BUILD_SHA="$SHA" -t "local.invalid/mailexpert-backend:$TAG" .
docker build -f frontend/Dockerfile --build-arg VITE_BUILD_SHA="$SHA" -t "local.invalid/mailexpert-frontend:$TAG" .
docker build -t "local.invalid/mailexpert-edge:$TAG" deploy/edge
docker ps -q | xargs docker inspect -f '{{.Name}} {{.State.StartedAt}}' | sort >"$SCRATCH/ps-before.txt"
scripts/deploy/test/e2e.sh --version "$TAG" --image-prefix local.invalid; echo "exit $?"
docker ps -a --filter name=me-e2e- --format '{{.Names}}'
docker ps -q | xargs docker inspect -f '{{.Name}} {{.State.StartedAt}}' | sort | diff "$SCRATCH/ps-before.txt" - && echo host-unchanged
```

`backend/` и `frontend/` в 7c не меняются, поэтому после первой сборки образы можно не пересобирать, а перетегировать на новый HEAD: `docker tag local.invalid/mailexpert-backend:$OLD local.invalid/mailexpert-backend:$TAG` (то же для frontend и edge) — **кроме backend**: в нём `BUILD_SHA` зашит при сборке, а `install.sh` сверяет `/api/version` с тегом. Backend пересобирать на каждый новый HEAD (слой `npm ci` берётся из кэша, сборка — секунды). После Task 3 `e2e.sh --only backup` запускает только новый сценарий (быстрее при отладке); финальный прогон каждой задачи — без `--only`.

Вывод `diff` при расхождении не копировать в отчёт дословно: в нём имена чужих контейнеров; написать, что изменилось, без имён других проектов. Если e2e падает: исправить код (новый коммит, не amend), пересобрать backend с новым `TAG` и повторить. Для разбора — `E2E_KEEP=1`, затем `docker rm -fv me-e2e-<id>` вручную. Три неудачных попытки подряд по одной причине — остановиться и доложить.

## Файлы

| Файл | Что это |
|---|---|
| `scripts/deploy/lib/common.sh` | + `take_lock` |
| `scripts/deploy/lib/env.sh` | + списки ключей владельца (`APP_OWNER_KEYS`, `EDGE_OWNER_KEYS`, `WRITE_ONCE_KEYS`), перенесены из `configure.sh` и дополнены ключами restic |
| `scripts/deploy/lib/app.sh` (новый) | `set_install_paths`, `load_install`, `app_compose`, `edge_compose`, `ensure_image`, `panel_ready`, `app_psql`, `migration_count`, `db_volume_exists`, `project_containers`, `is_standby`/`set_standby`/`clear_standby`, `lock_held` |
| `scripts/deploy/lib/backup.sh` (новый) | чистые: `restic_repository_ok`, `backup_configured`, `ping_target`, `backup_checks`, `prune_today`, `json_number`, `backup_age_problem`, `backup_tag_ok`; с Docker: `load_restic_env`, `restic_run`, `ensure_backup_repo`, `print_recovery_key`, `show_recovery_key_once`, `send_ping`, `backup_ping_url`, `dump_database`, `write_backup_last` |
| `scripts/deploy/lib/pg-dump.sh` (новый) | POSIX sh внутри одноразового контейнера сервиса postgres: `pg_dump --snapshot` и подсчёт строк в одном снимке |
| `scripts/deploy/lib/counts.sql` (новый) | запрос подсчёта строк, один для дампа, проверки и восстановления |
| `scripts/deploy/lib/verify-restore.mjs` (новый) | в образе backend: `runMigrations()` без новых миграций, расшифровка всех `enc:v1:` значений; печатает только числа |
| `scripts/deploy/lib/health.sh` (новый) | `service_problems`, `disk_problem`, `cert_problem` |
| `scripts/deploy/lib/ops.sh` (новый) | `merge_restored_keys`, `update_outcome`, `space_problem`, `stale_local_dumps`, `write_update_state`, `set_update_status` |
| `scripts/deploy/install.sh` | `lib/app.sh` вместо своих `app_compose`/`edge_compose`/`ensure_image`; `MAILEXPERT_READY_TIMEOUT`; `up` ограничен по времени; маркер standby; `setup_backups` (репозиторий, ключ восстановления, `state/backup-since`) |
| `scripts/deploy/configure.sh` | ключи restic и `BACKUP_PING_URL`; `RESTIC_PASSWORD` пишется один раз; подсказка про `restore.sh` |
| `scripts/deploy/backup.sh` (новый) | бэкап, хранение, `check`, `--verify`, пинги, `--tag`, `--with-redis`, `--keep-dump`, `--show-recovery-key` |
| `scripts/deploy/healthcheck.sh` (новый) | проверка здоровья и пинг |
| `scripts/deploy/restore.sh` (новый) | восстановление на чистом сервере, `--no-start` |
| `scripts/deploy/update.sh`, `scripts/deploy/rollback.sh` (новые) | обновление и откат |
| `scripts/deploy/test/helper.bash` | подключает и новые библиотеки |
| `scripts/deploy/test/{lock,app,backup,health,ops}.bats` (новые), `configure.bats` | модульные тесты |
| `scripts/deploy/test/e2e-lib.sh` (новый) | `fail`, `pass`, `labelled` для обоих сценариев e2e |
| `scripts/deploy/test/e2e-install.sh` | берёт `fail`/`pass`/`labelled` из `e2e-lib.sh` |
| `scripts/deploy/test/e2e-backup.sh` (новый), `e2e-credential.mjs` (новый) | сценарий 7c внутри dind и помощник шифрования для него |
| `scripts/deploy/test/e2e.sh` | образы restic и MinIO, второй сценарий, `--only` |
| `.github/workflows/ci.yml` | `timeout-minutes` и имя шага e2e |
| `docs/superpowers/specs/2026-09-21-deployment-design.md` | решения 7c, уточнения, статус, открытый вопрос о провайдере — неблокирующий |

Раскладка на сервере, добавленная 7c: `<prefix>/backups/staging/` (временный, на время бэкапа), `<prefix>/backups/pre-update-<sha>.dump` (последние 3), `<prefix>/backups/verify-<hex>/` (временный), `<prefix>/state/{backup.lock,update.lock,backup-last.json,backup-since,recovery-key.shown,standby,update.json,restic-cache/,restore/}`.

Содержимое снимка restic (пути внутри снимка): `/backup/db.dump` (`pg_dump -Fc -Z0`), `/backup/counts.json`, `/backup/env` (`.env`), `/backup/edge.env` (если есть), `/backup/install.conf`, `/backup/redis.rdb` (только `--with-redis`). Хост restic всегда `mailexpert-panel`, теги: `nightly`, `manual`, `pre-update`, `move` (любой `^[a-z0-9][a-z0-9-]{0,31}$`).

---
### Task 1: Общая основа — `lib/app.sh`, блокировки, standby, ограниченный `up`

**Files:**
- Modify: `.gitattributes`
- Modify: `scripts/deploy/lib/common.sh` (+ `take_lock`)
- Create: `scripts/deploy/lib/app.sh`
- Modify: `scripts/deploy/install.sh`
- Modify: `scripts/deploy/test/helper.bash`
- Create: `scripts/deploy/test/lock.bats`, `scripts/deploy/test/app.bats`

**Interfaces:**
- Consumes: из 7b — `resolve_install_config`, `validate_install_config`, `INSTALL_ARGS` (`config.sh`), `die`/`log` (`common.sh`), `env_get` (`env.sh`).
- Produces (все следующие задачи):
  - `take_lock <file> <seconds> <what>` — исключительный `flock` на `<file>` до конца процесса, ждёт до `<seconds>`, иначе `die "<what> has held <file> for <seconds>s; …"` (код 1). Дескриптор выбирает bash (`exec {fd}>`), дети его наследуют: скрипт не запускает ребёнка, который берёт ту же блокировку. Блокировки: `state/install.lock` (как в 7b, `take_install_lock`, fd 9: `install.sh`, `configure.sh`, фаза записи ключей в `restore.sh`), `state/backup.lock` (`backup.sh`), `state/update.lock` (`update.sh`, `rollback.sh`, `restore.sh`).
  - `set_install_paths` — `APP_DIR`, `EDGE_DIR`, `STATE_DIR`, `BACKUP_DIR`, `ENV_FILE`, `EDGE_ENV`, `BACKEND_IMAGE`, массивы `APP_COMPOSE`, `EDGE_COMPOSE` из `OPT_PREFIX` и `CFG_*`.
  - `load_install <prefix>` — `CFG_*` из `<prefix>/install.conf` (с валидацией) и пути; нет файла или он неверен — `exit 2`.
  - `app_compose <args>`, `edge_compose <args>`, `ensure_image <image>`, `panel_ready` (0 — `/api/health/ready` отвечает 200), `app_psql [db]` (SQL из stdin, вывод `-A -t`), `migration_count`, `db_volume_exists`, `project_containers`, `is_standby`/`set_standby`/`clear_standby` (`state/standby`), `lock_held <file>` (0 — блокировку держит другой процесс).
  - `install.sh`: `READY_TIMEOUT=${MAILEXPERT_READY_TIMEOUT:-180}`; `up` панели ограничен `timeout "$READY_TIMEOUT"`; `--no-start` ставит standby, запуск панели снимает.

Почему `up` ограничен по времени: `frontend` зависит от `backend` с `condition: service_healthy`, и `docker compose up` ждёт здоровья backend без срока. Backend, который падает при старте (провалившаяся миграция), с `restart: unless-stopped` перезапускается бесконечно и ни разу не становится `unhealthy` (падает раньше первой проверки), поэтому `up` висел бы вечно, а `update.sh` не дошёл бы до отката. `timeout` работает только с исполняемым файлом, не с функцией, отсюда массив `APP_COMPOSE`.

- [ ] **Step 1: Концы строк**

В `.gitattributes` после строки `deploy/** text eol=lf` добавить:

```gitattributes
scripts/deploy/** text eol=lf
```

(покрывает `*.mjs` и `*.sql` из следующих задач).

- [ ] **Step 2: Написать падающие тесты**

В `scripts/deploy/test/helper.bash` заменить строку `for lib in common env config edge; do` на:

```bash
for lib in common env config edge app backup health ops; do
```

Создать `scripts/deploy/test/lock.bats`:

```bash
#!/usr/bin/env bats
# take_lock: one holder at a time, a bounded wait, the lock released when its holder exits.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  L=$BATS_TEST_TMPDIR/test.lock
}

@test "take_lock takes a free lock at once" {
  run take_lock "$L" 0 "a test holder"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "take_lock gives up with exit 1 when the lock is held longer than the timeout" {
  flock "$L" sleep 4 &
  sleep 0.5
  run take_lock "$L" 1 "a test holder"
  [ "$status" -eq 1 ]
  [[ $output == *"a test holder has held $L for 1s"* ]]
  wait
}

@test "take_lock waits for a holder that finishes in time" {
  flock "$L" sleep 2 &
  sleep 0.5
  run take_lock "$L" 10 "a test holder"
  [ "$status" -eq 0 ]
  [[ $output == *"waiting for a test holder"* ]]
  wait
}

@test "lock_held tells a held lock from a free one" {
  run lock_held "$BATS_TEST_TMPDIR/missing.lock"
  [ "$status" -eq 1 ]
  : >"$L"
  run lock_held "$L"
  [ "$status" -eq 1 ]
  flock "$L" sleep 3 &
  sleep 0.5
  run lock_held "$L"
  [ "$status" -eq 0 ]
  wait
}
```

Создать `scripts/deploy/test/app.bats`:

```bash
#!/usr/bin/env bats
# The installed panel as the deploy scripts load it: install.conf, paths, compose commands.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P"
}

write_conf() {
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 \
    PROJECT=me-test HTTP_PORT=18090 "$@" >"$P/install.conf"
}

@test "load_install reads install.conf and derives the paths and commands" {
  write_conf
  load_install "$P"
  [ "$CFG_PROJECT" = me-test ] && [ "$CFG_HTTP_PORT" = 18090 ] && [ "$OPT_PREFIX" = "$P" ]
  [ "$APP_DIR" = "$P/app" ] && [ "$STATE_DIR" = "$P/state" ] && [ "$BACKUP_DIR" = "$P/backups" ]
  [ "$ENV_FILE" = "$P/.env" ] && [ "$EDGE_ENV" = "$P/edge/.env" ]
  [ "$BACKEND_IMAGE" = ghcr.io/wyrtensi/mailexpert-backend:sha-0123456789ab ]
  [ "${APP_COMPOSE[*]}" = "docker compose -p me-test --project-directory $P/app --env-file $P/.env -f $P/app/docker-compose.yml -f $P/app/deploy/compose.prod.yml" ]
  [ "${EDGE_COMPOSE[*]}" = "docker compose -p edge --project-directory $P/edge --env-file $P/edge/.env -f $P/edge/compose.yml" ]
}

@test "load_install without install.conf exits 2" {
  run load_install "$P"
  [ "$status" -eq 2 ]
  [[ $output == *"install.conf is missing: run install.sh first"* ]]
}

@test "load_install rejects an invalid install.conf and a relative prefix" {
  write_conf VERSION=latest
  run load_install "$P"
  [ "$status" -eq 2 ]
  [[ $output == *"--version must be"* ]]
  run load_install relative/path
  [ "$status" -eq 2 ]
}

@test "the standby marker" {
  write_conf
  load_install "$P"
  mkdir -p "$STATE_DIR"
  run is_standby
  [ "$status" -eq 1 ]
  set_standby
  is_standby
  clear_standby
  run is_standby
  [ "$status" -eq 1 ]
}
```

Run: `BATS`
Expected: FAIL — `take_lock: command not found`, `load_install: command not found`, `lock_held: command not found`.

- [ ] **Step 3: `take_lock` в `common.sh`**

В `scripts/deploy/lib/common.sh` после функции `take_install_lock` добавить:

```bash
# take_lock <file> <seconds> <what>: an exclusive flock on <file>, held until the process exits,
# waiting up to <seconds> for <what> to let go. Children inherit the descriptor, so a script must
# not run a child that takes the same lock (it would wait for its own parent).
take_lock() {
  local file=$1 timeout=$2 what=$3 fd waited=0
  command -v flock >/dev/null || die "flock is required"
  exec {fd}>"$file"
  until flock -n "$fd"; do
    if [ "$waited" -eq 0 ]; then log "waiting for $what to finish"; fi
    [ "$waited" -lt "$timeout" ] || die "$what has held $file for ${timeout}s; try again when it finishes"
    sleep 1
    waited=$((waited + 1))
  done
}
```

`take_install_lock` не меняется: `install.sh` закрывает его fd 9 перед `exec` установщика другого коммита.

- [ ] **Step 4: `scripts/deploy/lib/app.sh`**

```bash
# shellcheck shell=bash
# The installed panel as every deploy script sees it: install.conf, the paths under the prefix,
# compose, images, the database and the standby marker. Needs common.sh, env.sh and config.sh.

# set_install_paths: the paths and commands derived from OPT_PREFIX and the CFG_* values. The
# compose commands are arrays as well as functions: `timeout` runs a program, not a function.
# shellcheck disable=SC2034 # read by the scripts that source this file
set_install_paths() {
  APP_DIR=$OPT_PREFIX/app EDGE_DIR=$OPT_PREFIX/edge STATE_DIR=$OPT_PREFIX/state
  BACKUP_DIR=$OPT_PREFIX/backups ENV_FILE=$OPT_PREFIX/.env EDGE_ENV=$OPT_PREFIX/edge/.env
  BACKEND_IMAGE=$CFG_IMAGE_PREFIX/mailexpert-backend:$CFG_VERSION
  APP_COMPOSE=(docker compose -p "$CFG_PROJECT" --project-directory "$APP_DIR" --env-file "$ENV_FILE"
    -f "$APP_DIR/docker-compose.yml" -f "$APP_DIR/deploy/compose.prod.yml")
  EDGE_COMPOSE=(docker compose -p "$CFG_EDGE_PROJECT" --project-directory "$EDGE_DIR" --env-file "$EDGE_ENV"
    -f "$EDGE_DIR/compose.yml")
}

# load_install <prefix>: the configuration install.sh stored in <prefix>/install.conf, validated,
# and the paths. Exits 2 when there is no install there or its configuration is invalid.
load_install() {
  local prefix=$1
  [[ $prefix =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix must be an absolute path without spaces" 2
  [ -f "$prefix/install.conf" ] || die "$prefix/install.conf is missing: run install.sh first" 2
  INSTALL_ARGS=([PREFIX]=$prefix)
  resolve_install_config "$prefix/install.conf"
  validate_install_config || exit 2
  set_install_paths
}

app_compose() { "${APP_COMPOSE[@]}" "$@"; }
edge_compose() { "${EDGE_COMPOSE[@]}" "$@"; }

# ensure_image <image>: pulls the image unless it is present locally (an emergency build from
# source tags a local image that a pull must not replace).
ensure_image() {
  if docker image inspect "$1" >/dev/null 2>&1; then return 0; fi
  log "pulling $1"
  docker pull --quiet "$1" >/dev/null || die "cannot pull $1 (emergency build from source: see deploy/compose.prod.yml)"
}

# panel_ready: status 0 when /api/health/ready answers 200 on the loopback port.
panel_ready() {
  curl -fs -m 5 -o /dev/null "http://127.0.0.1:$CFG_HTTP_PORT/api/health/ready"
}

# app_psql [database]: psql in the postgres container as the panel's database user, SQL on
# stdin, tuples only and unaligned. Without a name: the panel's own database.
app_psql() {
  # shellcheck disable=SC2016 # expanded by the shell inside the container
  app_compose exec -T postgres sh -c \
    'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${1:-$POSTGRES_DB}"' sh "${1:-}"
}

# migration_count: rows in schema_migrations of the panel's database.
migration_count() {
  printf 'SELECT count(*) FROM schema_migrations;\n' | app_psql
}

db_volume_exists() {
  docker volume inspect "${CFG_PROJECT}_postgres_data" >/dev/null 2>&1
}

# project_containers: ids of every container of the panel's compose project, running or not.
project_containers() {
  docker ps -aq --filter "label=com.docker.compose.project=$CFG_PROJECT"
}

# Standby: install.sh --no-start prepared this server, or restore.sh is filling it; the panel it
# holds is not the live one. The timers skip it: a backup from here would become `latest` in
# the shared repository, and a health check would page the owner about a panel that is off on
# purpose. install.sh clears the marker when it starts the panel.
is_standby() { [ -f "$STATE_DIR/standby" ]; }
set_standby() { : >"$STATE_DIR/standby"; }
clear_standby() { rm -f "$STATE_DIR/standby"; }

# lock_held <file>: status 0 when another process holds the flock on <file>.
lock_held() {
  local fd
  [ -e "$1" ] || return 1
  exec {fd}<"$1"
  if flock -n "$fd"; then
    exec {fd}<&-
    return 1
  fi
  exec {fd}<&-
  return 0
}
```

- [ ] **Step 5: `install.sh` на `lib/app.sh`**

В `scripts/deploy/install.sh`:

1. После строки `. "$SCRIPT_DIR/lib/system.sh"` добавить:

```bash
# shellcheck source=lib/app.sh
. "$SCRIPT_DIR/lib/app.sh"
```

2. Строку `READY_TIMEOUT=180` заменить на:

```bash
# update.sh raises it: long backfill migrations run before the backend listens.
READY_TIMEOUT=${MAILEXPERT_READY_TIMEOUT:-180}
```

3. Удалить функции `app_compose`, `edge_compose` и `ensure_image` (теперь в `lib/app.sh`, тела те же).

4. В `ensure_app_images` удалить строку `BACKEND_IMAGE=$CFG_IMAGE_PREFIX/mailexpert-backend:$CFG_VERSION` (её задаёт `set_install_paths`).

5. В `guard_existing_database` строку `docker volume inspect "${CFG_PROJECT}_postgres_data" >/dev/null 2>&1 || return 0` заменить на `db_volume_exists || return 0`.

6. Функцию `app_up` заменить на:

```bash
# app_up: `up` waits for the backend to be healthy before it starts the frontend, with no time
# limit, and a backend that crashes at start (a failing migration) restarts forever without
# ever turning unhealthy. The wait is bounded so that update.sh gets to its rollback.
app_up() {
  log "starting the panel (compose project $CFG_PROJECT)"
  timeout "$READY_TIMEOUT" "${APP_COMPOSE[@]}" up -d --quiet-pull ||
    die "the panel did not start within ${READY_TIMEOUT}s; see: docker compose -p $CFG_PROJECT logs backend"
  clear_standby
}
```

7. В `wait_ready` строку `until curl -fs -o /dev/null "$base/api/health/ready"; do` заменить на `until panel_ready; do`.

8. В `main` строки

```bash
  APP_DIR=$OPT_PREFIX/app EDGE_DIR=$OPT_PREFIX/edge STATE_DIR=$OPT_PREFIX/state
  ENV_FILE=$OPT_PREFIX/.env EDGE_ENV=$OPT_PREFIX/edge/.env
```

заменить на:

```bash
  [[ $READY_TIMEOUT =~ ^[0-9]+$ ]] || die "MAILEXPERT_READY_TIMEOUT must be a number of seconds" 2
  set_install_paths
```

и строку `if [ "$OPT_START" = 1 ]; then app_up; fi` — на:

```bash
  if [ "$OPT_START" = 1 ]; then app_up; else set_standby; fi
```

9. В `check_tools` добавить `timeout` в список: `for tool in git curl jq ss sha256sum timeout; do`.

- [ ] **Step 6: Прогнать проверки**

Run: `BATS`
Expected: PASS — новые `lock.bats`, `app.bats` и все тесты 7b.

Run: `git add -A && SC; echo "exit $?"`
Expected: `exit 0`.

- [ ] **Step 7: Commit**

```bash
git add .gitattributes scripts/deploy/lib/common.sh scripts/deploy/lib/app.sh scripts/deploy/install.sh \
  scripts/deploy/test/helper.bash scripts/deploy/test/lock.bats scripts/deploy/test/app.bats
git commit -m "refactor(deploy): share the installed-panel helpers and bound the panel start"
```

- [ ] **Step 8: e2e установки 7b после рефакторинга**

Run: `E2E` (раздел «Как запускать проверки»; сценарий 7b, других ещё нет).
Expected: `[e2e] ok: install e2e passed`, `deploy e2e passed`, `exit 0`, `host-unchanged`, список `me-e2e-` пуст. Падение — исправить новым коммитом и повторить.

---

### Task 2: Ключи restic в `configure.sh` и чистые функции бэкапа

**Files:**
- Modify: `scripts/deploy/lib/env.sh` (списки ключей владельца)
- Modify: `scripts/deploy/configure.sh`
- Create: `scripts/deploy/lib/backup.sh` (чистая часть; Docker-часть — Task 3)
- Create: `scripts/deploy/test/backup.bats`
- Modify: `scripts/deploy/test/configure.bats`

**Interfaces:**
- Consumes: `env_get`, `env_missing`, `env_value_ok`, `GENERATED_SECRET_KEYS` (`env.sh`).
- Produces:
  - `APP_OWNER_KEYS` (в `.env`, заменяются): `CF_ACCESS_ISSUER CF_ACCESS_AUDIENCE AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET HEALTHCHECK_PING_URL BACKUP_PING_URL RESTIC_REPOSITORY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION`; `EDGE_OWNER_KEYS` (в `edge/.env`): `TUNNEL_TOKEN DNS_API_TOKEN`; `WRITE_ONCE_KEYS`: `GENERATED_SECRET_KEYS` + `RESTIC_PASSWORD`.
  - `RESTIC_IMAGE=restic/restic:0.18.0`, `RESTIC_HOST=mailexpert-panel`, `RESTIC_KEYS` (четыре обязательных), `BACKUP_MAX_AGE` (26 ч).
  - `restic_repository_ok <url>` → 0/1; `backup_configured <env file>` → 0, когда все `RESTIC_KEYS` заданы; `ping_target <base> start|success|fail` → URL; `backup_checks <weekday 1-7> <tag> <verify 0|1>` → `verify|check|none`; `prune_today <weekday> <tag>` → 0/1; `json_number <key>` (однострочный JSON в stdin, целое; статус 1 — нет ключа); `backup_age_problem <now> <finished epoch|''> <since epoch|''> [max]` → строка проблемы или ничего; `backup_tag_ok <tag>`.

Решения задачи:
- Ключи restic лежат в `<prefix>/.env` вместе с остальными секретами владельца: один файл `0600`, одна блокировка, одна логика `configure.sh`. В контейнеры панели они не попадают: `docker-compose.yml` передаёт backend только перечисленные переменные.
- `RESTIC_PASSWORD` задаёт владелец (например, `openssl rand -hex 32` у себя), как и ключи S3; скрипты его не генерируют. Пишется один раз: заменённый пароль не меняет пароль репозитория, а только запирает сервер снаружи, и если старое значение нигде больше не записано, бэкапы потеряны. Ошибка исправляется вручную в `.env` — сознательным действием.
- `RESTIC_REPOSITORY` — только S3 (`s3:https://…`); `http` — только loopback (MinIO в e2e). Провайдер не выбран, поэтому никаких провайдер-специфичных ключей: регион необязателен (`AWS_DEFAULT_REGION`), путь-стиль/адрес задаёт сам URL.
- `BACKUP_PING_URL` необязателен: если у владельца отдельная проверка для ночного бэкапа (расписание «раз в сутки»), `backup.sh` пингует её; иначе — `HEALTHCHECK_PING_URL`, как в спецификации.

- [ ] **Step 1: Написать падающие тесты**

`scripts/deploy/test/backup.bats`:

```bash
#!/usr/bin/env bats
# Backup decisions that need no Docker: repository URLs, pings, which checks run, JSON fields
# and the backup age.

bats_require_minimum_version 1.5.0

setup() {
  load helper
}

@test "restic_repository_ok: S3 over https, plain http only on the loopback" {
  restic_repository_ok s3:https://s3.example.com/panel-backups
  restic_repository_ok s3:https://s3.example.com:9000/panel-backups/main/sub
  restic_repository_ok s3:http://127.0.0.1:19000/me-e2e-backups
  restic_repository_ok s3:http://localhost:9000/b
  for bad in s3:http://s3.example.com/b s3:https://s3.example.com s3:https://s3.example.com/ \
    /srv/restic sftp:backup@example.com:/r rest:https://example.com/r 'b2:bucket:path' \
    's3:https://s3.example.com/b c'; do
    run restic_repository_ok "$bad"
    [ "$status" -eq 1 ]
  done
}

@test "backup_configured needs all four restic keys" {
  F=$BATS_TEST_TMPDIR/.env
  printf '%s\n' RESTIC_REPOSITORY=s3:https://s3.example.com/b RESTIC_PASSWORD=p AWS_ACCESS_KEY_ID=a >"$F"
  run backup_configured "$F"
  [ "$status" -eq 1 ]
  printf 'AWS_SECRET_ACCESS_KEY=s\n' >>"$F"
  backup_configured "$F"
  printf 'RESTIC_PASSWORD=\n' >"$F.2"
  run backup_configured "$F.2"
  [ "$status" -eq 1 ]
}

@test "ping_target follows the start, success and fail endpoints" {
  [ "$(ping_target https://hc.example.com/ping/abc success)" = https://hc.example.com/ping/abc ]
  [ "$(ping_target https://hc.example.com/ping/abc/ start)" = https://hc.example.com/ping/abc/start ]
  [ "$(ping_target https://hc.example.com/ping/abc fail)" = https://hc.example.com/ping/abc/fail ]
  run ping_target https://hc.example.com/ping/abc other
  [ "$status" -eq 1 ]
}

@test "backup_checks: nightly verifies on Sundays and checks on other days; other tags only on request" {
  [ "$(backup_checks 7 nightly 0)" = verify ]
  [ "$(backup_checks 1 nightly 0)" = check ]
  [ "$(backup_checks 6 nightly 0)" = check ]
  [ "$(backup_checks 3 pre-update 0)" = none ]
  [ "$(backup_checks 7 move 0)" = none ]
  [ "$(backup_checks 3 manual 1)" = verify ]
  [ "$(backup_checks 3 nightly 1)" = verify ]
}

@test "prune_today: only the nightly backup on Sunday prunes" {
  prune_today 7 nightly
  run prune_today 6 nightly
  [ "$status" -eq 1 ]
  run prune_today 7 manual
  [ "$status" -eq 1 ]
}

@test "json_number reads compact and psql-style JSON" {
  [ "$(json_number finished_epoch <<<'{"finished_epoch":1800000000,"snapshot":"ab"}')" = 1800000000 ]
  [ "$(json_number email_accounts <<<'{"schema_migrations" : 66, "users" : 2, "email_accounts" : 1}')" = 1 ]
  [ "$(json_number users <<<'{"schema_migrations" : 66, "users" : 2, "email_accounts" : 1}')" = 2 ]
  run json_number dump_bytes <<<'{"snapshot":"ab"}'
  [ "$status" -eq 1 ]
}

@test "backup_age_problem" {
  now=1800000000
  [ -z "$(backup_age_problem "$now" $((now - 3600)) '')" ]
  [ "$(backup_age_problem "$now" $((now - 27 * 3600)) '')" = "backup: the last successful backup is 27 hours old" ]
  [ -z "$(backup_age_problem "$now" '' $((now - 3600)))" ]
  [ "$(backup_age_problem "$now" '' $((now - 30 * 3600)))" = "backup: no successful backup in the 30 hours since backups were configured" ]
  [ "$(backup_age_problem "$now" '' '')" = "backup: no successful backup recorded" ]
  [ -n "$(backup_age_problem "$now" $((now - 100)) '' 60)" ]
}

@test "backup_tag_ok" {
  backup_tag_ok nightly
  backup_tag_ok pre-update
  for bad in '' Nightly -x 'a b' "$(printf 'a%.0s' {1..33})"; do
    run backup_tag_ok "$bad"
    [ "$status" -eq 1 ]
  done
}
```

В `scripts/deploy/test/configure.bats` в конец добавить:

```bash
@test "restic keys and the backup ping URL go to .env and no value is printed" {
  run bash "$CONFIGURE" --prefix "$P" <<'EOF'
RESTIC_REPOSITORY=s3:https://s3.example.com/panel-backups/main
RESTIC_PASSWORD=restic-password-value-0001
AWS_ACCESS_KEY_ID=access-key-value-0002
AWS_SECRET_ACCESS_KEY=secret-key-value-0003
AWS_DEFAULT_REGION=eu-central-1
BACKUP_PING_URL=https://hc-ping.example.com/backup-ping-0004
EOF
  [ "$status" -eq 0 ]
  [[ $output == *RESTIC_PASSWORD* && $output != *value-000* && $output != *backup-ping-0004* ]]
  [ "$(env_get "$P/.env" RESTIC_REPOSITORY)" = s3:https://s3.example.com/panel-backups/main ]
  [ "$(env_get "$P/.env" RESTIC_PASSWORD)" = restic-password-value-0001 ]
  [ "$(env_get "$P/.env" AWS_ACCESS_KEY_ID)" = access-key-value-0002 ]
  [ "$(env_get "$P/.env" AWS_SECRET_ACCESS_KEY)" = secret-key-value-0003 ]
  [ "$(env_get "$P/.env" AWS_DEFAULT_REGION)" = eu-central-1 ]
  [ "$(env_get "$P/.env" BACKUP_PING_URL)" = https://hc-ping.example.com/backup-ping-0004 ]
}

@test "the repository must be S3 over https, plain http only on the loopback" {
  for bad in s3:http://s3.example.com/b /srv/restic sftp:backup@example.com:/r s3:https://s3.example.com; do
    run bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_REPOSITORY=$bad"
    [ "$status" -eq 2 ]
    [[ $output == *"RESTIC_REPOSITORY: must be s3:https://"* ]]
  done
  run bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_REPOSITORY=s3:http://127.0.0.1:19000/me-e2e-backups"
  [ "$status" -eq 0 ]
  run bash "$CONFIGURE" --prefix "$P" <<<"BACKUP_PING_URL=http://hc.example.com/x"
  [ "$status" -eq 2 ]
  run bash "$CONFIGURE" --prefix "$P" <<<"AWS_DEFAULT_REGION=Not_A_Region"
  [ "$status" -eq 2 ]
}

@test "RESTIC_PASSWORD: at least 16 characters and written once" {
  run bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_PASSWORD=too-short"
  [ "$status" -eq 2 ]
  [[ $output != *too-short* ]]
  bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_PASSWORD=first-restic-password"
  run bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_PASSWORD=first-restic-password"
  [ "$status" -eq 0 ]
  before=$(sha256sum <"$P/.env")
  run bash "$CONFIGURE" --prefix "$P" <<<"RESTIC_PASSWORD=second-restic-password"
  [ "$status" -eq 2 ]
  [[ $output == *"RESTIC_PASSWORD: "*"never replaced"* && $output != *first-restic* && $output != *second-restic* ]]
  [ "$(sha256sum <"$P/.env")" = "$before" ]
}

@test "a different generated key points to restore.sh for a move" {
  bash "$CONFIGURE" --prefix "$P" <<<"ENCRYPTION_KEY=$(printf 'b%.0s' {1..64})"
  run bash "$CONFIGURE" --prefix "$P" <<<"ENCRYPTION_KEY=$(printf 'c%.0s' {1..64})"
  [ "$status" -eq 2 ]
  [[ $output == *"ENCRYPTION_KEY: "*restore.sh* ]]
}
```

Run: `BATS`
Expected: FAIL — `restic_repository_ok: command not found` и т.д. в `backup.bats`; в `configure.bats` четыре новых теста падают (`RESTIC_REPOSITORY: not a key configure.sh stores`).

- [ ] **Step 2: Списки ключей в `env.sh`**

В `scripts/deploy/lib/env.sh` после строки `GENERATED_SECRET_KEYS=(...)` добавить:

```bash
# Owner secrets that configure.sh stores, replaced when given again (rotation). Backups go to any
# S3-compatible storage the owner picks: the repository URL and the access keys are all it takes.
# shellcheck disable=SC2034 # read by configure.sh, restore.sh and tests
APP_OWNER_KEYS=(CF_ACCESS_ISSUER CF_ACCESS_AUDIENCE AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET
  HEALTHCHECK_PING_URL BACKUP_PING_URL RESTIC_REPOSITORY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  AWS_DEFAULT_REGION)
# shellcheck disable=SC2034
EDGE_OWNER_KEYS=(TUNNEL_TOKEN DNS_API_TOKEN)
# Written once and never replaced by configure.sh: the generated keys, and RESTIC_PASSWORD, which
# a replacement would not change in the repository, only lock this server out of it.
# shellcheck disable=SC2034
WRITE_ONCE_KEYS=("${GENERATED_SECRET_KEYS[@]}" RESTIC_PASSWORD)
```

- [ ] **Step 3: Чистая часть `scripts/deploy/lib/backup.sh`**

```bash
# shellcheck shell=bash
# Backups: restic in a pinned container against any S3-compatible repository, retention,
# monitoring pings and state/backup-last.json. Needs common.sh and env.sh; the functions that run
# Docker also need app.sh. Pure functions first (bats covers them).

# 0.17.1+ reports "repository does not exist" as exit 10 and a wrong password as exit 12, which
# ensure_backup_repo relies on; a pinned image gives every server and the e2e test the same restic.
# shellcheck disable=SC2034 # read by the deploy scripts and e2e.sh
RESTIC_IMAGE=restic/restic:0.18.0
# One restic host name for every server of this panel: after a move the new server continues the
# same snapshot history, and `latest` is the latest backup of the panel wherever it ran.
RESTIC_HOST=mailexpert-panel
RESTIC_KEYS=(RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY)
# The health check fails when the last backup is older: nightly at 03:30 plus slack.
BACKUP_MAX_AGE=$((26 * 3600))

# restic_repository_ok <url>: s3:https://<endpoint>/<bucket>[/<path>]; plain http only on the
# loopback (MinIO in the e2e test).
restic_repository_ok() {
  [[ $1 =~ ^s3:https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._-]+(/[A-Za-z0-9._/-]*)?$ ]] ||
    [[ $1 =~ ^s3:http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?/[A-Za-z0-9._-]+(/[A-Za-z0-9._/-]*)?$ ]]
}

# backup_configured <env file>: status 0 when the four restic keys are set.
backup_configured() {
  [ -z "$(env_missing "$1" "${RESTIC_KEYS[@]}")" ]
}

# ping_target <base url> <start|success|fail>: the URL of the event (Healthchecks-style: the base
# URL is success, /start and /fail are the others).
ping_target() {
  local base=${1%/}
  case $2 in
    success) printf '%s\n' "$base" ;;
    start | fail) printf '%s/%s\n' "$base" "$2" ;;
    *) return 1 ;;
  esac
}

# backup_checks <weekday 1-7> <tag> <verify 0|1>: what follows a backup. verify: restore into a
# scratch database and decrypt; check: restic reads back 5% of the data; none. The nightly
# backup verifies on Sundays and checks on the other days; other tags only with --verify.
backup_checks() {
  if [ "$3" = 1 ]; then
    echo verify
  elif [ "$2" != nightly ]; then
    echo none
  elif [ "$1" = 7 ]; then
    echo verify
  else
    echo check
  fi
}

# prune_today <weekday 1-7> <tag>: status 0 when forget also prunes (the nightly run on Sunday).
prune_today() {
  [ "$2" = nightly ] && [ "$1" = 7 ]
}

# json_number <key>: the integer value of <key> in the one-line JSON on stdin (jq -c or psql
# json_build_object output); status 1 when the key is absent.
json_number() {
  local value
  value=$(sed -n "s/.*\"$1\" *: *\(-\{0,1\}[0-9][0-9]*\).*/\1/p" | head -n 1)
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

# backup_age_problem <now> <last success epoch or ''> <backups configured since epoch or ''>
# [max seconds]: prints the problem, nothing when the last backup is recent enough. A server
# whose backups were just configured is not a problem before its first night.
backup_age_problem() {
  local now=$1 finished=$2 since=$3 max=${4:-$BACKUP_MAX_AGE}
  if [[ $finished =~ ^[0-9]+$ ]]; then
    if [ $((now - finished)) -gt "$max" ]; then
      echo "backup: the last successful backup is $(((now - finished) / 3600)) hours old"
    fi
  elif [[ $since =~ ^[0-9]+$ ]]; then
    if [ $((now - since)) -gt "$max" ]; then
      echo "backup: no successful backup in the $(((now - since) / 3600)) hours since backups were configured"
    fi
  else
    echo "backup: no successful backup recorded"
  fi
  return 0
}

backup_tag_ok() {
  [[ $1 =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]
}
```

- [ ] **Step 4: `configure.sh`**

В `scripts/deploy/configure.sh`:

1. После строки `. "$SCRIPT_DIR/lib/env.sh"` добавить:

```bash
# shellcheck source=lib/backup.sh
. "$SCRIPT_DIR/lib/backup.sh"
```

2. Удалить строки с `# Owner secrets, replaced when given again (rotation).`, `APP_OWNER_KEYS=(...)` и `EDGE_OWNER_KEYS=(...)` (теперь в `env.sh`).

3. Текст `usage` заменить на:

```bash
usage() {
  cat <<'EOF'
Usage: configure.sh [--prefix /opt/mailexpert] < file-with-KEY=VALUE-lines

Panel (<prefix>/.env):     CF_ACCESS_ISSUER, CF_ACCESS_AUDIENCE, AUTH_GOOGLE_CLIENT_ID,
                           AUTH_GOOGLE_CLIENT_SECRET, HEALTHCHECK_PING_URL, BACKUP_PING_URL
Backups (<prefix>/.env):   RESTIC_REPOSITORY (s3:https://<endpoint>/<bucket>[/<path>], any
                           S3-compatible storage), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
                           AWS_DEFAULT_REGION (only when the storage needs one), RESTIC_PASSWORD
Edge (<prefix>/edge/.env): TUNNEL_TOKEN, DNS_API_TOKEN
A key given again replaces the stored value, except RESTIC_PASSWORD and the generated keys
(SESSION_SECRET, ENCRYPTION_KEY, DB_PASSWORD, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY): those are
accepted only when absent or identical. On a new server restore.sh takes the generated keys
from the backup. Then run install.sh again.
EOF
}
```

4. `key_target` заменить на:

```bash
# key_target <key>: app, edge or once; status 1 for keys configure.sh does not store.
key_target() {
  local key=$1 known
  for known in "${APP_OWNER_KEYS[@]}"; do [ "$known" = "$key" ] && { echo app; return 0; }; done
  for known in "${EDGE_OWNER_KEYS[@]}"; do [ "$known" = "$key" ] && { echo edge; return 0; }; done
  for known in "${WRITE_ONCE_KEYS[@]}"; do [ "$known" = "$key" ] && { echo once; return 0; }; done
  return 1
}
```

5. `value_problem` заменить на:

```bash
# value_problem <key> <value>: prints what is wrong with the value, nothing when it is fine.
value_problem() {
  case $1 in
    CF_ACCESS_ISSUER) [[ $2 =~ ^https://[a-z0-9-]+\.cloudflareaccess\.com$ ]] || echo "must be https://<TEAM>.cloudflareaccess.com" ;;
    HEALTHCHECK_PING_URL | BACKUP_PING_URL) [[ $2 =~ ^https:// ]] || echo "must be an https:// URL" ;;
    RESTIC_REPOSITORY) restic_repository_ok "$2" || echo "must be s3:https://<endpoint>/<bucket>[/<path>]" ;;
    RESTIC_PASSWORD) [ "${#2}" -ge 16 ] || echo "must be at least 16 characters" ;;
    AWS_DEFAULT_REGION) [[ $2 =~ ^[a-z0-9-]{2,32}$ ]] || echo "must be a region name such as us-east-1" ;;
  esac
  return 0
}
```

6. В `main` цикл проверки сгенерированных ключей под блокировкой заменить на:

```bash
  for i in "${!keys[@]}"; do
    [ "${targets[i]}" = once ] || continue
    current=$(env_get "$prefix/.env" "${keys[i]}") || current=
    if [ -n "$current" ] && [ "$current" != "${values[i]}" ]; then
      errors+=("${keys[i]}: $prefix/.env already has a different value; it is never replaced here (on a new server restore.sh brings ENCRYPTION_KEY and the other generated keys from the backup; a wrong RESTIC_PASSWORD is corrected by hand)")
    fi
  done
```

- [ ] **Step 5: Прогнать проверки**

Run: `BATS`
Expected: PASS, включая старый тест «generated secrets: stored when absent, kept when equal, refused when different».

Run: `git add -A && SC; echo "exit $?"`
Expected: `exit 0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy/lib/env.sh scripts/deploy/lib/backup.sh scripts/deploy/configure.sh \
  scripts/deploy/test/backup.bats scripts/deploy/test/configure.bats
git commit -m "feat(deploy): accept the restic repository keys in configure.sh"
```

---

### Task 3: `backup.sh` с проверкой восстановлением, репозиторий в `install.sh`, e2e бэкапа

**Files:**
- Modify: `scripts/deploy/lib/backup.sh` (Docker-часть)
- Create: `scripts/deploy/lib/pg-dump.sh`, `scripts/deploy/lib/counts.sql`, `scripts/deploy/lib/verify-restore.mjs`
- Create: `scripts/deploy/backup.sh` (режим `100755`)
- Modify: `scripts/deploy/install.sh` (`setup_backups`)
- Create: `scripts/deploy/test/e2e-lib.sh`, `scripts/deploy/test/e2e-backup.sh`, `scripts/deploy/test/e2e-credential.mjs`
- Modify: `scripts/deploy/test/e2e-install.sh`, `scripts/deploy/test/e2e.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1 (`load_install`, `app_compose`, `APP_COMPOSE`, `app_psql`, `ensure_image`, `is_standby`, `take_lock`, `BACKEND_IMAGE`), Task 2 (чистые функции `backup.sh`, `WRITE_ONCE_KEYS`).
- Produces:
  - `lib/backup.sh`: `load_restic_env` (экспортирует `RESTIC_KEYS` и `AWS_DEFAULT_REGION` из `.env`); `restic_run [-v host:container[:ro]]... -- <args>`; `ensure_backup_repo` (коды restic: 0 — открыт, 10 — нет репозитория → `init --repository-version 2`, 12 — неверный пароль → `die`, прочее → `die`); `print_recovery_key`; `show_recovery_key_once` (маркер `state/recovery-key.shown`); `backup_ping_url`; `send_ping <base> <start|success|fail> [text]` (никогда не валит вызывающего); `dump_database <dir>` (нужен `LIB_DIR` — каталог `lib` вызывающего скрипта); `write_backup_last <snapshot> <tag> <bytes> <seconds> <counts json> <restore seconds|''>`.
  - `backup.sh [--prefix P] [--tag T] [--verify] [--with-redis] [--keep-dump /abs/path]`, `backup.sh --show-recovery-key`; коды 0/1/2; на standby — 0 без действий.
  - `state/backup-last.json`: `{"finished_epoch":…, "finished_at":"…", "snapshot":"<id>", "tag":"…", "dump_bytes":…, "dump_seconds":…, "counts":{…}, "verified":true|false, "restore_seconds":…|null}`; `state/backup-since` (epoch первой настройки бэкапа).
  - `lib/verify-restore.mjs` (печатает `{"migrationsApplied":N,"decrypted":N,"failed":N,"mailboxValues":N}`, код 1 при ошибке; `VERIFY_EXPECT_MAILBOX=1` требует хотя бы одно значение из `email_accounts`); `lib/counts.sql`.
  - e2e: `e2e-lib.sh` (`fail`, `pass`, `labelled`, `remove_project`); `e2e-backup.sh --version --image-prefix --repo-url --minio-image` (помощники `deploy`, `on`, `expect_exit`/`OUT`, `credential`, `snapshots_here`, `backup_keys`; финальная строка `pass "backup e2e passed"` — следующие задачи вставляют свои этапы перед ней); `e2e.sh --only install|backup`.

Как устроен бэкап:
- Дамп и подсчёт строк берутся из **одного** снимка базы: одноразовый контейнер сервиса postgres (`docker compose run --rm --no-deps`, тот же образ, та же сеть, пароль из его окружения) открывает транзакцию `REPEATABLE READ`, экспортирует снимок (`pg_export_snapshot()`), `pg_dump --snapshot` и запрос `counts.sql` подключаются к нему. Так числа в `counts.json` описывают ровно то, что в дампе, и сравнение после восстановления не ломается от записей, пришедших между подсчётом и дампом.
- restic — в контейнере `restic/restic:0.18.0` с `--network host`; ключи — в окружении процесса (`export` из `.env`), в `docker run` только имена (`-e RESTIC_PASSWORD`).
- Проверка (`--verify`, ночью по воскресеньям): временный `postgres:16-alpine` без сети (`--network none`, `trust`, данные в `backups/verify-<hex>`), `restic dump … | pg_restore --single-transaction --exit-on-error`, сравнение `counts.sql` с `counts.json` из снимка, затем образ backend этой версии в сетевом пространстве временной базы (`--network container:<scratch>`, `127.0.0.1:5432`) с `ENCRYPTION_KEY` из `.env` **снимка**: `runMigrations()` не должен применить ни одной миграции, каждое `enc:v1:` значение в таблицах с секретами должно расшифроваться. В вывод попадают только числа.
- Хранение: `forget --tag pre-update --keep-last 5`, затем `forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --keep-tag pre-update --keep-tag move`; `--prune` — только ночной запуск в воскресенье; в остальные ночи — `check --read-data-subset=5%`.
- Пинги: `start` перед дампом, `success` в конце, `fail` из ловушки `EXIT` при любом ненулевом коде. Режим «только локальный дамп» (`--keep-dump` без ключей restic — `update.sh` на сервере без бэкапов) не пингует: это не бэкап.
- Если e2e покажет, что restic на пустом бакете MinIO возвращает не 10 (например, 1 с `NoSuchBucket`), — остановиться и доложить: не расширять `case` в `ensure_backup_repo`.

- [ ] **Step 1: Внутриконтейнерные части**

`scripts/deploy/lib/counts.sql`:

```sql
-- Row counts recorded with every dump (pg-dump.sh) and compared after every restore
-- (backup.sh --verify, restore.sh): one statement, one line of JSON.
SELECT json_build_object(
  'schema_migrations', (SELECT count(*) FROM schema_migrations),
  'users', (SELECT count(*) FROM users),
  'email_accounts', (SELECT count(*) FROM email_accounts),
  'google_oauth_apps', (SELECT count(*) FROM google_oauth_apps));
```

`scripts/deploy/lib/pg-dump.sh`:

```sh
# shellcheck shell=sh
# Runs in a one-off container of the postgres service (backup.sh, dump_database): dumps the
# panel's database and counts key tables in one exported snapshot, so the counts describe exactly
# what the dump holds. Writes /out/db.dump and /out/counts.json. POSIX sh (busybox).
set -eu
export PGHOST=postgres PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB" PGPASSWORD="$POSTGRES_PASSWORD"
work=$(mktemp -d)
holder=''
cleanup() {
  exec 3>&-
  if [ -n "$holder" ]; then wait "$holder" || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkfifo "$work/sql"
# The exporting transaction stays open until pg_dump and the counts have attached to its snapshot.
psql -X -q -A -t -v ON_ERROR_STOP=1 <"$work/sql" &
holder=$!
exec 3>"$work/sql"
# \o writes the snapshot name into a file and closes it, so the name is on disk, not in a buffer.
printf '%s\n' 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' "\\o $work/snapshot" \
  'SELECT pg_export_snapshot();' '\o' >&3
tries=0
until [ -s "$work/snapshot" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    echo "pg-dump.sh: no exported snapshot after 60s" >&2
    exit 1
  fi
  sleep 1
done
snapshot=$(head -n 1 "$work/snapshot")
pg_dump --snapshot="$snapshot" --format=custom --compress=0 --file=/out/db.dump
{
  printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
  printf "SET TRANSACTION SNAPSHOT '%s';\n" "$snapshot"
  cat /counts.sql
  printf 'COMMIT;\n'
} | psql -X -q -A -t -v ON_ERROR_STOP=1 >/out/counts.json
printf 'COMMIT;\n' >&3
exec 3>&-
wait "$holder"
holder=''
chmod 600 /out/db.dump /out/counts.json
```

`scripts/deploy/lib/verify-restore.mjs`:

```js
// Run by backup.sh --verify and restore.sh in the backend image, against a database restored
// from a backup: applies pending migrations (a backup of the running version has none) and
// decrypts every stored credential with ENCRYPTION_KEY from the same backup. Prints one line of
// counts, never a value. Exits 1 on any failure.
//
// VERIFY_EXPECT_MAILBOX=1: the backup has mailboxes, so at least one mailbox credential must
// decrypt (a key check that decrypted nothing proves nothing).
import { pool } from './src/services/db.js';
import { runMigrations } from './src/services/migrations.js';
import { decrypt } from './src/services/encryption.js';

// Values written by encrypt(): enc:v1:<iv hex>:<tag hex>:<ciphertext hex>.
const ENCRYPTED = /enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]*/g;
// Tables that hold values encrypted with ENCRYPTION_KEY. Whole rows are scanned as text, so a new
// encrypted column, or a token inside a JSON setting, in one of them needs no change here.
const TABLES = ['email_accounts', 'google_oauth_apps', 'users', 'system_settings', 'integration_config',
  'user_integrations', 'ai_codex_credentials', 'oidc_providers'];

const result = { migrationsApplied: 0, decrypted: 0, failed: 0, mailboxValues: 0 };
const print = console.log;
const quiet = () => {};
let ok = true;
try {
  const count = async () => Number((await pool.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n);
  const before = await count();
  console.log = quiet; // runMigrations reports progress on stdout; this script prints one line
  await runMigrations();
  console.log = print;
  result.migrationsApplied = (await count()) - before;
  if (result.migrationsApplied !== 0) ok = false;
  console.error = quiet; // decrypt() explains each failure on stderr; failures are counted instead
  for (const table of TABLES) {
    const { rows: [{ reg }] } = await pool.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
    if (!reg) continue;
    const { rows } = await pool.query(`SELECT t::text AS row FROM ${table} t`);
    for (const { row } of rows) {
      for (const value of row.match(ENCRYPTED) ?? []) {
        if (table === 'email_accounts') result.mailboxValues++;
        if (decrypt(value) === null) result.failed++;
        else result.decrypted++;
      }
    }
  }
  if (result.failed > 0) ok = false;
  if (process.env.VERIFY_EXPECT_MAILBOX === '1' && result.mailboxValues === 0) ok = false;
} catch (err) {
  console.log = print;
  result.error = err.code || err.name; // no message: it may quote data
  ok = false;
}
print(JSON.stringify(result));
await pool.end().catch(quiet);
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Docker-часть `lib/backup.sh`**

В конец `scripts/deploy/lib/backup.sh` добавить:

```bash
# --- The functions below run Docker and need app.sh (load_install or set_install_paths). ---

# load_restic_env: exports the restic keys from .env. The values stay in the environment of this
# process and its children; restic_run hands containers the names, never the values.
load_restic_env() {
  local key value
  for key in "${RESTIC_KEYS[@]}" AWS_DEFAULT_REGION; do
    value=$(env_get "$ENV_FILE" "$key") || value=
    if [ -n "$value" ]; then
      export "$key=$value"
    else
      unset "$key"
    fi
  done
}

# restic_run [-v <host path>:<container path>[:ro]]... -- <restic arguments>: restic in its
# pinned container on the host network (the repository may be on the loopback), with its cache
# in state/restic-cache.
restic_run() {
  local -a mounts=()
  while [ "${1:-}" = -v ]; do
    mounts+=(-v "$2")
    shift 2
  done
  [ "${1:-}" = -- ] || die "restic_run: -- expected before the restic arguments"
  shift
  mkdir -p "$STATE_DIR/restic-cache"
  docker run --rm --network host \
    -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -e RESTIC_CACHE_DIR=/cache -v "$STATE_DIR/restic-cache:/cache" "${mounts[@]}" "$RESTIC_IMAGE" "$@"
}

# ensure_backup_repo: opens the repository, creating it (format v2, compressed) only when restic
# reports that it does not exist. A password that does not open an existing repository is never
# answered with a new repository.
ensure_backup_repo() {
  local code=0
  restic_run -- cat config >/dev/null 2>&1 || code=$?
  case $code in
    0) log "backups: the restic repository opens" ;;
    10)
      log "backups: creating the restic repository"
      restic_run -- init --repository-version 2 >/dev/null
      ;;
    12) die "RESTIC_PASSWORD does not open the repository in RESTIC_REPOSITORY; configure.sh never replaces it: correct it in $ENV_FILE by hand" ;;
    *) die "the restic repository is not reachable (restic exit $code): check RESTIC_REPOSITORY and the S3 keys" ;;
  esac
}

# print_recovery_key: the one place a secret is printed, on stderr, at the owner's request or
# once at install time in a terminal.
print_recovery_key() {
  local repository password
  repository=$(env_get "$ENV_FILE" RESTIC_REPOSITORY)
  password=$(env_get "$ENV_FILE" RESTIC_PASSWORD)
  {
    printf '\n[mailexpert] RECOVERY KEY. Store it outside this server, for example in a password manager.\n'
    printf '[mailexpert] With it and the S3 access key (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) the backups\n'
    printf '[mailexpert] restore on any server; without it nobody can read them.\n\n'
    printf '  RESTIC_REPOSITORY=%s\n  RESTIC_PASSWORD=%s\n\n' "$repository" "$password"
  } >&2
}

# show_recovery_key_once: prints the recovery key the first time, and only to a terminal:
# cloud-init and CI logs must not keep it.
show_recovery_key_once() {
  local marker=$STATE_DIR/recovery-key.shown
  [ ! -f "$marker" ] || return 0
  if [ -t 2 ]; then
    print_recovery_key
    : >"$marker"
  else
    log "the recovery key has not been shown yet (no terminal); show it with: $APP_DIR/scripts/deploy/backup.sh --prefix $OPT_PREFIX --show-recovery-key"
  fi
}

# backup_ping_url: BACKUP_PING_URL when the owner keeps a separate daily check for backups,
# otherwise HEALTHCHECK_PING_URL; empty when neither is set.
backup_ping_url() {
  local url
  url=$(env_get "$ENV_FILE" BACKUP_PING_URL) || url=
  if [ -z "$url" ]; then url=$(env_get "$ENV_FILE" HEALTHCHECK_PING_URL) || url=; fi
  printf '%s\n' "$url"
}

# send_ping <base url> <start|success|fail> [text]: tells the monitoring service; never fails the
# caller. The URL carries the check's key, so it reaches curl through a config on a file
# descriptor, not through argv; curl's own messages are dropped for the same reason.
send_ping() {
  local base=$1 kind=$2 body=${3:-} target
  [ -n "$base" ] || return 0
  target=$(ping_target "$base" "$kind") || return 0
  if ! printf '%s' "$body" | curl -fsS -m 10 --retry 2 -o /dev/null --data-binary @- \
    -K <(printf 'url = "%s"\n' "$target") 2>/dev/null; then
    warn "could not reach the monitoring service ($kind ping)"
  fi
}

# dump_database <dir>: <dir>/db.dump (pg_dump custom format, uncompressed: restic compresses and
# deduplicates across days) and <dir>/counts.json, from one database snapshot, by a one-off
# container of the postgres service. LIB_DIR is the caller's scripts/deploy/lib.
dump_database() {
  app_compose run --rm --no-deps -T -v "$1:/out" -v "$LIB_DIR/pg-dump.sh:/pg-dump.sh:ro" \
    -v "$LIB_DIR/counts.sql:/counts.sql:ro" --entrypoint sh postgres /pg-dump.sh >/dev/null
}

# write_backup_last <snapshot> <tag> <dump bytes> <dump seconds> <counts json> <restore seconds or ''>:
# state/backup-last.json for healthcheck.sh (age), update.sh (free space) and the owner (the
# expected downtime of a move).
write_backup_last() {
  local file=$STATE_DIR/backup-last.json tmp now
  now=$(date +%s)
  tmp=$(mktemp "$file.XXXXXX")
  jq -cn --arg snapshot "$1" --arg tag "$2" --argjson dump_bytes "$3" --argjson dump_seconds "$4" \
    --argjson counts "$5" --arg restore "$6" --argjson now "$now" \
    '{finished_epoch: $now, finished_at: ($now | todate), snapshot: $snapshot, tag: $tag,
      dump_bytes: $dump_bytes, dump_seconds: $dump_seconds, counts: $counts,
      verified: ($restore != ""),
      restore_seconds: (if $restore == "" then null else ($restore | tonumber) end)}' >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}
```

- [ ] **Step 3: `scripts/deploy/backup.sh`**

```bash
#!/usr/bin/env bash
# Backs up the panel into the restic repository named in .env (any S3-compatible storage): a
# pg_dump with the row counts taken in the same database snapshot, plus .env, edge/.env and
# install.conf, which hold the keys that make the dump usable. restic encrypts the repository
# with RESTIC_PASSWORD, kept on the server and by the owner (the recovery key).
#
# Nightly by mailexpert-backup.timer; by hand; by update.sh (--tag pre-update --keep-dump); before
# a move, once the panel is stopped (--with-redis --tag move). Pings BACKUP_PING_URL (or
# HEALTHCHECK_PING_URL) at the start, on success and on failure.
#
# Exit codes: 0 done (or skipped on a standby server), 1 failure, 2 invalid input.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR=$SCRIPT_DIR/lib
# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib/config.sh
. "$LIB_DIR/config.sh"
# shellcheck source=lib/app.sh
. "$LIB_DIR/app.sh"
# shellcheck source=lib/backup.sh
. "$LIB_DIR/backup.sh"
exit_on_unexpected_failure

# How long to wait for another backup.sh: update.sh's pre-update backup may meet a nightly one.
LOCK_TIMEOUT=${MAILEXPERT_BACKUP_LOCK_TIMEOUT:-3600}
SCRATCH_IMAGE=postgres:16-alpine
PING_URL='' STARTED=0 STAGING='' VERIFY_DIR='' VERIFY_CONTAINER='' VERIFY_SECONDS=''

usage() {
  cat <<'EOF'
Usage: backup.sh [--prefix /opt/mailexpert] [--tag nightly] [--verify] [--with-redis]
                 [--keep-dump <absolute path>]
       backup.sh [--prefix /opt/mailexpert] --show-recovery-key

--tag           restic tag: nightly (default, the timer), manual, pre-update, move, ...
--verify        after the backup, restore it into a scratch database and check it; the nightly
                backup does this on Sundays and a restic check of 5% of the data on other days
--with-redis    also Redis (sessions, idempotency keys): for a move, once the panel is stopped
--keep-dump     also keep the database dump at this path (update.sh); without the restic keys
                only this local dump is made
--show-recovery-key
                print RESTIC_REPOSITORY and RESTIC_PASSWORD to store them outside the server
Exit codes: 0 done or skipped on a standby server, 1 failure, 2 invalid input.
EOF
}

finish() {
  local status=$?
  if [ -n "$VERIFY_CONTAINER" ]; then docker rm -fv "$VERIFY_CONTAINER" >/dev/null 2>&1 || true; fi
  if [ -n "$VERIFY_DIR" ]; then rm -rf "$VERIFY_DIR"; fi
  if [ -n "$STAGING" ]; then rm -rf "$STAGING"; fi
  if [ "$status" != 0 ] && [ "$STARTED" = 1 ]; then
    send_ping "$PING_URL" fail "backup.sh failed with exit $status; see journalctl -u mailexpert-backup"
  fi
  exit "$status"
}

# stage_files <dir> <with redis 0|1>: what goes into the snapshot next to the dump.
stage_files() {
  local dir=$1
  cp -p "$ENV_FILE" "$dir/env"
  if [ -f "$EDGE_ENV" ]; then cp -p "$EDGE_ENV" "$dir/edge.env"; fi
  cp -p "$OPT_PREFIX/install.conf" "$dir/install.conf"
  if [ "$2" = 1 ]; then
    app_compose exec -T redis redis-cli SAVE >/dev/null
    app_compose cp redis:/data/dump.rdb "$dir/redis.rdb"
    chmod 600 "$dir/redis.rdb"
    log "redis: dump.rdb added"
  fi
}

# forget_old <weekday> <tag>: the last 5 pre-update snapshots; otherwise 7 daily, 4 weekly and 6
# monthly, and every pre-update and move snapshot outside that policy. The nightly run on Sunday
# also prunes, which frees the space of forgotten snapshots.
forget_old() {
  local -a prune=()
  if prune_today "$1" "$2"; then prune=(--prune); fi
  restic_run -- forget --host "$RESTIC_HOST" --tag pre-update --keep-last 5 >/dev/null
  restic_run -- forget --host "$RESTIC_HOST" --keep-daily 7 --keep-weekly 4 --keep-monthly 6 \
    --keep-tag pre-update --keep-tag move "${prune[@]}" >/dev/null
}

wait_scratch_db() {
  for _ in $(seq 60); do
    if docker exec "$VERIFY_CONTAINER" pg_isready -q -h 127.0.0.1 -U mailexpert -d mailexpert; then return 0; fi
    sleep 1
  done
  die "verify: the scratch database did not start in 60s"
}

# verify_snapshot <snapshot>: the snapshot restored into a scratch PostgreSQL without network,
# its row counts compared with the ones taken at dump time, then the backend image of this
# version run against it: no migration may be pending, and every stored credential must decrypt
# with ENCRYPTION_KEY from the same snapshot. Only counts are printed. Sets VERIFY_SECONDS, the
# restore time: the main part of the downtime of a move.
verify_snapshot() {
  local snapshot=$1 id files expected restored key mailboxes expect=0 result started
  id=$(gen_hex 4)
  VERIFY_DIR=$BACKUP_DIR/verify-$id
  VERIFY_CONTAINER=$CFG_PROJECT-verify-$id
  mkdir -m 700 "$VERIFY_DIR"
  mkdir -m 700 "$VERIFY_DIR/data" "$VERIFY_DIR/files"
  restic_run -v "$VERIFY_DIR/files:/restore" -- restore "$snapshot" --target /restore \
    --include /backup/env --include /backup/counts.json >/dev/null
  files=$VERIFY_DIR/files/backup
  expected=$(<"$files/counts.json")
  key=$(env_get "$files/env" ENCRYPTION_KEY) || key=
  [ -n "$key" ] || die "verify: the snapshot has no ENCRYPTION_KEY in its .env"
  ensure_image "$SCRATCH_IMAGE"
  docker run -d --name "$VERIFY_CONTAINER" --label "mailexpert.verify=$CFG_PROJECT" --network none \
    -e POSTGRES_USER=mailexpert -e POSTGRES_DB=mailexpert -e POSTGRES_HOST_AUTH_METHOD=trust \
    -v "$VERIFY_DIR/data:/var/lib/postgresql/data" "$SCRATCH_IMAGE" >/dev/null
  wait_scratch_db
  started=$SECONDS
  restic_run -- dump "$snapshot" /backup/db.dump |
    docker exec -i "$VERIFY_CONTAINER" pg_restore -U mailexpert -d mailexpert --no-owner --exit-on-error --single-transaction
  VERIFY_SECONDS=$((SECONDS - started))
  restored=$(docker exec -i "$VERIFY_CONTAINER" psql -X -q -A -t -v ON_ERROR_STOP=1 -U mailexpert -d mailexpert <"$LIB_DIR/counts.sql")
  [ "$restored" = "$expected" ] || die "verify: row counts differ after the restore (dump: $expected, restored: $restored)"
  mailboxes=$(json_number email_accounts <<<"$expected") || mailboxes=0
  if [ "$mailboxes" -gt 0 ]; then expect=1; fi
  result=$(ENCRYPTION_KEY=$key VERIFY_EXPECT_MAILBOX=$expect docker run --rm --network "container:$VERIFY_CONTAINER" \
    -e ENCRYPTION_KEY -e VERIFY_EXPECT_MAILBOX -e DB_HOST=127.0.0.1 -e DB_USER=mailexpert -e DB_NAME=mailexpert \
    -v "$LIB_DIR/verify-restore.mjs:/app/verify-restore.mjs:ro" --entrypoint node "$BACKEND_IMAGE" verify-restore.mjs) ||
    die "verify: the restored data failed the check: $result"
  log "verify: restored in ${VERIFY_SECONDS}s, counts match, $result"
}

main() {
  local prefix=/opt/mailexpert tag=nightly verify=0 redis=0 keep='' show_key=0 local_only=0
  local started seconds bytes counts snapshot weekday checks
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix | --tag | --keep-dump)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value" 2; fi
        case $1 in
          --prefix) prefix=$2 ;;
          --tag) tag=$2 ;;
          --keep-dump) keep=$2 ;;
        esac
        shift 2
        ;;
      --verify) verify=1 && shift ;;
      --with-redis) redis=1 && shift ;;
      --show-recovery-key) show_key=1 && shift ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
  backup_tag_ok "$tag" || die "--tag must be lowercase letters, digits and '-'" 2
  if [ -n "$keep" ] && [[ ! $keep =~ ^/[A-Za-z0-9._/-]+$ ]]; then die "--keep-dump needs an absolute path without spaces" 2; fi
  [ "$(id -u)" = 0 ] || die "run backup.sh as root"
  load_install "$prefix"

  if [ "$show_key" = 1 ]; then
    backup_configured "$ENV_FILE" || die "backups are not configured, so there is no recovery key" 2
    print_recovery_key
    : >"$STATE_DIR/recovery-key.shown"
    return 0
  fi
  if is_standby; then
    log "standby server (install.sh --no-start or restore.sh): backup skipped"
    return 0
  fi
  take_lock "$STATE_DIR/backup.lock" "$LOCK_TIMEOUT" "another backup.sh"
  trap finish EXIT
  PING_URL=$(backup_ping_url)
  if ! backup_configured "$ENV_FILE" && [ -n "$keep" ]; then
    warn "backups are not configured: only the local dump $keep is made"
    local_only=1
  else
    send_ping "$PING_URL" start
    STARTED=1
    backup_configured "$ENV_FILE" ||
      die "backups are not configured: add RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY with configure.sh, then run install.sh"
  fi

  mkdir -p "$BACKUP_DIR"
  STAGING=$BACKUP_DIR/staging
  rm -rf "$STAGING"
  mkdir -m 700 "$STAGING"
  started=$SECONDS
  dump_database "$STAGING"
  seconds=$((SECONDS - started))
  bytes=$(stat -c %s "$STAGING/db.dump")
  counts=$(<"$STAGING/counts.json")
  log "database dumped in ${seconds}s, $bytes bytes, rows: $counts"
  if [ -n "$keep" ]; then
    cp -p "$STAGING/db.dump" "$keep"
    log "dump kept at $keep"
  fi
  [ "$local_only" = 0 ] || return 0

  stage_files "$STAGING" "$redis"
  load_restic_env
  ensure_image "$RESTIC_IMAGE"
  snapshot=$(restic_run -v "$STAGING:/backup:ro" -- backup --json --host "$RESTIC_HOST" --tag "$tag" /backup |
    jq -r 'select(.message_type == "summary") | .snapshot_id')
  [ -n "$snapshot" ] || die "restic reported no snapshot"
  log "snapshot ${snapshot:0:8} stored (tag $tag)"
  weekday=$(date +%u)
  forget_old "$weekday" "$tag"
  checks=$(backup_checks "$weekday" "$tag" "$verify")
  case $checks in
    verify) verify_snapshot "$snapshot" ;;
    check)
      restic_run -- check --read-data-subset=5% >/dev/null
      log "restic check of 5% of the data passed"
      ;;
  esac
  write_backup_last "$snapshot" "$tag" "$bytes" "$seconds" "$counts" "$VERIFY_SECONDS"
  send_ping "$PING_URL" success "snapshot ${snapshot:0:8} ($tag): dump $bytes bytes in ${seconds}s${VERIFY_SECONDS:+, verified, restored in ${VERIFY_SECONDS}s}"
  log "backup done"
}

# One line: bash has read it whole before main runs (update.sh checks out other commits).
main "$@"; exit $?
```

- [ ] **Step 4: Репозиторий и ключ восстановления в `install.sh`**

В `scripts/deploy/install.sh`:

1. После строки `. "$SCRIPT_DIR/lib/app.sh"` добавить:

```bash
# shellcheck source=lib/backup.sh
. "$SCRIPT_DIR/lib/backup.sh"
```

2. Перед `main()` добавить:

```bash
# setup_backups: with the restic keys in .env the repository is opened (created when it does not
# exist yet), the start of backups recorded for the health check and the recovery key shown once.
# Without the keys the panel runs without backups: a warning here, and the health check fails
# until the owner adds them.
setup_backups() {
  if ! backup_configured "$ENV_FILE"; then
    warn "backups are off: add RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY with configure.sh, then run install.sh again"
    return 0
  fi
  load_restic_env
  ensure_image "$RESTIC_IMAGE"
  ensure_backup_repo
  if [ ! -f "$STATE_DIR/backup-since" ]; then date +%s >"$STATE_DIR/backup-since"; fi
  show_recovery_key_once
}
```

3. В `main` между `admin_notice` и `if [ "$CFG_SYSTEM" = 1 ]; then install_timers; fi` вставить строку `setup_backups`.

- [ ] **Step 5: Общие помощники e2e и помощник шифрования**

`scripts/deploy/test/e2e-lib.sh`:

```bash
# shellcheck shell=bash
# Shared by the e2e scenarios that run inside the throwaway Docker-in-Docker container.

fail() {
  printf '[e2e] FAIL: %s\n' "$*" >&2
  exit 1
}

pass() { printf '[e2e] ok: %s\n' "$*"; }

# labelled <ps|volume|network> <compose project>
labelled() {
  case $1 in
    ps) docker ps -aq --filter "label=com.docker.compose.project=$2" ;;
    volume) docker volume ls -q --filter "label=com.docker.compose.project=$2" ;;
    network) docker network ls -q --filter "label=com.docker.compose.project=$2" ;;
  esac
}

# remove_project <compose project>: its containers, volumes and networks.
remove_project() {
  labelled ps "$1" | xargs -r docker rm -fv >/dev/null
  labelled volume "$1" | xargs -r docker volume rm >/dev/null
  labelled network "$1" | xargs -r docker network rm >/dev/null
}
```

В `scripts/deploy/test/e2e-install.sh`: удалить определения `fail`, `pass` и `labelled`; после строки `. "$DEPLOY_DIR/lib/edge.sh"` добавить

```bash
# shellcheck source=e2e-lib.sh
. "$TEST_DIR/e2e-lib.sh"
```

и в `teardown` три строки `labelled … | xargs …` заменить на `remove_project "$p"`.

`scripts/deploy/test/e2e-credential.mjs`:

```js
// Deploy e2e helper, run with `docker compose run` in the backend image of a test panel, so it
// has that panel's ENCRYPTION_KEY and database settings:
//   encrypt  prints encrypt($E2E_PLAIN)
//   check    prints "match" when the auth_pass of the mailbox $E2E_EMAIL decrypts to
//            $E2E_PLAIN, "mismatch" otherwise
import { decrypt, encrypt } from './src/services/encryption.js';

const mode = process.argv[2];
if (mode === 'encrypt') {
  console.log(encrypt(process.env.E2E_PLAIN));
  process.exit(0);
}
if (mode !== 'check') {
  console.log('usage: e2e-credential.mjs encrypt|check');
  process.exit(2);
}
const { pool } = await import('./src/services/db.js');
const { rows } = await pool.query('SELECT auth_pass FROM email_accounts WHERE email_address = $1', [process.env.E2E_EMAIL]);
console.error = () => {};
console.log(rows.length === 1 && decrypt(rows[0].auth_pass) === process.env.E2E_PLAIN ? 'match' : 'mismatch');
await pool.end();
process.exit(0);
```

- [ ] **Step 6: Сценарий `scripts/deploy/test/e2e-backup.sh` (этапы бэкапа)**

```bash
#!/usr/bin/env bash
# Backup, restore, update and rollback scenario of the deploy e2e test. Runs inside the throwaway
# Docker-in-Docker container started by e2e.sh and must never run on a host with real data.
# Server A is the compose project me-e2e-a in /e2e/a; server B, installed after A is wiped, is
# me-e2e-b in /e2e/b; MinIO in the project me-e2e-s3 stands in for the S3 provider. Everything it
# creates is removed at exit.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd "$TEST_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=../lib/env.sh
. "$DEPLOY_DIR/lib/env.sh"
# shellcheck source=../lib/config.sh
. "$DEPLOY_DIR/lib/config.sh"
# shellcheck source=../lib/app.sh
. "$DEPLOY_DIR/lib/app.sh"
# shellcheck source=../lib/backup.sh
. "$DEPLOY_DIR/lib/backup.sh"
# shellcheck source=e2e-lib.sh
. "$TEST_DIR/e2e-lib.sh"

A_PROJECT=me-e2e-a B_PROJECT=me-e2e-b S3_PROJECT=me-e2e-s3
A=/e2e/a B=/e2e/b ORIGIN=/e2e/origin.git WORK=/e2e/work STAGE=/e2e/stage
A_PORT=18081 B_PORT=18082 S3_PORT=19000
BUCKET=me-e2e-backups
VERSION='' IMAGE_PREFIX='' REPO_URL='' MINIO_IMAGE=''

while [ $# -gt 0 ]; do
  case $1 in
    --version) VERSION=$2 && shift 2 ;;
    --image-prefix) IMAGE_PREFIX=$2 && shift 2 ;;
    --repo-url) REPO_URL=$2 && shift 2 ;;
    --minio-image) MINIO_IMAGE=$2 && shift 2 ;;
    *) die "unknown option: $1" 2 ;;
  esac
done
if [ -z "$VERSION" ] || [ -z "$IMAGE_PREFIX" ] || [ -z "$REPO_URL" ] || [ -z "$MINIO_IMAGE" ]; then
  die "--version, --image-prefix, --repo-url and --minio-image are required" 2
fi

for p in "$A_PROJECT" "$B_PROJECT" "$S3_PROJECT"; do
  case $p in mailexpert | edge) fail "refusing to run as project $p" ;; esac
  [ -z "$(labelled ps "$p")$(labelled volume "$p")" ] || fail "project $p already has containers or volumes"
done
for d in "$A" "$B" "$ORIGIN" "$WORK" "$STAGE"; do
  [ ! -e "$d" ] || fail "$d already exists"
done

teardown() {
  local status=$? p
  docker ps -aq --filter label=mailexpert.verify | xargs -r docker rm -fv >/dev/null
  for p in "$A_PROJECT" "$B_PROJECT" "$S3_PROJECT"; do remove_project "$p"; done
  rm -rf "$A" "$B" "$ORIGIN" "$WORK" "$STAGE"
  exit "$status"
}
trap teardown EXIT

# deploy <script> <args...>: a deploy script of the commit under test.
deploy() {
  local script=$1
  shift
  bash "$DEPLOY_DIR/$script" "$@"
}

# on <prefix> <command...>: a command with that install loaded (paths, compose), in a subshell.
on() {
  local prefix=$1
  shift
  (
    load_install "$prefix"
    "$@"
  )
}

# expect_exit <code> <command...>: runs a command (a deploy script: its own process, so its own
# errexit), shows its output, keeps it in OUT and fails unless the exit code is <code>.
expect_exit() {
  local want=$1 code=0
  shift
  OUT=$("$@" 2>&1) || code=$?
  printf '%s\n' "$OUT"
  [ "$code" = "$want" ] || fail "${2:-$1} exited $code, expected $want"
}

# credential <prefix> encrypt|check: e2e-credential.mjs in the backend image of that panel.
credential() {
  on "$1" app_compose run --rm --no-deps -T -e E2E_PLAIN -e E2E_EMAIL \
    -v "$TEST_DIR/e2e-credential.mjs:/app/e2e-credential.mjs:ro" --entrypoint node backend \
    e2e-credential.mjs "$2" 2>/dev/null | tail -n 1
}

# snapshots_here [restic filter...]: the panel's snapshots as JSON (inside `on`).
snapshots_here() {
  load_restic_env
  restic_run -- snapshots --json --host "$RESTIC_HOST" "$@"
}

backup_keys() {
  printf 'RESTIC_REPOSITORY=s3:http://127.0.0.1:%s/%s\nRESTIC_PASSWORD=%s\nAWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' \
    "$S3_PORT" "$BUCKET" "$RESTIC_PW" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
}

export MINIO_ROOT_USER=e2e-s3-user MINIO_ROOT_PASSWORD E2E_EMAIL=box@example.test E2E_PLAIN
MINIO_ROOT_PASSWORD=$(gen_hex 16)
E2E_PLAIN=e2e-mailbox-password-$(gen_hex 4)
RESTIC_PW=$(gen_hex 24)

# 1. MinIO stands in for the S3 provider (restic creates the bucket); a bare origin repository
# lets the update stages add commits.
docker run -d --name me-e2e-s3 --label "com.docker.compose.project=$S3_PROJECT" -p "127.0.0.1:$S3_PORT:9000" \
  -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD "$MINIO_IMAGE" server /data >/dev/null
for _ in $(seq 60); do
  if curl -fs -o /dev/null "http://127.0.0.1:$S3_PORT/minio/health/live"; then break; fi
  sleep 1
done
curl -fs -o /dev/null "http://127.0.0.1:$S3_PORT/minio/health/live" || fail "MinIO did not start"
git clone --bare --quiet "$REPO_URL" "$ORIGIN"
HEAD_SHA=$(git -C "$ORIGIN" rev-parse HEAD)
[ "sha-${HEAD_SHA:0:12}" = "$VERSION" ] || fail "the bundle's HEAD is not $VERSION"
pass "MinIO and the origin repository"

# 2. Server A without restic keys: the panel runs, install.sh warns that backups are off.
expect_exit 0 deploy install.sh --prefix "$A" --version "$VERSION" --image-prefix "$IMAGE_PREFIX" \
  --repo-url "$ORIGIN" --project "$A_PROJECT" --http-port "$A_PORT" --no-system --no-edge --local-auth \
  --signin direct --direct-host a.example.test
[[ $OUT == *"backups are off"* ]] || fail "no warning about missing backups"
pass "server A runs without backups and says so"

# 3. The restic keys through configure.sh; the next install.sh creates the repository. Without a
# terminal the recovery key is not printed; --show-recovery-key prints it on request.
out=$(backup_keys | deploy configure.sh --prefix "$A" 2>&1)
[[ $out != *"$RESTIC_PW"* && $out != *"$MINIO_ROOT_PASSWORD"* ]] || fail "configure.sh printed a restic secret"
expect_exit 0 deploy install.sh --prefix "$A"
[[ $OUT == *"creating the restic repository"* ]] || fail "the repository was not created"
[[ $OUT == *"--show-recovery-key"* && $OUT != *"$RESTIC_PW"* ]] || fail "the recovery key without a terminal"
[ -f "$A/state/backup-since" ] || fail "state/backup-since is missing"
expect_exit 0 deploy backup.sh --prefix "$A" --show-recovery-key
[[ $OUT == *"RESTIC_PASSWORD=$RESTIC_PW"* ]] || fail "--show-recovery-key"
expect_exit 0 deploy install.sh --prefix "$A"
[[ $OUT == *"repository opens"* && $OUT != *"recovery key"* ]] || fail "a rerun: repository or recovery key"
pass "repository created; recovery key shown on request, then never again"

# 4. Test data: a user and a mailbox whose password is encrypted with A's ENCRYPTION_KEY.
cipher=$(credential "$A" encrypt)
[[ $cipher == enc:v1:* ]] || fail "encrypt: $cipher"
on "$A" app_psql >/dev/null <<SQL
WITH owner AS (INSERT INTO users (username, is_admin) VALUES ('e2e-owner', true) RETURNING id)
INSERT INTO email_accounts (user_id, name, email_address, auth_user, auth_pass, enabled)
SELECT id, 'E2E box', '$E2E_EMAIL', '$E2E_EMAIL', '$cipher', false FROM owner;
SQL
[ "$(credential "$A" check)" = match ] || fail "the stored credential does not decrypt on A"
pass "test data: a mailbox with an encrypted password"

# 5. A manual backup: one snapshot, backup-last.json, nothing left in staging.
expect_exit 0 deploy backup.sh --prefix "$A" --tag manual
last=$(<"$A/state/backup-last.json")
[ "$(jq -r .tag <<<"$last")" = manual ] || fail "backup-last.json tag: $last"
[ "$(jq -r .counts.email_accounts <<<"$last")" = 1 ] || fail "backup-last.json counts: $last"
[ "$(jq -r .verified <<<"$last")" = false ] || fail "backup-last.json verified: $last"
[ "$(on "$A" snapshots_here --tag manual | jq length)" = 1 ] || fail "one manual snapshot expected"
[ ! -e "$A/backups/staging" ] || fail "staging was left behind"
pass "manual backup"

# 6. --verify: restore into a scratch database, no pending migration, the credential decrypts
# with the key from the snapshot; nothing printed but counts, nothing left behind.
expect_exit 0 deploy backup.sh --prefix "$A" --tag manual --verify
[[ $OUT == *"counts match"* && $OUT == *'"migrationsApplied":0'* && $OUT == *'"failed":0'* ]] || fail "verify output"
[[ $OUT != *"$E2E_PLAIN"* ]] || fail "verify printed a credential"
[ "$(jq -r .verified "$A/state/backup-last.json")" = true ] || fail "backup-last.json verified"
[ -z "$(docker ps -aq --filter label=mailexpert.verify)" ] || fail "the scratch database was left behind"
[ -z "$(find "$A/backups" -maxdepth 1 -name 'verify-*')" ] || fail "verify files were left behind"
pass "backup --verify"

# 7. The check fails when the key in the snapshot does not decrypt the data.
cp -p "$A/.env" "$A/.env.keep"
wrong=$(gen_hex 32)
env_set "$A/.env" ENCRYPTION_KEY "$wrong"
expect_exit 1 deploy backup.sh --prefix "$A" --tag e2e-bad-key --verify
mv -f "$A/.env.keep" "$A/.env"
[[ $OUT == *"failed the check"* ]] || fail "a key that does not decrypt was not detected"
pass "verify detects a key that does not decrypt the data"

# 8. The nightly backup (default tag): a restic check, or on Sunday a verify. From here on it is
# the latest snapshot.
expect_exit 0 deploy backup.sh --prefix "$A"
[[ $OUT == *"restic check of 5% of the data passed"* || $OUT == *"counts match"* ]] || fail "nightly check"
[ "$(jq -r .tag "$A/state/backup-last.json")" = nightly ] || fail "nightly tag"
pass "nightly backup"

pass "backup e2e passed"
```

- [ ] **Step 7: `e2e.sh` и CI**

В `scripts/deploy/test/e2e.sh`:

1. После строки `. "$TEST_DIR/../lib/common.sh"` добавить:

```bash
# shellcheck source=../lib/backup.sh
. "$TEST_DIR/../lib/backup.sh"

# Stands in for the S3 provider inside the test; pinned like every other image.
MINIO_IMAGE=minio/minio:RELEASE.2025-04-22T22-12-26Z
```

2. `VERSION='' IMAGE_PREFIX=''` заменить на `VERSION='' IMAGE_PREFIX='' ONLY=''`, в разбор аргументов добавить

```bash
    --only) ONLY=$2 && shift 2 ;;
```

и после проверки `--image-prefix` —

```bash
case $ONLY in '' | install | backup) ;; *) die "--only must be install or backup" 2 ;; esac
```

3. В массив `IMAGES` дописать `"$RESTIC_IMAGE" "$MINIO_IMAGE"`.

4. Последний вызов `docker exec … e2e-install.sh …` заменить на:

```bash
if [ "$ONLY" != backup ]; then
  MSYS_NO_PATHCONV=1 docker exec "$NAME" bash /e2e/src/scripts/deploy/test/e2e-install.sh \
    --version "$VERSION" --image-prefix "$IMAGE_PREFIX" --repo-url /e2e/repo.bundle
fi
if [ "$ONLY" != install ]; then
  MSYS_NO_PATHCONV=1 docker exec "$NAME" bash /e2e/src/scripts/deploy/test/e2e-backup.sh \
    --version "$VERSION" --image-prefix "$IMAGE_PREFIX" --repo-url /e2e/repo.bundle --minio-image "$MINIO_IMAGE"
fi
```

5. В комментарий в начале файла после строки с примером вызова добавить строку `# --only install|backup runs one scenario (default: both).`

В `.github/workflows/ci.yml`, задание `deploy-e2e`: после `runs-on: ubuntu-latest` добавить `timeout-minutes: 45`; шаг `- name: Install e2e` переименовать в `- name: Deploy e2e`.

- [ ] **Step 8: Проверки и commit**

Run: `MSYS_NO_PATHCONV=1 docker run --rm restic/restic:0.18.0 version; docker pull --quiet minio/minio:RELEASE.2025-04-22T22-12-26Z`
Expected: `restic 0.18.0 …` и имя образа MinIO. Если какой-то тег недоступен — остановиться и доложить (не подбирать другой молча).

Run: `git add -A && git add --chmod=+x scripts/deploy/backup.sh scripts/deploy/test/e2e-backup.sh && SC; echo "exit $?"`
Expected: `exit 0`.

Run: `BATS; AL; echo "exit $?"`
Expected: PASS, `exit 0`.

```bash
git add scripts/deploy/lib/backup.sh scripts/deploy/lib/pg-dump.sh scripts/deploy/lib/counts.sql \
  scripts/deploy/lib/verify-restore.mjs scripts/deploy/install.sh scripts/deploy/test/e2e-lib.sh \
  scripts/deploy/test/e2e-install.sh scripts/deploy/test/e2e-credential.mjs scripts/deploy/test/e2e.sh \
  .github/workflows/ci.yml
git add --chmod=+x scripts/deploy/backup.sh scripts/deploy/test/e2e-backup.sh
git commit -m "feat(deploy): back up to restic with restore verification"
```

- [ ] **Step 9: e2e**

Run: `E2E` (пересобрать backend на новый HEAD).
Expected: восемь строк `[e2e] ok:` сценария бэкапа, `[e2e] ok: backup e2e passed`, `[e2e] ok: install e2e passed`, `deploy e2e passed`, `exit 0`, `host-unchanged`, список `me-e2e-` пуст.

---

### Task 4: `healthcheck.sh`

**Files:**
- Create: `scripts/deploy/lib/health.sh`
- Create: `scripts/deploy/healthcheck.sh` (режим `100755`)
- Create: `scripts/deploy/test/health.bats`
- Modify: `scripts/deploy/test/e2e-backup.sh` (этап 9)

**Interfaces:**
- Consumes: Task 1 (`load_install`, `app_compose`, `edge_compose`, `panel_ready`, `is_standby`, `lock_held`), Task 2-3 (`backup_configured`, `json_number`, `backup_age_problem`, `send_ping`), 7b (`edge_services`).
- Produces: `service_problems <service...>` (stdin — строки `<service> <state> <health>`), `disk_problem <path> <used%> [min free %]`, `cert_problem <host> <now> <expiry epoch|''> [min days]`; `healthcheck.sh [--prefix P]`, коды 0/1/2; переменная `MAILEXPERT_MIN_FREE_PCT` (по умолчанию 15).

Что проверяется (спецификация, «7. Мониторинг»): `/api/health/ready`; сервисы `frontend backend postgres redis` и сервисы края — `running` и не `unhealthy` (`starting` допустим: только что перезапущенный контейнер получает время; цикл падений виден как `restarting`); свободно ≥ 15% на `/` и в `DockerRootDir`; последний успешный бэкап моложе 26 ч (от `state/backup-since`, пока бэкапа ещё не было), без ключей restic — проблема «не настроен»; при Caddy с `--edge-tls acme` — сертификат `<DIRECT_HOST>` действует ещё ≥ 14 дней (срок из `curl -v`). Проверка памяти при почтовом узле на том же сервере — в PR 9 (узла пока нет). Standby и идущее обновление/откат/восстановление (занят `state/update.lock`) — пропуск с кодом 0 без пинга. Неожиданный сбой самого скрипта (например, недоступный демон Docker) завершает его с кодом 1 без пинга: пропуск пинга внешний сервис и замечает (dead man's switch).

- [ ] **Step 1: Написать падающие тесты**

`scripts/deploy/test/health.bats`:

```bash
#!/usr/bin/env bats
# Health decisions over what docker compose ps, df and curl report.

bats_require_minimum_version 1.5.0

setup() {
  load helper
}

@test "service_problems: missing, stopped, restarting and unhealthy services" {
  ps=$'frontend running healthy\nbackend restarting \npostgres running unhealthy\nredis exited '
  run service_problems frontend backend postgres redis edge-missing <<<"$ps"
  [ "$status" -eq 0 ]
  [ "$output" = $'containers: backend is restarting\ncontainers: postgres is unhealthy\ncontainers: redis is exited\ncontainers: edge-missing does not exist' ]
}

@test "service_problems: healthy, starting and services without a health check are fine" {
  ps=$'frontend running healthy\nbackend running starting\ncloudflared running '
  [ -z "$(service_problems frontend backend cloudflared <<<"$ps")" ]
}

@test "service_problems does not mistake a prefix for a service" {
  [ "$(service_problems redis <<<'redis-extra running healthy')" = "containers: redis does not exist" ]
}

@test "disk_problem" {
  [ -z "$(disk_problem / 85% 15)" ]
  [ "$(disk_problem / 86% 15)" = "disk: / is 86% full, less than 15% free" ]
  [ -z "$(disk_problem /var/lib/docker 99% 0)" ]
  [ "$(disk_problem / '' 15)" = "disk: cannot read the usage of /" ]
  [ -z "$(disk_problem / 50%)" ]
}

@test "cert_problem" {
  now=1800000000
  [ -z "$(cert_problem panel.example.com "$now" $((now + 30 * 86400)))" ]
  [ "$(cert_problem panel.example.com "$now" $((now + 10 * 86400)))" = "certificate: panel.example.com expires in 10 days" ]
  [ "$(cert_problem panel.example.com "$now" '')" = "certificate: cannot read the expiry date of panel.example.com" ]
}
```

Run: `BATS`
Expected: FAIL — `service_problems: command not found` и т.д.

- [ ] **Step 2: `scripts/deploy/lib/health.sh`**

```bash
# shellcheck shell=bash
# Health decisions of healthcheck.sh over what docker compose ps, df and curl report. Pure.

# service_problems <service...>: reads "<service> <state> <health>" lines (docker compose ps
# --format '{{.Service}} {{.State}} {{.Health}}') on stdin and prints a problem for each listed
# service that is missing, not running or unhealthy. "starting" is fine: a container that just
# restarted gets its grace time, and a crash loop shows as "restarting".
service_problems() {
  local lines service line state health
  lines=$(cat)
  for service in "$@"; do
    line=$(grep -m 1 "^$service " <<<"$lines" || true)
    if [ -z "$line" ]; then
      echo "containers: $service does not exist"
      continue
    fi
    read -r _ state health <<<"$line"
    if [ "$state" != running ]; then
      echo "containers: $service is $state"
    elif [ "${health:-}" = unhealthy ]; then
      echo "containers: $service is unhealthy"
    fi
  done
}

# disk_problem <path> <used, as df prints it: 42%> [minimum free percent, default 15]
disk_problem() {
  local path=$1 used=${2%\%} min=${3:-15}
  if ! [[ $used =~ ^[0-9]+$ ]]; then
    echo "disk: cannot read the usage of $path"
  elif [ $((100 - used)) -lt "$min" ]; then
    echo "disk: $path is ${used}% full, less than ${min}% free"
  fi
  return 0
}

# cert_problem <host> <now> <expiry epoch or ''> [minimum days, default 14]
cert_problem() {
  local host=$1 now=$2 expiry=$3 min=${4:-14} days
  if ! [[ $expiry =~ ^[0-9]+$ ]]; then
    echo "certificate: cannot read the expiry date of $host"
    return 0
  fi
  days=$(((expiry - now) / 86400))
  if [ "$days" -lt "$min" ]; then echo "certificate: $host expires in $days days"; fi
  return 0
}
```

Run: `BATS`
Expected: PASS.

- [ ] **Step 3: `scripts/deploy/healthcheck.sh`**

```bash
#!/usr/bin/env bash
# Checks the panel every 5 minutes (mailexpert-health.timer): readiness, containers, free disk,
# the age of the last backup and, with Caddy and a public certificate, its expiry. On success it
# pings HEALTHCHECK_PING_URL, otherwise <url>/fail with the list of problems. The monitoring
# service alerts the owner (in Telegram, through its own integration) on a failure and when the
# pings stop, so a server that is down, or cannot run this script, is noticed too.
#
# Exit codes: 0 healthy (or skipped: a standby server, an update, rollback or restore running),
# 1 problems found, 2 invalid input.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR=$SCRIPT_DIR/lib
# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib/config.sh
. "$LIB_DIR/config.sh"
# shellcheck source=lib/app.sh
. "$LIB_DIR/app.sh"
# shellcheck source=lib/backup.sh
. "$LIB_DIR/backup.sh"
# shellcheck source=lib/health.sh
. "$LIB_DIR/health.sh"
exit_on_unexpected_failure

# Free space below this share of a disk is a problem.
MIN_FREE_PCT=${MAILEXPERT_MIN_FREE_PCT:-15}

usage() {
  cat <<'EOF'
Usage: healthcheck.sh [--prefix /opt/mailexpert]

Checks readiness, containers, free disk (MAILEXPERT_MIN_FREE_PCT, default 15), the age of the
last backup and the certificate of <DIRECT_HOST>; pings HEALTHCHECK_PING_URL (or <url>/fail).
Exit codes: 0 healthy or skipped, 1 problems found, 2 invalid input.
EOF
}

# cert_expiry_epoch: the expiry of the certificate Caddy serves for <DIRECT_HOST>, from curl's
# TLS report.
cert_expiry_epoch() {
  local raw
  raw=$(curl -sv -o /dev/null -m 10 --resolve "$CFG_DIRECT_HOST:443:127.0.0.1" "https://$CFG_DIRECT_HOST/api/health" 2>&1 |
    sed -n 's/^\* *expire date: //p' | head -n 1)
  [ -n "$raw" ] || return 1
  date -d "$raw" +%s
}

# collect_problems: one line per problem.
collect_problems() {
  local now ps services root path used finished='' since='' expiry
  local -a paths=(/)
  now=$(date +%s)
  panel_ready || echo "ready: http://127.0.0.1:$CFG_HTTP_PORT/api/health/ready does not answer 200"
  if ps=$(app_compose ps --all --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null); then
    service_problems frontend backend postgres redis <<<"$ps"
  else
    echo "containers: docker compose ps failed for $CFG_PROJECT"
  fi
  services=$(edge_services)
  if [ -n "$services" ]; then
    if ps=$(edge_compose ps --all --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null); then
      # shellcheck disable=SC2086 # one service name per word
      service_problems $services <<<"$ps"
    else
      echo "containers: docker compose ps failed for $CFG_EDGE_PROJECT"
    fi
  fi
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || root=''
  if [ -n "$root" ]; then paths+=("$root"); fi
  for path in "${paths[@]}"; do
    used=$(df -P "$path" 2>/dev/null | awk 'NR == 2 {print $5}') || used=''
    disk_problem "$path" "$used" "$MIN_FREE_PCT"
  done
  if backup_configured "$ENV_FILE"; then
    if [ -f "$STATE_DIR/backup-last.json" ]; then
      finished=$(json_number finished_epoch <"$STATE_DIR/backup-last.json") || finished=''
    fi
    if [ -f "$STATE_DIR/backup-since" ]; then since=$(<"$STATE_DIR/backup-since"); fi
    backup_age_problem "$now" "$finished" "$since"
  else
    echo "backup: not configured (add the restic keys with configure.sh, then run install.sh)"
  fi
  if grep -qx caddy <<<"$services" && [ "$CFG_EDGE_TLS" = acme ]; then
    expiry=$(cert_expiry_epoch) || expiry=''
    cert_problem "$CFG_DIRECT_HOST" "$now" "$expiry"
  fi
}

main() {
  local prefix=/opt/mailexpert url problems line
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
  [[ $MIN_FREE_PCT =~ ^[0-9]+$ ]] || die "MAILEXPERT_MIN_FREE_PCT must be a number" 2
  [ "$(id -u)" = 0 ] || die "run healthcheck.sh as root"
  load_install "$prefix"
  if is_standby; then
    log "standby server: health check skipped"
    return 0
  fi
  if lock_held "$STATE_DIR/update.lock"; then
    log "an update, rollback or restore is running: health check skipped"
    return 0
  fi
  url=$(env_get "$ENV_FILE" HEALTHCHECK_PING_URL) || url=
  problems=$(collect_problems)
  if [ -z "$problems" ]; then
    send_ping "$url" success healthy
    log "healthy"
    return 0
  fi
  while IFS= read -r line; do
    printf '[mailexpert] problem: %s\n' "$line" >&2
  done <<<"$problems"
  send_ping "$url" fail "$problems"
  return 1
}

main "$@"; exit $?
```

- [ ] **Step 4: Этап e2e**

В `scripts/deploy/test/e2e-backup.sh` перед строкой `pass "backup e2e passed"` вставить:

```bash
# 9. Health of A: healthy after its backups; a stale backup and a stopped service are problems
# the output names. The disk threshold is 0 here: CI runners' disks are often more than 85%
# full; disk_problem itself is covered by bats.
export MAILEXPERT_MIN_FREE_PCT=0
expect_exit 0 deploy healthcheck.sh --prefix "$A"
[[ $OUT == *healthy* ]] || fail "health output"
cp -p "$A/state/backup-last.json" "$A/state/backup-last.keep"
stale=$(($(date +%s) - 27 * 3600))
jq -c --argjson t "$stale" '.finished_epoch = $t' "$A/state/backup-last.keep" >"$A/state/backup-last.json"
expect_exit 1 deploy healthcheck.sh --prefix "$A"
[[ $OUT == *"problem: backup: the last successful backup is 27 hours old"* ]] || fail "a stale backup was not reported"
mv -f "$A/state/backup-last.keep" "$A/state/backup-last.json"
on "$A" app_compose stop redis >/dev/null 2>&1
expect_exit 1 deploy healthcheck.sh --prefix "$A"
[[ $OUT == *"problem: containers: redis is exited"* && $OUT == *"problem: ready:"* ]] || fail "a stopped redis was not reported"
on "$A" app_compose start redis >/dev/null 2>&1
for _ in $(seq 60); do
  if on "$A" panel_ready; then break; fi
  sleep 2
done
expect_exit 0 deploy healthcheck.sh --prefix "$A"
pass "health check: healthy, stale backup, stopped service"
```

- [ ] **Step 5: Проверки и commit**

Run: `git add -A && git add --chmod=+x scripts/deploy/healthcheck.sh && SC && BATS; echo "exit $?"`
Expected: `exit 0`.

```bash
git add scripts/deploy/lib/health.sh scripts/deploy/test/health.bats scripts/deploy/test/e2e-backup.sh
git add --chmod=+x scripts/deploy/healthcheck.sh
git commit -m "feat(deploy): add the health check with monitoring pings"
```

- [ ] **Step 6: e2e**

Run: `E2E` с `--only backup` для отладки, финально — без него (пересобрать backend на новый HEAD).
Expected: новая строка `[e2e] ok: health check: healthy, stale backup, stopped service`, `backup e2e passed`, `install e2e passed`, `exit 0`, `host-unchanged`.

---

### Task 5: `restore.sh` — восстановление на чистом сервере и переезд

**Files:**
- Create: `scripts/deploy/lib/ops.sh` (часть восстановления; часть обновления — Task 6)
- Create: `scripts/deploy/restore.sh` (режим `100755`)
- Create: `scripts/deploy/test/ops.bats`
- Modify: `scripts/deploy/test/e2e-backup.sh` (этапы 10-14)

**Interfaces:**
- Consumes: Task 1 (`load_install`, `app_compose`, `app_psql`, `db_volume_exists`, `project_containers`, `set_standby`, `take_lock`), Task 2-3 (`backup_configured`, `load_restic_env`, `restic_run`, `json_number`, `RESTIC_HOST`, `lib/counts.sql`, `lib/verify-restore.mjs`), `env.sh` (`GENERATED_SECRET_KEYS`, `APP_OWNER_KEYS`, `EDGE_OWNER_KEYS`, `env_get`, `env_set`), `take_install_lock` (7b).
- Produces: `merge_restored_keys <dest env> <restored env> <overwrite|fill> <key...>` (печатает имена записанных ключей); `restore.sh latest|<snapshot id> [--prefix P] [--no-start]`, коды 0/1/2; `<prefix>/.env.pre-restore`.

Как решён переезд (спецификация, «5. Переезд», и требование 7b «`configure.sh` отвергает старый `ENCRYPTION_KEY` при переезде — решить в 7c»): новый сервер ставится `install.sh --no-start` той же версии, и установка генерирует свои `ENCRYPTION_KEY`, `DB_PASSWORD`, VAPID и `SESSION_SECRET`. `configure.sh` по-прежнему никогда их не заменяет (иначе опечатка владельца на живом сервере запирала бы данные) и в ошибке указывает на `restore.sh`. Заменяет их только `restore.sh`, значениями из снимка, и только когда у проекта нет ни тома базы, ни контейнеров: тогда сгенерированными ключами ещё ничего не зашифровано и ни одна база с `DB_PASSWORD` не инициализирована, а том базы создаётся уже с восстановленным паролем. Владелец передаёт через `configure.sh` на новом сервере только ключи restic (ключ восстановления и ключи S3), остальные секреты владельца — Access, вход Google, пинги, токены туннеля и DNS — подтягиваются из снимка, если на новом сервере их нет (заданные здесь остаются). `install.conf`, порт и имя compose-проекта остаются как установлены здесь: `.env` из снимка не копируется целиком. Версия снимка обязана совпадать с установленной (иначе — код 2 с командой `install.sh --version <версия снимка> --no-start`).

`--no-start` — для репетиции переезда (уточнение к шагу 2 «5. Переезд»): панель на новом сервере не запускается, потому что второй работающий экземпляр рядом с живым синхронизировал бы все ящики и запускал синхронизацию Access. Сервер остаётся standby (таймеры его пропускают); после репетиции — `docker compose -p <проект> down -v`, после настоящего восстановления — `install.sh --prefix <prefix>`.

- [ ] **Step 1: Написать падающие тесты**

`scripts/deploy/test/ops.bats`:

```bash
#!/usr/bin/env bats
# Decisions of restore.sh, update.sh and rollback.sh.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  D=$BATS_TEST_TMPDIR/dest.env
  S=$BATS_TEST_TMPDIR/restored.env
}

@test "merge_restored_keys overwrite: restored values replace local ones" {
  printf '%s\n' ENCRYPTION_KEY=local-key DB_PASSWORD=local-db APP_URL=https://b.example.com >"$D"
  printf '%s\n' ENCRYPTION_KEY=old-key DB_PASSWORD=old-db APP_URL=https://a.example.com >"$S"
  run merge_restored_keys "$D" "$S" overwrite ENCRYPTION_KEY DB_PASSWORD
  [ "$status" -eq 0 ]
  [ "$output" = $'ENCRYPTION_KEY\nDB_PASSWORD' ]
  [ "$(env_get "$D" ENCRYPTION_KEY)" = old-key ] && [ "$(env_get "$D" DB_PASSWORD)" = old-db ]
  [ "$(env_get "$D" APP_URL)" = https://b.example.com ]
  [ "$(stat -c %a "$D")" = 600 ]
}

@test "merge_restored_keys fill: only keys that are empty here" {
  printf '%s\n' AUTH_GOOGLE_CLIENT_ID=new-id AUTH_GOOGLE_CLIENT_SECRET= >"$D"
  printf '%s\n' AUTH_GOOGLE_CLIENT_ID=old-id AUTH_GOOGLE_CLIENT_SECRET=old-secret HEALTHCHECK_PING_URL=https://hc.example.com/x >"$S"
  run merge_restored_keys "$D" "$S" fill AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET HEALTHCHECK_PING_URL
  [ "$output" = $'AUTH_GOOGLE_CLIENT_SECRET\nHEALTHCHECK_PING_URL' ]
  [ "$(env_get "$D" AUTH_GOOGLE_CLIENT_ID)" = new-id ]
  [ "$(env_get "$D" AUTH_GOOGLE_CLIENT_SECRET)" = old-secret ]
}

@test "merge_restored_keys skips keys the snapshot does not have and equal values" {
  printf '%s\n' ENCRYPTION_KEY=same >"$D"
  printf '%s\n' ENCRYPTION_KEY=same VAPID_PUBLIC_KEY= >"$S"
  run merge_restored_keys "$D" "$S" overwrite ENCRYPTION_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run env_get "$D" VAPID_PUBLIC_KEY
  [ "$status" -eq 1 ]
}

@test "merge_restored_keys refuses an unknown mode" {
  run merge_restored_keys "$D" "$S" replace ENCRYPTION_KEY
  [ "$status" -eq 2 ]
}
```

Run: `BATS`
Expected: FAIL — `merge_restored_keys: command not found`.

- [ ] **Step 2: `scripts/deploy/lib/ops.sh`**

```bash
# shellcheck shell=bash
# Decisions and state of restore.sh, update.sh and rollback.sh. Needs common.sh and env.sh.

# merge_restored_keys <dest env> <restored env> <overwrite|fill> <key...>: copies keys from the
# .env of a snapshot. overwrite: the restored value replaces the local one; fill: only keys that
# are empty here are written. Keys empty or absent in the snapshot are skipped. Prints the name
# of each key written, never a value.
merge_restored_keys() {
  local dest=$1 src=$2 mode=$3 key value current
  shift 3
  case $mode in overwrite | fill) ;; *) die "merge_restored_keys: unknown mode $mode" 2 ;; esac
  for key in "$@"; do
    value=$(env_get "$src" "$key") || value=
    [ -n "$value" ] || continue
    current=$(env_get "$dest" "$key") || current=
    [ "$current" != "$value" ] || continue
    if [ "$mode" = fill ] && [ -n "$current" ]; then continue; fi
    env_set "$dest" "$key" "$value"
    printf '%s\n' "$key"
  done
}
```

В `scripts/deploy/test/e2e-backup.sh` после строки `. "$DEPLOY_DIR/lib/backup.sh"` добавить:

```bash
# shellcheck source=../lib/ops.sh
. "$DEPLOY_DIR/lib/ops.sh"
```

Run: `BATS`
Expected: PASS.

- [ ] **Step 3: `scripts/deploy/restore.sh`**

```bash
#!/usr/bin/env bash
# Restores the panel from a restic snapshot on a fresh server, after install.sh --no-start of the
# same version and configure.sh with the restic keys (the recovery key and the S3 keys):
#   - ENCRYPTION_KEY, DB_PASSWORD, SESSION_SECRET and the VAPID pair come from the snapshot in
#     place of the ones install.sh generated here. That is safe only while there is no database:
#     nothing here was encrypted or initialised with them yet, which is why restore.sh refuses
#     to run next to a database volume or containers of the project;
#   - owner secrets this server does not have (Access, Google sign-in, pings, tunnel and DNS
#     tokens) are filled in from the snapshot; the ones set here stay;
#   - install.conf, the port and the compose project stay as installed here;
#   - the database is restored and checked (row counts, no pending migration, every credential
#     decrypts), and Redis from a --with-redis snapshot;
#   - install.sh then starts the panel and checks it. --no-start stops before that: a rehearsal
#     must not run a second panel next to the live one (both would sync every mailbox).
#
#   restore.sh latest|<snapshot id> [--prefix /opt/mailexpert] [--no-start]
#
# Exit codes: 0 restored, 1 failure, 2 invalid input or not a fresh server (no data changed).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR=$SCRIPT_DIR/lib
# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib/config.sh
. "$LIB_DIR/config.sh"
# shellcheck source=lib/app.sh
. "$LIB_DIR/app.sh"
# shellcheck source=lib/backup.sh
. "$LIB_DIR/backup.sh"
# shellcheck source=lib/ops.sh
. "$LIB_DIR/ops.sh"
exit_on_unexpected_failure

WORK=''

usage() {
  cat <<'EOF'
Usage: restore.sh latest|<snapshot id> [--prefix /opt/mailexpert] [--no-start]

On a fresh server: install.sh --version <the snapshot's version> --no-start, configure.sh with
RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, then this.
--no-start   restore without starting the panel (rehearsal of a move); start it later with
             install.sh --prefix <prefix>
Exit codes: 0 restored, 1 failure, 2 invalid input or not a fresh server (no data changed).
EOF
}

cleanup() {
  local status=$?
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  exit "$status"
}

# names <lines>: the lines joined with spaces, "none" when there are none.
names() {
  if [ -z "$1" ]; then echo none; else paste -sd' ' - <<<"$1"; fi
}

# restore_secrets <dir>: generated keys from the snapshot replace this server's; owner secrets
# fill the gaps. Under install.sh's lock, like every other write to .env.
restore_secrets() {
  local files=$1 generated owner edge=''
  take_install_lock "$STATE_DIR" 600 restore.sh
  cp -p "$ENV_FILE" "$ENV_FILE.pre-restore"
  generated=$(merge_restored_keys "$ENV_FILE" "$files/env" overwrite "${GENERATED_SECRET_KEYS[@]}")
  owner=$(merge_restored_keys "$ENV_FILE" "$files/env" fill "${APP_OWNER_KEYS[@]}")
  if [ -f "$files/edge.env" ] && [ -f "$EDGE_ENV" ]; then
    edge=$(merge_restored_keys "$EDGE_ENV" "$files/edge.env" fill "${EDGE_OWNER_KEYS[@]}")
  fi
  exec 9>&-
  log "generated keys from the snapshot: $(names "$generated")"
  log "owner secrets from the snapshot: $(names "$owner"); edge: $(names "$edge")"
  log "the .env from before the restore is kept as $ENV_FILE.pre-restore"
}

# restore_database <dir>: a new database volume with the restored DB_PASSWORD, the dump, and the
# row counts compared with the ones taken at dump time.
restore_database() {
  local files=$1 expected restored
  app_compose up -d --wait --quiet-pull postgres >/dev/null
  # shellcheck disable=SC2016 # expanded by the shell inside the container
  app_compose exec -T postgres sh -c \
    'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error --single-transaction' <"$files/db.dump"
  expected=$(<"$files/counts.json")
  restored=$(app_psql <"$LIB_DIR/counts.sql")
  [ "$restored" = "$expected" ] || die "row counts differ after the restore (snapshot: $expected, restored: $restored)"
  log "database restored, rows: $restored"
}

# restore_redis <dir>: dump.rdb of a --with-redis snapshot into the Redis volume before Redis
# first starts (sessions and idempotency keys survive the move).
restore_redis() {
  [ -f "$1/redis.rdb" ] || return 0
  app_compose up --no-start redis >/dev/null
  app_compose cp "$1/redis.rdb" redis:/data/dump.rdb
  log "redis: dump.rdb restored"
}

# check_restored <counts json>: verify-restore.mjs in the backend image against the restored
# database, with the restored ENCRYPTION_KEY: no pending migration, every credential decrypts.
check_restored() {
  local mailboxes result
  mailboxes=$(json_number email_accounts <<<"$1") || mailboxes=0
  export VERIFY_EXPECT_MAILBOX=0
  if [ "$mailboxes" -gt 0 ]; then VERIFY_EXPECT_MAILBOX=1; fi
  result=$(app_compose run --rm --no-deps -T -e VERIFY_EXPECT_MAILBOX \
    -v "$LIB_DIR/verify-restore.mjs:/app/verify-restore.mjs:ro" --entrypoint node backend verify-restore.mjs 2>/dev/null) ||
    die "the restored data failed the check: $result"
  log "restored data: $result"
}

main() {
  local prefix=/opt/mailexpert snapshot='' no_start=0 started files version counts f
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      --no-start) no_start=1 && shift ;;
      -h | --help) usage && return 0 ;;
      -*) die "unknown option: $1 (see --help)" 2 ;;
      *)
        if [ -n "$snapshot" ]; then die "one snapshot only" 2; fi
        snapshot=$1
        shift
        ;;
    esac
  done
  [[ $snapshot =~ ^(latest|[0-9a-f]{8,64})$ ]] || die "usage: restore.sh latest|<snapshot id> [--prefix <prefix>] [--no-start]" 2
  [ "$(id -u)" = 0 ] || die "run restore.sh as root"
  load_install "$prefix"
  backup_configured "$ENV_FILE" ||
    die "the restic keys are missing in $ENV_FILE: add RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY with configure.sh first" 2
  take_lock "$STATE_DIR/update.lock" 60 "update.sh, rollback.sh or restore.sh"
  if db_volume_exists; then
    die "volume ${CFG_PROJECT}_postgres_data exists: restore.sh runs only on a server without a database. If it holds nothing you need (for example after a rehearsal), remove it with: docker compose -p $CFG_PROJECT down -v; then run restore.sh again" 2
  fi
  [ -z "$(project_containers)" ] ||
    die "compose project $CFG_PROJECT has containers: restore.sh runs only where the panel never started; if they hold nothing you need: docker compose -p $CFG_PROJECT down -v" 2

  set_standby
  trap cleanup EXIT
  WORK=$STATE_DIR/restore
  rm -rf "$WORK"
  mkdir -m 700 "$WORK"
  load_restic_env
  ensure_image "$RESTIC_IMAGE"
  started=$SECONDS
  restic_run -v "$WORK:/restore" -- restore "$snapshot" --host "$RESTIC_HOST" --target /restore >/dev/null
  files=$WORK/backup
  for f in db.dump counts.json env install.conf; do
    [ -f "$files/$f" ] || die "snapshot $snapshot has no $f"
  done
  version=$(env_get "$files/install.conf" VERSION) || version=
  [ "$version" = "$CFG_VERSION" ] ||
    die "the snapshot was made by $version, this server has $CFG_VERSION: run install.sh --prefix $OPT_PREFIX --version $version --no-start, then restore.sh again" 2

  restore_secrets "$files"
  restore_database "$files"
  restore_redis "$files"
  counts=$(<"$files/counts.json")
  check_restored "$counts"
  rm -rf "$WORK"
  WORK=''
  log "snapshot $snapshot restored in $((SECONDS - started))s"
  if [ "$no_start" = 1 ]; then
    log "standby: the panel is not started (--no-start). To go live: $APP_DIR/scripts/deploy/install.sh --prefix $OPT_PREFIX"
    return 0
  fi
  bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX"
  log "restore done in $((SECONDS - started))s"
}

main "$@"; exit $?
```

- [ ] **Step 4: Этапы e2e**

В `scripts/deploy/test/e2e-backup.sh` перед строкой `pass "backup e2e passed"` вставить:

```bash
# 10. Server A is lost: containers, volumes and files. The owner kept the recovery key and the
# S3 keys (the variables above); A's generated keys are noted only to compare after the move.
a_key=$(env_get "$A/.env" ENCRYPTION_KEY)
a_db=$(env_get "$A/.env" DB_PASSWORD)
a_vapid=$(env_get "$A/.env" VAPID_PUBLIC_KEY)
remove_project "$A_PROJECT"
rm -rf "$A"
pass "server A wiped"

# 11. Server B, prepared for the move: the same version, --no-start. Standby: the timers' scripts
# skip it. Its generated keys differ from A's; configure.sh refuses A's ENCRYPTION_KEY and names
# restore.sh.
expect_exit 0 deploy install.sh --prefix "$B" --version "$VERSION" --image-prefix "$IMAGE_PREFIX" \
  --repo-url "$ORIGIN" --project "$B_PROJECT" --http-port "$B_PORT" --no-system --no-edge --local-auth \
  --signin direct --direct-host b.example.test --no-start
[ -f "$B/state/standby" ] || fail "install.sh --no-start did not mark B as standby"
[ -z "$(labelled ps "$B_PROJECT")" ] || fail "install.sh --no-start started containers"
[ "$(env_get "$B/.env" ENCRYPTION_KEY)" != "$a_key" ] || fail "B has A's key before the restore"
expect_exit 0 deploy healthcheck.sh --prefix "$B"
[[ $OUT == *"standby server"* ]] || fail "the health check did not skip a standby server"
expect_exit 0 deploy backup.sh --prefix "$B"
[[ $OUT == *"backup skipped"* ]] || fail "the backup did not skip a standby server"
out=$(backup_keys | deploy configure.sh --prefix "$B" 2>&1)
[[ $out != *"$RESTIC_PW"* ]] || fail "configure.sh printed RESTIC_PASSWORD"
set +e
out=$(printf 'ENCRYPTION_KEY=%s\n' "$a_key" | deploy configure.sh --prefix "$B" 2>&1)
code=$?
set -e
if [ "$code" != 2 ] || [[ $out != *restore.sh* ]]; then fail "configure.sh with A's ENCRYPTION_KEY: exit $code"; fi
pass "server B prepared: standby, its own keys, configure.sh points to restore.sh"

# 12. The rehearsal: restore the latest snapshot without starting. A's generated keys replace
# B's; B keeps its project and port; the database and the credential check pass.
expect_exit 0 deploy restore.sh latest --prefix "$B" --no-start
[ "$(env_get "$B/.env" ENCRYPTION_KEY)" = "$a_key" ] || fail "ENCRYPTION_KEY was not restored"
[ "$(env_get "$B/.env" DB_PASSWORD)" = "$a_db" ] || fail "DB_PASSWORD was not restored"
[ "$(env_get "$B/.env" VAPID_PUBLIC_KEY)" = "$a_vapid" ] || fail "the VAPID keys were not restored"
[ "$(env_get "$B/.env" COMPOSE_PROJECT_NAME)" = "$B_PROJECT" ] || fail "COMPOSE_PROJECT_NAME changed"
[ "$(env_get "$B/.env" APP_HTTP_PORT)" = "$B_PORT" ] || fail "APP_HTTP_PORT changed"
[ "$(stat -c %a "$B/.env.pre-restore")" = 600 ] || fail ".env.pre-restore"
[[ $OUT == *'"failed":0'* && $OUT != *"$E2E_PLAIN"* && $OUT != *"$a_key"* ]] || fail "restore output"
[ -f "$B/state/standby" ] || fail "B left standby before it started"
[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$B_PROJECT" --filter label=com.docker.compose.service=backend)" ] ||
  fail "the backend runs after --no-start"
[ ! -e "$B/state/restore" ] || fail "restored files were left behind"
pass "restore --no-start (rehearsal)"

# 13. Going live: install.sh starts B; the mailbox password decrypts with the restored key.
expect_exit 0 deploy install.sh --prefix "$B"
[ ! -f "$B/state/standby" ] || fail "B is still standby"
[ "$(curl -fsS "http://127.0.0.1:$B_PORT/api/health/ready" | jq -r .status)" = ready ] || fail "B is not ready"
[ "$(credential "$B" check)" = match ] || fail "the credential does not decrypt on B"
[ "$(on "$B" app_psql <<<"SELECT count(*) FROM users WHERE username = 'e2e-owner';")" = 1 ] || fail "the user did not move"
pass "B runs with A's data and keys"

# 14. B backs up into the same repository and its verify passes; a second restore is refused and
# changes nothing.
expect_exit 0 deploy backup.sh --prefix "$B" --tag manual --verify
expect_exit 2 deploy restore.sh latest --prefix "$B"
[[ $OUT == *"_postgres_data exists"* ]] || fail "restore.sh did not refuse a server with a database"
[ "$(credential "$B" check)" = match ] || fail "the refused restore changed B"
pass "B backs up; restore.sh refuses a server with a database"
```

- [ ] **Step 5: Проверки и commit**

Run: `git add -A && git add --chmod=+x scripts/deploy/restore.sh && SC && BATS; echo "exit $?"`
Expected: `exit 0`.

```bash
git add scripts/deploy/lib/ops.sh scripts/deploy/test/ops.bats scripts/deploy/test/e2e-backup.sh
git add --chmod=+x scripts/deploy/restore.sh
git commit -m "feat(deploy): restore a backup on a fresh server, keys included"
```

- [ ] **Step 6: e2e**

Run: `E2E` (`--only backup` при отладке, финально без него; backend пересобрать на новый HEAD).
Expected: строки `server A wiped`, `server B prepared…`, `restore --no-start (rehearsal)`, `B runs with A's data and keys`, `B backs up; restore.sh refuses…`, `backup e2e passed`, `install e2e passed`, `exit 0`, `host-unchanged`.

---

### Task 6: `update.sh` и `rollback.sh`

**Files:**
- Modify: `scripts/deploy/lib/ops.sh` (+ функции обновления)
- Create: `scripts/deploy/update.sh`, `scripts/deploy/rollback.sh` (режим `100755`)
- Modify: `scripts/deploy/test/ops.bats`
- Modify: `scripts/deploy/test/e2e-backup.sh` (этапы 15-19)

**Interfaces:**
- Consumes: Task 1 (`load_install`, `app_compose`, `app_psql`, `migration_count`, `panel_ready`, `ensure_image`, `is_standby`, `take_lock`, `READY_TIMEOUT`/`MAILEXPERT_READY_TIMEOUT` и ограниченный `up` в `install.sh`), Task 3 (`backup.sh --tag pre-update --keep-dump`, `send_ping`, `json_number`).
- Produces:
  - `update_outcome <install exit> <migrations before> <after>` → `done|auto-rollback|manual-rollback`; `space_problem <free kB> <dump bytes>` → строка или ничего; `stale_local_dumps <keep>` (stdin — пути от новых к старым); `write_update_state <from> <to> <migrations before> <dump> <status>`; `set_update_status <status>`; `update_status` (пусто, если файла нет).
  - `state/update.json`: `{"from":"sha-…","to":"sha-…","migrations_before":N,"dump":"/…/pre-update-sha-….dump","status":"running|done|rolled-back|needs-rollback","started_epoch":N}`.
  - `update.sh sha-<12> [--prefix P]`, коды 0/1/2/4/5; `rollback.sh [--prefix P]`, коды 0/1/2.

Решения задачи:
- `update.sh` не повторяет установку: переключение делает `install.sh --prefix P --version <new>` (checkout, `MAILEXPERT_VERSION`, образы, `up`, ожидание готовности и сверка `/api/version`, `exec` установщика нового коммита). Срок готовности — `MAILEXPERT_READY_TIMEOUT`, по умолчанию 600 с (долгие миграции-бэкфиллы, спецификация, «3. Обновление», шаг 6); `up` ограничен тем же сроком (Task 1), так что backend в цикле падений не подвешивает обновление.
- Итог по числу строк `schema_migrations` до и после: не изменилось — автоматический возврат `install.sh --version <old>` (схема та же, старый код ей подходит), код 4; изменилось или неизвестно — backend и frontend останавливаются, код 5, команда `rollback.sh` в выводе. Пока статус `needs-rollback`, новый `update.sh` отказывается (код 2).
- Бэкап перед обновлением — `backup.sh --tag pre-update --keep-dump backups/pre-update-<old>.dump` (последние 3 файла хранятся на месте); без ключей restic — только локальный дамп с предупреждением. Проверка места: свободно не меньше двух размеров последнего дампа (`backup-last.json`, иначе `pg_database_size`) — локальный дамп и копия базы, которую восстанавливает откат.
- `rollback.sh` восстанавливает дамп в **новую** базу `<db>_rollback` и подменяет ею текущую переименованием в одной транзакции; заменённая база остаётся как `<db>_before_rollback_<время>`, пока владелец её не удалит (команда в выводе). Это отступление от `pg_restore --clean --if-exists --single-transaction` из спецификации: `--clean` удаляет только объекты из дампа, и таблицы, созданные новыми миграциями, пережили бы откат, а повторное обновление на ту же версию упало бы на их `CREATE TABLE`. Заодно сохраняются данные, записанные после обновления, — их можно достать вручную. Затем `install.sh --version <from>`.
- Предупреждение backend `Index idx_messages_provider_thread is …` в логах после обновления выводится как предупреждение (спецификация, «3. Обновление», шаг 6).
- Если e2e покажет, что `ALTER DATABASE … RENAME` не выполняется внутри транзакции в PostgreSQL 16, — остановиться и доложить.

- [ ] **Step 1: Написать падающие тесты**

В конец `scripts/deploy/test/ops.bats` добавить:

```bash
@test "update_outcome" {
  [ "$(update_outcome 0 66 67)" = done ]
  [ "$(update_outcome 1 66 66)" = auto-rollback ]
  [ "$(update_outcome 124 66 66)" = auto-rollback ]
  [ "$(update_outcome 1 66 67)" = manual-rollback ]
  [ "$(update_outcome 1 66 unknown)" = manual-rollback ]
  [ "$(update_outcome 3 '' '')" = manual-rollback ]
}

@test "space_problem: twice the last dump must be free" {
  [ -z "$(space_problem $((2 * 1024 * 1024)) $((1024 * 1024 * 1024)))" ]
  [ "$(space_problem $((1024 * 1024)) $((1024 * 1024 * 1024)))" = "free space: 1024 MB, the update needs 2048 MB (twice the last dump)" ]
}

@test "stale_local_dumps keeps the newest ones" {
  [ "$(printf '%s\n' d5 d4 d3 d2 d1 | stale_local_dumps 3)" = $'d2\nd1' ]
  [ -z "$(printf '%s\n' d2 d1 | stale_local_dumps 3)" ]
}
```

`write_update_state`, `set_update_status` и `update_status` пишут и читают JSON через `jq`, которого в образе bats (Alpine) может не быть; их проверяет e2e: статус `update.json` сверяется на каждом этапе обновления и отката (этапы 16-19). Тест с `skip` на случай отсутствия `jq` не добавлять.

Run: `BATS`
Expected: FAIL — `update_outcome: command not found` и т.д.

- [ ] **Step 2: Функции обновления в `lib/ops.sh`**

В конец `scripts/deploy/lib/ops.sh` добавить:

```bash
# update_outcome <install.sh exit> <migrations before> <migrations after>: done; auto-rollback
# (not ready and the schema is exactly as before, so the previous version fits it); or
# manual-rollback (anything else, an unknown count included).
update_outcome() {
  if [ "$1" = 0 ]; then
    echo done
  elif [[ $2 =~ ^[0-9]+$ && $3 =~ ^[0-9]+$ ]] && [ "$2" = "$3" ]; then
    echo auto-rollback
  else
    echo manual-rollback
  fi
}

# space_problem <free kB> <last dump bytes>: an update needs twice the dump free: the local
# pre-update dump, and the database copy a rollback restores next to the current one.
space_problem() {
  local free=$(($1 * 1024)) need=$(($2 * 2))
  if [ "$free" -lt "$need" ]; then
    echo "free space: $(($1 / 1024)) MB, the update needs $((need / 1048576)) MB (twice the last dump)"
  fi
  return 0
}

# stale_local_dumps <keep>: reads dump paths, newest first, and prints the ones beyond <keep>.
stale_local_dumps() {
  tail -n +"$(($1 + 1))"
}

# write_update_state <from> <to> <migrations before> <dump> <status>: state/update.json.
write_update_state() {
  local file=$STATE_DIR/update.json tmp now
  now=$(date +%s)
  tmp=$(mktemp "$file.XXXXXX")
  jq -cn --arg from "$1" --arg to "$2" --argjson before "$3" --arg dump "$4" --arg status "$5" --argjson now "$now" \
    '{from: $from, to: $to, migrations_before: $before, dump: $dump, status: $status, started_epoch: $now}' >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# set_update_status <status>: running, done, rolled-back or needs-rollback.
set_update_status() {
  local file=$STATE_DIR/update.json tmp
  tmp=$(mktemp "$file.XXXXXX")
  jq -c --arg status "$1" '.status = $status' "$file" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# update_status: the status of the last update, empty when there was none.
update_status() {
  [ -f "$STATE_DIR/update.json" ] || return 0
  jq -r '.status // ""' "$STATE_DIR/update.json"
}
```

Run: `BATS`
Expected: PASS.

- [ ] **Step 3: `scripts/deploy/update.sh`**

```bash
#!/usr/bin/env bash
# Updates the panel to another commit (image tag sha-<12>):
#   1. checks: no rollback pending, the panel ready, the commit exists, the images pulled before
#      anything stops, free space for twice the last dump;
#   2. a pre-update backup: backups/pre-update-<old>.dump (the last 3 are kept) and, with the
#      restic keys, a snapshot tagged pre-update;
#   3. install.sh --version <new>: checkout, MAILEXPERT_VERSION, up, migrations at start, the
#      readiness and version checks (MAILEXPERT_READY_TIMEOUT, 600 s by default here);
#   4. ready: done. Not ready and no migration applied: install.sh --version <old> by itself
#      (exit 4). Not ready after migrations were applied: backend and frontend stop and the
#      rollback is left to a person (exit 5): rollback.sh restores the pre-update dump and loses
#      what was written since, which only a person may decide.
#
#   update.sh sha-<commit> [--prefix /opt/mailexpert]
#
# Exit codes: 0 updated (or already at that version), 1 failure, 2 invalid input or a state that
# forbids an update (nothing changed), 4 not updated: the previous version runs again,
# 5 stopped after migrations: run rollback.sh.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR=$SCRIPT_DIR/lib
# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib/config.sh
. "$LIB_DIR/config.sh"
# shellcheck source=lib/app.sh
. "$LIB_DIR/app.sh"
# shellcheck source=lib/backup.sh
. "$LIB_DIR/backup.sh"
# shellcheck source=lib/ops.sh
. "$LIB_DIR/ops.sh"
exit_on_unexpected_failure

READY_TIMEOUT=${MAILEXPERT_READY_TIMEOUT:-600}

usage() {
  cat <<'EOF'
Usage: update.sh sha-<first 12 characters of the commit> [--prefix /opt/mailexpert]

Backs up, switches to the new version with install.sh and checks it. A version that does not
become ready is replaced by the previous one automatically when it applied no migrations
(exit 4); otherwise the panel is stopped and rollback.sh is left to you (exit 5).
MAILEXPERT_READY_TIMEOUT: seconds to wait for readiness (default 600).
Exit codes: 0 updated, 1 failure, 2 invalid input or state (nothing changed), 4 not updated,
the previous version runs again, 5 stopped after migrations: run rollback.sh.
EOF
}

# estimate_dump_bytes: the size of the last dump, or of the database when there is none yet.
estimate_dump_bytes() {
  if [ -f "$STATE_DIR/backup-last.json" ] && json_number dump_bytes <"$STATE_DIR/backup-last.json"; then
    return 0
  fi
  printf 'SELECT pg_database_size(current_database());\n' | app_psql
}

# prune_local_dumps: keeps the 3 newest pre-update dumps.
prune_local_dumps() {
  local list f
  # shellcheck disable=SC2012 # our own names: pre-update-sha-<hex>.dump
  list=$(ls -1t "$BACKUP_DIR"/pre-update-*.dump 2>/dev/null || true)
  [ -n "$list" ] || return 0
  while IFS= read -r f; do rm -f -- "$f"; done < <(stale_local_dumps 3 <<<"$list")
}

# check_index_warning <since>: the backend's warning about an invalid index that a migration
# without a transaction can leave behind.
check_index_warning() {
  local line
  line=$(app_compose logs --no-log-prefix --since "$1" backend 2>&1 | grep -m 1 'Index idx_messages_provider_thread is' || true)
  if [ -n "$line" ]; then warn "$line"; fi
}

# run_install <version>: install.sh of the current checkout switches to <version> (and continues
# with that commit's installer).
run_install() {
  MAILEXPERT_READY_TIMEOUT=$READY_TIMEOUT bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX" --version "$1"
}

main() {
  local prefix=/opt/mailexpert target='' old before after status=0 outcome dump free_kb bytes problem since url
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      sha-*)
        if [ -n "$target" ]; then die "one version only" 2; fi
        target=$1
        shift
        ;;
      *) die "unknown argument: $1 (see --help)" 2 ;;
    esac
  done
  [[ $target =~ ^sha-[0-9a-f]{12}$ ]] || die "usage: update.sh sha-<first 12 characters of the commit> [--prefix <prefix>]" 2
  [[ $READY_TIMEOUT =~ ^[0-9]+$ ]] || die "MAILEXPERT_READY_TIMEOUT must be a number of seconds" 2
  [ "$(id -u)" = 0 ] || die "run update.sh as root"
  load_install "$prefix"
  old=$CFG_VERSION
  if [ "$target" = "$old" ]; then
    log "already at $target"
    return 0
  fi
  if is_standby; then die "standby server: the panel does not run here; install.sh --version sets its version" 2; fi
  take_lock "$STATE_DIR/update.lock" 10 "another update.sh, rollback.sh or restore.sh"
  if [ "$(update_status)" = needs-rollback ]; then
    die "the last update stopped after migrations: run $APP_DIR/scripts/deploy/rollback.sh --prefix $OPT_PREFIX first" 2
  fi
  panel_ready || die "the panel is not ready now; fix that before updating" 2
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" rev-parse --verify --quiet "${target#sha-}^{commit}" >/dev/null ||
    die "commit ${target#sha-} is not in $CFG_REPO_URL" 2
  ensure_image "$CFG_IMAGE_PREFIX/mailexpert-backend:$target"
  ensure_image "$CFG_IMAGE_PREFIX/mailexpert-frontend:$target"
  free_kb=$(df -Pk "$OPT_PREFIX" | awk 'NR == 2 {print $4}')
  bytes=$(estimate_dump_bytes)
  problem=$(space_problem "$free_kb" "$bytes")
  [ -z "$problem" ] || die "$problem" 2

  before=$(migration_count)
  dump=$BACKUP_DIR/pre-update-$old.dump
  log "backup before the update"
  bash "$SCRIPT_DIR/backup.sh" --prefix "$OPT_PREFIX" --tag pre-update --keep-dump "$dump" ||
    die "the backup before the update failed; nothing was changed"
  prune_local_dumps
  write_update_state "$old" "$target" "$before" "$dump" running
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  url=$(env_get "$ENV_FILE" HEALTHCHECK_PING_URL) || url=
  log "updating $old -> $target"
  run_install "$target" || status=$?
  after=$(migration_count) || after=unknown
  outcome=$(update_outcome "$status" "$before" "$after")
  case $outcome in
    done)
      check_index_warning "$since"
      set_update_status done
      send_ping "$url" success "updated to $target"
      log "updated to $target. Back to $old with the database from before the update: $APP_DIR/scripts/deploy/rollback.sh --prefix $OPT_PREFIX"
      return 0
      ;;
    auto-rollback)
      warn "$target did not become ready and applied no migrations: returning to $old"
      if run_install "$old"; then
        set_update_status rolled-back
        send_ping "$url" fail "the update to $target failed; $old runs again"
        log "not updated: $old runs again; the reason is in the backend log of $target above"
        return 4
      fi
      set_update_status needs-rollback
      send_ping "$url" fail "the update to $target failed and $old did not start again"
      die "$old did not start again either: run $APP_DIR/scripts/deploy/rollback.sh --prefix $OPT_PREFIX"
      ;;
    manual-rollback)
      app_compose stop backend frontend >/dev/null 2>&1 || true
      set_update_status needs-rollback
      send_ping "$url" fail "the update to $target applied migrations and did not become ready; the panel is stopped"
      warn "$target applied migrations (schema_migrations: $before -> $after) and did not become ready; backend and frontend are stopped"
      log "back to $old with the database from before the update (what was written since is lost): $APP_DIR/scripts/deploy/rollback.sh --prefix $OPT_PREFIX"
      return 5
      ;;
  esac
}

# One line: install.sh checks out another commit, which rewrites this file while it runs.
main "$@"; exit $?
```

- [ ] **Step 4: `scripts/deploy/rollback.sh`**

```bash
#!/usr/bin/env bash
# Returns the panel to the version before the last update.sh, with the database from before that
# update: backend and frontend stop, the pre-update dump is restored into a new database that
# replaces the current one by renaming (the replaced one is kept until the owner drops it), and
# install.sh --version <previous> starts the previous version. What was written after the update
# is lost; mail itself stays on the mail servers and syncs again.
#
#   rollback.sh [--prefix /opt/mailexpert]
#
# Exit codes: 0 rolled back, 1 failure, 2 invalid input or nothing to roll back.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR=$SCRIPT_DIR/lib
# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=lib/env.sh
. "$LIB_DIR/env.sh"
# shellcheck source=lib/config.sh
. "$LIB_DIR/config.sh"
# shellcheck source=lib/app.sh
. "$LIB_DIR/app.sh"
# shellcheck source=lib/ops.sh
. "$LIB_DIR/ops.sh"
exit_on_unexpected_failure

READY_TIMEOUT=${MAILEXPERT_READY_TIMEOUT:-600}

usage() {
  cat <<'EOF'
Usage: rollback.sh [--prefix /opt/mailexpert]

Returns to the version before the last update.sh with the database from before that update
(state/update.json names both). What was written after the update is lost.
Exit codes: 0 rolled back, 1 failure, 2 invalid input or nothing to roll back.
EOF
}

# replace_database <dump>: the dump restored into <db>_rollback, which then takes the place of
# <db> by renaming; <db> stays as <db>_before_rollback_<time>. Unlike pg_restore --clean, nothing
# the newer version's migrations created survives in the restored database.
replace_database() {
  local dump=$1 db kept
  db=$(env_get "$ENV_FILE" DB_NAME) || db=mailexpert
  [[ $db =~ ^[a-z_][a-z0-9_]{0,30}$ ]] || die "DB_NAME '$db' is not a plain lowercase name"
  kept=${db}_before_rollback_$(date +%Y%m%d%H%M%S)
  printf 'DROP DATABASE IF EXISTS %s_rollback;\nCREATE DATABASE %s_rollback;\n' "$db" "$db" | app_psql postgres >/dev/null
  # shellcheck disable=SC2016 # expanded by the shell inside the container
  if ! app_compose exec -T postgres sh -c \
    'exec pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --exit-on-error --single-transaction' sh "${db}_rollback" <"$dump"; then
    printf 'DROP DATABASE IF EXISTS %s_rollback;\n' "$db" | app_psql postgres >/dev/null
    die "the dump did not restore; the database is unchanged"
  fi
  app_psql postgres >/dev/null <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();
BEGIN;
ALTER DATABASE $db RENAME TO $kept;
ALTER DATABASE ${db}_rollback RENAME TO $db;
COMMIT;
SQL
  log "the database from before the rollback is kept as $kept; once it is not needed: docker compose -p $CFG_PROJECT exec postgres sh -c 'dropdb -U \"\$POSTGRES_USER\" $kept'"
}

main() {
  local prefix=/opt/mailexpert state from dump
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
  [[ $READY_TIMEOUT =~ ^[0-9]+$ ]] || die "MAILEXPERT_READY_TIMEOUT must be a number of seconds" 2
  [ "$(id -u)" = 0 ] || die "run rollback.sh as root"
  load_install "$prefix"
  take_lock "$STATE_DIR/update.lock" 10 "update.sh, rollback.sh or restore.sh"
  state=$STATE_DIR/update.json
  [ -f "$state" ] || die "nothing to roll back: $state is missing (update.sh writes it)" 2
  [ "$(update_status)" != rolled-back ] || die "the last update was rolled back already" 2
  from=$(jq -r .from "$state")
  dump=$(jq -r .dump "$state")
  [[ $from =~ ^sha-[0-9a-f]{12}$ ]] || die "$state names no valid previous version" 2
  [ -f "$dump" ] || die "the pre-update dump $dump is missing; the way back is restore.sh with the pre-update snapshot on a fresh server" 2

  log "rolling back to $from with $dump; what was written since the update is lost"
  app_compose stop backend frontend >/dev/null 2>&1 || true
  app_compose up -d --wait postgres >/dev/null
  replace_database "$dump"
  MAILEXPERT_READY_TIMEOUT=$READY_TIMEOUT bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX" --version "$from"
  set_update_status rolled-back
  log "rolled back to $from"
}

# One line: install.sh checks out another commit, which rewrites this file while it runs.
main "$@"; exit $?
```

- [ ] **Step 5: Этапы e2e**

В `scripts/deploy/test/e2e-backup.sh` перед строкой `pass "backup e2e passed"` вставить:

```bash
# 15. Versions to update to: commits on top of HEAD in the origin repository, and images for them
# (HEAD's backend image plus the migrations and its own BUILD_SHA; HEAD's frontend retagged).
# ok: one new migration that works; mig: one that works and one that fails; fail: only one that
# fails (inside its transaction, so nothing is recorded).
mkdir -p "$STAGE"
printf 'CREATE TABLE e2e_update_marker (id integer);\n' >"$STAGE/9998_e2e_update_marker.sql"
printf 'SELECT 1 / 0;\n' >"$STAGE/9999_e2e_update_fails.sql"
git clone --quiet "$ORIGIN" "$WORK"

# derive_version <name> <migration file...>: prints the sha-<12> tag of the new version.
derive_version() {
  local name=$1 sha tag cid f
  shift
  git -C "$WORK" checkout --quiet --detach "$HEAD_SHA"
  for f in "$@"; do
    cp "$f" "$WORK/backend/migrations/"
    git -C "$WORK" add "backend/migrations/${f##*/}"
  done
  git -C "$WORK" -c user.name=e2e -c user.email=e2e@example.test commit --quiet --allow-empty -m "e2e: $name"
  sha=$(git -C "$WORK" rev-parse HEAD)
  git -C "$WORK" push --quiet origin "HEAD:refs/heads/e2e-$name"
  tag=sha-${sha:0:12}
  cid=$(docker create "$IMAGE_PREFIX/mailexpert-backend:$VERSION")
  for f in "$@"; do docker cp "$f" "$cid:/app/migrations/${f##*/}"; done
  docker commit --change "ENV BUILD_SHA=$sha" "$cid" "$IMAGE_PREFIX/mailexpert-backend:$tag" >/dev/null
  docker rm "$cid" >/dev/null
  docker tag "$IMAGE_PREFIX/mailexpert-frontend:$VERSION" "$IMAGE_PREFIX/mailexpert-frontend:$tag"
  printf '%s\n' "$tag"
}
V_OK=$(derive_version ok "$STAGE/9998_e2e_update_marker.sql")
V_MIG=$(derive_version mig "$STAGE/9998_e2e_update_marker.sql" "$STAGE/9999_e2e_update_fails.sql")
V_FAIL=$(derive_version fail "$STAGE/9999_e2e_update_fails.sql")
base=$(on "$B" migration_count)
marker_gone() { [ "$(on "$B" app_psql <<<"SELECT to_regclass('public.e2e_update_marker') IS NULL;")" = t ]; }
running_sha() { curl -fsS "http://127.0.0.1:$B_PORT/api/version" | jq -r .sha; }
backend_running() { [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$B_PROJECT" --filter label=com.docker.compose.service=backend)" ]; }
pass "versions ok ($V_OK), mig ($V_MIG) and fail ($V_FAIL)"

# 16. Update to ok: a pre-update backup (local dump and snapshot), the new migration, ready.
expect_exit 0 deploy update.sh "$V_OK" --prefix "$B"
sha=$(running_sha)
[ "sha-${sha:0:12}" = "$V_OK" ] || fail "B runs $sha after the update"
[ "$(on "$B" migration_count)" = $((base + 1)) ] || fail "the new migration was not applied"
[ -f "$B/backups/pre-update-$VERSION.dump" ] || fail "no local pre-update dump"
[ "$(on "$B" snapshots_here --tag pre-update | jq length)" = 1 ] || fail "no pre-update snapshot"
[ "$(update_status_of "$B")" = done ] || fail "update.json status after the update"
pass "update to a version with a new migration"

# 17. rollback.sh: the pre-update dump and the previous version; the new table is gone, the
# data is as before, the replaced database is kept.
expect_exit 0 deploy rollback.sh --prefix "$B"
[ "$(running_sha)" = "$HEAD_SHA" ] || fail "B does not run HEAD after the rollback"
[ "$(on "$B" migration_count)" = "$base" ] || fail "schema_migrations after the rollback"
marker_gone || fail "the new migration's table survived the rollback"
[ "$(credential "$B" check)" = match ] || fail "the credential after the rollback"
[ "$(on "$B" app_psql postgres <<<"SELECT count(*) FROM pg_database WHERE datname LIKE 'mailexpert_before_rollback_%';")" = 1 ] ||
  fail "the replaced database was not kept"
[ "$(update_status_of "$B")" = rolled-back ] || fail "update.json status after the rollback"
expect_exit 2 deploy rollback.sh --prefix "$B"
pass "rollback restores the pre-update dump and version; a second rollback is refused"

# 18. Update to fail: its only migration fails inside its transaction, nothing is recorded, and
# update.sh returns to the previous version by itself (exit 4). A shorter wait keeps the test fast.
export MAILEXPERT_READY_TIMEOUT=90
expect_exit 4 deploy update.sh "$V_FAIL" --prefix "$B"
[[ $OUT == *"applied no migrations"* ]] || fail "no explanation of the automatic return"
[ "$(running_sha)" = "$HEAD_SHA" ] || fail "B does not run HEAD after the automatic return"
[ "$(on "$B" migration_count)" = "$base" ] || fail "schema_migrations after a failed update"
[ "$(update_status_of "$B")" = rolled-back ] || fail "update.json status after the automatic return"
pass "a failed update without migrations returns to the previous version by itself"

# 19. Update to mig: one migration lands, the next fails: update.sh stops the panel and asks for
# rollback.sh (exit 5); another update is refused until then; rollback.sh restores the dump.
expect_exit 5 deploy update.sh "$V_MIG" --prefix "$B"
[[ $OUT == *rollback.sh* ]] || fail "no rollback.sh command in the output"
[ "$(on "$B" migration_count)" = $((base + 1)) ] || fail "mig: schema_migrations"
! backend_running || fail "the backend still runs after exit 5"
[ "$(update_status_of "$B")" = needs-rollback ] || fail "update.json status after exit 5"
expect_exit 2 deploy update.sh "$V_OK" --prefix "$B"
[[ $OUT == *"run "*rollback.sh*" first"* ]] || fail "update.sh did not refuse while a rollback is pending"
expect_exit 0 deploy rollback.sh --prefix "$B"
[ "$(running_sha)" = "$HEAD_SHA" ] || fail "B does not run HEAD after the second rollback"
[ "$(on "$B" migration_count)" = "$base" ] || fail "schema_migrations after the second rollback"
marker_gone || fail "the table of mig survived the rollback"
[ "$(credential "$B" check)" = match ] || fail "the credential after the second rollback"
pass "a failed update with migrations waits for rollback.sh, which restores the dump"
```

И в блок помощников (после `snapshots_here`) добавить:

```bash
# update_status_of <prefix>: the status in that panel's state/update.json.
update_status_of() {
  jq -r .status "$1/state/update.json"
}
```

- [ ] **Step 6: Проверки и commit**

Run: `git add -A && git add --chmod=+x scripts/deploy/update.sh scripts/deploy/rollback.sh && SC && BATS; echo "exit $?"`
Expected: `exit 0`.

```bash
git add scripts/deploy/lib/ops.sh scripts/deploy/test/ops.bats scripts/deploy/test/e2e-backup.sh
git add --chmod=+x scripts/deploy/update.sh scripts/deploy/rollback.sh
git commit -m "feat(deploy): update with a pre-update backup and roll back"
```

- [ ] **Step 7: e2e**

Run: `E2E` (`--only backup` при отладке, финально без него; backend пересобрать на новый HEAD).
Expected: строки этапов 15-19, `backup e2e passed`, `install e2e passed`, `deploy e2e passed`, `exit 0`, `host-unchanged`, список `me-e2e-` пуст. Этапы 18 и 19 ждут до 90 с каждый (цикл падений backend) — это ожидаемо.

---

### Task 7: Спецификация, полная проверка, уборка

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-deployment-design.md`

**Interfaces:**
- Consumes: всё из Task 1-6.
- Produces: решения и уточнения 7c в спецификации; чистое локальное окружение.

- [ ] **Step 1: Спецификация**

1. В строке статуса (строка 3) заменить `PR 7a (основа прода и CI) и 7b (установка и край) реализованы.` на `PR 7a (основа прода и CI), 7b (установка и край) и 7c (бэкап, восстановление, обновление и откат) реализованы.`

2. Решение о хранилище («Хранилище бэкапов — любое S3-совместимое» в «Принятых решениях») и неблокирующий статус открытого вопроса о провайдере записаны в спецификацию вместе с этим планом; проверить, что они на месте, и не дублировать.

3. В пункте 3 «Разбиения на PR» после `полный e2e.` добавить ` План: \`docs/superpowers/plans/2026-09-21-deployment-pr7c-backup-update.md\`.`

4. После подраздела «### Уточнения, принятые при реализации 7b» (перед «## Открытые вопросы») добавить:

```markdown
### Уточнения, принятые при реализации 7c

- Новые скрипты — оркестраторы над библиотеками, как `install.sh`: `lib/app.sh` (установленная панель: `install.conf`, пути, compose, база, маркер standby), `lib/backup.sh` (restic, пинги, `backup-last.json`), `lib/health.sh`, `lib/ops.sh` (решения обновления, слияние ключей при восстановлении); чистые функции покрыты bats. Коды выхода как в 7b; у `update.sh` ещё 4 — новая версия не поднялась, прежняя работает снова, и 5 — остановлено после миграций, нужен `rollback.sh`.
- restic — в контейнере `restic/restic:0.18.0` с `--network host`: одна версия на всех серверах и в e2e, коды выхода 10 («репозитория нет») и 12 («неверный пароль»). Ключи в `.env` через `configure.sh`: `RESTIC_REPOSITORY` (`s3:https://…`, `http` — только loopback для e2e), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, необязательный `AWS_DEFAULT_REGION`, `RESTIC_PASSWORD`. Пароль задаёт владелец; как и сгенерированные ключи, `configure.sh` пишет его только один раз: заменённый пароль не меняет пароль репозитория, а запирает сервер снаружи. В контейнеры секреты передаются только именами унаследованных переменных; URL пинга — через `curl -K`, не в argv.
- Ключи бэкапа для установки необязательны: без них `install.sh` предупреждает, а проверка здоровья сообщает «backup: not configured» (провайдер ещё не выбран, панель можно поставить раньше). С ключами `install.sh` открывает репозиторий, создаёт его (формат v2) только при коде 10, при неверном пароле останавливается; пишет `state/backup-since`; печатает ключ восстановления (`RESTIC_REPOSITORY`, `RESTIC_PASSWORD`) один раз и только в терминал (маркер `state/recovery-key.shown`), иначе — подсказку `backup.sh --show-recovery-key`: логи cloud-init и CI ключ не хранят.
- Снимок: `db.dump` (`pg_dump -Fc -Z0`), `counts.json`, `.env`, `edge/.env`, `install.conf`, с `--with-redis` — `redis.rdb`. `edge/Caddyfile` и `state/` в снимок не входят (отступление от «4. Бэкап», п. 2): Caddyfile рендерится из `install.conf` на новом сервере, `state/` описывает конкретный сервер. Дамп и подсчёт строк (`schema_migrations`, `users`, `email_accounts`, `google_oauth_apps`) берутся из одного экспортированного снимка PostgreSQL (`pg_export_snapshot` + `pg_dump --snapshot`) одноразовым контейнером сервиса postgres, поэтому сравнение после восстановления точное. Хост restic у всех серверов панели один — `mailexpert-panel`: после переезда история снимков продолжается, `latest` — последний бэкап панели.
- Хранение: последние 5 `pre-update`, остальное — 7 дневных, 4 недельных, 6 месячных; `pre-update` и `move` в общую политику не попадают. Ручные снимки одного дня схлопываются политикой до одного. `prune` — ночью в воскресенье, в остальные ночи — `restic check --read-data-subset=5%`, в воскресенье — `--verify`.
- `--verify`: временный `postgres:16-alpine` без сети с данными в `backups/verify-*`; `restic dump | pg_restore --single-transaction`; сравнение строк; затем образ backend этой версии в сетевом пространстве временной базы с `ENCRYPTION_KEY` из `.env` снимка: `runMigrations()` не применяет ни одной миграции (схема дампа совпадает с кодом), каждое `enc:v1:` значение в `email_accounts`, `google_oauth_apps`, `users`, `system_settings`, `integration_config`, `user_integrations`, `ai_codex_credentials`, `oidc_providers` расшифровывается (строки просматриваются целиком, включая токены внутри JSON). Если в снимке есть ящики, должно расшифроваться хотя бы одно значение из `email_accounts`. В вывод попадают только числа. Время восстановления — в `backup-last.json` (`restore_seconds`).
- Пинги: `start`, `success`, `fail` (из ловушки выхода). Необязательный `BACKUP_PING_URL` — отдельная проверка с суточным расписанием для бэкапа; без него бэкап пингует `HEALTHCHECK_PING_URL`. Локальный дамп без ключей restic (`update.sh` на сервере без бэкапов) не пингует.
- `state/backup-last.json`: время, снимок, тег, размер и время дампа, счётчики строк, признак и время проверки. Его читают `healthcheck.sh` (возраст бэкапа) и `update.sh` (место: свободно не меньше двух размеров дампа).
- Standby (`state/standby`): его ставят `install.sh --no-start` и `restore.sh`, снимает `install.sh` при запуске панели. `backup.sh` и `healthcheck.sh` на standby ничего не делают (код 0): бэкап с подготовленного сервера стал бы `latest` в общем репозитории, проверка здоровья будила бы владельца из-за выключенной намеренно панели.
- Блокировки: `state/install.lock` (как в 7b; `restore.sh` берёт её на время записи ключей), `state/backup.lock` (`backup.sh`, ожидание до часа), `state/update.lock` (`update.sh`, `rollback.sh`, `restore.sh`; `healthcheck.sh` при занятой блокировке пропускает проверку).
- `install.sh`: `up` панели ограничен сроком готовности (`timeout`), который задаёт `MAILEXPERT_READY_TIMEOUT` (по умолчанию 180 с, у `update.sh` и `rollback.sh` — 600 с). Без этого `up` ждал бы здоровья backend вечно: backend, падающий при старте, перезапускается бесконечно и не становится `unhealthy`.
- `restore.sh latest|<id> [--no-start]` работает только на сервере без тома базы и без контейнеров проекта (иначе код 2, данные не тронуты) — это и защита живого сервера, и условие безопасной замены ключей. Переезд (требование 7b): новый сервер — `install.sh --no-start` той же версии и `configure.sh` только с ключами restic; `configure.sh` сгенерированные ключи по-прежнему не заменяет и в ошибке называет `restore.sh`. `restore.sh` берёт из снимка `ENCRYPTION_KEY`, `DB_PASSWORD`, `SESSION_SECRET` и пару VAPID вместо сгенерированных здесь (ими ещё ничего не зашифровано, том базы создаётся уже с восстановленным паролем), дописывает секреты владельца, которых здесь нет (заданные здесь остаются), `install.conf`, порт и имя проекта не трогает, прежний `.env` сохраняет как `.env.pre-restore`. Версия снимка обязана совпадать с установленной. После восстановления — сравнение строк и та же проверка миграций и расшифровки, затем `install.sh` запускает панель.
- Уточнение к «5. Переезд», шаг 2: репетиция — `restore.sh latest --no-start` (панель не запускается: второй работающий экземпляр рядом с живым синхронизировал бы все ящики и запускал синхронизацию Access), время восстановления — в выводе; затем `docker compose -p <проект> down -v`. Шаг 1: секреты владельца на новый сервер вручную переносить не нужно, их подтягивает `restore.sh`.
- `update.sh`: переключение версии делает `install.sh --version` (checkout, образы, `up`, миграции, готовность, сверка версии, `exec` установщика нового коммита). Итог: готово; не поднялось без новых миграций — сам возвращает прежнюю версию (код 4); не поднялось после миграций — останавливает backend и frontend, пишет статус `needs-rollback` в `state/update.json` и команду `rollback.sh` (код 5); пока откат не сделан, новое обновление отклоняется. Предупреждение о неготовом `idx_messages_provider_thread` из логов выводится.
- `rollback.sh` восстанавливает дамп перед обновлением в новую базу и подменяет ею текущую переименованием в одной транзакции; заменённая база остаётся как `<db>_before_rollback_<время>` до ручного удаления (отступление от `pg_restore --clean`: таблицы новых миграций пережили бы `--clean`, и повторное обновление упало бы на их создании). Затем `install.sh --version <прежняя>`.
- `healthcheck.sh`: готовность, контейнеры панели и края (`running`, не `unhealthy`), свободное место на `/` и в каталоге Docker (`MAILEXPERT_MIN_FREE_PCT`, по умолчанию 15), возраст бэкапа (до первого бэкапа — от `backup-since`), срок сертификата `<DIRECT_HOST>` только при `--edge-tls acme`. Проверка памяти при почтовом узле на том же сервере — в PR 9. Неожиданный сбой скрипта — код 1 без пинга: пропуск пинга замечает внешний сервис.
- e2e (`e2e-backup.sh`, после сценария 7b в том же dind): MinIO вместо S3; сервер A без ключей (предупреждение), ключи через `configure.sh`, создание репозитория, ключ восстановления без терминала не печатается и печатается по `--show-recovery-key` один раз; ящик с паролем, зашифрованным ключом A; ручной бэкап, `--verify`, `--verify` с чужим ключом — ошибка, ночной бэкап; здоровье (норма, старый бэкап, остановленный Redis); уничтожение A; сервер B `--no-start` (standby: бэкап и здоровье пропускаются), `configure.sh` отвергает ключ A и называет `restore.sh`; `restore.sh --no-start`, запуск, расшифровка пароля ящика на B, бэкап с B, отказ повторного восстановления; обновления на версии с рабочей миграцией (затем `rollback.sh`), с падающей миграцией (автоматический возврат, код 4) и с рабочей и падающей (код 5, отказ нового обновления, `rollback.sh`). Не покрыты: реальный S3-провайдер (только MinIO), пинги (в e2e нет https-приёмника; `ping_target` — bats), срабатывание таймеров systemd, `--with-redis` (путь с `redis-cli SAVE` и `docker compose cp`), проверка сертификата при ACME, репозиторий на другом сервере (второй «сервер» — другой проект в том же dind), переезд с краем (`TUNNEL_TOKEN`, `DNS_API_TOKEN` из снимка — только bats `merge_restored_keys`), скачивание образов из GHCR при обновлении.
```

- [ ] **Step 2: Полная проверка**

Run: `SC; echo "exit $?"`
Expected: `exit 0`.

Run: `BATS; echo "exit $?"`
Expected: все тесты `env`, `config`, `edge`, `configure`, `lock`, `app`, `backup`, `health`, `ops` проходят, `exit 0`.

Run: `AL; echo "exit $?"`
Expected: `exit 0`.

Run: `git ls-files -s scripts/deploy/backup.sh scripts/deploy/healthcheck.sh scripts/deploy/restore.sh scripts/deploy/update.sh scripts/deploy/rollback.sh scripts/deploy/install.sh scripts/deploy/configure.sh | cut -c1-6 | sort -u`
Expected: `100755` — одна строка (таймеры включаются только для исполняемых скриптов).

Run: `git diff --stat origin/main -- backend frontend docker-compose.yml deploy/compose.prod.yml`
Expected: пусто — наборы тестов бэкенда и фронтенда не прогоняются (если не пусто — прогнать их, как в плане 7a).

Run: `git grep -nE -- "-e (RESTIC_PASSWORD|RESTIC_REPOSITORY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|ENCRYPTION_KEY|DB_PASSWORD|MINIO_ROOT_PASSWORD)=" -- scripts/deploy`
Expected: пусто — секреты уходят в контейнеры только именами.

Run: `git grep -niE "amazonaws|backblaze|wasabi|scaleway|storj|idrive|digitalocean|hetzner|r2\.cloudflarestorage" -- scripts/deploy docs/superpowers/specs/2026-09-21-deployment-design.md docs/superpowers/plans/2026-09-21-deployment-pr7c-backup-update.md`
Expected: пусто — провайдер не назван.

Run: `git grep -nE "([0-9]{1,3}\.){3}[0-9]{1,3}" -- scripts/deploy deploy docs/superpowers/plans/2026-09-21-deployment-pr7c-backup-update.md | grep -vE "127\.0\.0\.1|0\.0\.0\.0|203\.0\.113\.|198\.51\.100\."`
Expected: пусто.

e2e: если после последнего прогона Task 6 были коммиты в `scripts/` или `deploy/` — повторить `E2E` без `--only` на текущем HEAD (backend пересобрать) со снимком `docker ps` до и после. Expected: `deploy e2e passed`, `exit 0`, `host-unchanged`.

- [ ] **Step 3: Уборка**

```bash
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^local\.invalid/' | xargs -r docker rmi
docker ps -a --filter name=me-e2e- --format '{{.Names}}'
rm -rf "$SCRATCH"
```

Expected: вторая команда пуста. Скачанные публичные образы инструментов (`restic/restic`, `minio/minio`, `bats/bats`, `docker:29.8.1-dind`, `koalaman/shellcheck`, `rhysd/actionlint`) остаются. Рабочие контейнеры MailExpert и контейнеры других проектов на хосте не трогать.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-21-deployment-design.md
git commit -m "docs: record PR 7c implementation notes in the deployment spec"
```

- [ ] **Step 5: После слияния в `main` (напомнить владельцу в отчёте)**

- Выбрать S3-совместимое хранилище у другого провайдера, чем серверы, с версионированием или object lock; создать бакет и ключ доступа только к нему. До этого панель работает без бэкапов, и проверка здоровья об этом сообщает.
- Завести проверки во внешнем сервисе мониторинга (интеграция с Telegram — там же): основную на 5 минут для `HEALTHCHECK_PING_URL` и, по желанию, суточную для `BACKUP_PING_URL`; HTTP-проверку `https://<APP_HOST>/api/health` снаружи.
- На сервере: `configure.sh` с ключами restic и пингов, `install.sh` в терминале — показанный один раз ключ восстановления сохранить вне сервера; затем `backup.sh --verify` вручную.
- Runbook (установка, обновление, откат, бэкап, переезд по шагам) — 7d.

## Self-review

- Покрытие спецификации: «3. Обновление» — шаг 1 (место) `space_problem`; шаг 2 (`git fetch`, образы до остановки) — `update.sh`; шаг 3 (локальный дамп `pre-update-<sha>.dump`, 3 штуки, снимок `pre-update`) — `backup.sh --keep-dump`, `prune_local_dumps`; шаг 4 (`state/`) — `update.json`; шаг 5 — `install.sh --version`; шаг 6 (10 минут, версия, предупреждение об индексе) — `MAILEXPERT_READY_TIMEOUT=600`, `check_index_warning`; шаг 7 — `update_outcome`, коды 4/5; `rollback.sh` — Task 6 (с отступлением, записанным в уточнениях). «4. Бэкап» — пп. 1-6 (Task 3; `edge/Caddyfile` и `state/` — осознанно вне снимка, записано); `--with-redis` (Task 3, не в e2e — записано); `restore.sh` (Task 5). «5. Переезд» — шаги 1-5 в части скриптов (`--no-start`, standby, `restore.sh`, `--tag move`); переключение DNS и вывод старого сервера — runbook 7d. «7. Мониторинг» — Task 4 (память — PR 9, записано). «8. Проверка скриптов» — bats, shellcheck, e2e бэкапа, восстановления, обновления и отката (вариант с падающей миграцией — образ с лишними файлами в `migrations/`, собирается только в тесте). Уточнения 7b: ключи restic в `configure.sh` (Task 2), ключ восстановления (Task 3), таймеры включаются по наличию скриптов (режим `100755`, Task 7 Step 2), отказ `configure.sh` при переезде решён `restore.sh` (Task 5), пинги во внешний сервис без токена бота (Task 3-4).
- Решение контроллера: S3-провайдер не выбран — всё через `RESTIC_REPOSITORY` и ключи `configure.sh`, e2e на MinIO, провайдер — неблокирующий открытый вопрос (записано в спецификацию вместе с планом; Task 7 проверяет).
- Заглушки и безопасность: в тестах — `example.test`, `example.com`, `local.invalid`, loopback; все скрипты запускаются только внутри dind; `restore.sh` отказывается работать рядом с базой; секреты не попадают в argv и вывод (проверки grep в Task 7).
- Имена согласованы: `take_lock`, `load_install`, `set_install_paths`, `APP_COMPOSE`, `app_psql`, `migration_count`, `is_standby`/`set_standby`/`clear_standby`, `lock_held` (Task 1) — в Task 3-6; `restic_repository_ok`, `backup_configured`, `ping_target`, `backup_checks`, `prune_today`, `json_number`, `backup_age_problem`, `backup_tag_ok`, `RESTIC_IMAGE`, `RESTIC_HOST`, `RESTIC_KEYS` (Task 2) — в Task 3-6 и `e2e.sh`; `load_restic_env`, `restic_run`, `ensure_backup_repo`, `show_recovery_key_once`, `send_ping`, `backup_ping_url`, `dump_database`, `write_backup_last` (Task 3) — в Task 4-6; `merge_restored_keys` (Task 5); `update_outcome`, `space_problem`, `stale_local_dumps`, `write_update_state`, `set_update_status`, `update_status` (Task 6); помощники e2e `deploy`, `on`, `expect_exit`/`OUT`, `credential`, `snapshots_here`, `update_status_of`, `remove_project` — в своих этапах.

