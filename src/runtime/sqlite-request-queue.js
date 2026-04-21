import { openControlPlaneDatabase, nowIso, encodeJson, decodeJson } from './sqlite-control-plane.js';
import {
  buildRequestUniqueKey,
  normalizeRequestPriority,
  getRequestHostKey,
  getRequestGroupKey,
  getRequestLaneKey,
  normalizeRequestGroupBy,
} from './request-queue.js';

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
    laneConfigs,
    seenSet: {
      enabled: seenSet.enabled === true || Boolean(seenSetId),
      scope: String(seenSet.scope ?? 'workflow').trim().toLowerCase() === 'custom' ? 'custom' : 'workflow',
      id: seenSetId,
    },
  };
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

function hydrateRequest(row, config = {}) {
  if (!row) {
    return null;
  }

  return {
    uniqueKey: row.unique_key,
    url: row.url,
    groupKey: getRequestGroupKey(row.url, config.groupBy ?? 'hostname'),
    hostKey: getRequestHostKey(row.url),
    laneKey: row.lane_key ?? getRequestLaneKey({
      url: row.url,
      userData: decodeJson(row.user_data_json, {}),
      metadata: decodeJson(row.metadata_json, {}),
    }),
    method: row.method,
    body: row.body ?? undefined,
    depth: Number(row.depth ?? 0),
    parentUrl: row.parent_url ?? null,
    label: row.label ?? null,
    userData: decodeJson(row.user_data_json, {}),
    metadata: decodeJson(row.metadata_json, {}),
    replayState: decodeJson(row.replay_state_json, null),
    priority: normalizeRequestPriority(row.priority, 0),
    status: row.status,
    enqueueCount: Number(row.enqueue_count ?? 1),
    enqueuedAt: row.enqueued_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at ?? null,
    handledAt: row.handled_at ?? null,
    failedAt: row.failed_at ?? null,
    lastError: row.last_error ?? null,
    finalUrl: row.final_url ?? null,
    responseStatus: row.response_status ?? null,
  };
}

