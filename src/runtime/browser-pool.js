import { createHash } from 'node:crypto';
import { createLogger } from '../core/logger.js';
import { getAvailableBrowserBackends, normalizeBrowserEngine, resolveBrowserBackend } from './browser-backend.js';
import { createBrowserRootCdpSession } from './browser-targets.js';
import { addInitScriptCompat } from './browser-page-compat.js';

const logger = createLogger({ component: 'browser-pool' });
const entries = new Map();

function resolveProxySettings(proxy = undefined, browserConfig = {}) {
  const candidate = proxy ?? browserConfig.proxy ?? null;
  if (!candidate?.server) {
    return null;
  }
  return {
    server: candidate.server,
    username: candidate.username ?? null,
    password: candidate.password ?? null,
    bypass: Array.isArray(candidate.bypass) ? candidate.bypass : [],
  };
}

function proxyKeyFragment(proxySettings) {
  if (!proxySettings) {
    return { server: null, auth: null, bypass: [] };
  }
  const authSource = `${proxySettings.username ?? ''}:${proxySettings.password ?? ''}`;
  const auth = proxySettings.username || proxySettings.password
    ? createHash('sha256').update(authSource).digest('hex').slice(0, 12)
    : null;
  return {
    server: proxySettings.server,
    auth,
    bypass: proxySettings.bypass,
  };
}

function normalizeEngine(browserConfig = {}) {
  return normalizeBrowserEngine(browserConfig.engine);
}

function resolveNamespace(browserConfig = {}) {
  return browserConfig.pool?.namespace ?? null;
}

function browserKey(browserConfig = {}, proxy = undefined, backendName = null) {
  const proxySettings = resolveProxySettings(proxy, browserConfig);
  return JSON.stringify({
    namespace: resolveNamespace(browserConfig),
    engine: backendName ?? normalizeEngine(browserConfig),
    headless: browserConfig.headless ?? true,
    viewport: browserConfig.viewport ?? { width: 1440, height: 900 },
    executablePath: browserConfig.executablePath ?? null,
    proxy: proxyKeyFragment(proxySettings),
  });
}

function launchArgs(browserConfig = {}, proxy = undefined) {
  const args = [...(browserConfig.launchArgs ?? [])];
  const proxySettings = resolveProxySettings(proxy, browserConfig);
  const proxyServer = proxySettings?.server;

  if (proxyServer && !args.some((item) => item.startsWith('--proxy-server='))) {
    args.push(`--proxy-server=${proxyServer}`);
  }

  const bypass = proxySettings?.bypass;
  if (Array.isArray(bypass) && bypass.length > 0 && !args.some((item) => item.startsWith('--proxy-bypass-list='))) {
    args.push(`--proxy-bypass-list=${bypass.join(';')}`);
  }

  return args;
}

function buildPlaywrightProxyOptions(proxy = undefined, browserConfig = {}) {
  const proxySettings = resolveProxySettings(proxy, browserConfig);
  if (!proxySettings?.server) {
    return undefined;
  }
  return {
    server: proxySettings.server,
    username: proxySettings.username ?? undefined,
    password: proxySettings.password ?? undefined,
    bypass: proxySettings.bypass.length > 0 ? proxySettings.bypass.join(',') : undefined,
  };
}

function getPoolOptions(browserConfig = {}) {
  return {
    maxBrowsers: browserConfig.pool?.maxBrowsers ?? 2,
    closeIdleMs: browserConfig.pool?.closeIdleMs ?? 120000,
  };
}

function normalizeWaitUntilForBackend(backendFamily, waitUntil) {
  const value = String(waitUntil ?? '').trim().toLowerCase();
  if (!value) {
    return backendFamily === 'playwright' ? 'load' : 'load';
  }
  if (backendFamily === 'playwright') {
    if (value === 'networkidle2' || value === 'networkidle0') {
      return 'networkidle';
    }
  }
  return value;
}

function hasPersistentContexts(entry) {
  return entry.contexts.size > 0;
}

async function closeEntry(key, { force = false } = {}) {
  const entry = entries.get(key);
  if (!entry) {
    return;
  }

  if (!force && hasPersistentContexts(entry)) {
    return;
  }

  try {
    for (const context of entry.contexts.values()) {
      await context.close().catch(() => {});
    }
    if (entry.sharedContext && !entry.contexts.has('__shared__')) {
      await entry.sharedContext.close?.().catch(() => {});
    }
    await entry.browser.close().catch(() => {});
  } finally {
    entries.delete(key);
  }
}

