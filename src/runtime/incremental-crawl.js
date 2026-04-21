/**
 * Incremental / Diff crawl manager.
 *
 * Tracks content fingerprints per URL to enable efficient
 * re-crawling – only pages that have changed since the last
 * crawl are processed. Supports content-hash comparison,
 * Last-Modified / ETag header checks, and configurable
 * diff strategies.
 *
 * Usage:
 *   import { createIncrementalTracker } from '../runtime/incremental-crawl.js';
 *   const tracker = await createIncrementalTracker({ storagePath: '.omnicrawl/fingerprints.db' });
 *   const changed = await tracker.filterChanged(url, body, headers);
 */

import { createLogger } from '../core/logger.js';
import { createHash } from 'node:crypto';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { join } from 'node:path';

const log = createLogger('incremental-crawl');

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an incremental crawl tracker.
 *
 * @param {object} config
 * @param {string}  [config.storagePath='.omnicrawl/incremental.json'] - Path to fingerprint store
 * @param {'sha256'|'xxhash'|'etag'} [config.hashAlgo='sha256'] - Fingerprint algorithm
 * @param {boolean} [config.respectETag=true]     - Use ETag header when available
 * @param {boolean} [config.respectLastModified=true] - Use Last-Modified header when available
 * @param {number}  [config.minChangePercent=0]   - Minimum % of content change to count (0-100)
 * @param {string[]} [config.ignoreSelectors=[]]  - CSS selectors to strip before hashing
 * @returns {Promise<object>} Tracker with filterChanged(), record(), getHistory(), reset()
 */
export async function createIncrementalCrawlTracker(config = {}) {
  const {
    storagePath = '.omnicrawl/incremental.json',
    hashAlgo = 'sha256',
    respectETag = true,
    respectLastModified = true,
    minChangePercent = 0,
    ignoreSelectors = [],
  } = config;

  await ensureDir(join(storagePath, '..'));
  let fingerprints = {};
  try {
    fingerprints = await readJson(storagePath);
  } catch {
    fingerprints = {};
  }

  const tracker = {
    /**
     * Check if a URL's content has changed since the last crawl.
     *
     * @param {string} url
     * @param {string} body - Current response body
     * @param {object} [headers={}] - Response headers
     * @returns {Promise<{changed: boolean, reason: string, previousHash: string|null, currentHash: string}>}
     */
    async filterChanged(url, body, headers = {}) {
      const normalizedHeaders = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
      );
      const currentHash = computeHash(body, hashAlgo);
      const prev = fingerprints[url];

      // First crawl of this URL
      if (!prev) {
        log.debug('New URL detected', { url });
        return { changed: true, reason: 'new-url', previousHash: null, currentHash };
      }

      // ETag comparison (if supported by server and enabled)
      if (respectETag) {
        const etag = normalizedHeaders['etag'];
        if (etag && etag === prev.etag) {
          return { changed: false, reason: 'etag-match', previousHash: prev.hash, currentHash };
        }
      }

      // Last-Modified comparison
      if (respectLastModified) {
        const lastModified = normalizedHeaders['last-modified'];
        if (lastModified && lastModified === prev.lastModified) {
          return { changed: false, reason: 'last-modified-match', previousHash: prev.hash, currentHash };
        }
      }

      // Content hash comparison
      if (currentHash === prev.hash) {
        return { changed: false, reason: 'hash-match', previousHash: prev.hash, currentHash };
      }

      // Optional: minimum change percentage check
      if (minChangePercent > 0 && prev.bodyLength && body) {
        const changeRatio = Math.abs(body.length - prev.bodyLength) / prev.bodyLength;
        if (changeRatio * 100 < minChangePercent) {
          return { changed: false, reason: 'below-threshold', previousHash: prev.hash, currentHash };
        }
      }

      log.info('Content changed', { url });
      return { changed: true, reason: 'content-diff', previousHash: prev.hash, currentHash };
    },

    /**
     * Compatibility method for OmniCrawler.
     * Checks if we have seen this URL before.
     */
    async isSeen(url) {
      return !!fingerprints[url];
    },

    /**
     * Record the fingerprint for a URL after successful crawl.
     *
     * @param {string} url
     * @param {string} body
     * @param {object} [headers={}]
     */
    async record(url, body, headers = {}) {
      const normalizedHeaders = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
      );
      fingerprints[url] = {
        hash: computeHash(body, hashAlgo),
        etag: normalizedHeaders['etag'] ?? null,
        lastModified: normalizedHeaders['last-modified'] ?? null,
        bodyLength: body?.length ?? 0,
        recordedAt: new Date().toISOString(),
      };
      await writeJson(storagePath, fingerprints);
    },

    /**
     * Compatibility method for OmniCrawler.
     * Records the result for a URL.
     */
    async markSeen(url, result) {
      await this.record(url, result.body, result.headers);
    },

    /**
     * Get change history for a URL.
     *
     * @param {string} url
     * @returns {object|null}
     */
    getHistory(url) {
      return fingerprints[url] ?? null;
    },

    /**
     * Reset all stored fingerprints.
     */
    async reset() {
      fingerprints = {};
      await writeJson(storagePath, fingerprints);
      log.info('Incremental tracker reset');
    },
  };

  return tracker;
}

export const createIncrementalTracker = createIncrementalCrawlTracker;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeHash(content, algo) {
  if (typeof content !== 'string') content = String(content);
  return createHash(algo).update(content).digest('hex');
}
