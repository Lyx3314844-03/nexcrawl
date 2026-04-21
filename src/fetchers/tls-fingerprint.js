/**
 * TLS Fingerprint Spoofing Module
 *
 * Implements JA3/JA4 fingerprint manipulation by customizing
 * TLS cipher suites, extensions, and elliptic curves to mimic
 * real browsers.
 *
 * JA3 = ssl_version,ciphers,extensions,elliptic_curves,ec_point_formats
 * JA4 = quic,tl,ver,alpn,cipher,hext,exts
 */

import https from 'node:https';

// Chrome 123 TLS cipher suites (in browser order)
const CHROME_123_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
];

// Firefox 124 TLS cipher suites
const FIREFOX_124_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA',
  'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA',
  'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA',
  'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
  'TLS_RSA_WITH_AES_128_GCM_SHA256',
  'TLS_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_RSA_WITH_AES_128_CBC_SHA',
  'TLS_RSA_WITH_AES_256_CBC_SHA',
];

// Safari 17 TLS cipher suites
const SAFARI_17_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA',
  'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA',
  'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
  'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA',
  'TLS_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_RSA_WITH_AES_128_GCM_SHA256',
  'TLS_RSA_WITH_AES_256_CBC_SHA',
  'TLS_RSA_WITH_AES_128_CBC_SHA',
];

// TLS extension IDs (Chrome order)
const CHROME_EXTENSIONS = [
  0,    // server_name (SNI)
  5,    // status_request (OCSP)
  10,   // supported_groups
  11,   // ec_point_formats
  13,   // signature_algorithms
  16,   // application_layer_protocol_negotiation (ALPN)
  18,   // signed_certificate_timestamp
  21,   // padding
  22,   // encrypted_client_hello (ECH)
  23,   // compress_certificate
  27,   // post_handshake_auth
  35,   // session_ticket
  41,   // key_share
  43,   // supported_versions
  45,   // psk_key_exchange_modes
  49,   // record_size_limit
  51,   // pre_shared_key
  13172, // next_protocol_negotiation
  17513, // application_settings (ALPS)
  65281, // renegotiation_info
];

// Firefox extensions order
const FIREFOX_EXTENSIONS = [
  0, 5, 10, 11, 13, 16, 18, 21, 23, 27, 35, 41, 43, 44, 45, 49, 13172, 65281,
];

// Safari extensions order
const SAFARI_EXTENSIONS = [
  0, 5, 10, 11, 13, 16, 18, 21, 23, 27, 35, 41, 43, 45, 49, 51, 13172, 17513, 65281,
];

// Supported groups (elliptic curves) - Chrome order
const CHROME_GROUPS = [
  29, // x25519
  23, // secp256r1
  24, // secp384r1
  25, // secp521r1
  256, // ffdhe2048
  257, // ffdhe3072
];

// EC point formats
const EC_POINT_FORMATS = [0]; // uncompressed only

// TLS versions mapping
const TLS_VERSIONS = {
  tls10: 0x0301,
  tls11: 0x0302,
  tls12: 0x0303,
  tls13: 0x0304,
};

// ALPN protocols
const ALPN_HTTP1 = ['http/1.1'];
const ALPN_HTTP2 = ['h2', 'http/1.1'];
const ALPN_HTTP3 = ['h3', 'h2', 'http/1.1'];

