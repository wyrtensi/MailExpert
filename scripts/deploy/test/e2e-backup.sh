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
# B_PORT=18082 is declared by the restore scenario, the later task that installs server B.
A_PORT=18081 S3_PORT=19000
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
