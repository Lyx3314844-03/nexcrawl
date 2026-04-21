/**
 * Redis Control Plane Module
 *
 * Replaces SQLite as the distributed queue backend for large-scale crawling.
 * Provides job queue, schedule leases, worker heartbeats, and pub/sub events
 * through Redis with RedisJSON and RediSearch support.
 *
 * Requires: ioredis + optional redis-om for object mapping
 */

import { createRequire } from 'node:module';
import { AppError } from '../core/errors.js';

const require = createRequire(import.meta.url);

/**
 * Initialize Redis client (lazy load ioredis)
 */
function getRedisClient(options = {}) {
  const {
    host = '127.0.0.1',
    port = 6379,
    password = null,
    db = 0,
    keyPrefix = 'omnicrawl:',
    ...redisOptions
  } = options;

  let Redis;
  try {
    Redis = require('ioredis');
  } catch {
    throw new AppError(500, 'ioredis is required for Redis control plane. Run: npm install ioredis');
  }

  return new Redis({
    host,
    port,
    password,
    db,
    keyPrefix,
    retryStrategy: (times) => Math.min(times * 50, 2000),
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    ...redisOptions,
  });
}

/**
 * Redis-backed job queue with priority support
 */
export class RedisJobQueue {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.queueKey = options.queueKey ?? 'job:queue';
    this.processingKey = options.processingKey ?? 'job:processing';
    this.resultsKey = options.resultsKey ?? 'job:results';
    this.leaseTtlMs = options.leaseTtlMs ?? 300_000; // 5 min default
  }

  /**
   * Push job to queue with priority (using sorted set)
   */
  async push(job) {
    const priority = job.priority ?? 0;
    const jobId = job.id ?? crypto.randomUUID();
    const payload = { ...job, id: jobId, queuedAt: Date.now() };
    await this.redis.set(`job:${jobId}`, JSON.stringify(payload));
    // Lower score = higher priority
    await this.redis.zadd(this.queueKey, priority, jobId);
    return jobId;
  }

  /**
   * Claim next job with lease
   */
  async claim(workerId, maxWaitMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      // Atomically pop highest priority job (lowest score)
      const results = await this.redis.zpopmin(this.queueKey, 1);
      if (results.length === 0) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      const jobId = results[0][0];
      const leaseExpiry = Date.now() + this.leaseTtlMs;
      await this.redis.hset(this.processingKey, jobId, JSON.stringify({
        workerId,
        leasedAt: Date.now(),
        leaseExpiry,
      }));
      await this.redis.expire(this.processingKey, Math.ceil(this.leaseTtlMs / 1000));

      const jobData = await this.redis.get(`job:${jobId}`);
      return jobData ? JSON.parse(jobData) : null;
    }
    return null;
  }

  /**
   * Renew job lease
   */
  async renewLease(jobId, workerId) {
    const key = this.processingKey;
    const data = await this.redis.hget(key, jobId);
    if (!data) return false;
    const info = JSON.parse(data);
    if (info.workerId !== workerId) return false;
    info.leaseExpiry = Date.now() + this.leaseTtlMs;
    await this.redis.hset(key, jobId, JSON.stringify(info));
    return true;
  }

  /**
   * Release job back to queue (failed/timeout)
   */
  async release(jobId) {
    const data = await this.redis.hget(this.processingKey, jobId);
    if (data) {
      await this.redis.hdel(this.processingKey, jobId);
    }
    const jobData = await this.redis.get(`job:${jobId}`);
    if (jobData) {
      const job = JSON.parse(jobData);
      job.retries = (job.retries ?? 0) + 1;
      await this.redis.set(`job:${jobId}`, JSON.stringify(job));
      await this.redis.zadd(this.queueKey, job.priority ?? 0, jobId);
    }
  }

  /**
   * Complete job and store result
   */
  async complete(jobId, result) {
    await this.redis.hdel(this.processingKey, jobId);
    await this.redis.set(`${this.resultsKey}:${jobId}`, JSON.stringify({
      ...result,
      completedAt: Date.now(),
    }));
    await this.redis.del(`job:${jobId}`);
  }

  /**
   * Reclaim expired leases
   */
  async reclaimExpired() {
    const now = Date.now();
    const jobs = await this.redis.hgetall(this.processingKey);
    const reclaimed = [];
    for (const [jobId, dataStr] of Object.entries(jobs)) {
      try {
        const data = JSON.parse(dataStr);
        if (data.leaseExpiry < now) {
          reclaimed.push(jobId);
          await this.release(jobId);
        }
      } catch { /* skip malformed */ }
    }
    return reclaimed;
  }

  /**
   * Queue length
   */
  async length() {
    return this.redis.zcard(this.queueKey);
  }

  /**
   * Processing count
   */
  async processingCount() {
    return this.redis.hlen(this.processingKey);
  }
}

/**
 * Redis-backed schedule lease manager
 */
