/**
 * Elasticsearch data sink.
 *
 * Exports crawl results to an Elasticsearch cluster using the
 * _bulk API for efficient batch indexing.
 *
 * Usage:
 *   import { createElasticsearchSink } from '../runtime/elasticsearch-sink.js';
 *   const sink = await createElasticsearchSink({ node: 'http://localhost:9200', index: 'crawl-results' });
 *   await sink(batch);
 */

import { createLogger } from '../core/logger.js';
import { AppError } from '../core/errors.js';

const log = createLogger('elasticsearch-sink');

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an Elasticsearch sink.
 *
 * @param {object} config
 * @param {string}   config.node       - Elasticsearch node URL (e.g. http://localhost:9200)
 * @param {string}   config.index      - Target index name
 * @param {string}   [config.pipeline] - Ingest pipeline name
 * @param {string}   [config.apiKey]   - API key for authentication
 * @param {string}   [config.username] - Basic auth username
 * @param {string}   [config.password] - Basic auth password
 * @param {number}   [config.batchSize=500] - Documents per bulk request
 * @param {object}   [config.mapping]  - Custom index mapping to create on init
 * @returns {Promise<function>} Async sink function: (batch) => Promise<{insertedCount}>
 */
export async function createElasticsearchSink(config) {
  const {
    node,
    index,
    pipeline,
    apiKey,
    username,
    password,
    batchSize = 500,
    mapping,
  } = config;

  if (!node || !index) throw new AppError(400, 'Elasticsearch node and index are required');

  const headers = { 'Content-Type': 'application/x-ndjson' };
  if (apiKey) {
    headers['Authorization'] = `ApiKey ${apiKey}`;
  } else if (username && password) {
    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  // Create index with mapping if specified
  if (mapping) {
    try {
      const resp = await fetch(`${node}/${index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(mapping),
      });
      if (resp.ok) {
        log.info('Elasticsearch index created', { index });
      } else {
        log.warn('Elasticsearch index creation skipped', { index });
      }
    } catch (err) {
      log.warn('Elasticsearch index creation error', { error: err.message });
    }
  }

  /**
   * @param {Array<object>} batch
   * @returns {Promise<{insertedCount: number}>}
   */
  return async function sink(batch) {
    let insertedCount = 0;
    for (let i = 0; i < batch.length; i += batchSize) {
      const chunk = batch.slice(i, i + batchSize);
      const body = chunk.map(doc => {
        const header = { _index: index };
        if (pipeline) header.pipeline = pipeline;
        if (doc._id) {
          header._id = doc._id;
          delete doc._id;
        }
        return JSON.stringify({ index: header }) + '\n' + JSON.stringify(doc) + '\n';
      }).join('');

      const resp = await fetch(`${node}/_bulk`, {
        method: 'POST',
        headers,
        body,
      });

      if (!resp.ok) {
        const text = await resp.text();
        log.error('Elasticsearch bulk insert failed', { status: resp.status, body: text.slice(0, 200) });
        continue;
      }

      const result = await resp.json();
      insertedCount += result.items?.filter(i => i.index?.status === 201).length ?? 0;
    }
    log.info('Elasticsearch sink complete', { insertedCount });
    return { insertedCount };
  };
}
