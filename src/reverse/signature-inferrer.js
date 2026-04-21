/**
 * Signature Parameter Inferrer — automatically infers what parameters a
 * signature/sign function expects by combining AST analysis and dynamic probing.
 *
 * Strategy:
 *   1. AST: extract formal parameter names and detect what each param is used for
 *      (URL, method, body, timestamp, nonce, headers, etc.)
 *   2. Data flow: trace which globals/APIs the function reads (Date.now, location, etc.)
 *   3. Dynamic: call the function with typed probe values and observe behavior
 *
 * Returns a structured parameter spec with inferred types and example values.
 */

import * as babelParser from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import { parseWithCache } from './ast-cache.js';

const traverse = traverseModule.default ?? traverseModule;

const PARSER_OPTS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  plugins: ['jsx', 'typescript'],
  errorRecovery: true,
};

// ─── Semantic classification ──────────────────────────────────────────────────

const PARAM_HINTS = [
  { pattern: /^(url|path|uri|endpoint|route)$/i, type: 'url', example: 'https://api.example.com/v1/data' },
  { pattern: /^(method|verb|httpMethod)$/i, type: 'method', example: 'GET' },
  { pattern: /^(body|data|payload|content|requestBody|reqBody)$/i, type: 'body', example: '{"key":"value"}' },
  { pattern: /^(ts|timestamp|time|t|now)$/i, type: 'timestamp', example: () => String(Date.now()) },
  { pattern: /^(nonce|n|rand|random|salt)$/i, type: 'nonce', example: () => Math.random().toString(36).slice(2) },
  { pattern: /^(key|apiKey|appKey|accessKey|ak)$/i, type: 'apiKey', example: 'YOUR_API_KEY' },
  { pattern: /^(secret|appSecret|secretKey|sk)$/i, type: 'secret', example: 'YOUR_SECRET' },
  { pattern: /^(token|accessToken|authToken|jwt)$/i, type: 'token', example: 'Bearer YOUR_TOKEN' },
  { pattern: /^(headers|header|h)$/i, type: 'headers', example: {} },
  { pattern: /^(version|v|ver|appVersion)$/i, type: 'version', example: '1.0.0' },
  { pattern: /^(uid|userId|user_id|openid)$/i, type: 'userId', example: 'user_123' },
];

function classifyParamName(name) {
  for (const hint of PARAM_HINTS) {
    if (hint.pattern.test(name)) {
      return {
        type: hint.type,
        example: typeof hint.example === 'function' ? hint.example() : hint.example,
      };
    }
  }
  return { type: 'unknown', example: '' };
}

// ─── AST-based inference ──────────────────────────────────────────────────────

/**
 * Find a function by name in the AST and extract its parameter info.
 */
function findFunctionParams(ast, fnName) {
  let params = null;

  traverse(ast, {
    FunctionDeclaration(path) {
      if (t.isIdentifier(path.node.id, { name: fnName })) {
        params = path.node.params;
        path.stop();
      }
    },
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id, { name: fnName })) return;
      const init = path.node.init;
      if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
        params = init.params;
        path.stop();
      }
    },
    AssignmentExpression(path) {
      const left = path.node.left;
      const right = path.node.right;
      const name = t.isIdentifier(left) ? left.name
        : t.isMemberExpression(left) ? (t.isIdentifier(left.property) ? left.property.name : null)
        : null;
      if (name !== fnName) return;
      if (t.isFunctionExpression(right) || t.isArrowFunctionExpression(right)) {
        params = right.params;
        path.stop();
      }
    },
  });

  return params;
}

/**
 * Detect which globals/APIs the function body reads.
 */
function detectGlobalReads(ast, fnName) {
  const reads = new Set();
  let inTarget = false;

  traverse(ast, {
    FunctionDeclaration: {
      enter(path) { if (t.isIdentifier(path.node.id, { name: fnName })) inTarget = true; },
      exit(path) { if (t.isIdentifier(path.node.id, { name: fnName })) inTarget = false; },
    },
    MemberExpression(path) {
      if (!inTarget) return;
      const obj = path.node.object;
      const prop = path.node.property;
      if (t.isIdentifier(obj) && t.isIdentifier(prop)) {
        reads.add(`${obj.name}.${prop.name}`);
      }
    },
    CallExpression(path) {
      if (!inTarget) return;
      const callee = path.node.callee;
      if (t.isIdentifier(callee)) reads.add(callee.name + '()');
      if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && t.isIdentifier(callee.property)) {
        reads.add(`${callee.object.name}.${callee.property.name}()`);
      }
    },
  });

  return [...reads];
}

