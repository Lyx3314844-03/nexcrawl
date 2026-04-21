import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateUrl, validateCode, validateNumber, sanitizeHtml, RateLimiter } from '../../src/utils/validation.js';
import { ValidationError } from '../../src/errors.js';

describe('Validation', () => {
  describe('validateUrl', () => {
    it('should accept valid URLs', () => {
      const url = validateUrl('https://example.com');
      assert.strictEqual(url, 'https://example.com/');
    });

    it('should reject invalid protocols', () => {
      assert.throws(() => validateUrl('file:///etc/passwd'), ValidationError);
    });

    it('should reject private IPs by default', () => {
      assert.throws(() => validateUrl('http://127.0.0.1'), ValidationError);
      assert.throws(() => validateUrl('http://192.168.1.1'), ValidationError);
    });
  });

  describe('validateCode', () => {
    it('should accept safe code', () => {
      const code = validateCode('const x = 1 + 1;');
      assert.ok(code);
    });

    it('should reject dangerous patterns', () => {
      assert.throws(() => validateCode('require("child_process")'), ValidationError);
      assert.throws(() => validateCode('eval("code")'), ValidationError);
    });

    it('should enforce max length', () => {
      const longCode = 'x'.repeat(2000);
      assert.throws(() => validateCode(longCode, { maxLength: 1000 }), ValidationError);
    });
  });

  describe('validateNumber', () => {
    it('should validate numbers', () => {
      assert.strictEqual(validateNumber(5), 5);
      assert.strictEqual(validateNumber('10'), 10);
    });

    it('should enforce min/max', () => {
      assert.throws(() => validateNumber(5, { min: 10 }), ValidationError);
      assert.throws(() => validateNumber(15, { max: 10 }), ValidationError);
    });

    it('should enforce integer', () => {
      assert.throws(() => validateNumber(1.5, { integer: true }), ValidationError);
    });
  });

  describe('sanitizeHtml', () => {
    it('should escape HTML', () => {
      const result = sanitizeHtml('<script>alert("xss")</script>');
      assert.ok(!result.includes('<script>'));
      assert.ok(result.includes('&lt;'));
    });
  });
});

describe('RateLimiter', () => {
  it('should allow requests within limit', () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
    
    limiter.check('user1');
    limiter.check('user1');
    const result = limiter.check('user1');
    
    assert.strictEqual(result.remaining, 0);
  });

  it('should reject requests over limit', () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
    
    limiter.check('user1');
    limiter.check('user1');
    
    assert.throws(() => limiter.check('user1'), ValidationError);
  });

  it('should reset per key', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
    
    limiter.check('user1');
    limiter.reset('user1');
    
    const result = limiter.check('user1');
    assert.strictEqual(result.remaining, 0);
  });
});
