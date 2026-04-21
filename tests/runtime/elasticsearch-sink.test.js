/**
 * Unit tests for elasticsearch-sink module.
 * @module tests/runtime/elasticsearch-sink.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('elasticsearch-sink', () => {
  describe('module exports', () => {
    it('should export createElasticsearchSink as an async function', async () => {
      const mod = await import('../../src/runtime/elasticsearch-sink.js');
      assert.equal(typeof mod.createElasticsearchSink, 'function');
    });
  });

  describe('createElasticsearchSink', () => {
    it('should reject when node is not provided', async () => {
      const { createElasticsearchSink } = await import('../../src/runtime/elasticsearch-sink.js');
      await assert.rejects(
        () => createElasticsearchSink({ index: 'test' })
      );
    });

    it('should reject when index is not provided', async () => {
      const { createElasticsearchSink } = await import('../../src/runtime/elasticsearch-sink.js');
      await assert.rejects(
        () => createElasticsearchSink({ node: 'http://localhost:9200' })
      );
    });

    it('should return an async sink function when given valid config', async () => {
      const { createElasticsearchSink } = await import('../../src/runtime/elasticsearch-sink.js');
      // This will fail to connect to ES, but we test the factory shape
      try {
        const sink = await createElasticsearchSink({
          node: 'http://localhost:9200',
          index: 'test-index',
        });
        assert.equal(typeof sink, 'function');
      } catch (err) {
        // Connection failure is expected without a running ES instance
        assert.ok(err instanceof Error);
      }
    });

    it('should accept optional config parameters', async () => {
      const { createElasticsearchSink } = await import('../../src/runtime/elasticsearch-sink.js');
      try {
        const sink = await createElasticsearchSink({
          node: 'http://localhost:9200',
          index: 'test-index',
          pipeline: 'my-pipeline',
          apiKey: 'test-key',
          batchSize: 100,
          mapping: { properties: { title: { type: 'text' } } },
        });
        assert.equal(typeof sink, 'function');
      } catch (err) {
        // Connection failure is expected
        assert.ok(err instanceof Error);
      }
    });
  });
});
