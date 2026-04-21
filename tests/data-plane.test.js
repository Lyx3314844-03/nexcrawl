import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.js';

async function createFixtureSite() {
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, title: 'data-plane' }));
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

async function waitForCompletion(apiBase, jobId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${apiBase}/jobs/${jobId}`);
    const payload = await response.json();
    if (payload.job.status === 'completed') {
      return payload.job;
    }
    if (payload.job.status === 'failed') {
      throw new Error(`job failed: ${jobId}`);
    }
    await sleep(50);
  }

  throw new Error(`job timed out: ${jobId}`);
}

test('dataset and key-value data plane surfaces expose run outputs', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-data-plane-'));
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
          name: 'data-plane-job',
          seedUrls: [`${fixture.baseUrl}/page`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          extract: [{ name: 'title', type: 'json', path: 'title' }],
          plugins: [{ name: 'dedupe' }],
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
    await waitForCompletion(apiBase, created.jobId);

    const datasetsResponse = await fetch(`${apiBase}/datasets`);
    assert.equal(datasetsResponse.status, 200);
    const datasets = await datasetsResponse.json();
    assert.ok(datasets.items.some((item) => item.id === created.jobId));

    const datasetItemsResponse = await fetch(`${apiBase}/datasets/${created.jobId}/items`);
    assert.equal(datasetItemsResponse.status, 200);
    const datasetItems = await datasetItemsResponse.json();
    assert.equal(datasetItems.total, 1);
    assert.equal(datasetItems.items[0].extracted.title, 'data-plane');

    const kvStoresResponse = await fetch(`${apiBase}/key-value-stores`);
    assert.equal(kvStoresResponse.status, 200);
    const kvStores = await kvStoresResponse.json();
    assert.ok(kvStores.items.some((item) => item.id === created.jobId));

    const workflowRecordResponse = await fetch(`${apiBase}/key-value-stores/${created.jobId}/records/WORKFLOW`);
    assert.equal(workflowRecordResponse.status, 200);
    const workflowRecord = await workflowRecordResponse.json();
    assert.equal(workflowRecord.record.value.workflow.name, 'data-plane-job');

    const summaryRecordResponse = await fetch(`${apiBase}/key-value-stores/${created.jobId}/records/SUMMARY`);
    assert.equal(summaryRecordResponse.status, 200);
    const summaryRecord = await summaryRecordResponse.json();
    assert.equal(summaryRecord.record.value.jobId, created.jobId);
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
