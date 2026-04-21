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
- fridaScriptPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\a7232dce-2c95-4be3-b8cc-54cb6d99ed8f\frida-auto.js
- androidBootstrapPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\a7232dce-2c95-4be3-b8cc-54cb6d99ed8f\android-bootstrap.sh
- windowsBootstrapPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\a7232dce-2c95-4be3-b8cc-54cb6d99ed8f\windows-bootstrap.bat
- iosNotesPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\a7232dce-2c95-4be3-b8cc-54cb6d99ed8f\ios-capture-notes.md
- androidProxySetupPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\a7232dce-2c95-4be3-b8cc-54cb6d99ed8f\android-proxy-setup.sh
- androidClearProxyPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\a7232dce-2c95-4be3-b8cc-54cb6d99ed8f\android-clear-proxy.sh
- windowsProxyNotesPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\a7232dce-2c95-4be3-b8cc-54cb6d99ed8f\windows-proxy-notes.md
- captureManifestPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\a7232dce-2c95-4be3-b8cc-54cb6d99ed8f\capture-manifest.json
- bundleReadmePath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\a7232dce-2c95-4be3-b8cc-54cb6d99ed8f\README.md

Planned tools:
- frida-attach: frida (external-advisory)
