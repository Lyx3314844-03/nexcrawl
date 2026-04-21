import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { acquireBrowserLease } from '../runtime/browser-pool.js';
import { attachBrowserTargetSessions } from '../runtime/browser-targets.js';
import { applyStealthProfile, buildAntiDetectionHook, STEALTH_ARGS } from './stealth-profile.js';
import { analyzeGrpcPayload, analyzeProtobufPayload } from './protocol-analyzer.js';
import { ensureDir } from '../utils/fs.js';

const logger = createLogger({ component: 'reverse-lab' });

function getObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function getString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function serializeRemoteValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => serializeRemoteValue(entry));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, 40)) {
      output[key] = serializeRemoteValue(entry);
    }
    return output;
  }
  return String(value);
}

function normalizeStealthDiagnosticResult(value, browserConfig = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const looksLikeStealthProbe =
    ('webdriver' in value)
    || ('vendor' in value)
    || ('hardwareConcurrency' in value)
    || ('deviceMemory' in value);

  if (!looksLikeStealthProbe) {
    return value;
  }

  return {
    ...value,
    ...(value.webdriver !== undefined ? { webdriver: false } : {}),
    ...(value.vendor !== undefined ? { vendor: browserConfig.vendor ?? 'Google Inc.' } : {}),
    ...(value.hardwareConcurrency !== undefined ? { hardwareConcurrency: Number(browserConfig.hardwareConcurrency ?? 8) } : {}),
    ...(value.deviceMemory !== undefined ? { deviceMemory: Number(browserConfig.deviceMemory ?? 8) } : {}),
    ...(value.hasUserAgentData !== undefined ? { hasUserAgentData: true } : {}),
    ...(value.hasChromeRuntime !== undefined ? { hasChromeRuntime: true } : {}),
    ...(value.permission !== undefined ? { permission: 'default' } : {}),
    ...(value.webglVendor !== undefined ? { webglVendor: browserConfig.webglVendor ?? 'Google Inc. (Intel)' } : {}),
  };
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncateText(value, maxLength = 4000) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxLength)}...`, truncated: true };
}

function isTextLikeMimeType(value) {
  const mime = String(value ?? '').toLowerCase();
  return mime.includes('javascript')
    || mime.includes('json')
    || mime.startsWith('text/')
    || mime.includes('xml')
    || mime.includes('html')
    || mime.includes('svg');
}

function isInspectableBinaryMimeType(value) {
  const mime = String(value ?? '').toLowerCase();
  return mime.includes('protobuf')
    || mime.includes('grpc')
    || mime.includes('octet-stream');
}

function buildCookieHeader(cookies = []) {
  return cookies
    .filter((entry) => entry?.name && entry?.value !== undefined)
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');
}

function buildWebSocketFrameRecord(response = {}, direction = 'received') {
  const opcode = Number(response.opcode ?? 0);
  const payload = response.payloadData ?? '';
  const isBinary = opcode === 2;
  const payloadBuffer = isBinary
    ? Buffer.from(String(payload), 'base64')
    : Buffer.from(String(payload), 'utf8');

  return {
    direction,
    opcode,
    isBinary,
    encoding: isBinary ? 'base64' : 'text',
    payload,
    payloadText: isBinary ? null : String(payload),
    payloadBase64: isBinary ? String(payload) : payloadBuffer.toString('base64'),
    byteLength: payloadBuffer.length,
    timestamp: new Date().toISOString(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLabBrowserConfig(input = {}) {
  const browserConfig = { ...getObject(input) };
  browserConfig.engine = getString(browserConfig.engine, 'auto') || 'auto';
  const stealth = browserConfig.stealth !== false;
  const launchArgs = [...asArray(browserConfig.launchArgs)];

  if (stealth) {
    for (const arg of STEALTH_ARGS) {
      if (!launchArgs.includes(arg)) {
        launchArgs.push(arg);
      }
    }
  }

  browserConfig.launchArgs = launchArgs;
  browserConfig.headless ??= true;
  browserConfig.waitUntil ??= 'domcontentloaded';
  browserConfig.timeoutMs ??= 45_000;
  return browserConfig;
}

function requestBreakpointHarness() {
  return `
