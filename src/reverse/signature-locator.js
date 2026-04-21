/**
 * Signature Function Auto-Locator and RPC Module
 *
 * Uses AST data flow analysis to automatically locate signature generation
 * functions and exposes them as local HTTP RPC endpoints for crawler use.
 *
 * Workflow:
 * 1. Parse JavaScript bundle
 * 2. Identify crypto-related functions
 * 3. Trace data flow to find sign() function
 * 4. Extract function code and dependencies
 * 5. Generate RPC wrapper for signature generation
 */

import * as babelParser from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { analyzeDataFlow as analyzeAstDataFlow } from './advanced-ast-analyzer.js';
import { analyzeEncryption } from './advanced-crypto-analyzer.js';

const traverseAst = traverse.default ?? traverse;

function parseSource(code) {
  return babelParser.parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['estree', 'classProperties', 'dynamicImport', 'jsx', 'typescript'],
  });
}

function codeSlice(code, node) {
  if (!node || typeof node.start !== 'number' || typeof node.end !== 'number') {
    return '';
  }
  return code.slice(node.start, node.end);
}

function extractFunctionRuntimeCode(targetPath, code) {
  if (targetPath.isFunctionDeclaration()) {
    return codeSlice(code, targetPath.node);
  }

  const parentPath = targetPath.parentPath;
  if (!parentPath) {
    return codeSlice(code, targetPath.node);
  }

  if (parentPath.isVariableDeclarator()) {
    return codeSlice(code, parentPath.parentPath?.node ?? parentPath.node);
  }

  if (parentPath.isAssignmentExpression()) {
    return codeSlice(code, parentPath.parentPath?.node ?? parentPath.node);
  }

  if (parentPath.isObjectProperty() || parentPath.isObjectMethod()) {
    return codeSlice(code, parentPath.parentPath?.parentPath?.node ?? parentPath.node);
  }

  return codeSlice(code, targetPath.node);
}

function inferInvocationTarget(targetPath, code, fallbackName) {
  if (targetPath.isFunctionDeclaration()) {
    return fallbackName;
  }

  const parentPath = targetPath.parentPath;
  if (!parentPath) {
    return fallbackName;
  }

  if (parentPath.isVariableDeclarator() && t.isIdentifier(parentPath.node.id)) {
    return parentPath.node.id.name;
  }

  if (parentPath.isAssignmentExpression()) {
    return codeSlice(code, parentPath.node.left) || fallbackName;
  }

  if ((parentPath.isObjectProperty() || parentPath.isObjectMethod()) && t.isIdentifier(parentPath.node.key)) {
    return parentPath.node.key.name;
  }

  return fallbackName;
}

function collectReferencedGlobals(node) {
  const globals = new Set();
  const wrapped = t.file(t.program([t.expressionStatement(
    t.isFunction(node) ? t.toExpression(node) : node,
  )]));
  traverseAst(wrapped, {
    noScope: true,
    MemberExpression(path) {
      const object = path.node.object;
      if (!t.isIdentifier(object)) return;
      if (['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'crypto', 'process'].includes(object.name)) {
        globals.add(object.name);
      }
    },
    Identifier(path) {
      if (['Buffer', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'WebAssembly', 'fetch', 'atob', 'btoa'].includes(path.node.name)) {
        globals.add(path.node.name);
      }
    },
  });
  return [...globals];
}

function buildEnvironmentHints(globals = []) {
  const needs = new Set(globals);
  const browser = ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'crypto', 'fetch', 'atob', 'btoa']
    .some((name) => needs.has(name));
  const node = ['process', 'Buffer'].some((name) => needs.has(name));
  return {
    browser,
    node,
    needs: [...needs].sort(),
  };
}

