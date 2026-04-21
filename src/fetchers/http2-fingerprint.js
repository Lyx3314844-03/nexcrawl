/**
 * HTTP/2 Settings Simulation Module
 *
 * Simulates browser-specific HTTP/2 SETTINGS frames and pseudo-header ordering
 * to avoid HTTP/2 fingerprint-based bot detection.
 *
 * HTTP/2 fingerprint = SETTINGS frame parameters + pseudo-header order + header order
 */

// Chrome 123 HTTP/2 SETTINGS frame
const CHROME_H2_SETTINGS = {
  SETTINGS_HEADER_TABLE_SIZE: 65536,
  SETTINGS_ENABLE_PUSH: true,
  SETTINGS_INITIAL_WINDOW_SIZE: 6291456,
  SETTINGS_MAX_HEADER_LIST_SIZE: 262144,
  // Chrome-specific: SETTINGS_ENABLE_CONNECT_PROTOCOL is not sent
};

// Chrome HTTP/2 pseudo-header order
const CHROME_PSEUDO_HEADER_ORDER = [
  ':method',
  ':authority',
  ':scheme',
  ':path',
];

// Firefox 124 HTTP/2 SETTINGS frame
const FIREFOX_H2_SETTINGS = {
  SETTINGS_HEADER_TABLE_SIZE: 65536,
  SETTINGS_ENABLE_PUSH: false,
  SETTINGS_INITIAL_WINDOW_SIZE: 131072,
  SETTINGS_MAX_FRAME_SIZE: 16384,
};

// Firefox HTTP/2 pseudo-header order
const FIREFOX_PSEUDO_HEADER_ORDER = [
  ':method',
  ':path',
  ':authority',
  ':scheme',
];

// Safari 17 HTTP/2 SETTINGS frame
const SAFARI_H2_SETTINGS = {
  SETTINGS_HEADER_TABLE_SIZE: 4096,
  SETTINGS_ENABLE_PUSH: true,
  SETTINGS_INITIAL_WINDOW_SIZE: 2097152,
  SETTINGS_MAX_HEADER_LIST_SIZE: 262144,
};

// Safari HTTP/2 pseudo-header order
const SAFARI_PSEUDO_HEADER_ORDER = [
  ':method',
  ':scheme',
  ':path',
  ':authority',
];

// HTTP/2 stream dependency priorities (Chrome)
const CHROME_STREAM_PRIORITIES = [
  { stream: 1, parent: 0, weight: 201, exclusive: false }, // H2 stream 1 (often settings/ack)
  { stream: 3, parent: 0, weight: 101, exclusive: false }, // H2 stream 3
  { stream: 5, parent: 0, weight: 1, exclusive: false },   // H2 stream 5
  { stream: 7, parent: 0, weight: 1, exclusive: false },   // H2 stream 7
  { stream: 9, parent: 7, weight: 1, exclusive: false },   // H2 stream 9 depends on 7
  { stream: 11, parent: 3, weight: 1, exclusive: false },  // H2 stream 11 depends on 3
  { stream: 13, parent: 0, weight: 241, exclusive: false }, // H2 stream 13
];

// Firefox stream priorities
const FIREFOX_STREAM_PRIORITIES = [
  { stream: 1, parent: 0, weight: 1, exclusive: false },
  { stream: 3, parent: 1, weight: 1, exclusive: false },
  { stream: 5, parent: 0, weight: 1, exclusive: false },
  { stream: 7, parent: 0, weight: 1, exclusive: false },
];

// Safari stream priorities
const SAFARI_STREAM_PRIORITIES = [
  { stream: 1, parent: 0, weight: 256, exclusive: false },
  { stream: 3, parent: 0, weight: 256, exclusive: false },
];

// Connection preface (all browsers send this)
const H2_CONNECTION_PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';

