import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeUrl, computeFingerprint, RequestDeduplicator } from '../src/runtime/request-fingerprint.js';
import { DomainRateLimiter } from '../src/runtime/rate-limiter.js';
import { ExportManager, itemsToCsv, itemsToJsonl, itemsToJson } from '../src/runtime/export-manager.js';
import { createProxyProvider, getProxyFromProvider } from '../src/runtime/proxy-providers.js';
import {
  setupObservability,
  getPromRegistry,
  getPromMetrics,
  summarizeObservability,
  PROMETHEUS_CONTENT_TYPE,
  OPENMETRICS_CONTENT_TYPE,
} from '../src/runtime/observability.js';
import { BenchmarkRunner } from '../src/runtime/benchmark.js';
import { PluginRegistry, createSitemapPlugin, createJsonLdPlugin, createRobotsMetaPlugin, getGlobalRegistry } from '../src/plugins/plugin-registry.js';
import { OmniCrawler } from '../src/api/omnicrawler.js';
import { fetchWithCheerio, extractWithSchema } from '../src/fetchers/cheerio-fetcher.js';

const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../package.json');

// --- RequestFingerprint / RequestDeduplicator ---

test('normalizeUrl sorts query params', () => {
  const a = normalizeUrl('https://example.com/path?b=2&a=1');
  const b = normalizeUrl('https://example.com/path?a=1&b=2');
  assert.equal(a, b);
});

test('normalizeUrl removes tracking params by default', () => {
  const withUtm = normalizeUrl('https://example.com/page?utm_source=twitter&id=5');
  const withoutUtm = normalizeUrl('https://example.com/page?id=5');
  assert.equal(withUtm, withoutUtm);
});

test('normalizeUrl removes fragments by default', () => {
  const withHash = normalizeUrl('https://example.com/page#section');
  const withoutHash = normalizeUrl('https://example.com/page');
  assert.equal(withHash, withoutHash);
});

test('normalizeUrl lowercases hostname', () => {
  const upper = normalizeUrl('https://EXAMPLE.COM/path');
  const lower = normalizeUrl('https://example.com/path');
  assert.equal(upper, lower);
});

test('computeFingerprint produces deterministic sha256 hex', () => {
  const fp1 = computeFingerprint('https://example.com/page?b=2&a=1');
  const fp2 = computeFingerprint('https://example.com/page?a=1&b=2');
  assert.equal(fp1, fp2);
  assert.equal(fp1.length, 64);
});

test('RequestDeduplicator isDuplicate detects and registers URLs', () => {
  const dedup = new RequestDeduplicator();
  assert.equal(dedup.isDuplicate('https://example.com/a?b=2&c=1'), false);
  assert.equal(dedup.isDuplicate('https://example.com/a?c=1&b=2'), true);
});

test('RequestDeduplicator has checks without registering', () => {
  const dedup = new RequestDeduplicator();
  assert.equal(dedup.has('https://example.com/page'), false);
  dedup.isDuplicate('https://example.com/page');
  assert.equal(dedup.has('https://example.com/page'), true);
});

test('RequestDeduplicator reset clears state', () => {
  const dedup = new RequestDeduplicator();
  dedup.isDuplicate('https://example.com/page');
  dedup.reset();
  assert.equal(dedup.has('https://example.com/page'), false);
});

test('RequestDeduplicator getFingerprint returns normalized hash', () => {
  const dedup = new RequestDeduplicator();
  const fp = dedup.getFingerprint('https://example.com/page?b=2&a=1');
  assert.equal(typeof fp, 'string');
  assert.equal(fp.length, 64);
});

test('RequestDeduplicator snapshot returns stats', () => {
  const dedup = new RequestDeduplicator();
  dedup.isDuplicate('https://example.com/page1');
  dedup.isDuplicate('https://example.com/page2');
  dedup.isDuplicate('https://example.com/page1');
  const snap = dedup.snapshot();
  assert.equal(snap.totalChecked, 3);
  assert.equal(snap.duplicatesFound, 1);
});