async function cleanupIdleEntries() {
  const now = Date.now();
  const candidates = [];

  for (const [key, entry] of entries.entries()) {
    if (entry.activePages === 0 && !hasPersistentContexts(entry) && now - entry.lastUsedAt >= entry.closeIdleMs) {
      candidates.push(key);
    }
  }

  for (const key of candidates) {
    await closeEntry(key);
  }
}

async function enforcePoolLimit(maxBrowsers) {
  if (entries.size < maxBrowsers) {
    return;
  }

  const idleEntries = [...entries.entries()]
    .filter(([, entry]) => entry.activePages === 0)
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);

  if (idleEntries.length === 0) {
    return;
  }

  await closeEntry(idleEntries[0][0]);
}

async function launchBrowser(backend, browserConfig = {}, proxy = undefined) {
  const proxySettings = resolveProxySettings(proxy, browserConfig);
  const args = backend.family === 'playwright'
    ? [...(browserConfig.launchArgs ?? [])]
    : launchArgs(browserConfig, proxySettings);
  if (backend.family === 'playwright') {
    return backend.launcher.launch({
      headless: browserConfig.headless ?? true,
      executablePath: browserConfig.executablePath,
      args,
      proxy: buildPlaywrightProxyOptions(proxySettings),
    });
  }

  return backend.launcher.launch({
    headless: browserConfig.headless ?? true,
    defaultViewport: browserConfig.viewport ?? { width: 1440, height: 900 },
    executablePath: browserConfig.executablePath,
    args,
  });
}

async function getOrCreateEntry(browserConfig = {}, proxy = undefined) {
  await cleanupIdleEntries();
  const requestedEngine = normalizeEngine(browserConfig);
  const proxySettings = resolveProxySettings(proxy, browserConfig);
  const backend = resolveBrowserBackend(requestedEngine, {
    executablePath: browserConfig.executablePath,
  });
  if (!backend) {
    throw new Error(`browser engine not available: ${requestedEngine}`);
  }

  const key = browserKey(browserConfig, proxy, backend.name);
  const existing = entries.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  const poolOptions = getPoolOptions(browserConfig);
  await enforcePoolLimit(poolOptions.maxBrowsers);
  const browser = await launchBrowser(backend, browserConfig, proxy);

  const entry = {
    key,
    namespace: resolveNamespace(browserConfig),
    requestedEngine,
    backend: backend.name,
    backendFamily: backend.family,
    browser,
    browserConfig,
    activePages: 0,
    launchedAt: Date.now(),
    lastUsedAt: Date.now(),
    closeIdleMs: poolOptions.closeIdleMs,
    contexts: new Map(),
    sharedContext: null,
    proxyServer: proxySettings?.server ?? null,
    headless: browserConfig.headless ?? true,
  };

  entries.set(key, entry);
  logger.info('browser launched', {
    key,
    backend: entry.backend,
    proxyServer: entry.proxyServer,
  });
  return entry;
}

async function createContextForEntry(entry, browserConfig = {}) {
  if (entry.backendFamily === 'playwright') {
    return entry.browser.newContext({
      viewport: browserConfig.viewport ?? { width: 1440, height: 900 },
      userAgent: browserConfig.userAgent,
    });
  }
  return entry.browser.createBrowserContext();
}

async function getSharedContext(entry, browserConfig = {}) {
  if (entry.sharedContext) {
    return entry.sharedContext;
  }
  if (entry.backendFamily === 'playwright') {
    entry.sharedContext = await entry.browser.newContext({
      viewport: browserConfig.viewport ?? { width: 1440, height: 900 },
      userAgent: browserConfig.userAgent,
    });
  } else {
    entry.sharedContext = entry.browser.defaultBrowserContext();
  }
  return entry.sharedContext;
}

