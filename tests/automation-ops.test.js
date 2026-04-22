import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';

import { AiAgent } from '../src/api/ai-agent.js';
import { MfaHandler, generateTotp, solveLoginMfa } from '../src/api/mfa-handler.js';
import { fetchWebSocket } from '../src/fetchers/ws-fetcher.js';
import { ShardedDbSink } from '../src/runtime/sharded-db-sink.js';

const require = createRequire(import.meta.url);
const wsModule = require('ws');
const WebSocketServer = wsModule.WebSocketServer ?? wsModule.Server;

test('AiAgent captures browser state and executes browser actions', async () => {
  const typed = [];
  const pressed = [];
  let decisionCount = 0;

  const page = {
    async evaluate(_fn, ...args) {
      if (args.length === 2) {
        return {
          url: 'https://example.com/search',
          title: 'Search',
          htmlSnippet: 'Search page',
          elements: [
            { selector: '#search', text: 'Search', tag: 'input', type: 'text' },
          ],
        };
      }
      return null;
    },
    async focus() {},
    async $eval(_selector, fn) {
      fn({ value: 'old' });
    },
    async type(selector, text) {
      typed.push({ selector, text });
    },
    keyboard: {
      async press(key) {
        pressed.push(key);
      },
    },
  };

  const agent = new AiAgent(
    { page },
    {
      maxSteps: 3,
      delayMs: 0,
      ai: {
        provider: async () => {
          decisionCount += 1;
          if (decisionCount === 1) {
            return { action: 'type', selector: '#search', text: 'omnicrawl' };
          }
          if (decisionCount === 2) {
            return { action: 'press', key: 'Enter' };
          }
          return { action: 'finish', reason: 'submitted' };
        },
      },
    },
  );

  const result = await agent.execute('search for omnicrawl');

  assert.equal(result.status, 'success');
  assert.equal(result.reason, 'submitted');
  assert.deepEqual(typed, [{ selector: '#search', text: 'omnicrawl' }]);
  assert.deepEqual(pressed, ['Enter']);
  assert.equal(result.history.length, 2);
});

test('MfaHandler supports static, totp, and custom IMAP-like providers', async () => {
  const staticHandler = new MfaHandler({
    provider: 'static',
    config: { code: '654321' },
  });
  assert.equal(await staticHandler.getCode('demo'), '654321');

  const totp = generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', {
    digits: 8,
    timestamp: 59000,
  });
  assert.equal(totp, '94287082');

  const imapHandler = new MfaHandler({
    provider: 'imap',
    imapFactory: {
      async getLatestCode(filter) {
        assert.equal(filter, 'github');
        return '112233';
      },
    },
  });
  assert.equal(await imapHandler.getCode('github'), '112233');
});

test('solveLoginMfa fills and submits the received code', async () => {
  const calls = [];
  const page = {
    async fill(selector, value) {
      calls.push({ type: 'fill', selector, value });
    },
    async click(selector) {
      calls.push({ type: 'click', selector });
    },
  };

  const handler = new MfaHandler({
    provider: 'static',
    config: { code: '778899' },
  });

  const code = await solveLoginMfa(page, handler, '#otp', {
    submitSelector: '#submit',
  });

  assert.equal(code, '778899');
  assert.deepEqual(calls, [
    { type: 'fill', selector: '#otp', value: '778899' },
    { type: 'click', selector: '#submit' },
  ]);
});

test('fetchWebSocket supports reconnect and auth-refresh hooks', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');

  let connectionCount = 0;
  wss.on('connection', (socket) => {
    connectionCount += 1;
    if (connectionCount === 1) {
      socket.close(1011, 'retry');
      return;
    }

    socket.on('message', (message) => {
      const text = message.toString('utf8');
      const payload = JSON.parse(text);

      if (payload.subscribe === 'demo') {
        socket.send(JSON.stringify({ type: 'auth-expired' }));
        return;
      }

      if (payload.token === 'fresh-token') {
        socket.send(JSON.stringify({ type: 'ready' }));
      }
    });
  });

  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const result = await fetchWebSocket({
    url: `ws://127.0.0.1:${port}`,
    sendMessage: { subscribe: 'demo' },
    collectMs: 500,
    reconnectAttempts: 1,
    reconnectDelayMs: 20,
    reconnectOnCloseCodes: [1011],
    terminateOn: '"ready"',
    refreshOn: (message) => message.json?.type === 'auth-expired',
    authRefresh: async () => ({ token: 'fresh-token' }),
  });

  await new Promise((resolve) => wss.close(resolve));

  assert.equal(result.attemptsUsed, 2);
  assert.equal(result.reconnects, 1);
  assert.ok(result.messages.some((entry) => entry.json?.type === 'auth-expired'));
  assert.ok(result.messages.some((entry) => entry.json?.type === 'ready'));
});

test('ShardedDbSink performs grouped writes and supports the global static API', async () => {
  const writes = [];
  const sink = new ShardedDbSink({
    flushInterval: 60_000,
    shardCount: 4,
    tablePrefix: 'events',
    writer: async (tableName, items) => {
      writes.push({ tableName, items });
    },
  });

  await sink.push({ id: 1, title: 'a' });
  await sink.push({ id: 2, title: 'b' });
  const summary = await sink.flush();
  sink.close();

  assert.equal(summary.insertedCount, 2);
  assert.ok(writes.length >= 1);
  assert.ok(writes.every((entry) => entry.tableName.startsWith('events_s')));

  const dailyWrites = [];
  ShardedDbSink.configureGlobal({
    flushInterval: 60_000,
    shardType: 'daily',
    tablePrefix: 'daily_events',
    writer: async (tableName, items) => {
      dailyWrites.push({ tableName, items });
    },
  });

  await ShardedDbSink.push({
    createdAt: '2026-04-22T12:00:00.000Z',
    value: 1,
  });
  await ShardedDbSink.flush();
  ShardedDbSink.resetGlobal();

  assert.equal(dailyWrites.length, 1);
  assert.equal(dailyWrites[0].tableName, 'daily_events_d20260422');
});
