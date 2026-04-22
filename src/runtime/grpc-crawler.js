import http2 from 'node:http2';
import { getLogger } from '../utils/logger.js';
import { inferProtobufStructure, decodeWithInferredSchema, encodeGrpcFrame, encodeProtobufMessage } from '../reverse/protobuf-inferrer.js';
import { loadProtoSchema } from '../reverse/protocol-analyzer.js';

const logger = getLogger('grpc-crawler');

// ─── gRPC Status Codes ──────────────────────────────────────────────────────

export const GRPC_STATUS = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
};

export const GRPC_STATUS_NAME = Object.fromEntries(
  Object.entries(GRPC_STATUS).map(([k, v]) => [v, k])
);

export const RETRYABLE_STATUS = new Set([
  GRPC_STATUS.CANCELLED,
  GRPC_STATUS.DEADLINE_EXCEEDED,
  GRPC_STATUS.UNAVAILABLE,
  GRPC_STATUS.INTERNAL,
]);

function normalizeGrpcMetadata(callMeta = {}) {
  const directMeta = callMeta && typeof callMeta === 'object' && !Array.isArray(callMeta)
    ? callMeta
    : {};
  const nestedMeta =
    directMeta.metadata && typeof directMeta.metadata === 'object' && !Array.isArray(directMeta.metadata)
      ? directMeta.metadata
      : {};

  return Object.fromEntries(
    Object.entries({
      ...directMeta,
      ...nestedMeta,
    }).filter(([key, value]) => key !== 'metadata' && value !== undefined && value !== null),
  );
}

function looksLikeGrpcFrame(buf) {
  return Buffer.isBuffer(buf)
    && buf.length >= 5
    && buf.readUInt32BE(1) === buf.length - 5;
}

function encodeGrpcRequestBody(message, inputSchema) {
  if (Buffer.isBuffer(message)) {
    return looksLikeGrpcFrame(message) ? message : encodeGrpcFrame(message);
  }

  if (message === undefined || message === null) {
    return encodeGrpcFrame(Buffer.alloc(0));
  }

  if (inputSchema?.fields) {
    return encodeGrpcFrame(encodeProtobufMessage(message, inputSchema));
  }

  if (typeof message === 'object' && !Array.isArray(message) && Object.keys(message).length === 0) {
    return encodeGrpcFrame(Buffer.alloc(0));
  }

  throw new Error('request schema is required to encode a non-empty gRPC object payload');
}

// ─── Connection Pool ────────────────────────────────────────────────────────

export class GrpcConnectionPool {
  constructor(options = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.maxSessions = options.maxSessions ?? 4;
    this.sessions = new Map();
  }

  async closeAll() {
    for (const [key, session] of this.sessions) {
      try { session?.close?.(); } catch {}
      this.sessions.delete(key);
    }
  }
}

// ─── Frame Parsing ──────────────────────────────────────────────────────────

/**
 * Parse a single gRPC length-prefixed frame.
 * @param {Buffer|Uint8Array} buf
 * @returns {{ compressed: number, messageLength: number, message: Buffer, remaining: Buffer } | null}
 */
export function parseGrpcFrame(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 5) return null;
  const compressed = buf[0];
  const messageLength = buf.readUInt32BE(1);
  if (buf.length < 5 + messageLength) return null;
  const message = buf.subarray(5, 5 + messageLength);
  const remaining = buf.length > 5 + messageLength ? buf.subarray(5 + messageLength) : Buffer.alloc(0);
  return { compressed, messageLength, message, remaining };
}

/**
 * Parse all gRPC length-prefixed frames from a buffer.
 * @param {Buffer|Uint8Array} buf
 * @returns {Buffer[]}
 */
export function parseAllGrpcFrames(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 5) break;
    const compressed = buf[offset];
    const messageLength = buf.readUInt32BE(offset + 1);
    if (buf.length - offset < 5 + messageLength) break;
    const message = buf.subarray(offset + 5, offset + 5 + messageLength);
    frames.push(message);
    offset += 5 + messageLength;
  }
  return frames;
}

// ─── GrpcCrawler ────────────────────────────────────────────────────────────

/**
 * Full-featured gRPC crawler with schema inference, connection pooling,
 * unary & server-streaming RPC, and automatic retry.
 */
