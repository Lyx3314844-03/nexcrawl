import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.js';

async function createFixtureSite() {
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Preview Title</title><meta name="description" content="Preview Summary" /></head><body><h1>Preview Headline</h1><a href="/next">Next</a></body></html>');
      return;
    }

    if (req.url === '/api') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ data: { title: 'API Title', count: 3 } }));
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

test('workflow template builder API returns reusable workflow definitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-template-tools-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const response = await fetch(`${apiBase}/tools/workflow-templates/build`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        taskName: 'Template Demo',
        seedUrl: 'https://example.com',
        sourceType: 'browser-rendered',
        extractPreset: 'article',
        renderWaitMs: 1200,
        useBrowserDebug: true,
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.item.workflow.name, 'Template Demo');
    assert.equal(payload.item.workflow.mode, 'browser');
    assert.equal(payload.item.workflow.browser.sleepMs, 1200);
    assert.ok(payload.item.workflow.extract.some((rule) => rule.name === 'headline'));
    assert.equal(payload.item.suggestedWorkflowId, 'template-demo');
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('universal workflow builder API scaffolds GraphQL and WebSocket workflows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-universal-workflow-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const graphqlResponse = await fetch(`${apiBase}/tools/universal-workflow/build`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://example.com/graphql',
        body: 'query Viewer { viewer { id } }',
        variables: { locale: 'zh-CN' },
      }),
    });
    assert.equal(graphqlResponse.status, 200);
    const graphqlPayload = await graphqlResponse.json();
    assert.equal(graphqlPayload.item.primaryLane, 'graphql-semantics');
    assert.equal(graphqlPayload.item.workflow.request.method, 'POST');
    assert.equal(graphqlPayload.item.workflow.seedRequests[0].method, 'POST');
    assert.equal(
      graphqlPayload.item.workflow.seedRequests[0].body,
      JSON.stringify({ query: 'query Viewer { viewer { id } }', variables: { locale: 'zh-CN' } }),
    );
    assert.ok(graphqlPayload.item.workflow.extract.some((rule) => rule.name === 'data' && rule.type === 'json'));

    const wsResponse = await fetch(`${apiBase}/tools/universal-workflow/build`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: 'wss://example.com/prices',
        sendMessage: { subscribe: 'ticker' },
        collectMs: 2500,
        maxMessages: 8,
      }),
    });
    assert.equal(wsResponse.status, 200);
    const wsPayload = await wsResponse.json();
    assert.equal(wsPayload.item.primaryLane, 'websocket-semantics');
    assert.equal(wsPayload.item.workflow.seedRequests[0].url, 'wss://example.com/prices');
    assert.deepEqual(wsPayload.item.workflow.websocket.sendMessage, { subscribe: 'ticker' });
    assert.equal(wsPayload.item.workflow.websocket.collectMs, 2500);
    assert.equal(wsPayload.item.workflow.websocket.maxMessages, 8);
    assert.ok(wsPayload.item.workflow.extract.some((rule) => rule.name === 'messages'));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('universal workflow builder API scaffolds a runnable gRPC workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-universal-grpc-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const response = await fetch(`${apiBase}/tools/universal-workflow/build`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://grpc.example.com',
        body: 'application/grpc proto service Catalog { rpc Search (SearchRequest) returns (SearchResponse); }',
        service: 'catalog.CatalogService',
        rpcMethod: 'Search',
        request: { query: 'shoes' },
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.item.primaryLane, 'grpc-semantics');
    assert.equal(payload.item.runnable, true);
    assert.equal(payload.item.workflow.request.method, 'POST');
    assert.equal(payload.item.workflow.grpc.service, 'catalog.CatalogService');
    assert.equal(payload.item.workflow.grpc.method, 'Search');
    assert.equal(payload.item.workflow.seedRequests[0].grpc.service, 'catalog.CatalogService');
    assert.equal(payload.item.workflow.seedRequests[0].grpc.method, 'Search');
    assert.equal(payload.item.workflow.seedRequests[0].label, 'grpc-call');
    assert.equal(payload.item.workflow.seedRequests[0].body, JSON.stringify({ query: 'shoes' }));
    assert.ok(payload.item.workflow.extract.some((rule) => rule.name === 'payload'));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('extract preview API evaluates selector and json preview rules', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-extract-preview-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const selectorResponse = await fetch(`${apiBase}/tools/extract-preview`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/page`,
        sourceType: 'static-page',
        rule: {
          name: 'preview',
          type: 'selector',
          selector: 'meta[name="description"]',
          attribute: 'content',
        },
      }),
    });
    assert.equal(selectorResponse.status, 200);
    const selectorPayload = await selectorResponse.json();
    assert.equal(selectorPayload.item.extracted, 'Preview Summary');

    const jsonResponse = await fetch(`${apiBase}/tools/extract-preview`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/api`,
        sourceType: 'api-json',
        rule: {
          name: 'preview',
          type: 'json',
          path: 'data.title',
        },
      }),
    });
    assert.equal(jsonResponse.status, 200);
    const jsonPayload = await jsonResponse.json();
    assert.equal(jsonPayload.item.extracted, 'API Title');
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('field picker document endpoint returns injected picking surface', async () => {
  const fixture = await createFixtureSite();
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-field-picker-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const response = await fetch(`${apiBase}/tools/field-picker/document?url=${encodeURIComponent(`${fixture.baseUrl}/page`)}&sourceType=static-page`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /字段点选模式/);
    assert.match(html, /omnicrawl-field-picker/);
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
