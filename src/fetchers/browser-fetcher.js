import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireBrowserLease, closeBrowserPool } from '../runtime/browser-pool.js';
import { createBrowserDebugProbe } from './browser-debugger.js';
import { buildAntiDetectionHook, applyStealthProfile } from '../reverse/stealth-profile.js';
import { interpolateReplayString, hasReplayTemplate, readObjectPath } from '../utils/replay-template.js';
import { hashText } from '../utils/hash.js';

function normalizeHeaders(headers = {}) {
  const nextHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      nextHeaders[key.toLowerCase()] = String(value);
    }
  }

  return nextHeaders;
}

function buildIdentityAcceptLanguage(identity = {}) {
  if (identity.acceptLanguage) {
    return String(identity.acceptLanguage);
  }

  const languages = Array.isArray(identity.languages)
    ? identity.languages.filter(Boolean).map((entry) => String(entry))
    : [];
  const ordered = languages.length > 0
    ? languages
    : identity.locale
      ? [String(identity.locale)]
      : [];

  if (ordered.length === 0) {
    return null;
  }

  return ordered
    .slice(0, 10)
    .map((entry, index) => {
      if (index === 0) {
        return entry;
      }
      const q = Math.max(0.1, 1 - (index * 0.1));
      return `${entry};q=${q.toFixed(1)}`;
    })
    .join(',');
}

function getHeaderValue(headers = {}, name) {
  const normalizedName = String(name ?? '').toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (String(key).toLowerCase() === normalizedName) {
      return value;
    }
  }
  return undefined;
}

function resolveSession(request) {
  return request.session?.enabled && request.session?.id ? request.session : null;
}

function resolveProxy(request, browserConfig = {}) {
  return request.proxy ?? browserConfig.proxy ?? null;
}

function resolveBrowserIdentity(request = {}) {
  const identity = request.identity && typeof request.identity === 'object' && !Array.isArray(request.identity)
    ? request.identity
    : null;
  return identity && identity.enabled !== false ? identity : null;
}

function buildBrowserProfileOptions({ request, session }) {
  const identity = resolveBrowserIdentity(request);
  if (!identity) {
    return null;
  }

  const seedSource = JSON.stringify({
    sessionId: session?.id ?? null,
    url: request.url ?? null,
    userAgent: getHeaderValue(request.headers, 'user-agent') ?? identity.userAgent ?? null,
    acceptLanguage: getHeaderValue(request.headers, 'accept-language') ?? buildIdentityAcceptLanguage(identity),
    locale: identity.locale ?? null,
    platform: identity.platform ?? null,
    tlsProfile: request.tlsProfile ?? null,
    h2Profile: request.h2Profile ?? null,
  });
  const seed = Number.parseInt(hashText(seedSource).slice(0, 12), 16);

  return {
    ...identity,
    seed,
    userAgent: getHeaderValue(request.headers, 'user-agent') ?? identity.userAgent ?? undefined,
    acceptLanguage: getHeaderValue(request.headers, 'accept-language') ?? buildIdentityAcceptLanguage(identity) ?? undefined,
  };
}

async function applyIdentityBrowserProfile({ page, lease, profileOptions, applyStealthHook = true }) {
  if (!profileOptions) {
    return null;
  }

  if (applyStealthHook) {
    const hookCode = buildAntiDetectionHook(profileOptions);
    await lease.addInitScript(page, hookCode);

    const cdp =
      typeof page.createCDPSession === 'function'
        ? await page.createCDPSession().catch(() => null)
        : null;
    if (cdp) {
      await applyStealthProfile({
        page,
        cdp,
        options: profileOptions,
      }).catch(() => {});
    }
  }

  if (profileOptions.geolocation) {
    if (typeof lease.context?.setGeolocation === 'function') {
      await lease.context.setGeolocation({
        latitude: Number(profileOptions.geolocation.latitude),
        longitude: Number(profileOptions.geolocation.longitude),
        accuracy: Number(profileOptions.geolocation.accuracy ?? 100),
      }).catch(() => {});
    }
    if (typeof lease.context?.grantPermissions === 'function') {
      await lease.context.grantPermissions(['geolocation']).catch(() => {});
    }
  }

  return {
    applied: true,
    seed: profileOptions.seed ?? null,
    userAgent: profileOptions.userAgent ?? null,
    acceptLanguage: profileOptions.acceptLanguage ?? null,
    locale: profileOptions.locale ?? null,
    languages: Array.isArray(profileOptions.languages) ? [...profileOptions.languages] : [],
    platform: profileOptions.platform ?? null,
    vendor: profileOptions.vendor ?? null,
    deviceMemory: profileOptions.deviceMemory ?? null,
    hardwareConcurrency: profileOptions.hardwareConcurrency ?? null,
    maxTouchPoints: profileOptions.maxTouchPoints ?? null,
    tlsProfile: profileOptions.tlsProfile ?? null,
    h2Profile: profileOptions.h2Profile ?? null,
  };
}

function addBrowserIdentityParity(identity = null, request = {}) {
  if (!identity) {
    return null;
  }

  return {
    ...identity,
    parity: {
      userAgent:
        identity.userAgent == null
          ? null
          : String(identity.userAgent) === String(getHeaderValue(request.headers, 'user-agent') ?? ''),
      acceptLanguage:
        identity.acceptLanguage == null
          ? null
          : String(identity.acceptLanguage) === String(getHeaderValue(request.headers, 'accept-language') ?? ''),
      tlsProfile:
        identity.tlsProfile == null
          ? null
          : String(identity.tlsProfile) === String(request.tlsProfile ?? ''),
      h2Profile:
        identity.h2Profile == null
          ? null
          : String(identity.h2Profile) === String(request.h2Profile ?? ''),
    },
  };
}

function toHarHeaders(headers = {}) {
  return Object.entries(headers ?? {}).map(([name, value]) => ({
    name: String(name),
    value: String(value ?? ''),
  }));
}

