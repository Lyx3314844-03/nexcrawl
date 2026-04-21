import test from 'node:test';
import assert from 'node:assert/strict';
import { runExtractors } from '../src/extractors/extractor-engine.js';

function createResponse(body, contentType = 'application/javascript') {
  return {
    body,
    headers: {
      'content-type': contentType,
    },
    finalUrl: 'https://example.com/app.js',
    domMeta: {
      title: 'reverse-test',
    },
  };
}

test('reverse extractor supports advanced crypto, ast, and webpack operations', async () => {
  const workflow = {
    browser: {},
    extract: [
      { name: 'crypto', type: 'reverse', operation: 'crypto.analyze' },
      { name: 'ast', type: 'reverse', operation: 'ast.controlFlow' },
      { name: 'webpack', type: 'reverse', operation: 'webpack.analyze' },
    ],
  };

  const response = createResponse(`
    function sign(value) {
      if (value) {
        return CryptoJS.AES.encrypt(value, "1234567890123456").toString();
      }
      return "";
    }
    __webpack_require__(1);
  `);

  const extracted = await runExtractors({
    workflow,
    response,
  });

  assert.equal(extracted.crypto.kind, 'crypto-analysis');
  assert.ok(extracted.crypto.cryptoTypes.some((item) => item.name === 'AES'));
  assert.equal(extracted.ast.kind, 'ast-control-flow');
  assert.ok(extracted.ast.controlFlow.functions.some((item) => item.name === 'sign'));
  assert.equal(extracted.webpack.kind, 'webpack-analysis');
  assert.equal(extracted.webpack.isWebpack, true);
});

test('reverse extractor supports curl conversion and hook generation operations', async () => {
  const workflow = {
    browser: {},
    extract: [
      { name: 'curl', type: 'reverse', operation: 'curl.convert', language: 'python' },
      {
        name: 'hooks',
        type: 'reverse',
        operation: 'hooks.generate',
        options: {
          monitorNetwork: true,
        },
      },
    ],
  };

  const response = createResponse(
    "curl 'https://api.example.com/items' -H 'User-Agent: OmniCrawl'",
    'text/plain',
  );

  const extracted = await runExtractors({
    workflow,
    response,
  });

  assert.equal(extracted.curl.kind, 'curl-convert');
  assert.match(extracted.curl.code, /requests/);
  assert.equal(extracted.hooks.kind, 'hooks-generate');
  assert.match(extracted.hooks.code, /window\.__hookedCalls__/);
});

test('reverse extractor supports node profiling and deobfuscation operations', async () => {
  const workflow = {
    browser: {},
    extract: [
      { name: 'node', type: 'reverse', operation: 'node.profile' },
      { name: 'deobfuscate', type: 'reverse', operation: 'ast.deobfuscate' },
    ],
  };

  const response = createResponse(`
    const fs = require('fs');
    const data = ['YXBp', 'LXRva2Vu'];
    const token = Buffer.from('c2VjcmV0LWFwaQ==', 'base64').toString('utf8');
    const target = data[0] + data[1];
    fs.readFileSync(process.env.CONFIG_PATH, 'utf8');
  `);

  const extracted = await runExtractors({
    workflow,
    response,
  });

  assert.equal(extracted.node.kind, 'node-profile');
  assert.ok(extracted.node.modules.builtin.includes('fs'));
  assert.ok(extracted.node.runtime.filesystem.some((item) => item.api.includes('fs.readFileSync')));
  assert.ok(extracted.node.runtime.process.envKeys.some((item) => item.key === 'CONFIG_PATH'));

  assert.equal(extracted.deobfuscate.kind, 'ast-deobfuscate');
  assert.ok(extracted.deobfuscate.decodedStrings.includes('secret-api'));
  assert.ok(extracted.deobfuscate.constantBindings.some((item) => item.name === 'target'));
});