function buildTopLevelRegistry(ast, code) {
  const registry = {
    imports: new Map(),
    declarations: new Map(),
  };

  for (const statement of ast.program.body) {
    if (t.isImportDeclaration(statement)) {
      for (const specifier of statement.specifiers) {
        if (t.isImportDefaultSpecifier(specifier) || t.isImportNamespaceSpecifier(specifier)) {
          registry.imports.set(specifier.local.name, {
            source: statement.source.value,
            imported: null,
            kind: 'import',
            code: codeSlice(code, statement),
          });
          continue;
        }

        if (t.isImportSpecifier(specifier)) {
          registry.imports.set(specifier.local.name, {
            source: statement.source.value,
            imported: t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value,
            kind: 'import',
            code: codeSlice(code, statement),
          });
        }
      }
      continue;
    }

    if (t.isFunctionDeclaration(statement) && statement.id?.name) {
      registry.declarations.set(statement.id.name, {
        name: statement.id.name,
        kind: 'function',
        code: codeSlice(code, statement),
        node: statement,
      });
      continue;
    }

    if (t.isClassDeclaration(statement) && statement.id?.name) {
      registry.declarations.set(statement.id.name, {
        name: statement.id.name,
        kind: 'class',
        code: codeSlice(code, statement),
        node: statement,
      });
      continue;
    }

    if (t.isVariableDeclaration(statement)) {
      for (const declaration of statement.declarations) {
        if (!t.isIdentifier(declaration.id)) continue;
        registry.declarations.set(declaration.id.name, {
          name: declaration.id.name,
          kind: 'variable',
          code: codeSlice(code, statement),
          node: statement,
        });
      }
      continue;
    }
  }

  return registry;
}

function inferFunctionNameFromParent(parent) {
  if (!parent) return '<anonymous>';
  if (parent.id?.name) return parent.id.name;
  if (parent.property?.name) return parent.property.name;
  if (t.isAssignmentExpression(parent) && t.isMemberExpression(parent.left)) {
    if (t.isIdentifier(parent.left.property)) return parent.left.property.name;
    if (t.isStringLiteral(parent.left.property)) return parent.left.property.value;
  }
  if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
    return parent.id.name;
  }
  return '<anonymous>';
}

function findTargetFunctionPath(ast, candidate) {
  let targetPath = null;
  traverseAst(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === candidate.name && (path.node.loc?.start?.line ?? 0) === candidate.line) {
        targetPath = path;
        path.stop();
      }
    },
    FunctionExpression(path) {
      const parent = path.parent;
      const name = inferFunctionNameFromParent(parent);
      if (name === candidate.name && (path.node.loc?.start?.line ?? 0) === candidate.line) {
        targetPath = path;
        path.stop();
      }
    },
    ArrowFunctionExpression(path) {
      const parent = path.parent;
      const name = inferFunctionNameFromParent(parent);
      if (name === candidate.name && (path.node.loc?.start?.line ?? 0) === candidate.line) {
        targetPath = path;
        path.stop();
      }
    },
  });
  return targetPath;
}

function collectClosureDependencies(targetPath, registry) {
  const locals = new Set(Object.keys(targetPath.scope.bindings));
  const closureBindings = new Set();
  const imports = new Map();

  targetPath.traverse({
    Identifier(path) {
      if (!path.isReferencedIdentifier()) return;
      const { name } = path.node;
      if (locals.has(name)) return;

      const binding = path.scope.getBinding(name);
      if (!binding) return;
      if (binding.scope === targetPath.scope) return;

      if (registry.imports.has(name)) {
        imports.set(name, registry.imports.get(name));
        return;
      }

      if (registry.declarations.has(name)) {
        closureBindings.add(name);
      }
    },
  });

  const helpers = [];
  const queue = [...closureBindings];
  const seen = new Set();

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const declaration = registry.declarations.get(name);
    if (!declaration) continue;
    helpers.push(declaration);

    try {
      const helperAst = parseSource(declaration.code);
      traverseAst(helperAst, {
        Identifier(path) {
          if (!path.isReferencedIdentifier()) return;
          const refName = path.node.name;
          if (registry.imports.has(refName)) {
            imports.set(refName, registry.imports.get(refName));
            return;
          }
          if (registry.declarations.has(refName) && !seen.has(refName) && refName !== name) {
            queue.push(refName);
          }
        },
      });
    } catch {
      continue;
    }
  }

  return {
    helpers,
    imports: [...imports.entries()].map(([local, detail]) => ({ local, ...detail })),
  };
}

/**
 * Analyze JavaScript code to locate signature generation functions
 * @param {string} code - JavaScript source code
 * @param {Object} options - Analysis options
 * @returns {Array} Candidate signature functions
 */
