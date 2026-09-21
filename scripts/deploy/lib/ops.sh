# shellcheck shell=bash
# Decisions and state of restore.sh, update.sh and rollback.sh. Needs common.sh and env.sh.

# merge_restored_keys <dest env> <restored env> <overwrite|fill> <key...>: copies keys from the
# .env of a snapshot. overwrite: the restored value replaces the local one; fill: only keys that
# are empty here are written. Keys empty or absent in the snapshot are skipped. Prints the name
# of each key written, never a value.
merge_restored_keys() {
  local dest=$1 src=$2 mode=$3 key value current
  shift 3
  case $mode in overwrite | fill) ;; *) die "merge_restored_keys: unknown mode $mode" 2 ;; esac
  for key in "$@"; do
    value=$(env_get "$src" "$key") || value=
    [ -n "$value" ] || continue
    current=$(env_get "$dest" "$key") || current=
    [ "$current" != "$value" ] || continue
    if [ "$mode" = fill ] && [ -n "$current" ]; then continue; fi
    env_set "$dest" "$key" "$value"
    printf '%s\n' "$key"
  done
}

# update_outcome <install.sh exit> <migrations before> <migrations after>: done; auto-rollback
# (not ready and the schema is exactly as before, so the previous version fits it); or
# manual-rollback (anything else, an unknown count included).
update_outcome() {
  if [ "$1" = 0 ]; then
    echo "done"
  elif [[ $2 =~ ^[0-9]+$ && $3 =~ ^[0-9]+$ ]] && [ "$2" = "$3" ]; then
    echo auto-rollback
  else
    echo manual-rollback
  fi
}

# space_problem <free kB> <last dump bytes>: an update needs twice the dump free: the local
# pre-update dump, and the database copy a rollback restores next to the current one.
space_problem() {
  local free=$(($1 * 1024)) need=$(($2 * 2))
  if [ "$free" -lt "$need" ]; then
    echo "free space: $(($1 / 1024)) MB, the update needs $((need / 1048576)) MB (twice the last dump)"
  fi
  return 0
}

# stale_local_dumps <keep>: reads dump paths, newest first, and prints the ones beyond <keep>.
stale_local_dumps() {
  tail -n +"$(($1 + 1))"
}

# write_update_state <from> <to> <migrations before> <dump> <status>: state/update.json.
write_update_state() {
  local file=$STATE_DIR/update.json tmp now
  now=$(date +%s)
  tmp=$(mktemp "$file.XXXXXX")
  jq -cn --arg from "$1" --arg to "$2" --argjson before "$3" --arg dump "$4" --arg status "$5" --argjson now "$now" \
    '{from: $from, to: $to, migrations_before: $before, dump: $dump, status: $status, started_epoch: $now}' >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# set_update_status <status>: running, done, rolled-back or needs-rollback.
set_update_status() {
  local file=$STATE_DIR/update.json tmp
  tmp=$(mktemp "$file.XXXXXX")
  jq -c --arg status "$1" '.status = $status' "$file" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# update_status: the status of the last update, empty when there was none.
update_status() {
  [ -f "$STATE_DIR/update.json" ] || return 0
  jq -r '.status // ""' "$STATE_DIR/update.json"
}
