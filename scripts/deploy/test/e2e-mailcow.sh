#!/usr/bin/env bash
# Live check of MailExpert against a real mailcow, in a throwaway Docker-in-Docker container.
# Inside it: mailcow (pinned release) as mail.test.local with a certificate from a test CA, and
# the panel (backend, PostgreSQL, Redis) from a published backend image. The driver
# (e2e-mailcow-driver.mjs) then walks the mail node flows through the panel's HTTP API.
# On the host it creates one container, me-e2e-mc-<id>, removed at exit (E2E_KEEP=1 keeps it).
#
#   scripts/deploy/test/e2e-mailcow.sh --image ghcr.io/wyrtensi/mailexpert-backend:sha-<12>
#   scripts/deploy/test/e2e-mailcow.sh --image ... --scenario load [--mailboxes 100] [--imap-process-limit 2048]
#     [--node-tuning] [--kind gmail] [--panel-env NAME=VALUE ...]
#   scripts/deploy/test/e2e-mailcow.sh --image ... --scenario search --mailboxes 500 --node-tuning \
#     --levels 1000,5000,10000,30000,50000,100000 [--gmail-mailboxes 125]
#     [--server-cpuset 0-3 --server-cpus 2.8 --server-memory 8g --server-swap 2g]
#   scripts/deploy/test/e2e-mailcow.sh --image ... --scenario work --mailboxes 90 --gmail-mailboxes 110 \
#     --node-tuning --letters 300 --work-seconds 600 [--server-* ...]
#
# --gmail-mailboxes adds that many Gmail mailboxes next to the node's (load and search scenarios):
# mailcow mailboxes the panel reaches as imap.gmail.com, see --kind gmail. They get as many letters
# each as a node mailbox. On the real server Gmail's side is Google's: the Dovecot memory their
# sessions take here is the test's own, and the load summary reports it apart (gmail-like RSS).
# --server-* cap the whole container (mailcow, the panel and the inner Docker) like one server:
# the CPUs it may run on, the CPU time (in CPUs), the memory and the swap on top of it.
# --node-tuning applies the node settings docs/operations/mail-node.md recommends: the Dovecot
# overrides from scripts/deploy/mail-node/dovecot-extra.conf.
# --kind gmail adds the load mailboxes as Gmail mailboxes (imap.gmail.com / smtp.gmail.com, names
# that point at the mailcow node inside the container), so the panel applies its Gmail rules.
# --panel-env passes a setting to the panel, e.g. IMAP_MAX_PERSISTENT_PER_HOST=15.
#
# The default scenario checks the flows once (e2e-mailcow-driver.mjs). The load scenario
# (e2e-mailcow-load.mjs) creates many mailboxes and measures connecting, delivery to all of them,
# reconnecting after a backend restart and ten parallel sessions, sampling the memory of every
# container (mailcow and the panel) and the IMAP sessions and processes on the node every 5 seconds.
# The search scenario grows the mail to each of --levels letters in all (spread evenly over the
# mailboxes, imported straight into Dovecot) and, at each level, measures the panel's search by ten
# employees while the panel syncs the new letters, at rest (every letter opened, so body text is
# searched too), while one letter goes to every mailbox, and while all mailboxes reconnect after a
# backend restart; with memory and CPU peaks and the database size for the level.
# The work scenario seeds --letters letters in every mailbox and lets ten employees work in the
# shared mailboxes for --work-seconds (e2e-mailcow-load.mjs PHASE=work): moves, archive and Trash go
# through the panel's move queue. One letter goes to every mailbox as they start, and the backend
# restarts half way. Then it waits for the move queue to empty and checks every seeded letter in the
# panel against the node's own list: none lost, none twice, each in the folder the panel shows.
# The panel runs with the production limits of deploy/compose.prod.yml (memory caps, Node heap,
# PostgreSQL shared_buffers).
#
# Needs about 6 GB of memory for Docker and pulls a few GB of mailcow images on every run; it is
# a manual check, not part of CI. From Git Bash on Windows run it with MSYS_NO_PATHCONV=1, so
# container paths such as /opt reach docker.exe unchanged.
set -euo pipefail

DIND_IMAGE=docker:29.8.1-dind
MAILCOW_REF=2026-09
MAIL_HOST=mail.test.local
TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$TEST_DIR/../lib/common.sh"

