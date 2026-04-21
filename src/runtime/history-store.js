import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function isCompletedStatus(status) {
  return status === 'completed' || status === 'finished';
}

export class HistoryStore {
  constructor({ projectRoot = process.cwd() } = {}) {
    this.projectRoot = projectRoot;
    this.storageDir = resolve(projectRoot, '.omnicrawl');
    this.historyPath = join(this.storageDir, 'history.json');
    this.records = [];
    this.initPromise = null;
    this.initialized = false;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.storageDir);
        try {
          this.records = toArray(await readJson(this.historyPath));
        } catch {
          this.records = [];
          await writeJson(this.historyPath, this.records);
        }
        this.initialized = true;
      })();
    }

    await this.initPromise;
    return this;
  }

  list(limit = 100) {
    if (!this.initialized && this.initPromise) {
      return this.initPromise.then(() => this.list(limit));
    }

    return [...this.records]
      .sort((left, right) => String(right.finishedAt ?? right.startedAt ?? '').localeCompare(String(left.finishedAt ?? left.startedAt ?? '')))
      .slice(0, limit);
  }

  get(jobId) {
    if (!this.initialized && this.initPromise) {
      return this.initPromise.then(() => this.get(jobId));
    }

    return this.records.find((record) => record.jobId === jobId) ?? null;
  }

  async append(record) {
    await this.init();
    this.records = this.records.filter((entry) => entry.jobId !== record.jobId);
    this.records.unshift(record);
    await writeJson(this.historyPath, this.records);
    return record;
  }

  findPreviousCompleted(workflowName, { excludeJobId = null } = {}) {
    if (!this.initialized && this.initPromise) {
      return this.initPromise.then(() => this.findPreviousCompleted(workflowName, { excludeJobId }));
    }

    return this.records.find((record) =>
      record.jobId !== excludeJobId
      && record.workflowName === workflowName
      && isCompletedStatus(record.status)) ?? null;
  }

  listPreviousCompleted(workflowName, { excludeJobId = null, limit = 5 } = {}) {
    if (!this.initialized && this.initPromise) {
      return this.initPromise.then(() => this.listPreviousCompleted(workflowName, { excludeJobId, limit }));
    }

    return this.records
      .filter((record) =>
        record.jobId !== excludeJobId
        && record.workflowName === workflowName
        && isCompletedStatus(record.status))
      .slice(0, limit);
  }

  async loadWorkflowForJob(jobId) {
    const record = await this.get(jobId);

    if (!record?.runDir) {
      return null;
    }

    try {
      const raw = await readFile(join(record.runDir, 'workflow.json'), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed.workflow ?? null;
    } catch {
      return null;
    }
  }
}
