/**
 * HTTP Header Ordering Module
 *
 * Controls the exact order of HTTP request headers to match
 * real browser behavior. Different browsers send headers in
 * specific orders, and WAFs use this for fingerprinting.
 */

// Chrome 123 header order
const CHROME_HEADER_ORDER = [
  'connection',
  'upgrade-insecure-requests',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'user-agent',
  'accept',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-user',
  'sec-fetch-dest',
  'referer',
  'accept-encoding',
  'accept-language',
  'cookie',
];

// Firefox 124 header order
const FIREFOX_HEADER_ORDER = [
  'host',
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'connection',
  'upgrade-insecure-requests',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'cookie',
  'pragma',
  'cache-control',
  'te',
];

// Safari 17 header order
const SAFARI_HEADER_ORDER = [
  'host',
  'connection',
  'accept',
  'user-agent',
  'referer',
  'accept-language',
  'accept-encoding',
  'cookie',
];

// Edge header order (similar to Chrome but with Edge-specific headers)
const EDGE_HEADER_ORDER = [
  'connection',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'upgrade-insecure-requests',
  'user-agent',
  'accept',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-user',
  'sec-fetch-dest',
  'referer',
  'accept-encoding',
  'accept-language',
  'cookie',
];

const HEADER_ORDER_MAP = {
  'chrome-123': CHROME_HEADER_ORDER,
  'chrome-latest': CHROME_HEADER_ORDER,
  'firefox-124': FIREFOX_HEADER_ORDER,
  'firefox-latest': FIREFOX_HEADER_ORDER,
  'safari-17': SAFARI_HEADER_ORDER,
  'safari-latest': SAFARI_HEADER_ORDER,
  'edge-latest': EDGE_HEADER_ORDER,
};

/**
 * Get header order for a browser profile
 */
export function getHeaderOrder(profileName = 'chrome-latest') {
  return HEADER_ORDER_MAP[profileName];
}

/**
 * Reorder headers to match browser-specific order
 * @param {Object} headers - Original headers
 * @param {string} profile - Browser profile name
 * @returns {Object} Reordered headers (as ordered array of [key, value] pairs)
 */
export function reorderHeaders(headers, profile = 'chrome-latest') {
  const order = getHeaderOrder(profile) ?? CHROME_HEADER_ORDER;
  const result = [];
  const remaining = [];

  // Normalize header keys to lowercase
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  // Add headers in browser-specific order
  for (const key of order) {
    if (normalizedHeaders[key] !== undefined) {
      result.push([key, normalizedHeaders[key]]);
      delete normalizedHeaders[key];
    }
  }

  // Add remaining headers
  for (const [key, value] of Object.entries(normalizedHeaders)) {
    remaining.push([key, value]);
  }

  return {
    ordered: result,
    remaining,
    [Symbol.iterator]: function* () {
      yield result;
      yield remaining;
    },
  };
}

/**
 * Build fetch-compatible headers with correct ordering
 * For Node.js fetch, we use Headers object which preserves insertion order
 */
export function buildOrderedFetchHeaders(headers, profile = 'chrome-latest') {
  const { ordered, remaining } = reorderHeaders(headers, profile);
  const fetchHeaders = new Headers();

  for (const [key, value] of [...ordered, ...remaining]) {
    fetchHeaders.append(key, value);
  }

  return fetchHeaders;
}

export {
  CHROME_HEADER_ORDER,
  FIREFOX_HEADER_ORDER,
  SAFARI_HEADER_ORDER,
  EDGE_HEADER_ORDER,
  HEADER_ORDER_MAP,
};
