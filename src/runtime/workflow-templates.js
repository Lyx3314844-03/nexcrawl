import { buildUniversalCrawlPlan } from './universal-crawl-planner.js';

function toPositiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function slugifyValue(value, fallback = 'quick-start') {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function deriveTaskName(input = {}) {
  const explicit = firstNonEmptyString(input.taskName, input.name, input.workflowId);
  if (explicit) {
    return explicit;
  }

  const appId = firstNonEmptyString(input.app?.packageName, input.app?.bundleId, input.app?.appId);
  if (appId) {
    return appId;
  }

  const targetUrl = firstNonEmptyString(input.url, input.target, input.source);
  if (!targetUrl) {
    return 'universal-scaffold';
  }

  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.replace(/^www\./, '') || 'target';
    const path = parsed.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 2)
      .join('-');
    return [host, path].filter(Boolean).join(' ') || host;
  } catch {
    return targetUrl;
  }
}

function normalizeInputHeaders(headers) {
  return isPlainObject(headers)
    ? Object.fromEntries(
        Object.entries(headers)
          .filter(([key, value]) => typeof key === 'string' && value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)]),
      )
    : {};
}

function parseMessageCandidate(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function pickPrimaryLane(plan = {}) {
  const laneTypes = Array.isArray(plan.lanes) ? plan.lanes.map((entry) => entry?.type).filter(Boolean) : [];
  const ordered = [
    'graphql-semantics',
    'websocket-semantics',
    'api-json',
    'browser-crawl',
    'http-crawl',
    'manual-discovery',
  ];

  for (const type of ordered) {
    if (laneTypes.includes(type)) {
      return type;
    }
  }

  return laneTypes[0] ?? null;
}

function buildSeedRequest(url, input = {}, defaults = {}) {
  const method = String(input.method ?? defaults.method ?? 'GET').toUpperCase();
  const mergedHeaders = {
    ...(defaults.headers ?? {}),
    ...normalizeInputHeaders(input.headers),
  };
  const body = defaults.body !== undefined ? defaults.body : input.body;
  const metadata = {
    ...(isPlainObject(defaults.metadata) ? defaults.metadata : {}),
    ...(isPlainObject(input.metadata) ? input.metadata : {}),
  };

  return {
    url,
    method,
    headers: mergedHeaders,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...(defaults.label ? { label: defaults.label } : {}),
    ...((defaults.grpc ?? input.grpc) ? { grpc: defaults.grpc ?? input.grpc } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function applyUniversalWorkflowHints(workflow, plan, primaryLane) {
  const laneTypes = new Set((plan.lanes ?? []).map((entry) => entry?.type).filter(Boolean));
  const warnings = Array.isArray(plan.warnings) ? [...plan.warnings] : [];

  if (laneTypes.has('anti-bot-lab')) {
    workflow.mode = 'browser';
    workflow.browser = {
      headless: true,
      waitUntil: 'networkidle2',
      sleepMs: 1200,
      ...(workflow.browser ?? {}),
      debug: {
        enabled: true,
        persistArtifacts: true,
        captureNetwork: true,
        ...((workflow.browser ?? {}).debug ?? {}),
      },
    };
    workflow.reverse = {
      enabled: true,
      ...((workflow.reverse && typeof workflow.reverse === 'object') ? workflow.reverse : {}),
      cloudflare: {
        enabled: true,
        ...((workflow.reverse?.cloudflare && typeof workflow.reverse.cloudflare === 'object') ? workflow.reverse.cloudflare : {}),
      },
      behaviorSimulation: {
        enabled: true,
        ...((workflow.reverse?.behaviorSimulation && typeof workflow.reverse.behaviorSimulation === 'object') ? workflow.reverse.behaviorSimulation : {}),
      },
      challenge: {
        enabled: true,
        retryOnSolved: true,
        maxSolveAttempts: 1,
        ...((workflow.reverse?.challenge && typeof workflow.reverse.challenge === 'object') ? workflow.reverse.challenge : {}),
      },
    };
  }

  if (laneTypes.has('login-state-machine') || laneTypes.has('interactive-auth')) {
    workflow.session = {
      enabled: true,
      scope: 'job',
      ...(workflow.session ?? {}),
    };
  }

  return {
    workflow,
    warnings,
    primaryLane,
  };
}

function buildGrpcWorkflowScaffold(input = {}, { taskName, url }) {
  const grpcPath = firstNonEmptyString(input.path, input.grpcPath);
  const pathParts = grpcPath ? grpcPath.split('/').filter(Boolean) : [];
  const service = firstNonEmptyString(input.service, input.grpcService, input.serviceName, pathParts[0]) ?? 'package.Service';
  const rpcMethod = firstNonEmptyString(input.rpcMethod, input.grpcMethod, input.methodName, pathParts[1]) ?? 'Method';
  const metadata = normalizeInputHeaders(input.headers);
  const requestMessage = isPlainObject(input.request)
    ? input.request
    : isPlainObject(input.payload)
      ? input.payload
      : {};
  const descriptorPaths = Array.isArray(input.descriptorPaths) ? input.descriptorPaths.map((entry) => String(entry)) : [];
  const requestType = firstNonEmptyString(input.requestType, input.grpcRequestType);
  const responseType = firstNonEmptyString(input.responseType, input.grpcResponseType);
  const requestSchema = isPlainObject(input.requestSchema) ? input.requestSchema : { fields: [] };
  const responseSchema = isPlainObject(input.responseSchema) ? input.responseSchema : { fields: [] };
  const isServerStream = input.stream === true || input.serverStream === true;

  const item = buildWorkflowFromTemplate({
    taskName,
    seedUrl: url,
    sourceType: 'api-json',
    extractPreset: 'json-payload',
    maxDepth: 0,
    maxPages: 1,
    useSession: true,
    persistBodies: true,
  });

  item.workflow.mode = 'http';
  item.workflow.headers = {
    ...item.workflow.headers,
    'content-type': 'application/grpc',
    te: 'trailers',
    ...metadata,
  };
  item.workflow.request = {
    method: 'POST',
  };
  item.workflow.grpc = {
    enabled: true,
    service,
    method: rpcMethod,
    ...(grpcPath ? { path: grpcPath } : {}),
    metadata,
    descriptorPaths,
    ...(requestType ? { requestType } : {}),
    ...(responseType ? { responseType } : {}),
    ...(isPlainObject(input.requestSchema) ? { requestSchema } : {}),
    ...(isPlainObject(input.responseSchema) ? { responseSchema } : {}),
    stream: isServerStream,
  };
  item.workflow.seedRequests = [
    buildSeedRequest(url, input, {
      method: 'POST',
      headers: {
        'content-type': 'application/grpc',
        te: 'trailers',
        ...metadata,
      },
      body: JSON.stringify(requestMessage),
      label: 'grpc-call',
      grpc: {
        service,
        method: rpcMethod,
        ...(grpcPath ? { path: grpcPath } : {}),
        descriptorPaths,
        ...(requestType ? { requestType } : {}),
        ...(responseType ? { responseType } : {}),
        ...(isPlainObject(input.requestSchema) ? { requestSchema } : {}),
        ...(isPlainObject(input.responseSchema) ? { responseSchema } : {}),
        stream: isServerStream,
        metadata,
      },
      metadata: {
        lane: 'grpc-semantics',
      },
    }),
  ];
  item.workflow.extract = [
    { name: 'payload', type: 'script', code: 'return json;' },
    { name: 'data', type: 'json', path: 'data' },
    { name: 'items', type: 'json', path: 'items' },
    { name: 'grpcStatus', type: 'json', path: 'grpcStatus' },
  ];
  item.workflow.discovery = {
    enabled: false,
  };
  item.template = {
    sourceType: 'grpc',
    extractPreset: isServerStream ? 'grpc-stream' : 'grpc-unary',
  };
  return item;
}

export const workflowTemplateCatalog = [
  {
    id: 'static',
    title: 'Static Page',
    description: 'Static HTML pages such as articles, list pages, and company sites.',
    defaults: {
      sourceType: 'static-page',
      extractPreset: 'title-links',
      maxDepth: 1,
      maxPages: 20,
      renderWaitMs: 0,
    },
  },
  {
    id: 'browser',
    title: 'Browser Rendered',
    description: 'JavaScript-rendered pages that need a browser runtime.',
    defaults: {
      sourceType: 'browser-rendered',
      extractPreset: 'article',
      maxDepth: 0,
      maxPages: 10,
      renderWaitMs: 1200,
    },
  },
  {
    id: 'api',
    title: 'JSON API',
    description: 'JSON endpoints that return structured API payloads.',
    defaults: {
      sourceType: 'api-json',
      extractPreset: 'json-payload',
      maxDepth: 0,
      maxPages: 5,
      renderWaitMs: 0,
    },
  },
  {
    id: 'sitemap',
    title: 'Sitemap / Feed',
    description: 'Sitemap, RSS, and Atom feeds for URL discovery.',
    defaults: {
      sourceType: 'sitemap',
      extractPreset: 'title-links',
      maxDepth: 0,
      maxPages: 50,
      renderWaitMs: 0,
    },
  },
];

export function getWorkflowTemplateCatalog() {
  return workflowTemplateCatalog.map((entry) => ({ ...entry }));
}

export function buildExtractRules({ sourceType = 'static-page', extractPreset = 'title-links' } = {}) {
  if (sourceType === 'api-json') {
    return [
      { name: 'payload', type: 'script', code: 'return json;' },
    ];
  }

  if (sourceType === 'sitemap') {
    return [
      { name: 'urls', type: 'xpath', xpath: '//url/loc/text()', all: true, xml: true, maxItems: 500 },
      { name: 'sitemaps', type: 'xpath', xpath: '//sitemap/loc/text()', all: true, xml: true, maxItems: 500 },
    ];
  }

  if (sourceType === 'feed') {
    return [
      {
        name: 'titles',
        type: 'xpath',
        xpath: '//*[local-name()="item"]/*[local-name()="title"]/text() | //*[local-name()="entry"]/*[local-name()="title"]/text()',
        all: true,
        xml: true,
        maxItems: 100,
      },
      {
        name: 'links',
        type: 'xpath',
        xpath: '//*[local-name()="item"]/*[local-name()="link"]/text() | //*[local-name()="entry"]/*[local-name()="link"]/@href',
        all: true,
        xml: true,
        maxItems: 100,
      },
    ];
  }

  if (extractPreset === 'article') {
    return [
      { name: 'title', type: 'selector', selector: 'title' },
      { name: 'headline', type: 'selector', selector: 'h1' },
      { name: 'summary', type: 'selector', selector: 'meta[name="description"]', attribute: 'content' },
      { name: 'surface', type: 'surface' },
    ];
  }

  if (extractPreset === 'surface') {
    return [
      { name: 'title', type: 'selector', selector: 'title' },
      { name: 'surface', type: 'surface' },
    ];
  }

  return [
    { name: 'title', type: 'selector', selector: 'title' },
    { name: 'links', type: 'links', selector: 'a[href]', all: true, maxItems: 50 },
    { name: 'surface', type: 'surface' },
  ];
}

export function buildWorkflowFromTemplate(input = {}) {
  const sourceType = String(input.sourceType ?? 'static-page');
  const extractPreset = String(input.extractPreset ?? 'title-links');
  const taskName = String(input.taskName ?? 'quick-start').trim() || 'quick-start';
  const seedUrl = String(input.seedUrl ?? '').trim();
  if (!seedUrl) {
    throw new Error('seedUrl is required');
  }

  const maxDepth = toPositiveInt(input.maxDepth, 0, 0, 3);
  const maxPages = toPositiveInt(input.maxPages, 20, 1, 200);
  const renderWaitMs = toPositiveInt(input.renderWaitMs, 800, 0, 10000);
  const useSession = input.useSession !== false;
  const useBrowserDebug = input.useBrowserDebug !== false;
  const persistBodies = input.persistBodies === true;

  const workflow = {
    name: taskName,
    seedUrls: [seedUrl],
    mode: sourceType === 'browser-rendered' ? 'browser' : (sourceType === 'static-page' ? 'cheerio' : 'http'),
    concurrency: 1,
    maxDepth: sourceType === 'api-json' || sourceType === 'sitemap' || sourceType === 'feed' ? 0 : maxDepth,
    headers: {},
    extract: buildExtractRules({ sourceType, extractPreset }),
    plugins: [{ name: 'dedupe' }, { name: 'audit' }],
    output: {
      dir: 'runs',
      persistBodies,
      console: false,
    },
  };

  if (useSession) {
    workflow.session = {
      enabled: true,
      scope: 'job',
    };
  }

  if (sourceType === 'browser-rendered') {
    workflow.browser = {
      headless: true,
      waitUntil: 'networkidle2',
      sleepMs: renderWaitMs,
      debug: useBrowserDebug
        ? {
            enabled: true,
            persistArtifacts: true,
          }
        : {
            enabled: false,
          },
    };
  }

  if (sourceType === 'api-json') {
    workflow.headers.accept = 'application/json, text/plain;q=0.9, */*;q=0.8';
  }

  if (sourceType === 'sitemap' || sourceType === 'feed') {
    workflow.headers.accept = 'application/xml, text/xml;q=0.9, application/rss+xml;q=0.9, application/atom+xml;q=0.9, */*;q=0.8';
  }

  if (workflow.maxDepth > 0 || sourceType === 'api-json' || sourceType === 'sitemap' || sourceType === 'feed') {
    workflow.discovery = {
      enabled: true,
      maxPages,
      maxLinksPerPage: sourceType === 'sitemap' ? 10000 : sourceType === 'feed' ? 100 : 50,
      sameOriginOnly: sourceType === 'sitemap' || sourceType === 'feed' ? false : true,
      exclude: ['\\.(jpg|jpeg|png|gif|svg|webp|css|js|woff2?|ico|pdf)(\\?.*)?$'],
      extractor: sourceType === 'sitemap'
        ? {
              name: 'discover',
              type: 'xpath',
              xpath: '//url/loc/text() | //sitemap/loc/text()',
              all: true,
              xml: true,
              maxItems: 500,
            }
        : sourceType === 'feed'
          ? {
              name: 'discover',
              type: 'script',
              code: `
                const maxItems = 100;
                const rssLinks = [...body.matchAll(/<item\\b[\\s\\S]*?<link\\b[^>]*>([\\s\\S]*?)<\\/link>/gi)]
                  .map((match) => match[1]?.trim())
                  .filter(Boolean);
                const atomLinks = [...body.matchAll(/<entry\\b[\\s\\S]*?<link\\b[^>]*href=["']([^"']+)["'][^>]*\\/?>(?:<\\/link>)?/gi)]
                  .map((match) => match[1]?.trim())
                  .filter(Boolean);
                return [...new Set([...rssLinks, ...atomLinks])].slice(0, maxItems);
              `,
            }
          : {
              name: 'discover',
              type: 'links',
              selector: 'a[href]',
              all: true,
              maxItems: 50,
            },
    };
  }

  return {
    workflow,
    suggestedWorkflowId: slugifyValue(input.workflowId || workflow.name),
    template: {
      sourceType,
      extractPreset,
    },
  };
}

export function buildPreviewWorkflow({
  url,
  sourceType = 'static-page',
  renderWaitMs = 800,
  rule,
} = {}) {
  if (!url) {
    throw new Error('url is required');
  }
  if (!rule || typeof rule !== 'object') {
    throw new Error('rule is required');
  }

  const workflow = buildWorkflowFromTemplate({
    taskName: 'extract-preview',
    seedUrl: url,
    sourceType,
    extractPreset: 'surface',
    renderWaitMs,
    useSession: false,
    useBrowserDebug: sourceType === 'browser-rendered',
    persistBodies: false,
    maxDepth: 0,
    maxPages: 1,
  }).workflow;

  workflow.name = 'extract-preview';
  workflow.extract = [{
    name: rule.name ?? 'preview',
    ...rule,
  }];
  workflow.output.dir = 'runs/previews';
  return workflow;
}

export function buildWorkflowFromUniversalTarget(input = {}) {
  const plan = buildUniversalCrawlPlan(input);
  const url = firstNonEmptyString(input.url, input.target, input.source);
  const taskName = deriveTaskName(input);
  const suggestedWorkflowId = slugifyValue(firstNonEmptyString(input.workflowId, taskName), 'universal-scaffold');
  const primaryLane = pickPrimaryLane(plan);

  const result = {
    workflow: null,
    artifact: null,
    artifactKind: null,
    suggestedWorkflowId,
    analysis: plan.analysis,
    plan,
    primaryLane,
    runnable: plan.runnable,
    unsupportedReason: null,
    warnings: Array.isArray(plan.warnings) ? [...plan.warnings] : [],
    nextActions: Array.isArray(plan.nextActions) ? [...plan.nextActions] : [],
  };

  if (!url) {
    if (input.app) {
      result.runnable = false;
      result.unsupportedReason = 'Native app targets require platform execution or capture plans, not a direct workflow seed URL.';
      return result;
    }
    throw new Error('url, target, or source is required');
  }

  if (!plan.runnable) {
    result.unsupportedReason = plan.analysis?.blockers?.[0] ?? 'Target requires manual or human-assisted handling before automation.';
    return result;
  }

  let item;

  switch (primaryLane) {
    case 'grpc-semantics': {
      item = buildGrpcWorkflowScaffold(input, {
        taskName,
        url,
      });
      break;
    }

    case 'graphql-semantics': {
      const query = firstNonEmptyString(input.query, input.operation, input.body) ?? 'query AutoGeneratedQuery { __typename }';
      const variables = isPlainObject(input.variables) ? input.variables : {};
      const headers = {
        accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        'content-type': 'application/json',
      };
      item = buildWorkflowFromTemplate({
        taskName,
        seedUrl: url,
        sourceType: 'api-json',
        extractPreset: 'json-payload',
        maxDepth: 0,
        maxPages: 1,
        useSession: true,
        persistBodies: true,
      });
      item.workflow.mode = 'http';
      item.workflow.headers = {
        ...item.workflow.headers,
        ...headers,
      };
      item.workflow.request = {
        method: 'POST',
      };
      item.workflow.seedRequests = [
        buildSeedRequest(url, input, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query, variables }),
          label: 'graphql-operation',
          metadata: {
            lane: 'graphql-semantics',
          },
        }),
      ];
      item.workflow.extract = [
        { name: 'data', type: 'json', path: 'data' },
        { name: 'errors', type: 'json', path: 'errors' },
        { name: 'payload', type: 'script', code: 'return json;' },
      ];
      item.workflow.discovery = {
        enabled: false,
      };
      item.template = {
        sourceType: 'graphql',
        extractPreset: 'graphql-data',
      };
      break;
    }

    case 'websocket-semantics': {
      const sendMessage = parseMessageCandidate(input.sendMessage ?? input.message ?? input.body);
      item = buildWorkflowFromTemplate({
        taskName,
        seedUrl: url,
        sourceType: 'api-json',
        extractPreset: 'json-payload',
        maxDepth: 0,
        maxPages: 1,
        useSession: true,
        persistBodies: true,
      });
      item.workflow.mode = 'http';
      item.workflow.headers = {
        ...item.workflow.headers,
        ...normalizeInputHeaders(input.headers),
      };
      item.workflow.seedRequests = [
        buildSeedRequest(url, input, {
          method: 'GET',
          label: 'websocket-session',
          metadata: {
            lane: 'websocket-semantics',
          },
        }),
      ];
      item.workflow.websocket = {
        ...item.workflow.websocket,
        collectMs: toPositiveInt(input.collectMs, 5000, 100, 300000),
        maxMessages: toPositiveInt(input.maxMessages, 100, 1, 10000),
        ...(sendMessage === null ? {} : { sendMessage }),
      };
      item.workflow.extract = [
        { name: 'messages', type: 'script', code: 'return json;' },
        {
          name: 'lastMessage',
          type: 'script',
          code: 'return Array.isArray(json) && json.length > 0 ? (json[json.length - 1]?.json ?? json[json.length - 1]?.text ?? json[json.length - 1]) : null;',
        },
      ];
      item.workflow.discovery = {
        enabled: false,
      };
      item.template = {
        sourceType: 'websocket',
        extractPreset: 'transcript',
      };
      break;
    }

    case 'browser-crawl': {
      item = buildWorkflowFromTemplate({
        taskName,
        seedUrl: url,
        sourceType: 'browser-rendered',
        extractPreset: input.extractPreset ?? 'surface',
        renderWaitMs: toPositiveInt(input.renderWaitMs, 1200, 0, 10000),
        maxDepth: toPositiveInt(input.maxDepth, 0, 0, 3),
        maxPages: toPositiveInt(input.maxPages, 10, 1, 200),
        useSession: true,
        useBrowserDebug: true,
        persistBodies: true,
      });
      break;
    }

    case 'api-json': {
      item = buildWorkflowFromTemplate({
        taskName,
        seedUrl: url,
        sourceType: 'api-json',
        extractPreset: 'json-payload',
        maxDepth: 0,
        maxPages: toPositiveInt(input.maxPages, 5, 1, 200),
        useSession: true,
        persistBodies: true,
      });
      if (input.body !== undefined || input.method !== undefined) {
        item.workflow.seedRequests = [
          buildSeedRequest(url, input, {
            method: input.body !== undefined ? 'POST' : 'GET',
            label: 'api-request',
            metadata: {
              lane: 'api-json',
            },
          }),
        ];
      }
      break;
    }

    case 'http-crawl':
    default: {
      item = buildWorkflowFromTemplate({
        taskName,
        seedUrl: url,
        sourceType: 'static-page',
        extractPreset: input.extractPreset ?? 'title-links',
        maxDepth: toPositiveInt(input.maxDepth, 1, 0, 3),
        maxPages: toPositiveInt(input.maxPages, 20, 1, 200),
        useSession: true,
        persistBodies: false,
      });
      if (input.body !== undefined || input.method !== undefined) {
        item.workflow.seedRequests = [
          buildSeedRequest(url, input, {
            method: input.body !== undefined ? 'POST' : 'GET',
            label: 'seed-request',
            metadata: {
              lane: primaryLane ?? 'http-crawl',
            },
          }),
        ];
      }
      break;
    }
  }

  item.workflow.headers = {
    ...item.workflow.headers,
    ...normalizeInputHeaders(input.headers),
  };

  const hinted = applyUniversalWorkflowHints(item.workflow, plan, primaryLane);
  result.workflow = hinted.workflow;
  result.warnings = hinted.warnings;
  result.template = item.template;
  return result;
}
