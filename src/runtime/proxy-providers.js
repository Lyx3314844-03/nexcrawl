/**
 * ProxyProviders - Third-party proxy service integrations.
 *
 * Provides adapters for popular residential/datacenter proxy providers:
 * - Bright Data (formerly Luminati)
 * - Smartproxy
 * - Oxylabs
 * - Custom HTTP API provider
 *
 * Each adapter generates proxy URLs with authentication and supports
 * country/city targeting, session stickiness, and rotation strategies.
 *
 * Usage:
 *   const provider = createProxyProvider({ type: 'bright-data', ... });
 *   const proxyUrl = await provider.getNextProxy({ country: 'us' });
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('proxy-providers');

/**
 * @typedef {Object} ProxyProviderConfig
 * @property {'bright-data' | 'smartproxy' | 'oxylabs' | 'custom'} type
 * @property {string} endpoint - Provider gateway endpoint
 * @property {string} username - Auth username
 * @property {string} password - Auth password
 * @property {string} [zone] - Proxy zone (provider-specific)
 * @property {string} [country] - Default country code (ISO 3166-1 alpha-2)
 * @property {string} [city] - Default city
 * @property {number} [sessionDurationMinutes] - Session stickiness duration
 * @property {'round-robin' | 'random' | 'sequential'} [rotationStrategy='round-robin']
 */

/**
 * Bright Data proxy URL builder.
 * Format: http://username-zone-ZONE-country-XX-sess-XXXX:password@zproxy.lum-superproxy.io:22225
 */
class BrightDataProvider {
  constructor(config) {
    this.endpoint = config.endpoint || 'zproxy.lum-superproxy.io:22225';
    this.username = config.username;
    this.password = config.password;
    this.zone = config.zone || 'mobile';
    this.country = config.country;
    this.city = config.city;
    this.sessionDuration = config.sessionDurationMinutes;
    this.sessionCounter = 0;
  }

  buildProxyUrl(options = {}) {
    const country = options.country || this.country;
    const city = options.city || this.city;
    const sessionId = `sess${Date.now()}-${++this.sessionCounter}`;

    // Build username with lum-superproxy format
    let userPart = `${this.username}-zone-${this.zone}`;
    if (country) userPart += `-country-${country.toLowerCase()}`;
    if (city) userPart += `-city-${city.toLowerCase().replace(/\s+/g, '')}`;
    userPart += `-sess-${sessionId}`;
    if (this.sessionDuration) userPart += `-sess_time-${this.sessionDuration}`;

    const [host, port] = this.endpoint.split(':');
    return {
      server: `http://${host}:${port || 22225}`,
      username: userPart,
      password: this.password,
    };
  }

  get name() { return 'bright-data'; }
}

/**
 * Smartproxy proxy URL builder.
 * Format: http://username:password@gate.smartproxy.com:7000
 * Session: http://username-session-XXXX:password@gate.smartproxy.com:7000
 */
class SmartproxyProvider {
  constructor(config) {
    this.endpoint = config.endpoint || 'gate.smartproxy.com:7000';
    this.username = config.username;
    this.password = config.password;
    this.country = config.country;
    this.sessionCounter = 0;
  }

  buildProxyUrl(options = {}) {
    const country = options.country || this.country;
    const sessionId = `sid${Date.now()}-${++this.sessionCounter}`;

    let userPart = this.username;
    if (country) userPart += `-cc-${country.toLowerCase()}`;
    userPart += `-session-${sessionId}`;

    const [host, port] = this.endpoint.split(':');
    return {
      server: `http://${host}:${port || 7000}`,
      username: userPart,
      password: this.password,
    };
  }

  get name() { return 'smartproxy'; }
}

/**
 * Oxylabs proxy URL builder.
 * Format: http://username-cc-XX-sess-XXXX:password@pr.oxylabs.io:7777
 */
class OxylabsProvider {
  constructor(config) {
    this.endpoint = config.endpoint || 'pr.oxylabs.io:7777';
    this.username = config.username;
    this.password = config.password;
    this.country = config.country;
    this.sessionCounter = 0;
  }

  buildProxyUrl(options = {}) {
    const country = options.country || this.country;
    const sessionId = `sess${Date.now()}-${++this.sessionCounter}`;

    let userPart = this.username;
    if (country) userPart += `-cc-${country.toLowerCase()}`;
    userPart += `-sess-${sessionId}`;

    const [host, port] = this.endpoint.split(':');
    return {
      server: `http://${host}:${port || 7777}`,
      username: userPart,
      password: this.password,
    };
  }

  get name() { return 'oxylabs'; }
}

/**
 * Custom HTTP API provider.
 * Calls a remote endpoint to fetch proxy URLs on demand.
 * Expects the endpoint to return: { proxy: "http://user:pass@host:port", ttl: 60 }
 */
class CustomApiProvider {
  constructor(config) {
    this.endpoint = config.endpoint;
    this.apiKey = config.password; // Use password field as API key
    this.cache = new Map();
    this.cacheTtlMs = 60000;
  }

  async buildProxyUrl(options = {}) {
    const cacheKey = JSON.stringify(options);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.proxy;
    }

    const url = new URL(this.endpoint);
    if (options.country) url.searchParams.set('country', options.country);
    if (options.city) url.searchParams.set('city', options.city);

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(url.href, { headers });
    if (!response.ok) {
      throw new Error(`Proxy API returned status ${response.status}`);
    }

    const data = await response.json();
    const proxy = typeof data.proxy === 'string'
      ? parseProxyUrl(data.proxy)
      : data.proxy;

    this.cache.set(cacheKey, { proxy, timestamp: Date.now() });
    return proxy;
  }

  get name() { return 'custom'; }
}

/**
 * Parse a proxy URL string into a ProxyConfig object.
 * @param {string} url - e.g. "http://user:pass@host:port"
 * @returns {ProxyConfig}
 */
function parseProxyUrl(url) {
  const parsed = new URL(url);
  return {
    server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
  };
}

/**
 * Create a proxy provider instance from config.
 *
 * @param {ProxyProviderConfig} config
 * @returns {BrightDataProvider | SmartproxyProvider | OxylabsProvider | CustomApiProvider}
 */
export function createProxyProvider(config) {
  switch (config.type) {
    case 'bright-data':
      return new BrightDataProvider(config);
    case 'smartproxy':
      return new SmartproxyProvider(config);
    case 'oxylabs':
      return new OxylabsProvider(config);
    case 'custom':
      return new CustomApiProvider(config);
    default:
      throw new Error(`Unknown proxy provider type: ${config.type}. Supported: bright-data, smartproxy, oxylabs, custom`);
  }
}

/**
 * Build proxy configuration from a provider for a specific request.
 *
 * @param {Object} provider - Proxy provider instance
 * @param {Object} [options] - Request-specific options
 * @param {string} [options.country] - Target country
 * @param {string} [options.city] - Target city
 * @returns {Promise<ProxyConfig> | ProxyConfig}
 */
export function getProxyFromProvider(provider, options = {}) {
  if (typeof provider.buildProxyUrl === 'function') {
    return provider.buildProxyUrl(options);
  }
  throw new Error('Invalid proxy provider: missing buildProxyUrl method');
}

export default createProxyProvider;
