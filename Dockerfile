# syntax=docker/dockerfile:1
#
# Shared image for the plain-Docker path and both StartOS packages.
# Base pinned by manifest-list digest for reproducible, multi-arch builds
# (this is money-handling software — builds must be deterministic). The base
# digest is the reproducibility boundary; the image build itself runs no package
# manager beyond the required ca-certificates and does not build any JS/CSS, so
# there is no unpinned build-time dependency tree.
# Refresh the digest with:  docker buildx imagetools inspect node:24-slim
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime

LABEL org.opencontainers.image.title="Pickhash" \
      org.opencontainers.image.description="Rent Bitcoin hashrate on your own terms." \
      org.opencontainers.image.source="https://github.com/paulscode/pickhash" \
      org.opencontainers.image.licenses="MIT"

# curl for the container health checks; ca-certificates for TLS to the rental API.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Non-root runtime account. The process starts as root only long enough for the entrypoint
# to take ownership of the mounted data volume, then drops to this uid before serving (see
# docker_entrypoint.sh + server.js). Fixed ids so the entrypoint chown and the in-process
# drop agree, and so a bind-mounted host data dir has predictable ownership.
ENV PICKHASH_UID=10001 \
    PICKHASH_GID=10001
RUN groupadd -g "$PICKHASH_GID" pickhash \
 && useradd -u "$PICKHASH_UID" -g "$PICKHASH_GID" -M -d /root -s /usr/sbin/nologin pickhash

WORKDIR /root

# Application code. Zero runtime npm dependencies — Node standard library only.
COPY app/backend  /usr/local/lib/pickhash/backend
# Frontend, including the prebuilt (committed) dashboard.min.css — the image does not run
# Tailwind, so `make css` is the single, reproducible source of that stylesheet.
COPY app/frontend /usr/local/lib/pickhash/frontend
COPY icon.png /usr/local/lib/pickhash/frontend/icon.png

# Entrypoint + health-check scripts.
COPY docker_entrypoint.sh /usr/local/bin/docker_entrypoint.sh
COPY check-web.sh /usr/local/bin/check-web.sh
RUN chmod a+x /usr/local/bin/docker_entrypoint.sh \
              /usr/local/bin/check-web.sh

# The server binds this port; compose / `docker run -p` decide host publishing.
EXPOSE 3030

# Plain-Docker entrypoint. StartOS names its own command in startos/main.ts,
# so this line does not affect the StartOS build.
ENTRYPOINT ["/usr/local/bin/docker_entrypoint.sh"]