export class GrpcCrawler {
  /**
   * @param {object} options
   * @param {string} options.endpoint - HTTP/2 endpoint URL
   * @param {Record<string,string>} [options.metadata={}] - Default metadata headers
   * @param {number} [options.maxRetries=3] - Max retry attempts on retryable errors
   * @param {number} [options.retryDelayMs=500] - Base delay between retries
   * @param {object} [options.retry] - Retry config (alternative to top-level maxRetries/retryDelayMs)
   * @param {number} [options.retry.maxRetries] - Max retry attempts
   * @param {number} [options.retry.backoffMs] - Base delay between retries
   * @param {GrpcConnectionPool} [options.pool] - Optional external connection pool
   */
  constructor(options = {}) {
    if (!options.endpoint) throw new Error('endpoint is required');
    this.endpoint = options.endpoint;
    this.metadata = options.metadata ?? {};
    this.maxRetries = options.retry?.maxRetries ?? options.maxRetries ?? 3;
    this.retryDelayMs = options.retry?.backoffMs ?? options.retryDelayMs ?? 500;
    this.pool = options.pool ?? new GrpcConnectionPool();
    this.schemas = new Map();
    this.session = null;
  }

  /**
   * Register a protobuf schema for a service method.
   * @param {string} service - e.g. "package.Service"
   * @param {string} method - e.g. "GetItem"
   * @param {object} [responseSchema] - Response message schema
   * @param {object} [requestSchema] - Request message schema
   */
  registerSchema(service, method, responseSchema, requestSchema) {
    const path = `/${service}/${method}`;
    this.schemas.set(path, { input: requestSchema, output: responseSchema });
  }

  /**
   * Execute a unary gRPC call.
   * @param {string} service
   * @param {string} method
   * @param {object|Buffer} message - Request body (object or encoded Buffer)
   * @param {Record<string,string>} [callMeta] - Per-call metadata
   * @returns {Promise<{ data: object, grpcStatus: number }>}
   */
  async request(service, method, message, callMeta = {}) {
    const path = `/${service}/${method}`;
    const schema = this.schemas.get(path);
    const body = encodeGrpcRequestBody(message, schema?.input);

    let attempts = 0;
    while (attempts <= this.maxRetries) {
      try {
        if (!this.session || this.session.destroyed) await this._connect();

        const mergedMeta = { ...this.metadata, ...normalizeGrpcMetadata(callMeta) };
        const req = this.session.request({
          ':method': 'POST',
          ':path': path,
          'content-type': 'application/grpc',
          ...mergedMeta,
        });

        req.end(body);

        const { data, grpcStatus } = await this._readUnaryResponse(req, path);
        return { data, grpcStatus };
      } catch (err) {
        attempts++;
        const code = err.code ?? err.grpcStatus ?? GRPC_STATUS.UNKNOWN;
        if (attempts <= this.maxRetries && RETRYABLE_STATUS.has(code)) {
          logger.debug(`Retry ${attempts}/${this.maxRetries} for ${path} – ${code}`);
          await this._delay(this.retryDelayMs * attempts);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Execute a server-streaming gRPC call.
   * @param {string} service
   * @param {string} method
   * @param {object|Buffer} message
   * @param {Record<string,string>} [callMeta]
   * @returns {Promise<Array<{ data: object, grpcStatus: number }>>}
   */
  async serverStream(service, method, message, callMeta = {}) {
    const path = `/${service}/${method}`;
    const schema = this.schemas.get(path);
    const body = encodeGrpcRequestBody(message, schema?.input);

    if (!this.session || this.session.destroyed) await this._connect();

    const mergedMeta = { ...this.metadata, ...normalizeGrpcMetadata(callMeta) };
    const req = this.session.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      ...mergedMeta,
    });

    req.end(body);
    return this._readStreamResponse(req, path);
  }

  /**
   * Convenience: same as request() but returns only data.
   * @param {string} service
   * @param {string} method
   * @param {object|Buffer} message
   * @param {Record<string,string>} [callMeta]
   * @returns {Promise<object>}
   */
  async call(service, method, message, callMeta = {}) {
    const result = await this.request(service, method, message, callMeta);
    return result.data;
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  async _connect() {
    const session = http2.connect(this.endpoint);
    this.session = session;

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        session.off('connect', handleConnect);
        session.off('error', handleError);
      };

      const handleConnect = () => {
        cleanup();
        resolve();
      };

      const handleError = (error) => {
        cleanup();
        if (this.session === session) {
          this.session = null;
        }
        error.grpcStatus = error.grpcStatus ?? GRPC_STATUS.UNAVAILABLE;
        reject(error);
      };

      session.once('connect', handleConnect);
      session.once('error', handleError);
    });

    session.on('error', (error) => {
      if (this.session === session) {
        this.session = null;
      }
      logger.debug(`H2 session error: ${error.message}`);
    });
    session.on('close', () => {
      if (this.session === session) {
        this.session = null;
      }
    });

    logger.debug('H2 session established.');
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _readUnaryResponse(req, path) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let grpcStatus = GRPC_STATUS.OK;

      req.on('response', (headers) => {
        const status = headers['grpc-status'];
        if (status !== undefined) grpcStatus = Number(status);
      });

      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        const frame = parseGrpcFrame(buf);
        if (!frame) {
          resolve({ data: {}, grpcStatus });
          return;
        }

        const schema = this.schemas.get(path);
        let data;
        try {
          data = schema?.output ? decodeWithInferredSchema(frame.message, schema.output) : inferProtobufStructure(frame.message);
        } catch {
          data = {};
        }
        resolve({ data, grpcStatus });
      });

      req.on('error', reject);
    });
  }

  _readStreamResponse(req, path) {
    return new Promise((resolve, reject) => {
      const results = [];
      const chunks = [];
      let grpcStatus = GRPC_STATUS.OK;

      req.on('response', (headers) => {
        const status = headers['grpc-status'];
        if (status !== undefined) grpcStatus = Number(status);
      });

      req.on('data', (chunk) => {
        chunks.push(chunk);
        // Try to parse complete frames from accumulated data
        const buf = Buffer.concat(chunks);
        const frames = parseAllGrpcFrames(buf);
        if (frames.length > 0) {
          const consumed = frames.reduce((sum, f) => sum + 5 + f.length, 0);
          chunks.length = 0; // Clear accumulated chunks
          if (consumed < buf.length) chunks.push(buf.subarray(consumed));

          for (const message of frames) {
            const schema = this.schemas.get(path);
            let data;
            try {
              data = schema?.output ? decodeWithInferredSchema(message, schema.output) : inferProtobufStructure(message);
            } catch {
              data = {};
            }
            results.push(data);
          }
        }
      });

      req.on('end', () => resolve(results));
      req.on('error', reject);
    });
  }

  /**
   * Close the HTTP/2 session and connection pool.
   */
  async close() {
    try { this.session?.close?.(); } catch {}
    this.session = null;
    await this.pool.closeAll();
  }
}

