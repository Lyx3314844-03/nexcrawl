/**
 * WebSocket crawler — connect, send messages, collect responses, and close.
 *
 * Supports:
 *   - Plain WS and WSS connections
 *   - Custom headers and proxy tunneling
 *   - Message collection with timeout
 *   - JSON and binary message handling
 *   - Subscription pattern (send a subscribe message, collect N responses)
 *   - Optional heartbeat, reconnect, and auth-refresh hooks
 */

import { createRequire } from 'node:module';
import { createLogger } from '../core/logger.js';

const require = createRequire(import.meta.url);
const wsPackage = require('ws');
const WebSocket = wsPackage.WebSocket ?? wsPackage.default ?? wsPackage;

const log = createLogger('ws-fetcher');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeMessageInput(value, context = {}) {
  if (typeof value === 'function') {
    return value(context);
  }
  return value;
}

function parseIncomingMessage(data, isBinary) {
  if (isBinary) {
    return {
      type: 'binary',
      text: null,
      json: null,
      binary: Buffer.isBuffer(data) ? data : Buffer.from(data),
    };
  }

  const text = data.toString('utf8');
  try {
    return {
      type: 'text',
      text,
      json: JSON.parse(text),
      binary: null,
    };
  } catch {
    return {
      type: 'text',
      text,
      json: null,
      binary: null,
    };
  }
}

async function shouldRefreshAuth(message, request, context) {
  if (typeof request.refreshOn === 'function') {
    return Boolean(await request.refreshOn(message, context));
  }

  const pattern = request.refreshOn;
  if (!pattern) {
    return false;
  }

  const haystack = message.text ?? JSON.stringify(message.json ?? '');
  if (pattern instanceof RegExp) {
    return pattern.test(haystack);
  }
  return haystack.includes(String(pattern));
}

async function shouldReconnect(result, request, context) {
  if (typeof request.shouldReconnect === 'function') {
    return Boolean(await request.shouldReconnect(result, context));
  }

  if (request.reconnectOnCloseCodes?.includes(result.closeCode)) {
    return true;
  }

  if (result.ok) {
    return false;
  }

  return Boolean(result.error);
}

async function createProxyAgent(proxy) {
  if (!proxy) {
    return null;
  }

  if (String(proxy).startsWith('socks')) {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    return new SocksProxyAgent(proxy);
  }

  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(proxy);
}

