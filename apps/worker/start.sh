#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Worker container entrypoint
#
# Sets up only the X server stack the worker needs to drive a real Chromium
# under Xvfb:
#   * Xvfb        — virtual framebuffer on display :99 (headed Chromium target)
#   * fluxbox     — minimal window manager so popups, tabs and dialogs render
#
# x11vnc is NOT launched here. C2b spawns it per-session from the
# browser-session processor with a fresh single-use password (see
# apps/worker/src/queue/processors/browser-session.ts). That keeps each
# admin session isolated and means previous-session clients can't reattach.
#
# This script only prepares the display and then execs the worker process so
# PID 1 is the Node runtime and signals propagate cleanly.
# -----------------------------------------------------------------------------
set -euo pipefail

DISPLAY="${DISPLAY:-:99}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1920x1080x24}"

echo "[start.sh] launching Xvfb on ${DISPLAY} (${SCREEN_GEOMETRY})"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_GEOMETRY}" -ac +extension RANDR &
XVFB_PID=$!

# Give Xvfb a moment to come up before clients connect.
for _ in 1 2 3 4 5; do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

echo "[start.sh] launching fluxbox window manager"
DISPLAY="${DISPLAY}" fluxbox >/dev/null 2>&1 &

# Tear down the X stack if the worker process exits.
trap 'kill ${XVFB_PID} 2>/dev/null || true' EXIT

echo "[start.sh] launching worker process"
export DISPLAY
exec node dist/index.js
