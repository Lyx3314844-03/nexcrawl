import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRetryDelayMs, parseRetryAfterMs } from '../src/runtime/retry-policy.js';

test('parseRetryAfterMs handles seconds and http-date values', () => {
  assert.equal(parseRetryAfterMs('3'), 3000);

  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const delay = parseRetryAfterMs('Thu, 01 Jan 2026 00:00:02 GMT', now);
  assert.equal(delay, 2000);
});

test('computeRetryDelayMs supports exponential backoff and retry-after headers', () => {
  const exponentialDelay = computeRetryDelayMs({
    attempt: 3,
    retry: {
      backoffMs: 100,
      strategy: 'exponential',
      maxBackoffMs: 1000,
      jitterRatio: 0,
    },
  });
  assert.equal(exponentialDelay, 400);

  const retryAfterDelay = computeRetryDelayMs({
    attempt: 1,
    response: {
      headers: {
        'retry-after': '2',
      },
    },
    retry: {
      backoffMs: 200,
      strategy: 'fixed',
      respectRetryAfter: true,
      jitterRatio: 0,
    },
  });
  assert.equal(retryAfterDelay, 2000);
});
