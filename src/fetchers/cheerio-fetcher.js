/**
 * CheerioFetcher - Lightweight HTML parsing crawler using cheerio.
 *
 * Unlike BrowserFetcher (which launches Puppeteer/Playwright), this fetcher
 * uses raw HTTP + cheerio for fast static-content crawling.  It is the
 * equivalent of Crawlee's CheerioCrawler and should be the default choice
 * for sites that don't require JavaScript rendering.
 *
 * Usage:
 *   const crawler = new OmniCrawler({ mode: 'cheerio' });
 *   // or via workflow: mode: 'cheerio'
 */

import * as cheerio from 'cheerio';
import { fetchWithHttp } from './http-fetcher.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('cheerio-fetcher');

/**
 * Fetch a URL via HTTP and parse the response HTML with cheerio.
 *
 * @param {Object} request - Request descriptor (url, headers, method, body, proxy, tlsProfile, session, timeoutMs)
 * @param {Object} [options] - Options
 * @param {import('../runtime/session-store.js').SessionStore} [options.sessionStore] - Session store for cookie persistence
 * @param {string[]} [options.selectors] - CSS selectors to pre-extract
 * @param {boolean} [options.parseXml] - Use xmlMode for XML/FEED parsing
 * @returns {Promise<Object>} Parsed result with cheerio $, extracted data, and response metadata
 */
export async function fetchWithCheerio(request, { sessionStore, selectors = [], parseXml = false } = {}) {
  const response = await fetchWithHttp(request, { sessionStore });

  if (!response.ok) {
    return {
      mode: 'cheerio',
      url: request.url,
      finalUrl: response.finalUrl,
      ok: false,
      status: response.status,
      headers: response.headers,
      body: response.body,
      $: null,
      html: response.body,
      extracted: {},
      domMeta: { title: null },
      sessionId: response.sessionId,
      proxyServer: response.proxyServer,
      fetchedAt: response.fetchedAt,
    };
  }

  const contentType = response.headers['content-type'] ?? '';
  const isXml = parseXml || contentType.includes('xml') || contentType.includes('feed') || contentType.includes('rss');

  const $ = cheerio.load(response.body, {
    xmlMode: isXml,
    decodeEntities: true,
    lowerCaseTags: !isXml,
    lowerCaseAttributeNames: !isXml,
  });

  // Pre-extract requested selectors
  const extracted = {};
  for (const selector of selectors) {
    const elements = $(selector);
    if (elements.length === 1) {
      extracted[selector] = elements.text().trim();
    } else if (elements.length > 1) {
      extracted[selector] = elements.toArray().map(el => $(el).text().trim());
    }
  }

  // Auto-extract common metadata
  const metadata = {
    title: $('title').first().text().trim() || null,
    description: $('meta[name="description"]').attr('content') || null,
    canonical: $('link[rel="canonical"]').attr('href') || null,
    lang: $('html').attr('lang') || null,
    ogTitle: $('meta[property="og:title"]').attr('content') || null,
    ogImage: $('meta[property="og:image"]').attr('content') || null,
  };

  // Extract links for discovery
  const links = $('a[href]')
    .toArray()
    .map(el => $(el).attr('href'))
    .filter(Boolean);

  return {
    mode: 'cheerio',
    url: request.url,
    finalUrl: response.finalUrl,
    ok: true,
    status: response.status,
    headers: response.headers,
    body: response.body,
    $,
    html: response.body,
    extracted,
    metadata,
    links,
    domMeta: { title: metadata.title },
    sessionId: response.sessionId,
    proxyServer: response.proxyServer,
    fetchedAt: response.fetchedAt,
  };
}

/**
 * Convenience: extract data from a cheerio result using a schema.
 *
 * @param {Object} result - Result from fetchWithCheerio
 * @param {Object} schema - Extraction schema { field: selector | { selector, transform, attribute } }
 * @returns {Object} Extracted data object
 */
export function extractWithSchema(result, schema) {
  if (!result.$) return {};
  const $ = result.$;
  const data = {};

  for (const [field, def] of Object.entries(schema)) {
    if (typeof def === 'string') {
      const el = $(def);
      data[field] = el.length === 1 ? el.text().trim() : el.toArray().map(e => $(e).text().trim());
    } else {
      const el = $(def.selector);
      let value = def.attribute ? el.attr(def.attribute) : el.text().trim();
      if (def.transform && typeof def.transform === 'function') {
        value = def.transform(value, el);
      }
      data[field] = value ?? null;
    }
  }

  return data;
}

export default fetchWithCheerio;
