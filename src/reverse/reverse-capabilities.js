import vm from 'node:vm';
import { createRequire } from 'node:module';
import { AppError } from '../core/errors.js';
import { analyzeHtmlForReverse, analyzeJavaScript, executeReverseSnippet, invokeNamedFunction } from './reverse-analyzer.js';
import { analyzeAISurface } from './ai-analysis.js';
import {
  analyzeControlFlow as analyzeAstControlFlow,
  analyzeDataFlow as analyzeAstDataFlow,
  detectObfuscation as detectAstObfuscation,
  extractAllStrings as extractAstStrings,
  extractCryptoRelated as extractAstCryptoRelated,
  extractFunctionCallChain as extractAstCallChain,
} from './advanced-ast-analyzer.js';
import {
  analyzeEncryption,
  decrypt as decryptCrypto,
  encrypt as encryptCrypto,
  extractKeysMasked,
  hmac as createHmac,
  identifyCrypto,
} from './advanced-crypto-analyzer.js';
import { analyzeBundle, extractModuleCode, extractModules } from './webpack-analyzer.js';
import { ReverseCdpDebugger } from './cdp-debugger.js';
import { executeInChromium } from './browser-runtime.js';
import { analyzeNodeProfile, deobfuscateNodeLiterals } from './node-runtime-analyzer.js';
import { buildAntiDetectionHook } from './stealth-profile.js';
import { getAvailableBrowserBackends, getBrowserBackendCatalog } from '../runtime/browser-backend.js';
// New advanced capabilities
import {
  getBrowserTLSProfile,
  calculateJA3,
  calculateJA4,
  getAvailableTLSProfiles,
} from '../fetchers/tls-fingerprint.js';
import {
  getH2BrowserProfile,
  getAvailableH2Profiles,
  getH2FingerprintSummary,
} from '../fetchers/http2-fingerprint.js';
import {
  generateMousePath,
  generateTypingEvents,
  generateScrollEvents,
  generateInteractionSequence,
  analyzeBehaviorPattern,
} from './behavior-simulation.js';
import {
  solveCaptcha,
  detectCaptcha,
  autoSolveCaptcha,
  getCaptchaBalance,
} from './captcha-solver.js';
import {
  locateSignatureFunctions,
  autoSetupSignatureRPC,
  callSignatureRPC,
} from './signature-locator.js';
import {
  getAppWebViewProfile,
  getAvailableWebViewProfiles,
  injectAppWebView,
  detectAppWebView,
} from './app-webview.js';
import {
  analyzeProtobufPayload,
  analyzeGrpcPayload,
} from './protocol-analyzer.js';
import {
  buildNativeCapturePlan,
  getNativeToolStatus,
} from './native-integration.js';

const require = createRequire(import.meta.url);
const integrationCache = new Map();
const sharedCdpDebugger = new ReverseCdpDebugger();

const CURL_LANGUAGE_MAP = {
  python: 'toPython',
  'python-http': 'toPythonHttp',
  javascript: 'toJavaScript',
  'javascript-fetch': 'toJavaScript',
  node: 'toNode',
  'node-http': 'toNodeHttp',
  'node-axios': 'toNodeAxios',
  'node-got': 'toNodeGot',
  go: 'toGo',
  java: 'toJava',
  'java-okhttp': 'toJavaOkHttp',
  'java-httpurlconnection': 'toJavaHttpUrlConnection',
  'java-jsoup': 'toJavaJsoup',
  php: 'toPhp',
  'php-guzzle': 'toPhpGuzzle',
  ruby: 'toRuby',
  rust: 'toRust',
  csharp: 'toCSharp',
  dart: 'toDart',
  swift: 'toSwift',
  kotlin: 'toKotlin',
  r: 'toR',
  lua: 'toLua',
  perl: 'toPerl',
  powershell: 'toPowershellRestMethod',
  http: 'toHTTP',
  har: 'toHarString',
  json: 'toJsonString',
};

const OPERATION_ALIASES = new Map(
  [
    ['analyze', 'analyze'],
    ['static.analyze', 'analyze'],
    ['reverse.analyze', 'analyze'],
    ['ai.analyze', 'ai.analyze'],
    ['ai.surface', 'ai.analyze'],
    ['ai.surface-analyze', 'ai.analyze'],
    ['workflow.analyze', 'workflow.analyze'],
    ['reverse.workflow', 'workflow.analyze'],
    ['signature.analyze', 'workflow.analyze'],
    ['signature.recover', 'workflow.analyze'],
    ['execute', 'js.execute'],
    ['js.execute', 'js.execute'],
    ['invoke', 'js.invoke'],
    ['js.invoke', 'js.invoke'],
    ['function.call', 'js.invoke'],
    ['crypto.analyze', 'crypto.analyze'],
    ['crypto.identify', 'crypto.identify'],
    ['crypto.encrypt', 'crypto.encrypt'],
    ['crypto.decrypt', 'crypto.decrypt'],
    ['crypto.hmac', 'crypto.hmac'],
    ['ast.control-flow', 'ast.controlFlow'],
    ['ast.controlflow', 'ast.controlFlow'],
    ['ast.controlFlow', 'ast.controlFlow'],
    ['ast.data-flow', 'ast.dataFlow'],
    ['ast.dataflow', 'ast.dataFlow'],
    ['ast.dataFlow', 'ast.dataFlow'],
    ['ast.obfuscation', 'ast.obfuscation'],
    ['ast.call-chain', 'ast.callChain'],
    ['ast.callchain', 'ast.callChain'],
    ['ast.callChain', 'ast.callChain'],
    ['ast.strings', 'ast.strings'],
    ['ast.deobfuscate', 'ast.deobfuscate'],
    ['ast.deobfuscation', 'ast.deobfuscate'],
    ['ast.crypto-related', 'ast.cryptoRelated'],
    ['ast.cryptoRelated', 'ast.cryptoRelated'],
    ['node.profile', 'node.profile'],
    ['node.runtime', 'node.profile'],
    ['node.analyze', 'node.profile'],
    ['webpack.analyze', 'webpack.analyze'],
    ['webpack.extract-modules', 'webpack.extractModules'],
    ['webpack.extractModules', 'webpack.extractModules'],
    ['browser.simulate', 'browser.simulate'],
    ['browser.execute', 'browser.execute'],
    ['browser.chromium', 'browser.execute'],
    ['curl.convert', 'curl.convert'],
    ['curl.convert-batch', 'curl.convertBatch'],
    ['curl.convertBatch', 'curl.convertBatch'],
    ['hooks.generate', 'hooks.generate'],
    ['hooks.anti-detection', 'hooks.antiDetection'],
    ['hooks.antidetection', 'hooks.antiDetection'],
    ['hooks.antiDetection', 'hooks.antiDetection'],
    ['hooks.parameter-capture', 'hooks.parameterCapture'],
    ['hooks.parametercapture', 'hooks.parameterCapture'],
    ['hooks.parameterCapture', 'hooks.parameterCapture'],
    ['cdp.connect', 'cdp.connect'],
    ['cdp.disconnect', 'cdp.disconnect'],
    ['cdp.intercept', 'cdp.intercept'],
    ['cdp.requests', 'cdp.requests'],
    ['cdp.evaluate', 'cdp.evaluate'],
    ['cdp.breakpoint', 'cdp.breakpoint'],
    ['cdp.navigate', 'cdp.navigate'],
    ['cdp.cookies', 'cdp.cookies'],
    // TLS fingerprint operations
    ['tls.profile', 'tls.profile'],
    ['tls.fingerprint', 'tls.fingerprint'],
    ['tls.ja3', 'tls.ja3'],
    ['tls.ja4', 'tls.ja4'],
    // HTTP/2 operations
    ['h2.profile', 'h2.profile'],
    ['h2.fingerprint', 'h2.fingerprint'],
    // Behavior simulation
    ['behavior.mouse', 'behavior.mouse'],
    ['behavior.typing', 'behavior.typing'],
    ['behavior.scroll', 'behavior.scroll'],
    ['behavior.sequence', 'behavior.sequence'],
    ['behavior.analyze', 'behavior.analyze'],
    // CAPTCHA operations
    ['captcha.solve', 'captcha.solve'],
    ['captcha.detect', 'captcha.detect'],
    ['captcha.balance', 'captcha.balance'],
    // Signature operations
    ['signature.locate', 'signature.locate'],
    ['signature.setup-rpc', 'signature.setupRPC'],
    ['signature.call', 'signature.call'],
    // App WebView operations
    ['app-webview.profile', 'appWebview.profile'],
    ['app-webview.list', 'appWebview.list'],
    ['app-webview.detect', 'appWebview.detect'],
    ['app.nativeplan', 'app.nativePlan'],
    ['app.native-plan', 'app.nativePlan'],
    ['app.nativestatus', 'app.nativeStatus'],
    ['app.native-status', 'app.nativeStatus'],
    // Protocol operations
    ['protobuf.analyze', 'protobuf.analyze'],
    ['protobuf.decode', 'protobuf.analyze'],
    ['grpc.analyze', 'grpc.analyze'],
    ['grpc.decode', 'grpc.analyze'],
  ].map(([key, value]) => [key.toLowerCase(), value]),
);

