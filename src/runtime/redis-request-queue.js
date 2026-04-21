import { getRedisClient } from './redis-control-plane.js';
import {
  buildRequestUniqueKey,
  normalizeRequestPriority,
  getRequestGroupKey,
  getRequestHostKey,
  getRequestLaneKey,
  normalizeRequestGroupBy,
} from './request-queue.js';

function nowIso() {
  return new Date().toISOString();
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

function queueConfig(config = {}) {
  const parsedMaxInProgressPerGroup = Number(config.maxInProgressPerGroup ?? config.maxInProgressPerHost ?? 1);
  const seenSet = config.seenSet ?? {};
  const seenSetId = seenSet.id === undefined || seenSet.id === null ? null : String(seenSet.id).trim();
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
    atomicDequeueScanLimit: Math.max(1, Number(config.atomicDequeueScanLimit ?? 128)),
    atomicLaneHeadLimit: Math.max(1, Number(config.atomicLaneHeadLimit ?? 8)),
    laneConfigs,
    dropQueryParams: Array.isArray(config.dropQueryParams)
      ? config.dropQueryParams.map((entry) => String(entry).toLowerCase())
      : [],
    dropQueryParamPatterns: Array.isArray(config.dropQueryParamPatterns)
      ? config.dropQueryParamPatterns.map((entry) => String(entry))
      : [],
    seenSet: {
      enabled: seenSet.enabled === true || Boolean(seenSetId),
      scope: String(seenSet.scope ?? 'workflow').trim().toLowerCase() === 'custom' ? 'custom' : 'workflow',
      id: seenSetId,
    },
  };
}

function isEligibleForFrontierWindow(request, options = {}, config = {}) {
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
  const nowMs = Number(options.nowMs ?? Date.now());

  if (blockedGroupUntil(options.blockedGroups, groupKey) > nowMs) {
    return false;
  }

  if (hostAwareScheduling && maxInProgressPerGroup > 0) {
    const activeGroups = options.activeGroups ?? options.activeHosts;
    if (activeGroupCount(activeGroups, groupKey) >= maxInProgressPerGroup) {
      return false;
    }
  }

  if (maxRequestsPerWindow > 0 && budgetWindowMs > 0) {
    const recentDispatches = options.recentGroupDispatches ?? {};
    if (recentDispatchCount(recentDispatches, groupKey, nowMs, budgetWindowMs) >= maxRequestsPerWindow) {
      return false;
    }
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

function cloneRequestRecord(record) {
  return structuredClone(record);
}

async function zrangeCompat(redis, key, start, stop) {
  if (typeof redis.zrange === 'function') {
    return redis.zrange(key, start, stop);
  }

  if (typeof redis.zRange === 'function') {
    return redis.zRange(key, start, stop);
  }

  throw new TypeError('redis client does not support zrange/zRange');
}

async function zremCompat(redis, key, ...members) {
  if (typeof redis.zrem === 'function') {
    return redis.zrem(key, ...members);
  }

  if (typeof redis.zRem === 'function') {
    return redis.zRem(key, ...members);
  }

  throw new TypeError('redis client does not support zrem/zRem');
}

async function sismemberCompat(redis, key, member) {
  if (typeof redis.sismember === 'function') {
    return redis.sismember(key, member);
  }

  if (typeof redis.sIsMember === 'function') {
    return redis.sIsMember(key, member);
  }

  if (typeof redis.smembers === 'function') {
    const members = await redis.smembers(key);
    return members.includes(member) ? 1 : 0;
  }

  throw new TypeError('redis client does not support sismember/sIsMember');
}

async function hgetCompat(redis, key, field) {
  if (typeof redis.hget === 'function') {
    return redis.hget(key, field);
  }

  const values = await redis.hgetall(key);
  return values?.[field] ?? null;
}

async function hdelCompat(redis, key, ...fields) {
  if (typeof redis.hdel === 'function') {
    return redis.hdel(key, ...fields);
  }

  let removed = 0;
  const values = await redis.hgetall(key);
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(values, field)) {
      delete values[field];
      removed += 1;
    }
  }
  if (typeof redis.hset === 'function') {
    await redis.hset(key, values);
  }
  return removed;
}