async function sendMessage(ws, message, context) {
  const resolved = normalizeMessageInput(message, context);
  if (resolved === undefined || resolved === null || resolved === '') {
    return;
  }

  const payload =
    Buffer.isBuffer(resolved) || resolved instanceof Uint8Array
      ? resolved
      : typeof resolved === 'object'
        ? JSON.stringify(resolved)
        : String(resolved);

  await new Promise((resolve, reject) => {
    ws.send(payload, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function connectOnce(request, state) {
  const {
    url,
    headers = {},
    sendMessage: initialSendMessage = null,
    sendMessages = [],
    collectMs = 5000,
    maxMessages = 100,
    terminateOn = null,
    proxy = null,
    connectTimeoutMs = 10000,
    binary = false,
    heartbeatIntervalMs = 0,
    heartbeatTimeoutMs = 0,
    heartbeatMessage = null,
    onMessage = null,
    authRefresh = null,
  } = request;

  const attemptStartedAt = Date.now();
  let connectMs = 0;
  let closeCode = null;
  let closeReason = null;
  let lastMessageAt = Date.now();

  const wsOptions = { headers };
  if (proxy) {
    try {
      wsOptions.agent = await createProxyAgent(proxy);
    } catch (error) {
      log.warn('proxy agent unavailable, connecting without proxy', { error: error.message });
    }
  }

  return new Promise((resolve) => {
    const messages = state.messages;
    let ws;
    let connectTimer;
    let collectTimer;
    let heartbeatTimer;
    let settled = false;
    let authRefreshInFlight = false;

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(collectTimer);
      clearInterval(heartbeatTimer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve({
        url,
        ok: error === null,
        connectMs,
        totalMs: Date.now() - attemptStartedAt,
        messages,
        closeCode,
        closeReason,
        error: error ? String(error) : null,
      });
    };

    const messageContext = () => ({
      attempt: state.attempt,
      messages,
      ws,
      url,
    });

    try {
      ws = new WebSocket(url, wsOptions);
    } catch (error) {
      finish(error);
      return;
    }

    connectTimer = setTimeout(() => finish(new Error('connect timeout')), connectTimeoutMs);

    ws.on('open', async () => {
      connectMs = Date.now() - attemptStartedAt;
      clearTimeout(connectTimer);

      try {
        const outboundMessages = [
          ...(initialSendMessage !== null ? [initialSendMessage] : []),
          ...sendMessages,
        ];

        for (const outbound of outboundMessages) {
          await sendMessage(ws, outbound, messageContext());
        }
      } catch (error) {
        finish(error);
        return;
      }

      collectTimer = setTimeout(() => finish(), collectMs);

      if (heartbeatIntervalMs > 0) {
        heartbeatTimer = setInterval(async () => {
          try {
            if (heartbeatTimeoutMs > 0 && Date.now() - lastMessageAt > heartbeatTimeoutMs) {
              finish(new Error('heartbeat timeout'));
              return;
            }

            if (heartbeatMessage === null && typeof ws.ping === 'function') {
              ws.ping();
              return;
            }

            await sendMessage(ws, heartbeatMessage, {
              ...messageContext(),
              heartbeat: true,
            });
          } catch (error) {
            finish(error);
          }
        }, heartbeatIntervalMs);
      }
    });

    ws.on('message', async (data, isBinary) => {
      const parsed = parseIncomingMessage(data, isBinary || binary);
      const entry = {
        index: messages.length,
        receivedAt: Date.now(),
        ...parsed,
      };
      messages.push(entry);
      lastMessageAt = Date.now();

      if (typeof onMessage === 'function') {
        try {
          await onMessage(entry, messageContext());
        } catch (error) {
          finish(error);
          return;
        }
      }

      if (!authRefreshInFlight && typeof authRefresh === 'function') {
        try {
          const needsRefresh = await shouldRefreshAuth(entry, request, messageContext());
          if (needsRefresh) {
            authRefreshInFlight = true;
            const refreshResult = await authRefresh(entry, messageContext());
            const refreshMessages = Array.isArray(refreshResult) ? refreshResult : [refreshResult];
            for (const refreshMessage of refreshMessages) {
              await sendMessage(ws, refreshMessage, {
                ...messageContext(),
                authRefresh: true,
              });
            }
            authRefreshInFlight = false;
          }
        } catch (error) {
          finish(error);
          return;
        }
      }

      if (messages.length >= maxMessages) {
        finish();
        return;
      }

      if (terminateOn) {
        const haystack = entry.text ?? JSON.stringify(entry.json ?? '');
        const matched = terminateOn instanceof RegExp
          ? terminateOn.test(haystack)
          : haystack.includes(String(terminateOn));
        if (matched) {
          finish();
        }
      }
    });

    ws.on('close', (code, reason) => {
      closeCode = code;
      closeReason = reason?.toString() ?? null;
      finish();
    });

    ws.on('error', (error) => finish(error));
  });
}

/**
 * @typedef {Object} WsRequest
 * @property {string} url
 * @property {Record<string,string>} [headers]
 * @property {string|Object|Function|null} [sendMessage]
 * @property {Array<string|Object|Function>} [sendMessages]
 * @property {number} [collectMs=5000]
 * @property {number} [maxMessages=100]
 * @property {string|RegExp} [terminateOn]
 * @property {string} [proxy]
 * @property {number} [connectTimeoutMs=10000]
 * @property {boolean} [binary=false]
 * @property {number} [heartbeatIntervalMs=0]
 * @property {number} [heartbeatTimeoutMs=0]
 * @property {string|Object|Function|null} [heartbeatMessage]
 * @property {number} [reconnectAttempts=0]
 * @property {number} [reconnectDelayMs=1000]
 * @property {(result: WsResponse, context: object) => boolean|Promise<boolean>} [shouldReconnect]
 * @property {number[]} [reconnectOnCloseCodes]
 * @property {(message: WsMessage, context: object) => void|Promise<void>} [onMessage]
 * @property {string|RegExp|((message: WsMessage, context: object) => boolean|Promise<boolean>)} [refreshOn]
 * @property {(message: WsMessage, context: object) => unknown|Promise<unknown>} [authRefresh]
 */

/**
 * @typedef {Object} WsMessage
 * @property {number} index
 * @property {number} receivedAt
 * @property {'text'|'binary'} type
 * @property {string|null} text
 * @property {Object|null} json
 * @property {Buffer|null} binary
 */

/**
 * @typedef {Object} WsResponse
 * @property {string} url
 * @property {boolean} ok
 * @property {number} connectMs
 * @property {number} totalMs
 * @property {WsMessage[]} messages
 * @property {string|null} closeReason
 * @property {number|null} closeCode
 * @property {string|null} error
 * @property {number} attemptsUsed
 * @property {number} reconnects
 */

/**
 * Connect to a WebSocket, optionally send messages, collect responses, and close.
 *
 * @param {WsRequest} request
 * @returns {Promise<WsResponse>}
 */
export async function fetchWebSocket(request) {
  const reconnectAttempts = Math.max(0, Number(request.reconnectAttempts ?? 0) || 0);
  const reconnectDelayMs = Math.max(0, Number(request.reconnectDelayMs ?? 1000) || 1000);
  const startedAt = Date.now();
  const state = {
    attempt: 0,
    messages: [],
  };

  let result = null;
  while (state.attempt <= reconnectAttempts) {
    state.attempt += 1;
    result = await connectOnce(request, state);
    const retry = state.attempt <= reconnectAttempts
      && await shouldReconnect(result, request, { attempt: state.attempt, messages: state.messages });
    if (!retry) {
      break;
    }
    await delay(reconnectDelayMs);
  }

  return {
    ...(result ?? {
      url: request.url,
      ok: false,
      connectMs: 0,
      totalMs: 0,
      messages: state.messages,
      closeCode: null,
      closeReason: null,
      error: 'websocket connection did not start',
    }),
    totalMs: Date.now() - startedAt,
    attemptsUsed: state.attempt,
    reconnects: Math.max(0, state.attempt - 1),
  };
}

/**
 * Subscribe to a WebSocket stream and collect messages until timeout or maxMessages.
 *
 * @param {string} url
 * @param {Object|string} subscribeMessage
 * @param {Object} [options]
 * @returns {Promise<WsMessage[]>}
 */
export async function subscribeWebSocket(url, subscribeMessage, options = {}) {
  const result = await fetchWebSocket({
    url,
    sendMessage: subscribeMessage,
    collectMs: options.collectMs ?? 10000,
    maxMessages: options.maxMessages ?? 200,
    ...options,
  });
  return result.messages;
}

function normalizeTranscriptEntry(entry) {
  if (typeof entry === 'string' || Buffer.isBuffer(entry) || entry instanceof Uint8Array) {
    return {
      direction: 'in',
      payload: entry,
    };
  }

  if (isPlainObject(entry) && ('message' in entry || 'payload' in entry)) {
    return {
      direction: entry.direction === 'out' ? 'out' : 'in',
      payload: entry.message ?? entry.payload,
    };
  }

  return {
    direction: entry?.direction === 'out' ? 'out' : 'in',
    payload: entry,
  };
}

export function classifyWebSocketMessage(entry) {
  const normalized = normalizeTranscriptEntry(entry);
  const parsed =
    isPlainObject(normalized.payload) && 'type' in normalized.payload && 'receivedAt' in normalized.payload
      ? normalized.payload
      : typeof normalized.payload === 'string' || Buffer.isBuffer(normalized.payload) || normalized.payload instanceof Uint8Array
        ? parseIncomingMessage(normalized.payload, Buffer.isBuffer(normalized.payload) || normalized.payload instanceof Uint8Array)
        : {
            type: 'text',
            text: null,
            json: isPlainObject(normalized.payload) ? normalized.payload : null,
            binary: null,
          };

  const haystack = JSON.stringify(parsed.json ?? parsed.text ?? '').toLowerCase();
  const kind =
    /\b(ping|pong|heartbeat|keepalive|keep_alive)\b/.test(haystack)
      ? 'heartbeat'
      : /\b(auth|authorize|authorization|token|login|refresh)\b/.test(haystack)
        ? 'auth'
        : /\b(subscribe|subscription|subscribed|listen|join|watch|channel)\b/.test(haystack)
          ? 'subscribe'
          : /\b(ack|ready|welcome|connected|hello|ok)\b/.test(haystack)
            ? 'ack'
            : /\b(error|failed|forbidden|unauthorized|denied)\b/.test(haystack)
              ? 'error'
              : haystack && haystack !== '""'
                ? 'data'
                : 'unknown';

  return {
    direction: normalized.direction,
    kind,
    text: parsed.text ?? null,
    json: parsed.json ?? null,
    binary: parsed.binary ?? null,
  };
}

export function analyzeWebSocketTranscript(transcript = [], options = {}) {
  const classified = transcript.map((entry) => classifyWebSocketMessage(entry));
  const byKind = Object.create(null);
  for (const entry of classified) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  }

  const outgoingAuth = classified.find((entry) => entry.direction === 'out' && entry.kind === 'auth');
  const outgoingSubscribe = classified.find((entry) => entry.direction === 'out' && entry.kind === 'subscribe');
  const outgoingHeartbeat = classified.find((entry) => entry.direction === 'out' && entry.kind === 'heartbeat');
  const incomingHeartbeat = classified.find((entry) => entry.direction === 'in' && entry.kind === 'heartbeat');
  const maxSamples = clamp(options.maxSamples ?? 5, 1, 10, 5);

  return {
    total: classified.length,
    kinds: byKind,
    authLikely: Boolean(outgoingAuth || classified.some((entry) => entry.kind === 'auth')),
    subscriptionLikely: Boolean(outgoingSubscribe || classified.some((entry) => entry.kind === 'subscribe')),
    requiresHeartbeat: Boolean(outgoingHeartbeat || incomingHeartbeat),
    likelyAuthMessage: outgoingAuth?.json ?? outgoingAuth?.text ?? null,
    likelySubscribeMessage: outgoingSubscribe?.json ?? outgoingSubscribe?.text ?? null,
    likelyHeartbeatMessage: outgoingHeartbeat?.json ?? outgoingHeartbeat?.text ?? (incomingHeartbeat ? { type: 'pong' } : null),
    samples: classified.slice(0, maxSamples).map((entry) => ({
      direction: entry.direction,
      kind: entry.kind,
      text: entry.text,
      json: entry.json,
    })),
  };
}

export function buildWebSocketSessionPlan(transcript = [], options = {}) {
  const analysis = analyzeWebSocketTranscript(transcript, options);
  return {
    kind: 'websocket-session-plan',
    auth: {
      enabled: analysis.authLikely,
      message: analysis.likelyAuthMessage,
    },
    subscribe: {
      enabled: analysis.subscriptionLikely,
      message: analysis.likelySubscribeMessage,
    },
    heartbeat: {
      enabled: analysis.requiresHeartbeat,
      message: analysis.likelyHeartbeatMessage,
      intervalHintMs: options.heartbeatIntervalMs ?? null,
    },
    reconnectRecommended: analysis.kinds.error > 0 || analysis.requiresHeartbeat,
    analysis,
  };
}

function normalizeSendMessage(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

function serializeMessage(message) {
  return {
    index: message.index,
    receivedAt: message.receivedAt,
    type: message.type,
    text: message.text ?? null,
    json: message.json ?? null,
    binaryBase64: message.binary ? message.binary.toString('base64') : null,
  };
}

export async function fetchWebSocketResponse(request, options = {}) {
  const response = await fetchWebSocket({
    url: request.url,
    headers: request.headers ?? {},
    sendMessage: options.sendMessage ?? normalizeSendMessage(request.body),
    sendMessages: Array.isArray(options.sendMessages) ? options.sendMessages : [],
    collectMs: options.collectMs ?? 5000,
    maxMessages: options.maxMessages ?? 100,
    terminateOn: options.terminateOn ?? null,
    proxy: request.proxy?.server ?? options.proxy ?? null,
    connectTimeoutMs: request.timeoutMs ?? options.connectTimeoutMs ?? 10000,
    binary: options.binary === true,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    heartbeatMessage: options.heartbeatMessage,
    reconnectAttempts: options.reconnectAttempts,
    reconnectDelayMs: options.reconnectDelayMs,
    reconnectOnCloseCodes: options.reconnectOnCloseCodes,
    shouldReconnect: options.shouldReconnect,
    onMessage: options.onMessage,
    refreshOn: options.refreshOn,
    authRefresh: options.authRefresh,
  });

  return {
    mode: 'websocket',
    url: request.url,
    finalUrl: request.url,
    ok: response.ok,
    status: response.ok ? 101 : 599,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-omnicrawl-transport': 'websocket',
    },
    body: JSON.stringify(response.messages.map(serializeMessage)),
    messages: response.messages,
    closeCode: response.closeCode,
    closeReason: response.closeReason,
    error: response.error,
    sessionId: request.session?.id ?? null,
    proxyServer: request.proxy?.server ?? null,
    transport: {
      protocol: request.url.startsWith('wss:') ? 'wss' : 'ws',
      connectMs: response.connectMs,
      totalMs: response.totalMs,
      attemptsUsed: response.attemptsUsed,
      reconnects: response.reconnects,
    },
    fetchedAt: new Date().toISOString(),
  };
}
