export { createApp, startServer, getCapabilities } from './server.js';
export { loadWorkflow } from './runtime/workflow-loader.js';
export { JobStore } from './runtime/job-store.js';
export { HistoryStore } from './runtime/history-store.js';
export { WorkflowRegistry } from './runtime/workflow-registry.js';
export { ScheduleManager } from './runtime/scheduler.js';
export { SqliteScheduleManager } from './runtime/sqlite-scheduler.js';
export { SqliteDataPlane } from './runtime/sqlite-data-plane.js';
export { SqliteRequestQueue } from './runtime/sqlite-request-queue.js';
export { SqliteDatasetStore } from './runtime/sqlite-dataset-store.js';
export { SqliteKeyValueStore } from './runtime/sqlite-key-value-store.js';
export { SqliteGcService } from './runtime/sqlite-gc.js';
export { SessionStore } from './runtime/session-store.js';
export { SessionPool } from './runtime/session-pool.js';
export { ProxyPool } from './runtime/proxy-pool.js';
export { RequestQueue, buildRequestUniqueKey } from './runtime/request-queue.js';
export { DatasetStore } from './runtime/dataset-store.js';
export { KeyValueStore } from './runtime/key-value-store.js';
export { SqliteJobStore } from './runtime/sqlite-job-store.js';
export { DistributedWorkerService } from './runtime/distributed-worker.js';
export { resolveDistributedConfig } from './runtime/distributed-config.js';
export { AutoscaleController } from './runtime/autoscaler.js';
export { acquireBrowserLease, closeBrowserPool, getBrowserPoolSnapshot } from './runtime/browser-pool.js';
export { JobRunner, runWorkflow } from './runtime/job-runner.js';
export { closeBrowser } from './fetchers/browser-fetcher.js';
export { analyzeHtmlForReverse, analyzeJavaScript, executeReverseSnippet, invokeNamedFunction } from './reverse/reverse-analyzer.js';
export {
  detectJsObfuscationSnippets,
  inferApiParameterStructure,
  inferResponseSchema,
  classifyProtectionSurface,
  analyzeAISurface,
} from './reverse/ai-analysis.js';
export { getReverseCapabilitySnapshot, runReverseOperation } from './reverse/reverse-capabilities.js';
export { detectWafSurface, validateExtractedSchema, assessResultQuality, QualityTracker } from './runtime/quality-monitor.js';
export { analyzeBaseline } from './runtime/baseline-analyzer.js';
export { analyzeTrends } from './runtime/trend-analyzer.js';
export { analyzeRunDiagnostics, buildReplayRecipe, buildResultIdentitySnapshot, inspectResultDiagnostics } from './runtime/reverse-diagnostics.js';
export { applyWorkflowPatch, buildReplayWorkflow, buildReplayWorkflowPatchTemplate } from './runtime/replay-workflow.js';
export { dispatchAlerts } from './runtime/alert-dispatcher.js';
export { AlertOutbox, AlertOutboxService } from './runtime/alert-outbox.js';
export { CrawlPolicyManager, parseRobotsTxt, evaluateRobotsAccess } from './runtime/crawl-policy.js';
export { computeRetryDelayMs, parseRetryAfterMs } from './runtime/retry-policy.js';
export { HttpCacheStore } from './runtime/http-cache-store.js';
export { GroupBackoffController, normalizeGroupBackoffConfig } from './runtime/group-backoff.js';

// TLS/HTTP2 fingerprinting
export {
  getBrowserTLSProfile,
  createTLSAgent,
  calculateJA3,
  calculateJA4,
  getAvailableTLSProfiles,
  BROWSER_PROFILES as TLS_PROFILES,
} from './fetchers/tls-fingerprint.js';
export {
  getH2BrowserProfile,
  getAvailableH2Profiles,
  getH2FingerprintSummary,
  H2_BROWSER_PROFILES,
} from './fetchers/http2-fingerprint.js';
export {
  getHeaderOrder,
  reorderHeaders,
  buildOrderedFetchHeaders,
} from './fetchers/header-order.js';
export {
  generateFingerprintProfile,
  getFingerprintPresets,
  buildFingerprintInjection,
} from './fetchers/fingerprint-manager.js';

// Reverse surface compatibility re-exports.
// New code should prefer importing optional reverse modules from `omnicrawl/reverse`.

// Behavior simulation
export {
  generateMousePath,
  generateTypingEvents,
  generateScrollEvents,
  generateInteractionSequence,
  executeInteractionSequence,
  injectBehaviorSimulation,
  analyzeBehaviorPattern,
} from './reverse/behavior-simulation.js';

// CAPTCHA solving
export {
  solveCaptcha,
  detectCaptcha,
  autoSolveCaptcha,
  injectCaptchaToken,
  getCaptchaBalance,
} from './reverse/captcha-solver.js';

// Cloudflare solver
export {
  detectCloudflareChallenge,
  solveJsChallenge,
  waitForClearanceCookie,
  handleCloudflareChallenge,
  buildCloudflareStealthHeaders,
} from './reverse/cloudflare-solver.js';

