import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.js';

async function createFixtureSite() {
  let nestedVersion = 1;

  const server = createServer((req, res) => {
    if (req.url === '/json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, label: 'fixture' }));
      return;
    }

    if (req.url === '/nested') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(
        nestedVersion === 1
          ? {
              profile: {
                name: 'fixture-user',
                address: {
                  city: 'shanghai',
                  zip: '200000',
                },
              },
              stats: {
                score: 1,
              },
            }
          : {
              profile: {
                name: 'fixture-user',
                address: {
                  city: 'beijing',
                  zip: '100000',
                },
              },
              stats: {
                score: 2,
              },
            },
      ));
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
    setNestedVersion(value) {
      nestedVersion = Number(value);
    },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function waitForCompletedJob(apiBase, jobId) {
  let status = 'queued';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(50);
    const response = await fetch(`${apiBase}/jobs/${jobId}`);
    const payload = await response.json();
    status = payload.job.status;
    if (status === 'completed') {
      return payload.job;
    }
  }

  throw new Error(`job did not complete: ${jobId} (last status ${status})`);
}

test('api accepts job submission and exposes results', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-api-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const { server } = runtime;
  const apiPort = server.address().port;
  const apiBase = `http://127.0.0.1:${apiPort}`;

  try {
    const healthResponse = await fetch(`${apiBase}/health`);
    const health = await healthResponse.json();
    assert.equal(health.status, 'ok');

    const createResponse = await fetch(`${apiBase}/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow: {
          name: 'api-json-job',
          seedUrls: [`${fixture.baseUrl}/json`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          extract: [
            { name: 'label', type: 'json', path: 'label' },
            { name: 'ok', type: 'json', path: 'ok' },
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

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.ok(created.jobId);
    await waitForCompletedJob(apiBase, created.jobId);

    const resultsResponse = await fetch(`${apiBase}/jobs/${created.jobId}/results`);
    const results = await resultsResponse.json();
    assert.equal(results.total, 1);
    assert.equal(results.items.length, 1);
    assert.equal(results.items[0].extracted.label, 'fixture');
    assert.equal(results.items[0].extracted.ok, true);

    const detailResponse = await fetch(`${apiBase}/jobs/${created.jobId}/detail`);
    const detail = await detailResponse.json();
    assert.equal(detail.results.length, 1);
    assert.ok(detail.events.length >= 1);
    assert.equal(typeof detail.summary.quality.healthScore, 'number');
    assert.equal(detail.summary.baseline.available, false);
    assert.ok(detail.reverseAssets);
    assert.ok(Array.isArray(detail.reverseAssets.aiSurfaces));
    assert.equal(detail.latestAiSurface, null);

    const diagnosticsResponse = await fetch(`${apiBase}/jobs/${created.jobId}/diagnostics`);
    assert.equal(diagnosticsResponse.status, 200);
    const diagnosticsPayload = await diagnosticsResponse.json();
    assert.ok(diagnosticsPayload.item);
    assert.ok(Array.isArray(diagnosticsPayload.item.suspects));
    assert.ok(Array.isArray(diagnosticsPayload.item.recovery));

    const recipeResponse = await fetch(`${apiBase}/jobs/${created.jobId}/replay-recipe`);
    assert.equal(recipeResponse.status, 200);
    const recipePayload = await recipeResponse.json();
    assert.ok(recipePayload.item);
    assert.equal(recipePayload.item.version, 1);
    assert.ok(Array.isArray(recipePayload.item.steps));

    const replayWorkflowResponse = await fetch(`${apiBase}/jobs/${created.jobId}/replay-workflow`);
    assert.equal(replayWorkflowResponse.status, 200);
    const replayWorkflowPayload = await replayWorkflowResponse.json();
    assert.equal(replayWorkflowPayload.item.replay.replayOf, created.jobId);
    assert.equal(replayWorkflowPayload.item.maxDepth, 0);
    assert.equal(replayWorkflowPayload.item.discovery.enabled, false);
    assert.ok(replayWorkflowPayload.item.name.endsWith('-replay'));

    const replayTemplateResponse = await fetch(`${apiBase}/jobs/${created.jobId}/replay-workflow-template`);
    assert.equal(replayTemplateResponse.status, 200);
    const replayTemplatePayload = await replayTemplateResponse.json();
    assert.equal(replayTemplatePayload.item.version, 1);
    assert.ok(replayTemplatePayload.item.patch);
    assert.ok(Array.isArray(replayTemplatePayload.item.hints.instructions));
    assert.ok(Array.isArray(replayTemplatePayload.item.patch.browser.replay.steps));

    const replayRunResponse = await fetch(`${apiBase}/jobs/${created.jobId}/replay-workflow/run`, {
      method: 'POST',
    });
    assert.equal(replayRunResponse.status, 202);
    const replayRunPayload = await replayRunResponse.json();
    assert.ok(replayRunPayload.jobId);
    await waitForCompletedJob(apiBase, replayRunPayload.jobId);

    const patchedReplayRunResponse = await fetch(`${apiBase}/jobs/${created.jobId}/replay-workflow/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowPatch: {
          browser: {
            replay: {
              initScripts: ['window.__patchedReplay = "yes";'],
            },
          },
        },
      }),
    });
    assert.equal(patchedReplayRunResponse.status, 202);
    const patchedReplayRunPayload = await patchedReplayRunResponse.json();
    assert.ok(patchedReplayRunPayload.jobId);
    await waitForCompletedJob(apiBase, patchedReplayRunPayload.jobId);

    const filteredResultsResponse = await fetch(`${apiBase}/jobs/${created.jobId}/results?query=fixture`);
    const filteredResults = await filteredResultsResponse.json();
    assert.equal(filteredResults.total, 1);
    assert.equal(filteredResults.items.length, 1);

    const eventLogResponse = await fetch(`${apiBase}/jobs/${created.jobId}/event-log?type=job.completed`);
    const eventLog = await eventLogResponse.json();
    assert.equal(eventLog.total, 1);
    assert.equal(eventLog.items.length, 1);

    const exportResponse = await fetch(`${apiBase}/jobs/${created.jobId}/export?kind=results&format=csv`);
    const exportBody = await exportResponse.text();
    assert.match(exportBody, /sequence,url,finalUrl,mode,status/);
    assert.match(exportBody, /fixture/);

    const secondCreateResponse = await fetch(`${apiBase}/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow: {
          name: 'api-json-job',
          seedUrls: [`${fixture.baseUrl}/json`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          extract: [
            { name: 'label', type: 'json', path: 'label' },
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
    const secondCreated = await secondCreateResponse.json();
    await waitForCompletedJob(apiBase, secondCreated.jobId);

    const compareResponse = await fetch(`${apiBase}/jobs/compare?left=${created.jobId}&right=${secondCreated.jobId}`);
    const compare = await compareResponse.json();
    assert.equal(compare.left.jobId, created.jobId);
    assert.equal(compare.right.jobId, secondCreated.jobId);
    assert.equal(compare.overlap.sharedCount, 1);

    const secondDetailResponse = await fetch(`${apiBase}/jobs/${secondCreated.jobId}/detail`);
    const secondDetail = await secondDetailResponse.json();
    assert.equal(secondDetail.summary.baseline.available, true);
    assert.equal(secondDetail.summary.baseline.previousJobId, created.jobId);

    const trendsResponse = await fetch(`${apiBase}/history/trends?workflowName=api-json-job&limit=5`);
    assert.equal(trendsResponse.status, 200);
    const trends = await trendsResponse.json();
    assert.equal(trends.workflowName, 'api-json-job');
    assert.ok(Array.isArray(trends.items));
    assert.equal(trends.current.jobId, secondCreated.jobId);
    assert.equal(typeof trends.trend.available, 'boolean');

    const historyItemResponse = await fetch(`${apiBase}/history/${secondCreated.jobId}`);
    const historyItem = await historyItemResponse.json();
    assert.equal(historyItem.item.baseline.previousJobId, created.jobId);
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('api exposes nested change feed and change summary routes', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-api-changes-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const workflow = {
      name: 'api-nested-change-job',
      seedUrls: [`${fixture.baseUrl}/nested`],
      mode: 'http',
      concurrency: 1,
      maxDepth: 0,
      httpCache: {
        enabled: true,
        persistBody: true,
        reuseBodyOnNotModified: true,
      },
      extract: [
        { name: 'profile', type: 'json', path: 'profile' },
        { name: 'stats', type: 'json', path: 'stats' },
      ],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    };

    const firstCreate = await fetch(`${apiBase}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow }),
    });
    const first = await firstCreate.json();
    await waitForCompletedJob(apiBase, first.jobId);

    fixture.setNestedVersion(2);
    const secondCreate = await fetch(`${apiBase}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow }),
    });
    const second = await secondCreate.json();
    await waitForCompletedJob(apiBase, second.jobId);

    const summaryResponse = await fetch(`${apiBase}/jobs/${second.jobId}/change-summary`);
    assert.equal(summaryResponse.status, 200);
    const summaryPayload = await summaryResponse.json();
    assert.equal(summaryPayload.item.changedResultCount, 1);
    assert.ok(summaryPayload.item.fieldChangeCount >= 2);
    assert.ok(summaryPayload.item.topChangedFields.some((entry) => entry.field === 'profile'));

    const changesResponse = await fetch(`${apiBase}/jobs/${second.jobId}/changes`);
    assert.equal(changesResponse.status, 200);
    const changesPayload = await changesResponse.json();
    assert.equal(changesPayload.total, 1);
    assert.ok(changesPayload.items[0].fieldChanges.some((entry) => entry.path === 'profile.address.city'));
    assert.ok(changesPayload.items[0].fieldChanges.some((entry) => entry.path === 'stats.score'));

    const filteredResponse = await fetch(`${apiBase}/jobs/${second.jobId}/changes?path=profile.address.city`);
    assert.equal(filteredResponse.status, 200);
    const filteredPayload = await filteredResponse.json();
    assert.equal(filteredPayload.total, 1);
    assert.ok(filteredPayload.items[0].fieldChanges.some((entry) => entry.path === 'profile.address.city'));
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('api exposes failed request records for completed jobs', async () => {
  const failingSite = createServer((req, res) => {
    req.socket.destroy();
    res.destroy();
  });
  failingSite.listen(0, '127.0.0.1');
  await once(failingSite, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-api-failed-requests-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;
  const failingUrl = `http://127.0.0.1:${failingSite.address().port}/boom`;

  try {
    const createResponse = await fetch(`${apiBase}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflow: {
          name: 'api-failed-request-job',
          seedUrls: [failingUrl],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          retry: {
            attempts: 2,
          },
          output: {
            dir: 'runs',
            persistBodies: false,
            console: false,
          },
        },
      }),
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await waitForCompletedJob(apiBase, created.jobId);

    const failedResponse = await fetch(`${apiBase}/jobs/${created.jobId}/failed-requests`);
    assert.equal(failedResponse.status, 200);
    const failed = await failedResponse.json();

    assert.equal(failed.total, 1);
    assert.equal(failed.items[0].url, failingUrl);
    assert.equal(failed.items[0].attempt, 2);
    assert.equal(failed.items[0].status, null);
    assert.ok(failed.items[0].error.length > 0);

    const jobResponse = await fetch(`${apiBase}/jobs/${created.jobId}`);
    const jobPayload = await jobResponse.json();
    assert.equal(jobPayload.job.stats.failureCount, 1);
  } finally {
    await runtime.close();
    failingSite.close();
    await once(failingSite, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('api exposes reverse ai surface assets for completed jobs', async () => {
  const fixture = createServer((req, res) => {
    if (req.url === '/html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <body>
            <script>
              const payload = { token: "demo", page: 1 };
              fetch("/api/asset-search", {
                method: "POST",
                body: JSON.stringify(payload),
              });
            </script>
          </body>
        </html>
      `);
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-api-reverse-assets-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;
  const htmlUrl = `http://127.0.0.1:${fixture.address().port}/html`;

  try {
    const createResponse = await fetch(`${apiBase}/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow: {
          name: 'api-reverse-assets-job',
          seedUrls: [htmlUrl],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          reverse: {
            enabled: true,
            autoReverseAnalysis: true,
          },
          output: {
            dir: 'runs',
            persistBodies: true,
            console: false,
          },
        },
      }),
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await waitForCompletedJob(apiBase, created.jobId);

    const assetsResponse = await fetch(`${apiBase}/jobs/${created.jobId}/reverse-assets`);
    assert.equal(assetsResponse.status, 200);
    const assets = await assetsResponse.json();
    assert.ok(Array.isArray(assets.items.aiSurfaces));
    assert.equal(assets.items.aiSurfaces.length, 1);
    assert.equal(assets.items.aiSurfaces[0].classification, 'normal');

    const assetId = assets.items.aiSurfaces[0].assetId;
    const itemResponse = await fetch(`${apiBase}/jobs/${created.jobId}/reverse-assets/item?collection=aiSurfaces&assetId=${encodeURIComponent(assetId)}`);
    assert.equal(itemResponse.status, 200);
    const itemPayload = await itemResponse.json();
    assert.equal(itemPayload.item.payload.kind, 'ai-surface-analysis');
    assert.equal(itemPayload.item.payload.target, htmlUrl);
    assert.ok(itemPayload.item.payload.apiParameters.endpoints.includes('/api/asset-search'));

    const detailResponse = await fetch(`${apiBase}/jobs/${created.jobId}/detail`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.reverseAssets.aiSurfaces.length, 1);
    assert.equal(detail.latestAiSurface.payload.target, htmlUrl);
    assert.equal(detail.latestAiSurface.payload.protection.classification, 'normal');
  } finally {
    await runtime.close();
    fixture.close();
    await once(fixture, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('job auto-exports configured artifacts and records them in summary', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-api-exports-'));
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
          name: 'api-export-job',
          seedUrls: [`${fixture.baseUrl}/json`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          extract: [
            { name: 'label', type: 'json', path: 'label' },
          ],
          export: {
            enabled: true,
            outputs: [
              { kind: 'results', format: 'csv' },
              { kind: 'events', format: 'ndjson' },
              { kind: 'summary', format: 'json' },
            ],
          },
          output: {
            dir: 'runs',
            persistBodies: false,
            console: false,
          },
        },
      }),
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    const job = await waitForCompletedJob(apiBase, created.jobId);
    const detailResponse = await fetch(`${apiBase}/jobs/${created.jobId}/detail`);
    const detail = await detailResponse.json();

    assert.equal(Array.isArray(detail.summary.exports), true);
    assert.equal(detail.summary.exports.length, 3);

    const csvExport = detail.summary.exports.find((item) => item.kind === 'results' && item.format === 'csv');
    const eventsExport = detail.summary.exports.find((item) => item.kind === 'events');
    const summaryExport = detail.summary.exports.find((item) => item.kind === 'summary');

    assert.ok(csvExport?.path);
    assert.ok(eventsExport?.path);
    assert.ok(summaryExport?.path);

    const csvText = await readFile(csvExport.path, 'utf8');
    assert.match(csvText, /sequence/);
    assert.match(csvText, /finalUrl/);
    assert.match(csvText, /mode/);
    assert.match(csvText, /status/);
    assert.match(csvText, /fixture/);

    const eventsText = await readFile(eventsExport.path, 'utf8');
    assert.match(eventsText, /job\.completed/);

    const summaryText = await readFile(summaryExport.path, 'utf8');
    const exportedSummary = JSON.parse(summaryText);
    assert.equal(exportedSummary[0].jobId, created.jobId);
    assert.equal(exportedSummary[0].workflowName, 'api-export-job');
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('job stays completed when HTTP export delivery fails and summary records the failure', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-api-export-failure-'));
  let attempts = 0;
  const exportServer = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain body
    }
    attempts += 1;
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{"ok":false}');
  });
  exportServer.listen(0, '127.0.0.1');
  await once(exportServer, 'listening');

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
          name: 'api-export-failure-job',
          seedUrls: [`${fixture.baseUrl}/json`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          extract: [
            { name: 'label', type: 'json', path: 'label' },
          ],
          export: {
            enabled: true,
            outputs: [
              {
                kind: 'summary',
                format: 'json',
                path: `http://127.0.0.1:${exportServer.address().port}/ingest`,
                retryAttempts: 2,
                retryBackoffMs: 0,
              },
            ],
          },
          output: {
            dir: 'runs',
            persistBodies: false,
            console: false,
          },
        },
      }),
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await waitForCompletedJob(apiBase, created.jobId);

    const detailResponse = await fetch(`${apiBase}/jobs/${created.jobId}/detail`);
    const detail = await detailResponse.json();
    assert.equal(detail.summary.status, 'completed');
    assert.equal(detail.summary.exports.length, 1);
    assert.equal(detail.summary.exports[0].delivery, 'http');
    assert.equal(detail.summary.exports[0].delivered, false);
    assert.equal(detail.summary.exports[0].attempts, 3);
    assert.equal(detail.summary.exports[0].status, 502);
    assert.match(detail.summary.exports[0].reason ?? '', /status 502/);
    assert.equal(attempts, 3);
  } finally {
    await runtime.close();
    await fixture.close();
    exportServer.close();
    await once(exportServer, 'close');
    await rm(root, { recursive: true, force: true });
  }
});
