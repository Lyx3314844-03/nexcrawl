import { createLogger } from '../core/logger.js';

export class SqliteGcService {
  constructor({
    dataPlane,
    pollMs = 60_000,
    retentionMs = 7 * 24 * 60 * 60 * 1000,
    batchSize = 100,
  }) {
    this.dataPlane = dataPlane;
    this.pollMs = pollMs;
    this.retentionMs = retentionMs;
    this.batchSize = batchSize;
    this.logger = createLogger({ component: 'sqlite-gc' });
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.pollMs);
    this.timer.unref?.();
  }

  async runOnce() {
    if (this.running) {
      return null;
    }

    this.running = true;
    try {
      const pruned = this.dataPlane.pruneTerminalJobData({
        retentionMs: this.retentionMs,
        limit: this.batchSize,
      });

      if (pruned.jobs > 0) {
        this.logger.info('pruned terminal distributed job data', pruned);
      }

      return pruned;
    } finally {
      this.running = false;
    }
  }

  async close() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
