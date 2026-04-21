import babelParser from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';

const traverse = traverseModule.default;

const parserOptions = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  plugins: [
    'jsx',
    'typescript',
    'doExpressions',
    'objectRestSpread',
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'decorators-legacy',
    'dynamicImport',
    'optionalChaining',
    'nullishCoalescingOperator',
    'topLevelAwait',
    'bigInt',
    'numericSeparator',
  ],
};

function parse(code) {
  try {
    const ast = babelParser.parse(code, parserOptions);
    return { success: true, ast, error: null };
  } catch (error) {
    return { success: false, ast: null, error: error?.message ?? String(error) };
  }
}

function complexityLevel(cyclomaticComplexity) {
  if (cyclomaticComplexity > 10) return 'high';
  if (cyclomaticComplexity > 5) return 'medium';
  return 'low';
}

function collectArgumentValue(node) {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isIdentifier(node)) return node.name;
  if (t.isObjectExpression(node)) return '[Object]';
  if (t.isArrayExpression(node)) return '[Array]';
  return '[Expression]';
}

function calleeName(node) {
  if (t.isIdentifier(node.callee)) {
    return node.callee.name;
  }

  if (t.isMemberExpression(node.callee)) {
    const object = t.isIdentifier(node.callee.object)
      ? node.callee.object.name
      : t.isThisExpression(node.callee.object)
        ? 'this'
        : '';
    const property = t.isIdentifier(node.callee.property)
      ? node.callee.property.name
      : t.isStringLiteral(node.callee.property)
        ? node.callee.property.value
        : '';
    return object ? `${object}.${property}` : property || null;
  }

  return null;
}

function extractParamName(node) {
  if (t.isIdentifier(node)) return node.name;
  if (t.isAssignmentPattern(node)) return `${extractParamName(node.left)}=${collectArgumentValue(node.right)}`;
  if (t.isRestElement(node)) return `...${extractParamName(node.argument)}`;
  if (t.isObjectPattern(node)) return '[ObjectPattern]';
  if (t.isArrayPattern(node)) return '[ArrayPattern]';
  return '[Unknown]';
}

function cryptoKeywords() {
  return [
    'encrypt',
    'decrypt',
    'hash',
    'md5',
    'sha',
    'aes',
    'des',
    'rsa',
    'crypto',
    'cipher',
    'key',
    'iv',
    'secret',
    'password',
    'token',
    'sign',
    'verify',
    'base64',
    'hex',
    'utf8',
    'sm2',
    'sm3',
    'sm4',
    'hmac',
    'signature',
  ];
}

export function extractFunctionCalls(code) {
  const result = parse(code);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const calls = [];

  traverse(result.ast, {
    CallExpression(path) {
      calls.push({
        type: 'CallExpression',
        callee: calleeName(path.node),
        arguments: path.node.arguments.map((argument) => collectArgumentValue(argument)),
        location: {
          line: path.node.loc?.start?.line ?? null,
          column: path.node.loc?.start?.column ?? null,
        },
      });
    },
  });

  return {
    success: true,
    data: {
      calls,
      count: calls.length,
    },
  };
}

export function extractFunctions(code) {
  const result = parse(code);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const functions = [];

  traverse(result.ast, {
    FunctionDeclaration(path) {
      functions.push({
        type: 'FunctionDeclaration',
        name: path.node.id?.name ?? null,
        params: path.node.params.map((parameter) => extractParamName(parameter)),
        location: {
          start: path.node.loc?.start?.line ?? null,
          end: path.node.loc?.end?.line ?? null,
        },
      });
    },
    FunctionExpression(path) {
      if (!path.node.id?.name) return;
      functions.push({
        type: 'FunctionExpression',
        name: path.node.id.name,
        params: path.node.params.map((parameter) => extractParamName(parameter)),
        location: {
          start: path.node.loc?.start?.line ?? null,
          end: path.node.loc?.end?.line ?? null,
        },
      });
    },
    ArrowFunctionExpression(path) {
      functions.push({
        type: 'ArrowFunctionExpression',
        name: path.node.id?.name ?? 'anonymous',
        params: path.node.params.map((parameter) => extractParamName(parameter)),
        location: {
          start: path.node.loc?.start?.line ?? null,
          end: path.node.loc?.end?.line ?? null,
        },
      });
    },
  });

  return {
    success: true,
    data: {
      functions,
      count: functions.length,
    },
  };
}

