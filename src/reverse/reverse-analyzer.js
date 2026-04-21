import vm from 'node:vm';
import esprima from 'esprima';
import estraverse from 'estraverse';
import { hashText } from '../utils/hash.js';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function collectMatches(input, pattern, projector = (match) => match[0], limit = 100) {
  return unique(Array.from(input.matchAll(pattern)).map(projector)).slice(0, limit);
}

function collectCount(input, pattern) {
  return Array.from(input.matchAll(pattern)).length;
}

function printableRatio(value) {
  if (!value) {
    return 0;
  }

  let printable = 0;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13) {
      printable += 1;
    }
  }
  return printable / value.length;
}

function decodeBase64Candidates(input) {
  const literals = collectMatches(input, /["'`]([A-Za-z0-9+/]{16,}={0,2})["'`]/g, (match) => match[1], 40);
  const decoded = [];

  for (const literal of literals) {
    try {
      const value = Buffer.from(literal, 'base64').toString('utf8');
      if (value && printableRatio(value) >= 0.7) {
        decoded.push({
          encoded: literal,
          decoded: value.slice(0, 200),
        });
      }
    } catch {
      continue;
    }
  }

  return decoded.slice(0, 20);
}

function decodeEscapedRuns(input, pattern, transform) {
  return collectMatches(input, pattern, (match) => match[0], 30).map((encoded) => ({
    encoded,
    decoded: transform(encoded).slice(0, 200),
  }));
}

function decodeHexEscapes(input) {
  return decodeEscapedRuns(input, /(?:\\x[0-9a-fA-F]{2}){3,}/g, (encoded) =>
    encoded.replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16))),
  );
}

function decodeUnicodeEscapes(input) {
  return decodeEscapedRuns(input, /(?:\\u[0-9a-fA-F]{4}){2,}/g, (encoded) =>
    encoded.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16))),
  );
}

function firstTitle(html) {
  return html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null;
}

function getScriptBlocks(html, baseUrl) {
  const external = collectMatches(
    html,
    /<script[^>]+src=["']([^"']+)["'][^>]*>/gi,
    (match) => {
      try {
        return new URL(match[1], baseUrl).href;
      } catch {
        return match[1];
      }
    },
    100,
  );

  const inline = collectMatches(
    html,
    /<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi,
    (match) => match[1].trim(),
    30,
  );

  return { external, inline };
}

