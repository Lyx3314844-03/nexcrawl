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
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Scheduled Page</title></head><body><a href="/page">loop</a></body></html>');
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
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function waitFor(condition, { attempts = 80, delayMs = 50 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await condition();
    if (result) {
      return result;
    }
    await sleep(delayMs);
  }

  return null;
}

test('workflow registry, schedule manager, history replay, and dashboard work together', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-platform-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const dashboardResponse = await fetch(`${apiBase}/dashboard`);
    const dashboardHtml = await dashboardResponse.text();
    assert.match(dashboardHtml, /OmniCrawl Control Panel/);
    assert.match(dashboardHtml, /零代码快速开始/);
    assert.match(dashboardHtml, /Recent Run Health/);
    assert.match(dashboardHtml, /平台运营面/);
    assert.match(dashboardHtml, /登录状态机/);
    assert.match(dashboardHtml, /协议语义学习/);
    assert.match(dashboardHtml, /审计日志/);

    const registerResponse = await fetch(`${apiBase}/workflows`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'scheduled-demo',
        workflow: {
          name: 'scheduled-demo',
          seedUrls: [`${fixture.baseUrl}/page`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          extract: [{ name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' }],
          plugins: [{ name: 'dedupe' }, { name: 'audit' }],
          output: {
            dir: 'runs',
            persistBodies: false,
            console: false,
          },
        },
      }),
    });

    assert.equal(registerResponse.status, 201);
    const registered = await registerResponse.json();
    assert.equal(registered.item.id, 'scheduled-demo');

    const runResponse = await fetch(`${apiBase}/workflows/scheduled-demo/run`, {
      method: 'POST',
    });
    assert.equal(runResponse.status, 202);
    const launched = await runResponse.json();
    assert.ok(launched.jobId);

    const firstJob = await waitFor(async () => {
      const response = await fetch(`${apiBase}/jobs/${launched.jobId}`);
      const payload = await response.json();
      return payload.job.status === 'completed' ? payload.job : null;
    });
    assert.ok(firstJob);

    const historyAfterRun = await waitFor(async () => {
      const response = await fetch(`${apiBase}/history`);
      const payload = await response.json();
      return payload.items.find((item) => item.jobId === launched.jobId) ?? null;
    });
    assert.ok(historyAfterRun);

    const replayResponse = await fetch(`${apiBase}/history/${launched.jobId}/replay`, {
      method: 'POST',
    });
    assert.equal(replayResponse.status, 202);
    const replayed = await replayResponse.json();
    assert.ok(replayed.jobId);

    const scheduleResponse = await fetch(`${apiBase}/schedules`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowId: 'scheduled-demo',
        intervalMs: 100,
        enabled: true,
      }),
    });
    assert.equal(scheduleResponse.status, 201);
    const schedule = await scheduleResponse.json();
    assert.ok(schedule.item.id);

    const scheduleTriggeredJob = await waitFor(async () => {
      const response = await fetch(`${apiBase}/history`);
      const payload = await response.json();
      return payload.items.find((item) => item.metadata?.scheduleId === schedule.item.id) ?? null;
    }, { attempts: 120, delayMs: 50 });
    assert.ok(scheduleTriggeredJob);

    const disableResponse = await fetch(`${apiBase}/schedules/${schedule.item.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableResponse.status, 200);
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('history replay preserves advanced reverse workflow config in the replayed snapshot', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-platform-replay-reverse-'));
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
          name: 'history-replay-reverse',
          seedUrls: [`${fixture.baseUrl}/page`],
          mode: 'http',
          concurrency: 1,
          maxDepth: 0,
          reverse: {
            enabled: true,
            cloudflare: {
              maxWaitMs: 2400,
            },
            captcha: {
              provider: 'capsolver',
              apiKey: 'CAP-HISTORY',
              maxWaitMs: 6000,
            },
            behaviorSimulation: {
              scrolling: true,
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

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();

    const originalJob = await waitFor(async () => {
      const response = await fetch(`${apiBase}/jobs/${created.jobId}`);
      const payload = await response.json();
      return payload.job.status === 'completed' ? payload.job : null;
    });
    assert.ok(originalJob);

    const replayResponse = await fetch(`${apiBase}/history/${created.jobId}/replay`, {
      method: 'POST',
    });
    assert.equal(replayResponse.status, 202);
    const replayed = await replayResponse.json();

    const replayedJob = await waitFor(async () => {
      const response = await fetch(`${apiBase}/jobs/${replayed.jobId}`);
      const payload = await response.json();
      return payload.job.status === 'completed' ? payload.job : null;
    });
    assert.ok(replayedJob);

    const replaySnapshotRaw = await readFile(join(replayedJob.runDir, 'workflow.json'), 'utf8');
    const replaySnapshot = JSON.parse(replaySnapshotRaw);

    assert.deepEqual(replaySnapshot.workflow.reverse.cloudflare, { maxWaitMs: 2400 });
    assert.equal(replaySnapshot.workflow.reverse.captcha.provider, 'capsolver');
    assert.equal(replaySnapshot.workflow.reverse.captcha.apiKey, 'CAP-HISTORY');
    assert.deepEqual(replaySnapshot.workflow.reverse.behaviorSimulation, { scrolling: true });
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
