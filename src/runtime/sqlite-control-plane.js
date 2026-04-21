import { dirname } from 'node:path';
import { ensureDir } from '../utils/fs.js';

let DatabaseSyncRef = null;

async function loadDatabaseSync() {
  if (DatabaseSyncRef) {
    return DatabaseSyncRef;
  }

  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function patchedEmitWarning(warning, ...args) {
    const warningCode = typeof args[0] === 'string' ? args[0] : warning?.code;
    const warningMessage =
      typeof warning === 'string'
        ? warning
        : warning?.message ?? String(warning ?? '');

    if (warningCode === 'ExperimentalWarning' && warningMessage.includes('SQLite is an experimental feature')) {
      return;
    }

    return originalEmitWarning.call(this, warning, ...args);
  };

  try {
    const sqliteModule = await import('node:sqlite');
    DatabaseSyncRef = sqliteModule.DatabaseSync;
    return DatabaseSyncRef;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function plusMs(value, ms) {
  return new Date(new Date(value).getTime() + ms).toISOString();
}

export function encodeJson(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

export function decodeJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function isLeaseActive(leaseExpiresAt, reference = nowIso()) {
  return Boolean(leaseExpiresAt) && String(leaseExpiresAt) > String(reference);
}

export function readBoolean(value) {
  return Boolean(Number(value));
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

export async function openControlPlaneDatabase(dbPath) {
  await ensureDir(dirname(dbPath));
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      source TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      run_dir TEXT,
      stats_json TEXT NOT NULL,
      events_json TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_heartbeat_at TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at
      ON jobs (status, created_at);

    CREATE INDEX IF NOT EXISTS idx_jobs_lease_expires_at
      ON jobs (lease_expires_at);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      interval_ms INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_job_id TEXT,
      last_error TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_heartbeat_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next_run
      ON schedules (enabled, next_run_at);

    CREATE INDEX IF NOT EXISTS idx_schedules_lease_expires_at
      ON schedules (lease_expires_at);

    CREATE TABLE IF NOT EXISTS request_queue_items (
      job_id TEXT NOT NULL,
      unique_key TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL,
      body TEXT,
      depth INTEGER NOT NULL,
      parent_url TEXT,
      label TEXT,
      user_data_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL,
      lane_key TEXT,
      replay_state_json TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      enqueue_count INTEGER NOT NULL,
      enqueued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dispatched_at TEXT,
      handled_at TEXT,
      failed_at TEXT,
      last_error TEXT,
      final_url TEXT,
      response_status INTEGER,
      PRIMARY KEY (job_id, unique_key)
    );

    CREATE INDEX IF NOT EXISTS idx_request_queue_items_job_status
      ON request_queue_items (job_id, status, updated_at, enqueued_at);

    CREATE TABLE IF NOT EXISTS request_seen_items (
      scope_id TEXT NOT NULL,
      unique_key TEXT NOT NULL,
      url TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_job_id TEXT,
      PRIMARY KEY (scope_id, unique_key)
    );

    CREATE INDEX IF NOT EXISTS idx_request_seen_items_scope_updated
      ON request_seen_items (scope_id, last_seen_at);

    CREATE TABLE IF NOT EXISTS job_events (
      job_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (job_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_job_events_job_sequence
      ON job_events (job_id, sequence);

    CREATE TABLE IF NOT EXISTS job_results (
      job_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_job_results_job_sequence
      ON job_results (job_id, sequence);

    CREATE TABLE IF NOT EXISTS job_artifacts (
      job_id TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      content_type TEXT NOT NULL,
      body_text TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (job_id, artifact_path)
    );

    CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_path
      ON job_artifacts (job_id, artifact_path);

    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dataset_items (
      dataset_id TEXT NOT NULL,
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      item_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dataset_items_dataset_sequence
      ON dataset_items (dataset_id, sequence);

    CREATE TABLE IF NOT EXISTS key_value_stores (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS key_value_records (
      store_id TEXT NOT NULL,
      key TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      value_text TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (store_id, key)
    );

    CREATE INDEX IF NOT EXISTS idx_key_value_records_store_updated
      ON key_value_records (store_id, updated_at);
  `);

  ensureColumn(db, 'request_queue_items', 'priority', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'request_queue_items', 'replay_state_json', 'TEXT');
  ensureColumn(db, 'request_queue_items', 'user_data_json', `TEXT NOT NULL DEFAULT '{}'`);
  ensureColumn(db, 'request_queue_items', 'lane_key', 'TEXT');
  ensureColumn(db, 'request_queue_items', 'dispatched_at', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_request_queue_items_job_priority
      ON request_queue_items (job_id, status, priority DESC, enqueued_at ASC, unique_key ASC);
  `);
  return db;
}
