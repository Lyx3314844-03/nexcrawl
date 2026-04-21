import { attachBrowserTargetSessions } from '../runtime/browser-targets.js';
import { hashText } from '../utils/hash.js';

const DEFAULT_DEBUG_CONFIG = {
  enabled: true,
  captureScripts: true,
  captureNetwork: true,
  captureSourceMaps: true,
  captureHooks: true,
  maxScripts: 40,
  maxRequests: 80,
  maxSourceMaps: 40,
  maxHookEvents: 200,
  maxScriptBytes: 200_000,
  maxSourceMapBytes: 200_000,
  maxRequestBodyBytes: 8_192,
  maxResponseBodyBytes: 8_192,
  maxHeaderEntries: 40,
  timeoutMs: 5_000,
  hookMode: 'strict',
  persistArtifacts: true,
  previewItems: 5,
  previewBytes: 1_024,
  har: {
    enabled: false,
    includeBodies: true,
  },
  tracing: {
    enabled: false,
    screenshots: true,
    snapshots: true,
    sources: false,
  },
};

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function truncateText(value, maxBytes) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const bytes = Buffer.byteLength(text);

  if (bytes <= maxBytes) {
    return {
      text,
      bytes,
      truncated: false,
    };
  }

  return {
    text: Buffer.from(text).subarray(0, maxBytes).toString('utf8'),
    bytes,
    truncated: true,
  };
}

function normalizeHeaders(headers = {}, maxEntries = 40) {
  const output = {};

  for (const [key, value] of Object.entries(headers).slice(0, maxEntries)) {
    output[String(key)] = truncateText(value, 1024).text;
  }

  return output;
}

function isInterestingScriptUrl(url) {
  if (!url) {
    return true;
  }

  return ![
    'pptr:',
    'debugger://',
    'extensions::',
    'chrome-extension://',
    'devtools://',
    'omnicrawl://',
  ].some((prefix) => url.startsWith(prefix));
}

function resolveAbsoluteUrl(target, bases = []) {
  if (!target) {
    return null;
  }

  try {
    return new URL(target).href;
  } catch {
    for (const base of bases) {
      if (!base) {
        continue;
      }

      try {
        return new URL(target, base).href;
      } catch {
        continue;
      }
    }
  }

  return null;
}

function decodeDataUri(uri) {
  const match = String(uri).match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);

  if (!match) {
    return null;
  }

  const [, mimeType = 'text/plain', base64Flag, payload] = match;
  const decoded = base64Flag ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);

  return {
    mimeType,
    content: decoded,
  };
}

function describeDebugCaptureSupport({ lease, supportsWorkerSnapshot, supportsWorkerLifecycleEvents, supportsBrowserTargets }) {
  const backend = lease?.backend ?? null;
  const backendFamily = lease?.backendFamily ?? null;
  const limitations = [];

  let workerTargetsMode = 'full';
  if (!supportsWorkerSnapshot) {
    workerTargetsMode = 'unavailable';
    limitations.push('Current page API does not expose worker snapshots for debug capture.');
  } else if (!supportsWorkerLifecycleEvents) {
    workerTargetsMode = 'degraded';
    limitations.push('Worker debug capture is best-effort only; runtime worker creation events are not fully observable on this backend.');
  }

  let auxiliaryTargetsMode = 'full';
  if (!supportsBrowserTargets) {
    auxiliaryTargetsMode = 'degraded';
    limitations.push('Auxiliary target capture is degraded because this backend does not expose the browser target graph used for service/shared worker attachment.');
  }

  return {
    backend,
    backendFamily,
    workerTargets: {
      mode: workerTargetsMode,
      lifecycle: supportsWorkerLifecycleEvents ? 'evented' : 'best-effort',
    },
    auxiliaryTargets: {
      mode: auxiliaryTargetsMode,
    },
    limitations,
  };
}

async function fetchTextWithNodeContext(page, request, targetUrl, { timeoutMs, getCookies }) {
  const headers = {
    accept: 'application/json,text/plain,*/*',
  };
  const userAgent = request.headers?.['user-agent'];
  if (userAgent) {
    headers['user-agent'] = userAgent;
  }

  const referer = request.url;
  if (referer) {
    headers.referer = referer;
  }

  const cookies = await getCookies(targetUrl).catch(() => []);
  if (cookies.length > 0) {
    headers.cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  const response = await fetch(targetUrl, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  return {
    method: 'node.fetch',
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get('content-type') ?? null,
    headers: Object.fromEntries(response.headers.entries()),
    content: await response.text(),
  };
}

async function fetchTextWithPageContext(page, targetUrl, { timeoutMs }) {
  return page.evaluate(
    async ({ url, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          credentials: 'include',
          signal: controller.signal,
        });
        return {
          method: 'page.fetch',
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type') ?? null,
          headers: Object.fromEntries(response.headers.entries()),
          content: await response.text(),
          error: null,
        };
      } catch (error) {
        return {
          method: 'page.fetch',
          ok: false,
          status: null,
          contentType: null,
          headers: {},
          content: null,
          error: error?.message ?? String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    },
    {
      url: targetUrl,
      timeout: timeoutMs,
    },
  );
}

async function readProtocolStream(client, handle) {
  const chunks = [];

  try {
    while (true) {
      const chunk = await client.send('IO.read', {
        handle,
        size: 64 * 1024,
      });

      chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data));

      if (chunk.eof) {
        break;
      }
    }
  } finally {
    await client.send('IO.close', { handle }).catch(() => {});
  }

  return Buffer.concat(chunks).toString('utf8');
}

function summarizeSourceMap(content) {
  try {
    const parsed = JSON.parse(content);
    return {
      version: parsed.version ?? null,
      file: parsed.file ?? null,
      sourceRoot: parsed.sourceRoot ?? null,
      sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 80) : [],
      sourcesContentCount: Array.isArray(parsed.sourcesContent) ? parsed.sourcesContent.length : 0,
      namesCount: Array.isArray(parsed.names) ? parsed.names.length : 0,
      mappingsBytes: Buffer.byteLength(String(parsed.mappings ?? '')),
      parseError: null,
    };
  } catch (error) {
    return {
      version: null,
      file: null,
      sourceRoot: null,
      sources: [],
      sourcesContentCount: 0,
      namesCount: 0,
      mappingsBytes: 0,
      parseError: error?.message ?? String(error),
    };
  }
}

function normalizeTransportType(value) {
  if (value === 'Fetch') {
    return 'fetch';
  }

  if (value === 'XHR') {
    return 'xhr';
  }

  return null;
}

function isInjectedDebugBootstrapSource(source) {
  return typeof source === 'string' && source.startsWith('(function installRuntimeHooks(options = {}) {');
}

function extractSourceMapUrlFromSource(source) {
  if (typeof source !== 'string' || !source) {
    return null;
  }

  const matches = [...source.matchAll(/[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)\s*$/gm)];
  return matches.at(-1)?.[1] ?? null;
}