function loadIntegration(cacheKey, loader) {
  if (integrationCache.has(cacheKey)) {
    return integrationCache.get(cacheKey);
  }

  try {
    const value = loader();
    const loaded = {
      available: true,
      value,
      error: null,
    };
    integrationCache.set(cacheKey, loaded);
    return loaded;
  } catch (error) {
    const failed = {
      available: false,
      value: null,
      error: error?.message ?? String(error),
    };
    integrationCache.set(cacheKey, failed);
    return failed;
  }
}

function loadDependency(packageName) {
  return loadIntegration(`dependency:${packageName}`, () => require(packageName));
}

function getString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function getObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function toOperationKey(operation = 'analyze') {
  const normalized = String(operation ?? 'analyze').trim().replaceAll('_', '.').replaceAll('/', '.').toLowerCase();
  return OPERATION_ALIASES.get(normalized) ?? normalized;
}

function unwrapAnalyzerResult(result, { kind, engine }) {
  if (result?.success === false) {
    throw new AppError(400, result.error ?? 'reverse analysis failed');
  }

  if (result && typeof result === 'object' && 'data' in result) {
    return {
      kind,
      engine,
      ...result.data,
    };
  }

  return {
    kind,
    engine,
    ...(result && typeof result === 'object' ? result : { value: result }),
  };
}

function getCdpDebugger() {
  return sharedCdpDebugger;
}

function getJsdom() {
  const integration = loadDependency('jsdom');
  if (!integration.available) {
    throw new AppError(501, `browser simulation integration unavailable: ${integration.error}`);
  }

  return integration.value;
}

function getCurlConverter() {
  const integration = loadDependency('curlconverter');
  if (!integration.available) {
    throw new AppError(501, `curl conversion integration unavailable: ${integration.error}`);
  }

  return integration.value;
}

function requireCode(payload, label = 'code') {
  const code = getString(payload?.code);
  if (!code) {
    throw new AppError(400, `${label} is required`);
  }

  return code;
}

function requireFunctionName(payload) {
  const functionName = getString(payload?.functionName);
  if (!functionName) {
    throw new AppError(400, 'functionName is required');
  }

  return functionName;
}

function requireCurlCommand(payload) {
  const curlCommand = getString(payload?.curlCommand) || getString(payload?.code) || getString(payload?.input);
  if (!curlCommand) {
    throw new AppError(400, 'curlCommand is required');
  }

  return curlCommand;
}

function buildCurlResult(language, code) {
  return {
    kind: 'curl-convert',
    engine: 'curlconverter',
    language,
    code,
  };
}

function browserSimulationResult({ result, cookies, logs, html, url }) {
  return {
    kind: 'browser-simulate',
    engine: 'jsdom',
    result,
    cookies,
    logs,
    html,
    url,
  };
}

function safeIdentifier(name) {
  return String(name ?? '').replace(/[^a-zA-Z0-9_]/g, '_');
}