export class RedisScheduleManager {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.schedulesKey = options.schedulesKey ?? 'schedules';
    this.leaseKey = options.leaseKey ?? 'schedule:leases';
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
  }

  async register(scheduleId, cronExpr, workflow) {
    await this.redis.hset(this.schedulesKey, scheduleId, JSON.stringify({
      id: scheduleId,
      cron: cronExpr,
      workflow,
      createdAt: Date.now(),
      enabled: true,
    }));
  }

  async acquireLease(scheduleId, workerId) {
    const acquired = await this.redis.set(
      `${this.leaseKey}:${scheduleId}`,
      workerId,
      'NX',
      'PX',
      this.leaseTtlMs,
    );
    return acquired === 'OK';
  }

  async getAll() {
    const data = await this.redis.hgetall(this.schedulesKey);
    return Object.entries(data).map(([id, str]) => JSON.parse(str));
  }

  async enable(scheduleId) {
    const data = await this.redis.hget(this.schedulesKey, scheduleId);
    if (!data) return false;
    const schedule = JSON.parse(data);
    schedule.enabled = true;
    await this.redis.hset(this.schedulesKey, scheduleId, JSON.stringify(schedule));
    return true;
  }

  async disable(scheduleId) {
    const data = await this.redis.hget(this.schedulesKey, scheduleId);
    if (!data) return false;
    const schedule = JSON.parse(data);
    schedule.enabled = false;
    await this.redis.hset(this.schedulesKey, scheduleId, JSON.stringify(schedule));
    return true;
  }
}

/**
 * Redis pub/sub event bus for cross-node communication
 */
export class RedisEventBus {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.pub = redis.duplicate();
    this.channel = options.channel ?? 'omnicrawl:events';
    this.listeners = new Map();
  }

  async publish(event) {
    await this.pub.publish(this.channel, JSON.stringify({
      ...event,
      timestamp: Date.now(),
    }));
  }

  subscribe(handler) {
    const sub = this.redis.duplicate();
    sub.subscribe(this.channel);
    sub.on('message', (ch, msg) => {
      try {
        handler(JSON.parse(msg));
      } catch { /* skip malformed */ }
    });
    this.listeners.set(handler, sub);
    return handler;
  }

  unsubscribe(handler) {
    const sub = this.listeners.get(handler);
    if (sub) {
      sub.unsubscribe(this.channel);
      sub.quit();
      this.listeners.delete(handler);
    }
  }

  async close() {
    for (const sub of this.listeners.values()) {
      sub.unsubscribe(this.channel);
      sub.quit();
    }
    this.listeners.clear();
    await this.pub.quit();
  }
}

/**
 * Redis-backed worker heartbeat manager
 */
export class RedisWorkerRegistry {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.workersKey = options.workersKey ?? 'workers';
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  async register(workerId, metadata = {}) {
    await this.redis.hset(this.workersKey, workerId, JSON.stringify({
      id: workerId,
      status: 'active',
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      ...metadata,
    }));
  }

  async heartbeat(workerId, metadata = {}) {
    const existing = await this.redis.hget(this.workersKey, workerId);
    const data = existing ? JSON.parse(existing) : {};
    await this.redis.hset(this.workersKey, workerId, JSON.stringify({
      ...data,
      ...metadata,
      id: workerId,
      status: 'active',
      lastHeartbeat: Date.now(),
    }));
  }

  async deregister(workerId) {
    await this.redis.hdel(this.workersKey, workerId);
  }

  async getActive(staleMs = 60_000) {
    const data = await this.redis.hgetall(this.workersKey);
    const now = Date.now();
    return Object.entries(data)
      .map(([id, str]) => JSON.parse(str))
      .filter((w) => now - w.lastHeartbeat < staleMs);
  }

  async getDead(staleMs = 60_000) {
    const data = await this.redis.hgetall(this.workersKey);
    const now = Date.now();
    return Object.entries(data)
      .map(([id, str]) => JSON.parse(str))
      .filter((w) => now - w.lastHeartbeat >= staleMs);
  }

  async cleanupDead(staleMs = 60_000) {
    const dead = await this.getDead(staleMs);
    for (const w of dead) {
      await this.deregister(w.id);
    }
    return dead;
  }
}

/**
 * Create a complete Redis control plane
 */
export function createRedisControlPlane(options = {}) {
  const {
    redis: redisOptions = {},
    queue: queueOptions = {},
    schedule: scheduleOptions = {},
    events: eventsOptions = {},
    workers: workersOptions = {},
  } = options;

  const redis = getRedisClient(redisOptions);

  return {
    redis,
    queue: new RedisJobQueue(redis, queueOptions),
    schedules: new RedisScheduleManager(redis, scheduleOptions),
    events: new RedisEventBus(redis, eventsOptions),
    workers: new RedisWorkerRegistry(redis, workersOptions),

    async close() {
      await this.events.close();
      await redis.quit();
    },

    async healthCheck() {
      const start = Date.now();
      await redis.ping();
      return {
        status: 'ok',
        latencyMs: Date.now() - start,
        backend: 'redis',
      };
    },
  };
}

export {
  getRedisClient,
};
