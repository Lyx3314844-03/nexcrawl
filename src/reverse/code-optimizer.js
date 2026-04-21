/**
 * Code Optimizer — Dead Code Elimination (DCE) and Constant Folding.
 * Simplifies deobfuscated code by removing unreachable code and evaluating constants.
 */

import * as babelParser from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import generateModule from '@babel/generator';
import { parseWithCache } from './ast-cache.js';

const traverse = traverseModule.default ?? traverseModule;
const generate = generateModule.default ?? generateModule;

const PARSER_OPTS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  plugins: ['jsx', 'typescript'],
  errorRecovery: true,
};

// ─── Constant Folding ─────────────────────────────────────────────────────

function evaluateConstant(node) {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isIdentifier(node, { name: 'undefined' })) return undefined;
  
  if (t.isUnaryExpression(node)) {
    const arg = evaluateConstant(node.argument);
    if (arg === undefined) return undefined;
    if (node.operator === '-') return -arg;
    if (node.operator === '+') return +arg;
    if (node.operator === '!') return !arg;
    if (node.operator === '~') return ~arg;
  }
  
  if (t.isBinaryExpression(node)) {
    const left = evaluateConstant(node.left);
    const right = evaluateConstant(node.right);
    if (left === undefined || right === undefined) return undefined;
    
    switch (node.operator) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return left / right;
      case '%': return left % right;
      case '**': return left ** right;
      case '==': return left == right;
      case '===': return left === right;
      case '!=': return left != right;
      case '!==': return left !== right;
      case '<': return left < right;
      case '<=': return left <= right;
      case '>': return left > right;
      case '>=': return left >= right;
      case '<<': return left << right;
      case '>>': return left >> right;
      case '>>>': return left >>> right;
      case '&': return left & right;
      case '|': return left | right;
      case '^': return left ^ right;
    }
  }
  
  if (t.isLogicalExpression(node)) {
    const left = evaluateConstant(node.left);
    if (node.operator === '&&') {
      if (!left) return left;
      return evaluateConstant(node.right);
    }
    if (node.operator === '||') {
      if (left) return left;
      return evaluateConstant(node.right);
    }
    if (node.operator === '??') {
      if (left != null) return left;
      return evaluateConstant(node.right);
    }
  }
  
  return undefined;
}

function foldConstants(ast) {
  let changed = false;
  
  traverse(ast, {
    BinaryExpression(path) {
      const value = evaluateConstant(path.node);
      if (value !== undefined) {
        const literal = typeof value === 'number' ? t.numericLiteral(value)
          : typeof value === 'string' ? t.stringLiteral(value)
          : typeof value === 'boolean' ? t.booleanLiteral(value)
          : t.nullLiteral();
        path.replaceWith(literal);
        changed = true;
      }
    },
    UnaryExpression(path) {
      const value = evaluateConstant(path.node);
      if (value !== undefined) {
        const literal = typeof value === 'number' ? t.numericLiteral(value)
          : typeof value === 'boolean' ? t.booleanLiteral(value)
          : t.nullLiteral();
        path.replaceWith(literal);
        changed = true;
      }
    },
    LogicalExpression(path) {
      const value = evaluateConstant(path.node);
      if (value !== undefined) {
        const literal = typeof value === 'number' ? t.numericLiteral(value)
          : typeof value === 'string' ? t.stringLiteral(value)
          : typeof value === 'boolean' ? t.booleanLiteral(value)
          : t.nullLiteral();
        path.replaceWith(literal);
        changed = true;
      }
    },
  });
  
  return changed;
}

// ─── Dead Code Elimination ────────────────────────────────────────────────

function eliminateDeadCode(ast) {
  let changed = false;
  
  traverse(ast, {
    IfStatement(path) {
      const test = evaluateConstant(path.node.test);
      if (test === true) {
        path.replaceWith(path.node.consequent);
        changed = true;
      } else if (test === false) {
        if (path.node.alternate) {
          path.replaceWith(path.node.alternate);
        } else {
          path.remove();
        }
        changed = true;
      }
    },
    
    ConditionalExpression(path) {
      const test = evaluateConstant(path.node.test);
      if (test === true) {
        path.replaceWith(path.node.consequent);
        changed = true;
      } else if (test === false) {
        path.replaceWith(path.node.alternate);
        changed = true;
      }
    },
    
    WhileStatement(path) {
      const test = evaluateConstant(path.node.test);
      if (test === false) {
        path.remove();
        changed = true;
      }
    },
    
    // Remove unreachable code after return/throw/break/continue
    BlockStatement(path) {
      const body = path.node.body;
      let foundTerminator = -1;
      
      for (let i = 0; i < body.length; i++) {
        const stmt = body[i];
        if (t.isReturnStatement(stmt) || t.isThrowStatement(stmt) || 
            t.isBreakStatement(stmt) || t.isContinueStatement(stmt)) {
          foundTerminator = i;
          break;
        }
      }
      
      if (foundTerminator >= 0 && foundTerminator < body.length - 1) {
        path.node.body = body.slice(0, foundTerminator + 1);
        changed = true;
      }
    },
    
    // Remove empty statements
    EmptyStatement(path) {
      path.remove();
      changed = true;
    },
    
    // Remove unused variable declarations
    VariableDeclaration(path) {
      const declarations = path.node.declarations.filter((decl) => {
        if (!t.isIdentifier(decl.id)) return true;
        const binding = path.scope.getBinding(decl.id.name);
        return binding && binding.referenced;
      });
      
      if (declarations.length === 0) {
        path.remove();
        changed = true;
      } else if (declarations.length < path.node.declarations.length) {
        path.node.declarations = declarations;
        changed = true;
      }
    },
  });
  
  return changed;
}

// ─── Main Optimizer ───────────────────────────────────────────────────────

/**
 * Optimize code with constant folding and dead code elimination.
 * Runs multiple passes until no more changes.
 */
export function optimizeCode(code, options = {}) {
  const maxPasses = options.maxPasses ?? 5;
  
  let ast;
  try {
    ast = parseWithCache(code);
  } catch {
    return code;
  }
  
  let totalChanges = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const foldChanged = foldConstants(ast);
    const dceChanged = eliminateDeadCode(ast);
    
    if (!foldChanged && !dceChanged) break;
    totalChanges++;
  }
  
  try {
    const output = generate(ast, { comments: false, compact: false });
    return output.code;
  } catch {
    return code;
  }
}

/**
 * Analyze code complexity before and after optimization.
 */
export function analyzeOptimization(originalCode, optimizedCode) {
  const countNodes = (code) => {
    try {
      const ast = parseWithCache(code);
      let count = 0;
      traverse(ast, { enter() { count++; } });
      return count;
    } catch {
      return 0;
    }
  };
  
  const originalNodes = countNodes(originalCode);
  const optimizedNodes = countNodes(optimizedCode);
  const reduction = originalNodes > 0 ? ((originalNodes - optimizedNodes) / originalNodes * 100).toFixed(2) : 0;
  
  return {
    originalNodes,
    optimizedNodes,
    reduction: `${reduction}%`,
    originalSize: originalCode.length,
    optimizedSize: optimizedCode.length,
    sizeReduction: `${((originalCode.length - optimizedCode.length) / originalCode.length * 100).toFixed(2)}%`,
  };
}

/**
 * Convenience: optimize and return both result and analysis.
 */
export function optimizeWithAnalysis(code, options = {}) {
  const optimized = optimizeCode(code, options);
  const analysis = analyzeOptimization(code, optimized);
  return { code: optimized, analysis };
}
