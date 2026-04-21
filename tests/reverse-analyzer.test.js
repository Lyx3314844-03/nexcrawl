import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHtmlForReverse, analyzeJavaScript, executeReverseSnippet, invokeNamedFunction } from '../src/reverse/reverse-analyzer.js';
import { analyzeAISurface } from '../src/reverse/ai-analysis.js';

test('reverse analyzer detects static JS signals and names', () => {
  const source = `
    function sign(data) { debugger; return btoa(data) + CryptoJS.MD5(data); }
    const endpoint = "/api/sign";
    exports.sign = sign;
    const client = require("axios");
    const payload = { token: "x", ts: 1 };
    fetch(endpoint);
    navigator.plugins;
  `;

  const result = analyzeJavaScript(source, {
    target: 'inline://sample.js',
  });

  assert.equal(result.kind, 'javascript');
  assert.ok(result.signals.crypto.length >= 1);
  assert.ok(result.signals.antiDebug.length >= 1);
  assert.ok(result.signals.transport.length >= 1);
  assert.ok(result.recommendedHooks.includes('navigator'));
  assert.ok(result.names.functions.includes('sign'));
  assert.ok(result.names.exports.includes('sign'));
  assert.ok(result.endpoints.includes('/api/sign'));
  assert.equal(result.ast.ok, true);
  assert.ok(result.ast.requires.some((item) => item.source === 'axios'));
  assert.ok(result.ast.exports.some((item) => item.name === 'sign'));
  assert.ok(result.ast.calls.includes('fetch'));
  assert.ok(result.ast.memberAccesses.includes('navigator.plugins'));
  assert.ok(result.ast.objectKeys.includes('token'));
});

test('reverse analyzer aggregates HTML inline scripts', () => {
  const html = `
    <html>
      <head><title>Reverse</title></head>
      <body>
        <script src="/static/app.js"></script>
        <script>function token(){ return atob("c2ln"); }</script>
      </body>
    </html>
  `;

  const result = analyzeHtmlForReverse(html, {
    baseUrl: 'https://example.com/page',
  });

  assert.equal(result.kind, 'html');
  assert.equal(result.scripts.external[0], 'https://example.com/static/app.js');
  assert.equal(result.scripts.inlineCount, 1);
  assert.ok(result.aggregated.recommendedHooks.includes('atob/btoa'));
  assert.equal(result.scripts.inlineAnalyses[0].ast.ok, true);
});

test('reverse execution can inspect exports and invoke named functions', () => {
  const code = `
    function sign(value) { return value + "-sig"; }
    exports.sign = sign;
  `;

  const executed = executeReverseSnippet({
    code,
    expression: 'exports.sign("x")',
  });
  assert.equal(executed.result, 'x-sig');

  const invoked = invokeNamedFunction({
    code,
    functionName: 'sign',
    args: ['demo'],
  });
  assert.equal(invoked.result, 'demo-sig');
});

test('reverse execution exposes globalThis assignments to follow-up expressions', () => {
  const executed = executeReverseSnippet({
    code: 'globalThis.answer = 6 * 7;',
    expression: 'answer',
  });

  assert.equal(executed.result, 42);
});

test('ai surface analyzer summarizes obfuscation, request params, response schema, and protection evidence', async () => {
  const code = `
    const seed = "ZGVtby10b2tlbg==";
    function _0xabc(value) { return atob(seed) + atob(value); }
    function sign(url, body, ts) { return btoa(url + body + ts); }
    const payload = { token: "x", page: 1, filters: { keyword: "demo" } };
    const headers = { "x-sign": sign("/api/search", JSON.stringify(payload), "1") };
    fetch("/api/search?lang=zh", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  `;

  const result = await analyzeAISurface({
    code,
    html: '<html><body><div class="g-recaptcha"></div>Verify you are human</body></html>',
    responseBody: JSON.stringify({
      ok: true,
      items: [{ id: 1, title: 'demo' }],
      page: 1,
    }),
    status: 403,
    headers: {
      'cf-ray': 'abc123',
    },
    ai: {
      enabled: true,
      provider: async ({ evidence }) => ({
        classification: evidence.protection.classification,
        endpoints: evidence.apiParameters.endpoints,
      }),
    },
  });

  assert.equal(result.kind, 'ai-surface-analysis');
  assert.ok(result.obfuscation.suspiciousIdentifiers.includes('_0xabc'));
  assert.ok(result.apiParameters.requestShapes.some((item) => item.endpoint === '/api/search?lang=zh'));
  assert.ok(
    result.apiParameters.requestShapes.some((item) =>
      item.parameterLocations.some((entry) => entry.location === 'body' && entry.fields.some((field) => field.name === 'token')),
    ),
  );
  assert.equal(result.responseSchema.rootType, 'object');
  assert.equal(result.responseSchema.schema.properties.items.type, 'array');
  assert.equal(result.protection.waf.type, 'cloudflare');
  assert.equal(result.protection.captcha.vendor, 'recaptcha');
  assert.equal(result.ai.executed, true);
  assert.equal(result.ai.summary.classification, 'waf');
  assert.match(result.ai.prompt.system, /defensive analysis assistant/i);
});

test('ai surface analyzer can derive code evidence from inline scripts when code is omitted', async () => {
  const result = await analyzeAISurface({
    html: `
      <html>
        <body>
          <script>
            const params = { keyword: "demo", page: 2 };
            fetch("/api/inline/search", {
              method: "POST",
              body: JSON.stringify(params),
            });
          </script>
        </body>
      </html>
    `,
    responseBody: JSON.stringify({ ok: true }),
  });

  assert.equal(result.kind, 'ai-surface-analysis');
  assert.ok(result.apiParameters.endpoints.includes('/api/inline/search'));
  assert.ok(
    result.apiParameters.requestShapes.some((item) =>
      item.parameterLocations.some((entry) => entry.location === 'body' && entry.fields.some((field) => field.name === 'keyword')),
    ),
  );
});
