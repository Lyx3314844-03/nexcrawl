import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.js';

async function createBrowserDebugFixtureSite() {
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');

    if (requestUrl.pathname === '/page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html data-atob-native="pending" data-storage-native="pending">
          <head>
            <title>Browser Debug Fixture</title>
            <script>
              document.documentElement.setAttribute('data-atob-native', String(/\\[native code\\]/.test(Function.prototype.toString.call(atob))));
              document.documentElement.setAttribute('data-storage-native', String(/\\[native code\\]/.test(Function.prototype.toString.call(Storage.prototype.getItem))));
              localStorage.setItem('boot', 'yes');
              window.inlineEncoded = btoa('hello-inline');
              window.debugWorker = new Worker('/assets/worker.js');
              window.sharedDebugWorker = new SharedWorker('/assets/shared-worker.js');
              window.sharedDebugWorker.port.start();
            </script>
            <script src="/assets/app.js"></script>
          </head>
          <body>
            <main>fixture-ready</main>
          </body>
        </html>
      `);
      return;
    }

    if (requestUrl.pathname === '/assets/app.js') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.end(`
        (async () => {
          const token = atob('YWxwaGE=');
          localStorage.setItem('token', token);
          sessionStorage.setItem('mode', 'debug');

          await fetch('/api/fetch', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-debug': 'fetch'
            },
            body: JSON.stringify({ token })
          });

          const xhr = new XMLHttpRequest();
          xhr.open('GET', '/api/xhr?token=' + token, true);
          xhr.setRequestHeader('x-debug', 'xhr');
          xhr.send();

          if (globalThis.crypto?.subtle) {
            const bytes = new TextEncoder().encode(token);
            await crypto.subtle.digest('SHA-256', bytes);
          }

          const wasmBytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
          await WebAssembly.compile(wasmBytes);
          await WebAssembly.instantiate(wasmBytes);

          const frame = document.createElement('iframe');
          frame.src = '/frame';
          document.body.appendChild(frame);
          await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
          frame.contentWindow.postMessage({ via: 'iframe', token }, '*');

          window.debugWorker.postMessage({ via: 'worker', token });
          window.sharedDebugWorker.port.postMessage({ via: 'shared-worker', token });
        })();
        //# sourceMappingURL=app.js.map
      `);
      return;
    }

    if (requestUrl.pathname === '/assets/app.js.map') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          version: 3,
          file: 'app.js',
          sourceRoot: '',
          sources: ['app.ts'],
          sourcesContent: [
            "export async function run(){ const token = atob('YWxwaGE='); await fetch('/api/fetch'); }",
          ],
          names: ['run', 'token', 'fetch'],
          mappings: 'AAAA,SAASA,IAAIC',
        }),
      );
      return;
    }

    if (requestUrl.pathname === '/assets/worker.js') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.end(`
        self.workerToken = 'worker:' + Date.now();
        self.postMessage({ ok: true, via: 'worker' });
        //# sourceMappingURL=worker.js.map
      `);
      return;
    }

    if (requestUrl.pathname === '/assets/worker.js.map') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          version: 3,
          file: 'worker.js',
          sourceRoot: '',
          sources: ['worker.ts'],
          sourcesContent: ["self.postMessage({ ok: true, via: 'worker' });"],
          names: ['postMessage'],
          mappings: 'AAAA,IAAI',
        }),
      );
      return;
    }

    if (requestUrl.pathname === '/assets/shared-worker.js') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.end(`
        onconnect = (event) => {
          const port = event.ports[0];
          port.postMessage({ ok: true, via: 'shared-worker' });
        };
        //# sourceMappingURL=shared-worker.js.map
      `);
      return;
    }

    if (requestUrl.pathname === '/assets/shared-worker.js.map') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          version: 3,
          file: 'shared-worker.js',
          sourceRoot: '',
          sources: ['shared-worker.ts'],
          sourcesContent: ["onconnect = event => event.ports[0].postMessage({ ok: true, via: 'shared-worker' });"],
          names: ['onconnect', 'postMessage'],
          mappings: 'AAAA,IAAI',
        }),
      );
      return;
    }

    if (requestUrl.pathname === '/api/fetch') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          ok: true,
          via: 'fetch',
          body,
        }),
      );
      return;
    }

    if (requestUrl.pathname === '/api/xhr') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          ok: true,
          via: 'xhr',
          token: requestUrl.searchParams.get('token'),
        }),
      );
      return;
    }

    if (requestUrl.pathname === '/frame') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Frame</title></head>
          <body>
            <script>
              window.addEventListener('message', (event) => {
                window.parent.postMessage({ via: 'frame-reply', payload: event.data }, '*');
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
  const job = await waitForCompletion(apiBase, payload.jobId);

  const resultsResponse = await fetch(`${apiBase}/jobs/${payload.jobId}/results`);
  const results = await resultsResponse.json();
  return {
    jobId: payload.jobId,
    job,
    records: results.items,
  };
}

test('browser crawl automatically captures debug artifacts', async () => {
  const fixture = await createBrowserDebugFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-browser-debug-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const run = await submitJob(apiBase, {
      name: 'browser-debug-test',
      seedUrls: [`${fixture.baseUrl}/page`],
      mode: 'browser',
      concurrency: 1,
      maxDepth: 0,
      browser: {
        headless: true,
        waitUntil: 'networkidle2',
        sleepMs: 150,
        debug: {
          enabled: true,
          hookMode: 'strict',
          maxScripts: 20,
          maxRequests: 20,
          maxSourceMaps: 10,
          maxHookEvents: 50,
          maxScriptBytes: 120000,
          maxSourceMapBytes: 60000,
          maxRequestBodyBytes: 4096,
          maxResponseBodyBytes: 4096,
          previewItems: 20,
          previewBytes: 512,
          har: {
            enabled: true,
            includeBodies: true,
          },
          tracing: {
            enabled: true,
            screenshots: true,
          },
        },
      },
      extract: [
        { name: 'atobNative', type: 'regex', pattern: 'data-atob-native="([^"]+)"' },
        { name: 'storageNative', type: 'regex', pattern: 'data-storage-native="([^"]+)"' },
      ],
      plugins: [{ name: 'dedupe' }, { name: 'audit' }],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    });

    assert.equal(run.records.length, 1);
    const record = run.records[0];
    assert.equal(record.debug.enabled, true);
    assert.ok(record.debug.summary.requestCount >= 2);
    assert.ok(record.debug.summary.scriptCount >= 2);
    assert.ok(record.debug.summary.sourceMapCount >= 1);
    assert.ok(record.debug.summary.hookEventCount >= 4);
    assert.equal(record.extracted.atobNative, 'true');
    assert.equal(record.extracted.storageNative, 'true');
    assert.ok(record.debug.artifact?.path);
    assert.ok(record.debug.attachments?.har?.path);
    assert.equal(record.debug.attachments?.har?.format, 'synthetic-har-1.2');
    assert.ok(record.debug.attachments?.har?.entryCount >= 2);
    assert.ok(record.debug.attachments?.trace?.path);
    assert.match(String(record.debug.attachments?.trace?.format ?? ''), /(chromium-trace|playwright-trace)/);

    const fetchRequest = record.debug.requests.find(
      (item) => item.transport === 'fetch' && item.url.includes('/api/fetch'),
    );
    assert.ok(fetchRequest);
    assert.equal(fetchRequest.method, 'POST');
    assert.equal(fetchRequest.status, 200);
    assert.match(fetchRequest.requestBody?.text ?? '', /alpha/);
    assert.match(fetchRequest.responseBody?.text ?? '', /"via":"fetch"/);

    const xhrRequest = record.debug.requests.find((item) => item.transport === 'xhr' && item.url.includes('/api/xhr'));
    assert.ok(xhrRequest);
    assert.equal(xhrRequest.method, 'GET');
    assert.equal(xhrRequest.status, 200);

    const script = record.debug.scripts.find((item) => item.url?.endsWith('/assets/app.js'));
    assert.ok(script);
    assert.match(script.sourcePreview, /fetch\('/);
    assert.match(script.sourcePreview, /XMLHttpRequest/);

    const inlineScript = record.debug.scripts.find(
      (item) => item.kind === 'inline' && /hello-inline/.test(item.sourcePreview),
    );
    assert.ok(inlineScript);

    const sourceMap = record.debug.sourceMaps.find((item) => item.url?.endsWith('/assets/app.js.map'));
    assert.ok(sourceMap);
    assert.equal(sourceMap.summary.file, 'app.js');
    assert.deepEqual(sourceMap.summary.sources, ['app.ts']);
    assert.ok(sourceMap.retrieval.method);
    assert.match(sourceMap.contentPreview ?? '', /app\.ts/);

    const workerScriptPreview = record.debug.scripts.find((item) => item.targetType === 'worker');
    assert.ok(workerScriptPreview);

    const workerSourceMapPreview = record.debug.sourceMaps.find((item) => item.url?.endsWith('/assets/worker.js.map'));
    assert.ok(workerSourceMapPreview);
    assert.deepEqual(workerSourceMapPreview.summary.sources, ['worker.ts']);

    const sharedWorkerScriptPreview = record.debug.scripts.find((item) => item.targetType === 'shared_worker');
    const sharedWorkerSourceMapPreview = record.debug.sourceMaps.find((item) => item.url?.endsWith('/assets/shared-worker.js.map'));
    if (sharedWorkerSourceMapPreview) {
      assert.deepEqual(sharedWorkerSourceMapPreview.summary.sources, ['shared-worker.ts']);
    }

    assert.ok(record.debug.hooks.events.some((item) => item.type === 'localStorage.setItem' && item.key === 'token'));
    assert.ok(record.debug.hooks.events.some((item) => item.type === 'fetch.result' && item.url.includes('/api/fetch')));
    assert.ok(record.debug.hooks.events.some((item) => item.type === 'xhr.result' && item.url.includes('/api/xhr')));
    assert.equal(record.debug.hooks.sources.runtime, 'domstorage-native');
    assert.equal(record.debug.summary.runtimeHookMode, 'native-cdp-domstorage');
    assert.equal(typeof record.debug.captureSupport.backend, 'string');
    assert.match(record.debug.captureSupport.backendFamily, /^(puppeteer|playwright)$/);
    assert.equal(record.debug.captureSupport.workerTargets.mode, 'full');
    assert.equal(record.debug.captureSupport.workerTargets.lifecycle, 'evented');
    assert.equal(record.debug.captureSupport.auxiliaryTargets.mode, 'full');
    assert.deepEqual(record.debug.captureSupport.limitations, []);

    const debugResponse = await fetch(`${apiBase}/jobs/${run.jobId}/debug/${record.sequence}`);
    assert.equal(debugResponse.status, 200);
    const debugPayload = await debugResponse.json();
    assert.equal(debugPayload.artifact.path, record.debug.artifact.path);
    assert.equal(debugPayload.debug.attachments.har.path, record.debug.attachments.har.path);
    assert.equal(debugPayload.debug.attachments.trace.path, record.debug.attachments.trace.path);
    const fullDebug = debugPayload.debug;

    const fullScript = fullDebug.scripts.find((item) => item.url?.endsWith('/assets/app.js'));
    assert.ok(fullScript);
    assert.match(fullScript.source, /fetch\('/);
    assert.match(fullScript.source, /XMLHttpRequest/);

    const fullSourceMap = fullDebug.sourceMaps.find((item) => item.url?.endsWith('/assets/app.js.map'));
    assert.ok(fullSourceMap);
    assert.match(fullSourceMap.content ?? '', /app\.ts/);

    const fullWorkerSourceMap = fullDebug.sourceMaps.find((item) => item.url?.endsWith('/assets/worker.js.map'));
    assert.ok(fullWorkerSourceMap);
    assert.match(fullWorkerSourceMap.content ?? '', /worker\.ts/);

    const fullSharedWorkerSourceMap = fullDebug.sourceMaps.find((item) => item.url?.endsWith('/assets/shared-worker.js.map'));
    if (fullSharedWorkerSourceMap) {
      assert.match(fullSharedWorkerSourceMap.content ?? '', /shared-worker\.ts/);
    }
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('browser debug balanced mode captures webcrypto wasm and iframe traces', async () => {
  const fixture = await createBrowserDebugFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-browser-debug-balanced-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const run = await submitJob(apiBase, {
      name: 'browser-debug-balanced',
      seedUrls: [`${fixture.baseUrl}/page`],
      mode: 'browser',
      concurrency: 1,
      maxDepth: 0,
      browser: {
        headless: true,
        waitUntil: 'networkidle2',
        sleepMs: 150,
        debug: {
          enabled: true,
          hookMode: 'balanced',
          maxScripts: 20,
          maxRequests: 20,
          maxSourceMaps: 10,
          maxHookEvents: 120,
          previewItems: 40,
        },
      },
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    });

    const record = run.records[0];
    assert.ok(record.debug.hooks.events.some((item) => item.type === 'crypto.subtle.digest'));
    assert.ok(record.debug.hooks.events.some((item) => item.type === 'webassembly.compile'));
    assert.ok(record.debug.hooks.events.some((item) => item.type === 'webassembly.instantiate'));
    assert.ok(record.debug.hooks.events.some((item) => item.type === 'iframe.create'));
    assert.ok(record.debug.hooks.events.some((item) => item.type === 'window.postMessage'));
    assert.ok(record.debug.hooks.events.some((item) => item.type === 'messagePort.postMessage'));
    assert.equal(record.debug.hooks.sources.runtime, 'stealth-patch');

    const diagnosticsResponse = await fetch(`${apiBase}/jobs/${run.jobId}/diagnostics`);
    assert.equal(diagnosticsResponse.status, 200);
    const diagnosticsPayload = await diagnosticsResponse.json();
    assert.ok(diagnosticsPayload.item.surface.runtimeSignals.webCryptoSignalCount >= 1);
    assert.ok(diagnosticsPayload.item.surface.runtimeSignals.wasmSignalCount >= 1);
    assert.ok(diagnosticsPayload.item.surface.runtimeSignals.iframeSignalCount >= 1);
    assert.ok(diagnosticsPayload.item.surface.topHookTypes.some((entry) => entry.type === 'crypto.subtle.digest'));
    assert.ok(diagnosticsPayload.item.suspects.some((entry) => entry.type === 'runtime-signature-hardening'));
    assert.ok(diagnosticsPayload.item.timeline.some((entry) => entry.type === 'crypto.subtle.digest'));
    assert.ok(diagnosticsPayload.item.chains.some((entry) => entry.timeline.some((item) => item.type === 'webassembly.compile')));
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
