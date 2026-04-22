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

function mergeObjects(base = {}, next = {}) {
  return {
    ...(base ?? {}),
    ...(next ?? {}),
  };
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function mergeAuthStatePlans(...plans) {
  const normalized = plans.filter((plan) => plan && typeof plan === 'object');
  if (normalized.length === 0) {
    return null;
  }

  return normalized.reduce((acc, plan) => ({
    kind: 'auth-state-plan',
    loginWallDetected: acc.loginWallDetected || plan.loginWallDetected === true,
    loginWallReasons: unique([...(acc.loginWallReasons ?? []), ...(plan.loginWallReasons ?? [])]),
    sessionLikelyRequired: acc.sessionLikelyRequired || plan.sessionLikelyRequired === true,
    requiredCookies: unique([...(acc.requiredCookies ?? []), ...(plan.requiredCookies ?? [])]),
    cookieValues: mergeObjects(acc.cookieValues, plan.cookieValues),
    requiredHeaders: mergeObjects(acc.requiredHeaders, plan.requiredHeaders),
    replayState: mergeObjects(acc.replayState, plan.replayState),
    refreshLikely: acc.refreshLikely || plan.refreshLikely === true,
    csrfFields: unique([...(acc.csrfFields ?? []), ...(plan.csrfFields ?? [])]),
  }), {
    kind: 'auth-state-plan',
    loginWallDetected: false,
    loginWallReasons: [],
    sessionLikelyRequired: false,
    requiredCookies: [],
    cookieValues: {},
    requiredHeaders: {},
    replayState: {},
    refreshLikely: false,
    csrfFields: [],
  });
}

function buildAuthReplayInitScript(authStatePlan = {}) {
  const replayState = authStatePlan.replayState ?? {};
  const serialized = JSON.stringify(replayState);
  return `
(() => {
  const authState = ${serialized};
  window.__OMNICRAWL_AUTH_STATE = authState;
  for (const [key, value] of Object.entries(authState)) {
    try {
      if (value === null || value === undefined) continue;
      localStorage.setItem(key, String(value));
    } catch {}
    try {
      if (value === null || value === undefined) continue;
      sessionStorage.setItem(key, String(value));
    } catch {}
  }
})();
`.trim();
}

function buildAuthReplayCookies(authStatePlan = {}, workflow) {
  const url = workflow?.seedUrls?.[0] ?? null;
  if (!url) {
    return [];
  }

  return Object.entries(authStatePlan.cookieValues ?? {}).map(([name, value]) => ({
    name,
    value: String(value),
    url,
    path: '/',
  }));
}

export function buildWorkflowRepairPlan({
  workflow,
  diagnostics = {},
  recipe = {},
  failedRequests = [],
  authStatePlan = null,
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

  const mergedAuthStatePlan = mergeAuthStatePlans(
    authStatePlan,
    diagnostics?.authStatePlan,
    recipe?.authStatePlan,
  );

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

  const authRepairNeeded =
    hasSuspect(diagnostics, 'auth-or-session-state')
    || mergedAuthStatePlan?.sessionLikelyRequired
    || mergedAuthStatePlan?.loginWallDetected;

  if (authRepairNeeded) {
    patch.session = {
      ...(workflow.session ?? {}),
      enabled: true,
      scope: workflow.session?.scope ?? 'job',
      captureStorage: true,
    };

    const priorReplay = (patch.browser ?? workflow.browser ?? {}).replay ?? {};
    const nextReplay = {
      ...priorReplay,
      steps: toArray(priorReplay.steps),
      initScripts: [...toArray(priorReplay.initScripts)],
      cookies: [...toArray(priorReplay.cookies)],
    };

    if (mergedAuthStatePlan && Object.keys(mergedAuthStatePlan.replayState ?? {}).length > 0) {
      nextReplay.initScripts.push(buildAuthReplayInitScript(mergedAuthStatePlan));
    }

    const replayCookies = buildAuthReplayCookies(mergedAuthStatePlan ?? {}, workflow);
    if (replayCookies.length > 0) {
      nextReplay.cookies.push(...replayCookies);
    }

    patch.browser = {
      ...(patch.browser ?? workflow.browser ?? {}),
      replay: nextReplay,
    };

    if (mergedAuthStatePlan && Object.keys(mergedAuthStatePlan.requiredHeaders ?? {}).length > 0) {
      patch.headers = {
        ...(workflow.headers ?? {}),
        ...mergedAuthStatePlan.requiredHeaders,
      };
    }

    reasons.push('Enable session persistence and browser replay scaffolding for auth/session failures.');
    if ((mergedAuthStatePlan?.loginWallReasons?.length ?? 0) > 0) {
      reasons.push(`Auth-state analysis detected login/session pressure: ${mergedAuthStatePlan.loginWallReasons.join(', ')}.`);
    }
    if (Object.keys(mergedAuthStatePlan?.requiredHeaders ?? {}).length > 0) {
      reasons.push('Preserve known auth headers captured from healthy/auth-adjacent responses.');
    }
    if (Object.keys(mergedAuthStatePlan?.cookieValues ?? {}).length > 0) {
      reasons.push('Seed observed auth cookies into browser replay bootstrap.');
    }
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
    authStatePlan: mergedAuthStatePlan,
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

  const job = await jobStore.create({
    workflowId,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  const runPromise = jobRunner.run(job.id);

  return {
    success: true,
    workflowId,
    jobId: job.id,
    message: `Registered workflow "${workflowId}" and started job ${job.id}`,
    runPromise,
  };
}
