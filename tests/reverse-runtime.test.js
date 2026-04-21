import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildReverseEngineConfigFromWorkflow,
  createWorkflowReverseRuntime,
} from '../src/runtime/reverse-workflow-runtime.js';
import { evaluateSignerArtifact } from '../src/runtime/reverse-signer-runtime.js';
import { runReverseRegressionSuite } from '../src/runtime/reverse-regression.js';
import { analyzeRunDiagnostics, buildResultIdentitySnapshot, inspectResultDiagnostics } from '../src/runtime/reverse-diagnostics.js';
import {
  analyzeProtobufPayload,
  analyzeGrpcPayload,
} from '../src/reverse/protocol-analyzer.js';
import { buildNativeCapturePlan } from '../src/reverse/native-integration.js';

function encodeVarint(value) {
  let current = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current > 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (current > 0n);
  return Buffer.from(bytes);
}

function encodeProtobufField(fieldNumber, wireType, valueBuffer) {
  return Buffer.concat([
    encodeVarint((fieldNumber << 3) | wireType),
    valueBuffer,
  ]);
}

function encodeProtobufString(fieldNumber, value) {
  const body = Buffer.from(String(value), 'utf8');
  return encodeProtobufField(fieldNumber, 2, Buffer.concat([encodeVarint(body.length), body]));
}

function encodeProtobufInt(fieldNumber, value) {
  return encodeProtobufField(fieldNumber, 0, encodeVarint(value));
}

test('buildReverseEngineConfigFromWorkflow maps reverse app settings into executable appWebView config', () => {
  const config = buildReverseEngineConfigFromWorkflow({
    identity: {
      bundleId: 'com.tencent.mm',
      userAgent: 'UnitTestUA/1.0',
    },
    reverse: {
      app: {
        enabled: true,
        platform: 'ios',
        mitmproxy: { enabled: true, mode: 'upstream' },
        protobuf: { enabled: true, descriptorPaths: ['/tmp/example.proto'] },
        grpc: { enabled: true, services: { EchoService: true } },
        websocket: { captureBinary: false },
        sslPinning: { enabled: true, mode: 'external' },
      },
    },
  });

  assert.equal(config.appWebView.type, 'wechat');
  assert.equal(config.appWebView.userAgent, 'UnitTestUA/1.0');
  assert.equal(config.appWebView.extraGlobals.__OMNICRAWL_APP_PLATFORM, 'ios');
  assert.equal(config.appWebView.extraGlobals.__OMNICRAWL_APP_NATIVE_CAPABILITIES.mitmproxy.enabled, true);
  assert.equal(config.appWebView.extraGlobals.__OMNICRAWL_APP_NATIVE_CAPABILITIES.websocket.captureBinary, false);
  assert.equal(config.appWebView.extraGlobals.__OMNICRAWL_APP_NATIVE_CAPABILITIES.sslPinning.mode, 'external');
});

