import { applyWorkflowPatch } from './replay-workflow.js';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasSuspect(diagnostics, type) {
  return toArray(diagnostics?.suspects).some((entry) => entry.type === type);
}

function ensurePluginList(workflow) {
  const current = new Set(toArray(workflow.plugins).map((entry) => entry?.name).filter(Boolean));
  for (const name of ['dedupe', 'audit']) {
    current.add(name);
  }
  return [...current].map((name) => ({ name }));
}

export function buildWorkflowRepairPlan({
  workflow,
  diagnostics = {},
  recipe = {},
  failedRequests = [],
} = {}) {
  if (!workflow || typeof workflow !== 'object') {
    throw new TypeError('workflow is required');
  }

  const reasons = [];
  const patch = {
    plugins: ensurePluginList(workflow),
    output: {
      ...(workflow.output ?? {}),
      persistBodies: true,
      console: false,
    },
  };

  const recommendedMode = recipe.recommendedMode ?? workflow.mode ?? 'http';
  if (recommendedMode !== workflow.mode) {
    patch.mode = recommendedMode;
    reasons.push(`Switch mode from ${workflow.mode} to ${recommendedMode} based on replay recipe.`);
  }

  if (recommendedMode === 'browser' || recommendedMode === 'hybrid') {
    patch.browser = {
      ...(workflow.browser ?? {}),
      headless: workflow.browser?.headless ?? true,
      waitUntil: workflow.browser?.waitUntil ?? 'networkidle2',
      sleepMs: Math.max(800, Number(workflow.browser?.sleepMs ?? 0)),
      debug: {
        ...(workflow.browser?.debug ?? {}),
        enabled: true,
        persistArtifacts: true,
      },
    };
  }

  if (hasSuspect(diagnostics, 'auth-or-session-state')) {
    patch.session = {
      ...(workflow.session ?? {}),
      enabled: true,
      scope: workflow.session?.scope ?? 'job',
      captureStorage: true,
    };
    patch.browser = {
      ...(patch.browser ?? workflow.browser ?? {}),
      replay: {
        ...((patch.browser ?? workflow.browser ?? {}).replay ?? {}),
        steps: toArray(((patch.browser ?? workflow.browser ?? {}).replay ?? {}).steps),
      },
    };
    reasons.push('Enable session persistence and browser replay scaffolding for auth/session failures.');
  }

  if (hasSuspect(diagnostics, 'signature-or-parameter-chain') || hasSuspect(diagnostics, 'runtime-signature-hardening')) {
    patch.reverse = {
      ...(workflow.reverse ?? {}),
      enabled: true,
      autoReverseAnalysis: true,
      assets: {
        ...((workflow.reverse ?? {}).assets ?? {}),
        enabled: true,
        captureSignerFromResponse: true,
      },
    };
    patch.signer = {
      ...(workflow.signer ?? {}),
      enabled: true,
      capture: {
        ...((workflow.signer ?? {}).capture ?? {}),
        enabled: true,
      },
      regression: {
        ...((workflow.signer ?? {}).regression ?? {}),
        enabled: true,
      },
    };
    reasons.push('Enable reverse analysis, signer capture, and signer regression scaffolding for signature-related failures.');
  }

  if (hasSuspect(diagnostics, 'fingerprint-or-anti-bot') || hasSuspect(diagnostics, 'identity-drift')) {
    patch.identity = {
      ...(workflow.identity ?? {}),
      enabled: true,
      consistency: {
        ...((workflow.identity ?? {}).consistency ?? {}),
        httpHeaders: true,
        browserProfile: true,
        driftDetection: true,
        autoCorrect: true,
      },
    };
    reasons.push('Strengthen identity consistency for anti-bot or identity drift issues.');
  }

  if (hasSuspect(diagnostics, 'proxy-or-network-quality')) {
    patch.retry = {
      ...(workflow.retry ?? {}),
      attempts: Math.max(2, Number(workflow.retry?.attempts ?? 1)),
      backoffMs: Math.max(1000, Number(workflow.retry?.backoffMs ?? 0)),
    };
    reasons.push('Increase retry resilience for network/proxy quality failures.');
  }

  if (toArray(workflow.extract).length === 0 || hasSuspect(diagnostics, 'degraded-success')) {
    patch.extract = toArray(workflow.extract).length > 0
      ? workflow.extract
      : [
          { name: 'title', type: 'selector', selector: 'title' },
          { name: 'surface', type: 'surface' },
        ];
    reasons.push('Ensure extraction rules exist so degraded-success pages are easier to diagnose.');
  }

  if (failedRequests.length > 0) {
    reasons.push(`Observed ${failedRequests.length} failed requests; preserve bodies and debug artifacts for next run.`);
  }

  const rebuiltWorkflow = applyWorkflowPatch(workflow, patch);
  return {
    patch,
    reasons,
    rebuiltWorkflow,
    suggestedWorkflowId: `${workflow.name}-repaired`,
    quickActions: {
      registerAndRerun: {
        enabled: true,
        workflowId: `${workflow.name}-repaired`,
        endpoint: '/api/workflows/register-and-run',
      },
    },
  };
}

/**
 * Register repaired workflow and immediately start a new job
 */
export async function registerAndRerunRepair({
  repairPlan,
  jobStore,
  workflowRegistry,
  jobRunner,
} = {}) {
  if (!repairPlan?.rebuiltWorkflow) {
    throw new TypeError('repairPlan.rebuiltWorkflow is required');
  }

  const workflowId = repairPlan.suggestedWorkflowId;
  
  // Register repaired workflow
  await workflowRegistry.register({
    id: workflowId,
    workflow: repairPlan.rebuiltWorkflow,
    metadata: {
      source: 'auto-repair',
      originalWorkflow: repairPlan.rebuiltWorkflow.name,
      repairReasons: repairPlan.reasons,
      createdAt: new Date().toISOString(),
    },
  });

  // Create and start new job
  const job = await jobStore.create({
    workflowId,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  // Start job execution
  const runPromise = jobRunner.run(job.id);

  return {
    success: true,
    workflowId,
    jobId: job.id,
    message: `Registered workflow "${workflowId}" and started job ${job.id}`,
    runPromise,
  };
}