// Signature locator
export {
  locateSignatureFunctions,
  extractFunctionWithDependencies,
  generateRPCWrapper,
  autoSetupSignatureRPC,
  callSignatureRPC,
} from './reverse/signature-locator.js';

// App WebView
export {
  getAppWebViewProfile,
  getAvailableWebViewProfiles,
  buildJSBridgeInjection,
  injectAppWebView,
  detectAppWebView,
  createAppScrapeConfig,
} from './reverse/app-webview.js';

// Protocol analyzers
export {
  analyzeProtobufPayload,
  analyzeGrpcPayload,
  loadProtoSchema,
  decodeProtobufMessage,
  normalizeBinaryInput,
} from './reverse/protocol-analyzer.js';
export {
  buildNativeCapturePlan,
  getNativeToolStatus,
} from './reverse/native-integration.js';
export {
  analyzeNodeProfile,
  deobfuscateNodeLiterals,
} from './reverse/node-runtime-analyzer.js';

// Redis control plane
export {
  createRedisControlPlane,
  RedisJobQueue,
  RedisScheduleManager,
  RedisEventBus,
  RedisWorkerRegistry,
} from './runtime/redis-control-plane.js';

// Programmatic API
export { OmniCrawler } from './api/omnicrawler.js';
export { Router } from './api/router.js';
export { CrawlContextImpl as CrawlContext } from './api/crawl-context.js';
export { ItemPipeline } from './api/item-pipeline.js';
export { GracefulShutdown } from './api/graceful-shutdown.js';
export {
  HttpCrawler,
  CheerioCrawler,
  BrowserCrawler,
  HybridCrawler,
  MediaCrawler,
  JSDOMCrawler,
  ApiJsonCrawler,
  FeedCrawler,
  SitemapCrawler,
  GraphQLCrawler,
  WebSocketCrawler,
  PuppeteerCrawler,
  PuppeteerCoreCrawler,
  PlaywrightCrawler,
  PlaywrightCoreCrawler,
  PatchrightCrawler,
} from './api/crawler-presets.js';


// ─── Phase 1: Lightweight Crawler + Rate Limiting + Export + Dedup ─────────
export { fetchWithCheerio, extractWithSchema } from './fetchers/cheerio-fetcher.js';
export { DomainRateLimiter } from './runtime/rate-limiter.js';
export { ExportManager, itemsToCsv, itemsToJson, itemsToJsonl } from './runtime/export-manager.js';
export { normalizeUrl, computeFingerprint, RequestDeduplicator } from './runtime/request-fingerprint.js';

// ─── Phase 2: Proxy Providers + Observability ───────────────────────
export { createProxyProvider, getProxyFromProvider } from './runtime/proxy-providers.js';

// ─── Phase 3: Observability + Benchmark + Plugin Registry ─────────────
export {
  setupObservability,
  getPromRegistry,
  getPromMetrics,
  summarizeObservability,
  PROMETHEUS_CONTENT_TYPE,
  OPENMETRICS_CONTENT_TYPE,
} from './runtime/observability.js';
export { inspectOptionalIntegrations, probeIntegration, probeIntegrations, OPTIONAL_INTEGRATIONS } from './runtime/integration-registry.js';
export { BenchmarkRunner } from './runtime/benchmark.js';
export { PluginRegistry, createSitemapPlugin, createJsonLdPlugin, createRobotsMetaPlugin, getGlobalRegistry } from './plugins/plugin-registry.js';

// ─── New capabilities ──────────────────────────────────────────────────────

// XPath extraction
export { evaluateXPath } from './extractors/xpath-extractor.js';
export { extractMediaAssets, buildMediaExtractRules } from './extractors/media-extractor.js';

// Bloom filter deduplication
export { BloomFilter, BloomDeduplicator } from './runtime/bloom-filter.js';

// Cloud storage sinks
export { createCloudSink, createS3Adapter, createGCSAdapter, createAzureBlobAdapter } from './runtime/cloud-sink.js';

// Database sinks
export { createDatabaseSink, createPostgresSink, createMySQLSink, createMongoSink } from './runtime/db-sink.js';
export {
  downloadMediaAsset,
  downloadMediaAssets,
  collectMediaAssetsFromResult,
  filterMediaAssets,
  readMediaDownloadManifest,
  collectFailedMediaDownloads,
  retryFailedMediaDownloads,
} from './runtime/media-downloader.js';

// Pagination auto-discovery
export { discoverNextPage, getNextPageUrl } from './runtime/pagination-discovery.js';

// Alert notification channels
export { sendAlert, sendSlackAlert, sendDingTalkAlert, sendEmailAlert } from './runtime/alert-notifier.js';

// WebSocket crawler
export { fetchWebSocket, subscribeWebSocket } from './fetchers/ws-fetcher.js';

// GraphQL support
export { detectGraphQLEndpoints, executeGraphQL, introspectSchema, detectGraphQLPagination, fetchAllPages } from './fetchers/graphql-fetcher.js';

