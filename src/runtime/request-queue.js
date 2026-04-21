import { join } from 'node:path';
import { isIP } from 'node:net';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { hashText } from '../utils/hash.js';

function nowIso() {
  return new Date().toISOString();
}

export function normalizeRequestGroupBy(value = 'hostname') {
  const normalized = String(value ?? 'hostname').trim().toLowerCase();
  if (normalized === 'origin') {
    return 'origin';
  }

  if (normalized === 'registrabledomain' || normalized === 'registrable-domain') {
    return 'registrableDomain';
  }

  return 'hostname';
}

const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gov',
  'net',
  'org',
]);

function normalizeHostname(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.+$/, '');
}

export function getRegistrableDomain(hostname) {
  const normalizedHost = normalizeHostname(hostname);

  if (!normalizedHost) {
    return null;
  }

  if (isIP(normalizedHost) || !normalizedHost.includes('.')) {
    return normalizedHost;
  }

  const labels = normalizedHost.split('.').filter(Boolean);
  if (labels.length <= 2) {
    return normalizedHost;
  }

  const topLevel = labels.at(-1);
  const secondLevel = labels.at(-2);
  const useThreeLabels = topLevel.length === 2 && COMMON_SECOND_LEVEL_SUFFIXES.has(secondLevel);

  return useThreeLabels && labels.length >= 3
    ? labels.slice(-3).join('.')
    : labels.slice(-2).join('.');
}

function normalizeSeenSetConfig(config = {}) {
  const seenSet = config.seenSet ?? {};
  const rawId = seenSet.id ?? config.seenSetId ?? null;
  const id = rawId === null || rawId === undefined ? null : String(rawId).trim();
  const enabled = seenSet.enabled === true || Boolean(id);
  const rawScope = String(seenSet.scope ?? 'workflow').trim().toLowerCase();
  const scope = rawScope === 'global'
    ? 'global'
    : rawScope === 'custom'
      ? 'custom'
      : 'workflow';
  const ttlMs = Math.max(0, Number(seenSet.ttlMs ?? 0));
  const rawMaxEntries = Number(seenSet.maxEntries ?? 100000);
  const maxEntries = Number.isFinite(rawMaxEntries) ? Math.max(1, Math.min(1_000_000, rawMaxEntries)) : 100000;

  return {
    enabled,
    scope,
    id: enabled
      ? (id || (scope === 'global' ? 'global:seen-set' : 'request-queue:seen-set'))
      : null,
    ttlMs,
    maxEntries,
  };
}

