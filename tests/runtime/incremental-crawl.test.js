/**
 * Unit tests for incremental-crawl module.
 * @module tests/runtime/incremental-crawl.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('incremental-crawl', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omnicrawl-incr-'));
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('module exports', () => {
    it('should export createIncrementalTracker as an async function', async () => {
      const mod = await import('../../src/runtime/incremental-crawl.js');
      assert.equal(typeof mod.createIncrementalTracker, 'function');
    });
  });

  describe('createIncrementalTracker', () => {
    it('should return a tracker with filterChanged, record, getHistory, reset methods', async () => {
      const { createIncrementalTracker } = await import('../../src/runtime/incremental-crawl.js');
      const tracker = await createIncrementalTracker({
        storagePath: join(tmpDir, 'incr.json'),
      });
      assert.equal(typeof tracker.filterChanged, 'function');
      assert.equal(typeof tracker.record, 'function');
      assert.equal(typeof tracker.getHistory, 'function');
      assert.equal(typeof tracker.reset, 'function');
    });

    it('should detect a new URL as changed', async () => {
      const { createIncrementalTracker } = await import('../../src/runtime/incremental-crawl.js');
      const tracker = await createIncrementalTracker({
        storagePath: join(tmpDir, 'incr.json'),
      });
      const result = await tracker.filterChanged('https://example.com/page1', '<html>content</html>');
      assert.equal(result.changed, true);
      assert.ok(result.reason);
    });

    it('should record a URL and then detect it as unchanged', async () => {
      const { createIncrementalTracker } = await import('../../src/runtime/incremental-crawl.js');
      const tracker = await createIncrementalTracker({
        storagePath: join(tmpDir, 'incr.json'),
      });
      const url = 'https://example.com/page2';
      const body = '<html>unchanged content</html>';
      // First visit: should be changed
      const first = await tracker.filterChanged(url, body);
      assert.equal(first.changed, true);
      // Record the URL
      await tracker.record(url, body);
      // Second visit with same content: should not be changed
      const second = await tracker.filterChanged(url, body);
      assert.equal(second.changed, false);
    });

    it('should detect changed content after initial record', async () => {
      const { createIncrementalTracker } = await import('../../src/runtime/incremental-crawl.js');
      const tracker = await createIncrementalTracker({
        storagePath: join(tmpDir, 'incr.json'),
      });
      const url = 'https://example.com/page3';
      // Record original content
      await tracker.record(url, '<html>original</html>');
      // Visit with changed content
      const result = await tracker.filterChanged(url, '<html>modified content</html>');
      assert.equal(result.changed, true);
    });

    it('should return null history for unrecorded URLs', async () => {
      const { createIncrementalTracker } = await import('../../src/runtime/incremental-crawl.js');
      const tracker = await createIncrementalTracker({
        storagePath: join(tmpDir, 'incr.json'),
      });
      const history = await tracker.getHistory('https://example.com/unknown');
      assert.equal(history, null);
    });

    it('should return history for recorded URLs', async () => {
      const { createIncrementalTracker } = await import('../../src/runtime/incremental-crawl.js');
      const tracker = await createIncrementalTracker({
        storagePath: join(tmpDir, 'incr.json'),
      });
      const url = 'https://example.com/recorded';
      await tracker.record(url, '<html>content</html>');
      const history = await tracker.getHistory(url);
      assert.ok(history !== null);
    });

    it('should clear all history on reset', async () => {
      const { createIncrementalTracker } = await import('../../src/runtime/incremental-crawl.js');
      const tracker = await createIncrementalTracker({
        storagePath: join(tmpDir, 'incr.json'),
      });
      const url = 'https://example.com/to-reset';
      await tracker.record(url, '<html>content</html>');
      await tracker.reset();
      const history = await tracker.getHistory(url);
      assert.equal(history, null);
    });

    it('should respect ETag headers', async () => {
      const { createIncrementalTracker } = await import('../../src/runtime/incremental-crawl.js');
      const tracker = await createIncrementalTracker({
        storagePath: join(tmpDir, 'incr.json'),
        respectETag: true,
      });
      const url = 'https://example.com/etag';
      await tracker.record(url, '<html>content</html>', { etag: '"abc123"' });
      // Same ETag should mean not changed
      const result = await tracker.filterChanged(url, '<html>content</html>', { etag: '"abc123"' });
      assert.equal(result.changed, false);
    });

    it('should respect Last-Modified headers', async () => {
      const { createIncrementalTracker } = await import('../../src/runtime/incremental-crawl.js');
      const tracker = await createIncrementalTracker({
        storagePath: join(tmpDir, 'incr.json'),
        respectLastModified: true,
      });
      const url = 'https://example.com/lastmod';
      await tracker.record(url, '<html>content</html>', { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' });
      // Same Last-Modified should mean not changed
      const result = await tracker.filterChanged(url, '<html>content</html>', { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' });
      assert.equal(result.changed, false);
    });
  });
});