export function analyzeControlFlow(code) {
  const result = parse(code);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const controlFlow = {
    functions: [],
    branches: [],
    loops: [],
    returns: [],
    throwStatements: [],
    tryCatchBlocks: [],
  };

  traverse(result.ast, {
    FunctionDeclaration(path) {
      controlFlow.functions.push({
        name: path.node.id?.name || 'anonymous',
        params: path.node.params.length,
        async: Boolean(path.node.async),
        generator: Boolean(path.node.generator),
        location: {
          start: path.node.loc?.start?.line ?? null,
          end: path.node.loc?.end?.line ?? null,
        },
      });
    },
    IfStatement(path) {
      controlFlow.branches.push({
        type: 'if',
        hasElse: path.node.alternate !== null,
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
    SwitchStatement(path) {
      controlFlow.branches.push({
        type: 'switch',
        cases: path.node.cases.length,
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
    ForStatement(path) {
      controlFlow.loops.push({
        type: 'for',
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
    WhileStatement(path) {
      controlFlow.loops.push({
        type: 'while',
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
    DoWhileStatement(path) {
      controlFlow.loops.push({
        type: 'do-while',
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
    ReturnStatement(path) {
      controlFlow.returns.push({
        hasArgument: path.node.argument !== null,
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
    ThrowStatement(path) {
      controlFlow.throwStatements.push({
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
    TryStatement(path) {
      controlFlow.tryCatchBlocks.push({
        hasCatch: path.node.handler !== null,
        hasFinally: path.node.finalizer !== null,
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
  });

  const cyclomaticComplexity = 1 + controlFlow.branches.length + controlFlow.loops.length;

  return {
    success: true,
    data: {
      controlFlow,
      complexity: {
        cyclomaticComplexity,
        functionCount: controlFlow.functions.length,
        branchCount: controlFlow.branches.length,
        loopCount: controlFlow.loops.length,
        returnCount: controlFlow.returns.length,
        complexityLevel: complexityLevel(cyclomaticComplexity),
      },
    },
  };
}

export function analyzeDataFlow(code) {
  const result = parse(code);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const dataFlow = {
    variables: [],
    assignments: [],
    references: [],
    dependencies: [],
  };

  traverse(result.ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;

      dataFlow.variables.push({
        name: path.node.id.name,
        kind: path.parent.kind,
        hasInit: path.node.init !== null,
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
    AssignmentExpression(path) {
      if (!t.isIdentifier(path.node.left)) return;
      dataFlow.assignments.push({
        variable: path.node.left.name,
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
    Identifier(path) {
      const parentType = path.parent?.type;
      if (parentType === 'VariableDeclarator' || parentType === 'FunctionDeclaration' || parentType === 'AssignmentExpression') {
        return;
      }

      dataFlow.references.push({
        name: path.node.name,
        parentType,
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
  });

  const variableMap = new Map();
  for (const reference of dataFlow.references) {
    const current = variableMap.get(reference.name) ?? {
      name: reference.name,
      definition: null,
      usages: 0,
    };
    current.usages += 1;
    variableMap.set(reference.name, current);
  }

  for (const variable of dataFlow.variables) {
    const current = variableMap.get(variable.name) ?? {
      name: variable.name,
      definition: null,
      usages: 0,
    };
    current.definition = variable;
    variableMap.set(variable.name, current);
  }

  return {
    success: true,
    data: {
      dataFlow,
      variableUsage: [...variableMap.values()].sort((left, right) => right.usages - left.usages),
    },
  };
}

export function extractVariables(code) {
  const result = analyzeDataFlow(code);
  if (!result.success) {
    return result;
  }

  return {
    success: true,
    data: {
      variables: result.data.dataFlow.variables,
      count: result.data.dataFlow.variables.length,
    },
  };
}

export function detectObfuscation(code) {
  const indicators = [
    {
      type: 'stringArray',
      pattern: /var\s+\w+\s*=\s*\[["'][^"']+["'](,\s*["'][^"']+["'])*\]/g,
      description: '字符串数组混淆',
      severity: 'high',
    },
    {
      type: 'variableObfuscation',
      pattern: /(?:var|const|let)\s+_[0-9]+\b/g,
      description: '变量名混淆（使用_加数字）',
      severity: 'medium',
    },
    {
      type: 'evalUsage',
      pattern: /\beval\s*\(/g,
      description: '使用 eval',
      severity: 'high',
    },
    {
      type: 'functionConstructor',
      pattern: /\bnew\s+Function\s*\(/g,
      description: '使用 Function 构造器',
      severity: 'high',
    },
    {
      type: 'hexStrings',
      pattern: /\\x[0-9a-fA-F]{2}/g,
      description: '十六进制编码字符串',
      severity: 'medium',
    },
    {
      type: 'unicodeEscapes',
      pattern: /\\u[0-9a-fA-F]{4}/g,
      description: 'Unicode 转义字符',
      severity: 'low',
    },
    {
      type: 'controlFlowFlattening',
      pattern: /while\s*\(\s*true\s*\)\s*\{\s*switch\s*\(/g,
      description: '控制流平坦化',
      severity: 'high',
    },
    {
      type: 'deadCode',
      pattern: /if\s*\(\s*(?:false|0)\s*\)\s*\{/g,
      description: '死代码注入',
      severity: 'medium',
    },
  ];

  const detected = [];
  for (const indicator of indicators) {
    const matches = code.match(indicator.pattern);
    if (!matches) continue;
    detected.push({
      type: indicator.type,
      description: indicator.description,
      severity: indicator.severity,
      matchCount: matches.length,
      sample: matches[0].slice(0, 100),
    });
  }

  const highSeverityCount = detected.filter((item) => item.severity === 'high').length;

  return {
    isObfuscated: detected.length > 0,
    indicators: detected,
    obfuscationLevel: highSeverityCount > 2 ? 'heavy' : highSeverityCount > 0 ? 'moderate' : detected.length > 0 ? 'light' : 'none',
  };
}

export function extractFunctionCallChain(code, targetFunction) {
  const result = parse(code);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const callChains = [];

  traverse(result.ast, {
    CallExpression(path) {
      const name = calleeName(path.node);
      if (!name || (name !== targetFunction && !name.endsWith(`.${targetFunction}`))) {
        return;
      }

      callChains.push({
        callee: name,
        arguments: path.node.arguments.map((argument) => collectArgumentValue(argument)),
        location: {
          line: path.node.loc?.start?.line ?? null,
          column: path.node.loc?.start?.column ?? null,
        },
      });
    },
  });

  return {
    success: true,
    data: {
      targetFunction,
      callChains,
      count: callChains.length,
    },
  };
}

export function extractAllStrings(code) {
  const result = parse(code);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const strings = [];

  traverse(result.ast, {
    StringLiteral(path) {
      strings.push({
        value: path.node.value,
        length: path.node.value.length,
        isLikelyKey: path.node.value.length >= 16 && /^[a-zA-Z0-9+/=]+$/.test(path.node.value),
        isLikelyURL: /^https?:\/\//.test(path.node.value),
        isLikelySelector: /^[.#\[][a-zA-Z]/.test(path.node.value),
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
  });

  return {
    success: true,
    data: {
      strings,
      count: strings.length,
      likelyKeys: strings.filter((item) => item.isLikelyKey),
      likelyURLs: strings.filter((item) => item.isLikelyURL),
    },
  };
}

export function extractCryptoRelated(code) {
  const result = parse(code);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const keywords = cryptoKeywords();
  const cryptoRelated = [];

  traverse(result.ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      const name = path.node.id.name;
      if (!keywords.some((keyword) => name.toLowerCase().includes(keyword))) return;
      cryptoRelated.push({
        type: 'VariableDeclarator',
        name,
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
    FunctionDeclaration(path) {
      const name = path.node.id?.name;
      if (!name || !keywords.some((keyword) => name.toLowerCase().includes(keyword))) return;
      cryptoRelated.push({
        type: 'FunctionDeclaration',
        name,
        location: {
          start: path.node.loc?.start?.line ?? null,
          end: path.node.loc?.end?.line ?? null,
        },
      });
    },
    CallExpression(path) {
      const name = calleeName(path.node);
      if (!name || !keywords.some((keyword) => name.toLowerCase().includes(keyword))) return;
      cryptoRelated.push({
        type: 'CallExpression',
        callee: name,
        location: { line: path.node.loc?.start?.line ?? null },
      });
    },
  });

  return {
    success: true,
    data: {
      cryptoRelated,
      count: cryptoRelated.length,
    },
  };
}
