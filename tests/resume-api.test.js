import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.js';
import { buildRequestUniqueKey } from '../src/runtime/request-queue.js';

async function createFixtureSite() {
  const server = createServer((req, res) => {
    if (req.url === '/resume-page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Resume Fixture</title></head><body>resume-ok</body></html>');
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

async function waitForStatus(apiBase, jobId, expectedStatus) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${apiBase}/jobs/${jobId}`);
    const payload = await response.json();
    if (payload.job.status === expectedStatus) {
      return payload.job;
    }
    await sleep(50);
  }

  throw new Error(`job ${jobId} did not reach ${expectedStatus}`);
}

test('resume api continues interrupted jobs from persisted request queue state', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-resume-api-'));
  const jobId = 'job_resume_fixture';
  const runDir = join(root, 'runs', jobId);
  const queuePath = join(runDir, 'request-queue.json');
  const workflowPath = join(runDir, 'workflow.json');
  const jobsStatePath = join(root, '.omnicrawl', 'jobs.json');

  const workflow = {
    name: 'resume-job',
    seedUrls: [`${fixture.baseUrl}/resume-page`],
    mode: 'http',
    concurrency: 1,
    maxDepth: 0,
    requestQueue: {
      sortQueryParams: true,
      stripHash: true,
      reclaimInProgress: true,
    },
    extract: [{ name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' }],
    plugins: [{ name: 'audit' }],
    output: {
      dir: 'runs',
      persistBodies: false,
      console: false,
    },
  };

  const requestRecord = {
    uniqueKey: buildRequestUniqueKey({ url: `${fixture.baseUrl}/resume-page`, method: 'GET' }, workflow.requestQueue),
    url: `${fixture.baseUrl}/resume-page`,
    method: 'GET',
    body: undefined,
    depth: 0,
    parentUrl: null,
    label: null,
    metadata: {},
    status: 'inProgress',
    enqueueCount: 1,
    enqueuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handledAt: null,
    failedAt: null,
    lastError: null,
    finalUrl: null,
    responseStatus: null,
  };

  try {
    await mkdir(runDir, { recursive: true });
    await mkdir(join(root, '.omnicrawl'), { recursive: true });
    await writeFile(
      workflowPath,
      JSON.stringify(
        {
          source: 'fixture',
          workflow,
        },
        null,
        2,
      ),
    );
    await writeFile(
      queuePath,
      JSON.stringify(
        {
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          pending: [],
          requests: {
            [requestRecord.uniqueKey]: requestRecord,
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      jobsStatePath,
      JSON.stringify(
        [
          {
            id: jobId,
            workflowName: workflow.name,
            metadata: {
              trigger: 'fixture',
            },
            status: 'running',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            finishedAt: null,
            runDir,
            stats: {
              pagesFetched: 0,
              resultCount: 0,
              failureCount: 0,
            },
            events: [],
          },
        ],
        null,
        2,
      ),
    );

    const runtime = await startServer({ port: 0, projectRoot: root });
    const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

    try {
      const initialResponse = await fetch(`${apiBase}/jobs/${jobId}`);
      const initialPayload = await initialResponse.json();
      assert.equal(initialPayload.job.status, 'interrupted');

      const resumeResponse = await fetch(`${apiBase}/jobs/${jobId}/resume`, {
        method: 'POST',
      });
      assert.equal(resumeResponse.status, 202);

      const resumed = await waitForStatus(apiBase, jobId, 'completed');
      assert.equal(resumed.status, 'completed');

      const queueResponse = await fetch(`${apiBase}/jobs/${jobId}/queue`);
      assert.equal(queueResponse.status, 200);
      const queuePayload = await queueResponse.json();
      assert.equal(queuePayload.summary.handledCount, 1);

      const resultsResponse = await fetch(`${apiBase}/jobs/${jobId}/results`);
      const results = await resultsResponse.json();
      assert.equal(results.items.length, 1);
      assert.equal(results.items[0].extracted.title, 'Resume Fixture');
      assert.equal(results.items[0].uniqueKey, requestRecord.uniqueKey);
    } finally {
      await runtime.close();
    }
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('resume api preserves advanced reverse config from the persisted workflow snapshot', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-resume-api-reverse-'));
  const jobId = 'job_resume_reverse_fixture';
  const runDir = join(root, 'runs', jobId);
  const queuePath = join(runDir, 'request-queue.json');
  const workflowPath = join(runDir, 'workflow.json');
  const jobsStatePath = join(root, '.omnicrawl', 'jobs.json');

  const workflow = {
    name: 'resume-reverse-job',
    seedUrls: [`${fixture.baseUrl}/resume-page`],
    mode: 'http',
    concurrency: 1,
    maxDepth: 0,
    requestQueue: {
      sortQueryParams: true,
      stripHash: true,
      reclaimInProgress: true,
    },
    reverse: {
      enabled: true,
      cloudflare: {
        maxWaitMs: 3100,
      },
      captcha: {
        provider: 'capsolver',
        apiKey: 'CAP-RESUME',
        maxWaitMs: 8000,
      },
      behaviorSimulation: {
        typing: true,
      },
    },
    output: {
      dir: 'runs',
      persistBodies: false,
      console: false,
    },
  };

  const requestRecord = {
    uniqueKey: buildRequestUniqueKey({ url: `${fixture.baseUrl}/resume-page`, method: 'GET' }, workflow.requestQueue),
    url: `${fixture.baseUrl}/resume-page`,
    method: 'GET',
    body: undefined,
    depth: 0,
    parentUrl: null,
    label: null,
    metadata: {},
    status: 'inProgress',
    enqueueCount: 1,
    enqueuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handledAt: null,
    failedAt: null,
    lastError: null,
    finalUrl: null,
    responseStatus: null,
  };

  try {
    await mkdir(runDir, { recursive: true });
    await mkdir(join(root, '.omnicrawl'), { recursive: true });
    await writeFile(
      workflowPath,
      JSON.stringify(
        {
          source: 'fixture',
          workflow,
        },
        null,
        2,
      ),
    );
    await writeFile(
      queuePath,
      JSON.stringify(
        {
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          pending: [],
          requests: {
            [requestRecord.uniqueKey]: requestRecord,
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      jobsStatePath,
      JSON.stringify(
        [
          {
            id: jobId,
            workflowName: workflow.name,
            metadata: {
              trigger: 'fixture',
            },
            status: 'running',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            finishedAt: null,
            runDir,
            stats: {
              pagesFetched: 0,
              resultCount: 0,
              failureCount: 0,
            },
            events: [],
          },
        ],
        null,
        2,
      ),
    );

    const runtime = await startServer({ port: 0, projectRoot: root });
    const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

    try {
      const resumeResponse = await fetch(`${apiBase}/jobs/${jobId}/resume`, {
        method: 'POST',
      });
      assert.equal(resumeResponse.status, 202);

      const resumed = await waitForStatus(apiBase, jobId, 'completed');
      assert.equal(resumed.status, 'completed');

      const snapshotRaw = await readFile(join(resumed.runDir, 'workflow.json'), 'utf8');
      const snapshot = JSON.parse(snapshotRaw);

      assert.deepEqual(snapshot.workflow.reverse.cloudflare, { maxWaitMs: 3100 });
      assert.equal(snapshot.workflow.reverse.captcha.provider, 'capsolver');
      assert.equal(snapshot.workflow.reverse.captcha.apiKey, 'CAP-RESUME');
      assert.deepEqual(snapshot.workflow.reverse.behaviorSimulation, { typing: true });
    } finally {
      await runtime.close();
    }
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
