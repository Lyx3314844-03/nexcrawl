import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '../core/logger.js';
import { appendNdjson, ensureDir, writeJson } from '../utils/fs.js';
import { loadWorkflow } from './workflow-loader.js';
import { SessionStore } from './session-store.js';
import { ProxyPool } from './proxy-pool.js';
import { MiddlewareManager } from '../plugins/middleware-manager.js';
import { SinkManager } from './sink-manager.js';
import { closeBrowser } from '../fetchers/browser-fetcher.js';
import { applyRule, runExtractors } from '../extractors/extractor-engine.js';
import { validateWorkflow } from '../schemas/workflow-schema.js';
import { RequestQueue, normalizeRequestPriority } from './request-queue.js';
import { SqliteRequestQueue } from './sqlite-request-queue.js';
import { RedisRequestQueue } from './redis-request-queue.js';
import { SessionPool } from './session-pool.js';
import { AutoscaleController } from './autoscaler.js';
import { DatasetStore } from './dataset-store.js';
import { KeyValueStore } from './key-value-store.js';
import { SqliteDatasetStore } from './sqlite-dataset-store.js';
import { SqliteKeyValueStore } from './sqlite-key-value-store.js';
import { QualityTracker } from './quality-monitor.js';
import { analyzeBaseline } from './baseline-analyzer.js';
import { analyzeTrends } from './trend-analyzer.js';
import { CrawlPolicyManager } from './crawl-policy.js';
import { HttpCacheStore } from './http-cache-store.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { ExportManager } from './export-manager.js';
import { setupObservability, summarizeObservability } from './observability.js';
import { getUrlPathExtension } from '../utils/url.js';
import { interpolateReplayValue } from '../utils/replay-template.js';
import { applyAfterResponseHooks, buildResultRecord, enrichResultRecord, executeFetchAttempt, finalizeProcessedResult, handleDetectedChallenge, handleRetryableError, handleRetryableResponse, reportFailedFetchAttempt, reportSuccessfulFetchAttempt, waitForGroupBackoff } from './job-attempt.js';
import { createWorkflowReverseRuntime } from './reverse-workflow-runtime.js';
import { createAutoScrollPlugin } from '../fetchers/scroll-handler.js';
import { GroupBackoffController } from './group-backoff.js';
import { discoverNextPage } from './pagination-discovery.js';
import { changeTrackingSnapshot, dispatchAvailableItems, enqueueInitialRequests, frontierSnapshot, getSeedRequests, waitForDispatchProgress } from './job-frontier.js';
import { createTerminalSummary, enrichTerminalSummary, finalizeTerminalSummary, persistTerminalSummaryState } from './job-summary.js';
import { getGlobalConfig } from '../utils/config.js';

function createLocalJobId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function applyGlobalWorkflowDefaults(workflow = {}) {
  const globalConfig = getGlobalConfig();
  return {
    ...workflow,
    concurrency: workflow.concurrency ?? globalConfig.get('performance.concurrency') ?? undefined,
    timeoutMs: workflow.timeoutMs ?? globalConfig.get('performance.timeout') ?? undefined,
  };
}

function mergeReplayState(baseState, nextState) {
  const merged = {
    ...(baseState ?? {}),
    ...(nextState ?? {}),
  };

  return Object.keys(merged).length > 0 ? merged : null;
}

function mergeIdentityConfig(base = null, override = null) {
  const left = base && typeof base === 'object' && !Array.isArray(base) ? base : null;
  const right = override && typeof override === 'object' && !Array.isArray(override) ? override : null;

  if (!left && !right) {
    return null;
  }

  return {
    ...(left ?? {}),
    ...(right ?? {}),
    clientHints: {
      ...((left?.clientHints && typeof left.clientHints === 'object' && !Array.isArray(left.clientHints)) ? left.clientHints : {}),
      ...((right?.clientHints && typeof right.clientHints === 'object' && !Array.isArray(right.clientHints)) ? right.clientHints : {}),
    },
    languages: Array.isArray(right?.languages)
      ? [...right.languages]
      : Array.isArray(left?.languages)
        ? [...left.languages]
        : [],
    enabled: (right?.enabled ?? left?.enabled) !== false,
  };
}

function resolveReplayAwareValue(value, replayState, { strict = true } = {}) {
  if (value === undefined) {
    return undefined;
  }

  if (replayState === null || replayState === undefined) {
    return value;
  }

  return interpolateReplayValue(value, replayState ?? {}, { strict });
}

function getIdentityConsistencyConfig(identity = {}) {
  const consistency = identity?.consistency && typeof identity.consistency === 'object' && !Array.isArray(identity.consistency)
    ? identity.consistency
    : {};

  return {
    httpHeaders: consistency.httpHeaders !== false,
    browserProfile: consistency.browserProfile !== false,
    bindProxyRegion: consistency.bindProxyRegion === true,
    driftDetection: consistency.driftDetection !== false,
    autoCorrect: consistency.autoCorrect !== false,
  };
}

function getHeaderValue(headers = {}, name) {
  const target = String(name ?? '').toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (String(key).toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function setHeaderValue(headers = {}, name, value) {
  const target = String(name ?? '').toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === target) {
      delete headers[key];
    }
  }
  headers[target] = value;
}

function profileName(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    return value.name ?? value.profile ?? 'custom';
  }
  return String(value);
}

function normalizeProxyLocationValue(value) {
  return value == null ? null : String(value).trim().toLowerCase();
}

function buildIdentityAcceptLanguage(identity = {}) {
  if (identity.acceptLanguage) {
    return String(identity.acceptLanguage);
  }

  const languages = Array.isArray(identity.languages)
    ? identity.languages.filter(Boolean).map((entry) => String(entry))
    : [];
  const ordered = languages.length > 0
    ? languages
    : identity.locale
      ? [String(identity.locale)]
      : [];

  if (ordered.length === 0) {
    return null;
  }

  return ordered
    .slice(0, 10)
    .map((entry, index) => {
      if (index === 0) {
        return entry;
      }
      const q = Math.max(0.1, 1 - (index * 0.1));
      return `${entry};q=${q.toFixed(1)}`;
    })
    .join(',');
}

function buildIdentityHttpHeaders(identity = {}) {
  const clientHints =
    identity.clientHints && typeof identity.clientHints === 'object' && !Array.isArray(identity.clientHints)
      ? identity.clientHints
      : {};

  return Object.fromEntries(
    Object.entries({
      'user-agent': identity.userAgent,
      'accept-language': buildIdentityAcceptLanguage(identity),
      ...clientHints,
    }).filter(([, value]) => value !== undefined && value !== null && String(value).length > 0),
  );
}

function buildIdentityProxyBinding(identity = {}) {
  const binding = {
    region: normalizeProxyLocationValue(identity.proxyRegion),
    country: normalizeProxyLocationValue(identity.proxyCountry),
    city: normalizeProxyLocationValue(identity.proxyCity),
  };

  return binding.region || binding.country || binding.city ? binding : null;
}

function enforceIdentityConsistency(request, workflow) {
  const identity = request.identity && typeof request.identity === 'object' ? request.identity : null;
  if (!identity || identity.enabled === false) {
    return request;
  }

  const consistency = getIdentityConsistencyConfig(identity);
  // Carry forward corrections recorded in a prior enforcement pass (e.g. the
  // initial buildResolvedRequestInput pass) so that the post-plugin pass does
  // not reset the accumulated correctionCount to zero.
  const prior = request._identityConsistency && typeof request._identityConsistency === 'object'
    ? request._identityConsistency
    : null;
  const report = {
    enabled: true,
    autoCorrect: consistency.autoCorrect,
    driftDetection: consistency.driftDetection,
    bindProxyRegion: consistency.bindProxyRegion,
    // Recompute from the current request state on every pass so the
    // post-plugin enforcement step reflects the final outbound request.
    unsupported: prior ? [...prior.unsupported] : [],
    driftFields: prior ? [...prior.driftFields] : [],
    correctionFields: prior ? [...prior.correctionFields] : [],
    drifts: prior ? [...prior.drifts] : [],
    corrections: prior ? [...prior.corrections] : [],
  };

  const pushUniqueField = (list, field) => {
    if (!list.includes(field)) {
      list.push(field);
    }
  };

  const pushUniqueEntry = (list, entry) => {
    if (!list.some((existing) =>
      existing?.field === entry.field
      && existing?.expected === entry.expected
      && existing?.actual === entry.actual
      && existing?.reason === entry.reason)) {
      list.push(entry);
    }
  };

  const recordDrift = (field, expected, actual) => {
    if (!consistency.driftDetection || expected === undefined || expected === null || actual === undefined || actual === null) {
      return;
    }
    pushUniqueField(report.driftFields, field);
    pushUniqueEntry(report.drifts, { field, expected, actual });
  };

  const recordCorrection = (field, expected, actual) => {
    pushUniqueField(report.correctionFields, field);
    pushUniqueEntry(report.corrections, { field, expected, actual });
  };

  if (consistency.httpHeaders) {
    for (const [headerName, expectedValue] of Object.entries(buildIdentityHttpHeaders(identity))) {
      if (!expectedValue) {
        continue;
      }
      const actualValue = getHeaderValue(request.headers, headerName);
      if (actualValue !== undefined && String(actualValue) !== String(expectedValue)) {
        recordDrift(headerName, expectedValue, actualValue);
      }
      if (consistency.autoCorrect && String(actualValue ?? '') !== String(expectedValue)) {
        setHeaderValue(request.headers, headerName, String(expectedValue));
        recordCorrection(headerName, expectedValue, actualValue ?? null);
      }
    }
  }

  if (consistency.browserProfile) {
    for (const [field, expectedValue] of [
      ['tlsProfile', identity.tlsProfile],
      ['h2Profile', identity.h2Profile],
    ]) {
      if (!expectedValue) {
        continue;
      }
      const expectedName = profileName(expectedValue);
      const actualName = profileName(request[field]);
      if (actualName !== null && actualName !== expectedName) {
        recordDrift(field, expectedName, actualName);
      }
      if (consistency.autoCorrect && actualName !== expectedName) {
        request[field] = expectedValue;
        recordCorrection(field, expectedName, actualName);
      }
    }
  }

  if (consistency.bindProxyRegion) {
    const binding = buildIdentityProxyBinding(identity);
    if (!binding) {
      pushUniqueEntry(report.unsupported, {
        field: 'bindProxyRegion',
        reason: 'bindProxyRegion is enabled but identity.proxyRegion / proxyCountry / proxyCity is not configured',
      });
    } else {
      for (const [field, expected] of Object.entries(binding)) {
        if (!expected) {
          continue;
        }
        const actual = normalizeProxyLocationValue(request.proxy?.[field]);
        if (!actual) {
          pushUniqueEntry(report.unsupported, {
            field: `proxy.${field}`,
            reason: 'selected proxy is missing location metadata required for region binding',
          });
          continue;
        }
        if (actual !== expected) {
          recordDrift(`proxy.${field}`, expected, actual);
        }
      }
    }
  }

  report.driftCount = report.drifts.length;
  report.correctionCount = report.corrections.length;
  request._identityConsistency = report;
  return request;
}