function generateHookCode(options = {}) {
  const {
    hookFunctions = [],
    hookMethods = [],
    hookProperties = [],
    monitorNetwork = false,
    monitorCrypto = false,
    captureConsole = false,
  } = options;

  let hookCode = `
(function() {
  'use strict';

  window.__hookedCalls__ = window.__hookedCalls__ || [];
  window.__hookedCalls__.maxSize = 10000;

  function recordCall(type, name, args, returnValue) {
    if (window.__hookedCalls__.length >= window.__hookedCalls__.maxSize) {
      window.__hookedCalls__.shift();
    }

    function getCircularReplacer() {
      var seen = new WeakSet();
      return function(_key, value) {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return undefined;
          seen.add(value);
        }
        return value;
      };
    }

    window.__hookedCalls__.push({
      type: type,
      name: name,
      args: Array.from(args).map(function(arg) {
        try {
          return JSON.stringify(arg, getCircularReplacer());
        } catch (_error) {
          return String(arg);
        }
      }),
      returnValue: returnValue,
      timestamp: Date.now(),
      stack: new Error().stack,
    });
  }
`;

  if (hookFunctions.length > 0) {
    hookCode += `
  ${hookFunctions.map((entry) => `
  (function(original) {
    if (typeof original !== 'function') return;
    window.${safeIdentifier(entry.name)} = function() {
      var args = arguments;
      var result;
      try {
        result = original.apply(this, args);
      } finally {
        recordCall('function', ${JSON.stringify(entry.name)}, args, result);
      }
      return result;
    };
  })(window.${safeIdentifier(entry.name)});
  `).join('\n')}
`;
  }

  if (hookMethods.length > 0) {
    hookCode += `
  ${hookMethods.map((entry) => `
  (function(target) {
    if (!target || typeof target[${JSON.stringify(entry.name)}] !== 'function') return;
    var original = target[${JSON.stringify(entry.name)}];
    target[${JSON.stringify(entry.name)}] = function() {
      var args = arguments;
      var result;
      try {
        result = original.apply(this, args);
      } finally {
        recordCall('method', ${JSON.stringify(entry.object)} + '.' + ${JSON.stringify(entry.name)}, args, result);
      }
      return result;
    };
  })(window[${JSON.stringify(entry.object)}]);
  `).join('\n')}
`;
  }

  if (hookProperties.length > 0) {
    hookCode += `
  ${hookProperties.map((entry) => {
    const targetObject = typeof entry === 'string' ? 'window' : entry?.object ?? 'window';
    const propertyName = typeof entry === 'string' ? entry : entry?.name;
    const targetExpression = targetObject === 'window'
      ? 'window'
      : `window[${JSON.stringify(targetObject)}]`;
    return `
  (function(target) {
    if (!target) return;
    var originalValue = target[${JSON.stringify(propertyName)}];
    Object.defineProperty(target, ${JSON.stringify(propertyName)}, {
      get: function() {
        recordCall('property.get', ${JSON.stringify(`${targetObject}.${propertyName}`)}, [], originalValue);
        return originalValue;
      },
      set: function(value) {
        recordCall('property.set', ${JSON.stringify(`${targetObject}.${propertyName}`)}, [value], value);
        originalValue = value;
      },
      configurable: true,
    });
  })(${targetExpression});
  `;
  }).join('\n')}
`;
  }

  if (monitorNetwork) {
    hookCode += `
  (function(originalFetch) {
    if (typeof originalFetch !== 'function') return;
    window.fetch = function() {
      var args = arguments;
      recordCall('network', 'fetch', args, null);
      return originalFetch.apply(this, args).then(function(response) {
        recordCall('network', 'fetch.response', [args[0]], response && response.status);
        return response;
      });
    };
  })(window.fetch);

  (function(OriginalXHR) {
    if (typeof OriginalXHR !== 'function') return;
    window.XMLHttpRequest = function() {
      var xhr = new OriginalXHR();
      var originalOpen = xhr.open;
      var originalSend = xhr.send;

      xhr.open = function() {
        recordCall('network', 'XMLHttpRequest.open', arguments, null);
        return originalOpen.apply(this, arguments);
      };

      xhr.send = function() {
        recordCall('network', 'XMLHttpRequest.send', arguments, null);
        return originalSend.apply(this, arguments);
      };

      return xhr;
    };
  })(window.XMLHttpRequest);

  (function(OriginalWebSocket) {
    if (typeof OriginalWebSocket !== 'function') return;
    window.WebSocket = function(url, protocols) {
      var socket = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
      recordCall('network', 'WebSocket.connect', [url, protocols], null);
      socket.addEventListener('message', function(event) {
        recordCall('network', 'WebSocket.message', [url], event && event.data);
      });
      var originalSend = socket.send;
      socket.send = function(payload) {
        recordCall('network', 'WebSocket.send', [url, payload], null);
        return originalSend.call(this, payload);
      };
      return socket;
    };
  })(window.WebSocket);
`;
  }

  if (monitorCrypto) {
    hookCode += `
  if (typeof CryptoJS !== 'undefined') {
    ['AES', 'DES', 'RC4', 'Rabbit', 'TripleDES'].forEach(function(algo) {
      if (!CryptoJS[algo]) return;

      if (typeof CryptoJS[algo].encrypt === 'function') {
        var originalEncrypt = CryptoJS[algo].encrypt;
        CryptoJS[algo].encrypt = function() {
          var args = Array.from(arguments);
          var result = originalEncrypt.apply(CryptoJS[algo], args);
          recordCall('crypto', algo + '.encrypt', args, result && result.toString ? result.toString() : result);
          return result;
        };
      }

      if (typeof CryptoJS[algo].decrypt === 'function') {
        var originalDecrypt = CryptoJS[algo].decrypt;
        CryptoJS[algo].decrypt = function() {
          var args = Array.from(arguments);
          var result = originalDecrypt.apply(CryptoJS[algo], args);
          recordCall('crypto', algo + '.decrypt', args, result && result.toString ? result.toString(CryptoJS.enc.Utf8) : result);
          return result;
        };
      }
    });

    ['MD5', 'SHA1', 'SHA256', 'SHA512'].forEach(function(hash) {
      if (typeof CryptoJS[hash] !== 'function') return;
      var originalHash = CryptoJS[hash];
      CryptoJS[hash] = function() {
        var args = Array.from(arguments);
        var result = originalHash.apply(CryptoJS, args);
        recordCall('crypto', hash, args, result && result.toString ? result.toString() : result);
        return result;
      };
    });
  }

  if (window.crypto && window.crypto.subtle) {
    ['digest', 'encrypt', 'decrypt', 'sign', 'verify', 'deriveBits', 'deriveKey', 'wrapKey', 'unwrapKey', 'importKey', 'exportKey'].forEach(function(name) {
      if (typeof window.crypto.subtle[name] !== 'function') return;
      var originalMethod = window.crypto.subtle[name].bind(window.crypto.subtle);
      window.crypto.subtle[name] = function() {
        var args = Array.from(arguments);
        return Promise.resolve(originalMethod.apply(window.crypto.subtle, args)).then(function(result) {
          recordCall('crypto.subtle', name, args, result && result.byteLength !== undefined ? '[ArrayBuffer:' + result.byteLength + ']' : result);
          return result;
        });
      };
    });
  }

  if (typeof WebAssembly !== 'undefined') {
    if (typeof WebAssembly.instantiate === 'function') {
      var originalInstantiate = WebAssembly.instantiate.bind(WebAssembly);
      WebAssembly.instantiate = function() {
        var args = Array.from(arguments);
        return Promise.resolve(originalInstantiate.apply(WebAssembly, args)).then(function(result) {
          var exports = result && result.instance && result.instance.exports ? Object.keys(result.instance.exports) : [];
          recordCall('wasm', 'WebAssembly.instantiate', args, exports);
          return result;
        });
      };
    }
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      var originalInstantiateStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly);
      WebAssembly.instantiateStreaming = function() {
        var args = Array.from(arguments);
        return Promise.resolve(originalInstantiateStreaming.apply(WebAssembly, args)).then(function(result) {
          var exports = result && result.instance && result.instance.exports ? Object.keys(result.instance.exports) : [];
          recordCall('wasm', 'WebAssembly.instantiateStreaming', args, exports);
          return result;
        });
      };
    }
  }
`;
  }

  if (captureConsole) {
    hookCode += `
  ['log', 'warn', 'error', 'info', 'debug'].forEach(function(method) {
    if (!console || typeof console[method] !== 'function') return;
    var original = console[method];
    console[method] = function() {
      recordCall('console', method, arguments, null);
      return original.apply(console, arguments);
    };
  });
`;
  }

  hookCode += `
  console.log('[OmniCrawlReverse] Hooks installed');
})();
`;

  return hookCode;
}

