import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.js';

async function createBrowserFixtureSite() {
  const server = createServer((req, res) => {
    if (req.url === '/set') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Set Session</title></head>
          <body>
            <a href="/profile">profile</a>
            <script>
              document.cookie = 'token=alpha; path=/';
              localStorage.setItem('auth', 'yes');
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/profile') {
      const hasCookie = String(req.headers.cookie || '').includes('token=alpha');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Profile</title></head>
          <body>
            <div id="cookie">cookie=${hasCookie ? 'present' : 'missing'}</div>
            <div id="storage">storage=pending</div>
            <script>
              document.getElementById('storage').textContent = 'storage=' + (localStorage.getItem('auth') || 'none');
            </script>
          </body>
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

async function createReplaySurfaceFixture() {
  let imageHits = 0;

  const server = createServer((req, res) => {
    if (req.url === '/replay') {
      const hasCookie = String(req.headers.cookie || '').includes('replayToken=beta');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Replay Surface</title></head>
          <body>
            <img src="/pixel.png" />
            <div id="init-script">cookie=${hasCookie ? 'present' : 'missing'}; script=${'pending'}</div>
            <div id="storage-seed">seed=pending</div>
            <script>
              document.getElementById('init-script').textContent =
                'cookie=${hasCookie ? 'present' : 'missing'}; script=' + (window.__replayInit || 'missing');
              document.getElementById('storage-seed').textContent =
                'seed=' + (localStorage.getItem('seeded-auth') || 'missing');
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/pixel.png') {
      imageHits += 1;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from([137, 80, 78, 71]));
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    getImageHits() {
      return imageHits;
    },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function createReplayStepsFixture() {
  let finalHits = 0;
  let submitHits = 0;
  let tokenHits = 0;
  let followupHits = 0;

  const server = createServer((req, res) => {
    if (req.url === '/bootstrap') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Bootstrap</title></head>
          <body>
            <div id="ready">ready</div>
            <script>
              localStorage.setItem('boot-token', 'xyz');
              document.cookie = 'boot-cookie=1; path=/';
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/interactive') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Interactive</title></head>
          <body>
            <label for="name">name</label>
            <input id="name" />
            <button id="trigger" type="button">trigger</button>
            <div id="result">pending</div>
            <script>
              document.getElementById('trigger').addEventListener('click', async () => {
                const value = document.getElementById('name').value;
                const response = await fetch('/api/token', {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                  },
                  body: 'name=' + encodeURIComponent(value),
                });
                const payload = await response.json();
                localStorage.setItem('api-token', payload.token);
                document.getElementById('result').textContent = payload.token;
              });
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/final/') {
      res.statusCode = 302;
      res.setHeader('Location', '/final');
      res.end();
      return;
    }

    if (req.url === '/final') {
      finalHits += 1;
      const hasCookie = String(req.headers.cookie || '').includes('boot-cookie=1');
      const header = req.headers['x-replay-header'] ?? 'missing';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Final</title></head>
          <body>
            <div id="header">header=${header}</div>
            <div id="cookie">cookie=${hasCookie ? 'present' : 'missing'}</div>
            <div id="storage">storage=pending</div>
            <script>
              document.getElementById('storage').textContent =
                'storage=' + (localStorage.getItem('boot-token') || localStorage.getItem('api-token') || 'missing');
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/final-with-link') {
      finalHits += 1;
      const header = req.headers['x-replay-header'] ?? 'missing';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Final With Link</title></head>
          <body>
            <div id="header">header=${header}</div>
            <a href="/followup">followup</a>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/followup') {
      followupHits += 1;
      const header = req.headers['x-replay-header'] ?? 'missing';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Followup</title></head>
          <body>
            <div id="header">header=${header}</div>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/api/token' && req.method === 'POST') {
      tokenHits += 1;
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const params = new URLSearchParams(body);
        const name = params.get('name') || 'anon';
        const payload = JSON.stringify({
          token: `signed-${name}`,
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(payload);
      });
      return;
    }

    if (req.url === '/submit' && req.method === 'POST') {
      submitHits += 1;
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`
          <html>
            <head><title>Submit</title></head>
            <body>
              <div id="body">${body}</div>
            </body>
          </html>
        `);
      });
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    getFinalHits() {
      return finalHits;
    },
    getSubmitHits() {
      return submitHits;
    },
    getTokenHits() {
      return tokenHits;
    },
    getFollowupHits() {
      return followupHits;
    },
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

async function submitJob(apiBase, workflow) {
  const response = await fetch(`${apiBase}/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workflow }),
  });

  assert.equal(response.status, 202);
  const payload = await response.json();
  await waitForCompletion(apiBase, payload.jobId);

  const resultsResponse = await fetch(`${apiBase}/jobs/${payload.jobId}/results`);
  const results = await resultsResponse.json();
  return {
    jobId: payload.jobId,
    records: results.items,
  };
}

test('browser session isolation and runtime surfaces work through the API', async () => {
  const fixture = await createBrowserFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-browser-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const baseWorkflow = {
      name: 'browser-session-test',
      seedUrls: [`${fixture.baseUrl}/set`],
      mode: 'browser',
      concurrency: 1,
      maxDepth: 1,
      browser: {
        headless: true,
        waitUntil: 'load',
      },
      extract: [
        { name: 'cookieSeen', type: 'regex', pattern: 'cookie=([^<]+)' },
        { name: 'storageSeen', type: 'regex', pattern: 'storage=([^<]+)' },
      ],
      discovery: {
        enabled: true,
        maxPages: 2,
        maxLinksPerPage: 10,
        sameOriginOnly: true,
        extractor: { name: 'links', type: 'links', all: true },
      },
      plugins: [{ name: 'dedupe' }, { name: 'audit' }],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    };

    const withoutSession = await submitJob(apiBase, {
      ...baseWorkflow,
      name: 'browser-without-session',
      session: {
        enabled: false,
      },
    });

    const noSessionProfile = withoutSession.records.find((record) => record.finalUrl.endsWith('/profile'));
    assert.ok(noSessionProfile);
    assert.equal(noSessionProfile.extracted.cookieSeen, 'missing');
    assert.equal(noSessionProfile.extracted.storageSeen, 'none');

    const withSession = await submitJob(apiBase, {
      ...baseWorkflow,
      name: 'browser-with-session',
      session: {
        enabled: true,
        scope: 'custom',
        id: 'browser-session-a',
        persist: true,
        isolate: true,
      },
    });

    const sessionProfile = withSession.records.find((record) => record.finalUrl.endsWith('/profile'));
    assert.ok(sessionProfile);
    assert.equal(sessionProfile.extracted.cookieSeen, 'present');
    assert.equal(sessionProfile.extracted.storageSeen, 'yes');

    const sessionsResponse = await fetch(`${apiBase}/sessions`);
    const sessions = await sessionsResponse.json();
    assert.ok(sessions.items.some((item) => item.id === 'browser-session-a'));

    const poolResponse = await fetch(`${apiBase}/runtime/browser-pool`);
    const pool = await poolResponse.json();
    assert.ok(pool.size >= 1);
    assert.ok(pool.items.some((item) => item.contextCount >= 1));
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('browser replay config injects scripts, seeds cookies, and blocks resource loads', async () => {
  const fixture = await createReplaySurfaceFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-browser-replay-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const run = await submitJob(apiBase, {
      name: 'browser-replay-config',
      seedUrls: [`${fixture.baseUrl}/replay`],
      mode: 'browser',
      concurrency: 1,
      maxDepth: 0,
      browser: {
        headless: true,
        waitUntil: 'load',
        replay: {
          initScripts: ['window.__replayInit = "armed";'],
          storageSeeds: [
            { area: 'localStorage', key: 'seeded-auth', value: 'ok' },
          ],
          blockResourceTypes: ['image'],
          cookies: [
            {
              name: 'replayToken',
              value: 'beta',
              url: `${fixture.baseUrl}/replay`,
            },
          ],
        },
      },
      extract: [
        { name: 'state', type: 'regex', pattern: '<div id="init-script">([^<]+)</div>' },
        { name: 'seed', type: 'regex', pattern: '<div id="storage-seed">([^<]+)</div>' },
      ],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    });

    assert.equal(run.records.length, 1);
    assert.equal(run.records[0].extracted.state, 'cookie=present; script=armed');
    assert.equal(run.records[0].extracted.seed, 'seed=ok');
    assert.equal(fixture.getImageHits(), 0);
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('browser replay steps bootstrap state before the final request', async () => {
  const fixture = await createReplayStepsFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-browser-replay-steps-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const run = await submitJob(apiBase, {
      name: 'browser-replay-steps',
      seedUrls: [`${fixture.baseUrl}/final`],
      mode: 'browser',
      concurrency: 1,
      maxDepth: 0,
      browser: {
        headless: true,
        waitUntil: 'load',
        replay: {
          steps: [
            { type: 'navigate', url: `${fixture.baseUrl}/bootstrap`, waitUntil: 'load' },
            { type: 'waitForSelector', selector: '#ready', timeoutMs: 5000 },
            { type: 'extractState', source: 'localStorage', key: 'boot-token', saveAs: 'bootToken' },
            { type: 'extractState', source: 'cookie', key: 'boot-cookie', saveAs: 'bootCookie' },
            { type: 'setHeader', name: 'x-replay-header', value: '{{bootToken}}' },
            { type: 'navigate', url: `${fixture.baseUrl}/final/`, waitUntil: 'load' },
          ],
        },
      },
      extract: [
        { name: 'header', type: 'regex', pattern: '<div id="header">([^<]+)</div>' },
        { name: 'cookie', type: 'regex', pattern: '<div id="cookie">([^<]+)</div>' },
        { name: 'storage', type: 'regex', pattern: '<div id="storage">([^<]+)</div>' },
      ],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    });

    assert.equal(run.records.length, 1);
    assert.equal(run.records[0].extracted.header, 'header=xyz');
    assert.equal(run.records[0].extracted.cookie, 'cookie=present');
    assert.equal(run.records[0].extracted.storage, 'storage=xyz');
    assert.equal(run.records[0].replayState.bootToken, 'xyz');
    assert.equal(run.records[0].replayState.bootCookie, '1');
    assert.equal(fixture.getFinalHits(), 1);
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('browser replay final request templates resolve into POST body without extra navigation', async () => {
  const fixture = await createReplayStepsFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-browser-replay-final-request-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const run = await submitJob(apiBase, {
      name: 'browser-replay-final-request',
      seedUrls: [`${fixture.baseUrl}/submit`],
      seedRequests: [{
        url: `${fixture.baseUrl}/submit`,
        method: 'POST',
      }],
      mode: 'browser',
      concurrency: 1,
      maxDepth: 0,
      browser: {
        headless: true,
        waitUntil: 'load',
        replay: {
          finalBody: 'token={{bootToken}}',
          steps: [
            { type: 'navigate', url: `${fixture.baseUrl}/bootstrap`, waitUntil: 'load' },
            { type: 'waitForSelector', selector: '#ready', timeoutMs: 5000 },
            { type: 'extractState', source: 'localStorage', key: 'boot-token', saveAs: 'bootToken' },
          ],
        },
      },
      extract: [
        { name: 'body', type: 'regex', pattern: '<div id="body">([^<]+)</div>' },
      ],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    });

    assert.equal(run.records.length, 1);
    assert.equal(run.records[0].extracted.body, 'token=xyz');
    assert.equal(fixture.getSubmitHits(), 1);
    assert.equal(fixture.getFinalHits(), 0);
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('browser replay unresolved templates fail fast before request execution', async () => {
  const fixture = await createReplayStepsFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-browser-replay-template-fail-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const response = await fetch(`${apiBase}/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow: {
          name: 'browser-replay-template-fail',
          seedUrls: [`${fixture.baseUrl}/final`],
          mode: 'browser',
          concurrency: 1,
          maxDepth: 0,
          browser: {
            headless: true,
            waitUntil: 'load',
            replay: {
              steps: [
                { type: 'setHeader', name: 'x-replay-header', value: '{{missingValue}}' },
              ],
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

    assert.equal(response.status, 202);
    const payload = await response.json();

    let completed = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const jobResponse = await fetch(`${apiBase}/jobs/${payload.jobId}`);
      const jobPayload = await jobResponse.json();
      if (jobPayload.job.status === 'completed') {
        completed = true;
        assert.equal(jobPayload.job.stats.failureCount, 1);
        break;
      }
      await sleep(50);
    }

    assert.equal(completed, true);
    const failedRequestsResponse = await fetch(`${apiBase}/jobs/${payload.jobId}/failed-requests`);
    const failedRequestsPayload = await failedRequestsResponse.json();
    assert.equal(failedRequestsPayload.total, 1);
    assert.match(String(failedRequestsPayload.items[0].error ?? ''), /unresolved replay template/i);
    assert.equal(fixture.getFinalHits(), 0);
    assert.equal(fixture.getSubmitHits(), 0);
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('browser replay supports interactive response capture steps and extractor replay templates', async () => {
  const fixture = await createReplayStepsFixture();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-browser-replay-interactive-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const run = await submitJob(apiBase, {
      name: 'browser-replay-interactive',
      seedUrls: [`${fixture.baseUrl}/interactive`],
      mode: 'browser',
      concurrency: 1,
      maxDepth: 0,
      headers: {
        'x-replay-header': '{{apiToken}}',
      },
      browser: {
        headless: true,
        waitUntil: 'load',
        replay: {
          finalUrl: `${fixture.baseUrl}/final`,
          steps: [
            { type: 'navigate', url: `${fixture.baseUrl}/interactive`, waitUntil: 'load' },
            { type: 'waitForSelector', selector: '#name', timeoutMs: 5000 },
            { type: 'type', selector: '#name', value: 'alpha', delayMs: 5 },
            { type: 'click', selector: '#trigger', timeoutMs: 5000 },
            {
              type: 'waitForResponse',
              urlPattern: '/api/token',
              method: 'POST',
              status: 200,
              saveAs: 'tokenResponse',
              timeoutMs: 5000,
            },
            {
              type: 'extractResponseBody',
              from: 'tokenResponse',
              format: 'json',
              path: 'token',
              saveAs: 'apiToken',
            },
          ],
        },
      },
      extract: [
        { name: 'header', type: 'regex', pattern: '<div id="header">header=([^<]+)</div>' },
        { name: 'templatedHeader', type: 'regex', pattern: '<div id="header">header=({{apiToken}})</div>' },
        { name: 'storage', type: 'regex', pattern: '<div id="storage">storage=([^<]+)</div>' },
      ],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    });

    assert.equal(run.records.length, 1);
    assert.equal(run.records[0].extracted.header, 'signed-alpha');
    assert.equal(run.records[0].extracted.templatedHeader, 'signed-alpha');
    assert.equal(run.records[0].extracted.storage, 'signed-alpha');
    assert.equal(run.records[0].replayState.apiToken, 'signed-alpha');
    assert.equal(fixture.getTokenHits(), 1);
    assert.equal(fixture.getFinalHits(), 1);
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
