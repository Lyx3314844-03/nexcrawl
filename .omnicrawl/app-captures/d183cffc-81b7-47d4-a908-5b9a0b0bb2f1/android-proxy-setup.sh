#!/usr/bin/env bash
set -euo pipefail

DEVICE_ID="<device-id>"
PROXY_HOST="${1:-127.0.0.1}"
PROXY_PORT="${2:-8080}"
BUNDLE_ID="target.bundle.id"

echo "[omnicrawl] setting Android global proxy to $PROXY_HOST:$PROXY_PORT"
adb -s "$DEVICE_ID" shell settings put global http_proxy "$PROXY_HOST:$PROXY_PORT"

echo "[omnicrawl] launching target app"
adb -s "$DEVICE_ID" shell monkey -p "$BUNDLE_ID" -c android.intent.category.LAUNCHER 1

echo "[omnicrawl] done. To clear proxy later run:"
echo "adb -s $DEVICE_ID shell settings put global http_proxy :0"