function generateAntiDetectionHook() {
  return buildAntiDetectionHook();
}

function generateParameterCaptureHook(targetObject = 'window', propertyNames = []) {
  return `
(function() {
  'use strict';

  window.__capturedParams__ = window.__capturedParams__ || [];

  function captureParam(name, value) {
    window.__capturedParams__.push({
      name: name,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value),
      timestamp: Date.now(),
    });
  }

  ${propertyNames.map((name) => `
  (function() {
    var originalValue = ${targetObject}.${name};
    Object.defineProperty(${targetObject}, ${JSON.stringify(name)}, {
      get: function() {
        captureParam(${JSON.stringify(`${targetObject}.${name}`)}, originalValue);
        return originalValue;
      },
      set: function(value) {
        captureParam(${JSON.stringify(`${targetObject}.${name}.set`)}, value);
        originalValue = value;
      },
      configurable: true,
    });
  })();
  `).join('\n')}
})();
`;
}

async function simulateBrowser(payload = {}) {
  const { JSDOM } = getJsdom();
  const code = requireCode(payload);
  const browserConfig = getObject(payload.browserConfig);
  const html = getString(payload.html, '<!doctype html><html><head></head><body></body></html>');
  const url = getString(browserConfig.url || payload.url, 'https://example.com/');
  const userAgent = getString(browserConfig.userAgent, 'Mozilla/5.0 OmniCrawlBrowserSim/1.0');
  const timeoutMs = Number(payload.timeoutMs ?? 1000);
  const logs = [];
  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
  });

  try {
    const navigator = {
      ...dom.window.navigator,
      userAgent,
      platform: getString(browserConfig.platform, 'Win32'),
      language: getString(browserConfig.language, 'zh-CN'),
    };

    const sandbox = {
      window: dom.window,
      document: dom.window.document,
      navigator,
      location: dom.window.location,
      localStorage: dom.window.localStorage,
      sessionStorage: dom.window.sessionStorage,
      console: {
        log: (...args) => logs.push({ level: 'log', args }),
        warn: (...args) => logs.push({ level: 'warn', args }),
        error: (...args) => logs.push({ level: 'error', args }),
      },
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
      btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
      setTimeout: (fn) => {
        if (typeof fn === 'function') {
          fn();
        }
        return 1;
      },
      clearTimeout: () => {},
      setInterval: (fn) => {
        if (typeof fn === 'function') {
          fn();
        }
        return 1;
      },
      clearInterval: () => {},
      ...getObject(payload.context),
    };

    sandbox.window.console = sandbox.console;
    sandbox.globalThis = sandbox;

    const runValue = vm.runInNewContext(code, sandbox, { timeout: timeoutMs });
    const expression = getString(payload.expression);
    const expressionValue = expression ? vm.runInNewContext(expression, sandbox, { timeout: timeoutMs }) : undefined;

    return browserSimulationResult({
      result: expression ? expressionValue : runValue,
      cookies: dom.window.document.cookie,
      logs,
      html: dom.serialize(),
      url: dom.window.location.href,
    });
  } finally {
    dom.window.close();
  }
}

function convertCurl(payload = {}) {
  const curlconverter = getCurlConverter();
  const curlCommand = requireCurlCommand(payload);
  const language = String(payload.language ?? 'python').trim().toLowerCase();
  const converterName = CURL_LANGUAGE_MAP[language];

  if (!converterName) {
    throw new AppError(400, `unsupported curl conversion language: ${language}`);
  }

  const converter = curlconverter[converterName];
  if (typeof converter !== 'function') {
    throw new AppError(501, `curlconverter method missing: ${converterName}`);
  }

  return buildCurlResult(language, converter(curlCommand));
}

function convertCurlBatch(payload = {}) {
  const curlconverter = getCurlConverter();
  const curlCommand = requireCurlCommand(payload);
  const languages = Array.isArray(payload.languages) && payload.languages.length > 0
    ? payload.languages.map((value) => String(value).trim().toLowerCase())
    : ['python', 'javascript', 'go', 'java'];

  const results = {};

  for (const language of languages) {
    const converterName = CURL_LANGUAGE_MAP[language];
    if (!converterName || typeof curlconverter[converterName] !== 'function') {
      results[language] = {
        success: false,
        error: 'unsupported language',
      };
      continue;
    }

    try {
      results[language] = {
        success: true,
        code: curlconverter[converterName](curlCommand),
      };
    } catch (error) {
      results[language] = {
        success: false,
        error: error?.message ?? String(error),
      };
    }
  }

  return {
    kind: 'curl-convert-batch',
    engine: 'curlconverter',
    results,
  };
}

function extractInlineScriptBlocks(html) {
  return Array.from(String(html ?? '').matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function uniqueStrings(values = [], maxItems = 50) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))].slice(0, maxItems);
}

function buildWorkflowNextSteps({ crypto, obfuscation, webpack, recommendedHooks, nodeProfile }) {
  const nextSteps = [];

  if (crypto.keys?.length || crypto.ivs?.length || crypto.signatures?.length) {
    nextSteps.push('Use crypto.encrypt/crypto.decrypt or crypto.hmac with extracted parameters to validate the signing path.');
  }

  if (obfuscation.isObfuscated || (obfuscation.indicators?.length ?? 0) > 0) {
    nextSteps.push('Run ast.deobfuscate and compare resolved strings against runtime network parameters.');
  }

  if (webpack.isWebpack) {
    nextSteps.push('Run webpack.extractModules to isolate the real signer module before instrumenting it.');
  }

  if (recommendedHooks.includes('fetch/XMLHttpRequest')) {
    nextSteps.push('Generate hooks with monitorNetwork enabled to capture request payload assembly in real time.');
  }

  if (recommendedHooks.includes('crypto')) {
    nextSteps.push('Generate hooks with monitorCrypto enabled to capture plaintext, key, IV, and signature outputs at runtime.');
  }

  if (nodeProfile?.runtime?.process?.envKeys?.length || nodeProfile?.runtime?.subprocess?.length) {
    nextSteps.push('Review node.profile output for environment-derived secrets, subprocess calls, and native-addon boundaries.');
  }

  return nextSteps.slice(0, 8);
}

