import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ASTCache, getGlobalASTCache, parseWithCache, clearASTCache, getASTCacheStats } from '../../src/reverse/ast-cache.js';

describe('ASTCache', () => {
  let cache;

  beforeEach(() => {
    cache = new ASTCache({ maxSize: 3 });
  });

  it('should parse and cache code', () => {
    const code = 'const x = 1 + 1;';
    const ast1 = cache.parse(code);
    const ast2 = cache.parse(code);
    
    assert.ok(ast1);
    assert.strictEqual(ast1, ast2); // Same reference = cached
    assert.strictEqual(cache.getStats().hits, 1);
    assert.strictEqual(cache.getStats().misses, 1);
  });

  it('should respect maxSize', () => {
    cache.parse('const a = 1;');
    cache.parse('const b = 2;');
    cache.parse('const c = 3;');
    cache.parse('const d = 4;'); // Should evict oldest
    
    assert.strictEqual(cache.getStats().size, 3);
  });

  it('should calculate hit rate', () => {
    const code = 'const x = 1;';
    cache.parse(code); // miss
    cache.parse(code); // hit
    cache.parse(code); // hit
    
    const stats = cache.getStats();
    assert.strictEqual(stats.hitRate, 2/3);
  });

  it('should clear cache', () => {
    cache.parse('const x = 1;');
    cache.clear();
    
    assert.strictEqual(cache.getStats().size, 0);
    assert.strictEqual(cache.getStats().hits, 0);
  });
});

describe('Global AST Cache', () => {
  beforeEach(() => {
    clearASTCache();
  });

  it('should use global cache', () => {
    const code = 'const x = 1;';
    parseWithCache(code);
    parseWithCache(code);
    
    const stats = getASTCacheStats();
    assert.strictEqual(stats.hits, 1);
  });
});
