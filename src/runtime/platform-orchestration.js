function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export class ResourceScheduler {
  constructor({ quotas = {} } = {}) {
    this.quotas = quotas;
    this.usage = new Map();
  }

  setQuota(tenantId = 'default', quota = {}) {
    const id = String(tenantId || 'default');
    this.quotas[id] = {
      ...(this.quotas[id] ?? {}),
      ...quota,
    };
    return {
      tenantId: id,
      quota: { ...this.quotas[id] },
    };
  }

  getQuota(tenantId = 'default') {
    return { ...(this.quotas[tenantId] ?? this.quotas.default ?? {}) };
  }

  canRun(task = {}) {
    const tenantId = task.tenantId ?? 'default';
    const quota = this.quotas[tenantId] ?? this.quotas.default ?? {};
    const usage = this.usage.get(tenantId) ?? { running: 0, browser: 0, proxy: 0, account: 0 };
    for (const key of ['running', 'browser', 'proxy', 'account']) {
      const max = quota[key] ?? quota[`${key}s`];
      if (max !== undefined && usage[key] + Number(task.resources?.[key] ?? (key === 'running' ? 1 : 0)) > Number(max)) {
        return false;
      }
    }
    return true;
  }

  reserve(task = {}) {
    if (!this.canRun(task)) return null;
    const tenantId = task.tenantId ?? 'default';
    const usage = this.usage.get(tenantId) ?? { running: 0, browser: 0, proxy: 0, account: 0 };
    usage.running += 1;
    for (const key of ['browser', 'proxy', 'account']) {
      usage[key] += Number(task.resources?.[key] ?? 0);
    }
    this.usage.set(tenantId, usage);
    return { tenantId, usage: { ...usage } };
  }

  release(task = {}) {
    const tenantId = task.tenantId ?? 'default';
    const usage = this.usage.get(tenantId) ?? { running: 0, browser: 0, proxy: 0, account: 0 };
    usage.running = Math.max(0, usage.running - 1);
    for (const key of ['browser', 'proxy', 'account']) {
      usage[key] = Math.max(0, usage[key] - Number(task.resources?.[key] ?? 0));
    }
    this.usage.set(tenantId, usage);
    return { tenantId, usage: { ...usage } };
  }

  snapshot() {
    const tenantIds = [...new Set([
      ...Object.keys(this.quotas),
      ...this.usage.keys(),
    ])];
    return {
      quotas: Object.fromEntries(Object.entries(this.quotas).map(([tenantId, quota]) => [tenantId, { ...quota }])),
      usage: Object.fromEntries([...this.usage.entries()].map(([tenantId, usage]) => [tenantId, { ...usage }])),
      tenants: tenantIds.map((tenantId) => ({
        tenantId,
        quota: this.getQuota(tenantId),
        usage: { ...(this.usage.get(tenantId) ?? { running: 0, browser: 0, proxy: 0, account: 0 }) },
      })),
    };
  }
}

export function buildDagExecutionPlan(nodes = []) {
  const remaining = new Map(nodes.map((node) => [node.id, { ...node, dependsOn: node.dependsOn ?? [] }]));
  const completed = new Set();
  const waves = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((node) => node.dependsOn.every((dep) => completed.has(dep)));
    if (ready.length === 0) {
      return { kind: 'dag-execution-plan', valid: false, waves, cycle: [...remaining.keys()] };
    }
    waves.push(ready.map((node) => node.id));
    for (const node of ready) {
      remaining.delete(node.id);
      completed.add(node.id);
    }
  }

  return { kind: 'dag-execution-plan', valid: true, waves };
}

export function createLineageRecord({ jobId, input = {}, output = {}, transform = {} } = {}) {
  return {
    kind: 'lineage-record',
    jobId,
    input: clone(input),
    output: clone(output),
    transform: clone(transform),
    recordedAt: new Date().toISOString(),
  };
}

export function evolveSchemaVersion(schema = {}, observedFields = {}) {
  const fields = { ...(schema.fields ?? {}) };
  const changes = [];
  for (const [name, sample] of Object.entries(observedFields ?? {})) {
    const type = Array.isArray(sample) ? 'array' : sample === null ? 'null' : typeof sample;
    if (!fields[name]) {
      fields[name] = { type, since: Number(schema.version ?? 0) + 1 };
      changes.push({ type: 'add-field', name, fieldType: type });
    } else if (fields[name].type !== type) {
      fields[name] = { ...fields[name], type: [fields[name].type, type].flat().filter((v, i, a) => a.indexOf(v) === i) };
      changes.push({ type: 'widen-field', name, fieldType: type });
    }
  }
  return {
    ...schema,
    version: Number(schema.version ?? 0) + (changes.length ? 1 : 0),
    fields,
    changes,
  };
}
