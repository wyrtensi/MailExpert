#!/usr/bin/env bats
# Decisions of restore.sh, update.sh and rollback.sh.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  D=$BATS_TEST_TMPDIR/dest.env
  S=$BATS_TEST_TMPDIR/restored.env
}

@test "merge_restored_keys overwrite: restored values replace local ones" {
  printf '%s\n' ENCRYPTION_KEY=local-key DB_PASSWORD=local-db APP_URL=https://b.example.com >"$D"
  printf '%s\n' ENCRYPTION_KEY=old-key DB_PASSWORD=old-db APP_URL=https://a.example.com >"$S"
  run merge_restored_keys "$D" "$S" overwrite ENCRYPTION_KEY DB_PASSWORD
  [ "$status" -eq 0 ]
  [ "$output" = $'ENCRYPTION_KEY\nDB_PASSWORD' ]
  [ "$(env_get "$D" ENCRYPTION_KEY)" = old-key ] && [ "$(env_get "$D" DB_PASSWORD)" = old-db ]
  [ "$(env_get "$D" APP_URL)" = https://b.example.com ]
  [ "$(stat -c %a "$D")" = 600 ]
}

@test "merge_restored_keys fill: only keys that are empty here" {
  printf '%s\n' AUTH_GOOGLE_CLIENT_ID=new-id AUTH_GOOGLE_CLIENT_SECRET= >"$D"
  printf '%s\n' AUTH_GOOGLE_CLIENT_ID=old-id AUTH_GOOGLE_CLIENT_SECRET=old-secret HEALTHCHECK_PING_URL=https://hc.example.com/x >"$S"
  run merge_restored_keys "$D" "$S" fill AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET HEALTHCHECK_PING_URL
  [ "$output" = $'AUTH_GOOGLE_CLIENT_SECRET\nHEALTHCHECK_PING_URL' ]
  [ "$(env_get "$D" AUTH_GOOGLE_CLIENT_ID)" = new-id ]
  [ "$(env_get "$D" AUTH_GOOGLE_CLIENT_SECRET)" = old-secret ]
}

@test "merge_restored_keys skips keys the snapshot does not have and equal values" {
  printf '%s\n' ENCRYPTION_KEY=same >"$D"
  printf '%s\n' ENCRYPTION_KEY=same VAPID_PUBLIC_KEY= >"$S"
  run merge_restored_keys "$D" "$S" overwrite ENCRYPTION_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run env_get "$D" VAPID_PUBLIC_KEY
  [ "$status" -eq 1 ]
}

@test "merge_restored_keys refuses an unknown mode" {
  run merge_restored_keys "$D" "$S" replace ENCRYPTION_KEY
  [ "$status" -eq 2 ]
}