function normalizeGrpcWorkflowConfig(config = {}) {
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

function normalizeProtoType(type = '') {
  return String(type ?? '').replace(/^\./, '');
}

function isProtoMessageType(type = '') {
  const normalized = normalizeProtoType(type).toLowerCase();
  return ![
    'double', 'float',
    'int32', 'int64', 'uint32', 'uint64',
    'sint32', 'sint64',
    'fixed32', 'fixed64',
    'sfixed32', 'sfixed64',
    'bool', 'string', 'bytes', 'enum',
  ].includes(normalized);
}

function descriptorToInferenceSchema(schema, messageType, seen = new Set()) {
  const normalizedType = normalizeProtoType(messageType);
  if (!normalizedType || seen.has(normalizedType)) {
    return null;
  }
  const descriptor = schema?.messages?.[normalizedType];
  if (!descriptor) {
    return null;
  }

  seen.add(normalizedType);
  const fields = Object.values(descriptor.fieldsByNumber ?? {})
    .sort((left, right) => left.fieldNumber - right.fieldNumber)
    .map((field) => ({
      fieldNumber: field.fieldNumber,
      name: field.name,
      type: isProtoMessageType(field.type) ? 'message' : normalizeProtoType(field.type).toLowerCase(),
      repeated: field.repeated === true,
    }));

  const nestedSchemas = {};
  for (const field of Object.values(descriptor.fieldsByNumber ?? {})) {
    if (!isProtoMessageType(field.type)) {
      continue;
    }
    const nested = descriptorToInferenceSchema(schema, field.type, seen);
    if (nested) {
      nestedSchemas[field.name] = nested;
    }
  }

  seen.delete(normalizedType);
  return {
    fields,
    ...(Object.keys(nestedSchemas).length > 0 ? { nestedSchemas } : {}),
  };
}

function resolveGrpcMethodFromConfig(schema, config = {}) {
  const explicitService = config.service ? normalizeProtoType(config.service) : null;
  const explicitMethod = config.method ? String(config.method) : null;
  const explicitPath = config.path ? String(config.path) : null;
  const pathParts = explicitPath ? explicitPath.split('/').filter(Boolean) : [];
  const pathService = pathParts[0] ? normalizeProtoType(pathParts[0]) : null;
  const pathMethod = pathParts[1] ? String(pathParts[1]) : null;
  const targetService = explicitService ?? pathService;
  const targetMethod = explicitMethod ?? pathMethod;

  if (!targetService || !targetMethod) {
    return null;
  }

  for (const service of schema?.services ?? []) {
    const normalizedServiceName = normalizeProtoType(service.name);
    const serviceMatches = normalizedServiceName === targetService || normalizedServiceName.endsWith(`.${targetService}`);
    if (!serviceMatches) {
      continue;
    }
    const method = service.methods.find((entry) => entry.name === targetMethod);
    if (method) {
      return {
        service: normalizedServiceName,
        method: method.name,
        path: `/${normalizedServiceName}/${method.name}`,
        requestType: normalizeProtoType(method.requestType),
        responseType: normalizeProtoType(method.responseType),
      };
    }
  }

  return {
    service: targetService,
    method: targetMethod,
    path: explicitPath ?? `/${targetService}/${targetMethod}`,
    requestType: config.requestType ? normalizeProtoType(config.requestType) : null,
    responseType: config.responseType ? normalizeProtoType(config.responseType) : null,
  };
}

async function enrichGrpcWorkflowConfig(config = {}) {
  const normalized = {
    ...normalizeGrpcWorkflowConfig(config),
    metadata: normalizeGrpcWorkflowConfig(config.metadata ?? {}),
    descriptorPaths: Array.isArray(config.descriptorPaths) ? config.descriptorPaths : [],
  };

  if (normalized.descriptorPaths.length === 0) {
    return normalized;
  }

  const schema = await loadProtoSchema(normalized.descriptorPaths);
  const resolved = resolveGrpcMethodFromConfig(schema, normalized);

  return {
    ...normalized,
    service: normalized.service ?? resolved?.service ?? undefined,
    method: normalized.method ?? resolved?.method ?? undefined,
    path: normalized.path ?? resolved?.path ?? undefined,
    requestType: normalized.requestType ?? resolved?.requestType ?? undefined,
    responseType: normalized.responseType ?? resolved?.responseType ?? undefined,
    requestSchema: normalized.requestSchema ?? descriptorToInferenceSchema(schema, normalized.requestType ?? resolved?.requestType),
    responseSchema: normalized.responseSchema ?? descriptorToInferenceSchema(schema, normalized.responseType ?? resolved?.responseType),
  };
}

function parseGrpcRequestMessage(body, config = {}) {
  if (body === undefined || body === null || body === '') {
    return {};
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body !== 'string') {
    return body;
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return {};
  }

  const bodyEncoding = String(config.bodyEncoding ?? 'auto').toLowerCase();
  if (bodyEncoding === 'protobuf-base64' || bodyEncoding === 'grpc-frame-base64') {
    return Buffer.from(trimmed, 'base64');
  }

  if (bodyEncoding === 'utf8') {
    return Buffer.from(trimmed, 'utf8');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return bodyEncoding === 'json' ? {} : Buffer.from(trimmed, 'utf8');
  }
}

export async function fetchGrpcResponse(request, options = {}) {
  const grpc = await enrichGrpcWorkflowConfig({
    ...(options ?? {}),
    ...(request?.grpc ?? {}),
  });

  if (!grpc.service || !grpc.method) {
    throw new Error('grpc.service and grpc.method are required, or provide grpc.path plus descriptorPaths');
  }

  const crawler = new GrpcCrawler({
    endpoint: request.url,
    metadata: {
      ...(grpc.metadata ?? {}),
      ...(request.headers ?? {}),
    },
    maxRetries: grpc.maxRetries,
    retryDelayMs: grpc.retryDelayMs,
  });

  if (grpc.requestSchema || grpc.responseSchema) {
    crawler.registerSchema(grpc.service, grpc.method, grpc.responseSchema, grpc.requestSchema);
  }

  const message = parseGrpcRequestMessage(request.body, grpc);

  try {
    if (grpc.stream) {
      const items = await crawler.serverStream(grpc.service, grpc.method, message, grpc.metadata ?? {});
      const payload = {
        kind: 'grpc-response',
        data: null,
        items,
        grpcStatus: GRPC_STATUS.OK,
        service: grpc.service,
        method: grpc.method,
        stream: true,
      };

      return {
        mode: 'grpc',
        url: request.url,
        finalUrl: request.url,
        ok: true,
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-omnicrawl-transport': 'grpc',
        },
        body: JSON.stringify(payload),
        sessionId: request.session?.id ?? null,
        proxyServer: request.proxy?.server ?? null,
        grpcStatus: GRPC_STATUS.OK,
        transport: {
          protocol: 'grpc',
          service: grpc.service,
          method: grpc.method,
          stream: true,
        },
        fetchedAt: new Date().toISOString(),
      };
    }

    const result = await crawler.request(grpc.service, grpc.method, message, grpc.metadata ?? {});
    const payload = {
      kind: 'grpc-response',
      data: result.data,
      items: [],
      grpcStatus: result.grpcStatus,
      service: grpc.service,
      method: grpc.method,
      stream: false,
    };

    return {
      mode: 'grpc',
      url: request.url,
      finalUrl: request.url,
      ok: result.grpcStatus === GRPC_STATUS.OK,
      status: result.grpcStatus === GRPC_STATUS.OK ? 200 : 502,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-omnicrawl-transport': 'grpc',
      },
      body: JSON.stringify(payload),
      sessionId: request.session?.id ?? null,
      proxyServer: request.proxy?.server ?? null,
      grpcStatus: result.grpcStatus,
      transport: {
        protocol: 'grpc',
        service: grpc.service,
        method: grpc.method,
        stream: false,
      },
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    await crawler.close();
  }
}
