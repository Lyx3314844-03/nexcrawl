import { analyzeJavaScript } from './reverse-analyzer.js';
import {
  extractAllStrings,
  extractCryptoRelated,
  extractFunctionCallChain,
  extractFunctionCalls,
  extractFunctions,
  extractVariables,
} from './advanced-ast-analyzer.js';

export function extractLegacyAstPayload(code, options = {}) {
  const payload = {};

  if (options.functions !== false) {
    payload.functions = extractFunctions(code);
  }

  if (options.calls !== false) {
    payload.calls = extractFunctionCalls(code);
  }

  if (options.variables !== false) {
    payload.variables = extractVariables(code);
  }

  if (options.strings !== false) {
    payload.strings = extractAllStrings(code);
  }

  if (options.crypto === true) {
    payload.crypto = extractCryptoRelated(code);
  }

  return payload;
}

export function findLegacyAstFailure(payload) {
  for (const value of Object.values(payload)) {
    if (value?.success === false) {
      return value.error ?? 'AST analysis failed';
    }
  }

  return null;
}

export function extractLegacyFunctionParams(code, functionName) {
  const result = extractFunctions(code);
  if (result.success === false) {
    return result;
  }

  const functions = functionName
    ? result.data.functions.filter((entry) => entry.name === functionName)
    : result.data.functions;

  return {
    success: true,
    data: {
      functions,
      count: functions.length,
      filter: functionName || 'all',
    },
  };
}

export function findLegacyCalls(code, functionName) {
  const result = extractFunctionCallChain(code, functionName);
  if (result.success === false) {
    return result;
  }

  return {
    success: true,
    data: {
      calls: result.data.callChains,
      count: result.data.count,
      functionName,
    },
  };
}

export function summarizeLegacyAstAnalysis(code) {
  const result = analyzeJavaScript(code, {
    target: 'inline://legacy-ast-analyze.js',
  });

  return {
    success: true,
    results: {
      crypto: result.signals.crypto,
      obfuscation: result.signals.obfuscation,
      antiDebug: result.signals.antiDebug,
      functions: result.names.functions,
      calls: result.ast.ok ? result.ast.calls : [],
      ast: result.ast,
    },
  };
}