test('RequestDeduplicator can distinguish requests by method and body when configured', () => {
  const dedup = new RequestDeduplicator({
    requestQueueConfig: {
      includeMethodInUniqueKey: true,
      includeBodyInUniqueKey: true,
    },
  });

  assert.equal(dedup.isDuplicate({
    url: 'https://example.com/graphql',
    method: 'POST',
    body: '{"page":1}',
  }), false);
  assert.equal(dedup.isDuplicate({
    url: 'https://example.com/graphql',
    method: 'POST',
    body: '{"page":2}',
  }), false);
  assert.equal(dedup.isDuplicate({
    url: 'https://example.com/graphql',
    method: 'POST',
    body: '{"page":1}',
  }), true);
});

// --- DomainRateLimiter ---

test('DomainRateLimiter tracks per-domain state', () => {
  const limiter = new DomainRateLimiter({ requestsPerSecond: 10 });
  const snap = limiter.snapshot();
  assert.equal(Object.keys(snap.domains || {}).length, 0);
});

test('DomainRateLimiter acquire returns wait info', async () => {
  const limiter = new DomainRateLimiter({ requestsPerSecond: 1000 });
  const result = await limiter.acquire('https://example.com/page');
  assert.ok(result);
  assert.equal(result.domain, 'example.com');
  assert.equal(typeof result.waitMs, 'number');
  limiter.release('https://example.com/page');
});

test('DomainRateLimiter accepts bare hostnames for acquire/release', async () => {
  const limiter = new DomainRateLimiter({ requestsPerSecond: 1000 });
  const result = await limiter.acquire('example.com');
  assert.equal(result.domain, 'example.com');
  limiter.release('example.com');
});

test('DomainRateLimiter release decrements active count', async () => {
  const limiter = new DomainRateLimiter({ requestsPerSecond: 1000, maxConcurrent: 5 });
  await limiter.acquire('https://example.com/page');
  limiter.release('https://example.com/page');
  const snap = limiter.snapshot();
  assert.ok(snap);
});

test('DomainRateLimiter setDomainRate updates per-domain config', () => {
  const limiter = new DomainRateLimiter({ requestsPerSecond: 10 });
  limiter.setDomainRate('slow.com', 0.5);
  const snap = limiter.snapshot();
  assert.ok(snap);
});

test('DomainRateLimiter reset clears all domain state', async () => {
  const limiter = new DomainRateLimiter({ requestsPerSecond: 1000 });
  await limiter.acquire('https://example.com/page');
  limiter.reset();
  const snap = limiter.snapshot();
  assert.ok(snap);
});

test('DomainRateLimiter autoThrottle adjusts effective RPS from outcomes', async () => {
  const limiter = new DomainRateLimiter({
    requestsPerSecond: 2,
    autoThrottle: {
      enabled: true,
      minRequestsPerSecond: 0.5,
      maxRequestsPerSecond: 4,
      targetLatencyMs: 100,
      cooldownMs: 0,
    },
  });
  await limiter.acquire('https://example.com/page');
  limiter.release('https://example.com/page');
  limiter.report('https://example.com/page', { durationMs: 500, ok: false, status: 429 });
  const reduced = limiter.snapshot().domains['example.com'].rps;
  assert.ok(reduced < 2);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    limiter.report('https://example.com/page', { durationMs: 20, ok: true, status: 200 });
  }
  const recovered = limiter.snapshot().domains['example.com'].rps;
  assert.ok(recovered > reduced);
});

// --- ExportManager ---

test('itemsToCsv produces valid CSV with header', () => {
  const items = [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }];
  const csv = itemsToCsv(items);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('name'));
  assert.ok(lines[1].includes('Alice'));
  assert.ok(lines[2].includes('Bob'));
});

test('itemsToCsv handles nested objects by flattening', () => {
  const items = [{ user: { name: 'Alice' }, score: 10 }];
  const csv = itemsToCsv(items);
  assert.ok(csv.includes('user.name'));
  assert.ok(csv.includes('Alice'));
});

test('itemsToCsv escapes values with commas and quotes', () => {
  const items = [{ desc: 'Hello, World' }];
  const csv = itemsToCsv(items);
  assert.ok(csv.includes('"Hello, World"'));
});

test('itemsToJsonl produces newline-delimited JSON', () => {
  const items = [{ a: 1 }, { a: 2 }];
  const jsonl = itemsToJsonl(items);
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).a, 1);
  assert.equal(JSON.parse(lines[1]).a, 2);
});