IMAGE='' SCENARIO=functional MAILBOXES=100 IMAP_PROCESS_LIMIT='' NODE_TUNING=0 KIND=node PANEL_ENV='' LEVELS=''
GMAIL_MAILBOXES=0 SERVER_LIMITS='' LETTERS=300 WORK_SECONDS=600
while [ $# -gt 0 ]; do
  case $1 in
    --image) IMAGE=$2 && shift 2 ;;
    --scenario) SCENARIO=$2 && shift 2 ;;
    --mailboxes) MAILBOXES=$2 && shift 2 ;;
    --gmail-mailboxes) GMAIL_MAILBOXES=$2 && shift 2 ;;
    --levels) LEVELS=$2 && shift 2 ;;
    --letters) LETTERS=$2 && shift 2 ;;
    --work-seconds) WORK_SECONDS=$2 && shift 2 ;;
    --server-cpuset)
      [[ $2 =~ ^[0-9]+([-,][0-9]+)*$ ]] || die "--server-cpuset must be a CPU list such as 0-3" 2
      SERVER_LIMITS="$SERVER_LIMITS --cpuset-cpus $2" && shift 2 ;;
    --server-cpus)
      [[ $2 =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--server-cpus must be a number such as 2.8" 2
      SERVER_LIMITS="$SERVER_LIMITS --cpus $2" && shift 2 ;;
    --server-memory)
      [[ $2 =~ ^[1-9][0-9]*g$ ]] || die "--server-memory must be in gigabytes, such as 8g" 2
      SERVER_MEMORY=${2%g} && shift 2 ;;
    --server-swap)
      [[ $2 =~ ^[0-9]+g$ ]] || die "--server-swap must be in gigabytes, such as 2g" 2
      SERVER_SWAP=${2%g} && shift 2 ;;
    --imap-process-limit) IMAP_PROCESS_LIMIT=$2 && shift 2 ;;
    --node-tuning) NODE_TUNING=1 && shift ;;
    --kind) KIND=$2 && shift 2 ;;
    --panel-env)
      [[ $2 =~ ^[A-Z][A-Z0-9_]*=[A-Za-z0-9._:/-]*$ ]] || die "--panel-env must be NAME=VALUE" 2
      PANEL_ENV="$PANEL_ENV -e $2" && shift 2 ;;
    *) die "unknown option: $1" 2 ;;
  esac
done
[ -n "$IMAGE" ] || die "--image <backend image> is required" 2
case $SCENARIO in functional | load | search | work) ;; *) die "--scenario must be functional, load, search or work" 2 ;; esac
[[ $LETTERS =~ ^[1-9][0-9]{0,4}$ ]] || die "--letters must be a number from 1 to 99999" 2
[[ $WORK_SECONDS =~ ^[1-9][0-9]{1,4}$ ]] || die "--work-seconds must be a number from 10 to 99999" 2
[[ $MAILBOXES =~ ^[1-9][0-9]{0,3}$ ]] || die "--mailboxes must be a number from 1 to 9999" 2
[[ $GMAIL_MAILBOXES =~ ^[0-9]{1,3}$ ]] || die "--gmail-mailboxes must be a number from 0 to 999" 2
if [ -n "${SERVER_MEMORY:-}" ]; then
  # Docker's --memory-swap is memory and swap together.
  SERVER_LIMITS="$SERVER_LIMITS --memory ${SERVER_MEMORY}g --memory-swap $((SERVER_MEMORY + ${SERVER_SWAP:-0}))g"
elif [ -n "${SERVER_SWAP:-}" ]; then
  die "--server-swap needs --server-memory" 2
fi
if [ "$GMAIL_MAILBOXES" != 0 ]; then
  [ "$KIND" = node ] || die "--gmail-mailboxes adds to node mailboxes; drop --kind gmail" 2
  [ "$SCENARIO" != functional ] || die "--gmail-mailboxes is for the load and search scenarios" 2
fi
if [ "$SCENARIO" = search ] || [ "$SCENARIO" = work ]; then
  [ "$KIND" = node ] || die "--scenario $SCENARIO runs on node mailboxes (add Gmail ones with --gmail-mailboxes)" 2
