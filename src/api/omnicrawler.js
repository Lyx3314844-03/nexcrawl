import { JobRunner } from "../runtime/job-runner.js";
import { validateWorkflow } from "../schemas/workflow-schema.js";
import { CrawlContextImpl } from "./crawl-context.js";
import { Router } from "./router.js";
import { ItemPipeline } from "./item-pipeline.js";
import { GracefulShutdown } from "./graceful-shutdown.js";
import { createLogger } from "../core/logger.js";
import { SessionStore } from "../runtime/session-store.js";
import { HistoryStore } from "../runtime/history-store.js";
import { DatasetStore } from "../runtime/dataset-store.js";
import { KeyValueStore } from "../runtime/key-value-store.js";
import { closeBrowser } from "../fetchers/browser-fetcher.js";
import { JobStore } from "../runtime/job-store.js";
import { ReverseEngine } from "../reverse/reverse-engine.js";
import { ReversePlugin } from "../plugins/reverse-plugin.js";
import { RequestDeduplicator } from "../runtime/request-fingerprint.js";
import { ExportManager } from "../runtime/export-manager.js";
import { downloadMediaAssets, collectMediaAssetsFromResult } from "../runtime/media-downloader.js";
import { buildReplayWorkflowPatchTemplate } from "../runtime/replay-workflow.js";
import { createWorkflowReverseRuntime } from "../runtime/reverse-workflow-runtime.js";
import { buildMediaExtractRules } from "../extractors/media-extractor.js";
import { getGlobalConfig } from "../utils/config.js";
import { extractShadowDom, extractIframes } from "../extractors/shadow-dom-extractor.js";
import { createAuthHandler } from "../middleware/auth-handler.js";
import { createIncrementalCrawlTracker } from "../runtime/incremental-crawl.js";
import { createCronScheduler } from "../runtime/cron-scheduler.js";
import { fetchSearchResults } from "../fetchers/search-engine-fetcher.js";

import { join, resolve } from "node:path";

const LEGACY_APP_BUNDLE_IDS = {
  wechat: 'com.tencent.mm',
  douyin: 'com.ss.android.ugc.aweme',
  taobao: 'com.taobao.taobao',
  jd: 'com.jingdong.app.mall',
};

function normalizeSeedRequest(input) {
  if (typeof input === "string") {
    return { url: input };
  }

  if (!input || typeof input !== "object" || Array.isArray(input) || !input.url) {
    throw new TypeError("Seed request must be a URL string or an object with a url field");
  }

  return {
    url: input.url,
    method: input.method,
    headers: input.headers,
    body: input.body,
    grpc: input.grpc,
    websocket: input.websocket,
    label: input.label ?? null,
    priority: input.priority,
    userData: input.userData ?? {},
    metadata: input.metadata ?? {},
  };
}

async function resolveProgrammaticPlugin(entry, context) {
  const resolved =
    typeof entry.plugin === 'function'
      ? await entry.plugin(entry.options ?? {}, context)
      : entry.plugin;

  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new TypeError('Programmatic plugin must resolve to a plugin object');
  }

  return resolved;
}

function normalizeMiddlewareConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Middleware config must be an object');
  }

  const normalized = {
    route: {},
    runtime: {},
  };

  const routeSource = input.route && typeof input.route === 'object' && !Array.isArray(input.route)
    ? input.route
    : {};
  const runtimeSource = input.runtime && typeof input.runtime === 'object' && !Array.isArray(input.runtime)
    ? input.runtime
    : {};

  for (const [key, value] of Object.entries(routeSource)) {
    if (typeof value === 'function') {
      normalized.route[key] = value;
    }
  }

  for (const [key, value] of Object.entries(runtimeSource)) {
    if (typeof value === 'function') {
      normalized.runtime[key] = value;
    }
  }

  if (typeof input.beforeRequest === 'function') {
    normalized.route.beforeRequest = input.beforeRequest;
  }
  if (typeof input.afterResponse === 'function') {
    normalized.route.afterResponse = input.afterResponse;
  }
  if (typeof input.onError === 'function') {
    normalized.route.onError = input.onError;
  }

  return normalized;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergePlainObjects(base = {}, next = {}) {
  const output = { ...base };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = mergePlainObjects(output[key], value);
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = [...value];
      continue;
    }
    output[key] = value;
  }
  return output;
}

function removeUndefinedEntries(input = {}) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function appendExtractRules(existing = [], next = []) {
  return [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(next) ? next : [])];
}

function normalizeMediaDownloadConfig(config = {}) {
  return removeUndefinedEntries({
    enabled: config.enabled !== false,
    outputDir: config.outputDir,
    fields: Array.isArray(config.fields) && config.fields.length > 0 ? [...new Set(config.fields)] : ['media', 'images', 'videos', 'audio'],
    organizeByKind: config.organizeByKind !== false,
    skipExisting: config.skipExisting !== false,
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
    retryAttempts: config.retryAttempts,
    retryBackoffMs: config.retryBackoffMs,
    headers: config.headers,
    maxBytes: config.maxBytes,
    manifestPath: config.manifestPath,
    failuresPath: config.failuresPath,
    mediaInclude: config.mediaInclude,
    mediaExclude: config.mediaExclude,
    subdirTemplate: config.subdirTemplate,
    fileNameTemplate: config.fileNameTemplate,
  });
}

function mapLegacyStealthToIdentity(stealth) {
  if (!stealth) {
    return null;
  }

  const options = isPlainObject(stealth) ? stealth : {};
  return removeUndefinedEntries({
    enabled: true,
    locale: options.locale,
    languages: options.languages,
    platform: options.platform,
    vendor: options.vendor,
    userAgent: options.userAgent,
    deviceMemory: options.deviceMemory,
    hardwareConcurrency: options.hardwareConcurrency,
    maxTouchPoints: options.maxTouchPoints,
    webglVendor: options.webglVendor,
    webglRenderer: options.webglRenderer,
    canvasNoise: options.canvasNoise,
    audioNoise: options.audioNoise,
    timezoneId: options.timezoneId,
    acceptLanguage: options.acceptLanguage,
  });
}

