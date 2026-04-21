/**
 * OmniCrawl - Type declarations for the public API.
 *
 * These JSDoc-compatible .d.ts files provide TypeScript support
 * without requiring a full TS migration of the source code.
 */

// ─── Request & Response ───────────────────────────────────────────

export interface CrawlRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  proxy?: ProxyConfig;
  tlsProfile?: string;
  session?: SessionConfig;
  label?: string;
  depth?: number;
  parentUrl?: string | null;
  uniqueKey?: string | null;
  params?: Record<string, string>;
  userData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  replayState?: Record<string, unknown> | null;
  websocket?: Partial<WsRequest>;
}

export interface SeedRequest extends CrawlRequest {
  priority?: number;
}

export interface EnqueueRequest extends SeedRequest {}

export interface CrawlResponse {
  mode: 'http' | 'browser' | 'cheerio' | 'websocket';
  url: string;
  finalUrl: string;
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  sessionId: string | null;
  proxyServer: string | null;
  fetchedAt: string;
  replayState?: Record<string, unknown> | null;
  debug?: {
    requests?: Array<{
      url: string;
      method?: string;
      transport?: string | null;
      status?: number | null;
      mimeType?: string | null;
      responseHeaders?: Record<string, string>;
      encodedDataLength?: number | null;
    }>;
  } | null;
}

// ─── Proxy ─────────────────────────────────────────────────────────

export interface ProxyConfig {
  server: string;
  url?: string;
  username?: string;
  password?: string;
  region?: string;
  country?: string;
  city?: string;
  bypass?: string[];
  label?: string;
}

export interface ProxyPoolConfig {
  enabled?: boolean;
  strategy?: 'roundRobin' | 'stickySession' | 'healthiest';
  stickyBySession?: boolean;
  maxFailures?: number;
  cooldownMs?: number;
  retryOnStatuses?: number[];
  allowDirectFallback?: boolean;
  servers?: ProxyConfig[];
}

export interface ProxyProviderConfig {
  type: 'bright-data' | 'smartproxy' | 'oxylabs' | 'custom';
  endpoint: string;
  username: string;
  password: string;
  zone?: string;
  country?: string;
  city?: string;
  sessionDurationMinutes?: number;
}

// ─── Session ──────────────────────────────────────────────────────

export interface SessionConfig {
  enabled: boolean;
  id?: string;
  scope?: 'job' | 'custom';
  persist?: boolean;
  isolate?: boolean;
  captureStorage?: boolean;
  pool?: {
    enabled?: boolean;
    id?: string;
    maxSessions?: number;
    maxFailures?: number;
    retireAfterUses?: number;
    bindProxy?: boolean;
    strategy?: 'leastUsed' | 'roundRobin';
  };
}

export interface IdentityConfig {
  enabled?: boolean;
  bundleId?: string;
  userAgent?: string;
  acceptLanguage?: string;
  locale?: string;
  languages?: string[];
  timezoneId?: string;
  platform?: string;
  vendor?: string;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  maxTouchPoints?: number;
  webglVendor?: string;
  webglRenderer?: string;
  canvasNoise?: number;
  audioNoise?: number;
  proxyRegion?: string;
  proxyCountry?: string;
  proxyCity?: string;
  fonts?: string[];
  clientHints?: Record<string, string>;
  geolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  tlsProfile?: string;
  h2Profile?: unknown;
  consistency?: {
    httpHeaders?: boolean;
    browserProfile?: boolean;
    bindProxyRegion?: boolean;
    driftDetection?: boolean;
    autoCorrect?: boolean;
  };
}

export interface SignerRegressionCase {
  name: string;
  params?: Record<string, unknown>;
  equals?: unknown;
  matches?: string;
  exists?: boolean;
}

export interface SignerConfig {
  enabled?: boolean;
  assetId?: string;
  source?: 'auto' | 'artifact' | 'inline' | 'rpc';
  functionName?: string;
  paramName?: string;
  maxCandidates?: number;
  minScore?: number;
  capture?: {
    enabled?: boolean;
    sources?: Array<'responseBody' | 'debugScripts'>;
    maxScripts?: number;
  };
  inject?: {
    enabled?: boolean;
    mode?: 'artifact' | 'rpc' | 'value';
    location?: 'header' | 'query' | 'body' | 'cookie';
    name?: string;
    rpcUrl?: string;
    template?: string;
    params?: Record<string, string>;
  };
  regression?: {
    enabled?: boolean;
    cases?: SignerRegressionCase[];
  };
}

export interface ReverseConfig {
  enabled?: boolean;
  autoReverseAnalysis?: boolean;
  cloudflare?: boolean | Record<string, unknown>;
  captcha?: {
    provider?: string;
    service?: string;
    apiKey?: string;
    maxWaitMs?: number;
    [key: string]: unknown;
  } | null;
  behaviorSimulation?: boolean | Record<string, unknown>;
  challenge?: {
    enabled?: boolean;
    statuses?: number[];
    bodyPatterns?: string[];
    maxSolveAttempts?: number;
    retryOnSolved?: boolean;
    retryOnFailed?: boolean;
    retryDelayMs?: number;
    sessionAction?: 'retain' | 'reportFailure' | 'retire';
    proxyAction?: 'retain' | 'reportFailure' | 'cooldown';
    attribution?: 'challenge' | 'session' | 'proxy' | 'signer' | 'identity';
    validate?: {
      enabled?: boolean;
      successCookieNames?: string[];
      absencePatterns?: string[];
    };
  };
  app?: {
    enabled?: boolean;
    platform?: 'android' | 'ios' | 'miniapp' | 'webview';
    frida?: {
      enabled?: boolean;
      deviceId?: string;
      bundleId?: string;
      scriptPath?: string;
      exec?: {
        command: string;
        args?: string[];
        shell?: boolean;
      };
    };
    mitmproxy?: {
      enabled?: boolean;
      dumpPath?: string;
      mode?: string;
      addonPath?: string;
      exec?: {
        command: string;
        args?: string[];
        shell?: boolean;
      };
    };
    protobuf?: {
      enabled?: boolean;
      descriptorPaths?: string[];
    };
    grpc?: {
      enabled?: boolean;
      services?: Record<string, unknown>;
    };
    websocket?: {
      captureBinary?: boolean;
    };
    sslPinning?: {
      enabled?: boolean;
      mode?: 'advisory' | 'external';
    };
  };
  assets?: {
    enabled?: boolean;
    storageDir?: string;
    persistArtifacts?: boolean;
    captureSignerFromResponse?: boolean;
  };
  regression?: {
    enabled?: boolean;
    requestContracts?: Array<{
      name: string;
      urlPattern?: string;
      finalUrlPattern?: string;
      method?: string;
      transport?: 'document' | 'fetch' | 'xhr' | 'websocket' | 'other';
      status?: number;
      requestHeaderNames?: string[];
      responseHeaderNames?: string[];
      requestBodyPattern?: string;
      responseBodyPattern?: string;
      minMatches?: number;
      maxMatches?: number;
    }>;
    challenge?: {
      enabled?: boolean;
      maxDetected?: number;
      requireSolved?: boolean;
    };
    identity?: {
      enabled?: boolean;
      allowDriftFields?: string[];
    };
    antiBot?: {
      enabled?: boolean;
      maxChallengeLikely?: number;
      maxBlocked?: number;
    };
  };
}

// ─── Workflow ──────────────────────────────────────────────────────

export interface WorkflowConfig {
  name: string;
  seedUrls: string[];
  seedRequests?: SeedRequest[];
  mode: 'http' | 'browser' | 'cheerio' | 'hybrid';
  concurrency: number;
  maxDepth: number;
  timeoutMs: number;
  headers?: Record<string, string>;
  identity?: IdentityConfig;
  reverse?: ReverseConfig;
  signer?: SignerConfig;
  proxy?: ProxyConfig;
  proxyPool?: ProxyPoolConfig;
  browser?: BrowserConfig;
  session?: SessionConfig;
  retry?: RetryConfig;
  export?: ExportConfig;
  autoscale?: AutoscaleConfig;
  requestQueue?: RequestQueueConfig;
  discovery?: DiscoveryConfig;
  extract?: ExtractRule[];
  crawlPolicy?: CrawlPolicyConfig;
  rateLimiter?: RateLimiterConfig;
  websocket?: Partial<WsRequest>;
  observability?: ObservabilityConfig;
  output?: OutputConfig;
  plugins?: PluginConfig[];
}