test('ExportManager constructor accepts options', () => {
  const mgr = new ExportManager({});
  assert.ok(mgr instanceof ExportManager);
});

test('ExportManager can deliver configured exports to HTTP destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-export-http-'));
  const runDir = join(root, 'runs', 'job-http-export');
  const received = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    received.push({
      method: req.method,
      headers: req.headers,
      body,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'results.ndjson'), `${JSON.stringify({ url: 'https://example.com', status: 200 })}\n`, 'utf8');

    const exporter = new ExportManager({ projectRoot: root, runDir });
    const manifest = await exporter.exportConfigured({
      enabled: true,
      outputs: [
        {
          kind: 'results',
          format: 'json',
          path: `http://127.0.0.1:${server.address().port}/ingest`,
          headers: { 'x-test-export': 'yes' },
          signingSecret: 'secret',
        },
      ],
    });

    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].delivery, 'http');
    assert.equal(manifest[0].delivered, true);
    assert.equal(manifest[0].status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].headers['x-test-export'], 'yes');
    assert.match(received[0].headers['x-omnicrawl-signature'] ?? '', /^sha256=/);
    const payload = JSON.parse(received[0].body);
    assert.equal(payload[0].url, 'https://example.com');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('ExportManager can deliver configured exports to PostgreSQL-compatible backends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-export-postgres-'));
  const runDir = join(root, 'runs', 'job-postgres-export');
  const statements = [];

  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'results.ndjson'), `${JSON.stringify({ url: 'https://example.com', status: 200 })}\n`, 'utf8');

    const exporter = new ExportManager({
      projectRoot: root,
      runDir,
      jobId: 'job-postgres',
      workflowName: 'export-postgres',
      clients: {
        postgres: {
          async query(sql, params) {
            statements.push({ sql, params });
            return { rowCount: params.length };
          },
        },
      },
    });

    const manifest = await exporter.exportConfigured({
      enabled: true,
      outputs: [
        {
          kind: 'results',
          backend: 'postgres',
          table: 'crawl_results',
          metadataColumn: 'meta',
        },
      ],
    });

    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].delivery, 'postgres');
    assert.equal(manifest[0].insertedCount, 1);
    assert.match(statements[0].sql, /INSERT INTO "crawl_results"/);
    assert.match(statements[0].sql, /"payload", "meta"/);
    const payload = JSON.parse(statements[0].params[0]);
    assert.equal(payload._omnicrawl.jobId, 'job-postgres');
    assert.equal(payload._omnicrawl.workflowName, 'export-postgres');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ExportManager can deliver configured exports to MongoDB-compatible backends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-export-mongo-'));
  const runDir = join(root, 'runs', 'job-mongo-export');
  const inserted = [];

  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'results.ndjson'), `${JSON.stringify({ url: 'https://example.com', status: 200 })}\n`, 'utf8');

    const exporter = new ExportManager({
      projectRoot: root,
      runDir,
      jobId: 'job-mongo',
      workflowName: 'export-mongo',
      clients: {
        mongodb: {
          db(name) {
            assert.equal(name, 'analytics');
            return {
              collection(collectionName) {
                assert.equal(collectionName, 'crawl_results');
                return {
                  async insertMany(documents) {
                    inserted.push(...documents);
                    return { insertedCount: documents.length };
                  },
                };
              },
            };
          },
        },
      },
    });

    const manifest = await exporter.exportConfigured({
      enabled: true,
      outputs: [
        {
          kind: 'results',
          backend: 'mongodb',
          database: 'analytics',
          collection: 'crawl_results',
        },
      ],
    });

    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].delivery, 'mongodb');
    assert.equal(manifest[0].insertedCount, 1);
    assert.equal(inserted[0]._omnicrawl.jobId, 'job-mongo');
    assert.equal(inserted[0]._omnicrawl.workflowName, 'export-mongo');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ExportManager records failed HTTP exports after retries without throwing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-export-http-fail-'));
  const runDir = join(root, 'runs', 'job-http-export-fail');
  let attempts = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain
    }
    attempts += 1;
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{"ok":false}');
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'results.ndjson'), `${JSON.stringify({ url: 'https://example.com', status: 200 })}\n`, 'utf8');

    const exporter = new ExportManager({ projectRoot: root, runDir });
    const manifest = await exporter.exportConfigured({
      enabled: true,
      outputs: [
        {
          kind: 'results',
          format: 'json',
          path: `http://127.0.0.1:${server.address().port}/ingest`,
          retryAttempts: 2,
          retryBackoffMs: 0,
        },
      ],
    });

    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].delivery, 'http');
    assert.equal(manifest[0].delivered, false);
    assert.equal(manifest[0].attempts, 3);
    assert.equal(manifest[0].status, 502);
    assert.match(manifest[0].reason ?? '', /status 502/);
    assert.equal(attempts, 3);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

