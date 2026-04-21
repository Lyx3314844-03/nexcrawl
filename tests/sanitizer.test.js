import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitize, sanitizeString, sanitizeHeaders, sanitizeUrl } from '../src/utils/sanitizer.js';

describe('Sanitizer', () => {
  it('should redact sensitive object fields', () => {
    const obj = {
      username: 'user',
      password: 'secret123',
      apiKey: 'abc123',
      data: { token: 'xyz789' },
    };

    const result = sanitize(obj);

    assert.strictEqual(result.username, 'user');
    assert.strictEqual(result.password, '***REDACTED***');
    assert.strictEqual(result.apiKey, '***REDACTED***');
    assert.strictEqual(result.data.token, '***REDACTED***');
  });

  it('should handle arrays', () => {
    const arr = [
      { password: 'secret1' },
      { password: 'secret2' },
    ];

    const result = sanitize(arr);

    assert.strictEqual(result[0].password, '***REDACTED***');
    assert.strictEqual(result[1].password, '***REDACTED***');
  });

  it('should sanitize strings with sensitive patterns', () => {
    const str = 'Authorization: Bearer abc123 and password=secret';
    const result = sanitizeString(str);

    assert.ok(result.includes('Bearer ***REDACTED***'));
    assert.ok(result.includes('password=***REDACTED***'));
  });

  it('should sanitize HTTP headers', () => {
    const headers = {
      'content-type': 'application/json',
      'authorization': 'Bearer token123',
      'cookie': 'session=abc',
    };

    const result = sanitizeHeaders(headers);

    assert.strictEqual(result['content-type'], 'application/json');
    assert.strictEqual(result.authorization, '***REDACTED***');
    assert.strictEqual(result.cookie, '***REDACTED***');
  });

  it('should sanitize URLs with sensitive params', () => {
    const url = 'https://api.example.com/data?token=abc123&page=1';
    const result = sanitizeUrl(url);

    assert.ok(result.includes('token=***REDACTED***'));
    assert.ok(result.includes('page=1'));
  });

  it('should handle max depth', () => {
    const deep = { a: { b: { c: { d: { e: 'value' } } } } };
    const result = sanitize(deep, 3);

    assert.strictEqual(result.a.b.c, '[Max Depth Reached]');
  });
});