export interface BrowserConfig {
  engine?: string;
  headless?: boolean;
  timeoutMs?: number;
  waitForSelector?: string;
  sleepMs?: number;
  viewport?: { width: number; height: number };
  userAgent?: string;
  executablePath?: string;
  launchArgs?: string[];
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  debug?: {
    enabled?: boolean;
    captureScripts?: boolean;
    captureNetwork?: boolean;
    captureSourceMaps?: boolean;
    captureHooks?: boolean;
    persistArtifacts?: boolean;
    har?: {
      enabled?: boolean;
      includeBodies?: boolean;
    };
    tracing?: {
      enabled?: boolean;
      screenshots?: boolean;
      snapshots?: boolean;
      sources?: boolean;
    };
  };
  replay?: {
    initScripts?: string[];
    finalUrl?: string;
    finalMethod?: string;
    finalBody?: string;
    storageSeeds?: Array<{
      area?: 'localStorage' | 'sessionStorage';
      key: string;
      value: string;
    }>;
    blockResourceTypes?: Array<'document' | 'stylesheet' | 'image' | 'media' | 'font' | 'script' | 'xhr' | 'fetch' | 'websocket' | 'manifest' | 'other'>;
    blockUrlPatterns?: string[];
    cookies?: Array<{
      name: string;
      value: string;
      domain?: string;
      url?: string;
      path?: string;
      expires?: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: 'Strict' | 'Lax' | 'None';
    }>;
    steps?: Array<{
      type: 'navigate' | 'waitForSelector' | 'extractState' | 'setHeader' | 'click' | 'type' | 'press' | 'select' | 'scroll' | 'waitForResponse' | 'extractResponseBody' | 'assert' | 'branch' | 'goto' | 'wait';
      label?: string;
      url?: string;
      target?: string;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
      timeoutMs?: number;
      durationMs?: number;
      selector?: string;
      visible?: boolean;
      shadowHostSelector?: string;
      frameUrlPattern?: string;
      frameSelector?: string;
      waitForNavigation?: boolean;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      delayMs?: number;
      clear?: boolean;
      keyPress?: string;
      optionLabel?: string;
      optionIndex?: number;
      x?: number;
      y?: number;
      to?: 'top' | 'bottom';
      repeat?: number;
      retries?: number;
      retryDelayMs?: number;
      onErrorGoto?: string;
      errorSaveAs?: string;
      source?: 'cookie' | 'localStorage' | 'sessionStorage' | 'text' | 'html' | 'attribute';
      key?: string;
      attribute?: string;
      saveAs?: string;
      name?: string;
      value?: string;
      state?: string;
      equals?: unknown;
      notEquals?: unknown;
      exists?: boolean;
      matches?: string;
      message?: string;
      urlPattern?: string;
      method?: string;
      status?: number;
      resourceType?: 'document' | 'stylesheet' | 'image' | 'media' | 'font' | 'script' | 'xhr' | 'fetch' | 'websocket' | 'manifest' | 'other';
      onMatchGoto?: string;
      cases?: Array<{
        state?: string;
        equals?: unknown;
        notEquals?: unknown;
        exists?: boolean;
        matches?: string;
        goto: string;
      }>;
      defaultGoto?: string;
      from?: string;
      format?: 'text' | 'json';
      path?: string;
    }>;
  };
  pool?: {
    maxBrowsers?: number;
    closeIdleMs?: number;
  };
}

export interface RetryConfig {
  attempts?: number;
  backoffMs?: number;
  strategy?: 'fixed' | 'exponential';
  maxBackoffMs?: number;
  jitterRatio?: number;
  respectRetryAfter?: boolean;
  retryOnStatuses?: number[];
  groupBackoff?: GroupBackoffConfig;
}

export interface GroupBackoffConfig {
  enabled?: boolean;
  groupBy?: 'hostname' | 'origin' | 'registrableDomain';
  baseDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  respectRetryAfter?: boolean;
  resetOnSuccess?: boolean;
  onNetworkError?: boolean;
  statusCodes?: number[];
}

export interface AutoscaleConfig {
  targetLatencyMs?: number;
  maxFailureRate?: number;
  scaleUpStep?: number;
  scaleDownStep?: number;
  minConcurrency?: number;
  maxConcurrency?: number;
  sampleWindow?: number;
}

export interface RequestQueueConfig {
  sortQueryParams?: boolean;
  stripHash?: boolean;
  stripTrailingSlash?: boolean;
  dropQueryParams?: string[];
  dropQueryParamPatterns?: string[];
  includeMethodInUniqueKey?: boolean;
  includeBodyInUniqueKey?: boolean;
  reclaimInProgress?: boolean;
  hostAwareScheduling?: boolean;
  groupBy?: 'hostname' | 'origin' | 'registrableDomain';
  maxInProgressPerGroup?: number;
  maxInProgressPerHost?: number;
  budgetWindowMs?: number;
  maxRequestsPerWindow?: number;
  seenSet?: {
    enabled?: boolean;
    scope?: 'workflow' | 'custom';
    id?: string;
    ttlMs?: number;
    maxEntries?: number;
  };
  priority?: {
    seed?: number;
    sitemap?: number;
    discovery?: number;
    depthPenalty?: number;
  };
}

export interface DiscoveryConfig {
  enabled?: boolean;
  sameOriginOnly?: boolean;
  respectNoFollow?: boolean;
  maxPages?: number;
  maxLinksPerPage?: number;
  skipFileExtensions?: string[];
  include?: string[];
  exclude?: string[];
  strategy?: DiscoveryStrategy;
  rules?: DiscoveryRule[];
  extractor?: ExtractRule;
}

export interface DiscoveryStrategy {
  classify?: boolean;
  enqueuePagination?: boolean;
  enqueueCanonical?: boolean;
  enqueueAlternateLanguages?: boolean;
  skipLogout?: boolean;
  skipAssetLinks?: boolean;
  lanes?: Record<string, DiscoveryLaneConfig>;
}

export interface DiscoveryLaneConfig {
  maxInProgress?: number;
  budgetWindowMs?: number;
  maxRequestsPerWindow?: number;
}

export interface ExtractRule {
  type: 'regex' | 'json' | 'script' | 'selector' | 'links' | 'surface' | 'reverse' | 'xpath' | 'media';
  name: string;
  format?: 'url' | 'object';
  path?: string;
  xpath?: string;
  selector?: string;
  pattern?: string;
  flags?: string;
  attribute?: string;
  all?: boolean;
  code?: string;
  mode?: 'auto' | 'script' | 'html';
  operation?: string;
  functionName?: string;
  args?: unknown[];
  expression?: string;
  language?: string;
  languages?: string[];
  options?: Record<string, unknown>;
  xml?: boolean;
  kinds?: Array<'image' | 'video' | 'audio'>;
  includeDom?: boolean;
  includeMeta?: boolean;
  includeJsonLd?: boolean;
  includeNetwork?: boolean;
  includeResponse?: boolean;
  maxItems?: number;
}