function installRuntimeHooks(options = {}) {
  const maxEvents = Number(options.maxEvents ?? 200);
  const stateKey = String(options.stateKey ?? '__ocdbg_state__');
  const stealthKey = String(options.stealthKey ?? '__ocdbg_stealth__');

  if (globalThis[stateKey]?.version === 2) {
    globalThis[stateKey].maxEvents = maxEvents;
    return;
  }

  const state = {
    version: 2,
    maxEvents,
    droppedEvents: 0,
    events: [],
  };

  function push(event) {
    const nextEvent = {
      at: new Date().toISOString(),
      source: 'runtime',
      ...event,
    };

    if (state.events.length >= state.maxEvents) {
      state.droppedEvents += 1;
      return;
    }

    state.events.push(nextEvent);
  }

  function labelStorage(target) {
    if (target === globalThis.localStorage) {
      return 'localStorage';
    }

    if (target === globalThis.sessionStorage) {
      return 'sessionStorage';
    }

    return 'storage';
  }

  function previewRuntimeValue(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) {
      return value;
    }

    if (depth > 2) {
      return '[MaxDepth]';
    }

    if (typeof value === 'string') {
      return value.length > 300 ? `${value.slice(0, 300)}...` : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'function') {
      return `[Function ${value.name || 'anonymous'}]`;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 10).map((entry) => previewRuntimeValue(entry, depth + 1, seen));
    }

    if (typeof value === 'object') {
      if (seen.has(value)) {
        return '[Circular]';
      }

      seen.add(value);

      if (typeof Request !== 'undefined' && value instanceof Request) {
        return {
          url: value.url,
          method: value.method,
        };
      }

      if (typeof Headers !== 'undefined' && value instanceof Headers) {
        return Object.fromEntries(Array.from(value.entries()).slice(0, 20));
      }

      if (typeof URL !== 'undefined' && value instanceof URL) {
        return value.href;
      }

      if (typeof FormData !== 'undefined' && value instanceof FormData) {
        return Array.from(value.entries())
          .slice(0, 20)
          .map(([key, entry]) => [key, typeof entry === 'string' ? entry : '[Binary]']);
      }

      if (ArrayBuffer.isView(value)) {
        return {
          type: value.constructor?.name ?? 'TypedArray',
          byteLength: value.byteLength ?? 0,
        };
      }

      const output = {};
      for (const [key, entry] of Object.entries(value).slice(0, 20)) {
        output[key] = previewRuntimeValue(entry, depth + 1, seen);
      }
      return output;
    }

    return String(value);
  }

  Object.defineProperty(globalThis, stateKey, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: state,
  });

  let stealth = globalThis[stealthKey];
  if (!stealth) {
    const originalFunctionToString = Function.prototype.toString;
    const sourceByWrapper = new WeakMap();
    const descriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');
    const patchedToString = function toString() {
      if (sourceByWrapper.has(this)) {
        return sourceByWrapper.get(this);
      }

      return originalFunctionToString.call(this);
    };

    sourceByWrapper.set(patchedToString, originalFunctionToString.call(originalFunctionToString));

    Object.defineProperty(Function.prototype, 'toString', {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      writable: descriptor?.writable ?? true,
      value: patchedToString,
    });

    stealth = {
      register(wrapper, original) {
        sourceByWrapper.set(wrapper, originalFunctionToString.call(original));
        return wrapper;
      },
    };

    Object.defineProperty(globalThis, stealthKey, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: stealth,
    });
  }

  function patchMethod(target, key, createWrapper) {
    let owner = target;
    let descriptor = null;
    while (owner && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor && typeof descriptor.value === 'function') {
        break;
      }
      descriptor = null;
      owner = Object.getPrototypeOf(owner);
    }

    if (!descriptor || !owner || typeof descriptor.value !== 'function') {
      return;
    }

    const original = descriptor.value;
    if (original.__ocdbgWrapped === true) {
      return;
    }
    const wrapper = stealth.register(createWrapper(original), original);
    Object.defineProperty(wrapper, '__ocdbgWrapped', {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });

    Object.defineProperty(owner, key, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      writable: descriptor.writable,
      value: wrapper,
    });
  }

  function patchAccessor(target, key, handlers = {}) {
    let owner = target;
    let descriptor = null;
    while (owner && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor && (typeof descriptor.get === 'function' || typeof descriptor.set === 'function')) {
        break;
      }
      descriptor = null;
      owner = Object.getPrototypeOf(owner);
    }

    if (!descriptor || !owner) {
      return;
    }

    const nextDescriptor = {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: descriptor.set,
    };

    if (typeof descriptor.get === 'function' && typeof handlers.get === 'function') {
      const originalGet = descriptor.get;
      nextDescriptor.get = stealth.register(function get() {
        const value = originalGet.call(this);
        try {
          handlers.get.call(this, value);
        } catch {}
        return value;
      }, originalGet);
    }

    if (typeof descriptor.set === 'function' && typeof handlers.set === 'function') {
      const originalSet = descriptor.set;
      nextDescriptor.set = stealth.register(function set(value) {
        try {
          handlers.set.call(this, value);
        } catch {}
        return originalSet.call(this, value);
      }, originalSet);
    }

    Object.defineProperty(owner, key, nextDescriptor);
  }

  function wrapMaybePromise(type, meta, value) {
    if (value && typeof value.then === 'function') {
      return value.then(
        (resolved) => {
          push({
            type,
            ...meta,
            result: previewRuntimeValue(resolved),
          });
          return resolved;
        },
        (error) => {
          push({
            type,
            ...meta,
            error: error?.message ?? String(error),
          });
          throw error;
        },
      );
    }

    push({
      type,
      ...meta,
      result: previewRuntimeValue(value),
    });
    return value;
  }

  if (typeof globalThis.atob === 'function') {
    patchMethod(globalThis, 'atob', (originalAtob) =>
      function atob(value) {
        const result = originalAtob.call(this, value);
        push({
          type: 'atob',
          input: previewRuntimeValue(value),
          result: previewRuntimeValue(result),
        });
        return result;
      },
    );
  }

  if (typeof globalThis.btoa === 'function') {
    patchMethod(globalThis, 'btoa', (originalBtoa) =>
      function btoa(value) {
        const result = originalBtoa.call(this, value);
        push({
          type: 'btoa',
          input: previewRuntimeValue(value),
          result: previewRuntimeValue(result),
        });
        return result;
      },
    );
  }

  if (globalThis.crypto?.subtle) {
    for (const methodName of ['digest', 'encrypt', 'decrypt', 'sign', 'verify', 'importKey', 'exportKey', 'deriveBits', 'deriveKey', 'wrapKey', 'unwrapKey']) {
      patchMethod(globalThis.crypto.subtle, methodName, (originalMethod) =>
        function subtleMethod(...args) {
          const [algorithm, firstPayload] = args;
          return wrapMaybePromise(`crypto.subtle.${methodName}`, {
            algorithm: previewRuntimeValue(algorithm),
            input: previewRuntimeValue(firstPayload),
          }, originalMethod.apply(this, args));
        },
      );
    }
  }

  if (typeof globalThis.WebAssembly === 'object' && globalThis.WebAssembly) {
    for (const methodName of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming']) {
      patchMethod(globalThis.WebAssembly, methodName, (originalMethod) =>
        function webAssemblyMethod(...args) {
          const [source] = args;
          return wrapMaybePromise(`webassembly.${methodName}`, {
            input: previewRuntimeValue(source),
          }, originalMethod.apply(this, args));
        },
      );
    }
  }

  patchMethod(globalThis, 'postMessage', (originalPostMessage) =>
    function postMessage(...args) {
      push({
        type: 'window.postMessage',
        input: previewRuntimeValue(args[0]),
        targetOrigin: previewRuntimeValue(args[1]),
      });
      return originalPostMessage.apply(this, args);
    },
  );

  if (typeof globalThis.MessagePort === 'function') {
    patchMethod(globalThis.MessagePort.prototype, 'postMessage', (originalPostMessage) =>
      function postMessage(...args) {
        push({
          type: 'messagePort.postMessage',
          input: previewRuntimeValue(args[0]),
        });
        return originalPostMessage.apply(this, args);
      },
    );
  }

  if (typeof globalThis.Worker === 'function') {
    patchMethod(globalThis.Worker.prototype, 'postMessage', (originalPostMessage) =>
      function postMessage(...args) {
        push({
          type: 'worker.postMessage',
          input: previewRuntimeValue(args[0]),
        });
        return originalPostMessage.apply(this, args);
      },
    );
  }

  if (typeof globalThis.BroadcastChannel === 'function') {
    patchMethod(globalThis.BroadcastChannel.prototype, 'postMessage', (originalPostMessage) =>
      function postMessage(...args) {
        push({
          type: 'broadcastChannel.postMessage',
          input: previewRuntimeValue(args[0]),
        });
        return originalPostMessage.apply(this, args);
      },
    );
  }

  if (typeof globalThis.Document === 'function') {
    patchMethod(globalThis.Document.prototype, 'createElement', (originalCreateElement) =>
      function createElement(...args) {
        const element = originalCreateElement.apply(this, args);
        if (String(args[0] ?? '').toLowerCase() === 'iframe') {
          push({
            type: 'iframe.create',
            tagName: 'iframe',
          });
        }
        return element;
      },
    );
  }

  if (typeof globalThis.HTMLIFrameElement === 'function') {
    patchAccessor(globalThis.HTMLIFrameElement.prototype, 'src', {
      set(value) {
        push({
          type: 'iframe.src.set',
          value: previewRuntimeValue(value),
        });
      },
    });
    patchMethod(globalThis.HTMLIFrameElement.prototype, 'setAttribute', (originalSetAttribute) =>
      function setAttribute(...args) {
        if (String(args[0] ?? '').toLowerCase() === 'src') {
          push({
            type: 'iframe.src.setAttribute',
            value: previewRuntimeValue(args[1]),
          });
        }
        return originalSetAttribute.apply(this, args);
      },
    );
  }

}

