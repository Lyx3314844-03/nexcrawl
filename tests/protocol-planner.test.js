import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GraphQLCrawler,
  WebSocketCrawler,
} from '../src/api/crawler-presets.js';
import {
  buildGraphQLRequestPlan,
  buildGraphQLStarterOperation,
  extractPersistedQueryHints,
} from '../src/fetchers/graphql-fetcher.js';
import {
  analyzeWebSocketTranscript,
  buildWebSocketSessionPlan,
  classifyWebSocketMessage,
} from '../src/fetchers/ws-fetcher.js';

const schema = {
  queryType: 'Query',
  mutationType: 'Mutation',
  subscriptionType: 'Subscription',
  types: [
    {
      name: 'Query',
      kind: 'OBJECT',
      description: null,
      fields: [
        {
          name: 'product',
          type: 'Product',
          args: [{ name: 'id', type: 'ID!' }],
        },
      ],
    },
    {
      name: 'Mutation',
      kind: 'OBJECT',
      description: null,
      fields: [
        {
          name: 'login',
          type: 'Session',
          args: [{ name: 'email', type: 'String!' }],
        },
      ],
    },
    {
      name: 'Subscription',
      kind: 'OBJECT',
      description: null,
      fields: [
        {
          name: 'priceUpdated',
          type: 'PriceUpdate',
          args: [{ name: 'symbol', type: 'String!' }],
        },
      ],
    },
    {
      name: 'Product',
      kind: 'OBJECT',
      description: null,
      fields: [
        { name: 'id', type: 'ID!', args: [] },
        { name: 'name', type: 'String', args: [] },
        { name: 'price', type: 'Float', args: [] },
      ],
    },
    {
      name: 'Session',
      kind: 'OBJECT',
      description: null,
      fields: [
        { name: 'token', type: 'String', args: [] },
        { name: 'viewerId', type: 'ID', args: [] },
      ],
    },
    {
      name: 'PriceUpdate',
      kind: 'OBJECT',
      description: null,
      fields: [
        { name: 'symbol', type: 'String', args: [] },
        { name: 'price', type: 'Float', args: [] },
      ],
    },
  ],
};

test('GraphQL helpers extract persisted query hints and build starter operations', () => {
  const source = `
    fetch('/graphql', {
      method: 'POST',
      body: JSON.stringify({
        operationName: 'ProductQuery',
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          }
        }
      })
    });
  `;

  const hints = extractPersistedQueryHints(source, 'https://example.com/app');
  const operation = buildGraphQLStarterOperation(schema, {
    operationType: 'query',
    fieldName: 'product',
  });
  const plan = buildGraphQLRequestPlan({
    source,
    baseUrl: 'https://example.com/app',
    schema,
  });

  assert.equal(hints.length, 1);
  assert.equal(hints[0].endpoint, 'https://example.com/graphql');
  assert.equal(operation?.fieldName, 'product');
  assert.match(operation?.query ?? '', /query queryProduct/);
  assert.match(operation?.query ?? '', /product\(id: \$id\)/);
  assert.deepEqual(operation?.variables, { id: 'demo' });
  assert.equal(plan.recommendedEndpoint, 'https://example.com/graphql');
  assert.equal(plan.persistedQueries.length, 1);
  assert.equal(plan.starterOperations.length, 3);
});

test('GraphQLCrawler exposes persisted-query and request-plan helpers', () => {
  const crawler = new GraphQLCrawler();
  const source = `
    const endpoint = "/graphql";
    const query = {
      extensions: { persistedQuery: { sha256Hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }
    };
  `;

  const hints = crawler.detectPersistedQueries(source, 'https://example.com/app');
  const starter = crawler.buildStarterOperation(schema, {
    operationType: 'mutation',
  });
  const plan = crawler.buildRequestPlan(source, 'https://example.com/app', schema);

  assert.equal(hints[0].hash, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(starter?.fieldName, 'login');
  assert.match(starter?.query ?? '', /mutation mutationLogin/);
  assert.equal(plan.starterOperations[0].operationType, 'query');
});

test('WebSocket transcript helpers classify auth, subscribe, heartbeat, and data messages', () => {
  const transcript = [
    { direction: 'out', message: { type: 'auth', token: 'abc' } },
    { direction: 'in', message: { type: 'ready' } },
    { direction: 'out', message: { op: 'subscribe', channel: 'prices' } },
    { direction: 'in', message: { type: 'subscribed', channel: 'prices' } },
    { direction: 'out', message: { type: 'ping' } },
    { direction: 'in', message: { type: 'pong' } },
    { direction: 'in', message: { type: 'update', data: { price: 10 } } },
  ];

  const classified = classifyWebSocketMessage(transcript[0]);
  const analysis = analyzeWebSocketTranscript(transcript);
  const plan = buildWebSocketSessionPlan(transcript, { heartbeatIntervalMs: 15000 });

  assert.equal(classified.kind, 'auth');
  assert.equal(analysis.authLikely, true);
  assert.equal(analysis.subscriptionLikely, true);
  assert.equal(analysis.requiresHeartbeat, true);
  assert.deepEqual(analysis.likelyAuthMessage, { type: 'auth', token: 'abc' });
  assert.deepEqual(analysis.likelySubscribeMessage, { op: 'subscribe', channel: 'prices' });
  assert.deepEqual(plan.heartbeat.message, { type: 'ping' });
  assert.equal(plan.heartbeat.intervalHintMs, 15000);
  assert.equal(plan.reconnectRecommended, true);
});

test('WebSocketCrawler exposes transcript analysis helpers', () => {
  const crawler = new WebSocketCrawler();
  const transcript = [
    { direction: 'out', message: { action: 'login', token: 'abc' } },
    { direction: 'out', message: { action: 'subscribe', topic: 'orders' } },
    { direction: 'out', message: { action: 'heartbeat' } },
  ];

  const analysis = crawler.analyzeTranscript(transcript);
  const plan = crawler.buildSessionPlan(transcript);

  assert.equal(analysis.authLikely, true);
  assert.equal(analysis.subscriptionLikely, true);
  assert.equal(plan.auth.enabled, true);
  assert.equal(plan.subscribe.enabled, true);
  assert.equal(plan.heartbeat.enabled, true);
});
