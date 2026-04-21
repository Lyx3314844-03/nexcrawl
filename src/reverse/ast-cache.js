/**
 * AST Parse Cache — avoid redundant parsing of the same code.
 * Uses LRU cache with configurable size and TTL.
 */

import { createHash } from 'node:crypto';
import * as babelParser from '@babel/parser';

const PARSER_OPTS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  plugins: ['jsx', 'typescript'],
  errorRecovery: true,
};

class LRUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

class ASTCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize ?? 100;
    this.ttl = options.ttl ?? 3600000; // 1 hour
    this.cache = new LRUCache(this.maxSize);
    this.hits = 0;
    this.misses = 0;
  }

  _hash(code) {
    return createHash('md5').update(code).digest('hex').slice(0, 16);
  }

  parse(code, options = {}) {
    const key = this._hash(code);
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.timestamp < this.ttl) {
      this.hits++;
      return cached.ast;
    }

    this.misses++;
    try {
      const ast = babelParser.parse(code, { ...PARSER_OPTS, ...options });
      this.cache.set(key, { ast, timestamp: Date.now() });
      return ast;
    } catch (error) {
      return null;
    }
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
    };
  }
}

// Global singleton
let globalCache = null;

export function getGlobalASTCache() {
  if (!globalCache) {
    globalCache = new ASTCache();
  }
  return globalCache;
}

export function parseWithCache(code, options = {}) {
  return getGlobalASTCache().parse(code, options);
}

export function clearASTCache() {
  if (globalCache) {
    globalCache.clear();
  }
}

export function getASTCacheStats() {
  return globalCache ? globalCache.getStats() : null;
}

export { ASTCache };
