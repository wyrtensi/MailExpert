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