fi
if [ "$SCENARIO" = search ]; then
  [[ $LEVELS =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]] || die "--levels must be a comma-separated list of letter counts" 2
  previous=0
  for level in ${LEVELS//,/ }; do
    [ $((level % MAILBOXES)) = 0 ] || die "--levels: $level letters do not split evenly over $MAILBOXES mailboxes" 2
    [ "$level" -gt "$previous" ] || die "--levels must grow" 2
    previous=$level
  done
fi
[ -z "$IMAP_PROCESS_LIMIT" ] || [[ $IMAP_PROCESS_LIMIT =~ ^[1-9][0-9]{2,4}$ ]] || die "--imap-process-limit must be a number from 100 to 99999" 2
case $KIND in node | gmail) ;; *) die "--kind must be node or gmail" 2 ;; esac

NAME=me-e2e-mc-${E2E_ID:-$(gen_hex 4)}
if docker container inspect "$NAME" >/dev/null 2>&1; then die "container $NAME already exists"; fi

SAMPLER_PID=''
cleanup() {
  local status=$?
  if [ -n "$SAMPLER_PID" ]; then kill "$SAMPLER_PID" 2>/dev/null || true; fi
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    log "kept $NAME; remove it with: docker rm -fv $NAME"
  elif docker container inspect "$NAME" >/dev/null 2>&1; then
    docker rm -fv "$NAME" >/dev/null || warn "could not remove $NAME"
  fi
  exit "$status"
}
trap cleanup EXIT

inner() { docker exec "$NAME" sh -c "$1"; }

log "starting $NAME from $DIND_IMAGE${SERVER_LIMITS:+ with$SERVER_LIMITS}"
# shellcheck disable=SC2086 # SERVER_LIMITS is a list of options
docker run -d --privileged $SERVER_LIMITS --name "$NAME" "$DIND_IMAGE" >/dev/null
for _ in $(seq 60); do
  if docker exec "$NAME" docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" docker info >/dev/null 2>&1 || die "the inner docker daemon did not start"
inner 'apk add --no-cache --quiet bash git curl openssl jq coreutils iproute2 findutils grep sed gawk >/dev/null'

log "configuring mailcow $MAILCOW_REF as $MAIL_HOST"
inner "git clone -q --depth 1 -c advice.detachedHead=false -b $MAILCOW_REF https://github.com/mailcow/mailcow-dockerized /opt/mailcow"
# --dev keeps the pinned tag instead of switching to a branch.
inner "cd /opt/mailcow && ln -sf mailcow.conf .env && MAILCOW_HOSTNAME=$MAIL_HOST MAILCOW_TZ=UTC SKIP_CLAMD=y ./generate_config.sh --dev </dev/null >/dev/null 2>&1"
API_KEY="$(gen_hex 16)-$(gen_hex 8)"
# The recursive resolver cannot reach the root servers from inside Docker Desktop, so its health
# check is skipped; local delivery between the test mailboxes needs no outside DNS.
inner "cd /opt/mailcow && sed -i \
  -e 's/^SKIP_LETS_ENCRYPT=n/SKIP_LETS_ENCRYPT=y/' -e 's/^SKIP_FTS=n/SKIP_FTS=y/' -e 's/^SKIP_OLEFY=n/SKIP_OLEFY=y/' \
  -e 's/^SKIP_UNBOUND_HEALTHCHECK=n/SKIP_UNBOUND_HEALTHCHECK=y/' \
  -e 's|^#API_KEY=\$|API_KEY=$API_KEY|' -e 's|^#API_ALLOW_FROM=.*|API_ALLOW_FROM=172.16.0.0/12,127.0.0.1|' mailcow.conf"
inner "grep -q '^API_KEY=$API_KEY\$' /opt/mailcow/mailcow.conf" || die "mailcow.conf has no API_KEY line to set"

log "issuing a test CA and a certificate for $MAIL_HOST"
inner "mkdir -p /opt/testca && cd /opt/testca \
  && openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 7 -subj '/CN=MailExpert e2e CA' 2>/dev/null \
  && openssl req -newkey rsa:2048 -nodes -keyout key.pem -out req.csr -subj '/CN=$MAIL_HOST' 2>/dev/null \
  && printf 'subjectAltName=DNS:$MAIL_HOST,DNS:imap.gmail.com,DNS:smtp.gmail.com\nextendedKeyUsage=serverAuth\n' > ext.cnf \
  && openssl x509 -req -in req.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out cert.pem -days 7 -extfile ext.cnf 2>/dev/null \
  && cp cert.pem key.pem /opt/mailcow/data/assets/ssl/"

