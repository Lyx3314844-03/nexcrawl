/**
 * GraphQL-aware crawler support.
 *
 * Features:
 *   - Introspection: discover schema types, queries, mutations, subscriptions
 *   - Query execution: typed fetch wrapper with variables and operation name
 *   - Endpoint detection: identify GraphQL endpoints from HTML/JS source
 *   - Persisted query hint extraction
 *   - Starter operation generation from introspection output
 *   - Pagination: detect and follow cursor-based / offset-based pagination
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('graphql');

const GQL_ENDPOINT_PATTERNS = [
  /["'`](\/graphql[^"'`]*?)["'`]/gi,
  /["'`](\/api\/graphql[^"'`]*?)["'`]/gi,
  /["'`](\/gql[^"'`]*?)["'`]/gi,
  /["'`](https?:\/\/[^"'`]+\/graphql[^"'`]*)["'`]/gi,
];

const BUILTIN_SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function renderTypeRef(typeNode) {
  if (!typeNode) {
    return null;
  }
  if (typeNode.kind === 'NON_NULL') {
    return `${renderTypeRef(typeNode.ofType)}!`;
  }
  if (typeNode.kind === 'LIST') {
    return `[${renderTypeRef(typeNode.ofType)}]`;
  }
  return typeNode.name ?? renderTypeRef(typeNode.ofType);
}

function unwrapTypeName(typeName) {
  return String(typeName ?? '').replace(/[!\[\]]/g, '');
}

function isScalarType(schema, typeName) {
  const normalized = unwrapTypeName(typeName);
  if (!normalized) return true;
  if (BUILTIN_SCALARS.has(normalized)) return true;
  const matched = schema?.types?.find((entry) => entry.name === normalized);
  return matched?.kind === 'SCALAR' || matched?.kind === 'ENUM';
}

function lookupType(schema, typeName) {
  const normalized = unwrapTypeName(typeName);
  return schema?.types?.find((entry) => entry.name === normalized) ?? null;
}

function buildSelectionSet(schema, typeName, options = {}, depth = 0, trail = new Set()) {
  const maxDepth = clamp(options.maxDepth ?? 2, 1, 5, 2);
  const maxFields = clamp(options.maxFields ?? 6, 1, 20, 6);
  const normalized = unwrapTypeName(typeName);
  if (!normalized || isScalarType(schema, normalized) || depth >= maxDepth || trail.has(normalized)) {
    return [];
  }

  const typeEntry = lookupType(schema, normalized);
  if (!typeEntry?.fields?.length) {
    return [];
  }

  const nextTrail = new Set(trail);
  nextTrail.add(normalized);

  return typeEntry.fields.slice(0, maxFields).map((field) => {
    const nested = buildSelectionSet(schema, field.type, options, depth + 1, nextTrail);
    return {
      name: field.name,
      type: field.type,
      selection: nested,
    };
  });
}

function renderSelection(selection = [], indent = 2, level = 1) {
  const pad = ' '.repeat(indent * level);
  return selection.map((entry) => {
    if (entry.selection?.length) {
      return `${pad}${entry.name} {\n${renderSelection(entry.selection, indent, level + 1)}\n${pad}}`;
    }
    return `${pad}${entry.name}`;
  }).join('\n');
}

function defaultVariableValue(typeName) {
  const normalized = unwrapTypeName(typeName);
  switch (normalized) {
    case 'ID':
    case 'String':
      return 'demo';
    case 'Int':
      return 1;
    case 'Float':
      return 1;
    case 'Boolean':
      return true;
    default:
      return null;
  }
}

export function detectGraphQLEndpoints(source, baseUrl) {
  const found = new Set();
  for (const pattern of GQL_ENDPOINT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      try {
        found.add(new URL(match[1], baseUrl).href);
      } catch {
        // ignore invalid URLs
      }
    }
  }
  return [...found];
}

export function extractPersistedQueryHints(source = '', baseUrl = '') {
  const endpoints = detectGraphQLEndpoints(String(source ?? ''), baseUrl);
  const results = [];
  const seen = new Set();
  const patterns = [
    /sha256Hash["']?\s*[:=]\s*["']([a-f0-9]{32,64})["']/gi,
    /persistedQuery["']?\s*:\s*\{[\s\S]{0,120}?sha256Hash["']?\s*:\s*["']([a-f0-9]{32,64})["']/gi,
    /operationId["']?\s*[:=]\s*["']([a-f0-9]{32,64})["']/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of String(source ?? '').matchAll(pattern)) {
      const hash = match[1]?.toLowerCase();
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      results.push({
        hash,
        endpoint: endpoints[0] ?? null,
        transport: 'persisted-query',
      });
    }
  }

  return results;
}

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
    accept: 'application/json',
    ...headers,
  };

  const payload = { query, variables };
  if (operationName) payload.operationName = operationName;

  if (persistedQueryHash) {
    payload.extensions = {
      persistedQuery: { version: 1, sha256Hash: persistedQueryHash },
    };
    if (!query) delete payload.query;
  }

  if (method === 'GET') {
    const params = new URLSearchParams();
    if (query) {
      params.set('query', query);
    }
    if (Object.keys(variables).length) params.set('variables', JSON.stringify(variables));
    if (operationName) params.set('operationName', operationName);
    if (persistedQueryHash) {
      params.set('extensions', JSON.stringify(payload.extensions));
    }
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
        type {
          name
          kind
          ofType {
            name
            kind
            ofType {
              name
              kind
              ofType {
                name
                kind
              }
            }
          }
        }
        args {
          name
          type {
            name
            kind
            ofType {
              name
              kind
              ofType {
                name
                kind
                ofType {
                  name
                  kind
                }
              }
            }
          }
        }
      }
    }
  }
}`;

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
        .filter((type) => !type.name.startsWith('__'))
        .map((type) => ({
          name: type.name,
          kind: type.kind,
          description: type.description ?? null,
          fields: (type.fields ?? []).map((field) => ({
            name: field.name,
            type: renderTypeRef(field.type),
            args: (field.args ?? []).map((arg) => ({
              name: arg.name,
              type: renderTypeRef(arg.type),
            })),
          })),
        })),
    };
  } catch (error) {
    log.warn('introspection failed', { endpoint, error: error.message });
    return null;
  }
}

export function buildGraphQLStarterOperation(schema, options = {}) {
  const operationType = String(options.operationType ?? 'query').toLowerCase();
  const rootTypeName =
    operationType === 'mutation'
      ? schema?.mutationType
      : operationType === 'subscription'
        ? schema?.subscriptionType
        : schema?.queryType;

  const rootType = lookupType(schema, rootTypeName);
  if (!rootType?.fields?.length) {
    return null;
  }

  const preferredFieldName = options.fieldName ? String(options.fieldName) : null;
  const field = rootType.fields.find((entry) => entry.name === preferredFieldName)
    ?? rootType.fields.find((entry) => (entry.args?.length ?? 0) === 0)
    ?? rootType.fields[0];

  if (!field) {
    return null;
  }

  const variableDefinitions = [];
  const variables = {};
  const invocationArgs = [];
  for (const arg of field.args ?? []) {
    const typeName = arg.type ?? 'String';
    variableDefinitions.push(`$${arg.name}: ${typeName}`);
    invocationArgs.push(`${arg.name}: $${arg.name}`);
    variables[arg.name] = defaultVariableValue(typeName);
  }

  const selection = buildSelectionSet(schema, field.type, options);
  const renderedSelection = selection.length > 0
    ? ` {\n${renderSelection(selection, 2, 2)}\n  }`
    : '';
  const variableSuffix = variableDefinitions.length > 0
    ? `(${variableDefinitions.join(', ')})`
    : '';
  const invocationSuffix = invocationArgs.length > 0
    ? `(${invocationArgs.join(', ')})`
    : '';
  const operationName = options.operationName
    ?? `${operationType}${field.name[0].toUpperCase()}${field.name.slice(1)}`;
  const query = `${operationType} ${operationName}${variableSuffix} {\n  ${field.name}${invocationSuffix}${renderedSelection}\n}`;

  return {
    operationType,
    operationName,
    rootType: rootTypeName,
    fieldName: field.name,
    query,
    variables,
    selection,
  };
}

export function buildGraphQLRequestPlan(options = {}) {
  const source = String(options.source ?? '');
  const baseUrl = options.baseUrl ?? options.endpoint ?? '';
  const schema = options.schema ?? null;
  const endpoints = options.endpoint
    ? unique([options.endpoint, ...detectGraphQLEndpoints(source, baseUrl)])
    : detectGraphQLEndpoints(source, baseUrl);
  const persistedQueries = extractPersistedQueryHints(source, baseUrl);
  const starterOperations = [];

  if (schema) {
    for (const operationType of ['query', 'mutation', 'subscription']) {
      const starter = buildGraphQLStarterOperation(schema, {
        operationType,
        maxDepth: options.maxDepth ?? 2,
        maxFields: options.maxFields ?? 6,
      });
      if (starter) {
        starterOperations.push(starter);
      }
    }
  }

  const lowerSource = source.toLowerCase();
  const paginationStrategy = lowerSource.includes('pageinfo') || lowerSource.includes('endcursor')
    ? 'cursor'
    : lowerSource.includes('offset') || lowerSource.includes('limit')
      ? 'offset'
      : null;

  return {
    endpoints,
    recommendedEndpoint: endpoints[0] ?? null,
    persistedQueries,
    starterOperations,
    paginationStrategy,
    authLikely: /\bauthorization\b|\bbearer\b|\bx-api-key\b|\bx-auth\b/i.test(source),
  };
}

export function detectGraphQLPagination(data) {
  if (!data || typeof data !== 'object') {
    return { hasNextPage: false, endCursor: null, nextOffset: null };
  }

  function findPageInfo(obj, depth = 0) {
    if (depth > 5 || !obj || typeof obj !== 'object') return null;
    if (obj.pageInfo && typeof obj.pageInfo === 'object') return obj.pageInfo;
    for (const value of Object.values(obj)) {
      const found = findPageInfo(value, depth + 1);
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

  const flat = JSON.stringify(data);
  const offsetMatch = flat.match(/"offset"\s*:\s*(\d+).*?"limit"\s*:\s*(\d+)/);
  if (offsetMatch) {
    return {
      hasNextPage: true,
      endCursor: null,
      nextOffset: Number(offsetMatch[1]) + Number(offsetMatch[2]),
    };
  }

  return { hasNextPage: false, endCursor: null, nextOffset: null };
}

export async function fetchAllPages(options) {
  const { endpoint, query, variables = {}, maxPages = 10, headers } = options;
  const pages = [];
  const cursors = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const vars = cursor ? { ...variables, cursor, after: cursor } : variables;
    const result = await executeGraphQL({ endpoint, query, variables: vars, headers });

    if (result.errors?.length) {
      log.warn('graphql page error', { page, errors: result.errors.map((entry) => entry.message) });
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
