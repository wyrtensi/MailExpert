# shellcheck shell=bash
# The managed Proton worker (deploy/proton-worker, compose service proton-worker) as the deploy
# scripts see it: which versions have it, its images, its private state in backups, restores and
# rollbacks, and its network namespace. Every Docker call goes through the installed compose
# project (app_compose) or a container that project made. Needs common.sh and app.sh.
#
# The worker shares the backend's network namespace (network_mode: service:backend): Bridge's
# IMAP/SMTP and its focus port listen on 127.0.0.1 there. Only the backend may join that
# namespace, and neither container may publish a port (proton_namespace_problems).

PROTON_WORKER_FILE=deploy/proton-worker/Dockerfile
PROTON_STATE_PATH=/var/lib/mailexpert-proton
PROTON_RUNTIME_PATH=/run/mailexpert-proton
PROTON_STATE_ARCHIVE=proton-state.tar
PROTON_WORKER_UID=1000
# Set by proton_snapshot_begin while the worker's snapshot gate is closed; PROTON_REFUSAL is why
# it was not (called directly, never in a command substitution: these globals must survive).
PROTON_SNAPSHOT='' PROTON_REFUSAL='' PROTON_RENEWER=''

# commit_has_proton_worker <repository> <commit>: status 0 when <commit> ships the worker. The
# target commit decides, never the running version: older versions and their backups have none.
commit_has_proton_worker() {
  git -C "$1" cat-file -e "$2:$PROTON_WORKER_FILE" 2>/dev/null
}

# proton_worker_installed: the checked-out version (APP_DIR) runs the worker.
proton_worker_installed() {
  [ -f "$APP_DIR/$PROTON_WORKER_FILE" ]
}

proton_worker_image() {
  printf '%s/mailexpert-proton-worker:%s\n' "$CFG_IMAGE_PREFIX" "$1"
}

# target_images <commit> <tag> <COMPOSE_PROFILES>: the images the panel at <commit> runs, one per
# line: pulled before anything is switched, so a missing one stops an update before its backup.
target_images() {
  printf '%s/mailexpert-backend:%s\n%s/mailexpert-frontend:%s\n' "$CFG_IMAGE_PREFIX" "$2" "$CFG_IMAGE_PREFIX" "$2"
  if [[ ",${3// /}," == *,tenant,* ]]; then printf '%s/mailexpert-tenant-worker:%s\n' "$CFG_IMAGE_PREFIX" "$2"; fi
  if commit_has_proton_worker "$APP_DIR" "$1"; then proton_worker_image "$2"; fi
  return 0
}

# ensure_target_images <commit> <tag> <COMPOSE_PROFILES>: ensure_image for each of target_images;
# stops the script at the first one that does not pull.
ensure_target_images() {
  local image images
  images=$(target_images "$@")
  while IFS= read -r image; do
    [ -n "$image" ] && ensure_image "$image"
  done <<<"$images"
}

# proton_container [--all]: the id of the worker's container in the panel's project, empty without one.
proton_container() {
  app_compose ps "$@" --quiet proton-worker 2>/dev/null | head -n 1
}

# proton_request <worker.py --request arguments>: the worker's own client inside its container,
# on its private socket. Prints the JSON answer; status 1 for anything but 2xx.
proton_request() {
  app_compose exec -T proton-worker python /opt/mailexpert-proton/worker.py --request "$@"
}

# proton_error <JSON answer>: its errorCode, or worker_unavailable.
proton_error() {
  local code
  code=$(jq -r '.errorCode // empty' <<<"$1" 2>/dev/null) || code=''
  printf '%s\n' "${code:-worker_unavailable}"
}