export class SqliteRequestQueue {
  constructor({ dbPath, jobId, config = {} } = {}) {
    this.dbPath = dbPath;
    this.jobId = jobId;
    this.config = queueConfig(config);
    this.db = null;
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

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.db = await openControlPlaneDatabase(this.dbPath);
        if (this.config.reclaimInProgress) {
        this.reclaimedCount = this.db.prepare(`
            UPDATE request_queue_items
            SET status = 'pending',
                updated_at = @updatedAt,
                dispatched_at = NULL
            WHERE job_id = @jobId
              AND status = 'inProgress'
          `).run({
            jobId: this.jobId,
            updatedAt: nowIso(),
          }).changes;
        }

        this.refreshSummary();
      })();
    }

    await this.initPromise;
    return this;
  }

  requireDb() {
    if (!this.db) {
      throw new Error('SqliteRequestQueue.init() must complete before use');
    }

    return this.db;
  }

  close() {
    this.db?.close();
    this.db = null;
    this.initPromise = null;
  }

  refreshSummary() {
    const db = this.requireDb();
    const rows = db.prepare(`
      SELECT status, COUNT(*) AS count, MAX(updated_at) AS updated_at
      FROM request_queue_items
      WHERE job_id = ?
      GROUP BY status
    `).all(this.jobId);

    const summary = {
      totalCount: 0,
      pendingCount: 0,
      inProgressCount: 0,
      handledCount: 0,
      failedCount: 0,
      reclaimedCount: this.reclaimedCount,
      updatedAt: null,
      seenSet: this.seenSetSummary(),
    };

    for (const row of rows) {
      const count = Number(row.count ?? 0);
      summary.totalCount += count;
      summary.updatedAt = summary.updatedAt && summary.updatedAt > row.updated_at ? summary.updatedAt : row.updated_at;

      if (row.status === 'pending') {
        summary.pendingCount = count;
      } else if (row.status === 'inProgress') {
        summary.inProgressCount = count;
      } else if (row.status === 'handled') {
        summary.handledCount = count;
      } else if (row.status === 'failed') {
        summary.failedCount = count;
      }
    }

    this.summaryCache = summary;
    return summary;
  }

  summary() {
    return {
      ...this.summaryCache,
    };
  }

  seenSetSummary() {
    if (!this.config.seenSet.enabled || !this.config.seenSet.id) {
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

    const db = this.requireDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS count, MAX(last_seen_at) AS updated_at
      FROM request_seen_items
      WHERE scope_id = ?
    `).get(this.config.seenSet.id);

    return {
      enabled: true,
      id: this.config.seenSet.id,
      scope: this.config.seenSet.scope,
      seenCount: Number(row?.count ?? 0),
      hitCount: this.seenHitCount,
      writeCount: this.seenWriteCount,
      updatedAt: row?.updated_at ?? null,
    };
  }

  hasPending() {
    return this.summaryCache.pendingCount > 0;
  }

  buildRecord(item) {
    const now = nowIso();
    const uniqueKey = item.uniqueKey ?? buildRequestUniqueKey(item, this.config);

    return {
      uniqueKey,
      url: item.url,
      groupKey: getRequestGroupKey(item, this.config.groupBy),
      laneKey: item.laneKey ?? getRequestLaneKey(item),
      method: String(item.method ?? 'GET').toUpperCase(),
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
      dispatchedAt: null,
      handledAt: null,
      failedAt: null,
      lastError: null,
      finalUrl: null,
      responseStatus: null,
    };
  }

  async enqueue(item) {
    await this.init();
    const db = this.requireDb();
    const uniqueKey = item.uniqueKey ?? buildRequestUniqueKey(item, this.config);
    const existingRow = db.prepare(`
      SELECT *
      FROM request_queue_items
      WHERE job_id = ? AND unique_key = ?
    `).get(this.jobId, uniqueKey);

    if (existingRow) {
      return {
        added: false,
        reason: 'duplicate-request',
        request: cloneRequestRecord(hydrateRequest(existingRow, this.config)),
      };
    }

    if (this.config.seenSet.enabled && this.config.seenSet.id) {
      const seenRow = db.prepare(`
        SELECT unique_key
        FROM request_seen_items
        WHERE scope_id = ? AND unique_key = ?
      `).get(this.config.seenSet.id, uniqueKey);

      if (seenRow) {
        this.seenHitCount += 1;
        return {
          added: false,
          reason: 'already-seen',
          request: null,
        };
      }
    }

    const record = this.buildRecord({
      ...item,
      uniqueKey,
    });

    db.prepare(`
      INSERT INTO request_queue_items (
        job_id,
        unique_key,
        url,
        method,
        body,
        depth,
        parent_url,
        label,
        user_data_json,
        metadata_json,
        lane_key,
        replay_state_json,
        priority,
        status,
        enqueue_count,
        enqueued_at,
        updated_at,
        dispatched_at,
        handled_at,
        failed_at,
        last_error,
        final_url,
        response_status
      ) VALUES (
        @jobId,
        @uniqueKey,
        @url,
        @method,
        @body,
        @depth,
        @parentUrl,
        @label,
        @userDataJson,
        @metadataJson,
        @laneKey,
        @replayStateJson,
        @priority,
        @status,
        @enqueueCount,
        @enqueuedAt,
        @updatedAt,
        @dispatchedAt,
        @handledAt,
        @failedAt,
        @lastError,
        @finalUrl,
        @responseStatus
      )
    `).run({
      jobId: this.jobId,
      uniqueKey: record.uniqueKey,
      url: record.url,
      method: record.method,
      body: record.body ?? null,
      depth: record.depth,
      parentUrl: record.parentUrl,
      label: record.label,
      userDataJson: encodeJson(record.userData, {}),
      metadataJson: encodeJson(record.metadata, {}),
      laneKey: record.laneKey ?? null,
      replayStateJson: encodeJson(record.replayState, null),
      priority: record.priority,
      status: record.status,
      enqueueCount: record.enqueueCount,
      enqueuedAt: record.enqueuedAt,
      updatedAt: record.updatedAt,
      dispatchedAt: record.dispatchedAt,
      handledAt: record.handledAt,
      failedAt: record.failedAt,
      lastError: record.lastError,
      finalUrl: record.finalUrl,
      responseStatus: record.responseStatus,
    });

    this.refreshSummary();

    return {
      added: true,
      reason: 'enqueued',
      request: cloneRequestRecord(record),
    };
  }

  async dequeue(options = {}) {
    await this.init();
    const db = this.requireDb();
    const resolvedOptions = options.useBackendFrontierState === true
      ? {
          ...options,
          ...this.collectBackendFrontierState(options),
        }
      : options;

    try {
      db.exec('BEGIN IMMEDIATE');
      const candidates = db.prepare(`
        SELECT *
        FROM request_queue_items
        WHERE job_id = @jobId
          AND status = 'pending'
        ORDER BY priority DESC, enqueued_at ASC, unique_key ASC
      `).all({
        jobId: this.jobId,
      });

      const candidate = candidates
        .map((row) => hydrateRequest(row, this.config))
        .find((request) => isEligibleForHostWindow(request, resolvedOptions, this.config));

      if (!candidate) {
        db.exec('COMMIT');
        this.refreshSummary();
        return null;
      }

      const updatedAt = nowIso();
      db.prepare(`
        UPDATE request_queue_items
        SET status = 'inProgress',
            updated_at = @updatedAt,
            dispatched_at = @updatedAt
        WHERE job_id = @jobId
          AND unique_key = @uniqueKey
          AND status = 'pending'
      `).run({
        jobId: this.jobId,
        uniqueKey: candidate.uniqueKey,
        updatedAt,
      });

      db.exec('COMMIT');
      this.refreshSummary();
      return {
        ...candidate,
        status: 'inProgress',
        updated_at: updatedAt,
        updatedAt,
        dispatchedAt: updatedAt,
      };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // noop
      }
      throw error;
    }
  }

  collectBackendFrontierState(options = {}) {
    const db = this.requireDb();
    const activeGroups = new Map();
    const activeLanes = new Map();
    const recentGroupDispatches = new Map();
    const recentLaneDispatches = new Map();
    const groupBudgetWindowMs = Math.max(0, Number(options.budgetWindowMs ?? this.config.budgetWindowMs ?? 0));
    const laneConfigs = options.laneConfigs ?? this.config.laneConfigs ?? {};
    const nowMs = Date.now();

    const rows = db.prepare(`
      SELECT *
      FROM request_queue_items
      WHERE job_id = ?
        AND (status = 'inProgress' OR dispatched_at IS NOT NULL)
    `).all(this.jobId);

    for (const row of rows) {
      const request = hydrateRequest(row, this.config);
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

  async markHandled(uniqueKey, patch = {}) {
    await this.init();
    const db = this.requireDb();
    const handledAt = nowIso();
    db.prepare(`
      UPDATE request_queue_items
      SET status = 'handled',
          handled_at = @handledAt,
          updated_at = @handledAt,
          last_error = NULL,
          final_url = @finalUrl,
          response_status = @responseStatus
      WHERE job_id = @jobId
        AND unique_key = @uniqueKey
    `).run({
      jobId: this.jobId,
      uniqueKey,
      handledAt,
      finalUrl: patch.finalUrl ?? null,
      responseStatus: patch.responseStatus ?? null,
    });

    if (this.config.seenSet.enabled && this.config.seenSet.id) {
      const writeResult = db.prepare(`
        INSERT INTO request_seen_items (
          scope_id,
          unique_key,
          url,
          first_seen_at,
          last_seen_at,
          last_job_id
        ) VALUES (
          @scopeId,
          @uniqueKey,
          @url,
          @handledAt,
          @handledAt,
          @jobId
        )
        ON CONFLICT(scope_id, unique_key) DO UPDATE SET
          url = excluded.url,
          last_seen_at = excluded.last_seen_at,
          last_job_id = excluded.last_job_id
      `).run({
        scopeId: this.config.seenSet.id,
        uniqueKey,
        url: patch.finalUrl ?? null,
        handledAt,
        jobId: this.jobId,
      });
      if (Number(writeResult.changes ?? 0) > 0) {
        this.seenWriteCount += 1;
      }
    }

    const row = db.prepare(`
      SELECT *
      FROM request_queue_items
      WHERE job_id = ? AND unique_key = ?
    `).get(this.jobId, uniqueKey);
    this.refreshSummary();
    return row ? cloneRequestRecord(hydrateRequest(row, this.config)) : null;
  }

  async markFailed(uniqueKey, { error, patch = {} } = {}) {
    await this.init();
    const db = this.requireDb();
    const failedAt = nowIso();
    db.prepare(`
      UPDATE request_queue_items
      SET status = 'failed',
          failed_at = @failedAt,
          updated_at = @failedAt,
          last_error = @lastError,
          final_url = @finalUrl,
          response_status = @responseStatus
      WHERE job_id = @jobId
        AND unique_key = @uniqueKey
    `).run({
      jobId: this.jobId,
      uniqueKey,
      failedAt,
      lastError: error ?? null,
      finalUrl: patch.finalUrl ?? null,
      responseStatus: patch.responseStatus ?? null,
    });

    const row = db.prepare(`
      SELECT *
      FROM request_queue_items
      WHERE job_id = ? AND unique_key = ?
    `).get(this.jobId, uniqueKey);
    this.refreshSummary();
    return row ? cloneRequestRecord(hydrateRequest(row, this.config)) : null;
  }
}
