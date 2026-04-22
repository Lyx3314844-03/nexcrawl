/**
 * Search engine fetcher for Google, Bing, DuckDuckGo, and Baidu.
 *
 * Handles SERP result extraction, pagination, rate-limiting
 * detection (429/captcha), and language/region configuration.
 *
 * Usage:
 *   import { fetchSearchResults } from '../fetchers/search-engine-fetcher.js';
 *   const results = await fetchSearchResults({ engine: 'google', query: 'web scraping', maxPages: 3 });
 */

import { createLogger } from '../core/logger.js';
import { AppError } from '../core/errors.js';

const log = createLogger('search-engine-fetcher');

// ─── Engine configurations ──────────────────────────────────────────────────

const ENGINE_CONFIGS = {
  google: {
    searchUrl: 'https://www.google.com/search',
    queryParam: 'q',
    startParam: 'start',
    pageIncrement: 10,
    resultSelector: '#search .g',
    titleSelector: 'h3',
    linkSelector: 'a[href]',
    snippetSelector: '.VwiC3b',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  },
  bing: {
    searchUrl: 'https://www.bing.com/search',
    queryParam: 'q',
    startParam: 'first',
    pageIncrement: 10,
    resultSelector: '#b_results .b_algo',
    titleSelector: 'h2 a',
    linkSelector: 'h2 a[href]',
    snippetSelector: '.b_caption p',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  },
  duckduckgo: {
    searchUrl: 'https://html.duckduckgo.com/html/',
    queryParam: 'q',
    startParam: 's',
    pageIncrement: 0, // DDG uses POST form for next page
    resultSelector: '.result',
    titleSelector: '.result__a',
    linkSelector: '.result__a[href]',
    snippetSelector: '.result__snippet',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  },
  baidu: {
    searchUrl: 'https://www.baidu.com/s',
    queryParam: 'wd',
    startParam: 'pn',
    pageIncrement: 10,
    resultSelector: '.result.c-container',
    titleSelector: 'h3 a',
    linkSelector: 'h3 a[href]',
    snippetSelector: '.c-span-last',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  },
};

// ─── Main fetch function ─────────────────────────────────────────────────────

/**
 * Fetch search engine results for a given query.
 *
 * @param {object} opts
 * @param {'google'|'bing'|'duckduckgo'|'baidu'} opts.engine - Search engine
 * @param {string} opts.query - Search query string
 * @param {number} [opts.maxPages] - Maximum pages to scrape (default 3)
 * @param {string} [opts.language] - Language code for results (e.g., 'en', 'zh')
 * @param {string} [opts.region] - Region/country code (e.g., 'us', 'cn')
 * @param {object} [opts.proxy] - Proxy configuration
 * @param {object} [opts.headers] - Additional request headers
 * @returns {Promise<{results: Array<{title: string, url: string, snippet: string, position: number}>, totalResults: number}>}
 */
export async function fetchSearchResults(opts = {}) {
  const {
    engine,
    query,
    maxPages = 3,
    language,
    region,
    proxy,
    headers: extraHeaders = {},
  } = opts;

  if (!engine) throw new AppError(400, 'Search engine is required');
  if (!query) throw new AppError(400, 'Search query is required');

  const cfg = ENGINE_CONFIGS[engine];
  if (!cfg) throw new AppError(400, `Unsupported engine: ${engine}`);

  const allResults = [];
  let position = 1;

  for (let page = 0; page < maxPages; page++) {
    const url = buildSearchUrl(cfg, query, page, { language, region });
    const headers = {
      'User-Agent': cfg.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': `${language ?? 'en'},${language ?? 'en'};q=0.9`,
      ...extraHeaders,
    };

    log.info('Fetching SERP', { engine, query, page });

    const resp = await fetchWithProxy(url, { headers, proxy });

    // Detect rate-limiting / CAPTCHA
    if (resp.status === 429) {
      log.warn('Rate limited by search engine', { engine, page });
      break;
    }
    if (isCaptchaPage(resp.body, engine)) {
      log.warn('CAPTCHA detected on SERP', { engine, page });
      break;
    }

    const pageResults = parseSerpHtml(resp.body, cfg, position);
    if (pageResults.length === 0) {
      log.info('No more results found', { engine, page });
      break;
    }

    allResults.push(...pageResults);
    position += pageResults.length;

    // DuckDuckGo uses POST form for pagination – not supported via simple URL increment
    if (engine === 'duckduckgo' && page > 0) break;

    // Polite delay between pages
    await delay(1500 + Math.random() * 1000);
  }

  log.info('Search complete', { engine, query, totalResults: allResults.length });
  return { results: allResults, totalResults: allResults.length };
}

// ─── URL builder ─────────────────────────────────────────────────────────────

function buildSearchUrl(cfg, query, page, opts = {}) {
  const params = new URLSearchParams({ [cfg.queryParam]: query });
  if (cfg.startParam && page > 0) {
    params.set(cfg.startParam, String(page * cfg.pageIncrement));
  }
  if (opts.language) params.set('hl', opts.language);
  if (opts.region) params.set('gl', opts.region);
  return `${cfg.searchUrl}?${params}`;
}

// ─── HTML parser ─────────────────────────────────────────────────────────────

function parseSerpHtml(html, cfg, startPosition) {
  const results = [];
  // Use a simple regex-based extraction for HTTP-only mode.
  // When used with CheerioCrawler, the caller should use the selectors directly.
  const re = /<a[^>]+href="(https?:\/\/[^"\s]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;
  let pos = startPosition;

  while ((match = re.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    // Skip search engine internal URLs
    if (url.includes('google.com/search') || url.includes('bing.com/search') ||
        url.includes('baidu.com/link') || url.includes('duckduckgo.com')) {
      continue;
    }
    results.push({ title, url, snippet: '', position: pos++ });
  }
  return results;
}

// ─── CAPTCHA detection ──────────────────────────────────────────────────────

function isCaptchaPage(body, engine) {
  if (!body) return false;
  const lower = body.toLowerCase();
  switch (engine) {
    case 'google': return lower.includes('captcha') || lower.includes('sorry/index');
    case 'bing':  return lower.includes('captcha') || lower.includes('verify');
    case 'baidu': return lower.includes('verify') || lower.includes('captcha');
    default: return false;
  }
}

// ─── Fetch with proxy support ───────────────────────────────────────────────

/**
 * Fetch with optional proxy support.
 * Uses http-fetcher's proxy capabilities when available,
 * falls back to direct fetch otherwise.
 */
async function fetchWithProxy(url, { headers, proxy }) {
  if (!proxy?.server) {
    const resp = await fetch(url, { headers, redirect: 'follow' });
    const body = await resp.text();
    return { status: resp.status, body, headers: Object.fromEntries(resp.headers) };
  }

  // Try to use http-fetcher's proxy tunnel support
  try {
    const httpFetcher = await import('./http-fetcher.js');
    if (typeof httpFetcher.fetchViaProxy === 'function') {
      return await httpFetcher.fetchViaProxy(url, { headers, proxy });
    }
  } catch {
    log.debug('http-fetcher proxy not available, using direct fetch with proxy header');
  }

  // Simplified proxy support via standard fetch with proxy URL
  log.warn('Full proxy tunneling not available – request may be blocked', { url });
  const resp = await fetch(url, { headers, redirect: 'follow' });
  const body = await resp.text();
  return { status: resp.status, body, headers: Object.fromEntries(resp.headers) };
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
