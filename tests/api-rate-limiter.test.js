import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RateLimiter } from '../src/middleware/rate-limiter.js';

describe('RateLimiter Middleware', () => {
  it('should allow requests within limit', async () => {
    const limiter = new RateLimiter({ max: 5, refillRate: 100 });
    const middleware = limiter.middleware();

    let callCount = 0;
    const req = { ip: '127.0.0.1' };
    const res = {
      status: () => ({ json: () => {} }),
      set: () => {},
    };
    const next = () => callCount++;

    for (let i = 0; i < 5; i++) {
      await middleware(req, res, next);
    }

    assert.strictEqual(callCount, 5);
  });

  it('should block requests exceeding limit', async () => {
    const limiter = new RateLimiter({ max: 3, refillRate: 100 });
    const middleware = limiter.middleware();

    let blocked = false;
    const req = { ip: '127.0.0.1' };
    const res = {
      status: (code) => {
        if (code === 429) blocked = true;
        return { json: () => {} };
      },
      set: () => {},
    };
    const next = () => {};

    for (let i = 0; i < 5; i++) {
      await middleware(req, res, next);
    }

    assert.strictEqual(blocked, true);
  });

  it('should reset after tokens refill', async () => {
    const limiter = new RateLimiter({ max: 2, refillRate: 100 });
    const middleware = limiter.middleware();

    const req = { ip: '127.0.0.1' };
    const res = {
      status: () => ({ json: () => {} }),
      set: () => {},
    };
    let callCount = 0;
    const next = () => callCount++;

    await middleware(req, res, next);
    await middleware(req, res, next);

    // Wait for token refill (at 100 tokens/sec, 1 token refills in 10ms)
    await new Promise(resolve => setTimeout(resolve, 50));

    await middleware(req, res, next);
    assert.strictEqual(callCount, 3);
  });

  it('should handle different IPs independently', async () => {
    const limiter = new RateLimiter({ max: 2, refillRate: 100 });
    const middleware = limiter.middleware();

    let callCount = 0;
    const res = {
      status: () => ({ json: () => {} }),
      set: () => {},
    };
    const next = () => callCount++;

    await middleware({ ip: '127.0.0.1' }, res, next);
    await middleware({ ip: '127.0.0.1' }, res, next);
    await middleware({ ip: '192.168.1.1' }, res, next);
    await middleware({ ip: '192.168.1.1' }, res, next);

    assert.strictEqual(callCount, 4);
  });
});
