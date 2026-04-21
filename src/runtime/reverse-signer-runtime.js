import vm from 'node:vm';
import { createRequire } from 'node:module';
import { hashText } from '../utils/hash.js';
import { readObjectPath } from '../utils/replay-template.js';
import {
  locateSignatureFunctions,
  extractFunctionWithDependencies,
  generateRPCWrapper,
  callSignatureRPC,
} from '../reverse/signature-locator.js';

const require = createRequire(import.meta.url);

function seedStorage(storage, values = {}) {
  if (!storage || !values || typeof values !== 'object') {
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    try {
      storage.setItem(key, value);
    } catch {
      continue;
    }
  }
}

function defineMutableGlobal(target, key, value) {
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
  } catch {
    try {
      target[key] = value;
    } catch {
      // Ignore non-configurable globals that already point at a usable value.
    }
  }
}

function createSignerEnvironment(options = {}) {
  const jsdom = require('jsdom');
  const { JSDOM } = jsdom;
  const url = options.url ?? 'https://example.com/';
  const html = options.html ?? '<!doctype html><html><body></body></html>';
  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const navigatorDescriptors = {
    userAgent: options.userAgent ?? 'OmniCrawlSignerRuntime/1.0',
    platform: options.platform ?? 'Win32',
    language: options.language ?? 'zh-CN',
    languages: options.languages ?? ['zh-CN', 'zh', 'en-US'],
    hardwareConcurrency: Number(options.hardwareConcurrency ?? 8),
  };

  for (const [key, value] of Object.entries(navigatorDescriptors)) {
    Object.defineProperty(window.navigator, key, {
      configurable: true,
      get: () => value,
    });
  }

  defineMutableGlobal(window, 'crypto', globalThis.crypto);
  defineMutableGlobal(window, 'fetch', typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
  defineMutableGlobal(window, 'atob', window.atob ?? ((value) => Buffer.from(String(value), 'base64').toString('binary')));
  defineMutableGlobal(window, 'btoa', window.btoa ?? ((value) => Buffer.from(String(value), 'binary').toString('base64')));
  defineMutableGlobal(window, 'Buffer', Buffer);
  defineMutableGlobal(window, 'process', process);
  defineMutableGlobal(window, 'require', require);
  defineMutableGlobal(window, 'console', console);
  defineMutableGlobal(window, 'globalThis', window);
  defineMutableGlobal(window, 'window', window);
  defineMutableGlobal(window, 'self', window);

  seedStorage(window.localStorage, options.localStorage);
  seedStorage(window.sessionStorage, options.sessionStorage);

  if (typeof options.cookie === 'string' && options.cookie) {
    for (const part of options.cookie.split(';')) {
      const cookie = part.trim();
      if (!cookie) continue;
      try {
        window.document.cookie = cookie;
      } catch {
        continue;
      }
    }
  }

  if (options.extraGlobals && typeof options.extraGlobals === 'object') {
    for (const [key, value] of Object.entries(options.extraGlobals)) {
      window[key] = value;
    }
  }

  return {
    context: window,
    cleanup: () => {
      window.close();
    },
  };
}

function resolveContextPath(context, path) {
  if (!path) {
    return undefined;
  }

  const normalized = String(path);
  if (normalized.startsWith('request.')) {
    return readObjectPath(context.request, normalized.slice('request.'.length));
  }
  if (normalized.startsWith('replay.')) {
    return readObjectPath(context.replayState, normalized.slice('replay.'.length));
  }
  if (normalized.startsWith('userData.')) {
    return readObjectPath(context.userData, normalized.slice('userData.'.length));
  }
  if (normalized.startsWith('metadata.')) {
    return readObjectPath(context.metadata, normalized.slice('metadata.'.length));
  }
  if (normalized.startsWith('response.')) {
    return readObjectPath(context.response, normalized.slice('response.'.length));
  }

  return readObjectPath(context.replayState, normalized)
    ?? readObjectPath(context.userData, normalized)
    ?? readObjectPath(context.metadata, normalized)
    ?? readObjectPath(context.request, normalized);
}

function buildSignerParams(mapping = {}, context = {}) {
  const params = {};
  for (const [key, path] of Object.entries(mapping ?? {})) {
    params[key] = resolveContextPath(context, path);
  }
  return params;
}

export function buildSignerArtifactFromCode(code, config = {}) {
  const located = locateSignatureFunctions(code, {
    functionName: config.functionName,
    paramName: config.paramName,
    maxCandidates: config.maxCandidates ?? 5,
  });

  const candidates = Array.isArray(located?.candidates) ? located.candidates : [];
  const selectedCandidate = candidates.find((candidate) => Number(candidate.score ?? 0) >= Number(config.minScore ?? 20)) ?? candidates[0] ?? null;
  if (!selectedCandidate) {
    return null;
  }

  const extracted = extractFunctionWithDependencies(code, selectedCandidate);
  const rpc = generateRPCWrapper(extracted, {
    port: config.rpcPort ?? 9527,
    endpoint: config.rpcEndpoint ?? '/sign',
  });

  return {
    source: config.source ?? 'responseBody',
    assetHash: hashText(code),
    selectedCandidate,
    located,
    extracted,
    rpc,
    functionName: extracted.name,
    params: extracted.params,
    invocationTarget: extracted.invocationTarget ?? extracted.name,
  };
}

export async function evaluateSignerArtifact(artifactDocument, params = {}, options = {}) {
  const artifact = artifactDocument?.payload ?? artifactDocument;
  if (!artifact?.extracted?.runtimeCode) {
    throw new Error('signer artifact runtime code is missing');
  }

  const environment = artifact.extracted?.environment ?? artifact.environment ?? {};
  const { context, cleanup } = createSignerEnvironment({
    url: options.url ?? 'https://example.com/',
    html: options.html,
    cookie: options.cookie,
    localStorage: options.localStorage,
    sessionStorage: options.sessionStorage,
    userAgent: options.userAgent,
    platform: options.platform,
    language: options.language,
    languages: options.languages,
    hardwareConcurrency: options.hardwareConcurrency,
    extraGlobals: {
      __OMNICRAWL_SIGNER_ENVIRONMENT: environment,
      ...(options.extraGlobals ?? {}),
    },
  });
  context.__params = params;

  for (const entry of artifact.extracted.importBindings ?? []) {
    if (entry.imported) {
      context[entry.local] = require(entry.source)[entry.imported];
    } else {
      context[entry.local] = require(entry.source);
    }
  }

  const invocationTarget = artifact.invocationTarget ?? artifact.functionName;
  const expression = `
    (async () => {
      ${artifact.extracted.runtimeCode}
      const args = ${JSON.stringify(artifact.params ?? [])}.map((key) => __params[key]);
      return await ${invocationTarget}(...args);
    })()
  `;

  try {
    return await vm.runInNewContext(expression, context, {
      timeout: Number(options.timeoutMs ?? 2000),
    });
  } finally {
    cleanup();
  }
}

export async function captureSignerArtifactFromResponse(response, config = {}, assetStore) {
  const sources = Array.isArray(config.capture?.sources) ? config.capture.sources : ['responseBody'];
  const candidates = [];

  if (sources.includes('responseBody') && typeof response?.body === 'string' && response.body.trim()) {
    candidates.push({
      source: 'responseBody',
      code: response.body,
    });
  }

  if (sources.includes('debugScripts')) {
    for (const script of response?.debug?.scripts ?? []) {
      const code = script.source ?? script.content ?? script.contentPreview ?? script.sourcePreview ?? null;
      if (typeof code === 'string' && code.trim()) {
        candidates.push({
          source: 'debugScripts',
          code,
          url: script.url ?? null,
        });
      }
    }
  }

  for (const candidate of candidates.slice(0, Number(config.capture?.maxScripts ?? 10))) {
    const artifact = buildSignerArtifactFromCode(candidate.code, {
      ...config,
      source: candidate.source,
    });
    if (!artifact) {
      continue;
    }

    const assetId = config.assetId ?? config.workflowName ?? 'default-signer';
    const record = await assetStore.recordSignerArtifact(assetId, {
      ...artifact,
      sourceUrl: candidate.url ?? null,
    });

    return {
      assetId,
      versionId: record.versionId,
      artifact: record.payload,
    };
  }

  return null;
}

export async function applySignerInjectionToRequest(request, signerConfig = {}, assetStore, context = {}) {
  if (signerConfig?.enabled !== true || signerConfig?.inject?.enabled !== true) {
    return null;
  }

  const injectConfig = signerConfig.inject ?? {};
  const params = buildSignerParams(injectConfig.params, {
    request,
    replayState: request.replayState ?? {},
    userData: request.userData ?? {},
    metadata: request.metadata ?? {},
    response: context.response ?? null,
  });

  let signatureValue;
  if (injectConfig.mode === 'rpc') {
    const rpcUrl = injectConfig.rpcUrl ?? signerConfig.inject?.rpcUrl;
    if (!rpcUrl) {
      throw new Error('signer rpcUrl is required for rpc injection mode');
    }
    signatureValue = await callSignatureRPC(rpcUrl, params);
  } else {
    const assetId = signerConfig.assetId ?? signerConfig.workflowName ?? 'default-signer';
    const artifact = await assetStore.getSignerArtifact(assetId);
    if (!artifact) {
      throw new Error(`signer artifact not found: ${assetId}`);
    }
    signatureValue = await evaluateSignerArtifact(artifact, params, {
      timeoutMs: signerConfig.timeoutMs ?? 2000,
      url: context.response?.finalUrl ?? context.response?.url ?? request.url,
      html: typeof context.response?.body === 'string' ? context.response.body : undefined,
      cookie: request.headers?.cookie ?? request.headers?.Cookie ?? '',
      localStorage: context.replayState?.localStorage ?? {},
      sessionStorage: context.replayState?.sessionStorage ?? {},
      userAgent: request.headers?.['user-agent'] ?? request.headers?.['User-Agent'] ?? undefined,
    });
  }

  const targetName = injectConfig.name ?? 'x-signature';
  if (injectConfig.location === 'query') {
    const url = new URL(request.url);
    url.searchParams.set(targetName, String(signatureValue));
    request.url = url.href;
  } else if (injectConfig.location === 'body') {
    if (injectConfig.template) {
      request.body = injectConfig.template.replace(/\{\{\s*value\s*\}\}/g, String(signatureValue));
    } else {
      const prefix = request.body ? `${request.body}&` : '';
      request.body = `${prefix}${encodeURIComponent(targetName)}=${encodeURIComponent(String(signatureValue))}`;
    }
  } else if (injectConfig.location === 'cookie') {
    request.headers = request.headers ?? {};
    const existing = request.headers.cookie ? `${request.headers.cookie}; ` : '';
    request.headers.cookie = `${existing}${targetName}=${signatureValue}`;
  } else {
    request.headers = request.headers ?? {};
    request.headers[targetName] = String(signatureValue);
  }

  return {
    name: targetName,
    value: String(signatureValue),
    location: injectConfig.location ?? 'header',
    params,
  };
}
