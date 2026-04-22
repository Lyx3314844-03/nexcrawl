/**
 * SOCKS5 / Tor proxy support.
 *
 * Extends the proxy pool to support SOCKS5 proxies (including Tor)
 * by integrating with the socks-proxy-agent library. Provides
 * Tor-specific helpers for circuit switching and identity renewal.
 *
 * Usage:
 *   import { createSocks5Agent, createTorAgent } from '../fetchers/socks5-proxy.js';
 *   const agent = await createSocks5Agent({ host: '127.0.0.1', port: 1080 });
 *   const resp = await fetch(url, { dispatcher: agent });
 */

import { createLogger } from '../core/logger.js';
import { AppError } from '../core/errors.js';

const log = createLogger('socks5-proxy');

// ─── SOCKS5 agent creation ──────────────────────────────────────────────────

/**
 * Create a SOCKS5 proxy agent for HTTP(S) requests.
 *
 * @param {object} config
 * @param {string}  config.host - SOCKS5 proxy host (default: 127.0.0.1)
 * @param {number}  config.port - SOCKS5 proxy port (default: 1080)
 * @param {string}  [config.username] - SOCKS5 username
 * @param {string}  [config.password] - SOCKS5 password
 * @param {boolean} [config.tls=false] - Use TLS to the proxy
 * @returns {Promise<object>} Agent with request(url, opts) method
 */
export async function createSocks5Agent(config = {}) {
  const {
    host = '127.0.0.1',
    port = 1080,
    username,
    password,
  } = config;

  const { SocksProxyAgent } = await import('socks-proxy-agent').catch(() => {
    throw new AppError(400, 'socks-proxy-agent not installed. Run: npm install socks-proxy-agent');
  });

  const proxyUrl = username && password
    ? `socks5://${username}:${password}@${host}:${port}`
    : `socks5://${host}:${port}`;

  const agent = new SocksProxyAgent(proxyUrl);
  log.info('SOCKS5 agent created', { host, port });

  return {
    agent,
    proxyUrl,

    /**
     * Make a request through the SOCKS5 proxy.
     *
     * @param {string} url
     * @param {object} [opts]
     * @returns {Promise<Response>}
     */
    /**
     * Make a request through the SOCKS5 proxy.
     * Requires Node.js 18.2+ with undici-based global fetch.
     * For older Node.js versions, use the agent directly with http.request.
     *
     * @param {string} url
     * @param {object} [opts]
     * @returns {Promise<Response>}
     */
    async request(url, opts = {}) {
      // Node.js global fetch supports dispatcher option (undici-based)
      if (typeof globalThis.fetch === 'function') {
        try {
          const resp = await fetch(url, { ...opts, dispatcher: agent });
          return resp;
        } catch (err) {
          if (err.message?.includes('dispatcher')) {
            log.warn('fetch dispatcher not supported – falling back to http.request');
          } else {
            throw err;
          }
        }
      }
      // Fallback for older Node.js: use http.request with the agent
      const { request: httpRequest } = await import('node:http');
      return new Promise((resolve, reject) => {
        const req = httpRequest(new URL(url), { ...opts, agent }, (res) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const responseText = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode,
              body: responseText,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              json: () => Promise.resolve(JSON.parse(responseText)),
              text: () => Promise.resolve(responseText),
              url,
              statusText: res.statusMessage || '',
              clone: () => Promise.resolve(null),
              headers: {
                get: (name) => res.headers?.[name.toLowerCase()],
                has: (name) => name.toLowerCase() in (res.headers ?? {}),
                entries: () => Object.entries(res.headers ?? {}),
              },
            });
          });
        });
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
      });
    },
  };
}

// ─── Tor-specific agent ──────────────────────────────────────────────────────

/**
 * Create a Tor-specific proxy agent.
 *
 * Connects to the Tor SOCKS5 port (default 9050) and provides
 * helpers for renewing the Tor circuit (getting a new exit IP).
 *
 * @param {object} [config]
 * @param {string}  [config.host='127.0.0.1'] - Tor SOCKS host
 * @param {number}  [config.socksPort=9050]   - Tor SOCKS5 port
 * @param {number}  [config.controlPort=9051]  - Tor control port
 * @param {string}  [config.controlPassword]   - Tor control password
 * @returns {Promise<object>} Tor agent with renewIdentity() method
 */
export async function createTorAgent(config = {}) {
  const {
    host = '127.0.0.1',
    socksPort = 9050,
    controlPort = 9051,
    controlPassword,
  } = config;

  const socks5 = await createSocks5Agent({ host, port: socksPort });

  log.info('Tor agent created', { host, socksPort, controlPort });

  return {
    ...socks5,

    /**
     * Request a new Tor circuit (new exit IP).
     * Sends SIGNAL NEWNYM via the Tor control port.
     *
     * @returns {Promise<boolean>}
     */
    async renewIdentity() {
      const { createConnection } = await import('node:net');

      return new Promise((resolve) => {
        const sock = createConnection({ host, port: controlPort }, () => {
          if (controlPassword) {
            sock.write(`AUTHENTICATE "${controlPassword}"\r\n`);
          } else {
            sock.write('AUTHENTICATE ""\r\n');
          }
          sock.write('SIGNAL NEWNYM\r\n');
          sock.write('QUIT\r\n');
        });

        let data = '';
        sock.on('data', (chunk) => { data += chunk.toString(); });
        sock.on('close', () => {
          const ok = data.includes('250');
          if (ok) {
            log.info('Tor identity renewed');
          } else {
            log.warn('Tor identity renewal failed', { data: data.trim() });
          }
          resolve(ok);
        });
        sock.on('error', (err) => {
          log.warn('Tor control connection error', { error: err.message });
          resolve(false);
        });
      });
    },

    /**
     * Check if the Tor connection is working by fetching the check endpoint.
     *
     * @returns {Promise<{isTor: boolean, ip: string}>}
     */
    async checkTorConnection() {
      try {
        const resp = await socks5.request('https://check.torproject.org/api/ip');
        const data = await resp.json();
        const isTor = data.IsTor ?? false;
        log.info('Tor connection check', { isTor, ip: data.IP });
        return { isTor, ip: data.IP ?? 'unknown' };
      } catch (err) {
        log.warn('Tor connection check failed', { error: err.message });
        return { isTor: false, ip: 'unknown' };
      }
    },
  };
}

// ─── Proxy pool integration ──────────────────────────────────────────────────

/**
 * Normalize a SOCKS5 proxy URL for the proxy pool.
 *
 * @param {string} proxyUrl - socks5://[user:pass@]host:port
 * @returns {{ protocol: 'socks5', host: string, port: number, username: string|null, password: string|null }}
 */
export function normalizeSocks5Proxy(proxyUrl) {
  const url = new URL(proxyUrl);
  return {
    protocol: 'socks5',
    host: url.hostname,
    port: parseInt(url.port, 10),
    username: url.username || null,
    password: url.password || null,
  };
}
