import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.js';
import { WorkflowRegistry } from '../src/runtime/workflow-registry.js';
import { SqliteJobStore } from '../src/runtime/sqlite-job-store.js';
import { SqliteScheduleManager } from '../src/runtime/sqlite-scheduler.js';
import { SqliteRequestQueue } from '../src/runtime/sqlite-request-queue.js';
import { resolveDistributedConfig } from '../src/runtime/distributed-config.js';

async function createFixtureSite() {
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, title: 'distributed-platform' }));
      return;
    }

    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`
        function sign(value) {
          if (value) {
            return CryptoJS.AES.encrypt(value, "1234567890123456").toString();
          }
          return "";
        }
        __webpack_require__(1);
      `);
      return;
    }

    if (req.url === '/slow-page') {
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, title: 'slow-distributed' }));
      }, 400);
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

async function waitFor(condition, { attempts = 120, delayMs = 25 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await condition();
    if (result) {
      return result;
    }

    await sleep(delayMs);
  }

  return null;
}

async function readSseUntil(url, predicate, { timeoutMs = 5000 } = {}) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/event-stream',
    },
  });
  const reader = response.body.getReader();
  const events = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += Buffer.from(value).toString('utf8');
      let separatorIndex = buffer.indexOf('\n\n');

      while (separatorIndex >= 0) {
        const chunk = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        separatorIndex = buffer.indexOf('\n\n');

        const eventName = chunk.match(/^event: (.+)$/m)?.[1] ?? 'message';
        const dataText = chunk.match(/^data: (.+)$/m)?.[1];
        if (!dataText) {
          continue;
        }

        const event = {
          type: eventName,
          data: JSON.parse(dataText),
        };
        events.push(event);

        if (predicate(event, events)) {
          return events;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  throw new Error(`SSE predicate not satisfied for ${url}`);
}

test('distributed control plane queues jobs and worker executes them', async () => {
  const fixture = await createFixtureSite();
  const controlRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-distributed-control-'));
  const submitRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-distributed-submit-'));
  const queryRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-distributed-query-'));
  const dbPath = join(controlRoot, '.omnicrawl', 'control-plane.sqlite');
  const workerRuntime = await startServer({
    port: 0,
    projectRoot: submitRoot,
    distributed: {
      enabled: true,
      backend: 'sqlite',
      workerId: 'node-a',
      dbPath,
      pollIntervalMs: 20,
      heartbeatMs: 30,
      leaseTtlMs: 150,
      schedulerPollMs: 20,
      scheduleLeaseTtlMs: 150,
    },
  });
  const queryRuntime = await startServer({
    port: 0,
    projectRoot: queryRoot,
    distributed: {
      enabled: true,
      backend: 'sqlite',
      workerId: 'node-b',
      workerEnabled: false,
      dbPath,
      pollIntervalMs: 20,
      heartbeatMs: 30,
      leaseTtlMs: 150,
      schedulerPollMs: 20,
      scheduleLeaseTtlMs: 150,
    },
  });
  const submitApiBase = `http://127.0.0.1:${workerRuntime.server.address().port}`;
  const queryApiBase = `http://127.0.0.1:${queryRuntime.server.address().port}`;

  try {
    const createResponse = await fetch(`${submitApiBase}/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow: {
          name: 'distributed-job',
          seedUrls: [`${fixture.baseUrl}/slow-page`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          extract: [{ name: 'title', type: 'json', path: 'title' }],
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
    assert.equal(created.queued, true);

    const sseEvents = await readSseUntil(`${queryApiBase}/jobs/${created.jobId}/events`, (event) => event.type === 'job.completed');
    assert.ok(sseEvents.some((event) => event.type === 'job.completed'));

    const completedJob = await waitFor(async () => {
      const response = await fetch(`${queryApiBase}/jobs/${created.jobId}`);
      const payload = await response.json();
      return payload.job?.status === 'completed' ? payload.job : null;
    });

    assert.ok(completedJob);
    assert.equal(completedJob.metadata.workerId, 'node-a');

    const resultsPayload = await waitFor(async () => {
      const response = await fetch(`${queryApiBase}/jobs/${created.jobId}/results`);
      const payload = await response.json();
      return payload.total > 0 ? payload : null;
    });
    assert.equal(resultsPayload.total, 1);
    assert.equal(resultsPayload.items[0].extracted.title, 'slow-distributed');

    const datasetsResponse = await fetch(`${queryApiBase}/datasets/${created.jobId}`);
    const datasetsPayload = await datasetsResponse.json();
    assert.equal(datasetsPayload.item.id, created.jobId);

    const kvResponse = await fetch(`${queryApiBase}/key-value-stores/${created.jobId}/records/SUMMARY`);
    const kvPayload = await kvResponse.json();
    assert.equal(kvPayload.record.value.jobId, created.jobId);

    const historyResponse = await fetch(`${queryApiBase}/history`);
    const historyPayload = await historyResponse.json();
    assert.ok(historyPayload.items.some((item) => item.jobId === created.jobId));
  } finally {
    await queryRuntime.close();
    await workerRuntime.close();
    await fixture.close();
    await sleep(50);
    await rm(controlRoot, { recursive: true, force: true });
    await rm(submitRoot, { recursive: true, force: true });
    await rm(queryRoot, { recursive: true, force: true });
  }
});

test('distributed scheduler lease allows only one enqueue across competing schedulers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-distributed-scheduler-'));
  const registry = new WorkflowRegistry({ projectRoot: root });
  const configA = resolveDistributedConfig({
    projectRoot: root,
    distributed: {
      enabled: true,
      backend: 'sqlite',
      workerId: 'scheduler-a',
      schedulerPollMs: 20,
      scheduleLeaseTtlMs: 120,
      leaseTtlMs: 120,
    },
  });
  const configB = resolveDistributedConfig({
    projectRoot: root,
    distributed: {
      enabled: true,
      backend: 'sqlite',
      workerId: 'scheduler-b',
      schedulerPollMs: 20,
      scheduleLeaseTtlMs: 120,
      leaseTtlMs: 120,
      dbPath: configA.dbPath,
    },
  });
  const jobStore = new SqliteJobStore({ dbPath: configA.dbPath });
  const schedulerA = new SqliteScheduleManager({
    workflowRegistry: registry,
    jobStore,
    controlPlane: configA,
  });
  const schedulerB = new SqliteScheduleManager({
    workflowRegistry: registry,
    jobStore,
    controlPlane: configB,
  });

  try {
    await registry.init();
    await jobStore.init();
    await registry.register({
      id: 'dist-scheduled',
      source: 'inline',
      workflow: {
        name: 'dist-scheduled',
        seedUrls: ['https://example.com'],
        mode: 'http',
        concurrency: 1,
        maxDepth: 0,
        extract: [],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: false,
        },
      },
    });

    await schedulerA.init();
    await schedulerB.init();

    const schedule = await schedulerA.create({
      workflowId: 'dist-scheduled',
      intervalMs: 150,
      enabled: true,
    });

    const firstScheduledJob = await waitFor(() => {
      return jobStore.list().find((item) => item.metadata?.scheduleId === schedule.id) ?? null;
    }, { attempts: 120, delayMs: 20 });

    assert.ok(firstScheduledJob);

    await schedulerA.setEnabled(schedule.id, false);
    await sleep(180);

    const jobs = jobStore.list().filter((item) => item.metadata?.scheduleId === schedule.id);
    assert.equal(jobs.length, 1);
  } finally {
    schedulerA.close();
    schedulerB.close();
    jobStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('distributed resume works from shared request queue state without local runDir', async () => {
  const fixture = await createFixtureSite();
  const controlRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-distributed-resume-control-'));
  const submitRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-distributed-resume-submit-'));
  const workerRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-distributed-resume-worker-'));
  const dbPath = join(controlRoot, '.omnicrawl', 'control-plane.sqlite');
  const jobStore = new SqliteJobStore({ dbPath });
  const queue = new SqliteRequestQueue({
    dbPath,
    jobId: 'job_distributed_resume',
    config: {
      reclaimInProgress: true,
    },
  });

  try {
    await jobStore.init();
    await queue.init();

    const workflow = {
      name: 'distributed-resume',
      seedUrls: [`${fixture.baseUrl}/page`],
      mode: 'http',
      concurrency: 1,
      maxDepth: 0,
      extract: [{ name: 'title', type: 'json', path: 'title' }],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    };

    const job = jobStore.createQueuedWorkflow({
      jobId: 'job_distributed_resume',
      workflow,
      source: 'fixture',
      metadata: { trigger: 'fixture' },
    });
    await queue.enqueue({
      url: `${fixture.baseUrl}/page`,
      depth: 0,
      parentUrl: null,
      method: 'GET',
    });
    const leased = await queue.dequeue();
    assert.ok(leased);
    jobStore.update(job.id, {
      status: 'interrupted',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      runDir: `distributed://${job.id}`,
    });

    const submitRuntime = await startServer({
      port: 0,
      projectRoot: submitRoot,
      distributed: {
        enabled: true,
        backend: 'sqlite',
        workerId: 'resume-submit',
        workerEnabled: false,
        dbPath,
        pollIntervalMs: 20,
        heartbeatMs: 30,
        leaseTtlMs: 150,
      },
    });
    const submitApiBase = `http://127.0.0.1:${submitRuntime.server.address().port}`;
    let workerRuntime = null;
    let workerApiBase = null;

    try {
      const response = await fetch(`${submitApiBase}/jobs/${job.id}/resume`, {
        method: 'POST',
      });
      assert.equal(response.status, 202);

      workerRuntime = await startServer({
        port: 0,
        projectRoot: workerRoot,
        distributed: {
          enabled: true,
          backend: 'sqlite',
          workerId: 'resume-node',
          dbPath,
          pollIntervalMs: 20,
          heartbeatMs: 30,
          leaseTtlMs: 150,
        },
      });
      workerApiBase = `http://127.0.0.1:${workerRuntime.server.address().port}`;

      const completed = await waitFor(async () => {
        const jobResponse = await fetch(`${workerApiBase}/jobs/${job.id}`);
        const payload = await jobResponse.json();
        return payload.job?.status === 'completed' ? payload.job : null;
      });

      assert.ok(completed);
      const resultsPayload = await waitFor(async () => {
        const resultsResponse = await fetch(`${submitApiBase}/jobs/${job.id}/results`);
        const payload = await resultsResponse.json();
        return payload.total > 0 ? payload : null;
      });
      assert.equal(resultsPayload.total, 1);
      assert.equal(resultsPayload.items[0].extracted.title, 'distributed-platform');

      const queueResponse = await fetch(`${submitApiBase}/jobs/${job.id}/queue`);
      const queuePayload = await queueResponse.json();
      assert.equal(queuePayload.summary.handledCount, 1);
    } finally {
      await workerRuntime?.close();
      await submitRuntime.close();
    }
  } finally {
    queue.close();
    jobStore.close();
    await fixture.close();
    await sleep(50);
    await rm(controlRoot, { recursive: true, force: true });
    await rm(submitRoot, { recursive: true, force: true });
    await rm(workerRoot, { recursive: true, force: true });
  }
});