export function locateSignatureFunctions(code, options = {}) {
  const {
    functionName = null, // Known function name to search for
    paramName = null,    // Known parameter name
    returnType = null,   // Expected return type ('string', 'base64', 'hex')
    maxCandidates = 10,
  } = options;

  const candidates = [];

  // Parse AST
  let ast;
  try {
    ast = babelParser.parse(code, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      plugins: ['estree', 'classProperties'],
    });
  } catch {
    return { error: 'Failed to parse JavaScript', candidates: [] };
  }

  // Get crypto analysis results
  const cryptoAnalysis = analyzeEncryption(code);

  // Get data flow analysis
  let dataFlow;
  try {
    dataFlow = analyzeAstDataFlow(code);
  } catch {
    dataFlow = { success: false };
  }

  // Find all function declarations and expressions
  const functions = [];
  traverseAst(ast, {
    FunctionDeclaration(path) {
      functions.push({
        type: 'FunctionDeclaration',
        name: path.node.id?.name ?? '<anonymous>',
        params: path.node.params.map((p) => p.name ?? '<destructured>'),
        start: path.node.loc?.start?.line ?? 0,
        end: path.node.loc?.end?.line ?? 0,
        path,
      });
    },
    FunctionExpression(path) {
      const parent = path.parent;
      const name = inferFunctionNameFromParent(parent);
      functions.push({
        type: 'FunctionExpression',
        name,
        params: path.node.params.map((p) => p.name ?? '<destructured>'),
        start: path.node.loc?.start?.line ?? 0,
        end: path.node.loc?.end?.line ?? 0,
        path,
      });
    },
    ArrowFunctionExpression(path) {
      const parent = path.parent;
      const name = inferFunctionNameFromParent(parent);
      functions.push({
        type: 'ArrowFunctionExpression',
        name,
        params: path.node.params.map((p) => p.name ?? '<destructured>'),
        start: path.node.loc?.start?.line ?? 0,
        end: path.node.loc?.end?.line ?? 0,
        path,
      });
    },
  });

  // Score each function based on signature-like characteristics
  for (const fn of functions) {
    let score = 0;
    const indicators = [];

    const fnCode = code.split('\n').slice(fn.start - 1, fn.end).join('\n');

    // Check for crypto API usage
    if (fnCode.includes('CryptoJS') || fnCode.includes('crypto.')) {
      score += 30;
      indicators.push('uses crypto API');
    }

    // Check for common signature function names
    const sigNames = ['sign', 'signature', 'encrypt', 'hash', 'md5', 'sha', 'aes', 'token', 'auth', 'verify'];
    const fnNameLower = fn.name.toLowerCase();
    for (const sigName of sigNames) {
      if (fnNameLower.includes(sigName)) {
        score += 25;
        indicators.push(`name contains "${sigName}"`);
        break;
      }
    }

    // Check for string return (common for signatures)
    if (fnCode.includes('toString()') || fnCode.includes('.join(')) {
      score += 15;
      indicators.push('string conversion');
    }

    // Check for hex/base64 encoding
    if (fnCode.includes('toString(16)') || fnCode.includes('btoa') || fnCode.includes('Buffer.from')) {
      score += 20;
      indicators.push('hex/base64 encoding');
    }

    // Check for string concatenation (parameter assembly)
    const concatCount = (fnCode.match(/\+/g) ?? []).length;
    if (concatCount > 3) {
      score += 10;
      indicators.push(`parameter assembly (${concatCount} concatenations)`);
    }

    // Check for known crypto patterns
    if (fnCode.includes('HMAC') || fnCode.includes('AES') || fnCode.includes('RSA')) {
      score += 20;
      indicators.push('crypto algorithm detected');
    }

    // Check if function appears in crypto analysis results
    if (cryptoAnalysis.signatures?.some((s) => s.name === fn.name || s.callee === fn.name)) {
      score += 40;
      indicators.push('identified by crypto analysis');
    }

    // Filter by known function name
    if (functionName && fn.name.toLowerCase().includes(functionName.toLowerCase())) {
      score += 50;
      indicators.push(`matches target function name "${functionName}"`);
    }

    // Filter by known parameter name
    if (paramName && fn.params.includes(paramName)) {
      score += 20;
      indicators.push(`has parameter "${paramName}"`);
    }

    // Check for return value analysis
    if (fnCode.includes('return ') && fnCode.split('return ').length > 1) {
      const returnStmts = fnCode.match(/return\s+[^;]+;/g) ?? [];
      for (const stmt of returnStmts) {
        if (returnType === 'hex' && stmt.includes('toString(16)')) score += 10;
        if (returnType === 'base64' && stmt.includes('btoa')) score += 10;
        if (returnType === 'string' && stmt.includes('toString()')) score += 10;
      }
    }

    if (score > 0) {
      candidates.push({
        name: fn.name,
        type: fn.type,
        line: fn.start,
        endLine: fn.end,
        params: fn.params,
        score,
        indicators,
        code: fnCode,
      });
    }
  }

  // Sort by score and limit
  candidates.sort((a, b) => b.score - a.score);
  return {
    candidates: candidates.slice(0, maxCandidates),
    totalFound: candidates.length,
    cryptoAnalysis,
    dataFlow: dataFlow.success ? dataFlow.data : null,
  };
}

