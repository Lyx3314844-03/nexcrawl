/**
 * Benchmark - Performance benchmark suite for OmniCrawl.
 *
 * Measures throughput, latency, and resource usage across crawl modes
 * (http, cheerio, browser) and provides comparison reports.
 *
 * Usage:
 *   const bench = new BenchmarkRunner({ iterations: 100 });
 *   const results = await bench.runAll(targetUrl);
 *   console.log(bench.formatReport(results));
 */

import { fetchWithHttp } from '../fetchers/http-fetcher.js';
import { fetchWithCheerio } from '../fetchers/cheerio-fetcher.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('benchmark');

/**
 * @typedef {Object} BenchmarkResult
 * @property {string} name - Benchmark name
 * @property {number} iterations - Number of iterations
 * @property {number} totalTimeMs - Total wall-clock time
 * @property {number} avgLatencyMs - Average request latency
 * @property {number} p50Ms - 50th percentile latency
 * @property {number} p95Ms - 95th percentile latency
 * @property {number} p99Ms - 99th percentile latency
 * @property {number} minMs - Minimum latency
 * @property {number} maxMs - Maximum latency
 * @property {number} rps - Requests per second
 * @property {number} successRate - Fraction of successful requests
 * @property {number} avgBodyBytes - Average response body size
 */

function percentile(sorted, p) {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

export class BenchmarkRunner {
  /**
   * @param {Object} [options]
   * @param {number} [options.iterations=50] - Requests per benchmark
   * @param {number} [options.concurrency=1] - Parallel requests
   * @param {number} [options.warmup=3] - Warmup iterations (not measured)
   * @param {number} [options.timeoutMs=30000] - Per-request timeout
   */
  constructor(options = {}) {
    this.iterations = options.iterations ?? 50;
    this.concurrency = options.concurrency ?? 1;
    this.warmup = options.warmup ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  /**
   * Run a single benchmark (measure one fetch function).
   *
   * @param {string} name - Benchmark name
   * @param {Function} fetchFn - async (url) => response
   * @param {string} url - Target URL
   * @returns {Promise<BenchmarkResult>}
   */
  async runSingle(name, fetchFn, url) {
    // Warmup
    for (let i = 0; i < this.warmup; i++) {
      try { await fetchFn(url); } catch { /* ignore warmup errors */ }
    }

    const latencies = [];
    const bodySizes = [];
    let successes = 0;
    let failures = 0;

    const totalStart = Date.now();

    // Run with concurrency
    const batches = [];
    for (let i = 0; i < this.iterations; i += this.concurrency) {
      const batch = [];
      for (let j = i; j < Math.min(i + this.concurrency, this.iterations); j++) {
        batch.push((async () => {
          const start = Date.now();
          try {
            const response = await fetchFn(url);
            const elapsed = Date.now() - start;
            latencies.push(elapsed);
            bodySizes.push(Buffer.byteLength(response.body ?? ''));
            successes += 1;
          } catch {
            const elapsed = Date.now() - start;
            latencies.push(elapsed);
            failures += 1;
          }
        })());
      }
      await Promise.all(batch);
    }

    const totalTimeMs = Date.now() - totalStart;
    const sorted = [...latencies].sort((a, b) => a - b);

    return {
      name,
      iterations: this.iterations,
      totalTimeMs,
      avgLatencyMs: sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      minMs: sorted[0] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
      rps: totalTimeMs > 0 ? (this.iterations / totalTimeMs) * 1000 : 0,
      successRate: this.iterations > 0 ? successes / this.iterations : 0,
      avgBodyBytes: bodySizes.length > 0 ? bodySizes.reduce((s, v) => s + v, 0) / bodySizes.length : 0,
    };
  }

  /**
   * Run all standard benchmarks against a URL.
   *
   * @param {string} url - Target URL
   * @returns {Promise<BenchmarkResult[]>}
   */
  async runAll(url) {
    const results = [];

    // HTTP benchmark
    results.push(await this.runSingle('http', (targetUrl) =>
      fetchWithHttp({ url: targetUrl, timeoutMs: this.timeoutMs }), url));

    // Cheerio benchmark
    results.push(await this.runSingle('cheerio', (targetUrl) =>
      fetchWithCheerio({ url: targetUrl, timeoutMs: this.timeoutMs }), url));

    return results;
  }

  /**
   * Format benchmark results as a readable table.
   *
   * @param {BenchmarkResult[]} results
   * @returns {string}
   */
  formatReport(results) {
    const lines = [];
    lines.push('┌────────────┬───────────┬───────────┬───────────┬───────────┬────────┬──────────┐');
    lines.push('│ Mode       │  Avg (ms) │  P50 (ms) │  P95 (ms) │  RPS      │  Success│ Body (B) │');
    lines.push('├────────────┼───────────┼───────────┼───────────┼───────────┼────────┼──────────┤');

    for (const r of results) {
      lines.push(`│ ${r.name.padEnd(10)} │ ${String(r.avgLatencyMs.toFixed(1)).padStart(9)} │ ${String(r.p50Ms.toFixed(1)).padStart(9)} │ ${String(r.p95Ms.toFixed(1)).padStart(9)} │ ${String(r.rps.toFixed(1)).padStart(8)} │ ${(r.successRate * 100).toFixed(0).padStart(6)}% │ ${String(Math.round(r.avgBodyBytes)).padStart(8)} │`);
    }

    lines.push('└────────────┴───────────┴───────────┴───────────┴───────────┴────────┴──────────┘');
    return lines.join('\n');
  }

  /**
   * Format results as JSON for programmatic use.
   * @param {BenchmarkResult[]} results
   * @returns {Object}
   */
  formatJson(results) {
    return {
      timestamp: new Date().toISOString(),
      iterations: this.iterations,
      concurrency: this.concurrency,
      benchmarks: results,
    };
  }
}

export default BenchmarkRunner;