test('createWorkflowReverseRuntime records app capture advisory surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-reverse-runtime-'));
  try {
    const runtime = await createWorkflowReverseRuntime({
      workflow: {
        name: 'native-surface',
        seedUrls: ['https://example.com'],
        reverse: {
          app: {
            enabled: true,
            platform: 'android',
            frida: { enabled: true, deviceId: 'usb-1' },
            protobuf: { enabled: true, descriptorPaths: ['a.proto'] },
          },
        },
      },
      projectRoot: root,
      jobId: 'job-1',
    });

    const capture = await runtime.assetStore.readLatestAsset('app-captures', 'native-surface-app-surface');
    assert.ok(capture);
    assert.equal(capture.payload.webViewProfile, 'android-webview');
    assert.equal(capture.payload.nativeCapabilities.frida.enabled, true);
    assert.deepEqual(capture.payload.nativeCapabilities.protobuf.descriptorPaths, ['a.proto']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reverse asset store records ai surface summaries and indexes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-ai-surface-store-'));
  try {
    const runtime = await createWorkflowReverseRuntime({
      workflow: {
        name: 'ai-surface-store',
        seedUrls: ['https://example.com'],
        reverse: {
          enabled: true,
          autoReverseAnalysis: true,
        },
      },
      projectRoot: root,
      jobId: 'job-ai-surface-store',
    });

    const record = await runtime.assetStore.recordAISurface('ai-surface-store-ai-surface-https://example.com/page', {
      kind: 'ai-surface-analysis',
      target: 'https://example.com/page',
      protection: {
        classification: 'captcha',
      },
    });
    const stored = await runtime.assetStore.readLatestAsset('ai-surfaces', 'ai-surface-store-ai-surface-https://example.com/page');

    assert.ok(stored);
    assert.equal(record.assetId, 'ai-surface-store-ai-surface-https://example.com/page');
    assert.equal(stored.payload.target, 'https://example.com/page');
    assert.equal(stored.payload.protection.classification, 'captcha');
    assert.ok(runtime.assetStore.snapshot().aiSurfaces.some((entry) => entry.assetId === record.assetId && entry.classification === 'captcha'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildNativeCapturePlan generates actionable Frida and mitmproxy commands', () => {
  const plan = buildNativeCapturePlan({
    bundleId: 'com.example.app',
    frida: {
      enabled: true,
      deviceId: 'usb-1',
      scriptPath: 'hooks/pinning.js',
    },
    mitmproxy: {
      enabled: true,
      dumpPath: 'captures/native.dump',
      mode: 'upstream:http://127.0.0.1:8080',
      addonPath: 'captures/mitm-addon.py',
    },
    protobuf: {
      enabled: true,
      descriptorPaths: ['echo.proto'],
    },
  }, {
    toolStatus: {
      frida: { available: true, version: '16.0.0' },
      'frida-ps': { available: true, version: '16.0.0' },
      mitmdump: { available: true, version: '10.0.0' },
      mitmproxy: { available: true, version: '10.0.0' },
    },
  });

  assert.equal(plan.kind, 'app-native-plan');
  assert.equal(plan.ready, true);
  assert.ok(plan.steps.some((step) => step.tool === 'frida' && step.command.includes('hooks/pinning.js')));
  assert.ok(plan.steps.some((step) => step.tool === 'mitmdump' && step.command.includes('captures/native.dump')));
  assert.ok(plan.steps.some((step) => step.tool === 'mitmdump' && step.command.includes('captures/mitm-addon.py')));
  assert.deepEqual(plan.protocolHints.protobuf.descriptorPaths, ['echo.proto']);
});

test('evaluateSignerArtifact executes against a DOM-backed signer environment', async () => {
  const result = await evaluateSignerArtifact({
    extracted: {
      runtimeCode: `
        function sign() {
          const token = document.querySelector('#token').textContent;
          return token + '-' + localStorage.getItem('seed') + '-' + navigator.userAgent.includes('Unit');
        }
      `,
      importBindings: [],
      environment: { browser: true, needs: ['document', 'localStorage'] },
    },
    params: [],
    invocationTarget: 'sign',
    functionName: 'sign',
  }, {}, {
    html: '<html><body><div id="token">ok</div></body></html>',
    localStorage: { seed: 'value' },
    userAgent: 'UnitTestSigner/1.0',
  });

  assert.equal(result, 'ok-value-true');
});

test('createWorkflowReverseRuntime wires autoReverseAnalysis into the runtime plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-auto-reverse-'));
  try {
    const runtime = await createWorkflowReverseRuntime({
      workflow: {
        name: 'auto-reverse',
        seedUrls: ['https://example.com'],
        reverse: {
          enabled: true,
          autoReverseAnalysis: true,
        },
      },
      projectRoot: root,
      jobId: 'job-auto-reverse',
    });

    runtime.reverseEngine.summarizeWorkflow = async () => ({ kind: 'workflow-summary', score: 1 });
    runtime.reverseEngine.analyzeAISurface = async () => ({ kind: 'ai-surface-analysis', protection: { classification: 'normal' } });
    const payload = {
      request: {
        url: 'https://example.com',
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
        },
        finalUrl: 'https://example.com/final',
      },
      result: {
        html: '<html><script>window.sign = () => "ok";</script></html>',
      },
    };
    await runtime.runtimePlugins[0].afterExtract(payload);
    assert.deepEqual(payload.result._reverseSummary, { kind: 'workflow-summary', score: 1 });
    assert.deepEqual(payload.result._aiSurfaceSummary, { kind: 'ai-surface-analysis', protection: { classification: 'normal' } });
    assert.ok(payload.result._aiSurfaceAsset);
    const aiRecord = await runtime.assetStore.readLatestAsset(
      'ai-surfaces',
      `auto-reverse-ai-surface-https://example.com/final`,
    );
    assert.ok(aiRecord);
    assert.equal(aiRecord.payload.protection.classification, 'normal');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runReverseRegressionSuite validates request contracts against captured debug requests', async () => {
  const regression = await runReverseRegressionSuite({
    workflow: {
      reverse: {
        regression: {
          requestContracts: [{
            name: 'signed-fetch',
            urlPattern: '/api/sign',
            method: 'POST',
            transport: 'fetch',
            status: 200,
            requestHeaderNames: ['x-signature'],
            responseHeaderNames: ['content-type'],
            responseBodyPattern: '"ok":true',
          }],
        },
      },
    },
    summary: {
      failureCount: 0,
      quality: {
        waf: {
          challengedCount: 0,
        },
      },
    },
    results: [{
      url: 'https://example.com/page',
      finalUrl: 'https://example.com/page',
      debug: {
        requests: [{
          requestId: 'req-1',
          url: 'https://example.com/api/sign',
          method: 'POST',
          transport: 'fetch',
          status: 200,
          requestHeaders: {
            'x-signature': 'abc',
          },
          responseHeaders: {
            'content-type': 'application/json',
          },
          responseBody: {
            text: '{"ok":true}',
          },
        }],
      },
    }],
    assetStore: null,
  });

  assert.equal(regression.passed, true);
  const suite = regression.suites.find((entry) => entry.name === 'requestContracts');
  assert.ok(suite);
  assert.equal(suite.cases[0].passed, true);
  assert.equal(suite.cases[0].matchCount, 1);
});

