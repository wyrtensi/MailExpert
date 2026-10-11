#!/usr/bin/env bats
# The managed Proton worker in the deploy lifecycle (lib/proton.sh and its callers): its images
# follow the target commit, its network namespace stays the backend's alone with no published
# port, its snapshot gate wraps the backup's capture, and a restore without its state leaves
# Proton unavailable rather than wrong. docker is a stub.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  # shellcheck source=/dev/null
  source "$DEPLOY_DIR/lib/proton.sh"
  APP_DIR=$BATS_TEST_TMPDIR/app
  mkdir -p "$APP_DIR/deploy/proton-worker"
  : >"$APP_DIR/deploy/proton-worker/Dockerfile"
  CFG_PROJECT=me-test CFG_IMAGE_PREFIX=ghcr.io/o CFG_VERSION=sha-0123456789ab CFG_INSTALL_ID=0123456789abcdef
  APP_COMPOSE=(docker compose -p me-test)
  STUB=$BATS_TEST_TMPDIR/bin
  mkdir -p "$STUB"
  # The stub answers by pattern; DOCKER_* variables shape the answers.
  cat >"$STUB/docker" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
case " $* " in
  *" pull "*"${DOCKER_MISSING:-none}"*) echo "manifest unknown" >&2; exit 1 ;;
  *" image inspect "*) exit 1 ;;
  *" pull "*) exit 0 ;;
  *" ps --quiet backend "*) echo backend-short ;;
  *" ps --all --quiet proton-worker "* | *" ps --quiet proton-worker "*) [ -n "${DOCKER_NO_WORKER:-}" ] || echo worker-short ;;
  *" up -d --no-deps --force-recreate proton-worker "*) : >"$BATS_TEST_TMPDIR/recreated" ;;
  *" exec -T proton-worker python "*"/snapshot/begin"*)
    if [ -n "${DOCKER_STALE_GATE:-}" ] && [ ! -e "$BATS_TEST_TMPDIR/stale-ended" ]; then
      echo '{"errorCode":"operation_conflict","httpStatus":409}'; exit 1
    fi
    if [ -n "${DOCKER_SNAPSHOT_BUSY:-}" ]; then echo '{"errorCode":"snapshot_busy","httpStatus":409}'; exit 1; fi
    if [ -n "${DOCKER_SNAPSHOT_TIMEOUT:-}" ]; then echo '{"error":"timeout","errorCode":"worker_unavailable","httpStatus":0}'; exit 1; fi
    echo '{"state":"snapshot","linkedAddresses":2,"sendLeases":0,"httpStatus":200}' ;;
  *" exec -T proton-worker python "*"/snapshot/end backup-old "*) : >"$BATS_TEST_TMPDIR/stale-ended"; echo '{"state":"idle","httpStatus":200}' ;;
  *" exec -T proton-worker python "*"/snapshot/end"*)
    : >"$BATS_TEST_TMPDIR/gate-open"
    if [ -n "${DOCKER_GATE_LOST:-}" ]; then echo '{"state":"running","ended":false,"httpStatus":200}'
    else echo '{"state":"running","ended":true,"httpStatus":200}'; fi ;;
  *" exec -T proton-worker python "*"/snapshot/renew"*)
    echo renew >>"$BATS_TEST_TMPDIR/renewals"
    if [ -n "${DOCKER_RENEW_HANG:-}" ]; then exec sleep 5; fi
    if [ -n "${DOCKER_GATE_LOST:-}" ]; then echo '{"errorCode":"operation_conflict","httpStatus":409}'; exit 1; fi
    id=${!#}
    echo "{\"state\":\"snapshot\",\"snapshotId\":\"$id\",\"httpStatus\":200}" ;;
  *" exec -T proton-worker python "*"/healthz"*)
    if [ -n "${DOCKER_STALE_GATE:-}" ]; then echo '{"state":"snapshot","snapshotId":"backup-old","httpStatus":200}'
    else echo '{"state":"idle","snapshotId":null,"httpStatus":200}'; fi ;;
  *" exec -T proton-worker tar "*)
    d=$(mktemp -d); mkdir -p "$d/bridge"; printf 'vault-secret-sentinel' >"$d/bridge/vault.enc"; printf '{}' >"$d/controller.json"
    tar -C "$d" -cf - . ;;
  *" inspect -f {{.Id}} backend-short "*) echo "${DOCKER_BACKEND_ID:-backendid}" ;;
  *" {{len .HostConfig.PortBindings}} "*)
    case " $* " in
      *" workerid "*) echo "/me-test-proton-worker ${DOCKER_WORKER_PORTS:-0} false" ;;
      *) echo "/me-test-backend 0 false" ;;
    esac ;;
  *" inspect -f {{.Name}} "*) echo /me-test-backend ;;
  *" inspect -f {{.Id}} worker-short "*) echo workerid ;;
  *" inspect -f {{.HostConfig.NetworkMode}} workerid "*)
    if [ -e "$BATS_TEST_TMPDIR/recreated" ]; then echo "container:${DOCKER_BACKEND_ID:-backendid}"; else echo "container:${DOCKER_WORKER_JOINS:-backendid}"; fi ;;
  *" ps -aq --no-trunc "*) printf '%s\n' backendid workerid ${DOCKER_OTHER:+otherid} ;;
  *" inspect -f {{.Id}} {{.Name}} {{.HostConfig.NetworkMode}} "*)
    echo "backendid /me-test-backend bridge"
    echo "workerid /me-test-proton-worker container:backendid"
    if [ -n "${DOCKER_OTHER:-}" ]; then echo "otherid /neighbour container:$DOCKER_OTHER"; fi ;;
  *" up --no-start "*) ;;
  *".Destination"*) echo me-test_volume ;;
  *" inspect -f {{.Config.Image}} "*) echo ghcr.io/o/mailexpert-proton-worker:sha-0123456789ab ;;
  *" run --rm -i --network none --user 0 "*)
    cat >"$BATS_TEST_TMPDIR/helper-stdin"
    echo 3 ;;
  *" stop proton-worker "*) ;;
