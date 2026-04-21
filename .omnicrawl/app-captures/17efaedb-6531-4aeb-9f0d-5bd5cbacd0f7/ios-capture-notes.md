# OmniCrawl iOS Capture Notes

- Bundle ID: target.bundle.id
- Frida script: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\17efaedb-6531-4aeb-9f0d-5bd5cbacd0f7\frida-auto.js
- mitmproxy addon: ./mitm-addon.py
- Traffic dump: ./traffic.dump

Checklist:
1. Start mitmproxy/mitmdump with the generated addon.
2. Point the device or simulator proxy to the mitmproxy host/port.
3. Visit mitm.it from Safari and install/trust the mitmproxy CA certificate.
4. Start Frida with the generated helper script.
5. Launch the target app and verify requests appear in the dump.
