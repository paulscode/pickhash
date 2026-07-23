#!/bin/sh
# Plain-Docker / StartOS container entrypoint.
# Runs a single Node process (HTTP API + static UI + control loop) and forwards
# SIGTERM to it so the container stops promptly — an unforwarded signal hits the
# 30s grace timeout and shows up as "stuck in Stopping" on StartOS.
set -e

export PORT="${PORT:-3030}"
export DATA_DIR="${DATA_DIR:-/root/data}"
export HASHGG_HOST="${HASHGG_HOST:-}"   # empty = HashGG not configured (optional integration)
export HASHGG_PORT="${HASHGG_PORT:-3000}"

# On StartOS 0.3.5.1 the platform mounts /root/start9 and the HashGG service is
# reachable at "hashgg.embassy". Default to it there so optional auto-discovery
# works out of the box. (StartOS 0.4.0 sets HASHGG_HOST explicitly via the daemon
# env; plain Docker leaves it empty, disabling the probe.) Setting it only ENABLES
# discovery — if HashGG isn't installed the probe just fails and Pickhash stays
# fully usable.
if [ -z "$HASHGG_HOST" ] && [ -d /root/start9 ]; then
  export HASHGG_HOST="hashgg.embassy"
fi

# Dashboard password. StartOS 0.4.0 injects DASHBOARD_PASSWORD via the daemon env;
# on 0.3.5.1 there is no main.ts, so read the value the user manages on the config
# screen out of the rendered config.yaml. Parsed with node (already in the image, so
# no yq/awk dependency); the password charset (a-z,A-Z,0-9) needs no unescaping.
export DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-}"
if [ -z "$DASHBOARD_PASSWORD" ] && [ -f /root/start9/config.yaml ]; then
  export DASHBOARD_PASSWORD="$(node -e 'try{const m=require("fs").readFileSync("/root/start9/config.yaml","utf8").match(/^dashboard-password:[ \t]*"?([^"\r\n]*)"?[ \t]*$/m);process.stdout.write(m?m[1]:"")}catch(e){}')"
  # Where to find/change the password in the 0.3.5.1 UI (shown on the login screen).
  export DASHBOARD_PASSWORD_PATH="${DASHBOARD_PASSWORD_PATH:-Change it in the Pickhash service under Config → Dashboard Password.}"
fi

# On StartOS the dashboard is reached over an encrypted transport (LAN TLS / Tor), so mark the
# session cookie Secure. Plain Docker (often loopback http) leaves it unset so login still works.
if [ -d /root/start9 ]; then
  export COOKIE_SECURE="${COOKIE_SECURE:-1}"
fi

mkdir -p "$DATA_DIR"

# The process starts as root so it can take ownership of the (platform-mounted) data volume;
# server.js then drops to PICKHASH_UID/GID before serving. Hand the volume to that account, and
# make the data dir's parent traversable so the dropped uid can reach it (the volume mount at
# /root is otherwise 0700 root-only). Single-purpose container, so o+x on the parent exposes nothing.
if [ "$(id -u)" = "0" ] && [ -n "$PICKHASH_UID" ]; then
  chown -R "$PICKHASH_UID:$PICKHASH_GID" "$DATA_DIR" 2>/dev/null || true
  chmod o+x "$(dirname "$DATA_DIR")" 2>/dev/null || true
fi

# node:sqlite is available without a flag on Node 24 but prints an ExperimentalWarning
# on every start; silence just that one warning (keep all others).
node --disable-warning=ExperimentalWarning /usr/local/lib/pickhash/backend/server.js &
PID=$!

trap 'kill -TERM "$PID" 2>/dev/null; wait "$PID"' TERM INT
wait "$PID"
