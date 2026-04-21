/**
 * Database sink — real connection management for PostgreSQL, MySQL, and MongoDB.
 *
 * Wraps driver-level clients into a unified interface compatible with
 * ExportManager's 'sink' backend. Connections are lazily established and
 * optionally pooled.
 *
 * Install the driver you need:
 *   npm install pg          # PostgreSQL
 *   npm install mysql2      # MySQL / MariaDB
 *   npm install mongodb     # MongoDB
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('db-sink');

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

/**
 * @param {Object} config
 * @param {string} config.connectionString - postgres://user:pass@host:5432/db
 * @param {string} config.table - Target table name
 * @param {string} [config.jsonColumn='payload'] - Column to store JSON
 * @param {number} [config.batchSize=200]
 * @returns {Promise<Function>} sink(batch) => Promise<{insertedCount}>
 */
export async function createPostgresSink(config) {
  const { default: pg } = await import('pg').catch(() => {
    throw new Error('PostgreSQL sink requires pg: npm install pg');
  });

  const pool = new pg.Pool({ connectionString: config.connectionString });
  const table = pgIdent(config.table);
  const col = pgIdent(config.jsonColumn ?? 'payload');
  const batchSize = config.batchSize ?? 200;

  // Ensure table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id BIGSERIAL PRIMARY KEY,
      ${col} JSONB NOT NULL,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch((err) => log.warn('table create skipped', { error: err.message }));

  return async function postgresSink(batch) {
    if (!batch?.length) return { insertedCount: 0 };
    let total = 0;
    for (let i = 0; i < batch.length; i += batchSize) {
      const chunk = batch.slice(i, i + batchSize);
      const values = chunk.map((_, idx) => `($${idx + 1})`).join(', ');
      const params = chunk.map((item) => JSON.stringify(item));
      await pool.query(`INSERT INTO ${table} (${col}) VALUES ${values}`, params);
      total += chunk.length;
    }
    return { insertedCount: total };
  };
}

/**
 * @param {string} name
 * @returns {string} safely quoted PostgreSQL identifier
 */
function pgIdent(name) {
  const parts = String(name).split('.').map((p) => `"${p.replace(/"/g, '""')}"`);
  return parts.join('.');
}

// ─── MySQL ────────────────────────────────────────────────────────────────────

/**
 * @param {Object} config
 * @param {string} config.host
 * @param {number} [config.port=3306]
 * @param {string} config.user
 * @param {string} config.password
 * @param {string} config.database
 * @param {string} config.table
 * @param {string} [config.jsonColumn='payload']
 * @param {number} [config.batchSize=200]
 */
export async function createMySQLSink(config) {
  const mysql = await import('mysql2/promise').catch(() => {
    throw new Error('MySQL sink requires mysql2: npm install mysql2');
  });

  const pool = mysql.createPool({
    host: config.host,
    port: config.port ?? 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 5,
  });

  const table = `\`${config.table.replace(/`/g, '``')}\``;
  const col = `\`${(config.jsonColumn ?? 'payload').replace(/`/g, '``')}\``;
  const batchSize = config.batchSize ?? 200;

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ${col} JSON NOT NULL,
      inserted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).catch((err) => log.warn('table create skipped', { error: err.message }));

  return async function mysqlSink(batch) {
    if (!batch?.length) return { insertedCount: 0 };
    let total = 0;
    for (let i = 0; i < batch.length; i += batchSize) {
      const chunk = batch.slice(i, i + batchSize);
      const placeholders = chunk.map(() => '(?)').join(', ');
      const params = chunk.map((item) => JSON.stringify(item));
      await pool.execute(`INSERT INTO ${table} (${col}) VALUES ${placeholders}`, params);
      total += chunk.length;
    }
    return { insertedCount: total };
  };
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────

/**
 * @param {Object} config
 * @param {string} config.connectionString - mongodb://user:pass@host:27017
 * @param {string} config.database
 * @param {string} config.collection
 * @param {number} [config.batchSize=500]
 */
export async function createMongoSink(config) {
  const { MongoClient } = await import('mongodb').catch(() => {
    throw new Error('MongoDB sink requires mongodb: npm install mongodb');
  });

  const client = new MongoClient(config.connectionString);
  await client.connect();
  const collection = client.db(config.database).collection(config.collection);
  const batchSize = config.batchSize ?? 500;

  return async function mongoSink(batch) {
    if (!batch?.length) return { insertedCount: 0 };
    let total = 0;
    for (let i = 0; i < batch.length; i += batchSize) {
      const chunk = batch.slice(i, i + batchSize);
      const result = await collection.insertMany(chunk, { ordered: false });
      total += result.insertedCount ?? chunk.length;
    }
    return { insertedCount: total };
  };
}

// ─── Unified factory ──────────────────────────────────────────────────────────

/**
 * Create a database sink by provider name.
 *
 * @param {'postgres'|'mysql'|'mongodb'} provider
 * @param {Object} config - Provider-specific config (see individual functions above)
 * @returns {Promise<Function>} sink(batch) => Promise<{insertedCount}>
 */
export async function createDatabaseSink(provider, config) {
  switch (provider) {
    case 'postgres': return createPostgresSink(config);
    case 'mysql': return createMySQLSink(config);
    case 'mongodb': return createMongoSink(config);
    default: throw new Error(`Unknown database provider: ${provider}. Use 'postgres', 'mysql', or 'mongodb'.`);
  }
}