export function summarizeWorkflow(payload = {}) {
  const explicitMode = getString(payload.mode, 'script');
  const html = getString(payload.html);
  const inputCode = getString(payload.code);
  const mode = explicitMode === 'html' || (!inputCode && html) ? 'html' : 'script';
  const target = getString(payload.target) || getString(payload.url) || null;
  const title = getString(payload.title) || null;
  const scriptCode = mode === 'html'
    ? extractInlineScriptBlocks(html || inputCode).join('\n\n')
    : (inputCode || html);

  if (!scriptCode && !html) {
    throw new AppError(400, 'code or html is required');
  }

  const base = mode === 'html'
    ? analyzeHtmlForReverse(html || inputCode, {
        baseUrl: getString(payload.baseUrl, target ?? undefined),
        maxInlineScripts: Number(payload.maxInlineScripts ?? 8),
      })
    : analyzeJavaScript(scriptCode, { target, title });

  const crypto = analyzeEncryption(scriptCode);
  const maskedKeys = extractKeysMasked(scriptCode);
  const controlFlow = analyzeAstControlFlow(scriptCode);
  const dataFlow = analyzeAstDataFlow(scriptCode);
  const obfuscation = detectAstObfuscation(scriptCode);
  const strings = extractAstStrings(scriptCode);
  const cryptoRelated = extractAstCryptoRelated(scriptCode);
  const deobfuscation = deobfuscateNodeLiterals(scriptCode);
  const nodeProfile = analyzeNodeProfile(scriptCode);
  const webpack = analyzeBundle(scriptCode);
  const recommendedHooks = mode === 'html'
    ? uniqueStrings(base.aggregated?.recommendedHooks ?? [])
    : uniqueStrings(base.recommendedHooks ?? []);

  const hookOptions = {
    hookProperties: uniqueStrings(
      [
        ...crypto.keys.map(() => 'key'),
        ...crypto.ivs.map(() => 'iv'),
        ...crypto.signatures.map(() => 'signature'),
      ],
      6,
    ).map((name) => ({ object: 'window', name })),
    monitorNetwork: recommendedHooks.includes('fetch/XMLHttpRequest'),
    monitorCrypto: recommendedHooks.includes('crypto'),
    captureConsole: true,
  };

  const workflowHooks = payload.includeHookCode === true
    ? {
        runtime: generateHookCode(hookOptions),
        antiDetection: generateAntiDetectionHook(),
      }
    : null;

  const nodeData = nodeProfile.success === false ? null : nodeProfile.data;
  const nextSteps = buildWorkflowNextSteps({
    crypto,
    obfuscation,
    webpack,
    recommendedHooks,
    nodeProfile: nodeData,
  });

  return {
    kind: 'workflow-analysis',
    engine: 'omnicrawl',
    mode,
    target,
    base,
    crypto: {
      ...crypto,
      maskedKeys,
    },
    ast: {
      controlFlow: controlFlow.success === false ? null : controlFlow.data,
      dataFlow: dataFlow.success === false ? null : dataFlow.data,
      obfuscation,
      strings: strings.success === false ? null : strings.data,
      cryptoRelated: cryptoRelated.success === false ? null : cryptoRelated.data,
      deobfuscation: deobfuscation.success === false ? null : deobfuscation.data,
    },
    node: nodeData,
    webpack,
    hooks: {
      recommended: recommendedHooks,
      options: hookOptions,
      generated: workflowHooks,
    },
    signatureSurfaces: {
      endpoints: uniqueStrings(mode === 'html' ? base.aggregated?.endpoints ?? [] : base.endpoints ?? [], 80),
      envKeys: uniqueStrings(nodeData?.runtime?.process?.envKeys?.map((entry) => entry.key) ?? [], 40),
      networkApis: uniqueStrings(nodeData?.runtime?.network?.map((entry) => entry.api) ?? [], 40),
      decodedStrings: uniqueStrings(deobfuscation.success === false ? [] : deobfuscation.data.decodedStrings ?? [], 80),
      suspiciousSinks: (nodeData?.risks?.suspiciousSinks ?? []).slice(0, 30),
      likelySignatureFunctions: uniqueStrings(
        (cryptoRelated.success === false ? [] : [
          ...(cryptoRelated.data.cryptoRelated ?? []).map((entry) => entry.name ?? entry.callee ?? null),
        ]),
        40,
      ),
    },
    summary: {
      likelyNodeRuntime: Boolean(nodeData?.meta?.moduleFormat && nodeData.meta.moduleFormat !== 'unknown'),
      likelyWebpackBundle: Boolean(webpack.isWebpack),
      likelySignatureFlow: crypto.cryptoTypes.length > 0 || (crypto.signatures?.length ?? 0) > 0,
      riskLevel: nodeData?.risks?.level ?? (obfuscation.isObfuscated ? 'medium' : 'low'),
      recommendedHookCount: hookOptions.hookProperties.length + Number(hookOptions.monitorNetwork) + Number(hookOptions.monitorCrypto),
    },
    nextSteps,
  };
}

