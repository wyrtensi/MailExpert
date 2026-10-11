# syntax=docker/dockerfile:1
#
# MailExpert managed Proton Bridge worker.
#
# Build context: deploy/proton-worker (never the repository root).
#   docker build --platform linux/amd64 -t <tag> deploy/proton-worker
#
# Pins (see .superpowers/sdd/2026-10-10-mailbox-providers/task-4-research.md):
# - Bridge source: bridge-version (exact commit, never patched; go.mod/go.sum untouched).
# - Go 1.26.9 builder and Python 3.13.16 runtime by index digest.
# - Debian packages from snapshot.debian.org at DEBIAN_SNAPSHOT.
# - Python packages from hash-locked requirements*.lock (--require-hashes).

ARG GO_IMAGE=golang:1.26.9-bookworm@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c
ARG PY_IMAGE=python:3.13.16-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
ARG DEBIAN_SNAPSHOT=20261011T000000Z
ARG GOVULNCHECK_VERSION=v1.9.0

# ---------------------------------------------------------------------------
# Bridge build: exact source commit, bundled toolchain only, read-only modules.
FROM ${GO_IMAGE} AS builder
ARG DEBIAN_SNAPSHOT
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*; \
    { echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main"; \
      echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm-updates main"; \
      echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main"; \
    } > /etc/apt/sources.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends libfido2-dev libcbor-dev libssl-dev libsecret-1-dev pkg-config; \
    rm -rf /var/lib/apt/lists/*

ENV GOTOOLCHAIN=local \
    CGO_ENABLED=1 \
    GOFLAGS=

COPY bridge-version /build/bridge-version
WORKDIR /src/proton-bridge
RUN source /build/bridge-version; \
    git init -q .; \
    git remote add origin "${BRIDGE_REPO}"; \
    git fetch -q --depth 1 origin "${BRIDGE_COMMIT}"; \
    git checkout -q --detach FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "${BRIDGE_COMMIT}"; \
    sha256sum go.mod go.sum > /build/gomod.before.sha256

RUN go mod download && go mod verify

# Makefile prerequisite `gofiles`: generates the gitignored internal/bridge/credits.go
# from go.mod with the project's own utils/credits.sh (no tracked file changes).
RUN cd utils && ./credits.sh bridge && cd .. \
    && sha256sum internal/bridge/credits.go \
    && test -z "$(git status --porcelain)" \
    && git status --porcelain --ignored

# Same ldflags as the Makefile (build-nogui), without the launcher.
# CGO links libfido2 like the Makefile on Linux.
RUN source /build/bridge-version; \
    build_time="$(git log -1 --format=%cI HEAD)"; \
    pkg=github.com/ProtonMail/proton-bridge/v3/internal/constants; \
    mkdir -p /out; \
    CGO_LDFLAGS="-lfido2 -lcbor -lssl -lcrypto" \
    go build -mod=readonly -trimpath -tags='' \
      -ldflags "-X ${pkg}.Version=${BRIDGE_APP_VERSION} -X ${pkg}.Revision=${BRIDGE_COMMIT} -X ${pkg}.BuildTime=${build_time} -X '${pkg}.FullAppName=Proton Mail Bridge' -X ${pkg}.BuildEnv=dev" \
      -o /out/bridge ./cmd/Desktop-Bridge; \
    sha256sum -c /build/gomod.before.sha256; \
    test -z "$(git status --porcelain)"; \
    cp LICENSE /out/LICENSE

# ---------------------------------------------------------------------------
# Evidence-only stage: govulncheck against the same source tree and binary.
FROM builder AS vulncheck
ARG GOVULNCHECK_VERSION
RUN go install "golang.org/x/vuln/cmd/govulncheck@${GOVULNCHECK_VERSION}"

# ---------------------------------------------------------------------------
# Python bindings from bridge.proto of the same commit (codegen deps stay here).
FROM ${PY_IMAGE} AS codegen
COPY requirements-codegen.lock /build/requirements-codegen.lock
RUN pip install --no-cache-dir --disable-pip-version-check --require-hashes --only-binary=:all: \
      -r /build/requirements-codegen.lock \
    && pip check
COPY --from=builder /src/proton-bridge/internal/frontend/grpc/bridge.proto /proto/bridge.proto
RUN mkdir -p /gen \
    && python -m grpc_tools.protoc -I/proto --python_out=/gen --grpc_python_out=/gen /proto/bridge.proto \
    && sha256sum /proto/bridge.proto /gen/*.py

# ---------------------------------------------------------------------------
FROM ${PY_IMAGE} AS runtime
ARG DEBIAN_SNAPSHOT
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*; \
    { echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main"; \
      echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm-updates main"; \
      echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main"; \
    } > /etc/apt/sources.list; \
    apt-get update; \
    apt-get upgrade -y --no-install-recommends; \
    apt-get install -y --no-install-recommends libfido2-1 libcbor0.8 libssl3 libsecret-1-0 ca-certificates pass gnupg; \
    rm -rf /var/lib/apt/lists/*

COPY requirements.lock /build/requirements.lock
RUN pip install --no-cache-dir --disable-pip-version-check --require-hashes --only-binary=:all: \
      -r /build/requirements.lock \
    && pip check

RUN groupadd --gid 1000 worker \
    && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /var/lib/mailexpert-proton \
       --shell /usr/sbin/nologin worker

COPY --from=builder /out/bridge /opt/proton-bridge/bridge
COPY --from=builder /out/LICENSE /opt/proton-bridge/LICENSE
COPY bridge-version /opt/proton-bridge/bridge-version
COPY --from=codegen /gen/ /opt/mailexpert-proton/bridge_grpc/

ENV PYTHONPATH=/opt/mailexpert-proton:/opt/mailexpert-proton/bridge_grpc \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/var/lib/mailexpert-proton
COPY native.py controller.py worker.py /opt/mailexpert-proton/
COPY --chmod=0755 entrypoint.sh /opt/mailexpert-proton/entrypoint.sh

USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "/opt/mailexpert-proton/worker.py", "--healthcheck"]
ENTRYPOINT ["/opt/mailexpert-proton/entrypoint.sh"]