/**
 * Extract function code with all its dependencies
 * @param {string} code - Full source code
 * @param {Object} candidate - Candidate function info
 * @returns {Object} Extracted function with dependencies
 */
export function extractFunctionWithDependencies(code, candidate) {
  const ast = parseSource(code);
  const targetPath = findTargetFunctionPath(ast, candidate);
  if (!targetPath) {
    return {
      code: candidate.code ?? '',
      runtimeCode: candidate.code ?? '',
      dependencies: [],
      importBindings: [],
      helperDeclarations: [],
      closureBindings: [],
      globals: [],
      environment: buildEnvironmentHints([]),
      params: candidate.params,
      name: candidate.name,
    };
  }

  const registry = buildTopLevelRegistry(ast, code);
  const functionCode = extractFunctionRuntimeCode(targetPath, code);
  const invocationTarget = inferInvocationTarget(targetPath, code, candidate.name);
  const closure = collectClosureDependencies(targetPath, registry);
  const globals = collectReferencedGlobals(targetPath.node);
  const runtimeSegments = [
    ...closure.helpers.map((entry) => entry.code),
    functionCode,
  ].filter(Boolean);

  return {
    code: functionCode,
    runtimeCode: runtimeSegments.join('\n\n'),
    dependencies: [...new Set(closure.imports.map((entry) => entry.source))],
    importBindings: closure.imports,
    helperDeclarations: closure.helpers.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      code: entry.code,
    })),
    closureBindings: closure.helpers.map((entry) => entry.name),
    globals,
    invocationTarget,
    environment: buildEnvironmentHints(globals),
    params: candidate.params,
    name: candidate.name,
  };
}

/**
 * Generate RPC wrapper for a signature function
 * Creates an HTTP endpoint that can be called to generate signatures
 * @param {Object} fnInfo - Extracted function info
 * @param {Object} options - RPC configuration
 * @returns {Object} RPC wrapper code and configuration
 */
