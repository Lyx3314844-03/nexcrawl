import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisRequestQueue } from '../src/runtime/redis-request-queue.js';

class FakeRedisClient {
  constructor() {
    this.sets = new Map();
    this.hashes = new Map();
    this.sortedSets = new Map();
  }

  async connect() {}

  async quit() {}

  #ensureSet(key) {
    if (!this.sets.has(key)) {
      this.sets.set(key, new Set());
    }
    return this.sets.get(key);
  }

  #ensureHash(key) {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, {});
    }
    return this.hashes.get(key);
  }

  #ensureSortedSet(key) {
    if (!this.sortedSets.has(key)) {
      this.sortedSets.set(key, new Map());
    }
    return this.sortedSets.get(key);
  }

  async sadd(key, ...members) {
    const bucket = this.#ensureSet(key);
    let added = 0;
    for (const member of members) {
      if (!bucket.has(member)) {
        bucket.add(member);
        added += 1;
      }
    }
    return added;
  }

  async smembers(key) {
    return [...this.#ensureSet(key)];
  }

  async sismember(key, member) {
    return this.#ensureSet(key).has(member) ? 1 : 0;
  }

  async scard(key) {
    return this.#ensureSet(key).size;
  }

  async srem(key, ...members) {
    const bucket = this.#ensureSet(key);
    let removed = 0;
    for (const member of members) {
      if (bucket.delete(member)) {
        removed += 1;
      }
    }
    return removed;
  }

  async hset(key, values) {
    const bucket = this.#ensureHash(key);
    Object.assign(bucket, Object.fromEntries(
      Object.entries(values).map(([field, value]) => [field, String(value)]),
    ));
    return 1;
  }

  async hget(key, field) {
    return this.#ensureHash(key)[field] ?? null;
  }

  async hdel(key, ...fields) {
    const bucket = this.#ensureHash(key);
    let removed = 0;
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(bucket, field)) {
        delete bucket[field];
        removed += 1;
      }
    }
    return removed;
  }

  async hincrby(key, field, delta) {
    const bucket = this.#ensureHash(key);
    const next = Number(bucket[field] ?? 0) + Number(delta);
    bucket[field] = String(next);
    return next;
  }

  async hgetall(key) {
    return { ...this.#ensureHash(key) };
  }

  async zadd(key, score, member) {
    this.#ensureSortedSet(key).set(member, Number(score));
    return 1;
  }

  async zcard(key) {
    return this.#ensureSortedSet(key).size;
  }

  async zrange(key, start, stop) {
    const items = [...this.#ensureSortedSet(key).entries()].sort((left, right) => {
      if (left[1] !== right[1]) {
        return left[1] - right[1];
      }

      return String(left[0]).localeCompare(String(right[0]));
    });
    const normalizedStop = stop < 0 ? items.length + stop : stop;
    return items.slice(start, normalizedStop + 1).map(([member]) => member);
  }

  async zrem(key, ...members) {
    const bucket = this.#ensureSortedSet(key);
    let removed = 0;
    for (const member of members) {
      if (bucket.delete(member)) {
        removed += 1;
      }
    }
    return removed;
  }

  async zremrangebyscore(key, min, max) {
    const bucket = this.#ensureSortedSet(key);
    const lower = min === '-inf' ? Number.NEGATIVE_INFINITY : Number(min);
    const upper = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);
    let removed = 0;
    for (const [member, score] of [...bucket.entries()]) {
      if (score >= lower && score <= upper) {
        bucket.delete(member);
        removed += 1;
      }
    }
    return removed;
  }

  async zpopmin(key, count = 1) {
    const bucket = this.#ensureSortedSet(key);
    const items = [...bucket.entries()].sort((left, right) => {
      if (left[1] !== right[1]) {
        return left[1] - right[1];
      }

      return String(left[0]).localeCompare(String(right[0]));
    }).slice(0, count);

    for (const [member] of items) {
      bucket.delete(member);
    }

    return items.flatMap(([member, score]) => [member, String(score)]);
  }

  async evaluateAtomicDequeue({ keys, args }) {
    const [pendingKey, pendingLanesKey, inProgressKey, activeGroupsKey, activeLanesKey] = keys;
    const [
      itemPrefix,
      pendingLanePrefix,
      nowIso,
      nowMsRaw,
      hostAwareSchedulingRaw,
      maxInProgressPerGroupRaw,
      budgetWindowMsRaw,
      maxRequestsPerWindowRaw,
      laneConfigsJson,
      blockedGroupsJson,
      recentGroupsPrefix,
      recentLanesPrefix,
      laneHeadLimitRaw,
    ] = args;

    const nowMs = Number(nowMsRaw);
    const hostAwareScheduling = hostAwareSchedulingRaw === '1';
    const maxInProgressPerGroup = Number(maxInProgressPerGroupRaw);
    const budgetWindowMs = Number(budgetWindowMsRaw);
    const maxRequestsPerWindow = Number(maxRequestsPerWindowRaw);
    const laneConfigs = JSON.parse(laneConfigsJson || '{}');
    const blockedGroups = JSON.parse(blockedGroupsJson || '{}');
    const laneHeadLimit = Number(laneHeadLimitRaw ?? 8);
    const laneBuckets = await this.smembers(pendingLanesKey);
    let bestMember = '';
    let bestScore = null;
    let bestLaneBucket = '';
    let bestGroupKey = '';
    let bestLaneKey = '';
    let bestLaneConfig = null;

    for (const laneBucket of laneBuckets) {
      const lanePendingKey = `${pendingLanePrefix}${laneBucket}`;
      const laneConfig = laneConfigs[laneBucket] ?? null;

      if (laneConfig?.maxInProgress > 0) {
        const activeLaneCount = Number(await this.hget(activeLanesKey, laneBucket) ?? 0);
        if (activeLaneCount >= Number(laneConfig.maxInProgress)) {
          continue;
        }
      }

      if (laneConfig?.maxRequestsPerWindow > 0 && laneConfig?.budgetWindowMs > 0) {
        const recentLaneKey = `${recentLanesPrefix}${laneBucket}`;
        await this.zremrangebyscore(recentLaneKey, '-inf', nowMs - Number(laneConfig.budgetWindowMs));
        const recentLaneCount = await this.zcard(recentLaneKey);
        if (recentLaneCount >= Number(laneConfig.maxRequestsPerWindow)) {
          continue;
        }
      }

      const pendingMembers = await this.zrange(lanePendingKey, 0, laneHeadLimit - 1);
      for (const member of pendingMembers) {
        const itemKey = `${itemPrefix}${member}`;
        const item = await this.hgetall(itemKey);
        if (!item.uniqueKey) {
          await this.zrem(pendingKey, member);
          await this.zrem(lanePendingKey, member);
          continue;
        }
        if (item.status !== 'pending') {
          await this.zrem(pendingKey, member);
          await this.zrem(lanePendingKey, member);
          continue;
        }

        const groupKey = item.groupKey ?? '';
        const blockedUntil = Number(blockedGroups[groupKey] ?? 0);
        if (blockedUntil > nowMs) {
          continue;
        }

        if (hostAwareScheduling && maxInProgressPerGroup > 0 && groupKey) {
          const activeGroupCount = Number(await this.hget(activeGroupsKey, groupKey) ?? 0);
          if (activeGroupCount >= maxInProgressPerGroup) {
            continue;
          }
        }

        if (maxRequestsPerWindow > 0 && budgetWindowMs > 0 && groupKey) {
          const recentGroupKey = `${recentGroupsPrefix}${groupKey}`;
          await this.zremrangebyscore(recentGroupKey, '-inf', nowMs - budgetWindowMs);
          const recentGroupCount = await this.zcard(recentGroupKey);
          if (recentGroupCount >= maxRequestsPerWindow) {
            continue;
          }
        }

        const itemScore = Number(item.pendingScore ?? 0);
        if (bestScore === null || itemScore < bestScore) {
          bestMember = member;
          bestScore = itemScore;
          bestLaneBucket = laneBucket;
          bestGroupKey = groupKey;
          bestLaneKey = item.laneKey ?? '';
          bestLaneConfig = laneConfig;
        }
        break;
      }

      if ((await this.zcard(lanePendingKey)) === 0) {
        await this.srem(pendingLanesKey, laneBucket);
      }
    }

    if (!bestMember) {
      return '';
    }

    await this.zrem(pendingKey, bestMember);
    await this.zrem(`${pendingLanePrefix}${bestLaneBucket}`, bestMember);
    if ((await this.zcard(`${pendingLanePrefix}${bestLaneBucket}`)) === 0) {
      await this.srem(pendingLanesKey, bestLaneBucket);
    }
    const itemKey = `${itemPrefix}${bestMember}`;
    await this.hset(itemKey, {
      status: 'inProgress',
      updatedAt: nowIso,
      dispatchedAt: nowIso,
      dispatchedAtMs: String(nowMs),
    });
    await this.sadd(inProgressKey, bestMember);

    if (bestGroupKey) {
      await this.hincrby(activeGroupsKey, bestGroupKey, 1);
      if (maxRequestsPerWindow > 0 && budgetWindowMs > 0) {
        await this.zadd(`${recentGroupsPrefix}${bestGroupKey}`, nowMs, `${nowMs}:${bestMember}`);
      }
    }

    if (bestLaneConfig && bestLaneKey) {
      if (Number(bestLaneConfig.maxInProgress ?? 0) > 0) {
        await this.hincrby(activeLanesKey, bestLaneKey, 1);
      }
      if (Number(bestLaneConfig.maxRequestsPerWindow ?? 0) > 0 && Number(bestLaneConfig.budgetWindowMs ?? 0) > 0) {
        await this.zadd(`${recentLanesPrefix}${bestLaneKey}`, nowMs, `${nowMs}:${bestMember}`);
      }
    }

    return bestMember;
  }
}