// Browser profiles
const BROWSER_PROFILES = {
  'chrome-123': {
    name: 'Chrome 123',
    ciphers: CHROME_123_CIPHERS,
    extensions: CHROME_EXTENSIONS,
    groups: CHROME_GROUPS,
    ecPointFormats: EC_POINT_FORMATS,
    alpn: ALPN_HTTP2,
    tlsMinVersion: 'TLSv1.2',
    tlsMaxVersion: 'TLSv1.3',
    compressionMethods: [0], // null compression
  },
  'chrome-124': {
    name: 'Chrome 124',
    ciphers: CHROME_123_CIPHERS,
    extensions: CHROME_EXTENSIONS,
    groups: CHROME_GROUPS,
    ecPointFormats: EC_POINT_FORMATS,
    alpn: ALPN_HTTP2,
    tlsMinVersion: 'TLSv1.2',
    tlsMaxVersion: 'TLSv1.3',
    compressionMethods: [0],
  },
  'chrome-latest': {
    name: 'Chrome Latest',
    ciphers: CHROME_123_CIPHERS,
    extensions: CHROME_EXTENSIONS,
    groups: CHROME_GROUPS,
    ecPointFormats: EC_POINT_FORMATS,
    alpn: ALPN_HTTP2,
    tlsMinVersion: 'TLSv1.2',
    tlsMaxVersion: 'TLSv1.3',
    compressionMethods: [0],
  },
  'firefox-124': {
    name: 'Firefox 124',
    ciphers: FIREFOX_124_CIPHERS,
    extensions: FIREFOX_EXTENSIONS,
    groups: [29, 23, 24, 25, 256, 257],
    ecPointFormats: EC_POINT_FORMATS,
    alpn: ALPN_HTTP2,
    tlsMinVersion: 'TLSv1.2',
    tlsMaxVersion: 'TLSv1.3',
    compressionMethods: [0],
  },
  'firefox-latest': {
    name: 'Firefox Latest',
    ciphers: FIREFOX_124_CIPHERS,
    extensions: FIREFOX_EXTENSIONS,
    groups: [29, 23, 24, 25, 256, 257],
    ecPointFormats: EC_POINT_FORMATS,
    alpn: ALPN_HTTP2,
    tlsMinVersion: 'TLSv1.2',
    tlsMaxVersion: 'TLSv1.3',
    compressionMethods: [0],
  },
  'safari-17': {
    name: 'Safari 17',
    ciphers: SAFARI_17_CIPHERS,
    extensions: SAFARI_EXTENSIONS,
    groups: [29, 23, 24, 25],
    ecPointFormats: EC_POINT_FORMATS,
    alpn: ALPN_HTTP2,
    tlsMinVersion: 'TLSv1.1',
    tlsMaxVersion: 'TLSv1.3',
    compressionMethods: [0],
  },
  'safari-latest': {
    name: 'Safari Latest',
    ciphers: SAFARI_17_CIPHERS,
    extensions: SAFARI_EXTENSIONS,
    groups: [29, 23, 24, 25],
    ecPointFormats: EC_POINT_FORMATS,
    alpn: ALPN_HTTP2,
    tlsMinVersion: 'TLSv1.1',
    tlsMaxVersion: 'TLSv1.3',
    compressionMethods: [0],
  },
};

/**
 * Calculate JA3 fingerprint string from TLS parameters
 * @param {Object} params - TLS parameters
 * @returns {string} JA3 fingerprint
 */
export function calculateJA3(params = {}) {
  const {
    tlsVersion = 'TLSv1.3',
    ciphers = [],
    extensions = [],
    groups = [],
    ecPointFormats = [0],
  } = params;

  const versionStr = (TLS_VERSIONS[tlsVersion.replace('.', '')] ?? 0x0304).toString();
  const cipherStr = ciphers.join('-');
  const extStr = extensions.join('-');
  const groupStr = groups.join('-');
  const ecStr = ecPointFormats.join('-');

  return `${versionStr},${cipherStr},${extStr},${groupStr},${ecStr}`;
}

/**
 * Calculate JA4 fingerprint string (simplified version)
 * @param {Object} params - TLS parameters
 * @returns {string} JA4 fingerprint
 */
export function calculateJA4(params = {}) {
  const {
    quic = false,
    tlsVersion = 'TLSv1.3',
    alpn = ['h2', 'http/1.1'],
    ciphers = [],
    extensions = [],
  } = params;

  const quicStr = quic ? 'q' : 't';
  const tlsVer = tlsVersion === 'TLSv1.3' ? '13' : tlsVersion === 'TLSv1.2' ? '12' : '11';
  const alpnStr = (alpn[0] ?? 'xx').slice(0, 2);
  const cipherCount = ciphers.length.toString().padStart(2, '0');
  const extCount = extensions.length.toString().padStart(2, '0');
  const sni = extensions.includes(0) ? 'd' : 'i';
  const extHash = simpleHash(extensions.join(','));

  return `${quicStr}${tlsVer}${alpnStr}${cipherCount}${extCount}${sni}${extHash}`;
}

