import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DomainRateLimiter } from '../src/runtime/rate-limiter.js';

describe('DomainRateLimiter', () => {
  it('should initialize with default config', () => {
    const limiter = new DomainRateLimiter();
    assert.ok(limiter);
  });

  it('should enforce rate limit', async () => {
    const limiter = new DomainRateLimiter({
      requestsPerSecond: 10,
      burstSize: 1,
    });

    const start = Date.now();
    await limiter.waitForTurn('example.com');
    await limiter.waitForTurn('example.com');
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 90, `Expected delay >= 90ms, got ${elapsed}ms`);
  });

  it('should handle different domains independently', async () => {
    const limiter = new DomainRateLimiter({ requestsPerSecond: 5 });

    const start = Date.now();
    await Promise.all([
      limiter.waitForTurn('example.com'),
      limiter.waitForTurn('other.com'),
    ]);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 100, 'Different domains should not block each other');
  });

  it('should respect domain overrides', async () => {
    const limiter = new DomainRateLimiter({
      requestsPerSecond: 10,
      domainOverrides: new Map([['slow.com', 1]]),
    });

    const start = Date.now();
    await limiter.waitForTurn('slow.com');
    await limiter.waitForTurn('slow.com');
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 900, `Expected delay >= 900ms for slow domain, got ${elapsed}ms`);
  });

  it('should allow burst requests', async () => {
    const limiter = new DomainRateLimiter({
      requestsPerSecond: 2,
      burstSize: 5,
    });

    const start = Date.now();
    await Promise.all([
      limiter.waitForTurn('example.com'),
      limiter.waitForTurn('example.com'),
      limiter.waitForTurn('example.com'),
    ]);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 200, 'Burst requests should not be delayed');
  });
});