function toHarQueryString(targetUrl) {
  try {
    const url = new URL(String(targetUrl ?? ''));
    return [...url.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function buildHarAttachment(debug, { request, finalUrl, includeBodies = true } = {}) {
  if (!debug?.enabled) {
    return null;
  }

  const entries = (debug.requests ?? []).map((item) => {
    const requestBodyText = includeBodies ? item.requestBody?.text ?? '' : '';
    const responseBodyText = includeBodies ? item.responseBody?.text ?? '' : '';
    const startedAt = item.startedAt ?? new Date().toISOString();
    const finishedAt = item.finishedAt ?? startedAt;
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt) || 0);
    const requestHeaders = item.requestHeaders ?? {};
    const responseHeaders = item.responseHeaders ?? {};
    const responseMimeType =
      item.mimeType
      ?? getHeaderValue(responseHeaders, 'content-type')
      ?? 'text/plain';

    return {
      startedDateTime: startedAt,
      time: durationMs,
      request: {
        method: item.method ?? 'GET',
        url: item.url ?? request.url,
        httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(requestHeaders),
        queryString: toHarQueryString(item.url ?? request.url),
        cookies: [],
        headersSize: -1,
        bodySize: Buffer.byteLength(requestBodyText),
        ...(requestBodyText
          ? {
              postData: {
                mimeType: getHeaderValue(requestHeaders, 'content-type') ?? 'text/plain',
                text: requestBodyText,
              },
            }
          : {}),
      },
      response: {
        status: Number(item.status ?? 0),
        statusText: item.errorText ? 'error' : '',
        httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(responseHeaders),
        cookies: [],
        content: {
          size: Buffer.byteLength(responseBodyText),
          mimeType: responseMimeType,
          ...(includeBodies ? { text: responseBodyText } : {}),
        },
        redirectURL: getHeaderValue(responseHeaders, 'location') ?? '',
        headersSize: -1,
        bodySize: Buffer.byteLength(responseBodyText),
      },
      cache: {},
      timings: {
        blocked: 0,
        dns: -1,
        connect: -1,
        send: 0,
        wait: durationMs,
        receive: 0,
        ssl: -1,
      },
      _omnicrawl: {
        transport: item.transport ?? null,
        targetType: item.targetType ?? null,
        error: item.errorText ?? null,
      },
    };
  });

  const payload = {
    log: {
      version: '1.2',
      creator: {
        name: 'omnicrawl',
        comment: 'Synthetic HAR generated from browser debug capture.',
      },
      pages: [
        {
          startedDateTime: entries[0]?.startedDateTime ?? new Date().toISOString(),
          id: 'page_1',
          title: finalUrl ?? request.url,
          pageTimings: {},
        },
      ],
      entries: entries.map((entry) => ({
        pageref: 'page_1',
        ...entry,
      })),
    },
  };
  const content = JSON.stringify(payload, null, 2);

  return {
    enabled: true,
    backend: 'omnicrawl',
    format: 'synthetic-har-1.2',
    contentType: 'application/json',
    fileName: 'network.har',
    entryCount: entries.length,
    bytes: Buffer.byteLength(content),
    contentBase64: Buffer.from(content).toString('base64'),
  };
}

async function startBrowserTraceCapture({ page, lease, browserConfig = {} } = {}) {
  const tracingConfig =
    browserConfig?.debug?.tracing && typeof browserConfig.debug.tracing === 'object'
      ? browserConfig.debug.tracing
      : {};
  if (tracingConfig.enabled !== true) {
    return null;
  }

  let started = false;
  let tempDir = null;
  let stopImpl = async () => ({
    enabled: false,
    backend: 'unsupported',
    format: null,
    error: 'browser tracing is unavailable on the current backend',
  });

  try {
    if (lease.context?.tracing && typeof lease.context.tracing.start === 'function' && typeof lease.context.tracing.stop === 'function') {
      tempDir = await mkdtemp(join(tmpdir(), 'omnicrawl-trace-'));
      await lease.context.tracing.start({
        screenshots: tracingConfig.screenshots !== false,
        snapshots: tracingConfig.snapshots !== false,
        sources: tracingConfig.sources === true,
      });
      started = true;

      stopImpl = async () => {
        if (!started) {
          return null;
        }
        started = false;
        const tracePath = join(tempDir, 'trace.zip');
        await lease.context.tracing.stop({ path: tracePath });
        const buffer = await readFile(tracePath);
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        tempDir = null;
        return {
          enabled: true,
          backend: 'playwright',
          format: 'playwright-trace',
          contentType: 'application/zip',
          fileName: 'trace.zip',
          bytes: buffer.length,
          screenshots: tracingConfig.screenshots !== false,
          snapshots: tracingConfig.snapshots !== false,
          sources: tracingConfig.sources === true,
          contentBase64: buffer.toString('base64'),
        };
      };
    } else if (page?.tracing && typeof page.tracing.start === 'function' && typeof page.tracing.stop === 'function') {
      await page.tracing.start({
        screenshots: tracingConfig.screenshots !== false,
      });
      started = true;

      stopImpl = async () => {
        if (!started) {
          return null;
        }
        started = false;
        const raw = await page.tracing.stop();
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        return {
          enabled: true,
          backend: 'puppeteer',
          format: 'chromium-trace',
          contentType: 'application/json',
          fileName: 'trace.json',
          bytes: buffer.length,
          screenshots: tracingConfig.screenshots !== false,
          snapshots: false,
          sources: false,
          contentBase64: buffer.toString('base64'),
        };
      };
    }
  } catch (error) {
    const message = error?.message ?? String(error);
    stopImpl = async () => ({
      enabled: false,
      backend: lease.backendFamily ?? 'unknown',
      format: null,
      error: message,
    });
  }

  return {
    async stop() {
      return stopImpl();
    },
    async dispose() {
      if (started) {
        await stopImpl().catch(() => {});
      }
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        tempDir = null;
      }
    },
  };
}

function isTransientBrowserBootstrapError(error) {
  const message = String(error?.message ?? error ?? '');
  return message.includes('Requesting main frame too early')
    || message.includes('Connection closed')
    || message.includes('Target closed')
    || message.includes('Navigating frame was detached');
}

function resourceTypeOf(entry) {
  try {
    return String(entry?.resourceType?.() ?? entry?.resourceType ?? '').toLowerCase();
  } catch {
    return '';
  }
}

function urlOf(entry) {
  try {
    return String(entry?.url?.() ?? entry?.url ?? '');
  } catch {
    return '';
  }
}

function patternMatches(url, pattern) {
  try {
    return new RegExp(pattern, 'i').test(url);
  } catch {
    return url.toLowerCase().includes(String(pattern).toLowerCase());
  }
}

function buildInitialHeaders(headers = {}, replayState = {}) {
  const nextHeaders = {};
  for (const [key, value] of Object.entries(normalizeHeaders(headers))) {
    if (hasReplayTemplate(value)) {
      continue;
    }
    nextHeaders[key] = interpolateReplayString(value, replayState);
  }
  return nextHeaders;
}

function buildResolvedHeaders(headers = {}, replayState = {}) {
  const nextHeaders = {};
  for (const [key, value] of Object.entries(normalizeHeaders(headers))) {
    nextHeaders[key] = interpolateReplayString(value, replayState, { strict: true });
  }
  return nextHeaders;
}

function normalizeComparableUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ''));
    url.hash = '';
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.href;
  } catch {
    return String(rawUrl ?? '');
  }
}

function replayUrlsEquivalent(left, right) {
  return normalizeComparableUrl(left) === normalizeComparableUrl(right);
}

const hookInitScripts = new WeakMap();

function recordHookInitScript(page, script, arg) {
  if (!page || !script) {
    return;
  }
  const existing = hookInitScripts.get(page) ?? [];
  existing.push({ script, arg });
  hookInitScripts.set(page, existing);
}

async function flushHookInitScripts(page) {
  const entries = hookInitScripts.get(page) ?? [];
  if (entries.length === 0 || typeof page?.evaluate !== 'function') {
    return;
  }

  for (const entry of entries) {
    if (typeof entry.script === 'string') {
      await page.evaluate((source) => {
        (0, eval)(source);
      }, entry.script);
      continue;
    }

    await page.evaluate(
      ({ fnSource, arg }) => {
        const evaluator = (0, eval)(`(${fnSource})`);
        return evaluator(arg);
      },
      {
        fnSource: entry.script.toString(),
        arg: entry.arg,
      },
    );
  }
}

