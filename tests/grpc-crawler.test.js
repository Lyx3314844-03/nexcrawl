/**
 * Tests for grpc-crawler.js — real HTTP/2 + Protobuf transport
 *
 * Validates: GrpcCrawler, GrpcConnectionPool, gRPC frame parsing,
 *            unary & streaming RPCs, retry, metadata
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import {
  GrpcCrawler,
  GrpcConnectionPool,
  GRPC_STATUS,
  GRPC_STATUS_NAME,
  RETRYABLE_STATUS,
  parseGrpcFrame,
  parseAllGrpcFrames,
} from '../src/runtime/grpc-crawler.js';
import {
  encodeProtobufMessage,
  encodeGrpcFrame,
} from '../src/reverse/protobuf-inferrer.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTestPayload(obj, schema) {
  return encodeProtobufMessage(obj, schema);
}

function createMockGrpcServer(port, handler) {
  return new Promise((resolve, reject) => {
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
      const contentType = headers['content-type'];
      if (!contentType || !contentType.startsWith('application/grpc')) {
        stream.respond({ ':status': 415 });
        stream.end();
        return;
      }
      handler(stream, headers);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ─── GRPC_STATUS constants ────────────────────────────────────────────────────

test('GRPC_STATUS — has standard gRPC status codes', () => {
  assert.equal(GRPC_STATUS.OK, 0);
  assert.equal(GRPC_STATUS.CANCELLED, 1);
  assert.equal(GRPC_STATUS.UNKNOWN, 2);
  assert.equal(GRPC_STATUS.INVALID_ARGUMENT, 3);
  assert.equal(GRPC_STATUS.DEADLINE_EXCEEDED, 4);
  assert.equal(GRPC_STATUS.NOT_FOUND, 5);
  assert.equal(GRPC_STATUS.PERMISSION_DENIED, 7);
  assert.equal(GRPC_STATUS.RESOURCE_EXHAUSTED, 8);
  assert.equal(GRPC_STATUS.UNIMPLEMENTED, 12);
  assert.equal(GRPC_STATUS.INTERNAL, 13);
  assert.equal(GRPC_STATUS.UNAVAILABLE, 14);
  assert.equal(GRPC_STATUS.UNAUTHENTICATED, 16);
});

test('GRPC_STATUS_NAME — reverse mapping', () => {
  assert.equal(GRPC_STATUS_NAME[0], 'OK');
  assert.equal(GRPC_STATUS_NAME[14], 'UNAVAILABLE');
  assert.equal(GRPC_STATUS_NAME[16], 'UNAUTHENTICATED');
});

test('RETRYABLE_STATUS — contains expected retryable codes', () => {
  assert.ok(RETRYABLE_STATUS.has(GRPC_STATUS.CANCELLED));
  assert.ok(RETRYABLE_STATUS.has(GRPC_STATUS.DEADLINE_EXCEEDED));
  assert.ok(RETRYABLE_STATUS.has(GRPC_STATUS.UNAVAILABLE));
  assert.ok(RETRYABLE_STATUS.has(GRPC_STATUS.INTERNAL));
  assert.ok(!RETRYABLE_STATUS.has(GRPC_STATUS.OK));
  assert.ok(!RETRYABLE_STATUS.has(GRPC_STATUS.INVALID_ARGUMENT));
  assert.ok(!RETRYABLE_STATUS.has(GRPC_STATUS.NOT_FOUND));
});

// ─── parseGrpcFrame ──────────────────────────────────────────────────────────
// Returns { compressed, messageLength, message, remaining } or null

test('parseGrpcFrame — valid uncompressed frame', () => {
  const payload = Buffer.from('hello world');
  const frame = encodeGrpcFrame(payload);
  const result = parseGrpcFrame(frame);
  assert.equal(result.compressed, 0);
  assert.equal(result.messageLength, payload.length);
  assert.deepStrictEqual(result.message, payload);
});

test('parseGrpcFrame — empty payload', () => {
  const payload = Buffer.alloc(0);
  const frame = encodeGrpcFrame(payload);
  const result = parseGrpcFrame(frame);
  assert.equal(result.compressed, 0);
  assert.equal(result.messageLength, 0);
  assert.deepStrictEqual(result.message, Buffer.alloc(0));
});

test('parseGrpcFrame — frame too short returns null', () => {
  const shortBuf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  const result = parseGrpcFrame(shortBuf);
  assert.equal(result, null);
});

test('parseGrpcFrame — truncated payload returns null', () => {
  const header = Buffer.alloc(5);
  header[0] = 0x00;
  header.writeUInt32BE(10, 1);
  const partial = Buffer.concat([header, Buffer.from('hello')]);
  const result = parseGrpcFrame(partial);
  assert.equal(result, null);
});

test('parseGrpcFrame — compressed flag set', () => {
  const payload = Buffer.from([0x01, 0x02, 0x03]);
  const frame = encodeGrpcFrame(payload, true);
  const result = parseGrpcFrame(frame);
  assert.equal(result.compressed, 1);
  assert.equal(result.messageLength, 3);
});

test('parseGrpcFrame — remaining bytes after frame', () => {
  const payload = Buffer.from('hello');
  const frame = encodeGrpcFrame(payload);
  const extra = Buffer.from('extra');
  const combined = Buffer.concat([frame, extra]);
  const result = parseGrpcFrame(combined);
  assert.equal(result.messageLength, 5);
  assert.deepStrictEqual(result.remaining, extra);
});

// ─── parseAllGrpcFrames ──────────────────────────────────────────────────────

test('parseAllGrpcFrames — single frame', () => {
  const payload = Buffer.from('single');
  const frame = encodeGrpcFrame(payload);
  const results = parseAllGrpcFrames(frame);
  assert.equal(results.length, 1);
  assert.deepStrictEqual(results[0], payload);
});

test('parseAllGrpcFrames — multiple frames', () => {
  const p1 = Buffer.from('first');
  const p2 = Buffer.from('second');
  const p3 = Buffer.from('third');
  const data = Buffer.concat([
    encodeGrpcFrame(p1),
    encodeGrpcFrame(p2),
    encodeGrpcFrame(p3),
  ]);
  const results = parseAllGrpcFrames(data);
  assert.equal(results.length, 3);
  assert.deepStrictEqual(results[0], p1);
  assert.deepStrictEqual(results[1], p2);
  assert.deepStrictEqual(results[2], p3);
});

test('parseAllGrpcFrames — empty buffer returns empty array', () => {
  const results = parseAllGrpcFrames(Buffer.alloc(0));
  assert.equal(results.length, 0);
});

// ─── GrpcConnectionPool ──────────────────────────────────────────────────────

test('GrpcConnectionPool — constructor with defaults', () => {
  const pool = new GrpcConnectionPool();
  assert.equal(pool.idleTimeoutMs, 30000);
  assert.equal(pool.maxSessions, 4);
  assert.ok(pool.sessions instanceof Map);
});

test('GrpcConnectionPool — constructor with custom options', () => {
  const pool = new GrpcConnectionPool({ maxSessions: 8 });
  assert.equal(pool.maxSessions, 8);
});

test('GrpcConnectionPool — closeAll on empty pool', async () => {
  const pool = new GrpcConnectionPool();
  await pool.closeAll();
  assert.equal(pool.sessions.size, 0);
});

// ─── GrpcCrawler constructor ─────────────────────────────────────────────────

test('GrpcCrawler — constructor with endpoint', () => {
  const crawler = new GrpcCrawler({ endpoint: 'localhost:50051' });
  assert.equal(crawler.endpoint, 'localhost:50051');
  assert.ok(crawler.pool instanceof GrpcConnectionPool);
  assert.ok(crawler.schemas instanceof Map);
});

test('GrpcCrawler — constructor requires endpoint', () => {
  assert.throws(
    () => new GrpcCrawler({}),
    { message: /endpoint/i },
  );
});

test('GrpcCrawler — constructor with custom metadata', () => {
  const crawler = new GrpcCrawler({
    endpoint: 'localhost:50051',
    metadata: { authorization: 'Bearer test-token' },
  });
  assert.deepStrictEqual(crawler.metadata, { authorization: 'Bearer test-token' });
});

test('GrpcCrawler — constructor with custom retry config', () => {
  const crawler = new GrpcCrawler({
    endpoint: 'localhost:50051',
    retry: { maxRetries: 5, backoff: 'exponential' },
  });
  assert.equal(crawler.retry.maxRetries, 5);
  assert.equal(crawler.retry.backoff, 'exponential');
});

test('GrpcCrawler — registerSchema stores schemas', () => {
  const crawler = new GrpcCrawler({ endpoint: 'localhost:50051' });
  const reqSchema = { fields: [{ fieldNumber: 1, name: 'id', type: 'int32', repeated: false }] };
  const resSchema = { fields: [{ fieldNumber: 1, name: 'name', type: 'string', repeated: false }] };

  crawler.registerSchema('myservice', 'MyMethod', resSchema, reqSchema);
  assert.ok(crawler.schemas.has('myservice/MyMethod'));
});

// ─── Integration: unary RPC against mock server ──────────────────────────────

test('integration: unary RPC with mock gRPC server', async (t) => {
  const port = 18090;
  const responseSchema = {
    fields: [
      { fieldNumber: 1, name: 'greeting', type: 'string', repeated: false },
    ],
  };
  const requestSchema = {
    fields: [
      { fieldNumber: 1, name: 'name', type: 'string', repeated: false },
    ],
  };

  const server = await createMockGrpcServer(port, async (stream, headers) => {
    await collectStream(stream);
    const responsePayload = buildTestPayload({ greeting: 'Hello, World!' }, responseSchema);
    const responseFrame = encodeGrpcFrame(responsePayload);

    stream.respond({
      ':status': 200,
      'content-type': 'application/grpc+proto',
    });
    stream.write(responseFrame);
    stream.end();
  });

  t.after(() => new Promise((resolve) => server.close(resolve)));

  const crawler = new GrpcCrawler({
    endpoint: `http://127.0.0.1:${port}`,
    retry: { maxRetries: 0 },
  });

  crawler.registerSchema('test.Greeter', 'SayHello', responseSchema, requestSchema);

  const result = await crawler.request('test.Greeter', 'SayHello', { name: 'Test' });

  assert.ok(result);
  assert.ok(result.data);
  assert.equal(result.data.greeting, 'Hello, World!');
  assert.equal(result.grpcStatus, GRPC_STATUS.OK);

  await crawler.close();
});

// ─── Integration: server-streaming RPC ────────────────────────────────────────

test('integration: server-streaming RPC with mock gRPC server', async (t) => {
  const port = 18091;
  const responseSchema = {
    fields: [
      { fieldNumber: 1, name: 'message', type: 'string', repeated: false },
    ],
  };
  const requestSchema = {
    fields: [
      { fieldNumber: 1, name: 'count', type: 'int32', repeated: false },
    ],
  };

  const server = await createMockGrpcServer(port, async (stream, headers) => {
    await collectStream(stream);
    const messages = ['msg-1', 'msg-2', 'msg-3'];
    stream.respond({
      ':status': 200,
      'content-type': 'application/grpc+proto',
    });

    for (const msg of messages) {
      const payload = buildTestPayload({ message: msg }, responseSchema);
      const frame = encodeGrpcFrame(payload);
      stream.write(frame);
    }

    stream.end();
  });

  t.after(() => new Promise((resolve) => server.close(resolve)));

  const crawler = new GrpcCrawler({
    endpoint: `http://127.0.0.1:${port}`,
    retry: { maxRetries: 0 },
  });

  crawler.registerSchema('test.Streamer', 'Stream', responseSchema, requestSchema);

  const results = await crawler.serverStream('test.Streamer', 'Stream', { count: 3 });

  assert.ok(Array.isArray(results));
  assert.equal(results.length, 3);
  assert.equal(results[0].message, 'msg-1');
  assert.equal(results[1].message, 'msg-2');
  assert.equal(results[2].message, 'msg-3');

  await crawler.close();
});

// ─── Integration: metadata propagation ────────────────────────────────────────

test('integration: metadata headers are sent with request', async (t) => {
  const port = 18093;
  let receivedHeaders = null;
  const responseSchema = {
    fields: [{ fieldNumber: 1, name: 'ok', type: 'bool', repeated: false }],
  };

  const server = await createMockGrpcServer(port, async (stream, headers) => {
    receivedHeaders = headers;
    const payload = buildTestPayload({ ok: true }, responseSchema);
    stream.respond({
      ':status': 200,
      'content-type': 'application/grpc+proto',
    });
    stream.write(encodeGrpcFrame(payload));
    stream.end();
  });

  t.after(() => new Promise((resolve) => server.close(resolve)));

  const crawler = new GrpcCrawler({
    endpoint: `http://127.0.0.1:${port}`,
    metadata: { 'x-custom-header': 'custom-value' },
    retry: { maxRetries: 0 },
  });

  crawler.registerSchema('test.Meta', 'Ping', responseSchema);

  await crawler.request('test.Meta', 'Ping', {}, {
    metadata: { 'x-per-call-header': 'call-value' },
  });

  assert.ok(receivedHeaders);
  assert.equal(receivedHeaders['x-custom-header'], 'custom-value');
  assert.equal(receivedHeaders['x-per-call-header'], 'call-value');

  await crawler.close();
});

// ─── Integration: connection refused with retry ───────────────────────────────

test('integration: connection refused is retryable', async () => {
  const crawler = new GrpcCrawler({
    endpoint: 'http://127.0.0.1:19999',
    retry: { maxRetries: 1, backoffMs: 100 },
  });

  await assert.rejects(
    () => crawler.request('test.Service', 'Method', {}),
    (err) => {
      return err.message && (err.message.includes('connect') || err.message.includes('ECONNREFUSED') || err.message.includes('retry') || err.message.includes('unavailable'));
    },
  );

  await crawler.close();
});