// ─── Main inferrer ────────────────────────────────────────────────────────────

/**
 * Infer the parameters of a signature function from its source code.
 *
 * @param {string} code - JavaScript source containing the function
 * @param {string} fnName - Name of the function to analyze
 * @returns {{
 *   fnName: string,
 *   params: Array<{ name: string, index: number, type: string, example: any, required: boolean }>,
 *   globalReads: string[],
 *   usesTimestamp: boolean,
 *   usesNonce: boolean,
 *   usesUrl: boolean,
 *   usesBody: boolean,
 *   callExample: string,
 *   confidence: 'high'|'medium'|'low'
 * }}
 */
export function inferSignatureParams(code, fnName) {
  let ast;
  try {
    ast = parseWithCache(code);
  } catch {
    return { fnName, params: [], globalReads: [], usesTimestamp: false, usesNonce: false, usesUrl: false, usesBody: false, callExample: `${fnName}()`, confidence: 'low' };
  }

  const rawParams = findFunctionParams(ast, fnName) ?? [];
  const globalReads = detectGlobalReads(ast, fnName);

  const params = rawParams.map((p, index) => {
    let name = 'arg' + index;
    if (t.isIdentifier(p)) name = p.name;
    else if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) name = p.left.name;
    else if (t.isRestElement(p) && t.isIdentifier(p.argument)) name = '...' + p.argument.name;

    const { type, example } = classifyParamName(name);
    const required = !t.isAssignmentPattern(p);

    return { name, index, type, example, required };
  });

  // Supplement from global reads
  const usesTimestamp = globalReads.some((r) => /Date\.now|getTime|timestamp/i.test(r))
    || params.some((p) => p.type === 'timestamp');
  const usesNonce = globalReads.some((r) => /random|nonce|Math\.random/i.test(r))
    || params.some((p) => p.type === 'nonce');
  const usesUrl = params.some((p) => p.type === 'url');
  const usesBody = params.some((p) => p.type === 'body');

  // If timestamp/nonce are read from globals but not in params, note them
  const implicitDeps = [];
  if (usesTimestamp && !params.some((p) => p.type === 'timestamp')) {
    implicitDeps.push({ name: 'timestamp', source: 'Date.now()', type: 'timestamp' });
  }
  if (usesNonce && !params.some((p) => p.type === 'nonce')) {
    implicitDeps.push({ name: 'nonce', source: 'Math.random()', type: 'nonce' });
  }

  // Build call example
  const exampleArgs = params.map((p) => {
    const v = p.example;
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
  const callExample = `${fnName}(${exampleArgs.join(', ')})`;

  const confidence = params.length > 0
    ? (params.every((p) => p.type !== 'unknown') ? 'high' : 'medium')
    : 'low';

  return {
    fnName,
    params,
    implicitDeps,
    globalReads,
    usesTimestamp,
    usesNonce,
    usesUrl,
    usesBody,
    callExample,
    confidence,
  };
}

/**
 * Scan a JS file for all likely signature functions and infer their params.
 *
 * @param {string} code
 * @param {string[]} [nameHints=['sign','signature','getSign','calcSign','buildSign','_sign']]
 * @returns {Array<ReturnType<inferSignatureParams>>}
 */
export function inferAllSignatureFunctions(code, nameHints) {
  const hints = nameHints ?? ['sign', 'signature', 'getSign', 'calcSign', 'buildSign', '_sign', 'genSign', 'makeSign'];
  let ast;
  try {
    ast = parseWithCache(code);
  } catch {
    return [];
  }

  const found = new Set();
  traverse(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id?.name;
      if (name && hints.some((h) => name.toLowerCase().includes(h.toLowerCase()))) found.add(name);
    },
    VariableDeclarator(path) {
      const name = t.isIdentifier(path.node.id) ? path.node.id.name : null;
      if (!name) return;
      const init = path.node.init;
      if ((t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))
        && hints.some((h) => name.toLowerCase().includes(h.toLowerCase()))) {
        found.add(name);
      }
    },
  });

  return [...found].map((name) => inferSignatureParams(code, name));
}
