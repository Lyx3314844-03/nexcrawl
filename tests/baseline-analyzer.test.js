import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow } from '../src/runtime/job-runner.js';
import { HistoryStore } from '../src/runtime/history-store.js';
import { analyzeBaseline } from '../src/runtime/baseline-analyzer.js';

async function createBaselineFixture() {
  const server = createServer((req, res) => {
    if (req.url === '/stable') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Stable</title></head>
          <body><div data-token="stable-token">ok</div></body>
        </html>
      `);
      return;
    }

    if (req.url === '/drift') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Server', 'cloudflare');
      res.setHeader('CF-Ray', 'baseline');
      res.setHeader('Set-Cookie', '__cf_bm=test');
      res.statusCode = 403;
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

test('baseline analyzer reports regressions between summaries', () => {
  const baseline = analyzeBaseline({
    currentSummary: {
      jobId: 'current',
      pagesFetched: 1,
      resultCount: 1,
      failureCount: 1,
      httpCache: {
        changedCount: 3,
        unchangedCount: 0,
      },
      quality: {
        healthScore: 55,
        schema: { invalidRecordCount: 1 },
        waf: { detectedCount: 1, challengedCount: 1 },
        structure: {
          shapeVariantCount: 2,
          fieldCoverage: { token: 0.2 },
          fieldTypes: { token: [{ type: 'null', count: 1 }] },
        },
      },
    },
    previousSummary: {
      jobId: 'previous',
      finishedAt: '2026-01-01T00:00:00.000Z',
      pagesFetched: 3,
      resultCount: 3,
      failureCount: 0,
      httpCache: {
        changedCount: 0,
        unchangedCount: 3,
      },
      quality: {
        healthScore: 90,
        schema: { invalidRecordCount: 0 },
        waf: { detectedCount: 0, challengedCount: 0 },
        structure: {
          shapeVariantCount: 1,
          fieldCoverage: { token: 1 },
          fieldTypes: { token: [{ type: 'string', count: 3 }] },
        },
      },
    },
  });

  assert.equal(baseline.available, true);
  assert.equal(baseline.previousJobId, 'previous');
  assert.ok(baseline.alerts.some((entry) => entry.type === 'result-count-drop'));
  assert.ok(baseline.alerts.some((entry) => entry.type === 'failure-count-increase'));
  assert.ok(baseline.alerts.some((entry) => entry.type === 'content-change-increase'));
  assert.ok(baseline.alerts.some((entry) => entry.type === 'field-coverage-drop' && entry.field === 'token'));
  assert.ok(baseline.alerts.some((entry) => entry.type === 'field-type-change' && entry.field === 'token'));
});

test('job runner stores baseline comparison against previous successful run', async () => {
  const fixture = await createBaselineFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-baseline-'));
  const historyStore = new HistoryStore({ projectRoot: root });

  try {
    const baseSummary = await runWorkflow(
      {
        name: 'baseline-job',
        seedUrls: [`${fixture.baseUrl}/stable`],
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
        },
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root, historyStore },
    );

    assert.equal(baseSummary.baseline.available, false);

    const driftSummary = await runWorkflow(
      {
        name: 'baseline-job',
        seedUrls: [`${fixture.baseUrl}/drift`],
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
        },
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
      { projectRoot: root, historyStore },
    );

    assert.equal(driftSummary.baseline.available, true);
    assert.equal(driftSummary.baseline.previousJobId, baseSummary.jobId);
    assert.ok(driftSummary.baseline.alerts.some((entry) => entry.type === 'schema-regression'));
    assert.ok(driftSummary.baseline.alerts.some((entry) => entry.type === 'waf-challenge-increase'));
    assert.ok(driftSummary.baseline.alerts.some((entry) => entry.type === 'health-score-drop'));

    const storedHistory = await historyStore.get(driftSummary.jobId);
    assert.equal(storedHistory.baseline.previousJobId, baseSummary.jobId);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