function mapLegacyAppWebViewToWorkflow(appWebView) {
  if (!appWebView) {
    return null;
  }

  const config = isPlainObject(appWebView) ? appWebView : { type: appWebView };
  const appType = String(config.type ?? appWebView).trim().toLowerCase();
  if (!appType) {
    return null;
  }

  return removeUndefinedEntries({
    enabled: true,
    platform: appType === 'ios' ? 'ios' : appType === 'android' ? 'android' : 'webview',
  });
}

function buildWorkflowRuntimeConfig({
  identityConfig = null,
  signerConfig = null,
  reverseRuntimeConfig = null,
  reverseConfig = null,
} = {}) {
  let identity = isPlainObject(identityConfig) ? mergePlainObjects({}, identityConfig) : null;
  let reverse = isPlainObject(reverseRuntimeConfig) ? mergePlainObjects({}, reverseRuntimeConfig) : null;
  const signer = isPlainObject(signerConfig) ? mergePlainObjects({}, signerConfig) : null;

  if (reverseConfig?.stealth) {
    identity = mergePlainObjects(identity ?? {}, mapLegacyStealthToIdentity(reverseConfig.stealth) ?? {});
  }

  if (reverseConfig?.tlsProfile) {
    identity = mergePlainObjects(identity ?? {}, {
      enabled: true,
      tlsProfile: reverseConfig.tlsProfile,
    });
  }

  if (reverseConfig?.h2Profile) {
    identity = mergePlainObjects(identity ?? {}, {
      enabled: true,
      h2Profile: reverseConfig.h2Profile,
    });
  }

  if (reverseConfig?.reverseAnalysis) {
    reverse = mergePlainObjects(reverse ?? {}, {
      enabled: true,
      autoReverseAnalysis: true,
    });
  }

  if (reverseConfig?.cloudflare) {
    reverse = mergePlainObjects(reverse ?? {}, {
      enabled: true,
      cloudflare: reverseConfig.cloudflare,
    });
  }

  if (reverseConfig?.captcha) {
    reverse = mergePlainObjects(reverse ?? {}, {
      enabled: true,
      captcha: reverseConfig.captcha,
    });
  }

  if (reverseConfig?.behaviorSim) {
    reverse = mergePlainObjects(reverse ?? {}, {
      enabled: true,
      behaviorSimulation: reverseConfig.behaviorSim,
    });
  }

  if (reverseConfig?.challenge) {
    reverse = mergePlainObjects(reverse ?? {}, {
      enabled: true,
      challenge: reverseConfig.challenge,
    });
  }

  if (reverseConfig?.appWebView) {
    const mappedApp = mapLegacyAppWebViewToWorkflow(reverseConfig.appWebView);
    if (mappedApp) {
      reverse = mergePlainObjects(reverse ?? {}, {
        enabled: true,
        app: mappedApp,
      });
    }

    const appType = String(
      (isPlainObject(reverseConfig.appWebView) ? reverseConfig.appWebView.type : reverseConfig.appWebView) ?? '',
    ).trim().toLowerCase();
    const bundleId = LEGACY_APP_BUNDLE_IDS[appType] ?? undefined;
    const userAgent = isPlainObject(reverseConfig.appWebView) ? reverseConfig.appWebView.userAgent : undefined;
    if (bundleId || userAgent) {
      identity = mergePlainObjects(identity ?? {}, removeUndefinedEntries({
        enabled: true,
        bundleId,
        userAgent,
      }));
    }
  }

  return {
    identity: identity && Object.keys(identity).length > 0 ? identity : null,
    reverse: reverse && Object.keys(reverse).length > 0 ? reverse : null,
    signer: signer && Object.keys(signer).length > 0 ? signer : null,
  };
}

function applyLegacyReverseConfigToEngine(engine, reverseConfig = {}) {
  if (!engine || !reverseConfig) {
    return engine;
  }

  for (const [key, value] of Object.entries(reverseConfig)) {
    if (value !== undefined) {
      engine[key] = value;
    }
  }

  return engine;
}

function buildProgrammaticSummary({ crawler, runnerSummary, durationMs }) {
  return {
    ...runnerSummary,
    name: crawler._name,
    itemsPushed: crawler._itemCount,
    requestsFailed: runnerSummary.failureCount ?? 0,
    failedRequestCount: runnerSummary.failedRequestCount ?? runnerSummary.failureCount ?? 0,
    requestsRetried: runnerSummary.retryCount ?? runnerSummary.requestsRetried ?? 0,
    durationMs,
    datasetId: crawler._datasetStore?.datasetId ?? runnerSummary.jobId ?? null,
    keyValueStoreId: crawler._kvStore?.storeId ?? runnerSummary.jobId ?? null,
    systemKeyValueStoreId: runnerSummary.jobId ?? null,
  };
}

function createFailedRequestSnapshot({ item, request, response, error, attempt, runner }) {
  const seed = request ?? item ?? {};
  return {
    attempt: Number(attempt ?? 0) || 1,
    error,
    item: item ?? null,
    request: {
      url: seed.url,
      method: seed.method ?? 'GET',
      headers: seed.headers ?? {},
      body: seed.body,
      depth: seed.depth ?? 0,
      parentUrl: seed.parentUrl ?? null,
      uniqueKey: seed.uniqueKey ?? null,
      label: seed.label ?? seed.metadata?.label ?? null,
      params: seed.params ?? {},
      userData: seed.userData ?? {},
      metadata: seed.metadata ?? {},
    },
    response: response ?? null,
    runner: runner ?? null,
  };
}

