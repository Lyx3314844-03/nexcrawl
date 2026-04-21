import { openControlPlaneDatabase, nowIso, plusMs, encodeJson, decodeJson, isLeaseActive } from './sqlite-control-plane.js';

function createJobId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultStats() {
  return {
    pagesFetched: 0,
    resultCount: 0,
    failureCount: 0,
  };
}

function emptyLease() {
  return {
    owner: null,
    expiresAt: null,
    lastHeartbeatAt: null,
    active: false,
  };
}

function isTerminalStatus(status) {
  return ['completed', 'failed', 'interrupted'].includes(status);
}

function hydrateJob(row, { includeWorkflow = false } = {}) {
  if (!row) {
    return null;
  }

  const job = {
    id: row.id,
    workflowName: row.workflow_name,
    source: row.source ?? 'inline',
    metadata: decodeJson(row.metadata_json, {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    runDir: row.run_dir ?? null,
    stats: decodeJson(row.stats_json, defaultStats()),
    events: decodeJson(row.events_json, []),
    error: row.error ?? null,
    lease: {
      owner: row.lease_owner ?? null,
      expiresAt: row.lease_expires_at ?? null,
      lastHeartbeatAt: row.last_heartbeat_at ?? null,
      active: isLeaseActive(row.lease_expires_at),
    },
  };

  if (includeWorkflow) {
    job.workflow = decodeJson(row.workflow_json, null);
  }

  return job;
}

function toHistoryRecord(job) {
  if (!job) {
    return null;
  }

  return {
    ...job,
    jobId: job.id,
  };
}

export class SqliteJobStore {
  constructor({ dbPath, workerId } = {}) {
    this.dbPath = dbPath;
    this.workerId = workerId ?? null;
    this.db = null;
    this.listeners = new Map();
    this.initPromise = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.db = await openControlPlaneDatabase(this.dbPath);
      })();
    }

    await this.initPromise;
    return this;
  }

  requireDb() {
    if (!this.db) {
      throw new Error('SqliteJobStore.init() must complete before use');
    }

    return this.db;
  }

  close() {
    this.db?.close();
    this.db = null;
    this.initPromise = null;
  }

  readJob(jobId, { includeWorkflow = false } = {}) {
    const db = this.requireDb();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    return hydrateJob(row, { includeWorkflow });
  }

  writeJob(job) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO jobs (
        id,
        workflow_name,
        workflow_json,
        source,
        metadata_json,
        status,
        created_at,
        updated_at,
        started_at,
        finished_at,
        run_dir,
        stats_json,
        events_json,
        lease_owner,
        lease_expires_at,
        last_heartbeat_at,
        error
      ) VALUES (
        @id,
        @workflowName,
        @workflowJson,
        @source,
        @metadataJson,
        @status,
        @createdAt,
        @updatedAt,
        @startedAt,
        @finishedAt,
        @runDir,
        @statsJson,
        @eventsJson,
        @leaseOwner,
        @leaseExpiresAt,
        @lastHeartbeatAt,
        @error
      )
      ON CONFLICT(id) DO UPDATE SET
        workflow_name = excluded.workflow_name,
        workflow_json = excluded.workflow_json,
        source = excluded.source,
        metadata_json = excluded.metadata_json,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        run_dir = excluded.run_dir,
        stats_json = excluded.stats_json,
        events_json = excluded.events_json,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        error = excluded.error
    `).run({
      id: job.id,
      workflowName: job.workflowName,
      workflowJson: encodeJson(job.workflow, null),
      source: job.source ?? 'inline',
      metadataJson: encodeJson(job.metadata, {}),
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      runDir: job.runDir,
      statsJson: encodeJson(job.stats, defaultStats()),
      eventsJson: encodeJson(job.events, []),
      leaseOwner: job.lease?.owner ?? null,
      leaseExpiresAt: job.lease?.expiresAt ?? null,
      lastHeartbeatAt: job.lease?.lastHeartbeatAt ?? null,
      error: job.error ?? null,
    });
  }

  create({ workflowName, metadata = {}, workflow, source = 'inline', id } = {}) {
    return this.createQueuedWorkflow({
      jobId: id,
      workflowName,
      metadata,
      workflow,
      source,
    });
  }

  createQueuedWorkflow({ workflowName, metadata = {}, workflow, source = 'inline', jobId } = {}) {
    if (!workflow) {
      throw new Error('workflow is required for distributed queueing');
    }

    const now = nowIso();
    const job = {
      id: jobId ?? createJobId(),
      workflowName: workflowName ?? workflow.name,
      workflow,
      source,
      metadata,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      runDir: null,
      stats: defaultStats(),
      events: [],
      error: null,
      lease: emptyLease(),
    };

    this.writeJob(job);
    return this.get(job.id);
  }

  get(jobId) {
    return this.readJob(jobId);
  }

  loadWorkflow(jobId) {
    return this.readJob(jobId, { includeWorkflow: true })?.workflow ?? null;
  }

  list() {
    const db = this.requireDb();
    const rows = db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC, created_at DESC').all();
    return rows.map((row) => hydrateJob(row));
  }

  listHistory(limit = 100) {
    return this.list()
      .filter((job) => job.status !== 'queued' && job.status !== 'running')
      .map((job) => toHistoryRecord(job))
      .slice(0, limit);
  }

  getHistory(jobId) {
    const job = this.get(jobId);
    if (!job || job.status === 'queued' || job.status === 'running') {
      return null;
    }

    return toHistoryRecord(job);
  }

  update(jobId, patch) {
    const current = this.readJob(jobId, { includeWorkflow: true });
    if (!current) {
      return null;
    }

    const next = {
      ...current,
      ...patch,
      workflow: patch?.workflow ?? current.workflow,
      metadata: patch?.metadata ?? current.metadata,
      stats: patch?.stats ?? current.stats,
      events: patch?.events ?? current.events,
      updatedAt: nowIso(),
      lease: current.lease ?? emptyLease(),
    };

    if (next.status === 'queued') {
      next.startedAt = patch?.startedAt ?? null;
      next.finishedAt = patch?.finishedAt ?? null;
      next.error = patch?.error ?? null;
      next.events = patch?.events ?? [];
      next.lease = emptyLease();
    }

    if (next.status === 'running') {
      next.finishedAt = patch?.finishedAt ?? null;
      next.lease = {
        owner: patch?.lease?.owner ?? current.lease?.owner ?? null,
        expiresAt: patch?.lease?.expiresAt ?? current.lease?.expiresAt ?? null,
        lastHeartbeatAt: patch?.lease?.lastHeartbeatAt ?? current.lease?.lastHeartbeatAt ?? null,
        active: isLeaseActive(patch?.lease?.expiresAt ?? current.lease?.expiresAt ?? null),
      };
    }

    if (isTerminalStatus(next.status)) {
      next.lease = emptyLease();
    }

    this.writeJob(next);
    return this.get(jobId);
  }

  pushEvent(jobId, event) {
    const current = this.readJob(jobId, { includeWorkflow: true });
    if (!current) {
      return;
    }

    const events = [...current.events, event].slice(-200);
    const next = {
      ...current,
      events,
      updatedAt: nowIso(),
    };

    this.writeJob(next);

    const listeners = this.listeners.get(jobId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  subscribe(jobId, listener) {
    const listeners = this.listeners.get(jobId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(jobId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(jobId);
      }
    };
  }

  requeueJob(jobId, { metadata, workflow, source } = {}) {
    const current = this.readJob(jobId, { includeWorkflow: true });
    if (!current) {
      return null;
    }

    const now = nowIso();
    const nextWorkflow = workflow ?? current.workflow;
    const next = {
      ...current,
      workflow: nextWorkflow,
      workflowName: nextWorkflow?.name ?? current.workflowName,
      source: source ?? current.source,
      metadata: metadata ?? current.metadata,
      status: 'queued',
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      stats: defaultStats(),
      events: [],
      error: null,
      lease: emptyLease(),
    };

    this.writeJob(next);
    return this.get(jobId);
  }

  claimNextQueuedJob({ workerId, leaseTtlMs }) {
    const db = this.requireDb();
    const now = nowIso();
    const leaseExpiresAt = plusMs(now, leaseTtlMs);

    try {
      db.exec('BEGIN IMMEDIATE');

      db.prepare(`
        UPDATE jobs
        SET status = 'interrupted',
            updated_at = @now,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_heartbeat_at = NULL,
            error = COALESCE(error, 'worker lease expired')
        WHERE status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= @now
      `).run({ now });

      const candidate = db.prepare(`
        SELECT id
        FROM jobs
        WHERE status IN ('interrupted', 'queued')
        ORDER BY CASE status WHEN 'interrupted' THEN 0 ELSE 1 END,
                 updated_at ASC,
                 created_at ASC
        LIMIT 1
      `).get();

      if (!candidate?.id) {
        db.exec('COMMIT');
        return null;
      }

      const claimed = db.prepare(`
        UPDATE jobs
        SET status = 'running',
            updated_at = @now,
            started_at = COALESCE(started_at, @now),
            finished_at = NULL,
            lease_owner = @workerId,
            lease_expires_at = @leaseExpiresAt,
            last_heartbeat_at = @now,
            error = NULL
        WHERE id = @id
          AND status IN ('interrupted', 'queued')
      `).run({
        id: candidate.id,
        workerId,
        now,
        leaseExpiresAt,
      });

      if (claimed.changes === 0) {
        db.exec('ROLLBACK');
        return null;
      }

      db.exec('COMMIT');
      return this.readJob(candidate.id, { includeWorkflow: true });
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // noop
      }
      throw error;
    }
  }

  renewLease(jobId, { workerId, leaseTtlMs }) {
    const db = this.requireDb();
    const now = nowIso();
    const leaseExpiresAt = plusMs(now, leaseTtlMs);
    const result = db.prepare(`
      UPDATE jobs
      SET updated_at = @now,
          lease_expires_at = @leaseExpiresAt,
          last_heartbeat_at = @now
      WHERE id = @id
        AND status = 'running'
        AND lease_owner = @workerId
    `).run({
      id: jobId,
      workerId,
      now,
      leaseExpiresAt,
    });

    return result.changes > 0;
  }
}