test('identity consistency drift is surfaced in result and run diagnostics', () => {
  const request = {
    headers: {
      'user-agent': 'ExpectedUA/1.0',
      'accept-language': 'zh-CN,zh',
    },
    tlsProfile: 'chrome-latest',
    h2Profile: 'chrome-latest',
    identity: {
      enabled: true,
      userAgent: 'ExpectedUA/1.0',
      acceptLanguage: 'zh-CN,zh',
      tlsProfile: 'chrome-latest',
      h2Profile: 'chrome-latest',
    },
    _identityConsistency: {
      enabled: true,
      driftCount: 2,
      correctionCount: 2,
      driftFields: ['user-agent', 'tlsProfile'],
      correctionFields: ['user-agent', 'tlsProfile'],
      drifts: [
        { field: 'user-agent', expected: 'ExpectedUA/1.0', actual: 'BadUA/9.9' },
        { field: 'tlsProfile', expected: 'chrome-latest', actual: 'safari-latest' },
      ],
      corrections: [
        { field: 'user-agent', expected: 'ExpectedUA/1.0', actual: 'BadUA/9.9' },
        { field: 'tlsProfile', expected: 'chrome-latest', actual: 'safari-latest' },
      ],
      unsupported: [],
    },
  };
  const response = {
    status: 200,
    body: '{"ok":true}',
    headers: {},
  };

  const identity = buildResultIdentitySnapshot({ request, response });
  const resultDiagnostics = inspectResultDiagnostics({
    request,
    response,
    extracted: { ok: true },
    quality: {},
  });
  const runDiagnostics = analyzeRunDiagnostics({
    summary: {
      failureCount: 0,
      quality: {
        waf: { challengedCount: 0, detectedCount: 0 },
        schema: { invalidRecordCount: 0 },
        structure: { shapeVariantCount: 1 },
      },
      changeTracking: { changedResultCount: 0 },
      baseline: { alerts: [] },
      resultCount: 1,
    },
    results: [{
      url: 'https://example.com/page',
      finalUrl: 'https://example.com/page',
      status: 200,
      attemptsUsed: 1,
      fetchedAt: new Date().toISOString(),
      responseBody: '{"ok":true}',
      debug: {
        requests: [],
        scripts: [],
        hooks: { events: [] },
      },
      identity,
      diagnostics: resultDiagnostics,
      quality: {},
    }],
  });

  assert.equal(identity.consistency.driftCount, 2);
  assert.equal(identity.applied, null);
  assert.equal(resultDiagnostics.identityDriftDetected, true);
  assert.equal(resultDiagnostics.identityCorrectionApplied, true);
  assert.equal(runDiagnostics.state.identityConsistency.driftCount, 2);
  assert.ok(runDiagnostics.suspects.some((entry) => entry.type === 'identity-drift'));
  assert.ok(runDiagnostics.recipe.rationale.some((entry) => /identity fields drifted/i.test(entry)));
});

