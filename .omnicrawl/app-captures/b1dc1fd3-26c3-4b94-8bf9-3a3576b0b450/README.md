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
- fridaScriptPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b1dc1fd3-26c3-4b94-8bf9-3a3576b0b450\frida-auto.js
- androidBootstrapPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b1dc1fd3-26c3-4b94-8bf9-3a3576b0b450\android-bootstrap.sh
- windowsBootstrapPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b1dc1fd3-26c3-4b94-8bf9-3a3576b0b450\windows-bootstrap.bat
- iosNotesPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b1dc1fd3-26c3-4b94-8bf9-3a3576b0b450\ios-capture-notes.md
- androidProxySetupPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b1dc1fd3-26c3-4b94-8bf9-3a3576b0b450\android-proxy-setup.sh
- androidClearProxyPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b1dc1fd3-26c3-4b94-8bf9-3a3576b0b450\android-clear-proxy.sh
- windowsProxyNotesPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b1dc1fd3-26c3-4b94-8bf9-3a3576b0b450\windows-proxy-notes.md
- captureManifestPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b1dc1fd3-26c3-4b94-8bf9-3a3576b0b450\capture-manifest.json
- bundleReadmePath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b1dc1fd3-26c3-4b94-8bf9-3a3576b0b450\README.md

Planned tools:
- frida-attach: frida (external-advisory)
