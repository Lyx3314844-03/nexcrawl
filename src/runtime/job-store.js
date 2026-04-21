import { join, resolve } from 'node:path';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';

function createJobId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

function cloneJob(job) {
  return structuredClone(job);
}

export class JobStore {
  constructor({ projectRoot = process.cwd() } = {}) {
    this.projectRoot = projectRoot;
    this.storageDir = resolve(projectRoot, '.omnicrawl');
    this.statePath = join(this.storageDir, 'jobs.json');
    this.jobs = new Map();
    this.listeners = new Map();
    this.initPromise = null;
    this.persistChain = Promise.resolve();
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.storageDir);

        try {
          const loaded = toArray(await readJson(this.statePath));
          const interruptedAt = nowIso();

          for (const job of loaded) {
            if (job.status === 'running' || job.status === 'queued') {
              job.status = 'interrupted';
              job.updatedAt = interruptedAt;
            }

            this.jobs.set(job.id, job);
          }

          await this.persist();
        } catch {
          await this.persist();
        }
      })();
    }

    await this.initPromise;
    return this;
  }

  async persist() {
    await writeJson(
      this.statePath,
      [...this.jobs.values()].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))),
    );
  }

  schedulePersist() {
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(() => this.persist());
    return this.persistChain;
  }

  create({ workflowName, metadata = {} }) {
    const id = createJobId();
    const job = {
      id,
      workflowName,
      metadata,
      status: 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      runDir: null,
      stats: {
        pagesFetched: 0,
        resultCount: 0,
        failureCount: 0,
      },
      events: [],
    };

    this.jobs.set(id, job);
    void this.schedulePersist();
    return job;
  }

  get(jobId) {
    return this.jobs.get(jobId) ?? null;
  }

  list() {
    return Array.from(this.jobs.values())
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
      .map((job) => cloneJob(job));
  }

  update(jobId, patch) {
    const current = this.jobs.get(jobId);

    if (!current) {
      return null;
    }

    Object.assign(current, patch, {
      updatedAt: nowIso(),
    });

    void this.schedulePersist();
    return cloneJob(current);
  }

  pushEvent(jobId, event) {
    const current = this.jobs.get(jobId);

    if (!current) {
      return;
    }

    current.events.push(event);

    if (current.events.length > 200) {
      current.events.shift();
    }

    void this.schedulePersist();

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
}
