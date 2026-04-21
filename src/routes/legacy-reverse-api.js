import { AppError } from '../core/errors.js';
import { fetchWithBrowser } from '../fetchers/browser-fetcher.js';
import { fetchWithHttp } from '../fetchers/http-fetcher.js';
import {
  extractLegacyAstPayload,
  extractLegacyFunctionParams,
  findLegacyAstFailure,
  findLegacyCalls,
  summarizeLegacyAstAnalysis,
} from '../reverse/legacy-compat.js';
import { runReverseOperation } from '../reverse/reverse-capabilities.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

function getObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function getStringValue(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function stripReverseMetadata(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const { kind, engine, ...rest } = result;
  return rest;
}

function legacyDataEnvelope(data, extras = {}) {
  return {
    success: true,
    data,
    ...extras,
    timestamp: nowIso(),
  };
}

function legacyTopLevelEnvelope(payload = {}) {
  return {
    success: true,
    ...payload,
    timestamp: nowIso(),
  };
}

function requireText(value, label) {
  const text = getStringValue(value).trim();
  if (!text) {
    throw new AppError(400, `${label} is required`);
  }
  return text;
}

function truncateText(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { text, truncated: false };
  }

  const buffer = Buffer.from(String(text ?? ''), 'utf8');
  if (buffer.length <= maxBytes) {
    return { text: String(text ?? ''), truncated: false };
  }

  return {
    text: buffer.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

function isHtmlLike(contentType, body) {
  return /html/i.test(contentType) || /<script|<html/i.test(body);
}

function extractInlineScripts(html) {
  return Array.from(html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function extractScriptUrls(html, baseUrl) {
  const urls = [];
  for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    try {
      urls.push(new URL(match[1], baseUrl).href);
    } catch {
      continue;
    }
  }
  return [...new Set(urls)];
}

function normalizeFetchMode(input = {}) {
  const explicit = getStringValue(input.fetchMode).trim().toLowerCase();
  if (explicit === 'browser' || explicit === 'http') {
    return explicit;
  }

  if (input.useBrowser === true) {
    return 'browser';
  }

  const browserConfig = getObject(input.browserConfig);
  if (Object.keys(browserConfig).length > 0 || getObject(input.session).enabled === true) {
    return 'browser';
  }

  return 'http';
}

async function fetchRemoteText(url, input = {}, { sessionStore } = {}) {
  const headers = getObject(input.headers);
  const proxy = getObject(input.proxy);
  const fetchMode = normalizeFetchMode(input);
  const request = {
    url,
    method: 'GET',
    headers,
    timeoutMs: Number(input.timeoutMs ?? 30000),
    proxy: proxy.server ? proxy : undefined,
    session: getObject(input.session),
  };
  const response = fetchMode === 'browser'
    ? await fetchWithBrowser(request, getObject(input.browserConfig), { sessionStore })
    : await fetchWithHttp(request, { sessionStore });

  return {
    url,
    finalUrl: response.finalUrl,
    status: response.status,
    contentType: response.headers['content-type'] ?? response.headers['Content-Type'] ?? 'text/plain; charset=utf-8',
    body: response.body,
    debug: response.debug ?? null,
    fetchMode,
  };
}

async function resolveSourceCode(input = {}, { includeExternalScripts = false, sessionStore } = {}) {
  const inlineCode = getStringValue(input.code).trim();
  const maxBytes = Number(input.maxBytes ?? 750_000);

  if (inlineCode) {
    const clipped = truncateText(inlineCode, maxBytes);
    return {
      code: clipped.text,
      source: {
        kind: 'inline',
        truncated: clipped.truncated,
      },
    };
  }

  const url = getStringValue(input.url).trim();
  if (!url) {
    throw new AppError(400, 'code or url is required');
  }

  const primary = await fetchRemoteText(url, input, { sessionStore });
  const source = {
    kind: 'remote',
    fetchMode: primary.fetchMode,
    requestedUrl: url,
    finalUrl: primary.finalUrl,
    status: primary.status,
    contentType: primary.contentType,
    inlineScriptCount: 0,
    externalScripts: [],
    capturedScriptCount: 0,
    truncated: false,
  };

  const fragments = [];
  const seenFragments = new Set();
  function pushFragment(text) {
    if (!text) return;
    const normalized = String(text).trim();
    if (!normalized || seenFragments.has(normalized)) {
      return;
    }
    seenFragments.add(normalized);
    fragments.push(normalized);
  }

  if (isHtmlLike(primary.contentType, primary.body)) {
    const inlineScripts = extractInlineScripts(primary.body);
    source.inlineScriptCount = inlineScripts.length;
    if (inlineScripts.length > 0) {
      for (const script of inlineScripts) {
        pushFragment(script);
      }
    }

    if (primary.fetchMode === 'browser' && Array.isArray(primary.debug?.scripts) && primary.debug.scripts.length > 0) {
      const capturedScripts = primary.debug.scripts.slice(0, Number(input.maxCapturedScripts ?? 20));
      source.capturedScriptCount = capturedScripts.length;

      for (const script of capturedScripts) {
        if (script.kind === 'external') {
          source.externalScripts.push({
            url: script.url ?? null,
            status: null,
            contentType: 'application/javascript',
            truncated: script.truncated === true,
            captured: true,
            targetType: script.targetType ?? null,
          });
        }

        if (typeof script.source === 'string' && script.source) {
          const clipped = truncateText(script.source, Math.floor(maxBytes / Math.max(1, capturedScripts.length)));
          pushFragment(clipped.text);
          source.truncated ||= clipped.truncated || script.truncated === true;
        }
      }
    }

    if (includeExternalScripts && source.externalScripts.length === 0) {
      const scriptUrls = extractScriptUrls(primary.body, primary.finalUrl).slice(0, Number(input.maxExternalScripts ?? 6));
      for (const scriptUrl of scriptUrls) {
        try {
          const script = await fetchRemoteText(scriptUrl, { ...input, fetchMode: 'http' }, { sessionStore });
          const clipped = truncateText(script.body, Math.floor(maxBytes / Math.max(1, scriptUrls.length + 1)));
          source.externalScripts.push({
            url: script.finalUrl,
            status: script.status,
            contentType: script.contentType,
            truncated: clipped.truncated,
          });
          pushFragment(clipped.text);
          source.truncated ||= clipped.truncated;
        } catch (error) {
          source.externalScripts.push({
            url: scriptUrl,
            error: error?.message ?? String(error),
          });
        }
      }
    }
  }

  if (fragments.length === 0) {
    const clipped = truncateText(primary.body, maxBytes);
    source.truncated ||= clipped.truncated;
    pushFragment(clipped.text);
  }

  return {
    code: fragments.join('\n\n'),
    source,
  };
}

function registerLegacyRoute(app, { method = 'post', path, handler }) {
  app[method](path, async (req, res, next) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      next(error);
    }
  });
}

async function runReverseBatch(items = [], { sessionStore } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(400, 'items array is required');
  }

  const normalizedItems = items.map((entry) => getObject(entry));
  const sourceConcurrency = Math.max(1, Number(normalizedItems[0]?.sourceConcurrency ?? 3));
  const operationConcurrency = Math.max(1, Number(normalizedItems[0]?.concurrency ?? 4));
  const sourceCache = new Map();

  function sourceCacheKey(item) {
    if (getStringValue(item.code).trim()) {
      return `code:${item.code}`;
    }
    const url = getStringValue(item.url).trim();
    if (!url) {
      return null;
    }
    return JSON.stringify({
      url,
      fetchMode: normalizeFetchMode(item),
      browserConfig: getObject(item.browserConfig),
      headers: getObject(item.headers),
      proxy: getObject(item.proxy),
      session: getObject(item.session),
      maxBytes: item.maxBytes ?? null,
      maxExternalScripts: item.maxExternalScripts ?? null,
      maxCapturedScripts: item.maxCapturedScripts ?? null,
    });
  }

  const uniqueResolutions = [];
  const pendingByItem = new Array(normalizedItems.length).fill(null);

  normalizedItems.forEach((item, index) => {
    const needsSourceResolution = !getStringValue(item.code).trim() && getStringValue(item.url).trim();
    if (!needsSourceResolution) {
      return;
    }

    const cacheKey = sourceCacheKey(item);
    if (!cacheKey) {
      return;
    }

    if (!sourceCache.has(cacheKey)) {
      sourceCache.set(cacheKey, { key: cacheKey, item, resolved: null, error: null });
      uniqueResolutions.push(sourceCache.get(cacheKey));
    }

    pendingByItem[index] = cacheKey;
  });

  await mapWithConcurrency(uniqueResolutions, sourceConcurrency, async (entry) => {
    try {
      entry.resolved = await resolveSourceCode(entry.item, {
        includeExternalScripts: true,
        sessionStore,
      });
    } catch (error) {
      entry.error = error?.message ?? String(error);
    }
    return entry;
  });

  const results = await mapWithConcurrency(normalizedItems, operationConcurrency, async (item, index) => {
    try {
      const resolvedEntry = pendingByItem[index] ? sourceCache.get(pendingByItem[index]) : null;
      if (resolvedEntry?.error) {
        throw new Error(resolvedEntry.error);
      }

      const resolved = resolvedEntry?.resolved ?? null;
      const result = await runReverseOperation({
        ...item,
        code: resolved?.code ?? item.code,
      });

      return {
        index,
        success: true,
        result,
        source: resolved?.source ?? null,
      };
    } catch (error) {
      return {
        index,
        success: false,
        error: error?.message ?? String(error),
      };
    }
  });

  return {
    total: results.length,
    successCount: results.filter((item) => item.success).length,
    failureCount: results.filter((item) => !item.success).length,
    items: results,
  };
}