export class OmniCrawler {
  constructor(config = {}) {
    const globalConfig = getGlobalConfig();
    this._name = config.name ?? "default";
    this._mode = config.mode ?? "http";
    this._concurrency = config.concurrency ?? globalConfig.get('performance.concurrency') ?? 3;
    this._maxDepth = config.maxDepth ?? 1;
    this._timeoutMs = config.timeoutMs ?? globalConfig.get('performance.timeout') ?? 30000;
    this._projectRoot = config.projectRoot ?? process.cwd();
    this._headers = config.headers ?? {};
    this._seedRequests = [];
    this._router = null;
    this._itemPipeline = null;
    this._middleware = { route: {}, runtime: {} };
    this._shutdown = null;
    this._proxy = null;
    this._workflowOverrides = {};
    this._rateLimiter = null;
    this._deduplicator = null;
    this._exportManager = null;
    this._lifecycle = { onReady: null, onIdle: null, onComplete: null, onError: null, onFailedRequest: null };
    this._log = createLogger("omnicrawler:" + this._name);
    this._runner = null;
    this._running = false;
    this._startTime = 0;
    this._summary = null;
    this._itemCount = 0;
    this._sessionStore = null;
    this._datasetStore = null;
    this._kvStore = null;
    this._reverseEngine = null;
    this._programmaticPlugins = [];
    this._identityConfig = isPlainObject(config.identity) ? mergePlainObjects({}, config.identity) : null;
    this._signerConfig = isPlainObject(config.signer) ? mergePlainObjects({}, config.signer) : null;
    this._reverseRuntimeConfig = isPlainObject(config.reverse) ? mergePlainObjects({}, config.reverse) : null;
    this._mediaDownloadConfig = null;
  }