export interface MediaAsset {
  url: string;
  kind: 'image' | 'video' | 'audio';
  source: 'response' | 'dom' | 'meta' | 'jsonld' | 'network';
  pageUrl?: string | null;
  tagName?: string | null;
  attribute?: string | null;
  mimeType?: string | null;
  title?: string | null;
  alt?: string | null;
  poster?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface MediaExtractionOptions {
  includeCombined?: boolean;
  includeImages?: boolean;
  includeVideos?: boolean;
  includeAudio?: boolean;
  includeDom?: boolean;
  includeMeta?: boolean;
  includeJsonLd?: boolean;
  includeNetwork?: boolean;
  fieldNames?: Partial<Record<'media' | 'images' | 'videos' | 'audio', string>>;
  format?: 'url' | 'object';
  maxItems?: number;
  maxNetworkRequests?: number;
}

export interface MediaDownloadOptions {
  enabled?: boolean;
  outputDir?: string;
  fields?: string[];
  organizeByKind?: boolean;
  skipExisting?: boolean;
  timeoutMs?: number;
  concurrency?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
  headers?: Record<string, string>;
  maxBytes?: number;
  maxItems?: number;
  includeNetwork?: boolean;
  manifestPath?: string;
  failuresPath?: string;
  mediaInclude?: Array<string | RegExp>;
  mediaExclude?: Array<string | RegExp>;
  subdirTemplate?: string;
  fileNameTemplate?: string;
}

export interface MediaDownloadRecord {
  ok: boolean;
  url: string;
  finalUrl: string | null;
  path: string | null;
  fileName: string | null;
  kind: 'image' | 'video' | 'audio' | null;
  source: string | null;
  title?: string | null;
  pageUrl?: string | null;
  bytes: number;
  contentType: string | null;
  status: number | null;
  downloadedAt: string;
  attempts?: number;
  error?: string;
  skipped?: boolean;
  streaming?: {
    type: 'hls' | 'dash';
    manifestUrl: string;
    segmentCount: number;
  };
}

export interface MediaDownloadSummary {
  total: number;
  downloaded: number;
  failed: number;
  items: MediaDownloadRecord[];
  outputDir: string;
}

export interface DiscoveryRule {
  pattern: string;
  action?: 'enqueue' | 'skip';
  priority?: number;
  label?: string;
  userData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CrawlPolicyConfig {
  robotsTxt?: {
    enabled?: boolean;
    userAgent?: string;
    respectCrawlDelay?: boolean;
    maxCrawlDelayMs?: number;
    allowOnError?: boolean;
    seedSitemaps?: boolean;
    maxSitemaps?: number;
    maxUrlsPerSitemap?: number;
    timeoutMs?: number;
  };
}

export interface RateLimiterConfig {
  enabled?: boolean;
  requestsPerSecond?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  burstSize?: number;
  maxConcurrent?: number;
  domainOverrides?: Record<string, number>;
  autoThrottle?: AutoThrottleConfig;
}

export interface AutoThrottleConfig {
  enabled?: boolean;
  minRequestsPerSecond?: number;
  maxRequestsPerSecond?: number;
  targetLatencyMs?: number;
  errorRateThreshold?: number;
  scaleDownFactor?: number;
  scaleUpStep?: number;
  smoothing?: number;
  cooldownMs?: number;
}

export interface OutputConfig {
  dir?: string;
  directory?: string;
  console?: boolean;
  persistBodies?: boolean;
}

export interface ExportConfig {
  enabled?: boolean;
  outputs?: ExportOutputConfig[];
}

export interface ExportOutputConfig {
  kind?: 'results' | 'events' | 'summary';
  backend?: 'file' | 'stdout' | 'http' | 'postgres' | 'mysql' | 'mongodb' | 'sink';
  format?: 'csv' | 'json' | 'jsonl' | 'ndjson';
  path?: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  timeoutMs?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
  table?: string;
  database?: string;
  collection?: string;
  jsonColumn?: string;
  metadataColumn?: string;
  batchSize?: number;
  ordered?: boolean;
  signingSecret?: string;
  signatureHeader?: string;
  signatureAlgorithm?: 'sha1' | 'sha256' | 'sha512';
  flatten?: boolean;
  columns?: string[];
  indent?: number;
  query?: string;
  limit?: number;
}

export interface PluginConfig {
  name: string;
  options?: Record<string, unknown>;
  path?: string;
  exportName?: string;
}

// ─── Fingerprint ───────────────────────────────────────────────────

export interface FingerprintConfig {
  sortQueryParams?: boolean;
  removeTrailingSlash?: boolean;
  lowercaseHostname?: boolean;
  removeFragment?: boolean;
  ignoreParams?: string[];
  normalizeProtocol?: boolean;
  removeDefaultPort?: boolean;
  hashAlgorithm?: string;
}

// ─── Crawl Result ──────────────────────────────────────────────────

export interface CrawlResult {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  mode: string;
  sessionId?: string | null;
  proxyServer?: string | null;
  proxyLabel?: string | null;
  identity?: unknown;
  diagnostics?: unknown;
  extracted?: Record<string, unknown>;
  replayState?: Record<string, unknown> | null;
  metadata?: PageMetadata;
  links?: string[];
  durationMs?: number;
  error?: string;
}

export interface PageMetadata {
  title: string | null;
  description: string | null;
  canonical: string | null;
  lang: string | null;
  ogTitle: string | null;
  ogImage: string | null;
}

// ─── Crawl Summary ─────────────────────────────────────────────────

export interface CrawlSummary {
  name: string;
  pagesFetched: number;
  itemsPushed: number;
  requestsFailed: number;
  failedRequestCount?: number;
  requestsRetried: number;
  durationMs: number;
  status: 'completed' | 'failed' | 'cancelled';
  jobId?: string | null;
  runDir?: string | null;
  datasetId?: string | null;
  keyValueStoreId?: string | null;
  systemKeyValueStoreId?: string | null;
  resultCount?: number;
  skippedCount?: number;
  queuedCount?: number;
  queue?: unknown;
  autoscale?: unknown;
  frontier?: unknown;
  changeTracking?: unknown;
  crawlPolicy?: unknown;
  rateLimiter?: unknown;
  observability?: unknown;
  httpCache?: unknown;
  diagnostics?: unknown;
  quality?: unknown;
  baseline?: unknown;
  trend?: unknown;
  alertDelivery?: unknown;
  exports?: unknown[];
  error?: string;
}

// ─── Programmatic API ──────────────────────────────────────────────

export interface CrawlSnapshot {
  status: 'idle' | 'running';
  name: string;
  jobId?: string | null;
  runDir?: string | null;
  datasetId?: string | null;
  keyValueStoreId?: string | null;
  systemKeyValueStoreId?: string | null;
  itemsPushed?: number;
  pagesFetched?: number;
  resultCount?: number;
  requestsFailed?: number;
  failedRequestCount?: number;
  requestsRetried?: number;
  skippedCount?: number;
  queuedCount?: number;
  queue?: unknown;
  autoscale?: unknown;
}

export interface CrawlContext {
  request: CrawlRequest;
  response: CrawlResponse;
  extracted: Record<string, unknown>;
  log: {
    info(message: string, payload?: Record<string, unknown>): void;
    warn(message: string, payload?: Record<string, unknown>): void;
    error(message: string, payload?: Record<string, unknown>): void;
    debug(message: string, payload?: Record<string, unknown>): void;
  };
  body: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  params: Record<string, string>;
  label: string | null;
  enqueue(url: string | EnqueueRequest, options?: { depth?: number; userData?: Record<string, unknown>; label?: string; metadata?: Record<string, unknown> }): Promise<boolean>;
  enqueueLinks(urls: Array<string | EnqueueRequest>, options?: { depth?: number; userData?: Record<string, unknown>; label?: string; metadata?: Record<string, unknown> }): Promise<number>;
  enqueueExtractedLinks(source?: string | Array<string | EnqueueRequest>, options?: { depth?: number; userData?: Record<string, unknown>; label?: string; metadata?: Record<string, unknown> }): Promise<number>;
  pushData(item: Record<string, unknown>): Promise<void>;
  drainItems(pipeline?: ItemPipeline): Promise<Record<string, unknown>[]>;
  inputValue(key: string): Promise<unknown>;
  setValue(key: string, value: unknown): Promise<void>;
  snapshot(): CrawlSnapshot;
  reverseEngine: unknown | null;
  analyzeJS(code: string, options?: Record<string, unknown>): Promise<unknown>;
  analyzeCrypto(code: string, options?: Record<string, unknown>): Promise<unknown>;
  analyzeWebpack(code: string, options?: Record<string, unknown>): Promise<unknown>;
  locateSignature(code: string, options?: Record<string, unknown>): Promise<unknown>;
  summarizeWorkflow(html?: string, options?: Record<string, unknown>): Promise<unknown>;
  analyzeAISurface(payload?: Record<string, unknown>): Promise<AiSurfaceAnalysisResult>;
  runReverseOperation(operation: string, payload?: Record<string, unknown>): Promise<unknown>;
  simulateHumanBehavior(options?: Record<string, unknown>): Promise<void>;
  generateHookCode(options?: Record<string, unknown>): string;
  page: unknown | null;
}

export type RouteHandler = (ctx: CrawlContext) => Promise<void> | void;

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
  label: string | null;
}

export interface LifecycleCallbacks {
  onReady?: (crawler: OmniCrawler) => void;
  onIdle?: (crawler: OmniCrawler) => void;
  onComplete?: (summary: CrawlSummary) => void;
  onError?: (error: Error) => void;
  onFailedRequest?: (ctx: FailedRequestContext) => void;
}

export interface RouteMiddleware {
  beforeRequest?: RouteHandler;
  afterResponse?: RouteHandler;
  onError?: (ctx: CrawlContext, error: Error) => Promise<void> | void;
}

export interface RuntimeMiddleware extends Partial<Pick<OmniPlugin, 'beforeEnqueue' | 'beforeRequest' | 'afterResponse' | 'afterExtract' | 'afterFetch' | 'beforeNavigation' | 'afterNavigation' | 'onError' | 'onFailedRequest' | 'onJobStart' | 'onJobComplete'>> {}

export interface MiddlewareConfig extends RouteMiddleware {
  route?: RouteMiddleware;
  runtime?: RuntimeMiddleware;
}

export interface OmniCrawlerConfig {
  name?: string;
  mode?: 'http' | 'browser' | 'cheerio' | 'hybrid';
  concurrency?: number;
  maxDepth?: number;
  timeoutMs?: number;
  projectRoot?: string;
  headers?: Record<string, string>;
  identity?: IdentityConfig;
  reverse?: ReverseConfig;
  signer?: SignerConfig;
}

export type PipelineStep = (item: Record<string, unknown>, ctx: CrawlContext) => Promise<Record<string, unknown> | null | undefined> | Record<string, unknown> | null | undefined;

export interface PipelineResult {
  item: Record<string, unknown> | null;
  dropped: boolean;
  error: Error | null;
}

export interface PipelineStats {
  steps: number;
  processed: number;
  dropped: number;
  errors: number;
}

export class Router {
  constructor();
  addHandler(pattern: string | RegExp, handler: RouteHandler, options?: { label?: string }): this;
  addDefaultHandler(handler: RouteHandler): this;
  getHandlerByLabel(label: string): RouteHandler | null;
  resolve(url: string, label?: string | null): RouteMatch | null;
  labels(): string[];
  hasLabel(label: string): boolean;
}

export class ItemPipeline {
  constructor();
  addStep(step: PipelineStep): this;
  process(item: Record<string, unknown>, ctx: CrawlContext): Promise<PipelineResult>;
  stats(): PipelineStats;
  steps(): PipelineStep[];
  reset(): void;
}

export class GracefulShutdown {
  constructor(options?: { timeoutMs?: number; install?: boolean });
  readonly isShuttingDown: boolean;
  register(callback: () => Promise<void> | void): this;
  install(): void;
  uninstall(): void;
  shutdown(): Promise<void>;
}

export class OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
  readonly isRunning: boolean;
  readonly reverseEngine: unknown;
  readonly name: string;
  readonly lastSummary: CrawlSummary | null;
  readonly jobId: string | null;
  readonly runDir: string | null;
  readonly datasetId: string | null;
  readonly keyValueStoreId: string | null;
  readonly systemKeyValueStoreId: string | null;
  addSeedUrls(urls: string | SeedRequest | Array<string | SeedRequest>): this;
  addRequests(requests: SeedRequest | Array<SeedRequest | string>): this;
  setMode(mode: 'http' | 'browser' | 'cheerio' | 'hybrid'): this;
  setConcurrency(n: number): this;
  setMaxDepth(n: number): this;
  setTimeout(ms: number): this;
  setHeaders(headers: Record<string, string>): this;
  setProjectRoot(dir: string): this;
  useRouter(router: Router): this;
  useItemPipeline(pipeline: ItemPipeline): this;
  useMiddleware(middleware: MiddlewareConfig): this;
  usePlugin(plugin: OmniPlugin | ((options?: Record<string, unknown>, context?: { crawler: OmniCrawler; runner: unknown; logger: CrawlContext['log'] }) => Promise<OmniPlugin> | OmniPlugin), options?: Record<string, unknown>): this;
  useProxy(proxy: string | ProxyConfig): this;
  useRateLimiter(config: RateLimiterConfig): this;
  useDeduplicator(config: FingerprintConfig | Record<string, unknown>): this;
  useExport(config: ExportConfig): this;
  useProxyPool(config: ProxyPoolConfig): this;
  onReady(fn: NonNullable<LifecycleCallbacks['onReady']>): this;
  onIdle(fn: NonNullable<LifecycleCallbacks['onIdle']>): this;
  onComplete(fn: NonNullable<LifecycleCallbacks['onComplete']>): this;
  onError(fn: NonNullable<LifecycleCallbacks['onError']>): this;
  onFailedRequest(fn: NonNullable<LifecycleCallbacks['onFailedRequest']>): this;
  gracefulShutdown(options?: { timeoutMs?: number }): this;
  setBrowserOptions(config: BrowserConfig): this;
  setSessionOptions(config: SessionConfig): this;
  setRetryOptions(config: RetryConfig): this;
  setAutoscaleOptions(config: AutoscaleConfig): this;
  setRequestQueueOptions(config: RequestQueueConfig): this;
  setDiscovery(config: DiscoveryConfig): this;
  setExtractRules(config: ExtractRule[]): this;
  useMediaExtraction(options?: MediaExtractionOptions): this;
  useMediaDownload(options?: MediaDownloadOptions): this;
  setCrawlPolicy(config: CrawlPolicyConfig): this;
  setIdentity(config: IdentityConfig): this;
  setSigner(config: SignerConfig): this;
  setReverseRuntime(config: ReverseConfig): this;
  useStealth(options?: Record<string, unknown>): this;
  useCloudflareSolver(options?: Record<string, unknown>): this;
  useCaptchaSolver(provider: string, apiKey: string, options?: Record<string, unknown>): this;
  useBehaviorSimulation(options?: Record<string, unknown>): this;
  useAppWebView(appType: 'wechat' | 'douyin' | 'taobao' | 'jd' | 'android' | 'ios', options?: Record<string, unknown>): this;
  useReverseAnalysis(options?: Record<string, unknown>): this;
  useTlsProfile(profileName: string): this;
  useH2Profile(profile: Record<string, unknown>): this;
  useReverse(config: Record<string, unknown>): this;
  run(): Promise<CrawlSummary>;
  teardown(): Promise<void>;
  snapshot(): CrawlSnapshot;
  getDatasetInfo(): Promise<DatasetInfo | null>;
  listItems(options?: { offset?: number; limit?: number; query?: string }): Promise<ListItemsResult>;
  getKeyValueInfo(): Promise<KeyValueStoreInfo | null>;
  listRecords(): Promise<KeyValueRecord[]>;
  getValue(key: string): Promise<unknown>;
  setValue(key: string, value: unknown, options?: { contentType?: string }): Promise<KeyValueRecord>;
  listFailedRequests(options?: { offset?: number; limit?: number; query?: string }): Promise<ListItemsResult & { items: FailedRequestRecord[] }>;
  getReplayRecipe(): Promise<ReplayRecipe | null>;
  getReplayWorkflowTemplate(): Promise<ReplayWorkflowTemplate | null>;
}

