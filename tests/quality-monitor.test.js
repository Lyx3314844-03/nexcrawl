import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow } from '../src/runtime/job-runner.js';
import { detectWafSurface, validateExtractedSchema } from '../src/runtime/quality-monitor.js';

async function createProtectedFixture() {
  const server = createServer((req, res) => {
    if (req.url === '/blocked') {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Server', 'cloudflare');
      res.setHeader('CF-Ray', 'test-ray');
      res.setHeader('Set-Cookie', '__cf_bm=test; Path=/; HttpOnly');
      res.end(`
        <html>
          <head><title>Attention Required</title></head>
          <body>
            <h1>Verify you are human</h1>
            <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/ok') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Healthy</title></head>
          <body><div data-token="abc-123">ok</div></body>
        </html>
      `);
      return;
    }

    if (req.url === '/signed') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        error: 'invalid signature',
        reason: 'timestamp expired',
      }));
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

test('quality monitor detects upstream WAF markers without bypass logic', () => {
  const waf = detectWafSurface({
    status: 403,
    headers: {
      server: 'cloudflare',
      'cf-ray': 'abc',
      'set-cookie': '__cf_bm=test',
    },
    body: 'Attention Required! Verify you are human. /cdn-cgi/challenge-platform/',
    url: 'https://example.com/protected',
  });

  assert.equal(waf.detected, true);
  assert.equal(waf.provider, 'cloudflare');
  assert.equal(waf.challengeLikely, true);
});

test('quality monitor validates extracted schema contracts', () => {
  const result = validateExtractedSchema(
    {
      title: 'ok',
      count: '3',
      tags: [],
    },
    {
      required: ['title', 'token'],
      types: {
        count: 'number',
        tags: 'array',
      },
    },
  );

  assert.equal(result.configured, true);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((entry) => entry.type === 'missing-required-field' && entry.field === 'token'));
  assert.ok(result.issues.some((entry) => entry.type === 'type-mismatch' && entry.field === 'count'));
});

test('job runner writes quality summary, schema alerts, and WAF observations', async () => {
  const fixture = await createProtectedFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-quality-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'quality-monitoring',
        seedUrls: [`${fixture.baseUrl}/blocked`, `${fixture.baseUrl}/ok`],
        mode: 'http',
        concurrency: 2,
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
      { projectRoot: root },
    );

    assert.equal(summary.status, 'completed');
    assert.equal(summary.quality.waf.detectedCount >= 1, true);
    assert.equal(summary.quality.schema.invalidRecordCount, 1);
    assert.equal(summary.quality.structure.shapeVariantCount >= 2, true);
    assert.equal(summary.quality.healthScore < 100, true);
    assert.ok(summary.quality.alerts.some((entry) => entry.type === 'waf-detected'));
    assert.ok(summary.quality.alerts.some((entry) => entry.type === 'schema-validation'));
    assert.ok(summary.quality.alerts.some((entry) => entry.type === 'shape-drift'));

    const summaryFile = JSON.parse(await readFile(join(summary.runDir, 'summary.json'), 'utf8'));
    assert.equal(summaryFile.quality.schema.invalidRecordCount, 1);

    const records = (await readFile(join(summary.runDir, 'results.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const blockedRecord = records.find((entry) => entry.url.endsWith('/blocked'));
    assert.ok(blockedRecord);
    assert.equal(blockedRecord.quality.waf.provider, 'cloudflare');
    assert.equal(blockedRecord.quality.schema.valid, false);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('job runner writes reverse diagnostics with suspects and recovery suggestions', async () => {
  const fixture = await createProtectedFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-diagnostics-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'reverse-diagnostics',
        seedUrls: [`${fixture.baseUrl}/blocked`, `${fixture.baseUrl}/signed`, `${fixture.baseUrl}/ok`],
        mode: 'http',
        concurrency: 3,
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
      { projectRoot: root },
    );

    assert.equal(summary.status, 'completed');
    assert.ok(summary.diagnostics);
    assert.ok(summary.diagnostics.state);
    assert.ok(summary.diagnostics.state.auth);
    assert.ok(summary.diagnostics.surface);
    assert.ok(summary.diagnostics.signals);
    assert.ok(Array.isArray(summary.diagnostics.suspects));
    assert.ok(Array.isArray(summary.diagnostics.timeline));
    assert.ok(Array.isArray(summary.diagnostics.chains));
    assert.ok(Array.isArray(summary.diagnostics.recovery));
    assert.ok(summary.diagnostics.recipe);
    assert.equal(summary.diagnostics.recipe.version, 1);
    assert.equal(summary.diagnostics.recipe.recommendedMode, 'browser');
    assert.ok(Array.isArray(summary.diagnostics.recipe.rationale));
    assert.ok(Array.isArray(summary.diagnostics.recipe.steps));
    assert.ok(summary.diagnostics.suspects.some((entry) => entry.type === 'fingerprint-or-anti-bot'));
    assert.ok(summary.diagnostics.suspects.some((entry) => entry.type === 'signature-or-parameter-chain'));
    assert.ok(summary.diagnostics.recovery.some((entry) => entry.type === 'fingerprint-or-anti-bot'));
    assert.ok(summary.diagnostics.timeline.length >= 0);
    assert.ok(summary.diagnostics.chains.length >= 0);
    assert.equal(typeof summary.diagnostics.state.auth.authHeaderCount, 'number');

    const summaryFile = JSON.parse(await readFile(join(summary.runDir, 'summary.json'), 'utf8'));
    assert.ok(summaryFile.diagnostics);
    assert.ok(summaryFile.diagnostics.signals.challengeCount >= 1);
    assert.ok(summaryFile.diagnostics.signals.signatureLikelyCount >= 1);
    assert.equal(summaryFile.diagnostics.recipe.recommendedMode, 'browser');

    const records = (await readFile(join(summary.runDir, 'results.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const blockedRecord = records.find((entry) => entry.url.endsWith('/blocked'));
    const signedRecord = records.find((entry) => entry.url.endsWith('/signed'));
    assert.ok(blockedRecord?.identity);
    assert.equal(blockedRecord?.diagnostics?.primaryClass, 'anti-bot');
    assert.equal(signedRecord?.diagnostics?.signatureLikely, true);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
