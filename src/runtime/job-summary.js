import { analyzeRunDiagnostics } from './reverse-diagnostics.js';
import { dispatchAlerts } from './alert-dispatcher.js';
import { runReverseRegressionSuite } from './reverse-regression.js';

export function createTerminalSummary({
  jobId,
  workflowName,
  status,
  source,
  runDir,
  metadata,
  pagesFetched,
  resultCount,
  failureCount,
  failedRequestCount,
  skippedCount,
  queuedCount,
  queue,
  sessions,
  autoscale,
  frontier,
  changeTracking,
  crawlPolicy,
  rateLimiter,
  observability,
  httpCache,
  quality,
  startedAt,
  finishedAt,
  error,
} = {}) {
  return {
    jobId,
    workflowName,
    status,
    source,
    runDir,
    metadata,
    pagesFetched,
    resultCount,
    failureCount,
    failedRequestCount,
    skippedCount,
    queuedCount,
    queue,
    sessions,
    autoscale,
    frontier,
    changeTracking,
    crawlPolicy,
    rateLimiter,
    observability,
    httpCache,
    quality,
    diagnostics: null,
    reverse: null,
    baseline: null,
    trend: null,
    alertDelivery: null,
    exports: [],
    startedAt,
    finishedAt,
    ...(error ? { error } : {}),
  };
}

export async function enrichTerminalSummary({
  summary,
  workflow,
  results,
  logger,
  buildBaseline,
  buildTrend,
  reverseAssetStore = null,
  signerAssetId = null,
  alertOutbox = null,
  includeReverseRuntime = false,
} = {}) {
  summary.baseline = await buildBaseline(summary);
  summary.trend = await buildTrend(summary);
  summary.diagnostics = analyzeRunDiagnostics({
    summary,
    results,
  });

  if (includeReverseRuntime) {
    summary.reverse = {
      assets: reverseAssetStore?.snapshot?.() ?? null,
      regression: await runReverseRegressionSuite({
        workflow,
        summary,
        results,
        assetStore: reverseAssetStore,
      }),
    };

    if (summary.reverse?.regression && reverseAssetStore) {
      await reverseAssetStore.recordRegressionReport(
        signerAssetId ?? workflow.name,
        summary.reverse.regression,
      );
    }
  }

  summary.alertDelivery = await dispatchAlerts({
    workflow,
    summary,
    logger,
  });

  if (alertOutbox && summary.alertDelivery.enabled && !summary.alertDelivery.delivered && summary.alertDelivery.attempted) {
    const queuedAlert = await alertOutbox.enqueueFromDispatch({
      workflow,
      summary,
      dispatchResult: summary.alertDelivery,
    });
    if (queuedAlert) {
      summary.alertDelivery.queued = true;
      summary.alertDelivery.outboxId = queuedAlert.id;
    }
  }

  return summary;
}

function buildCoreSummaryRecords({ requestQueueSummary, autoscaleSnapshot, summary, includeReverseRuntime = false }) {
  const records = [
    ['QUEUE', requestQueueSummary ?? {}],
    ['AUTOSCALE', autoscaleSnapshot ?? {}],
    ['FRONTIER', summary.frontier],
    ['CHANGE_TRACKING', summary.changeTracking],
    ['QUALITY', summary.quality],
    ['CRAWL_POLICY', summary.crawlPolicy],
    ['RATE_LIMITER', summary.rateLimiter],
    ['OBSERVABILITY', summary.observability],
    ['HTTP_CACHE', summary.httpCache],
    ['DIAGNOSTICS', summary.diagnostics],
  ];

  if (includeReverseRuntime) {
    records.push(['REVERSE_RUNTIME', summary.reverse]);
  }

  records.push(['REPLAY_RECIPE', summary.diagnostics?.recipe ?? null]);
  return records;
}

function buildSupplementalSummaryRecords({ changeFeed = [], summary }) {
  const records = [];

  if (changeFeed.length > 0) {
    records.push(['CHANGE_FEED', changeFeed]);
  }

  records.push(
    ['BASELINE', summary.baseline],
    ['TREND', summary.trend],
    ['ALERT_DELIVERY', summary.alertDelivery],
  );

  if (summary.sessions) {
    records.push(['SESSIONS', summary.sessions]);
  }

  return records;
}

async function writeSummaryRecords(keyValueStore, records = []) {
  for (const [key, value] of records) {
    await keyValueStore.setRecord(key, value);
  }
}

export async function persistTerminalSummaryState({
  sink,
  keyValueStore,
  requestQueueSummary,
  autoscaleSnapshot,
  summary,
  persistFailedRequests,
  changeFeed = [],
  includeReverseRuntime = false,
} = {}) {
  await sink.writeSummary(summary);
  await writeSummaryRecords(
    keyValueStore,
    buildCoreSummaryRecords({
      requestQueueSummary,
      autoscaleSnapshot,
      summary,
      includeReverseRuntime,
    }),
  );
  await persistFailedRequests?.();
  await writeSummaryRecords(
    keyValueStore,
    buildSupplementalSummaryRecords({
      changeFeed,
      summary,
    }),
  );
}

export async function finalizeTerminalSummary({
  exportManager,
  workflow,
  summary,
  sink,
  keyValueStore,
  historyStore,
} = {}) {
  summary.exports = await exportManager.exportConfigured(workflow.export);
  await sink.writeSummary(summary);
  await keyValueStore.setRecord('EXPORTS', summary.exports);
  await historyStore?.append(summary);
}
