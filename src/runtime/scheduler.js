import { join, resolve } from 'node:path';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function createScheduleId() {
  return `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ScheduleManager {
  constructor({ projectRoot = process.cwd(), workflowRegistry, jobStore, historyStore, launchWorkflow, restoreTimers = true }) {
    this.projectRoot = projectRoot;
    this.storageDir = resolve(projectRoot, '.omnicrawl');
    this.schedulesPath = join(this.storageDir, 'schedules.json');
    this.workflowRegistry = workflowRegistry;
    this.jobStore = jobStore;
    this.historyStore = historyStore;
    this.launchWorkflow = launchWorkflow;
    this.restoreTimers = restoreTimers;
    this.schedules = [];
    this.timers = new Map();
    this.activeTicks = new Set();
    this.initPromise = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.storageDir);
        try {
          this.schedules = toArray(await readJson(this.schedulesPath));
        } catch {
          this.schedules = [];
          await writeJson(this.schedulesPath, this.schedules);
        }

        for (const schedule of this.schedules) {
          if (schedule.enabled && this.restoreTimers) {
            this.startTimer(schedule);
          }
        }
      })();
    }

    await this.initPromise;
    return this;
  }

  async persist() {
    await this.init();
    await writeJson(this.schedulesPath, this.schedules);
  }

  list() {
    return [...this.schedules].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  get(scheduleId) {
    return this.schedules.find((item) => item.id === scheduleId);
  }

  startTimer(schedule) {
    this.stopTimer(schedule.id);

    if (!schedule.enabled) {
      return;
    }

    const timer = setInterval(() => {
      const tickPromise = this.tick(schedule.id);
      this.activeTicks.add(tickPromise);
      tickPromise.finally(() => {
        this.activeTicks.delete(tickPromise);
      });
    }, schedule.intervalMs);

    timer.unref?.();
    this.timers.set(schedule.id, timer);
  }

  stopTimer(scheduleId) {
    const timer = this.timers.get(scheduleId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(scheduleId);
    }
  }

  async tick(scheduleId) {
    const schedule = this.get(scheduleId);

    if (!schedule) {
      return;
    }

    if (schedule.running) {
      return;
    }

    schedule.running = true;
    schedule.updatedAt = new Date().toISOString();
    await this.persist();

    try {
      const workflowEntry = await this.workflowRegistry.get(schedule.workflowId);
      const workflow = workflowEntry?.workflow ?? workflowEntry ?? null;
      if (!workflow) {
        throw new Error(`workflow ${schedule.workflowId} not found`);
      }

      const summary = await this.launchWorkflow(workflow, {
        source: `schedule:${schedule.id}`,
        metadata: {
          trigger: 'schedule',
          scheduleId: schedule.id,
          workflowId: schedule.workflowId,
        },
      });

      schedule.lastRunAt = new Date().toISOString();
      schedule.lastJobId = summary.jobId;
      schedule.lastError = null;
      schedule.nextRunAt = new Date(Date.now() + schedule.intervalMs).toISOString();
    } catch (error) {
      schedule.lastError = error?.message ?? String(error);
    } finally {
      schedule.running = false;
      schedule.updatedAt = new Date().toISOString();
      await this.persist();
    }
  }

  async create({ workflowId, intervalMs, enabled = true }) {
    await this.init();

    const workflowEntry = await this.workflowRegistry.get(workflowId);
    if (!workflowEntry) {
      throw new Error(`workflow ${workflowId} not found`);
    }

    const now = new Date().toISOString();
    const schedule = {
      id: createScheduleId(),
      workflowId,
      intervalMs: Number(intervalMs),
      enabled: Boolean(enabled),
      running: false,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastJobId: null,
      lastError: null,
      nextRunAt: enabled ? new Date(Date.now() + Number(intervalMs)).toISOString() : null,
    };

    this.schedules.unshift(schedule);
    await this.persist();
    if (schedule.enabled) {
      this.startTimer(schedule);
    }
    return schedule;
  }

  async setEnabled(scheduleId, enabled) {
    await this.init();
    const schedule = this.schedules.find((item) => item.id === scheduleId);

    if (!schedule) {
      return null;
    }

    schedule.enabled = Boolean(enabled);
    schedule.updatedAt = new Date().toISOString();
    schedule.nextRunAt = schedule.enabled ? new Date(Date.now() + schedule.intervalMs).toISOString() : null;

    if (schedule.enabled) {
      this.startTimer(schedule);
    } else {
      this.stopTimer(schedule.id);
    }

    await this.persist();
    return schedule;
  }

  async close() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    await Promise.allSettled([...this.activeTicks]);
  }
}
