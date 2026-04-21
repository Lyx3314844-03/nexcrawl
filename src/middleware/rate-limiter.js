/**
 * API Rate Limiting Middleware — Distributed Token Bucket + Redis
 *
 * Protects API endpoints from abuse using a true token bucket algorithm.
 * Supports in-memory mode (single process) and Redis-backed mode (distributed).
 *
 * @example
 * // In-memory (default)
 * const limiter = new RateLimiter({ max: 100, refillRate: 10 });
 *
 * // Redis-backed (distributed)
 * const limiter = new RateLimiter({
 *   max: 100,
 *   refillRate: 10,
 *   redis: { host: '127.0.0.1', port: 6379 },
 *   prefix: 'omnicrawl:ratelimit:'
 * });
 */

/**
 * In-memory token bucket state.
 * @typedef {{ tokens: number, lastRefillAt: number }} BucketState
 */

/**
 * RateLimiter — Token Bucket with optional Redis backend.
 *
 * Algorithm: Token Bucket
 *   - Each client gets a bucket with `max` tokens (burst capacity).
 *   - Tokens refill at `refillRate` tokens per second.
 *   - Each request consumes 1 token.
 *   - If no tokens available → 429 Too Many Requests.
 *
 * Superior to fixed-window because:
 *   - No burst-at-boundary problem (fixed-window allows 2x burst at window edge)
 *   - Smoother traffic shaping
 *   - Supports distributed environments via Redis
 */
