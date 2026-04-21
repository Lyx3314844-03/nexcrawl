import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow } from '../src/runtime/job-runner.js';
import { startServer } from '../src/server.js';

async function createTargetServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/proxied') {
      if (req.headers['x-proxy-test'] !== 'enabled') {
        res.statusCode = 403;
        res.end('proxy required');
        return;
      }

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, via: 'proxy' }));
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function createRouteTargetServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/route-a') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ route: 'a', proxy: req.headers['x-proxy-route'] ?? 'none' }));
      return;
    }

    if (req.url === '/route-b') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ route: 'b', proxy: req.headers['x-proxy-route'] ?? 'none' }));
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function createForwardProxy(options = {}) {
  const {
    testHeader = 'enabled',
    routeHeader = null,
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
          ...(routeHeader ? { 'x-proxy-route': routeHeader } : {}),
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
      server.close();
      await once(server, 'close');
    },
  };
}

async function createFailingProxy() {
  const server = http.createServer((_req, res) => {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('bad proxy');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

test('http fetcher routes requests through configured proxy server', async () => {
  const target = await createTargetServer();
  const proxy = await createForwardProxy();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-proxy-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'proxy-http-job',
        seedUrls: [`${target.baseUrl}/proxied`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        proxy: {
          server: proxy.url,
        },
        extract: [
          { name: 'ok', type: 'json', path: 'ok' },
          { name: 'via', type: 'json', path: 'via' },
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

    const resultsRaw = await readFile(join(summary.runDir, 'results.ndjson'), 'utf8');
    const records = resultsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.equal(records.length, 1);
    assert.equal(records[0].status, 200);
    assert.equal(records[0].proxyServer, proxy.url);
    assert.equal(records[0].extracted.ok, true);
    assert.equal(records[0].extracted.via, 'proxy');
  } finally {
    await proxy.close();
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('proxy pool routes target URLs to matching proxies', async () => {
  const target = await createRouteTargetServer();
  const proxyA = await createForwardProxy({ routeHeader: 'a' });
  const proxyB = await createForwardProxy({ routeHeader: 'b' });
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-proxy-routes-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'proxy-routing-job',
        seedUrls: [`${target.baseUrl}/route-a`, `${target.baseUrl}/route-b`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        proxyPool: {
          enabled: true,
          strategy: 'roundRobin',
          servers: [
            {
              label: 'proxy-a',
              server: proxyA.url,
              match: {
                include: ['/route-a'],
              },
            },
            {
              label: 'proxy-b',
              server: proxyB.url,
              match: {
                include: ['/route-b'],
              },
            },
          ],
        },
        retry: {
          attempts: 1,
          backoffMs: 0,
        },
        extract: [
          { name: 'route', type: 'json', path: 'route' },
          { name: 'proxy', type: 'json', path: 'proxy' },
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

    const resultsRaw = await readFile(join(summary.runDir, 'results.ndjson'), 'utf8');
    const records = resultsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    const routeA = records.find((record) => record.extracted.route === 'a');
    const routeB = records.find((record) => record.extracted.route === 'b');

    assert.ok(routeA);
    assert.ok(routeB);
    assert.equal(routeA.proxyLabel, 'proxy-a');
    assert.equal(routeA.extracted.proxy, 'a');
    assert.equal(routeB.proxyLabel, 'proxy-b');
    assert.equal(routeB.extracted.proxy, 'b');
  } finally {
    await proxyB.close();
    await proxyA.close();
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('proxy pool honors identity region binding when bindProxyRegion is enabled', async () => {
  const target = await createRouteTargetServer();
  const proxyUs = await createForwardProxy({ routeHeader: 'us' });
  const proxyEu = await createForwardProxy({ routeHeader: 'eu' });
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-proxy-region-binding-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'proxy-region-binding-job',
        seedUrls: [`${target.baseUrl}/route-a`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        identity: {
          enabled: true,
          proxyCountry: 'US',
          consistency: {
            bindProxyRegion: true,
            httpHeaders: false,
          },
        },
        proxyPool: {
          enabled: true,
          strategy: 'roundRobin',
          servers: [
            {
              label: 'eu-proxy',
              server: proxyEu.url,
              country: 'DE',
            },
            {
              label: 'us-proxy',
              server: proxyUs.url,
              country: 'US',
            },
          ],
        },
        extract: [
          { name: 'route', type: 'json', path: 'route' },
          { name: 'proxy', type: 'json', path: 'proxy' },
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

    const resultsRaw = await readFile(join(summary.runDir, 'results.ndjson'), 'utf8');
    const records = resultsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.equal(records.length, 1);
    assert.equal(records[0].proxyLabel, 'us-proxy');
    assert.equal(records[0].extracted.proxy, 'us');
    assert.equal(records[0].identity.consistency.correctionCount, 0);
    assert.equal(records[0].identity.consistency.driftCount, 0);
    assert.equal(records[0].identity.consistency.unsupported.length, 0);
  } finally {
    await proxyEu.close();
    await proxyUs.close();
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('proxy pool rotates away from failing proxy and exposes runtime health', async () => {
  const target = await createTargetServer();
  const badProxy = await createFailingProxy();
  const goodProxy = await createForwardProxy();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-proxy-pool-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const response = await fetch(`${apiBase}/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow: {
          name: 'proxy-pool-http-job',
          seedUrls: [`${target.baseUrl}/proxied`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          proxyPool: {
            enabled: true,
            strategy: 'roundRobin',
            maxFailures: 1,
            cooldownMs: 60000,
            servers: [
              { label: 'bad', server: badProxy.url },
              { label: 'good', server: goodProxy.url },
            ],
          },
          retry: {
            attempts: 2,
            backoffMs: 0,
            retryOnStatuses: [502],
          },
          extract: [
            { name: 'ok', type: 'json', path: 'ok' },
            { name: 'via', type: 'json', path: 'via' },
          ],
          plugins: [{ name: 'dedupe' }, { name: 'audit' }],
          output: {
            dir: 'runs',
            persistBodies: false,
            console: false,
          },
        },
      }),
    });

    assert.equal(response.status, 202);
    const created = await response.json();

    for (let attempt = 0; attempt < 80; attempt += 1) {
      const jobResponse = await fetch(`${apiBase}/jobs/${created.jobId}`);
      const jobPayload = await jobResponse.json();
      if (jobPayload.job.status === 'completed') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const resultsResponse = await fetch(`${apiBase}/jobs/${created.jobId}/results`);
    const results = await resultsResponse.json();
    assert.equal(results.total, 1);
    assert.equal(results.items.length, 1);
    assert.equal(results.items[0].status, 200);
    assert.equal(results.items[0].proxyLabel, 'good');
    assert.equal(results.items[0].attemptsUsed, 2);

    const proxiesResponse = await fetch(`${apiBase}/runtime/proxies`);
    const proxies = await proxiesResponse.json();
    const badState = proxies.items.find((item) => item.label === 'bad');
    const goodState = proxies.items.find((item) => item.label === 'good');

    assert.ok(badState);
    assert.ok(goodState);
    assert.equal(badState.failureCount, 1);
    assert.equal(badState.inCooldown, true);
    assert.equal(goodState.successCount, 1);

    const disableResponse = await fetch(`${apiBase}/runtime/proxies/control`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        key: goodState.key,
        enabled: false,
      }),
    });
    assert.equal(disableResponse.status, 200);

    const noteResponse = await fetch(`${apiBase}/runtime/proxies/control`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        key: goodState.key,
        notes: 'maintenance',
      }),
    });
    assert.equal(noteResponse.status, 200);

    const resetResponse = await fetch(`${apiBase}/runtime/proxies/reset`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        key: badState.key,
      }),
    });
    assert.equal(resetResponse.status, 200);

    const refreshedProxyState = await fetch(`${apiBase}/runtime/proxies`);
    const refreshed = await refreshedProxyState.json();
    const disabledGood = refreshed.items.find((item) => item.key === goodState.key);
    const resetBad = refreshed.items.find((item) => item.key === badState.key);

    assert.equal(disabledGood.effectiveDisabled, true);
    assert.equal(disabledGood.notes, 'maintenance');
    assert.equal(resetBad.failureCount, 0);
    assert.equal(resetBad.inCooldown, false);

    const probeResponse = await fetch(`${apiBase}/runtime/proxies/probe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        key: goodState.key,
        targetUrl: `${target.baseUrl}/proxied`,
      }),
    });
    assert.equal(probeResponse.status, 200);
    const probePayload = await probeResponse.json();
    assert.equal(probePayload.result.ok, true);

    const afterProbeResponse = await fetch(`${apiBase}/runtime/proxies`);
    const afterProbe = await afterProbeResponse.json();
    const probedGood = afterProbe.items.find((item) => item.key === goodState.key);
    assert.equal(probedGood.lastProbeOk, true);
    assert.equal(probedGood.lastProbeStatus, 200);
  } finally {
    await runtime.close();
    await goodProxy.close();
    await badProxy.close();
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});
