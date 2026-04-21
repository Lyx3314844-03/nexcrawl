/**
 * BloomFilter — memory-efficient probabilistic deduplication for large-scale crawls.
 *
 * Uses a Uint8Array bit array with k independent hash functions (FNV-1a variants).
 * False positive rate ≈ (1 - e^(-kn/m))^k where n=items, m=bits, k=hashCount.
 *
 * Typical usage:
 *   const bloom = new BloomFilter({ capacity: 1_000_000, errorRate: 0.01 });
 *   if (!bloom.has(url)) { bloom.add(url); crawl(url); }
 */

/**
 * FNV-1a 32-bit hash with a seed offset for independent hash functions.
 * @param {string} str
 * @param {number} seed - offset added to FNV offset basis
 * @returns {number} unsigned 32-bit integer
 */
function fnv1a(str, seed = 0) {
  let hash = (0x811c9dc5 + seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export class BloomFilter {
  /**
   * @param {Object} options
   * @param {number} [options.capacity=1000000] - Expected number of unique items
   * @param {number} [options.errorRate=0.01] - Acceptable false positive rate (0–1)
   * @param {number} [options.hashCount] - Override number of hash functions
   * @param {number} [options.bitSize] - Override bit array size
   */
  constructor({ capacity = 1_000_000, errorRate = 0.01, hashCount, bitSize } = {}) {
    // Optimal bit size: m = -n * ln(p) / (ln2)^2
    this.bitSize = bitSize ?? Math.ceil(-capacity * Math.log(errorRate) / (Math.LN2 ** 2));
    // Optimal hash count: k = (m/n) * ln2
    this.hashCount = hashCount ?? Math.max(1, Math.round((this.bitSize / capacity) * Math.LN2));
    this.bits = new Uint8Array(Math.ceil(this.bitSize / 8));
    this.count = 0;
  }

  /** @param {string} item */
  add(item) {
    for (let i = 0; i < this.hashCount; i++) {
      const bit = fnv1a(item, i * 0x9e3779b9) % this.bitSize;
      this.bits[bit >>> 3] |= 1 << (bit & 7);
    }
    this.count++;
  }

  /**
   * @param {string} item
   * @returns {boolean} true if item was probably seen before
   */
  has(item) {
    for (let i = 0; i < this.hashCount; i++) {
      const bit = fnv1a(item, i * 0x9e3779b9) % this.bitSize;
      if ((this.bits[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
    }
    return true;
  }

  /** Clear all bits */
  clear() {
    this.bits.fill(0);
    this.count = 0;
  }

  /** Estimated false positive rate given current fill */
  get falsePositiveRate() {
    const filled = this.bits.reduce((sum, byte) => {
      let b = byte;
      while (b) { sum += b & 1; b >>>= 1; }
      return sum;
    }, 0);
    return (filled / this.bitSize) ** this.hashCount;
  }

  /** Memory usage in bytes */
  get byteSize() {
    return this.bits.byteLength;
  }

  /** Serialize to a plain object for persistence */
  toJSON() {
    return {
      bitSize: this.bitSize,
      hashCount: this.hashCount,
      count: this.count,
      bits: Buffer.from(this.bits).toString('base64'),
    };
  }

  /** Restore from serialized object */
  static fromJSON(data) {
    const filter = new BloomFilter({ bitSize: data.bitSize, hashCount: data.hashCount });
    filter.count = data.count;
    const buf = Buffer.from(data.bits, 'base64');
    filter.bits.set(buf);
    return filter;
  }

  /** Alias for toJSON() — persistence compatibility */
  serialize() { return this.toJSON(); }

  /** Alias for fromJSON() — persistence compatibility */
  static deserialize(data) { return BloomFilter.fromJSON(data); }
}

/**
 * BloomDeduplicator — drop-in replacement for RequestDeduplicator using Bloom filter.
 * Suitable for 10M+ URL deduplication with ~10MB memory vs HashMap's ~800MB.
 */
export class BloomDeduplicator {
  /**
   * @param {Object} options
   * @param {number} [options.capacity=5000000]
   * @param {number} [options.errorRate=0.001]
   */
  constructor(options = {}) {
    this.filter = new BloomFilter({
      capacity: options.capacity ?? 5_000_000,
      errorRate: options.errorRate ?? 0.001,
    });
  }

  /**
   * @param {string} uniqueKey
   * @returns {boolean} true if already seen (duplicate)
   */
  isDuplicate(uniqueKey) {
    if (this.filter.has(uniqueKey)) return true;
    this.filter.add(uniqueKey);
    return false;
  }

  get stats() {
    return {
      count: this.filter.count,
      byteSize: this.filter.byteSize,
      falsePositiveRate: this.filter.falsePositiveRate,
    };
  }
}
