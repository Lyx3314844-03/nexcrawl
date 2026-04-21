/**
 * ExportManager - Multi-format data export for crawl results.
 *
 * Supports CSV, JSON, JSONL/NDJSON, and database sink (PostgreSQL/MySQL/MongoDB placeholder)
 * output. Equivalent to Scrapy's Feed Exports and Crawlee's Dataset.export()
 *
 * Usage:
 *   const exporter = new ExportManager({ datasetStore });
 *   await exporter.exportToCsv({ datasetId: 'default', outputPath: 'results.csv' });
 *   await exporter.exportToJson({ datasetId: 'default', outputPath: 'results.json' });
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { DatasetStore } from './dataset-store.js';
import { createLogger } from '../core/logger.js';
import { ensureDir } from '../utils/fs.js';
import { dirname, join, resolve } from 'node:path';

const log = createLogger('export-manager');

function normalizeBackend(value, destination = '') {
  const explicit = String(value ?? '').trim().toLowerCase();
  if (explicit) {
    return explicit;
  }

  return resolveDestinationType(destination);
}

function quoteSqlIdentifier(identifier, dialect = 'postgres') {
  const value = String(identifier ?? '').trim();
  if (!value) {
    throw new Error('SQL identifier is required');
  }

  const parts = value.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }

  if (dialect === 'mysql') {
    return parts.map((part) => `\`${part}\``).join('.');
  }

  return parts.map((part) => `"${part}"`).join('.');
}

function createStructuredRecord(item, output, context = {}) {
  const exportedAt = context.exportedAt ?? new Date().toISOString();
  return {
    ...item,
    _omnicrawl: {
      jobId: context.jobId ?? null,
      kind: context.kind ?? null,
      workflowName: context.workflowName ?? null,
      exportedAt,
      backend: normalizeBackend(output.backend, output.path),
    },
  };
}

async function insertSqlJsonRows({ client, output, items, dialect, context }) {
  if (!client) {
    throw new Error(`${dialect} export requires a client`);
  }

  const runner = typeof client.query === 'function'
    ? (...args) => client.query(...args)
    : typeof client.execute === 'function'
      ? (...args) => client.execute(...args)
      : null;

  if (!runner) {
    throw new Error(`${dialect} client must expose query() or execute()`);
  }

  const table = quoteSqlIdentifier(output.table, dialect);
  const jsonColumn = quoteSqlIdentifier(output.jsonColumn ?? 'payload', dialect);
  const metadataColumn = output.metadataColumn
    ? quoteSqlIdentifier(output.metadataColumn, dialect)
    : null;
  const records = items.map((item) => createStructuredRecord(item, output, context));
  const batches = [];
  const batchSize = output.batchSize ?? 100;

  for (let index = 0; index < records.length; index += batchSize) {
    batches.push(records.slice(index, index + batchSize));
  }

  let insertedCount = 0;

  for (const batch of batches) {
    if (batch.length === 0) {
      continue;
    }

    const values = [];
    const params = [];

    for (const item of batch) {
      const payload = JSON.stringify(item);
      const metadata = JSON.stringify(item._omnicrawl);

      if (dialect === 'mysql') {
        params.push(payload);
        if (metadataColumn) {
          params.push(metadata);
          values.push('(?, ?)');
        } else {
          values.push('(?)');
        }
      } else {
        const payloadParam = params.length + 1;
        params.push(payload);
        if (metadataColumn) {
          const metadataParam = params.length + 1;
          params.push(metadata);
          values.push(`($${payloadParam}, $${metadataParam})`);
        } else {
          values.push(`($${payloadParam})`);
        }
      }
    }

    const columnList = metadataColumn
      ? `${jsonColumn}, ${metadataColumn}`
      : `${jsonColumn}`;
    const statement = `INSERT INTO ${table} (${columnList}) VALUES ${values.join(', ')}`;
    await runner(statement, params);
    insertedCount += batch.length;
  }

  return {
    backend: dialect,
    insertedCount,
    batches: batches.length,
    target: output.table,
  };
}

async function insertMongoRows({ client, output, items, context }) {
  if (!client) {
    throw new Error('mongodb export requires a client');
  }

  const dbName = output.database;
  const collectionName = output.collection;
  if (!dbName || !collectionName) {
    throw new Error('mongodb export requires database and collection');
  }

  const db = typeof client.db === 'function' ? client.db(dbName) : null;
  const collection = db?.collection?.(collectionName);
  if (!collection || typeof collection.insertMany !== 'function') {
    throw new Error('mongodb client must expose db(name).collection(name).insertMany()');
  }

  const documents = items.map((item) => createStructuredRecord(item, output, context));
  if (documents.length === 0) {
    return {
      backend: 'mongodb',
      insertedCount: 0,
      batches: 0,
      target: `${dbName}.${collectionName}`,
    };
  }

  const result = await collection.insertMany(documents, {
    ordered: output.ordered ?? true,
  });

  return {
    backend: 'mongodb',
    insertedCount: result?.insertedCount ?? documents.length,
    batches: 1,
    target: `${dbName}.${collectionName}`,
  };
}

/**
 * Create entries for the new data sinks (Elasticsearch, Kafka, Webhook).
 */
