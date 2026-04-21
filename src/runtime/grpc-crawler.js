/**
 * gRPC Crawler — full HTTP/2 + Protobuf transport implementation
 *
 * Capabilities:
 *   - Real HTTP/2 transport with gRPC framing (5-byte length-prefix)
 *   - Protobuf encoding via inferred schema (no .proto file required)
 *   - Connection pooling with keep-alive and idle cleanup
 *   - gRPC metadata (headers) support
 *   - Timeout / deadline propagation
 *   - Retry with configurable backoff
 *   - Server-streaming and unary RPCs
 *   - Automatic schema inference on first response
 *   - TLS support with custom CA / rejectUnauthorized options
 */

import http2 from 'node:http2';
import { URL } from 'node:url';
import { getLogger } from '../utils/logger.js';
import { Router } from '../api/router.js';
import { OmniCrawlError, NetworkError, TimeoutError } from '../errors.js';
import {
  inferProtobufStructure,
  decodeWithInferredSchema,
  encodeProtobufMessage,
  encodeGrpcFrame,
} from '../reverse/protobuf-inferrer.js';
import { computeRetryDelayMs } from './retry-policy.js';

const logger = getLogger('grpc-crawler');

// ─── gRPC status codes ────────────────────────────────────────────────────────

export const GRPC_STATUS = {
  OK: 0, CANCELLED: 1, UNKNOWN: 2, INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4, NOT_FOUND: 5, ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8, FAILED_PRECONDITION: 9,
  ABORTED: 10, OUT_OF_RANGE: 11, UNIMPLEMENTED: 12,
  INTERNAL: 13, UNAVAILABLE: 14, DATA_LOSS: 15, UNAUTHENTICATED: 16,
};

export const GRPC_STATUS_NAME = Object.fromEntries(
  Object.entries(GRPC_STATUS).map(([k, v]) => [v, k]),
);

export const RETRYABLE_STATUS = new Set([
  GRPC_STATUS.CANCELLED, GRPC_STATUS.UNKNOWN,
  GRPC_STATUS.DEADLINE_EXCEEDED, GRPC_STATUS.RESOURCE_EXHAUSTED,
  GRPC_STATUS.ABORTED, GRPC_STATUS.INTERNAL, GRPC_STATUS.UNAVAILABLE,
]);

// ─── gRPC frame parsing ──────────────────────────────────────────────────────

/**
 * Parse gRPC trailers from a buffer.
 * Trailers are encoded as key-value pairs separated by \r\n.
 */