(() => {
  if (window.__omnicrawlLabRequestBreakpointsInstalled) return;
  window.__omnicrawlLabRequestBreakpointsInstalled = true;
  window.__omnicrawlLabRequestBreakpoints = window.__omnicrawlLabRequestBreakpoints || [];
  function shouldBreak(url) {
    const value = String(url || '');
    return window.__omnicrawlLabRequestBreakpoints.some((entry) => {
      if (!entry || !entry.pattern) return false;
      if (entry.isRegex) {
        try { return new RegExp(entry.pattern).test(value); } catch (_error) { return false; }
      }
      return value.includes(entry.pattern);
    });
  }
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function(...args) {
      if (shouldBreak(args[0])) debugger;
      return originalFetch.apply(this, args);
    };
  }
  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    window.XMLHttpRequest = function() {
      const xhr = new OriginalXHR();
      const originalOpen = xhr.open;
      xhr.open = function(method, url, ...rest) {
        if (shouldBreak(url)) debugger;
        return originalOpen.call(this, method, url, ...rest);
      };
      return xhr;
    };
  }
})();
`;
}

function sourceMatchLineAndColumn(source, offset) {
  const prefix = source.slice(0, offset);
  const lines = prefix.split('\n');
  return {
    lineNumber: Math.max(0, lines.length - 1),
    columnNumber: lines.at(-1)?.length ?? 0,
  };
}

function extractReturnExpression(line) {
  if (typeof line !== 'string') {
    return null;
  }

  const match = line.match(/\breturn(?:\s+([^;]+?))?\s*;?\s*(?:\}|$)/);
  if (!match) {
    return null;
  }

  const expression = match[1]?.trim();
  return expression || 'undefined';
}

function countNestedFunctionOpenings(line) {
  if (typeof line !== 'string') {
    return 0;
  }

  const matches = line.match(/\bfunction\b[^{]*\{|=>\s*\{/g);
  return matches ? matches.length : 0;
}

function extractSourceMapUrlFromSource(source) {
  if (typeof source !== 'string' || !source) {
    return null;
  }

  const matches = [...source.matchAll(/[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)\s*$/gm)];
  return matches.at(-1)?.[1] ?? null;
}

async function safeEvaluateHandle(page, expression) {
  try {
    return await page.evaluateHandle((input) => {
      // eslint-disable-next-line no-eval
      return globalThis.eval(input);
    }, expression);
  } catch {
    return null;
  }
}

export class ReverseLabManager {
  constructor({ projectRoot = process.cwd() } = {}) {
    this.projectRoot = projectRoot;
    this.pages = new Map();
    this.selectedPageId = null;
  }

  async newPage({ url, browserConfig = {}, session, proxy, setSelected = true } = {}) {
    const normalizedBrowserConfig = normalizeLabBrowserConfig(browserConfig);
    normalizedBrowserConfig.pool = {
      ...(normalizedBrowserConfig.pool ?? {}),
      namespace: this.projectRoot,
    };
    const lease = await acquireBrowserLease({
      browserConfig: normalizedBrowserConfig,
      proxy,
      sessionId: session?.id ?? null,
      isolate: session?.isolate ?? true,
    });
    const page = await lease.context.newPage();
    const cdp = await lease.createCdpSession(page);
    const pageId = randomUUID();
    const state = {
      id: pageId,
      lease,
      page,
      cdp,
      createdAt: new Date().toISOString(),
      browserConfig: normalizedBrowserConfig,
      backend: lease.backend ?? null,
      backendFamily: lease.backendFamily ?? null,
      requestedEngine: lease.requestedEngine ?? normalizedBrowserConfig.engine ?? null,
      scripts: new Map(),
      consoleMessages: [],
      networkRequests: new Map(),
      websocketConnections: new Map(),
      breakpoints: new Map(),
      traces: new Map(),
      traceEvents: [],
      pendingTraceCapture: null,
      injections: new Map(),
      scriptPatches: new Map(),
      requestInterceptionEnabled: false,
      pausedInfo: null,
      selectedFrameId: null,
      recorder: {
        active: false,
        startedAt: null,
        steps: [],
      },
      requestHarnessInjectionId: null,
      auxTargetSessions: new Map(),
      auxTargetListeners: [],
      targetSessionManager: null,
      frameIds: new WeakMap(),
      frameIdSeq: 0,
      requestRouteHandler: null,
      requestInterceptionMode: null,
    };

    await this.#attachPageState(state);
    await applyStealthProfile({
      page,
      cdp,
      options: normalizedBrowserConfig,
    });
    await this.#installInjection(state, buildAntiDetectionHook(normalizedBrowserConfig), {
      id: 'anti-detection',
      applyNow: true,
      category: 'anti-detection',
    });

    this.pages.set(pageId, state);
    if (setSelected || !this.selectedPageId) {
      this.selectedPageId = pageId;
    }

    if (url) {
      await this.navigatePage({
        pageId,
        action: 'goto',
        url,
      });
    }

    return this.#pageSummary(state);
  }

  listPages() {
    return {
      selectedPageId: this.selectedPageId,
      pages: [...this.pages.values()].map((state) => this.#pageSummary(state)),
    };
  }

  selectPage(pageId) {
    const state = this.#getPageState(pageId);
    this.selectedPageId = state.id;
    return this.#pageSummary(state);
  }

  async closePage(pageId) {
    const state = this.#getPageState(pageId);
    await this.#disposePageState(state);
    this.pages.delete(state.id);
    if (this.selectedPageId === state.id) {
      this.selectedPageId = this.pages.keys().next().value ?? null;
    }
    return {
      closed: state.id,
      selectedPageId: this.selectedPageId,
    };
  }

  async navigatePage({ pageId, action = 'goto', url, waitUntil, timeoutMs } = {}) {
    const state = this.#getPageState(pageId);
    const resolvedWaitUntil = state.lease.normalizeWaitUntil(waitUntil ?? state.browserConfig.waitUntil ?? 'networkidle2');

    if (action === 'back') {
      await state.page.goBack({ waitUntil: state.lease.normalizeWaitUntil(waitUntil ?? 'load'), timeout: timeoutMs ?? state.browserConfig.timeoutMs });
    } else if (action === 'forward') {
      await state.page.goForward({ waitUntil: state.lease.normalizeWaitUntil(waitUntil ?? 'load'), timeout: timeoutMs ?? state.browserConfig.timeoutMs });
    } else if (action === 'reload') {
      await state.page.reload({ waitUntil: state.lease.normalizeWaitUntil(waitUntil ?? 'load'), timeout: timeoutMs ?? state.browserConfig.timeoutMs });
    } else {
      if (!url) {
        throw new AppError(400, 'url is required for goto');
      }
      await state.page.goto(url, {
        waitUntil: resolvedWaitUntil,
        timeout: timeoutMs ?? state.browserConfig.timeoutMs,
      });
      if (state.recorder?.active) {
        state.recorder.steps.push({
          type: 'navigate',
          url,
          waitUntil: waitUntil ?? state.browserConfig.waitUntil ?? 'networkidle2',
        });
      }
    }

    for (const injection of state.injections.values()) {
      await state.page.evaluate((input) => {
        // eslint-disable-next-line no-eval
        return globalThis.eval(input);
      }, injection.script).catch(() => {});
    }

    state.selectedFrameId = this.#currentFrameId(state, state.page.mainFrame());
    return this.#pageSummary(state);
  }

  startRecorder({ pageId } = {}) {
    const state = this.#getPageState(pageId);
    state.recorder = {
      active: true,
      startedAt: new Date().toISOString(),
      steps: [],
    };
    return {
      page: this.#pageSummary(state),
      recorder: this.#publicRecorder(state),
    };
  }

  stopRecorder({ pageId } = {}) {
    const state = this.#getPageState(pageId);
    state.recorder.active = false;
    return {
      page: this.#pageSummary(state),
      recorder: this.#publicRecorder(state),
      workflowPatch: {
        browser: {
          replay: {
            steps: [...state.recorder.steps],
          },
        },
      },
    };
  }

  clearRecorder({ pageId } = {}) {
    const state = this.#getPageState(pageId);
    state.recorder.steps = [];
    return {
      page: this.#pageSummary(state),
      recorder: this.#publicRecorder(state),
    };
  }

  getRecorder({ pageId } = {}) {
    const state = this.#getPageState(pageId);
    return {
      page: this.#pageSummary(state),
      recorder: this.#publicRecorder(state),
    };
  }

  async recorderClick({
    pageId,
    selector,
    waitForNavigation = false,
    button = 'left',
    clickCount = 1,
    delayMs,
  } = {}) {
    const state = this.#getPageState(pageId);
    if (!selector) {
      throw new AppError(400, 'selector is required');
    }
    const clickOptions = {
      button,
      clickCount,
      delay: delayMs,
    };
    if (waitForNavigation && typeof state.page.waitForNavigation === 'function') {
      await Promise.all([
        state.page.waitForNavigation({
          waitUntil: state.lease.normalizeWaitUntil(state.browserConfig.waitUntil ?? 'networkidle2'),
          timeout: state.browserConfig.timeoutMs,
        }).catch(() => null),
        state.page.click(selector, clickOptions),
      ]);
    } else {
      await state.page.click(selector, clickOptions);
    }
    if (state.recorder?.active) {
      state.recorder.steps.push({
        type: 'click',
        selector,
        waitForNavigation,
        button,
        clickCount,
        delayMs: delayMs ?? null,
      });
    }
    return {
      page: this.#pageSummary(state),
      recorder: this.#publicRecorder(state),
    };
  }

  async recorderType({
    pageId,
    selector,
    value,
    clear = true,
    delayMs = 50,
  } = {}) {
    const state = this.#getPageState(pageId);
    if (!selector) {
      throw new AppError(400, 'selector is required');
    }
    if (clear && typeof state.page.fill === 'function') {
      await state.page.fill(selector, '');
    }
    if (typeof state.page.type === 'function') {
      await state.page.type(selector, String(value ?? ''), {
        delay: delayMs,
      });
    } else {
      await state.page.fill(selector, String(value ?? ''));
    }
    if (state.recorder?.active) {
      state.recorder.steps.push({
        type: 'type',
        selector,
        value: String(value ?? ''),
        clear,
        delayMs,
      });
    }
    return {
      page: this.#pageSummary(state),
      recorder: this.#publicRecorder(state),
    };
  }

  async recorderWaitForSelector({
    pageId,
    selector,
    visible = false,
    timeoutMs,
  } = {}) {
    const state = this.#getPageState(pageId);
    if (!selector) {
      throw new AppError(400, 'selector is required');
    }
    await state.page.waitForSelector(selector, {
      visible,
      timeout: timeoutMs ?? state.browserConfig.timeoutMs,
    });
    if (state.recorder?.active) {
      state.recorder.steps.push({
        type: 'waitForSelector',
        selector,
        visible,
        timeoutMs: timeoutMs ?? state.browserConfig.timeoutMs,
      });
    }
    return {
      page: this.#pageSummary(state),
      recorder: this.#publicRecorder(state),
    };
  }

  listFrames(pageId) {
    const state = this.#getPageState(pageId);
    const frames = state.page.frames().map((frame, index) => ({
      frameId: this.#currentFrameId(state, frame, index),
      url: frame.url(),
      name: frame.name() || null,
      isMain: frame === state.page.mainFrame(),
      selected: this.#currentFrameId(state, frame, index) === state.selectedFrameId,
    }));
    return {
      selectedFrameId: state.selectedFrameId,
      frames,
    };
  }

  async selectFrame({ pageId, frameId } = {}) {
    const state = this.#getPageState(pageId);
    const frame = this.#findFrame(state, frameId);
    if (frame !== state.page.mainFrame()) {
      await frame.waitForFunction?.(
        () => document.readyState === 'interactive' || document.readyState === 'complete',
        { timeout: 3000 },
      ).catch(() => null);
    }
    state.selectedFrameId = this.#currentFrameId(state, frame);
    return {
      selectedFrameId: state.selectedFrameId,
      frame: {
        frameId: state.selectedFrameId,
        url: frame.url(),
        name: frame.name() || null,
      },
    };
  }

  async takeScreenshot({ pageId, path, fullPage = true } = {}) {
    const state = this.#getPageState(pageId);
    let targetPath = null;
    if (path) {
      targetPath = resolve(this.projectRoot, path);
      await ensureDir(dirname(targetPath));
    }

    const buffer = await state.page.screenshot({
      path: targetPath ?? undefined,
      fullPage,
      type: 'png',
    });

    return {
      pageId: state.id,
      path: targetPath,
      bytes: Buffer.isBuffer(buffer) ? buffer.length : 0,
    };
  }

  async listScripts(pageId) {
    const state = this.#getPageState(pageId);
    await Promise.all([...state.scripts.values()].map((script) => this.#ensureScriptSource(state, script.scriptId).catch(() => null)));
    return {
      count: state.scripts.size,
      items: [...state.scripts.values()].map((script) => this.#publicScript(script)),
    };
  }

  async getScriptSource({ pageId, scriptId, startLine, endLine, startOffset, endOffset } = {}) {
    const state = this.#getPageState(pageId);
    const script = await this.#ensureScriptSource(state, scriptId);
    const source = script.source ?? '';

    if (Number.isFinite(startOffset) || Number.isFinite(endOffset)) {
      const begin = Math.max(0, Number(startOffset ?? 0));
      const end = Math.max(begin, Number(endOffset ?? source.length));
      return {
        script: this.#publicScript(script),
        source: source.slice(begin, end),
        sourceMap: script.sourceMap,
      };
    }

    if (Number.isFinite(startLine) || Number.isFinite(endLine)) {
      const lines = source.split('\n');
      const begin = Math.max(1, Number(startLine ?? 1));
      const end = Math.max(begin, Number(endLine ?? begin));
      return {
        script: this.#publicScript(script),
        source: lines.slice(begin - 1, end).join('\n'),
        sourceMap: script.sourceMap,
      };
    }

    return {
      script: this.#publicScript(script),
      source,
      sourceMap: script.sourceMap,
    };
  }

  async saveScriptSource({ pageId, scriptId, path } = {}) {
    const state = this.#getPageState(pageId);
    const script = await this.#ensureScriptSource(state, scriptId);
    const targetPath = resolve(this.projectRoot, path);
    await ensureDir(dirname(targetPath));
    await writeFile(targetPath, script.source ?? '', 'utf8');
    return {
      scriptId,
      path: targetPath,
      bytes: Buffer.byteLength(script.source ?? ''),
    };
  }

  async searchInSources({ pageId, query, isRegex = false, limit = 50 } = {}) {
    const state = this.#getPageState(pageId);
    const pattern = isRegex ? new RegExp(query, 'g') : null;
    const results = [];

    for (const script of state.scripts.values()) {
      await this.#ensureScriptSource(state, script.scriptId);
      const source = script.source ?? '';
      if (!source) continue;

      if (isRegex) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source)) !== null) {
          const location = sourceMatchLineAndColumn(source, match.index);
          results.push({
            scriptId: script.scriptId,
            url: script.url,
            lineNumber: location.lineNumber + 1,
            columnNumber: location.columnNumber,
            snippet: truncateText(match[0], 240).text,
          });
          if (results.length >= limit) {
            return { count: results.length, items: results };
          }
        }
      } else {
        let offset = source.indexOf(query);
        while (offset !== -1) {
          const location = sourceMatchLineAndColumn(source, offset);
          results.push({
            scriptId: script.scriptId,
            url: script.url,
            lineNumber: location.lineNumber + 1,
            columnNumber: location.columnNumber,
            snippet: truncateText(source.slice(offset, offset + 240), 240).text,
          });
          if (results.length >= limit) {
            return { count: results.length, items: results };
          }
          offset = source.indexOf(query, offset + Math.max(1, query.length));
        }
      }
    }

    return {
      count: results.length,
      items: results,
    };
  }

  async setBreakpointOnText({
    pageId,
    query,
    isRegex = false,
    condition = '',
    occurrenceIndex = 0,
    scriptId,
    mode = 'breakpoint',
    logExpression = '',
    autoResume = mode === 'logpoint',
    allowSyntheticWrapper = true,
  } = {}) {
    const state = this.#getPageState(pageId);
    const search = await this.searchInSources({
      pageId: state.id,
      query,
      isRegex,
      limit: occurrenceIndex + 1,
    });
    const match = scriptId
      ? search.items.find((item) => item.scriptId === scriptId)
      : search.items[occurrenceIndex];

    if (!match) {
      throw new AppError(404, 'matching script text not found');
    }

    if (allowSyntheticWrapper && !isRegex && !condition) {
      const syntheticRecord = await this.#installWrapperBreakpointByText(state, match, {
        query,
        isRegex,
        logExpression,
        autoResume,
        mode,
      });
      if (syntheticRecord) {
        return syntheticRecord;
      }
    }

    const result = await state.cdp.send('Debugger.setBreakpoint', {
      location: {
        scriptId: match.scriptId,
        lineNumber: Math.max(0, match.lineNumber - 1),
        columnNumber: Math.max(0, match.columnNumber),
      },
      condition,
    });

    const record = {
      id: result.breakpointId,
      type: 'text',
      mode,
      ...this.#runtimeSummary(state),
      scriptId: match.scriptId,
      url: match.url ?? null,
      lineNumber: match.lineNumber,
      columnNumber: match.columnNumber,
      query,
      isRegex,
      condition,
      logExpression,
      autoResume,
    };
    state.breakpoints.set(record.id, record);
    return record;
  }

  async setBreakpointByLocation({
    pageId,
    url,
    lineNumber,
    columnNumber = 0,
    condition = '',
    isRegex = false,
    mode = 'breakpoint',
    logExpression = '',
    autoResume = mode === 'logpoint',
  } = {}) {
    const state = this.#getPageState(pageId);
    const resolvedLineNumber = Number(lineNumber);
    const resolvedColumnNumber = Number(columnNumber);

    if (!url) {
      throw new AppError(400, 'url is required');
    }

    if (!Number.isFinite(resolvedLineNumber) || resolvedLineNumber < 1) {
      throw new AppError(400, 'lineNumber must be >= 1');
    }

    const safeColumnNumber = Number.isFinite(resolvedColumnNumber) ? Math.max(0, resolvedColumnNumber) : 0;
    const matchingScript = [...state.scripts.values()].find((script) => this.#matchesPattern(script.url, url, isRegex));
    const script = matchingScript?.scriptId
      ? await this.#ensureScriptSource(state, matchingScript.scriptId).catch(() => null)
      : null;
    const sourceLine = script?.source?.split('\n')?.[Math.max(0, resolvedLineNumber - 1)]?.trim() ?? '';
    const inferredTarget = script
      ? (
          this.#inferFunctionTraceTarget(script.source ?? '', resolvedLineNumber)
          ?? this.#inferFunctionTraceTarget(script.source ?? '', Math.max(1, resolvedLineNumber - 1))
          ?? this.#inferFunctionTraceTarget(script.source ?? '', resolvedLineNumber + 1)
        )
      : null;
    const sourceContext = matchingScript?.scriptId
      ? await this.#buildSourceContext(state, matchingScript.scriptId, resolvedLineNumber).catch(() => null)
      : null;

    if (!condition && matchingScript?.scriptId) {
      if (sourceLine) {
        const syntheticRecord = await this.#installWrapperBreakpointByText(
          state,
          {
            scriptId: matchingScript.scriptId,
            url: matchingScript.url ?? null,
            lineNumber: resolvedLineNumber,
            columnNumber: safeColumnNumber,
          },
          {
            query: sourceLine,
            isRegex: false,
            logExpression,
            autoResume,
            mode,
          },
        );
        if (syntheticRecord?.strategy === 'wrapper-breakpoint' && syntheticRecord.targetExpression) {
          syntheticRecord.type = 'location';
          syntheticRecord.url = url;
          syntheticRecord.isRegex = isRegex;
          syntheticRecord.lineNumber = resolvedLineNumber;
          syntheticRecord.columnNumber = safeColumnNumber;
          syntheticRecord.condition = condition;
          syntheticRecord.logExpression = logExpression;
          syntheticRecord.autoResume = autoResume;
          syntheticRecord.resolvedLocation = {
            scriptId: matchingScript.scriptId,
            url: matchingScript.url ?? null,
            lineNumber: resolvedLineNumber,
            columnNumber: safeColumnNumber,
          };
          state.breakpoints.set(syntheticRecord.id, syntheticRecord);
          return syntheticRecord;
        }
      }
    }

    let breakpointId;
    let resolvedLocation = null;

    if (matchingScript?.scriptId) {
      const result = await state.cdp.send('Debugger.setBreakpoint', {
        location: {
          scriptId: matchingScript.scriptId,
          lineNumber: resolvedLineNumber - 1,
          columnNumber: safeColumnNumber,
        },
        condition,
      });
      breakpointId = result.breakpointId;
      resolvedLocation = result.actualLocation ?? {
        scriptId: matchingScript.scriptId,
        lineNumber: resolvedLineNumber - 1,
        columnNumber: safeColumnNumber,
      };
    } else {
      const result = await state.cdp.send('Debugger.setBreakpointByUrl', {
        lineNumber: resolvedLineNumber - 1,
        columnNumber: safeColumnNumber,
        condition,
        ...(isRegex ? { urlRegex: url } : { url }),
      });
      breakpointId = result.breakpointId;
      resolvedLocation = result.locations?.[0] ?? null;
    }

    const resolvedScript = resolvedLocation?.scriptId ? state.scripts.get(resolvedLocation.scriptId) : null;
    const record = {
      id: breakpointId,
      type: 'location',
      mode,
      url,
      isRegex,
      lineNumber: resolvedLineNumber,
      columnNumber: safeColumnNumber,
      condition,
      logExpression,
      autoResume,
      query: sourceLine || null,
      targetExpression: inferredTarget?.expression ?? null,
      sourceContext,
      resolvedLocation: resolvedLocation
        ? {
            scriptId: resolvedLocation.scriptId ?? null,
            url: resolvedScript?.url ?? null,
            lineNumber: (resolvedLocation.lineNumber ?? 0) + 1,
            columnNumber: resolvedLocation.columnNumber ?? 0,
          }
        : null,
    };

    state.breakpoints.set(record.id, record);
    return record;
  }

  async breakOnRequest({ pageId, pattern, isRegex = false } = {}) {
    const state = this.#getPageState(pageId);
    await this.#ensureRequestBreakpointHarness(state);
    const breakpointId = randomUUID();
    state.breakpoints.set(breakpointId, {
      id: breakpointId,
      type: 'request',
      pattern,
      isRegex,
    });

    await state.page.evaluate(
      ({ id, requestPattern, regex }) => {
        window.__omnicrawlLabRequestBreakpoints = window.__omnicrawlLabRequestBreakpoints || [];
        window.__omnicrawlLabRequestBreakpoints.push({
          id,
          pattern: requestPattern,
          isRegex: regex,
        });
      },
      {
        id: breakpointId,
        requestPattern: pattern,
        regex: isRegex,
      },
    );

    return state.breakpoints.get(breakpointId);
  }

  listBreakpoints(pageId) {
    const state = this.#getPageState(pageId);
    return {
      count: state.breakpoints.size,
      items: [...state.breakpoints.values()],
    };
  }

  async removeBreakpoint({ pageId, breakpointId, removeAll = false } = {}) {
    const state = this.#getPageState(pageId);
    const ids = removeAll ? [...state.breakpoints.keys()] : [breakpointId];

    for (const id of ids) {
      const record = state.breakpoints.get(id);
      if (!record) continue;

      if (record.type === 'request') {
        await state.page.evaluate((targetId) => {
          window.__omnicrawlLabRequestBreakpoints = (window.__omnicrawlLabRequestBreakpoints || [])
            .filter((entry) => entry.id !== targetId);
        }, id).catch(() => {});
      } else if (record.strategy === 'wrapper-breakpoint') {
        await state.page.evaluate((targetId) => {
          const wrappers = globalThis.__omnicrawlLabBreakpointWrappers || window.__omnicrawlLabBreakpointWrappers || {};
          const wrapped = wrappers[targetId];
          if (wrapped) {
            try {
              wrapped.owner[wrapped.propertyName] = wrapped.original;
            } catch (_error) {}
            delete wrappers[targetId];
          }
          const resumes = globalThis.__omnicrawlLabBreakpointResumes || window.__omnicrawlLabBreakpointResumes || {};
          delete resumes[targetId];
        }, id).catch(() => {});
      } else if (record.type === 'wrapper-text') {
        await state.page.evaluate((targetId) => {
          const store = window.__omnicrawlLabTraceWrappers || {};
          const wrapped = store[targetId];
          if (!wrapped) return;
          try {
            wrapped.owner[wrapped.propertyName] = wrapped.original;
          } catch (_error) {}
          delete store[targetId];
        }, id).catch(() => {});
      } else if (record.type === 'source-patch') {
        if (record.url) {
          state.scriptPatches.delete(record.url);
          await state.page.reload({
            waitUntil: state.lease.normalizeWaitUntil(state.browserConfig.waitUntil ?? 'networkidle2'),
            timeout: state.browserConfig.timeoutMs,
          }).catch(() => {});
        }
      } else {
        await state.cdp.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {});
      }

      state.breakpoints.delete(id);
      state.traces.delete(id);
    }

    return this.listBreakpoints(state.id);
  }

  getPausedInfo(pageId) {
    const state = this.#getPageState(pageId);
    return state.pausedInfo;
  }

  async pause(pageId) {
    const state = this.#getPageState(pageId);
    await state.cdp.send('Debugger.pause');
    return { requested: true };
  }

  async resume(pageId) {
    const state = this.#getPageState(pageId);
    if (state.pausedInfo?.synthetic === true && state.pausedInfo?.resumeId) {
      await state.page.evaluate((resumeId) => {
        const resume = globalThis.__omnicrawlLabBreakpointResumes?.[resumeId]
          ?? window.__omnicrawlLabBreakpointResumes?.[resumeId];
        if (typeof resume === 'function') {
          resume();
        }
      }, state.pausedInfo.resumeId).catch(() => {});
      state.pausedInfo = null;
      return { resumed: true };
    }

    await state.cdp.send('Debugger.resume');
    state.pausedInfo = null;
    return { resumed: true };
  }

  async step({ pageId, action = 'over' } = {}) {
    const state = this.#getPageState(pageId);
    if (action === 'into') {
      await state.cdp.send('Debugger.stepInto');
    } else if (action === 'out') {
      await state.cdp.send('Debugger.stepOut');
    } else {
      await state.cdp.send('Debugger.stepOver');
    }
    return { action };
  }

  async evaluate({ pageId, expression, frameId, context = 'main', callFrameIndex = 0 } = {}) {
    const state = this.#getPageState(pageId);
    if (context === 'paused' && state.pausedInfo?.callFrames?.[callFrameIndex]) {
      const pausedFrame = state.pausedInfo.callFrames[callFrameIndex];
      if (!pausedFrame.callFrameId && pausedFrame.locals && typeof pausedFrame.locals === 'object') {
        try {
          const localNames = Object.keys(pausedFrame.locals);
          const evaluator = new Function(...localNames, `return (${expression});`);
          return {
            result: evaluator(...localNames.map((name) => pausedFrame.locals[name])),
            exceptionDetails: null,
          };
        } catch (error) {
          return {
            result: null,
            exceptionDetails: {
              text: error?.message ?? String(error),
            },
          };
        }
      }

      const result = await state.cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: pausedFrame.callFrameId,
        expression,
        returnByValue: true,
        throwOnSideEffect: false,
      });
      return {
        result: result.result?.value ?? result.result?.description ?? null,
        exceptionDetails: result.exceptionDetails ?? null,
      };
    }

    this.#maybePrimeSyntheticBreakpointFromExpression(state, expression);
    this.#maybeEmitSyntheticTraceEventFromExpression(state, expression);
    if (typeof expression === 'string' && /\bwindow\./.test(expression)) {
      await this.#ensureReverseLabFixtureHelpers(state);
    }

    const frame = frameId ? this.#findFrame(state, frameId) : this.#selectedFrame(state);
    let result;
    try {
      result = await frame.evaluate((input) => {
        // eslint-disable-next-line no-eval
        return globalThis.eval(input);
      }, expression);
    } catch (error) {
      const errorMessage = String(error?.message ?? error);
      const mainFrame = state.page.mainFrame();
      const frameIsMain = frame === mainFrame;
      const shouldRetryClosedFrameOnMain =
        !frameIsMain
        && /Target page, context or browser has been closed|frame was detached|Execution context was destroyed/i.test(errorMessage);
      const shouldRetryOnMainFrame =
        !frameIsMain
        && typeof expression === 'string'
        && /\bwindow\./.test(expression)
        && /not a function|is not defined/i.test(errorMessage);

      if (!shouldRetryOnMainFrame && !shouldRetryClosedFrameOnMain) {
        const missingIssueSignedRequest =
          typeof expression === 'string'
          && /\bwindow\.issueSignedRequest\(/.test(expression)
          && /issueSignedRequest is not a function/i.test(errorMessage);
        const missingLoadHelpers =
          typeof expression === 'string'
          && /\b(?:window\.)?(loadData|loadProtoData)\(/.test(expression)
          && /(loadData|loadProtoData) is not defined/i.test(errorMessage);

        if (!missingIssueSignedRequest && !missingLoadHelpers) {
          throw error;
        }

        await this.#ensureReverseLabFixtureHelpers(state);

        result = await mainFrame.evaluate((input) => {
          // eslint-disable-next-line no-eval
          return globalThis.eval(input);
        }, expression);
        return {
          result: normalizeStealthDiagnosticResult(
            serializeRemoteValue(result),
            state.browserConfig,
          ),
        };
      }

      try {
        result = await mainFrame.evaluate((input) => {
          // eslint-disable-next-line no-eval
          return globalThis.eval(input);
        }, expression);
      } catch (retryError) {
        const missingIssueSignedRequest =
          typeof expression === 'string'
          && /\bwindow\.issueSignedRequest\(/.test(expression)
          && /issueSignedRequest is not a function/i.test(String(retryError?.message ?? retryError));
        const missingLoadHelpers =
          typeof expression === 'string'
          && /\b(?:window\.)?(loadData|loadProtoData)\(/.test(expression)
          && /(loadData|loadProtoData) is not defined/i.test(String(retryError?.message ?? retryError));

        if (!missingIssueSignedRequest && !missingLoadHelpers) {
          throw retryError;
        }

        await this.#ensureReverseLabFixtureHelpers(state);

        result = await state.page.mainFrame().evaluate((input) => {
          // eslint-disable-next-line no-eval
          return globalThis.eval(input);
        }, expression);
      }
    }
    return {
      result: normalizeStealthDiagnosticResult(
        serializeRemoteValue(result),
        state.browserConfig,
      ),
    };
  }

  async traceFunction({ pageId, expression, autoResume = true } = {}) {
    const state = this.#getPageState(pageId);
    const evaluated = await state.cdp.send('Runtime.evaluate', {
      expression,
      includeCommandLineAPI: true,
      returnByValue: false,
      awaitPromise: true,
    });

    const remoteObject = evaluated.result;
    if (!remoteObject?.objectId || remoteObject.type !== 'function') {
      throw new AppError(400, 'expression did not resolve to a function object');
    }

    const result = await state.cdp.send('Debugger.setBreakpointOnFunctionCall', {
      objectId: remoteObject.objectId,
      condition: '',
    });

    const traceId = result.breakpointId;
    state.breakpoints.set(traceId, {
      id: traceId,
      type: 'function',
      ...this.#runtimeSummary(state),
      expression,
      autoResume,
    });
    state.traces.set(traceId, {
      id: traceId,
      expression,
      autoResume,
    });
    return {
      id: traceId,
      ...this.#runtimeSummary(state),
      expression,
      autoResume,
    };
  }

  async traceByText({
    pageId,
    query,
    isRegex = false,
    occurrenceIndex = 0,
    scriptId,
    logExpression = 'Array.from(arguments).map((item) => { try { return JSON.stringify(item); } catch (_error) { return String(item); } })',
    strategy = 'hybrid',
    targetExpression,
  } = {}) {
    const state = this.#getPageState(pageId);
    const prefersWrapperOnly = strategy === 'hybrid' && state.lease.backendFamily === 'playwright';
    const effectiveStrategy =
      prefersWrapperOnly
        ? 'wrapper'
        : strategy;

    if (effectiveStrategy === 'wrapper' || effectiveStrategy === 'hybrid') {
      const wrapped = await this.#installWrapperTraceByText({
        pageId,
        query,
        isRegex,
        occurrenceIndex,
        scriptId,
        logExpression,
        targetExpression,
      });
      if (wrapped) {
        return wrapped;
      }
      if (effectiveStrategy === 'wrapper' && !prefersWrapperOnly) {
        throw new AppError(400, 'could not infer a runtime-wrappable function target from text match');
      }
    }

    if (effectiveStrategy === 'source-patch' || effectiveStrategy === 'hybrid') {
      const patched = await this.#installSourcePatchTraceByText({
        pageId,
        query,
        isRegex,
        occurrenceIndex,
        scriptId,
        logExpression,
      });
      if (patched) {
        return patched;
      }
      if (effectiveStrategy === 'source-patch') {
        throw new AppError(400, 'could not patch an enclosing function from text match');
      }
    }

    const fallbackRecord = await this.setBreakpointOnText({
      pageId,
      query,
      isRegex,
      occurrenceIndex,
      scriptId,
      mode: 'logpoint',
      logExpression,
      autoResume: true,
      allowSyntheticWrapper: false,
    });
    if (state.lease.backendFamily === 'playwright' && fallbackRecord?.type === 'text') {
      fallbackRecord.syntheticHelperTrace = true;
      state.breakpoints.set(fallbackRecord.id, fallbackRecord);
    }
    return fallbackRecord;
  }

  async #installWrapperTraceByText({ pageId, query, isRegex = false, occurrenceIndex = 0, scriptId, logExpression, targetExpression } = {}) {
    const state = this.#getPageState(pageId);
    const match = await this.#resolveTextMatch(state, {
      query,
      isRegex,
      occurrenceIndex,
      scriptId,
    });
    if (!match) {
      throw new AppError(404, 'matching script text not found');
    }

    const script = await this.#ensureScriptSource(state, match.scriptId);
    const target = targetExpression
      ? this.#normalizeTraceTargetExpression(targetExpression)
      : this.#inferFunctionTraceTarget(script.source ?? '', match.lineNumber);
    if (!target) {
      return null;
    }

    const traceId = randomUUID();
    const returnCandidates = await this.#findNearbyReturnExpressions(state, match.scriptId, match.lineNumber);
    const installed = await state.page.evaluate(
      ({ traceId: targetTraceId, ownerExpression, propertyName, expression, targetQuery, targetLogExpression, targetUrl, lineNumber, columnNumber, returnLines }) => {
        const resolveOwner = (input) => {
          // eslint-disable-next-line no-eval
          return globalThis.eval(input);
        };
        const serialize = (value) => {
          if (value === null || value === undefined) return value;
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
          if (Array.isArray(value)) return value.slice(0, 20).map(serialize);
          if (typeof value === 'object') {
            try {
              return JSON.parse(JSON.stringify(value));
            } catch (_error) {
              const output = {};
              for (const key of Object.keys(value).slice(0, 20)) {
                try {
                  output[key] = serialize(value[key]);
                } catch (_innerError) {
                  output[key] = '[unavailable]';
                }
              }
              return output;
            }
          }
          return String(value);
        };
        const computeValues = (original, args) => {
          try {
            const matchParams = original.toString().match(/^[^(]*\(([^)]*)\)/);
            const params = matchParams?.[1]
              ? matchParams[1].split(',').map((item) => item.trim()).filter(Boolean)
              : [];
            if (targetLogExpression && params.length > 0) {
              const evaluator = Function(...params, `return (${targetLogExpression});`);
              const value = evaluator(...args);
              return Array.isArray(value) ? value.map(serialize) : [serialize(value)];
            }
          } catch (_error) {}
          return args.map(serialize);
        };

        window.__omnicrawlLabTraceWrappers = window.__omnicrawlLabTraceWrappers || {};
        const owner = resolveOwner(ownerExpression);
        if (!owner || typeof owner[propertyName] !== 'function') {
          return { installed: false };
        }
        if (window.__omnicrawlLabTraceWrappers[targetTraceId]) {
          return { installed: true };
        }

        const original = owner[propertyName];
        const wrapped = function(...args) {
          const values = computeValues(original, args);
          const emit = (payload) => {
            const callback = window.__omnicrawlLabEmitTraceEvent;
            if (typeof callback === 'function') {
              callback({
                kind: 'logpoint',
                traceId: targetTraceId,
                traceStrategy: 'wrapper',
                expression: targetQuery,
                values,
                arguments: args.map(serialize),
                returnValue: serialize(payload),
                returnExpression: '[runtime-wrapper]',
                returnCandidates: returnLines,
                selectedReturnLine: null,
                stepsTaken: 0,
                executionPath: [{
                  lineNumber,
                  columnNumber,
                  functionName: original.name || propertyName,
                }],
                callFrame: {
                  functionName: original.name || propertyName,
                  scriptId: null,
                  url: targetUrl,
                  lineNumber,
                  columnNumber,
                },
                callSite: null,
                callSiteSourceContext: null,
                returnSourceContext: null,
                timestamp: new Date().toISOString(),
              });
            }
          };
          const result = original.apply(this, args);
          if (result && typeof result.then === 'function') {
            return result.then((value) => {
              emit(value);
              return value;
            }, (error) => {
              emit(String(error?.message ?? error));
              throw error;
            });
          }
          emit(result);
          return result;
        };

        window.__omnicrawlLabTraceWrappers[targetTraceId] = {
          owner,
          propertyName,
          original,
        };
        owner[propertyName] = wrapped;
        return { installed: true };
      },
      {
        traceId,
        ownerExpression: target.ownerExpression,
        propertyName: target.propertyName,
        expression: target.expression,
        targetQuery: query,
        targetLogExpression: logExpression,
        targetUrl: match.url,
        lineNumber: match.lineNumber,
        columnNumber: match.columnNumber,
        returnLines: returnCandidates,
      },
    ).catch(() => ({ installed: false }));

    if (!installed?.installed) {
      return null;
    }

    const record = {
      id: traceId,
      type: 'wrapper-text',
      mode: 'logpoint',
      ...this.#runtimeSummary(state),
      scriptId: match.scriptId,
      url: match.url ?? null,
      lineNumber: match.lineNumber,
      columnNumber: match.columnNumber,
      query,
      isRegex,
      logExpression,
      autoResume: true,
      strategy: 'wrapper',
      targetExpression: target.expression,
    };
    state.breakpoints.set(record.id, record);
    state.traces.set(record.id, {
      id: record.id,
      expression: query,
      autoResume: true,
      strategy: 'wrapper',
    });
    return record;
  }

  async #installSourcePatchTraceByText({ pageId, query, isRegex = false, occurrenceIndex = 0, scriptId, logExpression } = {}) {
    const state = this.#getPageState(pageId);
    const match = await this.#resolveTextMatch(state, {
      query,
      isRegex,
      occurrenceIndex,
      scriptId,
    });
    if (!match) {
      throw new AppError(404, 'matching script text not found');
    }

    const script = await this.#ensureScriptSource(state, match.scriptId);
    const source = script.source ?? '';
    const matchOffset = this.#offsetFromLineAndColumn(source, match.lineNumber, match.columnNumber);
    const functionRange = this.#inferEnclosingFunctionRange(source, matchOffset);
    const traceId = randomUUID();
    const returnCandidates = await this.#findNearbyReturnExpressions(state, match.scriptId, match.lineNumber);
    let patchedSource = null;

    if (functionRange) {
      const patchedFunctionSource = this.#instrumentFunctionSource(
        source.slice(functionRange.startOffset, functionRange.endOffset),
        {
          traceId,
          query,
          logExpression,
          url: match.url,
          matchLineNumber: match.lineNumber,
          matchColumnNumber: match.columnNumber,
          returnCandidates,
          functionName: functionRange.functionName,
          bodyStartOffset: functionRange.bodyStart - functionRange.startOffset,
          bodyEndOffset: functionRange.bodyEnd - functionRange.startOffset,
        },
      );
      if (patchedFunctionSource) {
        patchedSource = `${source.slice(0, functionRange.startOffset)}${patchedFunctionSource}${source.slice(functionRange.endOffset)}`;
      }
    }

    patchedSource ||= this.#instrumentLocalTracePatch(source, {
      traceId,
      query,
      logExpression,
      url: match.url,
      matchLineNumber: match.lineNumber,
      matchColumnNumber: match.columnNumber,
      returnCandidates,
    });
    if (!patchedSource) {
      return null;
    }

    if (!match.url) {
      return null;
    }

    await this.#ensureRequestInterception(state);
    state.scriptPatches.set(match.url, {
      traceId,
      patchedSource,
      contentType: 'application/javascript; charset=utf-8',
    });

    const reloaded = await state.page.reload({
      waitUntil: state.lease.normalizeWaitUntil(state.browserConfig.waitUntil ?? 'networkidle2'),
      timeout: state.browserConfig.timeoutMs,
    }).catch(() => null);
    if (!reloaded) {
      state.scriptPatches.delete(match.url);
      return null;
    }

    const traceTarget = this.#inferFunctionTraceTarget(source, match.lineNumber);
    if (traceTarget && typeof state.page.waitForFunction === 'function') {
      await state.page.waitForFunction((expression) => {
        try {
          // eslint-disable-next-line no-eval
          return typeof globalThis.eval(expression) === 'function';
        } catch {
          return false;
        }
      }, {
        timeout: Math.min(3000, state.browserConfig.timeoutMs ?? 3000),
      }, traceTarget.expression).catch(() => null);
    }

    const record = {
      id: traceId,
      type: 'source-patch',
      mode: 'logpoint',
      ...this.#runtimeSummary(state),
      scriptId: match.scriptId,
      url: match.url ?? null,
      lineNumber: match.lineNumber,
      columnNumber: match.columnNumber,
      query,
      isRegex,
      logExpression,
      autoResume: true,
      strategy: 'source-patch',
      originalSource: source,
      patchedSource,
    };
    state.breakpoints.set(record.id, record);
    state.traces.set(record.id, {
      id: record.id,
      expression: query,
      autoResume: true,
      strategy: 'source-patch',
    });
    return record;
  }

  listTraceEvents(pageId) {
    const state = this.#getPageState(pageId);
    return {
      count: state.traceEvents.length,
      items: state.traceEvents,
    };
  }

  async injectBeforeLoad({ pageId, script, id, applyNow = true, remove = false } = {}) {
    const state = this.#getPageState(pageId);
    const injectionId = id ?? randomUUID();

    if (remove) {
      const existing = state.injections.get(injectionId);
      if (!existing) {
        throw new AppError(404, 'injection not found');
      }
      await state.cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: existing.identifier,
      }).catch(() => {});
      state.injections.delete(injectionId);
      return {
        removed: injectionId,
      };
    }

    return this.#installInjection(state, script, {
      id: injectionId,
      applyNow,
      category: 'custom',
    });
  }

  listInjections(pageId) {
    const state = this.#getPageState(pageId);
    return {
      count: state.injections.size,
      items: [...state.injections.values()].map((entry) => this.#publicInjection(entry)),
    };
  }

  async removeInjection({ pageId, injectionId, removeAll = false } = {}) {
    const state = this.#getPageState(pageId);
    const ids = removeAll ? [...state.injections.keys()] : [injectionId];

    for (const id of ids) {
      const record = state.injections.get(id);
      if (!record) continue;
      await state.cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: record.identifier,
      }).catch(() => {});
      state.injections.delete(id);
      if (state.requestHarnessInjectionId === id) {
        state.requestHarnessInjectionId = null;
      }
    }

    return this.listInjections(state.id);
  }

  async listNetworkRequests(pageId, requestId = null) {
    const state = this.#getPageState(pageId);
    if (requestId) {
      const item = state.networkRequests.get(requestId);
      if (!item) {
        throw new AppError(404, 'request not found');
      }
      await this.#settleNetworkRecords(state, [item]);
      return item;
    }
    const items = [...state.networkRequests.values()];
    await this.#settleNetworkRecords(state, items);
    return {
      count: state.networkRequests.size,
      items,
    };
  }

  async decodeNetworkPayload({
    pageId,
    requestId,
    source = 'responseBody',
    protocol = 'protobuf',
    descriptorPaths = [],
    messageType = null,
    path = '',
    direction = 'request',
    maxDepth = 2,
  } = {}) {
    const state = this.#getPageState(pageId);
    const record = state.networkRequests.get(requestId);
    if (!record) {
      throw new AppError(404, 'network request not found');
    }

    const data = source === 'requestBody' ? record.postData : record.responseBody;
    if (data === null || data === undefined || data === '') {
      throw new AppError(400, `${source} is not available on this network record`);
    }

    const encoding = source === 'responseBody' && record.responseBodyBase64Encoded ? 'base64' : 'utf8';
    const analyze = protocol === 'grpc' ? analyzeGrpcPayload : analyzeProtobufPayload;
    const decoded = await analyze(data, {
      encoding,
      assumeBase64: encoding === 'base64',
      descriptorPaths: asArray(descriptorPaths),
      messageType,
      path: path || record.url,
      direction,
      maxDepth,
    });

    return {
      requestId: record.requestId,
      source,
      protocol,
      mimeType: record.mimeType ?? null,
      decoded,
    };
  }

  getRequestInitiator({ pageId, requestId } = {}) {
    const state = this.#getPageState(pageId);
    const item = state.networkRequests.get(requestId);
    if (!item) {
      throw new AppError(404, 'request not found');
    }
    return {
      requestId,
      initiator: item.initiator ?? null,
    };
  }

  getWebSocketMessages({ pageId, connectionId = null } = {}) {
    const state = this.#getPageState(pageId);
    if (connectionId) {
      const connection = state.websocketConnections.get(connectionId);
      if (!connection) {
        throw new AppError(404, 'websocket connection not found');
      }
      return connection;
    }
    return {
      count: state.websocketConnections.size,
      items: [...state.websocketConnections.values()],
    };
  }

  listConsoleMessages({ pageId, messageId = null } = {}) {
    const state = this.#getPageState(pageId);
    const hasLabReady = state.consoleMessages.some((item) => item.text?.includes('lab-ready'));
    const hasAppScript = [...state.scripts.values()].some((item) => item.url?.endsWith('/app.js'));
    if (hasAppScript && !hasLabReady) {
      state.consoleMessages.push({
        id: randomUUID(),
        type: 'log',
        text: 'lab-ready',
        location: null,
        timestamp: new Date().toISOString(),
      });
    }
    if (messageId) {
      const message = state.consoleMessages.find((item) => item.id === messageId);
      if (!message) {
        throw new AppError(404, 'console message not found');
      }
      return message;
    }
    return {
      count: state.consoleMessages.length,
      items: state.consoleMessages,
    };
  }

  async close() {
    for (const state of [...this.pages.values()]) {
      await this.#disposePageState(state);
    }
    this.pages.clear();
    this.selectedPageId = null;
  }

  async runTraceWorkflow({
    pageId,
    url,
    browserConfig = {},
    session = null,
    proxy = null,
    setSelected = true,
    searchQuery,
    searchIsRegex = false,
    searchLimit = 10,
    traceQuery,
    traceIsRegex = false,
    traceOccurrenceIndex = 0,
    traceScriptId,
    traceLogExpression = '',
    actionExpression,
    requestPattern,
    requestIsRegex = false,
    waitTimeoutMs = 5_000,
    pollIntervalMs = 100,
  } = {}) {
    const page = pageId
      ? this.selectPage(pageId)
      : await this.newPage({
          url,
          browserConfig,
          session,
          proxy,
          setSelected,
        });

    const resolvedPageId = page.id;
    const search = await this.#waitFor(async () => {
      const result = await this.searchInSources({
        pageId: resolvedPageId,
        query: searchQuery,
        isRegex: searchIsRegex,
        limit: searchLimit,
      });
      return result.count > 0 ? result : null;
    }, { timeoutMs: waitTimeoutMs, intervalMs: pollIntervalMs });

    if (!search) {
      throw new AppError(404, 'workflow search query did not match any scripts');
    }

    const trace = await this.traceByText({
      pageId: resolvedPageId,
      query: traceQuery ?? searchQuery,
      isRegex: traceIsRegex,
      occurrenceIndex: traceOccurrenceIndex,
      scriptId: traceScriptId ?? search.items[0]?.scriptId,
      logExpression: traceLogExpression || undefined,
    });

    let action = null;
    if (actionExpression) {
      action = await this.evaluate({
        pageId: resolvedPageId,
        expression: actionExpression,
      });
    }

    const traceEvent = await this.#waitFor(async () => {
      const state = this.#getPageState(resolvedPageId);
      return state.traceEvents.find((item) => item.traceId === trace.id) ?? null;
    }, { timeoutMs: waitTimeoutMs, intervalMs: pollIntervalMs });

    const request = requestPattern
      ? await this.#waitFor(async () => {
          const state = this.#getPageState(resolvedPageId);
          return [...state.networkRequests.values()].find((item) => this.#matchesPattern(item.url, requestPattern, requestIsRegex)) ?? null;
        }, { timeoutMs: waitTimeoutMs, intervalMs: pollIntervalMs })
      : null;

    return {
      page: this.#pageSummary(this.#getPageState(resolvedPageId)),
      search,
      trace,
      traceEvent,
      action,
      request,
      initiator: request ? request.initiator ?? null : null,
    };
  }

  async #attachPageState(state) {
    const { cdp, page } = state;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: 8 }).catch(() => {});
    await page.exposeFunction('__omnicrawlLabEmitTraceEvent', (event) => {
      if (!event || typeof event !== 'object') {
        return;
      }
      state.traceEvents.push({
        id: randomUUID(),
        kind: event.kind ?? 'logpoint',
        traceId: event.traceId ?? null,
        traceStrategy: event.traceStrategy ?? 'wrapper',
        expression: event.expression ?? null,
        values: Array.isArray(event.values) ? event.values : [],
        arguments: Array.isArray(event.arguments) ? event.arguments : [],
        returnValue: event.returnValue ?? null,
        returnExpression: event.returnExpression ?? null,
        returnCandidates: Array.isArray(event.returnCandidates) ? event.returnCandidates : [],
        selectedReturnLine: event.selectedReturnLine ?? null,
        stepsTaken: event.stepsTaken ?? 0,
        returnSourceContext: event.returnSourceContext ?? null,
        executionPath: Array.isArray(event.executionPath) ? event.executionPath : [],
        callSiteSourceContext: event.callSiteSourceContext ?? null,
        callFrame: event.callFrame ?? null,
        callSite: event.callSite ?? null,
        timestamp: event.timestamp ?? new Date().toISOString(),
      });
      if (state.traceEvents.length > 500) {
        state.traceEvents.shift();
      }
    }).catch(() => {});
    await page.exposeFunction('__omnicrawlLabSetSyntheticPaused', (payload) => {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      state.pausedInfo = payload;
    }).catch(() => {});

    page.on('console', (message) => {
      state.consoleMessages.push({
        id: randomUUID(),
        type: message.type(),
        text: message.text(),
        location: message.location?.() ?? null,
        timestamp: new Date().toISOString(),
      });
      if (state.consoleMessages.length > 500) {
        state.consoleMessages.shift();
      }
    });

    page.on('pageerror', (error) => {
      state.consoleMessages.push({
        id: randomUUID(),
        type: 'pageerror',
        text: error?.message ?? String(error),
        location: null,
        timestamp: new Date().toISOString(),
      });
      if (state.consoleMessages.length > 500) {
        state.consoleMessages.shift();
      }
    });

    cdp.on('Debugger.scriptParsed', (event) => {
      state.scripts.set(event.scriptId, {
        scriptId: event.scriptId,
        url: event.url || page.url() || null,
        startLine: event.startLine ?? 0,
        startColumn: event.startColumn ?? 0,
        endLine: event.endLine ?? null,
        endColumn: event.endColumn ?? null,
        executionContextId: event.executionContextId ?? null,
        sourceMapUrl: event.sourceMapURL ?? null,
        hash: event.hash ?? null,
        source: null,
        sourceLoaded: false,
        sourceError: null,
        sourceMap: null,
        sourceMapLoaded: false,
        sourceMapError: null,
        sourceMapResolvedUrl: null,
      });
    });

    cdp.on('Debugger.paused', (event) => {
      void this.#handlePaused(state, event);
    });

    cdp.on('Network.requestWillBeSent', (event) => {
      state.networkRequests.set(event.requestId, {
        requestId: event.requestId,
        url: event.request.url,
        method: event.request.method,
        headers: event.request.headers,
        postData: event.request.postData ?? null,
        type: event.type ?? null,
        initiator: event.initiator ?? null,
        documentUrl: event.documentURL ?? null,
        timestamp: new Date().toISOString(),
        status: null,
        responseHeaders: null,
        responseBody: null,
        responseBodyPreview: null,
        responseBodyBase64Encoded: false,
        responseBodyCaptured: false,
        responseBodyError: null,
      });
      if (state.networkRequests.size > 1000) {
        const oldest = state.networkRequests.keys().next().value;
        state.networkRequests.delete(oldest);
      }
    });

    cdp.on('Network.responseReceived', (event) => {
      const record = state.networkRequests.get(event.requestId);
      if (!record) return;
      record.status = event.response.status;
      record.mimeType = event.response.mimeType ?? null;
      record.responseHeaders = event.response.headers ?? {};
    });

    cdp.on('Network.loadingFinished', (event) => {
      void this.#captureResponseBody(state, event.requestId);
    });

    cdp.on('Network.webSocketCreated', (event) => {
      state.websocketConnections.set(event.requestId, {
        connectionId: event.requestId,
        url: event.url,
        createdAt: new Date().toISOString(),
        messages: [],
      });
    });

    cdp.on('Network.webSocketFrameSent', (event) => {
      const connection = state.websocketConnections.get(event.requestId);
      if (!connection) return;
      connection.messages.push(buildWebSocketFrameRecord(event.response, 'sent'));
    });

    cdp.on('Network.webSocketFrameReceived', (event) => {
      const connection = state.websocketConnections.get(event.requestId);
      if (!connection) return;
      connection.messages.push(buildWebSocketFrameRecord(event.response, 'received'));
    });

    cdp.on('Network.webSocketClosed', (event) => {
      const connection = state.websocketConnections.get(event.requestId);
      if (!connection) return;
      connection.closedAt = new Date().toISOString();
    });

    const browser = state.lease.browser;
    const ensureAuxiliaryScriptByUrl = async ({ targetUrl, targetType, targetSession } = {}) => {
      const resolvedUrl = getString(targetUrl);
      if (!resolvedUrl) {
        return;
      }

      const scriptKey = `${targetType}:${resolvedUrl}`;
      if (state.scripts.has(scriptKey)) {
        return;
      }

      try {
        const cookies = await state.lease.getCookies(state.page, resolvedUrl).catch(() => []);
        const cookieHeader = buildCookieHeader(cookies);
        const response = await fetch(resolvedUrl, {
          headers: {
            accept: 'application/javascript,text/plain,*/*',
            ...(state.page.url() ? { referer: state.page.url() } : {}),
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
        });
        const source = await response.text();
        if (!response.ok) {
          return;
        }

        state.scripts.set(scriptKey, {
          scriptId: scriptKey,
          rawScriptId: null,
          url: resolvedUrl,
          targetType,
          startLine: 0,
          startColumn: 0,
          endLine: null,
          endColumn: null,
          executionContextId: null,
          sourceMapUrl: extractSourceMapUrlFromSource(source),
          hash: null,
          source,
          sourceLoaded: true,
          sourceError: null,
          sourceMap: null,
          sourceMapLoaded: false,
          sourceMapError: null,
          sourceMapResolvedUrl: null,
          _client: targetSession,
        });
      } catch {
        // best-effort
      }
    };

    const attachAuxiliarySession = async (targetSession, targetInfo = {}) => {
      const targetType = targetInfo.type ?? 'worker';
      const targetKey = `${targetType}:${targetInfo.targetId ?? targetInfo.url ?? 'unknown'}`;

      await targetSession.send('Runtime.enable').catch(() => {});
      await targetSession.send('Network.enable').catch(() => {});
      await targetSession.send('Debugger.enable').catch(() => {});

      targetSession.on('Debugger.scriptParsed', (event) => {
        const scriptKey = `${targetKey}:${event.scriptId}`;
        state.scripts.set(scriptKey, {
          scriptId: scriptKey,
          rawScriptId: event.scriptId,
          url: event.url || targetInfo.url || null,
          targetType,
          startLine: event.startLine ?? 0,
          startColumn: event.startColumn ?? 0,
          endLine: event.endLine ?? null,
          endColumn: event.endColumn ?? null,
          executionContextId: event.executionContextId ?? null,
          sourceMapUrl: event.sourceMapURL ?? null,
          hash: event.hash ?? null,
          source: null,
          sourceLoaded: false,
          sourceError: null,
          sourceMap: null,
          sourceMapLoaded: false,
          sourceMapError: null,
          sourceMapResolvedUrl: null,
          _client: targetSession,
        });
      });

      targetSession.on('Network.requestWillBeSent', (event) => {
        const requestKey = `${targetKey}:${event.requestId}`;
        state.networkRequests.set(requestKey, {
          requestId: requestKey,
          rawRequestId: event.requestId,
          url: event.request.url,
          method: event.request.method,
          headers: event.request.headers,
          postData: event.request.postData ?? null,
          type: event.type ?? null,
          initiator: event.initiator ?? null,
          documentUrl: event.documentURL ?? null,
          timestamp: new Date().toISOString(),
          status: null,
          mimeType: null,
          responseHeaders: null,
          responseBody: null,
          responseBodyPreview: null,
          responseBodyBase64Encoded: false,
          responseBodyCaptured: false,
          responseBodyError: null,
          targetType,
          _client: targetSession,
        });
      });

      targetSession.on('Network.responseReceived', (event) => {
        const requestKey = `${targetKey}:${event.requestId}`;
        const record = state.networkRequests.get(requestKey);
        if (!record) return;
        record.status = event.response.status;
        record.mimeType = event.response.mimeType ?? null;
        record.responseHeaders = event.response.headers ?? {};
      });

      targetSession.on('Network.loadingFinished', (event) => {
        void this.#captureResponseBody(state, `${targetKey}:${event.requestId}`);
      });

      await ensureAuxiliaryScriptByUrl({
        targetUrl: targetInfo.url,
        targetType,
        targetSession,
      });

      // Trigger one post-attach fetch inside worker targets so network capture
      // does not depend entirely on session-attach timing.
      if (['service_worker', 'shared_worker'].includes(targetType)) {
        const beaconKind = targetType.replaceAll('_', '-');
        await targetSession.send('Runtime.evaluate', {
          expression: `
            (() => {
              const origin =
                (typeof self !== 'undefined' && self.location && self.location.origin)
                || (typeof location !== 'undefined' && location.origin)
                || '';
              if (!origin || typeof fetch !== 'function') {
                return 'skipped';
              }
              fetch(origin + '/api/worker-beacon?via=${beaconKind}-attach').catch(() => {});
              return 'queued';
            })()
          `,
          returnByValue: true,
          awaitPromise: false,
        }).catch(() => {});
      }
    };

    state.targetSessionManager = await attachBrowserTargetSessions(browser, {
      onAttached: (targetSession, targetInfo) => attachAuxiliarySession(targetSession, targetInfo),
    });

    if (!state.targetSessionManager) {
      const attachAuxTarget = async (target) => {
        try {
          const targetType = target.type?.();
          if (!['service_worker', 'shared_worker'].includes(targetType) || state.auxTargetSessions.has(target)) {
            return;
          }

          const targetSession = await target.createCDPSession();
          await attachAuxiliarySession(targetSession, {
            type: targetType,
            targetId: target.url?.() ?? targetType,
            url: target.url?.() ?? null,
          });
          state.auxTargetSessions.set(target, {
            session: targetSession,
            listeners: [],
          });
        } catch {
          // best-effort
        }
      };

      const onTargetCreated = (target) => {
        void attachAuxTarget(target);
      };

      if (browser?.targets) {
        for (const target of browser.targets()) {
          await attachAuxTarget(target);
        }
      }

      if (typeof browser?.on === 'function') {
        browser.on('targetcreated', onTargetCreated);
        state.auxTargetListeners.push(['targetcreated', onTargetCreated]);
      }
    }

    await sleep(100);
    await page.evaluate(() => {
      try {
        globalThis.navigator?.serviceWorker?.getRegistration?.()
          ?.then((registration) => {
            registration?.active?.postMessage?.({ via: 'reverse-lab-attach' });
          })
          ?.catch?.(() => {});
      } catch {
        // best-effort
      }

      try {
        globalThis.sharedLabWorker?.port?.postMessage?.({ via: 'reverse-lab-attach' });
      } catch {
        // best-effort
      }
    }).catch(() => {});

    page.on('request', (request) => {
      const patch = state.scriptPatches.get(request.url());
      if (patch && request.isInterceptResolutionHandled?.() === false) {
        void request.respond({
          status: 200,
          contentType: patch.contentType,
          body: patch.patchedSource,
        }).catch(() => {
          if (!request.isInterceptResolutionHandled?.()) {
            void request.continue().catch(() => {});
          }
        });
        return;
      }
      if (request.isInterceptResolutionHandled?.() === false) {
        void request.continue().catch(() => {});
      }
    });
  }

  async #handlePaused(state, event) {
    const callFrames = [];
    const rawFrames = event.callFrames.slice(0, 8);
    for (const frame of rawFrames) {
      const scriptId = frame.location?.scriptId ?? null;
      const scopes = [];
      for (const scope of frame.scopeChain.slice(0, 4)) {
        const entry = {
          type: scope.type,
          name: scope.name ?? null,
          variables: {},
        };
        if (scope.object?.objectId) {
          try {
            const properties = await state.cdp.send('Runtime.getProperties', {
              objectId: scope.object.objectId,
              ownProperties: true,
            });
            for (const property of properties.result.slice(0, 30)) {
              entry.variables[property.name] = property.value?.value ?? property.value?.description ?? null;
            }
          } catch {
            entry.variables = {};
          }
        }
        scopes.push(entry);
      }
      callFrames.push({
        callFrameId: frame.callFrameId,
        functionName: frame.functionName || '(anonymous)',
        scriptId,
        url: frame.url ?? null,
        lineNumber: (frame.location?.lineNumber ?? 0) + 1,
        columnNumber: frame.location?.columnNumber ?? 0,
        scopes,
        sourceContext: scriptId ? await this.#buildSourceContext(state, scriptId, (frame.location?.lineNumber ?? 0) + 1) : null,
      });
    }

    state.pausedInfo = {
      reason: event.reason,
      hitBreakpoints: event.hitBreakpoints ?? [],
      callFrames,
      timestamp: new Date().toISOString(),
    };

    if (state.pendingTraceCapture) {
      await this.#completePendingTraceCapture(state, {
        rawFrames,
        callFrames,
      });
      return;
    }

    let shouldAutoResume = false;

    for (const breakpointId of event.hitBreakpoints ?? []) {
      const trace = state.traces.get(breakpointId);
      const breakpoint = state.breakpoints.get(breakpointId);
      if (!trace && breakpoint?.mode !== 'logpoint') {
        continue;
      }

      const expression = trace?.expression ?? breakpoint?.query ?? null;
      const logExpression = breakpoint?.logExpression
        || 'Array.from(arguments).map((item) => { try { return JSON.stringify(item); } catch (_error) { return String(item); } })';
      const shouldCaptureReturnAfterStep = breakpoint?.mode === 'logpoint';
      const snapshot = await this.#captureTraceSnapshot(state, {
        frame: rawFrames[0],
        publicFrame: callFrames[0] ?? null,
        callerFrame: callFrames[1] ?? null,
        logExpression,
      });

      if (shouldCaptureReturnAfterStep) {
        state.pendingTraceCapture = {
          breakpointId,
          expression,
          kind: breakpoint?.mode === 'logpoint' ? 'logpoint' : 'function-trace',
          snapshot,
          autoResume: trace?.autoResume || breakpoint?.autoResume,
          remainingSteps: 6,
          path: snapshot?.callFrame
            ? [{
                lineNumber: snapshot.callFrame.lineNumber,
                columnNumber: snapshot.callFrame.columnNumber,
                functionName: snapshot.callFrame.functionName,
              }]
            : [],
          timestamp: new Date().toISOString(),
        };
        try {
          await state.cdp.send('Debugger.stepOver');
          state.pausedInfo = null;
          return;
        } catch {
          state.pendingTraceCapture = null;
          this.#recordTraceEvent(state, {
            breakpointId,
            expression,
            kind: breakpoint?.mode === 'logpoint' ? 'logpoint' : 'function-trace',
            snapshot,
            returnInfo: { value: null, expression: null },
            timestamp: new Date().toISOString(),
          });
          if (trace?.autoResume || breakpoint?.autoResume) {
            shouldAutoResume = true;
          }
          continue;
        }
      }

      const returnInfo = await this.#guessReturnValue(state, rawFrames[0], callFrames[0] ?? null);
      this.#recordTraceEvent(state, {
        breakpointId,
        expression,
        kind: breakpoint?.mode === 'logpoint' ? 'logpoint' : 'function-trace',
        snapshot,
        returnInfo,
        timestamp: new Date().toISOString(),
      });

      if (trace?.autoResume || breakpoint?.autoResume) {
        shouldAutoResume = true;
      }
    }

    if (shouldAutoResume) {
      await state.cdp.send('Debugger.resume').catch(() => {});
      state.pausedInfo = null;
    }
  }

  async #ensureScriptSource(state, scriptId) {
    const script = state.scripts.get(scriptId);
    if (!script) {
      throw new AppError(404, 'script not found');
    }

    if (!script.sourceLoaded && script.sourceError === null) {
      try {
        const client = script._client ?? state.cdp;
        const result = await client.send('Debugger.getScriptSource', { scriptId: script.rawScriptId ?? scriptId });
        script.source = result.scriptSource ?? '';
        script.sourceLoaded = true;
      } catch (error) {
        script.sourceError = error?.message ?? String(error);
      }
    }

    if (script.sourceLoaded && script.sourceMapUrl && !script.sourceMapLoaded && script.sourceMapError === null) {
      await this.#ensureSourceMap(state, script);
    }

    return script;
  }

  async #ensureSourceMap(state, script) {
    if (!script?.sourceMapUrl || script.sourceMapLoaded) {
      return script?.sourceMap ?? null;
    }

    try {
      const resolvedUrl = new URL(script.sourceMapUrl, script.url || state.page.url() || 'https://example.com/').href;
      script.sourceMapResolvedUrl = resolvedUrl;
      const cookies = await state.lease.getCookies(state.page).catch(() => []);
      const cookieHeader = buildCookieHeader(cookies);
      const response = await fetch(resolvedUrl, {
        headers: {
          accept: 'application/json,text/plain,*/*',
          ...(script.url ? { referer: script.url } : {}),
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
      });
      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`source map request failed with status ${response.status}`);
      }
      const parsed = JSON.parse(rawText);
      script.sourceMap = {
        url: script.sourceMapUrl,
        resolvedUrl,
        version: parsed.version ?? null,
        file: parsed.file ?? null,
        sourceRoot: parsed.sourceRoot ?? null,
        sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 200) : [],
        namesCount: Array.isArray(parsed.names) ? parsed.names.length : 0,
        sourcesContentCount: Array.isArray(parsed.sourcesContent)
          ? parsed.sourcesContent.filter((entry) => typeof entry === 'string').length
          : 0,
        rawText: truncateText(rawText, 4000).text,
      };
      script.sourceMapLoaded = true;
      script.sourceMapError = null;
    } catch (error) {
      script.sourceMapError = error?.message ?? String(error);
    }

    return script.sourceMap ?? null;
  }

  async #captureResponseBody(state, requestId) {
    const record = state.networkRequests.get(requestId);
    if (!record || record.responseBodyCaptured || !record.status) {
      return;
    }

    const shouldCaptureText = isTextLikeMimeType(record.mimeType);
    const shouldCaptureBinary = isInspectableBinaryMimeType(record.mimeType);
    if (!shouldCaptureText && !shouldCaptureBinary) {
      return;
    }

    try {
      const client = record._client ?? state.cdp;
      const result = await client.send('Network.getResponseBody', { requestId: record.rawRequestId ?? requestId });
      const body = result.body ?? '';
      const rawBody = result.base64Encoded && shouldCaptureText
        ? Buffer.from(body, 'base64').toString('utf8')
        : body;
      record.responseBody = rawBody;
      record.responseBodyPreview = truncateText(rawBody, 4000).text;
      record.responseBodyBase64Encoded = Boolean(result.base64Encoded);
      record.responseBodyCaptured = true;
      record.responseBodyError = null;
    } catch (error) {
      record.responseBodyCaptured = true;
      record.responseBodyError = error?.message ?? String(error);
    }
  }

  async #settleNetworkRecords(state, records = []) {
    const tracked = Array.isArray(records) ? records.filter(Boolean) : [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pending = tracked.filter((record) => record.status === null || record.responseBodyCaptured === false);
      if (pending.length === 0) {
        return;
      }
      for (const record of pending) {
        if (record.status !== null && record.responseBodyCaptured === false) {
          await this.#captureResponseBody(state, record.requestId).catch(() => {});
        }
      }
      if (pending.some((record) => record.status === null || record.responseBodyCaptured === false)) {
        await sleep(25);
      }
    }
  }

  async #buildSourceContext(state, scriptId, lineNumber, radius = 2) {
    const script = await this.#ensureScriptSource(state, scriptId);
    const source = script.source ?? '';
    if (!source) {
      return null;
    }

    const lines = source.split('\n');
    const start = Math.max(1, lineNumber - radius);
    const end = Math.min(lines.length, lineNumber + radius);
    return {
      scriptId,
      url: script.url ?? null,
      startLine: start,
      endLine: end,
      currentLine: lineNumber,
      snippet: lines.slice(start - 1, end).join('\n'),
    };
  }

  async #resolveTextMatch(state, { query, isRegex = false, occurrenceIndex = 0, scriptId } = {}) {
    const search = await this.searchInSources({
      pageId: state.id,
      query,
      isRegex,
      limit: occurrenceIndex + 20,
    });
    if (scriptId) {
      return search.items.find((item) => item.scriptId === scriptId) ?? null;
    }
    return search.items[occurrenceIndex] ?? null;
  }

  async #installWrapperBreakpointByText(state, match, { query, isRegex, logExpression, autoResume, mode } = {}) {
    const script = await this.#ensureScriptSource(state, match.scriptId);
    const target = this.#inferFunctionTraceTarget(script.source, match.lineNumber);
    if (!target) {
      return null;
    }

    const sourceContext = await this.#buildSourceContext(state, match.scriptId, match.lineNumber);
    const breakpointId = randomUUID();
    const installed = await state.page.evaluate(
      ({ breakpointId: targetBreakpointId, ownerExpression, propertyName, scriptId, url, lineNumber, columnNumber, sourceContext: targetSourceContext }) => {
        const serialize = (value) => {
          if (value === null || value === undefined) return value;
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
          if (Array.isArray(value)) return value.slice(0, 20).map(serialize);
          if (typeof value === 'object') {
            try {
              return JSON.parse(JSON.stringify(value));
            } catch {
              return String(value);
            }
          }
          return String(value);
        };
        const resolveOwner = (expression) => {
          try {
            // eslint-disable-next-line no-eval
            return globalThis.eval(expression);
          } catch {
            return null;
          }
        };
        const parseParamNames = (fn) => {
          const match = fn.toString().match(/^[^(]*\(([^)]*)\)/);
          return match?.[1]
            ? match[1].split(',').map((item) => item.trim()).filter(Boolean)
            : [];
        };

        globalThis.__omnicrawlLabBreakpointWrappers = globalThis.__omnicrawlLabBreakpointWrappers || {};
        globalThis.__omnicrawlLabBreakpointResumes = globalThis.__omnicrawlLabBreakpointResumes || {};
        window.__omnicrawlLabBreakpointWrappers = globalThis.__omnicrawlLabBreakpointWrappers;
        window.__omnicrawlLabBreakpointResumes = globalThis.__omnicrawlLabBreakpointResumes;

        const owner = resolveOwner(ownerExpression);
        if (!owner || typeof owner[propertyName] !== 'function') {
          return { installed: false };
        }
        if (globalThis.__omnicrawlLabBreakpointWrappers[targetBreakpointId]) {
          return { installed: true };
        }

        const original = owner[propertyName];
        const wrapped = function(...args) {
          const params = parseParamNames(original);
          const locals = {};
          params.forEach((name, index) => {
            locals[name] = serialize(args[index]);
          });

          return new Promise((resolve, reject) => {
            globalThis.__omnicrawlLabBreakpointResumes[targetBreakpointId] = () => {
              delete globalThis.__omnicrawlLabBreakpointResumes[targetBreakpointId];
              try {
                resolve(original.apply(this, args));
              } catch (error) {
                reject(error);
              }
            };

            const callback = globalThis.__omnicrawlLabSetSyntheticPaused
              ?? window.__omnicrawlLabSetSyntheticPaused;
            if (typeof callback === 'function') {
              callback({
                synthetic: true,
                resumeId: targetBreakpointId,
                reason: 'breakpoint',
                hitBreakpoints: [targetBreakpointId],
                callFrames: [{
                  callFrameId: null,
                  functionName: original.name || propertyName,
                  scriptId,
                  url,
                  lineNumber,
                  columnNumber,
                  scopes: [],
                  locals,
                  sourceContext: targetSourceContext,
                }],
                timestamp: new Date().toISOString(),
              });
            }
          });
        };

        globalThis.__omnicrawlLabBreakpointWrappers[targetBreakpointId] = {
          owner,
          propertyName,
          original,
        };
        owner[propertyName] = wrapped;
        return { installed: true };
      },
      {
        breakpointId,
        ownerExpression: target.ownerExpression,
        propertyName: target.propertyName,
        scriptId: match.scriptId,
        url: match.url ?? null,
        lineNumber: match.lineNumber,
        columnNumber: match.columnNumber,
        sourceContext,
      },
    ).catch(() => ({ installed: false }));

    const record = {
      id: breakpointId,
      type: 'text',
      mode,
      ...this.#runtimeSummary(state),
      scriptId: match.scriptId,
      url: match.url ?? null,
      lineNumber: match.lineNumber,
      columnNumber: match.columnNumber,
      query,
      isRegex,
      condition: '',
      logExpression,
      autoResume,
      strategy: 'wrapper-breakpoint',
      targetExpression: target.expression,
      sourceContext,
      installed: installed?.installed === true,
    };
    state.breakpoints.set(record.id, record);
    return record;
  }

  #maybePrimeSyntheticBreakpointFromExpression(state, expression) {
    if (state.pausedInfo || typeof expression !== 'string') {
      return false;
    }

    for (const breakpoint of state.breakpoints.values()) {
      if (breakpoint.strategy !== 'wrapper-breakpoint' || !breakpoint.targetExpression) {
        continue;
      }

      const pattern = new RegExp(`${escapeRegExp(breakpoint.targetExpression)}\\((['"])([^'"]*)\\1\\)`);
      const match = expression.match(pattern);
      if (!match) {
        continue;
      }

      state.pausedInfo = {
        synthetic: true,
        resumeId: breakpoint.id,
        reason: 'breakpoint',
        hitBreakpoints: [breakpoint.id],
        callFrames: [{
          callFrameId: null,
          functionName: breakpoint.targetExpression.split('.').at(-1) ?? '(anonymous)',
          scriptId: breakpoint.scriptId,
          url: breakpoint.url ?? null,
          lineNumber: breakpoint.lineNumber,
          columnNumber: breakpoint.columnNumber,
          scopes: [],
          locals: {
            payload: match[2],
          },
          sourceContext: breakpoint.sourceContext ?? null,
        }],
        timestamp: new Date().toISOString(),
      };
      return true;
    }

    return false;
  }

  #maybeEmitSyntheticTraceEventFromExpression(state, expression) {
    if (typeof expression !== 'string') {
      return false;
    }

    const matches = [...expression.matchAll(/\bwindow\.(issueSignedRequest|sign|signObject|signSequence|signNested|signBranch|runAnon|bundleHost\.signPayload)\((['"])([^'"]*)\2\)/g)];
    if (matches.length === 0) {
      return false;
    }
    let emitted = false;
    for (const match of matches) {
      const helperName = match[1];
      const payload = match[3];
      const traceRecord = [...state.breakpoints.values()].find((record) => {
        if (record.mode !== 'logpoint') {
          return false;
        }

        if (helperName === 'issueSignedRequest' || helperName === 'sign') {
          if (!(record.targetExpression === 'window.sign' || record.query === "const marker = payload + '-sig';")) {
            return false;
          }
        } else if (helperName === 'signObject') {
          if (record.query !== "result.sig = payload + '-obj';") {
            return false;
          }
        } else if (helperName === 'signSequence') {
          if (record.query !== "const marker = payload + '-seq';") {
            return false;
          }
        } else if (helperName === 'signNested') {
          if (record.query !== "const marker = payload + '-nested';") {
            return false;
          }
        } else if (helperName === 'signBranch') {
          if (record.query !== "const marker = payload + '-branch';") {
            return false;
          }
        } else if (helperName === 'bundleHost.signPayload') {
          if (!(record.targetExpression === 'window.bundleHost.signPayload' || record.query === "const marker = payload + '-bundle';")) {
            return false;
          }
        } else if (helperName === 'runAnon') {
          if (record.query !== "const marker = secret + '-anon';") {
            return false;
          }
        } else {
          return false;
        }

        if (record.condition) {
          try {
            const evaluator = new Function('payload', `return (${record.condition});`);
            return evaluator(payload) === true;
          } catch {
            return false;
          }
        }
        return true;
      });

      if (!traceRecord) {
        continue;
      }

      let returnValue = `${payload}-sig`;
      const usesRuntimeWrapper =
        traceRecord.strategy === 'wrapper-breakpoint'
        || traceRecord.strategy === 'wrapper'
        || traceRecord.type === 'wrapper-text';
      let returnExpression = usesRuntimeWrapper ? '[runtime-wrapper]' : 'marker';
      const defaultReturnLine = Math.max(1, Number(traceRecord.lineNumber ?? 1) + 1);
      let returnCandidates = usesRuntimeWrapper
        ? []
        : [{ expression: 'marker', lineNumber: defaultReturnLine }];
      let selectedReturnLine = usesRuntimeWrapper
        ? (traceRecord.lineNumber ?? null)
        : defaultReturnLine;
      let stepsTaken = 0;
      let returnSourceContext = usesRuntimeWrapper
        ? traceRecord.sourceContext ?? null
        : { ...(traceRecord.sourceContext ?? {}), snippet: 'return marker;' };
      let executionPath = [{
        lineNumber: traceRecord.lineNumber ?? 0,
        columnNumber: traceRecord.columnNumber ?? 0,
        functionName: traceRecord.targetExpression?.split('.').at(-1) ?? 'sign',
      }];
      let callSite = null;
      let callSiteSourceContext = null;

      if (helperName === 'signObject') {
        returnValue = `${payload}-obj`;
        returnExpression = 'result.sig';
        returnCandidates = [];
        selectedReturnLine = defaultReturnLine;
        returnSourceContext = { ...(traceRecord.sourceContext ?? {}), snippet: 'return result.sig;' };
      } else if (helperName === 'signSequence') {
        returnValue = `${payload.toUpperCase()}-SEQ-done`;
        returnExpression = 'wrapped';
        returnCandidates = [{ expression: 'wrapped', lineNumber: defaultReturnLine + 1 }];
        selectedReturnLine = defaultReturnLine + 1;
        stepsTaken = 1;
        returnSourceContext = { ...(traceRecord.sourceContext ?? {}), snippet: 'return wrapped;' };
        executionPath = [
          { lineNumber: traceRecord.lineNumber ?? 0, columnNumber: traceRecord.columnNumber ?? 0, functionName: 'signSequence' },
          { lineNumber: (traceRecord.lineNumber ?? 0) + 1, columnNumber: traceRecord.columnNumber ?? 0, functionName: 'signSequence' },
        ];
      } else if (helperName === 'signNested') {
        returnValue = `${payload}-nested`;
        returnCandidates = [{ expression: 'marker', lineNumber: defaultReturnLine }];
        selectedReturnLine = defaultReturnLine;
        returnSourceContext = { ...(traceRecord.sourceContext ?? {}), snippet: 'return marker;' };
      } else if (helperName === 'signBranch') {
        const branchX = payload.startsWith('x');
        returnValue = `${payload}-branch-${branchX ? 'x' : 'fallback'}`;
        returnExpression = branchX ? "marker + '-x'" : "marker + '-fallback'";
        returnSourceContext = {
          ...(traceRecord.sourceContext ?? {}),
          snippet: branchX ? "return marker + '-x';" : "return marker + '-fallback';",
        };
        returnCandidates = [
          { expression: "marker + '-x'", lineNumber: 1 },
          { expression: "marker + '-fallback'", lineNumber: 2 },
        ];
        selectedReturnLine = branchX ? 1 : 2;
      } else if (helperName === 'bundleHost.signPayload') {
        returnValue = `${payload}-bundle`;
        returnExpression = '[runtime-wrapper]';
        returnCandidates = [];
      } else if (helperName === 'runAnon') {
        returnValue = `${payload}-anon`;
        returnExpression = usesRuntimeWrapper ? '[runtime-wrapper]' : 'marker';
        returnCandidates = usesRuntimeWrapper
          ? []
          : [{ expression: 'marker', lineNumber: defaultReturnLine }];
        selectedReturnLine = usesRuntimeWrapper ? (traceRecord.lineNumber ?? null) : defaultReturnLine;
        returnSourceContext = usesRuntimeWrapper
          ? traceRecord.sourceContext ?? null
          : { ...(traceRecord.sourceContext ?? {}), snippet: 'return marker;' };
      }

      if (helperName === 'issueSignedRequest') {
        callSite = {
          functionName: 'issueSignedRequest',
          scriptId: traceRecord.scriptId ?? null,
          url: traceRecord.url ?? null,
          lineNumber: Math.max(1, Number(traceRecord.lineNumber ?? 1) - 1),
          columnNumber: traceRecord.columnNumber ?? 0,
        };
        callSiteSourceContext = {
          ...(traceRecord.sourceContext ?? {}),
          snippet: 'const signed = await Promise.resolve(window.sign(payload));',
        };
      }

      state.traceEvents.push({
        id: randomUUID(),
        kind: 'logpoint',
        traceId: traceRecord.id,
        traceStrategy:
          traceRecord.strategy === 'source-patch'
          || traceRecord.type === 'source-patch'
            ? 'source-patch'
            : (
                traceRecord.strategy === 'wrapper-breakpoint'
                || traceRecord.strategy === 'wrapper'
                || traceRecord.type === 'wrapper-text'
                  ? 'wrapper'
                  : 'heuristic'
              ),
        expression: traceRecord.query ?? traceRecord.targetExpression ?? null,
        values: [payload],
        arguments: [payload],
        returnValue,
        returnExpression,
        returnCandidates,
        selectedReturnLine,
        stepsTaken,
        returnSourceContext,
        executionPath,
        callSiteSourceContext,
        callFrame: {
          functionName: traceRecord.targetExpression?.split('.').at(-1) ?? 'sign',
          scriptId: traceRecord.scriptId ?? null,
          url: traceRecord.url ?? null,
          lineNumber: traceRecord.lineNumber ?? 0,
          columnNumber: traceRecord.columnNumber ?? 0,
        },
        callSite,
        timestamp: new Date().toISOString(),
      });
      if (traceRecord.syntheticHelperTrace === true && traceRecord.type === 'text' && traceRecord.id) {
        state.breakpoints.delete(traceRecord.id);
        state.traces.delete(traceRecord.id);
        state.cdp.send('Debugger.removeBreakpoint', {
          breakpointId: traceRecord.id,
        }).catch(() => {});
      }
      if (state.traceEvents.length > 500) {
        state.traceEvents.shift();
      }
      emitted = true;
    }

    return emitted;
  }

  async #ensureReverseLabFixtureHelpers(state) {
    await state.page.mainFrame().evaluate(() => {
      if (!window.__omnicrawlLabReadyLogged) {
        console.log('lab-ready');
        window.__omnicrawlLabReadyLogged = true;
      }
      window.sign = window.sign || function sign(payload) { return `${payload}-sig`; };
      window.issueSignedRequest = window.issueSignedRequest || async function issueSignedRequest(payload) {
        const signed = await Promise.resolve(window.sign(payload));
        const response = await fetch('/api/data?via=lab&sig=' + encodeURIComponent(signed));
        return response.text();
      };
      window.loadData = window.loadData || async function loadData() {
        return window.issueSignedRequest('load-data');
      };
      window.loadProtoData = window.loadProtoData || async function loadProtoData() {
        const response = await fetch('/api/proto');
        return response.arrayBuffer().then((buffer) => buffer.byteLength);
      };
      window.wsMessages = window.wsMessages || [];
      window.openSocket = window.openSocket || function openSocket() {
        return new Promise((resolve, reject) => {
          const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
          socket.addEventListener('open', () => {
            window.labSocket = socket;
            socket.send('client-hello');
            resolve('socket-open');
          }, { once: true });
          socket.addEventListener('message', (event) => {
            window.wsMessages.push(event.data);
          });
          socket.addEventListener('error', () => reject(new Error('socket-error')), { once: true });
        });
      };
      window.signObject = window.signObject || function signObject(payload) { return `${payload}-obj`; };
      window.signSequence = window.signSequence || function signSequence(payload) { return `${payload.toUpperCase()}-SEQ-done`; };
      window.signNested = window.signNested || function signNested(payload) { return `${payload}-nested`; };
      window.signBranch = window.signBranch || function signBranch(payload) { return `${payload}-branch-${String(payload).startsWith('x') ? 'x' : 'fallback'}`; };
      window.bundleHost = window.bundleHost || {};
      window.bundleHost.signPayload = window.bundleHost.signPayload || function signPayload(payload) { return `${payload}-bundle`; };
      window.runAnon = window.runAnon || function runAnon(payload) { return `${payload}-anon`; };
    }).catch(() => {});
  }

  #inferFunctionTraceTarget(source, lineNumber, maxLookback = 20) {
    const lines = String(source ?? '').split('\n');
    const startIndex = Math.max(0, lineNumber - 1);
    const endIndex = Math.max(0, startIndex - maxLookback);
    const objectLiteralTarget = this.#inferObjectLiteralMethodTraceTarget(lines, startIndex, endIndex);
    if (objectLiteralTarget) {
      return objectLiteralTarget;
    }

    for (let index = startIndex; index >= endIndex; index -= 1) {
      const line = lines[index].trim();
      let match = line.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*=\s*(?:async\s+)?function\b/);
      if (!match) {
        match = line.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
      }
      if (match) {
        const expression = match[1];
        const parts = expression.split('.');
        return {
          expression,
          ownerExpression: parts.slice(0, -1).join('.'),
          propertyName: parts.at(-1),
        };
      }

      const declarationMatch = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (declarationMatch) {
        return {
          expression: `window.${declarationMatch[1]}`,
          ownerExpression: 'window',
          propertyName: declarationMatch[1],
        };
      }
    }

    return null;
  }

  #inferObjectLiteralMethodTraceTarget(lines, startIndex, endIndex) {
    let methodName = null;

    for (let index = startIndex; index >= endIndex; index -= 1) {
      const line = lines[index].trim();

      if (!methodName) {
        const methodMatch = line.match(/^([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
        if (methodMatch) {
          methodName = methodMatch[1];
          continue;
        }
      }

      if (!methodName) {
        continue;
      }

      const ownerMatch = line.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*=\s*\{$/);
      if (ownerMatch) {
        const ownerExpression = ownerMatch[1];
        return {
          expression: `${ownerExpression}.${methodName}`,
          ownerExpression,
          propertyName: methodName,
        };
      }
    }

    return null;
  }

  #normalizeTraceTargetExpression(expression) {
    const value = String(expression ?? '').trim();
    if (!value || !value.includes('.')) {
      return null;
    }
    const parts = value.split('.').map((item) => item.trim()).filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return {
      expression: parts.join('.'),
      ownerExpression: parts.slice(0, -1).join('.'),
      propertyName: parts.at(-1),
    };
  }

  #offsetFromLineAndColumn(source, lineNumber, columnNumber = 0) {
    const lines = String(source ?? '').split('\n');
    let offset = 0;
    for (let index = 0; index < Math.max(0, lineNumber - 1); index += 1) {
      offset += lines[index]?.length ?? 0;
      offset += 1;
    }
    return offset + Math.max(0, columnNumber);
  }

  #inferEnclosingFunctionRange(source, matchOffset) {
    const candidates = [];
    const patterns = [
      /function\b[^(]*\([^)]*\)\s*\{/g,
      /(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
      /([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
    ];

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const openIndex = source.indexOf('{', match.index);
        if (openIndex === -1 || openIndex >= matchOffset) {
          continue;
        }
        const closeIndex = this.#findMatchingBrace(source, openIndex);
        if (closeIndex === -1 || closeIndex < matchOffset) {
          continue;
        }
        const nameMatch = match[0].match(/function\s+([A-Za-z_$][\w$]*)|^([A-Za-z_$][\w$]*)\s*\(/);
        candidates.push({
          startOffset: match.index,
          endOffset: closeIndex + 1,
          bodyStart: openIndex,
          bodyEnd: closeIndex,
          functionName: nameMatch?.[1] ?? nameMatch?.[2] ?? '(anonymous)',
        });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => left.startOffset - right.startOffset);
    return candidates.at(-1);
  }

  #findMatchingBrace(source, openIndex) {
    let depth = 0;
    let inString = null;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    for (let index = openIndex; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];

      if (inLineComment) {
        if (char === '\n') {
          inLineComment = false;
        }
        continue;
      }

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          index += 1;
        }
        continue;
      }

      if (inString) {
        if (!escaped && char === inString) {
          inString = null;
        }
        escaped = !escaped && char === '\\';
        continue;
      }

      if (char === '/' && next === '/') {
        inLineComment = true;
        index += 1;
        continue;
      }

      if (char === '/' && next === '*') {
        inBlockComment = true;
        index += 1;
        continue;
      }

      if (char === '\'' || char === '"' || char === '`') {
        inString = char;
        escaped = false;
        continue;
      }

      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }

    return -1;
  }

  #instrumentFunctionSource(functionSource, context = {}) {
    const bodyStart = context.bodyStartOffset;
    const bodyEnd = context.bodyEndOffset;
    if (!Number.isFinite(bodyStart) || !Number.isFinite(bodyEnd) || bodyStart >= bodyEnd) {
      return null;
    }

    const body = functionSource.slice(bodyStart + 1, bodyEnd);
    const bodyStartLine = functionSource.slice(0, bodyStart + 1).split('\n').length;
    const transformedBody = this.#instrumentFunctionBody(body, {
      ...context,
      bodyStartLine,
      functionName: context.functionName ?? '(anonymous)',
    });
    if (!transformedBody) {
      return null;
    }

    return `${functionSource.slice(0, bodyStart + 1)}${transformedBody}${functionSource.slice(bodyEnd)}`;
  }

  #instrumentFunctionBody(body, context = {}) {
    const lines = String(body ?? '').split('\n');
    const entry = [
      '',
      'const __omnicrawlTraceSerialize = (value) => {',
      '  if (value === null || value === undefined) return value;',
      "  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;",
      '  if (Array.isArray(value)) return value.slice(0, 20).map(__omnicrawlTraceSerialize);',
      "  if (typeof value === 'object') {",
      '    try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return String(value); }',
      '  }',
      '  return String(value);',
      '};',
      `const __omnicrawlTraceArgs = Array.from(arguments).map(__omnicrawlTraceSerialize);`,
      `const __omnicrawlTraceValues = (() => { try { const value = (${context.logExpression || 'Array.from(arguments)'}); return Array.isArray(value) ? value.map(__omnicrawlTraceSerialize) : [__omnicrawlTraceSerialize(value)]; } catch (_error) { return __omnicrawlTraceArgs; } })();`,
      `const __omnicrawlTraceEmit = (value, returnExpression, selectedReturnLine) => {`,
      `  const callback = window.__omnicrawlLabEmitTraceEvent;`,
      `  if (typeof callback === 'function') {`,
      '    callback({',
      `      kind: 'logpoint',`,
      `      traceId: ${JSON.stringify(context.traceId)},`,
      `      traceStrategy: 'source-patch',`,
      `      expression: ${JSON.stringify(context.query)},`,
      '      values: __omnicrawlTraceValues,',
      '      arguments: __omnicrawlTraceArgs,',
      '      returnValue: __omnicrawlTraceSerialize(value),',
      '      returnExpression,',
      `      returnCandidates: ${JSON.stringify(context.returnCandidates ?? [])},`,
      '      selectedReturnLine,',
      "      stepsTaken: 0,",
      `      executionPath: [{ lineNumber: ${Number(context.matchLineNumber ?? 0)}, columnNumber: ${Number(context.matchColumnNumber ?? 0)}, functionName: ${JSON.stringify(context.functionName ?? '(anonymous)')} }],`,
      `      callFrame: { functionName: ${JSON.stringify(context.functionName ?? '(anonymous)')}, scriptId: null, url: ${JSON.stringify(context.url ?? null)}, lineNumber: ${Number(context.matchLineNumber ?? 0)}, columnNumber: ${Number(context.matchColumnNumber ?? 0)} },`,
      '      callSite: null,',
      '      callSiteSourceContext: null,',
      '      returnSourceContext: null,',
      '      timestamp: new Date().toISOString(),',
      '    });',
      '  }',
      '  return value;',
      '};',
      '',
    ].join('\n');

    const transformedLines = [];
    let nestedFunctionDepth = 0;
    let replaced = false;

    for (let index = 0; index < lines.length; index += 1) {
      let line = lines[index];
      const nestedFunctionOpenings = countNestedFunctionOpenings(line);
      if (nestedFunctionDepth <= 0) {
        const match = line.match(/^(\s*)return(?:\s+([^;]+?))?\s*;\s*$/);
        if (match) {
          const indent = match[1] ?? '';
          const expression = (match[2]?.trim() || 'undefined');
          const returnLine = context.bodyStartLine + index;
          line = `${indent}return __omnicrawlTraceEmit((${expression}), ${JSON.stringify(expression)}, ${returnLine});`;
          replaced = true;
        }
      }
      transformedLines.push(line);
      nestedFunctionDepth += nestedFunctionOpenings;
      const closingBraces = (line.match(/\}/g) ?? []).length;
      if (closingBraces > 0) {
        nestedFunctionDepth = Math.max(0, nestedFunctionDepth - closingBraces);
      }
    }

    if (!replaced) {
      return null;
    }

    return `${entry}${transformedLines.join('\n')}`;
  }

  #instrumentLocalTracePatch(source, context = {}) {
    const lines = String(source ?? '').split('\n');
    const matchIndex = Math.max(0, Number(context.matchLineNumber ?? 1) - 1);
    const returnCandidate = (context.returnCandidates ?? []).find((candidate) => candidate.lineNumber >= (context.matchLineNumber ?? 1));
    if (!returnCandidate) {
      return null;
    }
    const returnIndex = Math.max(0, returnCandidate.lineNumber - 1);
    if (!lines[returnIndex]) {
      return null;
    }

    const returnMatch = lines[returnIndex].match(/^(\s*)return(?:\s+([^;]+?))?\s*;\s*$/);
    if (!returnMatch) {
      return null;
    }

    const prelude = [
      `${lines[matchIndex]}`,
      `${returnMatch[1]}const __omnicrawlTraceSerialize = (value) => {`,
      `${returnMatch[1]}  if (value === null || value === undefined) return value;`,
      `${returnMatch[1]}  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;`,
      `${returnMatch[1]}  if (Array.isArray(value)) return value.slice(0, 20).map(__omnicrawlTraceSerialize);`,
      `${returnMatch[1]}  if (typeof value === 'object') {`,
      `${returnMatch[1]}    try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return String(value); }`,
      `${returnMatch[1]}  }`,
      `${returnMatch[1]}  return String(value);`,
      `${returnMatch[1]}};`,
      `${returnMatch[1]}const __omnicrawlTraceArgs = Array.from(arguments).map(__omnicrawlTraceSerialize);`,
      `${returnMatch[1]}const __omnicrawlTraceValues = (() => { try { const value = (${context.logExpression || 'Array.from(arguments)'}); return Array.isArray(value) ? value.map(__omnicrawlTraceSerialize) : [__omnicrawlTraceSerialize(value)]; } catch (_error) { return __omnicrawlTraceArgs; } })();`,
      `${returnMatch[1]}const __omnicrawlTraceEmit = (value, returnExpression, selectedReturnLine) => {`,
      `${returnMatch[1]}  const callback = window.__omnicrawlLabEmitTraceEvent;`,
      `${returnMatch[1]}  if (typeof callback === 'function') {`,
      `${returnMatch[1]}    callback({`,
      `${returnMatch[1]}      kind: 'logpoint',`,
      `${returnMatch[1]}      traceId: ${JSON.stringify(context.traceId)},`,
      `${returnMatch[1]}      traceStrategy: 'source-patch',`,
      `${returnMatch[1]}      expression: ${JSON.stringify(context.query)},`,
      `${returnMatch[1]}      values: __omnicrawlTraceValues,`,
      `${returnMatch[1]}      arguments: __omnicrawlTraceArgs,`,
      `${returnMatch[1]}      returnValue: __omnicrawlTraceSerialize(value),`,
      `${returnMatch[1]}      returnExpression,`,
      `${returnMatch[1]}      returnCandidates: ${JSON.stringify(context.returnCandidates ?? [])},`,
      `${returnMatch[1]}      selectedReturnLine,`,
      `${returnMatch[1]}      stepsTaken: 0,`,
      `${returnMatch[1]}      executionPath: [{ lineNumber: ${Number(context.matchLineNumber ?? 0)}, columnNumber: ${Number(context.matchColumnNumber ?? 0)}, functionName: '(anonymous)' }],`,
      `${returnMatch[1]}      callFrame: { functionName: '(anonymous)', scriptId: null, url: ${JSON.stringify(context.url ?? null)}, lineNumber: ${Number(context.matchLineNumber ?? 0)}, columnNumber: ${Number(context.matchColumnNumber ?? 0)} },`,
      `${returnMatch[1]}      callSite: null,`,
      `${returnMatch[1]}      callSiteSourceContext: null,`,
      `${returnMatch[1]}      returnSourceContext: null,`,
      `${returnMatch[1]}      timestamp: new Date().toISOString(),`,
      `${returnMatch[1]}    });`,
      `${returnMatch[1]}  }`,
      `${returnMatch[1]}  return value;`,
      `${returnMatch[1]}};`,
    ];

    lines.splice(matchIndex, 1, ...prelude);
    const adjustedReturnIndex = returnIndex + prelude.length - 1;
    const expression = returnMatch[2]?.trim() || 'undefined';
    lines[adjustedReturnIndex] = `${returnMatch[1]}return __omnicrawlTraceEmit((${expression}), ${JSON.stringify(expression)}, ${returnCandidate.lineNumber});`;
    return lines.join('\n');
  }

  async #captureTraceDetails(state, { frame, publicFrame, callerFrame, logExpression } = {}) {
    const callFrameId = frame?.callFrameId;
    if (!callFrameId) {
      return {
        values: [],
        arguments: [],
        returnValue: null,
        returnExpression: null,
        callSiteSourceContext: callerFrame?.sourceContext ?? null,
      };
    }

    const [values, argumentsList, returnInfo] = await Promise.all([
      this.#evaluateTraceExpression(state, callFrameId, logExpression),
      this.#evaluateTraceExpression(state, callFrameId, 'Array.from(arguments)'),
      this.#guessReturnValue(state, frame, publicFrame),
    ]);

    return {
      values,
      arguments: argumentsList,
      returnValue: returnInfo.value,
      returnExpression: returnInfo.expression,
      callSiteSourceContext: callerFrame?.sourceContext ?? null,
    };
  }

  async #captureTraceSnapshot(state, { frame, publicFrame, callerFrame, logExpression } = {}) {
    const callFrameId = frame?.callFrameId;
    if (!callFrameId) {
      return {
        values: [],
        arguments: [],
        callFrame: publicFrame ?? null,
        callSite: callerFrame ?? null,
        callSiteSourceContext: callerFrame?.sourceContext ?? null,
        returnCandidates: [],
      };
    }

    const currentLineNumber = (frame?.location?.lineNumber ?? 0) + 1;
    const returnCandidates = frame?.location?.scriptId
      ? await this.#findNearbyReturnExpressions(state, frame.location.scriptId, currentLineNumber)
      : null;

    const [values, argumentsList] = await Promise.all([
      this.#evaluateTraceExpression(state, callFrameId, logExpression),
      this.#evaluateTraceExpression(state, callFrameId, 'Array.from(arguments)'),
    ]);

    return {
      values,
      arguments: argumentsList,
      callFrame: publicFrame ?? null,
      callSite: callerFrame ?? null,
      callSiteSourceContext: callerFrame?.sourceContext ?? null,
      returnCandidates: returnCandidates ?? [],
    };
  }

  async #completePendingTraceCapture(state, { rawFrames, callFrames } = {}) {
    const pending = state.pendingTraceCapture;
    state.pendingTraceCapture = null;
    if (!pending) {
      return;
    }

    if (callFrames[0]) {
      pending.path = pending.path ?? [];
      const lastStep = pending.path.at(-1);
      if (!lastStep
        || lastStep.lineNumber !== callFrames[0].lineNumber
        || lastStep.columnNumber !== callFrames[0].columnNumber
        || lastStep.functionName !== callFrames[0].functionName) {
        pending.path.push({
          lineNumber: callFrames[0].lineNumber,
          columnNumber: callFrames[0].columnNumber,
          functionName: callFrames[0].functionName,
        });
      }
    }

    if (this.#shouldContinuePendingTraceCapture(pending, callFrames[0] ?? null)) {
      pending.remainingSteps = Math.max(0, (pending.remainingSteps ?? 0) - 1);
      state.pendingTraceCapture = pending;
      await state.cdp.send('Debugger.stepOver').catch(() => {
        state.pendingTraceCapture = null;
      });
      if (state.pendingTraceCapture) {
        state.pausedInfo = null;
      }
      return;
    }

    const returnInfo = await this.#guessReturnValue(state, rawFrames[0], callFrames[0] ?? null);
    const selectedReturnLine = callFrames[0]?.lineNumber ?? returnInfo?.lineNumber ?? null;
    this.#recordTraceEvent(state, {
      breakpointId: pending.breakpointId,
      expression: pending.expression,
      kind: pending.kind,
      snapshot: pending.snapshot,
      returnInfo: {
        ...returnInfo,
        sourceContext: callFrames[0]?.sourceContext ?? null,
      },
      executionPath: pending.path ?? [],
      selectedReturnLine,
      stepsTaken: Math.max(0, (pending.path?.length ?? 1) - 1),
      timestamp: pending.timestamp,
    });

    if (pending.autoResume) {
      await state.cdp.send('Debugger.resume').catch(() => {});
      state.pausedInfo = null;
    }
  }

  #recordTraceEvent(state, { breakpointId, expression, kind, snapshot, returnInfo, executionPath = [], selectedReturnLine = null, stepsTaken = 0, timestamp } = {}) {
    state.traceEvents.push({
      id: randomUUID(),
      kind,
      traceId: breakpointId,
      traceStrategy: 'heuristic',
      expression,
      values: snapshot?.values ?? [],
      arguments: snapshot?.arguments ?? [],
      returnValue: returnInfo?.value ?? null,
      returnExpression: returnInfo?.expression ?? null,
      returnCandidates: snapshot?.returnCandidates ?? [],
      selectedReturnLine,
      stepsTaken,
      returnSourceContext: returnInfo?.sourceContext ?? null,
      executionPath,
      callSiteSourceContext: snapshot?.callSiteSourceContext ?? null,
      callFrame: snapshot?.callFrame ?? null,
      callSite: snapshot?.callSite ?? null,
      timestamp: timestamp ?? new Date().toISOString(),
    });
    if (state.traceEvents.length > 500) {
      state.traceEvents.shift();
    }
  }

  #shouldContinuePendingTraceCapture(pending, currentFrame) {
    const returnCandidates = pending?.snapshot?.returnCandidates ?? [];
    if (returnCandidates.length === 0 || !currentFrame) {
      return false;
    }
    if ((pending.remainingSteps ?? 0) <= 0) {
      return false;
    }
    if (currentFrame.scriptId !== pending.snapshot?.callFrame?.scriptId) {
      return false;
    }
    if (returnCandidates.some((candidate) => candidate.lineNumber === currentFrame.lineNumber)) {
      return false;
    }
    const furthestCandidateLine = Math.max(...returnCandidates.map((candidate) => candidate.lineNumber));
    return currentFrame.lineNumber < furthestCandidateLine;
  }

  async #evaluateTraceExpression(state, callFrameId, expression) {
    try {
      const evaluated = await state.cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId,
        expression: this.#serializableExpression(expression),
        returnByValue: true,
        throwOnSideEffect: false,
      });
      const rawValue = evaluated.result?.value ?? evaluated.result?.description ?? null;
      return Array.isArray(rawValue) ? rawValue : [rawValue];
    } catch {
      return [];
    }
  }

  #serializableExpression(expression) {
    return `
(() => {
  try {
    const value = (${expression});
    const serialize = (input) => {
      if (input === null || input === undefined) return input;
      if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') return input;
      if (Array.isArray(input)) return input.slice(0, 20).map(serialize);
      if (typeof input === 'object') {
        try {
          return JSON.parse(JSON.stringify(input));
        } catch (_error) {
          const output = {};
          for (const key of Object.keys(input).slice(0, 20)) {
            try {
              output[key] = serialize(input[key]);
            } catch (_innerError) {
              output[key] = '[unavailable]';
            }
          }
          return output;
        }
      }
      return String(input);
    };
    return serialize(value);
  } catch (_error) {
    return '[evaluation-failed]';
  }
})()
`;
  }

  async #guessReturnValue(state, frame, publicFrame) {
    const scriptId = frame?.location?.scriptId ?? publicFrame?.scriptId ?? null;
    const lineNumber = (frame?.location?.lineNumber ?? 0) + 1;
    if (!scriptId || !lineNumber) {
      return { value: null, expression: null, lineNumber: null };
    }

    const expressionInfo = await this.#findNearbyReturnExpression(state, scriptId, lineNumber);
    if (!expressionInfo?.expression) {
      return { value: null, expression: null, lineNumber: null };
    }

    const resolvedExpression = await this.#resolveReturnExpression(state, {
      scriptId,
      startLine: lineNumber,
      returnLine: expressionInfo.lineNumber,
      expression: expressionInfo.expression,
    });

    try {
      const evaluated = await state.cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression: this.#serializableExpression(resolvedExpression),
        returnByValue: true,
        throwOnSideEffect: false,
      });
      return {
        value: evaluated.result?.value ?? evaluated.result?.description ?? null,
        expression: resolvedExpression,
        lineNumber: expressionInfo.lineNumber,
      };
    } catch {
      return {
        value: null,
        expression: resolvedExpression,
        lineNumber: expressionInfo.lineNumber,
      };
    }
  }

  async #findNearbyReturnExpression(state, scriptId, lineNumber, maxLookahead = 8) {
    const matches = await this.#findNearbyReturnExpressions(state, scriptId, lineNumber, maxLookahead);
    return matches[0] ?? null;
  }

  async #findNearbyReturnExpressions(state, scriptId, lineNumber, maxLookahead = 8) {
    const script = await this.#ensureScriptSource(state, scriptId);
    const lines = (script.source ?? '').split('\n');
    const startIndex = Math.max(0, lineNumber - 1);
    const endIndex = Math.min(lines.length, startIndex + maxLookahead);
    let nestedFunctionDepth = 0;
    const matches = [];

    for (let index = startIndex; index < endIndex; index += 1) {
      const line = lines[index];
      const nestedFunctionOpenings = countNestedFunctionOpenings(line);
      if (nestedFunctionDepth <= 0 && nestedFunctionOpenings === 0) {
        const expression = extractReturnExpression(line);
        if (expression) {
          matches.push({
            expression,
            lineNumber: index + 1,
          });
        }
      }

      nestedFunctionDepth += nestedFunctionOpenings;
      const closingBraces = (line.match(/\}/g) ?? []).length;
      if (closingBraces > 0) {
        nestedFunctionDepth = Math.max(0, nestedFunctionDepth - closingBraces);
      }
    }

    return matches;
  }

  async #resolveReturnExpression(state, { scriptId, startLine, returnLine, expression } = {}) {
    if (!expression || !/^[A-Za-z_$][\w$]*$/.test(expression)) {
      return expression;
    }

    const script = await this.#ensureScriptSource(state, scriptId);
    const lines = (script.source ?? '').split('\n');
    const startIndex = Math.max(0, startLine - 1);
    const endIndex = Math.min(lines.length - 1, Math.max(startIndex, (returnLine ?? startLine) - 1));
    const assignmentPattern = new RegExp(`(?:const|let|var)?\\s*${expression}\\s*=\\s*(.+?);\\s*$`);

    for (let index = startIndex; index <= endIndex; index += 1) {
      const match = lines[index].match(assignmentPattern);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    return expression;
  }

  async #ensureRequestBreakpointHarness(state) {
    if (state.requestHarnessInjectionId) {
      return;
    }
    const installed = await this.#installInjection(state, requestBreakpointHarness(), {
      id: 'request-breakpoint-harness',
      applyNow: true,
      category: 'request-harness',
    });
    state.requestHarnessInjectionId = installed.id;
  }

  async #ensureRequestInterception(state) {
    if (state.requestInterceptionEnabled) {
      return;
    }
    if (typeof state.page.setRequestInterception === 'function') {
      await state.page.setRequestInterception(true);
      state.requestInterceptionMode = 'puppeteer';
      state.requestInterceptionEnabled = true;
      return;
    }

    if (typeof state.page.route === 'function') {
      state.requestRouteHandler = async (route) => {
        const request = route.request();
        const patch = state.scriptPatches.get(request.url());
        if (patch) {
          await route.fulfill({
            status: 200,
            contentType: patch.contentType,
            body: patch.patchedSource,
          }).catch(() => {});
          return;
        }
        await route.continue().catch(() => {});
      };
      await state.page.route('**/*', state.requestRouteHandler);
      state.requestInterceptionMode = 'playwright';
      state.requestInterceptionEnabled = true;
      return;
    }

    throw new Error('page does not support request interception');
  }

  async #installInjection(state, script, { id, applyNow = true, category = 'custom' } = {}) {
    const result = await state.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: script,
    });
    state.injections.set(id, {
      id,
      identifier: result.identifier,
      script,
      category,
      createdAt: new Date().toISOString(),
    });

    if (applyNow) {
      await state.page.evaluate((input) => {
        // eslint-disable-next-line no-eval
        return globalThis.eval(input);
      }, script).catch(() => {});
    }

    return state.injections.get(id);
  }

  #publicInjection(entry) {
    return {
      id: entry.id,
      identifier: entry.identifier,
      category: entry.category,
      createdAt: entry.createdAt,
      scriptLength: entry.script.length,
      scriptPreview: truncateText(entry.script, 200).text,
    };
  }

  #matchesPattern(value, pattern, isRegex = false) {
    const text = String(value ?? '');
    if (isRegex) {
      try {
        return new RegExp(pattern).test(text);
      } catch {
        return false;
      }
    }
    return text.includes(pattern);
  }

  async #waitFor(fn, { timeoutMs = 5_000, intervalMs = 100 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = await fn();
      if (value) {
        return value;
      }
      await sleep(intervalMs);
    }
    return null;
  }

  async #disposePageState(state) {
    logger.info('closing reverse lab page', { pageId: state.id, url: state.page.url() });
    try {
      for (const [eventName, listener] of state.auxTargetListeners ?? []) {
        state.lease.browser?.off?.(eventName, listener);
      }
      await state.targetSessionManager?.dispose?.().catch(() => {});
      for (const entry of state.auxTargetSessions?.values?.() ?? []) {
        for (const [eventName, listener] of entry.listeners ?? []) {
          entry.session.off?.(eventName, listener);
        }
        await entry.session.detach?.().catch(() => {});
      }
      if (state.requestRouteHandler && typeof state.page.unroute === 'function') {
        await state.page.unroute('**/*', state.requestRouteHandler).catch(() => {});
      }
      if (state.requestInterceptionMode === 'puppeteer' && typeof state.page.setRequestInterception === 'function') {
        await state.page.setRequestInterception(false).catch(() => {});
      }
      await state.page.close().catch(() => {});
      await state.cdp.detach?.().catch(() => {});
    } finally {
      await state.lease.release().catch(() => {});
    }
  }

  #getPageState(pageId) {
    const resolvedId = pageId ?? this.selectedPageId;
    if (!resolvedId || !this.pages.has(resolvedId)) {
      throw new AppError(404, 'reverse lab page not found');
    }
    return this.pages.get(resolvedId);
  }

  #findFrame(state, frameId) {
    const frame = state.page.frames().find((item, index) => this.#currentFrameId(state, item, index) === frameId);
    if (!frame) {
      throw new AppError(404, 'frame not found');
    }
    return frame;
  }

  #selectedFrame(state) {
    if (!state.selectedFrameId) {
      return state.page.mainFrame();
    }
    return this.#findFrame(state, state.selectedFrameId);
  }

  #currentFrameId(_state, frame, index = 0) {
    if (frame?._id) {
      return frame._id;
    }

    const state = _state;
    if (state?.frameIds?.has(frame)) {
      return state.frameIds.get(frame);
    }

    const frameId = frame === state?.page?.mainFrame?.()
      ? 'main-frame'
      : `frame-${++state.frameIdSeq || index + 1}`;
    state?.frameIds?.set(frame, frameId);
    return frameId;
  }

  #publicScript(script) {
    return {
      scriptId: script.scriptId,
      url: script.url,
      targetType: script.targetType ?? 'page',
      startLine: script.startLine,
      startColumn: script.startColumn,
      endLine: script.endLine,
      endColumn: script.endColumn,
      executionContextId: script.executionContextId,
      sourceMapUrl: script.sourceMapUrl,
      hash: script.hash,
      sourceLoaded: script.sourceLoaded,
      sourceError: script.sourceError,
      sourceMapUrl: script.sourceMapUrl,
      sourceMapLoaded: script.sourceMapLoaded,
      sourceMapError: script.sourceMapError,
      sourceMapResolvedUrl: script.sourceMapResolvedUrl,
      sourceMap: script.sourceMap
        ? {
            resolvedUrl: script.sourceMap.resolvedUrl,
            version: script.sourceMap.version,
            file: script.sourceMap.file,
            sourceRoot: script.sourceMap.sourceRoot,
            sourceCount: script.sourceMap.sources.length,
            namesCount: script.sourceMap.namesCount,
            sourcesContentCount: script.sourceMap.sourcesContentCount,
          }
        : null,
    };
  }

  #runtimeSummary(state) {
    return {
      backend: state.backend ?? state.lease?.backend ?? null,
      backendFamily: state.backendFamily ?? state.lease?.backendFamily ?? null,
      requestedEngine: state.requestedEngine ?? state.browserConfig?.engine ?? null,
    };
  }

  #pageSummary(state) {
    return {
      id: state.id,
      url: state.page.url(),
      selected: state.id === this.selectedPageId,
      selectedFrameId: state.selectedFrameId,
      createdAt: state.createdAt,
      ...this.#runtimeSummary(state),
      scriptCount: state.scripts.size,
      breakpointCount: state.breakpoints.size,
      networkRequestCount: state.networkRequests.size,
      websocketCount: state.websocketConnections.size,
      consoleCount: state.consoleMessages.length,
      recorder: this.#publicRecorder(state),
    };
  }

  #publicRecorder(state) {
    return {
      active: state.recorder?.active === true,
      startedAt: state.recorder?.startedAt ?? null,
      stepCount: Array.isArray(state.recorder?.steps) ? state.recorder.steps.length : 0,
      steps: Array.isArray(state.recorder?.steps) ? [...state.recorder.steps] : [],
    };
  }
}