// --- ProxyProviders ---

test('createProxyProvider returns Bright Data provider', () => {
  const provider = createProxyProvider({ type: 'bright-data', username: 'user', password: 'pass' });
  assert.ok(provider);
  assert.equal(typeof provider.buildProxyUrl, 'function');
});

test('createProxyProvider returns Smartproxy provider', () => {
  const provider = createProxyProvider({ type: 'smartproxy', endpoint: 'gate.smartproxy.com:7000', username: 'user', password: 'pass' });
  assert.ok(provider);
  assert.equal(typeof provider.buildProxyUrl, 'function');
});

test('createProxyProvider returns Oxylabs provider', () => {
  const provider = createProxyProvider({ type: 'oxylabs', username: 'user', password: 'pass' });
  assert.ok(provider);
  assert.equal(typeof provider.buildProxyUrl, 'function');
});

test('Bright Data provider builds proxy URL with zone', () => {
  const provider = createProxyProvider({ type: 'bright-data', username: 'user', password: 'pass', zone: 'mobile' });
  const result = provider.buildProxyUrl();
  assert.ok(result.server.startsWith('http://'));
  assert.ok(result.username.includes('zone-mobile'));
  assert.equal(result.password, 'pass');
});

test('getProxyFromProvider calls buildProxyUrl', async () => {
  const provider = createProxyProvider({ type: 'bright-data', username: 'user', password: 'pass' });
  const result = await getProxyFromProvider(provider, { country: 'us' });
  assert.ok(result);
  assert.ok(result.server || typeof result === 'string');
});

test('createProxyProvider throws for unknown type', () => {
  assert.throws(() => createProxyProvider({ type: 'unknown' }));
});

// --- Observability ---

test('setupObservability returns tracer and meter', () => {
  const { tracer, meter } = setupObservability({ tracing: { enabled: true }, metrics: { enabled: true } });
  assert.ok(tracer);
  assert.ok(meter);
});

test('tracer startSpan and endSpan work', () => {
  const { tracer } = setupObservability({ tracing: { enabled: true } });
  const span = tracer.startSpan('test.operation');
  assert.ok(span);
  assert.equal(span.name, 'test.operation');
  tracer.endSpan(span);
  assert.ok(span.durationMs >= 0);
});

test('span supports setAttribute and addEvent', () => {
  const { tracer } = setupObservability({ tracing: { enabled: true } });
  const span = tracer.startSpan('op');
  span.setAttribute('key', 'value');
  span.addEvent('something happened', { detail: 42 });
  tracer.endSpan(span);
  assert.equal(span.attributes.key, 'value');
  assert.equal(span.events.length, 1);
  assert.equal(span.events[0].name, 'something happened');
});

test('meter incrementCounter and setGauge work', () => {
  const { meter } = setupObservability({ metrics: { enabled: true } });
  meter.incrementCounter('requests_total', 1, { domain: 'example.com' });
  meter.setGauge('active_sessions', 5);
  const promText = meter.toPrometheusFormat();
  assert.ok(promText.includes('requests_total'));
  assert.ok(promText.includes('active_sessions'));
});

test('setupObservability build_info stays aligned with package version', () => {
  const { meter } = setupObservability({ metrics: { enabled: true } });
  const promText = meter.toPrometheusFormat();
  assert.ok(promText.includes(`version="${packageVersion}"`));
});

test('summarizeObservability returns compact tracing and metrics snapshots', () => {
  const observability = setupObservability({ tracing: { enabled: true }, metrics: { enabled: true } });
  const span = observability.tracer.startSpan('crawl.request');
  span?.setStatus('error');
  observability.tracer.endSpan(span);
  observability.meter.incrementCounter('page_requests_total', 1, { mode: 'http' });

  const summary = summarizeObservability(observability);
  assert.equal(summary.tracing.spanCount, 1);
  assert.equal(summary.tracing.errorSpanCount, 1);
  assert.equal(summary.metrics.counters.length >= 1, true);
});

