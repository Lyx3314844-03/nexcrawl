import {
  openControlPlaneDatabase,
  nowIso,
  encodeJson,
  decodeJson,
} from './sqlite-control-plane.js';

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function paginate(items, { offset = 0, limit = 50 } = {}) {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(1, limit);
  return {
    total: items.length,
    offset: safeOffset,
    limit: safeLimit,
    items: items.slice(safeOffset, safeOffset + safeLimit),
  };
}

function matchesQuery(item, query) {
  if (!query) {
    return true;
  }

  return JSON.stringify(item).toLowerCase().includes(String(query).toLowerCase());
}

function toDatasetItem(row) {
  return decodeJson(row.item_json, null);
}

function toKvRecord(row) {
  if (!row) {
    return null;
  }

  return {
    key: row.key,
    fileName: row.file_name,
    contentType: row.content_type,
    bytes: Number(row.bytes ?? 0),
    updatedAt: row.updated_at,
    value: row.content_type === 'application/json' ? decodeJson(row.value_text, null) : row.value_text,
  };
}

export class SqliteDataPlane {
  constructor({ dbPath } = {}) {
    this.dbPath = dbPath;
    this.db = null;
    this.initPromise = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.db = await openControlPlaneDatabase(this.dbPath);
      })();
    }

    await this.initPromise;
    return this;
  }

  requireDb() {
    if (!this.db) {
      throw new Error('SqliteDataPlane.init() must complete before use');
    }

    return this.db;
  }

  close() {
    this.db?.close();
    this.db = null;
    this.initPromise = null;
  }

  appendEvent(jobId, event) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO job_events (job_id, sequence, type, at, payload_json)
      VALUES (@jobId, @sequence, @type, @at, @payloadJson)
      ON CONFLICT(job_id, sequence) DO UPDATE SET
        type = excluded.type,
        at = excluded.at,
        payload_json = excluded.payload_json
    `).run({
      jobId,
      sequence: Number(event.sequence ?? 0),
      type: String(event.type ?? ''),
      at: event.at ?? nowIso(),
      payloadJson: encodeJson(event, {}),
    });
  }

  listEvents(jobId, { offset = 0, limit = 100, query = '', type = '', afterSequence = 0 } = {}) {
    const db = this.requireDb();
    const rows = db.prepare(`
      SELECT payload_json
      FROM job_events
      WHERE job_id = @jobId
        AND sequence > @afterSequence
      ORDER BY sequence ASC
    `).all({
      jobId,
      afterSequence: Number(afterSequence ?? 0),
    });
    const events = rows
      .map((row) => decodeJson(row.payload_json, null))
      .filter(Boolean)
      .filter((item) => (!type ? true : item.type === type))
      .filter((item) => matchesQuery(item, query));

    return paginate(events, {
      offset: toInt(offset, 0),
      limit: toInt(limit, 100),
    });
  }

  appendResult(jobId, result) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO job_results (job_id, sequence, payload_json, created_at)
      VALUES (@jobId, @sequence, @payloadJson, @createdAt)
      ON CONFLICT(job_id, sequence) DO UPDATE SET
        payload_json = excluded.payload_json,
        created_at = excluded.created_at
    `).run({
      jobId,
      sequence: Number(result.sequence ?? 0),
      payloadJson: encodeJson(result, {}),
      createdAt: result.fetchedAt ?? nowIso(),
    });
  }

  listResults(jobId, { offset = 0, limit = 50, query = '' } = {}) {
    const db = this.requireDb();
    const rows = db.prepare(`
      SELECT payload_json
      FROM job_results
      WHERE job_id = ?
      ORDER BY sequence ASC
    `).all(jobId);
    const results = rows
      .map((row) => decodeJson(row.payload_json, null))
      .filter(Boolean)
      .filter((item) => matchesQuery(item, query));

    return paginate(results, {
      offset: toInt(offset, 0),
      limit: toInt(limit, 50),
    });
  }

  getResult(jobId, sequence) {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT payload_json
      FROM job_results
      WHERE job_id = ? AND sequence = ?
    `).get(jobId, Number(sequence));
    return row ? decodeJson(row.payload_json, null) : null;
  }

  writeArtifact(jobId, artifactPath, bodyText, { contentType = 'text/plain; charset=utf-8' } = {}) {
    const db = this.requireDb();
    const now = nowIso();
    const text = String(bodyText ?? '');
    db.prepare(`
      INSERT INTO job_artifacts (job_id, artifact_path, content_type, body_text, bytes, created_at, updated_at)
      VALUES (@jobId, @artifactPath, @contentType, @bodyText, @bytes, @createdAt, @updatedAt)
      ON CONFLICT(job_id, artifact_path) DO UPDATE SET
        content_type = excluded.content_type,
        body_text = excluded.body_text,
        bytes = excluded.bytes,
        updated_at = excluded.updated_at
    `).run({
      jobId,
      artifactPath,
      contentType,
      bodyText: text,
      bytes: Buffer.byteLength(text),
      createdAt: now,
      updatedAt: now,
    });
  }

  writeJsonArtifact(jobId, artifactPath, value) {
    this.writeArtifact(jobId, artifactPath, JSON.stringify(value, null, 2), {
      contentType: 'application/json',
    });
  }

  readArtifact(jobId, artifactPath) {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT artifact_path, content_type, body_text, bytes, created_at, updated_at
      FROM job_artifacts
      WHERE job_id = ? AND artifact_path = ?
    `).get(jobId, artifactPath);

    if (!row) {
      return null;
    }

    return {
      path: row.artifact_path,
      contentType: row.content_type,
      bodyText: row.body_text,
      bytes: Number(row.bytes ?? 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  readArtifactJson(jobId, artifactPath) {
    const record = this.readArtifact(jobId, artifactPath);
    if (!record) {
      return null;
    }

    return decodeJson(record.bodyText, null);
  }

  ensureDataset(datasetId, metadata = {}) {
    const db = this.requireDb();
    const now = nowIso();
    db.prepare(`
      INSERT INTO datasets (id, created_at, updated_at, item_count, metadata_json)
      VALUES (@id, @createdAt, @updatedAt, 0, @metadataJson)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run({
      id: datasetId,
      createdAt: now,
      updatedAt: now,
      metadataJson: encodeJson(metadata, {}),
    });
  }

  setDatasetMetadata(datasetId, metadata = {}) {
    const current = this.getDataset(datasetId);
    const nextMetadata = {
      ...(current?.metadata ?? {}),
      ...(metadata ?? {}),
    };
    const db = this.requireDb();
    db.prepare(`
      UPDATE datasets
      SET metadata_json = @metadataJson,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: datasetId,
      metadataJson: encodeJson(nextMetadata, {}),
      updatedAt: nowIso(),
    });
    return this.getDataset(datasetId);
  }

  addDatasetItem(datasetId, item) {
    this.ensureDataset(datasetId);
    const db = this.requireDb();
    const now = nowIso();
    db.prepare(`
      INSERT INTO dataset_items (dataset_id, item_json, created_at)
      VALUES (?, ?, ?)
    `).run(datasetId, encodeJson(item, {}), now);
    db.prepare(`
      UPDATE datasets
      SET item_count = item_count + 1,
          updated_at = ?
      WHERE id = ?
    `).run(now, datasetId);

    const dataset = this.getDataset(datasetId);
    return dataset?.itemCount ?? 0;
  }

  listDatasets(limit = 100) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT id, created_at, updated_at, item_count, metadata_json
      FROM datasets
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(Number(limit)).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      itemCount: Number(row.item_count ?? 0),
      metadata: decodeJson(row.metadata_json, {}),
    }));
  }

  getDataset(datasetId) {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT id, created_at, updated_at, item_count, metadata_json
      FROM datasets
      WHERE id = ?
    `).get(datasetId);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      itemCount: Number(row.item_count ?? 0),
      metadata: decodeJson(row.metadata_json, {}),
    };
  }

  listDatasetItems(datasetId, { offset = 0, limit = 50, query = '' } = {}) {
    const db = this.requireDb();
    const rows = db.prepare(`
      SELECT item_json
      FROM dataset_items
      WHERE dataset_id = ?
      ORDER BY sequence ASC
    `).all(datasetId);
    const items = rows
      .map((row) => toDatasetItem(row))
      .filter(Boolean)
      .filter((item) => matchesQuery(item, query));

    return paginate(items, {
      offset: toInt(offset, 0),
      limit: toInt(limit, 50),
    });
  }

  ensureKeyValueStore(storeId, metadata = {}) {
    const db = this.requireDb();
    const now = nowIso();
    db.prepare(`
      INSERT INTO key_value_stores (id, created_at, updated_at, metadata_json)
      VALUES (@id, @createdAt, @updatedAt, @metadataJson)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run({
      id: storeId,
      createdAt: now,
      updatedAt: now,
      metadataJson: encodeJson(metadata, {}),
    });
  }

  setKeyValueMetadata(storeId, metadata = {}) {
    const current = this.getKeyValueStore(storeId);
    const nextMetadata = {
      ...(current?.metadata ?? {}),
      ...(metadata ?? {}),
    };
    const db = this.requireDb();
    db.prepare(`
      UPDATE key_value_stores
      SET metadata_json = @metadataJson,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: storeId,
      metadataJson: encodeJson(nextMetadata, {}),
      updatedAt: nowIso(),
    });
    return this.getKeyValueStore(storeId);
  }

  setRecord(storeId, key, value, { contentType = 'application/json', fileName = `${key}.json` } = {}) {
    this.ensureKeyValueStore(storeId);
    const db = this.requireDb();
    const serialized = contentType === 'application/json' ? JSON.stringify(value, null, 2) : String(value ?? '');
    const now = nowIso();
    db.prepare(`
      INSERT INTO key_value_records (store_id, key, file_name, content_type, value_text, bytes, updated_at)
      VALUES (@storeId, @key, @fileName, @contentType, @valueText, @bytes, @updatedAt)
      ON CONFLICT(store_id, key) DO UPDATE SET
        file_name = excluded.file_name,
        content_type = excluded.content_type,
        value_text = excluded.value_text,
        bytes = excluded.bytes,
        updated_at = excluded.updated_at
    `).run({
      storeId,
      key,
      fileName,
      contentType,
      valueText: serialized,
      bytes: Buffer.byteLength(serialized),
      updatedAt: now,
    });
    db.prepare(`
      UPDATE key_value_stores
      SET updated_at = ?
      WHERE id = ?
    `).run(now, storeId);
    return this.getRecord(storeId, key);
  }

  listKeyValueStores(limit = 100) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT store.id, store.created_at, store.updated_at, store.metadata_json,
             COUNT(record.key) AS record_count
      FROM key_value_stores store
      LEFT JOIN key_value_records record ON record.store_id = store.id
      GROUP BY store.id, store.created_at, store.updated_at, store.metadata_json
      ORDER BY store.updated_at DESC
      LIMIT ?
    `).all(Number(limit)).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: decodeJson(row.metadata_json, {}),
      recordCount: Number(row.record_count ?? 0),
    }));
  }

  getKeyValueStore(storeId) {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT store.id, store.created_at, store.updated_at, store.metadata_json,
             COUNT(record.key) AS record_count
      FROM key_value_stores store
      LEFT JOIN key_value_records record ON record.store_id = store.id
      WHERE store.id = ?
      GROUP BY store.id, store.created_at, store.updated_at, store.metadata_json
    `).get(storeId);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: decodeJson(row.metadata_json, {}),
      recordCount: Number(row.record_count ?? 0),
      records: this.listRecords(storeId),
    };
  }

  listRecords(storeId) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM key_value_records
      WHERE store_id = ?
      ORDER BY updated_at DESC
    `).all(storeId).map((row) => ({
      key: row.key,
      fileName: row.file_name,
      contentType: row.content_type,
      bytes: Number(row.bytes ?? 0),
      updatedAt: row.updated_at,
    }));
  }

  getRecord(storeId, key) {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT *
      FROM key_value_records
      WHERE store_id = ? AND key = ?
    `).get(storeId, key);
    return toKvRecord(row);
  }

  readQueue(jobId) {
    const db = this.requireDb();
    const rows = db.prepare(`
      SELECT *
      FROM request_queue_items
      WHERE job_id = ?
      ORDER BY enqueued_at ASC, unique_key ASC
    `).all(jobId);

    const requests = {};
    const pending = [];

    for (const row of rows) {
      const record = {
        uniqueKey: row.unique_key,
        url: row.url,
        method: row.method,
        body: row.body ?? undefined,
        depth: Number(row.depth ?? 0),
        parentUrl: row.parent_url ?? null,
        label: row.label ?? null,
        metadata: decodeJson(row.metadata_json, {}),
        status: row.status,
        enqueueCount: Number(row.enqueue_count ?? 1),
        enqueuedAt: row.enqueued_at,
        updatedAt: row.updated_at,
        handledAt: row.handled_at ?? null,
        failedAt: row.failed_at ?? null,
        lastError: row.last_error ?? null,
        finalUrl: row.final_url ?? null,
        responseStatus: row.response_status ?? null,
      };

      requests[record.uniqueKey] = record;
      if (record.status === 'pending') {
        pending.push(record.uniqueKey);
      }
    }

    return {
      version: 1,
      createdAt: null,
      updatedAt: rows.at(-1)?.updated_at ?? null,
      pending,
      requests,
    };
  }

  pruneTerminalJobData({ retentionMs = 7 * 24 * 60 * 60 * 1000, limit = 100 } = {}) {
    const db = this.requireDb();
    const threshold = new Date(Date.now() - retentionMs).toISOString();
    const jobs = db.prepare(`
      SELECT id
      FROM jobs
      WHERE status IN ('completed', 'failed', 'interrupted')
        AND finished_at IS NOT NULL
        AND finished_at <= ?
      ORDER BY finished_at ASC
      LIMIT ?
    `).all(threshold, Number(limit));

    const pruned = {
      jobs: 0,
      events: 0,
      results: 0,
      artifacts: 0,
      queueItems: 0,
      datasetItems: 0,
      datasets: 0,
      keyValueRecords: 0,
      keyValueStores: 0,
    };

    for (const job of jobs) {
      const datasetId = job.id;
      const storeId = job.id;
      pruned.events += db.prepare('DELETE FROM job_events WHERE job_id = ?').run(job.id).changes;
      pruned.results += db.prepare('DELETE FROM job_results WHERE job_id = ?').run(job.id).changes;
      pruned.artifacts += db.prepare('DELETE FROM job_artifacts WHERE job_id = ?').run(job.id).changes;
      pruned.queueItems += db.prepare('DELETE FROM request_queue_items WHERE job_id = ?').run(job.id).changes;
      pruned.datasetItems += db.prepare('DELETE FROM dataset_items WHERE dataset_id = ?').run(datasetId).changes;
      pruned.datasets += db.prepare('DELETE FROM datasets WHERE id = ?').run(datasetId).changes;
      pruned.keyValueRecords += db.prepare('DELETE FROM key_value_records WHERE store_id = ?').run(storeId).changes;
      pruned.keyValueStores += db.prepare('DELETE FROM key_value_stores WHERE id = ?').run(storeId).changes;
      pruned.jobs += 1;
    }

    return pruned;
  }
}