// AI, Mobile, and gRPC capabilities
export { AiExtractor, useAiExtraction } from './api/ai-extractor.js';
export { AiAgent } from './api/ai-agent.js';
export { DataValidator, useDataValidation } from './api/data-validator.js';
export { MfaHandler, solveLoginMfa } from './api/mfa-handler.js';
export { MobileCrawler } from './runtime/mobile-crawler.js';
export { NativeBridge } from './reverse/native-bridge.js';
export { V8BytecodeAnalyzer } from './reverse/v8-bytecode-analyzer.js';
export { RuntimeSentinel } from './reverse/runtime-sentinel.js';
export { HeapDumpAnalyzer } from './reverse/heap-dump-analyzer.js';
export { TorCrawler } from './runtime/tor-crawler.js';
export { StreamRecorder } from './runtime/stream-recorder.js';
export { WebhookDispatcher } from './runtime/webhook-dispatcher.js';
export { BrowserPoolGuard } from './runtime/browser-pool-guard.js';
export { ClusterPartitionManager } from './runtime/cluster-partition-manager.js';
export { ShardedDbSink } from './runtime/sharded-db-sink.js';
export { buildHardenedEnvironmentInjection } from './reverse/v-stealth.js';
export { GrpcCrawler } from './runtime/grpc-crawler.js';
export { JobInputBuilder } from './runtime/job-input-builder.js';
export { JobDiscovery } from './runtime/job-discovery.js';

// WAF bypass
export { detectWaf, getWafBypassConfig, buildAkamaiHeaders, buildPerimeterXHeaders, buildDataDomeHeaders, buildPerimeterXEvasionScript, handleDataDomeCookieChallenge } from './reverse/waf-bypass.js';

// ─── Node.js Reverse Engineering Capabilities ──────────────────────────────

// Function call tracing
export { FunctionTracer, traceFunction } from './reverse/function-tracer.js';

// String array deobfuscation
export { StringArrayDeobfuscator, deobfuscateStringArray } from './reverse/string-array-deobfuscator.js';

// Control flow deobfuscation
export { ControlFlowDeobfuscator, deobfuscateControlFlow, fullDeobfuscate } from './reverse/control-flow-deobfuscator.js';

// Browser sandbox for reverse engineering
export { BrowserSandbox, runInBrowserSandbox } from './reverse/browser-sandbox.js';

// Signature parameter inference
export { inferSignatureParams, inferAllSignatureFunctions } from './reverse/signature-inferrer.js';

// JS version diff detection
export { detectVersionDiff, VersionMonitor, compareVersions } from './reverse/version-diff-detector.js';

// Protobuf structure inference
export { inferProtobufStructure, inferFromMultipleSamples, decodeWithInferredSchema } from './reverse/protobuf-inferrer.js';

// WASM reverse engineering
export {
  analyzeWasmModule,
  extractWasmImports,
  extractWasmExports,
  getWasmSummary,
  isWasmModule,
  extractWasmFromJS,
  analyzeWasmInstantiation,
} from './reverse/wasm-analyzer.js';

// ─── Code Optimizer ─────────────────────────────────────────────────────────

export { optimizeCode, analyzeOptimization, optimizeWithAnalysis } from './reverse/code-optimizer.js';

// ─── AST Parse Cache ────────────────────────────────────────────────────────

export { ASTCache, getGlobalASTCache, parseWithCache, clearASTCache, getASTCacheStats } from './reverse/ast-cache.js';

// ─── Fingerprint Protection ────────────────────────────────────────────────

export {
  generateCanvasNoiseInjection,
  generateWebGLProtection,
  generateAudioContextProtection,
  generateFontProtection,
  buildFingerprintProtection,
  applyFingerprintProtection,
} from './reverse/fingerprint-protection.js';

// ─── Error Classes ──────────────────────────────────────────────────────────

export {
  OmniCrawlError,
  NetworkError,
  TimeoutError,
  ProxyError,
  HttpError,
  RateLimitError,
  AntiBotError,
  CaptchaError,
  WafBlockError,
  ParsingError,
  ASTParsingError,
  SelectorError,
  ValidationError,
  SchemaValidationError,
  ResourceError,
  BrowserPoolExhaustedError,
  StorageError,
  ConfigurationError,
  ReverseEngineeringError,
  DeobfuscationError,
  SandboxError,
  isRecoverableError,
  wrapError,
  createHttpError,
} from './errors.js';

// ─── Validation and Security ────────────────────────────────────────────────

export {
  validateUrl,
  validateCode,
  validateSelector,
  validateNumber,
  validateObject,
  sanitizeHtml,
  sanitizeFilename,
  RateLimiter,
} from './utils/validation.js';

// ─── Error Handling Utilities ───────────────────────────────────────────────

export {
  withErrorHandling,
  withAsyncErrorHandling,
  safeExecute,
  withRetry,
  withTimeout,
  collectErrors,
} from './utils/error-handling.js';

// ─── Configuration Management ───────────────────────────────────────────────

export {
  ConfigManager,
  DEFAULT_CONFIG,
  getGlobalConfig,
  setGlobalConfig,
  loadConfigFromEnv,
} from './utils/config.js';

// ─── Logging ────────────────────────────────────────────────────────────────

export {
  Logger,
  getLogger,
  setLogger,
} from './utils/logger.js';
