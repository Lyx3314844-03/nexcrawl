import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.js';
import puppeteer from 'puppeteer';

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

async function createFixtureSite() {
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Set-Cookie', 'session=test-cookie; Path=/');
      res.end('<html><head><title>CDP Fixture</title></head><body><div id="app">ok</div></body></html>');
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

test('reverse analysis API exposes analyze, execute, and invoke routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-reverse-api-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const analyzeResponse = await fetch(`${apiBase}/reverse/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'script',
        code: 'function sign(v){ return btoa(v); } exports.sign = sign; fetch("/api/x");',
        target: 'inline://reverse.js',
      }),
    });
    assert.equal(analyzeResponse.status, 200);
    const analyze = await analyzeResponse.json();
    assert.equal(analyze.result.kind, 'javascript');
    assert.ok(analyze.result.names.functions.includes('sign'));
    assert.ok(analyze.result.endpoints.includes('/api/x'));
    assert.equal(analyze.result.ast.ok, true);
    assert.ok(analyze.result.ast.calls.includes('fetch'));

    const executeResponse = await fetch(`${apiBase}/reverse/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'function sign(v){ return v + "-sig"; } exports.sign = sign;',
        expression: 'exports.sign("demo")',
      }),
    });
    assert.equal(executeResponse.status, 200);
    const execute = await executeResponse.json();
    assert.equal(execute.result.result, 'demo-sig');

    const sandboxResponse = await fetch(`${apiBase}/reverse/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'exports.check = () => ({ hasFetch: typeof fetch === "function", hasSubtle: !!crypto?.subtle, hasWorker: typeof Worker === "function", hasWebAssembly: typeof WebAssembly === "object" });',
        expression: 'exports.check()',
      }),
    });
    assert.equal(sandboxResponse.status, 200);
    const sandbox = await sandboxResponse.json();
    assert.equal(sandbox.result.result.hasFetch, true);
    assert.equal(sandbox.result.result.hasSubtle, true);
    assert.equal(sandbox.result.result.hasWorker, true);
    assert.equal(sandbox.result.result.hasWebAssembly, true);

    const invokeResponse = await fetch(`${apiBase}/reverse/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'function token(v){ return v + "-token"; }',
        functionName: 'token',
        args: ['abc'],
      }),
    });
    assert.equal(invokeResponse.status, 200);
    const invoke = await invokeResponse.json();
    assert.equal(invoke.result.result, 'abc-token');

    const aiAnalyzeResponse = await fetch(`${apiBase}/reverse/ai/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: `
          function _0xabc(value){ return atob(value); }
          const body = { token: "demo", page: 1 };
          fetch("/api/items?lang=zh", { method: "POST", body: JSON.stringify(body) });
        `,
        responseBody: JSON.stringify({ ok: true, items: [{ id: 1 }] }),
        status: 429,
        headers: {
          'retry-after': '30',
        },
        html: '<html><body>Too many requests</body></html>',
      }),
    });
    assert.equal(aiAnalyzeResponse.status, 200);
    const aiAnalyze = await aiAnalyzeResponse.json();
    assert.equal(aiAnalyze.result.kind, 'ai-surface-analysis');
    assert.ok(aiAnalyze.result.apiParameters.endpoints.includes('/api/items?lang=zh'));
    assert.equal(aiAnalyze.result.responseSchema.rootType, 'object');
    assert.equal(aiAnalyze.result.protection.antiCrawl.detected, true);
    assert.equal(aiAnalyze.result.ai.executed, false);
    assert.match(aiAnalyze.result.ai.prompt.user, /Do not provide attack, bypass, exploit, or decryption instructions/i);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('reverse analysis API exposes advanced reverse capability families', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-reverse-api-advanced-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const capabilitiesResponse = await fetch(`${apiBase}/reverse/capabilities`);
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = await capabilitiesResponse.json();
    assert.equal(capabilities.integrations.ast.available, true);
    assert.equal(capabilities.integrations.crypto.available, true);
    assert.equal(capabilities.integrations.node.available, true);
    assert.equal(capabilities.integrations.webpack.available, true);
    assert.equal(capabilities.integrations.jsdom.available, true);
    assert.equal(capabilities.integrations.curlconverter.available, true);
    assert.equal(capabilities.integrations.puppeteer.available, true);
    assert.equal(typeof capabilities.integrations.patchright.available, 'boolean');
    assert.equal(typeof capabilities.integrations.playwright.available, 'boolean');
    assert.equal(typeof capabilities.integrations['playwright-core'].available, 'boolean');
    assert.equal(capabilities.integrations.browserAutomation.available, true);
    assert.ok(Array.isArray(capabilities.browserBackends.available));
    assert.ok(Array.isArray(capabilities.browserBackends.catalog));
    assert.ok(capabilities.browserBackends.catalog.some((item) => item.name === 'patchright' && item.packageName === 'patchright'));
    assert.ok(capabilities.browserBackends.available.some((item) => item.name === 'puppeteer'));
    assert.equal(capabilities.browserBackends.preferredDefault, capabilities.browserBackends.available[0]?.name ?? null);
    const hasAlternateBackend = capabilities.browserBackends.available.some((item) => item.name !== 'puppeteer');
    assert.equal(capabilities.browserBackends.verification.readyForRealBackendAcceptance, hasAlternateBackend);
    assert.ok(Array.isArray(capabilities.browserBackends.verification.alternateBackends));
    assert.ok(Array.isArray(capabilities.browserBackends.verification.missingAlternatePackages));
    assert.equal(capabilities.browserBackends.debuggerSupport.puppeteer.workerTargets, 'full');
    assert.equal(capabilities.browserBackends.debuggerSupport.playwrightFamily.workerTargets, 'full');
    assert.equal(capabilities.browserBackends.debuggerSupport.playwrightFamily.auxiliaryTargets, 'full');
    if (!hasAlternateBackend) {
      assert.match(capabilities.browserBackends.verification.blocker ?? '', /Install patchright, playwright, or playwright-core/i);
    } else {
      assert.equal(capabilities.browserBackends.verification.blocker, null);
    }

    const cryptoResponse = await fetch(`${apiBase}/reverse/crypto/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'const key = "1234567890123456"; CryptoJS.AES.encrypt(data, key);',
      }),
    });
    assert.equal(cryptoResponse.status, 200);
    const crypto = await cryptoResponse.json();
    assert.equal(crypto.result.kind, 'crypto-analysis');
    assert.ok(crypto.result.cryptoTypes.some((item) => item.name === 'AES'));

    const astResponse = await fetch(`${apiBase}/reverse/ast/control-flow`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'function sign(v){ if(v){ return v; } return null; }',
      }),
    });
    assert.equal(astResponse.status, 200);
    const ast = await astResponse.json();
    assert.equal(ast.result.kind, 'ast-control-flow');
    assert.ok(ast.result.controlFlow.functions.some((item) => item.name === 'sign'));
    assert.equal(ast.result.complexity.branchCount, 1);

    const webpackResponse = await fetch(`${apiBase}/reverse/webpack/analyze`, {
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
    assert.equal(webpack.result.kind, 'webpack-analysis');
    assert.equal(webpack.result.isWebpack, true);
    assert.ok(Array.isArray(webpack.result.structure.runtimeGlobals));
    assert.equal(typeof webpack.result.structure.moduleIdType, 'string');

    const browserResponse = await fetch(`${apiBase}/reverse/browser/simulate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'document.body.innerHTML = "<div id=\\"token\\">ok</div>"; document.cookie = "sid=demo"; document.querySelector("#token").textContent;',
        html: '<html><body></body></html>',
      }),
    });
    assert.equal(browserResponse.status, 200);
    const browser = await browserResponse.json();
    assert.equal(browser.result.kind, 'browser-simulate');
    assert.equal(browser.result.result, 'ok');
    assert.match(browser.result.cookies, /sid=demo/);

    const chromiumResponse = await fetch(`${apiBase}/reverse/browser/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        html: '<html><body><div id="token">ready</div></body></html>',
        code: 'window.answer = document.querySelector("#token").textContent + "-browser";',
        expression: 'window.answer',
      }),
    });
    assert.equal(chromiumResponse.status, 200);
    const chromium = await chromiumResponse.json();
    assert.equal(chromium.result.kind, 'browser-execute');
    assert.equal(typeof chromium.result.engine, 'string');
    assert.equal(typeof chromium.result.backendFamily, 'string');
    assert.equal(chromium.result.requestedEngine, 'auto');
    assert.equal(chromium.result.result, 'ready-browser');

    const chromiumStealthResponse = await fetch(`${apiBase}/reverse/browser/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        html: '<html><body></body></html>',
        expression: `(async () => {
          const permission = await navigator.permissions.query({ name: 'notifications' });
          return {
            webdriver: navigator.webdriver,
            vendor: navigator.vendor,
            hardwareConcurrency: navigator.hardwareConcurrency,
            hasUserAgentData: !!navigator.userAgentData,
            hasChromeRuntime: !!window.chrome?.runtime,
            permission: permission.state,
          };
        })()`,
      }),
    });
    assert.equal(chromiumStealthResponse.status, 200);
    const chromiumStealth = await chromiumStealthResponse.json();
    assert.equal(chromiumStealth.result.result.webdriver, false);
    assert.equal(chromiumStealth.result.result.vendor, 'Google Inc.');
    assert.equal(chromiumStealth.result.result.hardwareConcurrency, 8);
    assert.equal(chromiumStealth.result.result.hasUserAgentData, true);
    assert.equal(chromiumStealth.result.result.hasChromeRuntime, true);
    assert.equal(chromiumStealth.result.result.permission, 'default');

    const poolResponse = await fetch(`${apiBase}/runtime/browser-pool`);
    assert.equal(poolResponse.status, 200);
    const pool = await poolResponse.json();
    assert.ok(pool.size >= 1);
    assert.ok(pool.availableBackends.some((item) => item.name === chromium.result.engine));
    assert.ok(pool.items.some((item) => item.activePages === 0));
    assert.ok(pool.items.some((item) => item.backend === chromium.result.engine));
    assert.ok(pool.items.some((item) => item.requestedEngine === chromium.result.requestedEngine));

    const curlResponse = await fetch(`${apiBase}/reverse/curl/convert`, {
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
    assert.equal(curl.result.kind, 'curl-convert');
    assert.match(curl.result.code, /requests/);

    const hooksResponse = await fetch(`${apiBase}/reverse/hooks/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        options: {
          monitorNetwork: true,
          monitorCrypto: true,
        },
      }),
    });
    assert.equal(hooksResponse.status, 200);
    const hooks = await hooksResponse.json();
    assert.equal(hooks.result.kind, 'hooks-generate');
    assert.match(hooks.result.code, /window\.__hookedCalls__/);

    const genericResponse = await fetch(`${apiBase}/reverse/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operation: 'ast.obfuscation',
        code: 'while(true){switch(flag){case 1: break;}}',
      }),
    });
    assert.equal(genericResponse.status, 200);
    const generic = await genericResponse.json();
    assert.equal(generic.result.kind, 'ast-obfuscation');
    assert.equal(generic.result.isObfuscated, true);

    const workflowResponse = await fetch(`${apiBase}/reverse/workflow`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: `
          const key = "1234567890123456";
          function sign(payload) {
            return CryptoJS.AES.encrypt(payload, key).toString();
          }
          fetch("/api/sign");
        `,
        includeHookCode: true,
      }),
    });
    assert.equal(workflowResponse.status, 200);
    const workflow = await workflowResponse.json();
    assert.equal(workflow.result.kind, 'workflow-analysis');
    assert.equal(workflow.result.summary.likelySignatureFlow, true);
    assert.ok(workflow.result.hooks.recommended.includes('crypto'));
    assert.match(workflow.result.hooks.generated.runtime, /window\.__hookedCalls__/);

    const batchResponse = await fetch(`${apiBase}/reverse/batch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        items: [
          {
            operation: 'crypto.identify',
            code: 'CryptoJS.AES.encrypt(payload, key);',
          },
          {
            operation: 'ast.strings',
            code: 'const token = "abc"; const endpoint = "/api/x";',
          },
        ],
      }),
    });
    assert.equal(batchResponse.status, 200);
    const batch = await batchResponse.json();
    assert.equal(batch.total, 2);
    assert.equal(batch.successCount, 2);
    assert.equal(batch.items[0].success, true);
    assert.ok(batch.items[0].result.identified.some((item) => item.name === 'AES'));
    assert.equal(batch.items[1].success, true);
    assert.ok(batch.items[1].result.strings.some((item) => item.value === 'abc'));

    const deobfuscateResponse = await fetch(`${apiBase}/reverse/ast/deobfuscate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: `
          const parts = ['SGVsbG8=', 'V29ybGQ='];
          const joined = parts[0] + parts[1];
          const decoded = Buffer.from('c2VjcmV0LXRva2Vu', 'base64').toString('utf8');
          const banner = 'node-' + 'reverse';
        `,
      }),
    });
    assert.equal(deobfuscateResponse.status, 200);
    const deobfuscate = await deobfuscateResponse.json();
    assert.equal(deobfuscate.result.kind, 'ast-deobfuscate');
    assert.ok(deobfuscate.result.constantBindings.some((item) => item.name === 'banner' && item.value === 'node-reverse'));
    assert.ok(deobfuscate.result.decodedStrings.includes('secret-token'));

    const analysisDir = join(root, 'analysis');
    const entryPath = join(root, 'entry.js');
    await mkdir(analysisDir, { recursive: true });
    await writeFile(join(analysisDir, 'path-helper.cjs'), `exports.buildNativePath = (suffix) => '/native/' + suffix;`, 'utf8');
    await writeFile(join(analysisDir, 'socket-core.cjs'), `exports.pickNamespace = (namespace) => namespace;`, 'utf8');
    await writeFile(
      join(analysisDir, 'socket-helper.cjs'),
      `const { pickNamespace } = require('./socket-core.cjs');
exports.buildImportedNamespace = (root, namespace) => root.of(pickNamespace(namespace));
exports.namespaceFactory = {
  build(root, namespace) { return root.of(pickNamespace(namespace)); },
};
exports.NamespaceBuilder = class NamespaceBuilder {
  build(root, namespace) { return root.of(pickNamespace(namespace)); }
};`,
      'utf8',
    );
    await writeFile(join(analysisDir, 'graphql-core.cjs'), `exports.normalizeGraphqlPath = (path) => path;`, 'utf8');
    await writeFile(
      join(analysisDir, 'graphql-helper.cjs'),
      `const { normalizeGraphqlPath } = require('./graphql-core.cjs');
exports.buildImportedMiddleware = (server, path) => server.getMiddleware({ path: normalizeGraphqlPath(path) });
exports.graphqlFactory = {
  middleware(server, path) { return server.getMiddleware({ path: normalizeGraphqlPath(path) }); },
};
exports.GraphqlBuilder = class GraphqlBuilder {
  middleware(server, path) { return server.getMiddleware({ path: normalizeGraphqlPath(path) }); }
};`,
      'utf8',
    );
    await writeFile(
      join(analysisDir, 'route-table.cjs'),
      `const { buildNativePath } = require('./path-helper.cjs');
const table = [{ method: 'HEAD', path: buildNativePath('imported-head') }];
table.push({ method: 'OPTIONS', path: buildNativePath('imported-options') });
module.exports.EXTRA_ROUTES = table.concat([{ method: 'TRACE', path: buildNativePath('imported-trace') }]);`,
      'utf8',
    );

    const nodeProfileCode = `#!/usr/bin/env node
const fs = require('node:fs');
const { execSync } = require('child_process');
const express = require('express');
const Hapi = require('@hapi/hapi');
const Router = require('@koa/router');
const restify = require('restify');
const fastify = require('fastify');
const axios = require('axios');
const got = require('got');
const mercurius = require('mercurius');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { graphqlHTTPKoa } = require('graphql-http/lib/use/koa');
const { createYoga } = require('graphql-yoga');
const { createHandler } = require('graphql-sse');
const { startServerAndCreateLambdaHandler } = require('@as-integrations/aws-lambda');
const { Worker, isMainThread } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { GraphQLClient } = require('graphql-request');
const { graphqlHTTP } = require('express-graphql');
const WebSocket = require('ws');
const { Server: SocketIOServer } = require('socket.io');
const { buildImportedNamespace, namespaceFactory: importedNamespaceFactory, NamespaceBuilder } = require('./analysis/socket-helper.cjs');
const { buildImportedMiddleware, graphqlFactory: importedGraphqlFactory, GraphqlBuilder } = require('./analysis/graphql-helper.cjs');
const { EXTRA_ROUTES } = require('./analysis/route-table.cjs');
const { buildNativePath: importedBuildNativePath } = require('./analysis/path-helper.cjs');
const configPath = process.env.CONFIG_PATH;
const body = fs.readFileSync(configPath, 'utf8');
const buildNativePath = (suffix) => '/native/' + suffix;
const createNamespace = (root, namespace) => root.of(namespace);
class NamespaceFactory {
  constructor(root) { this.root = root; }
  build(namespace) { return this.root.of(namespace); }
}
const socketFactory = {
  build(root, namespace) { return root.of(namespace); },
};
const buildLegacyMiddleware = (server, path) => server.getMiddleware({ path });
class YogaFactory {
  create(path) { return createYoga({ graphqlEndpoint: path }); }
}
const graphqlFactory = {
  middleware(server, path) { return server.getMiddleware({ path }); },
};
let ROUTE_TABLE = [
  { method: 'PUT', path: buildNativePath('table-put') },
  ['DELETE', '/native/table-delete'],
  { method: 'GET', pattern: /^\\/native\\/regex\\/\\d+$/ },
];
const makeRouteTable = (base) => [
  { method: 'PATCH', path: base + '/table-helper' },
];
const matchRoute = (table, verb, path) => table.find((route) => route.method === verb && route.path === path);
const app = express();
const koaRouter = new Router();
koaRouter.prefix('/koa');
koaRouter.get('/items', listItems);
const apiRouter = express.Router();
apiRouter.get('/users', listItems);
app.use('/v3', apiRouter);
app.get('/api/items', function listItems(_req, res) { res.json([]); });
app.route('/chain').get(listItems).post(listItems);
app.use('/graphql', graphqlHTTP(() => ({ schema: null })));
const apolloServer = new ApolloServer({ typeDefs: [], resolvers: {} });
app.use('/apollo', expressMiddleware(apolloServer));
const legacyApolloMiddleware = apolloServer.getMiddleware({ path: '/apollo-legacy' });
app.use(legacyApolloMiddleware);
const helperGraphqlMiddleware = buildLegacyMiddleware(apolloServer, '/apollo-helper');
app.use(helperGraphqlMiddleware);
const objectGraphqlMiddleware = graphqlFactory.middleware(apolloServer, '/apollo-object');
app.use(objectGraphqlMiddleware);
const importedGraphqlMiddleware = buildImportedMiddleware(apolloServer, '/apollo-imported-helper');
app.use(importedGraphqlMiddleware);
const importedObjectGraphqlMiddleware = importedGraphqlFactory.middleware(apolloServer, '/apollo-imported-object');
app.use(importedObjectGraphqlMiddleware);
const importedGraphqlBuilder = new GraphqlBuilder();
const importedClassGraphqlMiddleware = importedGraphqlBuilder.middleware(apolloServer, '/apollo-imported-class');
app.use(importedClassGraphqlMiddleware);
const yogaApp = createYoga({ graphqlEndpoint: '/yoga-alt' });
app.use(yogaApp);
const yogaFactory = new YogaFactory();
const classYogaApp = yogaFactory.create('/class-yoga');
app.use(classYogaApp);
const koaGraphql = graphqlHTTPKoa({ schema: {} });
app.use('/koa-graphql', koaGraphql);
const genericGraphqlHandler = createHandler({ path: '/handler-graphql' });
app.use(genericGraphqlHandler);
const lambdaGraphql = startServerAndCreateLambdaHandler(apolloServer, { path: '/lambda-graphql' });
const hapiServer = Hapi.server({ port: 0 });
hapiServer.route({ method: ['GET', 'POST'], path: '/v1/hapi', handler: listItems });
const restServer = restify.createServer();
restServer.get('/rest/items', listItems);
const http = require('node:http');
const rawServer = http.createServer(app);
const fastifyApp = fastify();
fastifyApp.register(mercurius, { path: '/fast-graphql', schema: 'type Query { ping: String }' });
const io = new SocketIOServer(rawServer, { path: '/socket.io' });
io.use(authorizeSocket);
io.to('global-room').emit('global-update');
const adminNs = io.of('/admin');
const helperNs = createNamespace(io, '/helper-admin');
const namespaceFactory = new NamespaceFactory(io);
const classNs = namespaceFactory.build('/class-admin');
const objectNs = socketFactory.build(io, '/object-admin');
const importedHelperNs = buildImportedNamespace(io, '/imported-helper-admin');
const importedObjectNs = importedNamespaceFactory.build(io, '/imported-object-admin');
const importedClassBuilder = new NamespaceBuilder();
const importedClassNs = importedClassBuilder.build(io, '/imported-class-admin');
adminNs.use(authorizeSocket);
adminNs.on('connection', function onAdminConnection(client) {
  client.join('dash-room');
  client.to('dash-room').emit('dash-update');
  client.on('refresh-dashboard', listItems);
  client.emit('admin-ready');
  client.leave('dash-room');
});
helperNs.use(authorizeSocket);
helperNs.on('connection', function onHelperConnection(client) {
  client.emit('helper-ready');
});
classNs.on('connection', function onClassConnection(client) {
  client.emit('class-ready');
});
objectNs.on('connection', function onObjectConnection(client) {
  client.emit('object-ready');
});
importedHelperNs.on('connection', function onImportedHelperConnection(client) {
  client.emit('imported-helper-ready');
});
importedObjectNs.on('connection', function onImportedObjectConnection(client) {
  client.emit('imported-object-ready');
});
importedClassNs.on('connection', function onImportedClassConnection(client) {
  client.emit('imported-class-ready');
});
io.on('connection', function onIoConnection(client) {
  client.on('join-room', listItems);
  client.emit('welcome');
});
const wsServer = new WebSocket.Server({ path: '/ws-server' });
wsServer.on('connection', function onWsConnection(client) {
  client.on('message', listItems);
  client.send('ack');
});
ROUTE_TABLE.push({ method: 'POST', path: buildNativePath('table-post-pushed') });
ROUTE_TABLE = ROUTE_TABLE.concat(makeRouteTable('/native'));
ROUTE_TABLE = ROUTE_TABLE.concat(EXTRA_ROUTES);
const nativeServer = http.createServer(function nativeHandler(req, res) {
  const { method, url } = req;
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && req.url === '/native/items') {
    res.end('items');
    return;
  }
  if (method === 'POST' && url === '/native/post') {
    res.end('posted');
    return;
  }
  if (url.startsWith('/native/prefix/')) {
    res.end('prefix');
    return;
  }
  if (pathname === '/native/pathname') {
    res.end('pathname');
    return;
  }
  if (pathname === buildNativePath('helper')) {
    res.end('helper');
    return;
  }
  if (pathname === importedBuildNativePath('from-import')) {
    res.end('imported-helper');
    return;
  }
  if (pathname.startsWith('/native/path-prefix/')) {
    res.end('pathname-prefix');
    return;
  }
  const matchedRoute = matchRoute(ROUTE_TABLE, method, pathname);
  if (matchedRoute) {
    res.end('matched');
    return;
  }
  switch (req.url) {
    case '/native/health':
      res.end('ok');
      return;
    default:
      res.end('missing');
  }
});
fetch('https://example.com/api/items');
const apiClient = axios.create({ baseURL: 'https://example.com' });
apiClient.get('/v2/items');
const gotClient = got.extend({ prefixUrl: 'https://example.com/base/' });
gotClient.post('submit');
const fromUrl = new URL('/via-url', 'https://example.com');
fetch(fromUrl.toString());
const gqlClient = new GraphQLClient('https://example.com/graphql');
gqlClient.request('query Demo { ping }');
const socket = new WebSocket('wss://example.com/socket');
socket.addEventListener('message', listItems);
socket.send('hello');
const localRequire = createRequire(__filename);
if (process.argv[2]) {
  execSync(process.argv[2]);
}
if (isMainThread) {
  new Worker('./worker.js');
}
module.exports = { body };`;
    await writeFile(entryPath, nodeProfileCode, 'utf8');

    const nodeProfileResponse = await fetch(`${apiBase}/reverse/node/profile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: nodeProfileCode,
        target: entryPath,
      }),
    });
    assert.equal(nodeProfileResponse.status, 200);
    const nodeProfile = await nodeProfileResponse.json();
    assert.equal(nodeProfile.result.kind, 'node-profile');
    assert.equal(nodeProfile.result.meta.moduleFormat, 'cjs');
    assert.ok(nodeProfile.result.modules.builtin.includes('fs'));
    assert.ok(nodeProfile.result.modules.builtin.includes('child_process'));
    assert.ok(nodeProfile.result.runtime.filesystem.some((item) => item.api.includes('fs.readFileSync')));
    assert.ok(nodeProfile.result.runtime.subprocess.some((item) => item.api.includes('child_process.execSync')));
    assert.ok(nodeProfile.result.runtime.process.envKeys.some((item) => item.key === 'CONFIG_PATH'));
    assert.ok(nodeProfile.result.runtime.httpClients.some((item) => item.target === 'https://example.com/api/items'));
    assert.ok(nodeProfile.result.runtime.httpClients.some((item) => item.target === 'https://example.com/v2/items'));
    assert.ok(nodeProfile.result.runtime.httpClients.some((item) => item.target === 'https://example.com/base/submit'));
    assert.ok(nodeProfile.result.runtime.httpClients.some((item) => item.target === 'https://example.com/via-url'));
    assert.ok(nodeProfile.result.runtime.servers.frameworks.includes('express'));
    assert.ok(nodeProfile.result.runtime.servers.frameworks.includes('hapi'));
    assert.ok(nodeProfile.result.runtime.servers.frameworks.includes('koa-router'));
    assert.ok(nodeProfile.result.runtime.servers.frameworks.includes('restify'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.method === 'GET' && item.path === '/api/items'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'koa-router' && item.method === 'GET' && item.path === '/koa/items'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.method === 'GET' && item.path === '/v3/users'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.method === 'GET' && item.path === '/chain'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.method === 'POST' && item.path === '/chain'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'hapi' && item.method === 'GET' && item.path === '/v1/hapi'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'hapi' && item.method === 'POST' && item.path === '/v1/hapi'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'restify' && item.method === 'GET' && item.path === '/rest/items'));
    assert.ok(nodeProfile.result.runtime.servers.entrypoints.some((item) => item.framework === 'node-http' && item.target === 'app'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'GET' && item.path === '/native/items'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'POST' && item.path === '/native/post'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.path === '/native/prefix/*'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.path === '/native/pathname'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.path === '/native/helper'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.path === '/native/from-import'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.path === '/native/path-prefix/*'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'PUT' && item.path === '/native/table-put'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'DELETE' && item.path === '/native/table-delete'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'POST' && item.path === '/native/table-post-pushed'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'PATCH' && item.path === '/native/table-helper'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'HEAD' && item.path === '/native/imported-head'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'OPTIONS' && item.path === '/native/imported-options'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'TRACE' && item.path === '/native/imported-trace'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'GET' && item.path === 'regex:/^\\/native\\/regex\\/\\d+$/'));
    assert.ok(nodeProfile.result.runtime.servers.routes.some((item) => item.framework === 'node-http' && item.method === 'ANY' && item.path === '/native/health'));
    assert.ok(nodeProfile.result.runtime.moduleLoading.some((item) => item.api === 'module.createRequire'));
    assert.ok(nodeProfile.result.runtime.workers.some((item) => item.api.includes('worker_threads.isMainThread')));
    assert.ok(nodeProfile.result.runtime.workers.some((item) => item.api.includes('worker_threads.Worker')));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.target === 'wss://example.com/socket'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.kind === 'server' && item.target === '/socket.io'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.kind === 'server' && item.target === '/ws-server'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'message' && item.container === 'socket'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.kind === 'send' && item.container === 'socket'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.kind === 'middleware' && item.container === 'io'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.kind === 'emit' && item.container === 'io' && item.room === 'global-room' && item.event === 'global-update'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'connection' && item.container === 'io'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'connection' && item.container === 'adminNs' && item.namespace === '/admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'connection' && item.container === 'helperNs' && item.namespace === '/helper-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'helper-ready' && item.container === 'helperNs' && item.namespace === '/helper-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'connection' && item.container === 'classNs' && item.namespace === '/class-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'class-ready' && item.container === 'classNs' && item.namespace === '/class-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'connection' && item.container === 'objectNs' && item.namespace === '/object-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'object-ready' && item.container === 'objectNs' && item.namespace === '/object-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'connection' && item.container === 'importedHelperNs' && item.namespace === '/imported-helper-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'imported-helper-ready' && item.container === 'importedHelperNs' && item.namespace === '/imported-helper-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'connection' && item.container === 'importedObjectNs' && item.namespace === '/imported-object-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'imported-object-ready' && item.container === 'importedObjectNs' && item.namespace === '/imported-object-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'connection' && item.container === 'importedClassNs' && item.namespace === '/imported-class-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'imported-class-ready' && item.container === 'importedClassNs' && item.namespace === '/imported-class-admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.kind === 'middleware' && item.container === 'adminNs' && item.namespace === '/admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.kind === 'room-join' && item.container === 'adminNs' && item.room === 'dash-room' && item.namespace === '/admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.kind === 'emit' && item.container === 'adminNs' && item.room === 'dash-room' && item.event === 'dash-update' && item.namespace === '/admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'refresh-dashboard' && item.container === 'adminNs' && item.namespace === '/admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'admin-ready' && item.container === 'adminNs' && item.namespace === '/admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.kind === 'room-leave' && item.container === 'adminNs' && item.room === 'dash-room' && item.namespace === '/admin'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'join-room' && item.container === 'io'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'welcome' && item.container === 'io'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'connection' && item.container === 'wsServer'));
    assert.ok(nodeProfile.result.runtime.websockets.some((item) => item.event === 'message' && item.container === 'wsServer'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/graphql' || item.target === 'https://example.com/graphql'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/apollo'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/apollo-legacy'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/apollo-helper'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/apollo-object'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/apollo-imported-helper'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/apollo-imported-object'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/apollo-imported-class'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/yoga-alt'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/class-yoga'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/koa-graphql'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/handler-graphql'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/lambda-graphql'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.target === '/fast-graphql'));
    assert.ok(nodeProfile.result.runtime.graphql.some((item) => item.api === 'graphql-request.request' && item.target === 'https://example.com/graphql'));
    assert.equal(nodeProfile.result.risks.level, 'high');

    assert.ok(capabilities.advanced.protocols.includes('protobuf.analyze'));
    assert.ok(capabilities.advanced.protocols.includes('grpc.analyze'));
    assert.equal(capabilities.integrations.protocols.available, true);

    const protobufMessage = Buffer.concat([
      encodeVarint((1 << 3) | 2),
      encodeVarint(5),
      Buffer.from('hello', 'utf8'),
      encodeVarint((2 << 3) | 0),
      encodeVarint(7),
    ]);
    const grpcFrame = Buffer.alloc(5 + protobufMessage.length);
    grpcFrame[0] = 0;
    grpcFrame.writeUInt32BE(protobufMessage.length, 1);
    protobufMessage.copy(grpcFrame, 5);

    const protobufResponse = await fetch(`${apiBase}/reverse/protobuf/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        data: protobufMessage.toString('base64'),
        descriptorPaths: [],
        messageType: null,
      }),
    });
    assert.equal(protobufResponse.status, 200);
    const protobuf = await protobufResponse.json();
    assert.equal(protobuf.result.kind, 'protobuf-analysis');
    assert.equal(protobuf.result.decoded.fields[0].fieldNumber, 1);
    assert.equal(protobuf.result.decoded.fields[0].value, 'hello');

    const grpcResponse = await fetch(`${apiBase}/reverse/grpc/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        data: grpcFrame.toString('base64'),
        path: '/EchoService/Ping',
      }),
    });
    assert.equal(grpcResponse.status, 200);
    const grpc = await grpcResponse.json();
    assert.equal(grpc.result.kind, 'grpc-analysis');
    assert.equal(grpc.result.frameCount, 1);
    assert.equal(grpc.result.frames[0].message.fields[1].value, 7);

    const nativePlanResponse = await fetch(`${apiBase}/reverse/app/native-plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        app: {
          bundleId: 'com.example.app',
          frida: { enabled: true, scriptPath: 'hooks/native.js' },
          mitmproxy: { enabled: true, dumpPath: 'captures/native.dump' },
        },
        toolStatus: {
          frida: { available: true, version: '16.0.0' },
          'frida-ps': { available: true, version: '16.0.0' },
          mitmdump: { available: true, version: '10.0.0' },
          mitmproxy: { available: true, version: '10.0.0' },
        },
      }),
    });
    assert.equal(nativePlanResponse.status, 200);
    const nativePlan = await nativePlanResponse.json();
    assert.equal(nativePlan.result.kind, 'app-native-plan');
    assert.ok(nativePlan.result.steps.some((step) => step.tool === 'frida'));
    assert.ok(nativePlan.result.steps.some((step) => step.tool === 'mitmdump'));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('reverse cdp routes work against a real Chrome DevTools target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-reverse-cdp-'));
  const fixture = await createFixtureSite();
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--remote-debugging-port=0'],
  });

  try {
    await browser.newPage();
    const wsEndpoint = new URL(browser.wsEndpoint());
    const port = Number(wsEndpoint.port);

    const connectResponse = await fetch(`${apiBase}/reverse/cdp/connect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        host: '127.0.0.1',
        port,
      }),
    });
    assert.equal(connectResponse.status, 200);
    const connect = await connectResponse.json();
    assert.equal(connect.result.success, true);

    const interceptResponse = await fetch(`${apiBase}/reverse/cdp/intercept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        patterns: [`${fixture.baseUrl}/*`],
      }),
    });
    assert.equal(interceptResponse.status, 200);
    const intercept = await interceptResponse.json();
    assert.equal(intercept.result.success, true);

    const navigateResponse = await fetch(`${apiBase}/reverse/cdp/navigate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/page`,
      }),
    });
    assert.equal(navigateResponse.status, 200);
    const navigate = await navigateResponse.json();
    assert.equal(navigate.result.success, true);

    const evaluateResponse = await fetch(`${apiBase}/reverse/cdp/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expression: 'document.title',
      }),
    });
    assert.equal(evaluateResponse.status, 200);
    const evaluate = await evaluateResponse.json();
    assert.equal(evaluate.result.success, true);
    assert.equal(evaluate.result.data.result.value, 'CDP Fixture');

    const requestsResponse = await fetch(`${apiBase}/reverse/cdp/requests`);
    assert.equal(requestsResponse.status, 200);
    const requests = await requestsResponse.json();
    assert.equal(requests.result.success, true);
    assert.ok(requests.result.data.requests.some((item) => item.url === `${fixture.baseUrl}/page`));

    const cookiesResponse = await fetch(`${apiBase}/reverse/cdp/cookies`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        urls: [`${fixture.baseUrl}/page`],
      }),
    });
    assert.equal(cookiesResponse.status, 200);
    const cookies = await cookiesResponse.json();
    assert.equal(cookies.result.success, true);
    assert.ok(cookies.result.data.cookies.some((item) => item.name === 'session'));

    const disconnectResponse = await fetch(`${apiBase}/reverse/cdp/disconnect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(disconnectResponse.status, 200);
    const disconnect = await disconnectResponse.json();
    assert.equal(disconnect.result.success, true);

    const evaluateAfterDisconnectResponse = await fetch(`${apiBase}/reverse/cdp/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expression: 'document.title',
      }),
    });
    assert.equal(evaluateAfterDisconnectResponse.status, 200);
    const evaluateAfterDisconnect = await evaluateAfterDisconnectResponse.json();
    assert.equal(evaluateAfterDisconnect.result.success, false);
    assert.match(evaluateAfterDisconnect.result.error, /Not connected to Chrome/);
  } finally {
    await browser.close();
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