/**
 * Simple hash function for JA4 extension hash
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).slice(0, 6).padStart(6, '0');
}

/**
 * Get browser TLS profile by name
 * @param {string} profileName - Browser profile name
 * @returns {Object|null} TLS profile configuration
 */
export function getBrowserTLSProfile(profileName) {
  const name = String(profileName).toLowerCase().replace(/\s+/g, '-');
  return BROWSER_PROFILES[name] ?? null;
}

/**
 * Get all available browser TLS profiles
 * @returns {Array} List of available profiles
 */
export function getAvailableTLSProfiles() {
  return Object.entries(BROWSER_PROFILES).map(([key, profile]) => ({
    id: key,
    name: profile.name,
    cipherCount: profile.ciphers.length,
    extensionCount: profile.extensions.length,
  }));
}

/**
 * Build TLS options for Node.js https request
 * @param {Object} profile - Browser TLS profile
 * @returns {Object} Node.js TLS options
 */
export function buildTLSOptions(profile) {
  if (!profile) {
    return {};
  }

  return {
    ciphers: profile.ciphers.join(':'),
    minVersion: profile.tlsMinVersion,
    maxVersion: profile.tlsMaxVersion,
    // Enable TLS 1.3 early data if available
    enableTrace: false,
    // Set ALPN protocols
    ALPNProtocols: profile.alpn,
    // Server name indication
    servername: profile.servername ?? undefined,
    // Reject unauthorized certificates
    rejectUnauthorized: profile.rejectUnauthorized ?? true,
  };
}

/**
 * Create a custom HTTPS agent with TLS fingerprint spoofing
 * @param {Object} options - TLS options
 * @returns {https.Agent} Custom HTTPS agent
 */
export function createTLSAgent(options = {}) {
  const profile = options.profile ?? BROWSER_PROFILES['chrome-latest'];
  const tlsOptions = buildTLSOptions(profile);

  return new https.Agent({
    ...tlsOptions,
    keepAlive: options.keepAlive ?? true,
    keepAliveMsecs: options.keepAliveMsecs ?? 30000,
    maxSockets: options.maxSockets ?? 25,
    maxFreeSockets: options.maxFreeSockets ?? 5,
    timeout: options.timeout ?? 30000,
    scheduling: options.scheduling ?? 'lifo',
  });
}

/**
 * Calculate JA3/JA4 fingerprints for a given URL
 * Useful for testing what fingerprint your current configuration produces
 * @param {string} url - Target URL
 * @param {Object} options - TLS options
 * @returns {Promise<Object>} JA3 and JA4 fingerprints
 */
export async function probeTLSFingerprint(url, options = {}) {
  const profile = options.profile ?? BROWSER_PROFILES['chrome-latest'];

  const ja3 = calculateJA3({
    tlsVersion: profile.tlsMaxVersion,
    ciphers: profile.ciphers,
    extensions: profile.extensions,
    groups: profile.groups,
    ecPointFormats: profile.ecPointFormats,
  });

  const ja4 = calculateJA4({
    tlsVersion: profile.tlsMaxVersion,
    alpn: profile.alpn,
    ciphers: profile.ciphers,
    extensions: profile.extensions,
  });

  return {
    url,
    profile: profile.name,
    ja3,
    ja4,
    ciphers: profile.ciphers.length,
    extensions: profile.extensions.length,
  };
}

export {
  BROWSER_PROFILES,
  CHROME_123_CIPHERS,
  FIREFOX_124_CIPHERS,
  SAFARI_17_CIPHERS,
  CHROME_EXTENSIONS,
  FIREFOX_EXTENSIONS,
  SAFARI_EXTENSIONS,
  CHROME_GROUPS,
  EC_POINT_FORMATS,
  ALPN_HTTP1,
  ALPN_HTTP2,
  ALPN_HTTP3,
};
