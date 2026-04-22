import { validateWorkflow } from '../schemas/workflow-schema.js';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeName(name, suffix) {
  const base = String(name ?? 'workflow').trim() || 'workflow';
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

function shouldUseBalancedHooks(recipe = {}) {
  const mode = recipe.recommendedMode;
  return mode === 'browser' || mode === 'hybrid';
}

function buildRateLimiterConfig(existing = {}, recipe = {}) {
  if (recipe.recommendedMode === 'http') {
    return {
      enabled: existing.enabled ?? true,
      requestsPerSecond: existing.requestsPerSecond ?? 1,
      maxConcurrent: existing.maxConcurrent ?? existing.burstSize ?? 1,
      minDelayMs: existing.minDelayMs ?? 0,
      maxDelayMs: existing.maxDelayMs ?? 0,
      burstSize: existing.burstSize ?? 1,
      autoThrottle: {
        enabled: existing.autoThrottle?.enabled ?? false,
        ...(existing.autoThrottle ?? {}),
      },
    };
  }

  return {
    enabled: true,
    requestsPerSecond: Math.min(Number(existing.requestsPerSecond ?? 1), 1),
    maxConcurrent: 1,
    minDelayMs: Math.max(250, Number(existing.minDelayMs ?? 0)),
    maxDelayMs: Math.max(1000, Number(existing.maxDelayMs ?? 0)),
    burstSize: 1,
    autoThrottle: {
      enabled: false,
      ...(existing.autoThrottle ?? {}),
    },
  };
}

function firstSeedUrl(workflow = {}) {
  const seedRequestUrl = Array.isArray(workflow.seedRequests) ? workflow.seedRequests[0]?.url : null;
  return seedRequestUrl ?? workflow.seedUrls?.[0] ?? null;
}

function cookieTemplateForUrl(url, name, index) {
  return {
    name,
    value: `__FILL_COOKIE_${String(name || index + 1).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}__`,
    ...(url ? { url } : {}),
  };
}

function storageTemplateForKey(key, index) {
  return {
    area: 'localStorage',
    key,
    value: `__FILL_STORAGE_${String(key || index + 1).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}__`,
  };
}

function normalizeRecordingWorkflowName(session = {}) {
  const raw = String(session.name ?? session.id ?? 'login-recording').trim() || 'login-recording';
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'login-recording';
}

function toStorageSeedEntries(replayState = {}) {
  return Object.entries(replayState ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({
      area: 'localStorage',
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));
}

function toCookieEntries(cookieValues = {}, targetUrl) {
  return Object.entries(cookieValues ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({
      name,
      value: String(value),
      ...(targetUrl ? { url: targetUrl } : {}),
      path: '/',
    }));
}

function normalizeScrollTarget(value) {
  const text = String(value ?? 'bottom').toLowerCase();
  if (text === 'up' || text === 'top') return 'top';
  return 'bottom';
}

function normalizeReplayStep(step = {}, index = 0, fallbackUrl = null) {
  const type = String(step.type ?? '').trim().toLowerCase();
  switch (type) {
    case 'navigate':
      return {
        type: 'navigate',
        url: step.url ?? step.value ?? fallbackUrl ?? null,
      };

    case 'click':
      return step.selector
        ? {
            type: 'click',
            selector: step.selector,
            waitForNavigation: step.waitForNavigation === true,
          }
        : null;

    case 'type':
      return step.selector
        ? {
            type: 'type',
            selector: step.selector,
            value: String(step.value ?? ''),
            clear: step.clear !== false,
          }
        : null;

    case 'press':
    case 'key':
      return {
        type: 'press',
        keyPress: String(step.value ?? step.keyPress ?? 'Enter'),
      };

    case 'scroll':
      return {
        type: 'scroll',
        ...(step.selector ? { selector: step.selector } : {}),
        to: normalizeScrollTarget(step.value ?? step.direction),
      };

    case 'wait':
      return {
        type: 'wait',
        durationMs: Math.max(0, Number(step.durationMs ?? step.value ?? 1000) || 1000),
      };

    case 'select':
      return step.selector
        ? {
            type: 'select',
            selector: step.selector,
            optionLabel: typeof step.value === 'string' ? step.value : undefined,
          }
        : null;

    default:
      return null;
  }
}

function buildReplayStepsFromRecording(session = {}) {
  const steps = ensureArray(session.steps)
    .map((step, index) => normalizeReplayStep(step, index, session.url ?? null))
    .filter(Boolean);

  if (!steps.some((step) => step.type === 'navigate') && session.url) {
    steps.unshift({ type: 'navigate', url: session.url });
  }

  return steps;
}

function collectObservedUrls(session = {}) {
  return ensureArray(session.steps)
    .flatMap((step) => [step.url, step.finalUrl, step.value])
    .filter((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
}

function inferReplayFinalUrl(session = {}) {
  const candidates = collectObservedUrls(session);
  const preferred = candidates.find((url) => !/\/(login|signin|sign-in|auth)(\/|$|\?)/i.test(url));
  return preferred ?? candidates[candidates.length - 1] ?? null;
}

function inferSuccessSelector(session = {}) {
  const htmlSnippets = ensureArray(session.steps)
    .map((step) => step.html)
    .filter((value) => typeof value === 'string' && value.trim());

  for (const html of htmlSnippets) {
    if (/id=["']logout["']/i.test(html)) return '#logout';
    if (/id=["']account["']/i.test(html)) return '#account';
    if (/data-testid=["']logout["']/i.test(html)) return '[data-testid="logout"]';
    if (/data-testid=["']account["']/i.test(html)) return '[data-testid="account"]';
    if (/(logout|sign out|my account|dashboard)/i.test(html)) {
      return 'body';
    }
  }

  return null;
}

function buildAuthExtractionSteps(authStatePlan = {}) {
  const steps = [];
  const replayKeys = Object.keys(authStatePlan.replayState ?? {});
  for (const key of replayKeys.slice(0, 8)) {
    steps.push({
      type: 'extractState',
      source: 'localStorage',
      key,
      saveAs: key,
    });
  }
  for (const name of ensureArray(authStatePlan.requiredCookies).slice(0, 8)) {
    steps.push({
      type: 'extractState',
      source: 'cookie',
      key: name,
      saveAs: name,
    });
  }
  return steps;
}

function buildReplayBootstrap(authStatePlan = {}) {
  const replayState = authStatePlan.replayState ?? {};
  if (!isPlainObject(replayState) || Object.keys(replayState).length === 0) {
    return [];
  }

  return [`
(() => {
  const state = ${JSON.stringify(replayState)};
  window.__OMNICRAWL_RECORDED_AUTH_STATE = state;
  for (const [key, value] of Object.entries(state)) {
    try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch {}
    try { sessionStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch {}
  }
})();
`.trim()];
}

export function buildReplayWorkflowPatchTemplate({ workflow = {}, recipe = {} } = {}) {
  const url = firstSeedUrl(workflow);
  const recommendedMode = recipe.recommendedMode ?? workflow.mode ?? 'http';
  const tokenLikeStorageKeys = ensureArray(recipe.capture?.tokenLikeStorageKeys)
    .slice(0, 10)
    .map((entry) => entry?.key)
    .filter(Boolean);
  const cookieNames = ensureArray(recipe.capture?.cookieNames)
    .slice(0, 10)
    .map((entry) => entry?.name)
    .filter(Boolean);
  const topEndpoints = ensureArray(recipe.capture?.topEndpoints)
    .slice(0, 5)
    .map((entry) => entry?.endpoint)
    .filter(Boolean);

  const patch = {
    browser: {
      replay: {
        initScripts: recommendedMode === 'browser' || recommendedMode === 'hybrid'
          ? ['window.__replayBootstrap = "__FILL_INIT_SCRIPT__";']
          : [],
        storageSeeds: tokenLikeStorageKeys.map(storageTemplateForKey),
        cookies: cookieNames.map((name, index) => cookieTemplateForUrl(url, name, index)),
        blockResourceTypes: recommendedMode === 'browser' || recommendedMode === 'hybrid'
          ? ['image', 'media', 'font']
          : [],
        blockUrlPatterns: [],
        steps: recommendedMode === 'browser' || recommendedMode === 'hybrid'
          ? [
              { type: 'navigate', url: '__FILL_BOOTSTRAP_URL__' },
              { type: 'waitForSelector', selector: '__FILL_READY_SELECTOR__', timeoutMs: 15000 },
              ...tokenLikeStorageKeys.slice(0, 3).map((key) => ({
                type: 'extractState',
                source: 'localStorage',
                key,
                saveAs: key,
              })),
              { type: 'setHeader', name: 'x-replay-bootstrap', value: '__FILL_HEADER_VALUE__' },
            ]
          : [],
      },
    },
  };

  if (recipe.generatedFrom?.authWallCount > 0) {
    patch.headers = {
      authorization: 'Bearer __FILL_AUTHORIZATION__',
    };
  }

  return {
    version: 1,
    targetUrl: url,
    recommendedMode,
    patch,
    hints: {
      topEndpoints,
      tokenLikeStorageKeys,
      cookieNames,
      instructions: [
        'Fill placeholder values before calling POST /jobs/:jobId/replay-workflow/run with { workflowPatch }.',
        'Prefer real bootstrap cookies/storage values captured from a healthy browser session.',
        'Remove authorization/storage placeholders that are not required by the target.',
      ],
    },
  };
}

export function applyWorkflowPatch(workflow, patch = {}) {
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
    return validateWorkflow(workflow);
  }

  const merge = (left, right) => {
    if (Array.isArray(right)) {
      return clone(right);
    }
    if (!isPlainObject(left) || !isPlainObject(right)) {
      return clone(right);
    }

    const next = { ...clone(left) };
    for (const [key, value] of Object.entries(right)) {
      if (value === undefined) {
        continue;
      }
      next[key] = key in next ? merge(next[key], value) : clone(value);
    }
    return next;
  };

  return validateWorkflow(merge(workflow, patch));
}

export function buildReplayWorkflow({ workflow, recipe = {}, replayOf = null } = {}) {
  if (!workflow || typeof workflow !== 'object') {
    throw new TypeError('workflow is required');
  }

  const base = clone(workflow);
  const recommendedMode = recipe.recommendedMode ?? base.mode ?? 'http';
  const browserLike = recommendedMode === 'browser' || recommendedMode === 'hybrid';
  const balancedHooks = shouldUseBalancedHooks(recipe);
  const existingProxyPool = base.proxyPool ?? {};
  const existingSession = base.session ?? {};
  const existingBrowser = base.browser ?? {};
  const existingRetry = base.retry ?? {};
  const existingRequestQueue = base.requestQueue ?? {};

  const next = {
    ...base,
    name: normalizeName(base.name, '-replay'),
    mode: recommendedMode,
    concurrency: browserLike ? 1 : Math.max(1, Math.min(Number(base.concurrency ?? 1), 2)),
    maxDepth: 0,
    discovery: {
      ...(base.discovery ?? {}),
      enabled: false,
      maxPages: 1,
    },
    browser: {
      ...existingBrowser,
      headless: existingBrowser.headless ?? true,
      waitUntil: browserLike ? 'domcontentloaded' : (existingBrowser.waitUntil ?? 'networkidle2'),
      replay: {
        ...(existingBrowser.replay ?? {}),
        initScripts: ensureArray(existingBrowser.replay?.initScripts),
        storageSeeds: ensureArray(existingBrowser.replay?.storageSeeds),
        cookies: ensureArray(existingBrowser.replay?.cookies),
        steps: ensureArray(existingBrowser.replay?.steps),
        blockUrlPatterns: ensureArray(existingBrowser.replay?.blockUrlPatterns),
        blockResourceTypes: ensureArray(existingBrowser.replay?.blockResourceTypes).length > 0
          ? ensureArray(existingBrowser.replay?.blockResourceTypes)
          : (browserLike ? ['image', 'media', 'font'] : []),
      },
      debug: {
        ...(existingBrowser.debug ?? {}),
        enabled: browserLike || existingBrowser.debug?.enabled === true,
        captureScripts: true,
        captureNetwork: true,
        captureSourceMaps: true,
        captureHooks: true,
        hookMode: balancedHooks ? 'balanced' : (existingBrowser.debug?.hookMode ?? 'strict'),
        persistArtifacts: true,
      },
    },
    session: {
      ...existingSession,
      enabled: true,
      persist: true,
      isolate: true,
      captureStorage: true,
      scope: existingSession.scope ?? 'job',
      pool: {
        ...(existingSession.pool ?? {}),
        enabled: browserLike ? (existingSession.pool?.enabled ?? false) : (existingSession.pool?.enabled ?? false),
        bindProxy: true,
      },
    },
    proxyPool: {
      ...existingProxyPool,
      stickyBySession: true,
      strategy: existingProxyPool.strategy ?? 'stickySession',
      allowDirectFallback: existingProxyPool.allowDirectFallback ?? false,
    },
    retry: {
      ...existingRetry,
      attempts: Math.max(2, Number(existingRetry.attempts ?? 1)),
      strategy: existingRetry.strategy ?? 'exponential',
      backoffMs: Math.max(500, Number(existingRetry.backoffMs ?? 0)),
      respectRetryAfter: true,
    },
    rateLimiter: buildRateLimiterConfig(base.rateLimiter ?? {}, recipe),
    requestQueue: {
      ...existingRequestQueue,
      hostAwareScheduling: true,
      maxInProgressPerHost: 1,
      maxInProgressPerGroup: 1,
      budgetWindowMs: Math.max(Number(existingRequestQueue.budgetWindowMs ?? 0), browserLike ? 1000 : 0),
      maxRequestsPerWindow: browserLike ? Math.max(Number(existingRequestQueue.maxRequestsPerWindow ?? 0), 1) : Number(existingRequestQueue.maxRequestsPerWindow ?? 0),
    },
    replay: {
      recipeVersion: recipe.version ?? 1,
      replayOf,
      generatedAt: new Date().toISOString(),
      recommendedMode,
      rationale: ensureArray(recipe.rationale).slice(0, 20),
      prerequisites: ensureArray(recipe.prerequisites).slice(0, 20),
    },
  };

  return validateWorkflow(next);
}

export function buildReplayWorkflowFromRecording({ session, options = {} } = {}) {
  if (!session || typeof session !== 'object') {
    throw new TypeError('session is required');
  }

  const targetUrl = session.url ?? options.url ?? null;
  if (!targetUrl) {
    throw new Error('session.url is required');
  }

  const authStatePlan = session.authStatePlan ?? options.authStatePlan ?? null;
  const inferredFinalUrl = inferReplayFinalUrl(session) ?? targetUrl;
  const successSelector = inferSuccessSelector(session);
  const authExtractionSteps = buildAuthExtractionSteps(authStatePlan ?? {});
  const replaySteps = buildReplayStepsFromRecording(session);
  if (successSelector) {
    replaySteps.push({
      type: 'waitForSelector',
      selector: successSelector,
      timeoutMs: Number(options.successTimeoutMs ?? 15000) || 15000,
    });
  } else {
    replaySteps.push({
      type: 'wait',
      durationMs: Number(options.successTimeoutMs ?? 1500) || 1500,
    });
  }
  replaySteps.push(...authExtractionSteps);

  const replay = {
    initScripts: buildReplayBootstrap(authStatePlan ?? {}),
    storageSeeds: toStorageSeedEntries(authStatePlan?.replayState ?? {}),
    cookies: toCookieEntries(authStatePlan?.cookieValues ?? {}, targetUrl),
    blockResourceTypes: ['image', 'media', 'font'],
    blockUrlPatterns: [],
    finalUrl: inferredFinalUrl,
    steps: replaySteps,
  };

  const workflow = {
    name: `${normalizeRecordingWorkflowName(session)}-replay`,
    seedUrls: [targetUrl],
    mode: 'browser',
    concurrency: 1,
    maxDepth: 0,
    timeoutMs: Number(options.timeoutMs ?? 45000) || 45000,
    headers: {
      ...(authStatePlan?.requiredHeaders ?? {}),
    },
    session: {
      enabled: true,
      scope: 'job',
      persist: true,
      isolate: true,
      captureStorage: true,
    },
    browser: {
      headless: options.headless !== false,
      waitUntil: 'domcontentloaded',
      sleepMs: Number(options.sleepMs ?? 800) || 800,
      replay,
      debug: {
        enabled: true,
        persistArtifacts: true,
        captureNetwork: true,
        captureScripts: true,
        captureSourceMaps: true,
        captureHooks: true,
      },
    },
    plugins: [{ name: 'dedupe' }, { name: 'audit' }],
    output: {
      dir: 'runs/recorded-replays',
      console: false,
      persistBodies: true,
    },
    replay: {
      source: 'login-recorder',
      recordingId: session.id ?? null,
      recordedAt: session.stoppedAt ?? session.createdAt ?? session.startedAt ?? null,
      successSelector,
      inferredFinalUrl,
    },
    extract: ensureArray(options.extract).length > 0
      ? clone(options.extract)
      : [{ name: 'title', type: 'selector', selector: 'title' }],
  };

  return validateWorkflow(workflow);
}
