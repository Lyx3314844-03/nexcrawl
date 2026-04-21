/**
 * DomainRateLimiter - Per-domain rate limiting for crawl requests.
 *
 * Unlike the crawl-policy `waitForTurn` which only respects robots.txt Crawl-delay,
 * this module provides explicit per-domain rate configuration, token-bucket style
 * burst allowance, and a clean API for integration into the fetch pipeline.
 *
 * v2: Adds optional Redis backend for distributed rate limiting across
 * multiple crawler instances. Falls back to in-memory when Redis is unavailable.
 *
 * Equivalent to Scrapy's per-domain DownloadDelay and Crawlee's maxRequestsPerMinute.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '../core/logger.js';

const log = createLogger('rate-limiter');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolveDomainTarget(target) {
  const raw = String(target ?? '').trim();
  if (!raw) {
    throw new Error('url or domain is required');
  }

  try {
    const candidate = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    if (/^[a-z0-9.-]+$/i.test(raw)) {
      return raw.toLowerCase();
    }
    throw new Error(`Invalid url or domain: ${raw}`);
  }
}

/**
 * @typedef {Object} DomainRateLimitConfig
 * @property {boolean} [enabled=true] - Enable explicit rate limiting
 * @property {number} [requestsPerSecond=1] - Max requests per second per domain
 * @property {number} [minDelayMs=0] - Minimum delay between requests (ms), overrides rps
 * @property {number} [maxDelayMs=0] - Maximum random jitter to add (ms)
 * @property {number} [burstSize=1] - Token bucket burst size (allow short bursts)
 * @property {number} [maxConcurrent=burstSize] - Max concurrent requests per domain
 * @property {Map<string, number>} [domainOverrides] - Per-domain rps overrides { "example.com": 0.5 }
 * @property {Object} [autoThrottle] - Adaptive throttling config
 * @property {Object} [redis] - Redis config for distributed mode
 * @property {string} [redis.host] - Redis host
 * @property {number} [redis.port] - Redis port
 * @property {string} [redis.password] - Redis password
 * @property {any} [redis.client] - Existing ioredis client instance
 * @property {string} [redisPrefix='omnicrawl:domainrl:'] - Redis key prefix
 */

export class DomainRateLimiter {
  /**
   * @param {DomainRateLimitConfig} config
   */
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.defaultRps = Math.max(0.001, config.requestsPerSecond ?? 1);
    this.minDelayMs = config.minDelayMs ?? 0;
    this.maxDelayMs = Math.max(0, config.maxDelayMs ?? 0);
    this.burstSize = Math.max(1, config.burstSize ?? 1);
    this.maxConcurrent = Math.max(1, config.maxConcurrent ?? this.burstSize);
    this.domainOverrides = config.domainOverrides instanceof Map
      ? new Map(config.domainOverrides)
      : new Map(Object.entries(config.domainOverrides ?? {}));
    const autoThrottle = config.autoThrottle ?? {};
    const maxAdaptiveRps = Math.max(
      autoThrottle.maxRequestsPerSecond ?? this.defaultRps,
      autoThrottle.minRequestsPerSecond ?? 0.25,
      this.defaultRps,
    );
    this.autoThrottle = {
      enabled: autoThrottle.enabled === true,
      minRequestsPerSecond: Math.max(0.001, autoThrottle.minRequestsPerSecond ?? 0.25),
      maxRequestsPerSecond: Math.max(0.001, maxAdaptiveRps),
      targetLatencyMs: Math.max(1, autoThrottle.targetLatencyMs ?? 2000),
      errorRateThreshold: clamp(autoThrottle.errorRateThreshold ?? 0.2, 0, 1),
      scaleDownFactor: clamp(autoThrottle.scaleDownFactor ?? 0.7, 0.01, 0.99),
      scaleUpStep: Math.max(0.01, autoThrottle.scaleUpStep ?? 0.1),
      smoothing: clamp(autoThrottle.smoothing ?? 0.3, 0, 1),
      cooldownMs: Math.max(0, autoThrottle.cooldownMs ?? 5000),
    };

    // Per-domain state (in-memory)
    /** @type {Map<string, { tokens: number, lastRefillAt: number, activeCount: number, nextSlotAt: number, adaptiveRps: number, emaLatencyMs: number|null, emaErrorRate: number, lastAdaptAt: number }>} */
    this.domains = new Map();

    this.stats = {
      totalWaits: 0,
      totalWaitMs: 0,
      domainsTracked: 0,
      burstGrants: 0,
      concurrentBlocks: 0,
      adaptiveAdjustments: 0,
    };