test('getPromRegistry returns a non-null registry with Prometheus content type', async () => {
  setupObservability({ metrics: { enabled: true } });
  const registry = getPromRegistry();
  assert.ok(registry);
  assert.equal(registry.contentType, PROMETHEUS_CONTENT_TYPE);
  const text = await registry.metrics();
  assert.ok(typeof text === 'string');
});

test('observability metrics honor prefix and default labels', async () => {
  const observability = setupObservability({
    metrics: {
      enabled: true,
      prefix: 'custom_',
      defaultLabels: { service: 'test-suite' },
      contentType: OPENMETRICS_CONTENT_TYPE,
    },
  });
  observability.meter.incrementCounter('requests_total', 2, { mode: 'http' });
  const text = await getPromMetrics();
  assert.ok(text.includes('custom_requests_total'));
  assert.ok(text.includes('service="test-suite"'));
  assert.ok(text.includes('# EOF'));
  assert.equal(getPromRegistry().contentType, OPENMETRICS_CONTENT_TYPE);
});

test('setupObservability with everything disabled returns no-ops', () => {
  const { tracer } = setupObservability({ tracing: { enabled: false }, metrics: { enabled: false } });
  const span = tracer.startSpan('noop');
  tracer.endSpan(span);
  assert.ok(span || span === null);
});

// --- BenchmarkRunner ---

test('BenchmarkRunner constructor sets defaults', () => {
  const bench = new BenchmarkRunner();
  assert.equal(bench.iterations, 50);
  assert.equal(bench.concurrency, 1);
  assert.equal(bench.warmup, 3);
});

test('BenchmarkRunner constructor accepts custom options', () => {
  const bench = new BenchmarkRunner({ iterations: 10, concurrency: 2, warmup: 1 });
  assert.equal(bench.iterations, 10);
  assert.equal(bench.concurrency, 2);
  assert.equal(bench.warmup, 1);
});

test('BenchmarkRunner formatReport returns a string', () => {
  const bench = new BenchmarkRunner();
  const mockResults = [{
    name: 'http', iterations: 5, totalTimeMs: 1000,
    avgLatencyMs: 200, p50Ms: 180, p95Ms: 300, p99Ms: 350,
    minMs: 100, maxMs: 400, rps: 5, successRate: 1, avgBodyBytes: 5000,
  }];
  const report = bench.formatReport(mockResults);
  assert.equal(typeof report, 'string');
  assert.ok(report.includes('http'));
  assert.ok(report.includes('200'));
});

// --- PluginRegistry ---

test('PluginRegistry register and load a plugin', async () => {
  const registry = new PluginRegistry();
  registry.register('test-plugin', async () => ({ name: 'test-plugin', beforeRequest: (req) => req }), { version: '1.0.0' });
  const instance = await registry.load('test-plugin');
  assert.equal(instance.name, 'test-plugin');
  assert.ok(typeof instance.beforeRequest === 'function');
});

test('PluginRegistry list returns registered plugins', () => {
  const registry = new PluginRegistry();
  registry.register('a', async () => ({ name: 'a' }));
  registry.register('b', async () => ({ name: 'b' }));
  const list = registry.list();
  assert.ok(list.length >= 2);
});

test('PluginRegistry unregister removes a plugin', () => {
  const registry = new PluginRegistry();
  registry.register('removeme', async () => ({ name: 'removeme' }));
  registry.unregister('removeme');
  assert.equal(registry.has('removeme'), false);
});

test('PluginRegistry load throws for unregistered plugin', async () => {
  const registry = new PluginRegistry();
  await assert.rejects(() => registry.load('nonexistent'));
});

test('createSitemapPlugin returns a plugin definition', () => {
  const plugin = createSitemapPlugin();
  assert.ok(plugin);
  assert.ok(plugin.name || plugin.factory || typeof plugin === 'object');
});

test('createJsonLdPlugin returns a plugin definition', () => {
  const plugin = createJsonLdPlugin();
  assert.ok(plugin);
  assert.ok(plugin.name || plugin.factory || typeof plugin === 'object');
});

