import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { createLogger } from '../core/logger.js';
import { deliverAlertPlan, getAlertDispatchPlan } from './alert-dispatcher.js';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

function plusMs(timestamp, ms) {
  return new Date(new Date(timestamp).getTime() + ms).toISOString();
}

function sortEntries(items = []) {
  return [...items].sort((left, right) =>
    String(left.nextAttemptAt ?? '').localeCompare(String(right.nextAttemptAt ?? ''))
    || String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
}

export class AlertOutbox {
  constructor({ projectRoot = process.cwd(), path } = {}) {
    this.projectRoot = projectRoot;
    this.storageDir = resolve(projectRoot, '.omnicrawl');
    this.path = path ?? join(this.storageDir, 'alert-outbox.json');
    this.entries = [];
    this.initPromise = null;
    this.persistChain = Promise.resolve();
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.storageDir);
        try {
          this.entries = toArray(await readJson(this.path));
        } catch {
          this.entries = [];
          await writeJson(this.path, this.entries);
        }
      })();
    }

    await this.initPromise;
    return this;
  }

  async persist() {
    await writeJson(this.path, sortEntries(this.entries));
  }

  schedulePersist() {
    this.persistChain = this.persistChain.catch(() => {}).then(() => this.persist());
    return this.persistChain;
  }

  async enqueueFromDispatch({ workflow, summary, dispatchResult } = {}) {
    const plan = getAlertDispatchPlan({ workflow, summary });
    if (!plan.enabled || !plan.shouldSend) {
      return null;
    }

    const now = nowIso();
    const entry = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      attemptCount: 0,
      lastError: dispatchResult?.reason ?? null,
      workflowName: summary.workflowName,
      jobId: summary.jobId,
      target: plan.webhook.url,
      plan,
    };

    this.entries.push(entry);
    await this.schedulePersist();
    return entry;
  }

  async list({ includeDelivered = false, limit = 100 } = {}) {
    await this.init();
    const filtered = includeDelivered
      ? this.entries
      : this.entries.filter((entry) => entry.status !== 'delivered');
    return sortEntries(filtered).slice(0, limit);
  }

  stats() {
    const pending = this.entries.filter((entry) => entry.status !== 'delivered');
    return {
      total: this.entries.length,
      pending: pending.length,
      delivered: this.entries.filter((entry) => entry.status === 'delivered').length,
      failed: this.entries.filter((entry) => entry.status === 'failed').length,
      nextAttemptAt: sortEntries(pending)[0]?.nextAttemptAt ?? null,
    };
  }

  async processDue({ logger } = {}) {
    await this.init();
    const now = nowIso();
    const due = this.entries.filter((entry) =>
      entry.status !== 'delivered'
      && String(entry.nextAttemptAt ?? '') <= now);
    const results = [];

    for (const entry of due) {
      entry.attemptCount = Number(entry.attemptCount ?? 0) + 1;
      entry.updatedAt = nowIso();
      const response = await deliverAlertPlan({
        plan: entry.plan,
        logger,
      });

      if (response.delivered) {
        entry.status = 'delivered';
        entry.deliveredAt = nowIso();
        entry.lastError = null;
      } else {
        entry.status = 'failed';
        entry.lastError = response.reason ?? 'delivery failed';
        const backoffMs = Math.max(1000, Number(entry.plan.webhook.retryBackoffMs ?? 1000));
        entry.nextAttemptAt = plusMs(nowIso(), backoffMs * entry.attemptCount);
      }

      results.push({
        id: entry.id,
        delivered: response.delivered,
        reason: response.reason ?? null,
        attemptCount: entry.attemptCount,
      });
    }

    if (results.length > 0) {
      await this.schedulePersist();
    }
    return results;
  }
}

export class AlertOutboxService {
  constructor({ projectRoot = process.cwd(), logger, pollIntervalMs = 10000 } = {}) {
    this.projectRoot = projectRoot;
    this.logger = logger ?? createLogger({ component: 'alert-outbox' });
    this.pollIntervalMs = pollIntervalMs;
    this.outbox = new AlertOutbox({ projectRoot });
    this.timer = null;
  }

  async init() {
    await this.outbox.init();
    return this;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.drain();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    void this.drain();
  }

  async drain() {
    const results = await this.outbox.processDue({ logger: this.logger });
    return {
      processed: results.length,
      results,
      stats: this.outbox.stats(),
    };
  }

  async enqueueFromDispatch(input) {
    return this.outbox.enqueueFromDispatch(input);
  }

  async list(options) {
    return this.outbox.list(options);
  }

  stats() {
    return this.outbox.stats();
  }

  async close() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.outbox.schedulePersist();
  }
}
