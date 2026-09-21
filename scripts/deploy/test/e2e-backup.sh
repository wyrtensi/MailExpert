#!/usr/bin/env bash
# Backup, restore, update and rollback scenario of the deploy e2e test. Runs inside the throwaway
# Docker-in-Docker container started by e2e.sh and must never run on a host with real data.
# Server A is the compose project me-e2e-a in /e2e/a; server B, installed after A is wiped, is
# me-e2e-b in /e2e/b; MinIO in the project me-e2e-s3 stands in for the S3 provider. Everything it
# creates is removed at exit.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
# A failure inside a `$(...)` command substitution (derive_version's git calls, run as
# `V_OK=$(derive_version ...)`) would otherwise only abort the script if it were the
# substitution's last command; inherit_errexit makes -e apply inside command substitutions too,
# so a failing git call there stops the whole run instead of being silently swallowed.
shopt -s inherit_errexit

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
# shellcheck source=../lib/ops.sh
. "$DEPLOY_DIR/lib/ops.sh"
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

# update_status_of <prefix>: the status in that panel's state/update.json.
update_status_of() {
  jq -r .status "$1/state/update.json"
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
# lets the update stages add commits. `$REPO_URL` is a bundle of the host checkout's HEAD, which
# may itself be a shallow clone (locally, or from a CI checkout with a shallow default) — cloning
# it leaves `$ORIGIN` with a detached HEAD and no branch, so a later `git push` out of it has
# nothing to negotiate against and walks the full (possibly incomplete, beyond the shallow
# boundary) history instead of just the new commits. Giving it a real branch at that same commit
# makes every later push self-contained: negotiation only ever needs objects at or after this
# tip, never anything from the host clone's own ancestry.
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
git -C "$ORIGIN" update-ref refs/heads/main "$HEAD_SHA"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
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
[[ $OUT == *"repository opens"* && $OUT != *"recovery key"* && $OUT != *"creating the restic repository"* ]] ||
  fail "a rerun: repository, recovery key or a re-init"
pass "repository created; recovery key shown on request, then never again; a rerun does not re-init"

# 3b. A wrong RESTIC_PASSWORD is refused without ever touching restic init: ensure_backup_repo
# treats restic's wrong-password exit code (12) specially and never creates a repository it
# cannot read the existing one of.
cp -p "$A/.env" "$A/.env.keep"
env_set "$A/.env" RESTIC_PASSWORD "$(gen_hex 24)"
expect_exit 1 deploy install.sh --prefix "$A"
mv -f "$A/.env.keep" "$A/.env"
[[ $OUT == *RESTIC_PASSWORD* ]] || fail "a wrong RESTIC_PASSWORD was not reported"
[[ $OUT != *"creating the restic repository"* ]] || fail "a wrong RESTIC_PASSWORD triggered init"
pass "a wrong RESTIC_PASSWORD is refused without touching the repository"

# 4. Test data: a user and a mailbox whose password is encrypted with A's ENCRYPTION_KEY.
cipher=$(credential "$A" encrypt)
[[ $cipher == enc:v1:* ]] || fail "encrypt: $cipher"
on "$A" app_psql >/dev/null <<SQL
WITH owner AS (INSERT INTO users (username, is_admin) VALUES ('e2e-owner', true) RETURNING id)
INSERT INTO email_accounts (added_by, name, email_address, auth_user, auth_pass, enabled)
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
  git -C "$WORK" push --quiet origin "HEAD:refs/heads/e2e-$name" || fail "derive_version $name: push to e2e-$name failed"
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
[ "$(update_status_of "$B")" = "done" ] || fail "update.json status after the update"
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

pass "backup e2e passed"