test('redis request queue matches local queue contract and honors priority ordering', async () => {
  const queue = new RedisRequestQueue({
    redis: {
      client: new FakeRedisClient(),
    },
    jobId: 'job-test',
    config: {
      dropQueryParamPatterns: ['^utm_'],
    },
  });

  await queue.init();

  const first = await queue.enqueue({
    url: 'https://example.com/list?page=2&utm_source=email',
    priority: 10,
    depth: 1,
  });
  assert.equal(first.added, true);

  const duplicate = await queue.enqueue({
    url: 'https://example.com/list?utm_medium=social&page=2',
    priority: 99,
    depth: 1,
  });
  assert.equal(duplicate.added, false);

  const second = await queue.enqueue({
    url: 'https://example.com/detail/42',
    priority: 50,
    depth: 0,
  });
  assert.equal(second.added, true);
  assert.equal(queue.summary().totalCount, 2);

  const dequeuedFirst = await queue.dequeue();
  assert.equal(dequeuedFirst?.url, 'https://example.com/detail/42');
  assert.equal(dequeuedFirst?.priority, 50);

  await queue.markHandled(dequeuedFirst.uniqueKey, {
    finalUrl: dequeuedFirst.url,
    responseStatus: 200,
  });

  const dequeuedSecond = await queue.dequeue();
  assert.equal(dequeuedSecond?.url, 'https://example.com/list?page=2&utm_source=email');
  assert.equal(dequeuedSecond?.priority, 10);

  await queue.markFailed(dequeuedSecond.uniqueKey, {
    error: 'boom',
  });

  const summary = queue.summary();
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.handledCount, 1);
  assert.equal(summary.failedCount, 1);
});

