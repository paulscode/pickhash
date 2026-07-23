#!/bin/bash
# Liveness health check: the dashboard HTTP server is up and answering.
#
# Dual-use. On StartOS 0.3.5.1 this is injected INTO the running main container
# (manifest `inject: true`), so 127.0.0.1 reaches the app; the platform pipes the
# elapsed run-time (ms) on stdin and reads the exit code: 0 = up, 60 = still
# starting (grace, no alarm), 1 = down. Plain-Docker's healthcheck pipes nothing, so
# the read hits EOF and we fall straight through to the real check.
PORT="${PORT:-3030}"
read -r DURATION 2>/dev/null || true
case "$DURATION" in ''|*[!0-9]*) DURATION=999999 ;; esac
if [ "$DURATION" -le 5000 ]; then
  echo "Pickhash dashboard is starting"
  exit 60
fi
if curl -fsS -m 5 "http://127.0.0.1:${PORT}/livez" >/dev/null 2>&1; then
  echo "Pickhash dashboard is reachable"
  exit 0
fi
echo "Pickhash dashboard is not responding on port ${PORT}" >&2
exit 1
