import { join, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';

function nowMs() {
  return Date.now();
}

function createState() {
  return {
    items: {},
  };
}

function proxyKey(proxy) {
  return `${proxy.server}::${proxy.username ?? ''}`;
}

function normalizeProxy(proxy, index = 0) {
  return {
    label: proxy.label ?? `proxy-${index + 1}`,
    server: proxy.server,
    username: proxy.username,
    password: proxy.password,
    region: proxy.region ?? null,
    country: proxy.country ?? null,
    city: proxy.city ?? null,
    bypass: proxy.bypass ?? [],
    weight: proxy.weight ?? 1,
    disabled: proxy.disabled ?? false,
    match: {
      hosts: proxy.match?.hosts ?? [],
      include: proxy.match?.include ?? [],
      exclude: proxy.match?.exclude ?? [],
      protocols: proxy.match?.protocols ?? [],
    },
  };
}

function normalizePoolConfig(proxyPool) {
  const rawServers = proxyPool?.servers ?? proxyPool?.proxies ?? [];
  return {
    enabled: proxyPool?.enabled ?? rawServers.length > 0,
    strategy: proxyPool?.strategy ?? 'roundRobin',
    stickyBySession: proxyPool?.stickyBySession ?? proxyPool?.stickySession ?? true,
    maxFailures: proxyPool?.maxFailures ?? proxyPool?.cooldownAfterFailures ?? 2,
    cooldownMs: proxyPool?.cooldownMs ?? proxyPool?.cooldownDurationMs ?? 30000,
    retryOnStatuses: proxyPool?.retryOnStatuses ?? [408, 429, 500, 502, 503, 504],
    allowDirectFallback: proxyPool?.allowDirectFallback ?? false,
    servers: rawServers.map((proxy, index) => normalizeProxy(proxy, index)),
  };
}

function clientForProtocol(protocol) {
  return protocol === 'https:' ? https : http;
}

function proxyAuthorizationHeader(proxy) {
  if (!proxy?.username && !proxy?.password) {
    return null;
  }

  return `Basic ${Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`).toString('base64')}`;
}

function collectBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    response.on('error', reject);
  });
}

function requestViaForwardProxy(targetUrl, proxy, timeoutMs = 5000) {
  const proxyUrl = new URL(proxy.server);
  const client = clientForProtocol(proxyUrl.protocol);

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        host: proxyUrl.hostname,
        port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
        method: 'GET',
        path: targetUrl.href,
        headers: {
          host: targetUrl.host,
          ...(proxyAuthorizationHeader(proxy)
            ? { 'proxy-authorization': proxyAuthorizationHeader(proxy) }
            : {}),
        },
      },
      async (response) => {
        try {
          resolve({
            status: response.statusCode ?? 500,
            body: await collectBody(response),
          });
        } catch (error) {
          reject(error);
        }
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('proxy probe timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

function createConnectTunnel(targetUrl, proxy, timeoutMs = 5000) {
  const proxyUrl = new URL(proxy.server);
  const client = clientForProtocol(proxyUrl.protocol);

  return new Promise((resolve, reject) => {
    const connectRequest = client.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      headers: {
        host: `${targetUrl.hostname}:${targetUrl.port || 443}`,
        ...(proxyAuthorizationHeader(proxy)
          ? { 'proxy-authorization': proxyAuthorizationHeader(proxy) }
          : {}),
      },
    });

    connectRequest.setTimeout(timeoutMs, () => {
      connectRequest.destroy(new Error('proxy tunnel timed out'));
    });
    connectRequest.on('connect', (response, socket) => {
      if ((response.statusCode ?? 500) >= 400) {
        socket.destroy();
        reject(new Error(`proxy tunnel failed with status ${response.statusCode}`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetUrl.hostname,
      });

      tlsSocket.once('secureConnect', () => resolve(tlsSocket));
      tlsSocket.once('error', reject);
    });
    connectRequest.on('error', reject);
    connectRequest.end();
  });
}

function requestViaTunnel(targetUrl, proxy, timeoutMs = 5000) {
  return new Promise(async (resolve, reject) => {
    try {
      const tlsSocket = await createConnectTunnel(targetUrl, proxy, timeoutMs);
      const req = https.request(
        {
          host: targetUrl.hostname,
          port: targetUrl.port || 443,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: 'GET',
          headers: {
            host: targetUrl.host,
          },
          createConnection: () => tlsSocket,
        },
        async (response) => {
          try {
            resolve({
              status: response.statusCode ?? 500,
              body: await collectBody(response),
            });
          } catch (error) {
            reject(error);
          }
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('proxy probe timed out'));
      });
      req.on('error', reject);
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

function sortByHealth(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return (left.lastSelectedAt ?? 0) - (right.lastSelectedAt ?? 0);
}

function hostMatches(host, expected) {
  const normalized = String(expected).replace(/^\./, '');
  return host === normalized || host.endsWith(`.${normalized}`);
}

function matchesTarget(proxy, targetUrl) {
  if (!targetUrl) {
    return true;
  }

  const url = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
  const match = proxy.match ?? {};
  const hosts = match.hosts ?? [];
  const protocols = match.protocols ?? [];
  const include = (match.include ?? []).map((pattern) => new RegExp(pattern));
  const exclude = (match.exclude ?? []).map((pattern) => new RegExp(pattern));

  if (hosts.length > 0 && !hosts.some((host) => hostMatches(url.hostname, host))) {
    return false;
  }

  if (protocols.length > 0 && !protocols.includes(url.protocol.replace(/:$/, ''))) {
    return false;
  }

  if (include.length > 0 && !include.some((pattern) => pattern.test(url.href))) {
    return false;
  }

  if (exclude.some((pattern) => pattern.test(url.href))) {
    return false;
  }

  return true;
}

function normalizeProxyLocationValue(value) {
  return value == null ? null : String(value).trim().toLowerCase();
}

function buildIdentityProxyBinding(identity = {}) {
  const binding = {
    region: normalizeProxyLocationValue(identity.proxyRegion),
    country: normalizeProxyLocationValue(identity.proxyCountry),
    city: normalizeProxyLocationValue(identity.proxyCity),
  };

  return binding.region || binding.country || binding.city ? binding : null;
}

function matchesIdentityProxyBinding(proxy, identityBinding = null) {
  if (!identityBinding) {
    return true;
  }

  for (const [field, expected] of Object.entries(identityBinding)) {
    if (!expected) {
      continue;
    }
    const actual = normalizeProxyLocationValue(proxy?.[field]);
    if (!actual || actual !== expected) {
      return false;
    }
  }

  return true;
}

export class ProxyPool {
  constructor({ projectRoot = process.cwd() } = {}) {
    this.projectRoot = projectRoot;
    this.storageDir = resolve(projectRoot, '.omnicrawl');
    this.statePath = join(this.storageDir, 'proxy-state.json');
    this.state = createState();
    this.stickyAssignments = new Map();
    this.roundRobinCursor = 0;
    this.initPromise = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.storageDir);
        try {
          const loaded = await readJson(this.statePath);
          this.state = loaded?.items ? loaded : createState();
        } catch {
          this.state = createState();
          await this.persist();
        }
      })();
    }

    await this.initPromise;
    return this;
  }

  async persist() {
    await writeJson(this.statePath, this.state);
  }

  safePersist() {
    void this.persist().catch(() => {});
  }

  ensureProxyState(proxy) {
    const key = proxyKey(proxy);
    const existing = this.state.items[key];

    if (existing) {
      return existing;
    }

    const created = {
      key,
      label: proxy.label,
      server: proxy.server,
      region: proxy.region ?? null,
      country: proxy.country ?? null,
      city: proxy.city ?? null,
      configuredDisabled: Boolean(proxy.disabled),
      manuallyDisabled: false,
      notes: '',
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      selectedCount: 0,
      cooldownUntil: 0,
      lastSelectedAt: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      lastProbeAt: 0,
      lastProbeTarget: null,
      lastProbeStatus: 0,
      lastProbeOk: null,
      lastError: null,
      score: 100,
    };

    this.state.items[key] = created;
    return created;
  }

  preparePool(proxyPool) {
    const config = normalizePoolConfig(proxyPool);

    for (const proxy of config.servers) {
      const state = this.ensureProxyState(proxy);
      state.configuredDisabled = Boolean(proxy.disabled);
      state.region = proxy.region ?? null;
      state.country = proxy.country ?? null;
      state.city = proxy.city ?? null;
    }

    this.safePersist();
    return config;
  }

  isAvailable(state) {
    return (state.cooldownUntil ?? 0) <= nowMs();
  }

  selectProxy({ proxyPool, fallbackProxy = null, affinityKey = null, targetUrl = null, identityBinding = null } = {}) {
    const config = this.preparePool(proxyPool);

    if (!config.enabled || config.servers.length === 0) {
      return fallbackProxy ?? null;
    }

    const states = config.servers
      .filter((proxy) => matchesTarget(proxy, targetUrl))
      .filter((proxy) => matchesIdentityProxyBinding(proxy, identityBinding))
      .map((proxy) => ({
        proxy,
        state: {
          ...this.ensureProxyState(proxy),
          configuredDisabled: Boolean(proxy.disabled),
        },
      }));

    const enabledStates = states.filter((entry) => !entry.proxy.disabled && !entry.state.manuallyDisabled);

    if (enabledStates.length === 0) {
      return config.allowDirectFallback ? fallbackProxy ?? null : null;
    }

    if (config.stickyBySession && affinityKey) {
      const stickyKey = this.stickyAssignments.get(affinityKey);
      if (stickyKey) {
        const sticky = enabledStates.find((entry) => proxyKey(entry.proxy) === stickyKey && this.isAvailable(entry.state));
        if (sticky) {
          const realState = this.ensureProxyState(sticky.proxy);
          realState.selectedCount += 1;
          realState.lastSelectedAt = nowMs();
          this.safePersist();
          return {
            ...sticky.proxy,
            key: realState.key,
          };
        }
      }
    }

    const available = enabledStates.filter((entry) => this.isAvailable(entry.state));
    const candidates = available.length > 0 ? available : enabledStates;
    let selected;

    if (config.strategy === 'healthiest' || config.strategy === 'stickySession') {
      selected = [...candidates].sort((left, right) => sortByHealth(left.state, right.state))[0];
    } else {
      selected = candidates[this.roundRobinCursor % candidates.length];
      this.roundRobinCursor = (this.roundRobinCursor + 1) % Math.max(candidates.length, 1);
    }

    if (!selected) {
      return config.allowDirectFallback ? fallbackProxy ?? null : null;
    }

    const realState = this.ensureProxyState(selected.proxy);
    realState.selectedCount += 1;
    realState.lastSelectedAt = nowMs();

    if (config.stickyBySession && affinityKey) {
      this.stickyAssignments.set(affinityKey, proxyKey(selected.proxy));
    }

    this.safePersist();
    return {
      ...selected.proxy,
      key: realState.key,
    };
  }

  reportSuccess(proxy) {
    if (!proxy?.server) {
      return;
    }

    const state = this.ensureProxyState(proxy);
    state.successCount += 1;
    state.consecutiveFailures = 0;
    state.lastSuccessAt = nowMs();
    state.lastError = null;
    state.cooldownUntil = 0;
    state.score = Math.min(100, state.score + 5);
    this.safePersist();
  }

  reportFailure(proxy, { message = 'proxy request failed', proxyPool } = {}) {
    if (!proxy?.server) {
      return;
    }

    const config = normalizePoolConfig(proxyPool);
    const state = this.ensureProxyState(proxy);
    state.failureCount += 1;
    state.consecutiveFailures += 1;
    state.lastFailureAt = nowMs();
    state.lastError = message;
    state.score = Math.max(0, state.score - 20);

    if (state.consecutiveFailures >= config.maxFailures) {
      state.cooldownUntil = nowMs() + config.cooldownMs;
      state.consecutiveFailures = 0;
    }

    this.safePersist();
  }

  list() {
    return Object.values(this.state.items)
      .map((item) => ({
        ...item,
        health: item.score,
        successes: item.successCount,
        failures: item.failureCount,
        enabled: !item.manuallyDisabled,
        effectiveDisabled: Boolean(item.configuredDisabled || item.manuallyDisabled),
        inCooldown: (item.cooldownUntil ?? 0) > nowMs(),
      }))
      .sort((left, right) => sortByHealth(left, right));
  }

  findByKey(key) {
    return this.state.items[key] ?? null;
  }

  async probe(key, { targetUrl = 'https://example.com', timeoutMs = 5000 } = {}) {
    await this.init();
    const state = this.state.items[key];
    if (!state) {
      return null;
    }

    const proxy = {
      label: state.label,
      server: state.server,
      username: key.split('::')[1] || undefined,
    };

    const url = new URL(targetUrl);
    state.lastProbeAt = nowMs();
    state.lastProbeTarget = url.href;

    try {
      const result =
        url.protocol === 'https:'
          ? await requestViaTunnel(url, proxy, timeoutMs)
          : await requestViaForwardProxy(url, proxy, timeoutMs);

      state.lastProbeStatus = result.status;
      state.lastProbeOk = result.status < 400;
      if (state.lastProbeOk) {
        state.score = Math.min(100, state.score + 2);
      }
      await this.persist();
      return {
        key,
        targetUrl: url.href,
        status: result.status,
        ok: result.status < 400,
      };
    } catch (error) {
      state.lastProbeStatus = 0;
      state.lastProbeOk = false;
      state.lastError = error?.message ?? String(error);
      state.score = Math.max(0, state.score - 10);
      await this.persist();
      return {
        key,
        targetUrl: url.href,
        status: 0,
        ok: false,
        error: error?.message ?? String(error),
      };
    }
  }

  setEnabled(key, enabled) {
    const item = this.state.items[key];
    if (!item) {
      return null;
    }

    item.manuallyDisabled = !enabled;
    if (enabled) {
      item.cooldownUntil = 0;
    }
    this.safePersist();
    return item;
  }

  updateNotes(key, notes) {
    const item = this.state.items[key];
    if (!item) {
      return null;
    }

    item.notes = String(notes ?? '');
    this.safePersist();
    return item;
  }

  reset(key) {
    const item = this.state.items[key];
    if (!item) {
      return null;
    }

    item.successCount = 0;
    item.failureCount = 0;
    item.consecutiveFailures = 0;
    item.selectedCount = 0;
    item.cooldownUntil = 0;
    item.lastSelectedAt = 0;
    item.lastSuccessAt = 0;
    item.lastFailureAt = 0;
    item.lastProbeAt = 0;
    item.lastProbeTarget = null;
    item.lastProbeStatus = 0;
    item.lastProbeOk = null;
    item.lastError = null;
    item.score = 100;
    item.notes = '';
    item.manuallyDisabled = false;
    this.safePersist();
    item.health = item.score;
    item.successes = item.successCount;
    item.failures = item.failureCount;
    item.enabled = !item.manuallyDisabled;
    return item;
  }
}
