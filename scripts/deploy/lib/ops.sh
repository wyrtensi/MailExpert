# shellcheck shell=bash
# Decisions of restore.sh and update.sh. Needs common.sh and env.sh.

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

# space_problem <free kB> <last dump bytes>: an update needs twice the dump free: the local
# pre-update dump, and room to restore it next to the current database if the update is undone.
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