test('distributed reverse extraction stores advanced reverse analysis in shared data plane', async () => {
  const fixture = await createFixtureSite();
  const controlRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-distributed-reverse-control-'));
  const submitRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-distributed-reverse-submit-'));
  const queryRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-distributed-reverse-query-'));
  const dbPath = join(controlRoot, '.omnicrawl', 'control-plane.sqlite');
  const workerRuntime = await startServer({
    port: 0,
    projectRoot: submitRoot,
    distributed: {
      enabled: true,
      backend: 'sqlite',
      workerId: 'reverse-node-a',
      dbPath,
      pollIntervalMs: 20,
      heartbeatMs: 30,
      leaseTtlMs: 150,
    },
  });
  const queryRuntime = await startServer({
    port: 0,
    projectRoot: queryRoot,
    distributed: {
      enabled: true,
      backend: 'sqlite',
      workerId: 'reverse-node-b',
      workerEnabled: false,
      dbPath,
      pollIntervalMs: 20,
      heartbeatMs: 30,
      leaseTtlMs: 150,
    },
  });
  const submitApiBase = `http://127.0.0.1:${workerRuntime.server.address().port}`;
  const queryApiBase = `http://127.0.0.1:${queryRuntime.server.address().port}`;

  try {
    const createResponse = await fetch(`${submitApiBase}/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow: {
          name: 'distributed-reverse-job',
          seedUrls: [`${fixture.baseUrl}/bundle.js`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          extract: [
            { name: 'crypto', type: 'reverse', operation: 'crypto.analyze' },
            { name: 'ast', type: 'reverse', operation: 'ast.controlFlow' },
          ],
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

    const completedJob = await waitFor(async () => {
      const response = await fetch(`${queryApiBase}/jobs/${created.jobId}`);
      const payload = await response.json();
      return payload.job?.status === 'completed' ? payload.job : null;
    });

    assert.ok(completedJob);

    const resultsPayload = await waitFor(async () => {
      const response = await fetch(`${queryApiBase}/jobs/${created.jobId}/results`);
      const payload = await response.json();
      return payload.total > 0 ? payload : null;
    });
    assert.equal(resultsPayload.total, 1);
    assert.equal(resultsPayload.items[0].extracted.crypto.kind, 'crypto-analysis');
    assert.ok(resultsPayload.items[0].extracted.crypto.cryptoTypes.some((item) => item.name === 'AES'));
    assert.equal(resultsPayload.items[0].extracted.ast.kind, 'ast-control-flow');
    assert.ok(resultsPayload.items[0].extracted.ast.controlFlow.functions.some((item) => item.name === 'sign'));
  } finally {
    await queryRuntime.close();
    await workerRuntime.close();
    await fixture.close();
    await sleep(50);
    await rm(controlRoot, { recursive: true, force: true });
    await rm(submitRoot, { recursive: true, force: true });
    await rm(queryRoot, { recursive: true, force: true });
  }
});
