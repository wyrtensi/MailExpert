# Развёртывание, PR 7b: установка и край — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** идемпотентная установка панели на сервер одной командой: `scripts/deploy/install.sh` (проверки хоста, пакеты, checkout нужного коммита, `.env` с секретами, которые генерируются один раз, запуск по прод-оверлею из 7a, край, файрвол, проверка готовности, таймеры) и `scripts/deploy/configure.sh` (секреты владельца только из stdin), шаблоны края (`deploy/edge/compose.yml`, `deploy/edge/Caddyfile.tmpl`), юниты systemd, bats-тесты чистых функций и e2e установки в одноразовом Docker-in-Docker; bats и e2e — в CI.

**Architecture:** `install.sh` — тонкий оркестратор над библиотеками `scripts/deploy/lib/*.sh`, которые подключаются через `source` и тестируются bats без Docker: `common.sh` (лог, версии, генерация hex, проверки имён), `env.sh` (файлы `KEY=VALUE`, «записать один раз», генерация секретов), `config.sh` (флаги, `install.conf`, валидация, всё, что следует из режима входа), `edge.sh` (Caddyfile и файлы проекта края), `system.sh` (Ubuntu: пакеты, Docker, swap, ufw, таймеры; пропускается целиком с `--no-system`). Действия с побочными эффектами (`docker run` для VAPID в `gen_vapid_pair`, случайные байты в `gen_hex`) спрятаны за функциями, которые тесты подменяют. Край — отдельный compose-проект (по умолчанию `edge`) в `<prefix>/edge/`: Caddy из образа `mailexpert-edge` (7a) и/или `cloudflared`, выбор через `COMPOSE_PROFILES`. e2e запускает установщик внутри привилегированного контейнера `docker:dind`: его `docker compose` видит только внутренний демон, поэтому контейнеры, тома и порты хоста для теста недосягаемы.

**Tech Stack:** bash 5 (Ubuntu 24.04; Alpine/busybox в dind и в образе bats), Docker Engine + Compose ≥ 2.24.4, Caddy 2.11 + `caddy-dns/cloudflare` (образ из 7a), `cloudflare/cloudflared:2026.9.1`, systemd timers, ufw; bats 1.14 (`bats/bats:1.14.0`), shellcheck (`koalaman/shellcheck:stable`), actionlint, `docker:29.8.1-dind`; GitHub Actions (`docker/build-push-action@v6` с `load: true`).

**Spec:** `docs/superpowers/specs/2026-09-21-deployment-design.md` — «2. Установка» (шаги 1-12), «1. Раскладка» (порты, TLS панели, край), «Принятые решения» (секреты один раз, край как отдельный проект, режимы входа, публичные пакеты GHCR, Compose ≥ 2.24.4, оповещения через `HEALTHCHECK_PING_URL`), «8. Проверка скриптов» (shellcheck, bats, e2e), «Уточнения, принятые при реализации 7a», «Открытые вопросы» (решения владельца: зона DNS в Cloudflare, Telegram через внешний сервис). Бэкап, restic, восстановление, обновление, `healthcheck.sh` и печать ключа восстановления (шаг 13) — 7c; runbook — 7d.

## Global Constraints

- Проза плана и спецификаций — по-русски; код, комментарии в коде, коммиты, тексты PR — по-английски. Без эмодзи.
- Коммиты от имени настроенного пользователя git (`wyrtensi`), без строк атрибуции. Не пушить без команды контроллера. Все команды `gh pr` — с `--repo wyrtensi/MailExpert`.
- В документах и тестах только заглушки: `<APP_HOST>`, `<CF_HOST>`, `<DIRECT_HOST>`, `<MAIL_HOST>`, `<TEAM>`, `<AUD>`, `<OWNER>`; в коде тестов — зарезервированные домены `example.com`, `example.test`, `.invalid`. Никаких реальных хостов, IP и секретов. Имя репозитория `wyrtensi/MailExpert` и префикс `ghcr.io/wyrtensi` публичны и допустимы.
- **Безопасность хоста (жёстко).** На хосте работают рабочие контейнеры `mailexpert-frontend`, `mailexpert-backend`, `mailexpert-postgres`, `mailexpert-redis` и контейнеры других проектов на хосте. Их не останавливать, не пересоздавать, не выполнять в них команды, не удалять; чужие контейнеры не перечислять и не называть. В 7b на демоне хоста **не выполняется ни одна** команда `docker compose up/down/restart/rm`. Разрешено на хосте: `docker build` с тегами только под `local.invalid/`; одноразовые `docker run --rm` инструментов (bats, shellcheck, actionlint, `caddy validate`, `ubuntu:24.04`); `docker compose ... config` (только чтение); один контейнер e2e `me-e2e-<id>`, который удаляется в конце. До и после e2e сравнить время старта запущенных контейнеров (`docker inspect -f '{{.Name}} {{.State.StartedAt}}'`, снимок только в `$SCRATCH`, не в отчёт) — ни одно не изменилось, ни один контейнер не пропал.
- Секреты никогда не передаются флагами и аргументами, не попадают в вывод и логи скриптов. Сообщения об ошибках называют ключ, но не значение.
- Сгенерированные ключи (`SESSION_SECRET`, `ENCRYPTION_KEY`, `DB_PASSWORD`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) пишутся только в отсутствующие или пустые ключи и никогда не перезаписываются; другое значение для существующего — ошибка, файл не меняется.
- Пакеты GHCR публичные: ни `GHCR_TOKEN`, ни `docker login`. Compose ≥ 2.24.4. Образ, который уже есть локально под нужным тегом, не скачивается (аварийная сборка из исходников из 7a должна работать).
- Хранилище бэкапов (S3-провайдер) не выбрано; 7b не зависит ни от restic, ни от S3.
- Исполняемые скрипты начинаются с `#!/usr/bin/env bash` и `set -euo pipefail`; библиотеки — `# shellcheck shell=bash`, без `set`. Концы строк LF. Результат `$(...)` с возможной ошибкой присваивается отдельной командой (`x=$(f)`), не подставляется в аргументы: иначе `set -e` теряет ошибку.
- `backend/` и `frontend/` в 7b не меняются.
- Если чистое решение упирается в препятствие (падающий чужой тест, недоступный образ, неожиданное поведение Compose, Caddy или busybox) — остановиться и доложить, не обходить (не отключать проверки, не ослаблять условия, не подставлять ожидаемые значения).

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

Ниже они записаны как `SC`, `BATS` и `AL`. Для временных файлов: `SCRATCH=$(mktemp -d)`; путь для Docker — `$(cygpath -w "$SCRATCH")`.

## Файлы

| Файл | Что это |
|---|---|
| `.gitattributes` | LF для `*.bats`, `*.tmpl`, всего `deploy/` |
| `.shellcheckrc` (новый) | shellcheck следует за `source` относительно каталога скрипта |
| `scripts/deploy/lib/common.sh` (новый) | `log`, `warn`, `die`, `version_ge`, `gen_hex`, `is_hostname`, `is_email`, `is_port`, `is_name` |
| `scripts/deploy/lib/env.sh` (новый) | `env_get`, `env_set`, `env_ensure_secret`, `env_fill_missing`, `env_missing`, `gen_vapid_pair`, `ensure_vapid`, `generate_app_secrets` |
| `scripts/deploy/lib/config.sh` (новый) | флаги, `install.conf`, валидация, `app_settings`, `edge_services`, `edge_profiles`, `required_owner_secrets`, `ssh_ports`, `ufw_allowed_ports`, `port_conflicts`, `resource_shortfalls`, `version_matches`, `render_unit` |
| `scripts/deploy/lib/edge.sh` (новый) | `caddy_site_address`, `render_caddyfile`, `write_edge_files` |
| `scripts/deploy/lib/system.sh` (новый) | `check_os`, `check_resources`, `install_packages`, `ensure_docker_running`, `ensure_swap`, `enable_unattended_upgrades`, `apply_ufw`, `install_timers` |
| `scripts/deploy/install.sh` (новый) | оркестратор установки |
| `scripts/deploy/configure.sh` (новый) | секреты владельца из stdin |
| `deploy/edge/compose.yml`, `deploy/edge/Caddyfile.tmpl` (новые) | проект края и шаблон Caddyfile |
| `deploy/systemd/mailexpert-{backup,health}.{service,timer}` (новые) | таймеры; скрипты для них приходят в 7c |
| `scripts/deploy/test/helper.bash`, `*.bats` (новые) | модульные тесты |
| `scripts/deploy/test/e2e.sh`, `e2e-install.sh` (новые) | e2e: обёртка на хосте и сценарий внутри dind |
| `.github/workflows/ci.yml` | задания `bats` и `deploy-e2e`; `images` ждёт их |
| `docs/superpowers/specs/2026-09-21-deployment-design.md` | статус 7b и уточнения реализации |

---

### Task 1: Основа — файлы `.env`, генерация секретов, bats в CI

**Files:**
- Modify: `.gitattributes`
- Create: `.shellcheckrc`
- Create: `scripts/deploy/lib/common.sh`
- Create: `scripts/deploy/lib/env.sh`
- Create: `scripts/deploy/test/helper.bash`
- Create: `scripts/deploy/test/env.bats`
- Modify: `.github/workflows/ci.yml` (новое задание `bats`)

**Interfaces:**
- Consumes: ничего.
- Produces (все последующие задачи):
  - `log <msg>`, `warn <msg>` (в stderr); `die <msg> [code=1]` (печатает и `exit`);
  - `version_ge <a> <b>` → 0, если `a >= b` (префикс `v` и суффикс `-…`/`+…` игнорируются);
  - `gen_hex <bytes>` → строка `2*bytes` шестнадцатеричных символов из `/dev/urandom`;
  - `is_hostname`, `is_email`, `is_port` (1024-65535), `is_name` (имя compose-проекта) → 0/1;
  - `GENERATED_SECRET_KEYS` — массив из пяти ключей;
  - `env_value_ok <v>`; `env_get <file> <key>` (печатает значение, статус 1 — нет файла или ключа); `env_set <file> <key> <value>` (атомарно, режим 0600, прочие строки без изменений; плохое значение — `die`); `env_ensure_secret <file> <key> <value>` (0 — записан или совпадает, 2 — отличается, файл не тронут); `env_fill_missing <file> <key> <generator...>`; `env_missing <file> <key...>` (печатает отсутствующие или пустые); `gen_vapid_pair` (печатает `<public> <private>`, читает `$BACKEND_IMAGE`); `ensure_vapid <file>`; `generate_app_secrets <file>`.

Почему `od`, а не `openssl rand`: в образе bats нет `openssl`, а `od` есть в coreutils и busybox; источник случайности тот же (`/dev/urandom`).

- [ ] **Step 1: Концы строк и shellcheck**

В `.gitattributes` после строки `*.sh text eol=lf` добавить:

```gitattributes
*.bats text eol=lf
*.tmpl text eol=lf
deploy/** text eol=lf
.shellcheckrc text eol=lf
```

Создать `.shellcheckrc`:

```ini
# Follow `source` directives to files that are not on the command line, relative to the
# sourcing script's directory (scripts/deploy/lib from scripts/deploy/*.sh).
external-sources=true
source-path=SCRIPTDIR
```

- [ ] **Step 2: Написать падающие тесты**

`scripts/deploy/test/helper.bash`:

```bash
# Loaded by every .bats file (`load helper`): the deploy libraries in the test shell.
DEPLOY_DIR=$(cd "$BATS_TEST_DIRNAME/.." && pwd)
REPO_DIR=$(cd "$DEPLOY_DIR/../.." && pwd)
for lib in common env config edge; do
  if [ -f "$DEPLOY_DIR/lib/$lib.sh" ]; then
    # shellcheck source=/dev/null
    source "$DEPLOY_DIR/lib/$lib.sh"
  fi
done
```

`scripts/deploy/test/env.bats`:

```bash
#!/usr/bin/env bats
# .env files: single-token values, atomic writes, secrets generated once and never replaced.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  F=$BATS_TEST_TMPDIR/.env
}

@test "env_set creates the file with mode 600" {
  env_set "$F" APP_URL https://app.example.com
  [ "$(cat "$F")" = "APP_URL=https://app.example.com" ]
  [ "$(stat -c %a "$F")" = 600 ]
}

@test "env_set replaces only its key and keeps comments and other keys" {
  printf '# comment\nA=1\nB=2\n' >"$F"
  env_set "$F" A 3
  [ "$(cat "$F")" = $'# comment\nA=3\nB=2' ]
}

@test "env_set rejects values compose would not read verbatim" {
  local bad
  for bad in 'a b' 'a$b' 'a#b' "a'b" 'a"b' 'a\b' $'a\nb' $'a\tb'; do
    run env_set "$F" K "$bad"
    [ "$status" -ne 0 ]
  done
  [ ! -e "$F" ]
}

@test "env_get prints the value and fails for a missing key or file" {
  printf 'A=x=y\nB=\n' >"$F"
  run env_get "$F" A
  [ "$status" -eq 0 ] && [ "$output" = "x=y" ]
  run env_get "$F" B
  [ "$status" -eq 0 ] && [ "$output" = "" ]
  run env_get "$F" C
  [ "$status" -eq 1 ]
  run env_get "$BATS_TEST_TMPDIR/none" A
  [ "$status" -eq 1 ]
}

@test "env_ensure_secret: absent or empty is set, equal is kept, different is refused" {
  env_ensure_secret "$F" K one
  printf 'E=\n' >>"$F"
  env_ensure_secret "$F" E two
  run env_ensure_secret "$F" K one
  [ "$status" -eq 0 ]
  before=$(sha256sum <"$F")
  run env_ensure_secret "$F" K other
  [ "$status" -eq 2 ]
  [ "$(sha256sum <"$F")" = "$before" ]
  [ "$(env_get "$F" K)" = one ]
  [ "$(env_get "$F" E)" = two ]
}

@test "env_missing lists absent and empty keys" {
  printf 'A=1\nB=\n' >"$F"
  run env_missing "$F" A B C
  [ "$output" = $'B\nC' ]
}

@test "generate_app_secrets fills every generated key" {
  gen_vapid_pair() { echo "PUB PRIV"; }
  generate_app_secrets "$F"
  [[ $(env_get "$F" SESSION_SECRET) =~ ^[0-9a-f]{64}$ ]]
  [[ $(env_get "$F" ENCRYPTION_KEY) =~ ^[0-9a-f]{64}$ ]]
  [[ $(env_get "$F" DB_PASSWORD) =~ ^[0-9a-f]{48}$ ]]
  [ "$(env_get "$F" VAPID_PUBLIC_KEY)" = PUB ]
  [ "$(env_get "$F" VAPID_PRIVATE_KEY)" = PRIV ]
}

@test "a rerun never calls a generator and never changes the file" {
  calls=$BATS_TEST_TMPDIR/calls
  gen_vapid_pair() { echo x >>"$calls"; echo "PUB PRIV"; }
  generate_app_secrets "$F"
  first=$(sha256sum <"$F")
  gen_hex() { echo x >>"$calls"; echo deadbeef; }
  generate_app_secrets "$F"
  generate_app_secrets "$F"
  [ "$(sha256sum <"$F")" = "$first" ]
  [ "$(wc -l <"$calls")" -eq 1 ]
}

@test "an empty key is generated, a present one is kept" {
  key=$(printf 'a%.0s' {1..64})
  printf 'SESSION_SECRET=\nENCRYPTION_KEY=%s\n' "$key" >"$F"
  gen_vapid_pair() { echo "PUB PRIV"; }
  generate_app_secrets "$F"
  [[ $(env_get "$F" SESSION_SECRET) =~ ^[0-9a-f]{64}$ ]]
  [ "$(env_get "$F" ENCRYPTION_KEY)" = "$key" ]
}

@test "half a VAPID pair is an error, not a regeneration" {
  printf 'VAPID_PUBLIC_KEY=PUB\n' >"$F"
  gen_vapid_pair() { echo "NEW NEW"; }
  run ensure_vapid "$F"
  [ "$status" -ne 0 ]
  [ "$(env_get "$F" VAPID_PUBLIC_KEY)" = PUB ]
  run env_get "$F" VAPID_PRIVATE_KEY
  [ "$status" -eq 1 ]
}

@test "gen_hex returns two hex characters per byte" {
  [[ $(gen_hex 3) =~ ^[0-9a-f]{6}$ ]]
  [[ $(gen_hex 32) =~ ^[0-9a-f]{64}$ ]]
}

@test "version_ge compares dotted versions" {
  version_ge 2.24.4 2.24.4
  version_ge 2.24.10 2.24.4
  version_ge 5.5.1 2.24.4
  version_ge v2.29.1-desktop.1 2.24.4
  run ! version_ge 2.24.3 2.24.4
  run ! version_ge 2.9.0 2.24.4
  run ! version_ge garbage 2.24.4
}

@test "name checks" {
  is_hostname panel.example.com
  run ! is_hostname https://panel.example.com
  run ! is_hostname Panel.example.com
  run ! is_hostname under_score.example.com
  run ! is_hostname localhost
  is_email admin@example.com
  run ! is_email 'admin example.com'
  is_port 8080
  run ! is_port 80
  run ! is_port 70000
  is_name me-e2e
  run ! is_name MailExpert
}
```

- [ ] **Step 3: Запустить — должны упасть**

Run: `BATS`
Expected: FAIL — `env_set: command not found` и подобные (библиотек ещё нет).

- [ ] **Step 4: Реализовать `scripts/deploy/lib/common.sh`**