export function getRequestGroupKey(target, groupBy = 'hostname') {
  const value = typeof target === 'string' ? target : target?.url;

  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const mode = normalizeRequestGroupBy(groupBy);
    if (mode === 'origin') {
      return url.origin.toLowerCase();
    }

    if (mode === 'registrableDomain') {
      return getRegistrableDomain(url.hostname);
    }

    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function getRequestHostKey(target) {
  return getRequestGroupKey(target, 'hostname');
}

function activeGroupCount(activeGroups, groupKey) {
  if (!groupKey) {
    return 0;
  }

  if (activeGroups instanceof Map) {
    return Number(activeGroups.get(groupKey) ?? 0);
  }

  if (activeGroups && typeof activeGroups === 'object') {
    return Number(activeGroups[groupKey] ?? 0);
  }

  return 0;
}

function activeKeyCount(collection, key) {
  if (!key) {
    return 0;
  }

  if (collection instanceof Map) {
    return Number(collection.get(key) ?? 0);
  }

  if (collection && typeof collection === 'object') {
    return Number(collection[key] ?? 0);
  }

  return 0;
}

function recentDispatchCount(recentDispatches, groupKey, nowMs, budgetWindowMs) {
  if (!groupKey || budgetWindowMs <= 0) {
    return 0;
  }

  const cutoff = nowMs - budgetWindowMs;
  const values = recentDispatches instanceof Map
    ? recentDispatches.get(groupKey)
    : recentDispatches?.[groupKey];

  if (!Array.isArray(values)) {
    return 0;
  }

  return values.filter((value) => Number(value) >= cutoff).length;
}

function recentKeyDispatchCount(recentDispatches, key, nowMs, budgetWindowMs) {
  if (!key || budgetWindowMs <= 0) {
    return 0;
  }

  const cutoff = nowMs - budgetWindowMs;
  const values = recentDispatches instanceof Map
    ? recentDispatches.get(key)
    : recentDispatches?.[key];

  if (!Array.isArray(values)) {
    return 0;
  }

  return values.filter((value) => Number(value) >= cutoff).length;
}

function blockedGroupUntil(blockedGroups, groupKey) {
  if (!groupKey) {
    return 0;
  }

  if (blockedGroups instanceof Map) {
    return Number(blockedGroups.get(groupKey) ?? 0);
  }

  if (blockedGroups && typeof blockedGroups === 'object') {
    return Number(blockedGroups[groupKey] ?? 0);
  }

  return 0;
}

export function getRequestLaneKey(target) {
  const laneKey = typeof target === 'string'
    ? null
    : target?.laneKey
      ?? target?.metadata?.kind
      ?? target?.userData?.discoveryKind
      ?? null;

  if (!laneKey) {
    return null;
  }

  return String(laneKey).trim().toLowerCase() || null;
}

function isEligibleForHostWindow(request, options = {}, config = {}) {
  const hostAwareScheduling = options.hostAwareScheduling ?? config.hostAwareScheduling ?? false;
  const groupBy = normalizeRequestGroupBy(options.groupBy ?? config.groupBy ?? 'hostname');
  const maxInProgressPerGroup = Number(
    options.maxInProgressPerGroup
    ?? options.maxInProgressPerHost
    ?? config.maxInProgressPerGroup
    ?? config.maxInProgressPerHost
    ?? 0,
  );
  const budgetWindowMs = Math.max(0, Number(options.budgetWindowMs ?? config.budgetWindowMs ?? 0));
  const maxRequestsPerWindow = Math.max(0, Number(options.maxRequestsPerWindow ?? config.maxRequestsPerWindow ?? 0));

  const groupKey = request.groupKey ?? request.hostKey ?? getRequestGroupKey(request, groupBy);
  const activeGroups = options.activeGroups ?? options.activeHosts;
  const recentDispatches = options.recentGroupDispatches ?? {};
  const nowMs = Number(options.nowMs ?? Date.now());
  const blockedUntil = blockedGroupUntil(options.blockedGroups, groupKey);

  if (blockedUntil > nowMs) {
    return false;
  }

  if (hostAwareScheduling && maxInProgressPerGroup > 0 && activeGroupCount(activeGroups, groupKey) >= maxInProgressPerGroup) {
    return false;
  }

  if (maxRequestsPerWindow > 0 && budgetWindowMs > 0 && recentDispatchCount(recentDispatches, groupKey, nowMs, budgetWindowMs) >= maxRequestsPerWindow) {
    return false;
  }

  const laneKey = request.laneKey ?? getRequestLaneKey(request);
  const laneConfig = laneKey ? options.laneConfigs?.[laneKey] ?? config.laneConfigs?.[laneKey] ?? null : null;
  const laneMaxInProgress = Math.max(0, Number(laneConfig?.maxInProgress ?? 0));
  const laneBudgetWindowMs = Math.max(0, Number(laneConfig?.budgetWindowMs ?? 0));
  const laneMaxRequestsPerWindow = Math.max(0, Number(laneConfig?.maxRequestsPerWindow ?? 0));

  if (laneMaxInProgress > 0 && activeKeyCount(options.activeLanes, laneKey) >= laneMaxInProgress) {
    return false;
  }

  if (
    laneMaxRequestsPerWindow > 0
    && laneBudgetWindowMs > 0
    && recentKeyDispatchCount(options.recentLaneDispatches, laneKey, nowMs, laneBudgetWindowMs) >= laneMaxRequestsPerWindow
  ) {
    return false;
  }

  return true;
}

function normalizeUrlForUniqueKey(targetUrl, options = {}) {
  const url = new URL(targetUrl);
  const dropQueryParams = new Set((options.dropQueryParams ?? []).map((entry) => String(entry).toLowerCase()));
  const dropQueryParamPatterns = (options.dropQueryParamPatterns ?? [])
    .map((entry) => {
      try {
        return new RegExp(entry, 'i');
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const retainedQueryEntries = [];
  for (const [key, value] of url.searchParams.entries()) {
    const normalizedKey = key.toLowerCase();
    const shouldDrop =
      dropQueryParams.has(normalizedKey)
      || dropQueryParamPatterns.some((pattern) => pattern.test(normalizedKey));

    if (!shouldDrop) {
      retainedQueryEntries.push([key, value]);
    }
  }

  if (options.stripHash !== false) {
    url.hash = '';
  }

  if (options.sortQueryParams !== false) {
    retainedQueryEntries.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) {
        return leftKey.localeCompare(rightKey);
      }

      return leftValue.localeCompare(rightValue);
    });
  }

  url.search = '';
  for (const [key, value] of retainedQueryEntries) {
    url.searchParams.append(key, value);
  }

  if (options.stripTrailingSlash && url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return url.href;
}

export function normalizeRequestPriority(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.max(-1000, Math.min(1000, parsed));
}

function createInitialState() {
  const now = nowIso();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    pending: [],
    requests: {},
  };
}

function createInitialSeenState(scopeId = null) {
  const now = nowIso();
  return {
    version: 1,
    scopeId,
    createdAt: now,
    updatedAt: now,
    entries: {},
  };
}

function queueConfig(config = {}) {
  const parsedMaxInProgressPerGroup = Number(config.maxInProgressPerGroup ?? config.maxInProgressPerHost ?? 1);
  const laneConfigs = config.laneConfigs && typeof config.laneConfigs === 'object' && !Array.isArray(config.laneConfigs)
    ? Object.fromEntries(
      Object.entries(config.laneConfigs).map(([laneKey, laneConfig]) => [
        String(laneKey).trim().toLowerCase(),
        {
          maxInProgress: Number.isFinite(Number(laneConfig?.maxInProgress)) ? Math.max(0, Number(laneConfig.maxInProgress)) : 0,
          budgetWindowMs: Math.max(0, Number(laneConfig?.budgetWindowMs ?? 0)),
          maxRequestsPerWindow: Math.max(0, Number(laneConfig?.maxRequestsPerWindow ?? 0)),
        },
      ]),
    )
    : {};
  return {
    sortQueryParams: config.sortQueryParams !== false,
    stripHash: config.stripHash !== false,
    stripTrailingSlash: config.stripTrailingSlash === true,
    includeMethodInUniqueKey: config.includeMethodInUniqueKey === true,
    includeBodyInUniqueKey: config.includeBodyInUniqueKey === true,
    reclaimInProgress: config.reclaimInProgress !== false,
    hostAwareScheduling: config.hostAwareScheduling !== false,
    groupBy: normalizeRequestGroupBy(config.groupBy ?? 'hostname'),
    maxInProgressPerGroup: Number.isFinite(parsedMaxInProgressPerGroup) ? Math.max(0, parsedMaxInProgressPerGroup) : 1,
    maxInProgressPerHost: Number.isFinite(parsedMaxInProgressPerGroup) ? Math.max(0, parsedMaxInProgressPerGroup) : 1,
    budgetWindowMs: Math.max(0, Number(config.budgetWindowMs ?? 0)),
    maxRequestsPerWindow: Math.max(0, Number(config.maxRequestsPerWindow ?? 0)),
    laneConfigs,
    dropQueryParams: Array.isArray(config.dropQueryParams)
      ? config.dropQueryParams.map((entry) => String(entry).toLowerCase())
      : [],
    dropQueryParamPatterns: Array.isArray(config.dropQueryParamPatterns)
      ? config.dropQueryParamPatterns.map((entry) => String(entry))
      : [],
    seenSet: normalizeSeenSetConfig(config),
  };
}

function cloneRequestRecord(record) {
  return structuredClone(record);
}

function sortPendingQueue(state) {
  state.pending.sort((leftKey, rightKey) => {
    const left = state.requests[leftKey];
    const right = state.requests[rightKey];

    const leftPriority = normalizeRequestPriority(left?.priority, 0);
    const rightPriority = normalizeRequestPriority(right?.priority, 0);
    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority;
    }

    const leftEnqueuedAt = String(left?.enqueuedAt ?? '');
    const rightEnqueuedAt = String(right?.enqueuedAt ?? '');
    if (leftEnqueuedAt !== rightEnqueuedAt) {
      return leftEnqueuedAt.localeCompare(rightEnqueuedAt);
    }

    return String(leftKey).localeCompare(String(rightKey));
  });
}

