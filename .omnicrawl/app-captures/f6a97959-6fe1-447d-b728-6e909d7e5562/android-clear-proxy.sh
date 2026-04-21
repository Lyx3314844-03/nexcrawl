#!/usr/bin/env bash
set -euo pipefail

DEVICE_ID="<device-id>"

echo "[omnicrawl] clearing Android global proxy"
adb -s "$DEVICE_ID" shell settings put global http_proxy :0