export async function acquireBrowserLease({ browserConfig = {}, proxy, sessionId = null, isolate = true } = {}) {
  const entry = await getOrCreateEntry(browserConfig, proxy);
  let context;
  let temporaryContext = false;

  if (sessionId && isolate) {
    context = entry.contexts.get(sessionId);
    if (!context) {
      context = await createContextForEntry(entry, browserConfig);
      entry.contexts.set(sessionId, context);
    }
  } else if (isolate) {
    context = await createContextForEntry(entry, browserConfig);
    temporaryContext = true;
  } else {
    context = await getSharedContext(entry, browserConfig);
  }

  entry.activePages += 1;
  entry.lastUsedAt = Date.now();

  return {
    browser: entry.browser,
    context,
    entry,
    requestedEngine: entry.requestedEngine,
    backend: entry.backend,
    backendFamily: entry.backendFamily,
    normalizeWaitUntil(waitUntil) {
      return normalizeWaitUntilForBackend(entry.backendFamily, waitUntil);
    },
    async createCdpSession(page) {
      if (entry.backendFamily === 'playwright') {
        return context.newCDPSession(page);
      }
      return page.target().createCDPSession();
    },
    async createBrowserCdpSession() {
      return createBrowserRootCdpSession(entry.browser);
    },
    async addInitScript(page, script, arg) {
      await addInitScriptCompat(page, script, arg);
    },
    async setUserAgent(page, userAgent) {
      if (!userAgent) {
        return;
      }
      if (typeof page.setUserAgent === 'function') {
        await page.setUserAgent(userAgent);
        return;
      }
      await page.setExtraHTTPHeaders?.({ 'user-agent': userAgent }).catch(() => {});
      await page.addInitScript?.((ua) => {
        try {
          Object.defineProperty(navigator, 'userAgent', {
            get: () => ua,
            configurable: true,
          });
        } catch (_error) {}
      }, userAgent).catch(() => {});
    },
    async setViewport(page, viewport) {
      if (!page || !viewport || typeof viewport !== 'object') {
        return;
      }
      if (typeof page.setViewport === 'function') {
        await page.setViewport(viewport);
        return;
      }
      await page.setViewportSize?.(viewport);
    },
    async setCookies(page, cookies = []) {
      if (!Array.isArray(cookies) || cookies.length === 0) {
        return;
      }
      if (typeof page?.setCookie === 'function') {
        await page.setCookie(...cookies);
        return;
      }
      if (typeof context?.addCookies === 'function') {
        await context.addCookies(cookies);
        return;
      }
      if (typeof context?.setCookie === 'function') {
        await context.setCookie(...cookies);
      }
    },
    async getCookies(page, urls = undefined) {
      if (typeof page?.cookies === 'function') {
        const normalizedUrls = Array.isArray(urls) ? urls : urls ? [urls] : [];
        return normalizedUrls.length > 0 ? page.cookies(...normalizedUrls) : page.cookies();
      }
      if (typeof context?.cookies === 'function') {
        const normalizedUrls = Array.isArray(urls) ? urls : urls ? [urls] : [];
        return normalizedUrls.length > 0 ? context.cookies(normalizedUrls) : context.cookies();
      }
      return [];
    },
    async authenticate(page, credentials = {}) {
      if (!page || (!credentials.username && !credentials.password)) {
        return;
      }
      if (typeof page.authenticate === 'function') {
        await page.authenticate({
          username: credentials.username ?? '',
          password: credentials.password ?? '',
        });
        return;
      }
      if (typeof context?.setHTTPCredentials === 'function') {
        // Proxy credentials for Playwright are configured at browser launch time.
        return;
      }
    },
    async release() {
      entry.activePages = Math.max(0, entry.activePages - 1);
      entry.lastUsedAt = Date.now();

      if (temporaryContext) {
        await context.close().catch(() => {});
      }

      await cleanupIdleEntries();
    },
  };
}

export function getBrowserPoolSnapshot() {
  return {
    size: entries.size,
    availableBackends: getAvailableBrowserBackends().map((backend) => ({
      name: backend.name,
      family: backend.family,
      defaultReady: backend.defaultReady,
      packageName: backend.packageName,
    })),
    items: [...entries.values()].map((entry) => ({
      key: entry.key,
      requestedEngine: entry.requestedEngine,
      backend: entry.backend,
      backendFamily: entry.backendFamily,
      proxyServer: entry.proxyServer,
      activePages: entry.activePages,
      contextCount: entry.contexts.size + (entry.sharedContext ? 1 : 0),
      launchedAt: new Date(entry.launchedAt).toISOString(),
      lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
      headless: entry.headless,
    })),
  };
}

export { buildPlaywrightProxyOptions, normalizeWaitUntilForBackend };

export async function closeBrowserPool({ namespace, force = false } = {}) {
  for (const [key, entry] of [...entries.entries()]) {
    if (namespace !== undefined && entry.namespace !== namespace) {
      continue;
    }
    await closeEntry(key, { force });
  }
}
