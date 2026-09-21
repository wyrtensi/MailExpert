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

@test "backup_repo_action: open only on 0, wrong-password only on 12 (restic's documented code since 0.17.1), otherwise init" {
  [ "$(backup_repo_action 0)" = open ]
  [ "$(backup_repo_action 12)" = wrong-password ]
  for code in 1 2 3 10 11 99; do
    [ "$(backup_repo_action "$code")" = init ]
  done
}

@test "restic_error_summary: the first retry line names the reason, else the last line" {
  local cut_off
  cut_off=$(printf '%s
'     'Stat(<config/>) returned error, retrying after 659ms: Stat: The specified bucket does not exist'     'Stat(<config/>) returned error, retrying after 1.1s: Stat: The specified bucket does not exist'     'signal terminated received, cleaning up'     'Fatal: unable to open config file: context canceled'     'Is there a repository at the following location?'     's3:http://127.0.0.1:19000/b')
  [ "$(restic_error_summary <<<"$cut_off")" =     'Stat(<config/>) returned error, retrying after 659ms: Stat: The specified bucket does not exist' ]
  [ "$(printf 'created restic repository
Fatal: repository master key and config already initialized

' |
    restic_error_summary)" = 'Fatal: repository master key and config already initialized' ]
  [ "$(printf 'no newline at the end' | restic_error_summary)" = 'no newline at the end' ]
  [ -z "$(restic_error_summary </dev/null)" ]
}

@test "restic_run: -t runs restic under the image's timeout, mounts stay in place" {
  docker() { printf '%s
' "$@"; }
  STATE_DIR=$BATS_TEST_TMPDIR
  local out
  out=$(restic_run -t 30 -v /a:/b:ro -- cat config)
  [[ $out == *$'/cache
-v
/a:/b:ro
--entrypoint
/usr/bin/timeout
'"$RESTIC_IMAGE"$'
30
restic
cat
config' ]]
  out=$(restic_run -v /a:/b -- snapshots)
  [[ $out == *$'/cache
-v
/a:/b
'"$RESTIC_IMAGE"$'
snapshots' ]]
  [[ $out != *timeout* ]]
}

@test "restic_host_ok: a restic host name without spaces or slashes" {
  restic_host_ok mailexpert-0123abcd
  restic_host_ok mailexpert-panel
  run restic_host_ok ''
  [ "$status" -eq 1 ]
  run restic_host_ok 'two words'
  [ "$status" -eq 1 ]
  run restic_host_ok a/b
  [ "$status" -eq 1 ]
  run restic_host_ok -leading-dash
  [ "$status" -eq 1 ]
}

@test "load_restic_host: generated once per server, then read back unchanged" {
  STATE_DIR=$BATS_TEST_TMPDIR
  load_restic_host 2>/dev/null
  local first=$RESTIC_HOST
  [[ $first =~ ^mailexpert-[0-9a-f]{16}$ ]]
  [ "$(cat "$STATE_DIR/restic-host")" = "$first" ]
  [ "$(stat -c %a "$STATE_DIR/restic-host")" = 600 ]
  RESTIC_HOST=''
  load_restic_host
  [ "$RESTIC_HOST" = "$first" ]
}

@test "load_restic_host: another server generates another host" {
  STATE_DIR=$BATS_TEST_TMPDIR/a
  mkdir -p "$STATE_DIR"
  load_restic_host 2>/dev/null
  local a=$RESTIC_HOST
  STATE_DIR=$BATS_TEST_TMPDIR/b
  mkdir -p "$STATE_DIR"
  load_restic_host 2>/dev/null
  [ "$RESTIC_HOST" != "$a" ]
}

@test "load_restic_host: a damaged file is an error, never replaced" {
  STATE_DIR=$BATS_TEST_TMPDIR
  printf 'bad host\n' >"$STATE_DIR/restic-host"
  run load_restic_host
  [ "$status" -eq 1 ]
  [[ $output == *restic-host* ]]
  [ "$(cat "$STATE_DIR/restic-host")" = 'bad host' ]
}
