function unique(items, keyFn = (item) => JSON.stringify(item)) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function isWebpackBundle(code) {
  return /__webpack_require__\s*\(/.test(code)
    || /function\s*\(\s*module\s*,\s*exports\s*,\s*__webpack_require__\s*\)/.test(code)
    || /webpackChunk/.test(code)
    || /webpackJsonp/.test(code);
}

export function detectWebpackVersion(code) {
  if (code.includes('webpackChunk') || code.includes('__webpack_require__.O')) {
    return 'webpack5+';
  }
  if (code.includes('__webpack_require__.r')) {
    return 'webpack4+';
  }
  if (code.includes('webpackJsonp')) {
    return 'webpack3';
  }
  return 'unknown';
}

function detectModuleIdType(modules = []) {
  const ids = modules.map((item) => item.id);
  if (ids.length === 0) return 'unknown';
  if (ids.every((id) => /^\d+$/.test(String(id)))) return 'numeric';
  if (ids.every((id) => typeof id === 'string')) return 'string';
  return 'mixed';
}

export function extractModules(code) {
  const modules = [];
  const patterns = [
    /\[(\d+)\]\s*:\s*(?:async\s*)?function\s*\(/g,
    /["']([^"']+)["']\s*:\s*(?:async\s*)?function\s*\(/g,
    /["']([^"']+)["']\s*:\s*\([^)]*\)\s*=>\s*\{/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      modules.push({
        id: match[1],
        type: 'module-factory',
        index: match.index,
      });
    }
  }

  const deduped = unique(modules, (item) => `${item.id}:${item.index}`);
  return {
    count: deduped.length,
    moduleIdType: detectModuleIdType(deduped),
    modules: deduped.slice(0, 200),
  };
}

export function extractChunks(code) {
  const chunks = [];
  const patterns = [
    /__webpack_require__\.e\(\s*["']?([^"')\s]+)["']?\s*\)/g,
    /webpackChunk[\w$]*\.push\(\s*\[\s*\[([^\]]+)\]/g,
    /__webpack_require__\.u\(\s*["']?([^"')\s]+)["']?\s*\)/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const raw = String(match[1]).trim();
      const ids = raw.split(',').map((value) => value.trim().replace(/["']/g, '')).filter(Boolean);
      for (const id of ids) {
        chunks.push({
          id,
          type: pattern.source.includes('push') ? 'pushed' : 'async',
        });
      }
    }
  }

  const deduped = unique(chunks, (item) => `${item.id}:${item.type}`);
  return {
    count: deduped.length,
    chunks: deduped.slice(0, 100),
  };
}

export function findEntryPoints(code) {
  const entryPoints = [];

  if (/\[(0|["']main["'])\]\s*:/.test(code)) {
    entryPoints.push({ id: '0', type: 'main' });
  }

  const jsonpPattern = /webpackJsonp\(\s*\[\s*([^\]]+)\s*\]/g;
  let match;
  while ((match = jsonpPattern.exec(code)) !== null) {
    entryPoints.push({
      ids: match[1].split(',').map((value) => value.trim().replace(/["']/g, '')),
      type: 'jsonp',
    });
  }

  const runtimePushPattern = /webpackChunk[\w$]*\.push\(\s*\[\s*\[([^\]]+)\]\s*,\s*\{[\s\S]*?\}\s*,\s*(\w+)/g;
  while ((match = runtimePushPattern.exec(code)) !== null) {
    entryPoints.push({
      ids: match[1].split(',').map((value) => value.trim().replace(/["']/g, '')),
      runtime: match[2],
      type: 'chunk-runtime',
    });
  }

  return unique(entryPoints);
}

export function findExternals(code) {
  const output = new Set();
  for (const pattern of [
    /require\s*\(\s*["'](react|vue|angular|jquery|lodash|axios|crypto-js|dayjs)[^"']*["']\s*\)/gi,
    /__webpack_require__\s*\(\s*["'](react|vue|angular|jquery|lodash|axios|crypto-js|dayjs)[^"']*["']\s*\)/gi,
  ]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      output.add(match[1]);
    }
  }

  return {
    count: output.size,
    modules: [...output],
  };
}

function collectRuntimeGlobals(code) {
  const runtimeGlobals = [];
  const names = ['m', 'c', 'd', 'r', 'n', 't', 'o', 'p', 'u', 'e', 'f', 'O', 'h', 'g', 'S'];
  for (const name of names) {
    if (new RegExp(`__webpack_require__\\.${name}\\b`).test(code)) {
      runtimeGlobals.push(name);
    }
  }
  return runtimeGlobals;
}

function collectSourceMapUrls(code) {
  const items = [];
  const pattern = /[#@]\s*sourceMappingURL=([^\s*]+)/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    items.push(match[1].trim());
  }
  return unique(items);
}

function detectChunkLoading(code) {
  const strategies = [];
  if (/script\.src\s*=\s*__webpack_require__\.p/.test(code) || /document\.createElement\(['"]script['"]\)/.test(code)) {
    strategies.push('script-tag');
  }
  if (/importScripts\(/.test(code)) {
    strategies.push('worker-importScripts');
  }
  if (/fetch\(__webpack_require__\.p/.test(code)) {
    strategies.push('fetch');
  }
  return strategies;
}

export function analyzeBundle(code) {
  const modules = extractModules(code);
  const chunks = extractChunks(code);
  const sourceMapUrls = collectSourceMapUrls(code);
  const runtimeGlobals = collectRuntimeGlobals(code);

  return {
    isWebpack: isWebpackBundle(code),
    version: detectWebpackVersion(code),
    modules,
    chunks,
    entryPoints: findEntryPoints(code),
    externalDeps: findExternals(code),
    structure: {
      moduleIdType: modules.moduleIdType,
      runtimeGlobals,
      runtimeGlobalCount: runtimeGlobals.length,
      dynamicImportCount: (code.match(/import\s*\(/g) ?? []).length,
      sourceMapUrls,
      sourceMapCount: sourceMapUrls.length,
      chunkLoading: detectChunkLoading(code),
    },
  };
}

export function extractModuleCode(code, moduleId) {
  for (const pattern of [
    new RegExp(`\\[${moduleId}\\]\\s*:\\s*(?:async\\s*)?function\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'g'),
    new RegExp(`["']${moduleId}["']\\s*:\\s*(?:async\\s*)?function\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'g'),
    new RegExp(`["']${moduleId}["']\\s*:\\s*\\([^)]*\\)\\s*=>\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'g'),
  ]) {
    const match = pattern.exec(code);
    if (match) {
      return {
        success: true,
        moduleId,
        code: match[1],
        length: match[1].length,
      };
    }
  }

  return {
    success: false,
    error: `Module ${moduleId} not found`,
  };
}
