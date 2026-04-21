/**
 * String Array Deobfuscator — automatically resolves _0x1234[N] style
 * string table references back to their plaintext values.
 *
 * Handles the most common obfuscator.io / javascript-obfuscator patterns:
 *   1. Plain string array:  var _0xabc = ['hello','world',...]; _0xabc[0] → 'hello'
 *   2. Rotation + shift:    array is rotated by a numeric offset before use
 *   3. RC4/base64 encoded:  each string is decoded via a decode function
 *   4. Indirect accessor:   var _0xfn = function(idx) { return _0xarr[idx]; }
 *
 * Strategy:
 *   - Parse AST to find the string array declaration
 *   - Detect and execute the rotation/decode setup in a safe vm sandbox
 *   - Replace all call-site references with the resolved string literals
 *   - Return the deobfuscated source code
 */

import vm from 'node:vm';
import * as babelParser from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import generate from '@babel/generator';

const traverse = traverseModule.default ?? traverseModule;
const generateCode = generate.default ?? generate;

const PARSER_OPTS = {
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  plugins: ['jsx'],
  errorRecovery: true,
};

// ─── Detection helpers ────────────────────────────────────────────────────────

/**
 * Detect if a variable declaration is a string array (e.g. var _0x1a2b = ['a','b',...])
 */
function isStringArrayDecl(node) {
  if (!t.isVariableDeclaration(node)) return false;
  for (const decl of node.declarations) {
    if (!t.isArrayExpression(decl.init)) continue;
    const elems = decl.init.elements;
    if (elems.length < 3) continue;
    const stringCount = elems.filter((e) => t.isStringLiteral(e)).length;
    if (stringCount / elems.length >= 0.7) return true;
  }
  return false;
}

/**
 * Extract the string array name and values from a declaration node.
 */
function extractStringArray(node) {
  for (const decl of node.declarations) {
    if (!t.isArrayExpression(decl.init)) continue;
    const elems = decl.init.elements;
    const stringCount = elems.filter((e) => t.isStringLiteral(e)).length;
    if (stringCount / elems.length < 0.7) continue;
    return {
      name: t.isIdentifier(decl.id) ? decl.id.name : null,
      values: elems.map((e) => (t.isStringLiteral(e) ? e.value : null)),
    };
  }
  return null;
}

// ─── Core deobfuscator ────────────────────────────────────────────────────────

/** 
 * Object-oriented API for string array deobfuscation.
 * Allows `new StringArrayDeobfuscator(code)` usage.
 */
export class StringArrayDeobfuscator {
  constructor(code, options = {}) {
    this._code = code;
    this._options = options;
    this._result = null;
  }

  /** Find all string arrays in the code. */
  findStringArrays() {
    // Parse and detect string array declarations
    let ast;
    try {
      ast = babelParser.parse(this._code, PARSER_OPTS);
    } catch {
      return [];
    }

    const arrays = [];
    for (const node of ast.program.body) {
      if (isStringArrayDecl(node)) {
        const info = extractStringArray(node);
        if (info?.name) {
          arrays.push({ name: info.name, size: info.values.length, values: info.values });
        }
      }
    }
    return arrays;
  }

  /** Deobfuscate and return the result object. */
  deobfuscate() {
    this._result = deobfuscateStringArray(this._code, this._options);
    return this._result;
  }

  /** Get the deobfuscated code (runs deobfuscate if needed). */
  getCode() {
    if (!this._result) this.deobfuscate();
    return this._result.code;
  }
}

/**
 * Deobfuscate string array references in JavaScript source code.
 *
 * @param {string} code - Obfuscated JavaScript source
 * @param {Object} [options]
 * @param {number} [options.vmTimeoutMs=3000] - Timeout for sandbox execution
 * @param {boolean} [options.executeSetup=true] - Execute rotation/decode setup in vm
 * @returns {{ code: string, resolved: number, arrayName: string|null, strings: string[]|null }}
 */