# The node setting docs/operations/mail-node.md (section 6a) asks for from about 400 mailboxes.
if [ -n "$IMAP_PROCESS_LIMIT" ]; then
  log "raising the dovecot imap process_limit to $IMAP_PROCESS_LIMIT"
  inner "printf 'service imap {\n  process_limit = %s\n}\n' $IMAP_PROCESS_LIMIT >> /opt/mailcow/data/conf/dovecot/extra.conf"
fi
if [ "$NODE_TUNING" = 1 ]; then
  log "applying the recommended node settings"
  docker exec -i "$NAME" sh -c 'cat >> /opt/mailcow/data/conf/dovecot/extra.conf' <"$TEST_DIR/../mail-node/dovecot-extra.conf"
fi

log "starting mailcow (pulls its images)"
inner 'cd /opt/mailcow && docker compose pull -q >/dev/null 2>&1 && docker compose up -d >/dev/null 2>&1'
api_ok() {
  inner "curl -fsS --cacert /opt/testca/ca.pem --resolve $MAIL_HOST:443:127.0.0.1 -H 'X-API-Key: $API_KEY' https://$MAIL_HOST/api/v1/get/status/version >/dev/null 2>&1"
}
for _ in $(seq 90); do
  if api_ok; then break; fi
  sleep 5
done
api_ok || die "the mailcow API did not answer"
if [ -n "$IMAP_PROCESS_LIMIT" ]; then
  applied=$(inner 'cd /opt/mailcow && docker compose exec -T dovecot-mailcow doveconf -h service/imap/process_limit' | tr -d '\r')
  [ "$applied" = "$IMAP_PROCESS_LIMIT" ] || die "dovecot imap process_limit is $applied, expected $IMAP_PROCESS_LIMIT"
  log "dovecot imap process_limit is $applied"
fi
if [ "$NODE_TUNING" = 1 ]; then
  dove_setting() { inner "cd /opt/mailcow && docker compose exec -T dovecot-mailcow doveconf -h $1" | tr -d '\r'; }
  applied=$(dove_setting service/imap-login/service_count)
  [ "$applied" = 0 ] || die "dovecot imap-login service_count is $applied, expected 0"
  applied=$(dove_setting imap_hibernate_timeout)
  case $applied in '' | 0 | '0 secs') die "dovecot imap_hibernate_timeout is '$applied', hibernation is off" ;; esac
  log "dovecot runs the recommended settings (login service_count 0, hibernation after $applied)"
fi

log "starting the panel from $IMAGE"
secret() { gen_hex 32; }
# An image the host already has (for example, built locally from a branch) is copied in, not pulled.
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker save "$IMAGE" | docker exec -i "$NAME" docker load -q >/dev/null
else
  inner "docker pull -q $IMAGE >/dev/null"
fi
# Memory caps and database settings as in docker-compose.yml and deploy/compose.prod.yml, /dev/shm
# included: at 64 MB, PostgreSQL's parallel work fails on a large messages table.
inner "docker network create panel >/dev/null \
  && docker run -d --name pg --network panel --memory 2g --shm-size 256m -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mailexpert \
    postgres:16-alpine postgres -c shared_buffers=1GB -c effective_cache_size=3GB -c random_page_cost=1.1 >/dev/null \
  && docker run -d --name redis --network panel redis:7-alpine \
    redis-server --save 60 1 --loglevel warning --maxmemory 256mb --maxmemory-policy noeviction >/dev/null"