function createHookPage(page, lease) {
  if (!page) {
    return page;
  }

  return new Proxy(page, {
    get(target, prop, receiver) {
      if (prop === 'evaluateOnNewDocument' && typeof target.evaluateOnNewDocument !== 'function') {
        return async (script, arg) => {
          recordHookInitScript(target, script, arg);
          await lease.addInitScript(target, script, arg);
        };
      }

      if (prop === '$eval' && typeof target.$eval !== 'function') {
        return async (selector, pageFunction, ...args) => {
          if (typeof target.locator === 'function') {
            return target.locator(selector).evaluate(pageFunction, ...args);
          }

          if (typeof target.evaluate === 'function') {
            return target.evaluate(
              ({ selector: innerSelector, fnSource, fnArgs }) => {
                const node = document.querySelector(innerSelector);
                if (!node) {
                  throw new Error(`selector not found: ${innerSelector}`);
                }
                const evaluator = (0, eval)(`(${fnSource})`);
                return evaluator(node, ...fnArgs);
              },
              {
                selector,
                fnSource: String(pageFunction),
                fnArgs: args,
              },
            );
          }

          throw new Error('Browser page does not support $eval compatibility');
        };
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value === 'function') {
        return value.bind(target);
      }

      return value;
    },
  });
}

function resolveFinalRequest({ request, browserConfig, replayState }) {
  const replayConfig = browserConfig?.replay ?? {};
  const method = String(
    replayConfig.finalMethod
      ?? request.method
      ?? 'GET',
  ).toUpperCase();
  const urlSource = replayConfig.finalUrl ?? request.url;
  const bodySource = replayConfig.finalBody ?? request.body;

  return {
    method,
    url: interpolateReplayString(urlSource, replayState, { strict: true }),
    body: bodySource === undefined ? undefined : interpolateReplayString(bodySource, replayState, { strict: true }),
    headers: buildResolvedHeaders(request.headers, replayState),
  };
}

async function executeBrowserFinalRequest({ page, lease, browserConfig, finalRequest, timeoutMs }) {
  const canNavigate = ['GET', 'HEAD'].includes(finalRequest.method) && !finalRequest.body;
  if (canNavigate) {
    const response = await page.goto(finalRequest.url, {
      waitUntil: lease.normalizeWaitUntil(browserConfig.waitUntil ?? 'networkidle2'),
      timeout: timeoutMs,
    });
    return {
      type: 'navigation',
      response,
    };
  }

  const result = await page.evaluate(async ({ url, method, headers, body }) => {
    const response = await fetch(url, {
      method,
      headers,
      body,
      credentials: 'include',
    });
    const text = await response.text();
    return {
      finalUrl: response.url,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: text,
    };
  }, {
    url: finalRequest.url,
    method: finalRequest.method,
    headers: finalRequest.headers,
    body: finalRequest.body ?? null,
  });

  return {
    type: 'fetch',
    response: result,
  };
}