export function getReverseCapabilitySnapshot() {
  const browserBackendCatalog = getBrowserBackendCatalog();
  const availableBrowserBackends = getAvailableBrowserBackends();
  const alternateBrowserBackends = availableBrowserBackends.filter((backend) => backend.name !== 'puppeteer');
  const integrations = {
    ast: { available: true, error: null },
    crypto: { available: true, error: null },
    node: { available: true, error: null },
    webpack: { available: true, error: null },
    hooks: { available: true, error: null },
    protocols: { available: true, error: null },
    nativeCapture: { available: true, error: null },
    cdp: loadDependency('chrome-remote-interface'),
    jsdom: loadDependency('jsdom'),
    curlconverter: loadDependency('curlconverter'),
    puppeteer: loadDependency('puppeteer'),
    patchright: loadDependency('patchright'),
    playwright: loadDependency('playwright'),
    'playwright-core': loadDependency('playwright-core'),
    browserAutomation: {
      available: availableBrowserBackends.length > 0,
      error: availableBrowserBackends.length > 0 ? null : 'no supported browser backend installed',
    },
  };

  return {
    basic: ['analyze', 'workflow.analyze', 'js.execute', 'js.invoke'],
    advanced: {
      ai: ['ai.analyze'],
      workflow: ['workflow.analyze'],
      crypto: ['crypto.analyze', 'crypto.identify', 'crypto.encrypt', 'crypto.decrypt', 'crypto.hmac'],
      ast: ['ast.controlFlow', 'ast.dataFlow', 'ast.obfuscation', 'ast.callChain', 'ast.strings', 'ast.deobfuscate', 'ast.cryptoRelated'],
      node: ['node.profile'],
      webpack: ['webpack.analyze', 'webpack.extractModules'],
      browser: ['browser.simulate', 'browser.execute'],
      app: ['app.nativePlan', 'app.nativeStatus', 'appWebview.profile', 'appWebview.list', 'appWebview.detect'],
      protocols: ['protobuf.analyze', 'grpc.analyze'],
      curl: ['curl.convert', 'curl.convertBatch'],
      hooks: ['hooks.generate', 'hooks.antiDetection', 'hooks.parameterCapture'],
      cdp: ['cdp.connect', 'cdp.disconnect', 'cdp.intercept', 'cdp.requests', 'cdp.evaluate', 'cdp.breakpoint', 'cdp.navigate', 'cdp.cookies'],
    },
    distributedExtractorOperations: [
      'analyze',
      'ai.analyze',
      'workflow.analyze',
      'crypto.analyze',
      'crypto.identify',
      'ast.controlFlow',
      'ast.dataFlow',
      'ast.obfuscation',
      'ast.callChain',
      'ast.strings',
      'ast.deobfuscate',
      'ast.cryptoRelated',
      'node.profile',
      'webpack.analyze',
      'webpack.extractModules',
      'browser.simulate',
      'browser.execute',
      'app.nativePlan',
      'app.nativeStatus',
      'protobuf.analyze',
      'grpc.analyze',
      'curl.convert',
      'curl.convertBatch',
      'hooks.generate',
      'hooks.antiDetection',
      'hooks.parameterCapture',
    ],
    integrations: Object.fromEntries(
      Object.entries(integrations).map(([name, integration]) => [
        name,
        {
          available: integration.available,
          error: integration.error,
        },
      ]),
    ),
    browserBackends: {
      catalog: browserBackendCatalog.map((backend) => ({
        name: backend.name,
        family: backend.family,
        packageName: backend.packageName,
        aliases: backend.aliases,
        available: backend.available,
      })),
      available: availableBrowserBackends.map((backend) => ({
        name: backend.name,
        family: backend.family,
        packageName: backend.packageName,
        aliases: backend.aliases,
      })),
      preferredDefault: availableBrowserBackends[0]?.name ?? null,
      verification: {
        readyForRealBackendAcceptance: alternateBrowserBackends.length > 0,
        alternateBackends: alternateBrowserBackends.map((backend) => ({
          name: backend.name,
          family: backend.family,
        })),
        missingAlternatePackages: ['patchright', 'playwright', 'playwright-core']
          .filter((name) => integrations[name]?.available !== true),
        blocker:
          alternateBrowserBackends.length > 0
            ? null
            : 'Install patchright, playwright, or playwright-core on this node before validating a non-puppeteer browser backend.',
      },
      debuggerSupport: {
        puppeteer: {
          workerTargets: 'full',
          auxiliaryTargets: 'full',
        },
        playwrightFamily: {
          workerTargets: 'full',
          auxiliaryTargets: 'full',
          note: 'Chromium-backed Playwright and Patchright sessions expose browser-level CDP target routing for dedicated, shared, and service worker capture.',
        },
      },
    },
  };
}