esac
exit 0
STUB_EOF
  chmod +x "$STUB/docker"
  export PATH="$STUB:$PATH" DOCKER_LOG=$BATS_TEST_TMPDIR/docker.log BATS_TEST_TMPDIR
  : >"$DOCKER_LOG"
}

# service_block <file> <service>: the lines of one top-level service in a compose file.
# A checkout with core.autocrlf (Windows) has CRLF line ends: compared without the CR, like
# install-id.bats does.
service_block() {
  tr -d '\r' <"$1" | awk -v s="  $2:" '$0 == s {on=1; print; next} on && /^  [a-z]/ {on=0} on && /^[a-z]/ {on=0} on {print}'
}

@test "worker_ports_are_private: the compose service publishes nothing and shares only the backend's namespace" {
  local base=$REPO_DIR/docker-compose.yml prod=$REPO_DIR/deploy/compose.prod.yml block
  block=$(service_block "$base" proton-worker)
  grep -q '^    network_mode: service:backend$' <<<"$block"
  if grep -q 'ports:' <<<"$block"; then false; fi
  if grep -q 'docker.sock' <<<"$block"; then false; fi
  grep -A2 'depends_on:' <<<"$block" | grep -q 'backend:'
  grep -A3 'depends_on:' <<<"$block" | grep -q 'condition: service_started'
  grep -q 'user: "1000:1000"' <<<"$block"
  grep -q 'read_only: true' <<<"$block"
  if service_block "$prod" proton-worker | grep -q 'ports:'; then false; fi
  service_block "$prod" proton-worker | grep -q 'mem_limit: 1g'
  # proton_state only in the worker, proton_runtime only in backend and worker.
  [ "$(grep -c 'proton_state:/var/lib/mailexpert-proton' "$base")" -eq 1 ]
  [ "$(tr -d '\r' <"$base" | grep -c 'proton_runtime:/run/mailexpert-proton$')" -eq 2 ]
  service_block "$base" backend | grep -q 'proton_runtime:/run/mailexpert-proton'
  if service_block "$base" backend | grep -q 'proton_state:'; then false; fi
  # No other service joins any namespace; the backend publishes no port either.
  [ "$(grep -c 'network_mode:' "$base")" -eq 1 ]
  if service_block "$base" backend | grep -q 'ports:'; then false; fi
  if service_block "$prod" backend | grep -q 'ports:'; then false; fi
}

