/**
 * GraphQL-aware crawler support.
 *
 * Features:
 *   - Introspection: discover schema types, queries, mutations, subscriptions
 *   - Query execution: typed fetch wrapper with variables and operation name
 *   - Endpoint detection: identify GraphQL endpoints from HTML/JS source
 *   - Persisted query support (Apollo/Relay style)
 *   - Pagination: detect and follow cursor-based / offset-based pagination
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('graphql');

// ─── Endpoint detection ───────────────────────────────────────────────────────

const GQL_ENDPOINT_PATTERNS = [
  /["'`](\/graphql[^"'`]*?)["'`]/gi,
  /["'`](\/api\/graphql[^"'`]*?)["'`]/gi,
  /["'`](\/gql[^"'`]*?)["'`]/gi,
  /["'`](https?:\/\/[^"'`]+\/graphql[^"'`]*)["'`]/gi,
];

/**
 * Detect GraphQL endpoint URLs from HTML or JS source.
 *
 * @param {string} source - HTML or JS source code
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {string[]} Deduplicated list of candidate GraphQL endpoint URLs
 */
export function detectGraphQLEndpoints(source, baseUrl) {
  const found = new Set();
  for (const pattern of GQL_ENDPOINT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      try {
        found.add(new URL(match[1], baseUrl).href);
      } catch { /* ignore invalid URLs */ }
    }
  }
  return [...found];
}

// ─── Query execution ──────────────────────────────────────────────────────────

/**
 * Execute a GraphQL query/mutation against an endpoint.
 *
 * @param {Object} options
 * @param {string} options.endpoint - GraphQL endpoint URL
 * @param {string} options.query - GraphQL query string
 * @param {Object} [options.variables]
 * @param {string} [options.operationName]
 * @param {Record<string,string>} [options.headers]
 * @param {'POST'|'GET'} [options.method='POST']
 * @param {number} [options.timeoutMs=15000]
 * @param {string} [options.persistedQueryHash] - Apollo persisted query hash
 * @returns {Promise<{ data: any, errors: any[]|null, extensions: any, status: number }>}
 */
