import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BrowserSandbox, runInBrowserSandbox } from '../../src/reverse/browser-sandbox.js';

describe('BrowserSandbox', () => {
  it('should execute code in sandbox', async () => {
    const sb = new BrowserSandbox();
    await sb.build();
    sb.run('var result = 1 + 1;');
    
    const result = sb.get('result');
    assert.strictEqual(result, 2);
  });

  it('should provide DOM APIs', async () => {
    const sb = new BrowserSandbox();
    await sb.build();
    sb.run('var title = document.title;');
    
    const title = sb.get('title');
    assert.strictEqual(typeof title, 'string');
  });

  it('should intercept fetch calls', async () => {
    const sb = new BrowserSandbox({ interceptNetwork: true });
    await sb.build();
    sb.run('fetch("https://api.example.com/data");');
    
    assert.strictEqual(sb.capturedRequests.length, 1);
    assert.strictEqual(sb.capturedRequests[0].type, 'fetch');
    assert.strictEqual(sb.capturedRequests[0].url, 'https://api.example.com/data');
  });

  it('should freeze time when configured', async () => {
    const frozenTime = 1234567890000;
    const sb = new BrowserSandbox({ freezeTime: frozenTime });
    await sb.build();
    sb.run('var now = Date.now();');
    
    const now = sb.get('now');
    assert.strictEqual(now, frozenTime);
  });

  it('should handle localStorage', async () => {
    const sb = new BrowserSandbox({ localStorage: { key: 'value' } });
    await sb.build();
    sb.run('var val = localStorage.getItem("key");');
    
    const val = sb.get('val');
    assert.strictEqual(val, 'value');
  });
});

describe('runInBrowserSandbox', () => {
  it('should run code and call function', async () => {
    const code = 'function add(a, b) { return a + b; }';
    const result = await runInBrowserSandbox(code, 'add', [2, 3]);
    
    assert.strictEqual(result.result, 5);
    assert.strictEqual(result.callError, null);
  });
});
