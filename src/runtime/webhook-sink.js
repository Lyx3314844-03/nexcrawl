/**
 * Webhook data sink.
 *
 * Sends crawl results to one or more HTTP webhook endpoints via
 * POST requests with retry logic, HMAC signing, and batch chunking.
 *
 * Usage:
 *   import { createWebhookSink } from '../runtime/webhook-sink.js';
 *   const sink = await createWebhookSink({ url: 'https://example.com/webhook', secret: 'hmac-key' });
 *   await sink(batch);
 */

import { createLogger } from '../core/logger.js';
import { AppError } from '../core/errors.js';
import { createHmac } from 'node:crypto';

const log = createLogger('webhook-sink');

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a webhook sink.
 *
 * @param {object} config
 * @param {string}   config.url           - Webhook endpoint URL
 * @param {string}   [config.secret]      - HMAC signing secret
 * @param {string}   [config.algorithm='sha256'] - HMAC algorithm
 * @param {string}   [config.headerName='X-OmniCrawl-Signature'] - Signature header name
 * @param {object}   [config.headers={}]  - Additional HTTP headers
 * @param {string}   [config.format='json'] - 'json' | 'jsonl' | 'csv'
 * @param {number}   [config.batchSize=100]  - Items per POST request
 * @param {number}   [config.retries=3]     - Retry count on failure
 * @param {number}   [config.retryDelayMs=1000] - Base retry delay (exponential backoff)
 * @param {number}   [config.timeoutMs=30000]   - Per-request timeout
 * @returns {Promise<function>} Async sink function: (batch) => Promise<{insertedCount}>
 */
export async function createWebhookSink(config) {
  const {
    url,
    secret,
    algorithm = 'sha256',
    headerName = 'X-OmniCrawl-Signature',
    headers: extraHeaders = {},
    format = 'json',
    batchSize = 100,
    retries = 3,
    retryDelayMs = 1000,
    timeoutMs = 30_000,
  } = config;

  if (!url) throw new AppError(400, 'Webhook URL is required');

  /**
   * @param {Array<object>} batch
   * @returns {Promise<{insertedCount}>}
   */
  return async function sink(batch) {
    let insertedCount = 0;

    for (let i = 0; i < batch.length; i += batchSize) {
      const chunk = batch.slice(i, i + batchSize);
      const payload = serializePayload(chunk, format);

      const headers = {
        'Content-Type': format === 'csv' ? 'text/csv' : 'application/json',
        ...extraHeaders,
      };

      if (secret) {
        const sig = createHmac(algorithm, secret).update(payload).digest('hex');
        headers[headerName] = `${algorithm}=${sig}`;
      }

      const success = await deliverWithRetry(url, {
        method: 'POST',
        headers,
        body: payload,
        timeout: timeoutMs,
      }, retries, retryDelayMs);

      if (success) insertedCount += chunk.length;
    }

    log.info('Webhook sink complete', { insertedCount });
    return { insertedCount };
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function serializePayload(items, format) {
  switch (format) {
    case 'jsonl':
      return items.map(i => JSON.stringify(i)).join('\n');
    case 'csv':
      return itemsToCsv(items);
    case 'json':
    default:
      return JSON.stringify(items);
  }
}

function itemsToCsv(items) {
  if (!items.length) return '';
  const headers = [...new Set(items.flatMap(i => Object.keys(i)))];
  const rows = items.map(item =>
    headers.map(h => JSON.stringify(item[h] ?? '')).join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

async function deliverWithRetry(url, opts, maxRetries, baseDelay) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeout);
      const resp = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);

      if (resp.ok) return true;

      if (resp.status >= 500 && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        log.warn('Webhook delivery retry', { attempt, status: resp.status, delay });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      log.error('Webhook delivery failed', { status: resp.status });
      return false;
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        log.warn('Webhook delivery error, retrying', { attempt, error: err.message, delay });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      log.error('Webhook delivery exhausted retries', { error: err.message });
      return false;
    }
  }
  return false;
}
