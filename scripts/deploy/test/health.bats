#!/usr/bin/env bats
# Health decisions over what docker compose ps, df and curl report.

bats_require_minimum_version 1.5.0

setup() {
  load helper
}

@test "service_problems: missing, stopped, restarting and unhealthy services" {
  ps=$'frontend running healthy\nbackend restarting \npostgres running unhealthy\nredis exited '
  run service_problems frontend backend postgres redis edge-missing <<<"$ps"
  [ "$status" -eq 0 ]
  [ "$output" = $'containers: backend is restarting\ncontainers: postgres is unhealthy\ncontainers: redis is exited\ncontainers: edge-missing does not exist' ]
}

@test "service_problems: healthy, starting and services without a health check are fine" {
  ps=$'frontend running healthy\nbackend running starting\ncloudflared running '
  [ -z "$(service_problems frontend backend cloudflared <<<"$ps")" ]
}

@test "service_problems does not mistake a prefix for a service" {
  [ "$(service_problems redis <<<'redis-extra running healthy')" = "containers: redis does not exist" ]
}

@test "disk_problem" {
  [ -z "$(disk_problem / 85% 15)" ]
  [ "$(disk_problem / 86% 15)" = "disk: / is 86% full, less than 15% free" ]
  [ -z "$(disk_problem /var/lib/docker 99% 0)" ]
  [ "$(disk_problem / '' 15)" = "disk: cannot read the usage of /" ]
  [ -z "$(disk_problem / 50%)" ]
}

@test "cert_problem" {
  now=1800000000
  [ -z "$(cert_problem panel.example.com "$now" $((now + 30 * 86400)))" ]
  [ "$(cert_problem panel.example.com "$now" $((now + 10 * 86400)))" = "certificate: panel.example.com expires in 10 days" ]
  [ "$(cert_problem panel.example.com "$now" '')" = "certificate: cannot read the expiry date of panel.example.com" ]
}