async function createNewSinkEntries(clients = {}) {
  const entries = [];

  // Elasticsearch
  try {
    const { createElasticsearchSink } = await import('./elasticsearch-sink.js');
    entries.push(['elasticsearch', async ({ items, output, context }) => {
      const sink = await createElasticsearchSink(output.config ?? {});
      return sink(items);
    }]);
  } catch { /* elasticsearch-sink not available */ }

  // Kafka
  try {
    const { createKafkaSink } = await import('./kafka-sink.js');
    entries.push(['kafka', async ({ items, output, context }) => {
      const sink = await createKafkaSink(output.config ?? {});
      return sink(items);
    }]);
  } catch { /* kafka-sink not available */ }

  // Webhook
  try {
    const { createWebhookSink } = await import('./webhook-sink.js');
    entries.push(['webhook', async ({ items, output, context }) => {
      const sink = await createWebhookSink(output.config ?? {});
      return sink(items);
    }]);
  } catch { /* webhook-sink not available */ }

  return entries;
}

function createDefaultBackends(clients = {}) {
  return new Map([
    ['postgres', async ({ items, output, context }) => insertSqlJsonRows({
      client: output.client ?? clients.postgres ?? null,
      output,
      items,
      dialect: 'postgres',
      context,
    })],
    ['mysql', async ({ items, output, context }) => insertSqlJsonRows({
      client: output.client ?? clients.mysql ?? null,
      output,
      items,
      dialect: 'mysql',
      context,
    })],
    ['mongodb', async ({ items, output, context }) => insertMongoRows({
      client: output.client ?? clients.mongodb ?? null,
      output,
      items,
      context,
    })],
    ['sink', async ({ items, output }) => {
      if (typeof output.sink !== 'function') {
        throw new Error('sink export requires a sink(batch) function');
      }

      const batchSize = output.batchSize ?? 100;
      let insertedCount = 0;
      let batches = 0;

      for (let index = 0; index < items.length; index += batchSize) {
        const batch = items.slice(index, index + batchSize);
        const result = await output.sink(batch);
        insertedCount += result?.insertedCount ?? batch.length;
        batches += 1;
      }

      return {
        backend: 'sink',
        insertedCount,
        batches,
        target: output.name ?? 'sink',
      };
    }],
  ]);
}

/**
 * Flatten a nested object into dot-notation keys for CSV headers.
 * @param {Object} obj
 * @param {string} [prefix]
 * @returns {Object}
 */