sleep 5
# The panel reaches the node by name, like in production; here the name points at the host of
# the inner daemon, where mailcow publishes its ports.
PANEL_ARGS="--network panel --add-host $MAIL_HOST:host-gateway -v /opt/testca/ca.pem:/ca/ca.pem:ro -e NODE_EXTRA_CA_CERTS=/ca/ca.pem"
# --kind gmail: the panel resolves mail hosts over DNS, not /etc/hosts, so imap.gmail.com must be
# answered by a DNS server of our own, or the panel would log in to the real Gmail. dnsmasq answers
# the two Gmail names with the node's address and every other outside name with NXDOMAIN; container
# names still resolve through Docker's own DNS, and the node's name through --add-host as before.
GMAIL_IP=''
if [ "$KIND" = gmail ] || [ "$GMAIL_MAILBOXES" != 0 ]; then
  GMAIL_IP=$(inner "docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'" | tr -d '\r')
  [[ $GMAIL_IP =~ ^[0-9.]+$ ]] || die "could not find the inner Docker gateway address"
  inner "docker run -d --name dns --network panel alpine:3.22 sh -c 'apk add -q --no-cache dnsmasq \
    && exec dnsmasq -k --no-resolv --address=/imap.gmail.com/$GMAIL_IP --address=/smtp.gmail.com/$GMAIL_IP --address=/#/' >/dev/null"
  DNS_IP=''
  for _ in $(seq 30); do
    DNS_IP=$(inner "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' dns" | tr -d '\r')
    if inner "docker exec dns nslookup imap.gmail.com 127.0.0.1 2>/dev/null | grep -q '$GMAIL_IP'"; then break; fi
    sleep 2
  done
  inner "docker exec dns nslookup imap.gmail.com 127.0.0.1 2>/dev/null | grep -q '$GMAIL_IP'" || die "the test DNS server did not start"
  PANEL_ARGS="$PANEL_ARGS --dns $DNS_IP"
  log "imap.gmail.com and smtp.gmail.com resolve to the node ($GMAIL_IP) through $DNS_IP"
fi
inner "docker run -d --name backend $PANEL_ARGS --memory 1536m -e NODE_OPTIONS=--max-old-space-size=1024 \
  -e NODE_ENV=production -e PORT=3000 -e APP_URL=http://backend:3000 \
  -e SESSION_SECRET=$(secret) -e ENCRYPTION_KEY=$(secret) -e DB_HOST=pg -e DB_PASSWORD=pw -e REDIS_URL=redis://redis:6379 \
  -e AUTH_MODE=local $PANEL_ENV $IMAGE >/dev/null"
panel_ok() { inner "docker run --rm --network panel $IMAGE node -e \"fetch('http://backend:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\"" >/dev/null 2>&1; }
for _ in $(seq 30); do
  if panel_ok; then break; fi
  sleep 3
done
panel_ok || die "the panel did not become healthy"

if [ "$SCENARIO" = functional ]; then
  log "running the checks"
  docker exec -i "$NAME" sh -c 'cat > /opt/driver.mjs' <"$TEST_DIR/e2e-mailcow-driver.mjs"
  inner "docker run --rm $PANEL_ARGS -v /opt/driver.mjs:/app/e2e-mailcow-driver.mjs:ro -w /app     -e PANEL=http://backend:3000 -e MAIL_HOST=$MAIL_HOST -e API_KEY=$API_KEY $IMAGE node e2e-mailcow-driver.mjs"
  exit 0
fi