async function getMainFrameId(client) {
  const tree = await client.send('Page.getFrameTree');
  return tree.frameTree?.frame?.id ?? null;
}

async function loadResourceWithProtocol(client, frameId, targetUrl) {
  const pageResource = await client.send('Page.getResourceContent', {
    frameId,
    url: targetUrl,
  });

  return {
    method: 'page.getResourceContent',
    ok: true,
    status: null,
    contentType: null,
    headers: {},
    content: pageResource.base64Encoded ? Buffer.from(pageResource.content, 'base64').toString('utf8') : pageResource.content,
  };
}

async function loadResourceWithNetwork(client, frameId, targetUrl) {
  const payload = await client.send('Network.loadNetworkResource', {
    ...(frameId ? { frameId } : {}),
    url: targetUrl,
    options: {
      disableCache: false,
      includeCredentials: true,
    },
  });

  if (!payload.resource?.success || !payload.resource?.stream) {
    throw new Error(payload.resource?.netErrorName ?? `resource load failed with status ${payload.resource?.httpStatusCode ?? 'unknown'}`);
  }

  return {
    method: 'network.loadNetworkResource',
    ok: true,
    status: payload.resource.httpStatusCode ?? null,
    contentType: payload.resource.headers?.['content-type'] ?? payload.resource.headers?.['Content-Type'] ?? null,
    headers: payload.resource.headers ?? {},
    content: await readProtocolStream(client, payload.resource.stream),
  };
}

async function collectSourceMapPayload({ client, page, request, targetUrl, sourceMapUrl, timeoutMs }) {
  const attempts = [];

  if (sourceMapUrl.startsWith('data:')) {
    const inline = decodeDataUri(sourceMapUrl);
    if (!inline) {
      return {
        error: 'failed to decode data-uri source map',
        attempts: [{ method: 'data-uri', success: false, error: 'decode failed' }],
      };
    }

    return {
      method: 'data-uri',
      ok: true,
      status: null,
      contentType: inline.mimeType,
      headers: {},
      content: inline.content,
      attempts: [{ method: 'data-uri', success: true }],
    };
  }

  const frameId = await getMainFrameId(client).catch(() => null);

  if (frameId && targetUrl) {
    try {
      const pageContent = await loadResourceWithProtocol(client, frameId, targetUrl);
      return {
        ...pageContent,
        attempts: [...attempts, { method: pageContent.method, success: true }],
      };
    } catch (error) {
      attempts.push({
        method: 'page.getResourceContent',
        success: false,
        error: error?.message ?? String(error),
      });
    }
  }

  if (targetUrl) {
    try {
      const networkContent = await loadResourceWithNetwork(client, frameId, targetUrl);
      return {
        ...networkContent,
        attempts: [...attempts, { method: networkContent.method, success: true, status: networkContent.status }],
      };
    } catch (error) {
      attempts.push({
        method: 'network.loadNetworkResource',
        success: false,
        error: error?.message ?? String(error),
      });
    }
  }

  if (targetUrl) {
    try {
      const pageFetch = await fetchTextWithPageContext(page, targetUrl, { timeoutMs });
      if (pageFetch.ok && typeof pageFetch.content === 'string') {
        return {
          ...pageFetch,
          attempts: [...attempts, { method: pageFetch.method, success: true, status: pageFetch.status }],
        };
      }

      attempts.push({
        method: 'page.fetch',
        success: false,
        status: pageFetch.status,
        error: pageFetch.error ?? 'page fetch failed',
      });
    } catch (error) {
      attempts.push({
        method: 'page.fetch',
        success: false,
        error: error?.message ?? String(error),
      });
    }

    try {
      const nodeFetch = await fetchTextWithNodeContext(page, request, targetUrl, {
        timeoutMs,
        getCookies: (url) => lease.getCookies(page, url),
      });
      if (nodeFetch.ok && typeof nodeFetch.content === 'string') {
        return {
          ...nodeFetch,
          attempts: [...attempts, { method: nodeFetch.method, success: true, status: nodeFetch.status }],
        };
      }

      attempts.push({
        method: 'node.fetch',
        success: false,
        status: nodeFetch.status,
        error: `node fetch returned status ${nodeFetch.status}`,
      });
    } catch (error) {
      attempts.push({
        method: 'node.fetch',
        success: false,
        error: error?.message ?? String(error),
      });
    }
  }

  return {
    error: 'source map could not be retrieved',
    attempts,
  };
}