    // Redis distributed backend
    this._redisClient = null;
    this._redisOwned = false;
    this._redisPrefix = config.redis?.prefix ?? 'omnicrawl:domainrl:';

    if (config.redis) {
      this._initRedis(config.redis);
    }
  }

  /**
   * Initialize Redis connection for distributed rate limiting.
   * @param {Object} config
   */
  async _initRedis(config) {
    if (config.client) {
      this._redisClient = config.client;
      this._redisOwned = false;
      return;
    }

    try {
      const Redis = (await import('ioredis')).default;
      this._redisClient = new Redis({
        host: config.host ?? '127.0.0.1',
        port: config.port ?? 6379,
        password: config.password,
        db: config.db ?? 0,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          return Math.min(times * 200, 5000);
        },
      });
      this._redisOwned = true;
      await this._redisClient.connect();
      log.info('DomainRateLimiter Redis backend connected');
    } catch (err) {
      log.error('DomainRateLimiter Redis init failed, falling back to in-memory', { error: err.message });
      this._redisClient = null;
    }
  }

  /**
   * Get the configured baseline RPS for a given domain.
   * @param {string} domain
   * @returns {number}
   */
  getBaseRpsForDomain(domain) {
    if (this.domainOverrides.has(domain)) {
      return Math.max(0.001, this.domainOverrides.get(domain));
    }
    return this.defaultRps;
  }

  /**
   * Get the effective RPS for a given domain.
   * @param {string} domain
   * @returns {number}
   */
  getRpsForDomain(domain) {
    const state = this.domains.get(domain);
    if (this.autoThrottle.enabled && state?.adaptiveRps) {
      return state.adaptiveRps;
    }
    return this.getBaseRpsForDomain(domain);
  }

  /**
   * Get or create domain state (in-memory).
   * @param {string} domain
   * @returns {{ tokens: number, lastRefillAt: number, activeCount: number, nextSlotAt: number, adaptiveRps: number, emaLatencyMs: number|null, emaErrorRate: number, lastAdaptAt: number }}
   */
  _getState(domain) {
    if (!this.domains.has(domain)) {
      const baseRps = this.getBaseRpsForDomain(domain);
      this.domains.set(domain, {
        tokens: this.burstSize,
        lastRefillAt: Date.now(),
        activeCount: 0,
        nextSlotAt: 0,
        adaptiveRps: clamp(baseRps, this.autoThrottle.minRequestsPerSecond, this.autoThrottle.maxRequestsPerSecond),
        emaLatencyMs: null,
        emaErrorRate: 0,
        lastAdaptAt: 0,
      });
      this.stats.domainsTracked = this.domains.size;
    }
    return this.domains.get(domain);
  }

  /**
   * Refill tokens based on elapsed time (token bucket algorithm).
   * @param {{ tokens: number, lastRefillAt: number }} state
   * @param {number} rps
   */
  _refillTokens(state, rps) {
    const now = Date.now();
    const elapsed = now - state.lastRefillAt;
    const refillRate = rps; // tokens per second
    const tokensToAdd = (elapsed / 1000) * refillRate;

    if (tokensToAdd >= 1) {
      state.tokens = Math.min(this.burstSize, state.tokens + Math.floor(tokensToAdd));
      state.lastRefillAt = now;
    }
  }

  /**
   * Redis-backed token bucket acquire (atomic via Lua).
   * @param {string} domain
   * @param {number} rps
   * @returns {Promise<{ allowed: boolean, waitMs: number }>}
   */
  async _acquireRedis(domain, rps) {
    const redisKey = `${this._redisPrefix}${domain}`;
    const now = Date.now();
    const intervalMs = Math.floor(1000 / rps);

    // Lua script: atomic token bucket check + concurrent tracking
    const script = [
      'local key = KEYS[1]',
      'local now = tonumber(ARGV[1])',
      'local burst = tonumber(ARGV[2])',
      'local interval_ms = tonumber(ARGV[3])',
      'local max_concurrent = tonumber(ARGV[4])',
      '',
      'local data = redis.call("HMGET", key, "tokens", "lastRefillAt", "activeCount", "nextSlotAt")',
      'local tokens = tonumber(data[1])',
      'local last = tonumber(data[2])',
      'local active = tonumber(data[3]) or 0',
      'local nextSlot = tonumber(data[4]) or 0',
      '',
      'if tokens == nil then tokens = burst; last = now end',
      '',
      '-- Refill tokens',
      'local elapsed = now - last',
      'if elapsed > 0 then',
      '  local add = math.floor(elapsed / interval_ms)',
      '  if add > 0 then tokens = math.min(burst, tokens + add); last = now end',
      'end',
      '',
      '-- Check concurrent limit',
      'if active >= max_concurrent then',
      '  local wait = math.max(0, nextSlot - now)',
      '  return {0, wait, active}',
      'end',
      '',
      '-- Try consume token',
      'if tokens >= 1 then',
      '  tokens = tokens - 1',
      '  active = active + 1',
      '  nextSlot = now + interval_ms',
      '  redis.call("HMSET", key, "tokens", tokens, "lastRefillAt", last, "activeCount", active, "nextSlotAt", nextSlot)',
      '  redis.call("PEXPIRE", key, math.max(burst * interval_ms * 3, 120000))',
      '  return {1, 0, active}',
      'end',
      '',
      '-- No tokens available, compute wait',
      'local deficit = 1 - tokens',
      'local wait = math.ceil(deficit * interval_ms)',
      'local next = math.max(nextSlot, now + interval_ms)',
      'return {0, math.max(wait, next - now), active}',
    ].join('\n');

    try {
      const result = await this._redisClient.eval(
        script, 1, redisKey, now, this.burstSize, intervalMs, this.maxConcurrent,
      );
      const allowed = result[0] === 1;
      const waitMs = result[1] ?? 0;
      const activeCount = result[2] ?? 0;

      return { allowed, waitMs, activeCount };
    } catch (err) {
      log.error('DomainRateLimiter Redis error, falling back to in-memory', { error: err.message });
      return { allowed: false, waitMs: -1, activeCount: 0 }; // -1 signals fallback needed
    }
  }

  /**
   * Redis-backed release (decrement active count).
   * @param {string} domain
   */
  async _releaseRedis(domain) {
    const redisKey = `${this._redisPrefix}${domain}`;
    try {
      const script = [
        'local key = KEYS[1]',
        'local active = tonumber(redis.call("HGET", key, "activeCount") or 0)',
        'if active > 0 then',
        '  redis.call("HINCRBY", key, "activeCount", -1)',
        'end',
        'return active - 1',
      ].join('\n');
      await this._redisClient.eval(script, 1, redisKey);
    } catch (err) {
      log.error('DomainRateLimiter Redis release error', { error: err.message });
    }
  }

  /**
   * Redis-backed report (update adaptive metrics).
   * @param {string} domain
   * @param {Object} outcome
   */
  async _reportRedis(domain, outcome) {
    const redisKey = `${this._redisPrefix}${domain}:metrics`;
    const durationMs = Math.max(0, Number(outcome.durationMs ?? 0));
    const status = Number(outcome.status ?? 0);
    const ok = outcome.ok !== undefined ? Boolean(outcome.ok) : status === 0 || status < 400;
    const errorSignal = !ok || [408, 429, 500, 502, 503, 504].includes(status) ? 1 : 0;

    try {
      // Store raw metrics for aggregation — auto-throttle adaptation
      // is done locally since it requires complex EMA calculations
      await this._redisClient.rpush(redisKey, JSON.stringify({
        at: Date.now(),
        durationMs,
        errorSignal,
        status,
      }));
      // Keep only last 100 samples
      await this._redisClient.ltrim(redisKey, -100, -1);
      await this._redisClient.pexpire(redisKey, 300000); // 5 min TTL
    } catch (err) {
      log.error('DomainRateLimiter Redis report error', { error: err.message });
    }
  }

  /**
   * Wait for permission to make a request to the given domain.
   * Resolves when the request is allowed.
   *
   * @param {string} target - The URL or domain to be requested
   * @returns {Promise<{ waitMs: number, domain: string }>}
   */
  async acquire(target) {
    if (!this.enabled) {
      return {
        waitMs: 0,
        domain: resolveDomainTarget(target),
      };
    }

    const domain = resolveDomainTarget(target);
    const rps = this.getRpsForDomain(domain);
    const intervalMs = 1000 / rps;

    // Redis distributed path
    if (this._redisClient) {
      const result = await this._acquireRedis(domain, rps);

      if (result.fallback) {
        // Fallback to in-memory
        return this._acquireLocal(domain, rps, intervalMs);
      }

      if (!result.allowed) {
        const waitMs = result.waitMs;
        if (waitMs > 0) {
          await sleep(waitMs);
          this.stats.totalWaits += 1;
          this.stats.totalWaitMs += waitMs;
        }
        // Retry after waiting
        const retry = await this._acquireRedis(domain, rps);
        if (!retry.allowed && retry.waitMs > 0) {
          await sleep(retry.waitMs);
          this.stats.totalWaits += 1;
          this.stats.totalWaitMs += retry.waitMs;
        }
      } else {
        this.stats.burstGrants += 1;
      }

      // Apply min delay override
      if (this.minDelayMs > 0) {
        await sleep(this.minDelayMs);
      }

      // Apply random jitter
      if (this.maxDelayMs > 0) {
        const jitter = Math.floor(Math.random() * this.maxDelayMs);
        if (jitter > 0) await sleep(jitter);
      }

      return { waitMs: result.waitMs, domain };
    }

    // In-memory path
    return this._acquireLocal(domain, rps, intervalMs);
  }

  async waitForTurn(target) {
    if (!this.enabled) {
      return {
        waitMs: 0,
        domain: resolveDomainTarget(target),
      };
    }

    const domain = resolveDomainTarget(target);
    const rps = this.getRpsForDomain(domain);
    const intervalMs = 1000 / rps;
    const state = this._getState(domain);

    this._refillTokens(state, rps);

    let waitMs = 0;
    if (state.tokens >= 1) {
      state.tokens -= 1;
      this.stats.burstGrants += 1;
    } else {
      const now = Date.now();
      const nextSlot = Math.max(state.nextSlotAt, now + intervalMs);
      waitMs = Math.max(0, nextSlot - now);
      if (waitMs > 0) {
        await sleep(waitMs);
        this.stats.totalWaits += 1;
        this.stats.totalWaitMs += waitMs;
      }
      state.lastRefillAt = Date.now();
    }

    state.nextSlotAt = Date.now() + intervalMs;
    return { waitMs, domain };
  }

  /**
   * Local in-memory acquire path.
   * @private
   */
  async _acquireLocal(domain, rps, intervalMs) {
    const state = this._getState(domain);

    // Check concurrent limit first
    if (state.activeCount >= this.maxConcurrent) {
      this.stats.concurrentBlocks += 1;
      const waitMs = Math.max(0, state.nextSlotAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }

    // Token bucket check
    this._refillTokens(state, rps);

    let waitMs = 0;

    if (state.tokens >= 1) {
      // Token available, consume it
      state.tokens -= 1;
      this.stats.burstGrants += 1;
    } else {
      // No token, must wait for next slot
      const now = Date.now();
      const nextSlot = Math.max(state.nextSlotAt, now + intervalMs);
      waitMs = Math.max(0, nextSlot - now);

      if (waitMs > 0) {
        await sleep(waitMs);
        this.stats.totalWaits += 1;
        this.stats.totalWaitMs += waitMs;
      }

      state.lastRefillAt = Date.now();
    }

    // Apply min delay override
    if (this.minDelayMs > 0) {
      const now = Date.now();
      const minSlot = state.nextSlotAt + this.minDelayMs;
      if (minSlot > now) {
        const extraWait = minSlot - now;
        await sleep(extraWait);
        waitMs += extraWait;
      }
    }

    // Apply random jitter
    if (this.maxDelayMs > 0) {
      const jitter = Math.floor(Math.random() * this.maxDelayMs);
      if (jitter > 0) {
        await sleep(jitter);
        waitMs += jitter;
      }
    }

    state.nextSlotAt = Date.now() + intervalMs;
    state.activeCount += 1;

    return { waitMs, domain };
  }

  /**
   * Release a slot after a request completes.
   * @param {string} target
   */
  release(target) {
    if (!this.enabled) {
      return;
    }

    const domain = resolveDomainTarget(target);

    if (this._redisClient) {
      this._releaseRedis(domain);
    }

    // Also update local state
    const state = this.domains.get(domain);
    if (state && state.activeCount > 0) {
      state.activeCount -= 1;
    }
  }

  /**
   * Report the outcome of a request so auto-throttle can adapt.
   * @param {string} target
   * @param {Object} outcome
   * @param {number} [outcome.durationMs]
   * @param {boolean} [outcome.ok]
   * @param {number} [outcome.status]
   */
  report(target, outcome = {}) {
    if (!this.enabled || !this.autoThrottle.enabled) {
      return;
    }

    const domain = resolveDomainTarget(target);
    const state = this._getState(domain);

    // Report to Redis for distributed awareness
    if (this._redisClient) {
      this._reportRedis(domain, outcome);
    }

    // Local auto-throttle adaptation
    const now = Date.now();
    const durationMs = Math.max(0, Number(outcome.durationMs ?? 0));
    const status = Number(outcome.status ?? 0);
    const ok = outcome.ok !== undefined ? Boolean(outcome.ok) : status === 0 || status < 400;
    const smoothing = this.autoThrottle.smoothing;
    const errorSignal = !ok || [408, 429, 500, 502, 503, 504].includes(status) ? 1 : 0;

    if (durationMs > 0) {
      state.emaLatencyMs = state.emaLatencyMs === null
        ? durationMs
        : (state.emaLatencyMs * (1 - smoothing)) + (durationMs * smoothing);
    }

    state.emaErrorRate = (state.emaErrorRate * (1 - smoothing)) + (errorSignal * smoothing);

    if (state.lastAdaptAt > 0 && (now - state.lastAdaptAt) < this.autoThrottle.cooldownMs) {
      return;
    }

    const currentRps = this.getRpsForDomain(domain);
    let nextRps = currentRps;

    const latencyAboveTarget = state.emaLatencyMs !== null && state.emaLatencyMs > this.autoThrottle.targetLatencyMs;
    const recoverySample = durationMs > 0 && durationMs < (this.autoThrottle.targetLatencyMs * 0.5);

    if (errorSignal === 1) {
      nextRps = currentRps * this.autoThrottle.scaleDownFactor;
    } else if (state.emaErrorRate >= this.autoThrottle.errorRateThreshold && latencyAboveTarget && !recoverySample) {
      nextRps = currentRps * this.autoThrottle.scaleDownFactor;
    } else if (latencyAboveTarget && !recoverySample) {
      const ratio = this.autoThrottle.targetLatencyMs / state.emaLatencyMs;
      nextRps = currentRps * clamp(ratio, this.autoThrottle.scaleDownFactor, 1);
    } else if (recoverySample || (state.emaLatencyMs !== null && state.emaLatencyMs < (this.autoThrottle.targetLatencyMs * 0.85))) {
      nextRps = currentRps * (1 + this.autoThrottle.scaleUpStep);
    }

    const boundedRps = clamp(
      nextRps,
      this.autoThrottle.minRequestsPerSecond,
      this.autoThrottle.maxRequestsPerSecond,
    );

    if (Math.abs(boundedRps - state.adaptiveRps) >= 0.001) {
      state.adaptiveRps = boundedRps;
      state.lastAdaptAt = now;
      this.stats.adaptiveAdjustments += 1;
    }
  }

  /**
   * Configure a specific domain's rate limit.
   * @param {string} domain - Domain name (e.g. "example.com")
   * @param {number} rps - Requests per second
   */
  setDomainRate(domain, rps) {
    const normalizedDomain = resolveDomainTarget(domain);
    this.domainOverrides.set(normalizedDomain, Math.max(0.001, rps));
    if (this.domains.has(normalizedDomain)) {
      const state = this.domains.get(normalizedDomain);
      state.adaptiveRps = clamp(
        state.adaptiveRps,
        this.autoThrottle.minRequestsPerSecond,
        Math.max(this.autoThrottle.maxRequestsPerSecond, Math.max(0.001, rps)),
      );
    }
  }

  /**
   * Get a snapshot of the current rate limiter state.
   * @returns {Object}
   */
  snapshot() {
    const domainSnapshots = {};
    for (const [domain, state] of this.domains) {
      domainSnapshots[domain] = {
        tokens: state.tokens,
        activeCount: state.activeCount,
        nextSlotAt: state.nextSlotAt,
        rps: this.getRpsForDomain(domain),
        baseRps: this.getBaseRpsForDomain(domain),
        adaptiveRps: this.autoThrottle.enabled ? state.adaptiveRps : null,
        emaLatencyMs: state.emaLatencyMs,
        emaErrorRate: state.emaErrorRate,
      };
    }

    return {
      ...this.stats,
      enabled: this.enabled,
      mode: this._redisClient ? 'redis' : 'memory',
      autoThrottle: this.autoThrottle,
      domains: domainSnapshots,
    };
  }

  /**
   * Reset all rate limiter state.
   */
  reset() {
    this.domains.clear();
    this.stats = {
      totalWaits: 0,
      totalWaitMs: 0,
      domainsTracked: 0,
      burstGrants: 0,
      concurrentBlocks: 0,
      adaptiveAdjustments: 0,
    };
  }

  /**
   * Close Redis connection if owned by this instance.
   */
  async close() {
    if (this._redisClient && this._redisOwned) {
      await this._redisClient.quit();
      this._redisClient = null;
      this._redisOwned = false;
    }
  }
}

export default DomainRateLimiter;