export async function runReverseOperation(payload = {}) {
  const operation = toOperationKey(payload.operation ?? 'analyze');

  switch (operation) {
    case 'analyze': {
      const mode = String(payload.mode ?? 'auto');
      const code = getString(payload.code);
      const html = getString(payload.html);
      const target = getString(payload.target) || undefined;
      const baseUrl = getString(payload.baseUrl, target);

      if (!code && !html) {
        throw new AppError(400, 'code or html is required');
      }

      return mode === 'html' || (mode === 'auto' && html)
        ? analyzeHtmlForReverse(html || code, { baseUrl })
        : analyzeJavaScript(code || html, { target, title: getString(payload.title) || null });
    }

    case 'ai.analyze':
      return analyzeAISurface(payload);

    case 'workflow.analyze':
      return summarizeWorkflow(payload);

    case 'js.execute':
      return executeReverseSnippet({
        code: requireCode(payload),
        expression: payload.expression,
        context: getObject(payload.context),
        timeoutMs: Number(payload.timeoutMs ?? 1000),
      });

    case 'js.invoke':
      return invokeNamedFunction({
        code: requireCode(payload),
        functionName: requireFunctionName(payload),
        args: Array.isArray(payload.args) ? payload.args : [],
        context: getObject(payload.context),
        timeoutMs: Number(payload.timeoutMs ?? 1000),
      });

    case 'crypto.analyze': {
      return {
        kind: 'crypto-analysis',
        engine: 'omnicrawl',
        ...analyzeEncryption(requireCode(payload)),
      };
    }

    case 'crypto.identify': {
      const identified = identifyCrypto(requireCode(payload));
      return {
        kind: 'crypto-identify',
        engine: 'omnicrawl',
        identified,
        count: identified.length,
      };
    }

    case 'crypto.encrypt': {
      const algorithm = getString(payload.algorithm);
      const data = getString(payload.data, getString(payload.code));
      if (!algorithm || !data) {
        throw new AppError(400, 'algorithm and data are required');
      }

      return {
        kind: 'crypto-encrypt',
        engine: 'omnicrawl',
        algorithm,
        encrypted: encryptCrypto({
          algorithm,
          data,
          key: payload.key,
          iv: payload.iv,
          mode: payload.mode,
          padding: payload.padding,
          hmacAlgorithm: payload.hmacAlgorithm,
        }),
      };
    }

    case 'crypto.decrypt': {
      const algorithm = getString(payload.algorithm);
      const data = getString(payload.data, getString(payload.code));
      if (!algorithm || !data) {
        throw new AppError(400, 'algorithm and data are required');
      }

      return {
        kind: 'crypto-decrypt',
        engine: 'omnicrawl',
        algorithm,
        decrypted: decryptCrypto({
          algorithm,
          data,
          key: payload.key,
          iv: payload.iv,
          mode: payload.mode,
          padding: payload.padding,
        }),
      };
    }

    case 'crypto.hmac': {
      const data = getString(payload.data, getString(payload.code));
      const key = getString(payload.key);
      if (!data || !key) {
        throw new AppError(400, 'data and key are required');
      }

      return {
        kind: 'crypto-hmac',
        engine: 'omnicrawl',
        algorithm: getString(payload.algorithm, 'SHA256'),
        signature: createHmac(data, key, payload.algorithm),
      };
    }

    case 'ast.controlFlow':
      return unwrapAnalyzerResult(analyzeAstControlFlow(requireCode(payload)), {
        kind: 'ast-control-flow',
        engine: 'omnicrawl',
      });

    case 'ast.dataFlow':
      return unwrapAnalyzerResult(analyzeAstDataFlow(requireCode(payload)), {
        kind: 'ast-data-flow',
        engine: 'omnicrawl',
      });

    case 'ast.obfuscation':
      return {
        kind: 'ast-obfuscation',
        engine: 'omnicrawl',
        ...detectAstObfuscation(requireCode(payload)),
      };

    case 'ast.callChain':
      return unwrapAnalyzerResult(extractAstCallChain(requireCode(payload), requireFunctionName(payload)), {
        kind: 'ast-call-chain',
        engine: 'omnicrawl',
      });

    case 'ast.strings':
      return unwrapAnalyzerResult(extractAstStrings(requireCode(payload)), {
        kind: 'ast-strings',
        engine: 'omnicrawl',
      });

    case 'ast.deobfuscate':
      return unwrapAnalyzerResult(deobfuscateNodeLiterals(requireCode(payload)), {
        kind: 'ast-deobfuscate',
        engine: 'omnicrawl',
      });

    case 'ast.cryptoRelated':
      return unwrapAnalyzerResult(extractAstCryptoRelated(requireCode(payload)), {
        kind: 'ast-crypto-related',
        engine: 'omnicrawl',
      });

    case 'node.profile':
      return unwrapAnalyzerResult(analyzeNodeProfile(requireCode(payload), {
        target: getString(payload.target) || getString(payload.filePath),
        maxLocalModuleDepth: Number(payload.maxLocalModuleDepth ?? 2),
      }), {
        kind: 'node-profile',
        engine: 'omnicrawl',
      });

    case 'webpack.analyze':
      return {
        kind: 'webpack-analysis',
        engine: 'omnicrawl',
        ...analyzeBundle(requireCode(payload)),
      };

    case 'webpack.extractModules': {
      const moduleId = getString(payload.moduleId);
      if (moduleId) {
        const result = extractModuleCode(requireCode(payload), moduleId);
        if (result?.success === false) {
          throw new AppError(404, result.error ?? `module not found: ${moduleId}`);
        }

        return {
          kind: 'webpack-module',
          engine: 'omnicrawl',
          ...result,
        };
      }

      return {
        kind: 'webpack-modules',
        engine: 'omnicrawl',
        ...extractModules(requireCode(payload)),
      };
    }

    case 'browser.simulate':
      return simulateBrowser(payload);

    case 'browser.execute':
      return executeInChromium(payload);

    case 'curl.convert':
      return convertCurl(payload);

    case 'curl.convertBatch':
      return convertCurlBatch(payload);

    case 'hooks.generate':
      return {
        kind: 'hooks-generate',
        engine: 'omnicrawl',
        code: generateHookCode(getObject(payload.options)),
      };

    case 'hooks.antiDetection':
      return {
        kind: 'hooks-anti-detection',
        engine: 'omnicrawl',
        code: generateAntiDetectionHook(),
      };

    case 'hooks.parameterCapture': {
      const targetObject = getString(payload.targetObject, 'window');
      const propertyNames = Array.isArray(payload.propertyNames) ? payload.propertyNames : [];
      return {
        kind: 'hooks-parameter-capture',
        engine: 'omnicrawl',
        code: generateParameterCaptureHook(targetObject, propertyNames),
      };
    }

    case 'cdp.connect':
      return {
        kind: 'cdp-connect',
        engine: 'omnicrawl',
        ...(await getCdpDebugger().connect({
          host: getString(payload.host, '127.0.0.1'),
          port: Number(payload.port ?? 9222),
          target: payload.target,
        })),
      };

    case 'cdp.disconnect':
      await getCdpDebugger().disconnect();
      return {
        kind: 'cdp-disconnect',
        engine: 'omnicrawl',
        success: true,
      };

    case 'cdp.intercept':
      return {
        kind: 'cdp-intercept',
        engine: 'omnicrawl',
        ...(await getCdpDebugger().interceptNetworkRequests(Array.isArray(payload.patterns) ? payload.patterns : [])),
      };

    case 'cdp.requests':
      return {
        kind: 'cdp-requests',
        engine: 'omnicrawl',
        ...getCdpDebugger().getInterceptedRequests(),
      };

    case 'cdp.evaluate': {
      const expression = getString(payload.expression);
      if (!expression) {
        throw new AppError(400, 'expression is required');
      }

      return {
        kind: 'cdp-evaluate',
        engine: 'omnicrawl',
        ...(await getCdpDebugger().evaluateJavaScript(expression)),
      };
    }

    case 'cdp.breakpoint': {
      const url = getString(payload.url);
      const lineNumber = Number(payload.lineNumber);
      if (!url || Number.isNaN(lineNumber)) {
        throw new AppError(400, 'url and lineNumber are required');
      }

      return {
        kind: 'cdp-breakpoint',
        engine: 'omnicrawl',
        ...(await getCdpDebugger().setBreakpoint(url, lineNumber, getString(payload.condition))),
      };
    }

    case 'cdp.navigate': {
      const url = getString(payload.url);
      if (!url) {
        throw new AppError(400, 'url is required');
      }

      return {
        kind: 'cdp-navigate',
        engine: 'omnicrawl',
        ...(await getCdpDebugger().navigateTo(url)),
      };
    }

    case 'cdp.cookies':
      return {
        kind: 'cdp-cookies',
        engine: 'omnicrawl',
        ...(await getCdpDebugger().getCookies(Array.isArray(payload.urls) ? payload.urls : [])),
      };

    // TLS Fingerprint operations
    case 'tls.profile': {
      const profileName = getString(payload.profile, 'chrome-latest');
      const profile = getBrowserTLSProfile(profileName);
      if (!profile) {
        throw new AppError(400, `Unknown TLS profile: ${profileName}`);
      }
      return {
        kind: 'tls-profile',
        engine: 'omnicrawl',
        profile: profile.name,
        ciphers: profile.ciphers,
        extensions: profile.extensions,
        groups: profile.groups,
      };
    }

    case 'tls.fingerprint': {
      const profileName = getString(payload.profile, 'chrome-latest');
      const profile = getBrowserTLSProfile(profileName);
      if (!profile) {
        throw new AppError(400, `Unknown TLS profile: ${profileName}`);
      }
      const ja3 = calculateJA3({
        tlsVersion: profile.tlsMaxVersion,
        ciphers: profile.ciphers,
        extensions: profile.extensions,
        groups: profile.groups,
        ecPointFormats: profile.ecPointFormats,
      });
      const ja4 = calculateJA4({
        tlsVersion: profile.tlsMaxVersion,
        alpn: profile.alpn,
        ciphers: profile.ciphers,
        extensions: profile.extensions,
      });
      return {
        kind: 'tls-fingerprint',
        engine: 'omnicrawl',
        profile: profile.name,
        ja3,
        ja4,
      };
    }

    case 'tls.ja3': {
      const profileName = getString(payload.profile, 'chrome-latest');
      const profile = getBrowserTLSProfile(profileName);
      return {
        kind: 'tls-ja3',
        engine: 'omnicrawl',
        ja3: profile ? calculateJA3({
          tlsVersion: profile.tlsMaxVersion,
          ciphers: profile.ciphers,
          extensions: profile.extensions,
          groups: profile.groups,
        }) : null,
      };
    }

    case 'tls.ja4': {
      const profileName = getString(payload.profile, 'chrome-latest');
      const profile = getBrowserTLSProfile(profileName);
      return {
        kind: 'tls-ja4',
        engine: 'omnicrawl',
        ja4: profile ? calculateJA4({
          tlsVersion: profile.tlsMaxVersion,
          alpn: profile.alpn,
          ciphers: profile.ciphers,
          extensions: profile.extensions,
        }) : null,
      };
    }

    // HTTP/2 operations
    case 'h2.profile': {
      const profileName = getString(payload.profile, 'chrome-latest');
      const profile = getH2BrowserProfile(profileName);
      if (!profile) {
        throw new AppError(400, `Unknown H2 profile: ${profileName}`);
      }
      return {
        kind: 'h2-profile',
        engine: 'omnicrawl',
        profile: profile.name,
        settings: profile.settings,
        pseudoHeaderOrder: profile.pseudoHeaderOrder,
      };
    }

    case 'h2.fingerprint': {
      const profileName = getString(payload.profile, 'chrome-latest');
      const profile = getH2BrowserProfile(profileName);
      return {
        kind: 'h2-fingerprint',
        engine: 'omnicrawl',
        ...getH2FingerprintSummary(profile),
      };
    }

    // Behavior simulation
    case 'behavior.mouse': {
      const start = getObject(payload.start, { x: 0, y: 0 });
      const end = getObject(payload.end, { x: 100, y: 100 });
      return {
        kind: 'behavior-mouse',
        engine: 'omnicrawl',
        path: generateMousePath(start, end, getObject(payload.options)),
      };
    }

    case 'behavior.typing': {
      const text = getString(payload.text, '');
      return {
        kind: 'behavior-typing',
        engine: 'omnicrawl',
        events: generateTypingEvents(text, getObject(payload.options)),
      };
    }

    case 'behavior.scroll': {
      const maxScroll = Number(payload.maxScroll ?? 3000);
      return {
        kind: 'behavior-scroll',
        engine: 'omnicrawl',
        events: generateScrollEvents(maxScroll, getObject(payload.options)),
      };
    }

    case 'behavior.sequence': {
      return {
        kind: 'behavior-sequence',
        engine: 'omnicrawl',
        events: generateInteractionSequence(getObject(payload.page), getObject(payload.options)),
      };
    }

    case 'behavior.analyze': {
      const events = Array.isArray(payload.events) ? payload.events : [];
      return {
        kind: 'behavior-analysis',
        engine: 'omnicrawl',
        ...analyzeBehaviorPattern(events),
      };
    }

    // CAPTCHA operations
    case 'captcha.solve': {
      return {
        kind: 'captcha-solve',
        engine: 'omnicrawl',
        ...(await solveCaptcha(getObject(payload.options))),
      };
    }

    case 'captcha.balance': {
      return {
        kind: 'captcha-balance',
        engine: 'omnicrawl',
        balance: await getCaptchaBalance(getObject(payload.options)),
      };
    }

    // Signature operations
    case 'signature.locate': {
      const code = getString(payload.code, '');
      return {
        kind: 'signature-locate',
        engine: 'omnicrawl',
        ...locateSignatureFunctions(code, getObject(payload.options)),
      };
    }

    case 'signature.setupRPC': {
      const code = getString(payload.code, '');
      return {
        kind: 'signature-setup-rpc',
        engine: 'omnicrawl',
        ...(await autoSetupSignatureRPC(code, getObject(payload.options))),
      };
    }

    case 'signature.call': {
      const url = getString(payload.url);
      if (!url) {
        throw new AppError(400, 'RPC URL is required');
      }
      return {
        kind: 'signature-call',
        engine: 'omnicrawl',
        signature: await callSignatureRPC(url, getObject(payload.params)),
      };
    }

    // App WebView operations
    case 'appWebview.profile': {
      const appName = getString(payload.app);
      const profile = getAppWebViewProfile(appName);
      if (!profile) {
        throw new AppError(400, `Unknown app profile: ${appName}`);
      }
      return {
        kind: 'app-webview-profile',
        engine: 'omnicrawl',
        profile: profile.name,
        userAgent: profile.userAgent,
        jsBridge: profile.jsBridge,
      };
    }

    case 'appWebview.list':
      return {
        kind: 'app-webview-list',
        engine: 'omnicrawl',
        profiles: getAvailableWebViewProfiles(),
      };

    case 'appWebview.detect':
      return {
        kind: 'app-webview-detect',
        engine: 'omnicrawl',
        note: 'Call detectAppWebView(page) from app-webview.js module',
      };

    case 'app.nativePlan':
      return {
        engine: 'omnicrawl',
        ...buildNativeCapturePlan(getObject(payload.app), {
          toolStatus: payload.toolStatus && typeof payload.toolStatus === 'object' ? payload.toolStatus : undefined,
        }),
      };

    case 'app.nativeStatus':
      return {
        kind: 'app-native-status',
        engine: 'omnicrawl',
        tools: getNativeToolStatus(),
      };

    case 'protobuf.analyze': {
      const data = payload.data ?? payload.payload ?? payload.body ?? payload.code;
      if (data === undefined || data === null) {
        throw new AppError(400, 'data is required');
      }
      return {
        engine: 'omnicrawl',
        ...(await analyzeProtobufPayload(data, {
          encoding: getString(payload.encoding, 'base64'),
          assumeBase64: payload.assumeBase64 !== false,
          descriptorPaths: Array.isArray(payload.descriptorPaths) ? payload.descriptorPaths : [],
          messageType: getString(payload.messageType) || null,
          maxDepth: Number(payload.maxDepth ?? 2),
        })),
      };
    }

    case 'grpc.analyze': {
      const data = payload.data ?? payload.payload ?? payload.body ?? payload.code;
      if (data === undefined || data === null) {
        throw new AppError(400, 'data is required');
      }
      return {
        engine: 'omnicrawl',
        ...(await analyzeGrpcPayload(data, {
          encoding: getString(payload.encoding, 'base64'),
          assumeBase64: payload.assumeBase64 !== false,
          descriptorPaths: Array.isArray(payload.descriptorPaths) ? payload.descriptorPaths : [],
          path: getString(payload.path),
          direction: getString(payload.direction, 'request'),
          maxDepth: Number(payload.maxDepth ?? 2),
        })),
      };
    }

    default:
      throw new AppError(400, `unknown reverse operation: ${operation}`);
  }
}
