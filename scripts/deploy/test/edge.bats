#!/usr/bin/env bats
# Edge files: the rendered Caddyfile and the edge compose project directory.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  install_defaults
  CFG_VERSION=sha-0123456789ab CFG_SIGNIN=direct CFG_DIRECT_HOST=panel.example.com
  T=$REPO_DIR/deploy/edge/Caddyfile.tmpl
  E=$BATS_TEST_TMPDIR/edge
}

@test "caddy_site_address uses the parent zone wildcard when there is one" {
  [ "$(caddy_site_address panel.example.com)" = '*.example.com' ]
  [ "$(caddy_site_address a.b.example.co.uk)" = '*.b.example.co.uk' ]
  [ "$(caddy_site_address example.com)" = example.com ]
}

@test "the DNS-01 Caddyfile" {
  run render_caddyfile "$T"
  [ "$status" -eq 0 ]
  [[ $output == *'*.example.com {'* ]]
  [[ $output == *'@app host panel.example.com'* ]]
  [[ $output == *'reverse_proxy 127.0.0.1:8080'* ]]
  [[ $output == *'dns cloudflare {env.DNS_API_TOKEN}'* ]]
  [[ $output == *'abort'* && $output == *'admin off'* ]]
  [[ $output != *'issuer internal'* && $output != *'email '* ]]
  run ! grep -E '@[A-Z_]+@' <<<"$output"
}

@test "the internal-CA Caddyfile with a custom port and an ACME email" {
  CFG_EDGE_TLS=internal CFG_HTTP_PORT=18080 CFG_ACME_EMAIL=ops@example.com
  run render_caddyfile "$T"
  [[ $output == *'issuer internal'* && $output != *'dns cloudflare'* ]]
  [[ $output == *'reverse_proxy 127.0.0.1:18080'* && $output == *'email ops@example.com'* ]]
}

@test "write_edge_files lays out the edge directory once" {
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  cmp "$REPO_DIR/deploy/edge/compose.yml" "$E/compose.yml"
  [ "$(stat -c %a "$E")" = 700 ]
  [ "$(env_get "$E/.env" COMPOSE_PROJECT_NAME)" = edge ]
  [ "$(env_get "$E/.env" COMPOSE_PROFILES)" = caddy ]
  [ "$(env_get "$E/.env" EDGE_IMAGE)" = local.invalid/mailexpert-edge:sha-0123456789ab ]
  grep -q '@app host panel.example.com' "$E/Caddyfile"
  before=$(cat "$E/.env" "$E/Caddyfile" "$E/compose.yml" | sha256sum)
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  [ "$(cat "$E/.env" "$E/Caddyfile" "$E/compose.yml" | sha256sum)" = "$before" ]
}

@test "write_edge_files keeps owner secrets and writes no Caddyfile for a tunnel-only edge" {
  mkdir -p "$E"
  printf 'TUNNEL_TOKEN=abc\n' >"$E/.env"
  CFG_SIGNIN=cf CFG_CF_HOST=cf.example.com
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  [ "$(env_get "$E/.env" TUNNEL_TOKEN)" = abc ]
  [ "$(env_get "$E/.env" COMPOSE_PROFILES)" = tunnel ]
  [ ! -e "$E/Caddyfile" ]
}

@test "caddy_restart_needed survives an interrupted run until the applied Caddyfile is recorded" {
  S=$BATS_TEST_TMPDIR/state/caddyfile.applied
  mkdir -p "$BATS_TEST_TMPDIR/state"
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  # A container created by this run has loaded the current file: nothing to restart.
  run caddy_restart_needed "$E/Caddyfile" "$S" 0
  [ "$status" -eq 1 ]
  # A running container without a record (an install from before the record existed) restarts once.
  caddy_restart_needed "$E/Caddyfile" "$S" 1
  caddy_record_applied "$E/Caddyfile" "$S"
  [ "$(stat -c %a "$S")" = 600 ]
  run caddy_restart_needed "$E/Caddyfile" "$S" 1
  [ "$status" -eq 1 ]
  # The Caddyfile changes and the run stops before Caddy restarts: every later run still restarts.
  CFG_DIRECT_HOST=other.example.com
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  caddy_restart_needed "$E/Caddyfile" "$S" 1
  write_edge_files "$REPO_DIR" "$E" local.invalid/mailexpert-edge:sha-0123456789ab
  caddy_restart_needed "$E/Caddyfile" "$S" 1
  caddy_record_applied "$E/Caddyfile" "$S"
  run caddy_restart_needed "$E/Caddyfile" "$S" 1
  [ "$status" -eq 1 ]
}
