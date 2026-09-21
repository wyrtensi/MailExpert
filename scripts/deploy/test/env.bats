#!/usr/bin/env bats
# .env files: single-token values, atomic writes, secrets generated once and never replaced.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  F=$BATS_TEST_TMPDIR/.env
}

@test "env_set creates the file with mode 600" {
  env_set "$F" APP_URL https://app.example.com
  [ "$(cat "$F")" = "APP_URL=https://app.example.com" ]
  [ "$(stat -c %a "$F")" = 600 ]
}

@test "env_set replaces only its key and keeps comments and other keys" {
  printf '# comment\nA=1\nB=2\n' >"$F"
  env_set "$F" A 3
  [ "$(cat "$F")" = $'# comment\nA=3\nB=2' ]
}

@test "env_set rejects values compose would not read verbatim" {
  local bad
  for bad in 'a b' 'a$b' 'a#b' "a'b" 'a"b' 'a\b' $'a\nb' $'a\tb'; do
    run env_set "$F" K "$bad"
    [ "$status" -ne 0 ]
  done
  [ ! -e "$F" ]
}

@test "env_get prints the value and fails for a missing key or file" {
  printf 'A=x=y\nB=\n' >"$F"
  run env_get "$F" A
  [ "$status" -eq 0 ] && [ "$output" = "x=y" ]
  run env_get "$F" B
  [ "$status" -eq 0 ] && [ "$output" = "" ]
  run env_get "$F" C
  [ "$status" -eq 1 ]
  run env_get "$BATS_TEST_TMPDIR/none" A
  [ "$status" -eq 1 ]
}

@test "env_ensure_secret: absent or empty is set, equal is kept, different is refused" {
  env_ensure_secret "$F" K one
  printf 'E=\n' >>"$F"
  env_ensure_secret "$F" E two
  run env_ensure_secret "$F" K one
  [ "$status" -eq 0 ]
  before=$(sha256sum <"$F")
  run env_ensure_secret "$F" K other
  [ "$status" -eq 2 ]
  [ "$(sha256sum <"$F")" = "$before" ]
  [ "$(env_get "$F" K)" = one ]
  [ "$(env_get "$F" E)" = two ]
}

@test "env_missing lists absent and empty keys" {
  printf 'A=1\nB=\n' >"$F"
  run env_missing "$F" A B C
  [ "$output" = $'B\nC' ]
}

@test "generate_app_secrets fills every generated key" {
  gen_vapid_pair() { echo "PUB PRIV"; }
  generate_app_secrets "$F"
  [[ $(env_get "$F" SESSION_SECRET) =~ ^[0-9a-f]{64}$ ]]
  [[ $(env_get "$F" ENCRYPTION_KEY) =~ ^[0-9a-f]{64}$ ]]
  [[ $(env_get "$F" DB_PASSWORD) =~ ^[0-9a-f]{48}$ ]]
  [ "$(env_get "$F" VAPID_PUBLIC_KEY)" = PUB ]
  [ "$(env_get "$F" VAPID_PRIVATE_KEY)" = PRIV ]
}

@test "a rerun never calls a generator and never changes the file" {
  calls=$BATS_TEST_TMPDIR/calls
  gen_vapid_pair() { echo x >>"$calls"; echo "PUB PRIV"; }
  generate_app_secrets "$F"
  first=$(sha256sum <"$F")
  gen_hex() { echo x >>"$calls"; echo deadbeef; }
  generate_app_secrets "$F"
  generate_app_secrets "$F"
  [ "$(sha256sum <"$F")" = "$first" ]
  [ "$(wc -l <"$calls")" -eq 1 ]
}

@test "an empty key is generated, a present one is kept" {
  key=$(printf 'a%.0s' {1..64})
  printf 'SESSION_SECRET=\nENCRYPTION_KEY=%s\n' "$key" >"$F"
  gen_vapid_pair() { echo "PUB PRIV"; }
  generate_app_secrets "$F"
  [[ $(env_get "$F" SESSION_SECRET) =~ ^[0-9a-f]{64}$ ]]
  [ "$(env_get "$F" ENCRYPTION_KEY)" = "$key" ]
}

@test "half a VAPID pair is an error, not a regeneration" {
  printf 'VAPID_PUBLIC_KEY=PUB\n' >"$F"
  gen_vapid_pair() { echo "NEW NEW"; }
  run ensure_vapid "$F"
  [ "$status" -ne 0 ]
  [ "$(env_get "$F" VAPID_PUBLIC_KEY)" = PUB ]
  run env_get "$F" VAPID_PRIVATE_KEY
  [ "$status" -eq 1 ]
}

@test "gen_hex returns two hex characters per byte" {
  [[ $(gen_hex 3) =~ ^[0-9a-f]{6}$ ]]
  [[ $(gen_hex 32) =~ ^[0-9a-f]{64}$ ]]
}

@test "version_ge compares dotted versions" {
  version_ge 2.24.4 2.24.4
  version_ge 2.24.10 2.24.4
  version_ge 5.5.1 2.24.4
  version_ge v2.29.1-desktop.1 2.24.4
  run ! version_ge 2.24.3 2.24.4
  run ! version_ge 2.9.0 2.24.4
  run ! version_ge garbage 2.24.4
}

@test "name checks" {
  is_hostname panel.example.com
  run ! is_hostname https://panel.example.com
  run ! is_hostname Panel.example.com
  run ! is_hostname under_score.example.com
  run ! is_hostname localhost
  is_email admin@example.com
  run ! is_email 'admin example.com'
  is_port 8080
  run ! is_port 80
  run ! is_port 70000
  is_name me-e2e
  run ! is_name MailExpert
}