async function hincrbyCompat(redis, key, field, delta) {
  if (typeof redis.hincrby === 'function') {
    return redis.hincrby(key, field, delta);
  }

  const current = Number(await hgetCompat(redis, key, field) ?? 0);
  const next = current + Number(delta);
  await redis.hset(key, { [field]: next });
  return next;
}

async function zremrangebyscoreCompat(redis, key, min, max) {
  if (typeof redis.zremrangebyscore === 'function') {
    return redis.zremrangebyscore(key, min, max);
  }

  if (typeof redis.zRemRangeByScore === 'function') {
    return redis.zRemRangeByScore(key, min, max);
  }

  return 0;
}

async function evalCompat(redis, script, keys = [], args = []) {
  if (typeof redis.eval === 'function') {
    return redis.eval(script, keys.length, ...keys, ...args);
  }

  if (typeof redis.evaluateAtomicDequeue === 'function') {
    return redis.evaluateAtomicDequeue({ script, keys, args });
  }

  throw new TypeError('redis client does not support eval');
}

function pendingScore(priority, enqueuedAt) {
  const safePriority = normalizeRequestPriority(priority, 0);
  const timestamp = new Date(enqueuedAt).getTime();
  return timestamp - (safePriority * 100_000_000_000);
}

function normalizePendingLaneBucketKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized || '__default__';
}