export class HttpCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
}

export class CheerioCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
}

export class BrowserCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
}

export class HybridCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
}

export class MediaCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig & { includeNetwork?: boolean; maxMediaItems?: number });
}

export class JSDOMCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
  setXPathRules(rules?: ExtractRule[]): this;
  setXPathMap(fieldMap?: Record<string, string>, options?: Partial<ExtractRule>): this;
}

export class ApiJsonCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
  setJsonPathMap(fieldMap?: Record<string, string>): this;
}

export class FeedCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
  useFeedExtraction(overrides?: Record<string, string>): this;
}

export class SitemapCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
  useSitemapExtraction(options?: { includeChildSitemaps?: boolean }): this;
}

export class GraphQLCrawler extends ApiJsonCrawler {
  constructor(config?: OmniCrawlerConfig);
  detectEndpoints(source: string, baseUrl: string): string[];
  execute(options: GraphQLOptions): Promise<GraphQLResult>;
  introspect(endpoint: string, options?: Partial<GraphQLOptions>): Promise<GraphQLSchema | null>;
  fetchAllPages(options: {
    endpoint: string;
    query: string;
    variables?: Record<string, unknown>;
    maxPages?: number;
    headers?: Record<string, string>;
  }): Promise<{ pages: unknown[]; cursors: string[] }>;
}

export class WebSocketCrawler extends HttpCrawler {
  constructor(config?: OmniCrawlerConfig);
  setWebSocketOptions(options?: Partial<WsRequest>): this;
  connect(options: WsRequest): Promise<WsResponse>;
  subscribe(url: string, subscribeMessage: string | object, options?: Partial<WsRequest>): Promise<WsMessage[]>;
}

export class PuppeteerCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
}

export class PuppeteerCoreCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
}

export class PlaywrightCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
}

export class PlaywrightCoreCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
}

export class PatchrightCrawler extends OmniCrawler {
  constructor(config?: OmniCrawlerConfig);
}

export declare function extractMediaAssets(response: CrawlResponse, rule?: ExtractRule): Array<MediaAsset | string>;
export declare function buildMediaExtractRules(options?: MediaExtractionOptions): ExtractRule[];
export declare function downloadMediaAsset(asset: MediaAsset | string, options?: MediaDownloadOptions & { index?: number }): Promise<MediaDownloadRecord>;
export declare function downloadMediaAssets(assets: Array<MediaAsset | string>, options?: MediaDownloadOptions): Promise<MediaDownloadSummary>;
export declare function collectMediaAssetsFromResult(result: CrawlResult, fields?: string[]): MediaAsset[];
export declare function filterMediaAssets(assets: Array<MediaAsset | string>, options?: MediaDownloadOptions): MediaAsset[];
export declare function readMediaDownloadManifest(manifestPath: string): Promise<MediaDownloadRecord[]>;
export declare function collectFailedMediaDownloads(records?: MediaDownloadRecord[]): MediaAsset[];
export declare function retryFailedMediaDownloads(manifestPath: string, options?: MediaDownloadOptions): Promise<MediaDownloadSummary>;

// ─── Store Interfaces ──────────────────────────────────────────────

