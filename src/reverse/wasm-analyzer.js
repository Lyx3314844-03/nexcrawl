/**
 * WebAssembly Reverse Engineering Support.
 * Analyzes WASM modules, extracts imports/exports, and provides disassembly.
 */

// ─── WASM Binary Parsing ──────────────────────────────────────────────────

const WASM_MAGIC = 0x6d736100; // '\0asm'
const WASM_VERSION = 1;

const SECTION_TYPES = {
  0: 'custom',
  1: 'type',
  2: 'import',
  3: 'function',
  4: 'table',
  5: 'memory',
  6: 'global',
  7: 'export',
  8: 'start',
  9: 'element',
  10: 'code',
  11: 'data',
  12: 'datacount',
};

function readLEB128(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  
  return { value: result, nextOffset: pos };
}

function readString(buf, offset) {
  const { value: length, nextOffset } = readLEB128(buf, offset);
  const str = buf.subarray(nextOffset, nextOffset + length).toString('utf8');
  return { value: str, nextOffset: nextOffset + length };
}

// ─── WASM Module Analysis ─────────────────────────────────────────────────

/**
 * Analyze a WebAssembly module binary.
 */
export function analyzeWasmModule(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  
  // Validate magic number
  const magic = buf.readUInt32LE(0);
  if (magic !== WASM_MAGIC) {
    return { valid: false, error: 'Invalid WASM magic number' };
  }
  
  // Validate version
  const version = buf.readUInt32LE(4);
  if (version !== WASM_VERSION) {
    return { valid: false, error: `Unsupported WASM version: ${version}` };
  }
  
  const sections = [];
  let offset = 8;
  
  while (offset < buf.length) {
    const sectionId = buf[offset++];
    const { value: sectionSize, nextOffset } = readLEB128(buf, offset);
    offset = nextOffset;
    
    const sectionData = buf.subarray(offset, offset + sectionSize);
    sections.push({
      id: sectionId,
      type: SECTION_TYPES[sectionId] ?? 'unknown',
      size: sectionSize,
      data: sectionData,
    });
    
    offset += sectionSize;
  }
  
  return {
    valid: true,
    version,
    sections,
    size: buf.length,
  };
}

/**
 * Extract imports from WASM module.
 */
export function extractWasmImports(buffer) {
  const analysis = analyzeWasmModule(buffer);
  if (!analysis.valid) return [];
  
  const importSection = analysis.sections.find((s) => s.type === 'import');
  if (!importSection) return [];
  
  const imports = [];
  let offset = 0;
  const data = importSection.data;
  
  const { value: count, nextOffset } = readLEB128(data, offset);
  offset = nextOffset;
  
  for (let i = 0; i < count && offset < data.length; i++) {
    const { value: module, nextOffset: o1 } = readString(data, offset);
    const { value: name, nextOffset: o2 } = readString(data, o1);
    const kind = data[o2];
    offset = o2 + 1;
    
    // Skip type index/limits based on kind
    if (kind === 0) { // function
      const { nextOffset: o3 } = readLEB128(data, offset);
      offset = o3;
    } else if (kind === 1) { // table
      offset += 2; // element type + limits
    } else if (kind === 2) { // memory
      offset += 1; // limits
    } else if (kind === 3) { // global
      offset += 2; // value type + mutability
    }
    
    imports.push({
      module,
      name,
      kind: ['function', 'table', 'memory', 'global'][kind] ?? 'unknown',
    });
  }
  
  return imports;
}

/**
 * Extract exports from WASM module.
 */
export function extractWasmExports(buffer) {
  const analysis = analyzeWasmModule(buffer);
  if (!analysis.valid) return [];
  
  const exportSection = analysis.sections.find((s) => s.type === 'export');
  if (!exportSection) return [];
  
  const exports = [];
  let offset = 0;
  const data = exportSection.data;
  
  const { value: count, nextOffset } = readLEB128(data, offset);
  offset = nextOffset;
  
  for (let i = 0; i < count && offset < data.length; i++) {
    const { value: name, nextOffset: o1 } = readString(data, offset);
    const kind = data[o1];
    const { value: index, nextOffset: o2 } = readLEB128(data, o1 + 1);
    offset = o2;
    
    exports.push({
      name,
      kind: ['function', 'table', 'memory', 'global'][kind] ?? 'unknown',
      index,
    });
  }
  
  return exports;
}

/**
 * Get WASM module summary.
 */
export function getWasmSummary(buffer) {
  const analysis = analyzeWasmModule(buffer);
  if (!analysis.valid) return analysis;
  
  const imports = extractWasmImports(buffer);
  const exports = extractWasmExports(buffer);
  
  const sectionSummary = {};
  for (const section of analysis.sections) {
    sectionSummary[section.type] = (sectionSummary[section.type] ?? 0) + 1;
  }
  
  return {
    valid: true,
    version: analysis.version,
    size: analysis.size,
    sections: sectionSummary,
    imports: {
      count: imports.length,
      modules: [...new Set(imports.map((i) => i.module))],
      items: imports,
    },
    exports: {
      count: exports.length,
      functions: exports.filter((e) => e.kind === 'function').length,
      items: exports,
    },
  };
}

/**
 * Detect if a buffer contains WASM code.
 */
export function isWasmModule(buffer) {
  if (!buffer || buffer.length < 8) return false;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const magic = buf.readUInt32LE(0);
  return magic === WASM_MAGIC;
}

/**
 * Extract WASM from JavaScript code (embedded as base64 or hex).
 */
export function extractWasmFromJS(jsCode) {
  const wasmModules = [];
  
  // Match base64 encoded WASM
  const base64Pattern = /['"]([A-Za-z0-9+/]{100,}={0,2})['"]/g;
  let match;
  
  while ((match = base64Pattern.exec(jsCode)) !== null) {
    try {
      const decoded = Buffer.from(match[1], 'base64');
      if (isWasmModule(decoded)) {
        wasmModules.push({
          type: 'base64',
          offset: match.index,
          size: decoded.length,
          buffer: decoded,
        });
      }
    } catch {}
  }
  
  // Match hex encoded WASM
  const hexPattern = /['"]([0-9a-fA-F]{200,})['"]/g;
  while ((match = hexPattern.exec(jsCode)) !== null) {
    try {
      const decoded = Buffer.from(match[1], 'hex');
      if (isWasmModule(decoded)) {
        wasmModules.push({
          type: 'hex',
          offset: match.index,
          size: decoded.length,
          buffer: decoded,
        });
      }
    } catch {}
  }
  
  return wasmModules;
}

/**
 * Analyze WASM instantiation in JavaScript.
 */
export function analyzeWasmInstantiation(jsCode) {
  const instantiations = [];
  
  // Match WebAssembly.instantiate calls
  const instantiatePattern = /WebAssembly\.(instantiate|instantiateStreaming|compile|compileStreaming)\s*\(/g;
  let match;
  
  while ((match = instantiatePattern.exec(jsCode)) !== null) {
    const method = match[1];
    const context = jsCode.slice(Math.max(0, match.index - 100), Math.min(jsCode.length, match.index + 200));
    
    instantiations.push({
      method,
      offset: match.index,
      context,
    });
  }
  
  return instantiations;
}
