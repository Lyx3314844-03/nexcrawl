/**
 * Unit tests for search-engine-fetcher module.
 * @module tests/fetchers/search-engine-fetcher.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('search-engine-fetcher', () => {
  describe('module exports', () => {
    it('should export fetchSearchResults as an async function', async () => {
      const mod = await import('../../src/fetchers/search-engine-fetcher.js');
      assert.equal(typeof mod.fetchSearchResults, 'function');
    });
  });

  describe('fetchSearchResults', () => {
    it('should reject with an error for an unsupported engine', async () => {
      const { fetchSearchResults } = await import('../../src/fetchers/search-engine-fetcher.js');
      await assert.rejects(
        () => fetchSearchResults({ engine: 'altavista', query: 'test' })
      );
    });

    it('should reject when query is missing', async () => {
      const { fetchSearchResults } = await import('../../src/fetchers/search-engine-fetcher.js');
      await assert.rejects(
        () => fetchSearchResults({ engine: 'google' })
      );
    });

    it('should reject when engine is missing', async () => {
      const { fetchSearchResults } = await import('../../src/fetchers/search-engine-fetcher.js');
      await assert.rejects(
        () => fetchSearchResults({ query: 'test' })
      );
    });

    it('should accept valid engine names (google, bing, duckduckgo, baidu)', async () => {
      const { fetchSearchResults } = await import('../../src/fetchers/search-engine-fetcher.js');
      // These will fail at runtime because there's no real search engine to hit,
      // but we verify the validation layer accepts them
      const engines = ['google', 'bing', 'duckduckgo', 'baidu'];
      for (const engine of engines) {
        // Each call will fail at network level, not validation
        try {
          await fetchSearchResults({ engine, query: 'test', maxPages: 1 });
        } catch (err) {
          // Should be a network/runtime error, not a validation error about engine
          assert.ok(!err.message.includes('Unsupported') && !err.message.includes('engine is required'),
            `${engine} should be accepted: ${err.message}`);
        }
      }
    });

    it('should accept optional parameters (maxPages, language, region, proxy, headers)', async () => {
      const { fetchSearchResults } = await import('../../src/fetchers/search-engine-fetcher.js');
      // Just verify the function accepts the config shape without validation errors
      try {
        await fetchSearchResults({
          engine: 'google',
          query: 'web scraping',
          maxPages: 2,
          language: 'en',
          region: 'us',
          proxy: { url: 'http://proxy:8080' },
          headers: { 'User-Agent': 'test' },
        });
      } catch (err) {
        // Network error is expected, not validation error
        assert.ok(!err.message.includes('required'));
      }
    });
  });
});