export interface StoreConfig {
  projectRoot?: string;
}

export interface DatasetConfig extends StoreConfig {
  datasetId: string;
  metadata?: Record<string, unknown>;
}

export interface ListItemsResult {
  total: number;
  offset: number;
  limit: number;
  items: Record<string, unknown>[];
}

export interface DatasetInfo {
  id: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  metadata?: Record<string, unknown>;
}

export interface KeyValueRecord {
  key: string;
  fileName: string;
  contentType: string;
  bytes: number;
  updatedAt: string;
  value?: unknown;
}

export interface KeyValueStoreInfo {
  id: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  recordCount: number;
  records?: KeyValueRecord[];
}

// ─── Export ────────────────────────────────────────────────────────

export interface ExportOptions {
  datasetId: string;
  outputPath: string;
  headers?: string[];
  flatten?: boolean;
  limit?: number;
  query?: string;
  indent?: number;
}

export interface ExportResult {
  format: string;
  path: string;
  itemCount: number;
  bytes: number;
}

// ─── Observability ─────────────────────────────────────────────────

export interface TracingConfig {
  enabled: boolean;
  serviceName?: string;
  endpoint?: string;
  sampleRate?: number;
  provider?: unknown;
  tracer?: unknown;
}

export interface MetricsConfig {
  enabled: boolean;
  port?: number;
  prefix?: string;
  defaultLabels?: Record<string, string>;
  provider?: unknown;
  meter?: unknown;
}

export interface ObservabilityConfig {
  tracing?: TracingConfig;
  metrics?: MetricsConfig;
}

// ─── Plugin Ecosystem ──────────────────────────────────────────────

export interface OmniPlugin {
  name: string;
  version?: string;
  description?: string;
  beforeEnqueue?: (ctx: HookContext) => Promise<HookResult | void>;
  beforeRequest?: (ctx: HookContext) => Promise<HookResult | void>;
  afterResponse?: (ctx: HookContext) => Promise<HookResult | void>;
  afterExtract?: (ctx: HookContext) => Promise<HookResult | void>;
  afterFetch?: (ctx: HookContext) => Promise<HookResult | void>;
  beforeNavigation?: (ctx: HookContext) => Promise<HookResult | void>;
  afterNavigation?: (ctx: HookContext) => Promise<HookResult | void>;
  onError?: (ctx: HookContext) => Promise<HookResult | void>;
  onFailedRequest?: (ctx: HookContext) => Promise<HookResult | void>;
  onJobStart?: (ctx: HookContext) => Promise<HookResult | void>;
  onJobComplete?: (ctx: HookContext) => Promise<HookResult | void>;
}

export interface HookContext {
  item?: CrawlRequest;
  request?: CrawlRequest;
  response?: CrawlResponse;
  result?: CrawlResult;
  extracted?: Record<string, unknown>;
  error?: Error;
  attempt?: number;
  page?: unknown;
  runner?: unknown;
  state?: Record<string, unknown>;
}

export interface FailedRequestContext {
  attempt: number;
  error: Error;
  item: CrawlRequest | null;
  request: CrawlRequest;
  response: CrawlResponse | null;
  runner?: unknown;
}

export interface FailedRequestRecord {
  url: string | null;
  method: string;
  depth: number;
  parentUrl: string | null;
  uniqueKey: string | null;
  label: string | null;
  userData: Record<string, unknown>;
  metadata: Record<string, unknown>;
  proxyServer: string | null;
  sessionId: string | null;
  status: number | null;
  finalUrl: string | null;
  attempt: number;
  error: string;
  failedAt: string;
}

export interface ReplayRecipe {
  version: number;
  recommendedMode: 'http' | 'browser' | 'hybrid';
  rationale: string[];
  prerequisites: string[];
  identity: Record<string, unknown> | null;
  capture: Record<string, unknown> | null;
  steps: Array<Record<string, unknown>>;
  recovery: Array<Record<string, unknown>>;
  generatedFrom: Record<string, unknown> | null;
}

export interface ReplayWorkflowTemplate {
  version: number;
  targetUrl: string | null;
  recommendedMode: 'http' | 'browser' | 'hybrid';
  patch: Record<string, unknown>;
  hints: {
    topEndpoints: string[];
    tokenLikeStorageKeys: string[];
    cookieNames: string[];
    instructions: string[];
  };
}

