#!/usr/bin/env bash
# Stores the owner's secrets for install.sh: KEY=VALUE lines on stdin, one per line. Secrets are
# never accepted as arguments (shell history, process list, cloud-init user-data) and values are
# never printed.
#
#   ssh root@<host> /opt/mailexpert/app/scripts/deploy/configure.sh < secrets.env
#
# Exit codes: 0 stored, 1 failure (for example install.sh held the lock too long), 2 invalid input,
# nothing stored (every problem is listed).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"
exit_on_unexpected_failure

# How long to wait for a running install.sh, which holds the lock for minutes on a first install.
LOCK_TIMEOUT=${MAILEXPERT_LOCK_TIMEOUT:-600}
[[ $LOCK_TIMEOUT =~ ^[0-9]+$ ]] || die "MAILEXPERT_LOCK_TIMEOUT must be a number of seconds" 2

# Owner secrets, replaced when given again (rotation).
APP_OWNER_KEYS=(CF_ACCESS_ISSUER CF_ACCESS_AUDIENCE AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET HEALTHCHECK_PING_URL)
EDGE_OWNER_KEYS=(TUNNEL_TOKEN DNS_API_TOKEN)

usage() {
  cat <<'EOF'
Usage: configure.sh [--prefix /opt/mailexpert] < file-with-KEY=VALUE-lines

Panel (<prefix>/.env):     CF_ACCESS_ISSUER, CF_ACCESS_AUDIENCE, AUTH_GOOGLE_CLIENT_ID,
                           AUTH_GOOGLE_CLIENT_SECRET, HEALTHCHECK_PING_URL
Edge (<prefix>/edge/.env): TUNNEL_TOKEN, DNS_API_TOKEN
Generated keys (SESSION_SECRET, ENCRYPTION_KEY, DB_PASSWORD, VAPID_PUBLIC_KEY,
VAPID_PRIVATE_KEY) are accepted only when absent or identical; they are never replaced.
Then run install.sh again.
EOF
}

# key_target <key>: app, edge or generated; status 1 for keys configure.sh does not store.
key_target() {
  local key=$1 known
  for known in "${APP_OWNER_KEYS[@]}"; do [ "$known" = "$key" ] && { echo app; return 0; }; done
  for known in "${EDGE_OWNER_KEYS[@]}"; do [ "$known" = "$key" ] && { echo edge; return 0; }; done
  for known in "${GENERATED_SECRET_KEYS[@]}"; do [ "$known" = "$key" ] && { echo generated; return 0; }; done
  return 1
}

# value_problem <key> <value>: prints what is wrong with the value, nothing when it is fine.
value_problem() {
  case $1 in
    CF_ACCESS_ISSUER) [[ $2 =~ ^https://[a-z0-9-]+\.cloudflareaccess\.com$ ]] || echo "must be https://<TEAM>.cloudflareaccess.com" ;;
    HEALTHCHECK_PING_URL) [[ $2 =~ ^https:// ]] || echo "must be an https:// URL" ;;
  esac
  return 0
}

# fail_on_errors <error...>: prints every error and exits 2 when there is any.
fail_on_errors() {
  [ "$#" -gt 0 ] || return 0
  printf '[mailexpert] error: %s\n' "$@" >&2
  die "nothing was written" 2
}

main() {
  local prefix=/opt/mailexpert line key value target problem current file old i n=0
  local -a keys=() values=() targets=() errors=()
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value" 2; fi
        prefix=$2
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      *) die "unexpected argument (not shown): secrets are read from stdin as KEY=VALUE lines, never from arguments" 2 ;;
    esac
  done
  [[ $prefix =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix must be an absolute path without spaces" 2
  if [ -t 0 ]; then log "paste KEY=VALUE lines, then press Ctrl-D"; fi

  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=${line%$'\r'}
    case $line in '' | '#'*) continue ;; esac
    key=${line%%=*}
    if [ "$key" = "$line" ] || ! [[ $key =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      errors+=("line $n is not KEY=VALUE (content not shown)")
      continue
    fi
    value=${line#*=}
    if ! target=$(key_target "$key"); then errors+=("$key: not a key configure.sh stores"); continue; fi
    if [ -z "$value" ]; then errors+=("$key: empty value"); continue; fi
    if ! env_value_ok "$value"; then
      errors+=("$key: the value must be one token without spaces, quotes, \$, # or backslash")
      continue
    fi
    problem=$(value_problem "$key" "$value")
    if [ -n "$problem" ]; then errors+=("$key: $problem"); continue; fi
    keys+=("$key") values+=("$value") targets+=("$target")
  done
  fail_on_errors "${errors[@]}"
  [ "${#keys[@]}" -gt 0 ] || die "no KEY=VALUE lines on stdin (see --help)" 2

  # install.sh generates keys in the same .env: the checks and the writes below run under its lock.
  mkdir -p "$prefix/edge" "$prefix/state"
  chmod 700 "$prefix/edge" "$prefix/state"
  take_install_lock "$prefix/state" "$LOCK_TIMEOUT" configure.sh
  for i in "${!keys[@]}"; do
    [ "${targets[i]}" = generated ] || continue
    current=$(env_get "$prefix/.env" "${keys[i]}") || current=
    if [ -n "$current" ] && [ "$current" != "${values[i]}" ]; then
      errors+=("${keys[i]}: $prefix/.env already has a different value; generated secrets are never replaced")
    fi
  done
  fail_on_errors "${errors[@]}"

  for i in "${!keys[@]}"; do
    if [ "${targets[i]}" = edge ]; then file=$prefix/edge/.env; else file=$prefix/.env; fi
    old=$(env_get "$file" "${keys[i]}") || old=
    if [ "$old" = "${values[i]}" ]; then
      log "${keys[i]}: unchanged"
    else
      env_set "$file" "${keys[i]}" "${values[i]}"
      log "${keys[i]}: stored in $file"
    fi
  done
  log "run install.sh again to apply"
}

main "$@"
exit $?