function parseGrpcTrailers(buf) {
  const text = buf.toString('utf8');
  const result = {};
  for (const line of text.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

/**
 * Parse a single gRPC length-prefixed message from a buffer.
 * Returns { compressed, messageLength, message, remaining } or null if incomplete.
 */
export function parseGrpcFrame(buf) {
  if (buf.length < 5) return null;
  const compressed = buf[0];
  const messageLength = buf.readUInt32BE(1);
  if (buf.length < 5 + messageLength) return null;
  const message = buf.subarray(5, 5 + messageLength);
  const remaining = buf.subarray(5 + messageLength);
  return { compressed, messageLength, message, remaining };
}

/**
 * Parse all gRPC frames from a buffer, returning an array of message buffers.
 */
export function parseAllGrpcFrames(buf) {
  const messages = [];
  let remaining = buf;
  while (remaining.length > 0) {
    const frame = parseGrpcFrame(remaining);
    if (!frame) break;
    messages.push(frame.message);
    remaining = frame.remaining;
  }
  return messages;
}

// ─── Connection pool ─────────────────────────────────────────────────────────

export class GrpcConnectionPool {
  constructor(options = {}) {
    this.maxSessions = options.maxSessions ?? 4;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.sessions = new Map();
    this._cleanupTimer = setInterval(() => this._cleanupIdle(), this.idleTimeoutMs / 2);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  _sessionKey(endpoint, tlsOptions) {
    return String(endpoint) + '|tls:' + (tlsOptions?.rejectUnauthorized !== false);
  }

  /**
   * Get or create an HTTP/2 session for the given endpoint.
   * @param {string} endpoint - e.g. https://api.example.com:443
   * @param {Object} [tlsOptions]
   * @returns {Promise<http2.ClientHttp2Session>}
   */
  async acquire(endpoint, tlsOptions = {}) {
    const key = this._sessionKey(endpoint, tlsOptions);
    const entry = this.sessions.get(key);
    if (entry && !entry.session.destroyed && !entry.session.closed) {
      entry.lastUsed = Date.now();
      entry.activeStreams++;
      return entry.session;
    }

    if (this.sessions.size >= this.maxSessions) {
      // Evict the least-recently-used idle session
      let lruKey = null;
      let lruTime = Infinity;
      for (const [k, v] of this.sessions) {
        if (v.activeStreams === 0 && v.lastUsed < lruTime) {
          lruTime = v.lastUsed;
          lruKey = k;
        }
      }
      if (lruKey) {
        const evicted = this.sessions.get(lruKey);
        try { evicted.session.close(); } catch {}
        this.sessions.delete(lruKey);
      }
    }

    const session = await this._createSession(endpoint, tlsOptions);
    const newEntry = { session, lastUsed: Date.now(), activeStreams: 1 };
    this.sessions.set(key, newEntry);

    session.on('stream', () => { newEntry.lastUsed = Date.now(); });
    session.on('close', () => { this.sessions.delete(key); });
    session.on('error', (err) => {
      logger.debug('HTTP/2 session error', { endpoint, error: err.message });
      try { session.close(); } catch {}
      this.sessions.delete(key);
    });

    return session;
  }

  release(endpoint, tlsOptions) {
    const key = this._sessionKey(endpoint, tlsOptions);
    const entry = this.sessions.get(key);
    if (entry) {
      entry.activeStreams = Math.max(0, entry.activeStreams - 1);
      entry.lastUsed = Date.now();
    }
  }

  async _createSession(endpoint, tlsOptions) {
    const url = new URL(endpoint);
    const isTls = url.protocol === 'https:' || url.protocol === 'grpcs:';
    const connectOpts = {
      host: url.hostname,
      port: parseInt(url.port || (isTls ? '443' : '80'), 10),
    };

    if (isTls) {
      Object.assign(connectOpts, {
        rejectUnauthorized: tlsOptions.rejectUnauthorized ?? true,
        ca: tlsOptions.ca,
        cert: tlsOptions.cert,
        key: tlsOptions.key,
        servername: url.hostname,
      });
    }

    return new Promise((resolve, reject) => {
      const session = http2.connect(endpoint, connectOpts);
      const connectTimeout = setTimeout(() => {
        session.close();
        reject(new TimeoutError('HTTP/2 connect timeout'));
      }, tlsOptions.connectTimeoutMs ?? 10_000);
      if (connectTimeout.unref) connectTimeout.unref();

      session.on('connect', () => {
        clearTimeout(connectTimeout);
        resolve(session);
      });
      session.on('error', (err) => {
        clearTimeout(connectTimeout);
        reject(
          new NetworkError('HTTP/2 connect failed: ' + err.message, { recoverable: true }),
        );
      });
    });
  }

  _cleanupIdle() {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (entry.activeStreams === 0 && now - entry.lastUsed > this.idleTimeoutMs) {
        try { entry.session.close(); } catch {}
        this.sessions.delete(key);
      }
    }
  }

  closeAll() {
    clearInterval(this._cleanupTimer);
    for (const [, entry] of this.sessions) {
      try { entry.session.close(); } catch {}
    }
    this.sessions.clear();
  }

  snapshot() {
    const entries = [];
    for (const [key, val] of this.sessions) {
      entries.push({ key, activeStreams: val.activeStreams, lastUsed: val.lastUsed });
    }
    return { totalSessions: this.sessions.size, maxSessions: this.maxSessions, entries };
  }
}

// ─── GrpcCrawler ─────────────────────────────────────────────────────────────

/**
 * gRPC protocol crawler with real HTTP/2 transport and Protobuf encoding/decoding.
 *
 * @example
 * const crawler = new GrpcCrawler({
 *   endpoint: 'https://api.example.com',
 *   metadata: { authorization: 'Bearer xxx' },
 *   deadlineMs: 30_000,
 * });
 *
 * // Unary RPC
 * const result = await crawler.request('PackageService', 'GetItem', { id: 42 });
 *
 * // Server-streaming RPC
 * const results = await crawler.serverStream('PackageService', 'ListItems', { page: 1 });
 */
export class GrpcCrawler {
  /**
   * @param {Object} options
   * @param {string} options.endpoint - gRPC server endpoint (https://host:port)
   * @param {Object} [options.metadata={}] - Default gRPC metadata (headers)
   * @param {Object} [options.router] - Router for data pipeline
   * @param {number} [options.deadlineMs=30000] - Default request deadline
   * @param {Object} [options.retry] - Retry configuration
   * @param {number} [options.retry.maxRetries=3]
   * @param {string} [options.retry.backoff='exponential']
   * @param {number} [options.retry.backoffMs=500]
   * @param {Object} [options.tls] - TLS options (ca, cert, key, rejectUnauthorized)
   * @param {Object} [options.pool] - Connection pool options
   * @param {string} [options.name='grpc-crawler']
   */
  constructor(options = {}) {
    this.name = options.name || 'grpc-crawler';
    this.endpoint = options.endpoint;
    this.router = options.router || new Router();
    this.metadata = options.metadata || {};
    this.deadlineMs = options.deadlineMs ?? 30_000;
    this.retry = {
      maxRetries: options.retry?.maxRetries ?? 3,
      backoff: options.retry?.backoff ?? 'exponential',
      backoffMs: options.retry?.backoffMs ?? 500,
      maxBackoffMs: options.retry?.maxBackoffMs ?? 10_000,
    };
    this.tls = options.tls || {};
    this.schemas = new Map(); // "service/method" → inferred schema
    this.pool = new GrpcConnectionPool(options.pool || {});

    if (!this.endpoint) {
      throw new OmniCrawlError('GrpcCrawler requires an endpoint option', {
        code: 'GRPC_NO_ENDPOINT',
        recoverable: false,
      });
    }
  }

  // ── Unary RPC ─────────────────────────────────────────────────────────────

  /**
   * Send a unary gRPC request.
   *
   * @param {string} service - Fully-qualified service name
   * @param {string} method - RPC method name
   * @param {Object|Buffer} payload - Request payload (object encoded via schema, or raw Buffer)
   * @param {Object} [callOptions]
   * @param {Object} [callOptions.metadata] - Per-call metadata overrides
   * @param {number} [callOptions.deadlineMs] - Per-call deadline
   * @param {Object} [callOptions.requestSchema] - Schema for encoding the request
   * @returns {Promise<{data: Object, raw: Buffer, grpcStatus: number, trailers: Object}>}
   */
  async request(service, method, payload, callOptions = {}) {
    const path = '/' + service + '/' + method;
    const deadlineMs = callOptions.deadlineMs ?? this.deadlineMs;
    const metadata = { ...this.metadata, ...(callOptions.metadata || {}) };

    // Encode payload
    const requestBuffer = this._encodePayload(service, method, payload, callOptions.requestSchema);
    const grpcFrame = encodeGrpcFrame(requestBuffer);

    // Retry loop
    let lastError = null;
    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = computeRetryDelayMs({
          attempt,
          retry: {
            backoff: this.retry.backoff,
            backoffMs: this.retry.backoffMs,
            maxBackoffMs: this.retry.maxBackoffMs,
            jitterRatio: 0.2,
          },
          random: Math.random,
        });
        logger.info('Retrying gRPC request', { service, method, attempt, delayMs: delay });
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const result = await this._sendUnary(path, grpcFrame, metadata, deadlineMs);

        // Auto-infer response schema on first call
        const schemaKey = service + '/' + method;
        if (!this.schemas.has(schemaKey) && result.raw.length > 0) {
          logger.info('Inferring response schema', { service, method });
          const schema = inferProtobufStructure(result.raw, {
            messageName: method + 'Response',
          });
          this.schemas.set(schemaKey, schema);
        }

        // Decode response
        const schema = this.schemas.get(schemaKey);
        const data = schema ? decodeWithInferredSchema(result.raw, schema) : {};

        // Route through data pipeline
        const ctx = {
          crawler: this,
          body: data,
          rawResponse: result.raw,
          pushData: async (d) => logger.info('gRPC Data pushed:', d),
        };
        await this.router.handleRequest(ctx);

        return { data, raw: result.raw, grpcStatus: result.grpcStatus, trailers: result.trailers };
      } catch (err) {
        lastError = err;
        const grpcStatus = err.grpcStatus ?? -1;
        if (!RETRYABLE_STATUS.has(grpcStatus) && attempt > 0) break;
        logger.debug('gRPC request failed', { service, method, attempt, error: err.message });
      }
    }

    throw lastError || new NetworkError('gRPC request failed after retries', { recoverable: false });
  }

  // ── Server-streaming RPC ──────────────────────────────────────────────────

  /**
   * Send a server-streaming gRPC request and collect all responses.
   *
   * @param {string} service
   * @param {string} method
   * @param {Object|Buffer} payload
   * @param {Object} [callOptions]
   * @returns {Promise<Array<{data: Object, raw: Buffer}>>}
   */
  async serverStream(service, method, payload, callOptions = {}) {
    const path = '/' + service + '/' + method;
    const deadlineMs = callOptions.deadlineMs ?? this.deadlineMs;
    const metadata = { ...this.metadata, ...(callOptions.metadata || {}) };

    const requestBuffer = this._encodePayload(service, method, payload, callOptions.requestSchema);
    const grpcFrame = encodeGrpcFrame(requestBuffer);

    const session = await this.pool.acquire(this.endpoint, this.tls);

    try {
      const result = await this._sendStreamRequest(session, path, grpcFrame, metadata, deadlineMs);

      // Parse all gRPC frames from the response body
      const messageBuffers = parseAllGrpcFrames(result.body);
      const schemaKey = service + '/' + method;

      // Auto-infer from first message
      if (!this.schemas.has(schemaKey) && messageBuffers.length > 0) {
        logger.info('Inferring response schema from stream', { service, method });
        const schema = inferProtobufStructure(messageBuffers[0], {
          messageName: method + 'Response',
        });
        this.schemas.set(schemaKey, schema);
      }

      const schema = this.schemas.get(schemaKey);
      const results = [];
      for (const msgBuf of messageBuffers) {
        const data = schema ? decodeWithInferredSchema(msgBuf, schema) : {};
        results.push({ data, raw: msgBuf });
      }

      // Route through data pipeline
      for (const item of results) {
        const ctx = {
          crawler: this,
          body: item.data,
          rawResponse: item.raw,
          pushData: async (d) => logger.info('gRPC stream data pushed:', d),
        };
        await this.router.handleRequest(ctx);
      }

      return results;
    } finally {
      this.pool.release(this.endpoint, this.tls);
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Encode a payload into a protobuf Buffer using known or provided schema.
   */
  _encodePayload(service, method, payload, requestSchema) {
    if (Buffer.isBuffer(payload)) return payload;

    const schemaKey = service + '/' + method + ':request';
    const schema = requestSchema || this.schemas.get(schemaKey);

    if (schema) {
      logger.debug('Encoding with inferred schema', { service, method });
      return encodeProtobufMessage(payload, schema);
    }

    // No schema available: try plain JSON-as-bytes as a best-effort fallback
    logger.debug('No request schema — encoding payload as JSON bytes', { service, method });
    return Buffer.from(JSON.stringify(payload), 'utf8');
  }

  /**
   * Perform a unary gRPC request over HTTP/2.
   * Returns { body, raw, grpcStatus, trailers }.
   */
  async _sendUnary(path, grpcFrame, metadata, deadlineMs) {
    const session = await this.pool.acquire(this.endpoint, this.tls);
    const deadline = Date.now() + deadlineMs;

    try {
      const headers = this._buildHeaders(path, metadata, deadline);

      const stream = session.request(headers);

      // Set stream-level timeout
      stream.setTimeout(deadlineMs, () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      });

      // Send the gRPC-framed request
      stream.end(grpcFrame);

      // Collect response
      const { body, responseHeaders, trailers: responseTrailers } =
        await this._collectResponse(stream, deadlineMs);

      // Parse the response gRPC frames
      const messages = parseAllGrpcFrames(body);
      const raw = messages.length > 0 ? messages[0] : Buffer.alloc(0);

      // Check gRPC status from trailers
      const grpcStatus = parseInt(responseTrailers['grpc-status'] ?? '0', 10);
      const grpcMessage = responseTrailers['grpc-message'] || '';

      if (grpcStatus !== GRPC_STATUS.OK) {
        const err = new NetworkError(
          'gRPC error ' + (GRPC_STATUS_NAME[grpcStatus] || grpcStatus) + ': ' + grpcMessage,
          { recoverable: RETRYABLE_STATUS.has(grpcStatus) },
        );
        err.grpcStatus = grpcStatus;
        throw err;
      }

      return { body, raw, grpcStatus, trailers: responseTrailers };
    } finally {
      this.pool.release(this.endpoint, this.tls);
    }
  }

  /**
   * Perform a server-streaming gRPC request over HTTP/2.
   * Returns { body, responseHeaders, trailers }.
   */
  async _sendStreamRequest(session, path, grpcFrame, metadata, deadlineMs) {
    const headers = this._buildHeaders(path, metadata, Date.now() + deadlineMs);
    const stream = session.request(headers);

    stream.setTimeout(deadlineMs, () => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
    });

    stream.end(grpcFrame);

    return this._collectResponse(stream, deadlineMs);
  }

  /**
   * Build HTTP/2 headers for a gRPC request.
   */
  _buildHeaders(path, metadata, deadline) {
    const headers = {
      [http2.constants.HTTP2_HEADER_PATH]: path,
      [http2.constants.HTTP2_HEADER_METHOD]: 'POST',
      [http2.constants.HTTP2_HEADER_SCHEME]: 'https',
      'content-type': 'application/grpc',
      te: 'trailers',
      'grpc-encoding': 'identity',
      'grpc-accept-encoding': 'identity,gzip',
      'user-agent': 'omnicrawl-grpc/1.0',
    };

    // Add deadline if provided
    if (deadline) {
      headers['grpc-timeout'] = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) + 'S';
    }

    // Merge user metadata (skip pseudo-headers)
    for (const [key, val] of Object.entries(metadata)) {
      if (key.startsWith(':')) continue;
      headers[key] = String(val);
    }

    return headers;
  }

  /**
   * Collect full response from an HTTP/2 stream, including trailers.
   */
  _collectResponse(stream, timeoutMs) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let responseHeaders = {};
      let trailers = {};

      const timeout = setTimeout(() => {
        stream.destroy();
        reject(new TimeoutError('gRPC stream timeout after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      if (timeout.unref) timeout.unref();

      stream.on('response', (hdrs) => {
        responseHeaders = hdrs || {};
      });

      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });

      stream.on('trailers', (trailerHdrs) => {
        trailers = trailerHdrs || {};
      });

      stream.on('end', () => {
        clearTimeout(timeout);
        const body = Buffer.concat(chunks);
        resolve({ body, responseHeaders, trailers });
      });

      stream.on('error', (err) => {
        clearTimeout(timeout);
        reject(
          new NetworkError('gRPC stream error: ' + err.message, { recoverable: true }),
        );
      });
    });
  }

  // ── Schema management ─────────────────────────────────────────────────────

  /**
   * Manually register a schema for a service/method.
   * @param {string} service
   * @param {string} method
   * @param {Object} schema - Schema from inferProtobufStructure()
   * @param {Object} [requestSchema] - Schema for encoding requests
   */
  registerSchema(service, method, schema, requestSchema = null) {
    const key = service + '/' + method;
    this.schemas.set(key, schema);
    if (requestSchema) {
      this.schemas.set(key + ':request', requestSchema);
    }
  }

  /**
   * Get the connection pool status snapshot.
   */
  poolStatus() {
    return this.pool.snapshot();
  }

  /**
   * Get all known schemas.
   */
  listSchemas() {
    const result = {};
    for (const [key, schema] of this.schemas) {
      result[key] = { fieldCount: schema.fields.length, protoSchema: schema.protoSchema };
    }
    return result;
  }

  /**
   * Close all pooled connections and clean up.
   */
  async close() {
    this.pool.closeAll();
    logger.info('GrpcCrawler closed', { name: this.name });
  }
}
