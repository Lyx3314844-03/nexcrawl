/**
 * Unit tests for shadow-dom-extractor module.
 * @module tests/extractors/shadow-dom-extractor.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Create a mock Playwright-style page with all methods needed by
 * extractShadowDom, extractIframes, and deepExtract.
 */
function createMockPage(overrides = {}) {
  return {
    evaluate: async (fn) => [],
    $$: async () => [],
    $: async () => null,
    $eval: async () => [],
    $$eval: async () => [],
    context: () => ({
      createCDPSession: async () => ({ send: async () => ({}) }),
    }),
    frames: () => [],
    ...overrides,
  };
}

describe('shadow-dom-extractor', () => {
  describe('module exports', () => {
    it('should export extractShadowDom as an async function', async () => {
      const mod = await import('../../src/extractors/shadow-dom-extractor.js');
      assert.equal(typeof mod.extractShadowDom, 'function');
    });

    it('should export extractClosedShadowRoots as an async function', async () => {
      const mod = await import('../../src/extractors/shadow-dom-extractor.js');
      assert.equal(typeof mod.extractClosedShadowRoots, 'function');
    });

    it('should export extractIframes as an async function', async () => {
      const mod = await import('../../src/extractors/shadow-dom-extractor.js');
      assert.equal(typeof mod.extractIframes, 'function');
    });

    it('should export deepExtract as an async function', async () => {
      const mod = await import('../../src/extractors/shadow-dom-extractor.js');
      assert.equal(typeof mod.deepExtract, 'function');
    });
  });

  describe('extractShadowDom', () => {
    it('should return an array when called with a mock page', async () => {
      const { extractShadowDom } = await import('../../src/extractors/shadow-dom-extractor.js');
      const result = await extractShadowDom(createMockPage());
      assert.ok(Array.isArray(result));
    });

    it('should accept options including selector, includeClosed, maxDepth, extractFields', async () => {
      const { extractShadowDom } = await import('../../src/extractors/shadow-dom-extractor.js');
      const result = await extractShadowDom(createMockPage(), {
        selector: 'my-widget',
        includeClosed: false,
        maxDepth: 3,
        extractFields: ['text', 'html'],
      });
      assert.ok(Array.isArray(result));
    });
  });

  describe('extractIframes', () => {
    it('should return an array when called with a mock page', async () => {
      const { extractIframes } = await import('../../src/extractors/shadow-dom-extractor.js');
      const result = await extractIframes(createMockPage());
      assert.ok(Array.isArray(result));
    });

    it('should accept selector and extractFields options', async () => {
      const { extractIframes } = await import('../../src/extractors/shadow-dom-extractor.js');
      const result = await extractIframes(createMockPage(), {
        selector: 'iframe.ad-frame',
        extractFields: ['html', 'src'],
      });
      assert.ok(Array.isArray(result));
    });
  });

  describe('deepExtract', () => {
    it('should return an object with shadowDom and iframes arrays', async () => {
      const { deepExtract } = await import('../../src/extractors/shadow-dom-extractor.js');
      const result = await deepExtract(createMockPage());
      assert.ok(result !== null && typeof result === 'object');
      assert.ok('shadowDom' in result);
      assert.ok('iframes' in result);
      assert.ok(Array.isArray(result.shadowDom));
      assert.ok(Array.isArray(result.iframes));
    });
  });
});