function normalizeLoadedState(state = createInitialState(), config = {}) {
  const nextState = state?.requests ? state : createInitialState();
  const groupBy = normalizeRequestGroupBy(config.groupBy ?? 'hostname');

  for (const request of Object.values(nextState.requests)) {
    request.priority = normalizeRequestPriority(request.priority, 0);
    request.groupKey = request.groupKey ?? request.hostKey ?? getRequestGroupKey(request, groupBy);
    request.hostKey = request.hostKey ?? getRequestHostKey(request);
    request.laneKey = request.laneKey ?? getRequestLaneKey(request);
    request.headers = request.headers ?? {};
    request.userData = request.userData ?? {};
    request.metadata = request.metadata ?? {};
    request.replayState = request.replayState ?? null;
  }

  nextState.pending = [...new Set(nextState.pending.filter((uniqueKey) => nextState.requests[uniqueKey]))];
  sortPendingQueue(nextState);
  return nextState;
}

function normalizeLoadedSeenState(state = createInitialSeenState(), config = {}) {
  const enabled = config.seenSet?.enabled === true;
  const scopeId = config.seenSet?.id ?? null;
  const nextState = state?.entries && typeof state.entries === 'object'
    ? state
    : createInitialSeenState(scopeId);

  nextState.scopeId = scopeId;
  if (!enabled) {
    nextState.entries = {};
  }

  return nextState;
}