function flattenObject(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, fullKey));
    } else if (Array.isArray(value)) {
      result[fullKey] = JSON.stringify(value);
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

/**
 * Collect all unique keys from a list of flat objects (for CSV headers).
 * @param {Object[]} items
 * @returns {string[]}
 */
function collectHeaders(items) {
  const headerSet = new Set();
  for (const item of items) {
    const flat = flattenObject(item);
    for (const key of Object.keys(flat)) {
      headerSet.add(key);
    }
  }
  return [...headerSet].sort();
}

/**
 * Escape a CSV field value.
 * @param {*} value
 * @returns {string}
 */
function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert items to CSV string.
 * @param {Object[]} items
 * @param {Object} [options]
 * @param {string[]} [options.headers] - Force specific column order
 * @param {boolean} [options.flatten=true] - Flatten nested objects
 * @param {boolean} [options.includeHeader=true] - Include header row
 * @returns {string}
 */
export function itemsToCsv(items, options = {}) {
  const { flatten = true, includeHeader = true, headers: forcedHeaders } = options;

  const processedItems = flatten ? items.map(item => flattenObject(item)) : items;
  const headers = forcedHeaders || collectHeaders(processedItems);

  const lines = [];

  if (includeHeader) {
    lines.push(headers.map(escapeCsvField).join(','));
  }

  for (const item of processedItems) {
    const row = headers.map(h => escapeCsvField(item[h] ?? ''));
    lines.push(row.join(','));
  }

  return lines.join('\n') + '\n';
}

/**
 * Convert items to JSON string (array of objects).
 * @param {Object[]} items
 * @param {Object} [options]
 * @param {number} [options.indent=2] - JSON indentation
 * @returns {string}
 */
export function itemsToJson(items, options = {}) {
  const { indent = 2 } = options;
  return JSON.stringify(items, null, indent) + '\n';
}

/**
 * Convert items to JSONL (newline-delimited JSON).
 * @param {Object[]} items
 * @returns {string}
 */
export function itemsToJsonl(items) {
  return items.map(item => JSON.stringify(item)).join('\n') + '\n';
}

async function readAllNdjsonFile(targetPath) {
  try {
    const raw = await readFile(targetPath, 'utf8');
    return raw.trim()
      ? raw.trim().split('\n').map((line) => JSON.parse(line))
      : [];
  } catch {
    return [];
  }
}

function normalizeFormat(format, outputPath = '') {
  const explicit = String(format ?? '').trim().toLowerCase();
  if (explicit) {
    return explicit === 'ndjson' ? 'jsonl' : explicit;
  }

  const lowered = String(outputPath).toLowerCase();
  if (lowered.endsWith('.csv')) return 'csv';
  if (lowered.endsWith('.json')) return 'json';
  if (lowered.endsWith('.jsonl') || lowered.endsWith('.ndjson')) return 'jsonl';
  return 'json';
}

function extensionForFormat(format) {
  switch (normalizeFormat(format)) {
    case 'csv':
      return '.csv';
    case 'jsonl':
      return '.ndjson';
    case 'json':
    default:
      return '.json';
  }
}

function contentTypeForFormat(format) {
  switch (normalizeFormat(format)) {
    case 'csv':
      return 'text/csv; charset=utf-8';
    case 'jsonl':
      return 'application/x-ndjson; charset=utf-8';
    case 'json':
    default:
      return 'application/json; charset=utf-8';
  }
}

function sanitizeHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      output[String(key)] = String(value);
    }
  }
  return output;
}

function normalizeLegacyOutputPath(options = {}) {
  return options.outputPath ?? options.path ?? null;
}

function resolveLegacyExportArgs(firstArg, secondArg) {
  if (Array.isArray(firstArg)) {
    return {
      items: firstArg,
      options: secondArg ?? {},
    };
  }

  return {
    items: null,
    options: firstArg ?? {},
  };
}

function buildSignatureHeaders({ payloadText, output, sentAt }) {
  if (!output?.signingSecret) {
    return {};
  }

  const algorithm = String(output.signatureAlgorithm ?? 'sha256').toLowerCase();
  const signature = createHmac(algorithm, output.signingSecret)
    .update(`${sentAt}.${payloadText}`)
    .digest('hex');

  return {
    [String(output.signatureHeader ?? 'x-omnicrawl-signature')]: `${algorithm}=${signature}`,
    'x-omnicrawl-timestamp': sentAt,
  };
}

function resolveDestinationType(path = '') {
  const value = String(path ?? '').trim().toLowerCase();
  if (value === 'stdout:' || value === 'stdout') {
    return 'stdout';
  }
  if (/^https?:\/\//.test(value)) {
    return 'http';
  }
  return 'file';
}

