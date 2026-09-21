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