function buildSandbox(context = {}) {
  const logs = [];
  const consoleApi = {
    log: (...args) => logs.push({ level: 'log', args }),
    warn: (...args) => logs.push({ level: 'warn', args }),
    error: (...args) => logs.push({ level: 'error', args }),
  };

  const storageFactory = () => {
    const store = new Map();
    return {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(String(key), String(value));
      },
      removeItem(key) {
        store.delete(String(key));
      },
      clear() {
        store.clear();
      },
    };
  };

  class ReverseWorkerStub extends EventTarget {
    constructor(url = '', options = {}) {
      super();
      this.url = String(url);
      this.options = options;
      this.onmessage = null;
      this.onerror = null;
      this.messages = [];
      this.terminated = false;
    }

    postMessage(message) {
      if (this.terminated) {
        return;
      }
      this.messages.push(message);
      const event = { data: message, target: this };
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: message }));
        if (typeof this.onmessage === 'function') {
          this.onmessage(event);
        }
      });
    }

    terminate() {
      this.terminated = true;
    }
  }

  class ReverseWebSocketStub extends EventTarget {
    constructor(url = '', protocols = []) {
      super();
      this.url = String(url);
      this.protocols = Array.isArray(protocols) ? protocols : [protocols].filter(Boolean);
      this.readyState = 1;
      this.bufferedAmount = 0;
      this.sentFrames = [];
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      queueMicrotask(() => {
        this.dispatchEvent(new Event('open'));
        if (typeof this.onopen === 'function') {
          this.onopen({ target: this });
        }
      });
    }

    send(payload) {
      if (this.readyState !== 1) {
        throw new Error('WebSocket is not open');
      }
      this.sentFrames.push(payload);
    }

    close(code = 1000, reason = '') {
      this.readyState = 3;
      const event = { code, reason, target: this };
      const CloseEventCtor = globalThis.CloseEvent ?? Event;
      this.dispatchEvent(new CloseEventCtor('close', { code, reason }));
      if (typeof this.onclose === 'function') {
        this.onclose(event);
      }
    }
  }

  const documentApi = {
    cookie: '',
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    referrer: '',
    createElement(tagName = 'div') {
      return {
        tagName: String(tagName).toUpperCase(),
        style: {},
        dataset: {},
        children: [],
        attributes: new Map(),
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        setAttribute(name, value) {
          this.attributes.set(String(name), String(value));
        },
        getAttribute(name) {
          return this.attributes.get(String(name)) ?? null;
        },
        getContext() {
          return null;
        },
        remove() {},
      };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };

  const navigatorApi = {
    userAgent: 'OmniCrawlReverseLab/1.0',
    platform: 'Win32',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en-US'],
    vendor: 'OpenAI OmniCrawl',
    hardwareConcurrency: 8,
    deviceMemory: 8,
  };

  const locationApi = {
    href: 'https://example.com/',
    origin: 'https://example.com',
    protocol: 'https:',
    host: 'example.com',
    hostname: 'example.com',
    pathname: '/',
    search: '',
    hash: '',
    assign(value) {
      this.href = String(value);
    },
    replace(value) {
      this.href = String(value);
    },
    reload() {},
  };

  const sandbox = {
    console: consoleApi,
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    File: globalThis.File,
    crypto: globalThis.crypto,
    fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
    structuredClone: globalThis.structuredClone,
    performance: globalThis.performance,
    queueMicrotask,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    CustomEvent: globalThis.CustomEvent,
    MessageChannel: globalThis.MessageChannel,
    MessagePort: globalThis.MessagePort,
    MessageEvent: globalThis.MessageEvent,
    CloseEvent: globalThis.CloseEvent,
    DOMException: globalThis.DOMException,
    WebAssembly,
    Worker: ReverseWorkerStub,
    SharedWorker: ReverseWorkerStub,
    WebSocket: ReverseWebSocketStub,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    module: { exports: {} },
    exports: {},
    window: {},
    self: {},
    globalThis: {},
    document: documentApi,
    navigator: navigatorApi,
    location: locationApi,
    localStorage: storageFactory(),
    sessionStorage: storageFactory(),
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
    setImmediate: globalThis.setImmediate ?? ((fn, ...args) => setTimeout(() => fn(...args), 0)),
    clearImmediate: globalThis.clearImmediate ?? (() => {}),
    ...context,
  };

  const runtimeWindow = {
    ...sandbox.window,
    document: sandbox.document,
    navigator: sandbox.navigator,
    location: sandbox.location,
    localStorage: sandbox.localStorage,
    sessionStorage: sandbox.sessionStorage,
    atob: sandbox.atob,
    btoa: sandbox.btoa,
    crypto: sandbox.crypto,
    fetch: sandbox.fetch,
    Headers: sandbox.Headers,
    Request: sandbox.Request,
    Response: sandbox.Response,
    FormData: sandbox.FormData,
    Blob: sandbox.Blob,
    File: sandbox.File,
    AbortController: sandbox.AbortController,
    AbortSignal: sandbox.AbortSignal,
    Event: sandbox.Event,
    EventTarget: sandbox.EventTarget,
    CustomEvent: sandbox.CustomEvent,
    MessageChannel: sandbox.MessageChannel,
    MessagePort: sandbox.MessagePort,
    MessageEvent: sandbox.MessageEvent,
    DOMException: sandbox.DOMException,
    performance: sandbox.performance,
    structuredClone: sandbox.structuredClone,
    queueMicrotask: sandbox.queueMicrotask,
    WebAssembly: sandbox.WebAssembly,
    Worker: sandbox.Worker,
    SharedWorker: sandbox.SharedWorker,
    WebSocket: sandbox.WebSocket,
    console: sandbox.console,
  };

  sandbox.window = runtimeWindow;
  sandbox.self = runtimeWindow;
  sandbox.globalThis = runtimeWindow;
  sandbox.document.defaultView = runtimeWindow;
  sandbox.window.window = runtimeWindow;
  sandbox.window.self = runtimeWindow;
  sandbox.window.globalThis = runtimeWindow;
  sandbox.window.top = runtimeWindow;
  sandbox.window.parent = runtimeWindow;
  sandbox.window.document = sandbox.document;
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.location = sandbox.location;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.sessionStorage = sandbox.sessionStorage;
  sandbox.window.module = sandbox.module;
  sandbox.window.exports = sandbox.exports;

  return { sandbox, logs };
}