```bash
# shellcheck shell=bash
# Helpers shared by the deploy scripts. Sourced, never executed.

log() { printf '[mailexpert] %s\n' "$*" >&2; }
warn() { printf '[mailexpert] warning: %s\n' "$*" >&2; }

# die <message> [exit code, default 1]
die() {
  printf '[mailexpert] error: %s\n' "$1" >&2
  exit "${2:-1}"
}

# version_ge <a> <b>: a >= b for dotted numeric versions. A leading "v" and a "-..." or
# "+..." suffix are ignored, so 2.24.4-desktop.1 compares as 2.24.4.
version_ge() {
  local a=${1#v} b=${2#v} i x y
  local -a av bv
  a=${a%%[-+]*}
  b=${b%%[-+]*}
  [[ $a =~ ^[0-9]+(\.[0-9]+)*$ && $b =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 1
  IFS=. read -r -a av <<<"$a"
  IFS=. read -r -a bv <<<"$b"
  for i in 0 1 2 3; do
    x=${av[i]:-0}
    y=${bv[i]:-0}
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

# gen_hex <bytes>: random bytes as lowercase hex, two characters per byte.
gen_hex() {
  head -c "$1" /dev/urandom | od -A n -v -t x1 | tr -d ' \n'
}

is_hostname() {
  [ "${#1}" -le 253 ] && [[ $1 =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

is_email() {
  [[ $1 =~ ^[^[:space:]@,]+@([a-z0-9-]+\.)+[a-z]{2,63}$ ]]
}

is_port() {
  [[ $1 =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

# is_name <compose project name>
is_name() {
  [[ $1 =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]
}
```

- [ ] **Step 5: Реализовать `scripts/deploy/lib/env.sh`**

```bash
# shellcheck shell=bash
# KEY=VALUE files: <prefix>/.env, <prefix>/edge/.env and <prefix>/install.conf. They are parsed,
# never sourced. A value is one token (no whitespace, quotes, '$', '#' or backslash), so docker
# compose reads it verbatim.

# Generated on the host, written once, never replaced: ENCRYPTION_KEY decrypts stored mailbox
# credentials, DB_PASSWORD is baked into the PostgreSQL volume, the VAPID pair backs every push
# subscription, SESSION_SECRET signs sessions.
GENERATED_SECRET_KEYS=(SESSION_SECRET ENCRYPTION_KEY DB_PASSWORD VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY)

env_value_ok() {
  case $1 in
    *[[:space:]]* | *[\'\"\$\#\\]*) return 1 ;;
  esac
  return 0
}

# env_get <file> <key>: prints the value; status 1 when the file or the key is absent.
env_get() {
  local file=$1 key=$2 line
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      "$key="*)
        printf '%s\n' "${line#"$key="}"
        return 0
        ;;
    esac
  done <"$file"
  return 1
}

# env_set <file> <key> <value>: adds or replaces one key, other lines stay as they are. The file
# is replaced atomically and keeps mode 0600.
env_set() {
  local file=$1 key=$2 value=$3 tmp line found=0 current
  env_value_ok "$value" || die "$key: the value must be one token without spaces, quotes, \$, # or backslash"
  if current=$(env_get "$file" "$key") && [ "$current" = "$value" ]; then
    return 0
  fi
  tmp=$(mktemp "$file.XXXXXX") || die "cannot write next to $file"
  chmod 600 "$tmp"
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case $line in
        "$key="*)
          if [ "$found" = 0 ]; then
            printf '%s=%s\n' "$key" "$value"
            found=1
          fi
          ;;
        *) printf '%s\n' "$line" ;;
      esac
    done <"$file" >"$tmp"
  fi
  if [ "$found" = 0 ]; then
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  mv -f "$tmp" "$file"
}

# env_ensure_secret <file> <key> <value>: writes only an absent or empty key. The same value is
# a no-op; a different value returns 2 and leaves the file untouched.
env_ensure_secret() {
  local file=$1 key=$2 value=$3 current
  current=$(env_get "$file" "$key") || current=
  if [ -z "$current" ]; then
    env_set "$file" "$key" "$value"
    return 0
  fi
  [ "$current" = "$value" ] && return 0
  log "$key already has a different value in $file; generated secrets are never replaced"
  return 2
}

# env_fill_missing <file> <key> <generator...>: runs the generator only for an absent or empty
# key and stores its output.
env_fill_missing() {
  local file=$1 key=$2 current value
  shift 2
  current=$(env_get "$file" "$key") || current=
  [ -z "$current" ] || return 0
  value=$("$@") || die "could not generate $key"
  [ -n "$value" ] || die "could not generate $key"
  env_set "$file" "$key" "$value"
  log "generated $key"
}

# env_missing <file> <key...>: prints each key that is absent or empty.
env_missing() {
  local file=$1 key value
  shift
  for key in "$@"; do
    value=$(env_get "$file" "$key") || value=
    [ -n "$value" ] || printf '%s\n' "$key"
  done
}

# gen_vapid_pair: "<public> <private>" from web-push inside the backend image ($BACKEND_IMAGE),
# without network access. Tests replace this function.
gen_vapid_pair() {
  docker run --rm --network none --entrypoint node "$BACKEND_IMAGE" -e \
    "const k = require('web-push').generateVAPIDKeys(); console.log(k.publicKey + ' ' + k.privateKey)"
}

# ensure_vapid <file>: generates the pair when both keys are missing. One key without the other
# is an error: half a pair is restored from a backup, never regenerated.
ensure_vapid() {
  local file=$1 pub priv pair
  pub=$(env_get "$file" VAPID_PUBLIC_KEY) || pub=
  priv=$(env_get "$file" VAPID_PRIVATE_KEY) || priv=
  if [ -n "$pub" ] && [ -n "$priv" ]; then return 0; fi
  if [ -n "$pub" ] || [ -n "$priv" ]; then
    die "$file has only one of VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY; restore the pair from a backup"
  fi
  pair=$(gen_vapid_pair) || die "could not generate VAPID keys"
  read -r pub priv <<<"$pair"
  if [ -z "$pub" ] || [ -z "$priv" ]; then die "could not generate VAPID keys"; fi
  env_set "$file" VAPID_PUBLIC_KEY "$pub"
  env_set "$file" VAPID_PRIVATE_KEY "$priv"
  log "generated VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY"
}

# generate_app_secrets <file>: every generated secret that is still missing.
generate_app_secrets() {
  local file=$1
  env_fill_missing "$file" SESSION_SECRET gen_hex 32
  env_fill_missing "$file" ENCRYPTION_KEY gen_hex 32
  env_fill_missing "$file" DB_PASSWORD gen_hex 24
  ensure_vapid "$file"
}
```

- [ ] **Step 6: Запустить — должны пройти**

Run: `BATS`
Expected: PASS, 13 тестов `env.bats`.

Run: `git add .gitattributes .shellcheckrc scripts/deploy && SC`
Expected: без замечаний, код 0. Если shellcheck ругается на `env.sh` (например, SC2034 на `GENERATED_SECRET_KEYS`, которую читают другие файлы) — перед присваиванием `# shellcheck disable=SC2034 # read by install.sh and tests`; других подавлений не добавлять, доложить.

- [ ] **Step 7: bats в CI**

В `.github/workflows/ci.yml` после задания `shellcheck` добавить:

```yaml
  bats:
    name: Bats
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v6

      - name: Deploy script unit tests
        run: docker run --rm -v "$PWD:/code:ro" -w /code bats/bats:1.14.0 scripts/deploy/test
```

В задании `images` заменить `needs: [backend, frontend, shellcheck]` на `needs: [backend, frontend, shellcheck, bats]`.

Run: `AL`
Expected: без замечаний.

- [ ] **Step 8: Commit**

```bash
git add .gitattributes .shellcheckrc scripts/deploy/lib/common.sh scripts/deploy/lib/env.sh scripts/deploy/test/helper.bash scripts/deploy/test/env.bats .github/workflows/ci.yml
git commit -m "feat(deploy): add env file helpers that generate secrets once"
```

---

### Task 2: Флаги, `install.conf`, валидация и выбор режима

**Files:**
- Create: `scripts/deploy/lib/config.sh`
- Create: `scripts/deploy/test/config.bats`

**Interfaces:**
- Consumes: `die`, `is_*`, `env_get`, `env_set` (Task 1).
- Produces:
  - глобальные `CFG_VERSION CFG_SIGNIN CFG_CF_HOST CFG_DIRECT_HOST CFG_ADMIN_EMAILS CFG_LOCAL_AUTH CFG_EDGE CFG_EDGE_TLS CFG_ACME_EMAIL CFG_PROJECT CFG_EDGE_PROJECT CFG_HTTP_PORT CFG_IMAGE_PREFIX CFG_REPO_URL CFG_SYSTEM` и `OPT_PREFIX OPT_START`; массив `INSTALL_CONF_KEYS`; ассоциативный `INSTALL_ARGS`;
  - `install_defaults`; `parse_install_args "$@"` (ошибка — `die … 2`); `resolve_install_config <conf file>` (умолчания < файл < флаги); `write_install_conf <file>`; `validate_install_config` (печатает все ошибки, статус 2);
  - `app_settings` → строки `KEY=VALUE` для `.env`; `edge_services` → `caddy` и/или `cloudflared` по строке; `edge_profiles` → `caddy`, `tunnel` или `caddy,tunnel`; `required_owner_secrets` → строки `app <KEY>` / `edge <KEY>`;
  - `ssh_ports <sshd -T ports> <SSH_CONNECTION>`; `ufw_allowed_ports <ssh port...>`; `port_conflicts <port...>` (stdin — `ss -ltnpH`); `resource_shortfalls <cpus> <mem kB> <disk kB>`; `version_matches <sha-tag> <full sha>`; `render_unit <template> <prefix>`.

Матрица секретов владельца (что `install.sh` ждёт от `configure.sh`):

| Условие | Ключи |
|---|---|
| край включён, режим `cf` или `both` | `edge TUNNEL_TOKEN` |
| край включён, режим `direct` или `both`, `--edge-tls acme` | `edge DNS_API_TOKEN` |
| вход Google, режим `cf` или `both` | `app CF_ACCESS_ISSUER`, `app CF_ACCESS_AUDIENCE` |
| вход Google, режим `direct` или `both` | `app AUTH_GOOGLE_CLIENT_ID`, `app AUTH_GOOGLE_CLIENT_SECRET` |
| `--local-auth` | ничего из входа |

`--edge-tls internal` — внутренний CA Caddy вместо ACME: для стендов и e2e, где нет ни зоны DNS, ни токена.

- [ ] **Step 1: Написать падающие тесты**

`scripts/deploy/test/config.bats`:

```bash
#!/usr/bin/env bats
# install.sh input: flags, install.conf, validation and what follows from the sign-in mode.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  C=$BATS_TEST_TMPDIR/install.conf
  install_defaults
}

configure() {
  install_defaults
  parse_install_args "$@"
  resolve_install_config "$C"
}

keys_of() { awk '{print $2}' | sort | paste -sd' ' -; }

@test "flags fill the configuration, hosts and emails are lowercased" {
  configure --version sha-0123456789ab --signin direct --direct-host Panel.Example.com --admin-email 'Admin@Example.com, b@example.com'
  [ "$CFG_VERSION" = sha-0123456789ab ]
  [ "$CFG_SIGNIN" = direct ]
  [ "$CFG_DIRECT_HOST" = panel.example.com ]
  [ "$CFG_ADMIN_EMAILS" = admin@example.com,b@example.com ]
  [ "$CFG_PROJECT" = mailexpert ] && [ "$CFG_EDGE_PROJECT" = edge ] && [ "$CFG_HTTP_PORT" = 8080 ]
  [ "$CFG_EDGE" = 1 ] && [ "$CFG_EDGE_TLS" = acme ] && [ "$CFG_SYSTEM" = 1 ] && [ "$CFG_LOCAL_AUTH" = 0 ]
  [ "$CFG_IMAGE_PREFIX" = ghcr.io/wyrtensi ]
  [ "$OPT_PREFIX" = /opt/mailexpert ] && [ "$OPT_START" = 1 ]
}

@test "unknown flags and missing values exit 2" {
  run parse_install_args --bogus
  [ "$status" -eq 2 ]
  run parse_install_args --version
  [ "$status" -eq 2 ]
  run parse_install_args --version --signin cf
  [ "$status" -eq 2 ]
  [[ $output == *"--version needs a value"* ]]
}

@test "install.conf supplies what the flags omit, flags win" {
  printf 'VERSION=sha-0123456789ab\nSIGNIN=cf\nCF_HOST=cf.example.com\nHTTP_PORT=18080\n' >"$C"
  configure --signin both --direct-host panel.example.com
  [ "$CFG_VERSION" = sha-0123456789ab ]
  [ "$CFG_SIGNIN" = both ]
  [ "$CFG_CF_HOST" = cf.example.com ]
  [ "$CFG_DIRECT_HOST" = panel.example.com ]
  [ "$CFG_HTTP_PORT" = 18080 ]
}

@test "install.conf round-trips and never stores --prefix or --no-start" {
  configure --version sha-0123456789ab --signin direct --direct-host panel.example.com --local-auth --no-system --no-start --prefix /srv/me
  [ "$OPT_PREFIX" = /srv/me ] && [ "$OPT_START" = 0 ]
  write_install_conf "$C"
  run env_get "$C" PREFIX
  [ "$status" -eq 1 ]
  run env_get "$C" START
  [ "$status" -eq 1 ]
  configure
  [ "$CFG_SIGNIN" = direct ] && [ "$CFG_LOCAL_AUTH" = 1 ] && [ "$CFG_SYSTEM" = 0 ] && [ "$OPT_START" = 1 ]
}

@test "a complete install validates" {
  configure --version sha-0123456789ab --signin both --cf-host cf.example.com --direct-host panel.example.com --admin-email admin@example.com
  validate_install_config
  configure --version sha-0123456789ab --signin direct --direct-host panel.example.com --local-auth
  validate_install_config
}

expect_invalid() {
  local msg=$1
  shift
  configure "$@"
  run validate_install_config
  [ "$status" -eq 2 ] || { echo "accepted: $*"; return 1; }
  [[ $output == *"$msg"* ]] || { echo "unexpected message: $output"; return 1; }
}

@test "invalid input is reported with the flag to fix" {
  local ok=(--signin direct --direct-host panel.example.com --admin-email admin@example.com)
  expect_invalid "--version" --version sha-0123 "${ok[@]}"
  expect_invalid "--version" --version v3.3.0 "${ok[@]}"
  expect_invalid "--signin" --version sha-0123456789ab --signin tunnel --admin-email admin@example.com
  expect_invalid "--cf-host" --version sha-0123456789ab --signin cf --admin-email admin@example.com
  expect_invalid "--direct-host" --version sha-0123456789ab --signin direct --direct-host https://panel.example.com --admin-email admin@example.com
  expect_invalid "--direct-host" --version sha-0123456789ab --signin direct --direct-host bad_host.example.com --admin-email admin@example.com
  expect_invalid "must differ" --version sha-0123456789ab --signin both --cf-host a.example.com --direct-host a.example.com --admin-email admin@example.com
  expect_invalid "--admin-email is required" --version sha-0123456789ab --signin direct --direct-host panel.example.com
  expect_invalid "not an email" --version sha-0123456789ab --signin direct --direct-host panel.example.com --admin-email nobody
  expect_invalid "--http-port" --version sha-0123456789ab "${ok[@]}" --http-port 80
  expect_invalid "--project" --version sha-0123456789ab "${ok[@]}" --project MailExpert
  expect_invalid "must differ" --version sha-0123456789ab "${ok[@]}" --project edge
  expect_invalid "--edge-tls" --version sha-0123456789ab "${ok[@]}" --edge-tls letsencrypt
  expect_invalid "--prefix" --version sha-0123456789ab "${ok[@]}" --prefix relative/dir
}

@test "app_settings per sign-in mode" {
  configure --version sha-0123456789ab --signin cf --cf-host cf.example.com --admin-email admin@example.com
  run app_settings
  [[ $output == *$'\nAPP_URL=https://cf.example.com\nAPP_ALT_URLS=\nAUTH_MODE=google\n'* ]]
  [[ $output == *"GOOGLE_REDIRECT_URI=https://cf.example.com/oauth/google/callback"* ]]
  [[ $output == *"MAILEXPERT_VERSION=sha-0123456789ab"* ]]
  [[ $output == *"COMPOSE_PROJECT_NAME=mailexpert"* && $output == *"APP_HTTP_PORT=8080"* ]]
  configure --version sha-0123456789ab --signin both --cf-host cf.example.com --direct-host panel.example.com --admin-email admin@example.com
  run app_settings
  [[ $output == *$'APP_URL=https://cf.example.com\nAPP_ALT_URLS=https://panel.example.com\n'* ]]
  configure --version sha-0123456789ab --signin direct --direct-host panel.example.com --local-auth
  run app_settings
  [[ $output == *"APP_URL=https://panel.example.com"* && $output == *"AUTH_MODE=local"* ]]
}

@test "owner secrets required per mode" {
  configure --signin cf
  [ "$(required_owner_secrets | keys_of)" = "CF_ACCESS_AUDIENCE CF_ACCESS_ISSUER TUNNEL_TOKEN" ]
  configure --signin direct
  [ "$(required_owner_secrets | keys_of)" = "AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET DNS_API_TOKEN" ]
  configure --signin direct --edge-tls internal
  [ "$(required_owner_secrets | keys_of)" = "AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET" ]
  configure --signin both
  [ "$(required_owner_secrets | keys_of)" = "AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET CF_ACCESS_AUDIENCE CF_ACCESS_ISSUER DNS_API_TOKEN TUNNEL_TOKEN" ]
  configure --signin both --local-auth
  [ "$(required_owner_secrets | keys_of)" = "DNS_API_TOKEN TUNNEL_TOKEN" ]
  configure --signin both --local-auth --no-edge
  [ -z "$(required_owner_secrets)" ]
  configure --signin cf --no-edge
  [ "$(required_owner_secrets | keys_of)" = "CF_ACCESS_AUDIENCE CF_ACCESS_ISSUER" ]
  [ "$(required_owner_secrets | awk '$2 == "TUNNEL_TOKEN" || $2 == "DNS_API_TOKEN" {print $1}' | sort -u)" = "" ]
  configure --signin both
  [ "$(required_owner_secrets | awk '$2 ~ /TOKEN$/ {print $1}' | sort -u)" = edge ]
}

@test "edge services, profiles and firewall per mode" {
  configure --signin direct
  [ "$(edge_services | paste -sd' ' -)" = caddy ] && [ "$(edge_profiles)" = caddy ]
  [ "$(ufw_allowed_ports 22 | paste -sd' ' -)" = "22/tcp 80/tcp 443/tcp 443/udp" ]
  configure --signin cf
  [ "$(edge_services | paste -sd' ' -)" = cloudflared ] && [ "$(edge_profiles)" = tunnel ]
  [ "$(ufw_allowed_ports 22 2222 | paste -sd' ' -)" = "22/tcp 2222/tcp" ]
  configure --signin both
  [ "$(edge_services | paste -sd' ' -)" = "caddy cloudflared" ] && [ "$(edge_profiles)" = caddy,tunnel ]
  configure --signin both --no-edge
  [ -z "$(edge_services)" ] && [ -z "$(edge_profiles)" ]
  [ "$(ufw_allowed_ports 22 | paste -sd' ' -)" = "22/tcp" ]
}

@test "ssh_ports keeps 22 and adds the configured and the current session ports" {
  [ "$(ssh_ports "" "" | paste -sd' ' -)" = 22 ]
  [ "$(ssh_ports $'2222\n22' "203.0.113.5 50000 198.51.100.7 2200" | paste -sd' ' -)" = "22 2200 2222" ]
  [ "$(ssh_ports "not-a-port" "" | paste -sd' ' -)" = 22 ]
}

@test "port_conflicts ignores the edge's own caddy" {
  ss_out='LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=10,fd=6))
LISTEN 0 4096 [::]:443 [::]:* users:(("caddy",pid=11,fd=7))
LISTEN 0 100 0.0.0.0:25 0.0.0.0:* users:(("docker-proxy",pid=12,fd=4))
LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:*'
  [ "$(port_conflicts 80 443 <<<"$ss_out")" = "80 nginx" ]
  [ "$(port_conflicts 25 <<<"$ss_out")" = "25 docker-proxy" ]
  [ "$(port_conflicts 8080 <<<"$ss_out")" = "8080 unknown" ]
  [ -z "$(port_conflicts 443 993 <<<"$ss_out")" ]
}

@test "resource_shortfalls" {
  [ -z "$(resource_shortfalls 4 8000000 50000000)" ]
  [ -z "$(resource_shortfalls 2 3900000 21000000)" ]
  [ "$(resource_shortfalls 1 2000000 1000000 | wc -l)" -eq 3 ]
}

@test "version_matches compares the tag with the full sha" {
  version_matches sha-0123456789ab 0123456789abcdef0123456789abcdef01234567
  run ! version_matches sha-0123456789ab 1123456789abcdef0123456789abcdef01234567
  run ! version_matches sha-0123456789ab dev
  run ! version_matches latest 0123456789abcdef0123456789abcdef01234567
}

@test "render_unit substitutes the prefix" {
  printf 'ExecStart=@PREFIX@/app/x.sh --prefix @PREFIX@\n' >"$BATS_TEST_TMPDIR/u.service"
  [ "$(render_unit "$BATS_TEST_TMPDIR/u.service" /opt/mailexpert)" = "ExecStart=/opt/mailexpert/app/x.sh --prefix /opt/mailexpert" ]
}
```

