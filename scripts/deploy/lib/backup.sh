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