export function buildRequestUniqueKey(item, config = {}) {
  const resolvedConfig = queueConfig(config);
  const method = String(item.method ?? 'GET').toUpperCase();
  const body = item.body === undefined || item.body === null ? '' : String(item.body);
  const includeMethodInUniqueKey =
    resolvedConfig.includeMethodInUniqueKey
    || method !== 'GET'
    || body.length > 0;
  const includeBodyInUniqueKey =
    resolvedConfig.includeBodyInUniqueKey
    || body.length > 0;
  const parts = [normalizeUrlForUniqueKey(item.url, resolvedConfig)];

  if (includeMethodInUniqueKey) {
    parts.unshift(method);
  }

  if (includeBodyInUniqueKey) {
    parts.push(hashText(body));
  }

  return parts.join(' ');
}

export class RequestQueue {
  constructor({ runDir, config = {}, logger } = {}) {
    this.runDir = runDir;
    this.logger = logger;
    this.config = queueConfig(config);
    this.statePath = join(runDir, 'request-queue.json');
    this.state = createInitialState();
    this.seenPath = this.config.seenSet.enabled && this.config.seenSet.id
      ? join(runDir, '..', '.frontier-seen', `${hashText(this.config.seenSet.id)}.json`)
      : null;
    this.seenState = createInitialSeenState(this.config.seenSet.id);
    this.initPromise = null;
    this.reclaimedCount = 0;
    this.seenHitCount = 0;
    this.seenWriteCount = 0;
    this.seenExpiredCount = 0;
    this.seenEvictedCount = 0;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.runDir);

        try {
          const loaded = await readJson(this.statePath);
          this.state = normalizeLoadedState(loaded, this.config);
        } catch {
          this.state = createInitialState();
          await this.persist();
        }

