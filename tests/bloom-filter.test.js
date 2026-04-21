import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BloomFilter } from '../src/runtime/bloom-filter.js';

describe('BloomFilter', () => {
  it('should initialize with default parameters', () => {
    const bloom = new BloomFilter();
    assert.ok(bloom);
    assert.ok(bloom.bitSize > 0);
    assert.ok(bloom.hashCount > 0);
  });

  it('should add and check items', () => {
    const bloom = new BloomFilter({ capacity: 100, errorRate: 0.01 });
    
    bloom.add('https://example.com');
    assert.strictEqual(bloom.has('https://example.com'), true);
    assert.strictEqual(bloom.has('https://other.com'), false);
  });

  it('should handle multiple items', () => {
    const bloom = new BloomFilter({ capacity: 1000, errorRate: 0.01 });
    const urls = Array.from({ length: 100 }, (_, i) => `https://example.com/${i}`);
    
    urls.forEach(url => bloom.add(url));
    urls.forEach(url => assert.strictEqual(bloom.has(url), true));
  });

  it('should have low false positive rate', () => {
    const bloom = new BloomFilter({ capacity: 1000, errorRate: 0.01 });
    const added = Array.from({ length: 500 }, (_, i) => `url-${i}`);
    const notAdded = Array.from({ length: 500 }, (_, i) => `other-${i}`);
    
    added.forEach(url => bloom.add(url));
    
    const falsePositives = notAdded.filter(url => bloom.has(url)).length;
    const rate = falsePositives / notAdded.length;
    
    assert.ok(rate < 0.05, `False positive rate ${rate} exceeds 5%`);
  });

  it('should serialize and deserialize', () => {
    const bloom = new BloomFilter({ capacity: 100, errorRate: 0.01 });
    bloom.add('test1');
    bloom.add('test2');
    
    const serialized = bloom.serialize();
    const restored = BloomFilter.deserialize(serialized);
    
    assert.strictEqual(restored.has('test1'), true);
    assert.strictEqual(restored.has('test2'), true);
    assert.strictEqual(restored.has('test3'), false);
  });
});
