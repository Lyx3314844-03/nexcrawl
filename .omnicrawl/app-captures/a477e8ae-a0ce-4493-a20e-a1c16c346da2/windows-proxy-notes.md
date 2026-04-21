# OmniCrawl Windows Proxy Notes

If you want Windows-hosted tools or emulators to use the proxy:

1. Start mitmdump with the generated addon.
2. Configure the target runtime to use the mitmproxy host/port.
3. Import/trust the mitmproxy root CA if HTTPS interception is required.
4. Use the generated bootstrap script to attach Frida after the proxy is active.

Undo:
- Remove the proxy from the target runtime or emulator.
- Stop mitmdump.
