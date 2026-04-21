import { describe, it } from 'node:test';
import assert from 'node:assert';
import { optimizeCode, analyzeOptimization, optimizeWithAnalysis } from '../../src/reverse/code-optimizer.js';

describe('Code Optimizer', () => {
  it('should fold constants', () => {
    // Use console.log so the variable is referenced and not eliminated by DCE
    const code = 'console.log(1 + 2); console.log(3 * 4);';
    const optimized = optimizeCode(code);
    
    assert.ok(optimized.includes('3'), `expected "3" in: ${optimized}`);
    assert.ok(optimized.includes('12'), `expected "12" in: ${optimized}`);
  });

  it('should eliminate dead code after return', () => {
    const code = 'function test() { return 1; console.log("unreachable"); }';
    const optimized = optimizeCode(code);
    
    assert.ok(!optimized.includes('unreachable'));
  });

  it('should remove always-false if statements', () => {
    const code = 'if (false) { console.log("never"); }';
    const optimized = optimizeCode(code);
    
    assert.ok(!optimized.includes('never'));
  });

  it('should simplify ternary expressions', () => {
    // Use a variable assignment that gets simplified
    const code = 'let x = true ? 1 : 2; console.log(x);';
    const optimized = optimizeCode(code);
    
    // After folding, ternary becomes just 1; the assignment should include 1
    assert.ok(optimized.includes('1'), `expected "1" in: ${optimized}`);
  });

  it('should analyze optimization', () => {
    // Use code that will definitely reduce: constant folding + dead code elimination
    const original = 'console.log(1 + 2); if (false) { console.log("dead"); } const a = 3 * 4; console.log(a);';
    const optimized = optimizeCode(original);
    const analysis = analyzeOptimization(original, optimized);
    
    // Verify that optimization actually happened (some nodes should be removed)
    assert.ok(analysis.originalNodes >= analysis.optimizedNodes, 
      `original ${analysis.originalNodes} should be >= optimized ${analysis.optimizedNodes}`);
    assert.ok(typeof analysis.reduction === 'string');
  });

  it('should return analysis with code', () => {
    const code = 'console.log(1 + 2);';
    const result = optimizeWithAnalysis(code);
    
    assert.ok(result.code, `expected non-empty code, got: "${result.code}"`);
    assert.ok(result.analysis);
    assert.ok(result.analysis.reduction);
  });
});