# Load: every 5 seconds, the memory and CPU of every container (STATS: time, name, memory, CPU) and,
# on the node, the IMAP sessions and the imap, imap-login and imap-hibernate processes (SAMPLES).
SAMPLES=$(mktemp)
STATS=$(mktemp)
sample() {
  # A failed probe loses one reading, not the sampler: a process that exits between listing /proc and
  # reading it makes cat fail, and under errexit and pipefail that would end the whole loop.
  set +e +o pipefail
  while :; do
    local now who procs
    now=$(date +%s)
    inner "docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}'" 2>/dev/null \
      | awk -v t="$now" 'NF { print t, $1, $2, $NF }' >>"$STATS"
    who=$(inner "cd /opt/mailcow && docker compose exec -T dovecot-mailcow doveadm who -1 2>/dev/null | grep -c imap" 2>/dev/null)
    procs=$(inner "cd /opt/mailcow && docker compose exec -T dovecot-mailcow sh -c 'cat /proc/[0-9]*/comm 2>/dev/null'" 2>/dev/null \
      | tr -d '\r' | awk '$1 == "imap" { i++ } $1 == "imap-login" { l++ } $1 == "imap-hibernate" { h++ } END { printf "%d %d %d", i, l, h }')
    who=$(printf '%s' "$who" | tr -d '\r')
    gmail=0
    if [ "$GMAIL_MAILBOXES" != 0 ]; then
      gmail=$(inner "docker exec -i mailcowdockerized-dovecot-mailcow-1 sh -s < /opt/gmail-rss.sh" 2>/dev/null | tr -d '\r')
    fi
    printf '%s %s %s %s\n' "$now" "${who:-0}" "$procs" "${gmail:-0}" >>"$SAMPLES"
    sleep 5
  done
}
# The memory (MiB) of the Dovecot processes that serve the Gmail-like mailboxes (gbox*), which the real
# server does not carry: their anonymous resident memory (RssAnon, own to each process; smaps and PSS
# are not readable without ptrace). mailcow's process titles carry no user name, so the processes come
# from doveadm who (user, protocol, pid, address); a hibernated session points at the shared
# imap-hibernate process, counted once.
docker exec -i "$NAME" sh -c 'cat > /opt/gmail-rss.sh' <<'RSS'
doveadm who -1 2>/dev/null | awk '$1 ~ /^gbox/ { print $3 }' | sort -u | while read -r pid; do
  sed -n 's/^RssAnon:[[:space:]]*\([0-9]*\).*/\1/p' "/proc/$pid/status" 2>/dev/null
done | awk '{ s += $1 } END { print int(s / 1024) }'
RSS
sample &
SAMPLER_PID=$!

docker exec -i "$NAME" sh -c 'cat > /opt/load.mjs' <"$TEST_DIR/e2e-mailcow-load.mjs"
DOMAIN="l$(gen_hex 3).test"
phase() {
  log "load phase: $1"
  inner "docker run --rm $PANEL_ARGS -v /opt/load.mjs:/app/e2e-mailcow-load.mjs:ro -w /app \
    -e PANEL=http://backend:3000 -e MAIL_HOST=$MAIL_HOST -e API_KEY=$API_KEY -e MAILBOXES=$MAILBOXES \
    -e DOMAIN=$DOMAIN -e LOAD_KIND=$KIND -e GMAIL_IP=$GMAIL_IP -e GMAIL_MAILBOXES=$GMAIL_MAILBOXES \
    -e PGHOST=pg -e PGUSER=mailexpert -e PGPASSWORD=pw -e PGDATABASE=mailexpert -e PHASE=$1 ${2:-} $IMAGE node e2e-mailcow-load.mjs" | grep '^RESULT '
}
restart_backend() {
  log "restarting the backend"
  restarted_at=$(( $(date +%s) * 1000 ))
  inner 'docker restart backend >/dev/null'
  for _ in $(seq 30); do
    if panel_ok; then break; fi
    sleep 3
  done
}
# After a restart: seconds until every mailbox has a session on the node again. The panel's
# last_sync is no proof of that: the folder status monitor syncs a mailbox over a background
# connection before its own connection is back.
wait_sessions() {
  local want=$((MAILBOXES + GMAIL_MAILBOXES)) have=0
  for _ in $(seq 360); do
    have=$(inner "docker exec mailcowdockerized-dovecot-mailcow-1 doveadm who -1" 2>/dev/null | awk 'NR > 1 { print $1 }' | sort -u | wc -l)
    [ "$have" -ge "$want" ] && break
    sleep 5
  done
  printf 'RESULT {"phase":"restart-sessions","mailboxes":%d,"of":%d,"seconds":%d}\n' \
    "$have" "$want" $(( $(date +%s) - restarted_at / 1000 ))
  [ "$have" -ge "$want" ] || die "only $have of $want mailboxes have a session on the node after the restart"
}
# Memory (MiB) and CPU (% of one core) peaks between two times, for one search level.
level_peaks() {
  awk -v label="$1" -v a="$2" -v b="$3" \
    'function mib(v) { if (v ~ /GiB$/) return v * 1024; if (v ~ /MiB$/) return v + 0; if (v ~ /KiB$/) return v / 1024; return 0 }
     $1 >= a && $1 <= b {
       m = mib($3); cpu = $4; sub(/%/, "", cpu); name = $2; sub(/^mailcowdockerized-/, "", name); sub(/-1$/, "", name)
       if (m > peak[name]) peak[name] = m; if (cpu + 0 > cpeak[name]) cpeak[name] = cpu + 0
       group = $2 ~ /^mailcowdockerized-/ ? "mailcow" : (name ~ /^(backend|pg|redis)$/ ? "panel" : "")
       if (group != "") { sum[$1, group] += m; sum[$1, "both"] += m; times[$1] = 1 } }
     END {
       split("mailcow panel both", gs, " ")
       for (i = 1; i <= 3; i++) for (t in times) if (sum[t, gs[i]] > top[gs[i]]) top[gs[i]] = sum[t, gs[i]]
       printf "LEVEL %s letters: memory peak mailcow %.0f MiB (dovecot %.0f), panel %.0f MiB (backend %.0f, pg %.0f), both %.0f MiB; CPU peak backend %.0f%%, pg %.0f%%, dovecot %.0f%%\n",
         label, top["mailcow"], peak["dovecot-mailcow"], top["panel"], peak["backend"], peak["pg"], top["both"],
         cpeak["backend"], cpeak["pg"], cpeak["dovecot-mailcow"] }' "$STATS"
}

