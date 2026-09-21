# shellcheck shell=bash
# Files of the edge compose project in <prefix>/edge: compose.yml (copied from the checkout),
# Caddyfile (rendered from deploy/edge/Caddyfile.tmpl) and the non-secret keys of edge/.env.

# caddy_site_address <host>: the parent zone wildcard for hosts with three or more labels, which
# keeps the exact host name out of certificate transparency logs; otherwise the host itself.
caddy_site_address() {
  local parent=${1#*.}
  if [[ $parent == *.* ]]; then
    printf '*.%s\n' "$parent"
  else
    printf '%s\n' "$1"
  fi
}

# render_caddyfile <template>: the Caddyfile for CFG_DIRECT_HOST on stdout.
render_caddyfile() {
  local text issuer global='' site
  text=$(<"$1") || die "cannot read $1"
  case $CFG_EDGE_TLS in
    acme) issuer='dns cloudflare {env.DNS_API_TOKEN}' ;;
    internal) issuer='issuer internal' ;;
    *) die "unknown edge TLS mode: $CFG_EDGE_TLS" ;;
  esac
  if [ -n "$CFG_ACME_EMAIL" ]; then global="email $CFG_ACME_EMAIL"; fi
  site=$(caddy_site_address "$CFG_DIRECT_HOST")
  text=${text//@GLOBAL_EMAIL@/"$global"}
  text=${text//@SITE@/"$site"}
  text=${text//@DIRECT_HOST@/"$CFG_DIRECT_HOST"}
  text=${text//@HTTP_PORT@/"$CFG_HTTP_PORT"}
  text=${text//@TLS_ISSUER@/"$issuer"}
  printf '%s\n' "$text"
}

# write_edge_files <app dir> <edge dir> <edge image>. Whether Caddy has loaded the Caddyfile is
# decided by caddy_restart_needed, not here: a run can stop between writing and restarting.
write_edge_files() {
  local app_dir=$1 edge_dir=$2 image=$3 env=$2/.env new
  mkdir -p "$edge_dir"
  chmod 700 "$edge_dir"
  cp "$app_dir/deploy/edge/compose.yml" "$edge_dir/compose.yml"
  env_set "$env" COMPOSE_PROJECT_NAME "$CFG_EDGE_PROJECT"
  new=$(edge_profiles)
  env_set "$env" COMPOSE_PROFILES "$new"
  env_set "$env" EDGE_IMAGE "$image"
  if edge_services | grep -qx caddy; then
    new=$(render_caddyfile "$app_dir/deploy/edge/Caddyfile.tmpl")
    if [ ! -f "$edge_dir/Caddyfile" ] || [ "$new" != "$(<"$edge_dir/Caddyfile")" ]; then
      printf '%s\n' "$new" >"$edge_dir/Caddyfile"
    fi
  fi
}

# caddy_restart_needed <Caddyfile> <applied record> <container existed before up 0|1>: status 0
# when the running Caddy may still serve an older Caddyfile. The record holds the hash of the
# Caddyfile that Caddy last loaded and is written only after a successful start or restart, so
# a run that stops in between leaves the restart to the next run.
caddy_restart_needed() {
  local file=$1 record=$2 existed=$3 applied
  [ "$existed" = 1 ] || return 1
  applied=$(cat "$record" 2>/dev/null) || return 0
  [ "$applied" != "$(sha256sum <"$file")" ]
}

# caddy_record_applied <Caddyfile> <applied record>
caddy_record_applied() {
  local file=$1 record=$2 tmp
  tmp=$(mktemp "$record.XXXXXX")
  chmod 600 "$tmp"
  sha256sum <"$file" >"$tmp"
  mv -f "$tmp" "$record"
}
