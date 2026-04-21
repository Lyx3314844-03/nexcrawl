import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FunctionTracer, traceFunction } from '../../src/reverse/function-tracer.js';

describe('FunctionTracer', () => {
  let tracer;

  beforeEach(() => {
    tracer = new FunctionTracer();
  });

  it('should trace function calls', () => {
    const context = {
      add: (a, b) => a + b,
      multiply: (a, b) => a * b,
    };
    tracer.hook(context);
    
    const result = context.add(2, 3);
    assert.strictEqual(result, 5);
    
    const chain = tracer.getCallChain();
    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].fnName, 'add');
    assert.deepStrictEqual(chain[0].args, [2, 3]);
    assert.strictEqual(chain[0].result, 5);
  });

  it('should trace nested calls', () => {
    const context = {
      outer: function(x) {
        return this.inner(x * 2);
      },
      inner: (x) => x + 1,
    };
    tracer.hook(context);
    
    context.outer(5);
    const chain = tracer.getCallChain();
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(chain[0].fnName, 'outer');
    assert.strictEqual(chain[1].fnName, 'inner');
  });

  it('should handle errors gracefully', () => {
    const context = {
      failing: () => { throw new Error('test error'); },
    };
    tracer.hook(context);
    
    try {
      context.failing();
    } catch {}
    
    const chain = tracer.getCallChain();
    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].error, 'test error');
  });
});

describe('traceFunction', () => {
  it('should trace function execution from code', async () => {
    const code = `
      function sign(url, timestamp) {
        return url + ':' + timestamp;
      }
    `;
    
    const result = await traceFunction(code, 'sign', ['/api/data', '1234567890']);
    assert.strictEqual(result.result, '/api/data:1234567890');
    assert.strictEqual(result.trace.length, 1);
    assert.strictEqual(result.error, null);
  });
});
