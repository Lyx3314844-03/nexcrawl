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
- fridaScriptPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b3cb0235-9c7f-4fd6-aa48-2bbe3f93ee6e\frida-auto.js
- androidBootstrapPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b3cb0235-9c7f-4fd6-aa48-2bbe3f93ee6e\android-bootstrap.sh
- windowsBootstrapPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b3cb0235-9c7f-4fd6-aa48-2bbe3f93ee6e\windows-bootstrap.bat
- iosNotesPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b3cb0235-9c7f-4fd6-aa48-2bbe3f93ee6e\ios-capture-notes.md
- androidProxySetupPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b3cb0235-9c7f-4fd6-aa48-2bbe3f93ee6e\android-proxy-setup.sh
- androidClearProxyPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b3cb0235-9c7f-4fd6-aa48-2bbe3f93ee6e\android-clear-proxy.sh
- windowsProxyNotesPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b3cb0235-9c7f-4fd6-aa48-2bbe3f93ee6e\windows-proxy-notes.md
- captureManifestPath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b3cb0235-9c7f-4fd6-aa48-2bbe3f93ee6e\capture-manifest.json
- bundleReadmePath: C:\Users\Administrator\omnicrawl\.omnicrawl\app-captures\b3cb0235-9c7f-4fd6-aa48-2bbe3f93ee6e\README.md

Planned tools:
- frida-attach: frida (external-advisory)
