/**
 * Unit tests for kasada-bypass module.
 * @module tests/reverse/kasada-bypass.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('kasada-bypass', () => {
  describe('detectKasada', () => {
    it('should export detectKasada as a function', async () => {
      const mod = await import('../../src/reverse/kasada-bypass.js');
      assert.equal(typeof mod.detectKasada, 'function');
    });

    it('should detect Kasada from x-kpsdk-ct header', async () => {
      const { detectKasada } = await import('../../src/reverse/kasada-bypass.js');
      const result = detectKasada({
        status: 403,
        headers: { 'x-kpsdk-ct': 'some-value' },
        body: '',
      });
      assert.equal(result.detected, true);
      assert.ok(result.signals.length > 0);
      assert.equal(result.name, 'kasada');
    });

    it('should detect Kasada from x-kpsdk-st header', async () => {
      const { detectKasada } = await import('../../src/reverse/kasada-bypass.js');
      const result = detectKasada({
        status: 403,
        headers: { 'x-kpsdk-st': 'some-value' },
        body: '',
      });
      assert.equal(result.detected, true);
      assert.ok(result.signals.length > 0);
    });

    it('should detect Kasada from x-kpsdk-cd header', async () => {
      const { detectKasada } = await import('../../src/reverse/kasada-bypass.js');
      const result = detectKasada({
        status: 403,
        headers: { 'x-kpsdk-cd': 'some-value' },
        body: '',
      });
      assert.equal(result.detected, true);
    });

    it('should detect Kasada from body containing kpsdk references', async () => {
      const { detectKasada } = await import('../../src/reverse/kasada-bypass.js');
      const result = detectKasada({
        status: 403,
        headers: {},
        body: '<script>Kpsdk.solve()</script>',
      });
      assert.equal(result.detected, true);
      assert.ok(result.signals.some(s => s.includes('kasada')));
    });

    it('should detect Kasada from body containing cdn.stitial.com', async () => {
      const { detectKasada } = await import('../../src/reverse/kasada-bypass.js');
      const result = detectKasada({
        status: 403,
        headers: {},
        body: '<script src="https://cdn.stitial.com/xxx"></script>',
      });
      assert.equal(result.detected, true);
    });

    it('should not detect Kasada on a normal response', async () => {
      const { detectKasada } = await import('../../src/reverse/kasada-bypass.js');
      const result = detectKasada({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><body>Hello</body></html>',
      });
      assert.equal(result.detected, false);
      assert.equal(result.signals.length, 0);
    });

    it('should return an object with detected, signals, and name properties', async () => {
      const { detectKasada } = await import('../../src/reverse/kasada-bypass.js');
      const result = detectKasada({ headers: {}, body: '' });
      assert.ok('detected' in result);
      assert.ok('signals' in result);
      assert.ok('name' in result);
      assert.ok(Array.isArray(result.signals));
    });
  });

  describe('extractKasadaChallenge', () => {
    it('should export extractKasadaChallenge as a function', async () => {
      const mod = await import('../../src/reverse/kasada-bypass.js');
      assert.equal(typeof mod.extractKasadaChallenge, 'function');
    });

    it('should return an object with scriptUrl, payload, stValue', async () => {
      const { extractKasadaChallenge } = await import('../../src/reverse/kasada-bypass.js');
      const result = extractKasadaChallenge('<html></html>');
      assert.ok('scriptUrl' in result);
      assert.ok('payload' in result);
      assert.ok('stValue' in result);
    });

    it('should return null values when no challenge is found', async () => {
      const { extractKasadaChallenge } = await import('../../src/reverse/kasada-bypass.js');
      const result = extractKasadaChallenge('<html><body>no challenge here</body></html>');
      assert.equal(result.scriptUrl, null);
      assert.equal(result.payload, null);
      assert.equal(result.stValue, null);
    });
  });

  describe('getKasadaBypassConfig', () => {
    it('should export getKasadaBypassConfig as a function', async () => {
      const mod = await import('../../src/reverse/kasada-bypass.js');
      assert.equal(typeof mod.getKasadaBypassConfig, 'function');
    });

    it('should return a config object with requiresBrowser, headers, evasionScript, notes', async () => {
      const { getKasadaBypassConfig } = await import('../../src/reverse/kasada-bypass.js');
      const result = getKasadaBypassConfig({
        status: 403,
        headers: { 'x-kpsdk-ct': 'value' },
        body: '',
      });
      assert.ok('requiresBrowser' in result);
      assert.ok('headers' in result);
      assert.ok('evasionScript' in result);
      assert.ok('notes' in result);
      assert.equal(result.requiresBrowser, true);
      assert.ok(Array.isArray(result.notes));
    });
  });

  describe('solveKasadaChallenge', () => {
    it('should export solveKasadaChallenge as a function', async () => {
      const mod = await import('../../src/reverse/kasada-bypass.js');
      assert.equal(typeof mod.solveKasadaChallenge, 'function');
    });
  });
});