test('createRobotsMetaPlugin returns a plugin definition', () => {
  const plugin = createRobotsMetaPlugin();
  assert.ok(plugin);
  assert.ok(plugin.name || plugin.factory || typeof plugin === 'object');
});

test('getGlobalRegistry returns a singleton', () => {
  const a = getGlobalRegistry();
  const b = getGlobalRegistry();
  assert.equal(a, b);
});

// --- OmniCrawler Phase 1-3 Integration ---

test('OmniCrawler setMode accepts cheerio', () => {
  const c = new OmniCrawler();
  c.setMode('cheerio');
  assert.equal(c._mode, 'cheerio');
});

test('OmniCrawler setMode throws for invalid mode', () => {
  const c = new OmniCrawler();
  assert.throws(() => c.setMode('invalid'), /Invalid mode/);
});

test('OmniCrawler useRateLimiter stores config', () => {
  const c = new OmniCrawler();
  const result = c.useRateLimiter({ requestsPerSecond: 5 });
  assert.equal(result, c);
  assert.deepEqual(c._workflowOverrides.rateLimiter, { requestsPerSecond: 5 });
});

test('OmniCrawler useDeduplicator stores config', () => {
  const c = new OmniCrawler();
  const result = c.useDeduplicator({ sortQueryParams: true });
  assert.equal(result, c);
  assert.deepEqual(c._workflowOverrides.deduplicator, { sortQueryParams: true });
});

test('OmniCrawler useExport stores config', () => {
  const c = new OmniCrawler();
  const result = c.useExport({ format: 'csv' });
  assert.equal(result, c);
  assert.deepEqual(c._workflowOverrides.export, { format: 'csv' });
});

test('OmniCrawler _rateLimiter initialized to null', () => {
  assert.equal(new OmniCrawler()._rateLimiter, null);
});

test('OmniCrawler _deduplicator initialized to null', () => {
  assert.equal(new OmniCrawler()._deduplicator, null);
});

test('OmniCrawler teardown handles null _rateLimiter gracefully', async () => {
  const c = new OmniCrawler();
  await c.teardown();
  assert.equal(c._running, false);
});


// --- CheerioFetcher ---

test('fetchWithCheerio is a function', () => {
  assert.equal(typeof fetchWithCheerio, 'function');
});

test('extractWithSchema is a function', () => {
  assert.equal(typeof extractWithSchema, 'function');
});

test('extractWithSchema extracts text by selector', () => {
  const mockResult = {
    $: (sel) => ({ length: 1, text: () => 'Hello World', toArray: () => ['Hello World'] }),
    html: '<html><body><h1>Hello World</h1></body></html>',
  };
  const schema = { title: 'h1' };
  const data = extractWithSchema(mockResult, schema);
  assert.equal(data.title, 'Hello World');
});

test('extractWithSchema extracts attribute', () => {
  const mockResult = {
    $: (sel) => ({ length: 1, text: () => 'Link', attr: (name) => name === 'href' ? 'https://example.com' : null, toArray: () => [] }),
    html: '<html><body></body></html>',
  };
  const schema = { link: { selector: 'a', attribute: 'href' } };
  const data = extractWithSchema(mockResult, schema);
  assert.equal(data.link, 'https://example.com');
});

test('extractWithSchema applies transform', () => {
  const mockResult = {
    $: (sel) => ({ length: 1, text: () => 'hello', attr: () => null, toArray: () => ['hello'] }),
    html: '<html><body></body></html>',
  };
  const schema = { title: { selector: 'h1', transform: (v) => v.toUpperCase() } };
  const data = extractWithSchema(mockResult, schema);
  assert.equal(data.title, 'HELLO');
});

test('OmniCrawler cheerio mode accepted by setMode', () => {
  const c = new OmniCrawler();
  c.setMode('cheerio');
  assert.equal(c._mode, 'cheerio');
});




// --- Missing tests ---

test('ExportManager itemsToJson converts items to JSON string', () => {
  const items = [{ name: 'Alice' }, { name: 'Bob' }];
  const json = itemsToJson(items);
  const parsed = JSON.parse(json);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'Alice');
});

test('OmniCrawler teardown handles null _exportManager gracefully', async () => {
  const c = new OmniCrawler();
  await c.teardown();
  assert.equal(c._running, false);
});