- [ ] **Step 2: Запустить — должны упасть**

Run: `BATS`
Expected: `env.bats` проходит, `config.bats` — FAIL (`install_defaults: command not found`).

- [ ] **Step 3: Реализовать `scripts/deploy/lib/config.sh`**

```bash
# shellcheck shell=bash
# install.sh input: flags, <prefix>/install.conf, validation and everything derived from the
# sign-in mode. Pure functions: no Docker, no network, no writes except the file passed in.

# install.conf keys, in the order they are written. --prefix and --no-start are per run.
INSTALL_CONF_KEYS=(VERSION SIGNIN CF_HOST DIRECT_HOST ADMIN_EMAILS LOCAL_AUTH EDGE EDGE_TLS
  ACME_EMAIL PROJECT EDGE_PROJECT HTTP_PORT IMAGE_PREFIX REPO_URL SYSTEM)
declare -gA INSTALL_ARGS=()

# shellcheck disable=SC2034 # the CFG_* and OPT_* globals are read by install.sh and edge.sh
install_defaults() {
  CFG_VERSION='' CFG_SIGNIN='' CFG_CF_HOST='' CFG_DIRECT_HOST='' CFG_ADMIN_EMAILS='' CFG_ACME_EMAIL=''
  CFG_LOCAL_AUTH=0 CFG_EDGE=1 CFG_EDGE_TLS=acme CFG_SYSTEM=1
  CFG_PROJECT=mailexpert CFG_EDGE_PROJECT=edge CFG_HTTP_PORT=8080
  CFG_IMAGE_PREFIX=ghcr.io/wyrtensi CFG_REPO_URL=https://github.com/wyrtensi/MailExpert.git
  OPT_PREFIX=/opt/mailexpert OPT_START=1
}

# flag_key --cf-host -> CF_HOST; --admin-email -> ADMIN_EMAILS
flag_key() {
  local key=${1#--}
  key=${key//-/_}
  key=${key^^}
  if [ "$key" = ADMIN_EMAIL ]; then key=ADMIN_EMAILS; fi
  printf '%s\n' "$key"
}

parse_install_args() {
  INSTALL_ARGS=()
  while [ $# -gt 0 ]; do
    case $1 in
      --version | --signin | --cf-host | --direct-host | --admin-email | --acme-email | --edge-tls | \
        --project | --edge-project | --http-port | --image-prefix | --repo-url | --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ] || [[ $2 == --* ]]; then die "$1 needs a value" 2; fi
        INSTALL_ARGS[$(flag_key "$1")]=$2
        shift 2
        ;;
      --local-auth) INSTALL_ARGS[LOCAL_AUTH]=1 && shift ;;
      --no-edge) INSTALL_ARGS[EDGE]=0 && shift ;;
      --no-system) INSTALL_ARGS[SYSTEM]=0 && shift ;;
      --no-start) INSTALL_ARGS[START]=0 && shift ;;
      -h | --help) INSTALL_ARGS[HELP]=1 && shift ;;
      *) die "unknown option: $1 (see --help)" 2 ;;
    esac
  done
}

# resolve_install_config <install.conf>: defaults, then the file, then the flags.
resolve_install_config() {
  local conf=$1 key value
  install_defaults
  for key in "${INSTALL_CONF_KEYS[@]}"; do
    if [ -n "${INSTALL_ARGS[$key]+set}" ]; then
      value=${INSTALL_ARGS[$key]}
    elif ! value=$(env_get "$conf" "$key"); then
      continue
    fi
    printf -v "CFG_$key" '%s' "$value"
  done
  if [ -n "${INSTALL_ARGS[PREFIX]+set}" ]; then OPT_PREFIX=${INSTALL_ARGS[PREFIX]}; fi
  if [ -n "${INSTALL_ARGS[START]+set}" ]; then OPT_START=${INSTALL_ARGS[START]}; fi
  CFG_CF_HOST=${CFG_CF_HOST,,}
  CFG_DIRECT_HOST=${CFG_DIRECT_HOST,,}
  CFG_ADMIN_EMAILS=${CFG_ADMIN_EMAILS,,}
  CFG_ADMIN_EMAILS=${CFG_ADMIN_EMAILS// /}
  CFG_ACME_EMAIL=${CFG_ACME_EMAIL,,}
}

write_install_conf() {
  local file=$1 key var
  for key in "${INSTALL_CONF_KEYS[@]}"; do
    var=CFG_$key
    env_set "$file" "$key" "${!var}"
  done
}

# validate_install_config: prints every problem, returns 2 if there is any.
validate_install_config() {
  local -a errors=() emails=()
  local email
  [[ $CFG_VERSION =~ ^sha-[0-9a-f]{12}$ ]] ||
    errors+=("--version must be sha-<first 12 hex characters of the commit>")
  case $CFG_SIGNIN in
    cf | direct | both) ;;
    *) errors+=("--signin must be cf, direct or both") ;;
  esac
  if [[ $CFG_SIGNIN == cf || $CFG_SIGNIN == both ]] && ! is_hostname "$CFG_CF_HOST"; then
    errors+=("--cf-host must be a host name such as app.example.com")
  fi
  if [[ $CFG_SIGNIN == direct || $CFG_SIGNIN == both ]] && ! is_hostname "$CFG_DIRECT_HOST"; then
    errors+=("--direct-host must be a host name such as app.example.com")
  fi
  if [ "$CFG_SIGNIN" = both ] && [ -n "$CFG_CF_HOST" ] && [ "$CFG_CF_HOST" = "$CFG_DIRECT_HOST" ]; then
    errors+=("--cf-host and --direct-host must differ")
  fi
  if [ -n "$CFG_ADMIN_EMAILS" ]; then
    IFS=, read -r -a emails <<<"$CFG_ADMIN_EMAILS"
    for email in "${emails[@]}"; do
      is_email "$email" || errors+=("--admin-email: '$email' is not an email address")
    done
  elif [ "$CFG_LOCAL_AUTH" != 1 ]; then
    errors+=("--admin-email is required with Google sign-in: these accounts become the first admins")
  fi
  if [ -n "$CFG_ACME_EMAIL" ] && ! is_email "$CFG_ACME_EMAIL"; then
    errors+=("--acme-email: not an email address")
  fi
  case $CFG_EDGE_TLS in
    acme | internal) ;;
    *) errors+=("--edge-tls must be acme or internal") ;;
  esac
  [[ $CFG_LOCAL_AUTH =~ ^[01]$ && $CFG_EDGE =~ ^[01]$ && $CFG_SYSTEM =~ ^[01]$ ]] ||
    errors+=("install.conf: LOCAL_AUTH, EDGE and SYSTEM must be 0 or 1")
  is_name "$CFG_PROJECT" || errors+=("--project must be lowercase letters, digits, '-' or '_'")
  is_name "$CFG_EDGE_PROJECT" || errors+=("--edge-project must be lowercase letters, digits, '-' or '_'")
  [ "$CFG_PROJECT" != "$CFG_EDGE_PROJECT" ] || errors+=("--project and --edge-project must differ")
  is_port "$CFG_HTTP_PORT" || errors+=("--http-port must be a port from 1024 to 65535")
  [[ $CFG_IMAGE_PREFIX =~ ^[a-z0-9][a-z0-9._:/-]*[a-z0-9]$ ]] || errors+=("--image-prefix is not an image repository prefix")
  if [ -z "$CFG_REPO_URL" ] || ! env_value_ok "$CFG_REPO_URL"; then errors+=("--repo-url is empty or has spaces"); fi
  [[ $OPT_PREFIX =~ ^/[A-Za-z0-9._/-]+$ ]] || errors+=("--prefix must be an absolute path without spaces")
  if [ "${#errors[@]}" -gt 0 ]; then
    printf '[mailexpert] error: %s\n' "${errors[@]}" >&2
    return 2
  fi
}

# app_settings: the non-secret .env keys install.sh owns, as KEY=VALUE lines. They follow the
# configuration on every run.
app_settings() {
  local url='' alt='' auth=google
  case $CFG_SIGNIN in
    cf) url=https://$CFG_CF_HOST ;;
    direct) url=https://$CFG_DIRECT_HOST ;;
    both) url=https://$CFG_CF_HOST alt=https://$CFG_DIRECT_HOST ;;
  esac
  if [ "$CFG_LOCAL_AUTH" = 1 ]; then auth=local; fi
  printf '%s\n' \
    "MAILEXPERT_VERSION=$CFG_VERSION" \
    "MAILEXPERT_IMAGE_PREFIX=$CFG_IMAGE_PREFIX" \
    "COMPOSE_PROJECT_NAME=$CFG_PROJECT" \
    "APP_HTTP_PORT=$CFG_HTTP_PORT" \
    "APP_URL=$url" \
    "APP_ALT_URLS=$alt" \
    "AUTH_MODE=$auth" \
    "BOOTSTRAP_ADMIN_EMAILS=$CFG_ADMIN_EMAILS" \
    "GOOGLE_REDIRECT_URI=$url/oauth/google/callback"
}

# edge_services: the edge services this install runs, one per line.
edge_services() {
  [ "$CFG_EDGE" = 1 ] || return 0
  case $CFG_SIGNIN in
    direct) echo caddy ;;
    cf) echo cloudflared ;;
    both) printf '%s\n' caddy cloudflared ;;
  esac
}

# edge_profiles: COMPOSE_PROFILES for deploy/edge/compose.yml.
edge_profiles() {
  edge_services | sed 's/^cloudflared$/tunnel/' | paste -sd, -
}

# required_owner_secrets: "<app|edge> <KEY>" lines that configure.sh must provide.
required_owner_secrets() {
  local caddy=0 tunnel=0
  if [ "$CFG_EDGE" = 1 ]; then
    case $CFG_SIGNIN in
      direct) caddy=1 ;;
      cf) tunnel=1 ;;
      both) caddy=1 tunnel=1 ;;
    esac
  fi
  if [ "$tunnel" = 1 ]; then echo "edge TUNNEL_TOKEN"; fi
  if [ "$caddy" = 1 ] && [ "$CFG_EDGE_TLS" = acme ]; then echo "edge DNS_API_TOKEN"; fi
  if [ "$CFG_LOCAL_AUTH" != 1 ]; then
    if [[ $CFG_SIGNIN == cf || $CFG_SIGNIN == both ]]; then
      printf '%s\n' "app CF_ACCESS_ISSUER" "app CF_ACCESS_AUDIENCE"
    fi
    if [[ $CFG_SIGNIN == direct || $CFG_SIGNIN == both ]]; then
      printf '%s\n' "app AUTH_GOOGLE_CLIENT_ID" "app AUTH_GOOGLE_CLIENT_SECRET"
    fi
  fi
  return 0
}

# ssh_ports <ports from `sshd -T`> <$SSH_CONNECTION>: 22, the configured sshd ports and the
# server port of the current SSH session. Enabling ufw without them locks the owner out.
ssh_ports() {
  {
    echo 22
    tr -s ' \t' '\n\n' <<<"$1"
    if [ -n "$2" ]; then echo "${2##* }"; fi
  } | grep -E '^[0-9]{1,5}$' | sort -nu
}

# ufw_allowed_ports <ssh port...>: inbound ufw rules, one per line.
ufw_allowed_ports() {
  local port
  for port in "$@"; do printf '%s/tcp\n' "$port"; done
  if edge_services | grep -qx caddy; then printf '%s\n' 80/tcp 443/tcp 443/udp; fi
}

# port_conflicts <port...>: reads `ss -ltnpH` on stdin and prints "<port> <process>" for each
# listed port held by anything but the edge's own caddy.
port_conflicts() {
  local want=" $* " laddr rest port proc
  while read -r _ _ _ laddr _ rest; do
    port=${laddr##*:}
    case $want in
      *" $port "*) ;;
      *) continue ;;
    esac
    proc=$(sed -n 's/.*users:(("\([^"]*\)".*/\1/p' <<<"$rest")
    [ "$proc" = caddy ] && continue
    printf '%s %s\n' "$port" "${proc:-unknown}"
  done
}

# resource_shortfalls <cpus> <MemTotal kB> <free disk kB>: one line per shortfall. A "4 GB"
# server reports about 3.8-3.9 GB of MemTotal, hence the 3800 MB floor.
resource_shortfalls() {
  if [ "$1" -lt 2 ]; then echo "CPU: $1, at least 2 are needed"; fi
  if [ "$2" -lt $((3800 * 1024)) ]; then echo "memory: $(($2 / 1024)) MB, at least 4 GB is needed"; fi
  if [ "$3" -lt $((20 * 1024 * 1024)) ]; then echo "free disk: $(($3 / 1024 / 1024)) GB, at least 20 GB is needed"; fi
  return 0
}

# version_matches <sha-XXXXXXXXXXXX> <full sha from /api/version>
version_matches() {
  [[ $1 =~ ^sha-[0-9a-f]{12}$ ]] && [ "${2:0:12}" = "${1#sha-}" ]
}

# render_unit <template> <prefix>: a systemd unit with @PREFIX@ replaced.
render_unit() {
  local text
  text=$(<"$1")
  printf '%s\n' "${text//@PREFIX@/"$2"}"
}
```

- [ ] **Step 4: Запустить — должны пройти**

Run: `BATS`
Expected: PASS, все тесты `env.bats` и `config.bats`.