function buildResolvedRequestInput(item, workflow, { proxy, session } = {}) {
  const replayState = item.replayState ?? null;
  const workflowRequest = workflow.request ?? {};
  const workflowGrpc =
    workflow.grpc && typeof workflow.grpc === 'object' && !Array.isArray(workflow.grpc)
      ? workflow.grpc
      : {};
  const effectiveIdentity = mergeIdentityConfig(workflow.identity ?? null, session?._boundIdentityProfile ?? null);
  const workflowWebSocket =
    workflow.websocket && typeof workflow.websocket === 'object' && !Array.isArray(workflow.websocket)
      ? workflow.websocket
      : {};
  const itemGrpc =
    item.grpc && typeof item.grpc === 'object' && !Array.isArray(item.grpc)
      ? item.grpc
      : {};
  const itemWebSocket =
    item.websocket && typeof item.websocket === 'object' && !Array.isArray(item.websocket)
      ? item.websocket
      : {};
  const request = {
    url: resolveReplayAwareValue(item.url, replayState),
    method: String(resolveReplayAwareValue(item.method ?? workflowRequest.method ?? 'GET', replayState)).toUpperCase(),
    headers: {
      ...buildIdentityHttpHeaders(effectiveIdentity ?? {}),
      ...(resolveReplayAwareValue(workflow.headers ?? {}, replayState) ?? {}),
      ...(resolveReplayAwareValue(item.headers ?? {}, replayState) ?? {}),
    },
    body: resolveReplayAwareValue(item.body ?? workflowRequest.body, replayState),
    timeoutMs: workflow.timeoutMs,
    proxy,
    session,
    identity: effectiveIdentity,
    replayState,
    grpc: resolveReplayAwareValue({
      ...workflowGrpc,
      ...itemGrpc,
    }, replayState),
    websocket: resolveReplayAwareValue({
      ...workflowWebSocket,
      ...itemWebSocket,
    }, replayState),
  };

  return enforceIdentityConsistency(request, workflow);
}

function resolveEnqueueCandidate(item = {}) {
  const replayState = item.replayState ?? null;
  return {
    ...item,
    url: resolveReplayAwareValue(item.url, replayState),
    method: item.method === undefined ? undefined : String(resolveReplayAwareValue(item.method, replayState)).toUpperCase(),
    headers: item.headers === undefined ? undefined : resolveReplayAwareValue(item.headers, replayState),
    body: item.body === undefined ? undefined : resolveReplayAwareValue(item.body, replayState),
    label: item.label === undefined ? undefined : resolveReplayAwareValue(item.label, replayState),
  };
}

function buildQueuedRequestInput(item, workflow, priority) {
  const workflowRequest = workflow.request ?? {};
  return {
    ...item,
    method: item.method ?? workflowRequest.method ?? 'GET',
    headers: {
      ...(workflow.headers ?? {}),
      ...(item.headers ?? {}),
    },
    body: item.body ?? workflowRequest.body,
    grpc: item.grpc ?? workflow.grpc ?? undefined,
    priority,
  };
}

function buildFailedRequestInput(item, workflow) {
  const workflowRequest = workflow.request ?? {};
  return {
    url: item.url,
    method: item.method ?? workflowRequest.method ?? 'GET',
    headers: {
      ...(workflow.headers ?? {}),
      ...(item.headers ?? {}),
    },
    body: item.body ?? workflowRequest.body,
    depth: item.depth,
    parentUrl: item.parentUrl ?? null,
    uniqueKey: item.uniqueKey ?? null,
    label: item.label ?? item.metadata?.label ?? null,
    userData: item.userData ?? {},
    metadata: item.metadata ?? {},
    grpc: item.grpc ?? workflow.grpc ?? undefined,
  };
}

function selectMode(workflow) {
  if (workflow.mode !== 'hybrid') {
    return workflow.mode;
  }

  const domRules = workflow.extract.some((rule) => rule.type === 'selector');
  const domDiscovery = workflow.discovery.extractor?.type === 'links' && Boolean(workflow.discovery.extractor?.selector);
  return domRules || domDiscovery ? 'browser' : 'http';
}

function queuePriorityConfig(workflow = {}) {
  return {
    seed: Number(workflow.requestQueue?.priority?.seed ?? 100),
    sitemap: Number(workflow.requestQueue?.priority?.sitemap ?? 80),
    discovery: Number(workflow.requestQueue?.priority?.discovery ?? 50),
    depthPenalty: Math.max(0, Number(workflow.requestQueue?.priority?.depthPenalty ?? 10)),
  };
}

function frontierConfig(workflow = {}) {
  const requestQueue = workflow.requestQueue ?? {};
  const maxInProgressPerGroup = Number(requestQueue.maxInProgressPerGroup ?? requestQueue.maxInProgressPerHost ?? 1);
  const seenSetInput = requestQueue.seenSet ?? {};
  const seenSetScope = String(seenSetInput.scope ?? 'workflow').trim().toLowerCase() === 'custom'
    ? 'custom'
    : 'workflow';
  const seenSetEnabled = seenSetInput.enabled === true || Boolean(seenSetInput.id);
  const seenSetId = seenSetEnabled
    ? String(
      seenSetInput.id
      ?? (seenSetScope === 'workflow' ? workflow.name : `${workflow.name}:seen-set`),
    ).trim()
    : null;

  return {
    hostAwareScheduling: requestQueue.hostAwareScheduling !== false,
    groupBy: String(requestQueue.groupBy ?? 'hostname'),
    maxInProgressPerGroup: Number.isFinite(maxInProgressPerGroup) ? Math.max(0, maxInProgressPerGroup) : 1,
    budgetWindowMs: Math.max(0, Number(requestQueue.budgetWindowMs ?? 0)),
    maxRequestsPerWindow: Math.max(0, Number(requestQueue.maxRequestsPerWindow ?? 0)),
    seenSet: {
      enabled: seenSetEnabled,
      scope: seenSetScope,
      id: seenSetId,
    },
  };
}

function mergeObservabilityConfig(workflow, jobId) {
  if (!workflow?.observability) {
    return null;
  }

  const tracing = workflow.observability.tracing
    ? {
        ...workflow.observability.tracing,
        serviceName: workflow.observability.tracing.serviceName ?? `omnicrawl:${workflow.name}`,
      }
    : { enabled: false };
  const metrics = workflow.observability.metrics
    ? {
        ...workflow.observability.metrics,
        defaultLabels: {
          workflow: workflow.name,
          job_id: jobId,
          ...(workflow.observability.metrics.defaultLabels ?? {}),
        },
      }
    : { enabled: false };

  return { tracing, metrics };
}

function annotateRequestError(error, metadata = {}) {
  const nextError = error instanceof Error ? error : new Error(String(error));

  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      nextError[key] = value;
    }
  }

  return nextError;
}

