function uniq(items = []) {
  return [...new Set(items.filter(Boolean))];
}

export function buildAppCapturePlan(options = {}) {
  const app = options.app ?? {};
  const device = options.device ?? {};
  const capture = options.capture ?? {};
  const steps = [];

  if (device.id || device.selector) {
    steps.push({ type: 'reserve-device', device });
  } else {
    steps.push({ type: 'reserve-device', device: { platformName: device.platformName ?? 'Android' } });
  }
  if (capture.injectCertificate !== false) {
    steps.push({ type: 'install-ca-certificate', source: capture.certificatePath ?? 'mitmproxy-ca' });
  }
  if (app.packageName || app.apkPath || app.bundleId) {
    if (capture.reinstall === true && (app.packageName || app.bundleId)) {
      steps.push({ type: 'uninstall-app', packageName: app.packageName ?? app.bundleId });
    }
    if (app.apkPath || app.ipaPath) {
      steps.push({ type: 'install-app', path: app.apkPath ?? app.ipaPath });
    }
    steps.push({ type: 'launch-app', packageName: app.packageName ?? app.bundleId, activity: app.activity ?? null });
  }
  if (capture.frida !== false) {
    steps.push({
      type: 'start-frida',
      packageName: app.packageName ?? app.bundleId ?? null,
      scripts: capture.fridaScripts ?? [],
      restartOnCrash: true,
    });
  }
  if (capture.mitmproxy !== false) {
    steps.push({ type: 'start-network-capture', proxy: capture.proxy ?? 'mitmproxy', bindDevice: true });
  }
  steps.push({ type: 'collect-page-tree', format: 'appium-source' });
  steps.push({ type: 'merge-streams', streams: ['app-page-tree', 'network-flow', 'frida-hook'] });

  return {
    kind: 'app-capture-plan',
    app,
    device,
    requiresAttestationBypass: Boolean(capture.playIntegrity || capture.safetyNet || capture.attestation),
    unsupportedClosedLoop: uniq([
      capture.playIntegrity ? 'play-integrity' : null,
      capture.safetyNet ? 'safetynet' : null,
      capture.attestation ? 'device-attestation' : null,
    ]),
    steps,
  };
}

export function mergeAppCaptureStreams({ pageTree = [], networkFlows = [], hookEvents = [] } = {}) {
  const nodes = Array.isArray(pageTree) ? pageTree : [];
  const flows = Array.isArray(networkFlows) ? networkFlows : [];
  const hooks = Array.isArray(hookEvents) ? hookEvents : [];
  const endpointById = new Map();

  for (const flow of flows) {
    const key = flow.requestId ?? flow.url ?? flow.path;
    if (key) endpointById.set(key, { ...flow, hooks: [] });
  }
  for (const hook of hooks) {
    const key = hook.requestId ?? hook.url ?? hook.path;
    if (key && endpointById.has(key)) {
      endpointById.get(key).hooks.push(hook);
    }
  }

  return {
    kind: 'app-unified-model',
    screens: nodes.map((node, index) => ({
      id: node.id ?? `screen-${index + 1}`,
      activity: node.activity ?? null,
      packageName: node.packageName ?? node.package ?? null,
      controls: node.controls ?? [],
    })),
    endpoints: [...endpointById.values()],
    orphanHookEvents: hooks.filter((hook) => {
      const key = hook.requestId ?? hook.url ?? hook.path;
      return !key || !endpointById.has(key);
    }),
  };
}
