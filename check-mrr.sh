#!/bin/bash
# Advisory reachability check for the external rental API. Non-blocking by design:
# a remote outage must never strand the package, so "unreachable" is a WARNING
# (exit 61), never a hard failure. On StartOS 0.3.5.1 this is injected into the main
# container (which has the egress the app itself uses); the platform pipes the
# elapsed run-time (ms) on stdin and reads the exit code: 0 = reachable, 60 = startup
# grace, 61 = unreachable (advisory warning). Plain-Docker isn't wired to this check.
read -r DURATION 2>/dev/null || true
case "$DURATION" in ''|*[!0-9]*) DURATION=999999 ;; esac
if [ "$DURATION" -le 5000 ]; then
  echo "Checking rental API…"
  exit 60
fi
if curl -fsS -m 8 -o /dev/null -I "https://www.miningrigrentals.com" 2>/dev/null; then
  echo "Rental API host reachable"
  exit 0
fi
echo "Rental API not reachable (advisory — Pickhash remains available)" >&2
exit 61