function syncSandboxGlobals(sandbox) {
  if (!sandbox || typeof sandbox !== 'object') {
    return sandbox;
  }

  for (const source of [sandbox.globalThis, sandbox.window, sandbox.self]) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    for (const [key, value] of Object.entries(source)) {
      if (['window', 'self', 'globalThis'].includes(key)) {
        continue;
      }
      if (!(key in sandbox)) {
        sandbox[key] = value;
      } else if (sandbox[key] !== value && typeof sandbox[key] !== 'function') {
        sandbox[key] = value;
      }
    }
  }

  return sandbox;
}

function serializeValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth > 3) {
    return '[MaxDepth]';
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => serializeValue(entry, depth + 1));
  }

  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, 40)) {
    output[key] = serializeValue(entry, depth + 1);
  }
  return output;
}

function compileSignalBuckets(source) {
  const buckets = {
    crypto: [
      /\bCryptoJS\b/g,
      /\bAES\b/g,
      /\bDES\b/g,
      /\bRSA\b/g,
      /\bHmacSHA(?:1|256|512)\b/g,
      /\bMD5\b/g,
      /\bSHA(?:1|256|512)\b/g,
      /\bSubtleCrypto\b/g,
      /\bcrypto\.subtle\b/g,
    ],
    encoding: [/\batob\(/g, /\bbtoa\(/g, /\bfromCharCode\b/g, /\bTextEncoder\b/g, /\bTextDecoder\b/g, /\bbase64\b/gi],
    obfuscation: [/\beval\(/g, /\bFunction\(/g, /_0x[a-f0-9]+/gi, /\\x[0-9a-fA-F]{2}/g, /\\u[0-9a-fA-F]{4}/g],
    antiDebug: [/\bdebugger\b/g, /\bdevtools\b/gi, /\bconsole\.clear\b/g, /\btoString\(\)\b/g, /\bouterWidth\b/g, /\bouterHeight\b/g],
    antiAutomation: [/\bwebdriver\b/g, /\bnavigator\.plugins\b/g, /\bnavigator\.languages\b/g, /\bcanvas\b/gi, /\bwebgl\b/gi, /\bfingerprint\b/gi],
    envAccess: [/\bwindow\./g, /\bdocument\./g, /\bnavigator\./g, /\blocation\./g, /\blocalStorage\b/g, /\bsessionStorage\b/g, /\bindexedDB\b/g],
    transport: [/\bfetch\(/g, /\bXMLHttpRequest\b/g, /\baxios\./g, /\bWebSocket\b/g, /\bEventSource\b/g, /\bsendBeacon\b/g],
    bundlers: [/\b__webpack_require__\b/g, /\bwebpackJsonp\b/g, /\bparcelRequire\b/g, /\bSystem\.register\b/g, /\bdefine\(/g, /\bmodule\.exports\b/g, /\bexport\s+(?:function|const|class)\b/g],
    serialization: [/\bJSON\.parse\b/g, /\bJSON\.stringify\b/g, /\bURLSearchParams\b/g, /\bFormData\b/g],
  };

  return Object.fromEntries(
    Object.entries(buckets).map(([bucket, patterns]) => [
      bucket,
      unique(patterns.flatMap((pattern) => collectMatches(source, pattern, (match) => match[0], 30))),
    ]),
  );
}

function analyzeMetrics(source) {
  const longStrings = collectMatches(source, /["'`]([^"'`]{80,})["'`]/g, (match) => match[1], 40);
  return {
    bytes: Buffer.byteLength(source),
    lineCount: source.split(/\r?\n/).length,
    functionCount: collectCount(source, /\bfunction\b/g) + collectCount(source, /=>/g),
    classCount: collectCount(source, /\bclass\s+[A-Za-z_$]/g),
    evalCount: collectCount(source, /\beval\(/g),
    debuggerCount: collectCount(source, /\bdebugger\b/g),
    fetchCount: collectCount(source, /\bfetch\(/g),
    xhrCount: collectCount(source, /\bXMLHttpRequest\b/g),
    longStringCount: longStrings.length,
  };
}

function analyzeNames(source) {
  return {
    functions: collectMatches(source, /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g, (match) => match[1], 80),
    assignedFunctions: collectMatches(source, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g, (match) => match[1], 80),
    classes: collectMatches(source, /\bclass\s+([A-Za-z_$][\w$]*)/g, (match) => match[1], 40),
    exports: unique([
      ...collectMatches(source, /\bexports\.([A-Za-z_$][\w$]*)\s*=/g, (match) => match[1], 80),
      ...collectMatches(source, /\bexport\s+(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g, (match) => match[1], 80),
      ...collectMatches(source, /\bmodule\.exports\s*=\s*{([^}]+)}/g, (match) => match[1], 20)
        .flatMap((entry) => entry.split(',').map((part) => part.split(':')[0].trim())),
    ]).slice(0, 80),
  };
}

function analyzeEndpoints(source) {
  return unique([
    ...collectMatches(source, /https?:\/\/[^\s"'`<>]+/g, (match) => match[0], 100),
    ...collectMatches(source, /\/(?:api|graphql)\/[A-Za-z0-9/_?&=.-]+/g, (match) => match[0], 100),
    ...collectMatches(source, /["'`](\/(?:api|graphql)[^"'`]*)["'`]/g, (match) => match[1], 100),
  ]).slice(0, 120);
}

function nodeLabel(node) {
  if (!node) {
    return null;
  }

  switch (node.type) {
    case 'Identifier':
      return node.name;

    case 'Literal':
      return typeof node.value === 'string' ? node.value : String(node.value);

    case 'ThisExpression':
      return 'this';

    case 'Super':
      return 'super';

    case 'MemberExpression': {
      const objectName = nodeLabel(node.object);
      const propertyName = node.computed ? nodeLabel(node.property) : node.property?.name;
      return objectName && propertyName ? `${objectName}.${propertyName}` : objectName ?? propertyName ?? null;
    }

    case 'CallExpression':
      return nodeLabel(node.callee);

    default:
      return null;
  }
}

function collectPatternNames(pattern) {
  if (!pattern) {
    return [];
  }

  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];

    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        property.type === 'Property'
          ? collectPatternNames(property.value)
          : property.type === 'RestElement'
            ? collectPatternNames(property.argument)
            : [],
      );

    case 'ArrayPattern':
      return pattern.elements.flatMap((element) => collectPatternNames(element));

    case 'RestElement':
      return collectPatternNames(pattern.argument);

    case 'AssignmentPattern':
      return collectPatternNames(pattern.left);

    default:
      return [];
  }
}

function namedFunction(node, parent) {
  if (!node) {
    return null;
  }

  if (node.id?.name) {
    return node.id.name;
  }

  if (parent?.type === 'VariableDeclarator') {
    return parent.id?.name ?? null;
  }

  if (parent?.type === 'AssignmentExpression') {
    return nodeLabel(parent.left);
  }

  if (parent?.type === 'Property') {
    return parent.key?.name ?? nodeLabel(parent.key);
  }

  return null;
}

function parseAst(source) {
  const commonOptions = {
    comment: true,
    loc: true,
    range: true,
    tolerant: true,
    jsx: true,
  };

  try {
    return {
      mode: 'module',
      ast: esprima.parseModule(source, commonOptions),
      error: null,
    };
  } catch (moduleError) {
    try {
      return {
        mode: 'script',
        ast: esprima.parseScript(source, commonOptions),
        error: null,
      };
    } catch (scriptError) {
      return {
        mode: 'unparsed',
        ast: null,
        error: scriptError?.message ?? moduleError?.message ?? 'AST parse failed',
      };
    }
  }
}

function analyzeAst(source) {
  const parsed = parseAst(source);

  if (!parsed.ast) {
    return {
      mode: parsed.mode,
      ok: false,
      error: parsed.error,
    };
  }

  const imports = [];
  const requires = [];
  const exports = [];
  const topLevel = [];
  const functions = [];
  const memberAccesses = [];
  const callExpressions = [];
  const callGraph = [];
  const objectKeys = [];
  const stringLiterals = [];
  const stats = {
    loopCount: 0,
    conditionalCount: 0,
    tryCatchCount: 0,
    awaitCount: 0,
    returnCount: 0,
  };

  const functionStack = ['<top>'];

  estraverse.traverse(parsed.ast, {
    enter(node, parent) {
      if (parent === parsed.ast) {
        if (node.type === 'ImportDeclaration') {
          imports.push({
            source: node.source.value,
            specifiers: node.specifiers.map((specifier) => specifier.local?.name ?? null).filter(Boolean),
          });
        }

        if (node.type === 'ExportNamedDeclaration') {
          if (node.declaration?.type === 'VariableDeclaration') {
            exports.push(
              ...node.declaration.declarations.flatMap((declaration) =>
                collectPatternNames(declaration.id).map((name) => ({ name, type: 'export-named' })),
              ),
            );
          } else if (node.declaration?.id?.name) {
            exports.push({ name: node.declaration.id.name, type: 'export-named' });
          }
        }

        if (node.type === 'ExportDefaultDeclaration') {
          exports.push({ name: nodeLabel(node.declaration) ?? 'default', type: 'export-default' });
        }

        if (node.type === 'FunctionDeclaration' && node.id?.name) {
          topLevel.push({ kind: 'function', name: node.id.name });
        }

        if (node.type === 'ClassDeclaration' && node.id?.name) {
          topLevel.push({ kind: 'class', name: node.id.name });
        }

        if (node.type === 'VariableDeclaration') {
          topLevel.push(
            ...node.declarations.flatMap((declaration) =>
              collectPatternNames(declaration.id).map((name) => ({ kind: 'variable', name })),
            ),
          );
        }
      }

      if (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression'
      ) {
        const name = namedFunction(node, parent) ?? `<anonymous:${functions.length + 1}>`;
        functions.push({
          name,
          async: Boolean(node.async),
          generator: Boolean(node.generator),
          params: node.params.flatMap((param) => collectPatternNames(param)),
          loc: node.loc
            ? {
                start: node.loc.start.line,
                end: node.loc.end.line,
              }
            : null,
        });
        functionStack.push(name);
      }

      if (node.type === 'CallExpression') {
        const callee = nodeLabel(node.callee);
        if (callee) {
          callExpressions.push(callee);
          callGraph.push({
            from: functionStack[functionStack.length - 1] ?? '<top>',
            to: callee,
          });
        }

        if (callee === 'require' && node.arguments[0]?.type === 'Literal') {
          requires.push({
            source: node.arguments[0].value,
          });
        }
      }

      if (node.type === 'AssignmentExpression') {
        const left = nodeLabel(node.left);
        if (left && (left.startsWith('exports.') || left.startsWith('module.exports'))) {
          exports.push({
            name: left.replace(/^module\.exports\.?/, '').replace(/^exports\./, '') || 'module.exports',
            type: 'commonjs',
          });
        }
      }

      if (node.type === 'MemberExpression') {
        const label = nodeLabel(node);
        if (label) {
          memberAccesses.push(label);
        }
      }

      if (node.type === 'Property') {
        const key = node.computed ? nodeLabel(node.key) : node.key?.name ?? nodeLabel(node.key);
        if (key) {
          objectKeys.push(key);
        }
      }

      if (node.type === 'Literal' && typeof node.value === 'string') {
        stringLiterals.push(node.value);
      }

      if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement' || node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
        stats.loopCount += 1;
      }

      if (node.type === 'IfStatement' || node.type === 'ConditionalExpression' || node.type === 'SwitchStatement') {
        stats.conditionalCount += 1;
      }

      if (node.type === 'TryStatement') {
        stats.tryCatchCount += 1;
      }

      if (node.type === 'AwaitExpression') {
        stats.awaitCount += 1;
      }

      if (node.type === 'ReturnStatement') {
        stats.returnCount += 1;
      }
    },
    leave(node) {
      if (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression'
      ) {
        functionStack.pop();
      }
    },
  });

  return {
    mode: parsed.mode,
    ok: true,
    imports: imports.slice(0, 60),
    requires: requires.slice(0, 60),
    exports: unique(exports.map((item) => `${item.type}:${item.name}`)).map((value) => {
      const [type, ...rest] = value.split(':');
      return { type, name: rest.join(':') };
    }),
    topLevel: unique(topLevel.map((item) => `${item.kind}:${item.name}`)).map((value) => {
      const [kind, ...rest] = value.split(':');
      return { kind, name: rest.join(':') };
    }),
    functions: functions.slice(0, 80),
    calls: unique(callExpressions).slice(0, 120),
    callGraph: unique(callGraph.map((edge) => `${edge.from}->${edge.to}`)).slice(0, 160).map((value) => {
      const [from, to] = value.split('->');
      return { from, to };
    }),
    memberAccesses: unique(memberAccesses).slice(0, 120),
    objectKeys: unique(objectKeys).slice(0, 120),
    stringLiterals: unique(stringLiterals).slice(0, 80),
    stats,
    parseError: null,
  };
}

function analyzeRecommendedHooks(signalBuckets) {
  const hooks = [];

  if (signalBuckets.envAccess.some((value) => value.includes('window'))) hooks.push('window');
  if (signalBuckets.envAccess.some((value) => value.includes('document'))) hooks.push('document');
  if (signalBuckets.envAccess.some((value) => value.includes('navigator'))) hooks.push('navigator');
  if (signalBuckets.envAccess.some((value) => value.includes('location'))) hooks.push('location');
  if (signalBuckets.envAccess.some((value) => value.includes('localStorage'))) hooks.push('localStorage');
  if (signalBuckets.envAccess.some((value) => value.includes('sessionStorage'))) hooks.push('sessionStorage');
  if (signalBuckets.crypto.length > 0) hooks.push('crypto');
  if (signalBuckets.encoding.length > 0) hooks.push('atob/btoa');
  if (signalBuckets.transport.length > 0) hooks.push('fetch/XMLHttpRequest');

  return unique(hooks);
}

export function analyzeJavaScript(source, options = {}) {
  const signalBuckets = compileSignalBuckets(source);
  const metrics = analyzeMetrics(source);
  const names = analyzeNames(source);
  const endpoints = analyzeEndpoints(source);
  const ast = analyzeAst(source);

  const score =
    signalBuckets.crypto.length * 3 +
    signalBuckets.obfuscation.length * 4 +
    signalBuckets.antiDebug.length * 4 +
    signalBuckets.antiAutomation.length * 3 +
    signalBuckets.transport.length * 2 +
    metrics.debuggerCount * 3 +
    metrics.evalCount * 3;

  return {
    kind: 'javascript',
    target: options.target ?? null,
    meta: {
      hash: hashText(source),
      bytes: metrics.bytes,
      lineCount: metrics.lineCount,
      title: options.title ?? null,
    },
    metrics,
    names,
    endpoints,
    strings: {
      base64: decodeBase64Candidates(source),
      hexEscapes: decodeHexEscapes(source),
      unicodeEscapes: decodeUnicodeEscapes(source),
    },
    ast,
    signals: signalBuckets,
    recommendedHooks: analyzeRecommendedHooks(signalBuckets),
    score,
  };
}

export function analyzeHtmlForReverse(html, options = {}) {
  const { external, inline } = getScriptBlocks(html, options.baseUrl);
  const inlineAnalyses = inline.slice(0, options.maxInlineScripts ?? 8).map((script, index) =>
    analyzeJavaScript(script, {
      target: `${options.baseUrl ?? 'inline'}#inline-${index + 1}`,
      title: firstTitle(html),
    }),
  );

  return {
    kind: 'html',
    target: options.baseUrl ?? null,
    meta: {
      hash: hashText(html),
      bytes: Buffer.byteLength(html),
      lineCount: html.split(/\r?\n/).length,
      title: firstTitle(html),
    },
    scripts: {
      external,
      inlineCount: inline.length,
      inlineAnalyses,
    },
    aggregated: {
      endpoints: unique(inlineAnalyses.flatMap((item) => item.endpoints)).slice(0, 120),
      cryptoSignals: unique(inlineAnalyses.flatMap((item) => item.signals.crypto)).slice(0, 40),
      obfuscationSignals: unique(inlineAnalyses.flatMap((item) => item.signals.obfuscation)).slice(0, 40),
      antiDebugSignals: unique(inlineAnalyses.flatMap((item) => item.signals.antiDebug)).slice(0, 40),
      antiAutomationSignals: unique(inlineAnalyses.flatMap((item) => item.signals.antiAutomation)).slice(0, 40),
      recommendedHooks: unique(inlineAnalyses.flatMap((item) => item.recommendedHooks)).slice(0, 40),
      maxScore: Math.max(0, ...inlineAnalyses.map((item) => item.score)),
    },
  };
}

export function executeReverseSnippet({ code, expression, context = {}, timeoutMs = 1000 }) {
  const { sandbox, logs } = buildSandbox(context);
  vm.runInNewContext(code, sandbox, { timeout: timeoutMs });
  syncSandboxGlobals(sandbox);

  const result =
    expression
      ? vm.runInNewContext(expression, sandbox, { timeout: timeoutMs })
      : sandbox.module.exports && Object.keys(sandbox.module.exports).length > 0
        ? sandbox.module.exports
        : sandbox.exports;

  return {
    kind: 'execute',
    logs,
    result: serializeValue(result),
    exports: serializeValue(sandbox.module.exports),
  };
}

export function invokeNamedFunction({ code, functionName, args = [], context = {}, timeoutMs = 1000 }) {
  const { sandbox, logs } = buildSandbox(context);
  vm.runInNewContext(code, sandbox, { timeout: timeoutMs });
  syncSandboxGlobals(sandbox);

  const target =
    sandbox[functionName] ??
    sandbox.module.exports?.[functionName] ??
    sandbox.exports?.[functionName] ??
    sandbox.window?.[functionName];

  if (typeof target !== 'function') {
    throw new Error(`Function not found: ${functionName}`);
  }

  const result = target(...args);

  return {
    kind: 'invoke',
    functionName,
    args: serializeValue(args),
    logs,
    result: serializeValue(result),
  };
}
