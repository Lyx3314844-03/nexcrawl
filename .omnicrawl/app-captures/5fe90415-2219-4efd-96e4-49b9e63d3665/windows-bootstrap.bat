@echo off
set DEVICE_ID=<device-id>
set FRIDA_SCRIPT=C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\5fe90415-2219-4efd-96e4-49b9e63d3665\frida-auto.js
set MITM_ADDON=.\mitm-addon.py
set MITM_DUMP=.\traffic.dump
set BUNDLE_ID=target.bundle.id

echo [omnicrawl] starting mitmdump capture
start "omnicrawl-mitm" /B mitmdump --mode "regular" -w "%MITM_DUMP%" -s "%MITM_ADDON%"

echo [omnicrawl] configure Android proxy manually or via adb shell settings put global http_proxy host:port
echo [omnicrawl] install the mitmproxy CA certificate on the device before TLS interception
echo [omnicrawl] starting Frida attach
frida -D "%DEVICE_ID%" -f "%BUNDLE_ID%" -l "%FRIDA_SCRIPT%" --no-pause