Run: `git add scripts/deploy && SC`
Expected: без замечаний. Строка `[ "$proc" = caddy ] && continue` внутри цикла допустима; если shellcheck выдаст что-то ещё — чинить код, не подавлять (кроме SC2034 на `install_defaults`, уже подавленного с причиной).

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/lib/config.sh scripts/deploy/test/config.bats
git commit -m "feat(deploy): parse and validate installer flags and derive the sign-in mode"
```

---

### Task 3: Край — compose-проект и шаблон Caddyfile

**Files:**
- Create: `deploy/edge/compose.yml`
- Create: `deploy/edge/Caddyfile.tmpl`
- Create: `scripts/deploy/lib/edge.sh`
- Create: `scripts/deploy/test/edge.bats`

**Interfaces:**
- Consumes: `CFG_*`, `edge_services`, `edge_profiles` (Task 2); `env_get`, `env_set`, `die` (Task 1); `deploy/edge/Dockerfile` (7a).
- Produces:
  - `caddy_site_address <host>` → `*.<родительская зона>` при трёх и более метках, иначе сам хост;
  - `render_caddyfile <template>` → Caddyfile для `CFG_DIRECT_HOST` в stdout;
  - `write_edge_files <app dir> <edge dir> <edge image>` — копирует `compose.yml`, пишет `Caddyfile` (только если среди сервисов есть caddy и содержимое изменилось), ставит в `edge/.env` ключи `COMPOSE_PROJECT_NAME`, `COMPOSE_PROFILES`, `EDGE_IMAGE`; выставляет глобальный `EDGE_CADDYFILE_CHANGED=0|1`;
  - файлы края в `<prefix>/edge/`: `compose.yml`, `Caddyfile`, `.env` (плюс `TUNNEL_TOKEN`, `DNS_API_TOKEN` от `configure.sh`, Task 4). Сервисы `caddy` (профиль `caddy`) и `cloudflared` (профиль `tunnel`), оба `network_mode: host`.

Решения: сайт — wildcard родительской зоны (так в спецификации: имя `<DIRECT_HOST>` не попадает в журналы Certificate Transparency), а отвечает Caddy только на `<DIRECT_HOST>`, остальным — `abort`. Admin API Caddy выключен (`admin off`: на host network он слушал бы `localhost:2019` хоста), поэтому изменённый Caddyfile применяется перезапуском контейнера. На 502-504 (панель остановлена при обновлении или переезде) — короткий текст с кодом 503, как требует раздел 5 спецификации.

- [ ] **Step 1: Написать падающие тесты**

`scripts/deploy/test/edge.bats`:

```bash
#!/usr/bin/env bats
# Edge files: the rendered Caddyfile and the edge compose project directory.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  install_defaults
  CFG_VERSION=sha-0123456789ab CFG_SIGNIN=direct CFG_DIRECT_HOST=panel.example.com
  T=$REPO_DIR/deploy/edge/Caddyfile.tmpl
  E=$BATS_TEST_TMPDIR/edge
}

@test "caddy_site_address uses the parent zone wildcard when there is one" {
  [ "$(caddy_site_address panel.example.com)" = '*.example.com' ]
  [ "$(caddy_site_address a.b.example.co.uk)" = '*.b.example.co.uk' ]
  [ "$(caddy_site_address example.com)" = example.com ]
}

@test "the DNS-01 Caddyfile" {
  run render_caddyfile "$T"
  [ "$status" -eq 0 ]
  [[ $output == *'*.example.com {'* ]]
  [[ $output == *'@app host panel.example.com'* ]]
  [[ $output == *'reverse_proxy 127.0.0.1:8080'* ]]
  [[ $output == *'dns cloudflare {env.DNS_API_TOKEN}'* ]]
  [[ $output == *'abort'* && $output == *'admin off'* ]]
  [[ $output != *'issuer internal'* && $output != *'email '* ]]
  run ! grep -E '@[A-Z_]+@' <<<"$output"
}

@test "the internal-CA Caddyfile with a custom port and an ACME email" {
  CFG_EDGE_TLS=internal CFG_HTTP_PORT=18080 CFG_ACME_EMAIL=ops@example.com
  run render_caddyfile "$T"
  [[ $output == *'issuer internal'* && $output != *'dns cloudflare'* ]]
  [[ $output == *'reverse_proxy 127.0.0.1:18080'* && $output == *'email ops@example.com'* ]]
}

@test "write_edge_files lays out the edge directory once" {
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  [ "$EDGE_CADDYFILE_CHANGED" = 1 ]
  cmp "$REPO_DIR/deploy/edge/compose.yml" "$E/compose.yml"
  [ "$(stat -c %a "$E")" = 700 ]
  [ "$(env_get "$E/.env" COMPOSE_PROJECT_NAME)" = edge ]
  [ "$(env_get "$E/.env" COMPOSE_PROFILES)" = caddy ]
  [ "$(env_get "$E/.env" EDGE_IMAGE)" = local.invalid/mailexpert-edge:sha-0123456789ab ]
  grep -q '@app host panel.example.com' "$E/Caddyfile"
  before=$(cat "$E/.env" "$E/Caddyfile" "$E/compose.yml" | sha256sum)
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  [ "$EDGE_CADDYFILE_CHANGED" = 0 ]
  [ "$(cat "$E/.env" "$E/Caddyfile" "$E/compose.yml" | sha256sum)" = "$before" ]
}

@test "write_edge_files keeps owner secrets and writes no Caddyfile for a tunnel-only edge" {
  mkdir -p "$E"
  printf 'TUNNEL_TOKEN=abc\n' >"$E/.env"
  CFG_SIGNIN=cf CFG_CF_HOST=cf.example.com
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  [ "$(env_get "$E/.env" TUNNEL_TOKEN)" = abc ]
  [ "$(env_get "$E/.env" COMPOSE_PROFILES)" = tunnel ]
  [ ! -e "$E/Caddyfile" ]
  [ "$EDGE_CADDYFILE_CHANGED" = 0 ]
}
```

- [ ] **Step 2: Запустить — должны упасть**

Run: `BATS`
Expected: FAIL в `edge.bats` (`caddy_site_address: command not found`, нет шаблона).

- [ ] **Step 3: Шаблоны края**

`deploy/edge/compose.yml`:

```yaml
# Edge of a MailExpert host: Caddy terminates TLS for <DIRECT_HOST>, cloudflared connects the
# Cloudflare tunnel for <CF_HOST>. Both use the host network and reach the panel on
# 127.0.0.1:<APP_HTTP_PORT>.
#
# A compose project of its own (default name "edge"): it outlives panel updates and, on a
# single server, will also front the mail node. install.sh copies this file to <prefix>/edge/
# and writes <prefix>/edge/.env: COMPOSE_PROJECT_NAME, COMPOSE_PROFILES (caddy, tunnel),
# EDGE_IMAGE (pinned by digest), and the secrets from configure.sh (DNS_API_TOKEN,
# TUNNEL_TOKEN). The public hostname of the tunnel (<CF_HOST> -> http://127.0.0.1:<port>) is
# set in Cloudflare Zero Trust, not here.

services:
  caddy:
    profiles: ["caddy"]
    image: ${EDGE_IMAGE:?set EDGE_IMAGE; install.sh pins it}
    restart: unless-stopped
    network_mode: host
    environment:
      DNS_API_TOKEN: ${DNS_API_TOKEN:-}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

  cloudflared:
    profiles: ["tunnel"]
    image: cloudflare/cloudflared:2026.9.1
    restart: unless-stopped
    network_mode: host
    command: ["tunnel", "--no-autoupdate", "run"]
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN:-}

volumes:
  caddy_data:
  caddy_config:
```

`deploy/edge/Caddyfile.tmpl` (отступы — табуляция):

```text
# Rendered by scripts/deploy/install.sh from deploy/edge/Caddyfile.tmpl; edits here are
# overwritten on the next run. The admin API is off: a restart of the caddy container applies
# a changed file.
{
	admin off
	@GLOBAL_EMAIL@
}

@SITE@ {
	tls {
		@TLS_ISSUER@
	}

	@app host @DIRECT_HOST@
	handle @app {
		reverse_proxy 127.0.0.1:@HTTP_PORT@
	}

	# Any other name covered by the certificate: drop the connection.
	handle {
		abort
	}

	# The panel is stopped for an update or a move.
	handle_errors 502 503 504 {
		respond "MailExpert is being updated or moved. Try again in a few minutes." 503
	}
}
```

- [ ] **Step 4: Реализовать `scripts/deploy/lib/edge.sh`**

```bash
# shellcheck shell=bash
# Files of the edge compose project in <prefix>/edge: compose.yml (copied from the checkout),
# Caddyfile (rendered from deploy/edge/Caddyfile.tmpl) and the non-secret keys of edge/.env.

