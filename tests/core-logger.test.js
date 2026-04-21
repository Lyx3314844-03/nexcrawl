import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/core/logger.js';

test('createLogger accepts string names without spreading characters into fields', async () => {
  const originalWrite = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    const logger = createLogger('reverse-lab');
    logger.info('hello', { requestId: 'req-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.stdout.write = originalWrite;
  }

  const payload = JSON.parse(chunks.find((entry) => entry.includes('"message":"hello"')) ?? '{}');
  assert.equal(payload.component, 'reverse-lab');
  assert.equal(payload.requestId, 'req-1');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, '0'), false);
});

test('createLogger redacts sensitive fields in fallback output', () => {
  const originalWrite = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    const logger = createLogger({ component: 'security' });
    logger.info('issuing token Bearer secret-token', {
      authorization: 'Bearer secret-token',
      nested: { password: 'super-secret' },
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const payload = JSON.parse(chunks.find((entry) => entry.includes('"component":"security"')) ?? '{}');
  assert.equal(payload.authorization, '***REDACTED***');
  assert.equal(payload.nested.password, '***REDACTED***');
  assert.match(payload.message, /\*\*\*REDACTED\*\*\*/);
});

test('createLogger reuses shared pino roots without growing exit listeners in test mode', async () => {
  const before = process.listenerCount('exit');

  for (let index = 0; index < 20; index += 1) {
    const logger = createLogger({ component: `logger-${index}` });
    logger.info('warmup');
  }

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(process.listenerCount('exit'), before);
});