// Browser profiles for HTTP/2 fingerprinting
const H2_BROWSER_PROFILES = {
  'chrome-123': {
    name: 'Chrome 123',
    settings: CHROME_H2_SETTINGS,
    pseudoHeaderOrder: CHROME_PSEUDO_HEADER_ORDER,
    headerOrder: getHeaderOrder('chrome-123'),
    streamPriorities: CHROME_STREAM_PRIORITIES,
    connectionPreface: H2_CONNECTION_PREFACE,
  },
  'chrome-latest': {
    name: 'Chrome Latest',
    settings: CHROME_H2_SETTINGS,
    pseudoHeaderOrder: CHROME_PSEUDO_HEADER_ORDER,
    headerOrder: getHeaderOrder('chrome-latest'),
    streamPriorities: CHROME_STREAM_PRIORITIES,
    connectionPreface: H2_CONNECTION_PREFACE,
  },
  'firefox-124': {
    name: 'Firefox 124',
    settings: FIREFOX_H2_SETTINGS,
    pseudoHeaderOrder: FIREFOX_PSEUDO_HEADER_ORDER,
    headerOrder: getHeaderOrder('firefox-124'),
    streamPriorities: FIREFOX_STREAM_PRIORITIES,
    connectionPreface: H2_CONNECTION_PREFACE,
  },
  'firefox-latest': {
    name: 'Firefox Latest',
    settings: FIREFOX_H2_SETTINGS,
    pseudoHeaderOrder: FIREFOX_PSEUDO_HEADER_ORDER,
    headerOrder: getHeaderOrder('firefox-latest'),
    streamPriorities: FIREFOX_STREAM_PRIORITIES,
    connectionPreface: H2_CONNECTION_PREFACE,
  },
  'safari-17': {
    name: 'Safari 17',
    settings: SAFARI_H2_SETTINGS,
    pseudoHeaderOrder: SAFARI_PSEUDO_HEADER_ORDER,
    headerOrder: getHeaderOrder('safari-17'),
    streamPriorities: SAFARI_STREAM_PRIORITIES,
    connectionPreface: H2_CONNECTION_PREFACE,
  },
  'safari-latest': {
    name: 'Safari Latest',
    settings: SAFARI_H2_SETTINGS,
    pseudoHeaderOrder: SAFARI_PSEUDO_HEADER_ORDER,
    headerOrder: getHeaderOrder('safari-latest'),
    streamPriorities: SAFARI_STREAM_PRIORITIES,
    connectionPreface: H2_CONNECTION_PREFACE,
  },
};

/**
 * Get HTTP/2 browser profile by name
 */
export function getH2BrowserProfile(profileName) {
  const name = String(profileName).toLowerCase().replace(/\s+/g, '-');
  return H2_BROWSER_PROFILES[name] ?? null;
}

/**
 * Get all available HTTP/2 browser profiles
 */
export function getAvailableH2Profiles() {
  return Object.entries(H2_BROWSER_PROFILES).map(([key, profile]) => ({
    id: key,
    name: profile.name,
    settingsCount: Object.keys(profile.settings).length,
    streamCount: profile.streamPriorities.length,
  }));
}

/**
 * Build HTTP/2 request headers with browser-specific pseudo-header order
 * @param {Object} request - Request configuration
 * @param {Object} profile - HTTP/2 browser profile
 * @returns {Object} Ordered headers
 */
export function buildH2Headers(request, profile) {
  const { url, method = 'GET', headers = {} } = request;
  const parsedUrl = new URL(url);
  const pseudoOrder = profile?.pseudoHeaderOrder ?? CHROME_PSEUDO_HEADER_ORDER;

  // Build pseudo-headers in browser-specific order
  const pseudoHeaders = {};
  for (const name of pseudoOrder) {
    switch (name) {
      case ':method':
        pseudoHeaders[':method'] = method.toUpperCase();
        break;
      case ':authority':
        pseudoHeaders[':authority'] = parsedUrl.host;
        break;
      case ':scheme':
        pseudoHeaders[':scheme'] = parsedUrl.protocol.replace(':', '');
        break;
      case ':path':
        pseudoHeaders[':path'] = parsedUrl.pathname + parsedUrl.search;
        break;
    }
  }

  // Merge with regular headers (pseudo-headers come first in HTTP/2)
  return { ...pseudoHeaders, ...headers };
}

/**
 * Generate HTTP/2 SETTINGS frame payload
 * @param {Object} settings - SETTINGS parameters
 * @returns {Buffer} SETTINGS frame bytes
 */