# proton_snapshot_begin <id>: closes the worker's admission gate (no new Proton sends, logins or
# removals), waits up to 60 s for the sends in flight, then stops Bridge and waits for its exit.
# Status 0 with the gate closed, or when there is nothing to hold (no worker in this version, its
# container not running: Bridge is not running then either); 1 with the reason on stdout
# (snapshot_busy: a send or a login did not finish in time; the gate is open again). An answer
# that is not a refusal (no HTTP status: the request timed out or the exec failed) leaves the
# outcome unknown: the worker may still close the gate, so PROTON_SNAPSHOT is set and the caller's
# proton_snapshot_end (idempotent in the worker) opens it again.
#
# Only backup.sh begins a snapshot, under backup.lock: a gate held by another id is a dead
# backup's (killed without its EXIT trap) and is ended first. While the gate is held a background
# renewer keeps it alive; it stops with proton_snapshot_end or when this shell dies, and the
# worker reopens a gate nobody renews after 5 minutes.
proton_snapshot_begin() {
  local answer status held ok=1
  proton_worker_installed || return 0
  [ -n "$(proton_container)" ] || return 0
  answer=$(proton_request POST /snapshot/begin "$1") || ok=0
  if [ "$ok" = 0 ] && [ "$(proton_error "$answer")" = operation_conflict ]; then
    held=$(proton_request GET /healthz 2>/dev/null | jq -r '.snapshotId // empty' 2>/dev/null) || held=''
    if [ -n "$held" ] && [ "$held" != "$1" ]; then
      warn "ending the Proton snapshot gate left by an earlier backup ($held)"
      proton_request POST /snapshot/end "$held" >/dev/null || true
      ok=1
      answer=$(proton_request POST /snapshot/begin "$1") || ok=0
    fi
  fi
  if [ "$ok" = 0 ]; then
    PROTON_REFUSAL=$(proton_error "$answer")
    status=$(jq -r '.httpStatus // 0' <<<"$answer" 2>/dev/null) || status=0
    if ! [[ $status =~ ^[0-9]+$ ]] || [ "$status" -lt 400 ]; then
      PROTON_SNAPSHOT=$1
      PROTON_REFUSAL="$PROTON_REFUSAL, outcome unknown"
    fi
    printf '%s\n' "$PROTON_REFUSAL"
    return 1
  fi
  PROTON_SNAPSHOT=$1
  proton_start_renewer "$1"
  log "proton worker: snapshot gate closed, Bridge stopped ($(jq -r '"\(.linkedAddresses // 0) linked addresses"' <<<"$answer" 2>/dev/null || echo 'state held'))"
}

# proton_snapshot_end: opens the gate again and lets the worker restart Bridge. Safe to call
# again (the EXIT trap); a failure is a warning: restarting the worker opens it as well.
proton_snapshot_end() {
  if [ -n "$PROTON_RENEWER" ]; then
    kill "$PROTON_RENEWER" 2>/dev/null || true
    wait "$PROTON_RENEWER" 2>/dev/null || true
    PROTON_RENEWER=''
  fi
  [ -n "$PROTON_SNAPSHOT" ] || return 0
  if proton_request POST /snapshot/end "$PROTON_SNAPSHOT" >/dev/null; then
    PROTON_SNAPSHOT=''
    log "proton worker: snapshot gate open"
    return 0
  fi
  warn "the Proton worker did not reopen its gate; Proton mail waits until it does: docker compose -p $CFG_PROJECT restart proton-worker"
  return 1
}

# stage_proton_state <dir>: the worker's state (Bridge vault and keychain, the controller
# proton_refusal_text: why backup.sh stops before its dump, for PROTON_REFUSAL.
proton_refusal_text() {
  case $PROTON_REFUSAL in
    snapshot_busy)
      printf '%s\n' "the Proton worker did not stop for the backup (snapshot_busy: a Proton send or sign-in did not finish within 60 s); nothing was dumped. A send stuck for good is released only by a restart of the worker once the old backend has stopped: docker compose -p $CFG_PROJECT restart backend proton-worker" ;;
    *)
      printf '%s\n' "the Proton worker did not stop for the backup ($PROTON_REFUSAL); nothing was dumped: see docker compose -p $CFG_PROJECT logs proton-worker" ;;
  esac
}

