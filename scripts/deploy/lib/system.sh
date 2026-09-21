# shellcheck shell=bash
# Setup of a dedicated Ubuntu 24.04 server. install.sh skips all of it with --no-system.

DOCKER_APT_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)

check_os() {
  local id version
  id=$(sed -n 's/^ID=//p' /etc/os-release 2>/dev/null | tr -d '"')
  version=$(sed -n 's/^VERSION_ID=//p' /etc/os-release 2>/dev/null | tr -d '"')
  if [ "$id" != ubuntu ] || [ "$version" != 24.04 ]; then
    die "Ubuntu 24.04 is required, found ${id:-unknown} ${version:-}; --no-system skips host setup"
  fi
}

# check_resources: fatal on the first install, a warning on reruns (data grows).
check_resources() {
  local dir=$OPT_PREFIX cpus mem_kb disk_kb short
  while [ ! -d "$dir" ]; do dir=$(dirname "$dir"); done
  cpus=$(nproc)
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  disk_kb=$(df -Pk "$dir" | awk 'NR == 2 {print $4}')
  short=$(resource_shortfalls "$cpus" "$mem_kb" "$disk_kb")
  [ -n "$short" ] || return 0
  short=$(paste -sd';' - <<<"$short")
  if [ -f "$ENV_FILE" ]; then warn "the host is below the minimum: $short"; else die "the host is too small: $short"; fi
}

install_packages() {
  local version arch codename
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git jq ufw iproute2 util-linux unattended-upgrades >/dev/null
  if version=$(docker compose version --short 2>/dev/null) && version_ge "$version" 2.24.4; then
    return 0
  fi
  if dpkg -s docker.io >/dev/null 2>&1; then
    die "docker.io from Ubuntu is installed and its Compose is too old; remove it (apt-get remove docker.io) and rerun"
  fi
  log "installing Docker Engine and Compose from download.docker.com"
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  arch=$(dpkg --print-architecture)
  codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release)
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$arch" "$codename" >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq "${DOCKER_APT_PACKAGES[@]}" >/dev/null
}

ensure_docker_running() {
  systemctl enable --now docker >/dev/null
}

ensure_swap() {
  [ -z "$(swapon --noheadings --show 2>/dev/null)" ] || return 0
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  log "swap: 2 GB in /swapfile"
}

enable_unattended_upgrades() {
  local file=/etc/apt/apt.conf.d/20auto-upgrades want
  want=$'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";'
  if [ ! -f "$file" ] || [ "$(<"$file")" != "$want" ]; then
    printf '%s\n' "$want" >"$file"
  fi
}

# apply_ufw: deny incoming except SSH and, when Caddy runs, 80/443. Docker publishes ports past
# ufw, which is why the panel publishes only on 127.0.0.1.
apply_ufw() {
  local conf rule
  local -a ports rules
  conf=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}') || conf=''
  mapfile -t ports < <(ssh_ports "$conf" "${SSH_CONNECTION:-}")
  mapfile -t rules < <(ufw_allowed_ports "${ports[@]}")
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  for rule in "${rules[@]}"; do ufw allow "$rule" >/dev/null; done
  ufw --force enable >/dev/null
  log "ufw: allowed ${rules[*]}"
}

# install_timers: a timer is enabled only when its script exists in the checked-out commit.
install_timers() {
  local name script unit
  for name in backup health; do
    case $name in
      backup) script=backup.sh ;;
      health) script=healthcheck.sh ;;
    esac
    if [ ! -x "$APP_DIR/scripts/deploy/$script" ]; then
      log "timer mailexpert-$name: skipped, $CFG_VERSION has no scripts/deploy/$script"
      continue
    fi
    for unit in service timer; do
      render_unit "$APP_DIR/deploy/systemd/mailexpert-$name.$unit" "$OPT_PREFIX" >"/etc/systemd/system/mailexpert-$name.$unit"
    done
    systemctl daemon-reload
    systemctl enable --now "mailexpert-$name.timer" >/dev/null
    log "timer mailexpert-$name: enabled"
  done
}
