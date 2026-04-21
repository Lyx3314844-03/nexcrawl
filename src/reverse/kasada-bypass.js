/**
 * Kasada WAF bypass module.
 *
 * Kasada uses a JavaScript challenge (KPD payload) that generates
 * the x-kpsdk-* headers required for subsequent requests.
 * This module detects Kasada-protected sites, extracts the challenge
 * script, and attempts to solve it inside a browser sandbox.
 *
 * NOTE: Techniques are intended for authorized testing only.
 */

import { createLogger } from '../core/logger.js';
import { AppError } from '../core/errors.js';

const log = createLogger('kasada-bypass');

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Detect whether a response is protected by Kasada WAF.
 *
 * @param {object} resp - Crawl response object
 * @returns {{ detected: boolean, signals: string[], name: string }}
 */
export function detectKasada(resp) {
  const signals = [];
  const headers = normalizeHeaders(resp.headers ?? {});
  const body = typeof resp.body === 'string' ? resp.body : '';

  if (headers['x-kpsdk-ct']) signals.push('x-kpsdk-ct');
  if (headers['x-kpsdk-st']) signals.push('x-kpsdk-st');
  if (headers['x-kpsdk-cd']) signals.push('x-kpsdk-cd');

  if (body.includes('Kpsdk') || body.includes('kpsdk')) signals.push('body:kpsdk-ref');
  if (body.includes('kpsdk_cd') || body.includes('kpsdk_ct')) signals.push('body:kpsdk-cd-ct');
  if (body.includes('cdn.stitial.com') || body.includes('kasada')) signals.push('body:kasada-cdn');
  if (resp.status === 403 && signals.length > 0) signals.push('status:403-kasada');

  return {
    detected: signals.length > 0,
    signals,
    name: 'kasada',
  };
}

// ─── Challenge extraction ────────────────────────────────────────────────────

/**
 * Extract the Kasada challenge script from the response body.
 *
 * @param {string} body - HTML body of the challenge page
 * @returns {{ scriptUrl: string|null, payload: string|null, stValue: string|null }}
 */
export function extractKasadaChallenge(body) {
  const scriptUrl = body.match(/src=["']([\/][\/]cdn\.stitial\.com\/[^"']+)["']/)?.[1] ?? null;
  const payload = body.match(/KPSDK_PAYLOAD\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
  const stValue = body.match(/x-kpsdk-st["']?\s*:\s*["']([^"']+)["']/)?.[1] ?? null;
  return { scriptUrl: scriptUrl ? 'https:' + scriptUrl : null, payload, stValue };
}

// ─── Browser-based solving ───────────────────────────────────────────────────

/**
 * Solve a Kasada challenge using a browser page.
 *
 * @param {import('playwright').Page | import('puppeteer').Page} page
 * @param {string} targetUrl
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - Max wait for challenge resolution (default 15000)
 * @returns {Promise<{cookies: object, headers: object, cdValue: string|null}>}
 */
export async function solveKasadaChallenge(page, targetUrl, opts = {}) {
  const { timeoutMs = 15_000 } = opts;

  // Inject stealth hooks to hide automation
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  // Wait for Kasada to set its cookies (x-kpsdk-cd, x-kpsdk-ct)
  const startTime = Date.now();
  let cdValue = null;
  while (Date.now() - startTime < timeoutMs) {
    const cookies = await page.context().cookies();
    const cdCookie = cookies.find(c => c.name === 'x-kpsdk-cd');
    if (cdCookie) {
      cdValue = cdCookie.value;
      break;
    }
    await delay(500);
  }

  if (!cdValue) {
    log.warn('Kasada challenge did not resolve within timeout', { timeoutMs });
  }

  // Extract all Kasada-relevant cookies
  const cookies = await page.context().cookies();
  const kasadaCookies = cookies.filter(c => c.name.startsWith('x-kpsdk-'));
  const headers = {};
  for (const c of kasadaCookies) {
    headers['x-kpsdk-cd'] = c.value;
  }

  log.info('Kasada challenge solved', { cookieCount: kasadaCookies.length });
  return { cookies: kasadaCookies, headers, cdValue };
}

// ─── Unified bypass config ───────────────────────────────────────────────────

/**
 * Get recommended bypass configuration for Kasada-protected sites.
 *
 * @param {object} [resp]
 * @returns {{ requiresBrowser: boolean, headers: object, evasionScript: string|null, notes: string[] }}
 */
export function getKasadaBypassConfig(resp) {
  const detection = resp ? detectKasada(resp) : { detected: true };
  const notes = [];

  if (!detection.detected) {
    return { requiresBrowser: false, headers: {}, evasionScript: null, notes: ['Kasada not detected'] };
  }

  notes.push('Kasada requires browser-based challenge solving');
  notes.push('Use chrome124 TLS profile for best results');
  notes.push('Combine with behavior simulation for anti-bot evasion');

  const headers = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  };

  const evasionScript = 'Object.defineProperty(navigator, "webdriver", { get: () => false });';

  return { requiresBrowser: true, headers, evasionScript, notes };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