export async function deliverExportPlan({ destination, serialized, format, output = {}, logger = log } = {}) {
  const type = resolveDestinationType(destination);
  const contentType = contentTypeForFormat(format);

  if (type === 'stdout') {
    process.stdout.write(serialized);
    return {
      delivery: 'stdout',
      path: 'stdout:',
      bytes: Buffer.byteLength(serialized),
      contentType,
      delivered: true,
      attempts: 1,
      reason: null,
      status: null,
    };
  }

  if (type === 'http') {
    const maxAttempts = Math.max(1, Number(output.retryAttempts ?? 0) + 1);
    const baseBackoffMs = Math.max(0, Number(output.retryBackoffMs ?? 1000));
    let lastError = null;
    let lastStatus = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const sentAt = new Date().toISOString();
        const response = await fetch(destination, {
          method: String(output.method ?? 'POST').toUpperCase(),
          headers: {
            'content-type': contentType,
            ...sanitizeHeaders(output.headers),
            ...buildSignatureHeaders({
              payloadText: serialized,
              output,
              sentAt,
            }),
          },
          body: serialized,
          signal: AbortSignal.timeout(Number(output.timeoutMs ?? 10000)),
        });

        lastStatus = response.status;
        if (!response.ok) {
          throw new Error(`export destination responded with status ${response.status}`);
        }

        return {
          delivery: 'http',
          path: destination,
          bytes: Buffer.byteLength(serialized),
          contentType,
          delivered: true,
          attempts: attempt,
          reason: null,
          status: response.status,
        };
      } catch (error) {
        lastError = error;
        logger?.warn?.('HTTP export delivery failed', {
          path: destination,
          attempt,
          maxAttempts,
          error: error?.message ?? String(error),
        });

        if (attempt < maxAttempts && baseBackoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, baseBackoffMs * attempt));
        }
      }
    }

    return {
      delivery: 'http',
      path: destination,
      bytes: Buffer.byteLength(serialized),
      contentType,
      delivered: false,
      attempts: maxAttempts,
      reason: lastError?.message ?? 'export delivery failed',
      status: lastStatus,
    };
  }

  await ensureDir(dirname(destination));
  await writeFile(destination, serialized, 'utf8');
  return {
    delivery: 'file',
    path: destination,
    bytes: Buffer.byteLength(serialized),
    contentType,
    delivered: true,
    attempts: 1,
    reason: null,
    status: null,
  };
}

export class ExportManager {
  /**
   * @param {Object} options
   * @param {string} [options.projectRoot] - Project root directory
   * @param {string|null} [options.runDir] - Job run directory
   * @param {import('./sqlite-data-plane.js').SqliteDataPlane|null} [options.dataPlane] - Shared data plane
   * @param {string|null} [options.jobId] - Job id for shared data exports
   * @param {Object} [options.clients] - Named export backend clients
   * @param {Map<string, Function>|Object|null} [options.backends] - Named export backend handlers
   */
  constructor({ projectRoot = process.cwd(), runDir = null, dataPlane = null, jobId = null, workflowName = null, exportOutbox = null, clients = {}, backends = null } = {}) {
    this.projectRoot = projectRoot;
    this.runDir = runDir;
    this.dataPlane = dataPlane;
    this.jobId = jobId;
    this.workflowName = workflowName;
    this.exportOutbox = exportOutbox;
    this.clients = clients;
    this.backends = createDefaultBackends(clients);

    if (backends instanceof Map) {
      for (const [name, handler] of backends.entries()) {
        this.registerBackend(name, handler);
      }
    } else if (backends && typeof backends === 'object') {
      for (const [name, handler] of Object.entries(backends)) {
        this.registerBackend(name, handler);
      }
    }
  }

  registerBackend(name, handler) {
    if (handler && typeof handler === 'object' && typeof handler.write === 'function') {
      handler = async ({ items, output, kind, format, context, clients }) => handler.write({
        items,
        output,
        kind,
        format,
        context,
        clients,
      });
    }

    if (!name || typeof handler !== 'function') {
      throw new Error('registerBackend requires a backend name and handler');
    }

    this.backends.set(String(name).trim().toLowerCase(), handler);
    return this;
  }

