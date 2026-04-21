import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEncryption, extractKeysMasked } from '../src/reverse/advanced-crypto-analyzer.js';
import { runReverseOperation } from '../src/reverse/reverse-capabilities.js';

test('advanced crypto analyzer recognizes extended reverse-analysis patterns', () => {
  const source = `
    const key = "1234567890123456";
    CryptoJS.Rabbit.encrypt(payload, key);
    const derived = crypto.pbkdf2Sync(secret, salt, 1000, 32, "sha256");
    const digest = await argon2.hash(password);
    const curve = new elliptic.ec("secp256k1");
    const mac = cmac(payload, key);
  `;

  const result = analyzeEncryption(source);
  const names = result.cryptoTypes.map((item) => item.name);

  assert.ok(names.includes('Rabbit'));
  assert.ok(names.includes('PBKDF2'));
  assert.ok(names.includes('Argon2'));
  assert.ok(names.includes('ECC'));
  assert.ok(names.includes('CMAC'));

  const maskedKeys = extractKeysMasked(source);
  assert.equal(maskedKeys.length, 1);
  assert.equal(maskedKeys[0].maskedValue, '1234***3456');
});

test('hook generation supports property hooks and richer anti-detection output', async () => {
  const hooks = await runReverseOperation({
    operation: 'hooks.generate',
    options: {
      hookProperties: [{ object: 'window', name: 'token' }],
      monitorNetwork: true,
      monitorCrypto: true,
    },
  });

  assert.equal(hooks.kind, 'hooks-generate');
  assert.match(hooks.code, /property\.get/);
  assert.match(hooks.code, /Rabbit/);
  assert.match(hooks.code, /crypto\.subtle/);
  assert.match(hooks.code, /WebSocket\.send/);
  assert.match(hooks.code, /WebAssembly\.instantiate/);

  const antiDetection = await runReverseOperation({
    operation: 'hooks.antiDetection',
  });

  assert.equal(antiDetection.kind, 'hooks-anti-detection');
  assert.match(antiDetection.code, /permissions\.query/);
  assert.match(antiDetection.code, /Object\.defineProperty\(navigator, 'plugins'/);
  assert.match(antiDetection.code, /loadTimes/);
  assert.match(antiDetection.code, /userAgentData/);
  assert.match(antiDetection.code, /hardwareConcurrency/);
});

test('signature setup extracts closure dependencies and runtime environment hints', async () => {
  const setup = await runReverseOperation({
    operation: 'signature.setup-rpc',
    code: `
      const secret = 'salt';
      function helper(value) {
        return value + ':' + secret;
      }
      window.sign = function sign(payload) {
        return helper(payload) + ':' + navigator.userAgent;
      };
    `,
  });

  assert.equal(setup.kind, 'signature-setup-rpc');
  assert.equal(setup.success, true);
  assert.ok(setup.extracted.closureBindings.includes('helper'));
  assert.ok(setup.extracted.environment.browser);
  assert.ok(setup.rpc.wrapperCode.includes('function helper'));
  assert.ok(setup.rpc.wrapperCode.includes('window.sign(...args)'));
  assert.ok(setup.rpc.wrapperCode.includes('OmniCrawlSignatureRPC/1.0'));
});