export interface HookResult {
  skip?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface PluginRegistryEntry {
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  factory: () => OmniPlugin | Promise<OmniPlugin>;
}


// ─── XPath Extractor ──────────────────────────────────────────────

export interface XPathRule {
  type: 'xpath';
  name: string;
  expression: string;
  all?: boolean;
  attribute?: string;
  maxItems?: number;
  xml?: boolean;
}

export declare function evaluateXPath(body: string, rule: XPathRule): string | string[] | null;

// ─── Bloom Filter ─────────────────────────────────────────────────

export declare class BloomFilter {
  bitSize: number;
  hashCount: number;
  count: number;
  constructor(options?: { capacity?: number; errorRate?: number; hashCount?: number; bitSize?: number });
  add(item: string): void;
  has(item: string): boolean;
  clear(): void;
  get falsePositiveRate(): number;
  get byteSize(): number;
  toJSON(): { bitSize: number; hashCount: number; count: number; bits: string };
  static fromJSON(data: { bitSize: number; hashCount: number; count: number; bits: string }): BloomFilter;
}

export declare class BloomDeduplicator {
  filter: BloomFilter;
  constructor(options?: { capacity?: number; errorRate?: number });
  isDuplicate(uniqueKey: string): boolean;
  get stats(): { count: number; byteSize: number; falsePositiveRate: number };
}

// ─── Cloud Sink ───────────────────────────────────────────────────

export interface S3SinkConfig {
  bucket: string;
  region: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface GCSSinkConfig {
  bucket: string;
  prefix?: string;
  keyFilename?: string;
  projectId?: string;
}

export interface AzureBlobSinkConfig {
  connectionString: string;
  container: string;
  prefix?: string;
}

export interface CloudSinkOptions {
  provider: 's3' | 'gcs' | 'azure';
  format?: 'json' | 'jsonl' | 'csv';
  keyTemplate?: string;
  providerConfig: S3SinkConfig | GCSSinkConfig | AzureBlobSinkConfig;
}

export declare function createCloudSink(options: CloudSinkOptions): Promise<(batch: unknown[], context?: { jobId?: string }) => Promise<{ insertedCount: number; uri?: string }>>;
export declare function createS3Adapter(config: S3SinkConfig): Promise<{ upload(key: string, buf: Buffer, contentType: string): Promise<string> }>;
export declare function createGCSAdapter(config: GCSSinkConfig): Promise<{ upload(key: string, buf: Buffer, contentType: string): Promise<string> }>;
export declare function createAzureBlobAdapter(config: AzureBlobSinkConfig): Promise<{ upload(key: string, buf: Buffer, contentType: string): Promise<string> }>;

// ─── Database Sink ────────────────────────────────────────────────

export interface PostgresSinkConfig {
  connectionString: string;
  table: string;
  jsonColumn?: string;
  batchSize?: number;
}

export interface MySQLSinkConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  table: string;
  jsonColumn?: string;
  batchSize?: number;
}

export interface MongoSinkConfig {
  connectionString: string;
  database: string;
  collection: string;
  batchSize?: number;
}

export declare function createDatabaseSink(provider: 'postgres' | 'mysql' | 'mongodb', config: PostgresSinkConfig | MySQLSinkConfig | MongoSinkConfig): Promise<(batch: unknown[]) => Promise<{ insertedCount: number }>>;
export declare function createPostgresSink(config: PostgresSinkConfig): Promise<(batch: unknown[]) => Promise<{ insertedCount: number }>>;
export declare function createMySQLSink(config: MySQLSinkConfig): Promise<(batch: unknown[]) => Promise<{ insertedCount: number }>>;
export declare function createMongoSink(config: MongoSinkConfig): Promise<(batch: unknown[]) => Promise<{ insertedCount: number }>>;

// ─── Pagination Discovery ─────────────────────────────────────────

export interface PaginationResult {
  nextUrl: string | null;
  method: 'html-selector' | 'json-field' | 'json-cursor' | 'url-pattern' | null;
  cursor: string | null;
}

export interface PaginationOptions {
  urlPattern?: boolean;
  jsonDetect?: boolean;
  maxPage?: number;
}

export declare function discoverNextPage(response: { body: string; finalUrl: string; headers?: Record<string, string> }, options?: PaginationOptions): PaginationResult;
export declare function getNextPageUrl(response: { body: string; finalUrl: string; headers?: Record<string, string> }, options?: PaginationOptions): string | null;

// ─── Alert Notifier ───────────────────────────────────────────────

export interface AlertPayload {
  title?: string;
  message?: string;
  severity?: 'info' | 'warning' | 'error' | 'critical';
  jobId?: string;
  workflowName?: string;
}

export interface SlackChannelConfig {
  type: 'slack';
  webhookUrl: string;
  channel?: string;
  username?: string;
  iconEmoji?: string;
  timeoutMs?: number;
}

export interface DingTalkChannelConfig {
  type: 'dingtalk';
  webhookUrl: string;
  secret?: string;
  atMobiles?: string[];
  atAll?: boolean;
  timeoutMs?: number;
}

export interface EmailChannelConfig {
  type: 'email';
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  pass: string;
  from: string;
  to: string | string[];
  subject?: string;
}

export type AlertChannelConfig = SlackChannelConfig | DingTalkChannelConfig | EmailChannelConfig;

export declare function sendAlert(alert: AlertPayload, channels: AlertChannelConfig[]): Promise<{ channel: string; ok: boolean; error?: string }[]>;
export declare function sendSlackAlert(alert: AlertPayload, config: SlackChannelConfig): Promise<void>;
export declare function sendDingTalkAlert(alert: AlertPayload, config: DingTalkChannelConfig): Promise<void>;
export declare function sendEmailAlert(alert: AlertPayload, config: EmailChannelConfig): Promise<void>;

// ─── WebSocket Fetcher ────────────────────────────────────────────

export interface WsMessage {
  index: number;
  receivedAt: number;
  type: 'text' | 'binary';
  text: string | null;
  json: unknown | null;
  binary: Buffer | null;
}

export interface WsRequest {
  url: string;
  headers?: Record<string, string>;
  sendMessage?: string | object | null;
  sendMessages?: (string | object)[];
  collectMs?: number;
  maxMessages?: number;
  terminateOn?: string;
  proxy?: string;
  connectTimeoutMs?: number;
  binary?: boolean;
}

export interface WsResponse {
  url: string;
  ok: boolean;
  connectMs: number;
  totalMs: number;
  messages: WsMessage[];
  closeReason: string | null;
  closeCode: number | null;
  error: string | null;
}

export declare function fetchWebSocket(request: WsRequest): Promise<WsResponse>;
export declare function subscribeWebSocket(url: string, subscribeMessage: string | object, options?: Partial<WsRequest>): Promise<WsMessage[]>;

// ─── GraphQL ──────────────────────────────────────────────────────

export interface GraphQLOptions {
  endpoint: string;
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  headers?: Record<string, string>;
  method?: 'POST' | 'GET';
  timeoutMs?: number;
  persistedQueryHash?: string;
}

export interface GraphQLResult {
  data: unknown;
  errors: { message: string }[] | null;
  extensions: unknown;
  status: number;
}

export interface GraphQLSchemaType {
  name: string;
  kind: string;
  description: string | null;
  fields: { name: string; type: string | null; args: string[] }[];
}

export interface GraphQLSchema {
  queryType: string | null;
  mutationType: string | null;
  subscriptionType: string | null;
  types: GraphQLSchemaType[];
}

export declare function detectGraphQLEndpoints(source: string, baseUrl: string): string[];
export declare function executeGraphQL(options: GraphQLOptions): Promise<GraphQLResult>;
export declare function introspectSchema(endpoint: string, options?: Partial<GraphQLOptions>): Promise<GraphQLSchema | null>;
export declare function detectGraphQLPagination(data: unknown): { hasNextPage: boolean; endCursor: string | null; nextOffset: number | null };
export declare function fetchAllPages(options: { endpoint: string; query: string; variables?: Record<string, unknown>; maxPages?: number; headers?: Record<string, string> }): Promise<{ pages: unknown[]; cursors: string[] }>;

// ─── AI Surface Analysis ──────────────────────────────────────────

export interface AiAnalysisField {
  name: string;
  type: string;
  children?: AiAnalysisField[];
  itemTypes?: string[];
}

export interface AiRequestShape {
  transport: string;
  endpoint: string | null;
  method: string;
  parameterLocations: Array<{
    location: 'query' | 'body' | 'headers';
    fields: AiAnalysisField[];
  }>;
}

export interface AiJsObfuscationResult {
  kind: 'ai-js-obfuscation';
  target: string | null;
  meta: {
    hash: string;
    bytes: number;
    lineCount: number;
    title: string | null;
  };
  confidence: 'low' | 'medium' | 'high';
  score: number;
  metrics: Record<string, number>;
  recognizedPatterns: string[];
  suspiciousIdentifiers: string[];
  decodedPreview: {
    base64: Array<{ encoded: string; decoded: string }>;
    hexEscapes: Array<{ encoded: string; decoded: string }>;
    unicodeEscapes: Array<{ encoded: string; decoded: string }>;
  };
  evidence: {
    obfuscationSignals: string[];
    antiDebugSignals: string[];
    transportSignals: string[];
    endpoints: string[];
  };
}

export interface AiApiParameterStructureResult {
  kind: 'ai-api-parameter-structure';
  target: string | null;
  endpoints: string[];
  requestShapes: AiRequestShape[];
  signatureFunctions: SignatureInferenceResult[];
  recommendedHooks: string[];
}

export interface AiResponseSchemaResult {
  kind: 'ai-response-schema';
  sampleCount: number;
  rootType: string;
  schema: Record<string, unknown> | null;
  examplesPreview: unknown[];
}

export interface AiProtectionClassificationResult {
  kind: 'ai-protection-classification';
  status: number;
  waf: {
    detected: boolean;
    type: WafType;
    signals: string[];
  };
  captcha: {
    detected: boolean;
    vendor: string | null;
    signals: string[];
  };
  antiCrawl: {
    detected: boolean;
    categories: string[];
    signals: string[];
    confidence: 'low' | 'medium' | 'high';
  };
  classification: 'waf' | 'captcha' | 'anti-crawl' | 'normal';
}

export interface AiPromptPayload {
  system: string;
  user: string;
  format: string;
  evidence: Record<string, unknown>;
}

export interface AiSurfaceAnalysisResult {
  kind: 'ai-surface-analysis';
  engine: 'omnicrawl';
  target: string | null;
  meta: {
    codeHash: string;
    bodyHash: string | null;
    codeBytes: number;
    bodyBytes: number;
  };
  obfuscation: AiJsObfuscationResult;
  apiParameters: AiApiParameterStructureResult;
  responseSchema: AiResponseSchemaResult;
  protection: AiProtectionClassificationResult;
  ai: {
    enabled: boolean;
    executed: boolean;
    summary: unknown;
    error: string | null;
    advisory: string | null;
    prompt: AiPromptPayload;
  };
}

export declare function detectJsObfuscationSnippets(source: string, options?: { target?: string | null }): AiJsObfuscationResult;
export declare function inferApiParameterStructure(source: string, options?: { target?: string | null }): AiApiParameterStructureResult;
export declare function inferResponseSchema(payload?: {
  sample?: unknown;
  samples?: unknown[];
  responseSample?: unknown;
  responseSamples?: unknown[];
  responseBody?: unknown;
  responseBodies?: unknown[];
  body?: unknown;
}): AiResponseSchemaResult;
export declare function classifyProtectionSurface(payload?: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  html?: string;
  content?: string;
  responseBody?: string;
}): AiProtectionClassificationResult;
export declare function analyzeAISurface(payload?: Record<string, unknown>): Promise<AiSurfaceAnalysisResult>;

// ─── WAF Bypass ───────────────────────────────────────────────────

export type WafType = 'akamai' | 'perimeterx' | 'datadome' | 'cloudflare' | 'unknown';

export interface WafDetectionResult {
  waf: WafType;
  signals: string[];
}

export interface WafBypassConfig {
  headers: Record<string, string>;
  browserMode: boolean;
  evasionScript: string | null;
  notes: string[];
}

export interface NodeProfileLocation {
  line: number | null;
  column: number | null;
}

export interface NodeProfileUsage {
  api: string;
  location: NodeProfileLocation;
  [key: string]: unknown;
}

export interface NodeProfileRoute {
  framework: string;
  container: string;
  method: string;
  path: string | null;
  handler: string | null;
  location: NodeProfileLocation;
}

export interface NodeProfileServerRuntime {
  frameworks: string[];
  entrypoints: Array<{ name: string; framework: string; kind: string; target?: string | null; location: NodeProfileLocation }>;
  routes: NodeProfileRoute[];
}

