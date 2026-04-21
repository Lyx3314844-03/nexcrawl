/**
 * Kafka data sink.
 *
 * Publishes crawl results to Apache Kafka topics using the
 * kafka.js producer for high-throughput streaming.
 *
 * Usage:
 *   import { createKafkaSink } from '../runtime/kafka-sink.js';
 *   const sink = await createKafkaSink({ brokers: ['localhost:9092'], topic: 'crawl-results' });
 *   await sink(batch);
 */

import { createLogger } from '../core/logger.js';
import { AppError } from '../core/errors.js';

const log = createLogger('kafka-sink');

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a Kafka sink.
 *
 * @param {object} config
 * @param {string[]} config.brokers     - Kafka broker addresses
 * @param {string}   config.topic       - Target topic name
 * @param {string}   [config.clientId]  - Client ID (default: omnicrawl-producer)
 * @param {string}   [config.keyField]  - Document field to use as message key
 * @param {object}   [config.sasl]      - SASL authentication config
 * @param {boolean}  [config.ssl]       - Enable SSL (default: false for local)
 * @param {string}   [config.serializer='json'] - 'json' | 'avro' (future)
 * @param {number}   [config.batchSize=500]     - Messages per produce call
 * @param {number}   [config.acks='all']        - Acknowledgment level
 * @returns {Promise<function>} Async sink function: (batch) => Promise<{insertedCount}>
 */
export async function createKafkaSink(config) {
  const {
    brokers,
    topic,
    clientId = 'omnicrawl-producer',
    keyField,
    sasl,
    ssl,
    serializer = 'json',
    batchSize = 500,
    acks = 'all',
  } = config;

  if (!brokers?.length || !topic) {
    throw new AppError(400, 'Kafka brokers and topic are required');
  }

  // Lazy-load kafkajs
  const { Kafka } = await import('kafkajs').catch(() => {
    throw new AppError(400, 'kafkajs is not installed. Run: npm install kafkajs');
  });

  const kafkaConfig = { brokers, clientId };
  if (sasl) kafkaConfig.sasl = sasl;
  if (ssl) kafkaConfig.ssl = ssl;

  const kafka = new Kafka(kafkaConfig);
  const producer = kafka.producer();
  await producer.connect();
  log.info('Kafka producer connected', { brokers, topic });

  /**
   * @param {Array<object>} batch
   * @returns {Promise<{insertedCount}>}
   */
  const sink = async function (batch) {
    let insertedCount = 0;

    for (let i = 0; i < batch.length; i += batchSize) {
      const chunk = batch.slice(i, i + batchSize);
      const messages = chunk.map(doc => ({
        key: keyField && doc[keyField] ? String(doc[keyField]) : undefined,
        value: JSON.stringify(doc),
      }));

      const result = await producer.send({
        topic,
        messages,
        acks,
      });

      insertedCount += result?.length ?? chunk.length;
    }

    log.info('Kafka sink complete', { insertedCount, topic });
    return { insertedCount };
  };

  // Attach teardown so the producer can be properly disconnected
  sink.teardown = async () => {
    await producer.disconnect();
    log.info('Kafka producer disconnected', { topic });
  };

  return sink;
}

/**
 * Disconnect the Kafka producer (call during teardown).
 *
 * @param {function} sinkFn - The sink function returned by createKafkaSink
 */
export async function disconnectKafkaSink(sinkFn) {
  // The producer is captured in the closure – expose teardown through a symbol
  if (sinkFn && typeof sinkFn.teardown === 'function') {
    await sinkFn.teardown();
  } else {
    log.warn('Kafka sink has no teardown method – producer may not be disconnected');
  }
}
