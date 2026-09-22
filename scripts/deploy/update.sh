#!/usr/bin/env bash
# Updates the panel to another commit (image tag sha-<12>):
#   1. checks: the panel ready, the commit exists, the images pulled before anything stops, free
#      space for the last dump;
#   2. a pre-update backup: backups/pre-update-<old>.dump (the last 3 are kept) and, with the
#      restic keys, a snapshot tagged pre-update;
#   3. install.sh --version <new>: checkout, MAILEXPERT_VERSION, up, migrations at start, the
#      readiness and version checks (MAILEXPERT_READY_TIMEOUT, 600 s by default here).
# A version that does not become ready is left as it is: going back is a decision for a person
# (the runbook's "Откат обновления": stop, restore the pre-update dump, install.sh --version <old>),
# because anything written after the update would be lost.
#
#   update.sh sha-<commit> [--prefix /opt/mailexpert]
#
# Exit codes: 0 updated (or already at that version), 1 failure, 2 invalid input or a state that
# forbids an update (nothing changed).
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
become ready is left as it is and the way back is printed: see the runbook, "Откат обновления".
MAILEXPERT_READY_TIMEOUT: seconds to wait for readiness (default 600).
Exit codes: 0 updated, 1 failure, 2 invalid input or state (nothing changed).
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
  local prefix=/opt/mailexpert target='' old dump free_kb bytes problem since url
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
  take_lock "$STATE_DIR/update.lock" 10 "another update.sh or restore.sh"
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

  dump=$BACKUP_DIR/pre-update-$old.dump
  log "backup before the update"
  bash "$SCRIPT_DIR/backup.sh" --prefix "$OPT_PREFIX" --tag pre-update --keep-dump "$dump" ||
    die "the backup before the update failed; nothing was changed"
  prune_local_dumps
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  url=$(env_get "$ENV_FILE" HEALTHCHECK_PING_URL) || url=
  log "updating $old -> $target"
  if ! run_install "$target"; then
    send_ping "$url" fail "the update to $target did not become ready"
    warn "$target did not become ready; nothing was rolled back"
    log "the backend log: docker compose -p $CFG_PROJECT logs backend"
    log "to go back to $old (what was written since the update is lost): stop backend and frontend, restore $dump into the database, then run install.sh --prefix $OPT_PREFIX --version $old (runbook: \"Откат обновления\")"
    exit 1
  fi
  check_index_warning "$since"
  send_ping "$url" success "updated to $target"
  log "updated to $target; the pre-update dump is $dump"
}

# One line: install.sh checks out another commit, which rewrites this file while it runs.
main "$@"; exit $?
