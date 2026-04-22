import vm from 'node:vm';
import { queryHtmlBatch } from '../fetchers/browser-fetcher.js';
import { hashText } from '../utils/hash.js';
import { interpolateReplayValue, readObjectPath } from '../utils/replay-template.js';
import { runReverseOperation } from '../reverse/reverse-capabilities.js';
import { extractMediaAssets } from './media-extractor.js';
import { evaluateXPath } from './xpath-extractor.js';

function parseJsonMaybe(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function firstTitle(body) {
  const match = body.match(/<title>([^<]+)<\/title>/i);
  return match?.[1] ?? null;
}

function normalizeUnique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getHeaderIgnoreCase(headers = {}, headerName = '') {
  const target = String(headerName).toLowerCase();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (String(name).toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function isLikelyJsonMimeType(value = '') {
  const normalized = String(value ?? '').toLowerCase();
  return normalized.includes('application/json')
    || normalized.includes('+json')
    || normalized.includes('graphql-response+json')
    || normalized.includes('text/json');
}

function parseJsonTextMaybe(value) {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const NETWORK_PRIMARY_KEYS = new Set([
  'data',
  'result',
  'results',
  'payload',
  'response',
  'body',
  'content',
  'value',
  'props',
  'pageprops',
]);

const NETWORK_COLLECTION_KEYS = new Set([
  'items',
  'list',
  'results',
  'records',
  'products',
  'entries',
  'edges',
  'nodes',
  'hits',
  'documents',
  'articles',
  'rows',
  'collections',
  'collection',
]);

const NETWORK_META_KEYS = new Set([
  'ok',
  'success',
  'status',
  'statuscode',
  'code',
  'message',
  'messages',
  'error',
  'errors',
  'meta',
  'metadata',
  'requestid',
  'traceid',
  'timestamp',
  'tokentype',
  'expiresin',
]);

const NETWORK_PAGINATION_KEYS = new Set([
  'pageinfo',
  'pagination',
  'paging',
  'cursor',
  'nextcursor',
  'prevcursor',
  'hasnextpage',
  'haspreviouspage',
  'total',
  'totalcount',
  'count',
  'offset',
  'limit',
]);

function normalizeNetworkKey(key = '') {
  return String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function appendObjectPath(base, key) {
  return base ? `${base}.${key}` : key;
}

function compileRegexList(patterns, flags = '') {
  if (!Array.isArray(patterns)) {
    return [];
  }

  return patterns
    .map((pattern) => {
      try {
        return new RegExp(pattern, flags);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function scoreJsonNode(value, depth = 0) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return -8 - depth;
    }

    const sample = value.slice(0, 3);
    const objectCount = sample.filter((entry) => isPlainObject(entry)).length;
    const nestedArrayCount = sample.filter(Array.isArray).length;
    return 28 + Math.min(30, value.length * 4) + objectCount * 10 + nestedArrayCount * 6 - depth * 2;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return -10 - depth;
    }

    const normalizedKeys = keys.map(normalizeNetworkKey);
    const collectionCount = normalizedKeys.filter((key) => NETWORK_COLLECTION_KEYS.has(key)).length;
    const paginationCount = normalizedKeys.filter((key) => NETWORK_PAGINATION_KEYS.has(key)).length;
    const metaCount = normalizedKeys.filter((key) => NETWORK_META_KEYS.has(key)).length;
    const dataKeyCount = normalizedKeys.filter((key) => !NETWORK_META_KEYS.has(key)).length;

    let score = 10;
    if (collectionCount > 0) {
      score += 45 + Math.min(15, collectionCount * 6);
    }
    if (collectionCount > 0 && dataKeyCount <= 2) {
      score += 14;
    }
    if (normalizedKeys.includes('data')) {
      score += 18;
    }
    if (paginationCount > 0 && collectionCount > 0) {
      score += 14;
    }
    if (dataKeyCount > 0 && dataKeyCount <= 4) {
      score += 10;
    }
    if (dataKeyCount === 1 && keys.length <= 3) {
      score += 12;
    }
    if (metaCount === keys.length) {
      score -= 35;
    }
    if (normalizedKeys.includes('errors') && !normalizedKeys.includes('data')) {
      score -= 25;
    }
    if (normalizedKeys.includes('token') && keys.length <= 3) {
      score -= 12;
    }

    return score - depth * 2;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      return -8 - depth;
    }
    if (/^(ok|success|true|false)$/i.test(text)) {
      return -10 - depth;
    }
    return Math.min(12, Math.floor(text.length / 40));
  }

  if (typeof value === 'boolean') {
    return -6 - depth;
  }

  if (typeof value === 'number') {
    return 1 - depth;
  }

  return 0 - depth;
}

function selectPrimaryJsonValue(value, path = '', depth = 0) {
  const selfScore = scoreJsonNode(value, depth);
  let best = {
    value,
    path,
    score: selfScore,
  };

  if (depth >= 5 || value === null || typeof value !== 'object') {
    return best;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 3); index += 1) {
      const entry = value[index];
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const child = selectPrimaryJsonValue(entry, appendObjectPath(path, String(index)), depth + 1);
      const score = child.score - 10;
      if (score > best.score) {
        best = {
          value: child.value,
          path: child.path,
          score,
        };
      }
    }

    return best;
  }

  const entries = Object.entries(value);
  const nonMetaEntries = entries.filter(([key]) => !NETWORK_META_KEYS.has(normalizeNetworkKey(key)));
  const singleInterestingKey = nonMetaEntries.length === 1;

  for (const [key, childValue] of entries) {
    if (childValue === undefined) {
      continue;
    }

    const childPath = appendObjectPath(path, key);
    const child = selectPrimaryJsonValue(childValue, childPath, depth + 1);
    const normalizedKey = normalizeNetworkKey(key);
    let bonus = 0;

    if (NETWORK_PRIMARY_KEYS.has(normalizedKey)) {
      bonus += 35;
    }
    if (NETWORK_COLLECTION_KEYS.has(normalizedKey)) {
      bonus += 28;
    }
    if (NETWORK_META_KEYS.has(normalizedKey)) {
      bonus -= 25;
    }
    if (NETWORK_PAGINATION_KEYS.has(normalizedKey)) {
      bonus -= 4;
    }
    if (singleInterestingKey && !NETWORK_META_KEYS.has(normalizedKey)) {
      bonus += 18;
    }

    const score = child.score + bonus - depth * 4;
    if (score > best.score) {
      best = {
        value: child.value,
        path: child.path,
        score,
      };
    }
  }

  return best;
}

function safeUrlText(input = '') {
  try {
    const parsed = new URL(input);
    return `${parsed.pathname}${parsed.search}`.toLowerCase();
  } catch {
    return String(input ?? '').toLowerCase();
  }
}

function analyzeNetworkEndpoint({ url = '', method = 'GET', requestBodyText = '', requestBodyJson = null } = {}) {
  const urlText = safeUrlText(url);
  const methodText = String(method ?? 'GET').toUpperCase();
  const requestText = String(requestBodyText ?? '').toLowerCase();
  const reasons = [];
  let score = 0;
  let category = 'other';

  const addSignal = (condition, nextCategory, nextScore, reason, { forceCategory = false } = {}) => {
    if (!condition) {
      return;
    }

    score += nextScore;
    reasons.push(reason);
    if (forceCategory || category === 'other' || Math.abs(nextScore) >= 18) {
      category = nextCategory;
    }
  };

  addSignal(
    urlText.includes('/graphql') || Boolean(requestBodyJson?.query) || Boolean(requestBodyJson?.operationName) || requestText.includes('"query"'),
    'graphql',
    36,
    'graphql-interface',
    { forceCategory: true },
  );
  addSignal(
    /(?:^|\/)(metrics?|stats|telemetry|rum)(?:\/|$)/i.test(urlText),
    'metrics',
    -40,
    'metrics-endpoint',
    { forceCategory: true },
  );
  addSignal(
    /analytics|beacon|collect|track|pixel|events?(?:\/|$)|logging?(?:\/|$)/i.test(urlText),
    'analytics',
    -42,
    'analytics-endpoint',
    { forceCategory: true },
  );
  addSignal(
    /(?:^|\/)(auth|login|logout|token|session|csrf|captcha)(?:\/|$)/i.test(urlText),
    'auth',
    -34,
    'auth-endpoint',
    { forceCategory: true },
  );
  addSignal(
    /(?:^|\/)(health|heartbeat|ping|ready|live)(?:\/|$)/i.test(urlText),
    'health',
    -18,
    'health-endpoint',
    { forceCategory: true },
  );
  addSignal(
    /bootstrap|initial|prefetch|dehydrated|hydration|page-data/i.test(urlText),
    'bootstrap-data',
    16,
    'bootstrap-endpoint',
  );
  addSignal(
    /\/api\/|\/rest\/|\/v\d+\//i.test(urlText),
    'api-data',
    14,
    'api-path',
  );
  addSignal(
    /search|results|catalog|collection|listing|products?|items?|detail|content|feed/i.test(urlText),
    'content-data',
    10,
    'content-endpoint',
  );

  if (methodText === 'POST' && ['graphql', 'api-data', 'bootstrap-data', 'content-data'].includes(category)) {
    score += 4;
    reasons.push('post-request');
  }

  return {
    score,
    category,
    reasons,
  };
}

function scorePatternHints(url, preferPatterns = [], avoidPatterns = []) {
  const urlText = String(url ?? '');
  let score = 0;
  const reasons = [];

  for (const pattern of preferPatterns) {
    if (pattern.test(urlText)) {
      score += 18;
      reasons.push(`prefer:${pattern.source}`);
    }
  }

  for (const pattern of avoidPatterns) {
    if (pattern.test(urlText)) {
      score -= 28;
      reasons.push(`avoid:${pattern.source}`);
    }
  }

  return {
    score,
    reasons,
  };
}

function scoreNetworkCandidate(candidate, index, total) {
  const status = Number(candidate.status ?? 0);
  const bodyBytes = Number(candidate.bodyBytes ?? 0);
  const dataShapeScore = Number(candidate.selectedDataScore ?? candidate.primaryDataScore ?? 0);
  const primaryDataScore = Number(candidate.primaryDataScore ?? 0);
  const payloadScore = Number(candidate.payloadScore ?? 0);
  return (
    (status >= 200 && status < 300 ? 50 : candidate.status == null ? 8 : 0)
    + (candidate.transport === 'fetch' ? 10 : candidate.transport === 'xhr' ? 8 : 0)
    + (candidate.isJson ? 25 : 0)
    + Math.min(15, Math.floor(bodyBytes / 256))
    + Math.max(-40, Math.min(40, Number(candidate.endpointScore ?? 0)))
    + Math.max(-20, Math.min(35, dataShapeScore))
    + (candidate.selection === 'primary-data' ? Math.max(0, Math.min(18, primaryDataScore)) : 0)
    + (payloadScore <= 0 ? -15 : 0)
    + Math.max(0, total - index)
  );
}

function extractNetworkPayload(response, rule = {}) {
  const requests = Array.isArray(response.debug?.requests) ? response.debug.requests : [];
  if (requests.length === 0) {
    return rule.all ? [] : null;
  }

  const transports = Array.isArray(rule.transports)
    ? rule.transports.map((value) => String(value).toLowerCase())
    : rule.transport
      ? [String(rule.transport).toLowerCase()]
      : ['fetch', 'xhr'];
  const urlPattern = rule.urlPattern ? new RegExp(rule.urlPattern, rule.flags ?? '') : null;
  const preferUrlPatterns = compileRegexList(rule.preferUrlPatterns, rule.flags ?? '');
  const avoidUrlPatterns = compileRegexList(rule.avoidUrlPatterns, rule.flags ?? '');
  const source = String(rule.source ?? 'response').toLowerCase();
  const selection = String(rule.selection ?? 'payload').toLowerCase();
  const requireJson = rule.requireJson !== false;
  const includeMeta = rule.includeMeta === true;
  const maxItems = Math.max(1, Number(rule.maxItems ?? 10));

  const candidates = requests
    .map((entry, index) => {
      const transport = String(entry.transport ?? '').toLowerCase();
      if (transports.length > 0 && !transports.includes(transport)) {
        return null;
      }
      if (urlPattern && !urlPattern.test(String(entry.url ?? ''))) {
        return null;
      }

      const bodyRecord = source === 'request' ? entry.requestBody : entry.responseBody;
      const bodyText = bodyRecord?.text ?? null;
      const requestBodyText = entry.requestBody?.text ?? null;
      const mimeType = String(
        entry.mimeType
        ?? getHeaderIgnoreCase(entry.responseHeaders ?? {}, 'content-type')
        ?? getHeaderIgnoreCase(entry.requestHeaders ?? {}, 'content-type')
        ?? '',
      );
      const parsed = parseJsonTextMaybe(bodyText);
      const requestBodyJson = parseJsonTextMaybe(requestBodyText);
      const isJson = parsed !== null || isLikelyJsonMimeType(mimeType);
      if (requireJson && parsed === null) {
        return null;
      }

      const payload = parsed ?? bodyText;
      const primarySelection = parsed !== null
        ? selectPrimaryJsonValue(parsed)
        : {
            value: payload,
            path: '',
            score: 0,
          };
      const value = rule.path
        ? readObjectPath(payload, rule.path)
        : selection === 'primary-data' && parsed !== null
          ? primarySelection.value
          : payload;
      if (value === undefined) {
        return null;
      }

      const endpointAnalysis = analyzeNetworkEndpoint({
        url: entry.url ?? null,
        method: entry.method ?? 'GET',
        requestBodyText,
        requestBodyJson,
      });
      const patternHints = scorePatternHints(entry.url ?? '', preferUrlPatterns, avoidUrlPatterns);
      const selectedPath = rule.path
        ? rule.path
        : selection === 'primary-data' && primarySelection.path
          ? primarySelection.path
          : null;

      const candidate = {
        url: entry.url ?? null,
        method: entry.method ?? 'GET',
        status: entry.status ?? null,
        transport,
        mimeType: mimeType || null,
        bodyBytes: bodyRecord?.bytes ?? Buffer.byteLength(bodyText ?? ''),
        isJson,
        apiCategory: endpointAnalysis.category,
        signals: [...endpointAnalysis.reasons, ...patternHints.reasons],
        selection,
        selectedBy: rule.path
          ? 'path'
          : selection === 'primary-data' && primarySelection.path
            ? 'primary-data'
            : 'payload',
        dataPath: selectedPath,
        primaryDataPath: primarySelection.path || null,
        selectedDataScore: scoreJsonNode(value),
        primaryDataScore: primarySelection.score,
        payloadScore: parsed !== null ? scoreJsonNode(parsed) : 0,
        endpointScore: endpointAnalysis.score + patternHints.score,
        data: value,
      };

      return {
        ...candidate,
        score: scoreNetworkCandidate(candidate, index, requests.length),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxItems);

  if (rule.all) {
    return includeMeta
      ? candidates.map(({ score, endpointScore, selectedDataScore, primaryDataScore, payloadScore, ...item }) => item)
      : candidates.map((item) => item.data);
  }

  const best = candidates[0] ?? null;
  if (!best) {
    return null;
  }
  if (includeMeta) {
    const { score, endpointScore, selectedDataScore, primaryDataScore, payloadScore, ...item } = best;
    return item;
  }
  return best.data;
}

export function extractLinksFallback(body, baseUrl, maxItems = 50, { format = 'url' } = {}) {
  const matches = body.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi);
  const links = [];

  for (const match of matches) {
    try {
      const url = new URL(match[1], baseUrl).href;
      if (format === 'object') {
        const fullTag = match[0];
        const relMatch = fullTag.match(/rel=["']([^"']+)["']/i);
        const rel = relMatch ? relMatch[1] : null;
        const nofollow = rel ? rel.toLowerCase().split(/\s+/).includes('nofollow') : false;

        links.push({
          url,
          text: null,
          tagName: 'a',
          rel,
          nofollow,
          hreflang: null,
          mediaType: null,
        });
      } else {
        links.push(url);
      }
    } catch {
      continue;
    }
  }

  return normalizeUnique(links).slice(0, maxItems);
}

function analyzeSurface(response) {
  const body = response.body;
  const scriptMatches = Array.from(body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi))
    .map((match) => {
      try {
        return new URL(match[1], response.finalUrl).href;
      } catch {
        return match[1];
      }
    })
    .slice(0, 50);

  const endpointMatches = Array.from(
    body.matchAll(/https?:\/\/[^\s"'<>`]+|\/api\/[A-Za-z0-9/_?&=.-]+/g),
  )
    .map((match) => match[0])
    .slice(0, 50);

  const cryptoSignals = normalizeUnique(
    Array.from(body.matchAll(/\b(cryptojs|aes|des|rsa|hmac|sha1|sha256|sha512|md5|base64)\b/gi)).map(
      (match) => match[0].toLowerCase(),
    ),
  );

  const obfuscationSignals = normalizeUnique(
    Array.from(body.matchAll(/eval\(|Function\(|fromCharCode|atob\(|btoa\(|\\x[0-9a-f]{2}|_0x[a-z0-9]+/gi)).map(
      (match) => match[0],
    ),
  );

  const antiAutomationSignals = normalizeUnique(
    Array.from(
      body.matchAll(/\b(webdriver|navigator\.plugins|navigator\.languages|webgl|canvas|fingerprint)\b/gi),
    ).map((match) => match[0]),
  );

  const bundlerSignals = normalizeUnique(
    Array.from(body.matchAll(/\b(__webpack_require__|webpackJsonp|vite|parcel|rollup)\b/gi)).map(
      (match) => match[0],
    ),
  );

  const inlineScriptCount = (body.match(/<script(?![^>]+src=)[^>]*>/gi) ?? []).length;

  return {
    bodyHash: hashText(body),
    title: response.domMeta?.title ?? firstTitle(body),
    scriptAssets: scriptMatches,
    inlineScriptCount,
    possibleApiEndpoints: endpointMatches,
    signals: {
      crypto: cryptoSignals,
      obfuscation: obfuscationSignals,
      antiAutomation: antiAutomationSignals,
      bundlers: bundlerSignals,
    },
    score:
      cryptoSignals.length * 3 +
      obfuscationSignals.length * 3 +
      antiAutomationSignals.length * 2 +
      bundlerSignals.length,
  };
}

function buildMeta(response) {
  return {
    url: response.finalUrl,
    status: response.status,
    contentType: response.headers['content-type'] ?? response.headers['Content-Type'] ?? null,
    title: response.domMeta?.title ?? firstTitle(response.body),
    bodyBytes: Buffer.byteLength(response.body),
    bodyHash: hashText(response.body),
  };
}

export async function applyRule({ rule, response, workflow, logger }) {
  const resolvedRule = response.replayState
    ? interpolateReplayValue(rule, response.replayState, { strict: true })
    : rule;

  switch (resolvedRule.type) {
    case 'regex': {
      const expression = new RegExp(
        resolvedRule.pattern ?? '',
        resolvedRule.all && !(resolvedRule.flags ?? '').includes('g') ? `${resolvedRule.flags ?? ''}g` : resolvedRule.flags ?? '',
      );
      if (resolvedRule.all) {
        const values = Array.from(response.body.matchAll(expression)).map((match) => match[1] ?? match[0]);
        return values.slice(0, resolvedRule.maxItems ?? 50);
      }

      const match = response.body.match(expression);
      return match?.[1] ?? match?.[0] ?? null;
    }

    case 'json': {
      const parsed = parseJsonMaybe(response.body);
      return parsed === null ? null : readObjectPath(parsed, resolvedRule.path);
    }

    case 'script': {
      const parsed = parseJsonMaybe(response.body);
      const source = resolvedRule.code?.includes('return ') ? `(function(){${resolvedRule.code}})()` : resolvedRule.code ?? 'null';

      return vm.runInNewContext(
        source,
        {
          body: response.body,
          json: parsed,
          headers: response.headers,
          meta: buildMeta(response),
          url: response.finalUrl,
          URL,
        },
        { timeout: 1000 },
      );
    }

    case 'surface':
      return analyzeSurface(response);

    case 'reverse': {
      const contentType = response.headers['content-type'] ?? response.headers['Content-Type'] ?? '';
      const inferredMode =
        resolvedRule.mode === 'auto'
          ? contentType.includes('html') || /<html|<script/i.test(response.body)
            ? 'html'
            : 'script'
          : resolvedRule.mode;

      return runReverseOperation({
        ...resolvedRule,
        mode: inferredMode,
        code: typeof resolvedRule.code === 'string' && resolvedRule.code ? resolvedRule.code : response.body,
        html: response.body,
        target: response.finalUrl,
        baseUrl: response.finalUrl,
        title: buildMeta(response).title,
        curlCommand: typeof resolvedRule.curlCommand === 'string' ? resolvedRule.curlCommand : response.body,
      });
    }

    case 'xpath':
      return evaluateXPath(response.body, resolvedRule);

    case 'media':
      return extractMediaAssets(response, resolvedRule);

    case 'network':
      return extractNetworkPayload(response, resolvedRule);

    case 'links':
    case 'selector':
      try {
        const result = await queryHtmlBatch(response.body, [resolvedRule], {
          baseUrl: response.finalUrl,
          browser: workflow.browser,
        });

        return result[resolvedRule.name] ?? null;
      } catch (error) {
        logger?.warn('dom extraction fallback used', {
          rule: resolvedRule.name,
          error: error?.message ?? String(error),
        });

        if (resolvedRule.type === 'links') {
          const links = extractLinksFallback(
            response.body,
            response.finalUrl,
            resolvedRule.maxItems ?? 50,
            { format: resolvedRule.format ?? 'url' },
          );
          return resolvedRule.all ? links : links[0] ?? null;
        }

        return null;
      }

    default:
      return null;
  }
}

export async function runExtractors({ workflow, response, logger }) {
  const extracted = {
    _meta: buildMeta(response),
  };

  for (const rule of workflow.extract) {
    extracted[rule.name] = await applyRule({
      rule,
      response,
      workflow,
      logger,
    });
  }

  return extracted;
}