function normalizeDiscoveryFileExtension(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

const DEFAULT_DISCOVERY_ASSET_EXTENSIONS = new Set([
  '.7z', '.avi', '.bmp', '.css', '.csv', '.doc', '.docx', '.gif', '.gz', '.ico', '.jpeg', '.jpg',
  '.js', '.json', '.m4a', '.mov', '.mp3', '.mp4', '.pdf', '.png', '.ppt', '.pptx', '.rar', '.rss',
  '.svg', '.tar', '.tgz', '.txt', '.webm', '.webp', '.xls', '.xlsx', '.xml', '.zip',
]);

function normalizeRelTokens(value) {
  return String(value ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeDiscoveryCandidate(candidate, parentUrl) {
  if (typeof candidate === 'string') {
    try {
      return {
        url: new URL(candidate, parentUrl).href,
        text: null,
        tagName: 'a',
        rel: null,
        nofollow: false,
        hreflang: null,
        mediaType: null,
        method: undefined,
        headers: undefined,
        body: undefined,
        uniqueKey: undefined,
        label: undefined,
        userData: undefined,
        metadata: undefined,
        replayState: undefined,
      };
    } catch {
      return null;
    }
  }

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !candidate.url) {
    return null;
  }

  try {
    return {
      url: new URL(candidate.url, parentUrl).href,
      text: candidate.text == null ? null : String(candidate.text).trim() || null,
      tagName: candidate.tagName == null ? null : String(candidate.tagName).trim().toLowerCase() || null,
      rel: candidate.rel == null ? null : String(candidate.rel).trim() || null,
      nofollow: candidate.nofollow === true,
      hreflang: candidate.hreflang == null ? null : String(candidate.hreflang).trim().toLowerCase() || null,
      mediaType: candidate.mediaType == null ? null : String(candidate.mediaType).trim().toLowerCase() || null,
      method: candidate.method === undefined ? undefined : String(candidate.method).toUpperCase(),
      headers: candidate.headers && typeof candidate.headers === 'object' && !Array.isArray(candidate.headers)
        ? { ...candidate.headers }
        : undefined,
      body: candidate.body,
      uniqueKey: candidate.uniqueKey == null ? undefined : String(candidate.uniqueKey),
      label: candidate.label == null ? undefined : String(candidate.label),
      userData: candidate.userData && typeof candidate.userData === 'object' && !Array.isArray(candidate.userData)
        ? { ...candidate.userData }
        : undefined,
      metadata: candidate.metadata && typeof candidate.metadata === 'object' && !Array.isArray(candidate.metadata)
        ? { ...candidate.metadata }
        : undefined,
      replayState: candidate.replayState ?? undefined,
    };
  } catch {
    return null;
  }
}

function parseJsonObjectMaybe(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function classifyDiscoveryCandidate(candidate, { paginationUrl = null } = {}) {
  const url = candidate.url.toLowerCase();
  const text = String(candidate.text ?? '').trim().toLowerCase();
  const relTokens = normalizeRelTokens(candidate.rel);
  const extension = getUrlPathExtension(candidate.url);

  if ((paginationUrl && candidate.url === paginationUrl) || relTokens.includes('next')) {
    return 'pagination';
  }

  if (relTokens.includes('canonical')) {
    return 'canonical';
  }

  if (candidate.hreflang || (relTokens.includes('alternate') && candidate.tagName === 'link')) {
    return 'alternate-language';
  }

  if (DEFAULT_DISCOVERY_ASSET_EXTENSIONS.has(extension) || candidate.mediaType) {
    return 'asset';
  }

  if (/(^|\/)(logout|signout|log-out|exit)(\/|$)/i.test(url) || /\b(log\s*out|sign\s*out)\b/i.test(text)) {
    return 'logout';
  }

  if (/\/api(\/|$)|[?&](api|format)=/i.test(url)) {
    return 'api';
  }

  if (/([?&](page|p|pg|offset|cursor)=)|\/(page|p)\/\d+/i.test(url) || /\b(next|next page|older|more|load more|下一页|更多)\b/i.test(text)) {
    return 'pagination';
  }

  if (/([?&](q|query|keyword|search)=)|\/search(\/|$)/i.test(url) || /\bsearch\b/i.test(text)) {
    return 'search';
  }

  if (/([?&](category|cat|collection|tag|brand)=)|\/(category|categories|collection|collections|list|listing|catalog|catalogue|browse)(\/|$)/i.test(url)) {
    return 'listing';
  }

  if (/\/(product|products|item|items|detail|details|dp)\/|\/p\/[a-z0-9_-]+/i.test(url)) {
    return 'detail';
  }

  return 'generic';
}

function defaultDiscoveryPriority(kind) {
  if (kind === 'sitemap') return 90;
  if (kind === 'pagination') return 85;
  if (kind === 'detail') return 70;
  if (kind === 'listing') return 45;
  if (kind === 'search') return 40;
  if (kind === 'api') return 30;
  return undefined;
}

function defaultDiscoveryLabel(kind) {
  if (kind === 'sitemap') {
    return 'sitemap';
  }
  if (kind === 'alternate-language' || kind === 'canonical' || kind === 'logout' || kind === 'asset' || kind === 'generic') {
    return null;
  }

  return kind;
}

function detectXmlDiscoverySource(response) {
  const contentType = String(response?.headers?.['content-type'] ?? response?.headers?.['Content-Type'] ?? '').toLowerCase();
  const body = String(response?.body ?? '').trimStart().toLowerCase();
  const url = String(response?.finalUrl ?? response?.url ?? '').toLowerCase();

  if (contentType.includes('rss') || contentType.includes('atom')
    || body.startsWith('<rss') || body.startsWith('<?xml') && body.includes('<feed')
    || body.includes('<feed')) {
    return 'feed';
  }

  if (contentType.includes('xml')
    || url.includes('sitemap')
    || body.startsWith('<?xml') && (body.includes('<urlset') || body.includes('<sitemapindex'))
    || body.includes('<urlset')
    || body.includes('<sitemapindex')) {
    return 'sitemap';
  }

  return null;
}

function isJsonDiscoveryResponse(response) {
  const contentType = String(response?.headers?.['content-type'] ?? response?.headers?.['Content-Type'] ?? '').toLowerCase();
  const body = String(response?.body ?? '').trimStart();
  return contentType.includes('json') || body.startsWith('{') || body.startsWith('[');
}

function buildDefaultDiscoveryRule({ response, workflow }) {
  const xmlSource = detectXmlDiscoverySource(response);
  const maxItems = workflow.discovery.maxLinksPerPage;

  if (xmlSource === 'feed') {
    return {
      name: '__links__',
      type: 'script',
      code: `
        const maxItems = ${maxItems};
        const rssLinks = [...body.matchAll(/<item\\b[\\s\\S]*?<link\\b[^>]*>([\\s\\S]*?)<\\/link>/gi)]
          .map((match) => match[1]?.trim())
          .filter(Boolean);
        const atomLinks = [...body.matchAll(/<entry\\b[\\s\\S]*?<link\\b[^>]*href=["']([^"']+)["'][^>]*\\/?>(?:<\\/link>)?/gi)]
          .map((match) => match[1]?.trim())
          .filter(Boolean);
        return [...new Set([...rssLinks, ...atomLinks])].slice(0, maxItems);
      `,
    };
  }

  if (xmlSource === 'sitemap') {
    return {
      name: '__links__',
      type: 'xpath',
      all: true,
      xml: true,
      maxItems,
      xpath: '//url/loc/text() | //sitemap/loc/text()',
    };
  }

  return {
    name: '__links__',
    type: 'links',
    all: true,
    maxItems,
    selector: 'a[href], link[rel="next"][href], link[rel="canonical"][href], link[rel="alternate"][hreflang][href]',
    format: 'object',
  };
}

function buildCursorPaginationCandidate({ item, workflow, response, cursor }) {
  if (!cursor) {
    return null;
  }

  const bodySource = item.body ?? workflow.request?.body;
  const parsedBody = parseJsonObjectMaybe(bodySource);
  if (parsedBody) {
    const nextBody = {
      ...parsedBody,
      variables: {
        ...((parsedBody.variables && typeof parsedBody.variables === 'object' && !Array.isArray(parsedBody.variables)) ? parsedBody.variables : {}),
      },
    };

    const query = String(parsedBody.query ?? '');
    const variableNames = new Set([
      ...Object.keys(nextBody.variables),
      ...(query.includes('$after') ? ['after'] : []),
      ...(query.includes('$cursor') ? ['cursor'] : []),
      ...(query.includes('$nextCursor') ? ['nextCursor'] : []),
      ...(query.includes('$endCursor') ? ['endCursor'] : []),
    ]);

    if (variableNames.size === 0) {
      variableNames.add('cursor');
    }

    for (const name of variableNames) {
      nextBody.variables[name] = cursor;
    }

    return {
      url: item.url,
      method: item.method ?? workflow.request?.method ?? 'POST',
      headers: {
        ...(workflow.headers ?? {}),
        ...(item.headers ?? {}),
      },
      body: JSON.stringify(nextBody),
      uniqueKey: `${item.uniqueKey ?? item.url}::cursor=${cursor}`,
      metadata: {
        source: 'discovery',
        paginationMethod: 'json-cursor',
        cursor,
      },
    };
  }

  try {
    const nextUrl = new URL(response.finalUrl ?? item.url);
    const targetParam = ['cursor', 'after', 'nextCursor', 'endCursor'].find((name) => nextUrl.searchParams.has(name)) ?? 'cursor';
    nextUrl.searchParams.set(targetParam, cursor);
    return {
      url: nextUrl.href,
      method: item.method ?? workflow.request?.method ?? 'GET',
      headers: {
        ...(workflow.headers ?? {}),
        ...(item.headers ?? {}),
      },
      uniqueKey: `${item.uniqueKey ?? nextUrl.origin + nextUrl.pathname}::cursor=${cursor}`,
      metadata: {
        source: 'discovery',
        paginationMethod: 'json-cursor',
        cursor,
      },
    };
  } catch {
    return null;
  }
}

function normalizeDiscoveryLaneConfigs(lanes = {}) {
  if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(lanes)
      .map(([laneKey, config]) => {
        const normalizedKey = String(laneKey ?? '').trim().toLowerCase();
        if (!normalizedKey || !config || typeof config !== 'object' || Array.isArray(config)) {
          return null;
        }

        return [normalizedKey, {
          maxInProgress: Number.isFinite(Number(config.maxInProgress)) ? Math.max(0, Number(config.maxInProgress)) : 0,
          budgetWindowMs: Math.max(0, Number(config.budgetWindowMs ?? 0)),
          maxRequestsPerWindow: Math.max(0, Number(config.maxRequestsPerWindow ?? 0)),
        }];
      })
      .filter(Boolean),
  );
}

export class JobRunner {
  constructor({
    workflow,
    projectRoot = process.cwd(),
    jobId,
    jobStore,
    historyStore,
    sessionStore,
    proxyPool,
    source = 'inline',
    metadata = {},
    keepBrowserPoolAlive = false,
    controlPlane = null,
    dataPlane = null,
    alertOutbox = null,
    exportOutbox = null,
    reverseEngine = null,
    runtimePlugins = [],
  }) {
    this.workflow = workflow;
    this.projectRoot = projectRoot;
    this.jobId = jobId ?? createLocalJobId();
    this.jobStore = jobStore;
    this.historyStore = historyStore;
    this.sessionStore = sessionStore ?? new SessionStore({ projectRoot });
    this.proxyPool = proxyPool ?? new ProxyPool({ projectRoot });
    this.source = source;
    this.metadata = metadata;
    this.keepBrowserPoolAlive = keepBrowserPoolAlive;
    this.controlPlane = controlPlane;
    this.dataPlane = dataPlane;
    this.alertOutbox = alertOutbox;
    this.exportOutbox = exportOutbox;
    this.reverseEngine = reverseEngine;
    this.runtimePlugins = Array.isArray(runtimePlugins) ? [...runtimePlugins] : [];
    this.distributedArtifactsEnabled = Boolean(controlPlane?.enabled && dataPlane);
    this.runDir = resolve(projectRoot, workflow.output.dir, this.jobId);
    this.publicRunDir = this.distributedArtifactsEnabled ? `distributed://${this.jobId}` : this.runDir;
    this.logger = createLogger({ component: 'job-runner', jobId: this.jobId });
    if (this.workflow.browser?.autoScroll?.enabled === true) {
      this.runtimePlugins.push(createAutoScrollPlugin(this.workflow.browser.autoScroll));
    }
    this.includePatterns = (this.workflow.discovery.include ?? []).map((entry) => new RegExp(entry));
    this.excludePatterns = (this.workflow.discovery.exclude ?? []).map((entry) => new RegExp(entry));
    this.discoveryFileExtensions = new Set(
      (this.workflow.discovery.skipFileExtensions ?? [])
        .map((entry) => normalizeDiscoveryFileExtension(entry))
        .filter(Boolean),
    );
    this.discoveryRules = (this.workflow.discovery.rules ?? [])
      .map((entry) => {
        try {
          return {
            ...entry,
            matcher: new RegExp(entry.pattern),
          };
        } catch {
          this.logger?.warn?.('discovery rule ignored due to invalid pattern', {
            pattern: entry?.pattern,
          });
          return null;
        }
      })
      .filter(Boolean);
    this.discoveryLaneConfigs = normalizeDiscoveryLaneConfigs(this.workflow.discovery.strategy?.lanes ?? {});
    this.queuePriority = queuePriorityConfig(this.workflow);
    this.frontier = frontierConfig(this.workflow);
    this.groupBackoff = new GroupBackoffController(this.workflow.retry?.groupBackoff ?? {}, {
      groupBy: this.workflow.retry?.groupBackoff?.groupBy ?? this.frontier.groupBy,
    });
    this.requestQueueConfig = {
      ...(this.workflow.requestQueue ?? {}),
      laneConfigs: this.discoveryLaneConfigs,
      seenSet: this.frontier.seenSet.enabled
        ? {
            ...(this.workflow.requestQueue?.seenSet ?? {}),
            enabled: true,
            scope: this.frontier.seenSet.scope,
            id: this.frontier.seenSet.id,
          }
        : {
            ...(this.workflow.requestQueue?.seenSet ?? {}),
          },
    };
    this.crawlPolicy = new CrawlPolicyManager({
      workflow: this.workflow,
      logger: this.logger,
      proxyPool: this.proxyPool,
    });
    this.httpCache = new HttpCacheStore({
      projectRoot: this.projectRoot,
      workflow: this.workflow,
      logger: this.logger,
      dataPlane: this.dataPlane,
    });
    this.rateLimiter = this.workflow.rateLimiter?.enabled === false
      ? null
      : this.workflow.rateLimiter
        ? new DomainRateLimiter(this.workflow.rateLimiter)
        : null;
    this.observability = null;
    this.observabilityConfig = mergeObservabilityConfig(this.workflow, this.jobId);
    if (this.observabilityConfig) {
      this.observability = setupObservability(this.observabilityConfig);
    }
    this.pending = new Set();
    this.activeGroupCounts = new Map();
    this.recentGroupDispatches = new Map();
    this.activeLaneCounts = new Map();
    this.recentLaneDispatches = new Map();
    this.sequence = 0;
    this.scheduledCount = 0;
    this.pagesFetched = 0;
    this.resultCount = 0;
    this.failureCount = 0;
    this.skippedCount = 0;
    this.retryCount = 0;
    this.completed = [];
    this.failedRequests = [];
    this.changeFeed = [];
    this.qualityTracker = new QualityTracker(this.workflow?.quality ?? {});
    this.exportManager = null;
    this.reverseAssetStore = null;
  }

  observabilitySummary() {
    if (!this.observability) {
      return null;
    }

    return {
      config: this.observabilityConfig,
      ...summarizeObservability(this.observability),
    };
  }

  getMetrics() {
    return {
      pagesFetched: this.pagesFetched,
      itemsPushed: this.resultCount,
      resultCount: this.resultCount,
      requestsFailed: this.failureCount,
      failedRequestCount: this.failedRequests.length,
      requestsRetried: this.retryCount,
      skippedCount: this.skippedCount,
      queuedCount: this.scheduledCount,
      queue: this.requestQueue?.summary?.() ?? null,
      autoscale: this.autoscaler?.snapshot?.() ?? null,
    };
  }

  buildFailedRequestRecord({ item, request, response, error, attempt }) {
    const source = request ?? item ?? {};
    return {
      url: source.url ?? item?.url ?? null,
      method: source.method ?? this.workflow.request.method ?? 'GET',
      depth: Number(source.depth ?? item?.depth ?? 0),
      parentUrl: source.parentUrl ?? item?.parentUrl ?? null,
      uniqueKey: source.uniqueKey ?? item?.uniqueKey ?? null,
      label: source.label ?? source.metadata?.label ?? item?.label ?? item?.metadata?.label ?? null,
      userData: source.userData ?? item?.userData ?? {},
      metadata: source.metadata ?? item?.metadata ?? {},
      grpc: source.grpc ?? item?.grpc ?? null,
      proxyServer: request?.proxy?.server ?? response?.proxyServer ?? null,
      sessionId: response?.sessionId ?? null,
      status: response?.status ?? null,
      finalUrl: response?.finalUrl ?? null,
      attempt: Number(attempt ?? 0) || 1,
      error: error?.message ?? String(error),
      failedAt: new Date().toISOString(),
    };
  }

  async persistFailedRequests() {
    await this.keyValueStore?.setRecord?.('FAILED_REQUESTS', this.failedRequests);
  }

  async emitSkippedPage(url, details = {}) {
    this.skippedCount += 1;
    await this.emit('page.skipped', {
      url,
      ...details,
    });
  }

  updateJobStats() {
    this.jobStore?.update(this.jobId, {
      stats: {
        pagesFetched: this.pagesFetched,
        resultCount: this.resultCount,
        failureCount: this.failureCount,
      },
    });
  }

  async emitRetryAttempt(payload = {}) {
    this.retryCount += 1;
    await this.emit('page.retrying', payload);
    if (Number(payload.delayMs) > 0) {
      await sleep(Number(payload.delayMs));
    }
  }

  createAttemptRuntime() {
    const runner = this;
    return {
      config: {
        get workflow() { return runner.workflow; },
      },
      fetch: {
        get sessionStore() { return runner.sessionStore; },
        get reverseEngine() { return runner.reverseEngine; },
      },
      hooks: {
        get plugins() { return runner.plugins; },
        get logger() { return runner.logger; },
      },
      services: {
        get proxyPool() { return runner.proxyPool; },
        get sessionPool() { return runner.sessionPool; },
        get rateLimiter() { return runner.rateLimiter; },
        get groupBackoff() { return runner.groupBackoff; },
        get httpCache() { return runner.httpCache; },
        get sink() { return runner.sink; },
        get requestQueue() { return runner.requestQueue; },
        get autoscaler() { return runner.autoscaler; },
        get observability() { return runner.observability; },
      },
      state: {
        get changeFeed() { return runner.changeFeed; },
        get completed() { return runner.completed; },
        get qualityTracker() { return runner.qualityTracker; },
        get sequence() { return runner.sequence; },
        get pagesFetched() { return runner.pagesFetched; },
        set pagesFetched(value) { runner.pagesFetched = value; },
        get resultCount() { return runner.resultCount; },
        set resultCount(value) { runner.resultCount = value; },
      },
      events: {
        emit: runner.emit.bind(runner),
        emitRetryAttempt: runner.emitRetryAttempt.bind(runner),
      },
      policy: {
        shouldRetryStatus: runner.shouldRetryStatus.bind(runner),
        shouldGroupBackoffStatus: runner.shouldGroupBackoffStatus.bind(runner),
      },
    };
  }

  createFrontierRuntime() {
    const runner = this;
    return {
      state: {
        get activeGroupCounts() { return runner.activeGroupCounts; },
        get recentGroupDispatches() { return runner.recentGroupDispatches; },
        get activeLaneCounts() { return runner.activeLaneCounts; },
        get recentLaneDispatches() { return runner.recentLaneDispatches; },
        get pending() { return runner.pending; },
        get changeFeed() { return runner.changeFeed; },
      },
      config: {
        get frontier() { return runner.frontier; },
        get discoveryLaneConfigs() { return runner.discoveryLaneConfigs; },
        get queuePriority() { return runner.queuePriority; },
        get workflow() { return runner.workflow; },
        get distributedArtifactsEnabled() { return runner.distributedArtifactsEnabled; },
      },
      services: {
        get requestQueue() { return runner.requestQueue; },
        get groupBackoff() { return runner.groupBackoff; },
        get httpCache() { return runner.httpCache; },
        get autoscaler() { return runner.autoscaler; },
        get crawlPolicy() { return runner.crawlPolicy; },
      },
      actions: {
        processItem: runner.processItem.bind(runner),
        handleFailedItem: runner.handleFailedItem.bind(runner),
        enqueue: runner.enqueue.bind(runner),
        nextDispatchDelayMs: runner.nextDispatchDelayMs.bind(runner),
      },
    };
  }

  async handleFailedItem({ item, error }) {
    this.failureCount += 1;
    const failedRequest = error?.request ?? buildFailedRequestInput(item, this.workflow);
    const attempt = Number(error?.attempt ?? 0) || 1;
    const errorMessage = error?.message ?? String(error);

    this.logger.error('page processing failed', {
      url: item.url,
      error: errorMessage,
    });
    await this.plugins.runHook('onFailedRequest', {
      request: failedRequest,
      response: error?.response ?? null,
      item,
      runner: this,
      attempt,
      error,
      page: error?.response?._page ?? null,
    });
    this.failedRequests.push(this.buildFailedRequestRecord({
      item,
      request: failedRequest,
      response: error?.response ?? null,
      error,
      attempt,
    }));
    await this.persistFailedRequests();
    await this.requestQueue.markFailed(item.uniqueKey, {
      error: errorMessage,
    });
    this.autoscaler.report({
      durationMs: 0,
      ok: false,
    });
    this.updateJobStats();
    await this.emit('page.failed', {
      url: item.url,
      depth: item.depth,
      attempt,
      error: errorMessage,
    });
  }

  async completeSkippedRequest({ item, request, requestSpan, startedAtMs, attempt }) {
    const skipReason = request._skipReason ?? 'skipped-by-plugin';
    this.logger.info('Skipping request marked by plugin', { url: request.url, reason: skipReason });
    await this.requestQueue.markHandled(item.uniqueKey, {
      finalUrl: request.url,
      responseStatus: null,
    });
    await this.emitSkippedPage(request.url, {
      depth: item.depth,
      reason: skipReason,
      attempt,
    });
    requestSpan?.addEvent('request.skipped', {
      attempt,
      reason: skipReason,
    });
    requestSpan?.end();
    this.observability?.tracer?.endSpan?.(requestSpan);
    this.autoscaler.report({
      durationMs: Date.now() - startedAtMs,
      ok: true,
    });
    this.updateJobStats();
    return null;
  }

  async finalizeCompletedItem({ result, discoveredCount }) {
    this.updateJobStats();
    await this.emit('page.completed', {
      url: result.url,
      status: result.status,
      depth: result.depth,
      discovered: discoveredCount,
      mode: result.mode,
      proxyServer: result.proxyServer,
      attemptsUsed: result.attemptsUsed,
    });
  }

  async init() {
    await ensureDir(this.runDir);
    const reverseRuntime =
      this.reverseEngine
        ? null
        : await createWorkflowReverseRuntime({
            workflow: this.workflow,
            projectRoot: this.projectRoot,
            jobId: this.jobId,
            dataPlane: this.dataPlane,
            logger: this.logger,
          });
    if (reverseRuntime) {
      this.workflow = reverseRuntime.workflow;
      this.reverseEngine = reverseRuntime.reverseEngine;
      this.reverseAssetStore = reverseRuntime.assetStore;
      this.runtimePlugins.push(...reverseRuntime.runtimePlugins);
    }
    this.workflow.browser = {
      ...(this.workflow.browser ?? {}),
      pool: {
        ...(this.workflow.browser?.pool ?? {}),
        namespace: this.projectRoot,
      },
    };
    await this.sessionStore.init();
    await this.proxyPool.init();
    this.requestQueue = this.distributedArtifactsEnabled
      ? this.controlPlane.backend === 'redis'
        ? new RedisRequestQueue({
            redis: this.controlPlane.redis,
            jobId: this.jobId,
            config: this.requestQueueConfig,
          })
        : new SqliteRequestQueue({
            dbPath: this.controlPlane.dbPath,
            jobId: this.jobId,
            config: this.requestQueueConfig,
          })
      : new RequestQueue({
          runDir: this.runDir,
          config: this.requestQueueConfig,
          logger: this.logger,
        });
    await this.requestQueue.init();
    this.datasetStore = this.distributedArtifactsEnabled
      ? new SqliteDatasetStore({
          dataPlane: this.dataPlane,
          datasetId: this.jobId,
          metadata: {
            jobId: this.jobId,
            workflowName: this.workflow.name,
            runDir: this.publicRunDir,
          },
        })
      : new DatasetStore({
          projectRoot: this.projectRoot,
          datasetId: this.jobId,
          metadata: {
            jobId: this.jobId,
            workflowName: this.workflow.name,
            runDir: this.publicRunDir,
          },
        });
    this.keyValueStore = this.distributedArtifactsEnabled
      ? new SqliteKeyValueStore({
          dataPlane: this.dataPlane,
          storeId: this.jobId,
          metadata: {
            jobId: this.jobId,
            workflowName: this.workflow.name,
            runDir: this.publicRunDir,
          },
        })
      : new KeyValueStore({
          projectRoot: this.projectRoot,
          storeId: this.jobId,
          metadata: {
            jobId: this.jobId,
            workflowName: this.workflow.name,
            runDir: this.publicRunDir,
          },
        });
    await Promise.all([this.datasetStore.init(), this.keyValueStore.init(), this.httpCache.init()]);
    if (this.workflow.session?.pool?.enabled) {
      this.sessionPool = new SessionPool({
        projectRoot: this.projectRoot,
        poolId: this.workflow.session.pool.id ?? `${this.workflow.name}:${this.jobId}`,
        config: this.workflow.session.pool,
      });
      await this.sessionPool.init();
    } else {
      this.sessionPool = null;
    }
    this.autoscaler = new AutoscaleController({
      config: this.workflow.autoscale,
      maxConcurrency: this.workflow.concurrency,
    });
    if (this.distributedArtifactsEnabled) {
      this.dataPlane.writeJsonArtifact(this.jobId, 'workflow.json', {
        source: this.source,
        workflow: this.workflow,
      });
    } else {
      await writeJson(join(this.runDir, 'workflow.json'), {
        source: this.source,
        workflow: this.workflow,
      });
    }
    await this.keyValueStore.setRecord('WORKFLOW', {
      source: this.source,
      workflow: this.workflow,
    });
    this.sink = new SinkManager({
      runDir: this.runDir,
      output: this.workflow.output,
      browserDebug: this.workflow.browser?.debug,
      datasetStore: this.datasetStore,
      keyValueStore: this.keyValueStore,
      dataPlane: this.dataPlane,
      jobId: this.jobId,
      localArtifactsEnabled: true,
    });
    await this.sink.init();
    this.exportManager = new ExportManager({
      projectRoot: this.projectRoot,
      runDir: this.runDir,
      dataPlane: this.dataPlane,
      jobId: this.jobId,
      workflowName: this.workflow.name,
      exportOutbox: this.exportOutbox,
    });
    this.plugins = new MiddlewareManager(this.workflow.plugins, {
      runDir: this.runDir,
      projectRoot: this.projectRoot,
      dataPlane: this.dataPlane,
      jobId: this.jobId,
      workflow: this.workflow,
    });
    await this.plugins.init();
    if (this.runtimePlugins.length > 0) {
      this.plugins.plugins.push(...this.runtimePlugins);
    }
    this.scheduledCount = this.requestQueue.summary().totalCount;
    await this.emit('job.started', {
      workflowName: this.workflow.name,
      queue: this.requestQueue.summary(),
      autoscale: this.autoscaler.snapshot(),
    });
    await this.plugins.runHook('onJobStart', {
      workflow: this.workflow,
      runner: this,
    });
  }

  async emit(type, data = {}) {
    this.sequence += 1;
    const event = {
      sequence: this.sequence,
      type,
      at: new Date().toISOString(),
      ...data,
    };

    if (this.distributedArtifactsEnabled) {
      this.dataPlane.appendEvent(this.jobId, event);
    } else {
      await appendNdjson(join(this.runDir, 'events.ndjson'), event);
    }
    this.jobStore?.pushEvent(this.jobId, event);
    return event;
  }

  async enqueue(item) {
    if (this.workflow.discovery.enabled && this.scheduledCount >= this.workflow.discovery.maxPages) {
      return false;
    }

    const resolvedItem = resolveEnqueueCandidate(item);

    const crawlDecision = await this.crawlPolicy.evaluateUrl(resolvedItem.url);
    if (!crawlDecision.allowed) {
      await this.emitSkippedPage(resolvedItem.url, {
        reason: crawlDecision.source ?? 'robots-txt',
        matchedRule: crawlDecision.matchedRule ?? null,
        userAgent: crawlDecision.userAgent ?? null,
      });
      return false;
    }

    const hookResult = await this.plugins.runHook('beforeEnqueue', {
      item: resolvedItem,
      runner: this,
    });

    if (hookResult.skip) {
      await this.emitSkippedPage(resolvedItem.url, {
        reason: hookResult.reason ?? 'skipped-by-plugin',
      });
      return false;
    }

    const enqueued = await this.requestQueue.enqueue(
      buildQueuedRequestInput(
        resolvedItem,
        this.workflow,
        this.resolveQueuePriority(resolvedItem),
      ),
    );

    this.scheduledCount = this.requestQueue.summary().totalCount;
    if (!enqueued.added && enqueued.reason === 'already-seen') {
      await this.emitSkippedPage(resolvedItem.url, {
        reason: 'already-seen',
      });
    }
    return enqueued.added;
  }

  resolveQueuePriority(item = {}) {
    if (item.priority !== undefined) {
      return normalizeRequestPriority(item.priority, 0);
    }

    const source = item.metadata?.source;
    let basePriority = item.parentUrl ? this.queuePriority.discovery : this.queuePriority.seed;
    if (source === 'sitemap') {
      basePriority = this.queuePriority.sitemap;
    }

    return normalizeRequestPriority(basePriority - ((Number(item.depth ?? 0)) * this.queuePriority.depthPenalty), 0);
  }

  async discoverLinks(item, response) {
    const xmlDiscoverySource = detectXmlDiscoverySource(response);
    const allowDepthBypass = Boolean(xmlDiscoverySource) || isJsonDiscoveryResponse(response);

    if (!this.workflow.discovery.enabled || (!allowDepthBypass && item.depth >= this.workflow.maxDepth)) {
      return [];
    }

    const discoveryStrategy = this.workflow.discovery.strategy ?? {};
    const pagination = discoveryStrategy.enqueuePagination !== false
      ? discoverNextPage(response, {
          urlPattern: true,
          jsonDetect: true,
        })
      : { nextUrl: null, method: null, cursor: null };

    const discoveryRule = {
      ...buildDefaultDiscoveryRule({
        response,
        workflow: this.workflow,
      }),
      ...(this.workflow.discovery.extractor ?? {}),
    };

    const links = await applyRule({
      rule: discoveryRule,
      response,
      workflow: this.workflow,
      logger: this.logger,
    });

    const rawCandidates = Array.isArray(links) ? [...links] : [links];
    if (pagination.nextUrl && !rawCandidates.some((entry) => {
      const value = typeof entry === 'object' && entry !== null ? entry.url : entry;
      return value === pagination.nextUrl;
    })) {
      rawCandidates.unshift({
        url: pagination.nextUrl,
        text: null,
        tagName: 'link',
        rel: 'next',
        nofollow: false,
        hreflang: null,
        mediaType: null,
      });
    }

    if (pagination.cursor) {
      const cursorCandidate = buildCursorPaginationCandidate({
        item,
        workflow: this.workflow,
        response,
        cursor: pagination.cursor,
      });

      if (cursorCandidate && !rawCandidates.some((entry) => {
        const value = typeof entry === 'object' && entry !== null ? entry.uniqueKey ?? entry.url : entry;
        return value === (cursorCandidate.uniqueKey ?? cursorCandidate.url);
      })) {
        rawCandidates.unshift(cursorCandidate);
      }
    }

    const seen = new Set();
    const discovered = [];

    for (const rawCandidate of rawCandidates) {
      const candidate = normalizeDiscoveryCandidate(rawCandidate, item.url);
      if (!candidate) {
        continue;
      }

      if (seen.has(candidate.url)) {
        continue;
      }
      seen.add(candidate.url);

      if (!this.#shouldKeepUrl(candidate.url, item.url)) {
        continue;
      }

      if (this.workflow.discovery.respectNoFollow && candidate.nofollow) {
        if (this.workflow.name === 'discovery-rules' || this.workflow.name === 'repro-discovery-rules') {
          console.log(`[DEBUG] Skipping nofollow link: ${candidate.url}`);
        }
        continue;
      }

      const extension = getUrlPathExtension(candidate.url);
      if (!xmlDiscoverySource && extension && this.discoveryFileExtensions.has(extension)) {
        continue;
      }

      const kind = xmlDiscoverySource === 'sitemap' && (extension === '.xml' || candidate.url.toLowerCase().includes('sitemap'))
        ? 'sitemap'
        : discoveryStrategy.classify === false
          ? 'generic'
          : classifyDiscoveryCandidate(candidate, {
              paginationUrl: pagination.nextUrl,
            });

      if (kind === 'canonical' && discoveryStrategy.enqueueCanonical !== true) {
        continue;
      }

      if (kind === 'alternate-language' && discoveryStrategy.enqueueAlternateLanguages !== true) {
        continue;
      }

      if (kind === 'logout' && discoveryStrategy.skipLogout !== false) {
        continue;
      }

      if (kind === 'asset' && discoveryStrategy.skipAssetLinks !== false) {
        continue;
      }

      const matchedRule = this.#matchDiscoveryRule(candidate);
      if (matchedRule?.action === 'skip') {
        continue;
      }

      discovered.push({
        url: candidate.url,
        method: candidate.method,
        headers: candidate.headers,
        body: candidate.body,
        uniqueKey: candidate.uniqueKey,
        priority: matchedRule?.priority ?? defaultDiscoveryPriority(kind),
        label: candidate.label ?? matchedRule?.label ?? defaultDiscoveryLabel(kind),
        userData: {
          ...(candidate.userData ?? {}),
          ...(kind !== 'generic' ? { discoveryKind: kind } : {}),
          ...(matchedRule?.userData ?? {}),
        },
        metadata: {
          ...(candidate.metadata ?? {}),
          source: candidate.metadata?.source ?? xmlDiscoverySource ?? 'discovery',
          kind,
          anchorText: candidate.text,
          tagName: candidate.tagName,
          rel: candidate.rel,
          nofollow: candidate.nofollow,
          hreflang: candidate.hreflang,
          mediaType: candidate.mediaType,
          paginationMethod: candidate.metadata?.paginationMethod ?? (candidate.url === pagination.nextUrl ? pagination.method : null),
          matchedRule: matchedRule?.pattern ?? null,
          ...(matchedRule?.metadata ?? {}),
        },
        replayState: candidate.replayState ?? response.replayState ?? item.replayState ?? null,
      });

      if (discovered.length >= this.workflow.discovery.maxLinksPerPage) {
        break;
      }
    }

    return discovered;
  }

  #matchDiscoveryRule(candidate) {
    for (const rule of this.discoveryRules) {
      if (rule?.matcher?.test(candidate.url)) {
        return rule;
      }
    }

    return null;
  }

  #shouldKeepUrl(targetUrl, parentUrl) {
    const discovery = this.workflow.discovery;

    if (discovery.sameOriginOnly) {
      try {
        if (new URL(targetUrl).origin !== new URL(parentUrl).origin) {
          return false;
        }
      } catch {
        return false;
      }
    }

    if (this.includePatterns.length > 0 && !this.includePatterns.some((pattern) => pattern.test(targetUrl))) {
      return false;
    }

    if (this.excludePatterns.some((pattern) => pattern.test(targetUrl))) {
      return false;
    }

    return true;
  }

  async resolveSessionConfig() {
    if (!this.workflow.session?.enabled && !this.workflow.session?.pool?.enabled) {
      return null;
    }

    if (this.workflow.session?.pool?.enabled && this.sessionPool) {
      const pooled = await this.sessionPool.acquire();
      const boundIdentityProfile = await this.sessionPool.resolveBoundIdentityProfile(pooled.id);
      return {
        ...this.workflow.session,
        enabled: true,
        id: pooled.id,
        _pooled: true,
        _boundIdentityProfile: boundIdentityProfile,
      };
    }

    const scope = this.workflow.session.scope ?? 'job';
    const sessionId =
      scope === 'custom'
        ? this.workflow.session.id
        : this.workflow.session.id ?? `${this.workflow.name}:${this.jobId}`;

    if (!sessionId) {
      throw new Error('session.id is required when session.scope is custom');
    }

    return {
      ...this.workflow.session,
      id: sessionId,
    };
  }

  shouldRetryStatus(status) {
    const statuses = new Set([
      ...(this.workflow.retry?.retryOnStatuses ?? []),
      ...(this.workflow.proxyPool?.retryOnStatuses ?? []),
    ]);
    return statuses.has(status);
  }

  shouldGroupBackoffStatus(status) {
    return this.groupBackoff.shouldBackoffStatus(status);
  }

  nextFrontierBudgetDelayMs(nowMs = Date.now()) {
    if (this.frontier.maxRequestsPerWindow <= 0 || this.frontier.budgetWindowMs <= 0) {
      return 0;
    }

    let nextReadyAt = Infinity;
    for (const timestamps of this.recentGroupDispatches.values()) {
      const retained = timestamps
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= nowMs - this.frontier.budgetWindowMs)
        .sort((left, right) => left - right);

      if (retained.length < this.frontier.maxRequestsPerWindow) {
        continue;
      }

      const releaseAt = retained[retained.length - this.frontier.maxRequestsPerWindow] + this.frontier.budgetWindowMs;
      if (releaseAt > nowMs && releaseAt < nextReadyAt) {
        nextReadyAt = releaseAt;
      }
    }

    return Number.isFinite(nextReadyAt) ? Math.max(0, nextReadyAt - nowMs) : 0;
  }

  nextLaneBudgetDelayMs(nowMs = Date.now()) {
    let nextReadyAt = Infinity;

    for (const [laneKey, laneConfig] of Object.entries(this.discoveryLaneConfigs)) {
      const budgetWindowMs = Math.max(0, Number(laneConfig?.budgetWindowMs ?? 0));
      const maxRequestsPerWindow = Math.max(0, Number(laneConfig?.maxRequestsPerWindow ?? 0));
      if (budgetWindowMs <= 0 || maxRequestsPerWindow <= 0) {
        continue;
      }

      const timestamps = this.recentLaneDispatches.get(laneKey) ?? [];
      const retained = timestamps
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= nowMs - budgetWindowMs)
        .sort((left, right) => left - right);

      if (retained.length < maxRequestsPerWindow) {
        continue;
      }

      const releaseAt = retained[retained.length - maxRequestsPerWindow] + budgetWindowMs;
      if (releaseAt > nowMs && releaseAt < nextReadyAt) {
        nextReadyAt = releaseAt;
      }
    }

    return Number.isFinite(nextReadyAt) ? Math.max(0, nextReadyAt - nowMs) : 0;
  }

  nextDispatchDelayMs(nowMs = Date.now()) {
    const backoffDelayMs = this.groupBackoff.nextReleaseDelayMs(nowMs);
    const frontierDelayMs = this.nextFrontierBudgetDelayMs(nowMs);
    const laneDelayMs = this.nextLaneBudgetDelayMs(nowMs);
    const candidates = [backoffDelayMs, frontierDelayMs, laneDelayMs].filter((value) => Number(value) > 0);

    if (candidates.length === 0) {
      return 0;
    }

    return Math.max(10, Math.min(...candidates));
  }

  async resolveProxyConfig({ session, item }) {
    const identity = this.workflow.identity ?? {};
    const consistency = getIdentityConsistencyConfig(identity);
    const identityBinding = consistency.bindProxyRegion ? buildIdentityProxyBinding(identity) : null;

    if (session?.id && session?._pooled && this.sessionPool) {
      const boundProxy = await this.sessionPool.resolveBoundProxy(session.id);
      if (boundProxy?.server) {
        if (!identityBinding) {
          return boundProxy;
        }
        const proxyRegion = normalizeProxyLocationValue(boundProxy.region);
        const proxyCountry = normalizeProxyLocationValue(boundProxy.country);
        const proxyCity = normalizeProxyLocationValue(boundProxy.city);
        const matches =
          (!identityBinding.region || proxyRegion === identityBinding.region)
          && (!identityBinding.country || proxyCountry === identityBinding.country)
          && (!identityBinding.city || proxyCity === identityBinding.city);
        if (matches) {
          return boundProxy;
        }
      }
      if (boundProxy?.server && !identityBinding) {
        return boundProxy;
      }
    }

    const affinityKey = session?.id ?? `${this.jobId}:${item.url}`;
    const selectedProxy = await this.proxyPool.selectProxy({
      proxyPool: this.workflow.proxyPool,
      fallbackProxy: this.workflow.proxy ?? null,
      affinityKey,
      targetUrl: item.url,
      identityBinding,
    });

    if (consistency.bindProxyRegion && identityBinding && !selectedProxy?.server) {
      throw new Error('no proxy matched the configured identity region binding');
    }

    if (selectedProxy?.server && session?.id && session?._pooled && this.sessionPool) {
      await this.sessionPool.bindProxy(session.id, selectedProxy);
    }

    return selectedProxy;
  }

  async bindSessionIdentityProfile(session, request) {
    if (!session?.id || !session?._pooled || !this.sessionPool || request.identity?.enabled === false) {
      return;
    }

    await this.sessionPool.bindIdentityProfile(session.id, {
      userAgent: request.identity?.userAgent ?? null,
      acceptLanguage: getHeaderValue(request.headers, 'accept-language') ?? null,
      locale: request.identity?.locale ?? null,
      languages: Array.isArray(request.identity?.languages) ? [...request.identity.languages] : [],
      tlsProfile: profileName(request.tlsProfile),
      h2Profile: profileName(request.h2Profile),
      clientHints:
        request.identity?.clientHints && typeof request.identity.clientHints === 'object' && !Array.isArray(request.identity.clientHints)
          ? { ...request.identity.clientHints }
          : {},
      fingerprintKey: session.id,
    });
  }

  async prepareRequestAttempt(item) {
    const session = await this.resolveSessionConfig();
    const proxy = await this.resolveProxyConfig({ session, item });
    const request = buildResolvedRequestInput(item, this.workflow, {
      proxy,
      session,
    });

    await this.bindSessionIdentityProfile(session, request);
    await this.httpCache.prepareRequest(request);

    const crawlDelay = await this.crawlPolicy.waitForTurn(item.url);
    if (crawlDelay.waitMs > 0) {
      await this.emit('page.delayed', {
        url: item.url,
        delayMs: crawlDelay.waitMs,
        crawlDelayMs: crawlDelay.crawlDelayMs,
        reason: 'robots-crawl-delay',
      });
    }

    return {
      session,
      request,
    };
  }

  async processItem(item) {
    const attemptRuntime = this.createAttemptRuntime();
    const startedAtMs = Date.now();
    const mode = selectMode(this.workflow);
    const maxAttempts = this.workflow.retry?.attempts ?? 1;
    const requestSpan = this.observability?.tracer?.startSpan?.('crawl.request', {
      attributes: {
        'crawl.url': item.url,
        'crawl.mode': mode,
        'crawl.depth': Number(item.depth ?? 0),
      },
    }) ?? null;
    let response = null;
    let request = null;
    let session = null;
    let attemptsUsed = 0;
    let lastError = null;

    while (attemptsUsed < maxAttempts) {
      attemptsUsed += 1;
      const attemptStartedAtMs = Date.now();
      let rateLimiterAcquired = false;
      await waitForGroupBackoff(attemptRuntime, item);
      ({ session, request } = await this.prepareRequestAttempt(item));

      try {
        if (this.rateLimiter) {
          const rateLimit = await this.rateLimiter.acquire(item.url);
          rateLimiterAcquired = true;
          if (rateLimit.waitMs > 0) {
            await this.emit('page.delayed', {
              url: item.url,
              delayMs: rateLimit.waitMs,
              domain: rateLimit.domain,
              reason: 'rate-limiter',
            });
          }
        }

        await this.plugins.runHook('beforeRequest', {
          request,
          item,
          runner: this,
          attempt: attemptsUsed,
        });
        request = enforceIdentityConsistency(request, this.workflow);

        // Allow beforeRequest hooks to skip this request (e.g., dedup)
        if (request._skip) {
          return this.completeSkippedRequest({
            item,
            request,
            requestSpan,
            startedAtMs,
            attempt: attemptsUsed,
          });
        }

        response = await executeFetchAttempt(attemptRuntime, {
          mode,
          request,
          item,
        });
        response = await this.httpCache.resolveResponse(request, response);
        response = await applyAfterResponseHooks(attemptRuntime, {
          request,
          response,
          item,
          attempt: attemptsUsed,
        });

        if (await handleDetectedChallenge(attemptRuntime, {
          request,
          response,
          session,
          item,
          attemptsUsed,
          maxAttempts,
        })) {
          continue;
        }

        await reportSuccessfulFetchAttempt(attemptRuntime, {
          mode: response.mode ?? mode,
          item,
          request,
          response,
          session,
          attemptStartedAtMs,
          requestSpan,
          attemptsUsed,
        });

        if (await handleRetryableResponse(attemptRuntime, {
          item,
          request,
          response,
          attemptsUsed,
          maxAttempts,
        })) {
          continue;
        }

        break;
      } catch (error) {
        lastError = error;
        const errorGroupBackoff = await reportFailedFetchAttempt(attemptRuntime, {
          mode,
          item,
          request,
          response,
          session,
          error,
          attemptStartedAtMs,
          requestSpan,
          attemptsUsed,
        });

        if (await handleRetryableError(attemptRuntime, {
          item,
          request,
          error,
          errorGroupBackoff,
          attemptsUsed,
          maxAttempts,
        })) {
          continue;
        }

        throw annotateRequestError(error, {
          attempt: attemptsUsed,
          item,
          request,
          response,
          session,
        });
      } finally {
        if (rateLimiterAcquired) {
          this.rateLimiter.release(item.url);
        }
      }
    }

    if (!response) {
      requestSpan?.setStatus('error');
      requestSpan?.end();
      this.observability?.tracer?.endSpan?.(requestSpan);
      throw annotateRequestError(lastError ?? new Error('request failed without response'), {
        attempt: attemptsUsed,
        item,
        request,
        response,
        session,
      });
    }

    response.replayState = mergeReplayState(item.replayState, response.replayState);

    const extracted = await runExtractors({
      workflow: this.workflow,
      response,
      logger: this.logger,
    });

    const discovered = await this.discoverLinks(item, response);
    const result = buildResultRecord(attemptRuntime, {
      item,
      request,
      response,
      mode: response.mode ?? mode,
      session,
      attemptsUsed,
      discovered,
      extracted,
    });
    await enrichResultRecord(attemptRuntime, {
      request,
      response,
      result,
    });
    await finalizeProcessedResult(attemptRuntime, {
      item,
      request,
      response,
      result,
      requestSpan,
      startedAtMs,
    });

    await this.finalizeCompletedItem({
      result,
      discoveredCount: discovered.length,
    });

    for (const link of discovered) {
      const request = typeof link === 'string'
        ? { url: link }
        : link;

      await this.enqueue({
        ...request,
        url: request.url,
        depth: item.depth + 1,
        parentUrl: item.url,
        replayState: response.replayState,
      });
    }

    return result;
  }

  async run() {
    await this.init();
    const frontierRuntime = this.createFrontierRuntime();
    const startedAt = new Date().toISOString();

    this.jobStore?.update(this.jobId, {
      status: 'running',
      startedAt,
      runDir: this.publicRunDir,
    });

    const seedRequests = getSeedRequests(this.workflow);
    await enqueueInitialRequests(frontierRuntime, seedRequests);

    try {
      while (this.requestQueue.hasPending() || this.pending.size > 0) {
        await dispatchAvailableItems(frontierRuntime);
        await waitForDispatchProgress(frontierRuntime);
      }

      const summary = createTerminalSummary({
        jobId: this.jobId,
        workflowName: this.workflow.name,
        status: 'completed',
        source: this.source,
        runDir: this.publicRunDir,
        metadata: this.metadata,
        pagesFetched: this.pagesFetched,
        resultCount: this.resultCount,
        failureCount: this.failureCount,
        failedRequestCount: this.failedRequests.length,
        skippedCount: this.skippedCount,
        queuedCount: this.scheduledCount,
        queue: this.requestQueue.summary(),
        sessions: this.sessionPool ? this.sessionPool.snapshot() : null,
        autoscale: this.autoscaler.snapshot(),
        frontier: frontierSnapshot(frontierRuntime),
        changeTracking: changeTrackingSnapshot(frontierRuntime),
        crawlPolicy: this.crawlPolicy.snapshot(),
        rateLimiter: this.rateLimiter?.snapshot() ?? null,
        observability: this.observabilitySummary(),
        httpCache: this.httpCache.snapshot(),
        quality: this.qualityTracker.snapshot({
          failureCount: this.failureCount,
        }),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      await enrichTerminalSummary({
        summary,
        workflow: this.workflow,
        results: this.completed,
        logger: this.logger,
        buildBaseline: (currentSummary) => this.buildBaseline(currentSummary),
        buildTrend: (currentSummary) => this.buildTrend(currentSummary),
        reverseAssetStore: this.reverseAssetStore,
        signerAssetId: this.workflow.signer?.assetId ?? this.workflow.name,
        alertOutbox: this.alertOutbox,
        includeReverseRuntime: true,
      });

      await this.plugins.runHook('onJobComplete', {
        workflow: this.workflow,
        runner: this,
        summary,
      });
      await persistTerminalSummaryState({
        sink: this.sink,
        keyValueStore: this.keyValueStore,
        requestQueueSummary: this.requestQueue.summary(),
        autoscaleSnapshot: this.autoscaler.snapshot(),
        summary,
        persistFailedRequests: () => this.persistFailedRequests(),
        changeFeed: this.changeFeed,
        includeReverseRuntime: true,
      });
      await this.emit('job.completed', summary);
      await finalizeTerminalSummary({
        exportManager: this.exportManager,
        workflow: this.workflow,
        summary,
        sink: this.sink,
        keyValueStore: this.keyValueStore,
        historyStore: this.historyStore,
      });
      this.jobStore?.update(this.jobId, {
        status: 'completed',
        runDir: this.publicRunDir,
        finishedAt: summary.finishedAt,
        stats: {
          pagesFetched: this.pagesFetched,
          resultCount: this.resultCount,
          failureCount: this.failureCount,
        },
      });
      return summary;
    } catch (error) {
      const failureAt = new Date().toISOString();
      const message = error?.message ?? String(error);
      const summary = createTerminalSummary({
        jobId: this.jobId,
        workflowName: this.workflow.name,
        status: 'failed',
        source: this.source,
        runDir: this.publicRunDir,
        metadata: this.metadata,
        pagesFetched: this.pagesFetched,
        resultCount: this.resultCount,
        failureCount: this.failureCount + 1,
        failedRequestCount: this.failedRequests.length,
        skippedCount: this.skippedCount,
        queuedCount: this.scheduledCount,
        queue: this.requestQueue?.summary?.() ?? null,
        sessions: this.sessionPool?.snapshot?.() ?? null,
        autoscale: this.autoscaler?.snapshot?.() ?? null,
        frontier: frontierSnapshot(frontierRuntime),
        changeTracking: changeTrackingSnapshot(frontierRuntime),
        crawlPolicy: this.crawlPolicy.snapshot(),
        rateLimiter: this.rateLimiter?.snapshot() ?? null,
        observability: this.observabilitySummary(),
        httpCache: this.httpCache.snapshot(),
        quality: this.qualityTracker.snapshot({
          failureCount: this.failureCount + 1,
        }),
        startedAt,
        finishedAt: failureAt,
        error: message,
      });
      await enrichTerminalSummary({
        summary,
        workflow: this.workflow,
        results: this.completed,
        logger: this.logger,
        buildBaseline: (currentSummary) => this.buildBaseline(currentSummary),
        buildTrend: (currentSummary) => this.buildTrend(currentSummary),
        alertOutbox: this.alertOutbox,
      });
      await this.emit('job.failed', {
        error: message,
      });
      this.jobStore?.update(this.jobId, {
        status: 'failed',
        finishedAt: failureAt,
        stats: {
          pagesFetched: this.pagesFetched,
          resultCount: this.resultCount,
          failureCount: this.failureCount + 1,
        },
      });
      await persistTerminalSummaryState({
        sink: this.sink,
        keyValueStore: this.keyValueStore,
        requestQueueSummary: this.requestQueue?.summary?.() ?? {},
        autoscaleSnapshot: this.autoscaler?.snapshot?.() ?? {},
        summary,
        persistFailedRequests: () => this.persistFailedRequests(),
        changeFeed: this.changeFeed,
      });
      await finalizeTerminalSummary({
        exportManager: this.exportManager,
        workflow: this.workflow,
        summary,
        sink: this.sink,
        keyValueStore: this.keyValueStore,
        historyStore: this.historyStore,
      });
      throw error;
    } finally {
      await this.requestQueue?.close?.();
      if (!this.keepBrowserPoolAlive) {
        await closeBrowser({ namespace: this.projectRoot }).catch(() => {});
      }
    }
  }

  async buildBaseline(summary) {
    if (!this.historyStore?.findPreviousCompleted) {
      return {
        available: false,
        previousJobId: null,
        previousFinishedAt: null,
        deltas: {},
        alerts: [],
      };
    }

    const previousSummary = await this.historyStore.findPreviousCompleted(this.workflow.name, {
      excludeJobId: this.jobId,
    });
    return analyzeBaseline({
      currentSummary: summary,
      previousSummary,
    });
  }

  async buildTrend(summary) {
    if (!this.historyStore?.listPreviousCompleted) {
      return {
        available: false,
        sampleCount: 0,
        windowJobIds: [],
        averages: {},
        deltas: {},
        alerts: [],
      };
    }

    const previousSummaries = await this.historyStore.listPreviousCompleted(this.workflow.name, {
      excludeJobId: this.jobId,
      limit: this.workflow.quality?.trend?.windowSize ?? 5,
    });
    return analyzeTrends({
      currentSummary: summary,
      previousSummaries,
    });
  }
}

export async function runWorkflow(workflowInput, options = {}) {
  const { workflow, source } =
    typeof workflowInput === 'string' || !workflowInput.seedUrls
      ? await loadWorkflow(workflowInput, { cwd: options.projectRoot ?? process.cwd() })
      : { workflow: validateWorkflow(applyGlobalWorkflowDefaults(workflowInput)), source: options.source ?? 'inline' };

  const keepBrowserPoolAlive = options.keepBrowserPoolAlive ?? Boolean(options.jobStore);

  const runner = new JobRunner({
    workflow,
    projectRoot: options.projectRoot ?? process.cwd(),
    jobId: options.jobId,
    jobStore: options.jobStore,
    historyStore: options.historyStore,
    sessionStore: options.sessionStore,
    proxyPool: options.proxyPool,
    source,
    metadata: options.metadata ?? {},
    keepBrowserPoolAlive,
    controlPlane: options.controlPlane ?? null,
    dataPlane: options.dataPlane ?? null,
    alertOutbox: options.alertOutbox ?? null,
    exportOutbox: options.exportOutbox ?? null,
  });

  return runner.run();
}
