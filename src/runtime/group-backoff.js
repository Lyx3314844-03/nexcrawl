import { getRequestGroupKey, normalizeRequestGroupBy } from './request-queue.js';

function clampNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function normalizeStatusCodes(values, fallback = [408, 429, 500, 502, 503, 504]) {
  const list = Array.isArray(values) ? values : fallback;
  return [...new Set(
    list
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isInteger(value) && value >= 100 && value <= 599),
  )];
}

export function normalizeGroupBackoffConfig(config = {}, { groupBy = 'hostname' } = {}) {
  const enabled = config.enabled === true;
  const normalizedGroupBy = normalizeRequestGroupBy(config.groupBy ?? groupBy);
  const baseDelayMs = clampNumber(config.baseDelayMs ?? config.cooldownMs, {
    min: 0,
    max: 3_600_000,
    fallback: 5_000,
  });
  const maxDelayMs = clampNumber(config.maxDelayMs, {
    min: baseDelayMs,
    max: 86_400_000,
    fallback: Math.max(baseDelayMs, 300_000),
  });
  const multiplier = clampNumber(config.multiplier, {
    min: 1,
    max: 10,
    fallback: 2,
  });

  return {
    enabled,
    groupBy: normalizedGroupBy,
    baseDelayMs,
    maxDelayMs,
    multiplier,
    respectRetryAfter: config.respectRetryAfter !== false,
    resetOnSuccess: config.resetOnSuccess !== false,
    onNetworkError: config.onNetworkError !== false,
    statusCodes: normalizeStatusCodes(config.statusCodes),
  };
}

export class GroupBackoffController {
  constructor(config = {}, options = {}) {
    this.config = normalizeGroupBackoffConfig(config, options);
    this.groups = new Map();
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  resolveGroupKey(target) {
    return getRequestGroupKey(target, this.config.groupBy);
  }

  ensureGroup(groupKey) {
    const existing = this.groups.get(groupKey);
    if (existing) {
      return existing;
    }

    const created = {
      groupKey,
      consecutiveFailures: 0,
      blockedUntil: 0,
      lastDelayMs: 0,
      lastStatus: null,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null,
    };
    this.groups.set(groupKey, created);
    return created;
  }

  shouldBackoffStatus(status) {
    return this.config.statusCodes.includes(Number(status));
  }

  getBlockedUntil(target) {
    if (!this.isEnabled()) {
      return 0;
    }

    const groupKey = this.resolveGroupKey(target);
    if (!groupKey) {
      return 0;
    }

    return Number(this.groups.get(groupKey)?.blockedUntil ?? 0);
  }

  getWaitMs(target, nowMs = Date.now()) {
    const blockedUntil = this.getBlockedUntil(target);
    return Math.max(0, blockedUntil - nowMs);
  }

  noteFailure(target, { status = null, retryAfterMs = null, error = null, nowMs = Date.now() } = {}) {
    if (!this.isEnabled()) {
      return { groupKey: null, delayMs: 0, blockedUntil: 0 };
    }

    if (status !== null && !this.shouldBackoffStatus(status)) {
      return { groupKey: null, delayMs: 0, blockedUntil: 0 };
    }

    if (status === null && this.config.onNetworkError !== true) {
      return { groupKey: null, delayMs: 0, blockedUntil: 0 };
    }

    const groupKey = this.resolveGroupKey(target);
    if (!groupKey) {
      return { groupKey: null, delayMs: 0, blockedUntil: 0 };
    }

    const state = this.ensureGroup(groupKey);
    state.consecutiveFailures += 1;
    const exponent = Math.max(0, state.consecutiveFailures - 1);
    let delayMs = this.config.baseDelayMs * (this.config.multiplier ** exponent);
    delayMs = Math.min(delayMs, this.config.maxDelayMs);

    if (this.config.respectRetryAfter && Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0) {
      delayMs = Math.max(delayMs, Number(retryAfterMs));
    }

    state.blockedUntil = Math.max(Number(state.blockedUntil ?? 0), nowMs + delayMs);
    state.lastDelayMs = delayMs;
    state.lastStatus = status === null ? null : Number(status);
    state.lastError = error ? String(error) : null;
    state.lastFailureAt = new Date(nowMs).toISOString();

    return {
      groupKey,
      delayMs,
      blockedUntil: state.blockedUntil,
    };
  }

  noteSuccess(target, { nowMs = Date.now() } = {}) {
    if (!this.isEnabled() || this.config.resetOnSuccess !== true) {
      return { groupKey: null, reset: false };
    }

    const groupKey = this.resolveGroupKey(target);
    if (!groupKey) {
      return { groupKey: null, reset: false };
    }

    const state = this.ensureGroup(groupKey);
    state.consecutiveFailures = 0;
    state.blockedUntil = 0;
    state.lastDelayMs = 0;
    state.lastStatus = null;
    state.lastError = null;
    state.lastSuccessAt = new Date(nowMs).toISOString();

    return { groupKey, reset: true };
  }

  blockedGroups(nowMs = Date.now()) {
    if (!this.isEnabled()) {
      return new Map();
    }

    return new Map(
      [...this.groups.entries()]
        .filter(([, state]) => Number(state.blockedUntil ?? 0) > nowMs)
        .map(([groupKey, state]) => [groupKey, Number(state.blockedUntil)]),
    );
  }

  nextReleaseDelayMs(nowMs = Date.now()) {
    let minBlockedUntil = Infinity;

    for (const state of this.groups.values()) {
      const blockedUntil = Number(state.blockedUntil ?? 0);
      if (blockedUntil > nowMs && blockedUntil < minBlockedUntil) {
        minBlockedUntil = blockedUntil;
      }
    }

    return Number.isFinite(minBlockedUntil) ? Math.max(0, minBlockedUntil - nowMs) : 0;
  }

  snapshot(nowMs = Date.now()) {
    const groups = [...this.groups.values()]
      .map((state) => ({
        groupKey: state.groupKey,
        consecutiveFailures: state.consecutiveFailures,
        blockedUntil: state.blockedUntil > nowMs ? state.blockedUntil : 0,
        waitMs: Math.max(0, Number(state.blockedUntil ?? 0) - nowMs),
        lastDelayMs: state.lastDelayMs,
        lastStatus: state.lastStatus,
        lastError: state.lastError,
        lastFailureAt: state.lastFailureAt,
        lastSuccessAt: state.lastSuccessAt,
      }))
      .sort((left, right) => left.groupKey.localeCompare(right.groupKey));

    return {
      enabled: this.config.enabled,
      groupBy: this.config.groupBy,
      baseDelayMs: this.config.baseDelayMs,
      maxDelayMs: this.config.maxDelayMs,
      multiplier: this.config.multiplier,
      statusCodes: [...this.config.statusCodes],
      blockedGroupCount: groups.filter((group) => group.waitMs > 0).length,
      groups,
    };
  }
}
