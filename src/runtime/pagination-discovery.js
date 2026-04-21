/**
 * Pagination auto-discovery — detects "next page" URLs from HTML responses.
 *
 * Strategy (in priority order):
 *   1. <link rel="next"> in <head>
 *   2. Common CSS selector patterns (a[rel=next], .next a, etc.)
 *   3. URL pattern increment (page=N → page=N+1, /page/N → /page/N+1)
 *   4. JSON API response fields (next, nextPage, nextCursor, etc.)
 *
 * Returns null when no next page is detected.
 */

import { JSDOM } from 'jsdom';

// CSS selectors tried in order — first match wins
const NEXT_SELECTORS = [
  'a[rel="next"]',
  'link[rel="next"]',
  '[aria-label="Next page"]',
  '[aria-label="next page"]',
  '.pagination .next a',
  '.pagination a.next',
  '.pager-next a',
  '.next-page a',
  'a.next',
  'a.next-page',
  '[class*="pagination"] a[class*="next"]',
  '[class*="pager"] a[class*="next"]',
  'nav a:last-child',
];

// JSON field names that commonly hold the next page URL or cursor
const JSON_NEXT_FIELDS = ['next', 'nextPage', 'next_page', 'nextUrl', 'next_url', 'nextCursor', 'next_cursor', 'nextLink', 'next_link'];

/**
 * Try to resolve a URL string relative to a base.
 * @param {string} href
 * @param {string} baseUrl
 * @returns {string|null}
 */
function resolveUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Detect next page URL from <link rel="next"> or common anchor selectors.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string|null}
 */
function detectFromHtml(html, baseUrl) {
  let dom;
  try {
    dom = new JSDOM(html, { contentType: 'text/html' });
  } catch {
    return null;
  }
  const doc = dom.window.document;

  for (const selector of NEXT_SELECTORS) {
    try {
      const el = doc.querySelector(selector);
      if (el) {
        const href = el.getAttribute('href') ?? el.getAttribute('content');
        const resolved = resolveUrl(href, baseUrl);
        if (resolved && resolved !== baseUrl) return resolved;
      }
    } catch {
      // invalid selector — skip
    }
  }
  return null;
}

/**
 * Detect next page from URL pattern increment.
 * Handles: ?page=N, ?p=N, ?pg=N, /page/N, /p/N
 * @param {string} currentUrl
 * @returns {string|null}
 */
function detectFromUrlPattern(currentUrl) {
  try {
    const url = new URL(currentUrl);

    // Query param patterns
    for (const param of ['page', 'p', 'pg', 'pageNum', 'pagenum', 'page_num', 'offset']) {
      const val = url.searchParams.get(param);
      if (val !== null && /^\d+$/.test(val)) {
        const next = new URL(currentUrl);
        next.searchParams.set(param, String(Number(val) + 1));
        return next.href;
      }
    }

    // Path segment patterns: /page/N or /p/N
    const pathMatch = url.pathname.match(/\/(page|p)\/(\d+)(\/.*)?$/i);
    if (pathMatch) {
      const nextPath = url.pathname.replace(
        /\/(page|p)\/(\d+)/i,
        (_, seg, n) => `/${seg}/${Number(n) + 1}`,
      );
      const next = new URL(currentUrl);
      next.pathname = nextPath;
      return next.href;
    }
  } catch {
    // invalid URL
  }
  return null;
}

/**
 * Detect next page cursor/URL from a parsed JSON response body.
 * @param {string} body
 * @returns {{ nextUrl?: string, nextCursor?: string }|null}
 */
function detectFromJson(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  // Flatten one level of nesting (data.pagination.next, meta.next, etc.)
  const candidates = [parsed, parsed.data, parsed.meta, parsed.pagination, parsed.paging, parsed.links]
    .filter((obj) => obj && typeof obj === 'object' && !Array.isArray(obj));

  for (const obj of candidates) {
    for (const field of JSON_NEXT_FIELDS) {
      const val = obj[field];
      if (typeof val === 'string' && val) {
        return { nextUrl: val };
      }
      if (typeof val === 'number' && val > 0) {
        return { nextCursor: String(val) };
      }
    }
  }

  const seen = new Set();
  function findGraphQLPageInfo(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) {
      return null;
    }
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);

    if (value.pageInfo && typeof value.pageInfo === 'object') {
      const hasNextPage = value.pageInfo.hasNextPage === true;
      const endCursor = typeof value.pageInfo.endCursor === 'string' ? value.pageInfo.endCursor : null;
      if (hasNextPage && endCursor) {
        return { nextCursor: endCursor };
      }
    }

    for (const nextValue of Object.values(value)) {
      const found = findGraphQLPageInfo(nextValue, depth + 1);
      if (found) {
        return found;
      }
    }

    return null;
  }

  const graphQlPageInfo = findGraphQLPageInfo(parsed);
  if (graphQlPageInfo) {
    return graphQlPageInfo;
  }
  return null;
}

/**
 * Discover the next page URL from a crawl response.
 *
 * @param {Object} response - CrawlResponse-like object
 * @param {string} response.body
 * @param {string} response.finalUrl
 * @param {Record<string,string>} [response.headers]
 * @param {Object} [options]
 * @param {boolean} [options.urlPattern=true] - Enable URL pattern increment fallback
 * @param {boolean} [options.jsonDetect=true] - Enable JSON field detection
 * @param {number} [options.maxPage] - Stop after this page number (URL pattern only)
 * @returns {{ nextUrl: string|null, method: string|null, cursor: string|null }}
 */
export function discoverNextPage(response, options = {}) {
  const { body, finalUrl, headers = {} } = response;
  const urlPattern = options.urlPattern !== false;
  const jsonDetect = options.jsonDetect !== false;

  const contentType = String(headers['content-type'] ?? headers['Content-Type'] ?? '');
  const isJson = contentType.includes('json') || (body.trimStart().startsWith('{') || body.trimStart().startsWith('['));

  // 1. JSON response
  if (isJson && jsonDetect) {
    const result = detectFromJson(body);
    if (result?.nextUrl) {
      const resolved = resolveUrl(result.nextUrl, finalUrl);
      if (resolved && resolved !== finalUrl) {
        return { nextUrl: resolved, method: 'json-field', cursor: result.nextCursor ?? null };
      }
    }
    if (result?.nextCursor) {
      return { nextUrl: null, method: 'json-cursor', cursor: result.nextCursor };
    }
  }

  // 2. HTML selectors + <link rel="next">
  if (!isJson) {
    const htmlNext = detectFromHtml(body, finalUrl);
    if (htmlNext) return { nextUrl: htmlNext, method: 'html-selector', cursor: null };
  }

  // 3. URL pattern increment
  if (urlPattern) {
    const patternNext = detectFromUrlPattern(finalUrl);
    if (patternNext && patternNext !== finalUrl) {
      // Respect maxPage guard
      if (options.maxPage != null) {
        try {
          const url = new URL(patternNext);
          for (const param of ['page', 'p', 'pg', 'pageNum', 'pagenum', 'page_num']) {
            const val = url.searchParams.get(param);
            if (val !== null && Number(val) > options.maxPage) {
              return { nextUrl: null, method: null, cursor: null };
            }
          }
        } catch { /* ignore */ }
      }
      return { nextUrl: patternNext, method: 'url-pattern', cursor: null };
    }
  }

  return { nextUrl: null, method: null, cursor: null };
}

/**
 * Convenience: returns just the next URL string or null.
 * @param {Object} response
 * @param {Object} [options]
 * @returns {string|null}
 */
export function getNextPageUrl(response, options) {
  return discoverNextPage(response, options).nextUrl;
}
