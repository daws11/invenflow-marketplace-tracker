#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Worker container entrypoint
#
# Sets up the X server stack the worker needs to drive a real Chromium with
# noVNC / x11vnc on top:
#   * Xvfb        — virtual framebuffer on display :99 (headed Chromium target)
#   * fluxbox     — minimal window manager so popups, tabs and dialogs render
#   * x11vnc      — VNC server bound to :5900, exposed to the `novnc` sidecar
#                   over the internal Docker network
#
# The Chromium itself is launched on demand by the worker code (per PRD §7.3),
# not by this script. This script only prepares the display and then execs the
# worker process so PID 1 is the Node runtime and signals propagate cleanly.
# -----------------------------------------------------------------------------
set -euo pipefail

DISPLAY="${DISPLAY:-:99}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1920x1080x24}"
VNC_PORT="${VNC_PORT:-5900}"

# `-rfbauth` reads a libvncserver-format password file. The worker code rotates
# this per session (single-use password embedded in the iframe URL); the file
# below is a placeholder so x11vnc can boot even before the first session.
VNC_PASSFILE="/tmp/vncpass"
if [[ ! -f "${VNC_PASSFILE}" ]]; then
  # `x11vnc -storepasswd` writes a file in the format x11vnc expects.
  x11vnc -storepasswd "placeholder-rotated-per-session" "${VNC_PASSFILE}" >/dev/null
fi

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

echo "[start.sh] launching x11vnc on 0.0.0.0:${VNC_PORT}"
x11vnc \
  -display "${DISPLAY}" \
  -rfbauth "${VNC_PASSFILE}" \
  -rfbport "${VNC_PORT}" \
  -listen 0.0.0.0 \
  -forever \
  -shared \
  -noxdamage \
  -quiet \
  -bg

# Tear down the X stack if the worker process exits.
trap 'kill ${XVFB_PID} 2>/dev/null || true' EXIT

echo "[start.sh] launching worker process"
export DISPLAY
exec node dist/index.js