@test "worker_ports_are_private: a running worker with a published port, or a neighbour in the namespace, is a problem" {
  [ -z "$(proton_namespace_problems)" ]
  DOCKER_WORKER_PORTS=1 run -0 proton_namespace_problems
  [[ $output == *"me-test-proton-worker publishes ports"* ]]
  DOCKER_OTHER=backendid run -0 proton_namespace_problems
  [[ $output == *"neighbour joins the backend's network namespace too"* ]]
  DOCKER_OTHER=me-test-backend run -0 proton_namespace_problems
  [[ $output == *"neighbour joins"* ]]
  run ensure_proton_namespace
  [ "$status" -eq 0 ]
  DOCKER_OTHER=backendid run ensure_proton_namespace
  [ "$status" -ne 0 ]
  [[ $output == *"neighbour joins the backend's network namespace too"* ]]
}

@test "worker_follows_recreated_backend_namespace: a worker left in an old backend's namespace is recreated" {
  DOCKER_WORKER_JOINS=oldbackendid run ensure_proton_namespace
  [ "$status" -eq 0 ]
  [ -e "$BATS_TEST_TMPDIR/recreated" ]
  grep -q 'up -d --no-deps --force-recreate proton-worker' "$DOCKER_LOG"
  [[ $output == *"in a stale network namespace, recreating it"* ]]
  [[ $output == *"in the backend's network namespace, no published ports"* ]]
}

@test "updater_common_recreate_checks_actual_namespace: install.sh checks the actual namespace after every up" {
  # The updater, update.sh and rollback.sh all switch through install.sh.
  local up check
  up=$(grep -n '^  if \[ "\$OPT_START" = 1 \]; then app_up' "$DEPLOY_DIR/install.sh" | cut -d: -f1)
  check=$(grep -n '^    ensure_proton_namespace$' "$DEPLOY_DIR/install.sh" | cut -d: -f1)
  [ -n "$up" ]
  [ -n "$check" ]
  [ "$check" -gt "$up" ]
  grep -q 'bash "$APP_DIR/scripts/deploy/install.sh"' "$DEPLOY_DIR/update.sh"
  grep -q 'install.sh" --prefix "$OPT_PREFIX" --version "$to"' "$DEPLOY_DIR/rollback.sh"
  grep -q 'install.sh' "$DEPLOY_DIR/updater.sh"
}

