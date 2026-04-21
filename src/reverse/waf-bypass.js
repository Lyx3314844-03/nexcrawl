/**
 * WAF bypass strategies for Akamai Bot Manager, PerimeterX (HUMAN), and DataDome.
 *
 * Each WAF has distinct detection signals. This module provides:
 *   - Detection: identify which WAF is active from response headers/body
 *   - Evasion hints: header sets, timing, and browser profile recommendations
 *   - Challenge handlers: cookie injection, sensor data generation stubs
 *
 * NOTE: These techniques are for authorized testing of systems you own or have
 * explicit permission to test. Do not use against third-party sites without consent.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('waf-bypass');

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Detect which WAF is protecting a response.
 *
 * @param {Object} response - { status, headers, body }
 * @returns {{ waf: 'akamai'|'perimeterx'|'datadome'|'cloudflare'|'unknown', signals: string[] }}
 */
export function detectWaf(response) {
  const { status, headers = {}, body = '' } = response;
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const signals = [];

  // Akamai Bot Manager
  if (h['x-akamai-transformed'] || h['x-check-cacheable'] || h['akamai-origin-hop']) {
    signals.push('akamai-header');
  }
  if (body.includes('ak_bmsc') || body.includes('bm_sz') || body.includes('_abck')) {
    signals.push('akamai-cookie-script');
  }
  if (status === 403 && body.includes('Reference #')) {
    signals.push('akamai-403-reference');
  }

  // PerimeterX (HUMAN)
  if (h['x-px-vid'] || h['x-px-enforcer-telemetry']) {
    signals.push('perimeterx-header');
  }
  if (body.includes('_pxde') || body.includes('_pxvid') || body.includes('PX.render.blockPage')) {
    signals.push('perimeterx-block-page');
  }
  if (body.includes('px-captcha') || body.includes('perimeterx')) {
    signals.push('perimeterx-captcha');
  }

  // DataDome
  if (h['x-datadome-cid'] || h['x-datadome']) {
    signals.push('datadome-header');
  }
  if (body.includes('datadome') || body.includes('dd_cookie_test')) {
    signals.push('datadome-body');
  }
  if (status === 403 && h['set-cookie']?.includes('datadome')) {
    signals.push('datadome-cookie-challenge');
  }

  // Cloudflare (already handled by cloudflare-solver.js, listed for completeness)
  if (h['cf-ray'] || h['cf-mitigated']) {
    signals.push('cloudflare-header');
  }

  let waf = 'unknown';
  if (signals.some((s) => s.startsWith('akamai'))) waf = 'akamai';
  else if (signals.some((s) => s.startsWith('perimeterx'))) waf = 'perimeterx';
  else if (signals.some((s) => s.startsWith('kasada'))) waf = 'kasada';

  else if (signals.some((s) => s.startsWith('datadome'))) waf = 'datadome';
  else if (signals.some((s) => s.startsWith('cloudflare'))) waf = 'cloudflare';

  return {
    waf,
    name: waf === 'unknown' ? 'none' : waf,
    signals,
  };
}

// ─── Akamai ───────────────────────────────────────────────────────────────────

/**
 * Build Akamai-compatible request headers.
 * Akamai Bot Manager scores requests based on header order, sec-ch-ua, and cookie presence.
 *
 * @param {Object} [options]
 * @param {string} [options.userAgent]
 * @returns {Record<string, string>}
 */
export function buildAkamaiHeaders(options = {}) {
  const ua = options.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  return {
    'user-agent': ua,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'cache-control': 'max-age=0',
  };
}

/**
 * Generate a minimal Akamai sensor data payload stub.
 * Real sensor data requires browser-side execution; this stub passes basic checks.
 * For full bypass, use browser mode with the stealth profile.
 *
 * @param {string} pageUrl
 * @returns {string} JSON string for _abck cookie validation
 */
export function generateAkamaiSensorData(pageUrl) {
  const now = Date.now();
  return JSON.stringify({
    sensor_data: `2;${now};${Math.random().toString(36).slice(2)};${pageUrl};0;0;0`,
  });
}

// ─── PerimeterX ───────────────────────────────────────────────────────────────

/**
 * Build PerimeterX-compatible request headers.
 * PX scores based on TLS fingerprint, header order, and behavioral signals.
 *
 * @param {Object} [options]
 * @returns {Record<string, string>}
 */
export function buildPerimeterXHeaders(options = {}) {
  const ua = options.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  return {
    'user-agent': ua,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'cross-site',
    'te': 'trailers',
  };
}

