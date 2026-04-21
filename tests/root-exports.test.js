import test from 'node:test';
import assert from 'node:assert/strict';

test('root package exports remain importable and expose control-flow helpers', async () => {
  const mod = await import('../src/index.js');

  assert.equal(typeof mod.ControlFlowDeobfuscator, 'function');
  assert.equal(typeof mod.deobfuscateControlFlow, 'function');
  assert.equal(typeof mod.fullDeobfuscate, 'function');

  const helper = new mod.ControlFlowDeobfuscator('while (true) { break; }');
  assert.deepEqual(helper.findFlattenedFunctions(), []);
  assert.equal(typeof helper.getCode(), 'string');
});