@test "target_images: the target commit decides whether the worker image is needed" {
  local repo=$BATS_TEST_TMPDIR/repo old new
  git init -q "$repo"
  printf 'x\n' >"$repo/a"
  git -C "$repo" add -A && git -C "$repo" -c user.name=t -c user.email=t@example.com commit -q -m old
  old=$(git -C "$repo" rev-parse HEAD)
  mkdir -p "$repo/deploy/proton-worker" && : >"$repo/deploy/proton-worker/Dockerfile"
  git -C "$repo" add -A && git -C "$repo" -c user.name=t -c user.email=t@example.com commit -q -m new
  new=$(git -C "$repo" rev-parse HEAD)
  APP_DIR=$repo
  if commit_has_proton_worker "$repo" "$old"; then false; fi
  commit_has_proton_worker "$repo" "$new"
  [ "$(target_images "$old" sha-old '')" = "ghcr.io/o/mailexpert-backend:sha-old
ghcr.io/o/mailexpert-frontend:sha-old" ]
  [ "$(target_images "$new" sha-new 'https, tenant')" = "ghcr.io/o/mailexpert-backend:sha-new
ghcr.io/o/mailexpert-frontend:sha-new
ghcr.io/o/mailexpert-tenant-worker:sha-new
ghcr.io/o/mailexpert-proton-worker:sha-new" ]
}

@test "missing_worker_image_stops_update_before_backup" {
  local repo=$BATS_TEST_TMPDIR/repo commit missing_image_update_status=0 backup_called_before_missing_image_failure=0
  git init -q "$repo"
  mkdir -p "$repo/deploy/proton-worker" && : >"$repo/deploy/proton-worker/Dockerfile"
  git -C "$repo" add -A && git -C "$repo" -c user.name=t -c user.email=t@example.com commit -q -m new
  commit=$(git -C "$repo" rev-parse HEAD)
  APP_DIR=$repo
  run env DOCKER_MISSING=mailexpert-proton-worker bash -c '
    source "$1/lib/common.sh"; source "$1/lib/proton.sh"
    APP_DIR=$2 CFG_IMAGE_PREFIX=ghcr.io/o
    ensure_target_images "$3" sha-new ""
    : >"$4/backup-called"' _ "$DEPLOY_DIR" "$repo" "$commit" "$BATS_TEST_TMPDIR"
  missing_image_update_status=$status
  [ ! -e "$BATS_TEST_TMPDIR/backup-called" ] || backup_called_before_missing_image_failure=1
  [ "$missing_image_update_status" -ne 0 ]
  [ "$backup_called_before_missing_image_failure" -eq 0 ]
  [[ $output == *"cannot pull ghcr.io/o/mailexpert-proton-worker:sha-new"* ]]
  # update.sh and rollback.sh pull the target's images before the backup and before anything stops.
  local pull backup
  pull=$(grep -n 'ensure_target_images "${target#sha-}"' "$DEPLOY_DIR/update.sh" | cut -d: -f1)
  backup=$(grep -n 'bash "$SCRIPT_DIR/backup.sh"' "$DEPLOY_DIR/update.sh" | cut -d: -f1)
  [ -n "$pull" ]
  [ -n "$backup" ]
  [ "$pull" -lt "$backup" ]
  pull=$(grep -n 'ensure_target_images "$full"' "$DEPLOY_DIR/rollback.sh" | cut -d: -f1)
  backup=$(grep -n 'app_compose stop backend frontend' "$DEPLOY_DIR/rollback.sh" | cut -d: -f1)
  [ -n "$pull" ]
  [ -n "$backup" ]
  [ "$pull" -lt "$backup" ]
}

@test "snapshot_failure_releases_gate: a busy snapshot stops the backup before the dump and leaves no gate to reopen" {
  DOCKER_SNAPSHOT_BUSY=1 run proton_snapshot_begin snap-1
  [ "$status" -eq 1 ]
  [ "$output" = snapshot_busy ]
  [ -z "$PROTON_SNAPSHOT" ]
  proton_snapshot_end
  [ ! -e "$BATS_TEST_TMPDIR/gate-open" ]
  # backup.sh: the gate before the dump, and reopened by its EXIT trap whatever happens.
  local begin dump
  begin=$(grep -n 'proton_snapshot_begin "' "$DEPLOY_DIR/backup.sh" | cut -d: -f1)
  dump=$(grep -n '^  dump_database "\$STAGING"' "$DEPLOY_DIR/backup.sh" | cut -d: -f1)
  [ -n "$begin" ]
  [ -n "$dump" ]
  [ "$begin" -lt "$dump" ]
  sed -n '/^finish() {/,/^}/p' "$DEPLOY_DIR/backup.sh" | grep -q proton_snapshot_end
}

@test "snapshot_failure_releases_gate: an unknown outcome (timeout) still reopens the gate on exit" {
  DOCKER_SNAPSHOT_TIMEOUT=1 proton_snapshot_begin snap-1 >"$BATS_TEST_TMPDIR/out" || true
  [ "$(cat "$BATS_TEST_TMPDIR/out")" = "worker_unavailable, outcome unknown" ]
  [ "$PROTON_SNAPSHOT" = snap-1 ]
  proton_snapshot_end 2>/dev/null
  [ -e "$BATS_TEST_TMPDIR/gate-open" ]
  [ -z "$PROTON_SNAPSHOT" ]
}

@test "the gate wraps the capture: begin, the state read in the worker, then end; no state values printed" {
  local dir=$BATS_TEST_TMPDIR/staging
  mkdir -m 700 "$dir"
  proton_snapshot_begin snap-1 2>"$BATS_TEST_TMPDIR/err"
  [ "$PROTON_SNAPSHOT" = snap-1 ]
  grep -q '2 linked addresses' "$BATS_TEST_TMPDIR/err"
  run stage_proton_state "$dir"
  [ "$status" -eq 0 ]
  [[ $output == *"proton worker state added (2 files)"* ]]
  [[ $output != *sentinel* ]]
  [ "$(stat -c %a "$dir/proton-state.tar")" = 600 ]
  tar -tf "$dir/proton-state.tar" | grep -q 'bridge/vault.enc'
  proton_snapshot_end 2>/dev/null
  [ -e "$BATS_TEST_TMPDIR/gate-open" ]
  [ -z "$PROTON_SNAPSHOT" ]
  # A version without the worker: nothing to hold, nothing staged.
  rm -rf "$APP_DIR/deploy"
  run proton_snapshot_begin snap-2
  [ "$status" -eq 0 ]
  rm -f "$dir/proton-state.tar"
  stage_proton_state "$dir"
  [ ! -e "$dir/proton-state.tar" ]
}

@test "restore_old_snapshot_keeps_proton_unavailable_safely: no state in the backup, empty worker state and a warning" {
  local dir=$BATS_TEST_TMPDIR/files
  mkdir -p "$dir"
  run restore_proton_state "$dir"
  [ "$status" -eq 0 ]
  [[ $output == *"holds no Proton worker state: the worker's state was cleared, managed Proton mailboxes need reconnecting"* ]]
  grep -q 'run --rm -i --network none --user 0' "$DOCKER_LOG"
  grep -q 'sh 1000 clear$' "$DOCKER_LOG"
  if grep -q 'sh 1000 restore$' "$DOCKER_LOG"; then false; fi
  # With the archive: it goes to the helper on stdin, as root without network, on the worker's volumes.
  printf 'archive' >"$dir/proton-state.tar"
  : >"$DOCKER_LOG"
  run restore_proton_state "$dir"
  [ "$status" -eq 0 ]
  grep -q 'run --rm -i --network none --user 0 .*-v me-test_volume:/state -v me-test_volume:/runtime --entrypoint sh ghcr.io/o/mailexpert-proton-worker:sha-0123456789ab -c ' "$DOCKER_LOG"
  grep -q 'sh 1000 restore$' "$DOCKER_LOG"
  [ "$(cat "$BATS_TEST_TMPDIR/helper-stdin")" = archive ]
  [[ $output == *"proton worker state restored (3 files)"* ]]
}

@test "historical_restore_quarantines_all_outgoing_jobs: restore and rollback hand every queued letter to a person" {
  local sql
  sql=$(quarantine_restored_sends_sql)
  [[ $sql == *"SET status = 'needs_attention', error_code = 'restored_from_backup'"* ]]
  [[ $sql == *"WHERE kind = 'send_message' AND status IN ('queued', 'running')"* ]]
  [[ $sql == *"to_regclass('public.jobs') IS NULL"* ]]
  # Nothing deleted: the letter and its evidence stay with the job.
  [[ $sql != *DELETE* ]]
  local restored quarantined start
  restored=$(grep -n '^  restore_database "\$files"' "$DEPLOY_DIR/restore.sh" | cut -d: -f1)
  quarantined=$(grep -n '^  quarantine_restored_sends$' "$DEPLOY_DIR/restore.sh" | cut -d: -f1)
  start=$(grep -n 'bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX"$' "$DEPLOY_DIR/restore.sh" | cut -d: -f1)
  [ -n "$restored" ]
  [ -n "$quarantined" ]
  [ "$restored" -lt "$quarantined" ]
  [ "$quarantined" -lt "$start" ]
  restored=$(grep -n 'swap_databases "\$db"' "$DEPLOY_DIR/rollback.sh" | cut -d: -f1)
  quarantined=$(grep -n 'quarantine_restored_sends' "$DEPLOY_DIR/rollback.sh" | tail -n 1 | cut -d: -f1)
  start=$(grep -n 'install.sh" --prefix "$OPT_PREFIX" --version "$to"' "$DEPLOY_DIR/rollback.sh" | cut -d: -f1)
  [ -n "$restored" ]
  [ -n "$quarantined" ]
  [ "$restored" -lt "$quarantined" ]
  [ "$quarantined" -lt "$start" ]
}

@test "the worker state is restored before the worker first starts" {
  local state start
  state=$(grep -n '^  restore_proton_state "\$files"' "$DEPLOY_DIR/restore.sh" | cut -d: -f1)
  start=$(grep -n 'bash "$APP_DIR/scripts/deploy/install.sh" --prefix "$OPT_PREFIX"$' "$DEPLOY_DIR/restore.sh" | cut -d: -f1)
  [ -n "$state" ]
  [ "$state" -lt "$start" ]
  state=$(grep -n 'restore_proton_state' "$DEPLOY_DIR/rollback.sh" | tail -n 1 | cut -d: -f1)
  start=$(grep -n 'install.sh" --prefix "$OPT_PREFIX" --version "$to"' "$DEPLOY_DIR/rollback.sh" | cut -d: -f1)
  [ -n "$state" ]
  [ "$state" -lt "$start" ]
}

@test "proton_worker_state: the worker's own health, error without an answer" {
  [ "$(proton_worker_state)" = idle ]
  cat >"$STUB/docker" <<'STUB_EOF'
#!/usr/bin/env bash
exit 1
STUB_EOF
  [ "$(proton_worker_state)" = error ]
}

@test "a stopped worker only warns after an install: ordinary mail and updates go on" {
  DOCKER_NO_WORKER=1 run ensure_proton_namespace
  [ "$status" -eq 0 ]
  [[ $output == *"warning: the Proton worker is not running"* ]]
  # The owner's conditions still stop it.
  DOCKER_OTHER=backendid run ensure_proton_namespace
  [ "$status" -ne 0 ]
  DOCKER_WORKER_PORTS=1 run ensure_proton_namespace
  [ "$status" -ne 0 ]
}

@test "a gate left closed by a killed backup is ended before the next backup's begin" {
  DOCKER_STALE_GATE=1 proton_snapshot_begin backup-new 2>"$BATS_TEST_TMPDIR/err"
  [ -e "$BATS_TEST_TMPDIR/stale-ended" ]
  [ "$PROTON_SNAPSHOT" = backup-new ]
  grep -q 'ending the Proton snapshot gate left by an earlier backup (backup-old)' "$BATS_TEST_TMPDIR/err"
  proton_snapshot_end 2>/dev/null
}

@test "the backup renews its gate while it lives; a killed holder stops renewing" {
  export PROTON_RENEW_SECONDS=0.2
  proton_snapshot_begin snap-1 2>/dev/null
  [ -n "$PROTON_RENEWER" ]
  sleep 1
  [ "$(wc -l <"$BATS_TEST_TMPDIR/renewals")" -ge 2 ]
  proton_snapshot_end 2>/dev/null
  [ -z "$PROTON_RENEWER" ]
  local after
  after=$(wc -l <"$BATS_TEST_TMPDIR/renewals")
  sleep 0.6
  [ "$(wc -l <"$BATS_TEST_TMPDIR/renewals")" -eq "$after" ]
  # A holder killed without its EXIT trap: the renewer notices and stops, the worker's TTL reopens.
  : >"$BATS_TEST_TMPDIR/renewals"
  bash -c 'source "$1/lib/common.sh"; source "$1/lib/proton.sh"; APP_COMPOSE=(docker compose -p me-test); APP_DIR=$2
    proton_snapshot_begin snap-2 2>/dev/null; kill -9 $$' _ "$DEPLOY_DIR" "$APP_DIR" || true
  sleep 0.6
  after=$(wc -l <"$BATS_TEST_TMPDIR/renewals")
  sleep 0.6
  [ "$(wc -l <"$BATS_TEST_TMPDIR/renewals")" -eq "$after" ]
}

@test "proton_snapshot_problem: a gate held with no backup running is a problem" {
  [ -z "$(proton_snapshot_problem snapshot 1)" ]
  [ -z "$(proton_snapshot_problem idle 0)" ]
  [[ $(proton_snapshot_problem snapshot 0) == *"snapshot gate is closed with no backup running"* ]]
  grep -q 'proton_snapshot_problem' "$DEPLOY_DIR/status.sh"
}

@test "Important A: the backup verifies its own gate around the capture and fails when it is gone" {
  proton_snapshot_begin snap-1 2>/dev/null
  run proton_snapshot_check snap-1
  [ "$status" -eq 0 ]
  DOCKER_GATE_LOST=1 run proton_snapshot_check snap-1
  [ "$status" -ne 0 ]
  [[ $output == *"lost its Proton snapshot gate"* ]]
  # /snapshot/end that did not close our gate fails the backup.
  DOCKER_GATE_LOST=1 run proton_snapshot_end
  [ "$status" -ne 0 ]
  [[ $output == *"the Proton snapshot gate was gone before the backup ended it"* ]]
  proton_snapshot_end 2>/dev/null
  # backup.sh: checked after the dump (right before the state) and right after the state, and
  # the end's answer decides.
  local dump before stage after end
  dump=$(grep -n '^  dump_database "\$STAGING"' "$DEPLOY_DIR/backup.sh" | cut -d: -f1)
  before=$(grep -n '^  proton_snapshot_check "\$PROTON_SNAPSHOT"' "$DEPLOY_DIR/backup.sh" | head -n 1 | cut -d: -f1)
  stage=$(grep -n '^  stage_proton_state "\$STAGING"' "$DEPLOY_DIR/backup.sh" | cut -d: -f1)
  after=$(grep -n '^  proton_snapshot_check "\$PROTON_SNAPSHOT"' "$DEPLOY_DIR/backup.sh" | tail -n 1 | cut -d: -f1)
  end=$(grep -n '^  proton_snapshot_end || die' "$DEPLOY_DIR/backup.sh" | cut -d: -f1)
  [ -n "$dump" ]
  [ -n "$before" ]
  [ -n "$end" ]
  [ "$dump" -lt "$before" ]
  [ "$before" -lt "$stage" ]
  [ "$stage" -lt "$after" ]
  [ "$after" -lt "$end" ]
}

@test "Important A: a stuck renew times out and the failure is surfaced and fails the check" {
  export PROTON_RENEW_SECONDS=0.2 PROTON_RENEW_TIMEOUT=1 DOCKER_RENEW_HANG=1
  proton_snapshot_begin snap-1 2>"$BATS_TEST_TMPDIR/err"
  sleep 3
  grep -q 'renewing the Proton snapshot gate failed' "$BATS_TEST_TMPDIR/err"
  unset DOCKER_RENEW_HANG
  run proton_snapshot_check snap-1
  [ "$status" -ne 0 ]
  [[ $output == *"renewing the gate failed during the backup"* ]]
  proton_snapshot_end 2>/dev/null || true
}

@test "Minor C: the renewer does not hold the backup's lock descriptors" {
  local lock=$BATS_TEST_TMPDIR/backup.lock fd
  export PROTON_RENEW_SECONDS=5
  exec {BACKUP_FD}>"$lock"
  flock -n "$BACKUP_FD"
  proton_snapshot_begin snap-1 2>/dev/null
  sleep 0.3
  if ls -l "/proc/$PROTON_RENEWER/fd" | grep -q "$lock"; then false; fi
  proton_snapshot_end 2>/dev/null
  exec {BACKUP_FD}>&-
}

@test "Minor B: a stuck sender is cleared by stopping backend and worker, then install.sh" {
  PROTON_REFUSAL=snapshot_busy OPT_PREFIX=/opt/x run proton_refusal_text
  [[ $output == *"docker compose -p me-test stop backend proton-worker, then install.sh --prefix /opt/x"* ]]
}
