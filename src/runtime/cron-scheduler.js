/**
 * Cron-based scheduler for periodic crawl jobs.
 *
 * Extends the existing ScheduleManager with cron expressions
 * for fine-grained scheduling (e.g., "0 8 * * 1-5" for every 6 hours).
 * Falls back gracefully when the cron parser is not installed.
 *
 * Usage:
 *   import { createCronScheduler } from '../runtime/cron-scheduler.js';
 *   const scheduler = await createCronScheduler({ storagePath: '.omnicrawl/crons.json' });
 *   await scheduler.addJob('price-monitor', '0 8 * * 1-5', workflowConfig);
 */

import { createLogger } from '../core/logger.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { join } from 'node:path';

const log = createLogger('cron-scheduler');

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a cron-based scheduler.
 *
 * @param {object} config
 * @param {string}  [config.storagePath='.omnicrawl/crons.json'] - Persistence file
 * @param {boolean} [config.restoreOnStartup=true] - Restore timers on init
 * @param {number}  [config.maxConcurrentPerJob=1] - Prevent overlapping runs
 * @returns {Promise<object>} Scheduler with addJob(), removeJob(), listJobs(), close()
 */
export async function createCronScheduler(config = {}) {
  const {
    storagePath = '.omnicrawl/crons.json',
    restoreOnStartup = true,
    maxConcurrentPerJob = 1,
  } = config;

  // Lazy-load cron parser
  let cronParser = null;
  try {
    const mod = await import('cron-parser');
    cronParser = mod.default ?? mod;
  } catch {
    log.warn('cron-parser not installed – using interval-only mode. Install: npm install cron-parser');
  }

  await ensureDir(join(storagePath, '..'));
  let jobs = {};
  try {
    jobs = await readJson(storagePath);
  } catch {
    jobs = {};
  }

  const timers = new Map();
  const runningCounts = new Map();
  const tickCallbacks = new Map();  // Separate storage for onTick (not persisted)

  /**
   * Compute the next interval delay from a cron expression.
   * Returns milliseconds until the next scheduled time.
   */
  function getNextDelay(expression) {
    if (!cronParser) return null; // cron-parser not available
    try {
      const interval = cronParser.parseExpression(expression);
      const next = interval.next();
      return Math.max(0, next.getTime() - Date.now());
    } catch (err) {
      log.warn('Invalid cron expression', { expression, error: err.message });
      return null;
    }
  }

  /**
   * Start the timer for a job using either cron or interval.
   */
  function startTimer(jobId) {
    const job = jobs[jobId];
    if (!job || !job.enabled) return;

    const delay = getNextDelay(job.cron);
    if (delay !== null) {
      // Cron-based scheduling
      scheduleCronTick(jobId, delay);
    } else if (job.intervalMs) {
      // Fallback to interval-based scheduling
      const timer = setInterval(() => tick(jobId), job.intervalMs);
      timer.unref?.();
      timers.set(jobId, timer);
    } else {
      log.warn('No valid cron or interval for job', { jobId });
    }
  }

  async function scheduleCronTick(jobId, delayMs) {
    if (delayMs <= 0) {
      await tick(jobId);
      const nextDelay = getNextDelay(jobs[jobId]?.cron);
      if (nextDelay !== null && jobs[jobId]?.enabled) {
        scheduleCronTick(jobId, nextDelay);
      }
      return;
    }
    const timer = setTimeout(async () => {
      await tick(jobId);
      // Schedule the next tick
      if (jobs[jobId]?.enabled) {
        const nextDelay = getNextDelay(jobs[jobId].cron);
        if (nextDelay !== null) scheduleCronTick(jobId, nextDelay);
      }
    }, delayMs);
    timer.unref?.();
    timers.set(jobId, timer);
  }

  async function tick(jobId) {
    const job = jobs[jobId];
    if (!job) return;

    const running = runningCounts.get(jobId) ?? 0;
    if (running >= maxConcurrentPerJob) {
      log.debug('Job skipped – max concurrent reached', { jobId });
      return;
    }

    runningCounts.set(jobId, running + 1);
    try {
      job.lastRunAt = new Date().toISOString();
      job.runCount = (job.runCount ?? 0) + 1;
      await persist();

      const onTick = tickCallbacks.get(jobId);
      if (onTick) {
        await onTick(jobId, job);
      }
      log.info('Cron job executed', { jobId, runCount: job.runCount });
    } catch (err) {
      job.lastError = err.message;
      log.error('Cron job tick failed', { jobId, error: err.message });
    } finally {
      runningCounts.set(jobId, Math.max(0, (runningCounts.get(jobId) ?? 1) - 1));
      await persist();
    }
  }

  async function persist() {
    await writeJson(storagePath, jobs);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  const scheduler = {
    /**
     * Add a new cron job.
     *
     * @param {string} jobId - Unique job identifier
     * @param {string} cronExpression - Cron expression (e.g., '0 8 * * 1-5')
     * @param {object} [opts]
     * @param {number} [opts.intervalMs] - Fallback interval if cron-parser unavailable
     * @param {boolean} [opts.enabled=true]
     * @param {function} [opts.onTick] - Async callback per execution
     * @param {object} [opts.metadata] - Arbitrary metadata for the onTick callback
     */
    async addJob(jobId, cronExpression, opts = {}) {
      const {
        intervalMs,
        enabled = true,
        onTick = null,
        metadata = {},
      } = opts;

      jobs[jobId] = {
        id: jobId,
        cron: cronExpression,
        intervalMs,
        enabled,
        metadata,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        lastError: null,
        runCount: 0,
      };
      // Store callback separately – cannot be JSON-serialized
      if (onTick) tickCallbacks.set(jobId, onTick);

      await persist();
      if (enabled) startTimer(jobId);
      log.info('Cron job added', { jobId, cron: cronExpression });
    },

    /**
     * Remove a cron job.
     */
    async removeJob(jobId) {
      tickCallbacks.delete(jobId);
      const timer = timers.get(jobId);
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer);
        timers.delete(jobId);
      }
      delete jobs[jobId];
      await persist();
      log.info('Cron job removed', { jobId });
    },

    /**
     * Enable or disable a job.
     */
    async toggleJob(jobId, enabled) {
      if (!jobs[jobId]) return;
      jobs[jobId].enabled = enabled;
      if (!enabled) {
        const timer = timers.get(jobId);
        if (timer) { clearTimeout(timer); clearInterval(timer); timers.delete(jobId); }
      } else {
        startTimer(jobId);
      }
      await persist();
    },

    /**
     * List all jobs.
     */
    listJobs() {
      return Object.values(jobs).map(j => ({
        id: j.id,
        cron: j.cron,
        enabled: j.enabled,
        lastRunAt: j.lastRunAt,
        runCount: j.runCount,
        lastError: j.lastError,
      }));
    },    /**
     * Re-attach an onTick callback to a job (use after restart).
     *
     * @param {string} jobId
     * @param {function} onTick - Async callback function
     */
    registerCallback(jobId, onTick) {
      if (!jobs[jobId]) {
        log.warn('Cannot register callback – job not found', { jobId });
        return;
      }
      tickCallbacks.set(jobId, onTick);
      log.info('Callback registered for job', { jobId });
    },



    /**
     * Graceful shutdown.
     */
    async close() {
      for (const [id, timer] of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.clear();
      await persist();
      log.info('Cron scheduler closed');
    },
  };

  // Restore timers on startup
  if (restoreOnStartup) {
    for (const jobId of Object.keys(jobs)) {
      if (jobs[jobId].enabled) startTimer(jobId);
    }
  }

  return scheduler;
}