export function resolveBrowserDebugConfig(browserConfig = {}) {
  const input = browserConfig.debug ?? {};
  const hookMode = input.hookMode === 'balanced' ? 'balanced' : 'strict';
  const har =
    input.har && typeof input.har === 'object' && !Array.isArray(input.har)
      ? input.har
      : {};
  const tracing =
    input.tracing && typeof input.tracing === 'object' && !Array.isArray(input.tracing)
      ? input.tracing
      : {};

  return {
    enabled: input.enabled !== false,
    captureScripts: input.captureScripts !== false,
    captureNetwork: input.captureNetwork !== false,
    captureSourceMaps: input.captureSourceMaps !== false,
    captureHooks: input.captureHooks !== false,
    maxScripts: clamp(input.maxScripts, 1, 200, DEFAULT_DEBUG_CONFIG.maxScripts),
    maxRequests: clamp(input.maxRequests, 1, 300, DEFAULT_DEBUG_CONFIG.maxRequests),
    maxSourceMaps: clamp(input.maxSourceMaps, 1, 200, DEFAULT_DEBUG_CONFIG.maxSourceMaps),
    maxHookEvents: clamp(input.maxHookEvents, 1, 1000, DEFAULT_DEBUG_CONFIG.maxHookEvents),
    maxScriptBytes: clamp(input.maxScriptBytes, 256, 2_000_000, DEFAULT_DEBUG_CONFIG.maxScriptBytes),
    maxSourceMapBytes: clamp(input.maxSourceMapBytes, 256, 2_000_000, DEFAULT_DEBUG_CONFIG.maxSourceMapBytes),
    maxRequestBodyBytes: clamp(input.maxRequestBodyBytes, 128, 512_000, DEFAULT_DEBUG_CONFIG.maxRequestBodyBytes),
    maxResponseBodyBytes: clamp(input.maxResponseBodyBytes, 128, 512_000, DEFAULT_DEBUG_CONFIG.maxResponseBodyBytes),
    maxHeaderEntries: clamp(input.maxHeaderEntries, 1, 200, DEFAULT_DEBUG_CONFIG.maxHeaderEntries),
    timeoutMs: clamp(input.timeoutMs, 250, 30_000, DEFAULT_DEBUG_CONFIG.timeoutMs),
    hookMode,
    persistArtifacts: input.persistArtifacts !== false,
    previewItems: clamp(input.previewItems, 1, 50, DEFAULT_DEBUG_CONFIG.previewItems),
    previewBytes: clamp(input.previewBytes, 128, 16_384, DEFAULT_DEBUG_CONFIG.previewBytes),
    har: {
      enabled: har.enabled === true,
      includeBodies: har.includeBodies !== false,
    },
    tracing: {
      enabled: tracing.enabled === true,
      screenshots: tracing.screenshots !== false,
      snapshots: tracing.snapshots !== false,
      sources: tracing.sources === true,
    },
  };
}

