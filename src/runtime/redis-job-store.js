import { createLogger } from '../core/logger.js';
import { getRedisClient } from './redis-control-plane.js';

function createJobId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Redis-backed Job Store for large-scale distributed crawling.
 * Uses Redis Hashes for job metadata and Sorted Sets for job status indexing and queuing.
 */
export class RedisJobStore {
  constructor({ redis: redisOptions, workerId } = {}) {
    this.redis = getRedisClient(redisOptions);
    this.workerId = workerId ?? null;
    this.logger = createLogger({ component: 'redis-job-store' });
    this.keyPrefix = redisOptions?.keyPrefix ?? 'omnicrawl:';
  }

  async init() {
    await this.redis.connect().catch((err) => {
      if (err.message.includes('already connecting')) return;
      throw err;
    });
    return this;
  }

  async close() {
    await this.redis.quit();
  }

  #j(jobId) { return `job:${jobId}`; }
  #index(status) { return `jobs:by_status:${status}`; }
  #queue() { return 'jobs:queue'; }

  async createQueuedWorkflow({ workflowName, metadata = {}, workflow, source = 'inline', jobId } = {}) {
    const id = jobId ?? createJobId();
    const job = {
      id,
      workflowName,
      workflow: JSON.stringify(workflow),
      source,
      metadata: JSON.stringify(metadata),
      status: 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      runDir: null,
      stats: JSON.stringify({ pagesFetched: 0, resultCount: 0, failureCount: 0 }),
      events: '[]',
      error: null,
    };

    await this.redis.hset(this.#j(id), job);
    await this.redis.zadd(this.#index('queued'), Date.now(), id);
    await this.redis.zadd(this.#queue(), metadata.priority ?? 0, id);
    
    return this.#hydrate(job);
  }

  async get(jobId) {
    const data = await this.redis.hgetall(this.#j(jobId));
    if (!data || !data.id) return null;
    return this.#hydrate(data);
  }

  async update(jobId, patch) {
    const current = await this.get(jobId);
    if (!current) return null;

    const oldStatus = current.status;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    
    const redisPatch = { ...patch, updatedAt: next.updatedAt };
    if (patch.metadata) redisPatch.metadata = JSON.stringify(patch.metadata);
    if (patch.stats) redisPatch.stats = JSON.stringify(patch.stats);
    if (patch.workflow) redisPatch.workflow = JSON.stringify(patch.workflow);
    if (patch.events) redisPatch.events = JSON.stringify(patch.events);

    await this.redis.hset(this.#j(jobId), redisPatch);

    if (patch.status && patch.status !== oldStatus) {
      await this.redis.zrem(this.#index(oldStatus), jobId);
      await this.redis.zadd(this.#index(patch.status), Date.now(), jobId);
      if (oldStatus === 'queued') {
        await this.redis.zrem(this.#queue(), jobId);
      }
    }

    return next;
  }

  async claimNextQueuedJob({ workerId, leaseTtlMs }) {
    // Atomically pop from queue
    const result = await this.redis.zpopmin(this.#queue(), 1);
    if (result.length === 0) return null;

    const jobId = result[0][0];
    const job = await this.get(jobId);
    if (!job) return null;

    const expiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    await this.update(jobId, {
      status: 'running',
      startedAt: nowIso(),
      lease: {
        owner: workerId,
        expiresAt,
        lastHeartbeatAt: nowIso(),
      }
    });

    return await this.get(jobId);
  }

  async renewLease(jobId, { workerId, leaseTtlMs }) {
    const job = await this.get(jobId);
    if (!job || job.lease?.owner !== workerId) return false;

    const expiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    await this.redis.hset(this.#j(jobId), {
      'lease:expiresAt': expiresAt,
      'lease:lastHeartbeatAt': nowIso(),
    });
    return true;
  }

  async listHistory(limit = 100) {
    // Combine terminal statuses
    const statuses = ['completed', 'failed', 'interrupted'];
    const jobIds = [];
    for (const status of statuses) {
      const ids = await this.redis.zrevrange(this.#index(status), 0, limit - 1);
      jobIds.push(...ids);
    }

    const jobs = await Promise.all(jobIds.slice(0, limit).map(id => this.get(id)));
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  #hydrate(data) {
    return {
      ...data,
      metadata: data.metadata ? JSON.parse(data.metadata) : {},
      stats: data.stats ? JSON.parse(data.stats) : {},
      workflow: data.workflow ? JSON.parse(data.workflow) : null,
      events: data.events ? JSON.parse(data.events) : [],
      lease: data['lease:owner'] ? {
        owner: data['lease:owner'],
        expiresAt: data['lease:expiresAt'],
        lastHeartbeatAt: data['lease:lastHeartbeatAt'],
        active: new Date(data['lease:expiresAt']) > new Date(),
      } : null,
    };
  }
}
