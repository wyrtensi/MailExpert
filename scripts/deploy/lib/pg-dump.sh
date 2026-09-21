# shellcheck shell=sh
# Runs in a one-off container of the postgres service (backup.sh, dump_database): dumps the
# panel's database and counts key tables in one exported snapshot, so the counts describe exactly
# what the dump holds. Writes /out/db.dump and /out/counts.json. POSIX sh (busybox).
set -eu
export PGHOST=postgres PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB" PGPASSWORD="$POSTGRES_PASSWORD"
work=$(mktemp -d)
holder=''
cleanup() {
  exec 3>&-
  if [ -n "$holder" ]; then wait "$holder" || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkfifo "$work/sql"
# The exporting transaction stays open until pg_dump and the counts have attached to its snapshot.
psql -X -q -A -t -v ON_ERROR_STOP=1 <"$work/sql" &
holder=$!
exec 3>"$work/sql"
# \o writes the snapshot name into a file and closes it, so the name is on disk, not in a buffer.
printf '%s\n' 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' "\\o $work/snapshot" \
  'SELECT pg_export_snapshot();' '\o' >&3
tries=0
until [ -s "$work/snapshot" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    echo "pg-dump.sh: no exported snapshot after 60s" >&2
    exit 1
  fi
  sleep 1
done
snapshot=$(head -n 1 "$work/snapshot")
pg_dump --snapshot="$snapshot" --format=custom --compress=0 --file=/out/db.dump
{
  printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
  printf "SET TRANSACTION SNAPSHOT '%s';\n" "$snapshot"
  cat /counts.sql
  printf 'COMMIT;\n'
} | psql -X -q -A -t -v ON_ERROR_STOP=1 >/out/counts.json
printf 'COMMIT;\n' >&3
exec 3>&-
wait "$holder"
holder=''
chmod 600 /out/db.dump /out/counts.json