/**
 * Browser-side JS to inject for PerimeterX evasion.
 * Patches _pxde and _pxvid to prevent detection of automation.
 *
 * @returns {string} JS snippet for page.evaluateOnNewDocument()
 */
export function buildPerimeterXEvasionScript() {
  return `
(() => {
  try {
    Object.defineProperty(window, '_pxde', { get: () => undefined, configurable: true });
    Object.defineProperty(window, '_pxvid', { get: () => undefined, configurable: true });
    // Prevent PX from reading automation flags
    const origGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptor = function(obj, prop) {
      if (prop === 'webdriver') return undefined;
      return origGetOwnPropertyDescriptor(obj, prop);
    };
  } catch (_e) {}
})();
`;
}

// ─── DataDome ─────────────────────────────────────────────────────────────────

/**
 * Build DataDome-compatible request headers.
 * DataDome is particularly sensitive to missing or inconsistent headers.
 *
 * @param {Object} [options]
 * @param {string} [options.referer]
 * @returns {Record<string, string>}
 */
export function buildDataDomeHeaders(options = {}) {
  const ua = options.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const headers = {
    'user-agent': ua,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': options.referer ? 'same-origin' : 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  };
  if (options.referer) headers['referer'] = options.referer;
  return headers;
}

/**
 * Handle a DataDome cookie challenge.
 * DataDome issues a 403 with a Set-Cookie: datadome=... that must be echoed back.
 *
 * @param {Object} response - { status, headers }
 * @returns {{ cookie: string|null, handled: boolean }}
 */
export function handleDataDomeCookieChallenge(response) {
  const setCookie = response.headers?.['set-cookie'] ?? response.headers?.['Set-Cookie'] ?? '';
  const match = String(setCookie).match(/datadome=([^;]+)/);
  if (!match) return { cookie: null, handled: false };
  return { cookie: `datadome=${match[1]}`, handled: true };
}

// ─── Unified bypass helper ────────────────────────────────────────────────────

/**
 * Get recommended bypass config for a detected WAF.
 *
 * @param {'akamai'|'perimeterx'|'datadome'|'unknown'} waf
 * @param {Object} [options]
 * @returns {{ headers: Record<string,string>, browserMode: boolean, evasionScript: string|null, notes: string[] }}
 */
/**
 * Build request headers for Kasada-protected sites.
 */
export function buildKasadaHeaders(options = {}) {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': options.lang ?? 'en-US,en;q=0.9',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  };
}

/**
 * Build an evasion script for Kasada challenges (inject via evaluateOnNewDocument).
 */
export function buildKasadaEvasionScript() {
  return `
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  `;
}

export function getWafBypassConfig(waf, options = {}) {
  switch (waf) {
    case 'akamai':
      return {
        headers: buildAkamaiHeaders(options),
        browserMode: true,
        evasionScript: null,
        notes: [
          'Use browser mode with stealth profile for full bypass',
          'Akamai requires valid _abck cookie from browser-side sensor data',
          'TLS JA3 fingerprint must match Chrome — use tlsProfile: "chrome124"',
        ],
      };
    case 'perimeterx':
      return {
        headers: buildPerimeterXHeaders(options),
        browserMode: true,
        evasionScript: buildPerimeterXEvasionScript(),
        notes: [
          'PerimeterX requires behavioral signals (mouse movement, scroll)',
          'Use behavior-simulation.js with browser mode',
          'TLS fingerprint and HTTP/2 settings must match real Chrome',
        ],
      };
    case 'datadome':
      return {
        headers: buildDataDomeHeaders(options),
        browserMode: false,
        evasionScript: null,
        notes: [
          'DataDome cookie challenge can often be handled in HTTP mode',
          'Echo back the datadome= cookie from the 403 response',
          'Rotate IPs frequently — DataDome tracks IP reputation',
        ],
      };    case 'kasada':
      return {
        requiresBrowser: true,
        headers: buildKasadaHeaders(options),
        evasionScript: buildKasadaEvasionScript(),
        notes: [
          'Kasada requires browser-based challenge solving',
          'Use chrome124 TLS profile for best results',
          'Combine with behavior simulation for anti-bot evasion',
          'See kasada-bypass.js for full challenge solving capabilities',
        ],
      };


    default:
      return {
        headers: {},
        browserMode: false,
        evasionScript: null,
        notes: ['Unknown WAF — use browser mode with full stealth profile as fallback'],
      };
  }
}
