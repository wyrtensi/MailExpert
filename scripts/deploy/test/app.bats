#!/usr/bin/env bats
# The installed panel as the deploy scripts load it: install.conf, paths, compose commands.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  P=$BATS_TEST_TMPDIR/p
  mkdir -p "$P"
}

write_conf() {
  printf '%s\n' VERSION=sha-0123456789ab SIGNIN=direct DIRECT_HOST=panel.example.com LOCAL_AUTH=1 \
    PROJECT=me-test HTTP_PORT=18090 "$@" >"$P/install.conf"
}

@test "load_install reads install.conf and derives the paths and commands" {
  write_conf
  load_install "$P"
  [ "$CFG_PROJECT" = me-test ] && [ "$CFG_HTTP_PORT" = 18090 ] && [ "$OPT_PREFIX" = "$P" ]
  [ "$APP_DIR" = "$P/app" ] && [ "$STATE_DIR" = "$P/state" ] && [ "$BACKUP_DIR" = "$P/backups" ]
  [ "$ENV_FILE" = "$P/.env" ] && [ "$EDGE_ENV" = "$P/edge/.env" ]
  [ "$BACKEND_IMAGE" = ghcr.io/wyrtensi/mailexpert-backend:sha-0123456789ab ]
  [ "${APP_COMPOSE[*]}" = "docker compose -p me-test --project-directory $P/app --env-file $P/.env -f $P/app/docker-compose.yml -f $P/app/deploy/compose.prod.yml" ]
  [ "${EDGE_COMPOSE[*]}" = "docker compose -p edge --project-directory $P/edge --env-file $P/edge/.env -f $P/edge/compose.yml" ]
}

@test "load_install without install.conf exits 2" {
  run load_install "$P"
  [ "$status" -eq 2 ]
  [[ $output == *"install.conf is missing: run install.sh first"* ]]
}

@test "load_install rejects an invalid install.conf and a relative prefix" {
  write_conf VERSION=latest
  run load_install "$P"
  [ "$status" -eq 2 ]
  [[ $output == *"--version must be"* ]]
  run load_install relative/path
  [ "$status" -eq 2 ]
}

@test "the standby marker" {
  write_conf
  load_install "$P"
  mkdir -p "$STATE_DIR"
  run is_standby
  [ "$status" -eq 1 ]
  set_standby
  is_standby
  clear_standby
  run is_standby
  [ "$status" -eq 1 ]
}
