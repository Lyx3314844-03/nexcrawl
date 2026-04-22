import express from 'express';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createLogger } from './core/logger.js';
import { AppError } from './core/errors.js';
import { OmniCrawlError } from './errors.js';
import { JobStore } from './runtime/job-store.js';
import { HistoryStore } from './runtime/history-store.js';
import { WorkflowRegistry } from './runtime/workflow-registry.js';
import { ScheduleManager } from './runtime/scheduler.js';
import { SessionStore } from './runtime/session-store.js';
import { ProxyPool } from './runtime/proxy-pool.js';
import { DatasetStore } from './runtime/dataset-store.js';
import { KeyValueStore } from './runtime/key-value-store.js';
import { SqliteJobStore } from './runtime/sqlite-job-store.js';
import { RedisJobStore } from './runtime/redis-job-store.js';
import { DistributedWorkerService } from './runtime/distributed-worker.js';
import { SqliteScheduleManager } from './runtime/sqlite-scheduler.js';
import { SqliteDataPlane } from './runtime/sqlite-data-plane.js';
import { SqliteGcService } from './runtime/sqlite-gc.js';
import { resolveDistributedConfig } from './runtime/distributed-config.js';
import { getBrowserPoolSnapshot } from './runtime/browser-pool.js';
import { runWorkflow } from './runtime/job-runner.js';
import { loadWorkflow } from './runtime/workflow-loader.js';
import { renderDashboard } from './dashboard.js';
import { closeBrowser } from './fetchers/browser-fetcher.js';
import { getReverseCapabilitySnapshot, runReverseOperation } from './reverse/reverse-capabilities.js';
import { registerLegacyReverseApi } from './routes/legacy-reverse-api.js';
import { registerReverseLabRoutes } from './routes/reverse-lab.js';
import { setupLoginRecorderRoutes, setupRepairPlanRoutes } from './routes/recorder-and-repair.js';
import { metrics } from './runtime/prometheus-exporter.js';
import { mapWithConcurrency } from './utils/concurrency.js';
import { ReverseLabManager } from './reverse/reverse-lab-manager.js';
import { analyzeTrends } from './runtime/trend-analyzer.js';
import { AlertOutboxService } from './runtime/alert-outbox.js';
import { applyWorkflowPatch, buildReplayWorkflow, buildReplayWorkflowPatchTemplate } from './runtime/replay-workflow.js';
import { buildPreviewWorkflow, buildWorkflowFromTemplate, buildWorkflowFromUniversalTarget, getWorkflowTemplateCatalog } from './runtime/workflow-templates.js';
import { renderFieldPickerDocument } from './runtime/field-picker.js';
import { buildWorkflowRepairPlan } from './runtime/workflow-repair.js';
import { deriveAuthStatePlanFromResults } from './runtime/auth-state.js';
import { AppCaptureManager } from './runtime/app-capture-manager.js';
import { ReverseAssetStore } from './runtime/reverse-asset-store.js';
import { inspectOptionalIntegrations, probeIntegration, probeIntegrations } from './runtime/integration-registry.js';
import { getPromMetrics, getPromRegistry } from './runtime/observability.js';
import { AccountPool } from './runtime/account-pool.js';
import { AntiBotLab, detectDegradedPage } from './runtime/anti-bot-lab.js';
import { buildAppCapturePlan, mergeAppCaptureStreams } from './runtime/app-capture-platform.js';
import { AccessPolicy, AuditLogger, CredentialVault, TenantRegistry } from './runtime/governance.js';
import { classifyLoginObservation, buildLoginRecoveryPlan, LoginStateMachine } from './runtime/login-state-machine.js';
import { buildInteractiveLoginPlan, HumanInteractionBroker } from './runtime/interactive-auth-executor.js';
import { ResourceScheduler, buildDagExecutionPlan, createLineageRecord, evolveSchemaVersion } from './runtime/platform-orchestration.js';
import { inferGraphQLSemantics, inferGrpcSemantics, inferWebSocketSemantics } from './runtime/protocol-semantics.js';
import { buildUniversalCrawlPlan } from './runtime/universal-crawl-planner.js';
import { buildAutoPatchPlan } from './runtime/self-healing.js';
import { DevicePool, buildMobileAppExecutionPlan, executeMobileAppPlan } from './runtime/mobile-device-platform.js';
import { buildAttestationCompliancePlan } from './runtime/attestation-policy.js';

const logger = createLogger({ component: 'server' });
const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../package.json');

export function getCapabilities() {
  return {
    name: 'omnicrawl',
    version: packageVersion,
    interfaces: ['cli', 'http-api', 'sse', 'dashboard'],
    surfaces: {
      core: {
        importPath: 'omnicrawl',
        focus: ['crawl-orchestration', 'request-queue', 'sessions', 'proxy-routing', 'datasets', 'dashboard'],
      },
      reverse: {
        importPath: 'omnicrawl/reverse',
        focus: ['reverse-analysis', 'reverse-lab', 'reverse-cdp', 'optional-solvers'],
        optIn: true,
      },
    },
    compliance: {
      posture: 'lawful-crawling-first',
      reverseModulesOptIn: true,
      automaticAccessControlBypass: false,
    },
    fetchers: ['http', 'cheerio', 'browser', 'hybrid', 'websocket', 'feed', 'sitemap', 'universal', 'mobile-appium'],
    extractors: ['regex', 'json', 'script', 'selector', 'links', 'surface', 'reverse', 'xpath', 'media', 'native-source'],
    presets: ['HttpCrawler', 'CheerioCrawler', 'BrowserCrawler', 'HybridCrawler', 'MediaCrawler', 'JSDOMCrawler', 'ApiJsonCrawler', 'FeedCrawler', 'SitemapCrawler', 'GraphQLCrawler', 'WebSocketCrawler', 'UniversalCrawler', 'PuppeteerCrawler', 'PuppeteerCoreCrawler', 'PlaywrightCrawler', 'PlaywrightCoreCrawler', 'PatchrightCrawler', 'MobileCrawler', 'TorCrawler'],
    plugins: ['dedupe', 'throttle', 'audit', 'rotateUserAgent'],
    platform: ['workflow-registry', 'interval-scheduler', 'history-replay', 'persistent-job-store', 'request-queue', 'host-aware-frontier-scheduling', 'per-host-concurrency-window', 'priority-frontier', 'per-group-budget-window', 'hostname-origin-frontier-grouping', 'group-backoff', 'retry-storm-isolation', 'job-resume', 'session-pool', 'autoscale-runtime', 'external-plugins', 'runtime-metrics', 'dataset-store', 'key-value-store', 'browser-pool', 'session-isolation', 'proxy-config', 'proxy-pool', 'proxy-routing', 'proxy-control', 'proxy-probe', 'retry-policy', 'rate-limiter', 'adaptive-auto-throttle', 'robots-txt-policy', 'crawl-delay', 'robots-sitemap-seeding', 'job-detail', 'event-search', 'result-pagination', 'failed-request-surface', 'replay-recipe', 'result-export', 'export-backend-drivers', 'job-compare', 'change-tracking', 'change-feed-api', 'nested-field-diff', 'reverse-analysis', 'reverse-workflow', 'reverse-batch', 'reverse-lab', 'reverse-ast', 'reverse-ast-deobfuscate', 'reverse-node-profile', 'reverse-crypto', 'reverse-webpack', 'reverse-browser-sim', 'reverse-browser-execute', 'reverse-curl-convert', 'reverse-hooks', 'reverse-cdp', 'legacy-reverse-compat', 'browser-debug-capture', 'xhr-fetch-capture', 'source-map-capture', 'runtime-hook-capture', 'browser-debug-artifacts', 'quality-monitoring', 'schema-validation', 'waf-detection', 'structure-drift-alerts', 'baseline-anomaly-detection', 'historical-regression-alerts', 'trend-window-analysis', 'webhook-alerting', 'observability-hooks', 'observability-summary', 'integration-registry', 'integration-probe', 'universal-crawl-planner', 'universal-workflow-scaffold', 'login-state-machine', 'interactive-auth-executor', 'tenant-registry', 'persistent-account-pool', 'account-pool-scheduling', 'rbac-access-policy', 'mobile-device-pool', 'mobile-app-execution-plan', 'attestation-compliance-gate', 'app-capture-closed-loop-plan', 'protocol-semantics', 'anti-bot-experiment-lab', 'tenant-resource-quotas', 'dag-orchestration-plan', 'data-lineage', 'schema-evolution', 'self-healing-patch-plan', 'audit-log', 'credential-vault', 'sqlite-control-plane', 'distributed-job-queue', 'worker-leases', 'distributed-scheduler', 'distributed-request-queue', 'distributed-results-store', 'distributed-event-log', 'distributed-artifact-store', 'distributed-sse', 'distributed-gc'],
    artifacts: ['events.ndjson', 'results.ndjson', 'summary.json', 'workflow.json', 'request-queue.json', '.omnicrawl/datasets/*', '.omnicrawl/key-value-stores/*', 'debug/*.browser-debug/manifest.json', 'sqlite:job_events', 'sqlite:job_results', 'sqlite:job_artifacts', 'sqlite:datasets', 'sqlite:key_value_stores'],
    reverse: getReverseCapabilitySnapshot(),
    integrations: inspectOptionalIntegrations(),
  };
}