const ATOMIC_BACKEND_DEQUEUE_LUA = `
local pendingKey = KEYS[1]
local pendingLanesKey = KEYS[2]
local inProgressKey = KEYS[3]
local activeGroupsKey = KEYS[4]
local activeLanesKey = KEYS[5]

local itemPrefix = ARGV[1]
local pendingLanePrefix = ARGV[2]
local nowIso = ARGV[3]
local nowMs = tonumber(ARGV[4]) or 0
local hostAwareScheduling = ARGV[5] == '1'
local maxInProgressPerGroup = tonumber(ARGV[6]) or 0
local budgetWindowMs = tonumber(ARGV[7]) or 0
local maxRequestsPerWindow = tonumber(ARGV[8]) or 0
local laneConfigs = cjson.decode(ARGV[9] or '{}')
local blockedGroups = cjson.decode(ARGV[10] or '{}')
local recentGroupsPrefix = ARGV[11]
local recentLanesPrefix = ARGV[12]
local laneHeadLimit = tonumber(ARGV[13]) or 8

local bestCandidate = ''
local bestPendingScore = nil
local bestLaneBucket = ''
local bestGroupKey = ''
local bestLaneKey = ''
local bestLaneConfig = nil

local laneBuckets = redis.call('SMEMBERS', pendingLanesKey)

for _, laneBucket in ipairs(laneBuckets) do
  local lanePendingKey = pendingLanePrefix .. laneBucket
  local laneCandidates = redis.call('ZRANGE', lanePendingKey, 0, laneHeadLimit - 1)
  local laneConfig = laneConfigs[laneBucket]

  if laneConfig then
    local laneMaxInProgress = tonumber(laneConfig.maxInProgress or '0') or 0
    if laneMaxInProgress > 0 then
      local activeLaneCount = tonumber(redis.call('HGET', activeLanesKey, laneBucket) or '0') or 0
      if activeLaneCount >= laneMaxInProgress then
        goto continue_lane
      end
    end

    local laneBudgetWindowMs = tonumber(laneConfig.budgetWindowMs or '0') or 0
    local laneMaxRequestsPerWindow = tonumber(laneConfig.maxRequestsPerWindow or '0') or 0
    if laneBudgetWindowMs > 0 and laneMaxRequestsPerWindow > 0 then
      local recentLaneKey = recentLanesPrefix .. laneBucket
      redis.call('ZREMRANGEBYSCORE', recentLaneKey, '-inf', nowMs - laneBudgetWindowMs)
      local recentLaneCount = tonumber(redis.call('ZCARD', recentLaneKey) or '0') or 0
      if recentLaneCount >= laneMaxRequestsPerWindow then
        goto continue_lane
      end
    end
  end

  for _, candidateKey in ipairs(laneCandidates) do
    local raw = redis.call('HGETALL', itemPrefix .. candidateKey)
    if #raw > 0 then
      local item = {}
      for index = 1, #raw, 2 do
        item[raw[index]] = raw[index + 1]
      end

      if item.status ~= 'pending' then
        redis.call('ZREM', pendingKey, candidateKey)
        redis.call('ZREM', lanePendingKey, candidateKey)
      else
        local groupKey = item.groupKey or ''
        local blockedUntil = tonumber(blockedGroups[groupKey] or '0') or 0
        local eligible = blockedUntil <= nowMs

        if eligible and hostAwareScheduling and maxInProgressPerGroup > 0 and groupKey ~= '' then
          local activeGroupCount = tonumber(redis.call('HGET', activeGroupsKey, groupKey) or '0') or 0
          if activeGroupCount >= maxInProgressPerGroup then
            eligible = false
          end
        end

        if eligible and maxRequestsPerWindow > 0 and budgetWindowMs > 0 and groupKey ~= '' then
          local recentGroupKey = recentGroupsPrefix .. groupKey
          redis.call('ZREMRANGEBYSCORE', recentGroupKey, '-inf', nowMs - budgetWindowMs)
          local recentGroupCount = tonumber(redis.call('ZCARD', recentGroupKey) or '0') or 0
          if recentGroupCount >= maxRequestsPerWindow then
            eligible = false
          end
        end

        if eligible then
          local itemPendingScore = tonumber(item.pendingScore or '0') or 0
          if bestPendingScore == nil or itemPendingScore < bestPendingScore then
            bestCandidate = candidateKey
            bestPendingScore = itemPendingScore
            bestLaneBucket = laneBucket
            bestGroupKey = groupKey
            bestLaneKey = item.laneKey or ''
            bestLaneConfig = laneConfig
          end
          break
        end
      end
    else
      redis.call('ZREM', pendingKey, candidateKey)
      redis.call('ZREM', lanePendingKey, candidateKey)
    end
  end

  if tonumber(redis.call('ZCARD', lanePendingKey) or '0') == 0 then
    redis.call('SREM', pendingLanesKey, laneBucket)
  end

  ::continue_lane::
end

if bestCandidate == '' then
  return ''
end

redis.call('ZREM', pendingKey, bestCandidate)
redis.call('ZREM', pendingLanePrefix .. bestLaneBucket, bestCandidate)
if tonumber(redis.call('ZCARD', pendingLanePrefix .. bestLaneBucket) or '0') == 0 then
  redis.call('SREM', pendingLanesKey, bestLaneBucket)
end
redis.call('HSET', itemPrefix .. bestCandidate,
  'status', 'inProgress',
  'updatedAt', nowIso,
  'dispatchedAt', nowIso,
  'dispatchedAtMs', tostring(nowMs)
)
redis.call('SADD', inProgressKey, bestCandidate)

if bestGroupKey ~= '' then
  redis.call('HINCRBY', activeGroupsKey, bestGroupKey, 1)
  if maxRequestsPerWindow > 0 and budgetWindowMs > 0 then
    redis.call('ZADD', recentGroupsPrefix .. bestGroupKey, nowMs, tostring(nowMs) .. ':' .. bestCandidate)
  end
end

if bestLaneKey ~= '' and bestLaneConfig then
  local laneMaxInProgress = tonumber(bestLaneConfig.maxInProgress or '0') or 0
  if laneMaxInProgress > 0 then
    redis.call('HINCRBY', activeLanesKey, bestLaneKey, 1)
  end

  local laneBudgetWindowMs = tonumber(bestLaneConfig.budgetWindowMs or '0') or 0
  local laneMaxRequestsPerWindow = tonumber(bestLaneConfig.maxRequestsPerWindow or '0') or 0
  if laneBudgetWindowMs > 0 and laneMaxRequestsPerWindow > 0 then
    redis.call('ZADD', recentLanesPrefix .. bestLaneKey, nowMs, tostring(nowMs) .. ':' .. bestCandidate)
  end
end

return bestCandidate
`;