export async function executeGraphQL(options) {
  const {
    endpoint,
    query,
    variables = {},
    operationName,
    headers = {},
    method = 'POST',
    timeoutMs = 15000,
    persistedQueryHash,
  } = options;

  let url = endpoint;
  let body;
  const reqHeaders = {
    'content-type': 'application/json',
    'accept': 'application/json',
    ...headers,
  };

  const payload = { query, variables };
  if (operationName) payload.operationName = operationName;

  // Apollo Persisted Queries
  if (persistedQueryHash) {
    payload.extensions = {
      persistedQuery: { version: 1, sha256Hash: persistedQueryHash },
    };
    if (!query) delete payload.query;
  }

  if (method === 'GET') {
    const params = new URLSearchParams({ query });
    if (Object.keys(variables).length) params.set('variables', JSON.stringify(variables));
    if (operationName) params.set('operationName', operationName);
    url = `${endpoint}?${params}`;
    delete reqHeaders['content-type'];
  } else {
    body = JSON.stringify(payload);
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const json = await res.json();
  return {
    data: json.data ?? null,
    errors: json.errors ?? null,
    extensions: json.extensions ?? null,
    status: res.status,
  };
}

// ─── Introspection ────────────────────────────────────────────────────────────

const INTROSPECTION_QUERY = `
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      name
      kind
      description
      fields(includeDeprecated: true) {
        name
        description
        type { name kind ofType { name kind } }
        args { name type { name kind ofType { name kind } } }
      }
    }
  }
}`;

/**
 * Run GraphQL introspection and return a simplified schema summary.
 *
 * @param {string} endpoint
 * @param {Object} [options] - Passed to executeGraphQL (headers, timeoutMs, etc.)
 * @returns {Promise<{ queryType: string, mutationType: string, subscriptionType: string, types: Object[] }|null>}
 */
export async function introspectSchema(endpoint, options = {}) {
  try {
    const result = await executeGraphQL({ ...options, endpoint, query: INTROSPECTION_QUERY });
    if (result.errors?.length) {
      log.warn('introspection errors', { endpoint, errors: result.errors.map((e) => e.message) });
    }
    const schema = result.data?.__schema;
    if (!schema) return null;

    return {
      queryType: schema.queryType?.name ?? null,
      mutationType: schema.mutationType?.name ?? null,
      subscriptionType: schema.subscriptionType?.name ?? null,
      types: (schema.types ?? [])
        .filter((t) => !t.name.startsWith('__'))
        .map((t) => ({
          name: t.name,
          kind: t.kind,
          description: t.description ?? null,
          fields: (t.fields ?? []).map((f) => ({
            name: f.name,
            type: f.type?.name ?? f.type?.ofType?.name ?? null,
            args: (f.args ?? []).map((a) => a.name),
          })),
        })),
    };
  } catch (err) {
    log.warn('introspection failed', { endpoint, error: err.message });
    return null;
  }
}

// ─── Pagination ───────────────────────────────────────────────────────────────

/**
 * Detect cursor-based pagination info from a GraphQL response.
 * Handles Relay-style (pageInfo.endCursor) and common custom patterns.
 *
 * @param {Object} data - GraphQL response data
 * @returns {{ hasNextPage: boolean, endCursor: string|null, nextOffset: number|null }}
 */
export function detectGraphQLPagination(data) {
  if (!data || typeof data !== 'object') {
    return { hasNextPage: false, endCursor: null, nextOffset: null };
  }

  // Search recursively for pageInfo
  function findPageInfo(obj, depth = 0) {
    if (depth > 5 || !obj || typeof obj !== 'object') return null;
    if (obj.pageInfo && typeof obj.pageInfo === 'object') return obj.pageInfo;
    for (const val of Object.values(obj)) {
      const found = findPageInfo(val, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const pageInfo = findPageInfo(data);
  if (pageInfo) {
    return {
      hasNextPage: pageInfo.hasNextPage === true,
      endCursor: pageInfo.endCursor ?? null,
      nextOffset: null,
    };
  }

  // Offset-based: look for total/count + offset/page fields
  const flat = JSON.stringify(data);
  const offsetMatch = flat.match(/"offset"\s*:\s*(\d+).*?"limit"\s*:\s*(\d+)/);
  if (offsetMatch) {
    return {
      hasNextPage: true, // can't know without total
      endCursor: null,
      nextOffset: Number(offsetMatch[1]) + Number(offsetMatch[2]),
    };
  }

  return { hasNextPage: false, endCursor: null, nextOffset: null };
}

/**
 * Fetch all pages of a paginated GraphQL query using cursor-based pagination.
 *
 * @param {Object} options
 * @param {string} options.endpoint
 * @param {string} options.query - Must accept $cursor: String variable
 * @param {Object} [options.variables]
 * @param {number} [options.maxPages=10]
 * @param {Record<string,string>} [options.headers]
 * @returns {Promise<{ pages: Object[], cursors: string[] }>}
 */
export async function fetchAllPages(options) {
  const { endpoint, query, variables = {}, maxPages = 10, headers } = options;
  const pages = [];
  const cursors = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const vars = cursor ? { ...variables, cursor, after: cursor } : variables;
    const result = await executeGraphQL({ endpoint, query, variables: vars, headers });

    if (result.errors?.length) {
      log.warn('graphql page error', { page, errors: result.errors.map((e) => e.message) });
      break;
    }

    pages.push(result.data);
    const pagination = detectGraphQLPagination(result.data);
    if (!pagination.hasNextPage || !pagination.endCursor) break;

    cursors.push(pagination.endCursor);
    cursor = pagination.endCursor;
  }

  return { pages, cursors };
}