export async function createBrowserDebugProbe({ page, request, browserConfig = {}, lease } = {}) {
  const debugConfig = resolveBrowserDebugConfig(browserConfig);

  if (!debugConfig.enabled) {
    return {
      enabled: false,
      async collect() {
        return {
          enabled: false,
        };
      },
      async dispose() {},
    };
  }

  const hookStateKey = `__ocdbg_state_${hashText(`${request.url}:${Date.now()}:${Math.random()}`).slice(0, 12)}`;
  const stealthKey = `__ocdbg_stealth_${hashText(`${hookStateKey}:stealth`).slice(0, 12)}`;

  if (debugConfig.captureHooks && debugConfig.hookMode === 'balanced') {
    await lease.addInitScript(page, installRuntimeHooks, {
      maxEvents: debugConfig.maxHookEvents,
      stateKey: hookStateKey,
      stealthKey,
    });
  }

  let client = null;
  try {
    client = await lease.createCdpSession(page);
  } catch {
    return {
      enabled: false,
      async collect() {
        return {
          enabled: false,
          unsupported: 'cdp-session-unavailable',
        };
      },
      async dispose() {},
    };
  }
  const browser = typeof page.browser === 'function'
    ? page.browser()
    : page.context?.().browser?.() ?? null;
  let supportsWorkerSnapshot = typeof page.workers === 'function';
  let supportsWorkerLifecycleEvents = lease?.backendFamily === 'puppeteer' && typeof page.on === 'function';
  const supportsLegacyBrowserTargets = browser && typeof browser.targets === 'function' && typeof browser.on === 'function';
  let supportsBrowserTargets = false;
  if (debugConfig.captureSourceMaps) {
    await client.send('Page.enable').catch(() => {});
  }
  if (debugConfig.captureHooks) {
    await client.send('DOMStorage.enable').catch(() => {});
  }
  const pendingTasks = [];
  const requests = [];
  const requestMap = new Map();
  const scripts = [];
  const scriptKeys = new Set();
  const sourceMaps = [];
  const sourceMapKeys = new Set();
  const cdpHookEvents = [];
  const counts = {
    droppedRequests: 0,
    droppedScripts: 0,
    droppedSourceMaps: 0,
    droppedHookEvents: 0,
  };
  const workerListeners = new Map();
  const auxTargetSessions = new Map();
  let targetSessionManager = null;

  function pushCdpHookEvent(event) {
    if (!debugConfig.captureHooks) {
      return;
    }

    const nextEvent = {
      at: new Date().toISOString(),
      source: 'cdp',
      ...event,
    };

    if (cdpHookEvents.length >= debugConfig.maxHookEvents) {
      counts.droppedHookEvents += 1;
      return;
    }

    cdpHookEvents.push(nextEvent);
  }

  function ensureRequestRecord(event) {
    const existing = requestMap.get(event.requestId);
    if (existing) {
      return existing;
    }

    const record = {
      requestId: event.requestId,
      transport: null,
      url: event.request.url,
      method: event.request.method,
      startedAt:
        typeof event.wallTime === 'number'
          ? new Date(event.wallTime * 1000).toISOString()
          : new Date().toISOString(),
      requestHeaders: normalizeHeaders(event.request.headers, debugConfig.maxHeaderEntries),
      requestBody: event.request.postData
        ? (() => {
            const requestBody = truncateText(event.request.postData, debugConfig.maxRequestBodyBytes);
            return {
              text: requestBody.text,
              bytes: requestBody.bytes,
              truncated: requestBody.truncated,
            };
          })()
        : null,
      _recorded: false,
      status: null,
      mimeType: null,
      responseHeaders: {},
      responseBody: null,
      errorText: null,
    };

    if (debugConfig.captureNetwork) {
      if (requests.length >= debugConfig.maxRequests) {
        counts.droppedRequests += 1;
      } else {
        record._recorded = true;
        record.requestHeaders = normalizeHeaders(event.request.headers, debugConfig.maxHeaderEntries);

        if (event.request.postData) {
          const requestBody = truncateText(event.request.postData, debugConfig.maxRequestBodyBytes);
          record.requestBody = {
            text: requestBody.text,
            bytes: requestBody.bytes,
            truncated: requestBody.truncated,
          };
        }

        requests.push(record);
      }
    }

    requestMap.set(event.requestId, record);
    return record;
  }

  function recordNetworkEntry(record) {
    if (!debugConfig.captureNetwork || record._recorded || !record.transport) {
      return;
    }

    if (requests.length >= debugConfig.maxRequests) {
      counts.droppedRequests += 1;
      return;
    }

    record._recorded = true;
    requests.push(record);
  }

  async function collectRequestBody(requestId, cdpClient = client) {
    try {
      const payload = await cdpClient.send('Network.getResponseBody', { requestId });
      const bodyText = payload.base64Encoded ? Buffer.from(payload.body, 'base64').toString('utf8') : payload.body;
      const preview = truncateText(bodyText, debugConfig.maxResponseBodyBytes);
      return {
        text: preview.text,
        bytes: preview.bytes,
        truncated: preview.truncated,
        base64Encoded: Boolean(payload.base64Encoded),
      };
    } catch (error) {
      return {
        error: error?.message ?? String(error),
      };
    }
  }

  async function collectSourceMap(sourceMapUrl, scriptRecord) {
    const resolvedUrl = resolveAbsoluteUrl(sourceMapUrl, [scriptRecord.url, request.url, page.url()]);
    const dedupeKey = resolvedUrl ?? sourceMapUrl;

    if (!dedupeKey || sourceMapKeys.has(dedupeKey)) {
      return;
    }

    if (sourceMaps.length >= debugConfig.maxSourceMaps) {
      counts.droppedSourceMaps += 1;
      return;
    }

    sourceMapKeys.add(dedupeKey);

    const sourceMapRecord = {
      scriptUrl: scriptRecord.url,
      url: resolvedUrl,
      sourceMapUrl,
      hash: null,
      content: null,
      contentType: null,
      bytes: 0,
      truncated: false,
      error: null,
      summary: null,
      retrieval: {
        method: null,
        status: null,
        headers: {},
        attempts: [],
      },
    };

    try {
      const fetched = await collectSourceMapPayload({
        client: scriptRecord._client ?? client,
        page,
        request,
        targetUrl: resolvedUrl,
        sourceMapUrl,
        timeoutMs: debugConfig.timeoutMs,
      });

      sourceMapRecord.retrieval = {
        method: fetched.method ?? null,
        status: fetched.status ?? null,
        headers: normalizeHeaders(fetched.headers ?? {}, debugConfig.maxHeaderEntries),
        attempts: fetched.attempts ?? [],
      };

      if (!fetched.content) {
        throw new Error(fetched.error ?? 'source map content missing');
      }

      const preview = truncateText(fetched.content, debugConfig.maxSourceMapBytes);
      sourceMapRecord.content = preview.text;
      sourceMapRecord.bytes = preview.bytes;
      sourceMapRecord.truncated = preview.truncated;
      sourceMapRecord.contentType = fetched.contentType ?? null;
      sourceMapRecord.hash = hashText(fetched.content);
      sourceMapRecord.summary = summarizeSourceMap(fetched.content);
    } catch (error) {
      sourceMapRecord.error = error?.message ?? String(error);
    }

    sourceMaps.push(sourceMapRecord);
  }

  async function fetchScriptText(targetUrl) {
    if (!targetUrl) {
      return null;
    }

    try {
      const pageFetch = await fetchTextWithPageContext(page, targetUrl, { timeoutMs: debugConfig.timeoutMs });
      if (pageFetch.ok && typeof pageFetch.content === 'string') {
        return pageFetch.content;
      }
    } catch {
      // fall through
    }

    try {
      const nodeFetch = await fetchTextWithNodeContext(page, request, targetUrl, {
        timeoutMs: debugConfig.timeoutMs,
        getCookies: (url) => lease.getCookies(page, url),
      });
      if (nodeFetch.ok && typeof nodeFetch.content === 'string') {
        return nodeFetch.content;
      }
    } catch {
      // fall through
    }

    return null;
  }

  async function collectScriptByUrl({
    targetUrl,
    targetType = 'worker',
    cdpClient = client,
  } = {}) {
    const resolvedScriptUrl = resolveAbsoluteUrl(targetUrl, [page.url(), request.url]) ?? targetUrl ?? null;
    if (!resolvedScriptUrl || !isInterestingScriptUrl(resolvedScriptUrl)) {
      return;
    }

    const dedupeKey = `${targetType}:${resolvedScriptUrl}`;
    if (scriptKeys.has(dedupeKey)) {
      return;
    }

    const scriptSource = await fetchScriptText(resolvedScriptUrl);
    if (typeof scriptSource !== 'string' || isInjectedDebugBootstrapSource(scriptSource)) {
      return;
    }

    if (scripts.length >= debugConfig.maxScripts) {
      counts.droppedScripts += 1;
      return;
    }

    const sourcePreview = truncateText(scriptSource, debugConfig.maxScriptBytes);
    const scriptRecord = {
      scriptId: dedupeKey,
      rawScriptId: null,
      url: resolvedScriptUrl,
      kind: 'external',
      targetType,
      startLine: 0,
      startColumn: 0,
      executionContextId: null,
      sourceMapUrl: extractSourceMapUrlFromSource(scriptSource),
      hash: hashText(scriptSource),
      bytes: sourcePreview.bytes,
      truncated: sourcePreview.truncated,
      source: sourcePreview.text,
      _client: cdpClient,
    };

    scriptKeys.add(dedupeKey);
    scripts.push(scriptRecord);

    if (debugConfig.captureSourceMaps && scriptRecord.sourceMapUrl) {
      await collectSourceMap(scriptRecord.sourceMapUrl, scriptRecord);
    }
  }

  async function collectScript(event) {
    try {
      const { scriptSource = '' } = await client.send('Debugger.getScriptSource', {
        scriptId: event.scriptId,
      });

      if (isInjectedDebugBootstrapSource(scriptSource)) {
        return;
      }

      if (scripts.length >= debugConfig.maxScripts) {
        counts.droppedScripts += 1;
        return;
      }

      const resolvedScriptUrl = resolveAbsoluteUrl(event.url, [page.url(), request.url]);
      const isDocumentInlineScript = !event.url || resolvedScriptUrl === page.url() || resolvedScriptUrl === request.url;
      const sourcePreview = truncateText(scriptSource, debugConfig.maxScriptBytes);
      const scriptKey = `${event.executionContextAuxData?.type ?? 'default'}:${resolvedScriptUrl ?? event.url ?? event.scriptId}`;
      if (scriptKeys.has(scriptKey)) {
        return;
      }
      const scriptRecord = {
        scriptId: event.scriptId,
        url: resolvedScriptUrl ?? event.url ?? null,
        kind: isDocumentInlineScript ? 'inline' : 'external',
        targetType: event.executionContextAuxData?.type ?? 'default',
        startLine: event.startLine ?? 0,
        startColumn: event.startColumn ?? 0,
        executionContextId: event.executionContextId ?? null,
        sourceMapUrl: event.sourceMapURL || null,
        hash: hashText(scriptSource),
        bytes: sourcePreview.bytes,
        truncated: sourcePreview.truncated,
        source: sourcePreview.text,
        _client: client,
      };

      scriptKeys.add(scriptKey);
      scripts.push(scriptRecord);

      if (debugConfig.captureSourceMaps && event.sourceMapURL) {
        await collectSourceMap(event.sourceMapURL, scriptRecord);
      }
    } catch {
      // Best-effort debug collection should not fail the crawl.
    }
  }

  if (debugConfig.captureNetwork || debugConfig.captureHooks) {
    await client.send('Network.enable', {
      maxPostDataSize: debugConfig.maxRequestBodyBytes,
    });

    client.on('Network.requestWillBeSent', (event) => {
      ensureRequestRecord(event);
    });

    client.on('Network.responseReceived', (event) => {
      const record = requestMap.get(event.requestId);
      const transport = normalizeTransportType(event.type);
      if (!record || !transport) {
        return;
      }

      record.transport = transport;
      record.url = event.response.url || record.url;
      record.status = event.response.status;
      record.mimeType = event.response.mimeType ?? null;
      record.responseHeaders = normalizeHeaders(event.response.headers, debugConfig.maxHeaderEntries);
      recordNetworkEntry(record);

      const requestBody = record.requestBody
        ? truncateText(record.requestBody.text, Math.min(debugConfig.maxRequestBodyBytes, 1024))
        : null;

      pushCdpHookEvent({
        at: record.startedAt,
        type: `${record.transport}.call`,
        transport: record.transport,
        requestId: record.requestId,
        url: record.url,
        method: record.method,
        body: requestBody?.text ?? null,
      });

      pushCdpHookEvent({
        type: `${record.transport}.result`,
        transport: record.transport,
        requestId: record.requestId,
        url: record.url,
        method: record.method,
        status: event.response.status,
        ok: event.response.status < 400,
      });
    });

    client.on('Network.loadingFinished', (event) => {
      const record = requestMap.get(event.requestId);
      if (!record) {
        return;
      }

      if (record._recorded) {
        record.encodedDataLength = event.encodedDataLength ?? null;
        record.finishedAt = new Date().toISOString();
        pendingTasks.push(
          collectRequestBody(event.requestId).then((responseBody) => {
            record.responseBody = responseBody;
          }),
        );
      }
    });

    client.on('Network.loadingFailed', (event) => {
      const record = requestMap.get(event.requestId);
      if (!record || !record.transport) {
        return;
      }

      if (record._recorded) {
        record.errorText = event.errorText ?? 'request failed';
        record.finishedAt = new Date().toISOString();
      }

      pushCdpHookEvent({
        type: `${record.transport}.error`,
        transport: record.transport,
        requestId: record.requestId,
        url: record.url,
        method: record.method,
        message: event.errorText ?? 'request failed',
      });
    });
  }

  if (debugConfig.captureScripts || debugConfig.captureSourceMaps) {
    await client.send('Debugger.enable');
    client.on('Debugger.scriptParsed', (event) => {
      if (!isInterestingScriptUrl(event.url)) {
        return;
      }

      pendingTasks.push(collectScript(event));
    });
  }

  if (debugConfig.captureHooks) {
    client.on('DOMStorage.domStorageItemAdded', (event) => {
      const storageType = event.storageId?.isLocalStorage ? 'localStorage' : 'sessionStorage';
      pushCdpHookEvent({
        type: `${storageType}.setItem`,
        key: event.key,
        value: truncateText(event.newValue, 512).text,
      });
    });

    client.on('DOMStorage.domStorageItemUpdated', (event) => {
      const storageType = event.storageId?.isLocalStorage ? 'localStorage' : 'sessionStorage';
      pushCdpHookEvent({
        type: `${storageType}.setItem`,
        key: event.key,
        oldValue: truncateText(event.oldValue, 512).text,
        value: truncateText(event.newValue, 512).text,
      });
    });

    client.on('DOMStorage.domStorageItemRemoved', (event) => {
      const storageType = event.storageId?.isLocalStorage ? 'localStorage' : 'sessionStorage';
      pushCdpHookEvent({
        type: `${storageType}.removeItem`,
        key: event.key,
      });
    });

    client.on('DOMStorage.domStorageItemsCleared', (event) => {
      const storageType = event.storageId?.isLocalStorage ? 'localStorage' : 'sessionStorage';
      pushCdpHookEvent({
        type: `${storageType}.clear`,
      });
    });
  }

  async function attachRoutedTargetSession(targetClient, targetInfo = {}) {
    const targetType = targetInfo.type ?? 'worker';
    const targetUrl = targetInfo.url ?? null;
    const targetKey = `${targetType}:${targetInfo.targetId ?? targetUrl ?? hashText(JSON.stringify(targetInfo)).slice(0, 8)}`;

    if (debugConfig.captureNetwork || debugConfig.captureHooks) {
      await targetClient.send('Network.enable', {
        maxPostDataSize: debugConfig.maxRequestBodyBytes,
      }).catch(() => {});

      targetClient.on('Network.requestWillBeSent', (event) => {
        const requestId = `${targetKey}:${event.requestId}`;
        const transport = normalizeTransportType(event.type);
        const record = {
          requestId,
          transport,
          targetType,
          url: event.request.url,
          method: event.request.method,
          startedAt:
            typeof event.wallTime === 'number'
              ? new Date(event.wallTime * 1000).toISOString()
              : new Date().toISOString(),
          requestHeaders: normalizeHeaders(event.request.headers, debugConfig.maxHeaderEntries),
          requestBody: event.request.postData
            ? (() => {
                const requestBody = truncateText(event.request.postData, debugConfig.maxRequestBodyBytes);
                return {
                  text: requestBody.text,
                  bytes: requestBody.bytes,
                  truncated: requestBody.truncated,
                };
              })()
            : null,
          _recorded: false,
          status: null,
          mimeType: null,
          responseHeaders: {},
          responseBody: null,
          errorText: null,
          _client: targetClient,
          _rawRequestId: event.requestId,
        };

        requestMap.set(requestId, record);
        recordNetworkEntry(record);
      });

      targetClient.on('Network.responseReceived', (event) => {
        const requestId = `${targetKey}:${event.requestId}`;
        const record = requestMap.get(requestId);
        if (!record) {
          return;
        }

        record.transport = record.transport ?? normalizeTransportType(event.type);
        record.url = event.response.url || record.url;
        record.status = event.response.status;
        record.mimeType = event.response.mimeType ?? null;
        record.responseHeaders = normalizeHeaders(event.response.headers, debugConfig.maxHeaderEntries);
        recordNetworkEntry(record);

        if (!record.transport) {
          return;
        }

        const requestBody = record.requestBody
          ? truncateText(record.requestBody.text, Math.min(debugConfig.maxRequestBodyBytes, 1024))
          : null;

        pushCdpHookEvent({
          at: record.startedAt,
          type: `${record.transport}.call`,
          transport: record.transport,
          requestId: record.requestId,
          targetType,
          url: record.url,
          method: record.method,
          body: requestBody?.text ?? null,
        });

        pushCdpHookEvent({
          type: `${record.transport}.result`,
          transport: record.transport,
          requestId: record.requestId,
          targetType,
          url: record.url,
          method: record.method,
          status: event.response.status,
          ok: event.response.status < 400,
        });
      });

      targetClient.on('Network.loadingFinished', (event) => {
        const requestId = `${targetKey}:${event.requestId}`;
        const record = requestMap.get(requestId);
        if (!record) {
          return;
        }

        record.finishedAt = new Date().toISOString();
        if (record._recorded) {
          pendingTasks.push(
            collectRequestBody(event.requestId, targetClient).then((responseBody) => {
              record.responseBody = responseBody;
            }),
          );
        }
      });

      targetClient.on('Network.loadingFailed', (event) => {
        const requestId = `${targetKey}:${event.requestId}`;
        const record = requestMap.get(requestId);
        if (!record || !record.transport) {
          return;
        }

        record.errorText = event.errorText ?? 'request failed';
        record.finishedAt = new Date().toISOString();
        pushCdpHookEvent({
          type: `${record.transport}.error`,
          transport: record.transport,
          requestId: record.requestId,
          targetType,
          url: record.url,
          method: record.method,
          message: event.errorText ?? 'request failed',
        });
      });
    }

    if (debugConfig.captureScripts || debugConfig.captureSourceMaps) {
      await targetClient.send('Debugger.enable').catch(() => {});
      targetClient.on('Debugger.scriptParsed', (event) => {
        if (!isInterestingScriptUrl(event.url)) {
          return;
        }

        pendingTasks.push(
          (async () => {
            try {
              const { scriptSource = '' } = await targetClient.send('Debugger.getScriptSource', {
                scriptId: event.scriptId,
              });

              if (isInjectedDebugBootstrapSource(scriptSource)) {
                return;
              }

              if (scripts.length >= debugConfig.maxScripts) {
                counts.droppedScripts += 1;
                return;
              }

              const sourcePreview = truncateText(scriptSource, debugConfig.maxScriptBytes);
              const scriptRecord = {
                scriptId: `${targetKey}:${event.scriptId}`,
                rawScriptId: event.scriptId,
                url: resolveAbsoluteUrl(event.url, [targetUrl, request.url, page.url()]) ?? event.url ?? targetUrl,
                kind: 'external',
                targetType,
                startLine: event.startLine ?? 0,
                startColumn: event.startColumn ?? 0,
                executionContextId: event.executionContextId ?? null,
                sourceMapUrl: event.sourceMapURL || null,
                hash: hashText(scriptSource),
                bytes: sourcePreview.bytes,
                truncated: sourcePreview.truncated,
                source: sourcePreview.text,
                _client: targetClient,
              };

              scripts.push(scriptRecord);

              if (debugConfig.captureSourceMaps && event.sourceMapURL) {
                await collectSourceMap(event.sourceMapURL, scriptRecord);
              }
            } catch {
              // Best-effort worker target capture should not fail the crawl.
            }
          })(),
        );
      });

      pendingTasks.push(
        collectScriptByUrl({
          targetUrl,
          targetType,
          cdpClient: targetClient,
        }),
      );
    }
  }

  async function attachWorker(worker) {
    try {
      const workerClient = worker.client;
      if (!workerClient || workerListeners.has(workerClient)) {
        return;
      }

      await workerClient.send('Debugger.enable').catch(() => {});

      const onScriptParsed = (event) => {
        if (!isInterestingScriptUrl(event.url)) {
          return;
        }

        pendingTasks.push(
          (async () => {
            try {
              const { scriptSource = '' } = await workerClient.send('Debugger.getScriptSource', {
                scriptId: event.scriptId,
              });

              if (isInjectedDebugBootstrapSource(scriptSource)) {
                return;
              }

              if (scripts.length >= debugConfig.maxScripts) {
                counts.droppedScripts += 1;
                return;
              }

              const sourcePreview = truncateText(scriptSource, debugConfig.maxScriptBytes);
              const scriptRecord = {
                scriptId: event.scriptId,
                url: resolveAbsoluteUrl(event.url, [request.url, page.url()]) ?? event.url ?? worker.url(),
                kind: 'external',
                targetType: 'worker',
                startLine: event.startLine ?? 0,
                startColumn: event.startColumn ?? 0,
                executionContextId: event.executionContextId ?? null,
                sourceMapUrl: event.sourceMapURL || null,
                hash: hashText(scriptSource),
                bytes: sourcePreview.bytes,
                truncated: sourcePreview.truncated,
                source: sourcePreview.text,
                _client: workerClient,
              };

              scripts.push(scriptRecord);

              if (debugConfig.captureSourceMaps && event.sourceMapURL) {
                await collectSourceMap(event.sourceMapURL, scriptRecord);
              }
            } catch {
              // Best-effort worker debug capture should not fail the crawl.
            }
          })(),
        );
      };

      workerClient.on('Debugger.scriptParsed', onScriptParsed);
      workerListeners.set(workerClient, onScriptParsed);
      pendingTasks.push(
        collectScriptByUrl({
          targetUrl: worker.url?.(),
          targetType: 'worker',
          cdpClient: workerClient,
        }),
      );
    } catch {
      // Worker capture is best-effort.
    }
  }

  async function attachAuxTarget(target) {
    try {
      const targetType = target.type();
      if (!['service_worker', 'shared_worker'].includes(targetType) || auxTargetSessions.has(target)) {
        return;
      }

      const targetSession = await target.createCDPSession();
      await targetSession.send('Debugger.enable').catch(() => {});

      const onScriptParsed = (event) => {
        if (!isInterestingScriptUrl(event.url)) {
          return;
        }

        pendingTasks.push(
          (async () => {
            try {
              const { scriptSource = '' } = await targetSession.send('Debugger.getScriptSource', {
                scriptId: event.scriptId,
              });

              if (isInjectedDebugBootstrapSource(scriptSource)) {
                return;
              }

              if (scripts.length >= debugConfig.maxScripts) {
                counts.droppedScripts += 1;
                return;
              }

              const sourcePreview = truncateText(scriptSource, debugConfig.maxScriptBytes);
              const scriptRecord = {
                scriptId: event.scriptId,
                url: resolveAbsoluteUrl(event.url, [request.url, page.url(), target.url()]) ?? event.url ?? target.url(),
                kind: 'external',
                targetType,
                startLine: event.startLine ?? 0,
                startColumn: event.startColumn ?? 0,
                executionContextId: event.executionContextId ?? null,
                sourceMapUrl: event.sourceMapURL || null,
                hash: hashText(scriptSource),
                bytes: sourcePreview.bytes,
                truncated: sourcePreview.truncated,
                source: sourcePreview.text,
                _client: targetSession,
              };

              scripts.push(scriptRecord);

              if (debugConfig.captureSourceMaps && event.sourceMapURL) {
                await collectSourceMap(event.sourceMapURL, scriptRecord);
              }
            } catch {
              // Best-effort target capture should not fail the crawl.
            }
          })(),
        );
      };

      targetSession.on('Debugger.scriptParsed', onScriptParsed);
      auxTargetSessions.set(target, {
        session: targetSession,
        listener: onScriptParsed,
      });
      pendingTasks.push(
        collectScriptByUrl({
          targetUrl: target.url?.(),
          targetType,
          cdpClient: targetSession,
        }),
      );
    } catch {
      // Auxiliary target capture is best-effort.
    }
  }

  if (browser && lease?.backendFamily === 'playwright') {
    targetSessionManager = await attachBrowserTargetSessions(browser, {
      onAttached: attachRoutedTargetSession,
    });
    if (targetSessionManager) {
      supportsBrowserTargets = true;
      supportsWorkerSnapshot = true;
      supportsWorkerLifecycleEvents = true;
    }
  }

  if (!targetSessionManager && supportsWorkerSnapshot) {
    for (const worker of page.workers()) {
      await attachWorker(worker);
    }
  }

  if (!targetSessionManager && supportsLegacyBrowserTargets) {
    supportsBrowserTargets = true;
    for (const target of browser.targets()) {
      await attachAuxTarget(target);
    }
  }

  const captureSupport = describeDebugCaptureSupport({
    lease,
    supportsWorkerSnapshot,
    supportsWorkerLifecycleEvents,
    supportsBrowserTargets,
  });

  if (!targetSessionManager && supportsWorkerLifecycleEvents) {
    page.on('workercreated', attachWorker);
  }
  const onWorkerDestroyed = (worker) => {
    const workerClient = worker.client;
    const listener = workerListeners.get(workerClient);
    if (!listener) {
      return;
    }

    workerClient.off('Debugger.scriptParsed', listener);
    workerListeners.delete(workerClient);
  };
  if (!targetSessionManager && supportsWorkerLifecycleEvents) {
    page.on('workerdestroyed', onWorkerDestroyed);
  }
  const onTargetCreated = (target) => {
    pendingTasks.push(attachAuxTarget(target));
  };
  if (!targetSessionManager && supportsLegacyBrowserTargets) {
    browser.on('targetcreated', onTargetCreated);
  }

  return {
    enabled: true,
    async collect({ finalUrl } = {}) {
      await Promise.allSettled(pendingTasks);

      let runtimeHooks = {
        events: [],
        droppedEvents: 0,
        error: null,
      };

      if (debugConfig.captureHooks) {
        if (debugConfig.hookMode === 'balanced') {
          try {
            const runtimeState = await page.evaluate((key) => {
              const state = globalThis[key];
              return {
                events: Array.isArray(state?.events) ? state.events : [],
                droppedEvents: Number(state?.droppedEvents ?? 0),
              };
            }, hookStateKey);

            runtimeHooks = {
              events: runtimeState.events,
              droppedEvents: runtimeState.droppedEvents,
              error: null,
            };
          } catch (error) {
            runtimeHooks.error = error?.message ?? String(error);
          }
        }
      }

      const mergedHookEvents = [...cdpHookEvents, ...runtimeHooks.events].sort((left, right) =>
        String(left.at ?? '').localeCompare(String(right.at ?? '')),
      );
      const overflowHookEvents = Math.max(0, mergedHookEvents.length - debugConfig.maxHookEvents);
      const finalHookEvents = mergedHookEvents.slice(0, debugConfig.maxHookEvents);
      const droppedHookEvents = counts.droppedHookEvents + runtimeHooks.droppedEvents + overflowHookEvents;
      const plainRequests = requests.map(({ _recorded, ...record }) => record);
      const plainScripts = scripts.map(({ _client, ...record }) => record);
      const plainSourceMaps = sourceMaps.map(({ _client, ...record }) => record);

      return {
        enabled: true,
        finalUrl: finalUrl ?? page.url() ?? request.url,
        captureSupport,
        summary: {
          requestCount: plainRequests.length,
          scriptCount: plainScripts.length,
          sourceMapCount: plainSourceMaps.length,
          hookEventCount: finalHookEvents.length,
          droppedRequests: counts.droppedRequests,
          droppedScripts: counts.droppedScripts,
          droppedSourceMaps: counts.droppedSourceMaps,
          droppedHookEvents,
          transportHookMode: debugConfig.captureHooks ? 'cdp-synthesized' : 'disabled',
          runtimeHookMode: !debugConfig.captureHooks ? 'disabled' : debugConfig.hookMode === 'balanced' ? 'stealth-patch' : 'native-cdp-domstorage',
        },
        requests: plainRequests,
        scripts: plainScripts,
        sourceMaps: plainSourceMaps,
        hooks: {
          events: finalHookEvents,
          droppedEvents: droppedHookEvents,
          error: runtimeHooks.error,
          sources: {
            transport: debugConfig.captureHooks ? 'cdp' : 'disabled',
            runtime: !debugConfig.captureHooks ? 'disabled' : debugConfig.hookMode === 'balanced' ? 'stealth-patch' : 'domstorage-native',
          },
        },
      };
    },
    async dispose() {
      if (!targetSessionManager && supportsWorkerLifecycleEvents && typeof page.off === 'function') {
        page.off('workercreated', attachWorker);
        page.off('workerdestroyed', onWorkerDestroyed);
      }
      if (!targetSessionManager && supportsLegacyBrowserTargets) {
        browser.off('targetcreated', onTargetCreated);
      }
      for (const [workerClient, listener] of workerListeners.entries()) {
        workerClient.off('Debugger.scriptParsed', listener);
      }
      workerListeners.clear();
      for (const { session, listener } of auxTargetSessions.values()) {
        session.off('Debugger.scriptParsed', listener);
        await session.detach().catch(() => {});
      }
      auxTargetSessions.clear();
      await targetSessionManager?.dispose().catch(() => {});
      await client.detach().catch(() => {});
    },
  };
}
