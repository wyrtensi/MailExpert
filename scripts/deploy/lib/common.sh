# shellcheck shell=bash
# Helpers shared by the deploy scripts. Sourced, never executed.

log() { printf '[mailexpert] %s\n' "$*" >&2; }
warn() { printf '[mailexpert] warning: %s\n' "$*" >&2; }

# die <message> [exit code, default 1]
die() {
  printf '[mailexpert] error: %s\n' "$1" >&2
  exit "${2:-1}"
}

# version_ge <a> <b>: a >= b for dotted numeric versions. A leading "v" and a "-..." or
# "+..." suffix are ignored, so 2.24.4-desktop.1 compares as 2.24.4.
version_ge() {
  local a=${1#v} b=${2#v} i x y
  local -a av bv
  a=${a%%[-+]*}
  b=${b%%[-+]*}
  [[ $a =~ ^[0-9]+(\.[0-9]+)*$ && $b =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 1
  IFS=. read -r -a av <<<"$a"
  IFS=. read -r -a bv <<<"$b"
  for i in 0 1 2 3; do
    x=${av[i]:-0}
    y=${bv[i]:-0}
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

# gen_hex <bytes>: random bytes as lowercase hex, two characters per byte.
gen_hex() {
  head -c "$1" /dev/urandom | od -A n -v -t x1 | tr -d ' \n'
}

is_hostname() {
  [ "${#1}" -le 253 ] && [[ $1 =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

is_email() {
  [[ $1 =~ ^[^[:space:]@,]+@([a-z0-9-]+\.)+[a-z]{2,63}$ ]]
}

is_port() {
  [[ $1 =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

# is_name <compose project name>
is_name() {
  [[ $1 =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]
}
