#!/bin/bash
# Managed Proton Bridge worker entrypoint: private state, pass/GPG keychain, then the
# controller. Bridge itself is started lazily by the controller, never from here.
set -euo pipefail
umask 077

if [ "$(id -u)" != 1000 ] || [ "$(id -g)" != 1000 ]; then
  echo "proton-worker: must run as uid/gid 1000" >&2
  exit 1
fi

state="${PROTON_WORKER_STATE_DIR:-/var/lib/mailexpert-proton}"
export GNUPGHOME="$state/bridge/gnupg"
export PASSWORD_STORE_DIR="$state/bridge/password-store"

for dir in "$state" "$state/bridge" "$state/controller" "$GNUPGHOME"; do
  mkdir -p "$dir"
  chmod 0700 "$dir"
  if [ "$(stat -c %u "$dir")" != 1000 ]; then
    echo "proton-worker: state directory is not owned by uid 1000" >&2
    exit 1
  fi
done

# Bridge keeps its vault key in the Linux "pass" keychain. The GPG key protecting it
# lives only in the private worker state and is created once.
if [ ! -s "$PASSWORD_STORE_DIR/.gpg-id" ]; then
  if ! gpg --batch --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec'; then
    gpg --batch --pinentry-mode loopback --passphrase '' \
      --quick-generate-key 'MailExpert Proton worker <proton-worker@localhost>' \
      default default never >/dev/null 2>&1
  fi
  fingerprint="$(gpg --batch --list-secret-keys --with-colons 2>/dev/null | awk -F: '/^fpr/ { print $10; exit }')"
  if [ -z "$fingerprint" ]; then
    echo "proton-worker: keychain initialisation failed" >&2
    exit 1
  fi
  pass init "$fingerprint" >/dev/null
fi

exec python /opt/mailexpert-proton/worker.py "$@"
