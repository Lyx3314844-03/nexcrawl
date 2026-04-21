import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.js';

async function createLegacyFixtureSite() {
  const counts = {
    page: 0,
    bundle: 0,
    dynamicPage: 0,
    dynamicScript: 0,
  };
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      counts.page += 1;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <body>
            <script>window.inlineSecret = "inline-secret";</script>
            <script src="/bundle.js"></script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/bundle.js') {
      counts.bundle += 1;
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`
        const key = "1234567890123456";
        CryptoJS.AES.encrypt(payload, key);
        module.exports = { sign(v) { return v; } };
      `);
      return;
    }

    if (req.url === '/dynamic-page') {
      counts.dynamicPage += 1;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <body>
            <script>
              const script = document.createElement('script');
              script.src = '/dynamic.js';
              document.head.appendChild(script);
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/dynamic.js') {
      counts.dynamicScript += 1;
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`
        const rabbitKey = "abcdef1234567890";
        CryptoJS.AES.encrypt('payload', rabbitKey);
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
    counts,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

test('legacy reverse APIs are available through omnicrawl compatibility routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-legacy-reverse-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;
  const fixture = await createLegacyFixtureSite();

  try {
    const docsResponse = await fetch(`${apiBase}/api/docs`);
    assert.equal(docsResponse.status, 200);
    const docs = await docsResponse.json();
    assert.equal(docs.endpoints.crypto.analyze, 'POST /api/crypto/analyze');
    assert.equal(docs.endpoints.curl.convert, 'POST /api/convert-curl');

    const cryptoResponse = await fetch(`${apiBase}/api/crypto/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: `
          const key = "1234567890123456";
          CryptoJS.Rabbit.encrypt(data, key);
          crypto.pbkdf2Sync(secret, salt, 1000, 32, "sha256");
        `,
      }),
    });
    assert.equal(cryptoResponse.status, 200);
    const crypto = await cryptoResponse.json();
    assert.equal(crypto.success, true);
    assert.ok(crypto.data.cryptoTypes.some((item) => item.name === 'Rabbit'));
    assert.ok(crypto.data.cryptoTypes.some((item) => item.name === 'PBKDF2'));
    assert.ok(crypto.data.keys.some((item) => item.value === '1234567890123456'));

    const cryptoUrlResponse = await fetch(`${apiBase}/api/crypto/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/page`,
      }),
    });
    assert.equal(cryptoUrlResponse.status, 200);
    const cryptoByUrl = await cryptoUrlResponse.json();
    assert.equal(cryptoByUrl.success, true);
    assert.ok(cryptoByUrl.data.cryptoTypes.some((item) => item.name === 'AES'));
    assert.equal(cryptoByUrl.data.source.kind, 'remote');
    assert.equal(cryptoByUrl.data.source.inlineScriptCount, 1);
    assert.ok(cryptoByUrl.data.source.externalScripts.some((item) => item.url === `${fixture.baseUrl}/bundle.js`));

    const cryptoBrowserUrlResponse = await fetch(`${apiBase}/api/crypto/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/dynamic-page`,
        fetchMode: 'browser',
        browserConfig: {
          waitUntil: 'networkidle2',
          debug: {
            enabled: true,
            maxScripts: 20,
          },
        },
      }),
    });
    assert.equal(cryptoBrowserUrlResponse.status, 200);
    const cryptoByBrowserUrl = await cryptoBrowserUrlResponse.json();
    assert.equal(cryptoByBrowserUrl.success, true);
    assert.ok(cryptoByBrowserUrl.data.cryptoTypes.some((item) => item.name === 'AES'));
    assert.equal(cryptoByBrowserUrl.data.source.fetchMode, 'browser');
    assert.ok(cryptoByBrowserUrl.data.source.capturedScriptCount >= 1);

    const workflowResponse = await fetch(`${apiBase}/api/reverse/workflow`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/page`,
      }),
    });
    assert.equal(workflowResponse.status, 200);
    const workflow = await workflowResponse.json();
    assert.equal(workflow.success, true);
    assert.equal(workflow.data.kind, 'workflow-analysis');
    assert.ok(workflow.data.summary.likelySignatureFlow);
    assert.ok(Array.isArray(workflow.data.nextSteps));

    const astResponse = await fetch(`${apiBase}/api/ast/extract`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: `
          function sign(value, salt = "x") { return value + salt; }
          const token = "demo";
          sign(token);
        `,
        options: {
          functions: true,
          calls: true,
          variables: true,
          strings: true,
          crypto: true,
        },
      }),
    });
    assert.equal(astResponse.status, 200);
    const ast = await astResponse.json();
    assert.equal(ast.success, true);
    assert.ok(ast.data.functions.data.functions.some((item) => item.name === 'sign'));
    assert.ok(ast.data.calls.data.calls.some((item) => item.callee === 'sign'));
    assert.ok(ast.data.variables.data.variables.some((item) => item.name === 'token'));
    assert.ok(ast.data.strings.data.strings.some((item) => item.value === 'demo'));

    const paramsResponse = await fetch(`${apiBase}/api/ast/extract-params`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: `
          function sign(value, salt = "x") { return value + salt; }
          function other(flag) { return flag; }
        `,
        functionName: 'sign',
      }),
    });
    assert.equal(paramsResponse.status, 200);
    const params = await paramsResponse.json();
    assert.equal(params.success, true);
    assert.equal(params.data.count, 1);
    assert.deepEqual(params.data.functions[0].params, ['value', 'salt=x']);

    const hookResponse = await fetch(`${apiBase}/api/hook/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        hookProperties: [{ object: 'window', name: 'token' }],
        monitorCrypto: true,
      }),
    });
    assert.equal(hookResponse.status, 200);
    const hook = await hookResponse.json();
    assert.equal(hook.success, true);
    assert.match(hook.data.hookCode, /property\.get/);
    assert.match(hook.data.hookCode, /Rabbit/);

    const curlResponse = await fetch(`${apiBase}/api/convert-curl`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        curlCommand: "curl 'https://api.example.com/users' -H 'User-Agent: OmniCrawl'",
        language: 'python',
      }),
    });
    assert.equal(curlResponse.status, 200);
    const curl = await curlResponse.json();
    assert.equal(curl.success, true);
    assert.equal(curl.language, 'python');
    assert.match(curl.code, /requests/);

    const webpackResponse = await fetch(`${apiBase}/api/webpack/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'var modules={}; __webpack_require__(1); function(module,exports,__webpack_require__){}',
      }),
    });
    assert.equal(webpackResponse.status, 200);
    const webpack = await webpackResponse.json();
    assert.equal(webpack.success, true);
    assert.equal(webpack.isWebpack, true);
    assert.equal(typeof webpack.totalModules, 'number');

    const reverseBatchResponse = await fetch(`${apiBase}/api/reverse/batch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        concurrency: 2,
        items: [
          { operation: 'crypto.identify', url: `${fixture.baseUrl}/page` },
          { operation: 'workflow.analyze', url: `${fixture.baseUrl}/page` },
        ],
      }),
    });
    assert.equal(reverseBatchResponse.status, 200);
    const reverseBatch = await reverseBatchResponse.json();
    assert.equal(reverseBatch.success, true);
    assert.equal(reverseBatch.successCount, 2);
    assert.equal(reverseBatch.items[0].success, true);
    assert.equal(reverseBatch.items[1].success, true);
    assert.equal(fixture.counts.page, 3);
    assert.equal(fixture.counts.bundle, 3);
  } finally {
    await fixture.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy runtime routes map to reverse execution helpers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-legacy-runtime-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const executeResponse = await fetch(`${apiBase}/api/js/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'globalThis.answer = 6 * 7;',
        expression: 'answer',
      }),
    });
    assert.equal(executeResponse.status, 200);
    const execute = await executeResponse.json();
    assert.equal(execute.success, true);
    assert.equal(execute.result, 42);

    const functionResponse = await fetch(`${apiBase}/api/function/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'function token(value) { return value + "-sig"; }',
        functionName: 'token',
        args: ['demo'],
      }),
    });
    assert.equal(functionResponse.status, 200);
    const invoked = await functionResponse.json();
    assert.equal(invoked.success, true);
    assert.equal(invoked.result, 'demo-sig');

    const browserResponse = await fetch(`${apiBase}/api/browser/simulate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        html: '<html><body><div id="token">ready</div></body></html>',
        code: 'window.answer = document.querySelector("#token").textContent;',
        expression: 'window.answer',
      }),
    });
    assert.equal(browserResponse.status, 200);
    const browser = await browserResponse.json();
    assert.equal(browser.success, true);
    assert.equal(browser.result, 'ready');

    const astAnalyzeResponse = await fetch(`${apiBase}/api/ast/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'function sign(v){ debugger; return fetch("/api/x") && btoa(v); }',
      }),
    });
    assert.equal(astAnalyzeResponse.status, 200);
    const astAnalyze = await astAnalyzeResponse.json();
    assert.equal(astAnalyze.success, true);
    assert.ok(astAnalyze.results.functions.includes('sign'));
    assert.ok(astAnalyze.results.antiDebug.includes('debugger'));
    assert.ok(astAnalyze.results.calls.includes('fetch'));
    assert.equal(astAnalyze.results.ast.ok, true);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
