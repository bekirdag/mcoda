#!/bin/sh
set -eu
mkdir -p "$HOME"
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp > /tmp/xvfb.log 2>&1 &
for attempt in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep .1; done
x11vnc -display :99 -localhost -rfbport 5900 -nopw -forever -shared > /tmp/vnc.log 2>&1 &
websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 > /tmp/websockify.log 2>&1 &
python3 /opt/codali/preview.py > /tmp/preview.log 2>&1 &
socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9222 > /tmp/cdp.log 2>&1 &
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check --disable-background-networking --disable-sync --password-store=basic --user-data-dir=/tmp/chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --window-size=1440,900 http://127.0.0.1:8000/ > /tmp/chrome.log 2>&1 &
# Owned desktops expire after eight hours, including if the TUI exits unexpectedly.
sleep 28800