test('redis request queue honors per-group budget windows', async () => {
  const queue = new RedisRequestQueue({
    redis: {
      client: new FakeRedisClient(),
    },
    jobId: 'job-frontier',
    config: {
      groupBy: 'origin',
      budgetWindowMs: 1000,
      maxRequestsPerWindow: 1,
    },
  });

  await queue.init();

  await queue.enqueue({
    url: 'http://127.0.0.1:3001/a-1',
    priority: 100,
  });
  await queue.enqueue({
    url: 'http://127.0.0.1:3001/a-2',
    priority: 90,
  });
  await queue.enqueue({
    url: 'http://127.0.0.1:3002/b-1',
    priority: 80,
  });

  const first = await queue.dequeue({
    groupBy: 'origin',
    budgetWindowMs: 1000,
    maxRequestsPerWindow: 1,
    recentGroupDispatches: new Map(),
  });
  assert.equal(first?.url, 'http://127.0.0.1:3001/a-1');

  const second = await queue.dequeue({
    groupBy: 'origin',
    budgetWindowMs: 1000,
    maxRequestsPerWindow: 1,
    recentGroupDispatches: new Map([
      ['http://127.0.0.1:3001', [Date.now()]],
    ]),
  });
  assert.equal(second?.url, 'http://127.0.0.1:3002/b-1');
});

