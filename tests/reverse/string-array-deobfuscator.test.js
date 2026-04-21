import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringArrayDeobfuscator, deobfuscateStringArray } from '../../src/reverse/string-array-deobfuscator.js';

describe('StringArrayDeobfuscator', () => {
  it('should find string arrays', () => {
    const code = `
      var _0x1234 = ['hello', 'world', 'test'];
      function _0xabcd(index) { return _0x1234[index]; }
    `;
    
    const deobf = new StringArrayDeobfuscator(code);
    const arrays = deobf.findStringArrays();
    
    assert.strictEqual(arrays.length, 1);
    assert.strictEqual(arrays[0].name, '_0x1234');
    assert.strictEqual(arrays[0].size, 3);
  });

  it('should deobfuscate string array references', () => {
    const code = `
      var _0x1234 = ['hello', 'world', 'test'];
      function _0xabcd(i) { return _0x1234[i]; }
      console.log(_0xabcd(0) + ' ' + _0xabcd(1));
    `;
    
    const result = deobfuscateStringArray(code);
    // deobfuscateStringArray returns { code, resolved, arrayName, strings }
    assert.ok(result.code.includes('"hello"'), `expected "hello" in: ${result.code}`);
    assert.ok(result.code.includes('"world"'), `expected "world" in: ${result.code}`);
  });

  it('should handle empty code', () => {
    const result = deobfuscateStringArray('');
    // Returns object with code property, not a raw string
    assert.strictEqual(result.code, '');
  });
});