export class RedisRequestQueue {
  constructor({ redis: redisOptions, jobId, config = {} } = {}) {
    this.redis = redisOptions?.client ?? getRedisClient(redisOptions);
    this.ownsClient = !redisOptions?.client;
    this.jobId = jobId;
    this.config = queueConfig(config);
    this.initPromise = null;
    this.reclaimedCount = 0;
    this.summaryCache = {
      totalCount: 0,
      pendingCount: 0,
      inProgressCount: 0,
      handledCount: 0,
      failedCount: 0,
      reclaimedCount: 0,
      updatedAt: null,
      seenSet: {
        enabled: this.config.seenSet.enabled,
        id: this.config.seenSet.id,
        scope: this.config.seenSet.scope,
        seenCount: 0,
        hitCount: 0,
        writeCount: 0,
        updatedAt: null,
      },
    };
    this.seenHitCount = 0;
    this.seenWriteCount = 0;
  }

  #k(sub) {
    return `job:${this.jobId}:request_queue:${sub}`;
  }

  #item(uniqueKey) {
    return this.#k(`item:${uniqueKey}`);
  }

  #seen() {
    return this.config.seenSet.id ? `frontier:seen:${this.config.seenSet.id}` : null;
  }

  #activeGroupsKey() {
    return this.#k('frontier:active_groups');
  }

  #activeLanesKey() {
    return this.#k('frontier:active_lanes');
  }

  #recentGroupsPrefix() {
    return `${this.#k('frontier:recent_groups:')}`;
  }

  #recentLanesPrefix() {
    return `${this.#k('frontier:recent_lanes:')}`;
  }

  #pendingLanesKey() {
    return this.#k('pending:lanes');
  }

  #pendingLanePrefix() {
    return `${this.#k('pending:lane:')}`;
  }

  #pendingLaneKey(bucketKey) {
    return `${this.#pendingLanePrefix()}${normalizePendingLaneBucketKey(bucketKey)}`;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (this.ownsClient && typeof this.redis.connect === 'function') {
          await this.redis.connect().catch((error) => {
            if (String(error?.message ?? '').includes('already connecting')) {
              return;
            }
            throw error;
          });
        }

        if (this.config.reclaimInProgress) {
          this.reclaimedCount = await this.reclaimInProgress();
        }

        await this.refreshSummary();
      })();
    }

    await this.initPromise;
    return this;
  }

  async reclaimInProgress() {
    const uniqueKeys = await this.redis.smembers(this.#k('inProgress'));
    let reclaimed = 0;

    for (const uniqueKey of uniqueKeys) {
      const data = await this.redis.hgetall(this.#item(uniqueKey));
      if (!data?.uniqueKey) {
        await this.redis.srem(this.#k('inProgress'), uniqueKey);
        continue;
      }

      const updatedAt = nowIso();
      await this.redis.hset(this.#item(uniqueKey), {
        status: 'pending',
        updatedAt,
        dispatchedAt: '',
        dispatchedAtMs: '',
      });
      await this.#releaseDispatchState(this.#hydrate(data));
      const request = this.#hydrate(await this.redis.hgetall(this.#item(uniqueKey)));
      await this.redis.zadd(this.#k('pending'), Number(data.pendingScore ?? pendingScore(data.priority, data.enqueuedAt)), uniqueKey);
      await this.#addPendingLaneEntry(request);
      await this.redis.srem(this.#k('inProgress'), uniqueKey);
      reclaimed += 1;
    }

    return reclaimed;
  }

  async refreshSummary() {
    const [total, pending, inProgress, handled, failed, seenCount] = await Promise.all([
      this.redis.scard(this.#k('all')),
      this.redis.zcard(this.#k('pending')),
      this.redis.scard(this.#k('inProgress')),
      this.redis.scard(this.#k('handled')),
      this.redis.scard(this.#k('failed')),
      this.config.seenSet.enabled && this.#seen() ? this.redis.scard(this.#seen()) : Promise.resolve(0),
    ]);

    this.summaryCache = {
      totalCount: Number(total ?? 0),
      pendingCount: Number(pending ?? 0),
      inProgressCount: Number(inProgress ?? 0),
      handledCount: Number(handled ?? 0),
      failedCount: Number(failed ?? 0),
      reclaimedCount: this.reclaimedCount,
      updatedAt: nowIso(),
      seenSet: {
        enabled: this.config.seenSet.enabled,
        id: this.config.seenSet.id,
        scope: this.config.seenSet.scope,
        seenCount: Number(seenCount ?? 0),
        hitCount: this.seenHitCount,
        writeCount: this.seenWriteCount,
        updatedAt: this.config.seenSet.enabled ? nowIso() : null,
      },
    };

    return this.summary();
  }

  summary() {
    return {
      ...this.summaryCache,
    };
  }

  seenSetSummary() {
    return {
      ...this.summaryCache.seenSet,
    };
  }

  hasPending() {
    return this.summaryCache.pendingCount > 0;
  }

  buildRecord(item) {
    const enqueuedAt = nowIso();
    const priority = normalizeRequestPriority(item.priority, 0);
    const uniqueKey = item.uniqueKey ?? buildRequestUniqueKey(item, this.config);

    return {
      uniqueKey,
      url: item.url,
      groupKey: getRequestGroupKey(item, this.config.groupBy),
      hostKey: getRequestHostKey(item),
      laneKey: item.laneKey ?? getRequestLaneKey(item) ?? '',
      pendingLaneBucket: normalizePendingLaneBucketKey(item.laneKey ?? getRequestLaneKey(item)),
      method: String(item.method ?? 'GET').toUpperCase(),
      body: item.body ?? '',
      depth: Number(item.depth ?? 0),
      parentUrl: item.parentUrl ?? '',
      label: item.label ?? '',
      userData: JSON.stringify(item.userData ?? {}),
      metadata: JSON.stringify(item.metadata ?? {}),
      replayState: JSON.stringify(item.replayState ?? null),
      priority,
      pendingScore: pendingScore(priority, enqueuedAt),
      status: 'pending',
      enqueueCount: 1,
      enqueuedAt,
      updatedAt: enqueuedAt,
      dispatchedAt: '',
      dispatchedAtMs: '',
      handledAt: '',
      failedAt: '',
      lastError: '',
      finalUrl: '',
      responseStatus: '',
    };
  }

  async enqueue(item) {
    await this.init();
    const uniqueKey = item.uniqueKey ?? buildRequestUniqueKey(item, this.config);
    const currentJobSeen = await sismemberCompat(this.redis, this.#k('all'), uniqueKey);

    if (Number(currentJobSeen) > 0) {
      const existing = this.#hydrate(await this.redis.hgetall(this.#item(uniqueKey)));
      return {
        added: false,
        reason: 'duplicate-request',
        request: existing ? cloneRequestRecord(existing) : null,
      };
    }

    if (this.config.seenSet.enabled && this.#seen()) {
      const seenBefore = await sismemberCompat(this.redis, this.#seen(), uniqueKey);
      if (Number(seenBefore) > 0) {
        this.seenHitCount += 1;
        return {
          added: false,
          reason: 'already-seen',
          request: null,
        };
      }
    }

    await this.redis.sadd(this.#k('all'), uniqueKey);

    const record = this.buildRecord({
      ...item,
      uniqueKey,
    });

    await this.redis.hset(this.#item(uniqueKey), record);
    await this.redis.zadd(this.#k('pending'), record.pendingScore, uniqueKey);
    await this.#addPendingLaneEntry(this.#hydrate(record));
    await this.refreshSummary();

    return {
      added: true,
      reason: 'enqueued',
      request: cloneRequestRecord(this.#hydrate(record)),
    };
  }

  async dequeue(options = {}) {
    await this.init();
    if (options.useBackendFrontierState === true) {
      const atomicRequest = await this.#dequeueAtomically(options).catch(() => null);
      if (atomicRequest) {
        await this.refreshSummary();
        return atomicRequest;
      }
    }

    const resolvedOptions = options.useBackendFrontierState === true
      ? {
          ...options,
          ...(await this.#collectBackendFrontierState(options)),
        }
      : options;
    const pendingKeys = await zrangeCompat(this.redis, this.#k('pending'), 0, -1);
    let uniqueKey = null;

    for (const candidateKey of pendingKeys) {
      const request = this.#hydrate(await this.redis.hgetall(this.#item(candidateKey)));
      if (!request || request.status !== 'pending') {
        if (request) {
          await this.#removePendingLaneEntry(request);
        }
        continue;
      }
      if (!isEligibleForFrontierWindow(request, resolvedOptions, this.config)) {
        continue;
      }
      uniqueKey = candidateKey;
      break;
    }

    if (!uniqueKey) {
      await this.refreshSummary();
      return null;
    }

    await zremCompat(this.redis, this.#k('pending'), uniqueKey);
    await this.#removePendingLaneEntry(this.#hydrate(await this.redis.hgetall(this.#item(uniqueKey))));
    const updatedAt = nowIso();
    await this.redis.hset(this.#item(uniqueKey), {
      status: 'inProgress',
      updatedAt,
      dispatchedAt: updatedAt,
      dispatchedAtMs: String(Date.now()),
    });
    await this.redis.sadd(this.#k('inProgress'), uniqueKey);
    const data = await this.redis.hgetall(this.#item(uniqueKey));
    await this.#recordDispatchState(this.#hydrate(data));
    await this.refreshSummary();
    return this.#hydrate(data);
  }

  async markHandled(uniqueKey, patch = {}) {
    await this.init();
    const existing = this.#hydrate(await this.redis.hgetall(this.#item(uniqueKey)));
    const handledAt = nowIso();
    await this.redis.hset(this.#item(uniqueKey), {
      status: 'handled',
      handledAt,
      updatedAt: handledAt,
      lastError: '',
      finalUrl: patch.finalUrl ?? '',
      responseStatus: patch.responseStatus ?? '',
    });
    await this.#releaseDispatchState(existing);
    await this.redis.srem(this.#k('inProgress'), uniqueKey);
    await this.redis.srem(this.#k('failed'), uniqueKey);
    await this.redis.sadd(this.#k('handled'), uniqueKey);
    if (this.config.seenSet.enabled && this.#seen()) {
      const added = await this.redis.sadd(this.#seen(), uniqueKey);
      if (Number(added) > 0) {
        this.seenWriteCount += 1;
      }
    }
    await this.refreshSummary();

    const data = await this.redis.hgetall(this.#item(uniqueKey));
    return this.#hydrate(data);
  }

  async markFailed(uniqueKey, { error, patch = {} } = {}) {
    await this.init();
    const existing = this.#hydrate(await this.redis.hgetall(this.#item(uniqueKey)));
    const failedAt = nowIso();
    await this.redis.hset(this.#item(uniqueKey), {
      status: 'failed',
      failedAt,
      updatedAt: failedAt,
      lastError: error ?? '',
      finalUrl: patch.finalUrl ?? '',
      responseStatus: patch.responseStatus ?? '',
    });
    await this.#releaseDispatchState(existing);
    await this.redis.srem(this.#k('inProgress'), uniqueKey);
    await this.redis.srem(this.#k('handled'), uniqueKey);
    await this.redis.sadd(this.#k('failed'), uniqueKey);
    await this.refreshSummary();

    const data = await this.redis.hgetall(this.#item(uniqueKey));
    return this.#hydrate(data);
  }

  async close() {
    if (this.ownsClient && typeof this.redis.quit === 'function') {
      await this.redis.quit().catch(() => {});
    }
  }

  #hydrate(data) {
    if (!data || !data.uniqueKey) {
      return null;
    }

    return {
      uniqueKey: data.uniqueKey,
      url: data.url,
      groupKey: data.groupKey || getRequestGroupKey(data.url, this.config.groupBy),
      hostKey: data.hostKey || getRequestHostKey(data.url),
      laneKey: data.laneKey || getRequestLaneKey({
        url: data.url,
        userData: data.userData ? JSON.parse(data.userData) : {},
        metadata: data.metadata ? JSON.parse(data.metadata) : {},
      }),
      pendingLaneBucket: data.pendingLaneBucket || normalizePendingLaneBucketKey(
        data.laneKey || getRequestLaneKey({
          url: data.url,
          userData: data.userData ? JSON.parse(data.userData) : {},
          metadata: data.metadata ? JSON.parse(data.metadata) : {},
        }),
      ),
      method: data.method,
      body: data.body || undefined,
      depth: Number(data.depth ?? 0),
      parentUrl: data.parentUrl || null,
      label: data.label || null,
      userData: data.userData ? JSON.parse(data.userData) : {},
      metadata: data.metadata ? JSON.parse(data.metadata) : {},
      replayState: data.replayState ? JSON.parse(data.replayState) : null,
      priority: normalizeRequestPriority(data.priority, 0),
      status: data.status,
      enqueueCount: Number(data.enqueueCount ?? 1),
      enqueuedAt: data.enqueuedAt,
      updatedAt: data.updatedAt,
      dispatchedAt: data.dispatchedAt || null,
      dispatchedAtMs: data.dispatchedAtMs ? Number(data.dispatchedAtMs) : null,
      handledAt: data.handledAt || null,
      failedAt: data.failedAt || null,
      lastError: data.lastError || null,
      finalUrl: data.finalUrl || null,
      responseStatus: data.responseStatus ? Number(data.responseStatus) : null,
    };
  }

  async #recordDispatchState(request) {
    if (!request || request.status !== 'inProgress') {
      return;
    }

    const dispatchedAtMs = Number(request.dispatchedAtMs ?? Date.now());
    if (request.groupKey) {
      await hincrbyCompat(this.redis, this.#activeGroupsKey(), request.groupKey, 1);
      if (this.config.maxRequestsPerWindow > 0 && this.config.budgetWindowMs > 0) {
        const recentGroupKey = `${this.#recentGroupsPrefix()}${request.groupKey}`;
        await zremrangebyscoreCompat(this.redis, recentGroupKey, '-inf', dispatchedAtMs - this.config.budgetWindowMs);
        await this.redis.zadd(recentGroupKey, dispatchedAtMs, `${dispatchedAtMs}:${request.uniqueKey}`);
      }
    }

    const laneConfig = request.laneKey ? this.config.laneConfigs?.[request.laneKey] ?? null : null;
    if (request.laneKey && laneConfig) {
      if (laneConfig.maxInProgress > 0) {
        await hincrbyCompat(this.redis, this.#activeLanesKey(), request.laneKey, 1);
      }
      if (laneConfig.maxRequestsPerWindow > 0 && laneConfig.budgetWindowMs > 0) {
        const recentLaneKey = `${this.#recentLanesPrefix()}${request.laneKey}`;
        await zremrangebyscoreCompat(this.redis, recentLaneKey, '-inf', dispatchedAtMs - laneConfig.budgetWindowMs);
        await this.redis.zadd(recentLaneKey, dispatchedAtMs, `${dispatchedAtMs}:${request.uniqueKey}`);
      }
    }
  }

  async #releaseDispatchState(request) {
    if (!request || request.status !== 'inProgress') {
      return;
    }

    if (request.groupKey) {
      const nextGroupCount = await hincrbyCompat(this.redis, this.#activeGroupsKey(), request.groupKey, -1);
      if (Number(nextGroupCount) <= 0) {
        await hdelCompat(this.redis, this.#activeGroupsKey(), request.groupKey);
      }
    }

    const laneConfig = request.laneKey ? this.config.laneConfigs?.[request.laneKey] ?? null : null;
    if (request.laneKey && laneConfig?.maxInProgress > 0) {
      const nextLaneCount = await hincrbyCompat(this.redis, this.#activeLanesKey(), request.laneKey, -1);
      if (Number(nextLaneCount) <= 0) {
        await hdelCompat(this.redis, this.#activeLanesKey(), request.laneKey);
      }
    }
  }

  async #addPendingLaneEntry(request) {
    if (!request?.uniqueKey) {
      return;
    }

    const bucketKey = normalizePendingLaneBucketKey(request.pendingLaneBucket ?? request.laneKey);
    await this.redis.sadd(this.#pendingLanesKey(), bucketKey);
    await this.redis.zadd(
      this.#pendingLaneKey(bucketKey),
      Number(request.pendingScore ?? pendingScore(request.priority, request.enqueuedAt)),
      request.uniqueKey,
    );
  }

  async #removePendingLaneEntry(request) {
    if (!request?.uniqueKey) {
      return;
    }

    const bucketKey = normalizePendingLaneBucketKey(request.pendingLaneBucket ?? request.laneKey);
    const lanePendingKey = this.#pendingLaneKey(bucketKey);
    await zremCompat(this.redis, lanePendingKey, request.uniqueKey);
    const remaining = Number(await this.redis.zcard(lanePendingKey) ?? 0);
    if (remaining <= 0) {
      await this.redis.srem(this.#pendingLanesKey(), bucketKey);
    }
  }

  async #dequeueAtomically(options = {}) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const blockedGroups = Object.fromEntries(
      Object.entries(options.blockedGroups ?? {}).map(([key, value]) => [key, Number(value)]),
    );
    const pendingCount = Number(await this.redis.zcard(this.#k('pending')) ?? 0);
    if (pendingCount <= 0) {
      return null;
    }
    const claimedUniqueKey = await evalCompat(this.redis, ATOMIC_BACKEND_DEQUEUE_LUA, [
      this.#k('pending'),
      this.#pendingLanesKey(),
      this.#k('inProgress'),
      this.#activeGroupsKey(),
      this.#activeLanesKey(),
    ], [
      this.#item(''),
      this.#pendingLanePrefix(),
      now,
      String(nowMs),
      (options.hostAwareScheduling ?? this.config.hostAwareScheduling ?? false) ? '1' : '0',
      String(options.maxInProgressPerGroup ?? this.config.maxInProgressPerGroup ?? 0),
      String(options.budgetWindowMs ?? this.config.budgetWindowMs ?? 0),
      String(options.maxRequestsPerWindow ?? this.config.maxRequestsPerWindow ?? 0),
      JSON.stringify(options.laneConfigs ?? this.config.laneConfigs ?? {}),
      JSON.stringify(blockedGroups),
      this.#recentGroupsPrefix(),
      this.#recentLanesPrefix(),
      String(options.atomicLaneHeadLimit ?? this.config.atomicLaneHeadLimit ?? 8),
    ]);

    if (!claimedUniqueKey) {
      return null;
    }

    const data = await this.redis.hgetall(this.#item(claimedUniqueKey));
    return this.#hydrate(data);
  }

  async #collectBackendFrontierState(options = {}) {
    const activeGroups = new Map();
    const activeLanes = new Map();
    const recentGroupDispatches = new Map();
    const recentLaneDispatches = new Map();
    const groupBudgetWindowMs = Math.max(0, Number(options.budgetWindowMs ?? this.config.budgetWindowMs ?? 0));
    const laneConfigs = options.laneConfigs ?? this.config.laneConfigs ?? {};
    const nowMs = Date.now();
    const uniqueKeys = await this.redis.smembers(this.#k('all'));

    for (const uniqueKey of uniqueKeys) {
      const request = this.#hydrate(await this.redis.hgetall(this.#item(uniqueKey)));
      if (!request) {
        continue;
      }

      if (request.status === 'inProgress' && request.groupKey) {
        activeGroups.set(request.groupKey, Number(activeGroups.get(request.groupKey) ?? 0) + 1);
      }
      if (request.status === 'inProgress' && request.laneKey) {
        activeLanes.set(request.laneKey, Number(activeLanes.get(request.laneKey) ?? 0) + 1);
      }

      const dispatchedAtMs = request.dispatchedAt ? Date.parse(request.dispatchedAt) : Number.NaN;
      if (Number.isNaN(dispatchedAtMs)) {
        continue;
      }

      if (request.groupKey && groupBudgetWindowMs > 0 && dispatchedAtMs >= nowMs - groupBudgetWindowMs) {
        const entries = recentGroupDispatches.get(request.groupKey) ?? [];
        entries.push(dispatchedAtMs);
        recentGroupDispatches.set(request.groupKey, entries);
      }

      const laneBudgetWindowMs = Math.max(0, Number(laneConfigs?.[request.laneKey]?.budgetWindowMs ?? 0));
      if (request.laneKey && laneBudgetWindowMs > 0 && dispatchedAtMs >= nowMs - laneBudgetWindowMs) {
        const entries = recentLaneDispatches.get(request.laneKey) ?? [];
        entries.push(dispatchedAtMs);
        recentLaneDispatches.set(request.laneKey, entries);
      }
    }

    return {
      activeGroups,
      activeLanes,
      recentGroupDispatches,
      recentLaneDispatches,
    };
  }
}