export function generateRPCWrapper(fnInfo, options = {}) {
  const {
    port = 9527,
    endpoint = '/sign',
    cors = true,
    rateLimit = 100, // Requests per minute
  } = options;

  const wrapperCode = `// Auto-generated RPC wrapper for ${fnInfo.name}
// Generated by OmniCrawl Signature Locator
const express = require('express');
const app = express();

app.use(express.json({ limit: '1mb' }));
${cors ? `app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});` : ''}

// Rate limiting
const requestCounts = new Map();
function checkRateLimit() {
  const now = Date.now();
  const windowMs = 60000;
  const cleaned = [...requestCounts.entries()].filter(([_, t]) => now - t < windowMs);
  requestCounts.clear();
  for (const [ip, t] of cleaned) requestCounts.set(ip, t);
  if (requestCounts.size >= ${rateLimit}) {
    return false;
  }
  return true;
}

function createRuntimeEnvironment() {
  const storageFactory = () => {
    const store = new Map();
    return {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(String(key), String(value)); },
      removeItem(key) { store.delete(String(key)); },
      clear() { store.clear(); },
    };
  };

  const location = {
    href: 'https://example.com/',
    origin: 'https://example.com',
    protocol: 'https:',
    host: 'example.com',
    hostname: 'example.com',
    pathname: '/',
    search: '',
    hash: '',
  };

  const document = {
    cookie: '',
    createElement() { return { style: {}, dataset: {}, appendChild() {}, setAttribute() {} }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };

  const navigator = {
    userAgent: 'OmniCrawlSignatureRPC/1.0',
    platform: 'Win32',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en-US'],
    hardwareConcurrency: 8,
  };

  const window = {
    document,
    navigator,
    location,
    localStorage: storageFactory(),
    sessionStorage: storageFactory(),
    crypto: globalThis.crypto,
    fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
  };

  window.window = window;
  window.self = window;
  window.globalThis = window;

  return {
    window,
    document,
    navigator,
    location,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    crypto: globalThis.crypto,
    fetch: window.fetch,
    atob: window.atob,
    btoa: window.btoa,
    Buffer,
    process,
  };
}

const runtime = createRuntimeEnvironment();
Object.assign(globalThis, runtime);

// Import or define the signature function
${fnInfo.importBindings.map((entry) => {
  if (entry.imported) {
    return `const { ${entry.imported}: ${entry.local} } = require('${entry.source}');`;
  }
  return `const ${entry.local} = require('${entry.source}');`;
}).join('\n')}

// The signature function
${fnInfo.runtimeCode || fnInfo.code}

// RPC endpoint
app.post('${endpoint}', async (req, res) => {
  if (!checkRateLimit()) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const params = ${JSON.stringify(fnInfo.params.map((p) => p))};
    const args = params.map((p) => req.body[p]);

    // Call the signature function
    const result = ${fnInfo.invocationTarget || fnInfo.name}(...args);

    res.json({
      success: true,
      signature: result,
      functionName: '${fnInfo.name}',
      closureBindings: ${JSON.stringify(fnInfo.closureBindings ?? [])},
      environment: ${JSON.stringify(fnInfo.environment ?? { browser: false, node: true, needs: [] })},
      timestamp: Date.now(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    function: '${fnInfo.name}',
    params: ${JSON.stringify(fnInfo.params)},
    closureBindings: ${JSON.stringify(fnInfo.closureBindings ?? [])},
    environment: ${JSON.stringify(fnInfo.environment ?? { browser: false, node: true, needs: [] })},
    timestamp: Date.now(),
  });
});

app.listen(${port}, () => {
  console.log(\`Signature RPC server running on port ${port}\`);
  console.log(\`Endpoint: POST http://localhost:${port}${endpoint}\`);
});
`;

  return {
    wrapperCode,
    config: {
      port,
      endpoint: `POST http://localhost:${port}${endpoint}`,
      healthEndpoint: `GET http://localhost:${port}/health`,
      params: fnInfo.params,
      functionName: fnInfo.name,
      invocationTarget: fnInfo.invocationTarget || fnInfo.name,
      closureBindings: fnInfo.closureBindings ?? [],
      environment: fnInfo.environment ?? { browser: false, node: true, needs: [] },
      rateLimit,
    },
  };
}

/**
 * Call a signature RPC endpoint
 * @param {string} url - RPC endpoint URL
 * @param {Object} params - Function parameters
 * @returns {Promise<string>} Generated signature
 */
export async function callSignatureRPC(url, params = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(`RPC call failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(`RPC error: ${data.error}`);
  }

  return data.signature;
}

/**
 * Full auto-signature pipeline: locate -> extract -> generate RPC
 * @param {string} code - JavaScript source code
 * @param {Object} options - Options
 * @returns {Object} Complete signature setup result
 */
export async function autoSetupSignatureRPC(code, options = {}) {
  // Step 1: Locate signature functions
  const located = locateSignatureFunctions(code, {
    functionName: options.functionName,
    paramName: options.paramName,
    maxCandidates: 5,
  });

  if (located.candidates.length === 0) {
    return {
      success: false,
      error: 'No signature functions found',
      located,
    };
  }

  // Step 2: Extract the best candidate
  const best = located.candidates[0];
  const extracted = extractFunctionWithDependencies(code, best);

  // Step 3: Generate RPC wrapper
  const rpc = generateRPCWrapper(extracted, {
    port: options.port ?? 9527,
    endpoint: options.endpoint ?? '/sign',
  });

  return {
    success: true,
    candidate: best,
    extracted,
    rpc,
    instructions: [
      `1. Save the RPC wrapper code to a file (e.g., sign-server.js)`,
      `2. Install dependencies: npm install express`,
      `3. Start the server: node sign-server.js`,
      `4. Test with: curl -X POST http://localhost:${options.port ?? 9527}${options.endpoint ?? '/sign'} -H 'Content-Type: application/json' -d '${JSON.stringify(Object.fromEntries(extracted.params.map((p) => [p, 'test'])))}'`,
    ],
  };
}
