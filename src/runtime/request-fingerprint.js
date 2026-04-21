/**
 * RequestFingerprint - URL normalization and request deduplication.
 *
 * Crawlee uses `Request.fingerprint()` which normalizes URLs by sorting query
 * parameters, removing trailing slashes, and lowercasing hostnames.  This
 * module provides the same capability plus configurable normalization.
 *
 * Equivalent to Crawlee's `Request.fingerprint()` and Scrapy's `request.fingerprint()`.
 */

import { createHash } from 'node:crypto';
import { buildRequestUniqueKey } from './request-queue.js';

/**
 * @typedef {Object} FingerprintConfig
 * @property {boolean} [sortQueryParams=true] - Sort URL query parameters alphabetically
 * @property {boolean} [removeTrailingSlash=true] - Remove trailing slashes from paths
 * @property {boolean} [lowercaseHostname=true] - Lowercase the hostname
 * @property {boolean} [removeFragment=true] - Remove URL fragment (#...)
 * @property {string[]} [ignoreParams] - Query params to ignore (e.g. ['utm_source', 'session_id'])
 * @property {boolean} [normalizeProtocol=true] - Treat http/https as equivalent
 * @property {boolean} [removeDefaultPort=true] - Remove default ports (:80, :443)
 * @property {boolean} [removeHash=true] - Include hash in fingerprint
 * @property {string} [hashAlgorithm='sha256'] - Hash algorithm for fingerprint
 */

const DEFAULT_IGNORE_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'ref', 'referrer',
];

/**
 * Normalize a URL for fingerprinting purposes.
 *
 * @param {string} url - The URL to normalize
 * @param {FingerprintConfig} [config] - Normalization options
 * @returns {string} Normalized URL string
 */
export function normalizeUrl(url, config = {}) {
  const {
    sortQueryParams = true,
    removeTrailingSlash = true,
    lowercaseHostname = true,
    removeFragment = true,
    ignoreParams = DEFAULT_IGNORE_PARAMS,
    normalizeProtocol = false,
    removeDefaultPort = true,
  } = config;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Fallback: hash the raw string
    return url;
  }

  // Lowercase hostname
  if (lowercaseHostname) {
    parsed.hostname = parsed.hostname.toLowerCase();
  }

  // Normalize protocol
  if (normalizeProtocol) {
    parsed.protocol = 'http:';
  }

  // Remove default ports
  if (removeDefaultPort) {
    const isDefault = (parsed.protocol === 'https:' && parsed.port === '443') ||
                      (parsed.protocol === 'http:' && parsed.port === '80');
    if (isDefault) {
      parsed.port = '';
    }
  }

  // Sort and filter query parameters
  if (sortQueryParams || ignoreParams.length > 0) {
    const ignoreSet = new Set(ignoreParams.map(p => p.toLowerCase()));
    const params = [...parsed.searchParams.entries()]
      .filter(([key]) => !ignoreSet.has(key.toLowerCase()));

    if (sortQueryParams) {
      params.sort(([a], [b]) => a.localeCompare(b));
    }

    parsed.search = params.length > 0
      ? params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';
  }

  // Remove fragment
  if (removeFragment) {
    parsed.hash = '';
  }

  // Normalize path
  let pathname = parsed.pathname;

  // Remove trailing slash (except for root)
  if (removeTrailingSlash && pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // Collapse duplicate slashes
  pathname = pathname.replace(/\/{2,}/g, '/');

  parsed.pathname = pathname;

  // Reconstruct URL
  const portPart = parsed.port ? `:${parsed.port}` : '';
  const searchPart = parsed.search ? parsed.search : '';
  return `${parsed.protocol}//${parsed.hostname}${portPart}${pathname}${searchPart}`;
}

/**
 * Compute a fingerprint hash for a URL.
 *
 * @param {string} url - The URL to fingerprint
 * @param {FingerprintConfig} [config] - Normalization options
 * @returns {string} Hex-encoded fingerprint hash
 */
export function computeFingerprint(url, config = {}) {
  const { hashAlgorithm = 'sha256' } = config;
  const normalized = normalizeUrl(url, config);
  return createHash(hashAlgorithm).update(normalized).digest('hex');
}

/**
 * RequestDeduplicator - Track seen request fingerprints to prevent duplicate crawling.
 *
 * Uses an in-memory Set by default, with optional size-bounded eviction.
 * For distributed crawling, swap in a Redis-backed implementation.
 */
export class RequestDeduplicator {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxEntries=1000000] - Max entries before LRU eviction (0 = unlimited)
   * @param {FingerprintConfig} [options.fingerprintConfig] - Fingerprint normalization config
   */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 1000000;
    this.fingerprintConfig = options.fingerprintConfig ?? {};
    this.requestQueueConfig = options.requestQueueConfig ?? options;
    /** @type {Set<string>} */
    this.seen = new Set();
    /** @type {string[]} ordered list for LRU eviction */
    this.order = [];
    this.stats = {
      totalChecked: 0,
      duplicatesFound: 0,
      evictions: 0,
    };
  }

  /**
   * Check if a URL has been seen before, and register it if not.
   *
   * @param {string|{ url: string, method?: string, body?: string }} input
   * @returns {boolean} true if this is a duplicate (already seen), false if new
   */
  isDuplicate(input) {
    this.stats.totalChecked += 1;
    const fingerprint = this.getFingerprint(input);

    if (this.seen.has(fingerprint)) {
      this.stats.duplicatesFound += 1;
      return true;
    }

    // Evict if over capacity
    if (this.maxEntries > 0 && this.seen.size >= this.maxEntries) {
      const evicted = this.order.shift();
      if (evicted) {
        this.seen.delete(evicted);
        this.stats.evictions += 1;
      }
    }

    this.seen.add(fingerprint);
    this.order.push(fingerprint);
    return false;
  }

  /**
   * Check without registering.
   * @param {string|{ url: string, method?: string, body?: string }} input
   * @returns {boolean}
   */
  has(input) {
    const fingerprint = this.getFingerprint(input);
    return this.seen.has(fingerprint);
  }

  /**
   * Get the fingerprint for a URL without modifying state.
   * @param {string|{ url: string, method?: string, body?: string }} input
   * @returns {string}
   */
  getFingerprint(input) {
    if (
      (input && typeof input === 'object' && !Array.isArray(input) && input.url)
      || Object.keys(this.requestQueueConfig ?? {}).length > 0
    ) {
      const { hashAlgorithm = 'sha256' } = this.fingerprintConfig;
      const request = input && typeof input === 'object' && !Array.isArray(input) && input.url
        ? input
        : { url: String(input) };
      const uniqueKey = buildRequestUniqueKey(request, this.requestQueueConfig);
      return createHash(hashAlgorithm).update(uniqueKey).digest('hex');
    }

    return computeFingerprint(input, this.fingerprintConfig);
  }

  /**
   * Reset the deduplicator state.
   */
  reset() {
    this.seen.clear();
    this.order = [];
    this.stats = { totalChecked: 0, duplicatesFound: 0, evictions: 0 };
  }

  /**
   * Get a snapshot of deduplicator state.
   */
  snapshot() {
    return {
      ...this.stats,
      uniqueEntries: this.seen.size,
      maxEntries: this.maxEntries,
    };
  }
}

export default RequestDeduplicator;
