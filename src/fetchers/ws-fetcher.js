/**
 * WebSocket crawler — connect, send messages, collect responses, and close.
 *
 * Supports:
 *   - Plain WS and WSS connections
 *   - Custom headers and proxy tunneling (via http-proxy-agent)
 *   - Message collection with timeout
 *   - JSON and binary message handling
 *   - Subscription pattern (send a subscribe message, collect N responses)
 */

import { createRequire } from 'node:module';
import { createLogger } from '../core/logger.js';

const require = createRequire(import.meta.url);
const wsPackage = require('ws');
const WebSocket = wsPackage.WebSocket ?? wsPackage.default ?? wsPackage;

const log = createLogger('ws-fetcher');

/**
 * @typedef {Object} WsRequest
 * @property {string} url - WebSocket URL (ws:// or wss://)
 * @property {Record<string,string>} [headers] - Additional handshake headers
 * @property {string|Object|null} [sendMessage] - Message to send after connect (JSON-serialized if object)
 * @property {string[]|Object[]} [sendMessages] - Multiple messages to send in sequence
 * @property {number} [collectMs=5000] - How long to collect messages (ms)
 * @property {number} [maxMessages=100] - Stop collecting after this many messages
 * @property {string} [terminateOn] - Stop when a message contains this string
 * @property {string} [proxy] - HTTP proxy URL for tunneling (e.g. http://user:pass@host:8080)
 * @property {number} [connectTimeoutMs=10000]
 * @property {boolean} [binary=false] - Collect binary frames as Buffer
 */

/**
 * @typedef {Object} WsMessage
 * @property {number} index
 * @property {number} receivedAt - Unix ms timestamp
 * @property {'text'|'binary'} type
 * @property {string|null} text
 * @property {Object|null} json - Parsed JSON if text is valid JSON
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
 */

/**
 * Connect to a WebSocket, optionally send messages, collect responses, and close.
 *
 * @param {WsRequest} request
 * @returns {Promise<WsResponse>}
 */
export async function fetchWebSocket(request) {
  const {
    url,
    headers = {},
    sendMessage = null,
    sendMessages = [],
    collectMs = 5000,
    maxMessages = 100,
    terminateOn = null,
    proxy = null,
    connectTimeoutMs = 10000,
    binary = false,
  } = request;

  const startAt = Date.now();
  const messages = [];
  let connectMs = 0;
  let closeCode = null;
  let closeReason = null;

  const wsOptions = { headers };

  // Proxy support via http-proxy-agent
  if (proxy) {
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      wsOptions.agent = new HttpsProxyAgent(proxy);
    } catch {
      log.warn('proxy agent unavailable, connecting without proxy');
    }
  }

  return new Promise((resolve) => {
    let ws;
    let connectTimer;
    let collectTimer;
    let settled = false;

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(collectTimer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve({
        url,
        ok: error === null,
        connectMs,
        totalMs: Date.now() - startAt,
        messages,
        closeCode,
        closeReason,
        error: error ? String(error) : null,
      });
    }

    try {
      ws = new WebSocket(url, wsOptions);
    } catch (err) {
      return finish(err);
    }

    connectTimer = setTimeout(() => finish(new Error('connect timeout')), connectTimeoutMs);

    ws.on('open', () => {
      connectMs = Date.now() - startAt;
      clearTimeout(connectTimer);

      // Send messages
      const toSend = [
        ...(sendMessage !== null ? [sendMessage] : []),
        ...sendMessages,
      ];
      for (const msg of toSend) {
        try {
          ws.send(typeof msg === 'object' ? JSON.stringify(msg) : String(msg));
        } catch (err) {
          log.warn('ws send error', { error: err.message });
        }
      }

      // Start collection timeout
      collectTimer = setTimeout(() => finish(), collectMs);
    });

    ws.on('message', (data, isBinary) => {
      const index = messages.length;
      let text = null;
      let json = null;
      let binData = null;

      if (isBinary || binary) {
        binData = Buffer.isBuffer(data) ? data : Buffer.from(data);
      } else {
        text = data.toString('utf8');
        try { json = JSON.parse(text); } catch { /* not JSON */ }
      }

      messages.push({ index, receivedAt: Date.now(), type: isBinary ? 'binary' : 'text', text, json, binary: binData });

      if (messages.length >= maxMessages) return finish();
      if (terminateOn && text?.includes(terminateOn)) return finish();
    });

    ws.on('close', (code, reason) => {
      closeCode = code;
      closeReason = reason?.toString() ?? null;
      finish();
    });

    ws.on('error', (err) => finish(err));
  });
}

/**
 * Subscribe to a WebSocket stream and collect messages until timeout or maxMessages.
 * Convenience wrapper around fetchWebSocket for pub/sub patterns.
 *
 * @param {string} url
 * @param {Object|string} subscribeMessage - Subscription payload
 * @param {Object} [options]
 * @param {number} [options.collectMs=10000]
 * @param {number} [options.maxMessages=200]
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
    },
    fetchedAt: new Date().toISOString(),
  };
}
