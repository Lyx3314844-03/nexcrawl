/**
 * Tests for Token Bucket RateLimiter (middleware) — Phase 1.6
 *
 * Covers:
 *   - Token bucket algorithm correctness
 *   - Burst capacity / refill rate
 *   - Rate limit enforcement (429 response)
 *   - Preset configurations (apiLimiter)
 *   - Redis fallback behavior
 *   - Header generation (X-RateLimit-*)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/middleware/rate-limiter.js';

describe('RateLimiter — Token Bucket Algorithm', () => {
  let limiter;

  beforeEach(() => {
    limiter = new RateLimiter({ max: 5, refillRate: 1 }); // 5 burst, 1 token/sec
  });

  it('should allow requests within bucket capacity', () => {
    const req = { ip: '127.0.0.1' };
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    const next = () => {};

    for (let i = 0; i < 5; i++) {
      limiter.middleware(req, res, next);
      assert.equal(res.statusCode, 200, `Request ${i + 1} should succeed`);
    }
  });

  it('should reject requests exceeding bucket capacity with 429', () => {
    const req = { ip: '127.0.0.1' };
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };

    // Consume all 5 tokens
    for (let i = 0; i < 5; i++) {
      limiter.middleware(req, res, () => {});
    }

    // 6th request should fail
    const rejectRes = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    limiter.middleware(req, rejectRes, () => {});
    assert.equal(rejectRes.statusCode, 429, '6th request should be rate limited');
  });

  it('should set X-RateLimit headers on successful requests', () => {
    const req = { ip: '10.0.0.1' };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
    limiter.middleware(req, res, () => {});

    assert.ok(res.headers['X-RateLimit-Limit'], 'Should set limit header');
    assert.ok(res.headers['X-RateLimit-Remaining'], 'Should set remaining header');
    assert.equal(res.headers['X-RateLimit-Limit'], 5);
  });

  it('should set Retry-After header on 429 responses', () => {
    const req = { ip: '10.0.0.2' };
    // Exhaust tokens
    for (let i = 0; i < 5; i++) {
      limiter.middleware(req, { setHeader() {} }, () => {});
    }
    const rejectRes = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    limiter.middleware(req, rejectRes, () => {});

    assert.ok(rejectRes.headers['Retry-After'], 'Should set Retry-After header');
    assert.ok(Number(rejectRes.headers['Retry-After']) > 0, 'Retry-After should be positive');
  });

  it('should refill tokens over time', async () => {
    const req = { ip: '192.168.1.1' };
    // Exhaust all tokens
    for (let i = 0; i < 5; i++) {
      limiter.middleware(req, { setHeader() {} }, () => {});
    }

    // Wait 1.1 seconds for 1 token refill
    await new Promise(r => setTimeout(r, 1100));

    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    limiter.middleware(req, res, () => {});
    assert.equal(res.statusCode, 200, 'Should allow after refill');
  });

  it('should isolate buckets per IP', () => {
    const req1 = { ip: '1.1.1.1' };
    const req2 = { ip: '2.2.2.2' };

    // Exhaust tokens for IP1
    for (let i = 0; i < 5; i++) {
      limiter.middleware(req1, { setHeader() {} }, () => {});
    }

    const rejectRes = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    limiter.middleware(req1, rejectRes, () => {});
    assert.equal(rejectRes.statusCode, 429, 'IP1 should be limited');

    // IP2 should still work
    const okRes = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    limiter.middleware(req2, okRes, () => {});
    assert.equal(okRes.statusCode, 200, 'IP2 should not be limited');
  });

  it('should use custom key extractor when provided', () => {
    const customLimiter = new RateLimiter({
      max: 2,
      refillRate: 1,
      keyExtractor: (req) => req.headers?.['x-api-key'] ?? req.ip,
    });

    const req1 = { ip: '1.1.1.1', headers: { 'x-api-key': 'key-A' } };
    const req2 = { ip: '1.1.1.1', headers: { 'x-api-key': 'key-B' } };

    // Exhaust for key-A
    customLimiter.middleware(req1, { setHeader() {} }, () => {});
    customLimiter.middleware(req1, { setHeader() {} }, () => {});

    const rejectRes = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    customLimiter.middleware(req1, rejectRes, () => {});
    assert.equal(rejectRes.statusCode, 429, 'key-A should be limited');

    // key-B should still work (different bucket)
    const okRes = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    customLimiter.middleware(req2, okRes, () => {});
    assert.equal(okRes.statusCode, 200, 'key-B should not be limited');
  });
});

describe('RateLimiter — Presets', () => {
  it('apiLimiter should use reduced burst (max=5)', () => {
    const preset = RateLimiter.apiLimiter;
    assert.ok(preset instanceof RateLimiter, 'apiLimiter should be a RateLimiter instance');
    assert.equal(preset.max, 5, 'apiLimiter max should be 5 (reduced burst)');
  });
});

describe('RateLimiter — Redis Fallback', () => {
  it('should fall back to in-memory when Redis is unavailable', async () => {
    const redisLimiter = new RateLimiter({
      max: 3,
      refillRate: 1,
      redis: { host: 'nonexistent-host', port: 6379, connectTimeout: 500 },
    });

    // Give it a moment to try connecting
    await new Promise(r => setTimeout(r, 100));

    const req = { ip: '3.3.3.3' };
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    redisLimiter.middleware(req, res, () => {});
    assert.equal(res.statusCode, 200, 'Should work with in-memory fallback');
  });
});

describe('RateLimiter — Edge Cases', () => {
  it('should handle requests with no IP gracefully', () => {
    const limiter = new RateLimiter({ max: 5, refillRate: 1 });
    const req = {};
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    limiter.middleware(req, res, () => {});
    assert.equal(res.statusCode, 200, 'Should work even without IP');
  });

  it('should handle zero refill rate', () => {
    const limiter = new RateLimiter({ max: 2, refillRate: 0 });
    const req = { ip: '4.4.4.4' };

    // Use all tokens
    limiter.middleware(req, { setHeader() {} }, () => {});
    limiter.middleware(req, { setHeader() {} }, () => {});

    // 3rd should fail and never refill
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; } };
    limiter.middleware(req, res, () => {});
    assert.equal(res.statusCode, 429, 'Should be limited with zero refill');
  });
});
