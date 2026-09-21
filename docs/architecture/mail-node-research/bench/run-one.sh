#!/bin/bash
# Run one N-mailbox benchmark iteration: fresh dovecot container, fresh node
# bench.js container, sample docker stats/top while idle, force-remove both
# (no waiting for bench.js's own graceful-logout timer — that's a long safety
# hold, not something we need to wait out here).
set -uo pipefail
N="$1"
HOLD="${2:-60}"
DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="$DIR/results"
mkdir -p "$RESULTS_DIR"
OUT="$RESULTS_DIR/N${N}.log"

: > "$OUT"
echo "=== N=$N hold=${HOLD}s $(date -u +%FT%TZ) ===" | tee -a "$OUT"

MSYS_NO_PATHCONV=1 docker rm -f me-bench-dovecot >/dev/null 2>&1
MSYS_NO_PATHCONV=1 docker run -d --name me-bench-dovecot --network me-bench-net me-bench-dovecot:latest >/dev/null
sleep 2

NODE_NAME="me-bench-node-${N}"
MSYS_NO_PATHCONV=1 docker rm -f "$NODE_NAME" >/dev/null 2>&1
MSYS_NO_PATHCONV=1 docker run -d --name "$NODE_NAME" --network me-bench-net -e BENCH_HOST=me-bench-dovecot me-bench-node:latest "$N" "$HOLD" >/dev/null

echo "--- waiting for READY_FOR_EXTERNAL_SAMPLING ---" >> "$OUT"
ready=0
for i in $(seq 1 240); do
  if docker logs "$NODE_NAME" 2>&1 | grep -q READY_FOR_EXTERNAL_SAMPLING; then
    ready=1
    break
  fi
  if docker logs "$NODE_NAME" 2>&1 | grep -q BENCH_FATAL; then
    break
  fi
  sleep 2
done
echo "ready=$ready after $((i*2))s" >> "$OUT"

echo "--- node logs (connect phase) ---" >> "$OUT"
docker logs "$NODE_NAME" >> "$OUT" 2>&1

# bench.js holds ~180s after printing READY before it does anything else, so we have
# a wide, safe window here — sample promptly, well clear of any teardown.
echo "--- sampling docker stats (3x, 5s apart) ---" >> "$OUT"
for s in 1 2 3; do
  echo "-- sample $s --" >> "$OUT"
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}\t{{.PIDs}}' me-bench-dovecot "$NODE_NAME" >> "$OUT" 2>&1
  sleep 5
done

echo "--- docker top me-bench-dovecot ---" >> "$OUT"
TOP_OUT=$(docker top me-bench-dovecot -eo pid,rss,args 2>&1)
echo "$TOP_OUT" >> "$OUT"

IMAP_COUNT=$(echo "$TOP_OUT" | grep -c 'dovecot/imap \[')
LOGIN_COUNT=$(echo "$TOP_OUT" | grep -c 'dovecot/imap-login')
IDLE_COUNT=$(echo "$TOP_OUT" | grep -c 'IDLE\]')
echo "imap_procs=$IMAP_COUNT imaplogin_procs=$LOGIN_COUNT idle_procs=$IDLE_COUNT" | tee -a "$OUT"

echo "--- node logs (again, should be unchanged) ---" >> "$OUT"
docker logs "$NODE_NAME" >> "$OUT" 2>&1

MSYS_NO_PATHCONV=1 docker rm -f "$NODE_NAME" >/dev/null 2>&1
MSYS_NO_PATHCONV=1 docker rm -f me-bench-dovecot >/dev/null 2>&1

echo "DONE N=$N" | tee -a "$OUT"