export function getLegacyReverseApiDocs() {
  return {
    service: 'omnicrawl-legacy-compat',
    native: {
      capabilities: '/capabilities',
      reverseCapabilities: '/reverse/capabilities',
    },
    endpoints: {
      crypto: {
        analyze: 'POST /api/crypto/analyze',
        identify: 'POST /api/crypto/identify',
        encrypt: 'POST /api/crypto/encrypt',
        decrypt: 'POST /api/crypto/decrypt',
        hmac: 'POST /api/crypto/hmac',
      },
      ast: {
        extract: 'POST /api/ast/extract',
        analyze: 'POST /api/ast/analyze',
        findCalls: 'POST /api/ast/find-calls',
        extractParams: 'POST /api/ast/extract-params',
        controlFlow: 'POST /api/ast/control-flow',
        dataFlow: 'POST /api/ast/data-flow',
        obfuscation: 'POST /api/ast/obfuscation',
        callChain: 'POST /api/ast/call-chain',
        strings: 'POST /api/ast/strings',
        deobfuscate: 'POST /api/ast/deobfuscate',
        cryptoRelated: 'POST /api/ast/crypto-related',
      },
      runtime: {
        jsExecute: 'POST /api/js/execute',
        functionCall: 'POST /api/function/call',
        browserSimulate: 'POST /api/browser/simulate',
      },
      curl: {
        convert: 'POST /api/convert-curl',
        convertBatch: 'POST /api/convert-curl-batch',
      },
      reverse: {
        batch: 'POST /api/reverse/batch',
        workflow: 'POST /api/reverse/workflow',
      },
      webpack: {
        analyze: 'POST /api/webpack/analyze',
        extractModules: 'POST /api/webpack/extract-modules',
      },
      hook: {
        generate: 'POST /api/hook/generate',
        antiDetection: 'POST /api/hook/anti-detection',
        captureParams: 'POST /api/hook/capture-params',
      },
      cdp: {
        connect: 'POST /api/cdp/connect',
        disconnect: 'POST /api/cdp/disconnect',
        intercept: 'POST /api/cdp/intercept',
        requests: 'GET /api/cdp/requests',
        evaluate: 'POST /api/cdp/evaluate',
        breakpoint: 'POST /api/cdp/breakpoint',
        navigate: 'POST /api/cdp/navigate',
        cookies: 'POST /api/cdp/cookies',
      },
    },
  };
}