  /**
   * Load items from a dataset store.
   * @param {Object} options
   * @param {string} options.datasetId
   * @param {number} [options.limit]
   * @param {string} [options.query]
   * @returns {Promise<Object[]>}
   */
  async _loadItems({ datasetId, limit, query }) {
    const result = await DatasetStore.listItems({
      projectRoot: this.projectRoot,
      datasetId,
      offset: 0,
      limit: limit ?? 100000,
      query: query ?? '',
    });
    return result.items;
  }

  async _loadJobItems({ kind = 'results', limit, query } = {}) {
    const normalizedKind = String(kind ?? 'results').trim().toLowerCase();

    if (normalizedKind === 'results') {
      if (this.dataPlane && this.jobId) {
        await this.dataPlane.init();
        return this.dataPlane.listResults(this.jobId, {
          offset: 0,
          limit: limit ?? 100000,
          query: query ?? '',
        }).items;
      }

      if (!this.runDir) {
        return [];
      }

      const items = await readAllNdjsonFile(join(this.runDir, 'results.ndjson'));
      return query
        ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(String(query).toLowerCase()))
        : items.slice(0, limit ?? 100000);
    }

    if (normalizedKind === 'events') {
      if (this.dataPlane && this.jobId) {
        await this.dataPlane.init();
        return this.dataPlane.listEvents(this.jobId, {
          offset: 0,
          limit: limit ?? 100000,
          query: query ?? '',
        }).items;
      }

      if (!this.runDir) {
        return [];
      }

      const items = await readAllNdjsonFile(join(this.runDir, 'events.ndjson'));
      return query
        ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(String(query).toLowerCase()))
        : items.slice(0, limit ?? 100000);
    }

    if (normalizedKind === 'summary') {
      let summary = null;

      if (this.dataPlane && this.jobId) {
        await this.dataPlane.init();
        summary = this.dataPlane.readArtifactJson(this.jobId, 'summary.json');
      } else if (this.runDir) {
        try {
          summary = JSON.parse(await readFile(join(this.runDir, 'summary.json'), 'utf8'));
        } catch {
          summary = null;
        }
      }

      return summary ? [summary] : [];
    }

    throw new Error(`Unsupported export kind: ${normalizedKind}`);
  }

  async _loadExportItems(options = {}) {
    if (options.datasetId) {
      return this._loadItems(options);
    }

    return this._loadJobItems(options);
  }

  _serialize(items, format, options = {}) {
    const normalizedFormat = normalizeFormat(format, options.outputPath);

    if (normalizedFormat === 'csv') {
      return itemsToCsv(items, {
        flatten: options.flatten ?? true,
        headers: options.columns ?? options.headers,
      });
    }

    if (normalizedFormat === 'jsonl') {
      return itemsToJsonl(items);
    }

    if (normalizedFormat === 'json') {
      return itemsToJson(items, { indent: options.indent ?? 2 });
    }

    throw new Error(`Unsupported export format: ${normalizedFormat}`);
  }

  _resolveOutputPath(outputPath, kind, format) {
    if (outputPath) {
      if (resolveDestinationType(outputPath) !== 'file') {
        return outputPath;
      }
      return this.runDir && !/^[A-Za-z]:\\|^\//.test(outputPath)
        ? resolve(this.runDir, outputPath)
        : outputPath;
    }

    const baseDir = this.runDir ? join(this.runDir, 'exports') : resolve(this.projectRoot, 'exports');
    return join(baseDir, `${kind}${extensionForFormat(format)}`);
  }

  async _deliverOutput({ destination, serialized, format, output }) {
    return deliverExportPlan({
      destination,
      serialized,
      format,
      output,
      logger: log,
    });
  }

  async _deliverBackend({ items, output, kind, format }) {
    const backend = normalizeBackend(output.backend, output.path);
    const handler = this.backends.get(backend);
    if (!handler) {
      throw new Error(`Unsupported export backend: ${backend}`);
    }

    const result = await handler({
      items,
      format,
      kind,
      output,
      context: {
        jobId: this.jobId,
        kind,
        workflowName: output.workflowName ?? this.workflowName,
      },
      clients: this.clients,
    });

    return {
      delivery: backend,
      path: result?.target ?? output.table ?? output.collection ?? backend,
      bytes: result?.bytes ?? null,
      contentType: result?.contentType ?? 'application/json',
      delivered: result?.delivered ?? true,
      attempts: result?.attempts ?? 1,
      reason: result?.reason ?? null,
      status: result?.status ?? null,
      insertedCount: result?.insertedCount ?? items.length,
      batches: result?.batches ?? 1,
    };
  }

  /**
   * Export dataset items to a CSV file.
   *
   * @param {Object} options
   * @param {string} options.datasetId - Dataset to export
   * @param {string} options.outputPath - Output file path
   * @param {string[]} [options.headers] - Force specific column order
   * @param {boolean} [options.flatten=true] - Flatten nested objects
   * @param {number} [options.limit] - Max items to export
   * @returns {Promise<{ format: string, path: string, itemCount: number, bytes: number }>}
   */
  async exportToCsv(firstArg = {}, secondArg = {}) {
    const { items: providedItems, options } = resolveLegacyExportArgs(firstArg, secondArg);
    const items = providedItems ?? await this._loadExportItems(options);
    const csv = itemsToCsv(items, {
      flatten: options.flatten ?? true,
      headers: options.headers,
    });
    const outputPath = normalizeLegacyOutputPath(options);

    await ensureDir(dirname(outputPath));
    await writeFile(outputPath, csv, 'utf8');

    log.info('Exported CSV', { path: outputPath, items: items.length });
    return {
      format: 'csv',
      path: outputPath,
      itemCount: items.length,
      bytes: Buffer.byteLength(csv),
    };
  }

  /**
   * Export dataset items to a JSON file.
   *
   * @param {Object} options
   * @param {string} options.datasetId
   * @param {string} options.outputPath
   * @param {number} [options.indent=2]
   * @param {number} [options.limit]
   * @returns {Promise<{ format: string, path: string, itemCount: number, bytes: number }>}
   */
  async exportToJson(firstArg = {}, secondArg = {}) {
    const { items: providedItems, options } = resolveLegacyExportArgs(firstArg, secondArg);
    const items = providedItems ?? await this._loadExportItems(options);
    const json = itemsToJson(items, { indent: options.indent ?? 2 });
    const outputPath = normalizeLegacyOutputPath(options);

    await ensureDir(dirname(outputPath));
    await writeFile(outputPath, json, 'utf8');

    log.info('Exported JSON', { path: outputPath, items: items.length });
    return {
      format: 'json',
      path: outputPath,
      itemCount: items.length,
      bytes: Buffer.byteLength(json),
    };
  }

  /**
   * Export dataset items to JSONL file.
   *
   * @param {Object} options
   * @param {string} options.datasetId
   * @param {string} options.outputPath
   * @param {number} [options.limit]
   * @returns {Promise<{ format: string, path: string, itemCount: number, bytes: number }>}
   */
  async exportToJsonl(firstArg = {}, secondArg = {}) {
    const { items: providedItems, options } = resolveLegacyExportArgs(firstArg, secondArg);
    const items = providedItems ?? await this._loadExportItems(options);
    const jsonl = itemsToJsonl(items);
    const outputPath = normalizeLegacyOutputPath(options);

    await ensureDir(dirname(outputPath));
    await writeFile(outputPath, jsonl, 'utf8');

    log.info('Exported JSONL', { path: outputPath, items: items.length });
    return {
      format: 'jsonl',
      path: outputPath,
      itemCount: items.length,
      bytes: Buffer.byteLength(jsonl),
    };
  }

  /**
   * Stream export to a database (PostgreSQL/MySQL/MongoDB).
   * This is a pluggable sink - provide a `sink` function that handles insertion.
   *
   * @param {Object} options
   * @param {string} options.datasetId
   * @param {Function} options.sink - async (items) => { insertedCount } sink function
   * @param {number} [options.batchSize=100] - Items per batch
   * @param {number} [options.limit]
   * @returns {Promise<{ format: string, itemCount: number, batches: number }>}
   */
  async exportToSink(firstArg = {}, secondArg = {}) {
    const { items: providedItems, options } = resolveLegacyExportArgs(firstArg, secondArg);
    const items = providedItems ?? await this._loadExportItems(options);
    const batchSize = options.batchSize ?? 100;
    let totalInserted = 0;
    let batches = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const result = await options.sink(batch);
      totalInserted += result?.insertedCount ?? batch.length;
      batches += 1;
    }

    log.info('Exported to sink', { totalInserted, batches });
    return {
      format: 'sink',
      itemCount: totalInserted,
      batches,
    };
  }

  /**
   * Generic export method - auto-detects format from file extension.
   *
   * @param {Object} options
   * @param {string} options.datasetId
   * @param {string} options.outputPath
   * @returns {Promise<Object>}
   */
  /**
   * Flush any buffered data to disk. Called during teardown to ensure data is persisted.
   * @returns {Promise<void>}
   */
  async flush() {
    // ExportManager writes data immediately on each export() call,
    // so flush is a no-op by default. Subclasses may override this
    // to flush internal buffers.
    log.info('ExportManager flush - no buffered data to write');
  }

  async export(firstArg = {}, secondArg = {}) {
    const { items: providedItems, options } = resolveLegacyExportArgs(firstArg, secondArg);
    const outputPath = normalizeLegacyOutputPath(options);
    if (!outputPath) throw new Error('outputPath is required');

    if (outputPath.endsWith('.csv')) return this.exportToCsv(providedItems ?? options, providedItems ? options : {});
    if (outputPath.endsWith('.json')) return this.exportToJson(providedItems ?? options, providedItems ? options : {});
    if (outputPath.endsWith('.jsonl') || outputPath.endsWith('.ndjson')) return this.exportToJsonl(providedItems ?? options, providedItems ? options : {});

    throw new Error(`Unsupported export format: ${outputPath}. Use .csv, .json, or .jsonl`);
  }

  async exportConfigured(config = {}) {
    const enabled = config?.enabled !== false;
    const outputs = Array.isArray(config?.outputs) ? config.outputs : [];
    if (!enabled || outputs.length === 0) {
      return [];
    }

    const manifest = [];

    for (const entry of outputs) {
      const kind = String(entry.kind ?? 'results').trim().toLowerCase();
      const format = normalizeFormat(entry.format, entry.path);
      const items = await this._loadExportItems({
        kind,
        limit: entry.limit,
        query: entry.query,
      });
      const backend = normalizeBackend(entry.backend, entry.path);
      const resolvedPath = ['file', 'http', 'stdout'].includes(backend)
        ? this._resolveOutputPath(entry.path, kind, format)
        : entry.path ?? null;
      const serialized = ['file', 'http', 'stdout'].includes(backend)
        ? this._serialize(items, format, {
            ...entry,
            outputPath: resolvedPath,
          })
        : null;
      const delivery = ['file', 'http', 'stdout'].includes(backend)
        ? await this._deliverOutput({
            destination: resolvedPath,
            serialized,
            format,
            output: entry,
          })
        : await this._deliverBackend({
            items,
            output: entry,
            kind,
            format,
          });

      manifest.push({
        kind,
        format,
        backend,
        delivery: delivery.delivery,
        path: delivery.path,
        itemCount: items.length,
        bytes: delivery.bytes,
        contentType: delivery.contentType,
        delivered: delivery.delivered,
        attempts: delivery.attempts,
        reason: delivery.reason,
        status: delivery.status,
        insertedCount: delivery.insertedCount ?? null,
        batches: delivery.batches ?? null,
      });
      if (backend === 'http' && delivery.delivered === false && this.exportOutbox && entry.queueOnFailure !== false) {
        const queued = await this.exportOutbox.enqueueFailedDelivery({
          workflowName: this.workflowName,
          jobId: this.jobId,
          output: entry,
          serialized,
          format,
          destination: resolvedPath,
          manifest: manifest.at(-1),
        });
        if (queued) {
          manifest.at(-1).queued = true;
          manifest.at(-1).outboxId = queued.id;
        }
      }
      log.info('Exported configured output', {
        kind,
        format,
        backend,
        destination: delivery.delivery,
        path: delivery.path,
        items: items.length,
        delivered: delivery.delivered,
      });
    }

    return manifest;
  }
}

export default ExportManager;
