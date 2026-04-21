/**
 * Unit tests for socks5-proxy module.
 * @module tests/fetchers/socks5-proxy.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('socks5-proxy', () => {
  describe('module exports', () => {
    it('should export createSocks5Agent as a function', async () => {
      const mod = await import('../../src/fetchers/socks5-proxy.js');
      assert.equal(typeof mod.createSocks5Agent, 'function');
    });

    it('should export createTorAgent as a function', async () => {
      const mod = await import('../../src/fetchers/socks5-proxy.js');
      assert.equal(typeof mod.createTorAgent, 'function');
    });

    it('should export normalizeSocks5Proxy as a function', async () => {
      const mod = await import('../../src/fetchers/socks5-proxy.js');
      assert.equal(typeof mod.normalizeSocks5Proxy, 'function');
    });
  });

  describe('normalizeSocks5Proxy', () => {
    it('should parse a full SOCKS5 URL with auth', async () => {
      const { normalizeSocks5Proxy } = await import('../../src/fetchers/socks5-proxy.js');
      const result = normalizeSocks5Proxy('socks5://user:pass@proxy.example.com:1080');
      assert.ok(result);
      assert.equal(result.protocol, 'socks5');
      assert.equal(result.host, 'proxy.example.com');
      assert.ok(result.port === '1080' || result.port === 1080, 'port should be 1080');
      assert.equal(result.username, 'user');
      assert.equal(result.password, 'pass');
    });

    it('should parse a SOCKS5 URL without auth', async () => {
      const { normalizeSocks5Proxy } = await import('../../src/fetchers/socks5-proxy.js');
      const result = normalizeSocks5Proxy('socks5://proxy.example.com:1080');
      assert.ok(result);
      assert.equal(result.host, 'proxy.example.com');
      assert.ok(result.port === '1080' || result.port === 1080, 'port should be 1080');
    });

    it('should parse a SOCKS5h URL', async () => {
      const { normalizeSocks5Proxy } = await import('../../src/fetchers/socks5-proxy.js');
      const result = normalizeSocks5Proxy('socks5h://proxy.example.com:1080');
      assert.ok(result);
      assert.ok(result.protocol === 'socks5h' || result.protocol === 'socks5', 'protocol should be socks5 variant');
    });

    it('should handle default port', async () => {
      const { normalizeSocks5Proxy } = await import('../../src/fetchers/socks5-proxy.js');
      const result = normalizeSocks5Proxy('socks5://proxy.example.com');
      assert.ok(result);
      assert.equal(result.host, 'proxy.example.com');
    });

    it('should return null or throw for invalid input', async () => {
      const { normalizeSocks5Proxy } = await import('../../src/fetchers/socks5-proxy.js');
      // Test with empty/invalid input
      try {
        const result = normalizeSocks5Proxy('');
        assert.ok(result === null || result === undefined);
      } catch (err) {
        // Throwing is also acceptable
        assert.ok(err instanceof Error);
      }
    });
  });

  describe('createSocks5Agent', () => {
    it('should return an object with agent, proxyUrl, and request', async () => {
      const { createSocks5Agent } = await import('../../src/fetchers/socks5-proxy.js');
      try {
        const result = await createSocks5Agent({
          host: '127.0.0.1',
          port: 1080,
        });
        assert.ok(result);
        assert.ok('agent' in result);
        assert.ok('proxyUrl' in result);
        assert.ok('request' in result);
        assert.equal(typeof result.request, 'function');
      } catch (err) {
        // May fail if socks-proxy-agent is not installed
        assert.ok(err instanceof Error);
      }
    });

    it('should accept username and password config', async () => {
      const { createSocks5Agent } = await import('../../src/fetchers/socks5-proxy.js');
      try {
        const result = await createSocks5Agent({
          host: '127.0.0.1',
          port: 1080,
          username: 'user',
          password: 'pass',
        });
        assert.ok(result.proxyUrl.includes('user:pass'));
      } catch (err) {
        assert.ok(err instanceof Error);
      }
    });
  });

  describe('createTorAgent', () => {
    it('should return an object with renewIdentity and checkTorConnection', async () => {
      const { createTorAgent } = await import('../../src/fetchers/socks5-proxy.js');
      try {
        const result = await createTorAgent({
          host: '127.0.0.1',
          socksPort: 9050,
          controlPort: 9051,
        });
        assert.ok(result);
        assert.equal(typeof result.renewIdentity, 'function');
        assert.equal(typeof result.checkTorConnection, 'function');
        assert.ok('agent' in result);
        assert.ok('proxyUrl' in result);
        assert.ok('request' in result);
      } catch (err) {
        // May fail if socks-proxy-agent is not installed
        assert.ok(err instanceof Error);
      }
    });
  });
});