test('applied browser identity parity is surfaced in result snapshots and diagnostics', () => {
  const request = {
    headers: {
      'user-agent': 'ExpectedUA/2.0',
      'accept-language': 'en-US,en;q=0.9',
    },
    tlsProfile: 'chrome-latest',
    h2Profile: 'chrome-latest',
    identity: {
      enabled: true,
      userAgent: 'ExpectedUA/2.0',
      acceptLanguage: 'en-US,en;q=0.9',
    },
  };
  const response = {
    status: 200,
    body: '<html>ok</html>',
    headers: {},
    debug: {
      identity: {
        seed: 123,
        userAgent: 'ExpectedUA/2.0',
        acceptLanguage: 'fr-FR,fr;q=0.9',
        locale: 'fr-FR',
        tlsProfile: 'chrome-latest',
        h2Profile: 'chrome-latest',
        parity: {
          userAgent: true,
          acceptLanguage: false,
          tlsProfile: true,
          h2Profile: true,
        },
      },
    },
  };

  const identity = buildResultIdentitySnapshot({ request, response });
  const diagnostics = inspectResultDiagnostics({
    request,
    response,
    extracted: { ok: true },
    quality: {},
  });

  assert.equal(identity.applied.seed, 123);
  assert.equal(identity.applied.locale, 'fr-FR');
  assert.equal(identity.parity.userAgentMatches, true);
  assert.equal(identity.parity.acceptLanguageMatches, false);
  assert.equal(diagnostics.browserIdentityMismatchCount, 1);
  assert.equal(diagnostics.primaryClass, 'identity');
});

test('protocol analyzers decode protobuf and gRPC payloads using proto descriptors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-proto-'));
  const protoPath = join(root, 'echo.proto');

  try {
    await writeFile(protoPath, `
      syntax = "proto3";
      message PingRequest {
        string query = 1;
        int32 page = 2;
      }
      message PingReply {
        string answer = 1;
      }
      service EchoService {
        rpc Ping (PingRequest) returns (PingReply);
      }
    `);

    const message = Buffer.concat([
      encodeProtobufString(1, 'hello'),
      encodeProtobufInt(2, 7),
    ]);

    const protobuf = await analyzeProtobufPayload(message, {
      assumeBase64: false,
      descriptorPaths: [protoPath],
      messageType: 'PingRequest',
    });
    assert.equal(protobuf.decoded.fields[0].fieldName, 'query');
    assert.equal(protobuf.decoded.fields[0].value, 'hello');
    assert.equal(protobuf.decoded.fields[1].fieldName, 'page');
    assert.equal(protobuf.decoded.fields[1].value, 7);

    const grpcFrame = Buffer.alloc(5 + message.length);
    grpcFrame[0] = 0;
    grpcFrame.writeUInt32BE(message.length, 1);
    message.copy(grpcFrame, 5);

    const grpc = await analyzeGrpcPayload(grpcFrame, {
      assumeBase64: false,
      descriptorPaths: [protoPath],
      path: '/EchoService/Ping',
      direction: 'request',
    });
    assert.equal(grpc.frameCount, 1);
    assert.equal(grpc.method.requestType, 'PingRequest');
    assert.equal(grpc.frames[0].message.fields[0].fieldName, 'query');
    assert.equal(grpc.frames[0].message.fields[1].value, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