export interface NodeProfileResult {
  meta: {
    moduleFormat: 'esm' | 'cjs' | 'mixed' | 'unknown';
    executableLikely: boolean;
    shebang: boolean;
  };
  modules: {
    imports: Array<{
      source: string;
      kind: string;
      moduleType: string;
      location: NodeProfileLocation | null;
      binding?: string;
      imported?: string | null;
    }>;
    builtin: string[];
    external: string[];
    relative: string[];
    dynamic: Array<{ kind: string; source: string; location: NodeProfileLocation }>;
  };
  runtime: {
    process: {
      envKeys: Array<{ key: string; location: NodeProfileLocation }>;
      argvAccesses: NodeProfileUsage[];
      cwdAccesses: NodeProfileUsage[];
      exitCalls: NodeProfileUsage[];
    };
    filesystem: NodeProfileUsage[];
    network: NodeProfileUsage[];
    httpClients: NodeProfileUsage[];
    servers: NodeProfileServerRuntime;
    subprocess: NodeProfileUsage[];
    dynamicCode: NodeProfileUsage[];
    crypto: NodeProfileUsage[];
    nativeAddons: NodeProfileUsage[];
    webassembly: NodeProfileUsage[];
    workers: NodeProfileUsage[];
    cluster: NodeProfileUsage[];
    moduleLoading: NodeProfileUsage[];
    websockets: NodeProfileUsage[];
    graphql: NodeProfileUsage[];
    persistence: NodeProfileUsage[];
  };
  cli: {
    frameworks: string[];
  };
  deobfuscation: {
    constantBindings: Array<{ name: string; kind: string; value: unknown; location: NodeProfileLocation }>;
    stringArrays: Array<{ name: string; size: number; preview: string[]; location: NodeProfileLocation }>;
    resolvedExpressions: Array<{ kind: string; original: string; value: string; location: NodeProfileLocation }>;
    decodedStrings: string[];
  };
  risks: {
    suspiciousSinks: Array<{ category: string; api: string; location: NodeProfileLocation }>;
    score: number;
    level: 'low' | 'medium' | 'high';
  };
}

export declare function detectWaf(response: { status: number; headers: Record<string, string>; body: string }): WafDetectionResult;
export declare function getWafBypassConfig(waf: WafType, options?: { userAgent?: string; referer?: string }): WafBypassConfig;
export declare function buildAkamaiHeaders(options?: { userAgent?: string }): Record<string, string>;
export declare function buildPerimeterXHeaders(options?: { userAgent?: string }): Record<string, string>;
export declare function buildDataDomeHeaders(options?: { userAgent?: string; referer?: string }): Record<string, string>;
export declare function buildPerimeterXEvasionScript(): string;
export declare function handleDataDomeCookieChallenge(response: { headers: Record<string, string> }): { cookie: string | null; handled: boolean };

// ─── Node.js Reverse Engineering Capabilities ──────────────────────────────

// Function call tracing
export interface FunctionCallRecord {
  fnName: string;
  args: unknown[];
  result: unknown;
  error: string | null;
  timestamp: number;
  depth: number;
  parent: string | null;
}

export declare class FunctionTracer {
  constructor(options?: { hookPatterns?: string[]; hookAll?: boolean; maxDepth?: number; captureArgs?: boolean; captureReturn?: boolean });
  hook(context: Record<string, unknown>): void;
  getCallChain(): FunctionCallRecord[];
  getCallTree(): Record<string, unknown>;
  clear(): void;
}

export declare function traceFunction(code: string, fnName: string, args?: unknown[], options?: { hookPatterns?: string[]; maxDepth?: number }): { result: unknown; callChain: FunctionCallRecord[]; callTree: Record<string, unknown>; error: string | null };

// String array deobfuscation
export declare class StringArrayDeobfuscator {
  constructor(code: string);
  findStringArrays(): Array<{ name: string; size: number; preview: string[] }>;
  deobfuscate(): {
    code: string;
    resolved: number;
    arrayName: string | null;
    strings: Array<string | null> | null;
  };
  getCode(): string;
}

export declare function deobfuscateStringArray(code: string, options?: {
  vmTimeoutMs?: number;
  executeSetup?: boolean;
}): {
  code: string;
  resolved: number;
  arrayName: string | null;
  strings: Array<string | null> | null;
};

// Control flow deobfuscation
export declare class ControlFlowDeobfuscator {
  constructor(code: string);
  findFlattenedFunctions(): Array<{ name: string; confidence: number }>;
  deobfuscate(): { code: string; restored: number };
  getCode(): string;
}

export declare function deobfuscateControlFlow(code: string): { code: string; restored: number };
export declare function fullDeobfuscate(code: string, options?: object): Promise<{
  code: string;
  stringArrayResolved: number;
  controlFlowRestored: number;
  arrayName: string | null;
}>;

// Browser sandbox
export interface BrowserSandboxOptions {
  url?: string;
  freezeTime?: number | null;
  cookies?: Record<string, string>;
  localStorage?: Record<string, string>;
  env?: Record<string, unknown>;
  vmTimeoutMs?: number;
  interceptNetwork?: boolean;
}

export interface CapturedRequest {
  type: 'fetch' | 'xhr';
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  capturedAt: number;
}

export declare class BrowserSandbox {
  constructor(options?: BrowserSandboxOptions);
  build(): Promise<BrowserSandbox>;
  run(code: string): BrowserSandbox;
  call(fnName: string, args?: unknown[]): unknown;
  get(name: string): unknown;
  close(): void;
  readonly capturedRequests: CapturedRequest[];
  readonly logs: Array<{ level: string; args: unknown[] }>;
  readonly loadError: string | null;
  readonly cookieStore: string;
}

export declare function runInBrowserSandbox(code: string, fnName: string, args?: unknown[], sandboxOptions?: BrowserSandboxOptions): Promise<{ result: unknown; callError: string | null; capturedRequests: CapturedRequest[]; logs: Array<{ level: string; args: unknown[] }>; loadError: string | null }>;

// Signature parameter inference
export interface SignatureParam {
  name: string;
  index: number;
  type: string;
  example: unknown;
  required: boolean;
}

export interface SignatureInferenceResult {
  fnName: string;
  params: SignatureParam[];
  implicitDeps: Array<{ name: string; source: string; type: string }>;
  globalReads: string[];
  usesTimestamp: boolean;
  usesNonce: boolean;
  usesUrl: boolean;
  usesBody: boolean;
  callExample: string;
  confidence: 'high' | 'medium' | 'low';
}

export declare function inferSignatureParams(code: string, fnName: string): SignatureInferenceResult;
export declare function inferAllSignatureFunctions(code: string, nameHints?: string[]): SignatureInferenceResult[];

// JS version diff detection
export interface VersionDiffResult {
  added: Array<{ name: string; hash: string }>;
  removed: Array<{ name: string; hash: string }>;
  modified: Array<{ name: string; oldHash: string; newHash: string; severity: 'critical' | 'high' | 'medium' | 'low' }>;
  unchanged: number;
  cryptoChanges: { added: string[]; removed: string[] };
  summary: string;
  hasCriticalChanges: boolean;
}

export declare function detectVersionDiff(oldCode: string, newCode: string, options?: { signatureFunctions?: string[]; trackCrypto?: boolean }): VersionDiffResult;

export declare class VersionMonitor {
  constructor();
  addVersion(code: string, metadata?: Record<string, unknown>): { hash: string; diff: VersionDiffResult | null; hasCriticalChanges: boolean };
  setSignatureFunctions(names: string[]): void;
  getLatest(): { timestamp: number; code: string; hash: string; metadata: Record<string, unknown>; diff: VersionDiffResult | null } | null;
  getCriticalVersions(): Array<{ timestamp: number; code: string; hash: string; metadata: Record<string, unknown>; diff: VersionDiffResult }>;
  getSummary(): { totalVersions: number; criticalChanges: number; latestHash: string | null; firstSeen: number | null; lastSeen: number | null };
}

export declare function compareVersions(oldCode: string, newCode: string, signatureFunctions?: string[]): string;

// Protobuf structure inference
export interface ProtobufField {
  fieldNumber: number;
  name: string;
  type: string;
  repeated: boolean;
}

export interface ProtobufInferenceResult {
  fields: ProtobufField[];
  protoSchema: string;
  rawFields?: unknown[];
  sampleCount?: number;
}

export declare function inferProtobufStructure(data: Buffer | Uint8Array, options?: { messageName?: string; detectRepeated?: boolean }): ProtobufInferenceResult;
export declare function inferFromMultipleSamples(samples: Array<Buffer | Uint8Array>, options?: { messageName?: string }): ProtobufInferenceResult;
export declare function decodeWithInferredSchema(data: Buffer | Uint8Array, schema: ProtobufInferenceResult): Record<string, unknown>;

// ─── Code Optimizer ─────────────────────────────────────────────────────────

export declare function optimizeCode(code: string, options?: { maxPasses?: number }): string;
export declare function analyzeOptimization(originalCode: string, optimizedCode: string): {
  originalNodes: number;
  optimizedNodes: number;
  reduction: string;
  originalSize: number;
  optimizedSize: number;
  sizeReduction: string;
};
export declare function optimizeWithAnalysis(code: string, options?: { maxPasses?: number }): {
  code: string;
  analysis: ReturnType<typeof analyzeOptimization>;
};