phase setup
DOVECOT=mailcowdockerized-dovecot-mailcow-1
if [ "$SCENARIO" = work ]; then
  phase users
  all=$((MAILBOXES + GMAIL_MAILBOXES))
  log "seeding $LETTERS letters in each of $all mailboxes"
  inner 'rm -rf /opt/seed && mkdir -m 777 /opt/seed'
  phase seed "-v /opt/seed:/seed -e SEED_FROM=0 -e SEED_COUNT=$LETTERS"
  inner "docker cp /opt/seed/. $DOVECOT:/tmp/seed && rm -rf /opt/seed"
  phase search "-e SEARCH_LABEL=sync -e SEARCH_UNTIL_ROWS=$((LETTERS * all))" &
  search_pid=$!
  inner "docker exec $DOVECOT sh -c 'chown -R vmail:vmail /tmp/seed \
    && { ls /tmp/seed | xargs -P 8 -I{} doveadm import -u {}@$DOMAIN maildir:/tmp/seed/{} \"\" all >/tmp/import.log 2>&1 \
         || { grep -v \": Info: \" /tmp/import.log | tail -20; exit 1; }; } && rm -rf /tmp/seed /tmp/import.log'"
  wait "$search_pid"
  work_started=$(date +%s)
  inner 'rm -rf /opt/work && mkdir -m 777 /opt/work'
  phase work "-v /opt/work:/seed -e WORK_SECONDS=$WORK_SECONDS" &
  work_pid=$!
  phase delivery
  sleep $((WORK_SECONDS / 2))
  restart_backend
  wait "$work_pid"
  phase drain
  # Syncs the moves set off (destination folders, flags) settle before the node is listed.
  sleep 60
  inner "docker exec $DOVECOT doveadm -f tab fetch -A 'mailbox hdr.message-id' all > /opt/work/server.tsv"
  phase verify "-v /opt/work:/seed"
  level_peaks work "$work_started" "$(date +%s)"