export function registerLegacyReverseApi(app, { sessionStore } = {}) {
  app.get('/api/docs', (_req, res) => {
    res.json(getLegacyReverseApiDocs());
  });

  registerLegacyRoute(app, {
    path: '/api/crypto/analyze',
    handler: async (req) => {
      const resolved = await resolveSourceCode(req.body, { includeExternalScripts: true, sessionStore });
      const result = await runReverseOperation({
        operation: 'crypto.analyze',
        code: resolved.code,
      });
      const data = {
        ...stripReverseMetadata(result),
        source: resolved.source,
      };
      return legacyDataEnvelope(data, {
        cryptoTypes: data.cryptoTypes,
        keys: data.keys,
        ivs: data.ivs,
        analysis: data,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/crypto/identify',
    handler: async (req) => {
      const resolved = await resolveSourceCode({
        ...req.body,
        code: getStringValue(req.body?.code).trim() || getStringValue(req.body?.output).trim(),
      }, { sessionStore });

      const result = await runReverseOperation({
        operation: 'crypto.identify',
        code: resolved.code,
      });

      return legacyDataEnvelope({
        identified: result.identified,
        count: result.count,
        source: resolved.source,
      });
    },
  });

  for (const [path, type] of [
    ['/api/crypto/encrypt', 'encrypt'],
    ['/api/crypto/decrypt', 'decrypt'],
  ]) {
    registerLegacyRoute(app, {
      path,
      handler: async (req) => {
        const algorithm = requireText(req.body?.algorithm, 'algorithm');
        const data = requireText(req.body?.data, 'data');
        const result = await runReverseOperation({
          operation: `crypto.${type}`,
          algorithm,
          data,
          key: req.body?.key,
          iv: req.body?.iv,
          mode: req.body?.mode,
          padding: req.body?.padding,
          hmacAlgorithm: req.body?.hmacAlgorithm,
        });

        return legacyDataEnvelope({
          [type === 'encrypt' ? 'encrypted' : 'decrypted']: result[type === 'encrypt' ? 'encrypted' : 'decrypted'],
          algorithm,
        });
      },
    });
  }

  registerLegacyRoute(app, {
    path: '/api/crypto/hmac',
    handler: async (req) => {
      const data = requireText(req.body?.data, 'data');
      const key = requireText(req.body?.key, 'key');
      const algorithm = getStringValue(req.body?.algorithm, 'SHA256');
      const result = await runReverseOperation({
        operation: 'crypto.hmac',
        data,
        key,
        algorithm,
      });

      return legacyDataEnvelope({
        signature: result.signature,
        algorithm,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/ast/extract',
    handler: async (req) => {
      const resolved = await resolveSourceCode(req.body, { includeExternalScripts: true, sessionStore });
      const payload = extractLegacyAstPayload(resolved.code, getObject(req.body?.options));
      const error = findLegacyAstFailure(payload);
      if (error) {
        throw new AppError(400, error);
      }
      return legacyDataEnvelope({
        ...payload,
        source: resolved.source,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/ast/analyze',
    handler: async (req) => {
      const resolved = await resolveSourceCode(req.body, { includeExternalScripts: true, sessionStore });
      const summary = summarizeLegacyAstAnalysis(resolved.code);
      return legacyTopLevelEnvelope({
        results: summary.results,
        source: resolved.source,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/ast/find-calls',
    handler: async (req) => {
      const resolved = await resolveSourceCode(req.body, { includeExternalScripts: true, sessionStore });
      const functionName = requireText(req.body?.functionName, 'functionName');
      const result = findLegacyCalls(resolved.code, functionName);
      if (result.success === false) {
        throw new AppError(400, result.error ?? 'AST call lookup failed');
      }
      return legacyDataEnvelope({
        ...result.data,
        source: resolved.source,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/ast/extract-params',
    handler: async (req) => {
      const resolved = await resolveSourceCode(req.body, { includeExternalScripts: true, sessionStore });
      const functionName = getStringValue(req.body?.functionName).trim() || undefined;
      const result = extractLegacyFunctionParams(resolved.code, functionName);
      if (result.success === false) {
        throw new AppError(400, result.error ?? 'AST parameter extraction failed');
      }
      return legacyDataEnvelope({
        ...result.data,
        source: resolved.source,
      });
    },
  });

  for (const [path, operation] of [
    ['/api/ast/control-flow', 'ast.controlFlow'],
    ['/api/ast/data-flow', 'ast.dataFlow'],
    ['/api/ast/obfuscation', 'ast.obfuscation'],
    ['/api/ast/call-chain', 'ast.callChain'],
    ['/api/ast/strings', 'ast.strings'],
    ['/api/ast/deobfuscate', 'ast.deobfuscate'],
    ['/api/ast/crypto-related', 'ast.cryptoRelated'],
  ]) {
    registerLegacyRoute(app, {
      path,
      handler: async (req) => {
        const resolved = await resolveSourceCode(req.body, { includeExternalScripts: true, sessionStore });
        const result = await runReverseOperation({
          ...getObject(req.body),
          code: resolved.code,
          operation,
        });
        return legacyDataEnvelope({
          ...stripReverseMetadata(result),
          source: resolved.source,
        });
      },
    });
  }

  registerLegacyRoute(app, {
    path: '/api/js/execute',
    handler: async (req) => {
      const result = await runReverseOperation({
        operation: 'js.execute',
        code: requireText(req.body?.code, 'code'),
        expression: req.body?.expression,
        context: getObject(req.body?.context),
        timeoutMs: req.body?.timeout ?? req.body?.timeoutMs,
      });

      return legacyTopLevelEnvelope({
        result: result.result,
        logs: result.logs,
        exports: result.exports,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/browser/simulate',
    handler: async (req) => {
      const result = await runReverseOperation({
        operation: 'browser.simulate',
        code: requireText(req.body?.code, 'code'),
        html: req.body?.html,
        browserConfig: getObject(req.body?.browserConfig),
        expression: req.body?.expression,
        timeoutMs: req.body?.timeout ?? req.body?.timeoutMs,
      });

      return legacyTopLevelEnvelope({
        result: result.result,
        cookies: result.cookies,
        logs: result.logs,
        html: result.html,
        url: result.url,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/function/call',
    handler: async (req) => {
      const result = await runReverseOperation({
        operation: 'js.invoke',
        code: requireText(req.body?.code, 'code'),
        functionName: requireText(req.body?.functionName, 'functionName'),
        args: Array.isArray(req.body?.args) ? req.body.args : [],
        context: getObject(req.body?.context),
        timeoutMs: req.body?.timeout ?? req.body?.timeoutMs,
      });

      return legacyTopLevelEnvelope({
        result: result.result,
        logs: result.logs,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/convert-curl',
    handler: async (req) => {
      const language = getStringValue(req.body?.language, 'python');
      const result = await runReverseOperation({
        operation: 'curl.convert',
        curlCommand: requireText(req.body?.curlCommand, 'curlCommand'),
        language,
      });

      return legacyTopLevelEnvelope({
        language,
        code: result.code,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/convert-curl-batch',
    handler: async (req) => {
      const result = await runReverseOperation({
        operation: 'curl.convertBatch',
        curlCommand: requireText(req.body?.curlCommand, 'curlCommand'),
        languages: Array.isArray(req.body?.languages) ? req.body.languages : undefined,
      });

      return legacyTopLevelEnvelope({
        results: result.results,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/reverse/batch',
    handler: async (req) => {
      const result = await runReverseBatch(req.body?.items, { sessionStore });
      return legacyTopLevelEnvelope(result);
    },
  });

  registerLegacyRoute(app, {
    path: '/api/reverse/workflow',
    handler: async (req) => {
      const resolved = (!getStringValue(req.body?.code).trim() && getStringValue(req.body?.url).trim())
        ? await resolveSourceCode(req.body, { includeExternalScripts: true, sessionStore })
        : null;
      const result = await runReverseOperation({
        ...getObject(req.body),
        operation: 'workflow.analyze',
        code: resolved?.code ?? req.body?.code,
      });
      return legacyDataEnvelope({
        ...result,
        source: resolved?.source ?? null,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/webpack/analyze',
    handler: async (req) => {
      const resolved = await resolveSourceCode(req.body, { includeExternalScripts: true, sessionStore });
      const result = await runReverseOperation({
        operation: 'webpack.analyze',
        code: resolved.code,
      });
      const data = {
        ...stripReverseMetadata(result),
        source: resolved.source,
      };
      return legacyTopLevelEnvelope({
        data,
        isWebpack: data.isWebpack,
        totalModules: data.moduleCount ?? data.modules?.count ?? 0,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/webpack/extract-modules',
    handler: async (req) => {
      const resolved = await resolveSourceCode(req.body, { includeExternalScripts: true, sessionStore });
      const result = await runReverseOperation({
        operation: 'webpack.extractModules',
        code: resolved.code,
        moduleId: req.body?.moduleId,
      });
      return legacyDataEnvelope({
        ...stripReverseMetadata(result),
        source: resolved.source,
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/protobuf/analyze',
    handler: async (req) => {
      const result = await runReverseOperation({
        operation: 'protobuf.analyze',
        ...getObject(req.body),
      });
      return legacyDataEnvelope(stripReverseMetadata(result));
    },
  });

  registerLegacyRoute(app, {
    path: '/api/grpc/analyze',
    handler: async (req) => {
      const result = await runReverseOperation({
        operation: 'grpc.analyze',
        ...getObject(req.body),
      });
      return legacyDataEnvelope(stripReverseMetadata(result));
    },
  });

  registerLegacyRoute(app, {
    path: '/api/app/native-plan',
    handler: async (req) => {
      const result = await runReverseOperation({
        operation: 'app.nativePlan',
        ...getObject(req.body),
      });
      return legacyDataEnvelope(stripReverseMetadata(result));
    },
  });

  registerLegacyRoute(app, {
    path: '/api/app/native-status',
    handler: async () => {
      const result = await runReverseOperation({
        operation: 'app.nativeStatus',
      });
      return legacyDataEnvelope(stripReverseMetadata(result));
    },
  });

  registerLegacyRoute(app, {
    path: '/api/hook/generate',
    handler: async (req) => {
      const result = await runReverseOperation({
        operation: 'hooks.generate',
        options: getObject(req.body),
      });

      return legacyDataEnvelope({
        hookCode: result.code,
        options: getObject(req.body),
      });
    },
  });

  registerLegacyRoute(app, {
    path: '/api/hook/anti-detection',
    handler: async () => {
      const result = await runReverseOperation({
        operation: 'hooks.antiDetection',
      });

      return legacyDataEnvelope({
        hookCode: result.code,
        description: '反检测 Hook，用于隐藏自动化特征',
      });
    },
  });

  for (const path of ['/api/hook/capture-params', '/api/hook/parameter-capture']) {
    registerLegacyRoute(app, {
      path,
      handler: async (req) => {
        const targetObject = requireText(req.body?.targetObject, 'targetObject');
        const propertyNames = Array.isArray(req.body?.propertyNames) ? req.body.propertyNames : [];
        const result = await runReverseOperation({
          operation: 'hooks.parameterCapture',
          targetObject,
          propertyNames,
        });

        return legacyDataEnvelope({
          hookCode: result.code,
          targetObject,
          propertyNames,
        });
      },
    });
  }

  for (const [path, operation] of [
    ['/api/cdp/connect', 'cdp.connect'],
    ['/api/cdp/disconnect', 'cdp.disconnect'],
    ['/api/cdp/intercept', 'cdp.intercept'],
    ['/api/cdp/evaluate', 'cdp.evaluate'],
    ['/api/cdp/breakpoint', 'cdp.breakpoint'],
    ['/api/cdp/navigate', 'cdp.navigate'],
    ['/api/cdp/cookies', 'cdp.cookies'],
  ]) {
    registerLegacyRoute(app, {
      path,
      handler: async (req) => {
        const result = await runReverseOperation({
          ...getObject(req.body),
          operation,
        });
        const data = stripReverseMetadata(result);
        return {
          success: data?.success !== false,
          ...(data?.success === false ? { error: data.error } : { data: data.data ?? data }),
          timestamp: nowIso(),
        };
      },
    });
  }

  registerLegacyRoute(app, {
    method: 'get',
    path: '/api/cdp/requests',
    handler: async (req) => {
      const result = await runReverseOperation({
        ...req.query,
        operation: 'cdp.requests',
      });
      const data = stripReverseMetadata(result);
      return {
        success: data?.success !== false,
        ...(data?.success === false ? { error: data.error } : { data: data.data ?? data }),
        timestamp: nowIso(),
      };
    },
  });
}
