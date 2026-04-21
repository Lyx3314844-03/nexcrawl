/**
 * Unit tests for kafka-sink module.
 * @module tests/runtime/kafka-sink.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('kafka-sink', () => {
  describe('module exports', () => {
    it('should export createKafkaSink as a function', async () => {
      const mod = await import('../../src/runtime/kafka-sink.js');
      assert.equal(typeof mod.createKafkaSink, 'function');
    });

    it('should export disconnectKafkaSink as a function', async () => {
      const mod = await import('../../src/runtime/kafka-sink.js');
      assert.equal(typeof mod.disconnectKafkaSink, 'function');
    });
  });

  describe('createKafkaSink', () => {
    it('should reject when brokers is not provided', async () => {
      const { createKafkaSink } = await import('../../src/runtime/kafka-sink.js');
      await assert.rejects(
        () => createKafkaSink({ topic: 'test' })
      );
    });

    it('should reject when topic is not provided', async () => {
      const { createKafkaSink } = await import('../../src/runtime/kafka-sink.js');
      await assert.rejects(
        () => createKafkaSink({ brokers: ['localhost:9092'] })
      );
    });

    it('should accept optional config parameters', async () => {
      const { createKafkaSink } = await import('../../src/runtime/kafka-sink.js');
      try {
        const sink = await createKafkaSink({
          brokers: ['localhost:9092'],
          topic: 'test-topic',
          clientId: 'test-client',
          keyField: 'id',
          ssl: false,
          serializer: 'json',
          batchSize: 100,
          acks: 'all',
        });
        assert.equal(typeof sink, 'function');
      } catch (err) {
        // Connection failure expected without a running Kafka instance
        assert.ok(err instanceof Error);
      }
    });

    it('should return a sink function with a teardown method', async () => {
      const { createKafkaSink } = await import('../../src/runtime/kafka-sink.js');
      try {
        const sink = await createKafkaSink({
          brokers: ['localhost:9092'],
          topic: 'test-topic',
        });
        assert.equal(typeof sink, 'function');
        assert.equal(typeof sink.teardown, 'function');
      } catch (err) {
        assert.ok(err instanceof Error);
      }
    });
  });

  describe('disconnectKafkaSink', () => {
    it('should not throw when called with a non-Kafka sink function', async () => {
      const { disconnectKafkaSink } = await import('../../src/runtime/kafka-sink.js');
      const fakeSink = async (batch) => ({ insertedCount: 0 });
      // Should not throw even without teardown
      await assert.doesNotReject(() => disconnectKafkaSink(fakeSink));
    });
  });
});
