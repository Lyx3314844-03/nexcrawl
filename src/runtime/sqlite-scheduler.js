import { openControlPlaneDatabase, nowIso, plusMs, encodeJson, decodeJson, isLeaseActive, readBoolean } from './sqlite-control-plane.js';

function createScheduleId() {
  return `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hydrateSchedule(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    enabled: readBoolean(row.enabled),
    intervalMs: Number(row.interval_ms),
    running: isLeaseActive(row.lease_expires_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt: row.next_run_at ?? null,
    lastRunAt: row.last_run_at ?? null,
    lastJobId: row.last_job_id ?? null,
    lastError: row.last_error ?? null,
    lease: {
      owner: row.lease_owner ?? null,
      expiresAt: row.lease_expires_at ?? null,
      lastHeartbeatAt: row.last_heartbeat_at ?? null,
      active: isLeaseActive(row.lease_expires_at),
    },
    workflow: decodeJson(row.workflow_json, null),
  };
}

export class SqliteScheduleManager {
  constructor({
    workflowRegistry,
    jobStore,
    controlPlane,
  }) {
    this.workflowRegistry = workflowRegistry;
    this.jobStore = jobStore;
    this.controlPlane = controlPlane;
    this.db = null;
    this.initPromise = null;
    this.pollTimer = null;
    this.scanning = false;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.db = await openControlPlaneDatabase(this.controlPlane.dbPath);
        this.pollTimer = setInterval(() => {
          void this.scanDueSchedules();
        }, this.controlPlane.schedulerPollMs);
        this.pollTimer.unref?.();
        void this.scanDueSchedules();
      })();
    }

    await this.initPromise;
    return this;
  }

  requireDb() {
    if (!this.db) {
      throw new Error('SqliteScheduleManager.init() must complete before use');
    }

    return this.db;
  }

  close() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.db?.close();
    this.db = null;
    this.initPromise = null;
  }

  get(scheduleId) {
    const db = this.requireDb();
    const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId);
    return hydrateSchedule(row);
  }

  async list() {
    await this.init();
    const db = this.requireDb();
    const rows = db.prepare('SELECT * FROM schedules ORDER BY updated_at DESC, created_at DESC').all();
    return rows.map((row) => {
      const item = hydrateSchedule(row);
      delete item.workflow;
      return item;
    });
  }

  writeSchedule(schedule) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO schedules (
        id,
        workflow_id,
        workflow_name,
        workflow_json,
        interval_ms,
        enabled,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_job_id,
        last_error,
        lease_owner,
        lease_expires_at,
        last_heartbeat_at
      ) VALUES (
        @id,
        @workflowId,
        @workflowName,
        @workflowJson,
        @intervalMs,
        @enabled,
        @createdAt,
        @updatedAt,
        @nextRunAt,
        @lastRunAt,
        @lastJobId,
        @lastError,
        @leaseOwner,
        @leaseExpiresAt,
        @lastHeartbeatAt
      )
      ON CONFLICT(id) DO UPDATE SET
        workflow_id = excluded.workflow_id,
        workflow_name = excluded.workflow_name,
        workflow_json = excluded.workflow_json,
        interval_ms = excluded.interval_ms,
        enabled = excluded.enabled,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        next_run_at = excluded.next_run_at,
        last_run_at = excluded.last_run_at,
        last_job_id = excluded.last_job_id,
        last_error = excluded.last_error,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        last_heartbeat_at = excluded.last_heartbeat_at
    `).run({
      id: schedule.id,
      workflowId: schedule.workflowId,
      workflowName: schedule.workflowName,
      workflowJson: encodeJson(schedule.workflow, null),
      intervalMs: schedule.intervalMs,
      enabled: schedule.enabled ? 1 : 0,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
      lastJobId: schedule.lastJobId,
      lastError: schedule.lastError,
      leaseOwner: schedule.lease?.owner ?? null,
      leaseExpiresAt: schedule.lease?.expiresAt ?? null,
      lastHeartbeatAt: schedule.lease?.lastHeartbeatAt ?? null,
    });
  }

  async create({ workflowId, intervalMs, enabled = true }) {
    await this.init();

    const workflowEntry = await this.workflowRegistry.get(workflowId);
    if (!workflowEntry?.workflow) {
      throw new Error(`workflow ${workflowId} not found`);
    }

    const now = nowIso();
    const schedule = {
      id: createScheduleId(),
      workflowId,
      workflowName: workflowEntry.workflow.name,
      workflow: workflowEntry.workflow,
      intervalMs: Number(intervalMs),
      enabled: Boolean(enabled),
      createdAt: now,
      updatedAt: now,
      nextRunAt: enabled ? plusMs(now, Number(intervalMs)) : null,
      lastRunAt: null,
      lastJobId: null,
      lastError: null,
      lease: {
        owner: null,
        expiresAt: null,
        lastHeartbeatAt: null,
        active: false,
      },
    };

    this.writeSchedule(schedule);
    const item = this.get(schedule.id);
    delete item.workflow;
    return item;
  }

  async setEnabled(scheduleId, enabled) {
    await this.init();
    const current = this.get(scheduleId);
    if (!current) {
      return null;
    }

    const now = nowIso();
    const next = {
      ...current,
      enabled: Boolean(enabled),
      updatedAt: now,
      nextRunAt: enabled ? current.nextRunAt ?? plusMs(now, current.intervalMs) : null,
      lease: {
        owner: null,
        expiresAt: null,
        lastHeartbeatAt: null,
        active: false,
      },
    };

    this.writeSchedule(next);
    const item = this.get(scheduleId);
    delete item.workflow;
    return item;
  }

  claimDueSchedule() {
    const db = this.requireDb();
    const now = nowIso();
    const leaseExpiresAt = plusMs(now, this.controlPlane.scheduleLeaseTtlMs);

    try {
      db.exec('BEGIN IMMEDIATE');

      const candidate = db.prepare(`
        SELECT id
        FROM schedules
        WHERE enabled = 1
          AND next_run_at IS NOT NULL
          AND next_run_at <= @now
          AND (lease_expires_at IS NULL OR lease_expires_at <= @now)
        ORDER BY next_run_at ASC, created_at ASC
        LIMIT 1
      `).get({ now });

      if (!candidate?.id) {
        db.exec('COMMIT');
        return null;
      }

      const claimed = db.prepare(`
        UPDATE schedules
        SET updated_at = @now,
            lease_owner = @workerId,
            lease_expires_at = @leaseExpiresAt,
            last_heartbeat_at = @now
        WHERE id = @id
          AND enabled = 1
          AND next_run_at IS NOT NULL
          AND next_run_at <= @now
          AND (lease_expires_at IS NULL OR lease_expires_at <= @now)
      `).run({
        id: candidate.id,
        workerId: this.controlPlane.workerId,
        now,
        leaseExpiresAt,
      });

      if (claimed.changes === 0) {
        db.exec('ROLLBACK');
        return null;
      }

      db.exec('COMMIT');
      return this.get(candidate.id);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // noop
      }
      throw error;
    }
  }

  async scanDueSchedules() {
    if (this.scanning) {
      return;
    }

    this.scanning = true;
    try {
      while (true) {
        const claimed = this.claimDueSchedule();
        if (!claimed?.workflow) {
          break;
        }

        const now = nowIso();
        try {
          const job = this.jobStore.createQueuedWorkflow({
            workflow: claimed.workflow,
            source: `schedule:${claimed.id}`,
            metadata: {
              trigger: 'schedule',
              scheduleId: claimed.id,
              workflowId: claimed.workflowId,
            },
          });

          this.writeSchedule({
            ...claimed,
            updatedAt: now,
            nextRunAt: plusMs(now, claimed.intervalMs),
            lastRunAt: now,
            lastJobId: job.id,
            lastError: null,
            lease: {
              owner: null,
              expiresAt: null,
              lastHeartbeatAt: null,
              active: false,
            },
          });
        } catch (error) {
          this.writeSchedule({
            ...claimed,
            updatedAt: now,
            nextRunAt: plusMs(now, claimed.intervalMs),
            lastError: error?.message ?? String(error),
            lease: {
              owner: null,
              expiresAt: null,
              lastHeartbeatAt: null,
              active: false,
            },
          });
        }
      }
    } finally {
      this.scanning = false;
    }
  }
}
