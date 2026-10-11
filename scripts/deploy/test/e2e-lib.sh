# shellcheck shell=bash
# Shared by the e2e scenarios that run inside the throwaway Docker-in-Docker container.

fail() {
  printf '[e2e] FAIL: %s\n' "$*" >&2
  exit 1
}

pass() { printf '[e2e] ok: %s\n' "$*"; }

# labelled <ps|volume|network> <compose project>
labelled() {
  case $1 in
    ps) docker ps -aq --filter "label=com.docker.compose.project=$2" ;;
    volume) docker volume ls -q --filter "label=com.docker.compose.project=$2" ;;
    network) docker network ls -q --filter "label=com.docker.compose.project=$2" ;;
  esac
}

# remove_project <compose project>: its containers, volumes and networks.
remove_project() {
  labelled ps "$1" | xargs -r docker rm -fv >/dev/null
  labelled volume "$1" | xargs -r docker volume rm >/dev/null
  labelled network "$1" | xargs -r docker network rm >/dev/null
}

# proton_isolation <compose project>: the managed Proton worker as the owner's conditions require:
# it runs as uid 1000 in the backend's network namespace, no other container joins that namespace,
# neither publishes a port (Bridge's random focus port on 127.0.0.1 included), its socket directory
# and state are 0700 and the socket 0600, the backend (uid 1000) reaches the socket and never sees
# the worker's state. Prints the worker's health on success.
proton_isolation() {
  local project=$1 backend worker=$1-proton-worker mode others modes answer
  backend=$(docker inspect -f '{{.Id}}' "$project-backend")
  [ "$(docker inspect -f '{{.State.Running}}' "$worker")" = true ] || fail "$worker is not running"
  mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$worker")
  [ "$mode" = "container:$backend" ] || fail "$worker joins $mode, not the backend's namespace"
  for c in "$worker" "$project-backend"; do
    [ "$(docker inspect -f '{{len .HostConfig.PortBindings}} {{.HostConfig.PublishAllPorts}}' "$c")" = "0 false" ] ||
      fail "$c publishes ports"
  done
  others=$(docker ps -aq --no-trunc | xargs docker inspect -f '{{.Name}} {{.HostConfig.NetworkMode}}' |
    awk -v m="container:$backend" -v w="/$worker" '$2 == m && $1 != w')
  [ -z "$others" ] || fail "other containers in the backend's namespace: $others"
  [ "$(docker exec "$worker" id -u)" = 1000 ] || fail "$worker does not run as uid 1000"
  modes=$(docker exec "$worker" stat -c '%u %a' /run/mailexpert-proton /run/mailexpert-proton/worker.sock /var/lib/mailexpert-proton | paste -sd' ' -)
  [ "$modes" = "1000 700 1000 600 1000 700" ] || fail "proton modes: $modes"
  docker exec "$project-backend" test ! -e /var/lib/mailexpert-proton || fail "the backend sees the worker's state"
  answer=$(docker exec "$project-backend" node -e "require('http').get({socketPath:'/run/mailexpert-proton/worker.sock',path:'/healthz'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(r.statusCode+' '+d))}).on('error',e=>{console.log('error '+e.code);process.exit(1)})") ||
    fail "the backend cannot reach the worker's socket: $answer"
  [[ $answer == "200 "* ]] || fail "the worker's health through the backend: $answer"
  printf '%s\n' "${answer#200 }"
}