export function deobfuscateStringArray(code, options = {}) {
  const { vmTimeoutMs = 3000, executeSetup = true } = options;

  let ast;
  try {
    ast = babelParser.parse(code, PARSER_OPTS);
  } catch {
    return { code, resolved: 0, arrayName: null, strings: null };
  }

  // Step 1: Find the string array declaration
  let arrayInfo = null;
  let arrayDeclIndex = -1;

  for (let i = 0; i < ast.program.body.length; i++) {
    const node = ast.program.body[i];
    if (isStringArrayDecl(node)) {
      arrayInfo = extractStringArray(node);
      arrayDeclIndex = i;
      break;
    }
  }

  if (!arrayInfo?.name) {
    return { code, resolved: 0, arrayName: null, strings: null };
  }

  // Step 2: Try to execute the setup code (rotation + decode) in a sandbox
  // to get the final resolved string array
  let resolvedStrings = arrayInfo.values;

  if (executeSetup) {
    try {
      // Collect the first ~10 statements (array decl + rotation/decode setup)
      const setupStatements = ast.program.body.slice(0, Math.min(arrayDeclIndex + 8, ast.program.body.length));
      const setupCode = setupStatements.map((n) => generateCode(n).code).join('\n');

      const sandbox = vm.createContext({
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        String, Number, Array, Object, Math, JSON,
      });

      vm.runInContext(setupCode, sandbox, { timeout: vmTimeoutMs });

      // Extract the (possibly rotated/decoded) array from sandbox
      const arr = sandbox[arrayInfo.name];
      if (Array.isArray(arr) && arr.length > 0) {
        resolvedStrings = arr.map((v) => (v == null ? null : String(v)));
      }
    } catch {
      // Fall back to static values
    }
  }

  // Step 3: Find the accessor function name (e.g. function _0xfn(n){return _0xarr[n]})
  const accessorNames = new Set();
  accessorNames.add(arrayInfo.name); // direct array access

  traverse(ast, {
    FunctionDeclaration(path) {
      const body = path.node.body.body;
      if (body.length !== 1) return;
      const stmt = body[0];
      if (!t.isReturnStatement(stmt)) return;
      const arg = stmt.argument;
      // return _0xarr[n] or return _0xarr[n - offset]
      if (t.isMemberExpression(arg) && t.isIdentifier(arg.object, { name: arrayInfo.name })) {
        if (t.isIdentifier(path.node.id)) accessorNames.add(path.node.id.name);
      }
    },
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init)) return;
      const body = t.isBlockStatement(init.body) ? init.body.body : null;
      if (!body || body.length !== 1) return;
      const stmt = body[0];
      if (!t.isReturnStatement(stmt)) return;
      const arg = stmt.argument;
      if (t.isMemberExpression(arg) && t.isIdentifier(arg.object, { name: arrayInfo.name })) {
        if (t.isIdentifier(path.node.id)) accessorNames.add(path.node.id.name);
      }
    },
  });

  // Step 4: Replace all call sites with string literals
  let resolved = 0;

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || !accessorNames.has(callee.name)) return;

      const arg = path.node.arguments[0];
      let idx = null;

      if (t.isNumericLiteral(arg)) {
        idx = arg.value;
      } else if (t.isUnaryExpression(arg, { operator: '-' }) && t.isNumericLiteral(arg.argument)) {
        // negative index — skip
        return;
      }

      if (idx === null || idx < 0 || idx >= resolvedStrings.length) return;
      const str = resolvedStrings[idx];
      if (str === null) return;

      path.replaceWith(t.stringLiteral(str));
      resolved++;
    },
    MemberExpression(path) {
      // _0xarr[0] direct access
      if (!t.isIdentifier(path.node.object, { name: arrayInfo.name })) return;
      if (!t.isNumericLiteral(path.node.computed ? path.node.property : null)) return;
      const idx = path.node.property.value;
      if (idx < 0 || idx >= resolvedStrings.length) return;
      const str = resolvedStrings[idx];
      if (str === null) return;
      path.replaceWith(t.stringLiteral(str));
      resolved++;
    },
  });

  const output = generateCode(ast, { retainLines: false, compact: false }).code;

  return {
    code: output,
    resolved,
    arrayName: arrayInfo.name,
    strings: resolvedStrings,
  };
}