elif [ "$SCENARIO" = search ]; then
  phase users
  have=0
  for level in ${LEVELS//,/ }; do
    per=$((level / MAILBOXES))
    level_started=$(date +%s)
    log "level $level letters on the node's mailboxes, $((per * (MAILBOXES + GMAIL_MAILBOXES))) with the Gmail ones: $((per - have)) new per mailbox, $per in all"
    inner 'rm -rf /opt/seed && mkdir -m 777 /opt/seed'
    phase seed "-v /opt/seed:/seed -e SEED_FROM=$have -e SEED_COUNT=$((per - have))"
    inner "docker cp /opt/seed/. $DOVECOT:/tmp/seed && rm -rf /opt/seed"
    # Dovecot takes the letters and the panel syncs them while the employees search.
    phase search "-e SEARCH_LABEL=sync -e SEARCH_UNTIL_ROWS=$((per * (MAILBOXES + GMAIL_MAILBOXES)))" &
    search_pid=$!
    # doveadm logs every letter it copies; its output is shown only when an import fails.
    inner "docker exec $DOVECOT sh -c 'chown -R vmail:vmail /tmp/seed \
      && { ls /tmp/seed | xargs -P 8 -I{} doveadm import -u {}@$DOMAIN maildir:/tmp/seed/{} \"\" all >/tmp/import.log 2>&1 \
           || { grep -v \": Info: \" /tmp/import.log | tail -20; exit 1; }; } && rm -rf /tmp/seed /tmp/import.log'"
    wait "$search_pid"
    have=$per
    phase bodies
    phase search "-e SEARCH_LABEL=rest -e SEARCH_SECONDS=60"
    phase search "-e SEARCH_LABEL=delivery -e SEARCH_SECONDS=60" &
    search_pid=$!
    phase delivery
    wait "$search_pid"
    restart_backend
    phase search "-e SEARCH_LABEL=restart -e SEARCH_SECONDS=120" &
    search_pid=$!
    phase restart "-e RESTARTED_AT=$restarted_at"
    wait_sessions
    wait "$search_pid"
    level_peaks "$level" "$level_started" "$(date +%s)"
    if [ "$GMAIL_MAILBOXES" != 0 ]; then
      awk -v label="$level" -v a="$level_started" -v b="$(date +%s)" '$1 >= a && $1 <= b && $6 + 0 > g { g = $6 + 0 }
        END { printf "LEVEL %s letters: the Gmail-like sessions take up to %d MiB of the node (not on the real server)\n", label, g }' "$SAMPLES"
    fi
  done
else
  phase delivery
  phase sessions
  restart_backend
  phase restart "-e RESTARTED_AT=$restarted_at"
  wait_sessions
fi
kill "$SAMPLER_PID" 2>/dev/null || true
SAMPLER_PID=''
# The busiest moments. Memory in MiB: the peak of each container, and the peak of the sum over
# mailcow's containers, over the panel's (backend, pg, redis) and over both at the same moment; the
# first sample is the idle node before any mailbox exists.
awk 'function mib(v) { if (v ~ /GiB$/) return v * 1024; if (v ~ /MiB$/) return v + 0; if (v ~ /KiB$/) return v / 1024; return 0 }
     { m = mib($3); cpu = $4; sub(/%/, "", cpu); name = $2; sub(/^mailcowdockerized-/, "", name); sub(/-1$/, "", name)
       if (m > peak[name]) peak[name] = m
       if (name == "backend" && cpu + 0 > bcpu) bcpu = cpu + 0
       group = $2 ~ /^mailcowdockerized-/ ? "mailcow" : (name ~ /^(backend|pg|redis)$/ ? "panel" : "")
       if (group != "") { sum[$1, group] += m; sum[$1, "both"] += m; times[$1] = 1 } }
     END {
       first = ""; for (t in times) if (first == "" || t + 0 < first + 0) first = t
       split("mailcow panel both", gs, " ")
       for (i = 1; i <= 3; i++) { g = gs[i]; for (t in times) if (sum[t, g] > top[g]) top[g] = sum[t, g] }
       printf "PEAK backend memory %.0f MiB, backend CPU %.0f%%\n", peak["backend"], bcpu
       printf "PEAK memory together: mailcow %.0f MiB, panel %.0f MiB, both %.0f MiB (idle at start: mailcow %.0f MiB, panel %.0f MiB)\n",
         top["mailcow"], top["panel"], top["both"], sum[first, "mailcow"], sum[first, "panel"]
       for (n in peak) printf "PEAK container %s %.0f MiB\n", n, peak[n] | "sort -k4 -n -r"
     }' "$STATS"
awk -v end="$(date +%s)" '{ if ($2 + 0 > w) w = $2 + 0; if ($3 + 0 > i) i = $3 + 0; if ($4 + 0 > l) l = $4 + 0; if ($5 + 0 > h) h = $5 + 0; if ($6 + 0 > g) g = $6 + 0
       if (NR == 1) first = $1; last = $1 }
     END { printf "PEAK on the node: IMAP sessions %d, imap processes %d, imap-login %d, imap-hibernate %d, Gmail-like sessions %d MiB\n", w, i, l, h, g
           printf "SAMPLES %d over %d s, the last one %d s before the end\n", NR, last - first, end - last }' "$SAMPLES"
log "samples: $SAMPLES (node) and $STATS (containers)"