# proton_start_renewer <id>: renews the gate every PROTON_RENEW_SECONDS (60) while this shell
# lives, in the background (PROTON_RENEWER).
proton_start_renewer() {
  local id=$1 parent=$$ every=${PROTON_RENEW_SECONDS:-60}
  (
    while sleep "$every"; do
      kill -0 "$parent" 2>/dev/null || exit 0
      proton_request POST /snapshot/renew "$id" >/dev/null 2>&1 || true
    done
  ) </dev/null >/dev/null 2>&1 &
  PROTON_RENEWER=$!
}

# proton_snapshot_problem <worker state> <a backup runs: 0|1>: a gate closed with no backup to
# hold it (the worker reopens it within 5 minutes; until then Proton is unavailable).
proton_snapshot_problem() {
  if [ "$1" = snapshot ] && [ "$2" = 0 ]; then
    echo "proton worker: the snapshot gate is closed with no backup running: Proton mail waits; it reopens within 5 minutes, or now with: docker compose -p ${CFG_PROJECT:-<project>} restart proton-worker"
  fi
  return 0
}

# journal) as <dir>/proton-state.tar, root 0600: read in the running worker while its snapshot
# gate holds Bridge stopped, or from a stopped container as it is. Only the file count is printed.
stage_proton_state() {
  local dir=$1 id count
  proton_worker_installed || return 0
  id=$(proton_container --all)
  if [ -z "$id" ]; then
    warn "no Proton worker container: its state is not in this backup (managed Proton mailboxes restored from it need reconnecting)"
    return 0
  fi
  (umask 077 && : >"$dir/$PROTON_STATE_ARCHIVE")
  if [ -n "$PROTON_SNAPSHOT" ]; then
    # GNU tar names skipped sockets (gpg-agent) on stderr; paths only, never contents.
    app_compose exec -T proton-worker tar -C "$PROTON_STATE_PATH" --numeric-owner -cf - . >"$dir/$PROTON_STATE_ARCHIVE" \
      2> >(grep -v 'socket ignored' >&2)
  else
    docker cp "$id:$PROTON_STATE_PATH/." - >"$dir/$PROTON_STATE_ARCHIVE"
  fi
  chmod 600 "$dir/$PROTON_STATE_ARCHIVE"
  count=$(tar -tf "$dir/$PROTON_STATE_ARCHIVE" | grep -vc '/$') || count=0
  log "proton worker state added ($count files)"
}

# proton_state_volume: the volume the worker's container mounts at its state path.
proton_state_volume() {
  local id
  id=$(proton_container --all)
  [ -n "$id" ] || return 1
  docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$PROTON_STATE_PATH\"}}{{.Name}}{{end}}{{end}}" "$id"
}

# The helper below runs as root without network in the installed worker image, on the worker's
# volumes only: it makes the state and runtime directories the worker's (uid 1000, 0700) and
# checks them; with an archive on stdin (restore) it first replaces the state with it, with clear
# it empties the state.
# shellcheck disable=SC2016 # expanded by sh inside the helper container
PROTON_PATHS_SCRIPT='set -eu
uid=$1
for d in /state /runtime; do chown "$uid:$uid" "$d"; chmod 0700 "$d"; done
if [ "${2:-}" = clear ]; then
  find /state -mindepth 1 -delete
fi
if [ "${2:-}" = restore ]; then
  find /state -mindepth 1 -delete
  tar -C /state --numeric-owner -xpf -
  chown -R "$uid:$uid" /state
  chmod 0700 /state
fi
rm -f /runtime/worker.sock
for d in /state /runtime; do
  [ "$(stat -c "%u %a" "$d")" = "$uid 700" ] || { echo "$d is not $uid 0700" >&2; exit 1; }
done
find /state -mindepth 1 -type f | wc -l'