        if (this.seenPath) {
          try {
            const loadedSeen = await readJson(this.seenPath);
            this.seenState = normalizeLoadedSeenState(loadedSeen, this.config);
            if (this.pruneSeenState() > 0) {
              await this.persistSeenState();
            }
          } catch {
            this.seenState = createInitialSeenState(this.config.seenSet.id);
            await this.persistSeenState();
          }
        }

        if (this.config.reclaimInProgress) {
          this.reclaimedCount = this.reclaimInProgress();
          if (this.reclaimedCount > 0) {
            await this.persist();
          }
        }
      })();
    }

    await this.initPromise;
    return this;
  }

  async persist() {
    this.state.updatedAt = nowIso();
    await writeJson(this.statePath, this.state);
  }

  async persistSeenState() {
    if (!this.seenPath) {
      return;
    }

    this.seenState.updatedAt = nowIso();
    await writeJson(this.seenPath, this.seenState);
  }

  pruneSeenState(nowMs = Date.now()) {
    if (!this.seenPath) {
      return 0;
    }

    let changed = 0;
    const ttlMs = this.config.seenSet.ttlMs ?? 0;
    if (ttlMs > 0) {
      const cutoff = nowMs - ttlMs;
      for (const [uniqueKey, entry] of Object.entries(this.seenState.entries ?? {})) {
        const seenAt = Date.parse(entry.lastSeenAt ?? entry.firstSeenAt ?? '');
        if (!Number.isNaN(seenAt) && seenAt < cutoff) {
          delete this.seenState.entries[uniqueKey];
          this.seenExpiredCount += 1;
          changed += 1;
        }
      }
    }

    const maxEntries = this.config.seenSet.maxEntries ?? 100000;
    const entries = Object.entries(this.seenState.entries ?? {});
    if (entries.length > maxEntries) {
      const overflow = entries.length - maxEntries;
      entries
        .sort((left, right) => {
          const leftAt = Date.parse(left[1]?.lastSeenAt ?? left[1]?.firstSeenAt ?? '');
          const rightAt = Date.parse(right[1]?.lastSeenAt ?? right[1]?.firstSeenAt ?? '');
          return leftAt - rightAt;
        })
        .slice(0, overflow)
        .forEach(([uniqueKey]) => {
          delete this.seenState.entries[uniqueKey];
          this.seenEvictedCount += 1;
          changed += 1;
        });
    }

    return changed;
  }

  reclaimInProgress() {
    let reclaimed = 0;

    for (const request of Object.values(this.state.requests)) {
      if (request.status !== 'inProgress') {
        continue;
      }

      request.status = 'pending';
      request.reclaimedAt = nowIso();
      request.updatedAt = request.reclaimedAt;
      if (!this.state.pending.includes(request.uniqueKey)) {
        this.state.pending.push(request.uniqueKey);
      }
      reclaimed += 1;
    }

    sortPendingQueue(this.state);
    return reclaimed;
  }

  summary() {
    const requests = Object.values(this.state.requests);
    const pendingCount = requests.filter((item) => item.status === 'pending').length;
    const inProgressCount = requests.filter((item) => item.status === 'inProgress').length;
    const handledCount = requests.filter((item) => item.status === 'handled').length;
    const failedCount = requests.filter((item) => item.status === 'failed').length;

    return {
      totalCount: requests.length,
      pendingCount,
      inProgressCount,
      handledCount,
      failedCount,
      reclaimedCount: this.reclaimedCount,
      updatedAt: this.state.updatedAt,
      seenSet: this.seenSetSummary(),
    };
  }

  hasPending() {
    return this.state.pending.length > 0;
  }

  buildRecord(item) {
    const now = nowIso();
    const uniqueKey = item.uniqueKey ?? buildRequestUniqueKey(item, this.config);

    return {
      uniqueKey,
      url: item.url,
      groupKey: getRequestGroupKey(item, this.config.groupBy),
      hostKey: getRequestHostKey(item),
      laneKey: getRequestLaneKey(item),
      method: String(item.method ?? 'GET').toUpperCase(),
      headers: item.headers ?? {},
      body: item.body,
      depth: Number(item.depth ?? 0),
      parentUrl: item.parentUrl ?? null,
      label: item.label ?? null,
      userData: item.userData ?? {},
      metadata: item.metadata ?? {},
      replayState: item.replayState ?? null,
      priority: normalizeRequestPriority(item.priority, 0),
      status: 'pending',
      enqueueCount: 1,
      enqueuedAt: now,
      updatedAt: now,
      handledAt: null,
      failedAt: null,
      lastError: null,
      finalUrl: null,
      responseStatus: null,
    };
  }

  async enqueue(item) {
    await this.init();
    const uniqueKey = item.uniqueKey ?? buildRequestUniqueKey(item, this.config);
    const existing = this.state.requests[uniqueKey];

    if (existing) {
      return {
        added: false,
        reason: 'duplicate-request',
        request: cloneRequestRecord(existing),
      };
    }

    if (this.hasSeen(uniqueKey)) {
      this.seenHitCount += 1;
      return {
        added: false,
        reason: 'already-seen',
        request: null,
      };
    }

    const request = this.buildRecord({
      ...item,
      uniqueKey,
    });
    this.state.requests[uniqueKey] = request;
    this.state.pending.push(uniqueKey);
    sortPendingQueue(this.state);
    await this.persist();

    return {
      added: true,
      reason: 'enqueued',
      request: cloneRequestRecord(request),
    };
  }

  async dequeue(options = {}) {
    await this.init();

    for (let index = 0; index < this.state.pending.length; index += 1) {
      const uniqueKey = this.state.pending[index];
      const request = this.state.requests[uniqueKey];

      if (!request || request.status !== 'pending') {
        this.state.pending.splice(index, 1);
        index -= 1;
        continue;
      }

      if (!isEligibleForHostWindow(request, options, this.config)) {
        continue;
      }

      this.state.pending.splice(index, 1);
      request.status = 'inProgress';
      request.updatedAt = nowIso();
      await this.persist();
      return cloneRequestRecord(request);
    }

    return null;
  }

  async markHandled(uniqueKey, patch = {}) {
    await this.init();
    const request = this.state.requests[uniqueKey];

    if (!request) {
      return null;
    }

    request.status = 'handled';
    request.handledAt = nowIso();
    request.updatedAt = request.handledAt;
    request.lastError = null;
    Object.assign(request, patch);
    await this.recordSeen(request.uniqueKey, request.finalUrl ?? request.url);
    await this.persist();
    return cloneRequestRecord(request);
  }

  async markFailed(uniqueKey, { error, patch = {} } = {}) {
    await this.init();
    const request = this.state.requests[uniqueKey];

    if (!request) {
      return null;
    }

    request.status = 'failed';
    request.failedAt = nowIso();
    request.updatedAt = request.failedAt;
    request.lastError = error ?? null;
    Object.assign(request, patch);
    await this.persist();
    return cloneRequestRecord(request);
  }

  hasSeen(uniqueKey) {
    return Boolean(this.seenPath && uniqueKey && this.seenState.entries?.[uniqueKey]);
  }

  async recordSeen(uniqueKey, url) {
    if (!this.seenPath || !uniqueKey) {
      return false;
    }

    const now = nowIso();
    const existing = this.seenState.entries[uniqueKey];
    this.seenState.entries[uniqueKey] = {
      uniqueKey,
      url: url ?? existing?.url ?? null,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    await this.persistSeenState();
    if (!existing) {
      this.seenWriteCount += 1;
    }
    return !existing;
  }

  seenSetSummary() {
    if (!this.config.seenSet.enabled) {
      return {
        enabled: false,
        id: null,
        scope: null,
        seenCount: 0,
        hitCount: 0,
        writeCount: 0,
        updatedAt: null,
      };
    }

    return {
      enabled: true,
      id: this.config.seenSet.id,
      scope: this.config.seenSet.scope,
      seenCount: Object.keys(this.seenState.entries ?? {}).length,
      hitCount: this.seenHitCount,
      writeCount: this.seenWriteCount,
      updatedAt: this.seenState.updatedAt,
    };
  }
}