  addSeedUrls(urls) { return this.addRequests(urls); }
  addRequests(requests) {
    const list = Array.isArray(requests) ? requests : [requests];
    this._seedRequests.push(...list.map(normalizeSeedRequest));
    return this;
  }
  setMode(mode) { if (!["http", "cheerio", "browser", "hybrid"].includes(mode)) { throw new Error("Invalid mode. Use: http, cheerio, browser, hybrid"); } this._mode = mode; return this; }
  setConcurrency(n) { if (n < 1 || n > 20) { throw new Error("Concurrency must be between 1 and 20"); } this._concurrency = n; return this; }
  setMaxDepth(n) { if (n < 0 || n > 10) { throw new Error("Max depth must be between 0 and 10"); } this._maxDepth = n; return this; }
  setTimeout(ms) { if (ms < 1000 || ms > 120000) { throw new Error("Timeout must be between 1000 and 120000 ms"); } this._timeoutMs = ms; return this; }
  setHeaders(h) { this._headers = { ...this._headers, ...h }; return this; }
  setProjectRoot(d) { this._projectRoot = d; return this; }
  useRouter(r) { if (!(r instanceof Router)) { throw new TypeError("Expected a Router instance"); } this._router = r; return this; }
  useItemPipeline(p) { if (!(p instanceof ItemPipeline)) { throw new TypeError("Expected an ItemPipeline instance"); } this._itemPipeline = p; return this; }
  useMiddleware(h) {
    const normalized = normalizeMiddlewareConfig(h);
    this._middleware = {
      route: { ...this._middleware.route, ...normalized.route },
      runtime: { ...this._middleware.runtime, ...normalized.runtime },
    };
    return this;
  }
  /**
   * Register a runtime plugin object or async plugin factory for programmatic runs.
   * Factories receive `(options, { crawler, runner, logger })`.
   * @param {Object|Function} plugin
   * @param {Object} [options]
   * @returns {OmniCrawler}
   */
  usePlugin(plugin, options = {}) {
    if ((typeof plugin !== 'function' && (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)))) {
      throw new TypeError('Expected a plugin object or async plugin factory');
    }
    this._programmaticPlugins.push({ plugin, options });
    return this;
  }
  useProxy(u) { this._proxy = u; return this; }
  useRateLimiter(c) { this._workflowOverrides.rateLimiter = c; return this; }
  useDeduplicator(c) { this._workflowOverrides.deduplicator = c; return this; }
  useExport(c) { this._workflowOverrides.export = c; return this; }
  useProxyPool(c) { this._workflowOverrides.proxyPool = c; return this; }
  onReady(fn) { this._lifecycle.onReady = fn; return this; }
  onIdle(fn) { this._lifecycle.onIdle = fn; return this; }
  onComplete(fn) { this._lifecycle.onComplete = fn; return this; }
  onError(fn) { this._lifecycle.onError = fn; return this; }
  onFailedRequest(fn) { this._lifecycle.onFailedRequest = fn; return this; }
  gracefulShutdown(o = {}) { this._shutdown = new GracefulShutdown({ timeoutMs: o.timeoutMs ?? 15000, install: false }); return this; }
  setBrowserOptions(c) { this._workflowOverrides.browser = c; return this; }
  setSessionOptions(c) { this._workflowOverrides.session = c; return this; }
  setRetryOptions(c) { this._workflowOverrides.retry = c; return this; }
  setAutoscaleOptions(c) { this._workflowOverrides.autoscale = c; return this; }
  setRequestQueueOptions(c) { this._workflowOverrides.requestQueue = c; return this; }
  setDiscovery(c) { this._workflowOverrides.discovery = c; return this; }
  setExtractRules(c) { this._workflowOverrides.extract = c; return this; }
  useMediaExtraction(options = {}) {
    const rules = buildMediaExtractRules(options);
    this._workflowOverrides.extract = appendExtractRules(this._workflowOverrides.extract, rules);

    if (options.includeNetwork !== false) {
      this.setBrowserOptions(mergePlainObjects(this._workflowOverrides.browser ?? {}, {
        debug: {
          enabled: true,
          captureNetwork: true,
          maxRequests: Number(options.maxNetworkRequests ?? 200) || 200,
        },
      }));
    }

    return this;
  }
  useMediaDownload(config = {}) {
    this._mediaDownloadConfig = normalizeMediaDownloadConfig(config);
    this._workflowOverrides.mediaDownload = this._mediaDownloadConfig;

    const hasMediaExtractRule = Array.isArray(this._workflowOverrides.extract)
      && this._workflowOverrides.extract.some((rule) => rule?.type === 'media');

    if (!hasMediaExtractRule) {
      this.useMediaExtraction({
        includeNetwork: config.includeNetwork !== false,
        format: 'object',
        maxItems: config.maxItems ?? 300,
      });
    }

    return this;
  }
  setCrawlPolicy(c) { this._workflowOverrides.crawlPolicy = c; return this; }
  setIdentity(config = {}) {
    this._identityConfig = mergePlainObjects(this._identityConfig ?? {}, config);
    return this;
  }
  setSigner(config = {}) {
    this._signerConfig = mergePlainObjects(this._signerConfig ?? {}, config);
    return this;
  }
  setReverseRuntime(config = {}) {
    this._reverseRuntimeConfig = mergePlainObjects(this._reverseRuntimeConfig ?? {}, config);
    return this;
  }

  /**
   * Enable stealth anti-detection for browser mode.
   * @param {Object} [options] - StealthProfile options (locale, platform, userAgent, etc.)
   * @returns {OmniCrawler}
   */
  useStealth(options = {}) {
    this._reverseConfig = this._reverseConfig ?? {};
    this._reverseConfig.stealth = Object.keys(options).length > 0 ? options : true;
    this.setIdentity(mapLegacyStealthToIdentity(this._reverseConfig.stealth) ?? { enabled: true });
    return this;
  }

  /**
   * Enable Cloudflare challenge solving.
   * @param {Object} [options] - CloudflareSolver options
   * @returns {OmniCrawler}
   */
  useCloudflareSolver(options = {}) {
    this._reverseConfig = this._reverseConfig ?? {};
    this._reverseConfig.cloudflare = Object.keys(options).length > 0 ? options : true;
    return this;
  }

  /**
   * Enable CAPTCHA solving via third-party service.
   * @param {string} provider - '2captcha', 'capsolver', or 'yescaptcha'
   * @param {string} apiKey - API key for the service
   * @param {Object} [options] - Additional captcha options
   * @returns {OmniCrawler}
   */
  useCaptchaSolver(provider, apiKey, options = {}) {
    if (!provider || !apiKey) throw new Error('useCaptchaSolver requires provider and apiKey');
    this._reverseConfig = this._reverseConfig ?? {};
    this._reverseConfig.captcha = { provider, apiKey, ...options };
    return this;
  }

  /**
   * Enable human behavior simulation for browser mode.
   * @param {Object} [options] - BehaviorSimulation options
   * @returns {OmniCrawler}
   */
  useBehaviorSimulation(options = {}) {
    this._reverseConfig = this._reverseConfig ?? {};
    this._reverseConfig.behaviorSim = Object.keys(options).length > 0 ? options : true;
    return this;
  }

  /**
   * Enable App WebView emulation for mobile in-app browsing.
   * @param {string} appType - 'wechat'|'douyin'|'taobao'|'jd'|'android'|'ios'
   * @param {Object} [options] - Additional WebView options
   * @returns {OmniCrawler}
   */
  useAppWebView(appType, options = {}) {
    if (!['wechat','douyin','taobao','jd','android','ios'].includes(appType)) {
      throw new Error('Invalid appWebView type. Use: wechat, douyin, taobao, jd, android, ios');
    }
    this._reverseConfig = this._reverseConfig ?? {};
    this._reverseConfig.appWebView = Object.keys(options).length > 0 ? { type: appType, ...options } : appType;
    this.setReverseRuntime({
      enabled: true,
      app: mapLegacyAppWebViewToWorkflow(this._reverseConfig.appWebView),
    });
    const bundleId = LEGACY_APP_BUNDLE_IDS[appType];
    if (bundleId || options.userAgent) {
      this.setIdentity(removeUndefinedEntries({
        enabled: true,
        bundleId,
        userAgent: options.userAgent,
      }));
    }
    return this;
  }

  /**
   * Enable JS/crypto/webpack analysis in route handlers.
   * @param {Object} [options] - Analysis options
   * @returns {OmniCrawler}
   */
  useReverseAnalysis(options = {}) {
    this._reverseConfig = this._reverseConfig ?? {};
    this._reverseConfig.reverseAnalysis = Object.keys(options).length > 0 ? options : true;
    this.setReverseRuntime({
      enabled: true,
      autoReverseAnalysis: true,
    });
    return this;
  }

  /**
   * Set TLS fingerprint profile for HTTP mode.
   * @param {string} profileName - TLS profile name (e.g. 'chrome_120')
   * @returns {OmniCrawler}
   */
  useTlsProfile(profileName) {
    if (!profileName) throw new Error('useTlsProfile requires a profile name');
    this._reverseConfig = this._reverseConfig ?? {};
    this._reverseConfig.tlsProfile = profileName;
    this.setIdentity({
      enabled: true,
      tlsProfile: profileName,
    });
    return this;
  }

  /**
   * Set HTTP/2 fingerprint profile.
   * @param {Object} profile - H2 profile configuration
   * @returns {OmniCrawler}
   */
  useH2Profile(profile) {
    if (!profile) throw new Error('useH2Profile requires a profile config');
    this._reverseConfig = this._reverseConfig ?? {};
    this._reverseConfig.h2Profile = profile;
    this.setIdentity({
      enabled: true,
      h2Profile: profile,
    });
    return this;
  }

  /**
   * Configure reverse engine with a full config object.
   * @param {Object} config - ReverseEngine config
   * @returns {OmniCrawler}
   */
  useReverse(config) {
    this._reverseConfig = { ...this._reverseConfig, ...config };
    return this;
  }

  /**
   * Enable auto-scroll for infinite-scroll / lazy-loaded pages.
   * @param {object} [opts] - Scroll options (maxScrolls, delayMs, stabilityThresholdMs, loadMoreSelector)
   * @returns {OmniCrawler}
   */
  useAutoScroll(opts = {}) {
    const config = {
      enabled: true,
      ...opts,
    };
    this._autoScrollOpts = config;
    this.setBrowserOptions(mergePlainObjects(this._workflowOverrides.browser ?? {}, {
      autoScroll: config,
    }));
    return this;
  }

  /**
   * Enable deep extraction of Shadow DOM and iframes.
   * @param {object} [opts] - Deep extract options (selector, includeClosed, maxDepth, extractFields)
   * @returns {OmniCrawler}
   */
  useDeepExtract(opts = {}) {
    this._deepExtractOpts = opts;
    return this;
  }

  /**
   * Enable automatic authentication (OAuth2/JWT/Digest).
   * @param {object} config - Auth config (type, clientId, clientSecret, tokenUrl, etc.)
   * @returns {OmniCrawler}
   */
  useAuth(config = {}) {
    this._authConfig = config;
    return this;
  }

  /**
   * Enable incremental crawling (skip already-seen URLs / content).
   * @param {object} [opts] - Incremental crawl options (storagePath, strategy, contentHashing)
   * @returns {OmniCrawler}
   */
  useIncrementalCrawl(opts = {}) {
    this._incrementalOpts = opts;
    return this;
  }

  /**
   * Enable cron-based scheduling for periodic crawl jobs.
   * @param {object} [opts] - Cron scheduler options (storagePath, restoreOnStartup)
   * @returns {OmniCrawler}
   */
  useCronSchedule(opts = {}) {
    this._cronOpts = opts;
    return this;
  }

  /**
   * Enable search engine result crawling (Google/Bing/DuckDuckGo/Baidu).
   * @param {object} config - Search config (engine, query, maxPages, language, etc.)
   * @returns {OmniCrawler}
   */
  useSearchEngine(config = {}) {
    this._searchEngineConfig = config;
    return this;
  }


  _buildWorkflow() {
    if (this._seedRequests.length === 0) { throw new Error("No seed URLs. Call .addSeedUrls() before .run()"); }
    const proxy =
      typeof this._proxy === 'string'
        ? { server: this._proxy }
        : this._proxy?.url && !this._proxy?.server
          ? { ...this._proxy, server: this._proxy.url }
          : this._proxy;
    const workflow = {
      name: this._name,
      seedUrls: this._seedRequests.map((request) => request.url),
      seedRequests: this._seedRequests.map((request) => ({ ...request })),
      mode: this._mode,
      concurrency: this._concurrency,
      maxDepth: this._maxDepth,
      timeoutMs: this._timeoutMs,
      headers: this._headers,
      plugins: [{ name: "dedupe" }, { name: "audit" }],
      output: { dir: "runs/" + this._name + "-" + Date.now(), console: true },
    };
    const runtimeConfig = buildWorkflowRuntimeConfig({
      identityConfig: this._identityConfig,
      signerConfig: this._signerConfig,
      reverseRuntimeConfig: this._reverseRuntimeConfig,
      reverseConfig: this._reverseConfig,
    });
    if (runtimeConfig.identity) {
      workflow.identity = runtimeConfig.identity;
    }
    if (runtimeConfig.reverse) {
      workflow.reverse = runtimeConfig.reverse;
    }
    if (runtimeConfig.signer) {
      workflow.signer = runtimeConfig.signer;
    }
    for (const [k, v] of Object.entries(this._workflowOverrides)) {
      if (v !== undefined && v !== null) { workflow[k] = v; }
    }
    if (proxy) { workflow.proxy = proxy; }
    return workflow;
  }

  /**
   * Process a fetched page through Router handler, middleware, and pipeline.
   * Called internally after each page fetch when a Router is configured.
   * @param {Object} request - The request descriptor
   * @param {Object} response - The fetch response
   * @param {Object} [extracted] - Extracted data from extractor engine
   * @returns {Promise<Object[]|null>} Processed items, or null if no handler matched.
   *   Note: The afterExtract hook ignores return values (PluginManager aggregates via Object.assign),
   *   but this return is retained for direct testing and future use.
   * @private
   */
  async _processPage(request, response, extracted) {
    if (!this._router) return null;
    let urlPath;
    try { urlPath = new URL(request.url).pathname; } catch(e) { urlPath = request.url; }
    const route = this._router.resolve(urlPath, request.label ?? request.metadata?.label ?? null);
    if (!route) return null;
    const ctx = new CrawlContextImpl({
      item: {
        ...request,
        label: route.label ?? request.label ?? request.metadata?.label ?? null,
        params: route.params ?? {},
      },
      response,
      extracted,
      runner: this._runner,
      reverseEngine: this._reverseEngine,
    });
    if (this._middleware.route.beforeRequest) {
      await this._middleware.route.beforeRequest(ctx);
    }
    try {
      await route.handler(ctx);
    } catch (handlerErr) {
      if (this._middleware.route.onError) {
        await this._middleware.route.onError(ctx, handlerErr);
      }
      this._log.error('Handler threw, skipping pipeline', { url: request.url, error: handlerErr.message });
      return null;
    }
    if (this._middleware.route.afterResponse) {
      await this._middleware.route.afterResponse(ctx);
    }
    // Drain items pushed by handler, optionally through the pipeline
    const items = await ctx.drainItems(this._itemPipeline);
    // Persist processed items to dataset store
    const datasetStore = this._datasetStore ?? this._runner?.datasetStore ?? null;
    if (items.length > 0 && datasetStore) {
      for (const item of items) {
        await datasetStore.addItem(item);
      }
      this._itemCount += items.length;
    }
    return items;
  }

  async run() {
    if (this._running) { throw new Error("Crawler is already running"); }
    const workflow = this._buildWorkflow();
    let validated;    try {      validated = validateWorkflow(workflow);
    } catch (err) {
      const issues = err.issues
        ? err.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")
        : err.message;
      throw new Error("Workflow validation failed: " + issues);
    }
    this._log.info("Starting crawler", { name: this._name, mode: this._mode, seeds: this._seedRequests.length });
    this._running = true;
    this._startTime = Date.now();
    this._itemCount = 0;
    this._sessionStore = new SessionStore({ projectRoot: this._projectRoot });
    this._datasetStore = null;
    this._kvStore = null;
    const historyStore = new HistoryStore({ projectRoot: this._projectRoot });
    const jobStore = new JobStore({ projectRoot: this._projectRoot });
    const reverseRuntime = await createWorkflowReverseRuntime({
      workflow: validated,
      projectRoot: this._projectRoot,
      logger: this._log,
    });
    const runtimeWorkflow = reverseRuntime?.workflow ?? validated;
    let runtimePlugins = [...(reverseRuntime?.runtimePlugins ?? [])];
    let runtimeReverseEngine = reverseRuntime?.reverseEngine ?? null;
    const runtimeAssetStore = reverseRuntime?.assetStore ?? null;

    if (runtimeReverseEngine && this._reverseConfig) {
      applyLegacyReverseConfigToEngine(runtimeReverseEngine, this._reverseConfig);
    } else if (this._reverseConfig) {
      runtimeReverseEngine = new ReverseEngine(this._reverseConfig);
      runtimePlugins.push(
        new ReversePlugin(runtimeReverseEngine, {
          workflow: runtimeWorkflow,
          assetStore: runtimeAssetStore,
        }).createPlugin(this._log),
      );
    }

    this._runner = new JobRunner({
      workflow: runtimeWorkflow,
      projectRoot: this._projectRoot,
      jobStore,
      historyStore,
      sessionStore: this._sessionStore,
      source: "programmatic",
      metadata: { api: "omnicrawler", name: this._name },
      reverseEngine: runtimeReverseEngine,
      runtimePlugins,
    });
    this._runner.reverseAssetStore = runtimeAssetStore;
    if (runtimeAssetStore) {
      runtimeAssetStore.jobId = this._runner.jobId;
    }
    this._datasetStore = new DatasetStore({
      projectRoot: this._projectRoot,
      datasetId: `${this._runner.jobId}:items`,
      metadata: {
        jobId: this._runner.jobId,
        workflowName: this._name,
        source: 'programmatic',
        kind: 'items',
      },
    });
    await this._datasetStore.init();
    this._kvStore = new KeyValueStore({
      projectRoot: this._projectRoot,
      storeId: `${this._runner.jobId}:state`,
      metadata: {
        jobId: this._runner.jobId,
        workflowName: this._name,
        source: 'programmatic',
        kind: 'state',
      },
    });
    await this._kvStore.init();
    this._runner.programmaticKeyValueStore = this._kvStore;
    this._reverseEngine = runtimeReverseEngine;
    if (this._reverseEngine?.requiresBrowser && !['browser', 'hybrid'].includes(this._mode)) {
      this._log.warn('Reverse capabilities require browser mode, but mode is ' + this._mode + '. Some features may not work.');
    }

    for (const entry of this._programmaticPlugins) {
      const plugin = await resolveProgrammaticPlugin(entry, {
        crawler: this,
        runner: this._runner,
        logger: this._log,
      });
      this._runner.runtimePlugins.push(plugin);
    }

    if (Object.keys(this._middleware.runtime).length > 0) {
      this._runner.runtimePlugins.push({
        name: 'omnicrawler-runtime-middleware',
        ...this._middleware.runtime,
      });
    }

    if (typeof this._lifecycle.onFailedRequest === 'function') {
      this._runner.runtimePlugins.push({
        name: 'omnicrawler-failed-request-handler',
        onFailedRequest: async (payload) => {
          return this._lifecycle.onFailedRequest(createFailedRequestSnapshot(payload));
        },
      });
    }

    if (this._mediaDownloadConfig && this._mediaDownloadConfig.enabled !== false) {
      this._runner.runtimePlugins.push({
        name: 'omnicrawler-media-downloader',
        afterExtract: async ({ result }) => {
          const assets = collectMediaAssetsFromResult(result, this._mediaDownloadConfig.fields);
          if (assets.length === 0) {
            return null;
          }

          const runDir = this._runner?.publicRunDir ?? this._projectRoot;
          const outputDir = this._mediaDownloadConfig.outputDir
            ? resolve(this._projectRoot, this._mediaDownloadConfig.outputDir)
            : join(runDir, 'media');
          const manifestPath = this._mediaDownloadConfig.manifestPath
            ? resolve(this._projectRoot, this._mediaDownloadConfig.manifestPath)
            : join(outputDir, 'downloads.ndjson');
          const failuresPath = this._mediaDownloadConfig.failuresPath
            ? resolve(this._projectRoot, this._mediaDownloadConfig.failuresPath)
            : join(outputDir, 'failed-downloads.ndjson');

          const downloadSummary = await downloadMediaAssets(assets, {
            ...this._mediaDownloadConfig,
            outputDir,
            manifestPath,
            failuresPath,
          });

          if (this._kvStore) {
            const key = `MEDIA_DOWNLOADS:${result.sequence}`;
            await this._kvStore.setRecord(key, {
              page: result.finalUrl,
              outputDir,
              manifestPath,
              failuresPath,
              ...downloadSummary,
            });
          }

          return null;
        },
      });
    }

    // Wire Phase 1 modules: Deduplicator, ExportManager
    this._rateLimiter = this._runner.rateLimiter ?? null;
    if (this._rateLimiter) {
      this._log.info("Rate limiter configured", { config: validated.rateLimiter });
    }
    if (this._workflowOverrides.deduplicator) {
      const deduplicatorConfig = isPlainObject(this._workflowOverrides.deduplicator)
        ? this._workflowOverrides.deduplicator
        : {};
      this._deduplicator = new RequestDeduplicator({
        ...deduplicatorConfig,
        fingerprintConfig: {
          ...(deduplicatorConfig.fingerprintConfig ?? deduplicatorConfig),
        },
        requestQueueConfig: {
          ...(validated.requestQueue ?? {}),
          ...(deduplicatorConfig.requestQueueConfig ?? deduplicatorConfig),
        },
      });
      this._log.info("Deduplicator configured", { config: this._workflowOverrides.deduplicator });
    }
    this._exportManager = null;
    if (this._workflowOverrides.export) {
      this._exportManager = new ExportManager({ projectRoot: this._projectRoot, ...this._workflowOverrides.export });
      this._log.info("Export manager configured", { config: this._workflowOverrides.export });
    }

    // Register deduplicator as a crawl pipeline plugin
    if (this._deduplicator) {
      this._runner.runtimePlugins.push({
        name: "omnicrawler-deduplicator",
        beforeRequest: async ({ request }) => {
          if (this._deduplicator.isDuplicate(request)) {
            this._log.info("Skipping duplicate URL", { url: request.url });
            request._skip = true;
            request._skipReason = 'duplicate-request';
          }
        },
      });
    }

    if (this._router) {
      this._runner.runtimePlugins.push({
        name: 'omnicrawler-router',
        afterExtract: async ({ request, response, result, item }) => {
          try {
            await this._processPage(item, response, result?.extracted ?? null);
          } catch (err) {
            this._log.error('Page processing error, skipping page', { url: item?.url, error: err.message });
          }
        },
      });
    }
    if (this._shutdown) {
      this._shutdown.registerJobPersistence(async () => {
        if (this._runner) {
          try { await this._runner.persistState(); } catch (e) {
            process.stderr.write();
          }
        }
      });
      this._shutdown.register(async () => this.teardown());

    // Close cron scheduler on shutdown
    if (this._cronScheduler) {
      this._shutdown.register(async () => {
        try { await this._cronScheduler.close(); } catch (_) { /* ignore */ }
      });
    }
      this._shutdown.install();
    }

    // ── Deep extract plugin for Shadow DOM / iframes ────────────────────────
    if (this._deepExtractOpts) {
      this._runner.runtimePlugins.push({
        name: 'omnicrawler-deep-extract',
        afterExtract: async ({ response, result }) => {
          const page = response?._page ?? null;
          if (page) {
            try {
              const shadowContent = await extractShadowDom(page, this._deepExtractOpts);
              if (shadowContent && shadowContent.length > 0) {
                result.shadowDom = shadowContent;
              }
              const iframeContent = await extractIframes(page, this._deepExtractOpts);
              if (iframeContent && iframeContent.length > 0) {
                result.iframes = iframeContent;
              }
            } catch (err) {
              this._log.warn('Deep extract failed', { error: err.message });
            }
          }
        },
      });
    }

    // ── Auth handler plugin for request authentication ─────────────────────
    if (this._authConfig) {
      try {
        const authHandler = createAuthHandler(this._authConfig);
        await authHandler.init();
        const initialHeaders = await authHandler.getAuthHeaders().catch(() => null);
        if (initialHeaders && Object.keys(initialHeaders).length > 0) {
          this._workflowOverrides.headers = {
            ...(this._workflowOverrides.headers ?? {}),
            ...initialHeaders,
          };
        }

        this._runner.runtimePlugins.push({
          name: 'omnicrawler-auth-apply',
          beforeRequest: async ({ request }) => {
            if (authHandler.isExpiring && authHandler.isExpiring()) {
              await authHandler.refresh?.();
            }

            if (typeof authHandler.applyToRequest === 'function') {
              const applied = await authHandler.applyToRequest(request);
              request.url = applied.url ?? request.url;
              request.headers = {
                ...(request.headers ?? {}),
                ...(applied.headers ?? {}),
              };
              if (applied.body !== undefined) {
                request.body = applied.body;
              }
              return;
            }

            const newHeaders = await authHandler.getAuthHeaders(request);
            if (newHeaders) {
              request.headers = { ...(request.headers ?? {}), ...newHeaders };
            }
          },
        });
      } catch (err) {
        this._log.warn('Auth handler init failed', { error: err.message });
      }
    }

    // ── Incremental crawl plugin (skip already-seen URLs) ──────────────────
    if (this._incrementalOpts) {
      try {
        const tracker = await createIncrementalCrawlTracker(this._incrementalOpts);
        this._runner.runtimePlugins.push({
          name: 'omnicrawler-incremental',
          beforeRequest: async ({ request }) => {
            const seen = await tracker.isSeen(request.url);
            if (seen) {
              request._skip = true;
              this._log.debug('Skipping seen URL', { url: request.url });
            }
          },
          afterExtract: async ({ request, result }) => {
            await tracker.markSeen(request.url, result);
          },
        });
      } catch (err) {
        this._log.warn('Incremental crawl init failed', { error: err.message });
      }
    }

    // ── Search engine plugin for SERP crawling ─────────────────────────────
    if (this._searchEngineConfig) {
      // Fetch search results and add as seed URLs before the runner starts
      try {
        const results = await fetchSearchResults(this._searchEngineConfig);
        if (results && results.items) {
          for (const item of results.items) {
            this.addSeedUrls([item.url]);
          }
          this._log.info('Search engine seeds added', { count: results.items.length });
        }
      } catch (err) {
        this._log.warn('Search engine fetch failed', { error: err.message });
      }
    }

    // ── Cron scheduler (starts background scheduling) ───────────────────────
    if (this._cronOpts) {
      try {
        const cronScheduler = await createCronScheduler(this._cronOpts);
        this._cronScheduler = cronScheduler;
        this._log.info('Cron scheduler ready', { jobs: cronScheduler.listJobs().length });
      } catch (err) {
        this._log.warn('Cron scheduler init failed', { error: err.message });
      }
    }

    if (this._lifecycle.onReady) { this._lifecycle.onReady(this); }
    try {
      const runnerSummary = await this._runner.run();
      this._summary = buildProgrammaticSummary({
        crawler: this,
        runnerSummary,
        durationMs: Date.now() - this._startTime,
      });
      if (this._itemPipeline && this._summary.itemsPushed > 0) {
        this._log.info("Processing items through pipeline", { steps: this._itemPipeline.steps().length, items: this._summary.itemsPushed });
      }
      if (this._lifecycle.onIdle) { this._lifecycle.onIdle(this); }
      if (this._lifecycle.onComplete) { this._lifecycle.onComplete(this._summary); }
      this._log.info("Crawl completed", { pages: this._summary.pagesFetched, items: this._summary.itemsPushed, failed: this._summary.requestsFailed, durationMs: this._summary.durationMs });
      return this._summary;
    } catch (err) {
      const metrics = (typeof this._runner?.getMetrics === "function") ? this._runner.getMetrics() : {};
      this._summary = {
        name: this._name,
        jobId: this._runner?.jobId ?? null,
        runDir: this._runner?.publicRunDir ?? null,
        datasetId: this._datasetStore?.datasetId ?? this._runner?.datasetStore?.datasetId ?? this._runner?.jobId ?? null,
        keyValueStoreId: this._kvStore?.storeId ?? this._runner?.keyValueStore?.storeId ?? this._runner?.jobId ?? null,
        systemKeyValueStoreId: this._runner?.keyValueStore?.storeId ?? this._runner?.jobId ?? null,
        pagesFetched: metrics.pagesFetched ?? 0,
        resultCount: metrics.resultCount ?? 0,
        skippedCount: metrics.skippedCount ?? 0,
        queuedCount: metrics.queuedCount ?? 0,
        queue: metrics.queue ?? null,
        autoscale: metrics.autoscale ?? null,
        itemsPushed: this._itemCount,
        requestsFailed: metrics.requestsFailed ?? 1,
        requestsRetried: metrics.requestsRetried ?? 0,
        durationMs: Date.now() - this._startTime,
      status: "failed",
      error: err.message,
      failedRequestCount: metrics.failedRequestCount ?? metrics.requestsFailed ?? 1,
    };
      if (this._lifecycle.onError) { this._lifecycle.onError(err); } else { this._log.error("Crawl failed", { error: err.message }); }
      throw err;
    } finally { this._running = false; }
  }

  async teardown() {
    this._log.info("Tearing down crawler", { name: this._name });
    try {
      if (this._runner) {
        if (typeof this._runner.stop === "function") { await this._runner.stop(); }
        this._runner = null;
      }
      if (this._mode === "browser" || this._mode === "hybrid") {
        await closeBrowser({ namespace: this._projectRoot }).catch(function() {});
      }
      if (this._rateLimiter) {
        this._rateLimiter.reset();
      }
      if (this._deduplicator) {
        this._deduplicator.reset();
      }
      if (this._exportManager && typeof this._exportManager.flush === 'function') {
        await this._exportManager.flush();
      }
      if (this._shutdown) {
      this._shutdown.registerJobPersistence(async () => {
        if (this._runner) {
          try { await this._runner.persistState(); } catch (e) {
            process.stderr.write("[omnicrawl] job persistence error: " + (e?.message ?? e) + "\n");
          }
        }
      });
        this._shutdown.uninstall();
        this._shutdown = null;
      }
      this._running = false;
      this._log.info("Teardown complete");
    } catch (err) {
      this._log.error("Teardown error", { error: err.message });
    }
  }

  get isRunning() { return this._running; }
  get reverseEngine() { return this._reverseEngine; }
  get name() { return this._name; }
  get lastSummary() { return this._summary; }
  get jobId() { return this._runner?.jobId ?? this._summary?.jobId ?? null; }
  get runDir() { return this._runner?.publicRunDir ?? this._summary?.runDir ?? null; }
  get datasetId() { return this._datasetStore?.datasetId ?? this._summary?.datasetId ?? this._runner?.datasetStore?.datasetId ?? this.jobId; }
  get keyValueStoreId() { return this._kvStore?.storeId ?? this._summary?.keyValueStoreId ?? this.jobId; }
  get systemKeyValueStoreId() { return this._runner?.keyValueStore?.storeId ?? this._summary?.systemKeyValueStoreId ?? this.jobId; }

  snapshot() {
    if (!this._runner) { return { status: "idle", name: this._name }; }
    const metrics = (typeof this._runner.getMetrics === "function") ? this._runner.getMetrics() : {};
    return {
      status: this._running ? "running" : "idle",
      name: this._name,
      jobId: this.jobId,
      runDir: this.runDir,
      datasetId: this.datasetId,
      keyValueStoreId: this.keyValueStoreId,
      systemKeyValueStoreId: this.systemKeyValueStoreId,
      itemsPushed: this._itemCount,
      failedRequestCount: metrics.failedRequestCount ?? undefined,
      ...metrics,
    };
  }

  async getDatasetInfo() {
    const datasetStore = this._datasetStore ?? this._runner?.datasetStore ?? null;
    if (!datasetStore) {
      return null;
    }
    if (typeof datasetStore.getInfo === 'function') {
      return datasetStore.getInfo();
    }
    return null;
  }

  async listItems(options = {}) {
    const datasetStore = this._datasetStore ?? this._runner?.datasetStore ?? null;
    if (!datasetStore) {
      throw new Error('Crawler dataset is not available before run() initializes stores');
    }
    if (typeof datasetStore.listItems !== 'function') {
      throw new Error('Dataset store does not support listItems()');
    }
    return datasetStore.listItems(options);
  }

  async getKeyValueInfo() {
    const keyValueStore = this._kvStore ?? this._runner?.keyValueStore ?? null;
    if (!keyValueStore) {
      return null;
    }
    if (typeof keyValueStore.getInfo === 'function') {
      return keyValueStore.getInfo();
    }
    return null;
  }

  async listRecords() {
    const keyValueStore = this._kvStore ?? this._runner?.keyValueStore ?? null;
    if (!keyValueStore) {
      throw new Error('Crawler key-value store is not available before run() initializes stores');
    }
    if (typeof keyValueStore.listRecords !== 'function') {
      throw new Error('Key-value store does not support listRecords()');
    }
    return keyValueStore.listRecords();
  }

  async getValue(key) {
    const keyValueStore = this._kvStore ?? this._runner?.keyValueStore ?? null;
    if (!keyValueStore) {
      throw new Error('Crawler key-value store is not available before run() initializes stores');
    }
    const record = await keyValueStore.getRecord(key);
    return record?.value ?? null;
  }

  async setValue(key, value, options = {}) {
    const keyValueStore = this._kvStore ?? this._runner?.keyValueStore ?? null;
    if (!keyValueStore) {
      throw new Error('Crawler key-value store is not available before run() initializes stores');
    }
    return keyValueStore.setRecord(key, value, options);
  }

  async listFailedRequests(options = {}) {
    const systemStore = this._runner?.keyValueStore ?? null;
    const record = systemStore ? await systemStore.getRecord('FAILED_REQUESTS') : null;
    const items = Array.isArray(record?.value) ? record.value : [];
    const query = String(options.query ?? '').trim().toLowerCase();
    const offset = Math.max(0, Number(options.offset ?? 0) || 0);
    const limit = Math.max(1, Number(options.limit ?? 50) || 50);
    const filtered = query
      ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(query))
      : items;

    return {
      total: filtered.length,
      offset,
      limit,
      items: filtered.slice(offset, offset + limit),
    };
  }

  async getReplayRecipe() {
    const systemStore = this._runner?.keyValueStore ?? null;
    const record = systemStore ? await systemStore.getRecord('REPLAY_RECIPE') : null;
    return record?.value ?? null;
  }

  async getReplayWorkflowTemplate() {
    const recipe = await this.getReplayRecipe();
    const workflow = this._runner?.workflow ?? null;
    if (!workflow) {
      return null;
    }
    return buildReplayWorkflowPatchTemplate({
      workflow,
      recipe: recipe ?? {},
    });
  }
}
