import { createHmac } from 'node:crypto';

const SEVERITY_RANK = {
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

function getSeverityRank(value) {
  return SEVERITY_RANK[String(value ?? 'info').toLowerCase()] ?? SEVERITY_RANK.info;
}

function flattenAlerts(summary = {}) {
  return [
    ...(summary.quality?.alerts ?? []).map((entry) => ({ source: 'quality', ...entry })),
    ...(summary.baseline?.alerts ?? []).map((entry) => ({ source: 'baseline', ...entry })),
    ...(summary.trend?.alerts ?? []).map((entry) => ({ source: 'trend', ...entry })),
  ];
}

function sanitizeHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      output[String(key)] = String(value);
    }
  }
  return output;
}

function buildSignatureHeaders({ payloadText, webhook, sentAt }) {
  if (!webhook.signingSecret) {
    return {};
  }

  const algorithm = String(webhook.signatureAlgorithm ?? 'sha256').toLowerCase();
  const signature = createHmac(algorithm, webhook.signingSecret)
    .update(`${sentAt}.${payloadText}`)
    .digest('hex');

  return {
    [String(webhook.signatureHeader ?? 'x-omnicrawl-signature')]: `${algorithm}=${signature}`,
    'x-omnicrawl-timestamp': sentAt,
  };
}

export function getAlertDispatchPlan({
  workflow,
  summary,
} = {}) {
  const webhook = workflow?.quality?.alerting?.webhook;
  if (!webhook?.enabled || !webhook?.url) {
    return {
      enabled: false,
      alertCount: 0,
      filteredAlertCount: 0,
      shouldSend: false,
      webhook: null,
      payload: null,
    };
  }

  const allAlerts = flattenAlerts(summary);
  const minSeverity = String(webhook.minSeverity ?? 'warning').toLowerCase();
  const filteredAlerts = allAlerts.filter((entry) => getSeverityRank(entry.severity) >= getSeverityRank(minSeverity));

  const sentAt = new Date().toISOString();
  const payload = {
    service: 'omnicrawl',
    sentAt,
    workflowName: summary.workflowName,
    jobId: summary.jobId,
    status: summary.status,
    alerts: filteredAlerts,
    summary: webhook.includeSummary === false
      ? undefined
      : {
          pagesFetched: summary.pagesFetched,
          resultCount: summary.resultCount,
          failureCount: summary.failureCount,
          healthScore: summary.quality?.healthScore ?? null,
          baseline: {
            previousJobId: summary.baseline?.previousJobId ?? null,
            alertCount: summary.baseline?.alerts?.length ?? 0,
          },
          trend: {
            sampleCount: summary.trend?.sampleCount ?? 0,
            alertCount: summary.trend?.alerts?.length ?? 0,
          },
        },
  };

  return {
    enabled: true,
    shouldSend: filteredAlerts.length > 0,
    alertCount: allAlerts.length,
    filteredAlertCount: filteredAlerts.length,
    webhook,
    payload,
    sentAt,
  };
}

export async function deliverAlertPlan({
  plan,
  logger,
} = {}) {
  if (!plan?.enabled) {
    return {
      enabled: false,
      delivered: false,
      reason: 'webhook-disabled',
      attempted: false,
      attempts: 0,
      alertCount: plan?.alertCount ?? 0,
      filteredAlertCount: plan?.filteredAlertCount ?? 0,
      target: null,
    };
  }

  if (!plan.shouldSend) {
    return {
      enabled: true,
      delivered: false,
      reason: 'no-alerts',
      attempted: false,
      attempts: 0,
      alertCount: plan.alertCount ?? 0,
      filteredAlertCount: plan.filteredAlertCount ?? 0,
      target: plan.webhook?.url ?? null,
    };
  }

  const payloadText = JSON.stringify(plan.payload);
  const maxAttempts = Math.max(1, Number(plan.webhook?.retryAttempts ?? 2) + 1);
  const baseBackoffMs = Math.max(0, Number(plan.webhook?.retryBackoffMs ?? 1000));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(plan.webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...sanitizeHeaders(plan.webhook.headers),
          ...buildSignatureHeaders({
            payloadText,
            webhook: plan.webhook,
            sentAt: plan.sentAt,
          }),
        },
        body: payloadText,
        signal: AbortSignal.timeout(Number(plan.webhook.timeoutMs ?? 10000)),
      });

      if (!response.ok) {
        throw new Error(`webhook responded with status ${response.status}`);
      }

      return {
        enabled: true,
        delivered: true,
        reason: null,
        attempted: true,
        attempts: attempt,
        alertCount: plan.alertCount ?? 0,
        filteredAlertCount: plan.filteredAlertCount ?? 0,
        target: plan.webhook.url,
        status: response.status,
      };
    } catch (error) {
      lastError = error;
      logger?.warn?.('alert webhook delivery failed', {
        jobId: plan.payload?.jobId,
        workflowName: plan.payload?.workflowName,
        attempt,
        maxAttempts,
        error: error?.message ?? String(error),
      });

      if (attempt < maxAttempts && baseBackoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, baseBackoffMs * attempt));
      }
    }
  }

  return {
    enabled: true,
    delivered: false,
    reason: lastError?.message ?? String(lastError ?? 'unknown webhook failure'),
    attempted: true,
    attempts: maxAttempts,
    alertCount: plan.alertCount ?? 0,
    filteredAlertCount: plan.filteredAlertCount ?? 0,
    target: plan.webhook?.url ?? null,
  };
}

export async function dispatchAlerts({
  workflow,
  summary,
  logger,
} = {}) {
  const plan = getAlertDispatchPlan({
    workflow,
    summary,
  });

  return deliverAlertPlan({
    plan,
    logger,
  });
}
