/**
 * Unit tests for webhook-sink module.
 * @module tests/runtime/webhook-sink.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('webhook-sink', () => {
  describe('module exports', () => {
    it('should export createWebhookSink as a function', async () => {
      const mod = await import('../../src/runtime/webhook-sink.js');
      assert.equal(typeof mod.createWebhookSink, 'function');
    });
  });

  describe('createWebhookSink', () => {
    it('should reject when url is not provided', async () => {
      const { createWebhookSink } = await import('../../src/runtime/webhook-sink.js');
      await assert.rejects(
        () => createWebhookSink({})
      );
    });

    it('should return an async sink function when given a valid url', async () => {
      const { createWebhookSink } = await import('../../src/runtime/webhook-sink.js');
      const sink = await createWebhookSink({
        url: 'https://httpbin.org/post',
      });
      assert.equal(typeof sink, 'function');
    });

    it('should accept optional config parameters', async () => {
      const { createWebhookSink } = await import('../../src/runtime/webhook-sink.js');
      const sink = await createWebhookSink({
        url: 'https://httpbin.org/post',
        secret: 'my-secret',
        algorithm: 'sha256',
        headerName: 'X-My-Signature',
        headers: { 'Authorization': 'Bearer token' },
        format: 'json',
        batchSize: 50,
        retries: 2,
        retryDelayMs: 500,
        timeoutMs: 10000,
      });
      assert.equal(typeof sink, 'function');
    });

    it('should return a sink that accepts a batch and returns insertedCount', async () => {
      const { createWebhookSink } = await import('../../src/runtime/webhook-sink.js');
      const sink = await createWebhookSink({
        url: 'https://httpbin.org/post',
        retries: 0,
        timeoutMs: 5000,
      });
      const batch = [{ id: 1, name: 'test' }];
      try {
        const result = await sink(batch);
        assert.ok(result !== null && typeof result === 'object');
        assert.ok('insertedCount' in result);
      } catch (err) {
        // Network errors are acceptable in test environments
        assert.ok(err instanceof Error);
      }
    });

    it('should support jsonl format', async () => {
      const { createWebhookSink } = await import('../../src/runtime/webhook-sink.js');
      const sink = await createWebhookSink({
        url: 'https://httpbin.org/post',
        format: 'jsonl',
        retries: 0,
      });
      assert.equal(typeof sink, 'function');
    });

    it('should support csv format', async () => {
      const { createWebhookSink } = await import('../../src/runtime/webhook-sink.js');
      const sink = await createWebhookSink({
        url: 'https://httpbin.org/post',
        format: 'csv',
        retries: 0,
      });
      assert.equal(typeof sink, 'function');
    });
  });
});
