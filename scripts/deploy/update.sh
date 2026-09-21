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
      set_update_status "done"
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
        exit 4
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
      exit 5
      ;;
  esac
}

# One line: install.sh checks out another commit, which rewrites this file while it runs.
main "$@"; exit $?