# caddy_site_address <host>: the parent zone wildcard for hosts with three or more labels, which
# keeps the exact host name out of certificate transparency logs; otherwise the host itself.
caddy_site_address() {
  local parent=${1#*.}
  if [[ $parent == *.* ]]; then
    printf '*.%s\n' "$parent"
  else
    printf '%s\n' "$1"
  fi
}

# render_caddyfile <template>: the Caddyfile for CFG_DIRECT_HOST on stdout.
render_caddyfile() {
  local text issuer global='' site
  text=$(<"$1") || die "cannot read $1"
  case $CFG_EDGE_TLS in
    acme) issuer='dns cloudflare {env.DNS_API_TOKEN}' ;;
    internal) issuer='issuer internal' ;;
    *) die "unknown edge TLS mode: $CFG_EDGE_TLS" ;;
  esac
  if [ -n "$CFG_ACME_EMAIL" ]; then global="email $CFG_ACME_EMAIL"; fi
  site=$(caddy_site_address "$CFG_DIRECT_HOST")
  text=${text//@GLOBAL_EMAIL@/"$global"}
  text=${text//@SITE@/"$site"}
  text=${text//@DIRECT_HOST@/"$CFG_DIRECT_HOST"}
  text=${text//@HTTP_PORT@/"$CFG_HTTP_PORT"}
  text=${text//@TLS_ISSUER@/"$issuer"}
  printf '%s\n' "$text"
}

# write_edge_files <app dir> <edge dir> <edge image>: sets EDGE_CADDYFILE_CHANGED to 1 when the
# Caddyfile was written anew.
write_edge_files() {
  local app_dir=$1 edge_dir=$2 image=$3 env=$2/.env new
  EDGE_CADDYFILE_CHANGED=0
  mkdir -p "$edge_dir"
  chmod 700 "$edge_dir"
  cp "$app_dir/deploy/edge/compose.yml" "$edge_dir/compose.yml"
  env_set "$env" COMPOSE_PROJECT_NAME "$CFG_EDGE_PROJECT"
  new=$(edge_profiles)
  env_set "$env" COMPOSE_PROFILES "$new"
  env_set "$env" EDGE_IMAGE "$image"
  if edge_services | grep -qx caddy; then
    new=$(render_caddyfile "$app_dir/deploy/edge/Caddyfile.tmpl")
    if [ ! -f "$edge_dir/Caddyfile" ] || [ "$new" != "$(<"$edge_dir/Caddyfile")" ]; then
      printf '%s\n' "$new" >"$edge_dir/Caddyfile"
      EDGE_CADDYFILE_CHANGED=1
    fi
  fi
}
```

`EDGE_CADDYFILE_CHANGED` читает `install.sh`; если shellcheck отметит SC2034 на присваиваниях — подавить на функции с причиной `# read by install.sh`, как в Task 2.

- [ ] **Step 5: Запустить bats и shellcheck**

Run: `BATS`
Expected: PASS, все тесты трёх файлов.

Run: `git add deploy/edge scripts/deploy && SC`
Expected: без замечаний.

- [ ] **Step 6: Caddy принимает оба варианта Caddyfile**

```bash
docker build -t local.invalid/mailexpert-edge:dev7b deploy/edge
SCRATCH=$(mktemp -d)
for tls in acme internal; do
  bash -c 'source scripts/deploy/lib/common.sh; source scripts/deploy/lib/env.sh; source scripts/deploy/lib/config.sh; source scripts/deploy/lib/edge.sh
    install_defaults; CFG_DIRECT_HOST=panel.example.com CFG_EDGE_TLS='"$tls"' CFG_ACME_EMAIL=ops@example.com
    render_caddyfile deploy/edge/Caddyfile.tmpl' >"$SCRATCH/Caddyfile.$tls"
  docker run --rm --network none -e DNS_API_TOKEN="$(head -c 20 /dev/urandom | od -A n -v -t x1 | tr -d ' \n')" \
    -v "$(cygpath -w "$SCRATCH/Caddyfile.$tls"):/etc/caddy/Caddyfile:ro" \
    local.invalid/mailexpert-edge:dev7b caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
done
```

Expected: дважды `Valid configuration`. Токен — случайные 40 hex-символов: `caddy validate` провизионирует модуль DNS, сеть ему не нужна. Если модуль отвергает формат токена или `handle_errors` с кодами — остановиться и доложить (версия Caddy закреплена в 7a).

- [ ] **Step 7: Compose читает проект края в обоих режимах (только `config`)**

```bash
for mode in direct cf both; do
  bash -c 'source scripts/deploy/lib/common.sh; source scripts/deploy/lib/env.sh; source scripts/deploy/lib/config.sh; source scripts/deploy/lib/edge.sh
    install_defaults; CFG_SIGNIN='"$mode"' CFG_CF_HOST=cf.example.com CFG_DIRECT_HOST=panel.example.com CFG_EDGE_PROJECT=me7b-render
    write_edge_files "$(pwd)" "'"$SCRATCH/edge-$mode"'" local.invalid/mailexpert-edge:dev7b'
  docker compose -p me7b-render --project-directory "$SCRATCH/edge-$mode" --env-file "$SCRATCH/edge-$mode/.env" \
    -f "$SCRATCH/edge-$mode/compose.yml" config --services | sort | paste -sd' ' -
done
docker compose -p me7b-render --project-directory "$SCRATCH/edge-both" --env-file "$SCRATCH/edge-both/.env" \
  -f "$SCRATCH/edge-both/compose.yml" config | grep -E 'network_mode|image:'
```

Команды без `MSYS_NO_PATHCONV`: Git Bash сам переводит пути `/tmp/...` для `docker.exe`. `config` ничего не создаёт.
Expected: `caddy`, `cloudflared`, `caddy cloudflared`; затем два `network_mode: host`, `image: local.invalid/mailexpert-edge:dev7b` и `image: cloudflare/cloudflared:2026.9.1`. Если `config --services` показывает сервисы неактивных профилей — остановиться и доложить (на этом держится выбор сервисов через `COMPOSE_PROFILES`).

Run: `docker pull -q cloudflare/cloudflared:2026.9.1 && docker run --rm cloudflare/cloudflared:2026.9.1 --version`
Expected: `cloudflared version 2026.9.1 ...` — закреплённый тег существует.

- [ ] **Step 8: Commit**

```bash
git add deploy/edge/compose.yml deploy/edge/Caddyfile.tmpl scripts/deploy/lib/edge.sh scripts/deploy/test/edge.bats
git commit -m "feat(deploy): add the edge compose project and the Caddyfile template"
```

---

### Task 4: `configure.sh` — секреты владельца из stdin

**Files:**
- Create: `scripts/deploy/configure.sh`
- Create: `scripts/deploy/test/configure.bats`

**Interfaces:**
- Consumes: `env_get`, `env_set`, `env_value_ok`, `GENERATED_SECRET_KEYS`, `log`, `die` (Task 1).
- Produces: `configure.sh [--prefix /opt/mailexpert] < file` — строки `KEY=VALUE` из stdin; коды 0 (записано) и 2 (ничего не записано). Куда идут ключи:
  - `<prefix>/.env`, заменяются при повторной передаче (ротация): `CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE`, `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `HEALTHCHECK_PING_URL`;
  - `<prefix>/edge/.env`, заменяются: `TUNNEL_TOKEN`, `DNS_API_TOKEN`;
  - `<prefix>/.env`, только если ключа нет или значение то же: пять `GENERATED_SECRET_KEYS` (ручной перенос ключей до первой установки); другое значение — ошибка.
  Ключи restic добавит 7c. Значения не печатаются никогда, в том числе в сообщениях об ошибках: строка, которая не похожа на `KEY=VALUE` с ключом `[A-Z][A-Z0-9_]*`, описывается без содержимого (токен в base64 может кончаться на `=`).

- [ ] **Step 1: Написать падающие тесты**

`scripts/deploy/test/configure.bats`:

```bash
#!/usr/bin/env bats
# configure.sh: owner secrets from stdin, never from arguments, never printed.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  P=$BATS_TEST_TMPDIR/p
  CONFIGURE=$DEPLOY_DIR/configure.sh
}

@test "stores app and edge secrets in their files and prints no value" {
  run bash "$CONFIGURE" --prefix "$P" <<'EOF'
# owner secrets
CF_ACCESS_ISSUER=https://team-x.cloudflareaccess.com
CF_ACCESS_AUDIENCE=aud-value-123

TUNNEL_TOKEN=tunnel-value-456==
DNS_API_TOKEN=dns-value-789
HEALTHCHECK_PING_URL=https://hc-ping.example.com/ping-value-000
EOF
  [ "$status" -eq 0 ]
  [ "$(env_get "$P/.env" CF_ACCESS_AUDIENCE)" = aud-value-123 ]
  [ "$(env_get "$P/.env" HEALTHCHECK_PING_URL)" = https://hc-ping.example.com/ping-value-000 ]
  [ "$(env_get "$P/edge/.env" TUNNEL_TOKEN)" = tunnel-value-456== ]
  [ "$(env_get "$P/edge/.env" DNS_API_TOKEN)" = dns-value-789 ]
  run env_get "$P/.env" TUNNEL_TOKEN
  [ "$status" -eq 1 ]
  [[ $output != *value* ]]
  [ "$(stat -c %a "$P/.env")" = 600 ] && [ "$(stat -c %a "$P/edge/.env")" = 600 ] && [ "$(stat -c %a "$P/edge")" = 700 ]
}

@test "output never contains a value" {
  run bash "$CONFIGURE" --prefix "$P" <<<"AUTH_GOOGLE_CLIENT_SECRET=very-secret-value"
  [ "$status" -eq 0 ]
  [[ $output == *AUTH_GOOGLE_CLIENT_SECRET* && $output != *very-secret-value* ]]
}

@test "owner secrets are replaced on rotation" {
  bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN=old"
  bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN=new"
  [ "$(env_get "$P/edge/.env" TUNNEL_TOKEN)" = new ]
}

@test "CRLF input is accepted" {
  run bash "$CONFIGURE" --prefix "$P" <<<$'AUTH_GOOGLE_CLIENT_ID=id-1\r'
  [ "$status" -eq 0 ]
  [ "$(env_get "$P/.env" AUTH_GOOGLE_CLIENT_ID)" = id-1 ]
}

@test "one bad line writes nothing" {
  run bash "$CONFIGURE" --prefix "$P" <<<$'TUNNEL_TOKEN=good\nNOT_A_KEY=x'
  [ "$status" -eq 2 ]
  [[ $output == *NOT_A_KEY* ]]
  [ ! -e "$P/.env" ] && [ ! -e "$P/edge/.env" ]
}

@test "a line that is not KEY=VALUE is reported without its content" {
  run bash "$CONFIGURE" --prefix "$P" <<<"eyJhbGciOiJIUzI1NiJ9secretpart=="
  [ "$status" -eq 2 ]
  [[ $output != *secretpart* ]]
  run bash "$CONFIGURE" --prefix "$P" <<<"TUNNEL_TOKEN spacedsecret"
  [ "$status" -eq 2 ]
  [[ $output != *spacedsecret* ]]
}

@test "values with spaces or empty values are refused without echo" {
  run bash "$CONFIGURE" --prefix "$P" <<<"DNS_API_TOKEN=two words"
  [ "$status" -eq 2 ]
  [[ $output != *words* ]]
  run bash "$CONFIGURE" --prefix "$P" <<<"DNS_API_TOKEN="
  [ "$status" -eq 2 ]
}

@test "value checks for the Access issuer and the ping URL" {
  run bash "$CONFIGURE" --prefix "$P" <<<"CF_ACCESS_ISSUER=https://example.com"
  [ "$status" -eq 2 ]
  run bash "$CONFIGURE" --prefix "$P" <<<"HEALTHCHECK_PING_URL=http://hc.example.com/x"
  [ "$status" -eq 2 ]
}

@test "generated secrets: stored when absent, kept when equal, refused when different" {
  key=$(printf 'b%.0s' {1..64})
  run bash "$CONFIGURE" --prefix "$P" <<<"ENCRYPTION_KEY=$key"
  [ "$status" -eq 0 ]
  run bash "$CONFIGURE" --prefix "$P" <<<"ENCRYPTION_KEY=$key"
  [ "$status" -eq 0 ]
  [[ $output == *"ENCRYPTION_KEY: unchanged"* ]]
  before=$(sha256sum <"$P/.env")
  run bash "$CONFIGURE" --prefix "$P" <<<"ENCRYPTION_KEY=$(printf 'c%.0s' {1..64})"
  [ "$status" -eq 2 ]
  [[ $output != *cccc* && $output != *bbbb* ]]
  [ "$(sha256sum <"$P/.env")" = "$before" ]
}

@test "secrets as arguments are refused and not echoed" {
  run bash "$CONFIGURE" --prefix "$P" TUNNEL_TOKEN=argsecret
  [ "$status" -eq 2 ]
  [[ $output != *argsecret* ]]
  [ ! -e "$P/edge/.env" ]
}

@test "empty stdin is an error" {
  run bash "$CONFIGURE" --prefix "$P" </dev/null
  [ "$status" -eq 2 ]
}
```

- [ ] **Step 2: Запустить — должны упасть**

Run: `BATS`
Expected: FAIL в `configure.bats` (нет файла `configure.sh`).

- [ ] **Step 3: Реализовать `scripts/deploy/configure.sh`**

```bash
#!/usr/bin/env bash
# Stores the owner's secrets for install.sh: KEY=VALUE lines on stdin, one per line. Secrets are
# never accepted as arguments (shell history, process list, cloud-init user-data) and values are
# never printed.
#
#   ssh root@<host> /opt/mailexpert/app/scripts/deploy/configure.sh < secrets.env
#
# Exit codes: 0 stored, 2 nothing stored (every problem is listed).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"

# Owner secrets, replaced when given again (rotation).
APP_OWNER_KEYS=(CF_ACCESS_ISSUER CF_ACCESS_AUDIENCE AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET HEALTHCHECK_PING_URL)
EDGE_OWNER_KEYS=(TUNNEL_TOKEN DNS_API_TOKEN)

usage() {
  cat <<'EOF'
Usage: configure.sh [--prefix /opt/mailexpert] < file-with-KEY=VALUE-lines

Panel (<prefix>/.env):     CF_ACCESS_ISSUER, CF_ACCESS_AUDIENCE, AUTH_GOOGLE_CLIENT_ID,
                           AUTH_GOOGLE_CLIENT_SECRET, HEALTHCHECK_PING_URL
Edge (<prefix>/edge/.env): TUNNEL_TOKEN, DNS_API_TOKEN
Generated keys (SESSION_SECRET, ENCRYPTION_KEY, DB_PASSWORD, VAPID_PUBLIC_KEY,
VAPID_PRIVATE_KEY) are accepted only when absent or identical; they are never replaced.
Then run install.sh again.
EOF
}

# key_target <key>: app, edge or generated; status 1 for keys configure.sh does not store.
key_target() {
  local key=$1 known
  for known in "${APP_OWNER_KEYS[@]}"; do [ "$known" = "$key" ] && { echo app; return 0; }; done
  for known in "${EDGE_OWNER_KEYS[@]}"; do [ "$known" = "$key" ] && { echo edge; return 0; }; done
  for known in "${GENERATED_SECRET_KEYS[@]}"; do [ "$known" = "$key" ] && { echo generated; return 0; }; done
  return 1
}

# value_problem <key> <value>: prints what is wrong with the value, nothing when it is fine.
value_problem() {
  case $1 in
    CF_ACCESS_ISSUER) [[ $2 =~ ^https://[a-z0-9-]+\.cloudflareaccess\.com$ ]] || echo "must be https://<TEAM>.cloudflareaccess.com" ;;
    HEALTHCHECK_PING_URL) [[ $2 =~ ^https:// ]] || echo "must be an https:// URL" ;;
  esac
  return 0
}

main() {
  local prefix=/opt/mailexpert line key value target problem current file old i n=0
  local -a keys=() values=() targets=() errors=()
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      *) die "unexpected argument (not shown): secrets are read from stdin as KEY=VALUE lines, never from arguments" 2 ;;
    esac
  done
  [[ $prefix =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix must be an absolute path without spaces" 2
  if [ -t 0 ]; then log "paste KEY=VALUE lines, then press Ctrl-D"; fi

  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=${line%$'\r'}
    case $line in '' | '#'*) continue ;; esac
    key=${line%%=*}
    if [ "$key" = "$line" ] || ! [[ $key =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      errors+=("line $n is not KEY=VALUE (content not shown)")
      continue
    fi
    value=${line#*=}
    if ! target=$(key_target "$key"); then errors+=("$key: not a key configure.sh stores"); continue; fi
    if [ -z "$value" ]; then errors+=("$key: empty value"); continue; fi
    if ! env_value_ok "$value"; then
      errors+=("$key: the value must be one token without spaces, quotes, \$, # or backslash")
      continue
    fi
    problem=$(value_problem "$key" "$value")
    if [ -n "$problem" ]; then errors+=("$key: $problem"); continue; fi
    if [ "$target" = generated ]; then
      current=$(env_get "$prefix/.env" "$key") || current=
      if [ -n "$current" ] && [ "$current" != "$value" ]; then
        errors+=("$key: $prefix/.env already has a different value; generated secrets are never replaced")
        continue
      fi
    fi
    keys+=("$key") values+=("$value") targets+=("$target")
  done

  if [ "${#errors[@]}" -gt 0 ]; then
    printf '[mailexpert] error: %s\n' "${errors[@]}" >&2
    die "nothing was written" 2
  fi
  [ "${#keys[@]}" -gt 0 ] || die "no KEY=VALUE lines on stdin (see --help)" 2

  mkdir -p "$prefix/edge"
  chmod 700 "$prefix/edge"
  for i in "${!keys[@]}"; do
    if [ "${targets[i]}" = edge ]; then file=$prefix/edge/.env; else file=$prefix/.env; fi
    old=$(env_get "$file" "${keys[i]}") || old=
    if [ "$old" = "${values[i]}" ]; then
      log "${keys[i]}: unchanged"
    else
      env_set "$file" "${keys[i]}" "${values[i]}"
      log "${keys[i]}: stored in $file"
    fi
  done
  log "run install.sh again to apply"
}

main "$@"
exit $?
```

- [ ] **Step 4: Запустить**

Run: `git add scripts/deploy/configure.sh && git update-index --chmod=+x scripts/deploy/configure.sh && BATS`
Expected: PASS, все тесты четырёх файлов.

Run: `SC`
Expected: без замечаний.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/configure.sh scripts/deploy/test/configure.bats
git commit -m "feat(deploy): add configure.sh to take owner secrets from stdin"
```

---

### Task 5: Хост Ubuntu — пакеты, swap, файрвол, таймеры

**Files:**
- Create: `scripts/deploy/lib/system.sh`
- Create: `deploy/systemd/mailexpert-backup.service`, `deploy/systemd/mailexpert-backup.timer`
- Create: `deploy/systemd/mailexpert-health.service`, `deploy/systemd/mailexpert-health.timer`

**Interfaces:**
- Consumes: `log`, `warn`, `die`, `version_ge` (Task 1); `resource_shortfalls`, `ssh_ports`, `ufw_allowed_ports`, `render_unit` (Task 2); глобальные `OPT_PREFIX`, `APP_DIR`, `ENV_FILE`, `CFG_VERSION` (задаёт `install.sh`, Task 6).
- Produces: `check_os`, `check_resources`, `install_packages`, `ensure_docker_running`, `ensure_swap`, `enable_unattended_upgrades`, `apply_ufw`, `install_timers`. Контракт для 7c: таймер вызывает `<prefix>/app/scripts/deploy/backup.sh --prefix <prefix>` в 03:30 и `.../healthcheck.sh --prefix <prefix>` каждые 5 минут; `install_timers` включает таймер, только если его скрипт есть в выписанном коммите и исполняемый, иначе пишет, что пропускает. Так 7b ставит механизм, а 7c — скрипты, без таймеров, которые падают каждую ночь.

- [ ] **Step 1: Юниты systemd**

`deploy/systemd/mailexpert-backup.service`:

```ini
[Unit]
Description=MailExpert nightly backup
Wants=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
ExecStart=@PREFIX@/app/scripts/deploy/backup.sh --prefix @PREFIX@
Nice=10
IOSchedulingClass=idle
```

`deploy/systemd/mailexpert-backup.timer`:

```ini
[Unit]
Description=MailExpert nightly backup at 03:30 server time

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

`deploy/systemd/mailexpert-health.service`:

```ini
[Unit]
Description=MailExpert health check
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=@PREFIX@/app/scripts/deploy/healthcheck.sh --prefix @PREFIX@
```

`deploy/systemd/mailexpert-health.timer`:

```ini
[Unit]
Description=MailExpert health check every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

- [ ] **Step 2: Реализовать `scripts/deploy/lib/system.sh`**

```bash
# shellcheck shell=bash
# Setup of a dedicated Ubuntu 24.04 server. install.sh skips all of it with --no-system.

DOCKER_APT_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)

check_os() {
  local id version
  id=$(sed -n 's/^ID=//p' /etc/os-release 2>/dev/null | tr -d '"')
  version=$(sed -n 's/^VERSION_ID=//p' /etc/os-release 2>/dev/null | tr -d '"')
  if [ "$id" != ubuntu ] || [ "$version" != 24.04 ]; then
    die "Ubuntu 24.04 is required, found ${id:-unknown} ${version:-}; --no-system skips host setup"
  fi
}

# check_resources: fatal on the first install, a warning on reruns (data grows).
check_resources() {
  local dir=$OPT_PREFIX cpus mem_kb disk_kb short
  while [ ! -d "$dir" ]; do dir=$(dirname "$dir"); done
  cpus=$(nproc)
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  disk_kb=$(df -Pk "$dir" | awk 'NR == 2 {print $4}')
  short=$(resource_shortfalls "$cpus" "$mem_kb" "$disk_kb")
  [ -n "$short" ] || return 0
  short=$(paste -sd';' - <<<"$short")
  if [ -f "$ENV_FILE" ]; then warn "the host is below the minimum: $short"; else die "the host is too small: $short"; fi
}

install_packages() {
  local version arch codename
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git jq ufw iproute2 util-linux unattended-upgrades >/dev/null
  if version=$(docker compose version --short 2>/dev/null) && version_ge "$version" 2.24.4; then
    return 0
  fi
  if dpkg -s docker.io >/dev/null 2>&1; then
    die "docker.io from Ubuntu is installed and its Compose is too old; remove it (apt-get remove docker.io) and rerun"
  fi
  log "installing Docker Engine and Compose from download.docker.com"
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  arch=$(dpkg --print-architecture)
  codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release)
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$arch" "$codename" >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq "${DOCKER_APT_PACKAGES[@]}" >/dev/null
}

ensure_docker_running() {
  systemctl enable --now docker >/dev/null
}

ensure_swap() {
  [ -z "$(swapon --noheadings --show 2>/dev/null)" ] || return 0
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  log "swap: 2 GB in /swapfile"
}

enable_unattended_upgrades() {
  local file=/etc/apt/apt.conf.d/20auto-upgrades want
  want=$'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";'
  if [ ! -f "$file" ] || [ "$(<"$file")" != "$want" ]; then
    printf '%s\n' "$want" >"$file"
  fi
}

# apply_ufw: deny incoming except SSH and, when Caddy runs, 80/443. Docker publishes ports past
# ufw, which is why the panel publishes only on 127.0.0.1.
apply_ufw() {
  local conf rule
  local -a ports rules
  conf=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}') || conf=''
  mapfile -t ports < <(ssh_ports "$conf" "${SSH_CONNECTION:-}")
  mapfile -t rules < <(ufw_allowed_ports "${ports[@]}")
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  for rule in "${rules[@]}"; do ufw allow "$rule" >/dev/null; done
  ufw --force enable >/dev/null
  log "ufw: allowed ${rules[*]}"
}

# install_timers: a timer is enabled only when its script exists in the checked-out commit.
install_timers() {
  local name script unit
  for name in backup health; do
    case $name in
      backup) script=backup.sh ;;
      health) script=healthcheck.sh ;;
    esac
    if [ ! -x "$APP_DIR/scripts/deploy/$script" ]; then
      log "timer mailexpert-$name: skipped, $CFG_VERSION has no scripts/deploy/$script"
      continue
    fi
    for unit in service timer; do
      render_unit "$APP_DIR/deploy/systemd/mailexpert-$name.$unit" "$OPT_PREFIX" >"/etc/systemd/system/mailexpert-$name.$unit"
    done
    systemctl daemon-reload
    systemctl enable --now "mailexpert-$name.timer" >/dev/null
    log "timer mailexpert-$name: enabled"
  done
}
```

- [ ] **Step 3: shellcheck**

Run: `git add deploy/systemd scripts/deploy && SC`
Expected: без замечаний.

- [ ] **Step 4: Юниты проходят `systemd-analyze verify`**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/src:ro" ubuntu:24.04 bash -c '
  set -euo pipefail
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd >/dev/null
  source /src/scripts/deploy/lib/common.sh; source /src/scripts/deploy/lib/config.sh
  mkdir -p /opt/mailexpert/app/scripts/deploy
  for s in backup.sh healthcheck.sh; do printf "#!/bin/sh\n" >/opt/mailexpert/app/scripts/deploy/$s; chmod +x /opt/mailexpert/app/scripts/deploy/$s; done
  for f in /src/deploy/systemd/*; do render_unit "$f" /opt/mailexpert >/etc/systemd/system/$(basename "$f"); done
  systemd-analyze verify /etc/systemd/system/mailexpert-*.service /etc/systemd/system/mailexpert-*.timer && echo verified
  grep -h ExecStart /etc/systemd/system/mailexpert-*.service'
```

Expected: `verified`, затем две строки `ExecStart=/opt/mailexpert/app/scripts/deploy/{backup,healthcheck}.sh --prefix /opt/mailexpert`. Предупреждения systemd о среде контейнера (нет PID 1 systemd) допустимы, ошибки по нашим юнитам — нет.

- [ ] **Step 5: Пакеты ставятся на чистой Ubuntu 24.04, проверка ОС отличает версии**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/src:ro" ubuntu:24.04 bash -c '
  set -euo pipefail
  source /src/scripts/deploy/lib/common.sh; source /src/scripts/deploy/lib/system.sh
  check_os && echo os-ok
  install_packages
  echo "compose $(docker compose version --short)"; git --version; jq --version; command -v ss flock ufw'
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/src:ro" ubuntu:22.04 bash -c '
  source /src/scripts/deploy/lib/common.sh; source /src/scripts/deploy/lib/system.sh; check_os'; echo "exit $?"
```

Expected: `os-ok`; `compose` с версией не ниже 2.24.4 (пакет `docker-compose-plugin` из репозитория Docker); версии git и jq; пути к `ss`, `flock`, `ufw`. Для 22.04 — `error: Ubuntu 24.04 is required, found ubuntu 22.04` и `exit 1`. Нужен интернет (apt, download.docker.com); демон Docker в контейнере не запускается — проверяется только установка пакетов. Если `apt-get install` docker-ce падает на postinst в контейнере — остановиться и доложить с выводом.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy/lib/system.sh deploy/systemd
git commit -m "feat(deploy): add Ubuntu host setup and systemd timer units"
```

---

### Task 6: `install.sh` — оркестратор

**Files:**
- Create: `scripts/deploy/install.sh`
- Modify: `scripts/deploy/test/config.bats` (два теста на `install.sh`)

**Interfaces:**
- Consumes: всё из Task 1-5; `docker-compose.yml` и `deploy/compose.prod.yml` (7a); `/api/health/ready`, `/api/version` (7a).
- Produces: `install.sh` с флагами из `usage`; коды 0 / 1 / 2 / 3. Раскладка `<prefix>` (по умолчанию `/opt/mailexpert`): `install.conf`, `.env` (0600), `app/` (git checkout), `edge/` (0700: `compose.yml`, `Caddyfile`, `.env`), `backups/` (0700, для 7c), `state/` (0700: `install.lock`, `edge-local-root.crt` при `--edge-tls internal`). Команда compose панели: `docker compose -p <project> --project-directory <prefix>/app --env-file <prefix>/.env -f docker-compose.yml -f deploy/compose.prod.yml`; края: `docker compose -p <edge project> --project-directory <prefix>/edge --env-file <prefix>/edge/.env -f <prefix>/edge/compose.yml`. Их используют 7c (`update.sh`, `backup.sh`) и e2e.

Порядок шагов и отличия от списка в спецификации (все попадут в «Уточнения 7b»):

1. разбор и валидация до любых действий (ошибка — код 2, на хосте ничего не создано);
2. root; каталоги; блокировка `flock` на `state/install.lock` (два запуска одновременно не идут);
3. без `--no-system`: ОС, ресурсы, пакеты и Docker, `systemctl enable docker`, swap, `unattended-upgrades`;
4. инструменты (`git curl jq ss flock sha256sum`), Docker и Compose ≥ 2.24.4, порты: 80/443 заняты не нашим Caddy — ошибка; 25/465/587/993 заняты не контейнером — предупреждение (понадобятся почтовому узлу);
5. `install.conf` с итоговыми значениями; checkout коммита; если установщик в этом коммите отличается от запущенного — `exec` установщика коммита (cloud-init может клонировать `main`, а ставить другой коммит);
6. несекретные ключи `.env`; образы панели (локальный образ не скачивается) — **до** генерации секретов, потому что VAPID генерируется в образе backend;
7. защита данных: если том `<project>_postgres_data` уже есть, а в `.env` нет `DB_PASSWORD` или `ENCRYPTION_KEY` — ошибка (новые значения заперли бы данные);
8. генерация недостающих секретов; файлы края; нет секретов владельца — список и код 3;
9. `up -d` панели (не с `--no-start`), край (с `--no-start` без `cloudflared`: второй коннектор того же туннеля делил бы трафик со старым сервером при подготовке переезда), ufw;
10. проверки: `ready` за 180 с и `/api/version`; через Caddy `https://<DIRECT_HOST>/api/health` с `--resolve` на 127.0.0.1 (при `internal` — с корнем внутреннего CA из контейнера); для туннеля — что `cloudflared` запущен (снаружи его отсюда не проверить);
11. сообщение об администраторе; таймеры (без `--no-system`).

- [ ] **Step 1: Написать падающие тесты**

В конец `scripts/deploy/test/config.bats` добавить:

```bash
@test "install.sh --help prints the usage" {
  run bash "$DEPLOY_DIR/install.sh" --help
  [ "$status" -eq 0 ]
  [[ $output == *"Usage: install.sh"* ]]
}

@test "install.sh stops with 2 on invalid input before touching the host" {
  run bash "$DEPLOY_DIR/install.sh" --prefix "$BATS_TEST_TMPDIR/p" --version bad --signin direct --direct-host panel.example.com --admin-email admin@example.com
  [ "$status" -eq 2 ]
  [[ $output == *"--version"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/p" ]
}
```

Run: `BATS`
Expected: два новых теста FAIL (нет `install.sh`).

- [ ] **Step 2: Реализовать `scripts/deploy/install.sh`**

```bash
#!/usr/bin/env bash
# Installs MailExpert on a host or re-applies its configuration. Idempotent: every step checks
# what is already done; generated secrets are written once and never replaced. Owner secrets
# come from configure.sh, never from flags.
#
# Exit codes: 0 done, 1 failure, 2 invalid input, 3 waiting for secrets (run configure.sh).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"
# shellcheck source=lib/config.sh
. "$SCRIPT_DIR/lib/config.sh"
# shellcheck source=lib/edge.sh
. "$SCRIPT_DIR/lib/edge.sh"
# shellcheck source=lib/system.sh
. "$SCRIPT_DIR/lib/system.sh"

READY_TIMEOUT=180
EDGE_TIMEOUT=180
ORIG_ARGS=("$@")
LOADED_HASH=$(cat "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR"/lib/*.sh | sha256sum)

usage() {
  cat <<'EOF'
Usage: install.sh --version sha-<commit> --signin cf|direct|both
                  [--cf-host <CF_HOST>] [--direct-host <DIRECT_HOST>]
                  [--admin-email <email>[,<email>]] [--local-auth]
                  [--no-edge] [--edge-tls acme|internal] [--acme-email <email>]
                  [--prefix /opt/mailexpert] [--project mailexpert] [--edge-project edge]
                  [--http-port 8080] [--image-prefix ghcr.io/wyrtensi] [--repo-url <git url>]
                  [--no-system] [--no-start]

--version       image tag sha-<first 12 characters of the commit>; that commit is checked out
--signin        cf: <CF_HOST> through the Cloudflare tunnel and Access; direct: <DIRECT_HOST>
                through Caddy with "Sign in with Google"; both: both hosts
--local-auth    username and password sign-in instead of Google (test stands)
--no-edge       run neither Caddy nor cloudflared
--edge-tls      acme (default): certificate through Cloudflare DNS-01;
                internal: Caddy's own CA (test stands)
--no-system     skip Ubuntu checks, packages, swap, ufw and timers
--no-start      prepare everything, start neither the panel nor the tunnel (before a move)

Values are stored in <prefix>/install.conf: a rerun without flags repeats the last install.
Secrets are never flags: add them with configure.sh (stdin).
Exit codes: 0 done, 1 failure, 2 invalid input, 3 waiting for secrets from configure.sh.
EOF
}

app_compose() {
  docker compose -p "$CFG_PROJECT" --project-directory "$APP_DIR" --env-file "$ENV_FILE" \
    -f "$APP_DIR/docker-compose.yml" -f "$APP_DIR/deploy/compose.prod.yml" "$@"
}

edge_compose() {
  docker compose -p "$CFG_EDGE_PROJECT" --project-directory "$EDGE_DIR" --env-file "$EDGE_ENV" \
    -f "$EDGE_DIR/compose.yml" "$@"
}

prepare_dirs() {
  mkdir -p "$OPT_PREFIX" "$APP_DIR" "$EDGE_DIR" "$OPT_PREFIX/backups" "$STATE_DIR"
  chmod 755 "$OPT_PREFIX"
  chmod 700 "$EDGE_DIR" "$OPT_PREFIX/backups" "$STATE_DIR"
}

lock_install() {
  command -v flock >/dev/null || die "flock is required"
  exec 9>"$STATE_DIR/install.lock"
  flock -n 9 || die "another install.sh is running"
}

check_tools() {
  local tool
  for tool in git curl jq ss sha256sum; do
    command -v "$tool" >/dev/null || die "$tool is required"
  done
}

check_docker() {
  local version
  command -v docker >/dev/null || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
  version=$(docker compose version --short 2>/dev/null) || die "docker compose v2 is not installed"
  version_ge "$version" 2.24.4 || die "docker compose $version is too old, 2.24.4 or newer is needed"
}

check_ports() {
  local listening conflicts
  listening=$(ss -ltnpH)
  if edge_services | grep -qx caddy; then
    conflicts=$(port_conflicts 80 443 <<<"$listening" | sort -u)
    [ -z "$conflicts" ] || die "ports for the edge are taken: $(paste -sd';' - <<<"$conflicts")"
  fi
  conflicts=$(port_conflicts 25 465 587 993 <<<"$listening" | awk '$2 != "docker-proxy"' | sort -u)
  [ -z "$conflicts" ] || warn "mail ports are taken outside Docker: $(paste -sd';' - <<<"$conflicts"); the mail node needs them"
}

checkout_code() {
  local commit=${CFG_VERSION#sha-} full
  if [ ! -d "$APP_DIR/.git" ]; then
    log "cloning $CFG_REPO_URL"
    git clone --quiet "$CFG_REPO_URL" "$APP_DIR"
  elif [ "$(git -C "$APP_DIR" remote get-url origin)" != "$CFG_REPO_URL" ]; then
    git -C "$APP_DIR" remote set-url origin "$CFG_REPO_URL"
  fi
  if ! git -C "$APP_DIR" rev-parse --verify --quiet "$commit^{commit}" >/dev/null; then
    git -C "$APP_DIR" fetch --quiet origin
  fi
  full=$(git -C "$APP_DIR" rev-parse --verify --quiet "$commit^{commit}") || die "commit $commit is not in $CFG_REPO_URL"
  if [ "$(git -C "$APP_DIR" rev-parse HEAD)" != "$full" ]; then
    [ -z "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ] ||
      die "$APP_DIR has local changes; refusing to switch commits"
    git -C "$APP_DIR" checkout --quiet --detach "$full"
    log "checked out $full"
  fi
}

# maybe_reexec: continue with the installer of the checked-out commit when it differs from the
# one running (for example cloud-init cloned main but installs an older or newer commit).
maybe_reexec() {
  local target=$APP_DIR/scripts/deploy target_hash
  [ -f "$target/install.sh" ] || die "commit $CFG_VERSION has no scripts/deploy/install.sh"
  [ -z "${MAILEXPERT_INSTALL_REEXEC:-}" ] || return 0
  target_hash=$(cat "$target/install.sh" "$target"/lib/*.sh | sha256sum)
  [ "$target_hash" != "$LOADED_HASH" ] || return 0
  log "continuing with the installer of $CFG_VERSION"
  exec 9>&-
  export MAILEXPERT_INSTALL_REEXEC=1
  exec bash "$target/install.sh" "${ORIG_ARGS[@]}"
}

write_app_settings() {
  local line subject url
  while IFS= read -r line; do
    env_set "$ENV_FILE" "${line%%=*}" "${line#*=}"
  done < <(app_settings)
  subject=$(env_get "$ENV_FILE" VAPID_SUBJECT) || subject=''
  if [ -z "$subject" ]; then
    url=$(env_get "$ENV_FILE" APP_URL)
    env_set "$ENV_FILE" VAPID_SUBJECT "$url"
  fi
}

ensure_image() {
  if docker image inspect "$1" >/dev/null 2>&1; then return 0; fi
  log "pulling $1"
  docker pull --quiet "$1" >/dev/null || die "cannot pull $1 (emergency build from source: see deploy/compose.prod.yml)"
}

ensure_app_images() {
  BACKEND_IMAGE=$CFG_IMAGE_PREFIX/mailexpert-backend:$CFG_VERSION
  ensure_image "$BACKEND_IMAGE"
  ensure_image "$CFG_IMAGE_PREFIX/mailexpert-frontend:$CFG_VERSION"
}

# pinned_edge_image: the EDGE_IMAGE to keep. A digest stays as it is; a tag becomes its digest
# once the image is local and has one (a locally built image has none and keeps its tag).
pinned_edge_image() {
  local image digest
  image=$(env_get "$EDGE_ENV" EDGE_IMAGE) || image=''
  [ -n "$image" ] || image=$CFG_IMAGE_PREFIX/mailexpert-edge:$CFG_VERSION
  if edge_services | grep -qx caddy; then
    ensure_image "$image"
    if [[ $image != *@sha256:* ]]; then
      digest=$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$image")
      [ -z "$digest" ] || image=$digest
    fi
  fi
  printf '%s\n' "$image"
}

guard_existing_database() {
  local missing
  docker volume inspect "${CFG_PROJECT}_postgres_data" >/dev/null 2>&1 || return 0
  missing=$(env_missing "$ENV_FILE" DB_PASSWORD ENCRYPTION_KEY)
  [ -z "$missing" ] ||
    die "volume ${CFG_PROJECT}_postgres_data exists but $ENV_FILE has no $(paste -sd' ' - <<<"$missing"): new values would lock the data out; restore .env from a backup"
}

require_owner_secrets() {
  local where key file value missing=''
  while read -r where key; do
    if [ "$where" = edge ]; then file=$EDGE_ENV; else file=$ENV_FILE; fi
    value=$(env_get "$file" "$key") || value=''
    [ -n "$value" ] || missing+=" $key"
  done < <(required_owner_secrets)
  [ -n "$missing" ] || return 0
  log "waiting for secrets:$missing"
  log "add them as KEY=VALUE lines: $APP_DIR/scripts/deploy/configure.sh --prefix $OPT_PREFIX < <file>"
  log "then run install.sh again"
  exit 3
}

app_up() {
  log "starting the panel (compose project $CFG_PROJECT)"
  app_compose up -d --quiet-pull
}

edge_up() {
  local services service
  local -a targets=()
  [ "$CFG_EDGE" = 1 ] || return 0
  services=$(edge_services)
  for service in caddy cloudflared; do
    if ! grep -qx "$service" <<<"$services"; then
      edge_compose --profile caddy --profile tunnel rm --stop --force "$service" >/dev/null
    fi
  done
  if grep -qx caddy <<<"$services"; then targets+=(caddy); fi
  if grep -qx cloudflared <<<"$services" && [ "$OPT_START" = 1 ]; then targets+=(cloudflared); fi
  [ "${#targets[@]}" -gt 0 ] || return 0
  edge_compose up -d --quiet-pull "${targets[@]}"
  if [ "$EDGE_CADDYFILE_CHANGED" = 1 ] && grep -qx caddy <<<"$services"; then
    edge_compose restart caddy >/dev/null
  fi
}

wait_ready() {
  local base=http://127.0.0.1:$CFG_HTTP_PORT deadline=$((SECONDS + READY_TIMEOUT)) sha
  until curl -fs -o /dev/null "$base/api/health/ready"; do
    [ "$SECONDS" -lt "$deadline" ] || die "the panel is not ready after ${READY_TIMEOUT}s; see: docker compose -p $CFG_PROJECT logs backend"
    sleep 3
  done
  sha=$(curl -fsS "$base/api/version" | jq -r .sha)
  version_matches "$CFG_VERSION" "$sha" || die "the running build is $sha, not $CFG_VERSION"
  log "panel ready on 127.0.0.1:$CFG_HTTP_PORT, build $sha"
}

edge_probe() {
  local host=$CFG_DIRECT_HOST root=$STATE_DIR/edge-local-root.crt
  local -a tls=()
  if [ "$CFG_EDGE_TLS" = internal ]; then
    edge_compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$root" 2>/dev/null || return 1
    tls=(--cacert "$root")
  fi
  curl -fs -o /dev/null "${tls[@]}" --resolve "$host:443:127.0.0.1" "https://$host/api/health"
}

verify_edge() {
  local services deadline=$((SECONDS + EDGE_TIMEOUT))
  [ "$CFG_EDGE" = 1 ] || return 0
  services=$(edge_services)
  if grep -qx cloudflared <<<"$services"; then
    edge_compose ps --status running --services | grep -qx cloudflared ||
      die "cloudflared is not running; see: docker compose -p $CFG_EDGE_PROJECT logs cloudflared"
    log "tunnel connector running; in Zero Trust the public hostname $CFG_CF_HOST must point to http://127.0.0.1:$CFG_HTTP_PORT"
  fi
  grep -qx caddy <<<"$services" || return 0
  until edge_probe; do
    [ "$SECONDS" -lt "$deadline" ] || die "https://$CFG_DIRECT_HOST does not answer through Caddy after ${EDGE_TIMEOUT}s; see: docker compose -p $CFG_EDGE_PROJECT logs caddy"
    sleep 5
  done
  log "edge: https://$CFG_DIRECT_HOST answers through Caddy"
}

admin_notice() {
  local url
  url=$(env_get "$ENV_FILE" APP_URL)
  if [ "$CFG_LOCAL_AUTH" = 1 ]; then
    log "local sign-in: the first account registered at $url becomes the admin"
  else
    log "Google sign-in: $CFG_ADMIN_EMAILS become admins at their first sign-in at $url"
  fi
}

main() {
  local edge_image
  parse_install_args "$@"
  if [ -n "${INSTALL_ARGS[HELP]+set}" ]; then
    usage
    return 0
  fi
  resolve_install_config "${INSTALL_ARGS[PREFIX]:-/opt/mailexpert}/install.conf"
  validate_install_config || exit 2
  APP_DIR=$OPT_PREFIX/app EDGE_DIR=$OPT_PREFIX/edge STATE_DIR=$OPT_PREFIX/state
  ENV_FILE=$OPT_PREFIX/.env EDGE_ENV=$OPT_PREFIX/edge/.env

  [ "$(id -u)" = 0 ] || die "run install.sh as root"
  prepare_dirs
  lock_install
  if [ "$CFG_SYSTEM" = 1 ]; then
    check_os
    check_resources
    install_packages
    ensure_docker_running
    ensure_swap
    enable_unattended_upgrades
  fi
  check_tools
  check_docker
  check_ports

  write_install_conf "$OPT_PREFIX/install.conf"
  chmod 600 "$OPT_PREFIX/install.conf"
  checkout_code
  maybe_reexec

  write_app_settings
  ensure_app_images
  guard_existing_database
  generate_app_secrets "$ENV_FILE"
  if [ "$CFG_EDGE" = 1 ]; then
    edge_image=$(pinned_edge_image)
    write_edge_files "$APP_DIR" "$EDGE_DIR" "$edge_image"
  fi
  require_owner_secrets

  if [ "$OPT_START" = 1 ]; then app_up; fi
  edge_up
  if [ "$CFG_SYSTEM" = 1 ]; then apply_ufw; fi
  if [ "$OPT_START" = 1 ]; then
    wait_ready
    verify_edge
  fi
  admin_notice
  if [ "$CFG_SYSTEM" = 1 ]; then install_timers; fi
  log "done"
}

# One line: bash has read it whole before main runs, so a checkout that rewrites this file
# cannot change what the running shell executes next.
main "$@"; exit $?
```

- [ ] **Step 3: Запустить bats и shellcheck**

Run: `git add scripts/deploy/install.sh && git update-index --chmod=+x scripts/deploy/install.sh && BATS`
Expected: PASS, все тесты, включая два новых.

Run: `SC`
Expected: без замечаний. Глобальные `APP_DIR`, `EDGE_DIR`, `STATE_DIR`, `ENV_FILE`, `EDGE_ENV`, `BACKEND_IMAGE` читаются в `system.sh`/`env.sh`: shellcheck видит их, потому что `install.sh` проверяется вместе с библиотеками; если он всё же выдаёт SC2154 в библиотеках — `# shellcheck disable=SC2154 # set by install.sh` на функции с причиной, другие подавления — доложить.

- [ ] **Step 4: VAPID в образе backend**

```bash
docker build -f backend/Dockerfile --build-arg BUILD_SHA="$(git rev-parse HEAD)" -t local.invalid/mailexpert-backend:dev7b .
BACKEND_IMAGE=local.invalid/mailexpert-backend:dev7b bash -c 'source scripts/deploy/lib/common.sh; source scripts/deploy/lib/env.sh; gen_vapid_pair' \
  | awk '{print length($1), length($2), ($1 ~ /^[A-Za-z0-9_-]+$/ && $2 ~ /^[A-Za-z0-9_-]+$/) ? "base64url" : "BAD"}'
```

Expected: `87 43 base64url` (публичный ключ — 65 байт, приватный — 32 байта в base64url без выравнивания). Сами ключи не выводятся. Если `require('web-push')` не находится из `-e` (пакет `"type": "module"`) — остановиться и доложить, не ставить пакет отдельно.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/install.sh scripts/deploy/test/config.bats
git commit -m "feat(deploy): add install.sh"
```

---

### Task 7: e2e установки в Docker-in-Docker и CI

**Files:**
- Create: `scripts/deploy/test/e2e.sh`
- Create: `scripts/deploy/test/e2e-install.sh`
- Modify: `.github/workflows/ci.yml` (задание `deploy-e2e`; `images` ждёт его)

**Interfaces:**
- Consumes: `install.sh`, `configure.sh`, библиотеки (Task 1-6); образы `<prefix>/mailexpert-{backend,frontend,edge}:sha-<12>`, собранные из HEAD.
- Produces: `e2e.sh --version sha-<12> --image-prefix <prefix>` (на хосте; переменные `E2E_ID` — суффикс имени контейнера, `E2E_KEEP=1` — не удалять контейнер для разбора); `e2e-install.sh --version --image-prefix --repo-url` (внутри dind). 7c добавит свой сценарий рядом и вызов в `e2e.sh`.

Изоляция: на хосте создаётся один привилегированный контейнер `me-e2e-<id>` из `docker:29.8.1-dind` без опубликованных портов; внутри — свой демон Docker, куда загружаются образы (`docker save | docker load`), и туда же git bundle с HEAD. Установщик, compose, Caddy на host network (порты 80/443 — внутри контейнера) работают только с внутренним демоном. Внутри сценарий дополнительно отказывается работать с именами проектов `mailexpert`/`edge` и с непустыми проектами, а в конце удаляет свои контейнеры, тома и сети по метке `com.docker.compose.project`. Контейнер `me-e2e-<id>` удаляется `docker rm -fv` вместе с анонимным томом `/var/lib/docker`.

Что проверяет e2e:

| Сценарий | Проверка |
|---|---|
| первый запуск, режим `direct`, `--edge-tls internal`, вход Google, без секретов владельца | код 3; в выводе `AUTH_GOOGLE_CLIENT_ID/SECRET`, нет `DNS_API_TOKEN`; в `.env` пять сгенерированных ключей нужного вида, режим 0600; панель не запущена |
| `configure.sh` | другой `ENCRYPTION_KEY` — код 2, `.env` без изменений; фиктивные `AUTH_GOOGLE_*` записаны, значение в выводе не появилось |
| второй запуск без флагов (из `install.conf`) | код 0; `ready`; `/api/version` = HEAD; frontend опубликован только на `127.0.0.1:18080`; через Caddy по TLS внутреннего CA: `/api/auth/config` → `google`, `googleSignIn: true`; другое имя под wildcard — соединение сброшено; порт 80 — `308` на https; `APP_URL`, `GOOGLE_REDIRECT_URI`; сгенерированные секреты те же |
| третий запуск | файлы конфигурации побайтно те же; контейнеры не пересозданы и не перезапущены (`Id`, `StartedAt`); проверка портов пропускает собственный Caddy |
| потерян `DB_PASSWORD` при существующем томе | код 1 и имя ключа; контейнеры не тронуты |
| режимы `cf` и `both` | только рендер: `docker compose config --services` даёт `cloudflared` / `caddy cloudflared`; `caddy validate` принимает Caddyfile с DNS-01 |

Не покрыто (в отчёте и в спецификации): проверка Ubuntu и ресурсов (только bats), установка пакетов и Docker (только смоук Task 5 в контейнере Ubuntu), swap, `unattended-upgrades`, применение ufw, срабатывание таймеров systemd (только `systemd-analyze verify`), реальный ACME DNS-01 в Cloudflare, реальное соединение туннеля, вход через Access и Google, скачивание образов из GHCR (образы локальные), перезапуск установщика другого коммита (`maybe_reexec`).

- [ ] **Step 1: Сценарий внутри dind — `scripts/deploy/test/e2e-install.sh`**

```bash
#!/usr/bin/env bash
# Install scenario of the deploy e2e test. Runs inside the throwaway Docker-in-Docker container
# started by e2e.sh and must never run on a host with real data. Everything it creates belongs
# to the compose projects me-e2e and me-e2e-edge and to /e2e, and is removed at exit.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd "$TEST_DIR/.." && pwd)
REPO_DIR=$(cd "$DEPLOY_DIR/../.." && pwd)
# shellcheck source=../lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=../lib/env.sh
. "$DEPLOY_DIR/lib/env.sh"
# shellcheck source=../lib/config.sh
. "$DEPLOY_DIR/lib/config.sh"
# shellcheck source=../lib/edge.sh
. "$DEPLOY_DIR/lib/edge.sh"

PROJECT=me-e2e
EDGE_PROJECT=me-e2e-edge
PORT=18080
PREFIX=/e2e/prefix
RENDER=/e2e/render
HOST=panel.example.test
VERSION='' IMAGE_PREFIX='' REPO_URL=''

while [ $# -gt 0 ]; do
  case $1 in
    --version) VERSION=$2 && shift 2 ;;
    --image-prefix) IMAGE_PREFIX=$2 && shift 2 ;;
    --repo-url) REPO_URL=$2 && shift 2 ;;
    *) die "unknown option: $1" 2 ;;
  esac
done
if [ -z "$VERSION" ] || [ -z "$IMAGE_PREFIX" ] || [ -z "$REPO_URL" ]; then
  die "--version, --image-prefix and --repo-url are required" 2
fi

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

for p in "$PROJECT" "$EDGE_PROJECT"; do
  case $p in mailexpert | edge) fail "refusing to run as project $p" ;; esac
  [ -z "$(labelled ps "$p")$(labelled volume "$p")" ] || fail "project $p already has containers or volumes"
done
[ ! -e "$PREFIX" ] || fail "$PREFIX already exists"

teardown() {
  local status=$? p
  for p in "$PROJECT" "$EDGE_PROJECT"; do
    labelled ps "$p" | xargs -r docker rm -fv >/dev/null
    labelled volume "$p" | xargs -r docker volume rm >/dev/null
    labelled network "$p" | xargs -r docker network rm >/dev/null
  done
  rm -rf "$PREFIX" "$RENDER"
  exit "$status"
}
trap teardown EXIT

install_run() { bash "$DEPLOY_DIR/install.sh" "$@"; }

generated_secrets() {
  local key
  for key in "${GENERATED_SECRET_KEYS[@]}"; do
    printf '%s=%s\n' "$key" "$(env_get "$PREFIX/.env" "$key")"
  done | sha256sum
}

config_files_hash() {
  sha256sum "$PREFIX/.env" "$PREFIX/install.conf" "$PREFIX/edge/.env" "$PREFIX/edge/Caddyfile" "$PREFIX/edge/compose.yml"
}

containers_state() {
  { labelled ps "$PROJECT"; labelled ps "$EDGE_PROJECT"; } |
    xargs -r docker inspect --format '{{.Name}} {{.Id}} {{.State.StartedAt}}' | sort
}

# 1. First run: secrets are generated, nothing starts, exit 3 lists the owner secrets.
set +e
out=$(install_run --prefix "$PREFIX" --version "$VERSION" --image-prefix "$IMAGE_PREFIX" --repo-url "$REPO_URL" \
  --project "$PROJECT" --edge-project "$EDGE_PROJECT" --http-port "$PORT" --no-system \
  --signin direct --direct-host "$HOST" --edge-tls internal --admin-email admin@example.test 2>&1)
code=$?
set -e
printf '%s\n' "$out"
[ "$code" = 3 ] || fail "first run exited $code, expected 3"
[[ $out == *AUTH_GOOGLE_CLIENT_ID* && $out == *AUTH_GOOGLE_CLIENT_SECRET* ]] || fail "the missing secrets are not listed"
[[ $out != *DNS_API_TOKEN* ]] || fail "DNS_API_TOKEN must not be required with --edge-tls internal"
[[ $(env_get "$PREFIX/.env" SESSION_SECRET) =~ ^[0-9a-f]{64}$ ]] || fail "SESSION_SECRET"
[[ $(env_get "$PREFIX/.env" ENCRYPTION_KEY) =~ ^[0-9a-f]{64}$ ]] || fail "ENCRYPTION_KEY"
[[ $(env_get "$PREFIX/.env" DB_PASSWORD) =~ ^[0-9a-f]{48}$ ]] || fail "DB_PASSWORD"
[[ $(env_get "$PREFIX/.env" VAPID_PUBLIC_KEY) =~ ^[A-Za-z0-9_-]{87}$ ]] || fail "VAPID_PUBLIC_KEY"
[[ $(env_get "$PREFIX/.env" VAPID_PRIVATE_KEY) =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "VAPID_PRIVATE_KEY"
[ "$(stat -c %a "$PREFIX/.env")" = 600 ] || fail ".env is not 0600"
[ -z "$(labelled ps "$PROJECT")" ] || fail "the panel started without its secrets"
secrets_first=$(generated_secrets)
pass "first run generates secrets and waits for the owner's (exit 3)"

# 2. configure.sh refuses a different generated secret and stores owner secrets silently.
before=$(sha256sum <"$PREFIX/.env")
set +e
printf 'ENCRYPTION_KEY=%s\n' "$(gen_hex 32)" | bash "$DEPLOY_DIR/configure.sh" --prefix "$PREFIX" >/dev/null 2>&1
code=$?
set -e
[ "$code" = 2 ] || fail "configure.sh accepted a different ENCRYPTION_KEY (exit $code)"
[ "$(sha256sum <"$PREFIX/.env")" = "$before" ] || fail "a refused configure.sh changed .env"
out=$(printf 'AUTH_GOOGLE_CLIENT_ID=e2e-client.apps.googleusercontent.com\nAUTH_GOOGLE_CLIENT_SECRET=e2e-fake-client-secret\n' |
  bash "$DEPLOY_DIR/configure.sh" --prefix "$PREFIX" 2>&1)
[[ $out != *e2e-fake-client-secret* ]] || fail "configure.sh printed a secret"
pass "configure.sh"

# 3. Second run without flags repeats install.conf; the panel and Caddy come up.
install_run --prefix "$PREFIX"
ready=$(curl -fsS "http://127.0.0.1:$PORT/api/health/ready")
[ "$(jq -r .status <<<"$ready")" = ready ] || fail "ready: $ready"
sha=$(curl -fsS "http://127.0.0.1:$PORT/api/version" | jq -r .sha)
[ "$sha" = "$(git -C "$PREFIX/app" rev-parse HEAD)" ] || fail "running build $sha"
ports=$(docker port "$PROJECT-frontend")
[ "$ports" = "80/tcp -> 127.0.0.1:$PORT" ] || fail "frontend ports: $ports"
root=$PREFIX/state/edge-local-root.crt
config=$(curl -fsS --cacert "$root" --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/auth/config")
[ "$(jq -r '.mode + " " + (.googleSignIn | tostring)' <<<"$config")" = "google true" ] || fail "auth config through the edge: $config"
if curl -fs -o /dev/null --cacert "$root" --resolve "other.example.test:443:127.0.0.1" https://other.example.test/ 2>/dev/null; then
  fail "the edge answered a host other than $HOST"
fi
redirect=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "$HOST:80:127.0.0.1" "http://$HOST/")
[ "$redirect" = "308 https://$HOST/" ] || fail "http redirect: $redirect"
[ "$(env_get "$PREFIX/.env" APP_URL)" = "https://$HOST" ] || fail "APP_URL"
[ "$(env_get "$PREFIX/.env" GOOGLE_REDIRECT_URI)" = "https://$HOST/oauth/google/callback" ] || fail "GOOGLE_REDIRECT_URI"
[ "$(generated_secrets)" = "$secrets_first" ] || fail "generated secrets changed"
pass "second run: panel ready (build $sha), edge TLS, routing and redirect"

# 4. Third run: no file changes, no container recreated or restarted.
files_before=$(config_files_hash)
state_before=$(containers_state)
install_run --prefix "$PREFIX"
[ "$(config_files_hash)" = "$files_before" ] || fail "a rerun changed configuration files"
[ "$(containers_state)" = "$state_before" ] || fail "a rerun recreated or restarted containers"
pass "rerun is idempotent"

# 5. A lost DB_PASSWORD next to an existing database volume stops the installer.
cp -p "$PREFIX/.env" "$PREFIX/.env.keep"
sed -i '/^DB_PASSWORD=/d' "$PREFIX/.env"
set +e
out=$(install_run --prefix "$PREFIX" 2>&1)
code=$?
set -e
mv -f "$PREFIX/.env.keep" "$PREFIX/.env"
if [ "$code" != 1 ] || [[ $out != *DB_PASSWORD* ]]; then fail "lost DB_PASSWORD with a database volume: exit $code"; fi
[ "$(containers_state)" = "$state_before" ] || fail "the refused run touched containers"
pass "a lost DB_PASSWORD is refused"

# 6. Tunnel modes are rendered and parsed only: the test has no real tunnel token.
for mode in cf both; do
  (
    install_defaults
    CFG_SIGNIN=$mode CFG_CF_HOST=cf.example.test CFG_DIRECT_HOST=$HOST CFG_EDGE_PROJECT=me-e2e-render
    write_edge_files "$REPO_DIR" "$RENDER/$mode" "$IMAGE_PREFIX/mailexpert-edge:$VERSION"
    env_set "$RENDER/$mode/.env" TUNNEL_TOKEN "$(gen_hex 32)"
    env_set "$RENDER/$mode/.env" DNS_API_TOKEN "$(gen_hex 20)"
  )
  services=$(docker compose -p me-e2e-render --project-directory "$RENDER/$mode" --env-file "$RENDER/$mode/.env" \
    -f "$RENDER/$mode/compose.yml" config --services | sort | paste -sd' ' -)
  case $mode in
    cf) want=cloudflared ;;
    both) want='caddy cloudflared' ;;
  esac
  [ "$services" = "$want" ] || fail "$mode edge services: $services"
done
docker run --rm --network none -e DNS_API_TOKEN="$(gen_hex 20)" -v "$RENDER/both/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$IMAGE_PREFIX/mailexpert-edge:$VERSION" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 ||
  fail "caddy rejected the DNS-01 Caddyfile"
pass "cf and both edges render and parse"

pass "install e2e passed"
```

- [ ] **Step 2: Обёртка на хосте — `scripts/deploy/test/e2e.sh`**

```bash
#!/usr/bin/env bash
# Deploy e2e test in a throwaway Docker-in-Docker container. The installer's docker commands
# reach only the daemon inside that container, so containers, volumes and ports of the host are
# out of its reach. On the host it creates one container, me-e2e-<id>, removed at exit
# (E2E_KEEP=1 keeps it for inspection).
#
#   scripts/deploy/test/e2e.sh --version sha-<12> --image-prefix local.invalid
#
# The images <prefix>/mailexpert-{backend,frontend,edge}:<version> must be built from HEAD, and
# the tracked files must match HEAD: the test installs HEAD from a git bundle.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: pass /e2e paths to docker.exe unchanged

DIND_IMAGE=docker:29.8.1-dind
TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$TEST_DIR/../lib/common.sh"

VERSION='' IMAGE_PREFIX=''
while [ $# -gt 0 ]; do
  case $1 in
    --version) VERSION=$2 && shift 2 ;;
    --image-prefix) IMAGE_PREFIX=$2 && shift 2 ;;
    *) die "unknown option: $1" 2 ;;
  esac
done
[[ $VERSION =~ ^sha-[0-9a-f]{12}$ ]] || die "--version sha-<12 hex characters> is required" 2
[ -n "$IMAGE_PREFIX" ] || die "--image-prefix is required" 2
head=$(git -C "$TEST_DIR" rev-parse HEAD)
[ "${head:0:12}" = "${VERSION#sha-}" ] || die "--version $VERSION is not HEAD ($head)" 2
[ -z "$(git -C "$TEST_DIR" status --porcelain --untracked-files=no)" ] ||
  die "tracked files differ from HEAD: the test installs HEAD, commit first" 2

NAME=me-e2e-${E2E_ID:-$(gen_hex 4)}
if docker container inspect "$NAME" >/dev/null 2>&1; then die "container $NAME already exists"; fi

cleanup() {
  local status=$?
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    log "kept $NAME; remove it with: docker rm -fv $NAME"
  elif docker container inspect "$NAME" >/dev/null 2>&1; then
    docker rm -fv "$NAME" >/dev/null || warn "could not remove $NAME"
  fi
  exit "$status"
}
trap cleanup EXIT

IMAGES=("$IMAGE_PREFIX/mailexpert-backend:$VERSION" "$IMAGE_PREFIX/mailexpert-frontend:$VERSION"
  "$IMAGE_PREFIX/mailexpert-edge:$VERSION" postgres:16-alpine redis:7-alpine)
for image in "${IMAGES[@]}"; do
  if docker image inspect "$image" >/dev/null 2>&1; then continue; fi
  case $image in
    "$IMAGE_PREFIX"/*) die "image $image is missing: build it from HEAD first" ;;
    *) docker pull --quiet "$image" >/dev/null ;;
  esac
done

log "starting $NAME from $DIND_IMAGE"
docker run -d --privileged --name "$NAME" "$DIND_IMAGE" >/dev/null
for _ in $(seq 60); do
  if docker exec "$NAME" docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" docker info >/dev/null 2>&1 || die "the inner docker daemon did not start"
docker exec "$NAME" apk add --no-cache --quiet bash curl jq iproute2 >/dev/null
log "loading images into $NAME"
docker save "${IMAGES[@]}" | docker exec -i "$NAME" docker load --quiet >/dev/null
docker exec "$NAME" mkdir -p /e2e
git -C "$TEST_DIR" bundle create - HEAD 2>/dev/null | docker exec -i "$NAME" sh -c 'cat >/e2e/repo.bundle'
docker exec "$NAME" git clone --quiet /e2e/repo.bundle /e2e/src
docker exec "$NAME" bash /e2e/src/scripts/deploy/test/e2e-install.sh \
  --version "$VERSION" --image-prefix "$IMAGE_PREFIX" --repo-url /e2e/repo.bundle
log "deploy e2e passed"
```

- [ ] **Step 3: shellcheck и commit (e2e ставит HEAD, поэтому код должен быть закоммичен до прогона)**

Run: `git add scripts/deploy/test/e2e.sh scripts/deploy/test/e2e-install.sh && git update-index --chmod=+x scripts/deploy/test/e2e.sh scripts/deploy/test/e2e-install.sh && SC && BATS`
Expected: без замечаний; bats проходит.

```bash
git commit -m "test(deploy): add an install e2e test in a throwaway Docker-in-Docker"
```

- [ ] **Step 4: Прогон e2e локально**

Снимок хоста до прогона:

```bash
SCRATCH=${SCRATCH:-$(mktemp -d)}
docker ps -q | xargs docker inspect -f '{{.Name}} {{.State.StartedAt}}' | sort >"$SCRATCH/ps-before.txt"
```

Сборка образов из HEAD (дерево чистое после Step 3) и прогон:

```bash
SHA=$(git rev-parse HEAD); TAG=sha-${SHA:0:12}
docker build -f backend/Dockerfile --build-arg BUILD_SHA="$SHA" -t "local.invalid/mailexpert-backend:$TAG" .
docker build -f frontend/Dockerfile --build-arg VITE_BUILD_SHA="$SHA" -t "local.invalid/mailexpert-frontend:$TAG" .
docker build -t "local.invalid/mailexpert-edge:$TAG" deploy/edge
scripts/deploy/test/e2e.sh --version "$TAG" --image-prefix local.invalid; echo "exit $?"
```

Expected: строки `[e2e] ok:` для шести сценариев, `[e2e] ok: install e2e passed`, `deploy e2e passed`, `exit 0`. Время — несколько минут.

После прогона:

```bash
docker ps -a --filter name=me-e2e- --format '{{.Names}}'
docker ps -q | xargs docker inspect -f '{{.Name}} {{.State.StartedAt}}' | sort | diff "$SCRATCH/ps-before.txt" - && echo host-unchanged
```

Expected: первая команда пуста (контейнер e2e удалён); `host-unchanged` — ни один контейнер хоста не исчез и не перезапускался (время старта то же). Вывод `diff` при расхождении не копировать в отчёт дословно: в нём имена чужих контейнеров; написать, что изменилось, без имён других проектов.

Если сценарий падает: исправить код (новый коммит, не amend), пересобрать образы с новым `TAG` и повторить. Для разбора — `E2E_KEEP=1`, затем `docker rm -fv me-e2e-<id>` вручную. Три неудачных попытки подряд по одной причине — остановиться и доложить.

- [ ] **Step 5: e2e в CI**

В `.github/workflows/ci.yml` после задания `bats` добавить:

```yaml
  deploy-e2e:
    name: Deploy e2e
    needs: [shellcheck, bats]
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v6
        with:
          # e2e.sh installs HEAD from a git bundle, which needs the history.
          fetch-depth: 0

      - uses: docker/setup-buildx-action@v3

      - name: Image tag
        id: image
        run: |
          sha=$(git rev-parse HEAD)
          echo "sha=$sha" >> "$GITHUB_OUTPUT"
          echo "tag=sha-${sha::12}" >> "$GITHUB_OUTPUT"

      - name: Backend image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./backend/Dockerfile
          platforms: linux/amd64
          load: true
          tags: local.invalid/mailexpert-backend:${{ steps.image.outputs.tag }}
          provenance: false
          build-args: |
            BUILD_SHA=${{ steps.image.outputs.sha }}
          cache-from: type=gha,scope=backend

      - name: Frontend image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./frontend/Dockerfile
          platforms: linux/amd64
          load: true
          tags: local.invalid/mailexpert-frontend:${{ steps.image.outputs.tag }}
          provenance: false
          build-args: |
            VITE_BUILD_SHA=${{ steps.image.outputs.sha }}
          cache-from: type=gha,scope=frontend

      - name: Edge image
        uses: docker/build-push-action@v6
        with:
          context: ./deploy/edge
          platforms: linux/amd64
          load: true
          tags: local.invalid/mailexpert-edge:${{ steps.image.outputs.tag }}
          provenance: false
          cache-from: type=gha,scope=edge

      - name: Install e2e
        run: scripts/deploy/test/e2e.sh --version "${{ steps.image.outputs.tag }}" --image-prefix local.invalid
```

В задании `images` заменить `needs: [backend, frontend, shellcheck, bats]` на `needs: [backend, frontend, shellcheck, bats, deploy-e2e]`: образы публикуются только после зелёного e2e. Кэш сборок — `cache-from` из тех же областей, что у `images` (запись в кэш остаётся за `images`).

Run: `AL`
Expected: без замечаний.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the deploy e2e test and publish images only after it"
```

---

### Task 8: Спецификация, полная проверка, уборка

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-deployment-design.md`

**Interfaces:**
- Consumes: всё из Task 1-7.
- Produces: статус 7b и уточнения в спецификации; чистое локальное окружение.

- [ ] **Step 1: Спецификация**

В строке статуса (строка 3) заменить `PR 7a (основа прода и CI) реализован.` на `PR 7a (основа прода и CI) и 7b (установка и край) реализованы.`

В пункте 2 «Разбиения на PR» после `e2e установки.` добавить ` План: \`docs/superpowers/plans/2026-09-21-deployment-pr7b-install-edge.md\`.`

После подраздела «### Уточнения, принятые при реализации 7a» (перед «## Открытые вопросы») добавить:

```markdown
### Уточнения, принятые при реализации 7b

- `install.sh` — оркестратор над `scripts/deploy/lib/{common,env,config,edge,system}.sh`; чистые функции покрыты bats. Коды выхода: 0 — готово, 1 — сбой, 2 — неверный ввод (до любых действий на хосте), 3 — ждёт секретов от `configure.sh`.
- Флаги сверх спецификации: `--prefix`, `--project`, `--edge-project`, `--http-port`, `--image-prefix`, `--repo-url`, `--edge-tls acme|internal` (внутренний CA Caddy для стендов и e2e), `--acme-email`, `--no-system` (без проверок Ubuntu и ресурсов, пакетов, swap, ufw и таймеров), `--no-start`. Итоговые значения пишутся в `install.conf` (умолчания < файл < флаги), повторный запуск без флагов повторяет установку; `--prefix` и `--no-start` не сохраняются.
- `--no-start` не запускает и `cloudflared`: второй коннектор того же туннеля при подготовке переезда делил бы трафик со старым сервером. Caddy запускается, чтобы сертификат был заранее.
- Образы панели скачиваются до генерации секретов: VAPID генерирует `web-push` в образе backend (`docker run --network none`). Образ, который уже есть локально под нужным тегом, не скачивается: так работает аварийная сборка из исходников.
- Остальные секреты — `/dev/urandom` через `od` (hex), а не `openssl rand`: без зависимости от `openssl`, тот же источник. `SESSION_SECRET` и `ENCRYPTION_KEY` — 32 байта, `DB_PASSWORD` — 24 байта. Половина пары VAPID — ошибка, а не повторная генерация.
- Если том `<проект>_postgres_data` существует, а в `.env` нет `DB_PASSWORD` или `ENCRYPTION_KEY`, установка останавливается: новые значения заперли бы данные.
- `configure.sh` читает только stdin. Ключи: в `.env` — `CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE`, `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `HEALTHCHECK_PING_URL` (заменяются при повторной передаче); в `edge/.env` — `TUNNEL_TOKEN`, `DNS_API_TOKEN`; сгенерированные ключи принимаются, только если их нет или значение то же. Одна неверная строка — не пишется ничего; значения не выводятся даже в ошибках. Ключи restic добавит 7c.
- Какие секреты нужны установке: `TUNNEL_TOKEN` при крае в режимах `cf`/`both`; `DNS_API_TOKEN` при Caddy с `--edge-tls acme`; `CF_ACCESS_*` при входе Google в `cf`/`both`; `AUTH_GOOGLE_*` при входе Google в `direct`/`both`; с `--local-auth` секреты входа не нужны.
- Край: `deploy/edge/compose.yml` копируется в `<prefix>/edge/`, сервисы выбираются через `COMPOSE_PROFILES` (`caddy`, `tunnel`) в `edge/.env`; `cloudflared` закреплён на `2026.9.1`. `EDGE_IMAGE` при первой записи закрепляется по digest (локально собранный образ digest не имеет и остаётся по тегу) и дальше не меняется. У Caddy выключен admin API, изменённый Caddyfile применяется перезапуском контейнера. Сайт — wildcard родительской зоны (`*.<зона>`) при трёх и более метках в `<DIRECT_HOST>`, отвечает только на `<DIRECT_HOST>`, остальным `abort`; на 502-504 — текст обслуживания с кодом 503. Порт 80 нужен только для перенаправления на https: сертификат выпускается через DNS-01.
- ufw: SSH-порты — 22, порты из `sshd -T` и серверный порт текущей SSH-сессии (иначе включение ufw может закрыть доступ); 80/tcp, 443/tcp и 443/udp — когда запущен Caddy. При переходе на режим `cf` правила 80/443 не удаляются (слушателя на них нет).
- Проверки хоста: 80/443 заняты не нашим Caddy — ошибка; 25/465/587/993 заняты не контейнером — предупреждение. Порог памяти — 3800 МБ `MemTotal` (сервер «4 ГБ» показывает меньше); нехватка ресурсов — ошибка только при первой установке, при повторной — предупреждение.
- Если установщик в выписанном коммите отличается от запущенного, установка продолжается установщиком коммита (`exec`).
- Таймеры: юниты в `deploy/systemd/`, `backup.sh` и `healthcheck.sh` вызываются с `--prefix <prefix>`; таймер включается, только если скрипт есть в коммите (скрипты — 7c). Время 03:30 — по часовому поясу сервера. Печать ключа восстановления (шаг 13) переносится в 7c вместе с restic.
- e2e (`scripts/deploy/test/e2e.sh`) запускает установку в одноразовом привилегированном контейнере `docker:dind`: режим `direct` с внутренним CA, код 3 без секретов, `configure.sh`, готовность, версия, TLS и маршрутизация Caddy, перенаправление с 80, повторный запуск без изменений файлов и перезапуска контейнеров, защита от потерянного `DB_PASSWORD`; режимы `cf` и `both` — только рендер и разбор. Не покрыты: проверки Ubuntu (кроме bats), установка пакетов (только смоук в контейнере Ubuntu), swap, ufw, срабатывание таймеров, реальные DNS-01 и туннель, вход через Access и Google, скачивание из GHCR. В CI e2e идёт после bats и shellcheck, публикация образов — после e2e.
```

- [ ] **Step 2: Полная проверка**

Run: `SC; echo "exit $?"`
Expected: `exit 0`.

Run: `BATS; echo "exit $?"`
Expected: все тесты `env.bats`, `config.bats`, `edge.bats`, `configure.bats` проходят, `exit 0`.

Run: `AL; echo "exit $?"`
Expected: `exit 0`.

Run: `git diff --stat origin/main -- backend frontend docker-compose.yml deploy/compose.prod.yml`
Expected: пусто — бэкенд, фронтенд и compose-файлы 7a не менялись, поэтому их наборы тестов не прогоняются (если diff не пуст — прогнать бэкенд и фронтенд как в плане 7a, раздел «Как запускать тесты»).

e2e: если после прогона Task 7 Step 4 были коммиты, затрагивающие `scripts/` или `deploy/`, — повторить Step 4 на текущем HEAD (новый `TAG`), с тем же снимком `docker ps` до и после.

Run: `git grep -nE "GHCR_TOKEN|docker login" -- scripts/deploy deploy`
Expected: пусто.

Run: `git grep -nE "([0-9]{1,3}\.){3}[0-9]{1,3}" -- scripts/deploy deploy docs/superpowers/plans/2026-09-21-deployment-pr7b-install-edge.md | grep -vE "127\.0\.0\.1|0\.0\.0\.0|203\.0\.113\.|198\.51\.100\."`
Expected: пусто — нет реальных IP (только loopback и документационные диапазоны).

- [ ] **Step 3: Уборка**

```bash
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^local\.invalid/' | xargs -r docker rmi
docker ps -a --filter name=me-e2e- --format '{{.Names}}'
rm -rf "$SCRATCH"
```

Expected: вторая команда пуста. Скачанные публичные образы инструментов (`bats/bats`, `docker:29.8.1-dind`, `ubuntu:24.04`, `ubuntu:22.04`, `cloudflare/cloudflared`, `koalaman/shellcheck`, `rhysd/actionlint`) не мешают и остаются. Рабочие контейнеры MailExpert и контейнеры других проектов на хосте не трогать.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-21-deployment-design.md
git commit -m "docs: record PR 7b implementation notes in the deployment spec"
```

- [ ] **Step 5: После слияния в `main` (напомнить владельцу в отчёте)**

- Первый зелёный прогон `main` публикует образы после `Deploy e2e`; видимость пакетов проверяется так же, как после 7a.
- Боевую установку по этому PR делать только после 7c (бэкап): до него на сервере нет ночного бэкапа и проверки здоровья, таймеры будут пропущены с сообщением.

## Self-review

- Покрытие спецификации, «2. Установка»: шаг 1 — `check_os`, `check_resources`, `check_ports` (Task 5, 6); шаг 2 — `install_packages`, `ensure_swap`, `enable_unattended_upgrades` (Task 5); шаг 3 — `prepare_dirs` (Task 6); шаг 4 — `checkout_code` (Task 6); шаг 5 — `generate_app_secrets`, `app_settings`, `env_ensure_secret` (Task 1, 2); шаг 6 — `configure.sh`, код 3 (Task 4, 6); шаг 7 — `ensure_app_images`, `app_up` (Task 6); шаг 8 — край (Task 3, 6); шаг 9 — `apply_ufw` (Task 5); шаг 10 — `wait_ready`, `verify_edge` (Task 6); шаг 11 — `admin_notice` (Task 6); шаг 12 — таймеры (Task 5); шаг 13 и restic — сознательно в 7c, записано в уточнениях. cloud-init: `install.sh` работает без вопросов и с `exec` установщика нужного коммита; пример user-data — 7d (runbook). «8. Проверка скриптов»: shellcheck, bats в CI, e2e установки в CI (бэкап, восстановление и обновление — 7c).
- Решения владельца: `caddy-dns/cloudflare` (DNS-01 в шаблоне), `HEALTHCHECK_PING_URL` через `configure.sh`, токена бота на сервере нет.
- Заглушки: реальных хостов, IP и секретов нет; в тестах — `example.com`, `example.test`, `local.invalid`.
- Имена согласованы: `env_*`, `generate_app_secrets`, `GENERATED_SECRET_KEYS` (Task 1) используются в Task 4, 6, 7; `edge_services`/`edge_profiles`/`required_owner_secrets`/`ufw_allowed_ports`/`ssh_ports`/`port_conflicts`/`resource_shortfalls`/`version_matches`/`render_unit` (Task 2) — в Task 3, 5, 6; `write_edge_files`/`EDGE_CADDYFILE_CHANGED` (Task 3) — в Task 6, 7; флаги `install.sh` одинаковы в `usage`, `parse_install_args`, e2e и уточнениях.
