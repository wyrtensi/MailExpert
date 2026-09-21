# Edge proxy: stock Caddy plus the Cloudflare DNS provider for DNS-01 certificates
# (stock Caddy ships no DNS modules). Built in CI, never on the host.
ARG CADDY_VERSION=2.11.4

FROM caddy:${CADDY_VERSION}-builder AS builder
ARG CADDY_DNS_CLOUDFLARE_VERSION=v0.2.4
RUN xcaddy build --with github.com/caddy-dns/cloudflare@${CADDY_DNS_CLOUDFLARE_VERSION}

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