test('redis request queue skips already-seen urls across runs', async () => {
  const redis = new FakeRedisClient();
  const firstQueue = new RedisRequestQueue({
    redis: {
      client: redis,
    },
    jobId: 'job-seen-a',
    config: {
      seenSet: {
        enabled: true,
        id: 'catalog-prod',
      },
    },
  });

  await firstQueue.init();
  const firstEnqueue = await firstQueue.enqueue({
    url: 'https://example.com/catalog/42',
    priority: 100,
  });
  assert.equal(firstEnqueue.added, true);

  const firstLease = await firstQueue.dequeue();
  assert.ok(firstLease);
  await firstQueue.markHandled(firstLease.uniqueKey, {
    finalUrl: firstLease.url,
    responseStatus: 200,
  });
  assert.equal(firstQueue.summary().seenSet.seenCount, 1);

  const secondQueue = new RedisRequestQueue({
    redis: {
      client: redis,
    },
    jobId: 'job-seen-b',
    config: {
      seenSet: {
        enabled: true,
        id: 'catalog-prod',
      },
    },
  });

  await secondQueue.init();
  const duplicate = await secondQueue.enqueue({
    url: 'https://example.com/catalog/42',
    priority: 100,
  });
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.reason, 'already-seen');
  assert.equal(secondQueue.summary().seenSet.seenCount, 1);
});

test('redis request queue honors discovery lane limits and windows', async () => {
  const queue = new RedisRequestQueue({
    redis: {
      client: new FakeRedisClient(),
    },
    jobId: 'job-lanes',
    config: {
      laneConfigs: {
        detail: {
          maxInProgress: 1,
          budgetWindowMs: 1000,
          maxRequestsPerWindow: 1,
        },
      },
    },
  });

  await queue.init();

  await queue.enqueue({
    url: 'https://example.com/product/1',
    priority: 100,
    metadata: { kind: 'detail' },
  });
  await queue.enqueue({
    url: 'https://example.com/product/2',
    priority: 90,
    metadata: { kind: 'detail' },
  });
  await queue.enqueue({
    url: 'https://example.com/catalog?page=2',
    priority: 80,
    metadata: { kind: 'pagination' },
  });

  const first = await queue.dequeue({
    laneConfigs: queue.config.laneConfigs,
    activeLanes: new Map(),
    recentLaneDispatches: new Map(),
  });
  assert.equal(first?.url, 'https://example.com/product/1');
  assert.equal(first?.laneKey, 'detail');

  const second = await queue.dequeue({
    laneConfigs: queue.config.laneConfigs,
    activeLanes: new Map([['detail', 1]]),
    recentLaneDispatches: new Map([['detail', [Date.now()]]]),
  });
  assert.equal(second?.url, 'https://example.com/catalog?page=2');
  assert.equal(second?.laneKey, 'pagination');

  const third = await queue.dequeue({
    laneConfigs: queue.config.laneConfigs,
    activeLanes: new Map(),
    recentLaneDispatches: new Map(),
  });
  assert.equal(third?.url, 'https://example.com/product/2');
  assert.equal(third?.laneKey, 'detail');
});