// ─── AST Parse Cache ────────────────────────────────────────────────────────

export declare class ASTCache {
  constructor(options?: { maxSize?: number; ttl?: number });
  parse(code: string, options?: Record<string, unknown>): unknown;
  clear(): void;
  getStats(): { size: number; maxSize: number; hits: number; misses: number; hitRate: number };
}

export declare function getGlobalASTCache(): ASTCache;
export declare function parseWithCache(code: string, options?: Record<string, unknown>): unknown;
export declare function clearASTCache(): void;
export declare function getASTCacheStats(): ReturnType<ASTCache['getStats']> | null;

// ─── Fingerprint Protection ────────────────────────────────────────────────

export declare function generateCanvasNoiseInjection(options?: { noiseLevel?: number; seed?: number }): string;
export declare function generateWebGLProtection(options?: { vendor?: string; renderer?: string; seed?: number }): string;
export declare function generateAudioContextProtection(options?: { seed?: number }): string;
export declare function generateFontProtection(options?: { allowedFonts?: string[] }): string;
export declare function buildFingerprintProtection(options?: {
  seed?: number;
  canvas?: boolean;
  webgl?: boolean;
  audio?: boolean;
  fonts?: boolean;
  noiseLevel?: number;
  vendor?: string;
  renderer?: string;
  allowedFonts?: string[];
}): string;
export declare function applyFingerprintProtection(page: unknown, options?: Parameters<typeof buildFingerprintProtection>[0]): Promise<{ success: boolean; seed?: number; error?: string }>;

// ─── Validation and Security ────────────────────────────────────────────────

export declare function validateUrl(url: string, options?: { allowedProtocols?: string[]; allowPrivateIPs?: boolean }): string;
export declare function validateCode(code: string, options?: { maxLength?: number; allowDangerousPatterns?: boolean }): string;
export declare function validateSelector(selector: string, options?: { maxLength?: number }): string;
export declare function validateNumber(value: unknown, options?: { min?: number; max?: number; integer?: boolean; field?: string }): number;
export declare function validateObject(obj: unknown, schema: Record<string, { required?: boolean; type?: string; validate?: (value: unknown) => void }>): Record<string, unknown>;
export declare function sanitizeHtml(html: string): string;
export declare function sanitizeFilename(filename: string): string;

export declare class RateLimiter {
  constructor(options?: { maxRequests?: number; windowMs?: number });
  check(key: string): { remaining: number; resetAt: number };
  reset(key: string): void;
  clear(): void;
}

// ─── Error Handling Utilities ───────────────────────────────────────────────

export declare function withErrorHandling<T extends (...args: any[]) => any>(
  fn: T,
  ErrorClass?: typeof OmniCrawlError,
  options?: Record<string, unknown>
): T;

export declare function withAsyncErrorHandling<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  ErrorClass?: typeof OmniCrawlError,
  options?: Record<string, unknown>
): T;

export declare function safeExecute<T>(
  fn: () => T,
  fallback?: T,
  options?: { logError?: boolean }
): T;

export declare function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    baseDelay?: number;
    maxDelay?: number;
    shouldRetry?: (error: Error) => boolean;
  }
): Promise<T>;

export declare function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  options?: { timeoutError?: Error }
): Promise<T>;

export declare function collectErrors<T>(
  operations: Array<() => Promise<T>>
): Promise<{
  results: Array<{ index: number; success: boolean; result?: T; error?: Error }>;
  errors: Array<{ index: number; error: Error }>;
  hasErrors: boolean;
}>;

// ─── WASM Analyzer ──────────────────────────────────────────────────────────

export interface WasmAnalysis {
  valid: boolean;
  version?: number;
  sections?: Array<{ id: number; type: string; size: number; data: Buffer }>;
  size?: number;
  error?: string;
}

export interface WasmImport {
  module: string;
  name: string;
  kind: string;
}

export interface WasmExport {
  name: string;
  kind: string;
  index: number;
}

export declare function analyzeWasmModule(buffer: Buffer | Uint8Array): WasmAnalysis;
export declare function extractWasmImports(buffer: Buffer | Uint8Array): WasmImport[];
export declare function extractWasmExports(buffer: Buffer | Uint8Array): WasmExport[];
export declare function getWasmSummary(buffer: Buffer | Uint8Array): {
  valid: boolean;
  version?: number;
  size?: number;
  sections?: Record<string, number>;
  imports?: { count: number; modules: string[]; items: WasmImport[] };
  exports?: { count: number; functions: number; items: WasmExport[] };
  error?: string;
};
export declare function isWasmModule(buffer: Buffer | Uint8Array): boolean;
export declare function extractWasmFromJS(jsCode: string): Array<{ type: string; offset: number; size: number; buffer: Buffer }>;
export declare function analyzeWasmInstantiation(jsCode: string): Array<{ method: string; offset: number; context: string }>;

export declare function analyzeNodeProfile(code: string): { success: boolean; data?: NodeProfileResult; error?: string };
export declare function deobfuscateNodeLiterals(code: string): {
  success: boolean;
  data?: NodeProfileResult['deobfuscation'];
  error?: string;
};


// ─── Configuration Management ───────────────────────────────────────────────

export interface OmniCrawlConfig {
  reverse?: {
    astCache?: { enabled?: boolean; maxSize?: number; ttl?: number };
    sandbox?: { vmTimeout?: number; interceptNetwork?: boolean; freezeTime?: number | null };
    optimizer?: { maxPasses?: number; enabled?: boolean };
  };
  stealth?: {
    fingerprint?: { canvas?: boolean; webgl?: boolean; audio?: boolean; fonts?: boolean; noiseLevel?: number };
    tlsProfile?: string;
    behaviorSimulation?: boolean;
  };
  security?: {
    validation?: { maxCodeLength?: number; allowDangerousPatterns?: boolean; allowPrivateIPs?: boolean };
    rateLimit?: { enabled?: boolean; maxRequests?: number; windowMs?: number };
  };
  performance?: { concurrency?: number; timeout?: number; retries?: number };
}

export declare class ConfigManager {
  constructor(userConfig?: Partial<OmniCrawlConfig>);
  get(path: string): any;
  set(path: string, value: any): void;
  getAll(): OmniCrawlConfig;
  reset(): void;
}

export declare const DEFAULT_CONFIG: OmniCrawlConfig;
export declare function getGlobalConfig(): ConfigManager;
export declare function setGlobalConfig(userConfig: Partial<OmniCrawlConfig>): ConfigManager;
export declare function loadConfigFromEnv(): ConfigManager;

// ─── Logging ────────────────────────────────────────────────────────────────

export interface LoggerOptions {
  level?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  name?: string;
  json?: boolean;
  timestamp?: boolean;
}

export declare class Logger {
  constructor(options?: LoggerOptions);
  debug(message: string, context?: Record<string, any>): void;
  info(message: string, context?: Record<string, any>): void;
  warn(message: string, context?: Record<string, any>): void;
  error(message: string, context?: Record<string, any>): void;
  child(options?: Partial<LoggerOptions>): Logger;
}

export declare function getLogger(name?: string): Logger;
export declare function setLogger(logger: Logger): void;

export interface OptionalIntegrationInfo {
  id: string;
  label: string;
  category: string;
  packageName: string;
  installed: boolean;
  packageVersion: string | null;
  envConfigured: boolean;
  envKeys: string[];
  docs: string;
}

export interface OptionalIntegrationSnapshot {
  total: number;
  installedCount: number;
  envConfiguredCount: number;
  items: OptionalIntegrationInfo[];
}

export interface OptionalIntegrationProbeResult extends OptionalIntegrationInfo {
  dryRun: boolean;
  ok: boolean;
  status: string;
  required: string[];
  configValid: boolean;
  durationMs: number;
  details?: Record<string, unknown> | null;
  error?: string;
}

export declare const OPTIONAL_INTEGRATIONS: Array<{
  id: string;
  label: string;
  packageName: string;
  category: string;
  envKeys: string[];
  docs: string;
}>;

export declare function inspectOptionalIntegrations(options?: {
  env?: Record<string, string | undefined>;
}): OptionalIntegrationSnapshot;

export declare function probeIntegration(options: {
  id: string;
  config?: Record<string, unknown>;
  dryRun?: boolean;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<OptionalIntegrationProbeResult>;

export declare function probeIntegrations(options?: {
  ids?: string[];
  configs?: Record<string, Record<string, unknown>>;
  dryRun?: boolean;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<{
  total: number;
  okCount: number;
  items: OptionalIntegrationProbeResult[];
}>;
