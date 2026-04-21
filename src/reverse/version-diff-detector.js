/**
 * Version Diff Detector — detect changes between two versions of JavaScript code,
 * with focus on signature/encryption algorithm modifications.
 *
 * Use cases:
 *   - Monitor target site's JS updates
 *   - Alert when signature logic changes
 *   - Track anti-scraping countermeasures
 *
 * Strategy:
 *   1. AST-level diff: compare function structures, not just text
 *   2. Signature function tracking: detect changes in known sign functions
 *   3. Crypto pattern changes: track encryption algorithm modifications
 *   4. Severity scoring: critical (sign logic changed) vs minor (comments/formatting)
 */

import * as babelParser from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import { createHash } from 'node:crypto';
import { parseWithCache } from './ast-cache.js';

const traverse = traverseModule.default ?? traverseModule;

const PARSER_OPTS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  plugins: ['jsx', 'typescript'],
  errorRecovery: true,
};

// ─── Function extraction ──────────────────────────────────────────────────────

function extractFunctions(code) {
  let ast;
  try {
    ast = parseWithCache(code);
  } catch {
    return new Map();
  }

  const functions = new Map();

  traverse(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id?.name;
      if (!name) return;
      const body = path.toString();
      const hash = createHash('md5').update(body).digest('hex').slice(0, 8);
      functions.set(name, { type: 'function', body, hash, loc: path.node.loc });
    },
    VariableDeclarator(path) {
      const name = t.isIdentifier(path.node.id) ? path.node.id.name : null;
      if (!name) return;
      const init = path.node.init;
      if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
        const body = path.toString();
        const hash = createHash('md5').update(body).digest('hex').slice(0, 8);
        functions.set(name, { type: 'variable', body, hash, loc: path.node.loc });
      }
    },
    AssignmentExpression(path) {
      const left = path.node.left;
      const right = path.node.right;
      if (!t.isFunctionExpression(right) && !t.isArrowFunctionExpression(right)) return;
      const name = t.isIdentifier(left) ? left.name
        : t.isMemberExpression(left) && t.isIdentifier(left.property) ? left.property.name
        : null;
      if (!name) return;
      const body = path.toString();
      const hash = createHash('md5').update(body).digest('hex').slice(0, 8);
      functions.set(name, { type: 'assignment', body, hash, loc: path.node.loc });
    },
  });

  return functions;
}

// ─── Crypto pattern detection ─────────────────────────────────────────────────

const CRYPTO_PATTERNS = [
  /\b(md5|sha1|sha256|sha512|hmac|aes|des|rsa|sm2|sm3|sm4)\b/i,
  /\b(encrypt|decrypt|cipher|hash|digest|sign|verify)\b/i,
  /\b(CryptoJS|forge|jsencrypt|crypto-js)\b/i,
];

function detectCryptoUsage(code) {
  const matches = new Set();
  for (const pattern of CRYPTO_PATTERNS) {
    const found = code.match(new RegExp(pattern, 'gi'));
    if (found) found.forEach((m) => matches.add(m.toLowerCase()));
  }
  return [...matches];
}

// ─── Diff analysis ────────────────────────────────────────────────────────────

/**
 * Compare two versions of JavaScript code and detect changes.
 *
 * @param {string} oldCode - Previous version
 * @param {string} newCode - Current version
 * @param {Object} [options]
 * @param {string[]} [options.signatureFunctions] - Known signature function names to track
 * @param {boolean} [options.trackCrypto=true] - Detect crypto algorithm changes
 * @returns {{
 *   added: Array<{name: string, hash: string}>,
 *   removed: Array<{name: string, hash: string}>,
 *   modified: Array<{name: string, oldHash: string, newHash: string, severity: 'critical'|'high'|'medium'|'low'}>,
 *   unchanged: number,
 *   cryptoChanges: {added: string[], removed: string[]},
 *   summary: string,
 *   hasCriticalChanges: boolean
 * }}
 */