export function buildSettingsFrame(settings) {
  const settingsEntries = Object.entries(settings).filter(([_, v]) => v !== undefined);
  const payloadLength = settingsEntries.length * 6;
  const frame = Buffer.alloc(9 + payloadLength);
  let offset = 9; // Skip frame header

  // Length of payload
  frame.writeUIntBE(payloadLength, 0, 3);
  frame.writeUInt8(0x04, 3); // Type: SETTINGS
  frame.writeUInt8(0x00, 4); // Flags: none
  frame.writeUInt32BE(0, 5); // Stream 0 (settings must be on stream 0)

  // Write settings entries
  for (const [key, value] of settingsEntries) {
    const settingId = SETTING_ID_MAP[key];
    if (settingId !== undefined) {
      frame.writeUInt16BE(settingId, offset);
      frame.writeUInt32BE(value === true ? 1 : value, offset + 2);
      offset += 6;
    }
  }

  return frame.slice(0, offset);
}

// HTTP/2 SETTINGS parameter IDs (RFC 7540)
const SETTING_ID_MAP = {
  SETTINGS_HEADER_TABLE_SIZE: 0x1,
  SETTINGS_ENABLE_PUSH: 0x2,
  SETTINGS_MAX_CONCURRENT_STREAMS: 0x3,
  SETTINGS_INITIAL_WINDOW_SIZE: 0x4,
  SETTINGS_MAX_FRAME_SIZE: 0x5,
  SETTINGS_MAX_HEADER_LIST_SIZE: 0x6,
  SETTINGS_ENABLE_CONNECT_PROTOCOL: 0x8,
};

/**
 * Get HTTP/2 fingerprint summary for a browser profile
 * @param {Object} profile - HTTP/2 browser profile
 * @returns {Object} Fingerprint summary
 */
export function getH2FingerprintSummary(profile) {
  if (!profile) {
    return { available: false };
  }

  return {
    available: true,
    name: profile.name,
    settings: profile.settings,
    pseudoHeaderOrder: profile.pseudoHeaderOrder.join(', '),
    streamPriorityCount: profile.streamPriorities.length,
    hasConnectionPreface: Boolean(profile.connectionPreface),
  };
}

/**
 * Build undici dispatcher options for HTTP/2 fingerprint simulation
 * This is used when undici is available for HTTP/2 support
 * @param {Object} options - Configuration options
 * @returns {Object} Undici dispatcher options
 */
export function buildUndiciOptions(options = {}) {
  const { tlsProfile, h2Profile } = options;
  const h2 = typeof h2Profile === 'string'
    ? getH2BrowserProfile(h2Profile)
    : h2Profile;

  return {
    // HTTP/2 specific options
    allowH2: true,
    maxConcurrentStreams: h2?.settings.SETTINGS_MAX_CONCURRENT_STREAMS ?? 100,
    initialWindowSize: h2?.settings.SETTINGS_INITIAL_WINDOW_SIZE ?? 6291456,
    headerTableSize: h2?.settings.SETTINGS_HEADER_TABLE_SIZE ?? 65536,
    maxHeaderListSize: h2?.settings.SETTINGS_MAX_HEADER_LIST_SIZE ?? 262144,
    // Pseudo-header order (for custom dispatcher implementation)
    pseudoHeaderOrder: h2?.pseudoHeaderOrder ?? CHROME_PSEUDO_HEADER_ORDER,
  };
}

export function buildHttp2SessionOptions(options = {}) {
  const { tlsProfile, h2Profile } = options;
  const h2 = typeof h2Profile === 'string'
    ? getH2BrowserProfile(h2Profile)
    : h2Profile;

  return {
    allowHTTP1: false,
    settings: { ...(h2?.settings ?? {}) },
    peerMaxConcurrentStreams: h2?.settings?.SETTINGS_MAX_CONCURRENT_STREAMS ?? 100,
    pseudoHeaderOrder: h2?.pseudoHeaderOrder ?? CHROME_PSEUDO_HEADER_ORDER,
    headerOrder: h2?.headerOrder ?? getHeaderOrder(typeof tlsProfile === 'string' ? tlsProfile : 'chrome-latest'),
  };
}

export {
  H2_BROWSER_PROFILES,
  CHROME_H2_SETTINGS,
  FIREFOX_H2_SETTINGS,
  SAFARI_H2_SETTINGS,
  CHROME_PSEUDO_HEADER_ORDER,
  FIREFOX_PSEUDO_HEADER_ORDER,
  SAFARI_PSEUDO_HEADER_ORDER,
  CHROME_STREAM_PRIORITIES,
  FIREFOX_STREAM_PRIORITIES,
  SAFARI_STREAM_PRIORITIES,
  H2_CONNECTION_PREFACE,
};
import { getHeaderOrder } from './header-order.js';