export class RateLimiter {
  /**
   * @param {Object} [options]
   * @param {number} [options.max=100] - Bucket capacity (max burst tokens)
   * @param {number} [options.refillRate=10] - Tokens refilled per second
   * @param {string} [options.message='Too many requests'] - Error message on limit
   * @param {Object} [options.redis=null] - Redis config for distributed mode
   * @param {string} [options.redis.host] - Redis host
   * @param {number} [options.redis.port] - Redis port
   * @param {string} [options.redis.password] - Redis password
   * @param {number} [options.redis.db] - Redis database index
   * @param {any} [options.redis.client] - Existing ioredis client
   * @param {string} [options.prefix='omnicrawl:ratelimit:'] - Redis key prefix
   * @param {boolean} [options.forwardHeaders=false] - Add X-RateLimit-* headers
   */
  constructor({
    max = 100,
    refillRate = 10,
    message = 'Too many requests',
    redis = null,
    prefix = 'omnicrawl:ratelimit:',
    forwardHeaders = true,
    keyExtractor = null,
  } = {}) {
    this.max = max;
    this.refillRate = refillRate;
    this.keyExtractor = keyExtractor;
    this.message = message;
    this.prefix = prefix;
    this.forwardHeaders = forwardHeaders;

    /** @type {Map<string, BucketState>} */
    this.buckets = new Map();

    // Redis distributed backend
    this._redisClient = null;
    this._redisOwned = false;

    if (redis) {
      this._initRedis(redis);
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
          const delay = Math.min(times * 200, 5000);
          return delay;
        },
      });
      this._redisOwned = true;
      await this._redisClient.connect();
    } catch (err) {
      process.stderr.write(`[omnicrawl] RateLimiter Redis init failed, falling back to in-memory: ${err.message}\n`);
      this._redisClient = null;
    }
  }

  /**
   * Refill tokens for an in-memory bucket.
   * @param {BucketState} bucket
   */
  _refill(bucket) {
    if (this.refillRate <= 0) {
      return;
    }

    const now = Date.now();
    const elapsed = now - bucket.lastRefillAt;
    const tokensToAdd = (elapsed / 1000) * this.refillRate;
    if (tokensToAdd >= 1) {
      bucket.tokens = Math.min(this.max, bucket.tokens + Math.floor(tokensToAdd));
      bucket.lastRefillAt = now;
    }
  }

  /**
   * Try to consume a token from an in-memory bucket.
   * @param {string} key - Client identifier
   * @returns {{ allowed: boolean, remaining: number, resetIn: number }}
   */
  _consumeLocal(key) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.max, lastRefillAt: Date.now() };
      this.buckets.set(key, bucket);
    }

    this._refill(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetIn: this.refillRate > 0
          ? Math.ceil((this.max - bucket.tokens) / this.refillRate)
          : 0,
      };
    }

    // Not enough tokens — calculate when next one will be available
    const deficit = 1 - bucket.tokens;
    const waitMs = this.refillRate > 0
      ? Math.ceil((deficit / this.refillRate) * 1000)
      : Number.POSITIVE_INFINITY;

    return {
      allowed: false,
      remaining: 0,
      resetIn: Number.isFinite(waitMs)
        ? Math.ceil(waitMs / 1000)
        : 3600,
    };
  }

  /**
   * Try to consume a token from a Redis-backed bucket (Lua script for atomicity).
   * @param {string} key
   * @returns {Promise<{ allowed: boolean, remaining: number, resetIn: number }>}
   */
  async _consumeRedis(key) {
    const redisKey = `${this.prefix}${key}`;
    const now = Date.now();
    const refillMs = 1000 / this.refillRate;

    // Lua script: atomic token bucket consume
    const script = [
      'local key = KEYS[1]',
      'local now = tonumber(ARGV[1])',
      'local max_tokens = tonumber(ARGV[2])',
      'local refill_ms = tonumber(ARGV[3])',
      'local bucket = redis.call("HMGET", key, "tokens", "lastRefillAt")',
      'local tokens = tonumber(bucket[1])',
      'local last = tonumber(bucket[2])',
      'if tokens == nil then tokens = max_tokens; last = now end',
      'local elapsed = now - last',
      'if elapsed > 0 then',
      '  local add = math.floor(elapsed / refill_ms)',
      '  if add > 0 then tokens = math.min(max_tokens, tokens + add); last = now end',
      'end',
      'local allowed = 0',
      'if tokens >= 1 then tokens = tokens - 1; allowed = 1 end',
      'redis.call("HMSET", key, "tokens", tokens, "lastRefillAt", last)',
      'redis.call("PEXPIRE", key, math.max(max_tokens * refill_ms * 2, 60000))',
      'local deficit = 1 - tokens',
      'local reset_in = math.ceil(deficit * refill_ms / 1000)',
      'return { allowed, math.floor(tokens), reset_in }',
    ].join('\n');

    try {
      const result = await this._redisClient.eval(script, 1, redisKey, now, this.max, refillMs);
      return {
        allowed: result[0] === 1,
        remaining: result[1],
        resetIn: result[2],
      };
    } catch (err) {
      process.stderr.write(`[omnicrawl] RateLimiter Redis error, falling back to in-memory: ${err.message}\n`);
      return this._consumeLocal(key);
    }
  }

  /**
   * Check whether a request is allowed (non-middleware usage).
   * @param {string} key - Client identifier (IP, user ID, etc.)
   * @returns {Promise<{ allowed: boolean, remaining: number, resetIn: number }>}
   */
  async check(key) {
    if (this._redisClient) {
      return this._consumeRedis(key);
    }
    return this._consumeLocal(key);
  }

  /**
   * Express-compatible middleware.
   * @returns {(req: any, res: any, next: Function) => void}
   */
  middleware(...args) {
    const handler = (req, res, next) => {
      const key = this.keyExtractor ? this.keyExtractor(req) : (req.ip || req.connection?.remoteAddress || 'unknown');
      const applyResult = (result) => {
        const setHeader = (name, value) => {
          if (typeof res?.set === 'function') {
            res.set(name, String(value));
            return;
          }
          if (typeof res?.setHeader === 'function') {
            res.setHeader(name, value);
          }
        };

        if (this.forwardHeaders) {
          setHeader('X-RateLimit-Limit', this.max);
          setHeader('X-RateLimit-Remaining', result.remaining);
          setHeader('X-RateLimit-Reset', result.resetIn);
        }

        if (!result.allowed) {
          setHeader('Retry-After', result.resetIn);

          if (typeof res?.status === 'function') {
            return res.status(429).json({
              error: this.message,
              retryAfter: result.resetIn,
            });
          }

          if (res && typeof res === 'object') {
            res.statusCode = 429;
          }
          if (typeof res?.json === 'function') {
            return res.json({
              error: this.message,
              retryAfter: result.resetIn,
            });
          }
          if (typeof res?.end === 'function') {
            res.end(JSON.stringify({
              error: this.message,
              retryAfter: result.resetIn,
            }));
          }
          return undefined;
        }

        return next?.();
      };

      if (this._redisClient) {
        return this.check(key).then(applyResult);
      }

      return applyResult(this._consumeLocal(key));
    };

    if (args.length === 0) {
      return handler;
    }

    return handler(...args);
  }

  /**
   * Clean up stale in-memory buckets.
   */
  cleanup() {
    const now = Date.now();
    const staleMs = this.refillRate > 0
      ? (this.max / this.refillRate) * 1000 * 2
      : 60 * 60 * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefillAt > staleMs) {
        this.buckets.delete(key);
      }
    }
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

  /**
   * Get a snapshot of current bucket states (for diagnostics).
   * @returns {Object}
   */
  snapshot() {
    const entries = {};
    for (const [key, bucket] of this.buckets) {
      entries[key] = {
        tokens: bucket.tokens,
        lastRefillAt: bucket.lastRefillAt,
      };
    }
    return {
      mode: this._redisClient ? 'redis' : 'memory',
      max: this.max,
      refillRate: this.refillRate,
      buckets: entries,
    };
  }
}

// Static accessor for presets (test compatibility)
Object.defineProperty(RateLimiter, 'apiLimiter', { get: () => apiLimiter });
Object.defineProperty(RateLimiter, 'strictLimiter', { get: () => strictLimiter });

// Preset limiters
export const apiLimiter = new RateLimiter({
  max: 5,
  refillRate: 5 / (15 * 60),
  message: 'Too many requests, please try again later.',
  forwardHeaders: true,
});

export const strictLimiter = new RateLimiter({
  max: 10,
  refillRate: 10 / 60,
  message: 'Rate limit exceeded.',
  forwardHeaders: true,
});

// Cleanup every 5 minutes
const cleanupTimer = setInterval(() => {
  apiLimiter.cleanup();
  strictLimiter.cleanup();
}, 5 * 60 * 1000);
cleanupTimer.unref?.();
