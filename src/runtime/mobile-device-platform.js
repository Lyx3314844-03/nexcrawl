import { readJson, writeJson } from '../utils/fs.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeDevice(device = {}, index = 0) {
  return {
    id: device.id ?? device.udid ?? `device-${index + 1}`,
    platform: device.platform ?? device.platformName ?? 'android',
    udid: device.udid ?? device.id ?? null,
    name: device.name ?? device.deviceName ?? device.id ?? `Device ${index + 1}`,
    status: device.status ?? 'available',
    labels: Array.isArray(device.labels) ? [...device.labels] : [],
    capabilities: device.capabilities ?? {},
    leasedUntil: Number(device.leasedUntil ?? 0),
    metadata: device.metadata ?? {},
  };
}

function matchesDevice(device, scope = {}) {
  if (scope.platform && String(device.platform).toLowerCase() !== String(scope.platform).toLowerCase()) return false;
  if (scope.labels?.length && !scope.labels.every((label) => device.labels.includes(label))) return false;
  return true;
}

export class DevicePool {
  constructor({ devices = [], leaseMs = 600000, path = null } = {}) {
    this.path = path;
    this.leaseMs = leaseMs;
    this.devices = new Map(devices.map((device, index) => {
      const normalized = normalizeDevice(device, index);
      return [normalized.id, normalized];
    }));
    this.initPromise = null;
    this.persistPromise = Promise.resolve();
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.path) return;
        try {
          const loaded = await readJson(this.path);
          this.leaseMs = Number(loaded?.leaseMs ?? this.leaseMs);
          const devices = Array.isArray(loaded?.devices) ? loaded.devices : [];
          this.devices = new Map(devices.map((device, index) => {
            const normalized = normalizeDevice(device, index);
            return [normalized.id, normalized];
          }));
        } catch {
          // Keep constructor-provided seed devices when no persisted state exists yet.
        }
      })();
    }
    await this.initPromise;
    return this;
  }

  async persist() {
    if (!this.path) return;
    await writeJson(this.path, {
      version: 1,
      leaseMs: this.leaseMs,
      devices: [...this.devices.values()],
    });
  }

  safePersist() {
    this.persistPromise = this.persistPromise
      .catch(() => {})
      .then(() => this.persist())
      .catch(() => {});
  }

  async flush() {
    await this.persistPromise;
  }

  upsert(device) {
    const existing = this.devices.get(device.id ?? device.udid);
    const normalized = normalizeDevice({ ...(existing ?? {}), ...device }, this.devices.size);
    this.devices.set(normalized.id, normalized);
    this.safePersist();
    return { ...normalized };
  }

  lease(scope = {}, now = Date.now()) {
    const selected = [...this.devices.values()]
      .filter((device) => device.status === 'available')
      .filter((device) => Number(device.leasedUntil ?? 0) <= now)
      .filter((device) => matchesDevice(device, scope))[0] ?? null;
    if (!selected) return null;
    selected.status = 'leased';
    selected.leasedUntil = now + Number(scope.leaseMs ?? this.leaseMs);
    selected.updatedAt = nowIso();
    this.safePersist();
    return { ...selected };
  }

  release(deviceId, result = {}) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    device.status = result.disabled ? 'disabled' : 'available';
    device.leasedUntil = 0;
    device.updatedAt = nowIso();
    device.lastResult = { ...result };
    this.safePersist();
    return { ...device };
  }

  snapshot() {
    return [...this.devices.values()].map((device) => ({ ...device }));
  }
}

export function buildMobileAppExecutionPlan({ app = {}, device = {}, capture = {} } = {}) {
  const packageName = app.packageName ?? app.bundleId ?? null;
  const steps = [
    { type: 'reserve-device', device },
    capture.reinstall ? { type: 'uninstall-app', packageName } : null,
    app.apkPath || app.ipaPath ? { type: 'install-app', path: app.apkPath ?? app.ipaPath } : null,
    capture.injectCertificate !== false ? { type: 'inject-ca-certificate', source: capture.certificatePath ?? 'mitmproxy-ca' } : null,
    capture.network !== false ? { type: 'start-network-capture', tool: 'mitmproxy', dumpPath: capture.dumpPath ?? 'traffic.dump' } : null,
    capture.frida !== false ? { type: 'start-frida-session', packageName, scripts: capture.fridaScripts ?? [] } : null,
    { type: 'launch-app', packageName, activity: app.activity ?? null },
    { type: 'collect-unified-model', streams: ['page-tree', 'network-flow', 'hook-events'] },
    { type: 'cleanup', clearProxy: capture.clearProxy !== false },
  ].filter(Boolean);

  return {
    kind: 'mobile-app-execution-plan',
    packageName,
    platform: app.platform ?? device.platform ?? 'android',
    steps,
  };
}

export async function executeMobileAppPlan(plan, adapter = {}, options = {}) {
  const dryRun = options.dryRun !== false;
  const events = [];
  for (const step of plan.steps ?? []) {
    const startedAt = nowIso();
    if (dryRun) {
      events.push({ step, status: 'planned', startedAt, finishedAt: nowIso() });
      continue;
    }
    const handler = adapter[step.type];
    if (typeof handler !== 'function') {
      throw new Error(`missing mobile execution adapter for step: ${step.type}`);
    }
    const result = await handler(step, { plan });
    events.push({ step, status: 'completed', startedAt, finishedAt: nowIso(), result });
  }
  return {
    kind: 'mobile-app-execution-result',
    dryRun,
    events,
  };
}