# proton_paths [restore|clear]: the helper on the volumes of the worker's container (created first,
# not started: `up --no-start` makes the volumes with the project's labels).
proton_paths() {
  local state runtime id image
  local -a labels
  app_compose up --no-start --quiet-pull proton-worker >/dev/null
  id=$(proton_container --all)
  [ -n "$id" ] || die "compose did not create the Proton worker's container"
  state=$(proton_state_volume)
  runtime=$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$PROTON_RUNTIME_PATH\"}}{{.Name}}{{end}}{{end}}" "$id")
  [ -n "$state" ] && [ -n "$runtime" ] || die "the Proton worker's container has no state or runtime volume"
  image=$(docker inspect -f '{{.Config.Image}}' "$id")
  managed_label_args labels helper "$CFG_INSTALL_ID"
  docker run --rm -i --network none --user 0 "${labels[@]}" -v "$state:/state" -v "$runtime:/runtime" \
    --entrypoint sh "$image" -c "$PROTON_PATHS_SCRIPT" sh "$PROTON_WORKER_UID" "$@"
}

# ensure_proton_paths: the worker's volumes exist and are its own (uid 1000, 0700) before it
# starts.
ensure_proton_paths() {
  local files
  proton_worker_installed || return 0
  files=$(proton_paths </dev/null) || die "the Proton worker's volumes could not be prepared (the error is above)"
  log "proton worker volumes ready ($files state files)"
}

# restore_proton_state <dir>: <dir>/proton-state.tar into the worker's state volume, the worker
# stopped (restore.sh before the first start, rollback.sh after the database swap). A snapshot
# without it (made by a version without the worker, or without its container) clears the state:
# a newer vault must not disagree with the restored database, so managed Proton mailboxes need
# reconnecting; nothing else changes.
restore_proton_state() {
  local dir=$1 files
  proton_worker_installed || return 0
  if [ -n "$(proton_container)" ]; then app_compose stop proton-worker >/dev/null; fi
  if [ ! -s "$dir/$PROTON_STATE_ARCHIVE" ]; then
    files=$(proton_paths clear </dev/null) || die "the Proton worker's state could not be cleared (the error is above); the worker stays stopped"
    warn "the backup holds no Proton worker state: the worker's state was cleared, managed Proton mailboxes need reconnecting"
    return 0
  fi
  files=$(proton_paths restore <"$dir/$PROTON_STATE_ARCHIVE") ||
    die "the Proton worker state could not be restored (the error is above); the worker stays stopped"
  log "proton worker state restored ($files files)"
}

# proton_namespace_problems: why the worker's network namespace is not as intended, one line
# each; nothing when the worker joins the running backend's namespace, no other container joins
# it, and neither publishes a port (Bridge's focus port included).
proton_namespace_problems() {
  local backend worker backend_name mode line id name joined all
  backend=$(app_compose ps --quiet backend 2>/dev/null | head -n 1)
  worker=$(proton_container)
  if [ -z "$backend" ] || [ -z "$worker" ]; then
    echo "not running"
    return 0
  fi
  backend=$(docker inspect -f '{{.Id}}' "$backend")
  backend_name=$(docker inspect -f '{{.Name}}' "$backend")
  worker=$(docker inspect -f '{{.Id}}' "$worker")
  mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$worker")
  [ "$mode" = "container:$backend" ] || echo "proton-worker: joins ${mode:-no namespace}, not the running backend's"
  for id in "$backend" "$worker"; do
    line=$(docker inspect -f '{{.Name}} {{len .HostConfig.PortBindings}} {{.HostConfig.PublishAllPorts}}' "$id")
    read -r name joined all <<<"$line"
    if [ "${joined:-0}" != 0 ] || [ "${all:-false}" != false ]; then echo "proton-worker: ${name#/} publishes ports"; fi
  done
  while read -r id name line; do
    [ -n "$id" ] && [ "$id" != "$worker" ] || continue
    case $line in
      "container:$backend" | "container:${backend_name#/}" | "container:${backend:0:12}")
        echo "proton-worker: ${name#/} joins the backend's network namespace too" ;;
    esac
  done < <(docker ps -aq --no-trunc | xargs -r docker inspect -f '{{.Id}} {{.Name}} {{.HostConfig.NetworkMode}}')
  return 0
}

