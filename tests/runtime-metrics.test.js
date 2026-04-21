import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.js';
import { setTimeout as sleep } from 'node:timers/promises';

async function createFixtureSite() {
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Metrics</title></head><body><div data-token="ok">ready</div></body></html>');
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

async function waitForCompletedJob(apiBase, jobId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(50);
    const response = await fetch(`${apiBase}/jobs/${jobId}`);
    const payload = await response.json();
    if (payload.job.status === 'completed') {
      return payload.job;
    }
  }
  throw new Error(`job did not complete: ${jobId}`);
}

test('runtime metrics endpoint exposes aggregate platform state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-runtime-metrics-'));
  const fixture = await createFixtureSite();
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const createResponse = await fetch(`${apiBase}/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow: {
          name: 'runtime-metrics-job',
          seedUrls: [`${fixture.baseUrl}/page`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          observability: {
            tracing: { enabled: true },
            metrics: { enabled: true },
          },
          extract: [
            { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
          ],
          output: {
            dir: 'runs',
            persistBodies: false,
            console: false,
          },
        },
      }),
    });
    const created = await createResponse.json();
    await waitForCompletedJob(apiBase, created.jobId);

    const response = await fetch(`${apiBase}/runtime/metrics`);
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(typeof payload.jobs.total, 'number');
    assert.equal(typeof payload.browserPool.size, 'number');
    assert.equal(typeof payload.proxies.total, 'number');
    assert.equal(typeof payload.activeRuns, 'number');
    assert.ok(payload.history);
    assert.ok(payload.alertOutbox);
    assert.equal(typeof payload.alertOutbox.pending, 'number');
    assert.equal(typeof payload.history.warningRuns, 'number');
    assert.equal(typeof payload.history.deliveredAlerts, 'number');
    assert.ok(payload.observability);
    assert.equal(typeof payload.observability.enabledRuns, 'number');
    assert.equal(typeof payload.observability.spanCount, 'number');
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('metrics endpoint exposes Prometheus content type and observability metrics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-prom-metrics-'));
  const fixture = await createFixtureSite();
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const createResponse = await fetch(`${apiBase}/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow: {
          name: 'prom-metrics-job',
          seedUrls: [`${fixture.baseUrl}/page`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          observability: {
            tracing: { enabled: true },
            metrics: { enabled: true },
          },
          extract: [
            { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
          ],
          output: {
            dir: 'runs',
            persistBodies: false,
            console: false,
          },
        },
      }),
    });
    const created = await createResponse.json();
    await waitForCompletedJob(apiBase, created.jobId);

    const response = await fetch(`${apiBase}/metrics`);
    assert.equal(response.status, 200);
    const contentType = response.headers.get('content-type') ?? '';
    assert.match(contentType, /text\/plain/i);
    assert.match(contentType, /version=0\.0\.4/i);
    const payload = await response.text();
    assert.ok(payload.includes('omnicrawl_jobs_total'));
    assert.ok(payload.includes('page_requests_total'));
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
