import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { runWorkflow } from '../src/runtime/job-runner.js';
import { closeBrowser } from '../src/fetchers/browser-fetcher.js';
import { ProxyPool } from '../src/runtime/proxy-pool.js';

async function createPolicyFixture() {
  const requestTimes = [];
  let baseUrl = null;

  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end([
        'User-agent: *',
        'Disallow: /blocked',
        'Sitemap: __BASE__/sitemap.xml',
      ].join('\n').replace('__BASE__', baseUrl));
      return;
    }

    if (req.url === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.end([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        `  <url><loc>${baseUrl}/from-sitemap</loc></url>`,
        '</urlset>',
      ].join('\n'));
      return;
    }

    if (req.url === '/') {
      requestTimes.push({ path: req.url, at: Date.now() });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Home</title></head><body><a href="/allowed">allowed</a><a href="/blocked">blocked</a></body></html>');
      return;
    }

    if (req.url === '/allowed' || req.url === '/blocked' || req.url === '/from-sitemap') {
      requestTimes.push({ path: req.url, at: Date.now() });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><title>${req.url.slice(1)}</title></head><body>${req.url}</body></html>`);
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    requestTimes,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
    },
  };
}

async function readResultUrls(summary) {
  const resultsRaw = await readFile(join(summary.runDir, 'results.ndjson'), 'utf8');
  return resultsRaw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).url)
    .sort();
}

async function createForwardProxy(options = {}) {
  const {
    testHeader = 'enabled',
  } = options;
  const server = http.createServer((clientReq, clientRes) => {
    const targetUrl = new URL(clientReq.url);
    const upstream = http.request(
      {
        host: targetUrl.hostname,
        port: targetUrl.port || 80,
        method: clientReq.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: {
          ...clientReq.headers,
          host: targetUrl.host,
          'x-proxy-test': testHeader,
        },
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 500, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );

    clientReq.pipe(upstream);
    upstream.on('error', (error) => {
      clientRes.statusCode = 502;
      clientRes.end(String(error.message || error));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
    },
  };
}

test('crawl policy respects robots.txt and seeds urls from sitemap', async () => {
  const fixture = await createPolicyFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-crawl-policy-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'crawl-policy-robots',
        seedUrls: [`${fixture.baseUrl}/`, `${fixture.baseUrl}/allowed`, `${fixture.baseUrl}/blocked`],
        mode: 'http',
        concurrency: 2,
        maxDepth: 0,
        crawlPolicy: {
          robotsTxt: {
            enabled: true,
            respectCrawlDelay: false,
            seedSitemaps: true,
            timeoutMs: 3000,
          },
        },
        extract: [{ name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' }],
        plugins: [{ name: 'dedupe' }, { name: 'audit' }],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    const resultUrls = await readResultUrls(summary);

    assert.deepEqual(resultUrls, [
      `${fixture.baseUrl}/`,
      `${fixture.baseUrl}/allowed`,
      `${fixture.baseUrl}/from-sitemap`,
    ]);
    assert.equal(summary.failureCount, 0);
    assert.ok(summary.skippedCount >= 1);
    assert.equal(summary.crawlPolicy.enabled, true);
    assert.ok(summary.crawlPolicy.robotsBlockedCount >= 1);
    assert.equal(summary.crawlPolicy.sitemapUrlsEnqueued, 1);
    assert.equal(fixture.requestTimes.some((entry) => entry.path === '/blocked'), false);
  } finally {
    await closeBrowser().catch(() => {});
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('crawl policy enforces crawl-delay between same-origin requests', async () => {
  const pageHits = [];
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end([
        'User-agent: *',
        'Allow: /',
        'Crawl-delay: 0.2',
      ].join('\n'));
      return;
    }

    if (req.url === '/page-a' || req.url === '/page-b') {
      pageHits.push(Date.now());
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><title>${req.url.slice(1)}</title></head><body>${req.url}</body></html>`);
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-crawl-delay-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'crawl-policy-delay',
        seedUrls: [`${baseUrl}/page-a`, `${baseUrl}/page-b`],
        mode: 'http',
        concurrency: 2,
        maxDepth: 0,
        crawlPolicy: {
          robotsTxt: {
            enabled: true,
            respectCrawlDelay: true,
            seedSitemaps: false,
            timeoutMs: 3000,
            maxCrawlDelayMs: 500,
          },
        },
        extract: [{ name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' }],
        plugins: [{ name: 'dedupe' }],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    assert.equal(summary.status, 'completed');
    assert.equal(pageHits.length, 2);
    assert.ok(pageHits[1] - pageHits[0] >= 150);
    assert.ok(summary.crawlPolicy.totalDelayMs >= 150);
  } finally {
    await closeBrowser().catch(() => {});
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('crawl policy can fail closed when robots.txt is unavailable', async () => {
  let pageHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.statusCode = 503;
      res.end('temporarily unavailable');
      return;
    }

    if (req.url === '/page') {
      pageHits += 1;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>page</title></head><body>page</body></html>');
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-crawl-policy-fail-closed-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'crawl-policy-fail-closed',
        seedUrls: [`${baseUrl}/page`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        crawlPolicy: {
          robotsTxt: {
            enabled: true,
            allowOnError: false,
            seedSitemaps: false,
            timeoutMs: 3000,
          },
        },
        extract: [{ name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' }],
        plugins: [{ name: 'dedupe' }],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    assert.equal(summary.status, 'completed');
    assert.equal(summary.pagesFetched, 0);
    assert.equal(summary.resultCount, 0);
    assert.equal(summary.skippedCount, 1);
    assert.equal(pageHits, 0);
  } finally {
    await closeBrowser().catch(() => {});
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('crawl policy fetches robots.txt and sitemaps through proxy pool routes', async () => {
  const requests = [];
  let baseUrl = null;
  const target = createServer((req, res) => {
    requests.push({
      path: req.url,
      proxyHeader: req.headers['x-proxy-test'] ?? null,
    });

    if (!req.headers['x-proxy-test']) {
      res.statusCode = 403;
      res.end('proxy required');
      return;
    }

    if (req.url === '/robots.txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end([
        'User-agent: *',
        `Sitemap: ${baseUrl}/sitemap.xml`,
      ].join('\n'));
      return;
    }

    if (req.url === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.end([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        `  <url><loc>${baseUrl}/seed</loc></url>`,
        `  <url><loc>${baseUrl}/from-sitemap</loc></url>`,
        '</urlset>',
      ].join('\n'));
      return;
    }

    if (req.url === '/seed' || req.url === '/from-sitemap') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><title>${req.url.slice(1)}</title></head><body>${req.url}</body></html>`);
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  baseUrl = `http://127.0.0.1:${target.address().port}`;
  const proxy = await createForwardProxy();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-crawl-policy-proxy-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'crawl-policy-proxy-seeding',
        seedUrls: [`${baseUrl}/seed`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        crawlPolicy: {
          robotsTxt: {
            enabled: true,
            seedSitemaps: true,
            respectCrawlDelay: false,
            timeoutMs: 3000,
          },
        },
        proxyPool: {
          enabled: true,
          strategy: 'healthiest',
          allowDirectFallback: false,
          servers: [
            {
              label: 'policy-proxy',
              server: proxy.url,
            },
          ],
        },
        extract: [{ name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' }],
        plugins: [{ name: 'dedupe' }],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    const resultUrls = await readResultUrls(summary);
    const proxyPool = await new ProxyPool({ projectRoot: root }).init();
    const proxyStates = await proxyPool.list();

    assert.deepEqual(resultUrls, [`${baseUrl}/from-sitemap`, `${baseUrl}/seed`]);
    assert.equal(summary.crawlPolicy.sitemapUrlsEnqueued, 1);
    assert.ok(summary.crawlPolicy.proxiedPolicyFetchCount >= 2);
    assert.equal(requests.filter((entry) => entry.path === '/robots.txt').every((entry) => entry.proxyHeader === 'enabled'), true);
    assert.equal(requests.filter((entry) => entry.path === '/sitemap.xml').every((entry) => entry.proxyHeader === 'enabled'), true);
    assert.ok(proxyStates[0].successCount >= 3);
  } finally {
    await closeBrowser().catch(() => {});
    await proxy.close();
    target.closeAllConnections?.();
    target.close();
    await once(target, 'close');
    await rm(root, { recursive: true, force: true });
  }
});