export function detectVersionDiff(oldCode, newCode, options = {}) {
  const { signatureFunctions = [], trackCrypto = true } = options;

  const oldFns = extractFunctions(oldCode);
  const newFns = extractFunctions(newCode);

  const added = [];
  const removed = [];
  const modified = [];
  let unchanged = 0;

  // Find removed functions
  for (const [name, info] of oldFns) {
    if (!newFns.has(name)) {
      removed.push({ name, hash: info.hash });
    }
  }

  // Find added and modified functions
  for (const [name, newInfo] of newFns) {
    const oldInfo = oldFns.get(name);
    if (!oldInfo) {
      added.push({ name, hash: newInfo.hash });
    } else if (oldInfo.hash !== newInfo.hash) {
      // Determine severity
      let severity = 'low';
      const isSignature = signatureFunctions.some((sf) => name.toLowerCase().includes(sf.toLowerCase()));
      if (isSignature) {
        severity = 'critical';
      } else if (/sign|encrypt|hash|crypto|auth|token/i.test(name)) {
        severity = 'high';
      } else if (oldInfo.body.length !== newInfo.body.length) {
        severity = 'medium';
      }
      modified.push({ name, oldHash: oldInfo.hash, newHash: newInfo.hash, severity });
    } else {
      unchanged++;
    }
  }

  // Crypto changes
  let cryptoChanges = { added: [], removed: [] };
  if (trackCrypto) {
    const oldCrypto = new Set(detectCryptoUsage(oldCode));
    const newCrypto = new Set(detectCryptoUsage(newCode));
    cryptoChanges.added = [...newCrypto].filter((c) => !oldCrypto.has(c));
    cryptoChanges.removed = [...oldCrypto].filter((c) => !newCrypto.has(c));
  }

  const hasCriticalChanges = modified.some((m) => m.severity === 'critical')
    || cryptoChanges.added.length > 0
    || cryptoChanges.removed.length > 0;

  const summary = [
    `Functions: +${added.length} -${removed.length} ~${modified.length} =${unchanged}`,
    hasCriticalChanges ? '⚠️  CRITICAL CHANGES DETECTED' : '✓ No critical changes',
  ].join(' | ');

  return {
    added,
    removed,
    modified,
    unchanged,
    cryptoChanges,
    summary,
    hasCriticalChanges,
  };
}

/**
 * Monitor a JS file for changes over time.
 * Stores version history and alerts on critical changes.
 */
export class VersionMonitor {
  constructor() {
    this.versions = []; // [{timestamp, code, hash, diff}]
    this.signatureFunctions = [];
  }

  /**
   * Add a new version snapshot.
   * @param {string} code
   * @param {Object} [metadata={}]
   */
  addVersion(code, metadata = {}) {
    const hash = createHash('md5').update(code).digest('hex').slice(0, 16);
    const timestamp = Date.now();

    let diff = null;
    if (this.versions.length > 0) {
      const prev = this.versions[this.versions.length - 1];
      diff = detectVersionDiff(prev.code, code, { signatureFunctions: this.signatureFunctions });
    }

    this.versions.push({ timestamp, code, hash, metadata, diff });
    return { hash, diff, hasCriticalChanges: diff?.hasCriticalChanges ?? false };
  }

  /**
   * Set known signature function names for tracking.
   */
  setSignatureFunctions(names) {
    this.signatureFunctions = names;
  }

  /**
   * Get the latest version.
   */
  getLatest() {
    return this.versions[this.versions.length - 1] ?? null;
  }

  /**
   * Get all versions with critical changes.
   */
  getCriticalVersions() {
    return this.versions.filter((v) => v.diff?.hasCriticalChanges);
  }

  /**
   * Get change history summary.
   */
  getSummary() {
    const total = this.versions.length;
    const critical = this.getCriticalVersions().length;
    return {
      totalVersions: total,
      criticalChanges: critical,
      latestHash: this.getLatest()?.hash ?? null,
      firstSeen: this.versions[0]?.timestamp ?? null,
      lastSeen: this.getLatest()?.timestamp ?? null,
    };
  }
}

/**
 * Convenience: compare two JS files and return a human-readable report.
 */
export function compareVersions(oldCode, newCode, signatureFunctions = []) {
  const diff = detectVersionDiff(oldCode, newCode, { signatureFunctions });
  const lines = [
    `=== Version Diff Report ===`,
    diff.summary,
    '',
  ];

  if (diff.added.length > 0) {
    lines.push(`Added (${diff.added.length}):`);
    diff.added.forEach((f) => lines.push(`  + ${f.name} [${f.hash}]`));
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push(`Removed (${diff.removed.length}):`);
    diff.removed.forEach((f) => lines.push(`  - ${f.name} [${f.hash}]`));
    lines.push('');
  }

  if (diff.modified.length > 0) {
    lines.push(`Modified (${diff.modified.length}):`);
    diff.modified.forEach((f) => {
      const icon = f.severity === 'critical' ? '🔴' : f.severity === 'high' ? '🟠' : '🟡';
      lines.push(`  ${icon} ${f.name} [${f.oldHash} → ${f.newHash}] (${f.severity})`);
    });
    lines.push('');
  }

  if (diff.cryptoChanges.added.length > 0 || diff.cryptoChanges.removed.length > 0) {
    lines.push('Crypto Changes:');
    diff.cryptoChanges.added.forEach((c) => lines.push(`  + ${c}`));
    diff.cryptoChanges.removed.forEach((c) => lines.push(`  - ${c}`));
    lines.push('');
  }

  return lines.join('\n');
}
