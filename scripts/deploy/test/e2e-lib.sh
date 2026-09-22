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
