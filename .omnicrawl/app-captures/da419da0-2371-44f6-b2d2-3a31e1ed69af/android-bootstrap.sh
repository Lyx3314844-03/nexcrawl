#!/usr/bin/env bash
set -euo pipefail

DEVICE_ID="<device-id>"
FRIDA_SCRIPT="C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\da419da0-2371-44f6-b2d2-3a31e1ed69af\frida-auto.js"
MITM_ADDON="./mitm-addon.py"
MITM_DUMP="./traffic.dump"
BUNDLE_ID="target.bundle.id"

echo "[omnicrawl] starting mitmdump capture"
mitmdump --mode "regular" -w "$MITM_DUMP" -s "$MITM_ADDON" &
MITM_PID=$!

echo "[omnicrawl] configure Android proxy manually or via adb shell settings put global http_proxy <host>:<port>"
echo "[omnicrawl] install mitmproxy CA on the device before testing TLS interception"
echo "[omnicrawl] starting Frida attach"
frida -D "$DEVICE_ID" -f "$BUNDLE_ID" -l "$FRIDA_SCRIPT" --no-pause

trap 'kill $MITM_PID >/dev/null 2>&1 || true' EXIT
