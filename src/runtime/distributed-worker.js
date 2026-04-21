import { createLogger } from '../core/logger.js';
import { runWorkflow } from './job-runner.js';

export class DistributedWorkerService {
  constructor({
    projectRoot = process.cwd(),
    jobStore,
    historyStore,
    sessionStore,
    proxyPool,
    alertOutbox,
    controlPlane,
    dataPlane,
    activeRuns = new Set(),
  }) {
    this.projectRoot = projectRoot;
    this.jobStore = jobStore;
    this.historyStore = historyStore;
    this.sessionStore = sessionStore;
    this.proxyPool = proxyPool;
    this.alertOutbox = alertOutbox ?? null;
    this.controlPlane = controlPlane;
    this.dataPlane = dataPlane;
    this.activeRuns = activeRuns;
    this.logger = createLogger({
      component: 'distributed-worker',
      workerId: controlPlane.workerId,
    });
    this.pollTimer = null;
    this.activeJobs = new Map();
    this.polling = false;
  }

  start() {
    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.controlPlane.pollIntervalMs);
    this.pollTimer.unref?.();
    void this.poll();
  }

  async poll() {
    if (this.polling) {
      return;
    }

    this.polling = true;
    try {
      while (this.activeJobs.size < this.controlPlane.workerConcurrency) {
        const claimed = this.jobStore.claimNextQueuedJob({
          workerId: this.controlPlane.workerId,
          leaseTtlMs: this.controlPlane.leaseTtlMs,
        });

        if (!claimed?.workflow) {
          break;
        }

        this.runClaimedJob(claimed);
      }
    } catch (error) {
      this.logger.error('worker poll failed', {
        error: error?.message ?? String(error),
      });
    } finally {
      this.polling = false;
    }
  }

  runClaimedJob(job) {
    const metadata = {
      ...(job.metadata ?? {}),
      workerId: this.controlPlane.workerId,
    };
    this.jobStore.update(job.id, { metadata });

    const leaseTimer = setInterval(() => {
      const renewed = this.jobStore.renewLease(job.id, {
        workerId: this.controlPlane.workerId,
        leaseTtlMs: this.controlPlane.leaseTtlMs,
      });

      if (!renewed) {
        const snapshot = this.jobStore.get(job.id);
        if (!snapshot || snapshot.status !== 'running') {
          return;
        }

        this.logger.error('worker lease renewal failed', {
          jobId: job.id,
        });
      }
    }, this.controlPlane.heartbeatMs);
    leaseTimer.unref?.();

    const promise = runWorkflow(job.workflow, {
      projectRoot: this.projectRoot,
      jobStore: this.jobStore,
      historyStore: this.historyStore,
      sessionStore: this.sessionStore,
      proxyPool: this.proxyPool,
      alertOutbox: this.alertOutbox,
      jobId: job.id,
      source: job.source,
      metadata,
      controlPlane: this.controlPlane,
      dataPlane: this.dataPlane,
    })
      .catch((error) => {
        this.logger.error('distributed job failed', {
          jobId: job.id,
          error: error?.message ?? String(error),
        });
      })
      .finally(() => {
        clearInterval(leaseTimer);
        this.activeJobs.delete(job.id);
        this.activeRuns.delete(promise);
        void this.poll();
      });

    this.activeJobs.set(job.id, { promise, leaseTimer });
    this.activeRuns.add(promise);
  }

  async close() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    await Promise.allSettled([...this.activeJobs.values()].map((entry) => entry.promise));
  }
}
