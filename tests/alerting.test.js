import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeTrends } from '../src/runtime/trend-analyzer.js';
import { runWorkflow } from '../src/runtime/job-runner.js';
import { HistoryStore } from '../src/runtime/history-store.js';
import { startServer } from '../src/server.js';

async function createAlertingFixture({ failWebhookAttempts = 0 } = {}) {
  const webhookPayloads = [];
  const webhookRequests = [];
  let webhookAttemptCount = 0;
  let remainingWebhookFailures = failWebhookAttempts;

  const fixtureServer = createServer((req, res) => {
    if (req.url === '/healthy') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Healthy</title></head>
          <body><div data-token="good-token">ok</div></body>
        </html>
      `);
      return;
    }

    if (req.url === '/degraded') {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Server', 'cloudflare');
      res.setHeader('CF-Ray', 'alerting');
      res.setHeader('Set-Cookie', '__cf_bm=test');
      res.end(`
        <html>
          <head><title>Attention Required</title></head>
          <body>Verify you are human</body>
        </html>
      `);
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  const webhookServer = createServer(async (req, res) => {
    if (req.url !== '/webhook' || req.method !== 'POST') {
      res.statusCode = 404;
      res.end('missing');
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    webhookAttemptCount += 1;
    webhookRequests.push({
      headers: req.headers,
      body,
    });
    webhookPayloads.push(JSON.parse(body));
    if (remainingWebhookFailures > 0) {
      remainingWebhookFailures -= 1;
      res.statusCode = 502;
    } else {
      res.statusCode = 204;
    }
    res.end();
  });

  fixtureServer.listen(0, '127.0.0.1');
  webhookServer.listen(0, '127.0.0.1');
  await Promise.all([once(fixtureServer, 'listening'), once(webhookServer, 'listening')]);

  return {
    baseUrl: `http://127.0.0.1:${fixtureServer.address().port}`,
    webhookUrl: `http://127.0.0.1:${webhookServer.address().port}/webhook`,
    webhookPayloads,
    webhookRequests,
    setWebhookFailures(value) {
      remainingWebhookFailures = Math.max(0, Number(value ?? 0));
    },
    async close() {
      fixtureServer.close();
      webhookServer.close();
      await Promise.all([once(fixtureServer, 'close'), once(webhookServer, 'close')]);
    },
  };
}

test('trend analyzer flags values materially below recent successful-run averages', () => {
  const trend = analyzeTrends({
    currentSummary: {
      pagesFetched: 1,
      resultCount: 1,
      failureCount: 2,
      httpCache: {
        changedCount: 5,
        unchangedCount: 0,
      },
      quality: {
        healthScore: 50,
        schema: { invalidRecordCount: 1 },
        waf: { challengedCount: 2 },
      },
    },
    previousSummaries: [
      {
        jobId: 'a',
        pagesFetched: 4,
        resultCount: 4,
        failureCount: 0,
        httpCache: {
          changedCount: 1,
          unchangedCount: 3,
        },
        quality: {
          healthScore: 95,
          schema: { invalidRecordCount: 0 },
          waf: { challengedCount: 0 },
        },
      },
      {
        jobId: 'b',
        pagesFetched: 3,
        resultCount: 3,
        failureCount: 0,
        httpCache: {
          changedCount: 2,
          unchangedCount: 2,
        },
        quality: {
          healthScore: 92,
          schema: { invalidRecordCount: 0 },
          waf: { challengedCount: 0 },
        },
      },
    ],
  });

  assert.equal(trend.available, true);
  assert.equal(trend.sampleCount, 2);
  assert.ok(trend.alerts.some((entry) => entry.type === 'result-count-below-trend'));
  assert.ok(trend.alerts.some((entry) => entry.type === 'pages-fetched-below-trend'));
  assert.ok(trend.alerts.some((entry) => entry.type === 'health-score-below-trend'));
  assert.ok(trend.alerts.some((entry) => entry.type === 'failure-count-above-trend'));
  assert.ok(trend.alerts.some((entry) => entry.type === 'content-change-above-trend'));
  assert.ok(trend.alerts.some((entry) => entry.type === 'challenge-count-above-trend'));
});

test('job runner sends webhook alerts for baseline/trend/quality warnings', async () => {
  const fixture = await createAlertingFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-alerting-'));
  const historyStore = new HistoryStore({ projectRoot: root });

  try {
    const healthySummary = await runWorkflow(
      {
        name: 'alerting-job',
        seedUrls: [`${fixture.baseUrl}/healthy`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        extract: [
          { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
          { name: 'token', type: 'regex', pattern: 'data-token="([^"]+)"' },
        ],
        quality: {
          schema: {
            required: ['title', 'token'],
            types: {
              title: 'string',
              token: 'string',
            },
          },
          trend: {
            windowSize: 3,
          },
          alerting: {
            webhook: {
              enabled: true,
              url: fixture.webhookUrl,
              minSeverity: 'warning',
            },
          },
        },
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root, historyStore },
    );

    assert.equal(healthySummary.alertDelivery.delivered, false);
    assert.equal(fixture.webhookPayloads.length, 0);

    const degradedSummary = await runWorkflow(
      {
        name: 'alerting-job',
        seedUrls: [`${fixture.baseUrl}/degraded`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        extract: [
          { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
          { name: 'token', type: 'regex', pattern: 'data-token="([^"]+)"' },
        ],
        quality: {
          schema: {
            required: ['title', 'token'],
            types: {
              title: 'string',
              token: 'string',
            },
          },
          trend: {
            windowSize: 3,
          },
          alerting: {
            webhook: {
              enabled: true,
              url: fixture.webhookUrl,
              minSeverity: 'warning',
            },
          },
        },
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root, historyStore },
    );

    assert.equal(degradedSummary.trend.available, true);
    assert.equal(degradedSummary.trend.sampleCount, 1);
    assert.ok(degradedSummary.trend.alerts.some((entry) => entry.type === 'health-score-below-trend'));
    assert.ok(degradedSummary.alertDelivery.delivered, true);
    assert.equal(fixture.webhookPayloads.length, 1);

    const payload = fixture.webhookPayloads[0];
    assert.equal(payload.jobId, degradedSummary.jobId);
    assert.equal(payload.workflowName, 'alerting-job');
    assert.ok(payload.alerts.some((entry) => entry.source === 'quality' && entry.type === 'waf-detected'));
    assert.ok(payload.alerts.some((entry) => entry.source === 'baseline' && entry.type === 'schema-regression'));
    assert.ok(payload.alerts.some((entry) => entry.source === 'trend' && entry.type === 'health-score-below-trend'));
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('webhook alert delivery retries and signs payloads when configured', async () => {
  const fixture = await createAlertingFixture({ failWebhookAttempts: 1 });
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-alerting-signature-'));
  const historyStore = new HistoryStore({ projectRoot: root });

  try {
    await runWorkflow(
      {
        name: 'alerting-signature-job',
        seedUrls: [`${fixture.baseUrl}/healthy`],
        mode: 'http',
        concurrency: 1,
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
      { projectRoot: root, historyStore },
    );

    const degradedSummary = await runWorkflow(
      {
        name: 'alerting-signature-job',
        seedUrls: [`${fixture.baseUrl}/degraded`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        extract: [
          { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
          { name: 'token', type: 'regex', pattern: 'data-token="([^"]+)"' },
        ],
        quality: {
          schema: {
            required: ['title', 'token'],
            types: {
              title: 'string',
              token: 'string',
            },
          },
          alerting: {
            webhook: {
              enabled: true,
              url: fixture.webhookUrl,
              minSeverity: 'warning',
              signingSecret: 'top-secret',
              signatureAlgorithm: 'sha256',
              retryAttempts: 2,
              retryBackoffMs: 10,
            },
          },
        },
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root, historyStore },
    );

    assert.equal(degradedSummary.alertDelivery.delivered, true);
    assert.equal(degradedSummary.alertDelivery.attempts, 2);
    assert.equal(fixture.webhookRequests.length, 2);
    assert.match(String(fixture.webhookRequests[0].headers['x-omnicrawl-signature'] ?? ''), /^sha256=/);
    assert.ok(fixture.webhookRequests[0].headers['x-omnicrawl-timestamp']);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('server outbox persists failed webhook deliveries and drains them later', async () => {
  const fixture = await createAlertingFixture({ failWebhookAttempts: 10 });
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-alerting-outbox-'));
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
          name: 'outbox-job',
          seedUrls: [`${fixture.baseUrl}/degraded`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          extract: [
            { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
            { name: 'token', type: 'regex', pattern: 'data-token="([^"]+)"' },
          ],
          quality: {
            schema: {
              required: ['title', 'token'],
              types: {
                title: 'string',
                token: 'string',
              },
            },
            alerting: {
              webhook: {
                enabled: true,
                url: fixture.webhookUrl,
                minSeverity: 'warning',
                retryAttempts: 1,
                retryBackoffMs: 10,
              },
            },
          },
          output: {
            dir: 'runs',
            persistBodies: false,
            console: false,
          },
        },
      }),
    });
    const created = await createResponse.json();

    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await fetch(`${apiBase}/jobs/${created.jobId}`);
      const payload = await response.json();
      if (payload.job.status === 'completed') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const detailResponse = await fetch(`${apiBase}/jobs/${created.jobId}/detail`);
    const detail = await detailResponse.json();
    assert.equal(detail.summary.alertDelivery.delivered, false);
    assert.equal(detail.summary.alertDelivery.queued, true);

    const outboxResponse = await fetch(`${apiBase}/runtime/alerts/outbox`);
    assert.equal(outboxResponse.status, 200);
    const outbox = await outboxResponse.json();
    assert.equal(outbox.stats.pending >= 1, true);
    assert.ok(outbox.items.some((entry) => entry.jobId === created.jobId));

    fixture.setWebhookFailures(0);
    const drainResponse = await fetch(`${apiBase}/runtime/alerts/outbox/drain`, {
      method: 'POST',
    });
    assert.equal(drainResponse.status, 200);
    const drained = await drainResponse.json();
    assert.equal(drained.result.processed >= 1, true);

    const outboxAfterResponse = await fetch(`${apiBase}/runtime/alerts/outbox?includeDelivered=true`);
    const outboxAfter = await outboxAfterResponse.json();
    const deliveredEntry = outboxAfter.items.find((entry) => entry.jobId === created.jobId);
    assert.equal(deliveredEntry.status, 'delivered');
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
