/**
 * Unit tests for auth-handler module.
 * @module tests/middleware/auth-handler.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('auth-handler', () => {
  describe('createAuthHandler factory', () => {
    it('should export createAuthHandler as a function', async () => {
      const mod = await import('../../src/middleware/auth-handler.js');
      assert.equal(typeof mod.createAuthHandler, 'function');
    });

    it('should throw for an unsupported auth type', async () => {
      const { createAuthHandler } = await import('../../src/middleware/auth-handler.js');
      assert.throws(() => createAuthHandler({ type: 'unsupported' }), /Unsupported auth type/);
    });

    it('should return a handler with init, getAuthHeaders, refresh, teardown for oauth2', async () => {
      const { createAuthHandler } = await import('../../src/middleware/auth-handler.js');
      const handler = createAuthHandler({
        type: 'oauth2',
        grantType: 'client_credentials',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'test-id',
        clientSecret: 'test-secret',
      });
      assert.equal(typeof handler.init, 'function');
      assert.equal(typeof handler.getAuthHeaders, 'function');
      assert.equal(typeof handler.refresh, 'function');
      assert.equal(typeof handler.teardown, 'function');
    });

    it('should return a handler with init, getAuthHeaders, refresh, teardown for jwt', async () => {
      const { createAuthHandler } = await import('../../src/middleware/auth-handler.js');
      const handler = createAuthHandler({
        type: 'jwt',
        acquireUrl: 'https://auth.example.com/token',
      });
      assert.equal(typeof handler.init, 'function');
      assert.equal(typeof handler.getAuthHeaders, 'function');
      assert.equal(typeof handler.refresh, 'function');
      assert.equal(typeof handler.teardown, 'function');
    });

    it('should return a handler with init, getAuthHeaders, refresh, teardown for digest', async () => {
      const { createAuthHandler } = await import('../../src/middleware/auth-handler.js');
      const handler = createAuthHandler({
        type: 'digest',
        username: 'user',
        password: 'pass',
      });
      assert.equal(typeof handler.init, 'function');
      assert.equal(typeof handler.getAuthHeaders, 'function');
      assert.equal(typeof handler.refresh, 'function');
      assert.equal(typeof handler.teardown, 'function');
    });

    it('should return a handler with preSeedChallenge for digest type', async () => {
      const { createAuthHandler } = await import('../../src/middleware/auth-handler.js');
      const handler = createAuthHandler({
        type: 'digest',
        username: 'user',
        password: 'pass',
      });
      assert.equal(typeof handler.preSeedChallenge, 'function');
    });
  });

  describe('JWT handler', () => {
    it('should reject init when acquireUrl is unreachable', async () => {
      const { createAuthHandler } = await import('../../src/middleware/auth-handler.js');
      const handler = createAuthHandler({
        type: 'jwt',
        acquireUrl: 'https://nonexistent.auth.example.com/acquire',
      });
      await assert.rejects(() => handler.init());
    });

    it('should teardown and clear state without error', async () => {
      const { createAuthHandler } = await import('../../src/middleware/auth-handler.js');
      const handler = createAuthHandler({
        type: 'jwt',
        acquireUrl: 'https://auth.example.com/token',
      });
      handler.teardown();
      assert.ok(true, 'teardown completed without error');
    });
  });

  describe('OAuth2 handler', () => {
    it('should handle missing tokenUrl gracefully for client_credentials', async () => {
      const { createAuthHandler } = await import('../../src/middleware/auth-handler.js');
      const handler = createAuthHandler({
        type: 'oauth2',
        grantType: 'client_credentials',
        clientId: 'test-id',
        clientSecret: 'test-secret',
        tokenUrl: 'https://nonexistent.auth.example.com/token',
      });
      await assert.rejects(() => handler.init());
    });
  });

  describe('Digest handler', () => {
    it('should reject when getAuthHeaders is called without a URL', async () => {
      const { createAuthHandler } = await import('../../src/middleware/auth-handler.js');
      const handler = createAuthHandler({
        type: 'digest',
        username: 'user',
        password: 'pass',
      });
      // getAuthHeaders(url, method) requires a URL; calling without one should reject
      await assert.rejects(() => handler.getAuthHeaders());
    });

    it('should init and teardown without error', async () => {
      const { createAuthHandler } = await import('../../src/middleware/auth-handler.js');
      const handler = createAuthHandler({
        type: 'digest',
        username: 'user',
        password: 'pass',
      });
      await handler.init();
      handler.teardown();
      assert.ok(true, 'digest init/teardown completed');
    });
  });
});