test('redis request queue persists userData and explicit laneKey', async () => {
  const queue = new RedisRequestQueue({
    redis: {
      client: new FakeRedisClient(),
    },
    jobId: 'job-userdata',
    config: {},
  });

  await queue.init();
  await queue.enqueue({
    url: 'https://example.com/product/9',
    priority: 100,
    laneKey: 'detail',
    userData: { discoveryKind: 'detail', shard: 'alpha' },
    metadata: { kind: 'detail' },
  });

  const leased = await queue.dequeue();
  assert.ok(leased);
  assert.equal(leased.laneKey, 'detail');
  assert.deepEqual(leased.userData, { discoveryKind: 'detail', shard: 'alpha' });
  assert.equal(leased.metadata.kind, 'detail');
});

test('redis request queue can coordinate lane budgets from backend state only', async () => {
  const queue = new RedisRequestQueue({
    redis: {
      client: new FakeRedisClient(),
    },
    jobId: 'job-backend-lanes',
    config: {
      hostAwareScheduling: false,
      laneConfigs: {
        detail: {
          maxInProgress: 1,
        },
      },
    },
  });

  await queue.init();
  await queue.enqueue({
    url: 'https://example.com/product/1',
    priority: 100,
    metadata: { kind: 'detail' },
  });
  await queue.enqueue({
    url: 'https://example.com/product/2',
    priority: 90,
    metadata: { kind: 'detail' },
  });
  await queue.enqueue({
    url: 'https://example.com/catalog?page=2',
    priority: 80,
    metadata: { kind: 'pagination' },
  });

  const first = await queue.dequeue({
    useBackendFrontierState: true,
    laneConfigs: queue.config.laneConfigs,
  });
  assert.equal(first?.url, 'https://example.com/product/1');

  const second = await queue.dequeue({
    useBackendFrontierState: true,
    laneConfigs: queue.config.laneConfigs,
  });
  assert.equal(second?.url, 'https://example.com/catalog?page=2');
  assert.equal(second?.laneKey, 'pagination');
});

test('redis request queue atomic dequeue can select from lane bucket heads', async () => {
  const queue = new RedisRequestQueue({
    redis: {
      client: new FakeRedisClient(),
    },
    jobId: 'job-atomic-window',
    config: {
      hostAwareScheduling: false,
      atomicLaneHeadLimit: 1,
      laneConfigs: {
        detail: {
          maxInProgress: 1,
        },
      },
    },
  });

  await queue.init();
  await queue.enqueue({
    url: 'https://example.com/product/1',
    priority: 100,
    metadata: { kind: 'detail' },
  });
  await queue.enqueue({
    url: 'https://example.com/product/2',
    priority: 90,
    metadata: { kind: 'detail' },
  });
  await queue.enqueue({
    url: 'https://example.com/catalog?page=2',
    priority: 80,
    metadata: { kind: 'pagination' },
  });

  const first = await queue.dequeue({
    useBackendFrontierState: true,
    laneConfigs: queue.config.laneConfigs,
  });
  assert.equal(first?.url, 'https://example.com/product/1');

  const second = await queue.dequeue({
    useBackendFrontierState: true,
    laneConfigs: queue.config.laneConfigs,
  });
  assert.equal(second?.url, 'https://example.com/catalog?page=2');
  assert.equal(second?.laneKey, 'pagination');
});
