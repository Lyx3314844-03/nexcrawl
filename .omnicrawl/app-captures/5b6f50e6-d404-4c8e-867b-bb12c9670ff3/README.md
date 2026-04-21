# OmniCrawl Capture Bundle

Target bundle: target.bundle.id
Platform: unknown

Recommended order:
1. Review capture-manifest.json.
2. Start mitmdump using android-bootstrap.sh or windows-bootstrap.bat.
3. Configure the device proxy and trust the mitmproxy CA certificate.
4. Attach Frida with the generated helper script.
5. Launch the target app and verify traffic appears in the dump.

Generated files:
- fridaScriptPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\5b6f50e6-d404-4c8e-867b-bb12c9670ff3\frida-auto.js
- androidBootstrapPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\5b6f50e6-d404-4c8e-867b-bb12c9670ff3\android-bootstrap.sh
- windowsBootstrapPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\5b6f50e6-d404-4c8e-867b-bb12c9670ff3\windows-bootstrap.bat
- iosNotesPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\5b6f50e6-d404-4c8e-867b-bb12c9670ff3\ios-capture-notes.md
- androidProxySetupPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\5b6f50e6-d404-4c8e-867b-bb12c9670ff3\android-proxy-setup.sh
- androidClearProxyPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\5b6f50e6-d404-4c8e-867b-bb12c9670ff3\android-clear-proxy.sh
- windowsProxyNotesPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\5b6f50e6-d404-4c8e-867b-bb12c9670ff3\windows-proxy-notes.md
- captureManifestPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\5b6f50e6-d404-4c8e-867b-bb12c9670ff3\capture-manifest.json
- bundleReadmePath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\5b6f50e6-d404-4c8e-867b-bb12c9670ff3\README.md

Planned tools:
- frida-attach: frida (external-advisory)
