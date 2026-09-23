#!/usr/bin/env bash
# Live check of MailExpert against a real mailcow, in a throwaway Docker-in-Docker container.
# Inside it: mailcow (pinned release) as mail.test.local with a certificate from a test CA, and
# the panel (backend, PostgreSQL, Redis) from a published backend image. The driver
# (e2e-mailcow-driver.mjs) then walks the mail node flows through the panel's HTTP API.
# On the host it creates one container, me-e2e-mc-<id>, removed at exit (E2E_KEEP=1 keeps it).
#
#   scripts/deploy/test/e2e-mailcow.sh --image ghcr.io/wyrtensi/mailexpert-backend:sha-<12>
#   scripts/deploy/test/e2e-mailcow.sh --image ... --scenario load [--mailboxes 100] [--imap-process-limit 2048]
#     [--kind gmail] [--panel-env NAME=VALUE ...]
#
# --kind gmail adds the load mailboxes as Gmail mailboxes (imap.gmail.com / smtp.gmail.com, names
# that point at the mailcow node inside the container), so the panel applies its Gmail rules.
# --panel-env passes a setting to the panel, e.g. IMAP_MAX_PERSISTENT_PER_HOST=15.
#
# The default scenario checks the flows once (e2e-mailcow-driver.mjs). The load scenario
# (e2e-mailcow-load.mjs) creates many mailboxes and measures connecting, delivery to all of them,
# reconnecting after a backend restart and ten parallel sessions, sampling the backend's memory
# and CPU and the IMAP sessions on the node every 5 seconds.
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

IMAGE='' SCENARIO=functional MAILBOXES=100 IMAP_PROCESS_LIMIT='' KIND=node PANEL_ENV=''
while [ $# -gt 0 ]; do
  case $1 in
    --image) IMAGE=$2 && shift 2 ;;
    --scenario) SCENARIO=$2 && shift 2 ;;
    --mailboxes) MAILBOXES=$2 && shift 2 ;;
    --imap-process-limit) IMAP_PROCESS_LIMIT=$2 && shift 2 ;;
    --kind) KIND=$2 && shift 2 ;;
    --panel-env)
      [[ $2 =~ ^[A-Z][A-Z0-9_]*=[A-Za-z0-9._:/-]*$ ]] || die "--panel-env must be NAME=VALUE" 2
      PANEL_ENV="$PANEL_ENV -e $2" && shift 2 ;;
    *) die "unknown option: $1" 2 ;;
  esac
done
[ -n "$IMAGE" ] || die "--image <backend image> is required" 2
case $SCENARIO in functional | load) ;; *) die "--scenario must be functional or load" 2 ;; esac
[[ $MAILBOXES =~ ^[1-9][0-9]{0,3}$ ]] || die "--mailboxes must be a number from 1 to 9999" 2
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

log "starting $NAME from $DIND_IMAGE"
docker run -d --privileged --name "$NAME" "$DIND_IMAGE" >/dev/null
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

log "starting the panel from $IMAGE"
secret() { gen_hex 32; }
inner "docker pull -q $IMAGE >/dev/null && docker network create panel >/dev/null \
  && docker run -d --name pg --network panel -e POSTGRES_USER=mailexpert -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mailexpert postgres:16-alpine >/dev/null \
  && docker run -d --name redis --network panel redis:7-alpine >/dev/null"
sleep 5
# The panel reaches the node by name, like in production; here the name points at the host of
# the inner daemon, where mailcow publishes its ports.
PANEL_ARGS="--network panel --add-host $MAIL_HOST:host-gateway -v /opt/testca/ca.pem:/ca/ca.pem:ro -e NODE_EXTRA_CA_CERTS=/ca/ca.pem"
# --kind gmail: the panel resolves mail hosts over DNS, not /etc/hosts, so imap.gmail.com must be
# answered by a DNS server of our own, or the panel would log in to the real Gmail. dnsmasq answers
# the two Gmail names with the node's address and every other outside name with NXDOMAIN; container
# names still resolve through Docker's own DNS, and the node's name through --add-host as before.
GMAIL_IP=''
if [ "$KIND" = gmail ]; then
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
inner "docker run -d --name backend $PANEL_ARGS -e NODE_ENV=production -e PORT=3000 -e APP_URL=http://backend:3000 \
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

# Load: one sample line every 5 seconds: backend memory and CPU, IMAP sessions on the node.
SAMPLES=$(mktemp)
sample() {
  while :; do
    local stats who
    stats=$(inner "docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}}' backend" 2>/dev/null | awk '{print $1, $4}')
    who=$(inner "cd /opt/mailcow && docker compose exec -T dovecot-mailcow doveadm who -1 2>/dev/null | grep -c imap" 2>/dev/null || echo 0)
    printf '%s %s %s\n' "$(date +%s)" "$stats" "$who" >>"$SAMPLES"
    sleep 5
  done
}
sample &
SAMPLER_PID=$!

docker exec -i "$NAME" sh -c 'cat > /opt/load.mjs' <"$TEST_DIR/e2e-mailcow-load.mjs"
DOMAIN="l$(gen_hex 3).test"
phase() {
  log "load phase: $1"
  inner "docker run --rm $PANEL_ARGS -v /opt/load.mjs:/app/e2e-mailcow-load.mjs:ro -w /app \
    -e PANEL=http://backend:3000 -e MAIL_HOST=$MAIL_HOST -e API_KEY=$API_KEY -e MAILBOXES=$MAILBOXES \
    -e DOMAIN=$DOMAIN -e LOAD_KIND=$KIND -e GMAIL_IP=$GMAIL_IP -e PHASE=$1 ${2:-} $IMAGE node e2e-mailcow-load.mjs" | grep '^RESULT '
}
phase setup
phase delivery
phase sessions
log "restarting the backend"
restarted_at=$(( $(date +%s) * 1000 ))
inner 'docker restart backend >/dev/null'
for _ in $(seq 30); do
  if panel_ok; then break; fi
  sleep 3
done
phase restart "-e RESTARTED_AT=$restarted_at"
kill "$SAMPLER_PID" 2>/dev/null || true
SAMPLER_PID=''
# The busiest moments: highest memory (MiB) and CPU, and the most IMAP sessions on the node.
awk '{ mem=$2; if (mem ~ /GiB/) { sub(/GiB/, "", mem); mem*=1024 } else sub(/MiB/, "", mem);
       cpu=$3; sub(/%/, "", cpu);
       if (mem+0 > m) m=mem+0; if (cpu+0 > c) c=cpu+0; if ($4+0 > w) w=$4+0 }
     END { printf "PEAK backend memory %.0f MiB, backend CPU %.0f%%, IMAP sessions on the node %d\n", m, c, w }' "$SAMPLES"
log "samples ($(wc -l <"$SAMPLES") lines): $SAMPLES"