async function readNdjsonFile(targetPath, limit = 50) {
  try {
    const raw = await readFile(targetPath, 'utf8');
    const lines = raw.trim() ? raw.trim().split('\n') : [];
    const parsed = [];
    for (const line of lines.slice(-limit)) {
      try {
        if (line.trim()) {
          parsed.push(JSON.parse(line));
        }
      } catch (error) {
        logger.warn('failed to parse ndjson line', { path: targetPath, error: error.message });
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

async function readAllNdjsonFile(targetPath) {
  try {
    const raw = await readFile(targetPath, 'utf8');
    const lines = raw.trim() ? raw.trim().split('\n') : [];
    const parsed = [];
    for (const line of lines) {
      try {
        if (line.trim()) {
          parsed.push(JSON.parse(line));
        }
      } catch (error) {
        logger.warn('failed to parse ndjson line', { path: targetPath, error: error.message });
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

async function readOptionalTextFile(targetPath) {
  try {
    return await readFile(targetPath, 'utf8');
  } catch {
    return null;
  }
}

async function readSummaryFile(runDir) {
  try {
    return JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8'));
  } catch {
    return null;
  }
}

function matchesQuery(item, query) {
  if (!query) {
    return true;
  }

  const haystack = JSON.stringify(item).toLowerCase();
  return haystack.includes(String(query).toLowerCase());
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function extractProvidedApiKey(req) {
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) {
    return headerKey.trim();
  }

  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function inferErrorStatus(error) {
  if (error instanceof AppError) {
    return error.statusCode;
  }

  if (error instanceof OmniCrawlError) {
    if (typeof error.statusCode === 'number') {
      return error.statusCode;
    }
    if (typeof error.code === 'string' && /^HTTP_\d{3}$/.test(error.code)) {
      return Number.parseInt(error.code.slice(5), 10);
    }
    switch (error.code) {
      case 'VALIDATION_ERROR':
      case 'SCHEMA_VALIDATION_ERROR':
      case 'CONFIGURATION_ERROR':
      case 'PARSING_ERROR':
      case 'AST_PARSE_ERROR':
      case 'SELECTOR_ERROR':
        return 400;
      case 'RATE_LIMIT':
        return 429;
      case 'TIMEOUT':
        return 408;
      case 'NETWORK_ERROR':
      case 'PROXY_ERROR':
      case 'RESOURCE_ERROR':
      case 'BROWSER_POOL_EXHAUSTED':
      case 'STORAGE_ERROR':
        return 503;
      default:
        return 500;
    }
  }

  if (Array.isArray(error?.issues)) {
    return 400;
  }

  return 500;
}

function serializeError(error) {
  if (error instanceof AppError) {
    return {
      error: error.message,
      code: error.code,
      details: error.details,
      recoverable: error.recoverable,
    };
  }

  if (error instanceof OmniCrawlError) {
    return {
      error: error.message,
      code: error.code,
      details: error.context,
      recoverable: error.recoverable,
    };
  }

  if (Array.isArray(error?.issues)) {
    return {
      error: 'workflow validation failed',
      code: 'SCHEMA_VALIDATION_ERROR',
      details: {
        issues: error.issues,
      },
      recoverable: false,
    };
  }

  return {
    error: error?.message ?? 'internal server error',
  };
}

function paginate(items, { offset = 0, limit = 50 } = {}) {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(1, limit);
  return {
    total: items.length,
    offset: safeOffset,
    limit: safeLimit,
    items: items.slice(safeOffset, safeOffset + safeLimit),
  };
}

function flattenRecord(record) {
  return {
    sequence: record.sequence ?? '',
    url: record.url ?? '',
    finalUrl: record.finalUrl ?? '',
    mode: record.mode ?? '',
    status: record.status ?? '',
    depth: record.depth ?? '',
    sessionId: record.sessionId ?? '',
    proxyLabel: record.proxyLabel ?? '',
    proxyServer: record.proxyServer ?? '',
    attemptsUsed: record.attemptsUsed ?? '',
    extracted: JSON.stringify(record.extracted ?? {}),
  };
}

function toCsv(records) {
  const rows = records.map(flattenRecord);
  const headers = ['sequence', 'url', 'finalUrl', 'mode', 'status', 'depth', 'sessionId', 'proxyLabel', 'proxyServer', 'attemptsUsed', 'extracted'];
  const escapeCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escapeCell(row[header])).join(',')),
  ].join('\n');
}

function compareJobs(leftJob, rightJob, leftResults, rightResults) {
  const leftUrls = new Set(leftResults.map((item) => item.finalUrl ?? item.url));
  const rightUrls = new Set(rightResults.map((item) => item.finalUrl ?? item.url));
  const sharedUrls = [...leftUrls].filter((url) => rightUrls.has(url));
  const leftOnlyUrls = [...leftUrls].filter((url) => !rightUrls.has(url));
  const rightOnlyUrls = [...rightUrls].filter((url) => !leftUrls.has(url));

  return {
    left: {
      jobId: leftJob.jobId ?? leftJob.id,
      workflowName: leftJob.workflowName,
      status: leftJob.status,
      pagesFetched: leftJob.pagesFetched ?? leftJob.stats?.pagesFetched ?? 0,
      resultCount: leftJob.resultCount ?? leftJob.stats?.resultCount ?? 0,
      failureCount: leftJob.failureCount ?? leftJob.stats?.failureCount ?? 0,
    },
    right: {
      jobId: rightJob.jobId ?? rightJob.id,
      workflowName: rightJob.workflowName,
      status: rightJob.status,
      pagesFetched: rightJob.pagesFetched ?? rightJob.stats?.pagesFetched ?? 0,
      resultCount: rightJob.resultCount ?? rightJob.stats?.resultCount ?? 0,
      failureCount: rightJob.failureCount ?? rightJob.stats?.failureCount ?? 0,
    },
    overlap: {
      sharedCount: sharedUrls.length,
      leftOnlyCount: leftOnlyUrls.length,
      rightOnlyCount: rightOnlyUrls.length,
      sharedUrls: sharedUrls.slice(0, 20),
      leftOnlyUrls: leftOnlyUrls.slice(0, 20),
      rightOnlyUrls: rightOnlyUrls.slice(0, 20),
    },
  };
}

function summarizeHistoryHealth(items = []) {
  const terminalItems = items.filter((item) => item && item.status !== 'queued' && item.status !== 'running');
  const healthScores = terminalItems
    .map((item) => item.quality?.healthScore)
    .filter((value) => Number.isFinite(value));
  const averageHealthScore = healthScores.length === 0
    ? null
    : healthScores.reduce((sum, value) => sum + value, 0) / healthScores.length;
  const warningRuns = terminalItems.filter((item) =>
    (item.quality?.alerts?.length ?? 0) > 0
    || (item.baseline?.alerts?.length ?? 0) > 0
    || (item.trend?.alerts?.length ?? 0) > 0);
  const deliveredAlerts = terminalItems.filter((item) => item.alertDelivery?.delivered);

  return {
    averageHealthScore,
    warningRuns: warningRuns.length,
    deliveredAlerts: deliveredAlerts.length,
    latestDeliveredAt: deliveredAlerts[0]?.finishedAt ?? null,
  };
}

function summarizeObservabilityHealth(items = []) {
  const observabilityItems = items
    .map((item) => item?.observability)
    .filter(Boolean);

  const tracingEnabledRuns = observabilityItems.filter((item) => item.config?.tracing?.enabled !== false);
  const metricsEnabledRuns = observabilityItems.filter((item) => item.config?.metrics?.enabled !== false);

  return {
    enabledRuns: observabilityItems.length,
    tracingEnabledRuns: tracingEnabledRuns.length,
    metricsEnabledRuns: metricsEnabledRuns.length,
    spanCount: observabilityItems.reduce((sum, item) => sum + (item.tracing?.spanCount ?? 0), 0),
    errorSpanCount: observabilityItems.reduce((sum, item) => sum + (item.tracing?.errorSpanCount ?? 0), 0),
    counterCount: observabilityItems.reduce((sum, item) => sum + (item.metrics?.counters?.length ?? 0), 0),
    histogramCount: observabilityItems.reduce((sum, item) => sum + (item.metrics?.histograms?.length ?? 0), 0),
  };
}

async function resolveJobRecord({ jobId, jobStore, historyStore }) {
  const active = jobStore.get(jobId);
  if (active) {
    return active;
  }

  return historyStore.get(jobId);
}

async function readJobKeyValueRecord({ controlPlane, dataPlane, projectRoot, storeId, key }) {
  if (controlPlane.enabled) {
    await dataPlane.init();
    return dataPlane.getRecord(storeId, key);
  }

  return KeyValueStore.getRecord({
    projectRoot,
    storeId,
    key,
  });
}

async function readJobChangeFeed({ controlPlane, dataPlane, projectRoot, jobId }) {
  const record = await readJobKeyValueRecord({
    controlPlane,
    dataPlane,
    projectRoot,
    storeId: jobId,
    key: 'CHANGE_FEED',
  });
  return Array.isArray(record?.value) ? record.value : [];
}

async function readJobChangeSummary({ controlPlane, dataPlane, projectRoot, jobId }) {
  const record = await readJobKeyValueRecord({
    controlPlane,
    dataPlane,
    projectRoot,
    storeId: jobId,
    key: 'CHANGE_TRACKING',
  });
  return record?.value ?? null;
}

async function readJobFailedRequests({ controlPlane, dataPlane, projectRoot, jobId }) {
  const record = await readJobKeyValueRecord({
    controlPlane,
    dataPlane,
    projectRoot,
    storeId: jobId,
    key: 'FAILED_REQUESTS',
  });
  return Array.isArray(record?.value) ? record.value : [];
}

async function readJobDiagnostics({ controlPlane, dataPlane, projectRoot, jobId, runDir = null }) {
  if (controlPlane.enabled) {
    await dataPlane.init();
    return dataPlane.getRecord(jobId, 'DIAGNOSTICS')?.value ?? dataPlane.readArtifactJson(jobId, 'summary.json')?.diagnostics ?? null;
  }

  const record = await KeyValueStore.getRecord({
    projectRoot,
    storeId: jobId,
    key: 'DIAGNOSTICS',
  });
  if (record?.value) {
    return record.value;
  }

  if (!runDir) {
    return null;
  }

  return (await readSummaryFile(runDir))?.diagnostics ?? null;
}

async function readJobReplayRecipe({ controlPlane, dataPlane, projectRoot, jobId, runDir = null }) {
  const record = await readJobKeyValueRecord({
    controlPlane,
    dataPlane,
    projectRoot,
    storeId: jobId,
    key: 'REPLAY_RECIPE',
  });
  if (record?.value) {
    return record.value;
  }

  const diagnostics = await readJobDiagnostics({
    controlPlane,
    dataPlane,
    projectRoot,
    jobId,
    runDir,
  });
  return diagnostics?.recipe ?? null;
}

async function readJobResults({ dataPlane, runDir = null, jobId }) {
  if (dataPlane && typeof dataPlane.listResults === 'function') {
    return dataPlane.listResults(jobId, {
      offset: 0,
      limit: 1000,
      query: '',
    })?.items ?? [];
  }

  if (!runDir) {
    return [];
  }

  return readAllNdjsonFile(join(runDir, 'results.ndjson'));
}

async function readJobAuthStatePlan({ controlPlane, dataPlane, projectRoot, jobId, runDir = null }) {
  const diagnostics = await readJobDiagnostics({
    controlPlane,
    dataPlane,
    projectRoot,
    jobId,
    runDir,
  });
  if (diagnostics?.authStatePlan) {
    return diagnostics.authStatePlan;
  }

  const results = await readJobResults({
    dataPlane,
    runDir,
    jobId,
  });

  return deriveAuthStatePlanFromResults(results);
}

async function loadWorkflowSnapshotForJob({ controlPlane, jobStore, historyStore, jobId }) {
  return controlPlane.enabled
    ? jobStore.loadWorkflow(jobId)
    : await historyStore.loadWorkflowForJob(jobId);
}

async function readWorkflowSnapshotFromRunDir(runDir) {
  if (!runDir) {
    return null;
  }

  try {
    const raw = await readFile(join(runDir, 'workflow.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.workflow ?? null;
  } catch {
    return null;
  }
}

async function loadResumeWorkflowSnapshot({ controlPlane, jobStore, job }) {
  if (controlPlane.enabled) {
    return jobStore.loadWorkflow(job.id);
  }

  return readWorkflowSnapshotFromRunDir(job.runDir);
}

export function createApp({
  projectRoot = process.cwd(),
  jobStore,
  historyStore,
  workflowRegistry,
  sessionStore,
  proxyPool,
  distributed,
  apiKey = process.env.OMNICRAWL_API_KEY,
} = {}) {
  const controlPlane = resolveDistributedConfig({ projectRoot, distributed });
  jobStore ??= controlPlane.enabled
    ? controlPlane.backend === 'redis'
      ? new RedisJobStore({ redis: controlPlane.redis, workerId: controlPlane.workerId })
      : new SqliteJobStore({ dbPath: controlPlane.dbPath, workerId: controlPlane.workerId })
    : new JobStore({ projectRoot });
  historyStore ??= new HistoryStore({ projectRoot });
  workflowRegistry ??= new WorkflowRegistry({ projectRoot });
  sessionStore ??= new SessionStore({ projectRoot });
  proxyPool ??= new ProxyPool({ projectRoot });
  const dataPlane = controlPlane.enabled ? new SqliteDataPlane({ dbPath: controlPlane.dbPath }) : null;
  const reverseLabManager = new ReverseLabManager({ projectRoot });
  const alertOutbox = new AlertOutboxService({ projectRoot, logger });
  const appCaptureManager = new AppCaptureManager({ projectRoot });
  const antiBotLab = new AntiBotLab({ path: join(projectRoot, '.omnicrawl', 'anti-bot-lab.json') });
  const accountPool = new AccountPool({ path: join(projectRoot, '.omnicrawl', 'accounts.json') });
  const devicePool = new DevicePool({ path: join(projectRoot, '.omnicrawl', 'devices.json') });
  const humanInteractionBroker = new HumanInteractionBroker({ path: join(projectRoot, '.omnicrawl', 'human-challenges.json') });
  const resourceScheduler = new ResourceScheduler();
  const tenantRegistry = new TenantRegistry({ path: join(projectRoot, '.omnicrawl', 'tenants.json') });
  const accessPolicy = new AccessPolicy({
    policies: [
      { id: 'admin-all', roles: ['admin'], actions: ['*'], resources: ['*'] },
      { id: 'operator-platform', roles: ['operator'], actions: ['platform.*', 'jobs.*', 'workflows.*'], resources: ['tenant:*'] },
      { id: 'viewer-read', roles: ['viewer'], actions: ['*.read', 'platform.*.read'], resources: ['tenant:*'] },
    ],
  });
  const auditLogger = new AuditLogger({ path: join(projectRoot, '.omnicrawl', 'audit.ndjson'), actor: 'api' });
  const credentialVault = new CredentialVault({
    path: join(projectRoot, '.omnicrawl', 'credentials.json'),
    masterKey: process.env.OMNICRAWL_VAULT_KEY,
  });
  const app = express();

  if (apiKey) {
    app.use((req, res, next) => {
      const providedKey = extractProvidedApiKey(req);
      if (providedKey !== apiKey) {
        return res.status(401).json({ error: 'unauthorized: valid api key required' });
      }
      next();
    });
  }

  const activeRuns = new Set();
  const activeJobs = new Map();

  function startManagedWorkflow(workflow, { source = 'inline', metadata = {}, jobId = null, reuseExisting = false } = {}) {
    let job;

    if (jobId && activeJobs.has(jobId)) {
      throw new AppError(409, `job is already active: ${jobId}`);
    }

    if (reuseExisting && jobId) {
      const existing = jobStore.get(jobId);
      if (!existing) {
        throw new AppError(404, `job not found: ${jobId}`);
      }

      job =
        jobStore.update(jobId, {
          workflowName: workflow.name,
          metadata,
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          stats: {
            pagesFetched: 0,
            resultCount: 0,
            failureCount: 0,
          },
        }) ?? existing;
    } else {
      job = jobStore.create({
        workflowName: workflow.name,
        metadata,
      });
    }

    const promise = runWorkflow(workflow, {
      projectRoot,
      jobStore,
      historyStore,
      sessionStore,
      proxyPool,
      jobId: job.id,
      source,
      metadata,
      controlPlane,
      dataPlane,
      alertOutbox,
    });
    activeRuns.add(promise);
    activeJobs.set(job.id, promise);
    promise.finally(() => {
      activeRuns.delete(promise);
      activeJobs.delete(job.id);
    });

    return { job, promise };
  }

  function enqueueDistributedWorkflow(workflow, { source = 'inline', metadata = {}, jobId = null, reuseExisting = false } = {}) {
    if (!controlPlane.enabled) {
      throw new Error('distributed control plane is not enabled');
    }

    if (reuseExisting && jobId) {
      const queued = jobStore.requeueJob(jobId, {
        workflow,
        source,
        metadata,
      });

      if (!queued) {
        throw new AppError(404, `job not found: ${jobId}`);
      }

      return { job: queued };
    }

    return {
      job: jobStore.createQueuedWorkflow({
        workflow,
        source,
        metadata,
        jobId,
      }),
    };
  }

  const scheduler = controlPlane.enabled
    ? new SqliteScheduleManager({
        workflowRegistry,
        jobStore,
        controlPlane,
      })
    : new ScheduleManager({
        projectRoot,
        workflowRegistry,
        jobStore,
        historyStore,
        launchWorkflow: async (workflow, options) => {
          const launched = startManagedWorkflow(workflow, options);
          return launched.promise;
        },
      });

  const distributedWorker = controlPlane.enabled && controlPlane.workerEnabled
    ? new DistributedWorkerService({
        projectRoot,
        jobStore,
        historyStore,
        sessionStore,
        proxyPool,
        alertOutbox,
        controlPlane,
        dataPlane,
        activeRuns,
      })
    : null;
  const gcService = controlPlane.enabled && controlPlane.gcEnabled
    ? new SqliteGcService({
        dataPlane,
        pollMs: controlPlane.gcPollMs,
        retentionMs: controlPlane.gcRetentionMs,
        batchSize: controlPlane.gcBatchSize,
      })
    : null;

  async function listResultsForJob(jobId, options = {}) {
    if (controlPlane.enabled) {
      await dataPlane.init();
      return dataPlane.listResults(jobId, options);
    }

    const query = String(options.query ?? '').trim();
    const filtered = (await readAllNdjsonFile(join(jobStore.get(jobId)?.runDir ?? '', 'results.ndjson')))
      .filter((item) => matchesQuery(item, query));
    return paginate(filtered, {
      offset: options.offset ?? 0,
      limit: options.limit ?? 50,
    });
  }

  async function listEventsForJob(jobId, options = {}) {
    if (controlPlane.enabled) {
      await dataPlane.init();
      return dataPlane.listEvents(jobId, options);
    }

    const query = String(options.query ?? '').trim();
    const type = String(options.type ?? '').trim();
    const filtered = (await readAllNdjsonFile(join(jobStore.get(jobId)?.runDir ?? '', 'events.ndjson')))
      .filter((item) => (!type ? true : item.type === type))
      .filter((item) => matchesQuery(item, query));

    return paginate(filtered, {
      offset: options.offset ?? 0,
      limit: options.limit ?? 100,
    });
  }

  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => {
    res.redirect('/dashboard');
  });

  app.get('/dashboard', (_req, res) => {
    res.type('html').send(renderDashboard());
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      ...getCapabilities(),
    });
  });

  app.get('/capabilities', (_req, res) => {
    res.json(getCapabilities());
  });

  app.post('/platform/login/analyze', async (req, res, next) => {
    try {
      const input = getObject(req.body);
      const observation = getObject(input.observation ?? input);
      const classification = classifyLoginObservation(observation);
      const plan = buildLoginRecoveryPlan(classification, getObject(input.options));
      await auditLogger.record('platform.login.analyze', {
        tenantId: input.tenantId ?? null,
        target: observation.url ?? observation.finalUrl ?? null,
        details: {
          state: classification.state,
          reasons: classification.reasons,
        },
      });
      res.json({ item: { classification, plan } });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/universal/plan', (req, res, next) => {
    try {
      res.json({ item: buildUniversalCrawlPlan(getObject(req.body)) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/login/state-machine', async (req, res, next) => {
    try {
      const input = getObject(req.body);
      const observations = Array.isArray(input.observations) ? input.observations : [getObject(input.observation)];
      const machine = new LoginStateMachine(getObject(input.options));
      const events = observations.map((observation) => machine.observe(observation));
      const plan = machine.plan(getObject(input.planOptions));
      res.json({
        item: {
          state: machine.state,
          events,
          plan,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/login/interactive-plan', async (req, res, next) => {
    try {
      const input = getObject(req.body);
      const item = buildInteractiveLoginPlan(getObject(input.observation), getObject(input.options));
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.get('/platform/human-challenges', (req, res) => {
    res.json({
      items: humanInteractionBroker.list({
        status: req.query.status ? String(req.query.status) : null,
        tenantId: req.query.tenantId ? String(req.query.tenantId) : null,
      }),
    });
  });

  app.post('/platform/human-challenges', async (req, res, next) => {
    try {
      const item = humanInteractionBroker.createChallenge(getObject(req.body));
      await auditLogger.record('human-challenge.create', {
        tenantId: item.tenantId,
        target: item.id,
        details: { type: item.type, accountId: item.accountId },
      });
      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/human-challenges/:challengeId/resolve', async (req, res, next) => {
    try {
      const item = humanInteractionBroker.resolveChallenge(req.params.challengeId, getObject(req.body));
      if (!item) {
        throw new AppError(404, 'human challenge not found');
      }
      await auditLogger.record('human-challenge.resolve', {
        tenantId: item.tenantId,
        target: item.id,
        details: { status: item.status },
      });
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.get('/platform/tenants', (_req, res) => {
    res.json({ items: tenantRegistry.list() });
  });

  app.post('/platform/tenants', async (req, res, next) => {
    try {
      const item = tenantRegistry.upsert(getObject(req.body));
      if (Object.keys(item.quotas ?? {}).length > 0) {
        resourceScheduler.setQuota(item.id, item.quotas);
      }
      await auditLogger.record('tenant.upsert', {
        tenantId: item.id,
        target: item.id,
        details: { status: item.status, quotas: item.quotas },
      });
      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/tenants/:tenantId/status', async (req, res, next) => {
    try {
      const item = tenantRegistry.setStatus(req.params.tenantId, req.body?.status);
      if (!item) {
        throw new AppError(404, 'tenant not found');
      }
      await auditLogger.record('tenant.status', {
        tenantId: item.id,
        target: item.id,
        details: { status: item.status },
      });
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.get('/platform/accounts', (_req, res) => {
    res.json({ items: accountPool.snapshot() });
  });

  app.post('/platform/accounts', async (req, res, next) => {
    try {
      const item = accountPool.upsert(getObject(req.body));
      await auditLogger.record('account.upsert', {
        tenantId: item.tenantId,
        target: item.id,
        details: { siteId: item.siteId, labels: item.labels },
      });
      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/accounts/lease', (req, res, next) => {
    try {
      const input = getObject(req.body);
      const pool = Array.isArray(input.accounts) ? new AccountPool({
        accounts: input.accounts,
        leaseMs: input.leaseMs,
        cooldownMs: input.cooldownMs,
        maxConsecutiveFailures: input.maxConsecutiveFailures,
      }) : accountPool;
      const lease = pool.lease(getObject(input.scope));
      if (input.result?.accountId) {
        pool.release(String(input.result.accountId), getObject(input.result));
      }
      res.json({
        item: lease,
        snapshot: pool.snapshot(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/accounts/release', async (req, res, next) => {
    try {
      const input = getObject(req.body);
      const accountId = String(input.accountId ?? '').trim();
      if (!accountId) {
        throw new AppError(400, 'accountId is required');
      }
      const item = accountPool.release(accountId, getObject(input.result));
      if (!item) {
        throw new AppError(404, 'account not found');
      }
      await auditLogger.record('account.release', {
        tenantId: item.tenantId,
        target: item.id,
        details: { ok: input.result?.ok, score: item.score },
      });
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/accounts/:accountId/enabled', async (req, res, next) => {
    try {
      const item = accountPool.setEnabled(req.params.accountId, req.body?.enabled !== false);
      if (!item) {
        throw new AppError(404, 'account not found');
      }
      await auditLogger.record('account.enabled', {
        tenantId: item.tenantId,
        target: item.id,
        details: { enabled: !item.disabled },
      });
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/app-capture/plan', (req, res, next) => {
    try {
      const input = getObject(req.body);
      res.json({
        item: buildAppCapturePlan(input),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/app-capture/merge-streams', (req, res, next) => {
    try {
      res.json({
        item: mergeAppCaptureStreams(getObject(req.body)),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/platform/devices', (_req, res) => {
    res.json({ items: devicePool.snapshot() });
  });

  app.post('/platform/devices', async (req, res, next) => {
    try {
      const item = devicePool.upsert(getObject(req.body));
      await auditLogger.record('device.upsert', {
        tenantId: req.body?.tenantId ?? null,
        target: item.id,
        details: { platform: item.platform, labels: item.labels },
      });
      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/devices/lease', (req, res, next) => {
    try {
      const item = devicePool.lease(getObject(req.body?.scope ?? req.body));
      res.json({ item, snapshot: devicePool.snapshot() });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/mobile-app/execution-plan', (req, res, next) => {
    try {
      const item = buildMobileAppExecutionPlan(getObject(req.body));
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/mobile-app/execute-plan', async (req, res, next) => {
    try {
      const input = getObject(req.body);
      const plan = input.plan ?? buildMobileAppExecutionPlan(input);
      const item = await executeMobileAppPlan(plan, {}, { dryRun: input.dryRun !== false });
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/attestation/compliance-plan', (req, res, next) => {
    try {
      res.json({ item: buildAttestationCompliancePlan(getObject(req.body?.signal ?? req.body), getObject(req.body?.options)) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/protocol/semantics', (req, res, next) => {
    try {
      const input = getObject(req.body);
      const kind = String(input.kind ?? input.protocol ?? '').toLowerCase();
      const item =
        kind === 'graphql'
          ? inferGraphQLSemantics(getObject(input.schema), getObject(input.options))
          : kind === 'websocket' || kind === 'ws'
            ? inferWebSocketSemantics(Array.isArray(input.transcript) ? input.transcript : [])
            : kind === 'grpc' || kind === 'protobuf'
              ? inferGrpcSemantics(Array.isArray(input.samples) ? input.samples : [])
              : null;
      if (!item) {
        throw new AppError(400, 'kind must be graphql, websocket, or grpc');
      }
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/anti-bot/experiments', (req, res, next) => {
    try {
      const input = getObject(req.body);
      const matrix = antiBotLab.buildExperimentMatrix({
        siteId: input.siteId,
        proxies: Array.isArray(input.proxies) ? input.proxies : [],
        identities: Array.isArray(input.identities) ? input.identities : [],
        browsers: Array.isArray(input.browsers) ? input.browsers : [],
      });
      res.json({
        items: matrix,
        total: matrix.length,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/anti-bot/results', (req, res, next) => {
    try {
      const input = getObject(req.body);
      const item = antiBotLab.recordExperiment(input);
      res.json({
        item,
        degraded: detectDegradedPage(input),
        successRates: antiBotLab.successRates(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/orchestration/reserve', (req, res, next) => {
    try {
      const task = getObject(req.body);
      const reservation = resourceScheduler.reserve(task);
      res.json({
        accepted: Boolean(reservation),
        reservation,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/platform/orchestration/quotas', (_req, res) => {
    res.json({ item: resourceScheduler.snapshot() });
  });

  app.post('/platform/orchestration/quotas', async (req, res, next) => {
    try {
      const input = getObject(req.body);
      const tenantId = String(input.tenantId ?? '').trim();
      if (!tenantId) {
        throw new AppError(400, 'tenantId is required');
      }
      const item = resourceScheduler.setQuota(tenantId, getObject(input.quota));
      const tenant = tenantRegistry.get(tenantId);
      if (tenant) {
        tenantRegistry.upsert({
          ...tenant,
          quotas: item.quota,
        });
      }
      await auditLogger.record('quota.set', {
        tenantId,
        target: tenantId,
        details: { quota: item.quota },
      });
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/orchestration/dag-plan', (req, res, next) => {
    try {
      const input = getObject(req.body);
      const nodes = Array.isArray(input.nodes) ? input.nodes : [];
      res.json({
        item: buildDagExecutionPlan(nodes),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/data/lineage', (req, res, next) => {
    try {
      res.json({
        item: createLineageRecord(getObject(req.body)),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/data/schema/evolve', (req, res, next) => {
    try {
      const input = getObject(req.body);
      res.json({
        item: evolveSchemaVersion(getObject(input.schema), getObject(input.observedFields)),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/self-healing/patch-plan', (req, res, next) => {
    try {
      res.json({
        item: buildAutoPatchPlan(getObject(req.body)),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/platform/governance/audit', (_req, res) => {
    res.json({ items: auditLogger.list() });
  });

  app.get('/platform/governance/access/policies', (_req, res) => {
    res.json({ items: accessPolicy.list() });
  });

  app.post('/platform/governance/access/evaluate', async (req, res, next) => {
    try {
      const input = getObject(req.body);
      const item = accessPolicy.evaluate({
        tenantId: input.tenantId,
        roles: Array.isArray(input.roles) ? input.roles : [],
        action: input.action,
        resource: input.resource,
      });
      await auditLogger.record('access.evaluate', {
        tenantId: input.tenantId,
        target: input.resource,
        details: { action: input.action, roles: input.roles, allowed: item.allowed, reason: item.reason },
      });
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/governance/audit', async (req, res, next) => {
    try {
      const input = getObject(req.body);
      const item = await auditLogger.record(String(input.action ?? 'platform.event'), {
        actor: input.actor,
        tenantId: input.tenantId,
        target: input.target,
        details: getObject(input.details),
      });
      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/platform/governance/credentials', async (req, res, next) => {
    try {
      const item = credentialVault.put(getObject(req.body));
      await auditLogger.record('credential.create', {
        tenantId: item.tenantId,
        target: item.id,
        details: { name: item.name, scope: item.scope },
      });
      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.get('/platform/governance/credentials/:tenantId/:name', (req, res) => {
    const id = `${req.params.tenantId}:${req.params.name}`;
    const item = credentialVault.describe(id);
    if (!item) {
      res.status(404).json({ error: 'credential not found' });
      return;
    }
    res.json({ item });
  });

  app.get('/tools/workflow-templates', (_req, res) => {
    res.json({ items: getWorkflowTemplateCatalog() });
  });

  app.post('/tools/workflow-templates/build', (req, res, next) => {
    try {
      const item = buildWorkflowFromTemplate(getObject(req.body));
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/tools/universal-workflow/build', (req, res, next) => {
    try {
      const item = buildWorkflowFromUniversalTarget(getObject(req.body));
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/tools/extract-preview', async (req, res, next) => {
    try {
      const input = getObject(req.body);
      const workflow = buildPreviewWorkflow({
        url: input.url,
        sourceType: input.sourceType,
        renderWaitMs: input.renderWaitMs,
        rule: getObject(input.rule),
      });
      const summary = await runWorkflow(workflow, {
        projectRoot,
        source: 'extract-preview',
        metadata: { trigger: 'extract-preview' },
      });
      const results = await readAllNdjsonFile(join(summary.runDir, 'results.ndjson'));
      const firstResult = results[0] ?? null;
      const ruleName = workflow.extract[0]?.name ?? 'preview';
      res.json({
        item: {
          summary,
          result: firstResult,
          extracted: firstResult?.extracted?.[ruleName] ?? null,
          meta: firstResult?._meta ?? firstResult?.extracted?._meta ?? null,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/tools/field-picker/document', async (req, res, next) => {
    try {
      const html = await renderFieldPickerDocument({
        url: String(req.query.url ?? ''),
        sourceType: String(req.query.sourceType ?? 'static-page'),
        renderWaitMs: toInt(req.query.renderWaitMs, 800),
      });
      res.type('html').send(html);
    } catch (error) {
      next(error);
    }
  });

  app.get('/tools/app-capture/sessions', (_req, res) => {
    res.json(appCaptureManager.list());
  });

  app.get('/tools/app-capture/sessions/:sessionId', (req, res) => {
    const item = appCaptureManager.get(req.params.sessionId);
    if (!item) {
      res.status(404).json({ error: 'capture session not found' });
      return;
    }
    res.json({ item });
  });

  app.get('/tools/app-capture/sessions/:sessionId/files', (req, res) => {
    const item = appCaptureManager.get(req.params.sessionId);
    if (!item) {
      res.status(404).json({ error: 'capture session not found' });
      return;
    }

    const captureDir = typeof item.captureDir === 'string' ? item.captureDir : null;
    const generated = item.generated && typeof item.generated === 'object' ? item.generated : {};
    const items = Object.entries(generated)
      .filter(([, filePath]) => typeof filePath === 'string' && filePath.trim())
      .map(([key, filePath]) => ({
        key,
        name: basename(filePath),
        relativePath:
          captureDir && filePath.startsWith(captureDir)
            ? filePath.slice(captureDir.length).replace(/^[\\/]+/, '')
            : basename(filePath),
        path: filePath,
      }));

    res.json({
      sessionId: item.id,
      captureDir,
      items,
    });
  });

  app.get('/tools/app-capture/sessions/:sessionId/files/:fileKey', async (req, res) => {
    const item = appCaptureManager.get(req.params.sessionId);
    if (!item) {
      res.status(404).json({ error: 'capture session not found' });
      return;
    }

    const captureDir = typeof item.captureDir === 'string' ? resolve(item.captureDir) : null;
    const generated = item.generated && typeof item.generated === 'object' ? item.generated : {};
    const rawPath = generated[req.params.fileKey];

    if (!captureDir || typeof rawPath !== 'string' || !rawPath.trim()) {
      res.status(404).json({ error: 'capture file not found' });
      return;
    }

    const resolvedPath = resolve(rawPath);
    if (!resolvedPath.startsWith(captureDir)) {
      res.status(404).json({ error: 'capture file not found' });
      return;
    }

    const content = await readOptionalTextFile(resolvedPath);
    if (content === null) {
      res.status(404).json({ error: 'capture file not found' });
      return;
    }

    res.json({
      sessionId: item.id,
      item: {
        key: req.params.fileKey,
        name: basename(resolvedPath),
        path: resolvedPath,
        content,
      },
    });
  });

  app.get('/tools/app-capture/sessions/:sessionId/asset', async (req, res, next) => {
    try {
      const item = appCaptureManager.get(req.params.sessionId);
      if (!item) {
        res.status(404).json({ error: 'capture session not found' });
        return;
      }
      if (!item.assetRef?.assetId) {
        res.status(404).json({ error: 'capture asset not found' });
        return;
      }

      const assetStore = await new ReverseAssetStore({ projectRoot, workflowName: 'tool-app-capture' }).init();
      const asset = await assetStore.readLatestAsset('app-captures', item.assetRef.assetId);
      if (!asset) {
        res.status(404).json({ error: 'capture asset not found' });
        return;
      }

      res.json({
        sessionId: item.id,
        assetRef: item.assetRef,
        item: asset,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/tools/app-capture/start', async (req, res, next) => {
    try {
      const item = await appCaptureManager.start({
        app: getObject(req.body?.app),
        options: getObject(req.body?.options),
      });
      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/tools/app-capture/sessions/:sessionId/stop', async (req, res) => {
    const item = await appCaptureManager.stop(req.params.sessionId);
    if (!item) {
      res.status(404).json({ error: 'capture session not found' });
      return;
    }
    res.json({ item });
  });

  app.get('/reverse/capabilities', (_req, res) => {
    res.json(getReverseCapabilitySnapshot());
  });

  function registerReverseRoute({ method = 'post', path, operation, includeQuery = false }) {
    app[method](path, async (req, res, next) => {
      try {
        const input = {
          ...(includeQuery ? req.query : {}),
          ...(getObject(req.body) ?? {}),
          operation,
          pool: {
            ...(getObject(req.body)?.pool ?? {}),
            namespace: projectRoot,
          },
        };
        const result = await runReverseOperation(input);
        res.json({ result });
      } catch (error) {
        next(error);
      }
    });
  }

  function getObject(value) {
    return value && typeof value === 'object' ? value : {};
  }

  const reverseAssetCollections = {
    signers: 'signers',
    regressions: 'regressions',
    appCaptures: 'app-captures',
    aiSurfaces: 'ai-surfaces',
  };

  app.get('/tools/reverse-assets/app-captures', async (_req, res, next) => {
    try {
      const assetStore = await new ReverseAssetStore({ projectRoot, workflowName: 'tool-app-capture' }).init();
      const snapshot = assetStore.snapshot();
      res.json({
        items: Array.isArray(snapshot.appCaptures) ? snapshot.appCaptures : [],
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/tools/reverse-assets/app-captures/:assetId', async (req, res, next) => {
    try {
      const assetStore = await new ReverseAssetStore({ projectRoot, workflowName: 'tool-app-capture' }).init();
      const item = await assetStore.readLatestAsset('app-captures', req.params.assetId);
      if (!item) {
        throw new AppError(404, 'reverse asset not found');
      }
      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.get('/jobs/:jobId/reverse-assets', async (req, res, next) => {
    try {
      const job = await resolveJobRecord({
        jobId: req.params.jobId,
        jobStore,
        historyStore,
      });

      if (!job) {
        throw new AppError(404, 'job not found');
      }

      const assetStore = await new ReverseAssetStore({ projectRoot }).init();
      const snapshot = assetStore.snapshot();
      const items = Object.fromEntries(
        Object.keys(reverseAssetCollections).map((collection) => [
          collection,
          (Array.isArray(snapshot[collection]) ? snapshot[collection] : [])
            .filter((entry) => entry.jobId === req.params.jobId),
        ]),
      );

      res.json({
        jobId: req.params.jobId,
        items,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/jobs/:jobId/reverse-assets/item', async (req, res, next) => {
    try {
      const job = await resolveJobRecord({
        jobId: req.params.jobId,
        jobStore,
        historyStore,
      });

      if (!job) {
        throw new AppError(404, 'job not found');
      }

      const collection = String(req.query.collection ?? '').trim();
      const assetId = String(req.query.assetId ?? '').trim();

      if (!Object.hasOwn(reverseAssetCollections, collection)) {
        throw new AppError(400, 'valid collection query param is required');
      }

      if (!assetId) {
        throw new AppError(400, 'assetId query param is required');
      }

      const assetStore = await new ReverseAssetStore({ projectRoot }).init();
      const item = await assetStore.readLatestAsset(reverseAssetCollections[collection], assetId);

      if (!item || item.jobId !== req.params.jobId) {
        throw new AppError(404, 'reverse asset not found');
      }

      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  registerReverseRoute({
    path: '/reverse/analyze',
    operation: 'analyze',
  });

  registerReverseRoute({
    path: '/reverse/workflow',
    operation: 'workflow.analyze',
  });

  registerReverseRoute({
    path: '/reverse/ai/analyze',
    operation: 'ai.analyze',
  });

  registerReverseRoute({
    path: '/reverse/execute',
    operation: 'js.execute',
  });

  registerReverseRoute({
    path: '/reverse/invoke',
    operation: 'js.invoke',
  });

  registerReverseRoute({
    path: '/reverse/crypto/analyze',
    operation: 'crypto.analyze',
  });

  registerReverseRoute({
    path: '/reverse/crypto/identify',
    operation: 'crypto.identify',
  });

  registerReverseRoute({
    path: '/reverse/crypto/encrypt',
    operation: 'crypto.encrypt',
  });

  registerReverseRoute({
    path: '/reverse/crypto/decrypt',
    operation: 'crypto.decrypt',
  });

  registerReverseRoute({
    path: '/reverse/crypto/hmac',
    operation: 'crypto.hmac',
  });

  registerReverseRoute({
    path: '/reverse/ast/control-flow',
    operation: 'ast.controlFlow',
  });

  registerReverseRoute({
    path: '/reverse/ast/data-flow',
    operation: 'ast.dataFlow',
  });

  registerReverseRoute({
    path: '/reverse/ast/obfuscation',
    operation: 'ast.obfuscation',
  });

  registerReverseRoute({
    path: '/reverse/ast/call-chain',
    operation: 'ast.callChain',
  });

  registerReverseRoute({
    path: '/reverse/ast/strings',
    operation: 'ast.strings',
  });

  registerReverseRoute({
    path: '/reverse/ast/deobfuscate',
    operation: 'ast.deobfuscate',
  });

  registerReverseRoute({
    path: '/reverse/ast/crypto-related',
    operation: 'ast.cryptoRelated',
  });

  registerReverseRoute({
    path: '/reverse/node/profile',
    operation: 'node.profile',
  });

  registerReverseRoute({
    path: '/reverse/webpack/analyze',
    operation: 'webpack.analyze',
  });

  registerReverseRoute({
    path: '/reverse/webpack/extract-modules',
    operation: 'webpack.extractModules',
  });

  registerReverseRoute({
    path: '/reverse/browser/simulate',
    operation: 'browser.simulate',
  });

  registerReverseRoute({
    path: '/reverse/browser/execute',
    operation: 'browser.execute',
  });

  registerReverseRoute({
    path: '/reverse/app/native-plan',
    operation: 'app.nativePlan',
  });

  registerReverseRoute({
    path: '/reverse/app/native-status',
    operation: 'app.nativeStatus',
  });

  registerReverseRoute({
    path: '/reverse/protobuf/analyze',
    operation: 'protobuf.analyze',
  });

  registerReverseRoute({
    path: '/reverse/grpc/analyze',
    operation: 'grpc.analyze',
  });

  registerReverseRoute({
    path: '/reverse/curl/convert',
    operation: 'curl.convert',
  });

  registerReverseRoute({
    path: '/reverse/curl/convert-batch',
    operation: 'curl.convertBatch',
  });

  registerReverseRoute({
    path: '/reverse/hooks/generate',
    operation: 'hooks.generate',
  });

  registerReverseRoute({
    path: '/reverse/hooks/anti-detection',
    operation: 'hooks.antiDetection',
  });

  registerReverseRoute({
    path: '/reverse/hooks/parameter-capture',
    operation: 'hooks.parameterCapture',
  });

  registerReverseRoute({
    path: '/reverse/cdp/connect',
    operation: 'cdp.connect',
  });

  registerReverseRoute({
    path: '/reverse/cdp/disconnect',
    operation: 'cdp.disconnect',
  });

  registerReverseRoute({
    path: '/reverse/cdp/intercept',
    operation: 'cdp.intercept',
  });

  registerReverseRoute({
    method: 'get',
    path: '/reverse/cdp/requests',
    operation: 'cdp.requests',
    includeQuery: true,
  });

  registerReverseRoute({
    path: '/reverse/cdp/evaluate',
    operation: 'cdp.evaluate',
  });

  registerReverseRoute({
    path: '/reverse/cdp/breakpoint',
    operation: 'cdp.breakpoint',
  });

  registerReverseRoute({
    path: '/reverse/cdp/navigate',
    operation: 'cdp.navigate',
  });

  registerReverseRoute({
    path: '/reverse/cdp/cookies',
    operation: 'cdp.cookies',
  });

  app.post('/reverse/run', async (req, res, next) => {
    try {
      const result = await runReverseOperation(getObject(req.body));
      res.json({ result });
    } catch (error) {
      next(error);
    }
  });

  app.post('/reverse/batch', async (req, res, next) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : null;
      if (!items || items.length === 0) {
        throw new AppError(400, 'items array is required');
      }

      const concurrency = Math.max(1, Number(req.body?.concurrency ?? 4));
      const results = await mapWithConcurrency(items, concurrency, async (rawInput, index) => {
        const input = getObject(rawInput);
        try {
          return {
            index,
            success: true,
            result: await runReverseOperation(input),
          };
        } catch (error) {
          return {
            index,
            success: false,
            error: error?.message ?? String(error),
          };
        }
      });

      res.json({
        total: results.length,
        successCount: results.filter((item) => item.success).length,
        failureCount: results.filter((item) => !item.success).length,
        items: results,
      });
    } catch (error) {
      next(error);
    }
  });

  registerLegacyReverseApi(app, { sessionStore });
  registerReverseLabRoutes(app, reverseLabManager);
  setupLoginRecorderRoutes(app, { jobStore, workflowRegistry, jobRunner: { run: runWorkflow } });
  setupRepairPlanRoutes(app, { jobStore, workflowRegistry, jobRunner: { run: runWorkflow } });

  app.get('/runtime/browser-pool', (_req, res) => {
    res.json(getBrowserPoolSnapshot());
  });

  app.get('/metrics', async (_req, res) => {
    const jobs = jobStore.list();
    const proxies = await proxyPool.list();

    const lines = [
      '# HELP omnicrawl_jobs_total Total number of jobs',
      '# TYPE omnicrawl_jobs_total counter',
      `omnicrawl_jobs_total ${jobs.length}`,
      '# HELP omnicrawl_proxies_total Total number of proxies',
      '# TYPE omnicrawl_proxies_total gauge',
      `omnicrawl_proxies_total ${proxies.length}`,
      '# HELP omnicrawl_active_runs Current active job runs',
      '# TYPE omnicrawl_active_runs gauge',
      `omnicrawl_active_runs ${controlPlane.enabled ? distributedWorker?.activeJobs.size ?? 0 : activeJobs.size}`,
    ];

    const statusCounts = jobs.reduce((acc, j) => {
      acc[j.status] = (acc[j.status] ?? 0) + 1;
      return acc;
    }, {});

    for (const [status, count] of Object.entries(statusCounts)) {
      lines.push(`omnicrawl_jobs_by_status{status="${status}"} ${count}`);
    }

    const registry = getPromRegistry();
    const promText = await getPromMetrics();
    const runtimeMetrics = `${lines.join('\n')}\n`;
    res.setHeader('Content-Type', registry.contentType ?? 'text/plain; charset=utf-8');
    res.send(`${runtimeMetrics}${promText}`);
  });

  app.get('/runtime/metrics', async (_req, res) => {
    const jobs = jobStore.list();
    const counts = jobs.reduce(
      (accumulator, job) => {
        accumulator.total += 1;
        accumulator.byStatus[job.status] = (accumulator.byStatus[job.status] ?? 0) + 1;
        return accumulator;
      },
      { total: 0, byStatus: {} },
    );

    const proxies = await proxyPool.list();
    const datasets = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.listDatasets(1000))
      : await DatasetStore.list({ projectRoot, limit: 1000 });
    const keyValueStores = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.listKeyValueStores(1000))
      : await KeyValueStore.list({ projectRoot, limit: 1000 });
    const recentHistory = controlPlane.enabled
      ? jobStore.listHistory(20)
      : await historyStore.list(20);

    res.json({
      jobs: counts,
      browserPool: getBrowserPoolSnapshot(),
      proxies: {
        total: proxies.length,
        disabled: proxies.filter((item) => item.effectiveDisabled).length,
        coolingDown: proxies.filter((item) => item.inCooldown).length,
      },
      datasets: {
        total: datasets.length,
      },
      keyValueStores: {
        total: keyValueStores.length,
      },
      history: summarizeHistoryHealth(recentHistory),
      observability: summarizeObservabilityHealth(recentHistory),
      alertOutbox: alertOutbox.stats(),
      activeRuns: controlPlane.enabled ? distributedWorker?.activeJobs.size ?? 0 : activeJobs.size,
      controlPlane: controlPlane.enabled
        ? {
            enabled: true,
            backend: controlPlane.backend,
            workerId: controlPlane.workerId,
            activeJobs: distributedWorker?.activeJobs.size ?? 0,
          }
        : {
            enabled: false,
            backend: 'local',
          },
    });
  });

  app.get('/runtime/proxies', async (_req, res) => {
    const items = await proxyPool.list();
    res.json({ items });
  });

  app.get('/runtime/integrations', (_req, res) => {
    res.json(inspectOptionalIntegrations());
  });

  app.post('/runtime/integrations/probe', async (req, res, next) => {
    try {
      if (req.body?.all === true || Array.isArray(req.body?.ids)) {
        const result = await probeIntegrations({
          ids: Array.isArray(req.body?.ids) ? req.body.ids.map((item) => String(item)) : [],
          configs: getObject(req.body?.configs),
          dryRun: req.body?.dryRun !== false,
          timeoutMs: toInt(req.body?.timeoutMs, 3000),
        });
        res.json(result);
        return;
      }

      const id = String(req.body?.id ?? '').trim();
      if (!id) {
        throw new AppError(400, 'id is required');
      }

      const result = await probeIntegration({
        id,
        config: getObject(req.body?.config),
        dryRun: req.body?.dryRun !== false,
        timeoutMs: toInt(req.body?.timeoutMs, 3000),
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get('/runtime/alerts/outbox', async (req, res) => {
    const limit = toInt(req.query.limit, 100);
    const includeDelivered = String(req.query.includeDelivered ?? 'false') === 'true';
    const items = await alertOutbox.list({
      limit: Number.isNaN(limit) ? 100 : limit,
      includeDelivered,
    });
    res.json({
      items,
      stats: alertOutbox.stats(),
    });
  });

  app.post('/runtime/alerts/outbox/drain', async (_req, res, next) => {
    try {
      const result = await alertOutbox.drain();
      res.json({ result });
    } catch (error) {
      next(error);
    }
  });

  app.get('/datasets', async (req, res) => {
    const limit = toInt(req.query.limit, 100);
    const items = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.listDatasets(Number.isNaN(limit) ? 100 : limit))
      : await DatasetStore.list({
          projectRoot,
          limit: Number.isNaN(limit) ? 100 : limit,
        });
    res.json({ items });
  });

  app.get('/datasets/:datasetId', async (req, res) => {
    const item = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.getDataset(req.params.datasetId))
      : await DatasetStore.get({
          projectRoot,
          datasetId: req.params.datasetId,
        });

    if (!item) {
      res.status(404).json({ error: 'dataset not found' });
      return;
    }

    res.json({ item });
  });

  app.get('/datasets/:datasetId/items', async (req, res) => {
    const limit = toInt(req.query.limit, 50);
    const offset = toInt(req.query.offset, 0);
    const query = String(req.query.query ?? '').trim();
    const page = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.listDatasetItems(req.params.datasetId, {
          offset: Number.isNaN(offset) ? 0 : offset,
          limit: Number.isNaN(limit) ? 50 : limit,
          query,
        }))
      : await DatasetStore.listItems({
          projectRoot,
          datasetId: req.params.datasetId,
          offset: Number.isNaN(offset) ? 0 : offset,
          limit: Number.isNaN(limit) ? 50 : limit,
          query,
        });

    if (page.total === 0) {
      const dataset = controlPlane.enabled
        ? dataPlane.getDataset(req.params.datasetId)
        : await DatasetStore.get({
            projectRoot,
            datasetId: req.params.datasetId,
          });

      if (!dataset) {
        res.status(404).json({ error: 'dataset not found' });
        return;
      }
    }

    res.json(page);
  });
 
  app.get('/key-value-stores', async (req, res) => {
    const limit = toInt(req.query.limit, 100);
    const items = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.listKeyValueStores(Number.isNaN(limit) ? 100 : limit))
      : await KeyValueStore.list({
          projectRoot,
          limit: Number.isNaN(limit) ? 100 : limit,
        });
    res.json({ items });
  });

  app.get('/key-value-stores/:storeId', async (req, res) => {
    const item = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.getKeyValueStore(req.params.storeId))
      : await KeyValueStore.get({
          projectRoot,
          storeId: req.params.storeId,
        });

    if (!item) {
      res.status(404).json({ error: 'key-value store not found' });
      return;
    }

    res.json({ item });
  });

  app.get('/key-value-stores/:storeId/records/:key', async (req, res) => {
    const record = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.getRecord(req.params.storeId, req.params.key))
      : await KeyValueStore.getRecord({
          projectRoot,
          storeId: req.params.storeId,
          key: req.params.key,
        });

    if (!record) {
      res.status(404).json({ error: 'record not found' });
      return;
    }

    res.json({ record });
  });

  app.post('/runtime/proxies/control', async (req, res, next) => {
    try {
      const key = String(req.body?.key ?? '').trim();
      if (!key) {
        throw new AppError(400, 'proxy key is required');
      }

      let item = null;

      if (typeof req.body?.enabled === 'boolean') {
        item = await proxyPool.setEnabled(key, req.body.enabled);
      }

      if (req.body?.notes !== undefined) {
        item = await proxyPool.updateNotes(key, req.body.notes);
      }

      if (!item) {
        throw new AppError(404, 'proxy not found');
      }

      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/runtime/proxies/reset', async (req, res, next) => {
    try {
      const key = String(req.body?.key ?? '').trim();
      if (!key) {
        throw new AppError(400, 'proxy key is required');
      }

      const item = await proxyPool.reset(key);
      if (!item) {
        throw new AppError(404, 'proxy not found');
      }

      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/runtime/proxies/probe', async (req, res, next) => {
    try {
      const key = String(req.body?.key ?? '').trim();
      if (!key) {
        throw new AppError(400, 'proxy key is required');
      }

      const result = await proxyPool.probe(key, {
        targetUrl: req.body?.targetUrl,
        timeoutMs: Number(req.body?.timeoutMs ?? 5000),
      });

      if (!result) {
        throw new AppError(404, 'proxy not found');
      }

      res.json({ result });
    } catch (error) {
      next(error);
    }
  });

  app.get('/sessions', async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const items = await sessionStore.list(Number.isNaN(limit) ? 100 : limit);
    res.json({ items });
  });

  app.get('/jobs', (_req, res) => {
    res.json({
      items: jobStore.list(),
    });
  });

  app.get('/jobs/compare', async (req, res) => {
    const leftId = String(req.query.left ?? '').trim();
    const rightId = String(req.query.right ?? '').trim();

    if (!leftId || !rightId) {
      res.status(400).json({ error: 'left and right query params are required' });
      return;
    }

    const leftJob = await resolveJobRecord({ jobId: leftId, jobStore, historyStore });
    const rightJob = await resolveJobRecord({ jobId: rightId, jobStore, historyStore });

    if (!leftJob || !rightJob) {
      res.status(404).json({ error: 'both jobs must exist and have run directories' });
      return;
    }

    const leftResults = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.listResults(leftId, { offset: 0, limit: 100000 }).items)
      : await readAllNdjsonFile(join(leftJob.runDir, 'results.ndjson'));
    const rightResults = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.listResults(rightId, { offset: 0, limit: 100000 }).items)
      : await readAllNdjsonFile(join(rightJob.runDir, 'results.ndjson'));

    res.json(compareJobs(leftJob, rightJob, leftResults, rightResults));
  });

  app.get('/jobs/:jobId', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    res.json({ job });
  });

  app.get('/jobs/:jobId/queue', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    if (controlPlane.enabled) {
      await dataPlane.init();
      const queue = dataPlane.readQueue(req.params.jobId);
      const requests = Object.values(queue.requests ?? {});
      res.json({
        summary: {
          totalCount: requests.length,
          pendingCount: requests.filter((item) => item.status === 'pending').length,
          inProgressCount: requests.filter((item) => item.status === 'inProgress').length,
          handledCount: requests.filter((item) => item.status === 'handled').length,
          failedCount: requests.filter((item) => item.status === 'failed').length,
          updatedAt: queue.updatedAt ?? null,
        },
        pending: queue.pending ?? [],
      });
      return;
    }

    try {
      const queue = JSON.parse(await readFile(join(job.runDir, 'request-queue.json'), 'utf8'));
      const requests = Object.values(queue.requests ?? {});
      res.json({
        summary: {
          totalCount: requests.length,
          pendingCount: requests.filter((item) => item.status === 'pending').length,
          inProgressCount: requests.filter((item) => item.status === 'inProgress').length,
          handledCount: requests.filter((item) => item.status === 'handled').length,
          failedCount: requests.filter((item) => item.status === 'failed').length,
          updatedAt: queue.updatedAt ?? null,
        },
        pending: queue.pending ?? [],
      });
    } catch {
      res.status(404).json({ error: 'request queue not found' });
    }
  });

  app.post('/jobs/:jobId/resume', async (req, res, next) => {
    try {
      const job = jobStore.get(req.params.jobId);
      if (!job) {
        throw new AppError(404, 'job not found');
      }

      if (job.status === 'running' || job.status === 'queued') {
        throw new AppError(409, `job is already active: ${job.id}`);
      }

      const workflow = await loadResumeWorkflowSnapshot({
        controlPlane,
        jobStore,
        job,
      });
      if (!workflow) {
        throw new AppError(404, 'workflow snapshot not found for job');
      }

      if (controlPlane.enabled) {
        const queued = enqueueDistributedWorkflow(workflow, {
          source: `resume:${job.id}`,
          metadata: {
            ...(job.metadata ?? {}),
            trigger: 'resume',
            resumedAt: new Date().toISOString(),
          },
          jobId: job.id,
          reuseExisting: true,
        });

        res.status(202).json({
          jobId: queued.job.id,
          status: queued.job.status,
          accepted: true,
          queued: true,
        });
        return;
      }

      const launched = startManagedWorkflow(workflow, {
        source: `resume:${job.id}`,
        metadata: {
          ...(job.metadata ?? {}),
          trigger: 'resume',
          resumedAt: new Date().toISOString(),
        },
        jobId: job.id,
        reuseExisting: true,
      });

      launched.promise.catch((error) => {
        logger.error('resume failed after acceptance', {
          jobId: job.id,
          error: error?.message ?? String(error),
        });
      });

      res.status(202).json({
        jobId: launched.job.id,
        status: launched.job.status,
        accepted: true,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/jobs/:jobId/results', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const limit = toInt(req.query.limit, 50);
    const offset = toInt(req.query.offset, 0);
    const query = String(req.query.query ?? '').trim();
    const page = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.listResults(req.params.jobId, { offset, limit, query }))
      : paginate(
          (await readAllNdjsonFile(join(job.runDir, 'results.ndjson')))
            .filter((item) => matchesQuery(item, query)),
          { offset, limit },
        );
    res.json(page);
  });

  app.get('/jobs/:jobId/failed-requests', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const limit = toInt(req.query.limit, 50);
    const offset = toInt(req.query.offset, 0);
    const query = String(req.query.query ?? '').trim();
    const items = await readJobFailedRequests({
      controlPlane,
      dataPlane,
      projectRoot,
      jobId: req.params.jobId,
    });

    res.json(paginate(
      items.filter((item) => matchesQuery(item, query)),
      { offset, limit },
    ));
  });

  app.get('/jobs/:jobId/changes', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const query = String(req.query.query ?? '').trim();
    const path = String(req.query.path ?? '').trim();
    const offset = toInt(req.query.offset, 0);
    const limit = toInt(req.query.limit, 50);
    const changeFeed = await readJobChangeFeed({
      controlPlane,
      dataPlane,
      projectRoot,
      jobId: req.params.jobId,
    });
    const filtered = changeFeed
      .filter((item) => matchesQuery(item, query))
      .filter((item) => (!path
        ? true
        : (item.fieldChanges ?? []).some((entry) => entry.path === path || entry.field === path)));

    res.json(paginate(filtered, { offset, limit }));
  });

  app.get('/jobs/:jobId/change-summary', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const summary = await readJobChangeSummary({
      controlPlane,
      dataPlane,
      projectRoot,
      jobId: req.params.jobId,
    });

    res.json({
      item: summary ?? {
        changedResultCount: 0,
        fieldChangeCount: 0,
        topChangedFields: [],
        cache: null,
      },
    });
  });

  app.get('/jobs/:jobId/diagnostics', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const diagnostics = await readJobDiagnostics({
      controlPlane,
      dataPlane,
      projectRoot,
      jobId: req.params.jobId,
      runDir: job.runDir ?? null,
    });

    res.json({
      item: diagnostics ?? {
        state: null,
        surface: null,
        signals: null,
        suspects: [],
        recovery: [],
      },
    });
  });

  app.get('/jobs/:jobId/replay-recipe', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const recipe = await readJobReplayRecipe({
      controlPlane,
      dataPlane,
      projectRoot,
      jobId: req.params.jobId,
      runDir: job.runDir ?? null,
    });

    res.json({
      item: recipe ?? {
        version: 1,
        recommendedMode: 'http',
        rationale: [],
        prerequisites: [],
        identity: null,
        capture: null,
        steps: [],
        recovery: [],
        generatedFrom: null,
      },
    });
  });

  app.get('/jobs/:jobId/replay-workflow', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const workflow = await loadWorkflowSnapshotForJob({
      controlPlane,
      jobStore,
      historyStore,
      jobId: req.params.jobId,
    });
    if (!workflow) {
      res.status(404).json({ error: 'workflow snapshot not found for job' });
      return;
    }

    const recipe = await readJobReplayRecipe({
      controlPlane,
      dataPlane,
      projectRoot,
      jobId: req.params.jobId,
      runDir: job.runDir ?? null,
    });

    res.json({
      item: buildReplayWorkflow({
        workflow,
        recipe: recipe ?? {},
        replayOf: req.params.jobId,
      }),
    });
  });

  app.get('/jobs/:jobId/replay-workflow-template', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const workflow = await loadWorkflowSnapshotForJob({
      controlPlane,
      jobStore,
      historyStore,
      jobId: req.params.jobId,
    });
    if (!workflow) {
      res.status(404).json({ error: 'workflow snapshot not found for job' });
      return;
    }

    const recipe = await readJobReplayRecipe({
      controlPlane,
      dataPlane,
      projectRoot,
      jobId: req.params.jobId,
      runDir: job.runDir ?? null,
    });

    res.json({
      item: buildReplayWorkflowPatchTemplate({
        workflow,
        recipe: recipe ?? {},
      }),
    });
  });

  app.get('/jobs/:jobId/repair-plan', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const workflow = await loadWorkflowSnapshotForJob({
      controlPlane,
      jobStore,
      historyStore,
      jobId: req.params.jobId,
    });
    if (!workflow) {
      res.status(404).json({ error: 'workflow snapshot not found for job' });
      return;
    }

    const [diagnostics, recipe, failedRequests, authStatePlan] = await Promise.all([
      readJobDiagnostics({
        controlPlane,
        dataPlane,
        projectRoot,
        jobId: req.params.jobId,
        runDir: job.runDir ?? null,
      }),
      readJobReplayRecipe({
        controlPlane,
        dataPlane,
        projectRoot,
        jobId: req.params.jobId,
        runDir: job.runDir ?? null,
      }),
      readJobFailedRequests({
        controlPlane,
        dataPlane,
        projectRoot,
        jobId: req.params.jobId,
      }),
      readJobAuthStatePlan({
        controlPlane,
        dataPlane,
        projectRoot,
        jobId: req.params.jobId,
        runDir: job.runDir ?? null,
      }),
    ]);

    res.json({
      item: buildWorkflowRepairPlan({
        workflow,
        diagnostics: diagnostics ?? {},
        recipe: recipe ?? {},
        failedRequests,
        authStatePlan,
      }),
    });
  });

  app.post('/jobs/:jobId/rebuild-workflow', async (req, res, next) => {
    try {
      const job = await resolveJobRecord({
        jobId: req.params.jobId,
        jobStore,
        historyStore,
      });

      if (!job) {
        throw new AppError(404, 'job not found');
      }

      const workflow = await loadWorkflowSnapshotForJob({
        controlPlane,
        jobStore,
        historyStore,
        jobId: req.params.jobId,
      });
      if (!workflow) {
        throw new AppError(404, 'workflow snapshot not found for job');
      }

      const [diagnostics, recipe, failedRequests, authStatePlan] = await Promise.all([
        readJobDiagnostics({
          controlPlane,
          dataPlane,
          projectRoot,
          jobId: req.params.jobId,
          runDir: job.runDir ?? null,
        }),
        readJobReplayRecipe({
          controlPlane,
          dataPlane,
          projectRoot,
          jobId: req.params.jobId,
          runDir: job.runDir ?? null,
        }),
        readJobFailedRequests({
          controlPlane,
          dataPlane,
          projectRoot,
          jobId: req.params.jobId,
        }),
        readJobAuthStatePlan({
          controlPlane,
          dataPlane,
          projectRoot,
          jobId: req.params.jobId,
          runDir: job.runDir ?? null,
        }),
      ]);
      const plan = buildWorkflowRepairPlan({
        workflow,
        diagnostics: diagnostics ?? {},
        recipe: recipe ?? {},
        failedRequests,
        authStatePlan,
      });
      const register = req.body?.register === true;
      let workflowEntry = null;
      if (register) {
        workflowEntry = await workflowRegistry.register({
          workflow: plan.rebuiltWorkflow,
          id: req.body?.id ?? plan.suggestedWorkflowId,
          source: `repair:${req.params.jobId}`,
          description: req.body?.description ?? `Rebuilt from job ${req.params.jobId}`,
        });
      }

      res.json({
        item: plan,
        workflow: workflowEntry,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/jobs/:jobId/replay-workflow/run', async (req, res, next) => {
    try {
      const job = await resolveJobRecord({
        jobId: req.params.jobId,
        jobStore,
        historyStore,
      });

      if (!job) {
        throw new AppError(404, 'job not found');
      }

      const workflow = await loadWorkflowSnapshotForJob({
        controlPlane,
        jobStore,
        historyStore,
        jobId: req.params.jobId,
      });
      if (!workflow) {
        throw new AppError(404, 'workflow snapshot not found for job');
      }

      const recipe = await readJobReplayRecipe({
        controlPlane,
        dataPlane,
        projectRoot,
        jobId: req.params.jobId,
        runDir: job.runDir ?? null,
      });

      const replayWorkflow = buildReplayWorkflow({
        workflow,
        recipe: recipe ?? {},
        replayOf: req.params.jobId,
      });
      const workflowPatch = req.body?.workflowPatch;
      const finalWorkflow = workflowPatch && typeof workflowPatch === 'object' && !Array.isArray(workflowPatch)
        ? applyWorkflowPatch(replayWorkflow, workflowPatch)
        : replayWorkflow;

      const launched = controlPlane.enabled
        ? enqueueDistributedWorkflow(finalWorkflow, {
            source: `replay-recipe:${req.params.jobId}`,
            metadata: { trigger: 'replay-recipe', replayOf: req.params.jobId },
          })
        : startManagedWorkflow(finalWorkflow, {
            source: `replay-recipe:${req.params.jobId}`,
            metadata: { trigger: 'replay-recipe', replayOf: req.params.jobId },
          });

      if (!controlPlane.enabled) {
        launched.promise.catch((error) => {
          logger.error('replay-recipe run failed after acceptance', {
            replayOf: req.params.jobId,
            error: error?.message ?? String(error),
          });
        });
      }

      res.status(202).json({
        jobId: launched.job.id,
        status: launched.job.status,
        workflowName: finalWorkflow.name,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/jobs/:jobId/debug/:sequence', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const sequence = Number.parseInt(String(req.params.sequence ?? ''), 10);
    if (Number.isNaN(sequence)) {
      res.status(400).json({ error: 'sequence must be an integer' });
      return;
    }

    const record = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.getResult(req.params.jobId, sequence))
      : (await readAllNdjsonFile(join(job.runDir, 'results.ndjson'))).find((item) => Number(item.sequence) === sequence);

    if (!record?.debug) {
      res.status(404).json({ error: 'debug record not found' });
      return;
    }

    if (record.debug.artifact?.path) {
      try {
        const parsed = controlPlane.enabled
          ? dataPlane.readArtifactJson(req.params.jobId, record.debug.artifact.path)
          : JSON.parse(await readFile(join(job.runDir, record.debug.artifact.path), 'utf8'));

        if (!parsed) {
          throw new Error('debug artifact not found');
        }

        if (parsed.format === 'browser-debug-v2' && parsed.files) {
          const artifactDir = controlPlane.enabled ? record.debug.artifact.path.split('/').slice(0, -1).join('/') : dirname(join(job.runDir, record.debug.artifact.path));
          const requests = [];
          const hooks = [];
          const scripts = [];
          const sourceMaps = [];

          for (const fileName of parsed.files.requests ?? []) {
            if (controlPlane.enabled) {
              const artifact = dataPlane.readArtifact(req.params.jobId, `${artifactDir}/${fileName}`);
              const lines = artifact?.bodyText?.trim() ? artifact.bodyText.trim().split('\n') : [];
              requests.push(...lines.map((line) => JSON.parse(line)));
            } else {
              requests.push(...(await readAllNdjsonFile(join(artifactDir, fileName))));
            }
          }

          for (const fileName of parsed.files.hooks ?? []) {
            if (controlPlane.enabled) {
              const artifact = dataPlane.readArtifact(req.params.jobId, `${artifactDir}/${fileName}`);
              const lines = artifact?.bodyText?.trim() ? artifact.bodyText.trim().split('\n') : [];
              hooks.push(...lines.map((line) => JSON.parse(line)));
            } else {
              hooks.push(...(await readAllNdjsonFile(join(artifactDir, fileName))));
            }
          }

          for (const fileName of parsed.files.scriptsIndex ?? []) {
            const entries = controlPlane.enabled
              ? (() => {
                  const artifact = dataPlane.readArtifact(req.params.jobId, `${artifactDir}/${fileName}`);
                  const lines = artifact?.bodyText?.trim() ? artifact.bodyText.trim().split('\n') : [];
                  return lines.map((line) => JSON.parse(line));
                })()
              : await readAllNdjsonFile(join(artifactDir, fileName));
            for (const entry of entries) {
              scripts.push({
                ...entry,
                source: entry.contentPath
                  ? controlPlane.enabled
                    ? dataPlane.readArtifact(req.params.jobId, `${artifactDir}/${entry.contentPath}`)?.bodyText ?? null
                    : await readOptionalTextFile(join(artifactDir, entry.contentPath))
                  : null,
              });
            }
          }

          for (const fileName of parsed.files.sourceMapsIndex ?? []) {
            const entries = controlPlane.enabled
              ? (() => {
                  const artifact = dataPlane.readArtifact(req.params.jobId, `${artifactDir}/${fileName}`);
                  const lines = artifact?.bodyText?.trim() ? artifact.bodyText.trim().split('\n') : [];
                  return lines.map((line) => JSON.parse(line));
                })()
              : await readAllNdjsonFile(join(artifactDir, fileName));
            for (const entry of entries) {
              sourceMaps.push({
                ...entry,
                content: entry.contentPath
                  ? controlPlane.enabled
                    ? dataPlane.readArtifact(req.params.jobId, `${artifactDir}/${entry.contentPath}`)?.bodyText ?? null
                    : await readOptionalTextFile(join(artifactDir, entry.contentPath))
                  : null,
              });
            }
          }

          res.json({
            artifact: record.debug.artifact,
            debug: {
              enabled: true,
              finalUrl: parsed.finalUrl ?? null,
              identity: parsed.identity ?? record.debug.identity ?? null,
              summary: parsed.summary ?? {},
              attachments: parsed.attachments ?? record.debug.attachments ?? null,
              requests,
              scripts,
              sourceMaps,
              hooks: {
                ...(record.debug.hooks ?? {}),
                events: hooks,
              },
            },
          });
          return;
        }

        res.json({
          artifact: record.debug.artifact,
          debug: parsed,
        });
        return;
      } catch {
        res.status(404).json({ error: 'debug artifact not found' });
        return;
      }
    }

    res.json({
      artifact: null,
      debug: record.debug,
    });
  });

  app.get('/jobs/:jobId/event-log', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const limit = toInt(req.query.limit, 100);
    const offset = toInt(req.query.offset, 0);
    const query = String(req.query.query ?? '').trim();
    const type = String(req.query.type ?? '').trim();
    const page = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.listEvents(req.params.jobId, { offset, limit, query, type }))
      : paginate(
          (await readAllNdjsonFile(join(job.runDir, 'events.ndjson')))
            .filter((item) => (!type ? true : item.type === type))
            .filter((item) => matchesQuery(item, query)),
          { offset, limit },
        );

    res.json(page);
  });

  app.get('/jobs/:jobId/detail', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    if (!job.runDir && !controlPlane.enabled) {
      res.json({
        job,
        summary: null,
        results: [],
        events: job.events ?? [],
      });
      return;
    }

    const resultLimit = Number.parseInt(String(req.query.limitResults ?? '20'), 10);
    const eventLimit = Number.parseInt(String(req.query.limitEvents ?? '50'), 10);
    const resultOffset = toInt(req.query.offsetResults, 0);
    const eventOffset = toInt(req.query.offsetEvents, 0);
    const query = String(req.query.query ?? '').trim();
    const summary = controlPlane.enabled
      ? (await dataPlane.init(), dataPlane.readArtifactJson(req.params.jobId, 'summary.json'))
      : await readSummaryFile(job.runDir);
    const resultPage = controlPlane.enabled
      ? dataPlane.listResults(req.params.jobId, {
          offset: resultOffset,
          limit: Number.isNaN(resultLimit) ? 20 : resultLimit,
          query,
        })
      : paginate(
          (await readAllNdjsonFile(join(job.runDir, 'results.ndjson')))
            .filter((item) => matchesQuery(item, query)),
          { offset: resultOffset, limit: Number.isNaN(resultLimit) ? 20 : resultLimit },
        );
    const eventPage = controlPlane.enabled
      ? dataPlane.listEvents(req.params.jobId, {
          offset: eventOffset,
          limit: Number.isNaN(eventLimit) ? 50 : eventLimit,
          query,
        })
      : paginate(
          (await readAllNdjsonFile(join(job.runDir, 'events.ndjson')))
            .filter((item) => matchesQuery(item, query)),
          { offset: eventOffset, limit: Number.isNaN(eventLimit) ? 50 : eventLimit },
        );
    const assetStore = await new ReverseAssetStore({ projectRoot }).init();
    const assetSnapshot = assetStore.snapshot();
    const reverseAssets = Object.fromEntries(
      Object.keys(reverseAssetCollections).map((collection) => [
        collection,
        (Array.isArray(assetSnapshot[collection]) ? assetSnapshot[collection] : [])
          .filter((entry) => entry.jobId === req.params.jobId),
      ]),
    );
    const latestAiSurfaceRef = reverseAssets.aiSurfaces[0] ?? null;
    const latestAiSurface = latestAiSurfaceRef
      ? await assetStore.readLatestAsset(reverseAssetCollections.aiSurfaces, latestAiSurfaceRef.assetId)
      : null;

    res.json({
      job,
      summary,
      reverseAssets,
      latestAiSurface,
      results: resultPage.items,
      resultPage,
      events: eventPage.items,
      eventPage,
    });
  });

  app.get('/jobs/:jobId/export', async (req, res) => {
    const job = await resolveJobRecord({
      jobId: req.params.jobId,
      jobStore,
      historyStore,
    });

    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const kind = String(req.query.kind ?? 'results');
    const format = String(req.query.format ?? 'json');
    const query = String(req.query.query ?? '').trim();
    const filtered = controlPlane.enabled
      ? (kind === 'events'
          ? (await dataPlane.init(), dataPlane.listEvents(req.params.jobId, { offset: 0, limit: 100000, query }).items)
          : dataPlane.listResults(req.params.jobId, { offset: 0, limit: 100000, query }).items)
      : (await readAllNdjsonFile(join(job.runDir, kind === 'events' ? 'events.ndjson' : 'results.ndjson')))
          .filter((item) => matchesQuery(item, query));

    if (format === 'ndjson') {
      res.type('application/x-ndjson');
      res.send(`${filtered.map((item) => JSON.stringify(item)).join('\n')}\n`);
      return;
    }

    if (format === 'csv') {
      res.type('text/csv; charset=utf-8');
      res.send(toCsv(filtered));
      return;
    }

    res.json({
      kind,
      format: 'json',
      total: filtered.length,
      items: filtered,
    });
  });


  app.get('/jobs/:jobId/events', async (req, res) => {
    const liveJob = jobStore.get(req.params.jobId);
    const isTerminal = liveJob && liveJob.status !== 'queued' && liveJob.status !== 'running';
    const historicalJob = isTerminal || !liveJob ? await historyStore.get(req.params.jobId) : null;

    if (!liveJob && !historicalJob?.runDir && !controlPlane.enabled) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    if (controlPlane.enabled) {
      await dataPlane.init();
      if (!liveJob && !jobStore.getHistory(req.params.jobId)) {
        res.status(404).json({ error: 'job not found' });
        return;
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const historicalEvents = controlPlane.enabled
      ? dataPlane.listEvents(req.params.jobId, { offset: 0, limit: 500 }).items
      : historicalJob?.runDir
        ? await readNdjsonFile(join(historicalJob.runDir, 'events.ndjson'), 500)
        : [];

    const seedEvents = controlPlane.enabled ? historicalEvents : liveJob?.events ?? historicalEvents;
    for (const event of seedEvents) {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (controlPlane.enabled) {
      let lastSequence = seedEvents.at(-1)?.sequence ?? 0;
      const timer = setInterval(() => {
        const nextEvents = dataPlane.listEvents(req.params.jobId, {
          afterSequence: lastSequence,
          offset: 0,
          limit: 500,
        }).items;

        for (const event of nextEvents) {
          lastSequence = Math.max(lastSequence, Number(event.sequence ?? 0));
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        const current = jobStore.get(req.params.jobId) ?? jobStore.getHistory(req.params.jobId);
        if (current && current.status !== 'queued' && current.status !== 'running' && nextEvents.length === 0) {
          clearInterval(timer);
          res.end();
        }
      }, 250);
      timer.unref?.();

      req.on('close', () => {
        clearInterval(timer);
        res.end();
      });
      return;
    }

    if (!liveJob || isTerminal) {
      res.end();
      return;
    }

    const unsubscribe = jobStore.subscribe(req.params.jobId, (event) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  });

  app.post('/runtime/gc/run', async (_req, res, next) => {
    try {
      if (!gcService) {
        throw new AppError(400, 'distributed gc is not enabled');
      }

      const result = await gcService.runOnce();
      res.json({ result });
    } catch (error) {
      next(error);
    }
  });

  app.get('/history', async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const items = controlPlane.enabled
      ? jobStore.listHistory(Number.isNaN(limit) ? 50 : limit)
      : await historyStore.list(Number.isNaN(limit) ? 50 : limit);
    res.json({ items });
  });

  app.get('/history/trends', async (req, res) => {
    const limit = toInt(req.query.limit, 5);
    const workflowName = String(req.query.workflowName ?? '').trim();
    const items = controlPlane.enabled
      ? jobStore.listHistory(Number.isNaN(limit) ? 5 : limit + 1)
      : await historyStore.list(Number.isNaN(limit) ? 5 : limit + 1);
    const filtered = workflowName
      ? items.filter((item) => item.workflowName === workflowName && item.status === 'completed')
      : items.filter((item) => item.status === 'completed');
    const [current, ...previous] = filtered;

    res.json({
      workflowName: workflowName || (current?.workflowName ?? null),
      current: current ?? null,
      items: filtered,
      trend: current
        ? analyzeTrends({
            currentSummary: current,
            previousSummaries: previous.slice(0, Math.max(0, (Number.isNaN(limit) ? 5 : limit) - 1)),
          })
        : {
            available: false,
            sampleCount: 0,
            windowJobIds: [],
            averages: {},
            deltas: {},
            alerts: [],
          },
    });
  });

  app.get('/history/:jobId', async (req, res) => {
    const item = controlPlane.enabled
      ? jobStore.getHistory(req.params.jobId)
      : await historyStore.get(req.params.jobId);

    if (!item) {
      res.status(404).json({ error: 'history item not found' });
      return;
    }

    res.json({ item });
  });

  app.post('/history/:jobId/replay', async (req, res, next) => {
    try {
      const workflow = controlPlane.enabled
        ? jobStore.loadWorkflow(req.params.jobId)
        : await historyStore.loadWorkflowForJob(req.params.jobId);
      if (!workflow) {
        throw new AppError(404, 'workflow snapshot not found for job');
      }

      const launched = controlPlane.enabled
        ? enqueueDistributedWorkflow(workflow, {
            source: `replay:${req.params.jobId}`,
            metadata: { trigger: 'replay', replayOf: req.params.jobId },
          })
        : startManagedWorkflow(workflow, {
            source: `replay:${req.params.jobId}`,
            metadata: { trigger: 'replay', replayOf: req.params.jobId },
          });

      if (!controlPlane.enabled) {
        launched.promise.catch((error) => {
          logger.error('replay failed after acceptance', {
            replayOf: req.params.jobId,
            error: error?.message ?? String(error),
          });
        });
      }

      res.status(202).json({
        jobId: launched.job.id,
        status: launched.job.status,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/workflows', async (_req, res) => {
    const items = await workflowRegistry.list();
    res.json({ items });
  });

  app.get('/workflows/:workflowId', async (req, res) => {
    const workflowEntry = await workflowRegistry.get(req.params.workflowId);

    if (!workflowEntry) {
      res.status(404).json({ error: 'workflow not found' });
      return;
    }

    res.json({ item: workflowEntry });
  });

  app.post('/workflows', async (req, res, next) => {
    try {
      const hasInlineWorkflow = typeof req.body?.workflow === 'object' && req.body.workflow !== null;
      const workflowPath = typeof req.body?.workflowPath === 'string' ? req.body.workflowPath : null;

      if (!hasInlineWorkflow && !workflowPath) {
        throw new AppError(400, 'workflow or workflowPath is required');
      }

      const { workflow, source } = await loadWorkflow(hasInlineWorkflow ? req.body.workflow : workflowPath, {
        cwd: projectRoot,
      });

      const item = await workflowRegistry.register({
        workflow,
        id: req.body?.id,
        source,
        description: req.body?.description ?? '',
      });

      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/workflows/:workflowId/run', async (req, res, next) => {
    try {
      const workflowEntry = await workflowRegistry.get(req.params.workflowId);
      if (!workflowEntry?.workflow) {
        throw new AppError(404, 'workflow not found');
      }

      const launched = controlPlane.enabled
        ? enqueueDistributedWorkflow(workflowEntry.workflow, {
            source: `registry:${workflowEntry.id}`,
            metadata: { trigger: 'workflow-run', workflowId: workflowEntry.id },
          })
        : startManagedWorkflow(workflowEntry.workflow, {
            source: `registry:${workflowEntry.id}`,
            metadata: { trigger: 'workflow-run', workflowId: workflowEntry.id },
          });

      if (!controlPlane.enabled) {
        launched.promise.catch((error) => {
          logger.error('workflow run failed after acceptance', {
            workflowId: workflowEntry.id,
            error: error?.message ?? String(error),
          });
        });
      }

      res.status(202).json({
        workflowId: workflowEntry.id,
        jobId: launched.job.id,
        accepted: true,
        queued: controlPlane.enabled,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/schedules', async (_req, res) => {
    const items = await scheduler.list();
    res.json({ items });
  });

  app.post('/schedules', async (req, res, next) => {
    try {
      const intervalMs = Number(req.body?.intervalMs);
      if (!req.body?.workflowId || Number.isNaN(intervalMs) || intervalMs < 100) {
        throw new AppError(400, 'workflowId and intervalMs >= 100 are required');
      }

      const item = await scheduler.create({
        workflowId: req.body.workflowId,
        intervalMs,
        enabled: req.body?.enabled !== false,
      });

      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/schedules/:scheduleId', async (req, res, next) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') {
        throw new AppError(400, 'enabled boolean is required');
      }

      const item = await scheduler.setEnabled(req.params.scheduleId, req.body.enabled);
      if (!item) {
        throw new AppError(404, 'schedule not found');
      }

      res.json({ item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/jobs', async (req, res, next) => {
    try {
      const workflowId = typeof req.body?.workflowId === 'string' ? req.body.workflowId : null;
      const hasInlineWorkflow = typeof req.body?.workflow === 'object' && req.body.workflow !== null;
      const workflowPath = typeof req.body?.workflowPath === 'string' ? req.body.workflowPath : null;

      let workflow;
      let source = 'inline';
      let metadata = { trigger: 'jobs-api' };

      if (workflowId) {
        const workflowEntry = await workflowRegistry.get(workflowId);
        if (!workflowEntry?.workflow) {
          throw new AppError(404, 'workflow not found');
        }
        workflow = workflowEntry.workflow;
        source = `registry:${workflowId}`;
        metadata = { trigger: 'jobs-api', workflowId };
      } else {
        if (!hasInlineWorkflow && !workflowPath) {
          throw new AppError(400, 'workflow, workflowPath, or workflowId is required');
        }

        const loaded = await loadWorkflow(hasInlineWorkflow ? req.body.workflow : workflowPath, {
          cwd: projectRoot,
        });
        workflow = loaded.workflow;
        source = loaded.source;
      }

      if (controlPlane.enabled) {
        const queued = enqueueDistributedWorkflow(workflow, {
          source,
          metadata,
        });

        res.status(202).json({
          jobId: queued.job.id,
          status: queued.job.status,
          stream: `/jobs/${queued.job.id}/events`,
          queued: true,
        });
        return;
      }

      const job = jobStore.create({
        workflowName: workflow.name,
        metadata,
      });

      res.status(202).json({
        jobId: job.id,
        status: job.status,
        stream: `/jobs/${job.id}/events`,
      });

      runWorkflow(workflow, {
        projectRoot,
        jobStore,
        historyStore,
        sessionStore,
        proxyPool,
        jobId: job.id,
        source,
        metadata,
        alertOutbox,
      }).catch((error) => {
        logger.error('job run failed after acceptance', {
          jobId: job.id,
          error: error?.message ?? String(error),
        });
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    const status = inferErrorStatus(error);
    const payload = serializeError(error);

    logger.error('request failed', {
      status,
      error: payload.error,
      code: payload.code,
    });

    res.status(status).json(payload);
  });

  return {
    app,
    jobStore,
    historyStore,
    workflowRegistry,
    sessionStore,
    proxyPool,
    scheduler,
    distributedWorker,
    dataPlane,
    gcService,
    controlPlane,
    activeRuns,
    alertOutbox,
    reverseLabManager,
    antiBotLab,
    accountPool,
    devicePool,
    humanInteractionBroker,
    tenantRegistry,
    resourceScheduler,
    auditLogger,
    credentialVault,
    accessPolicy,
  };
}

export async function startServer({
  port = 3100,
  host = '127.0.0.1',
  projectRoot = process.cwd(),
  distributed,
  apiKey,
} = {}) {
  const services = createApp({ projectRoot, distributed, apiKey });
  await Promise.all([
    services.jobStore.init(),
    services.historyStore.init(),
    services.workflowRegistry.init(),
    services.sessionStore.init(),
    services.proxyPool.init(),
    services.scheduler.init(),
    services.alertOutbox.init(),
    services.antiBotLab.init(),
    services.accountPool.init(),
    services.devicePool.init(),
    services.humanInteractionBroker.init(),
    services.tenantRegistry.init(),
    services.auditLogger.init(),
    services.credentialVault.init(),
    services.dataPlane?.init?.() ?? Promise.resolve(),
  ]);
  for (const tenant of services.tenantRegistry.list()) {
    if (Object.keys(tenant.quotas ?? {}).length > 0) {
      services.resourceScheduler.setQuota(tenant.id, tenant.quotas);
    }
  }
  services.distributedWorker?.start();
  services.gcService?.start();
  services.alertOutbox?.start();

  return new Promise((resolve) => {
    const server = services.app.listen(port, host, () => {
      resolve({
        server,
        ...services,
        async close() {
          await services.gcService?.close();
          await services.distributedWorker?.close();
          await services.scheduler.close();
          await services.alertOutbox?.close();
          await services.reverseLabManager?.close();
          await Promise.allSettled([...services.activeRuns]);
          await closeBrowser({ namespace: projectRoot, force: true }).catch(() => {});
          await new Promise((closeResolve) => {
            server.close(() => closeResolve());
          });
          services.dataPlane?.close?.();
          services.jobStore.close?.();
        },
      });
    });
  });
}