async function setupReplaySurface({ page, lease, browserConfig }) {
  const replayConfig = browserConfig?.replay ?? {};
  const initScripts = Array.isArray(replayConfig.initScripts) ? replayConfig.initScripts.filter(Boolean) : [];
  const storageSeeds = Array.isArray(replayConfig.storageSeeds)
    ? replayConfig.storageSeeds.filter((entry) => entry?.key)
    : [];
  const cookies = Array.isArray(replayConfig.cookies) ? replayConfig.cookies.filter((entry) => entry?.name) : [];
  const blockResourceTypes = new Set((Array.isArray(replayConfig.blockResourceTypes) ? replayConfig.blockResourceTypes : []).map((entry) => String(entry).toLowerCase()));
  const blockUrlPatterns = Array.isArray(replayConfig.blockUrlPatterns) ? replayConfig.blockUrlPatterns.filter(Boolean) : [];
  const htmlInitScriptBlock = initScripts.length > 0
    ? initScripts.map((script) => `<script data-omnicrawl-replay="true">${script}</script>`).join('')
    : '';
  let teardown = async () => {};

  for (const script of initScripts) {
    await lease.addInitScript(page, (source) => {
      try {
        window.eval(source);
      } catch (_error) {}
    }, script);
  }

  if (storageSeeds.length > 0) {
    await lease.addInitScript(page, (entries) => {
      for (const entry of entries) {
        try {
          const area = entry.area === 'sessionStorage' ? window.sessionStorage : window.localStorage;
          area.setItem(entry.key, entry.value);
        } catch (_error) {}
      }
    }, storageSeeds);
  }

  if (cookies.length > 0) {
    await lease.setCookies(page, cookies);
  }

  const shouldBlock = (requestLike) => {
    const resourceType = resourceTypeOf(requestLike);
    const requestUrl = urlOf(requestLike);
    return blockResourceTypes.has(resourceType)
      || blockUrlPatterns.some((pattern) => patternMatches(requestUrl, pattern));
  };

  if (blockResourceTypes.size > 0 || blockUrlPatterns.length > 0) {
    if (typeof page.setRequestInterception === 'function') {
      await page.setRequestInterception(true);
      const handler = (requestLike) => {
        if (shouldBlock(requestLike)) {
          void requestLike.abort().catch(() => {});
          return;
        }
        void requestLike.continue().catch(() => {});
      };
      page.on('request', handler);
      teardown = async () => {
        page.off?.('request', handler);
        await page.setRequestInterception(false).catch(() => {});
      };
    } else if (typeof page.route === 'function') {
      const routeHandler = async (route) => {
        const routeRequest = route.request();
        if (shouldBlock(routeRequest)) {
          await route.abort().catch(() => {});
          return;
        }

        const isDocument = String(routeRequest.resourceType?.() ?? '').toLowerCase() === 'document';
        if (isDocument && htmlInitScriptBlock) {
          try {
            const response = await route.fetch();
            const headers = response.headers();
            const contentType = String(headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase();
            if (contentType.includes('text/html')) {
              const body = await response.text();
              const injected = body.includes('data-omnicrawl-replay="true"')
                ? body
                : body.includes('<head>')
                  ? body.replace('<head>', `<head>${htmlInitScriptBlock}`)
                  : `${htmlInitScriptBlock}${body}`;
              await route.fulfill({
                status: response.status(),
                headers,
                body: injected,
              }).catch(() => {});
              return;
            }
          } catch {
            // fall through to normal continue
          }
        }

        await route.continue().catch(() => {});
      };
      await page.route('**/*', routeHandler);
      teardown = async () => {
        await page.unroute('**/*', routeHandler).catch(() => {});
      };
    }
  }

  return teardown;
}

function resolveReplayUrl(targetUrl, currentUrl, requestUrl) {
  const base = currentUrl && currentUrl !== 'about:blank' ? currentUrl : requestUrl;
  return new URL(String(targetUrl ?? ''), base).href;
}

function replayStepTimeout(step, browserConfig, request) {
  return step.timeoutMs ?? browserConfig.timeoutMs ?? request.timeoutMs ?? 45000;
}

function buildReplayStepLabels(steps = []) {
  const labels = new Map();
  steps.forEach((step, index) => {
    if (step?.label) {
      labels.set(String(step.label), index);
    }
  });
  return labels;
}

function resolveReplayLabel(label, labels) {
  const nextIndex = labels.get(String(label ?? ''));
  if (nextIndex === undefined) {
    throw new Error(`replay label not found: ${label}`);
  }
  return nextIndex;
}

function evaluateReplayCondition(condition = {}, replayState = {}) {
  const value = condition.state ? readObjectPath(replayState, condition.state) : condition.value;

  if (condition.exists !== undefined) {
    return condition.exists ? value !== undefined && value !== null : value === undefined || value === null;
  }
  if (condition.equals !== undefined) {
    return value === condition.equals;
  }
  if (condition.notEquals !== undefined) {
    return value !== condition.notEquals;
  }
  if (condition.matches !== undefined) {
    try {
      return new RegExp(String(condition.matches), 'i').test(String(value ?? ''));
    } catch {
      return String(value ?? '').includes(String(condition.matches));
    }
  }

  return Boolean(value);
}

async function resolveReplayContext({ page, replayState, step }) {
  if (step.frameUrlPattern) {
    const pattern = interpolateReplayString(step.frameUrlPattern, replayState, { strict: true });
    const frame = page.frames?.().find((entry) => patternMatches(entry.url?.() ?? '', pattern));
    if (!frame) {
      throw new Error(`replay frame not found for url pattern: ${pattern}`);
    }
    return frame;
  }

  if (step.frameSelector) {
    const selector = interpolateReplayString(step.frameSelector, replayState, { strict: true });
    const handle = await page.$(selector);
    const frame = await handle?.contentFrame?.();
    if (!frame) {
      throw new Error(`replay frame not found for selector: ${selector}`);
    }
    return frame;
  }

  return page;
}

async function waitForScopedSelector(context, selector, { timeout, visible, shadowHostSelector }) {
  if (!shadowHostSelector) {
    return context.waitForSelector(selector, {
      timeout,
      visible,
    });
  }

  return context.waitForFunction(({ hostSelector, targetSelector, mustBeVisible }) => {
    const host = document.querySelector(hostSelector);
    const node = host?.shadowRoot?.querySelector(targetSelector);
    if (!node) {
      return false;
    }
    if (!mustBeVisible) {
      return true;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, {
    timeout,
  }, {
    hostSelector: shadowHostSelector,
    targetSelector: selector,
    mustBeVisible: Boolean(visible),
  });
}

async function clickScopedSelector(context, selector, { shadowHostSelector, clickOptions = {} }) {
  if (!shadowHostSelector) {
    return context.click(selector, clickOptions);
  }

  return context.evaluate(({ hostSelector, targetSelector }) => {
    const node = document.querySelector(hostSelector)?.shadowRoot?.querySelector(targetSelector);
    if (!node) {
      throw new Error(`shadow selector not found: ${hostSelector} >> ${targetSelector}`);
    }
    node.click?.();
    node.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
  }, {
    hostSelector: shadowHostSelector,
    targetSelector: selector,
  });
}

async function typeScopedSelector(context, selector, value, { shadowHostSelector, delayMs, clear = false }) {
  if (!shadowHostSelector) {
    if (clear && typeof context.fill === 'function') {
      return context.fill(selector, value);
    }

    if (clear) {
      await context.$eval(selector, (node) => {
        if (node && 'value' in node) {
          node.value = '';
        }
      });
    }

    return context.type(selector, value, {
      delay: delayMs,
    });
  }

  return context.evaluate(({ hostSelector, targetSelector, nextValue, shouldClear }) => {
    const node = document.querySelector(hostSelector)?.shadowRoot?.querySelector(targetSelector);
    if (!node || !('value' in node)) {
      throw new Error(`shadow input not found: ${hostSelector} >> ${targetSelector}`);
    }
    node.value = shouldClear ? String(nextValue) : `${node.value ?? ''}${String(nextValue)}`;
    node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }, {
    hostSelector: shadowHostSelector,
    targetSelector: selector,
    nextValue: value,
    shouldClear: Boolean(clear),
  });
}

async function focusScopedSelector(context, selector, { shadowHostSelector }) {
  if (!shadowHostSelector) {
    if (typeof context.focus === 'function') {
      return context.focus(selector);
    }
    return context.$eval(selector, (node) => {
      node.focus?.();
    });
  }

  return context.evaluate(({ hostSelector, targetSelector }) => {
    const node = document.querySelector(hostSelector)?.shadowRoot?.querySelector(targetSelector);
    if (!node) {
      throw new Error(`shadow selector not found: ${hostSelector} >> ${targetSelector}`);
    }
    node.focus?.();
  }, {
    hostSelector: shadowHostSelector,
    targetSelector: selector,
  });
}

async function selectScopedOption(context, selector, option, { shadowHostSelector }) {
  if (!shadowHostSelector && typeof context.selectOption === 'function') {
    return context.selectOption(selector, option);
  }

  const optionSpec =
    option?.label !== undefined
      ? { kind: 'label', value: String(option.label) }
      : option?.index !== undefined
        ? { kind: 'index', value: Number(option.index) }
        : { kind: 'value', value: String(option?.value ?? '') };

  if (!shadowHostSelector) {
    return context.evaluate(({ targetSelector, nextOption }) => {
      const node = document.querySelector(targetSelector);
      if (!(node instanceof HTMLSelectElement)) {
        throw new Error(`select element not found: ${targetSelector}`);
      }

      if (nextOption.kind === 'index') {
        node.selectedIndex = nextOption.value;
      } else {
        const match = Array.from(node.options ?? []).find((entry) => {
          if (nextOption.kind === 'label') {
            return entry.label === nextOption.value || entry.text === nextOption.value;
          }
          return entry.value === nextOption.value;
        });
        if (!match) {
          throw new Error(`select option not found: ${nextOption.value}`);
        }
        node.value = match.value;
      }

      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return node.value;
    }, {
      targetSelector: selector,
      nextOption: optionSpec,
    });
  }

  return context.evaluate(({ hostSelector, targetSelector, nextOption }) => {
    const node = document.querySelector(hostSelector)?.shadowRoot?.querySelector(targetSelector);
    if (!(node instanceof HTMLSelectElement)) {
      throw new Error(`shadow select element not found: ${hostSelector} >> ${targetSelector}`);
    }

    if (nextOption.kind === 'index') {
      node.selectedIndex = nextOption.value;
    } else {
      const match = Array.from(node.options ?? []).find((entry) => {
        if (nextOption.kind === 'label') {
          return entry.label === nextOption.value || entry.text === nextOption.value;
        }
        return entry.value === nextOption.value;
      });
      if (!match) {
        throw new Error(`shadow select option not found: ${nextOption.value}`);
      }
      node.value = match.value;
    }

    node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return node.value;
  }, {
    hostSelector: shadowHostSelector,
    targetSelector: selector,
    nextOption: optionSpec,
  });
}

async function scrollContext(context, {
  selector = null,
  shadowHostSelector = null,
  x = null,
  y = null,
  to = null,
}) {
  const targetX = Number.isFinite(Number(x)) ? Number(x) : 0;
  const targetY =
    to === 'top'
      ? 0
      : to === 'bottom'
        ? null
        : Number.isFinite(Number(y)) ? Number(y) : null;

  if (!selector) {
    return context.evaluate(({ scrollX, scrollY, target }) => {
      const nextY =
        target === 'bottom'
          ? Math.max(
              document.documentElement?.scrollHeight ?? 0,
              document.body?.scrollHeight ?? 0,
              window.innerHeight,
            )
          : scrollY;
      window.scrollTo(scrollX, nextY ?? 0);
      return {
        x: window.scrollX,
        y: window.scrollY,
      };
    }, {
      scrollX: targetX,
      scrollY: targetY,
      target: to,
    });
  }

  if (!shadowHostSelector) {
    return context.evaluate(({ targetSelector, scrollX, scrollY, target }) => {
      const node = document.querySelector(targetSelector);
      if (!node) {
        throw new Error(`scroll target not found: ${targetSelector}`);
      }
      const nextY = target === 'top' ? 0 : target === 'bottom' ? node.scrollHeight : (scrollY ?? node.scrollTop);
      node.scrollTo(scrollX, nextY);
      return {
        x: node.scrollLeft,
        y: node.scrollTop,
      };
    }, {
      targetSelector: selector,
      scrollX: targetX,
      scrollY: targetY,
      target: to,
    });
  }

  return context.evaluate(({ hostSelector, targetSelector, scrollX, scrollY, target }) => {
    const node = document.querySelector(hostSelector)?.shadowRoot?.querySelector(targetSelector);
    if (!node) {
      throw new Error(`shadow scroll target not found: ${hostSelector} >> ${targetSelector}`);
    }
    const nextY = target === 'top' ? 0 : target === 'bottom' ? node.scrollHeight : (scrollY ?? node.scrollTop);
    node.scrollTo(scrollX, nextY);
    return {
      x: node.scrollLeft,
      y: node.scrollTop,
    };
  }, {
    hostSelector: shadowHostSelector,
    targetSelector: selector,
    scrollX: targetX,
    scrollY: targetY,
    target: to,
  });
}

async function extractScopedDomValue(context, step) {
  if (!step.shadowHostSelector) {
    if (step.source === 'text') {
      return context.$eval(step.selector, (node) => node.textContent?.trim() ?? '');
    }
    if (step.source === 'html') {
      return context.$eval(step.selector, (node) => node.innerHTML ?? '');
    }
    if (step.source === 'attribute') {
      return context.$eval(step.selector, (node, attribute) => node.getAttribute(attribute), step.attribute ?? 'value');
    }
    return null;
  }

  return context.evaluate(({ hostSelector, targetSelector, source, attribute }) => {
    const node = document.querySelector(hostSelector)?.shadowRoot?.querySelector(targetSelector);
    if (!node) {
      return null;
    }
    if (source === 'text') {
      return node.textContent?.trim() ?? '';
    }
    if (source === 'html') {
      return node.innerHTML ?? '';
    }
    if (source === 'attribute') {
      return node.getAttribute(attribute ?? 'value');
    }
    return null;
  }, {
    hostSelector: step.shadowHostSelector,
    targetSelector: step.selector,
    source: step.source,
    attribute: step.attribute ?? 'value',
  });
}

function methodOf(entry) {
  try {
    return String(entry?.method?.() ?? entry?.method ?? '').toUpperCase();
  } catch {
    return '';
  }
}

function statusOf(entry) {
  try {
    return Number(entry?.status?.() ?? entry?.status ?? 0);
  } catch {
    return 0;
  }
}

function headersOf(entry) {
  try {
    return entry?.headers?.() ?? entry?.headers ?? {};
  } catch {
    return {};
  }
}

function requestOf(entry) {
  try {
    return entry?.request?.() ?? entry?.request ?? null;
  } catch {
    return null;
  }
}

function normalizeResponseText(entry) {
  if (typeof entry?.body === 'string') {
    return entry.body;
  }

  if (Buffer.isBuffer(entry?.body)) {
    return entry.body.toString('utf8');
  }

  return null;
}

function buildReplayResponseSnapshot(response) {
  const request = requestOf(response);
  return {
    url: urlOf(response),
    status: statusOf(response),
    headers: headersOf(response),
    method: methodOf(request),
    resourceType: resourceTypeOf(request),
  };
}

function responseMatchesStep(response, step, replayState) {
  const request = requestOf(response);
  const urlPattern = step.urlPattern ? interpolateReplayString(step.urlPattern, replayState, { strict: true }) : null;
  const expectedMethod = step.method ? interpolateReplayString(step.method, replayState, { strict: true }).toUpperCase() : null;
  const expectedResourceType = step.resourceType ? interpolateReplayString(step.resourceType, replayState, { strict: true }).toLowerCase() : null;

  if (urlPattern && !patternMatches(urlOf(response), urlPattern)) {
    return false;
  }

  if (expectedMethod && methodOf(request) !== expectedMethod) {
    return false;
  }

  if (step.status !== undefined && statusOf(response) !== Number(step.status)) {
    return false;
  }

  if (expectedResourceType && resourceTypeOf(request) !== expectedResourceType) {
    return false;
  }

  return true;
}

async function readReplayResponseBody(response, responseBodyCache) {
  if (!response) {
    return '';
  }

  const existing = responseBodyCache.get(response);
  if (existing !== undefined) {
    return existing;
  }

  const normalized = normalizeResponseText(response);
  if (normalized !== null) {
    responseBodyCache.set(response, normalized);
    return normalized;
  }

  if (typeof response.text === 'function') {
    const body = await response.text();
    responseBodyCache.set(response, body);
    return body;
  }

  return '';
}

async function extractReplayStateValue({ page, lease, step, context = page }) {
  const source = String(step.source ?? '').trim();
  if (source === 'cookie') {
    const cookies = await lease.getCookies(page, page.url?.() ?? undefined);
    const match = cookies.find((entry) => entry.name === step.key);
    return match?.value ?? null;
  }

  if (source === 'localStorage' || source === 'sessionStorage') {
    return page.evaluate(({ storageArea, key }) => {
      const area = storageArea === 'sessionStorage' ? window.sessionStorage : window.localStorage;
      return area.getItem(key);
    }, {
      storageArea: source,
      key: step.key,
    });
  }

  if (source === 'text' || source === 'html' || source === 'attribute') {
    return extractScopedDomValue(context, step);
  }

  return null;
}

async function runReplaySteps({ page, lease, browserConfig, request }) {
  const replayConfig = browserConfig?.replay ?? {};
  const steps = Array.isArray(replayConfig.steps) ? replayConfig.steps : [];
  const replayState = {};
  const currentHeaders = buildInitialHeaders(request.headers, replayState);
  let lastNavigationResponse = null;
  const observedResponses = [];
  const responseAliases = new Map();
  const responseBodyCache = new WeakMap();
  let lastMatchedResponse = null;
  const responseListener = (response) => {
    observedResponses.push(response);
    if (observedResponses.length > 50) {
      observedResponses.shift();
    }
  };

  page.on?.('response', responseListener);

  try {
    const labels = buildReplayStepLabels(steps);
    let index = 0;

    while (index < steps.length) {
      const step = steps[index];
      if (!step || typeof step !== 'object') {
        index += 1;
        continue;
      }

      const maxRetries = Number(step.retries ?? 0);
      let stepAttempt = 0;
      let stepRedirect = null;

      while (true) {
        try {
          const context = await resolveReplayContext({ page, replayState, step });
          const shadowHostSelector = step.shadowHostSelector
            ? interpolateReplayString(step.shadowHostSelector, replayState, { strict: true })
            : null;

          if (step.type === 'goto') {
            stepRedirect = resolveReplayLabel(interpolateReplayString(step.target ?? '', replayState, { strict: true }), labels);
            break;
          }

          if (step.type === 'wait') {
            await sleep(Number(step.durationMs ?? 0));
            break;
          }

          if (step.type === 'branch') {
            const cases = Array.isArray(step.cases) ? step.cases : [];
            const matched = cases.find((entry) => evaluateReplayCondition(entry, replayState));
            const target = matched?.goto ?? step.defaultGoto ?? null;
            if (target) {
              stepRedirect = resolveReplayLabel(interpolateReplayString(target, replayState, { strict: true }), labels);
            }
            break;
          }

          if (step.type === 'assert') {
            if (!evaluateReplayCondition(step, replayState)) {
              throw new Error(step.message ?? `replay assertion failed${step.state ? `: ${step.state}` : ''}`);
            }
            break;
          }

          if (step.type === 'navigate') {
            const targetUrl = interpolateReplayString(
              resolveReplayUrl(step.url, page.url?.(), request.url),
              replayState,
              { strict: true },
            );
            lastNavigationResponse = await page.goto(targetUrl, {
              waitUntil: lease.normalizeWaitUntil(step.waitUntil ?? browserConfig.waitUntil ?? 'networkidle2'),
              timeout: replayStepTimeout(step, browserConfig, request),
            });
            break;
          }

          if (step.type === 'waitForSelector') {
            await waitForScopedSelector(
              context,
              interpolateReplayString(step.selector, replayState, { strict: true }),
              {
                timeout: replayStepTimeout(step, browserConfig, request),
                visible: step.visible,
                shadowHostSelector,
              },
            );
            break;
          }

          if (step.type === 'click') {
            const selector = interpolateReplayString(step.selector, replayState, { strict: true });
            const clickOptions = {
              button: step.button,
              clickCount: step.clickCount,
              delay: step.delayMs,
            };
            const shouldWaitForNavigation = Boolean(step.waitForNavigation || step.waitUntil);

            if (shouldWaitForNavigation && typeof page.waitForNavigation === 'function' && !shadowHostSelector) {
              const navigationPromise = page.waitForNavigation({
                waitUntil: lease.normalizeWaitUntil(step.waitUntil ?? browserConfig.waitUntil ?? 'networkidle2'),
                timeout: replayStepTimeout(step, browserConfig, request),
              });
              const [, navigationResponse] = await Promise.all([
                clickScopedSelector(context, selector, {
                  shadowHostSelector,
                  clickOptions,
                }),
                navigationPromise,
              ]);
              if (navigationResponse) {
                lastNavigationResponse = navigationResponse;
              }
              break;
            }

            await clickScopedSelector(context, selector, {
              shadowHostSelector,
              clickOptions,
            });
            break;
          }

          if (step.type === 'type') {
            const selector = interpolateReplayString(step.selector, replayState, { strict: true });
            const value = interpolateReplayString(step.value ?? '', replayState, { strict: true });
            await typeScopedSelector(context, selector, value, {
              shadowHostSelector,
              delayMs: step.delayMs,
              clear: step.clear,
            });
            break;
          }

          if (step.type === 'press') {
            const key = interpolateReplayString(step.keyPress ?? step.value ?? '', replayState, { strict: true });
            if (step.selector) {
              const selector = interpolateReplayString(step.selector, replayState, { strict: true });
              await focusScopedSelector(context, selector, {
                shadowHostSelector,
              });
            }
            await page.keyboard.press(key, {
              delay: step.delayMs,
            });
            break;
          }

          if (step.type === 'select') {
            const selector = interpolateReplayString(step.selector, replayState, { strict: true });
            const option = {};

            if (step.optionLabel !== undefined) {
              option.label = interpolateReplayString(step.optionLabel, replayState, { strict: true });
            } else if (step.optionIndex !== undefined) {
              option.index = Number(step.optionIndex);
            } else {
              option.value = interpolateReplayString(step.value ?? '', replayState, { strict: true });
            }

            await selectScopedOption(context, selector, option, {
              shadowHostSelector,
            });
            break;
          }

          if (step.type === 'scroll') {
            const selector = step.selector
              ? interpolateReplayString(step.selector, replayState, { strict: true })
              : null;
            const repeat = Math.max(1, Number(step.repeat ?? 1) || 1);

            for (let iteration = 0; iteration < repeat; iteration += 1) {
              await scrollContext(context, {
                selector,
                shadowHostSelector,
                x: step.x,
                y: step.y,
                to: step.to ?? null,
              });

              if ((step.delayMs ?? 0) > 0 && iteration < repeat - 1) {
                await sleep(step.delayMs);
              }
            }
            break;
          }

          if (step.type === 'waitForResponse') {
            const existingMatch = [...observedResponses].reverse().find((responseEntry) => responseMatchesStep(responseEntry, step, replayState));
            const matchedResponse =
              existingMatch
              ?? await page.waitForResponse(
                (responseEntry) => responseMatchesStep(responseEntry, step, replayState),
                {
                  timeout: replayStepTimeout(step, browserConfig, request),
                },
              );

            lastMatchedResponse = matchedResponse;
            if (step.saveAs) {
              responseAliases.set(step.saveAs, matchedResponse);
              replayState[step.saveAs] = buildReplayResponseSnapshot(matchedResponse);
            }
            if (step.onMatchGoto) {
              stepRedirect = resolveReplayLabel(interpolateReplayString(step.onMatchGoto, replayState, { strict: true }), labels);
            }
            break;
          }

          if (step.type === 'extractResponseBody') {
            const responseKey = step.from ? interpolateReplayString(step.from, replayState, { strict: true }) : null;
            const matchedResponse =
              responseKey
                ? responseAliases.get(responseKey)
                : lastMatchedResponse;

            if (!matchedResponse) {
              throw new Error(responseKey
                ? `replay response not found for alias: ${responseKey}`
                : 'replay response not available for extractResponseBody');
            }

            const format = String(step.format ?? (step.path ? 'json' : 'text')).toLowerCase();
            const body = await readReplayResponseBody(matchedResponse, responseBodyCache);
            let value = body;

            if (format === 'json' || step.path) {
              let parsed = null;
              try {
                parsed = JSON.parse(body);
              } catch {
                throw new Error('replay response body is not valid JSON');
              }

              const path = step.path ? interpolateReplayString(step.path, replayState, { strict: true }) : null;
              value = path ? readObjectPath(parsed, path) : parsed;
              if (path && value === undefined) {
                throw new Error(`replay response body path not found: ${path}`);
              }
            }

            replayState[step.saveAs ?? `state_${Object.keys(replayState).length + 1}`] = value;
            break;
          }

          if (step.type === 'extractState') {
            const value = await extractReplayStateValue({
              page,
              lease,
              context,
              step: {
                ...step,
                selector: step.selector ? interpolateReplayString(step.selector, replayState, { strict: true }) : step.selector,
                key: step.key ? interpolateReplayString(step.key, replayState, { strict: true }) : step.key,
                attribute: step.attribute ? interpolateReplayString(step.attribute, replayState, { strict: true }) : step.attribute,
                shadowHostSelector,
              },
            });
            replayState[step.saveAs ?? step.key ?? `state_${Object.keys(replayState).length + 1}`] = value;
            break;
          }

          if (step.type === 'setHeader') {
            currentHeaders[String(step.name ?? '').toLowerCase()] = interpolateReplayString(step.value ?? '', replayState, { strict: true });
            await page.setExtraHTTPHeaders(currentHeaders);
            break;
          }

          break;
        } catch (error) {
          if (stepAttempt < maxRetries) {
            stepAttempt += 1;
            if ((step.retryDelayMs ?? 0) > 0) {
              await sleep(step.retryDelayMs);
            }
            continue;
          }

          if (step.errorSaveAs) {
            replayState[step.errorSaveAs] = error?.message ?? String(error);
          }

          if (step.onErrorGoto) {
            stepRedirect = resolveReplayLabel(interpolateReplayString(step.onErrorGoto, replayState, { strict: true }), labels);
            break;
          }

          throw error;
        }
      }

      index = stepRedirect ?? (index + 1);
    }

    return {
      replayState,
      lastNavigationResponse,
    };
  } finally {
    page.off?.('response', responseListener);
  }
}

export async function fetchWithBrowser(request, browserConfig = {}, { sessionStore, reverseEngine, hooks = {} } = {}) {
  const session = resolveSession(request);
  const proxy = resolveProxy(request, browserConfig);
  const requestedEngine = String(browserConfig?.engine ?? '').trim().toLowerCase();
  const effectiveBrowserConfig = browserConfig?.debug?.enabled === true && (!requestedEngine || requestedEngine === 'auto')
    ? { ...browserConfig, engine: 'puppeteer' }
    : browserConfig;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const baseHeaders = normalizeHeaders(request.headers);
    const lease = await acquireBrowserLease({
      browserConfig: effectiveBrowserConfig,
      proxy,
      sessionId: session?.id ?? null,
      isolate: session?.isolate ?? true,
    });
    const page = await lease.context.newPage();
    let debugProbe = null;
    let debugBootstrapError = null;
    let teardownReplaySurface = async () => {};
    let replayState = {};
    let traceCapture = null;
    const browserProfileOptions = buildBrowserProfileOptions({ request, session });
    let browserIdentity = null;

    try {
      // Apply reverse engineering capabilities (stealth, behavior sim, app webview) before navigation
      if (reverseEngine && reverseEngine.enabled) {
        await reverseEngine.setupBrowserContext(page, {
          ...(effectiveBrowserConfig.stealthOptions ?? {}),
          ...(browserProfileOptions ?? {}),
        });
      }
      if (browserProfileOptions) {
        browserIdentity = await applyIdentityBrowserProfile({
          page,
          lease,
          profileOptions: browserProfileOptions,
          applyStealthHook: !reverseEngine?.stealth,
        });
      }
      if (session && sessionStore && session.persist !== false) {
        await sessionStore.restoreBrowserSession({
          sessionId: session.id,
          context: lease.context,
          page,
        });
      }

      if (proxy?.username || proxy?.password) {
        await lease.authenticate(page, {
          username: proxy.username ?? '',
          password: proxy.password ?? '',
        });
      }

      const initialHeaders = buildInitialHeaders(baseHeaders, replayState);
      const initialUserAgent = initialHeaders['user-agent'];
      if (initialUserAgent) {
        await lease.setUserAgent(page, initialUserAgent);
        delete initialHeaders['user-agent'];
      }

      if (Object.keys(initialHeaders).length > 0) {
        await page.setExtraHTTPHeaders(initialHeaders);
      }

      teardownReplaySurface = await setupReplaySurface({
        page,
        lease,
        browserConfig: effectiveBrowserConfig,
      });

      if (typeof hooks.beforeNavigation === 'function') {
        const hookPage = createHookPage(page, lease);
        await hooks.beforeNavigation({
          attempt,
          browserConfig,
          page: hookPage,
          proxy,
          request,
          session,
        });
      }

      try {
        debugProbe = await createBrowserDebugProbe({
          page,
          request,
          browserConfig: effectiveBrowserConfig,
          lease,
        });
      } catch (error) {
        debugBootstrapError = error?.message ?? String(error);
      }
      traceCapture = await startBrowserTraceCapture({
        page,
        lease,
        browserConfig: effectiveBrowserConfig,
      });

      const replayExecution = await runReplaySteps({
        page,
        lease,
        browserConfig: effectiveBrowserConfig,
        request: {
          ...request,
          headers: baseHeaders,
        },
      });
      replayState = replayExecution.replayState;

      const finalRequest = resolveFinalRequest({
        request: {
          ...request,
          headers: baseHeaders,
        },
        browserConfig: effectiveBrowserConfig,
        replayState,
      });
      const resolvedHeaders = { ...finalRequest.headers };
      const resolvedUserAgent = resolvedHeaders['user-agent'];
      if (resolvedUserAgent) {
        await lease.setUserAgent(page, resolvedUserAgent);
        delete resolvedHeaders['user-agent'];
      }
      if (Object.keys(resolvedHeaders).length > 0) {
        await page.setExtraHTTPHeaders(resolvedHeaders);
      }

      const targetRequestUrl = finalRequest.url;
      const currentPageUrl = page.url?.() ?? '';
      const finalExecution =
        currentPageUrl
        && currentPageUrl !== 'about:blank'
        && replayUrlsEquivalent(currentPageUrl, targetRequestUrl)
        && ['GET', 'HEAD'].includes(finalRequest.method)
        && !finalRequest.body
          ? {
              type: 'navigation',
              response: replayExecution.lastNavigationResponse,
            }
          : await executeBrowserFinalRequest({
              page,
              lease,
              browserConfig: effectiveBrowserConfig,
              finalRequest,
              timeoutMs: effectiveBrowserConfig.timeoutMs ?? request.timeoutMs ?? 45000,
            });
      const response = finalExecution.response;
      let challenge = null;
      let resolvedFinalUrl = finalExecution.type === 'navigation' ? (response?.url() ?? targetRequestUrl) : (response?.finalUrl ?? targetRequestUrl);
      let resolvedStatus = finalExecution.type === 'navigation' ? (response?.status() ?? 200) : (response?.status ?? 200);
      let resolvedResponseHeaders = finalExecution.type === 'navigation' ? (response?.headers?.() ?? {}) : (response?.headers ?? {});

      if (reverseEngine?.challenge && finalExecution.type === 'navigation') {
        const provisionalBody = await page.content().catch(() => '');
        const provisionalResponse = {
          status: resolvedStatus,
          headers: resolvedResponseHeaders,
          body: provisionalBody,
          url: resolvedFinalUrl,
        };

        if (reverseEngine.isChallengeResponse(provisionalResponse)) {
          try {
            const solveResult = await reverseEngine.resolveChallenge(page, provisionalResponse);
            const validation = await reverseEngine.validateChallengeResolution(page);
            challenge = {
              detected: true,
              type: solveResult?.type ?? null,
              solved: solveResult?.solved === true,
              validated: validation?.validated === true,
              reasons: validation?.reasons ?? [],
              originalStatus: provisionalResponse.status,
              finalUrl: page.url?.() ?? resolvedFinalUrl,
              shouldRetry: !(solveResult?.solved === true && validation?.validated === true),
            };

            if (challenge.solved && challenge.validated) {
              resolvedFinalUrl = page.url?.() ?? resolvedFinalUrl;
              resolvedStatus = 200;
              resolvedResponseHeaders = resolvedResponseHeaders ?? {};
            }
          } catch (error) {
            challenge = {
              detected: true,
              type: null,
              solved: false,
              validated: false,
              reasons: [error?.message ?? String(error)],
              originalStatus: provisionalResponse.status,
              finalUrl: resolvedFinalUrl,
              shouldRetry: true,
            };
          }
        }
      }

      if (browserConfig.waitForSelector) {
        await page.waitForSelector(browserConfig.waitForSelector, {
          timeout: browserConfig.timeoutMs ?? request.timeoutMs ?? 45000,
        });
      }

      if ((browserConfig.sleepMs ?? 0) > 0) {
        await sleep(browserConfig.sleepMs);
      }

      // Auto-run human behavior simulation if configured
      if (reverseEngine && reverseEngine.behaviorSim && browserConfig.autoBehaviorSim !== false) {
        try {
          await reverseEngine.simulateHumanBehavior(page);
        } catch (e) { /* non-fatal */ }
      }

      if (typeof hooks.afterNavigation === 'function') {
        await flushHookInitScripts(page).catch(() => {});
        const hookPage = createHookPage(page, lease);
        await hooks.afterNavigation({
          attempt,
          browserConfig,
          page: hookPage,
          proxy,
          request,
          response: {
            mode: 'browser',
            url: targetRequestUrl,
            finalUrl: resolvedFinalUrl,
            ok: resolvedStatus < 400,
            status: resolvedStatus,
            headers: resolvedResponseHeaders,
            body: '',
            sessionId: session?.id ?? null,
            proxyServer: proxy?.server ?? null,
            challenge,
            fetchedAt: new Date().toISOString(),
          },
          session,
        });
      }

      const traceArtifact =
        traceCapture
          ? await traceCapture.stop().catch((error) => ({
              enabled: false,
              backend: lease.backendFamily ?? 'unknown',
              format: null,
              error: error?.message ?? String(error),
            }))
          : null;
      const debugBase =
        debugProbe
          ? await debugProbe.collect({
              finalUrl: resolvedFinalUrl,
            })
          : debugBootstrapError
            ? {
                enabled: true,
                error: debugBootstrapError,
                requests: [],
                scripts: [],
                sourceMaps: [],
                hooks: {
                  events: [],
                  droppedEvents: 0,
                  error: debugBootstrapError,
                },
                summary: {
                  requestCount: 0,
                  scriptCount: 0,
                  sourceMapCount: 0,
                  hookEventCount: 0,
                  droppedRequests: 0,
                  droppedScripts: 0,
                  droppedSourceMaps: 0,
                  droppedHookEvents: 0,
                },
              }
            : null;
      const debug =
        debugBase
          ? {
              ...debugBase,
              identity: addBrowserIdentityParity(browserIdentity, request),
              attachments: {
                trace: traceArtifact,
                har:
                  effectiveBrowserConfig?.debug?.har?.enabled === true
                    ? buildHarAttachment(debugBase, {
                        request,
                        finalUrl: resolvedFinalUrl,
                        includeBodies: effectiveBrowserConfig.debug.har.includeBodies !== false,
                      })
                    : null,
              },
            }
          : null;

      if (session && sessionStore && session.persist !== false) {
        await sessionStore.captureBrowserSession({
          sessionId: session.id,
          context: lease.context,
          page,
          finalUrl: resolvedFinalUrl,
          captureStorage: session.captureStorage !== false,
        });
      }

      const body = finalExecution.type === 'navigation' ? await page.content() : (response?.body ?? '');
      const title = finalExecution.type === 'navigation' ? await page.title() : null;
      const text = finalExecution.type === 'navigation' ? await page.evaluate(() => document.body?.innerText ?? '') : body;

      return {
        mode: 'browser',
        requestedEngine: lease.requestedEngine,
        backend: lease.backend,
        backendFamily: lease.backendFamily,
        url: targetRequestUrl,
        finalUrl: resolvedFinalUrl,
        ok: resolvedStatus < 400,
        status: resolvedStatus,
        headers: resolvedResponseHeaders,
        body,
        text,
        sessionId: session?.id ?? null,
        proxyServer: proxy?.server ?? null,
        replayState,
        challenge,
        domMeta: { title },
        debug,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error;
      if (!isTransientBrowserBootstrapError(error) || attempt >= 2) {
        throw error;
      }
      await sleep(50);
    } finally {
      await teardownReplaySurface().catch(() => {});
      if (debugProbe) {
        await debugProbe.dispose().catch(() => {});
      }
      if (traceCapture) {
        await traceCapture.dispose().catch(() => {});
      }
      await page.close().catch(() => {});
      await lease.release();
    }
  }

  throw lastError ?? new Error('browser fetch failed');
}

export async function queryHtmlBatch(html, rules, { baseUrl, browser: browserConfig } = {}) {
  const lease = await acquireBrowserLease({
    browserConfig,
    isolate: true,
  });
  const page = await lease.context.newPage();

  try {
    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
    });

    if (rules.some(r => r.name === 'links')) {
      // Debug logging removed
    }

    const rawResults = await page.evaluate((inputRules) => {      function isNoFollow(relValue) {
        return String(relValue ?? '')
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .includes('nofollow');
      }

      function extractNodeValue(node, rule) {
        if (!node) {
          return null;
        }

        if (!rule.attribute || rule.attribute === 'text') {
          return (node.textContent ?? '').trim();
        }

        if (rule.attribute === 'html') {
          return node.innerHTML;
        }

        return node.getAttribute(rule.attribute) ?? null;
      }

      const result = {};

      for (const rule of inputRules) {
        if (rule.type === 'selector') {
          const nodes = Array.from(document.querySelectorAll(rule.selector ?? ''));
          const values = nodes.map((node) => extractNodeValue(node, rule)).filter((value) => value !== null);
          result[rule.name] = rule.all ? values.slice(0, rule.maxItems ?? 50) : values[0] ?? null;
          continue;
        }

        if (rule.type === 'links') {
          const selector = rule.selector ?? 'a[href]';
          const nodes = Array.from(document.querySelectorAll(selector));
          const values = nodes
            .map((node) => {
              if (rule.format === 'object') {
                const href = node.getAttribute('href') ?? node.href ?? null;
                if (!href) {
                  return null;
                }

                const rel = node.getAttribute('rel') ?? '';
                const nofollow = isNoFollow(rel);
                
                return {
                  url: href,
                  text: (node.textContent ?? '').trim() || null,
                  tagName: node.tagName?.toLowerCase?.() ?? null,
                  rel: rel || null,
                  nofollow,
                  hreflang: node.getAttribute('hreflang') ?? null,
                  mediaType: node.getAttribute('type') ?? null,
                };
              }

              if (!rule.attribute || rule.attribute === 'href') {
                return node.getAttribute('href') ?? node.href ?? null;
              }

              return extractNodeValue(node, rule);
            })
            .filter((value) => value !== null);

          result[rule.name] = rule.all ? values.slice(0, rule.maxItems ?? 50) : values[0] ?? null;
        }
      }

      return result;
    }, rules);

    if (!baseUrl) {
      return rawResults;
    }

    const normalized = {};
    const ruleMap = new Map(rules.map((rule) => [rule.name, rule]));
    const urlAttributes = new Set(['href', 'src', 'action', 'poster', 'data-src']);

    for (const [key, value] of Object.entries(rawResults)) {
      const rule = ruleMap.get(key) ?? null;
      const shouldNormalizeAsUrl = Boolean(
        rule
        && (
          rule.type === 'links'
          || (rule.type === 'selector' && urlAttributes.has(String(rule.attribute ?? '').toLowerCase()))
        ),
      );

      if (!shouldNormalizeAsUrl) {
        normalized[key] = value;
        continue;
      }

      if (Array.isArray(value)) {
        normalized[key] = value
          .map((entry) => {
            const rawUrl = typeof entry === 'object' && entry !== null ? entry.url : entry;
            try {
              const normalizedUrl = new URL(rawUrl, baseUrl).href;
              if (typeof entry === 'object' && entry !== null) {
                return {
                  ...entry,
                  url: normalizedUrl,
                };
              }
              return normalizedUrl;
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        continue;
      }

      if (typeof value === 'string') {
        try {
          normalized[key] = new URL(value, baseUrl).href;
        } catch {
          normalized[key] = value;
        }
        continue;
      }

      if (value && typeof value === 'object' && typeof value.url === 'string') {
        try {
          normalized[key] = {
            ...value,
            url: new URL(value.url, baseUrl).href,
          };
        } catch {
          normalized[key] = value;
        }
        continue;
      }

      normalized[key] = value;
    }

    return normalized;
  } finally {
    await page.close().catch(() => {});
    await lease.release();
  }
}

export async function closeBrowser(options = {}) {
  await closeBrowserPool(options);
}
