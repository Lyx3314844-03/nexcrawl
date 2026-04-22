import { createHash } from 'node:crypto';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('sharded-db-sink');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeIdentifier(value, fallback) {
  const normalized = String(value ?? fallback ?? '').trim();
  if (!normalized) {
    throw new Error('SQL identifier is required');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid SQL identifier: ${normalized}`);
  }
  return normalized;
}

function hashShard(input, shardCount) {
  const digest = createHash('md5').update(String(input ?? '')).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) % shardCount;
}

async function insertWithGenericClient(client, provider, tableName, items) {
  if (!client) {
    return;
  }

  switch (provider) {
    case 'postgres': {
      if (typeof client.query !== 'function') {
        throw new Error('Postgres sharded sink client must expose query()');
      }
      const table = sanitizeIdentifier(tableName, 'crawled_data');
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id BIGSERIAL PRIMARY KEY,
          payload JSONB NOT NULL,
          inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const values = items.map((_, index) => `($${index + 1})`).join(', ');
      await client.query(
        `INSERT INTO ${table} (payload) VALUES ${values}`,
        items.map((item) => JSON.stringify(item)),
      );
      return;
    }

    case 'mysql': {
      if (typeof client.execute !== 'function') {
        throw new Error('MySQL sharded sink client must expose execute()');
      }
      const table = `\`${sanitizeIdentifier(tableName, 'crawled_data').replace(/`/g, '``')}\``;
      await client.execute(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          payload JSON NOT NULL,
          inserted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const placeholders = items.map(() => '(?)').join(', ');
      await client.execute(
        `INSERT INTO ${table} (payload) VALUES ${placeholders}`,
        items.map((item) => JSON.stringify(item)),
      );
      return;
    }

    case 'mongodb': {
      const databaseName = client.databaseName ?? client.dbName ?? client.database ?? null;
      const collectionName = sanitizeIdentifier(tableName, 'crawled_data');
      const collection =
        typeof client.collection === 'function'
          ? client.collection(collectionName)
          : typeof client.db === 'function' && databaseName
            ? client.db(databaseName).collection(collectionName)
            : null;

      if (!collection?.insertMany) {
        throw new Error('Mongo sharded sink client must expose collection().insertMany() or db().collection().insertMany()');
      }
      await collection.insertMany(items, { ordered: false });
      return;
    }

    default:
      throw new Error(`Unsupported sharded sink provider: ${provider}`);
  }
}

function createAdapter(options = {}) {
  if (options.adapter && typeof options.adapter.insertBatch === 'function') {
    return options.adapter;
  }

  if (typeof options.writer === 'function') {
    return {
      async insertBatch(tableName, items, context) {
        await options.writer(tableName, items, context);
      },
    };
  }

  if (options.client && options.provider) {
    return {
      async insertBatch(tableName, items, context) {
        await insertWithGenericClient(options.client, options.provider, tableName, items, context);
      },
    };
  }

  return {
    async insertBatch(tableName, items) {
      logger.info(`Simulated sharded sink write to ${tableName}`, { count: items.length });
    },
  };
}

export class ShardedDbSink {
  static #globalInstance = null;

  static configureGlobal(options = {}) {
    if (ShardedDbSink.#globalInstance) {
      ShardedDbSink.#globalInstance.close();
    }
    ShardedDbSink.#globalInstance = new ShardedDbSink(options);
    return ShardedDbSink.#globalInstance;
  }

  static getGlobal() {
    if (!ShardedDbSink.#globalInstance) {
      ShardedDbSink.#globalInstance = new ShardedDbSink();
    }
    return ShardedDbSink.#globalInstance;
  }

  static async push(data) {
    return ShardedDbSink.getGlobal().push(data);
  }

  static async flush() {
    return ShardedDbSink.getGlobal().flush();
  }

  static resetGlobal() {
    if (ShardedDbSink.#globalInstance) {
      ShardedDbSink.#globalInstance.close();
      ShardedDbSink.#globalInstance = null;
    }
  }

  constructor(options = {}) {
    this.buffer = [];
    this.flushInterval = Number(options.flushInterval ?? 5000) || 5000;
    this.maxBufferSize = Number(options.maxBatchSize ?? 1000) || 1000;
    this.shardType = options.shardType ?? 'hash';
    this.shardCount = Math.max(1, Number(options.shardCount ?? 64) || 64);
    this.shardKey = options.shardKey ?? 'id';
    this.tablePrefix = sanitizeIdentifier(options.tablePrefix ?? 'crawled_data', 'crawled_data');
    this.adapter = createAdapter(options);
    this.provider = options.provider ?? null;
    this.databaseName = options.databaseName ?? null;
    this._timer = null;
    this._startAutoflush();
  }

  async push(data) {
    if (data === undefined) {
      return;
    }
    this.buffer.push(data);
    if (this.buffer.length >= this.maxBufferSize) {
      await this.flush();
    }
  }

  async flush() {
    if (this.buffer.length === 0) {
      return { insertedCount: 0, shards: [] };
    }

    const items = [...this.buffer];
    this.buffer = [];
    const shards = this._groupByShard(items);
    const shardEntries = Object.entries(shards);

    await Promise.all(shardEntries.map(async ([tableName, groupedItems]) => {
      await this.adapter.insertBatch(tableName, groupedItems, {
        provider: this.provider,
        databaseName: this.databaseName,
        shardType: this.shardType,
        tablePrefix: this.tablePrefix,
      });
      logger.info(`Flushed ${groupedItems.length} items to shard: ${tableName}`);
    }));

    return {
      insertedCount: items.length,
      shards: shardEntries.map(([tableName, groupedItems]) => ({
        tableName,
        count: groupedItems.length,
      })),
    };
  }

  close() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _groupByShard(items) {
    const groups = {};
    for (const item of items) {
      const shard = this._resolveShard(item);
      const tableName = this._buildTableName(shard, item);
      if (!groups[tableName]) {
        groups[tableName] = [];
      }
      groups[tableName].push(item);
    }
    return groups;
  }

  _resolveShard(item) {
    if (this.shardType === 'daily') {
      const source = item?.createdAt ?? item?.updatedAt ?? item?.timestamp ?? Date.now();
      const date = new Date(source);
      const yyyy = date.getUTCFullYear();
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(date.getUTCDate()).padStart(2, '0');
      return `${yyyy}${mm}${dd}`;
    }

    const shardValue =
      isPlainObject(item) && this.shardKey in item
        ? item[this.shardKey]
        : item?.id ?? JSON.stringify(item);
    return hashShard(shardValue, this.shardCount);
  }

  _buildTableName(shard, item) {
    if (this.shardType === 'daily') {
      return `${this.tablePrefix}_d${shard}`;
    }

    const explicit = isPlainObject(item) ? item._tableName ?? item.tableName ?? null : null;
    if (explicit) {
      return sanitizeIdentifier(explicit, `${this.tablePrefix}_s0`);
    }

    return `${this.tablePrefix}_s${shard}`;
  }

  _startAutoflush() {
    this._timer = setInterval(() => {
      this.flush().catch((error) => {
        logger.warn('ShardedDbSink autoflush failed', { error: error.message });
      });
    }, this.flushInterval);
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }
}
