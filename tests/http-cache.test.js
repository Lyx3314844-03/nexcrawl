import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow } from '../src/runtime/job-runner.js';
import { KeyValueStore } from '../src/runtime/key-value-store.js';
import { SqliteDataPlane } from '../src/runtime/sqlite-data-plane.js';

async function createConditionalCacheFixture() {
  const requests = [];
  let version = 1;

  const server = createServer((req, res) => {
    if (req.url === '/page') {
      const etag = version === 1 ? '"page-v1"' : '"page-v2"';
      requests.push({
        url: req.url,
        ifNoneMatch: req.headers['if-none-match'] ?? null,
        version,
      });

      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', 'Wed, 01 Jan 2025 00:00:00 GMT');
        res.end();
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', 'Wed, 01 Jan 2025 00:00:00 GMT');
      res.end(version === 1
        ? '<html><head><title>Cached Title</title></head><body>cached-body</body></html>'
        : '<html><head><title>Updated Title</title></head><body>changed-body</body></html>');
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    setVersion(nextVersion) {
      version = nextVersion;
    },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

test('http cache reuses cached body on 304 responses across runs', async () => {
  const fixture = await createConditionalCacheFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-http-cache-'));

  const workflow = {
    name: 'http-cache-fixture',
    seedUrls: [`${fixture.baseUrl}/page`],
    mode: 'http',
    concurrency: 1,
    maxDepth: 0,
    httpCache: {
      enabled: true,
      persistBody: true,
      reuseBodyOnNotModified: true,
      maxBodyBytes: 200_000,
    },
    extract: [
      { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
    ],
    output: {
      dir: 'runs',
      persistBodies: false,
      console: false,
    },
  };

  try {
    const firstSummary = await runWorkflow(workflow, { projectRoot: root });
    assert.equal(firstSummary.status, 'completed');
    assert.equal(firstSummary.httpCache.storesWritten, 1);
    assert.equal(fixture.requests[0].ifNoneMatch, null);

    const secondSummary = await runWorkflow(workflow, { projectRoot: root });
    assert.equal(secondSummary.status, 'completed');
    assert.equal(secondSummary.httpCache.conditionalRequests, 1);
    assert.equal(secondSummary.httpCache.notModifiedCount, 1);
    assert.equal(secondSummary.httpCache.bodyReuseCount, 1);
    assert.equal(fixture.requests[1].ifNoneMatch, '"page-v1"');

    const secondResultsRaw = await readFile(join(secondSummary.runDir, 'results.ndjson'), 'utf8');
    const secondRecords = secondResultsRaw.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(secondRecords.length, 1);
    assert.equal(secondRecords[0].status, 304);
    assert.equal(secondRecords[0].notModified, true);
    assert.equal(secondRecords[0].cacheReused, true);
    assert.equal(secondRecords[0].extracted.title, 'Cached Title');
    assert.equal(secondRecords[0].contentState, 'unchanged');
    assert.equal(secondRecords[0].extractedChangeState, 'unchanged');

    fixture.setVersion(2);
    const thirdSummary = await runWorkflow(workflow, { projectRoot: root });
    assert.equal(thirdSummary.status, 'completed');
    assert.equal(thirdSummary.httpCache.changedCount, 1);
    assert.equal(thirdSummary.changeTracking.changedResultCount, 1);
    assert.equal(thirdSummary.changeTracking.fieldChangeCount, 1);

    const thirdResultsRaw = await readFile(join(thirdSummary.runDir, 'results.ndjson'), 'utf8');
    const thirdRecords = thirdResultsRaw.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(thirdRecords[0].status, 200);
    assert.equal(thirdRecords[0].contentState, 'changed');
    assert.equal(thirdRecords[0].extractedChangeState, 'changed');
    assert.deepEqual(thirdRecords[0].changedFields, ['title']);
    assert.equal(thirdRecords[0].extracted.title, 'Updated Title');

    const changeFeedRecord = await KeyValueStore.getRecord({
      projectRoot: root,
      storeId: thirdSummary.jobId,
      key: 'CHANGE_FEED',
    });
    assert.ok(changeFeedRecord);
    assert.equal(changeFeedRecord.value.length, 1);
    assert.equal(changeFeedRecord.value[0].fieldChanges[0].field, 'title');
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('http cache can be shared through sqlite data plane across project roots', async () => {
  const fixture = await createConditionalCacheFixture();
  const rootA = await mkdtemp(join(tmpdir(), 'omnicrawl-http-cache-shared-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'omnicrawl-http-cache-shared-b-'));
  const dbDir = await mkdtemp(join(tmpdir(), 'omnicrawl-http-cache-db-'));
  const dbPath = join(dbDir, 'control-plane.sqlite');

  const workflow = {
    name: 'http-cache-shared-fixture',
    seedUrls: [`${fixture.baseUrl}/page`],
    mode: 'http',
    concurrency: 1,
    maxDepth: 0,
    httpCache: {
      enabled: true,
      shared: true,
      storeId: 'shared-http-cache',
      persistBody: true,
      reuseBodyOnNotModified: true,
    },
    extract: [
      { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
    ],
    output: {
      dir: 'runs',
      persistBodies: false,
      console: false,
    },
  };
  const firstDataPlane = new SqliteDataPlane({ dbPath });
  const secondDataPlane = new SqliteDataPlane({ dbPath });

  try {
    const firstSummary = await runWorkflow(workflow, {
      projectRoot: rootA,
      controlPlane: {
        enabled: true,
        backend: 'sqlite',
        dbPath,
      },
      dataPlane: firstDataPlane,
    });
    assert.equal(firstSummary.status, 'completed');
    assert.equal(firstSummary.httpCache.storesWritten, 1);

    const secondSummary = await runWorkflow(workflow, {
      projectRoot: rootB,
      controlPlane: {
        enabled: true,
        backend: 'sqlite',
        dbPath,
      },
      dataPlane: secondDataPlane,
    });
    assert.equal(secondSummary.status, 'completed');
    assert.equal(secondSummary.httpCache.conditionalRequests, 1);
    assert.equal(secondSummary.httpCache.notModifiedCount, 1);
    assert.equal(secondSummary.httpCache.bodyReuseCount, 1);
    assert.equal(fixture.requests[1].ifNoneMatch, '"page-v1"');
  } finally {
    firstDataPlane.close();
    secondDataPlane.close();
    await fixture.close();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});
