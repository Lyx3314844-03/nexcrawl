import { getLogger } from '../utils/logger.js';

const logger = getLogger('sharded-db-sink');

export class ShardedDbSink {
  constructor(options = {}) {
    this.buffer = [];
    this.flushInterval = options.flushInterval || 5000;
    this.maxBufferSize = options.maxBatchSize || 1000;
    this._startAutoflush();
  }

  /**
   * 线程安全的异步分片写入
   */
  async push(data) {
    this.buffer.push(data);
    if (this.buffer.length >= this.maxBufferSize) {
      await this.flush();
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;
    
    const items = [...this.buffer];
    this.buffer = [];

    // 1. 自动计算目标分片 (Shard calculation)
    const shards = this._groupByShard(items);
    
    // 2. 并行批量写入
    await Promise.all(Object.entries(shards).map(([tableName, data]) => {
      logger.info(`Flushing ${data.length} items to shard: ${tableName}`);
      // 模拟 SQL 批量写入: INSERT INTO ${tableName} VALUES ...
      return Promise.resolve();
    }));
  }

  _groupByShard(items) {
    const groups = {};
    for (const item of items) {
      const shardId = item.id ? (item.id % 64) : 0;
      const tableName = `crawled_data_s${shardId}`;
      if (!groups[tableName]) groups[tableName] = [];
      groups[tableName].push(item);
    }
    return groups;
  }

  _startAutoflush() {
    setInterval(() => this.flush(), this.flushInterval);
  }
}