# ensure_proton_namespace: after every `up`. A worker left in the namespace of a backend that was
# recreated without it is recreated (compose normally does that itself); any other problem stops
# the script: the worker's loopback services must stay the backend's alone.
ensure_proton_namespace() {
  local problems
  proton_worker_installed || return 0
  problems=$(proton_namespace_problems)
  if [ "$problems" = "not running" ]; then
    # Proton is down, ordinary mail is not: the update goes on, the health check reports it.
    warn "the Proton worker is not running: managed Proton mailboxes are unavailable; see docker compose -p $CFG_PROJECT logs proton-worker, then run install.sh --prefix $OPT_PREFIX again"
    return 0
  fi
  if grep -q 'not the running backend' <<<"$problems"; then
    log "proton worker: in a stale network namespace, recreating it"
    app_compose up -d --no-deps --force-recreate proton-worker >/dev/null ||
      die "recreating the Proton worker failed (its error is above)"
    problems=$(proton_namespace_problems)
  fi
  [ -z "$problems" ] || die "$(paste -sd';' - <<<"$problems")"
  log "proton worker: in the backend's network namespace, no published ports"
}

# proton_dump_dir <dump>: where backup.sh --keep-dump keeps the worker's state captured with that
# dump (update.sh's pre-update dump), for rollback.sh.
proton_dump_dir() {
  printf '%s.proton\n' "${1%.dump}"
}

# keep_proton_state <staging dir> <dump>: the staged worker state next to the kept dump, 0700/0600.
keep_proton_state() {
  local dir
  [ -f "$1/$PROTON_STATE_ARCHIVE" ] || return 0
  dir=$(proton_dump_dir "$2")
  rm -rf "$dir"
  mkdir -m 700 "$dir"
  cp -p "$1/$PROTON_STATE_ARCHIVE" "$dir/$PROTON_STATE_ARCHIVE"
  log "proton worker state kept at $dir"
}

# quarantine_restored_sends: quarantine_restored_sends_sql on the panel's database; the count only.
quarantine_restored_sends() {
  local count
  count=$(quarantine_restored_sends_sql | app_psql) ||
    die "the letters queued in the restored database could not be set aside (the error is above); the panel was not started"
  count=$(tr -d '[:space:]' <<<"$count")
  log "letters queued in the restored database, now waiting for a person (needs attention): ${count:-0}"
}

# proton_worker_state: idle, running, recovering, snapshot, degraded or error (no answer).
proton_worker_state() {
  local answer state
  answer=$(proton_request GET /healthz 2>/dev/null) || true
  state=$(jq -r '.state // empty' <<<"$answer" 2>/dev/null) || state=''
  printf '%s\n' "${state:-error}"
}

# quarantine_restored_sends: run on a database restored from a dump (restore.sh, rollback.sh).
# Letters queued or running in the dump are never sent again by themselves: whether they already
# went out after the dump is unknown, so each needs a person (needs_attention, its letter and any
# evidence kept). SQL for psql on stdout; it prints the count.
quarantine_restored_sends_sql() {
  cat <<'SQL'
CREATE TEMP TABLE quarantined (n integer);
DO $$
BEGIN
  IF to_regclass('public.jobs') IS NULL THEN
    INSERT INTO quarantined VALUES (0);
  ELSE
    WITH moved AS (
      UPDATE jobs
         SET status = 'needs_attention', error_code = 'restored_from_backup',
             last_error = 'Restored from a backup: this letter may or may not have been sent after the backup was made. Check the recipient''s mailbox or Sent, then send it again if needed.',
             claim_token = NULL, lease_until = NULL, updated_at = now()
       WHERE kind = 'send_message' AND status IN ('queued', 'running')
       RETURNING 1)
    INSERT INTO quarantined SELECT count(*) FROM moved;
  END IF;
END $$;
SELECT n FROM quarantined;
SQL
}
