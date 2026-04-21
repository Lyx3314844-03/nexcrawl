/**
 * Control Flow Deobfuscator — restores obfuscator.io control flow flattening.
 *
 * obfuscator.io control flow flattening pattern:
 *
 *   var _0xswitch = '3|1|0|2|4'.split('|'), _idx = 0;
 *   while (true) {
 *     switch (_0xswitch[_idx++]) {
 *       case '0': stmt_0; continue;
 *       case '1': stmt_1; continue;
 *       case '2': stmt_2; continue;
 *       case '3': stmt_3; continue;
 *       case '4': stmt_4; continue;
 *     }
 *     break;
 *   }
 *
 * Strategy:
 *   1. Detect while(true) { switch(arr[idx++]) { ... } break; } pattern
 *   2. Extract the order string (e.g. '3|1|0|2|4')
 *   3. Reorder the case bodies according to the order
 *   4. Replace the while/switch block with the flattened sequential statements
 */

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

// ─── Pattern detection ────────────────────────────────────────────────────────

/**
 * Check if a node is: while (true) { switch (...) { ... } break; }
 */
function isFlattenedWhile(node) {
  if (!t.isWhileStatement(node)) return false;
  // condition must be `true` or `1`
  const cond = node.test;
  if (!t.isBooleanLiteral(cond, { value: true }) && !t.isNumericLiteral(cond, { value: 1 })) return false;
  const body = node.body;
  if (!t.isBlockStatement(body)) return false;
  // body must contain a switch and a break
  const hasSwitch = body.body.some((s) => t.isSwitchStatement(s));
  const hasBreak = body.body.some((s) => t.isBreakStatement(s));
  return hasSwitch && hasBreak;
}

/**
 * Extract the order array from the preceding variable declaration.
 * Looks for: var _x = 'N|N|N'.split('|'), _idx = 0;
 * Returns the order array (e.g. ['3','1','0','2','4']) or null.
 */
function extractOrderFromPrecedingDecl(path) {
  const parent = path.parent;
  if (!t.isBlockStatement(parent) && !t.isProgram(parent)) return null;

  const siblings = parent.body ?? parent.body;
  const idx = siblings.indexOf(path.node);
  if (idx <= 0) return null;

  const prev = siblings[idx - 1];
  if (!t.isVariableDeclaration(prev)) return null;

  for (const decl of prev.declarations) {
    const init = decl.init;
    // 'N|N|N'.split('|')
    if (
      t.isCallExpression(init) &&
      t.isMemberExpression(init.callee) &&
      t.isStringLiteral(init.callee.object) &&
      t.isIdentifier(init.callee.property, { name: 'split' }) &&
      init.arguments.length === 1 &&
      t.isStringLiteral(init.arguments[0], { value: '|' })
    ) {
      return init.callee.object.value.split('|');
    }
  }
  return null;
}

/**
 * Extract case bodies from a switch statement, keyed by case value string.
 */
function extractCaseBodies(switchNode) {
  const cases = {};
  for (const c of switchNode.cases) {
    if (!c.test) continue; // default case
    const key = t.isStringLiteral(c.test) ? c.test.value
      : t.isNumericLiteral(c.test) ? String(c.test.value)
      : null;
    if (key === null) continue;
    // Filter out trailing `continue` statements
    const stmts = c.consequent.filter((s) => !t.isContinueStatement(s));
    cases[key] = stmts;
  }
  return cases;
}

function detectFlattenedBlocks(code) {
  let ast;
  try {
    ast = babelParser.parse(code, PARSER_OPTS);
  } catch {
    return [];
  }

  const findings = [];

  traverse(ast, {
    WhileStatement(path) {
      if (!isFlattenedWhile(path.node)) return;

      const fnPath = path.getFunctionParent();
      let name = '<program>';
      if (fnPath?.node) {
        if (t.isFunctionDeclaration(fnPath.node) && t.isIdentifier(fnPath.node.id)) {
          name = fnPath.node.id.name;
        } else if (
          (t.isFunctionExpression(fnPath.node) || t.isArrowFunctionExpression(fnPath.node))
          && fnPath.parentPath
          && t.isVariableDeclarator(fnPath.parentPath.node)
          && t.isIdentifier(fnPath.parentPath.node.id)
        ) {
          name = fnPath.parentPath.node.id.name;
        }
      }

      findings.push({ name, confidence: 1 });
    },
  });

  return findings;
}

export class ControlFlowDeobfuscator {
  constructor(code) {
    this._code = code;
    this._result = null;
  }

  findFlattenedFunctions() {
    return detectFlattenedBlocks(this._code);
  }

  deobfuscate() {
    this._result = deobfuscateControlFlow(this._code);
    return this._result;
  }

  getCode() {
    if (!this._result) this.deobfuscate();
    return this._result.code;
  }
}

// ─── Main deobfuscator ────────────────────────────────────────────────────────

/**
 * Restore control flow flattening in obfuscated JavaScript.
 *
 * @param {string} code - Obfuscated source
 * @returns {{ code: string, restored: number }}
 */
export function deobfuscateControlFlow(code) {
  let ast;
  try {
    ast = babelParser.parse(code, PARSER_OPTS);
  } catch {
    return { code, restored: 0 };
  }

  let restored = 0;

  traverse(ast, {
    WhileStatement(path) {
      if (!isFlattenedWhile(path.node)) return;

      const body = path.node.body.body;
      const switchNode = body.find((s) => t.isSwitchStatement(s));
      if (!switchNode) return;

      // Try to get order from preceding variable declaration
      const order = extractOrderFromPrecedingDecl(path);
      if (!order) return;

      const caseBodies = extractCaseBodies(switchNode);

      // Build the restored statement sequence
      const restored_stmts = [];
      for (const key of order) {
        const stmts = caseBodies[key];
        if (stmts) restored_stmts.push(...stmts);
      }

      if (restored_stmts.length === 0) return;

      // Replace the while block with the ordered statements
      path.replaceWithMultiple(restored_stmts);
      restored++;
    },
  });

  const output = generateCode(ast, { retainLines: false, compact: false }).code;
  return { code: output, restored };
}

/**
 * Apply both string array deobfuscation and control flow restoration in one pass.
 *
 * @param {string} code
 * @param {Object} [options]
 * @returns {{ code: string, stringArrayResolved: number, controlFlowRestored: number }}
 */
export async function fullDeobfuscate(code, options = {}) {
  // Import lazily to avoid circular deps
  const { deobfuscateStringArray } = await import('./string-array-deobfuscator.js');

  const step1 = deobfuscateStringArray(code, options);
  const step2 = deobfuscateControlFlow(step1.code);

  return {
    code: step2.code,
    stringArrayResolved: step1.resolved,
    controlFlowRestored: step2.restored,
    arrayName: step1.arrayName,
  };
}
