import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow } from '../src/runtime/job-runner.js';
import { DEFAULT_CONFIG, setGlobalConfig } from '../src/utils/config.js';

async function createFixtureSite() {
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Home</title></head>
          <body>
            <a href="/detail">detail</a>
            <script src="/assets/app.js"></script>
            <script>eval("console.log('x')")</script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/detail') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Detail</title></head>
          <body>detail page</body>
        </html>
      `);
      return;
    }

    if (req.url === '/assets/app.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end('const sign = CryptoJS.MD5("ok");');
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

test('job runner crawls, extracts, discovers, and writes summary', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-runner-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'local-http-crawl',
        seedUrls: [`${fixture.baseUrl}/`],
        mode: 'http',
        concurrency: 2,
        maxDepth: 1,
        rateLimiter: {
          requestsPerSecond: 20,
          autoThrottle: {
            enabled: true,
            cooldownMs: 0,
          },
        },
        observability: {
          tracing: { enabled: true },
          metrics: { enabled: true },
        },
        extract: [
          { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
          { name: 'surface', type: 'surface' },
          { name: 'hasDetail', type: 'script', code: "return body.includes('/detail');" },
        ],
        discovery: {
          enabled: true,
          maxPages: 3,
          maxLinksPerPage: 10,
          sameOriginOnly: true,
          extractor: { name: 'links', type: 'links', all: true },
        },
        plugins: [{ name: 'dedupe' }, { name: 'audit' }],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    assert.equal(summary.status, 'completed');
    assert.equal(summary.pagesFetched, 2);
    assert.equal(summary.failureCount, 0);
    assert.ok(summary.rateLimiter);
    assert.equal(summary.rateLimiter.enabled, true);
    assert.ok(summary.observability);
    assert.ok(summary.observability.tracing.spanCount >= 2);
    assert.ok(summary.observability.metrics.counters.some((metric) => metric.name.endsWith('page_requests_total')));

    const summaryFile = JSON.parse(await readFile(join(summary.runDir, 'summary.json'), 'utf8'));
    assert.equal(summaryFile.resultCount, 2);
    assert.ok(summaryFile.rateLimiter);
    assert.ok(summaryFile.observability);

    const resultsRaw = await readFile(join(summary.runDir, 'results.ndjson'), 'utf8');
    const records = resultsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.equal(records.length, 2);
    const homeRecord = records.find((record) => record.extracted.title === 'Home');
    assert.ok(homeRecord);
    assert.equal(homeRecord.extracted.hasDetail, true);
    assert.ok(homeRecord.extracted.surface.signals.obfuscation.length >= 1);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('runWorkflow applies global performance defaults for direct workflow objects', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-runner-config-'));

  setGlobalConfig({
    performance: {
      concurrency: 6,
      timeout: 4321,
    },
  });

  try {
    const summary = await runWorkflow(
      {
        name: 'global-defaults-direct-run',
        seedUrls: [`${fixture.baseUrl}/`],
        mode: 'http',
        maxDepth: 0,
        extract: [
          { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
        ],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    const workflowFile = JSON.parse(await readFile(join(summary.runDir, 'workflow.json'), 'utf8'));
    assert.equal(workflowFile.workflow.concurrency, 6);
    assert.equal(workflowFile.workflow.timeoutMs, 4321);
  } finally {
    setGlobalConfig(DEFAULT_CONFIG);
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner honors plugin-requested skips without failing the run', async () => {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<html><head><title>Skip</title></head><body>skip</body></html>');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-plugin-skip-'));
  const pluginDir = join(root, 'plugins');
  const pluginPath = join(pluginDir, 'skip-plugin.js');

  try {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      pluginPath,
      `export default function skipPlugin() {
        return {
          name: 'skip-plugin',
          async beforeRequest({ request }) {
            request._skip = true;
            request._skipReason = 'policy-filter';
          },
        };
      }`,
    );

    const summary = await runWorkflow(
      {
        name: 'plugin-skip',
        seedUrls: [`${baseUrl}/skip-me`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        plugins: [
          { name: 'skip-plugin', path: './plugins/skip-plugin.js' },
        ],
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
    assert.equal(summary.failureCount, 0);
    assert.equal(summary.skippedCount, 1);
    assert.equal(requestCount, 0);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner discovery rules can prioritize, enrich, and filter discovered links', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);

    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Discovery Home</title></head>
          <body>
            <a href="/list?page=1">Category listing</a>
            <a href="/detail/42">Product detail</a>
            <a href="/private" rel="nofollow">Private area</a>
            <a href="/logout">Logout</a>
            <a href="/brochure.pdf">Brochure</a>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/detail/42') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Detail 42</title></head><body>detail</body></html>');
      return;
    }

    if (req.url === '/list?page=1') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Listing</title></head><body>list</body></html>');
      return;
    }

    if (req.url === '/private' || req.url === '/logout' || req.url === '/brochure.pdf') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('should not be fetched');
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-discovery-rules-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'discovery-rules',
        seedUrls: [`${baseUrl}/`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 1,
        discovery: {
          enabled: true,
          maxPages: 10,
          maxLinksPerPage: 10,
          sameOriginOnly: true,
          respectNoFollow: true,
          skipFileExtensions: ['pdf'],
          rules: [
            { pattern: '/logout$', action: 'skip' },
            { pattern: '/detail/', priority: 90, label: 'detail', userData: { lane: 'detail' }, metadata: { bucket: 'detail' } },
            { pattern: '/list', priority: 10, label: 'listing', userData: { lane: 'listing' }, metadata: { bucket: 'listing' } },
          ],
          extractor: { name: 'links', type: 'links', all: true },
        },
        extract: [
          { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
        ],
        plugins: [{ name: 'dedupe' }, { name: 'audit' }],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    assert.equal(summary.status, 'completed');
    assert.equal(summary.pagesFetched, 3);
    assert.deepEqual(requests, ['/', '/detail/42', '/list?page=1']);

    const resultsRaw = await readFile(join(summary.runDir, 'results.ndjson'), 'utf8');
    const records = resultsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.equal(records[0].url, `${baseUrl}/`);
    assert.equal(records[1].url, `${baseUrl}/detail/42`);
    assert.equal(records[2].url, `${baseUrl}/list?page=1`);

    const queueState = JSON.parse(await readFile(join(summary.runDir, 'request-queue.json'), 'utf8'));
    const queuedRequests = Object.values(queueState.requests);
    const detailRequest = queuedRequests.find((entry) => entry.url === `${baseUrl}/detail/42`);
    const listingRequest = queuedRequests.find((entry) => entry.url === `${baseUrl}/list?page=1`);

    assert.ok(detailRequest);
    assert.ok(listingRequest);
    assert.equal(detailRequest.priority, 90);
    assert.equal(detailRequest.label, 'detail');
    assert.equal(detailRequest.userData.lane, 'detail');
    assert.equal(detailRequest.metadata.anchorText, 'Product detail');
    assert.equal(detailRequest.metadata.bucket, 'detail');
    assert.equal(detailRequest.metadata.matchedRule, '/detail/');

    assert.equal(listingRequest.priority, 10);
    assert.equal(listingRequest.label, 'listing');
    assert.equal(listingRequest.userData.lane, 'listing');
    assert.equal(listingRequest.metadata.anchorText, 'Category listing');
    assert.equal(listingRequest.metadata.bucket, 'listing');
    assert.equal(listingRequest.metadata.matchedRule, '/list');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner auto-classifies pagination and skips canonical alternate asset and logout links by default', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);

    if (req.url === '/catalog') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head>
            <title>Catalog</title>
            <link rel="next" href="/catalog?page=2" />
            <link rel="canonical" href="/catalog" />
            <link rel="alternate" hreflang="en" href="/en/catalog" />
          </head>
          <body>
            <a href="/product/9">Product 9</a>
            <a href="/logout">Logout</a>
            <a href="/manual.pdf">Manual</a>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/catalog?page=2') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Catalog page 2</title></head><body>page 2</body></html>');
      return;
    }

    if (req.url === '/product/9') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Product 9</title></head><body>detail</body></html>');
      return;
    }

    if (req.url === '/logout' || req.url === '/manual.pdf' || req.url === '/en/catalog') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('should not be fetched');
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-discovery-classify-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'discovery-classify-defaults',
        seedUrls: [`${baseUrl}/catalog`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 1,
        discovery: {
          enabled: true,
          maxPages: 10,
          maxLinksPerPage: 10,
          sameOriginOnly: true,
        },
        extract: [
          { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
        ],
        plugins: [{ name: 'dedupe' }, { name: 'audit' }],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    assert.equal(summary.status, 'completed');
    assert.equal(summary.pagesFetched, 3);
    assert.deepEqual(requests, ['/catalog', '/catalog?page=2', '/product/9']);

    const resultsRaw = await readFile(join(summary.runDir, 'results.ndjson'), 'utf8');
    const records = resultsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.equal(records[1].url, `${baseUrl}/catalog?page=2`);
    assert.equal(records[2].url, `${baseUrl}/product/9`);

    const queueState = JSON.parse(await readFile(join(summary.runDir, 'request-queue.json'), 'utf8'));
    const queuedRequests = Object.values(queueState.requests);
    const paginationRequest = queuedRequests.find((entry) => entry.url === `${baseUrl}/catalog?page=2`);
    const detailRequest = queuedRequests.find((entry) => entry.url === `${baseUrl}/product/9`);

    assert.ok(paginationRequest);
    assert.ok(detailRequest);
    assert.equal(paginationRequest.label, 'pagination');
    assert.equal(paginationRequest.priority, 85);
    assert.equal(paginationRequest.userData.discoveryKind, 'pagination');
    assert.equal(paginationRequest.metadata.kind, 'pagination');
    assert.equal(paginationRequest.metadata.paginationMethod, 'html-selector');

    assert.equal(detailRequest.label, 'detail');
    assert.equal(detailRequest.priority, 70);
    assert.equal(detailRequest.userData.discoveryKind, 'detail');
    assert.equal(detailRequest.metadata.kind, 'detail');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner enforces discovery lane budgets for detail pages', async () => {
  const starts = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/catalog') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Lane Catalog</title></head>
          <body>
            <a href="/catalog?page=2">Next page</a>
            <a href="/product/1">Product 1</a>
            <a href="/product/2">Product 2</a>
            <a href="/product/3">Product 3</a>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/catalog?page=2' || req.url === '/product/1' || req.url === '/product/2' || req.url === '/product/3') {
      starts.push({ url: req.url, at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 120));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><title>${req.url}</title></head><body>${req.url}</body></html>`);
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-discovery-lanes-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'discovery-lanes',
        seedUrls: [`${baseUrl}/catalog`],
        mode: 'http',
        concurrency: 3,
        maxDepth: 1,
        discovery: {
          enabled: true,
          maxPages: 10,
          maxLinksPerPage: 10,
          sameOriginOnly: true,
          strategy: {
            lanes: {
              detail: {
                maxInProgress: 1,
                budgetWindowMs: 180,
                maxRequestsPerWindow: 1,
              },
            },
          },
        },
        extract: [
          { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
        ],
        plugins: [{ name: 'dedupe' }, { name: 'audit' }],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    assert.equal(summary.status, 'completed');
    assert.equal(summary.pagesFetched, 5);
    assert.ok(summary.frontier.lanes.detail);
    assert.equal(summary.frontier.lanes.detail.maxInProgress, 1);
    assert.equal(summary.frontier.lanes.detail.maxRequestsPerWindow, 1);

    const paginationStart = starts.find((entry) => entry.url === '/catalog?page=2');
    const detailStarts = starts.filter((entry) => entry.url.startsWith('/product/'));

    assert.ok(paginationStart);
    assert.equal(detailStarts.length, 3);
    assert.ok(
      detailStarts[1].at - detailStarts[0].at >= 160,
      `expected lane budget gap before second detail, got ${detailStarts[1].at - detailStarts[0].at}ms`,
    );
    assert.ok(
      detailStarts[2].at - detailStarts[1].at >= 160,
      `expected lane budget gap before third detail, got ${detailStarts[2].at - detailStarts[1].at}ms`,
    );
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner applies host-aware frontier scheduling across concurrent seeds', async () => {
  const starts = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/a-1' || req.url === '/a-2' || req.url === '/b-1') {
      starts.push({
        url: `http://${req.headers.host}${req.url}`,
        at: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><title>${req.url.slice(1)}</title></head><body>${req.url}</body></html>`);
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-frontier-'));
  const sameHostBase = `http://127.0.0.1:${port}`;
  const otherHostBase = `http://localhost:${port}`;

  try {
    const summary = await runWorkflow(
      {
        name: 'frontier-host-aware',
        seedUrls: [`${sameHostBase}/a-1`, `${sameHostBase}/a-2`, `${otherHostBase}/b-1`],
        mode: 'http',
        concurrency: 2,
        maxDepth: 0,
        requestQueue: {
          hostAwareScheduling: true,
          maxInProgressPerHost: 1,
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

    const orderedStarts = [...starts].sort((left, right) => left.at - right.at).map((entry) => entry.url);
    const firstTwo = orderedStarts.slice(0, 2);

    assert.equal(summary.status, 'completed');
    assert.equal(summary.frontier.hostAwareScheduling, true);
    assert.equal(summary.frontier.maxInProgressPerHost, 1);
    assert.equal(firstTwo.includes(`${sameHostBase}/a-1`), true);
    assert.equal(firstTwo.includes(`${otherHostBase}/b-1`), true);
    assert.ok(orderedStarts.indexOf(`${otherHostBase}/b-1`) < orderedStarts.indexOf(`${sameHostBase}/a-2`));
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner honors request-level seed method, headers, and body', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    requests.push({
      method: req.method,
      body: Buffer.concat(chunks).toString('utf8'),
      contentType: req.headers['content-type'] ?? null,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<html><head><title>Seed Request OK</title></head><body>accepted</body></html>');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-seed-request-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'seed-request-overrides',
        seedUrls: [`${baseUrl}/submit`],
        seedRequests: [{
          url: `${baseUrl}/submit`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: '{"page":1}',
          label: 'seed-api',
          userData: {
            entry: 'api',
          },
        }],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        extract: [{ name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' }],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    assert.equal(summary.status, 'completed');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].contentType, 'application/json');
    assert.equal(requests[0].body, '{"page":1}');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner resolves workflow request templates from replayState and exposes them to extractors', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    requests.push({
      method: req.method,
      header: req.headers['x-auth'] ?? null,
      body: Buffer.concat(chunks).toString('utf8'),
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`
      <html>
        <head><title>Replay State HTTP</title></head>
        <body>
          <div id="header">${req.headers['x-auth'] ?? ''}</div>
          <div id="body">${requests.at(-1).body}</div>
        </body>
      </html>
    `);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-replay-state-http-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'replay-state-http-templates',
        seedUrls: [`${baseUrl}/templated`],
        seedRequests: [{
          url: `${baseUrl}/templated`,
          method: 'POST',
          replayState: {
            authToken: 'beta',
            payload: {
              id: 7,
            },
          },
        }],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        headers: {
          'x-auth': '{{authToken}}',
        },
        request: {
          method: 'POST',
          body: 'id={{payload.id}}',
        },
        extract: [
          { name: 'header', type: 'regex', pattern: '<div id="header">([^<]+)</div>' },
          { name: 'templatedHeader', type: 'regex', pattern: '<div id="header">({{authToken}})</div>' },
          { name: 'body', type: 'regex', pattern: '<div id="body">([^<]+)</div>' },
        ],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    assert.equal(summary.status, 'completed');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].header, 'beta');
    assert.equal(requests[0].body, 'id=7');

    const resultsRaw = await readFile(join(summary.runDir, 'results.ndjson'), 'utf8');
    const records = resultsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.equal(records.length, 1);
    assert.equal(records[0].extracted.header, 'beta');
    assert.equal(records[0].extracted.templatedHeader, 'beta');
    assert.equal(records[0].extracted.body, 'id=7');
    assert.equal(records[0].replayState.authToken, 'beta');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner applies origin-group budget windows when dispatching concurrent seeds', async () => {
  const starts = [];
  const makeServer = () => createServer(async (req, res) => {
    if (req.url === '/a-1' || req.url === '/a-2' || req.url === '/b-1') {
      starts.push({
        origin: `http://${req.headers.host}`,
        path: req.url,
        at: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><title>${req.url.slice(1)}</title></head><body>${req.url}</body></html>`);
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  const serverA = makeServer();
  const serverB = makeServer();
  serverA.listen(0, '127.0.0.1');
  serverB.listen(0, '127.0.0.1');
  await Promise.all([once(serverA, 'listening'), once(serverB, 'listening')]);
  const originA = `http://127.0.0.1:${serverA.address().port}`;
  const originB = `http://127.0.0.1:${serverB.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-frontier-budget-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'frontier-origin-budget',
        seedUrls: [`${originA}/a-1`, `${originA}/a-2`, `${originB}/b-1`],
        mode: 'http',
        concurrency: 2,
        maxDepth: 0,
        requestQueue: {
          groupBy: 'origin',
          hostAwareScheduling: true,
          maxInProgressPerGroup: 4,
          budgetWindowMs: 1000,
          maxRequestsPerWindow: 1,
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

    const orderedStarts = [...starts].sort((left, right) => left.at - right.at);
    const firstTwoOrigins = orderedStarts.slice(0, 2).map((entry) => entry.origin);

    assert.equal(summary.status, 'completed');
    assert.equal(summary.frontier.groupBy, 'origin');
    assert.equal(summary.frontier.maxRequestsPerWindow, 1);
    assert.equal(firstTwoOrigins.includes(originA), true);
    assert.equal(firstTwoOrigins.includes(originB), true);
    assert.ok(
      orderedStarts.findIndex((entry) => entry.origin === originB)
      < orderedStarts.findIndex((entry) => entry.origin === originA && entry.path === '/a-2'),
    );
  } finally {
    serverA.close();
    serverB.close();
    await Promise.all([once(serverA, 'close'), once(serverB, 'close')]);
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner delays the next same-origin request after a retryable failure when group backoff is enabled', async () => {
  const starts = [];
  let unstableAttempts = 0;
  const server = createServer((req, res) => {
    starts.push({
      url: `http://${req.headers.host}${req.url}`,
      at: Date.now(),
    });

    if (req.url === '/unstable') {
      unstableAttempts += 1;
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Busy</title></head><body>busy</body></html>');
      return;
    }

    if (req.url === '/stable') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Stable</title></head><body>ok</body></html>');
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-group-backoff-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'group-backoff-runner',
        seedUrls: [`${baseUrl}/unstable`, `${baseUrl}/stable`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        retry: {
          attempts: 1,
          retryOnStatuses: [503],
          groupBackoff: {
            enabled: true,
            groupBy: 'origin',
            baseDelayMs: 200,
            maxDelayMs: 200,
            statusCodes: [503],
          },
        },
        requestQueue: {
          groupBy: 'origin',
        },
        extract: [{ name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' }],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root },
    );

    const unstableStart = starts.find((entry) => entry.url === `${baseUrl}/unstable`);
    const stableStart = starts.find((entry) => entry.url === `${baseUrl}/stable`);

    assert.equal(summary.status, 'completed');
    assert.equal(summary.failureCount, 0);
    assert.ok(summary.frontier?.groupBackoff);
    assert.equal(summary.frontier.groupBackoff.enabled, true);
    assert.equal(unstableAttempts, 1);
    assert.ok(unstableStart);
    assert.ok(stableStart);
    assert.ok(stableStart.at - unstableStart.at >= 180);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner persists seen-set entries across runs and skips already-seen urls', async () => {
  let requestCount = 0;
  const server = createServer((req, res) => {
    if (req.url === '/seen') {
      requestCount += 1;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Seen</title></head><body>seen</body></html>');
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-seen-set-'));

  try {
    const workflow = {
      name: 'frontier-seen-set',
      seedUrls: [`${baseUrl}/seen`],
      mode: 'http',
      concurrency: 1,
      maxDepth: 0,
      requestQueue: {
        seenSet: {
          enabled: true,
          scope: 'workflow',
        },
      },
      extract: [{ name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' }],
      plugins: [{ name: 'dedupe' }],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    };

    const first = await runWorkflow(workflow, { projectRoot: root });
    const second = await runWorkflow(workflow, { projectRoot: root });

    assert.equal(first.status, 'completed');
    assert.equal(first.pagesFetched, 1);
    assert.equal(first.frontier.seenSet.enabled, true);
    assert.ok(first.frontier.seenSet.writeCount >= 1);

    assert.equal(second.status, 'completed');
    assert.equal(second.pagesFetched, 0);
    assert.equal(second.resultCount, 0);
    assert.ok(second.frontier.seenSet.hitCount >= 1);
    assert.equal(requestCount, 1);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner reuses a cross-run seen-set to skip already handled seeds', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    if (req.url === '/item') {
      requests.push(req.url);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Item</title></head><body>item</body></html>');
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-frontier-seen-'));
  const workflow = {
    name: 'frontier-seen-set',
    seedUrls: [`${origin}/item`],
    mode: 'http',
    concurrency: 1,
    maxDepth: 0,
    requestQueue: {
      groupBy: 'registrableDomain',
      seenSet: {
        enabled: true,
        id: 'frontier-seen-set-prod',
      },
    },
    extract: [{ name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' }],
    plugins: [{ name: 'dedupe' }],
    output: {
      dir: 'runs',
      persistBodies: false,
      console: false,
    },
  };

  try {
    const firstSummary = await runWorkflow(workflow, { projectRoot: root });
    const secondSummary = await runWorkflow(workflow, { projectRoot: root });

    assert.equal(firstSummary.status, 'completed');
    assert.equal(firstSummary.pagesFetched, 1);
    assert.equal(firstSummary.frontier.groupBy, 'registrableDomain');
    assert.equal(firstSummary.frontier.seenSet.enabled, true);
    assert.equal(firstSummary.frontier.seenSet.seenCount, 1);

    assert.equal(secondSummary.status, 'completed');
    assert.equal(secondSummary.pagesFetched, 0);
    assert.equal(secondSummary.queue.totalCount, 0);
    assert.equal(secondSummary.frontier.seenSet.seenCount, 1);
    assert.equal(requests.length, 1);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});
