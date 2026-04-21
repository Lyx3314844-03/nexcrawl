# OmniCrawl 完整使用示例

## 示例 1：完整的 JS 逆向工作流

```javascript
import {
  fullDeobfuscate,
  optimizeCode,
  inferSignatureParams,
  BrowserSandbox,
  withRetry,
} from 'omnicrawl';

// 步骤 1：获取混淆的 JS 代码
const obfuscatedCode = await fetch('https://example.com/app.js').then(r => r.text());

// 步骤 2：完整去混淆（字符串解密 + 控制流还原）
console.log('🔧 去混淆中...');
const deobfuscated = fullDeobfuscate(obfuscatedCode);

// 步骤 3：代码优化（死代码消除 + 常量折叠）
console.log('⚡ 优化代码...');
const { code: optimized, analysis } = optimizeWithAnalysis(deobfuscated);
console.log(`优化效果: 减少 ${analysis.reduction} 节点`);

// 步骤 4：分析签名函数
console.log('🔍 分析签名函数...');
const signatureAnalysis = inferSignatureParams(optimized, 'generateSign');
console.log('签名函数参数:', signatureAnalysis.params);
console.log('调用示例:', signatureAnalysis.callExample);

// 步骤 5：在沙箱中执行签名函数
console.log('🚀 执行签名函数...');
const sandbox = new BrowserSandbox({
  freezeTime: Date.now(), // 冻结时间保证一致性
});

try {
  await sandbox.build();
  sandbox.run(optimized);
  
  // 使用推断的参数调用
  const signature = sandbox.call('generateSign', [
    '/api/data',
    'POST',
    JSON.stringify({ key: 'value' }),
    Date.now().toString(),
    Math.random().toString(36).slice(2),
  ]);
  
  console.log('✅ 生成签名:', signature);
  console.log('📡 捕获的网络请求:', sandbox.capturedRequests);
  
} finally {
  sandbox.close(); // 清理资源
}
```

## 示例 2：完整的反指纹爬虫

```javascript
import {
  BrowserCrawler,
  Router,
} from 'omnicrawl';

const router = new Router().addDefaultHandler(async (ctx) => {
  const data = await ctx.page.evaluate(() => ({
    title: document.title,
    content: document.body.innerText,
  }));

  await ctx.pushData(data);
});

const crawler = new BrowserCrawler({ name: 'anti-bot-demo' })
  .addSeedUrls('https://protected-site.com')
  .useStealth({
    locale: 'zh-CN',
    canvasNoise: 3,
    audioNoise: 2,
  })
  .useTlsProfile('chrome_120')
  .useBehaviorSimulation({
    mouseMovement: true,
    scrolling: true,
    typing: true,
  })
  .useCloudflareSolver()
  .useRouter(router);

await crawler.run();
```

## 示例 3：WASM + JS 混合加密逆向

```javascript
import {
  extractWasmFromJS,
  getWasmSummary,
  analyzeWasmInstantiation,
  BrowserSandbox,
} from 'omnicrawl';

// 步骤 1：获取包含 WASM 的 JS
const jsCode = await fetch('https://example.com/crypto.js').then(r => r.text());

// 步骤 2：提取嵌入的 WASM 模块
console.log('🔍 提取 WASM 模块...');
const wasmModules = extractWasmFromJS(jsCode);
console.log(`找到 ${wasmModules.length} 个 WASM 模块`);

// 步骤 3：分析 WASM 结构
for (const wasm of wasmModules) {
  const summary = getWasmSummary(wasm.buffer);
  console.log('WASM 导入:', summary.imports.items);
  console.log('WASM 导出:', summary.exports.items);
}

// 步骤 4：分析 WASM 实例化
const instantiations = analyzeWasmInstantiation(jsCode);
console.log('WASM 实例化调用:', instantiations);

// 步骤 5：在沙箱中执行完整加密流程
const sandbox = new BrowserSandbox({ interceptNetwork: true });
try {
  await sandbox.build();
  sandbox.run(jsCode);
  
  // 调用加密函数
  const encrypted = sandbox.call('encrypt', ['sensitive data']);
  console.log('加密结果:', encrypted);
  
  // 查看 WASM 是否发起了网络请求
  console.log('网络请求:', sandbox.capturedRequests);
  
} finally {
  sandbox.close();
}
```

## 示例 4：版本监控和自动告警

```javascript
import {
  VersionMonitor,
  detectVersionDiff,
  sendSlackAlert,
} from 'omnicrawl';

const monitor = new VersionMonitor();
monitor.setSignatureFunctions(['sign', 'encrypt', 'generateToken']);

// 定期检查 JS 文件变化
setInterval(async () => {
  const newCode = await fetch('https://example.com/app.js').then(r => r.text());
  
  const { hasCriticalChanges, diff } = monitor.addVersion(newCode, {
    timestamp: Date.now(),
    source: 'https://example.com/app.js',
  });
  
  if (hasCriticalChanges) {
    console.warn('⚠️ 检测到关键变更！');
    console.log(diff.summary);
    
    // 发送告警
    await sendSlackAlert({
      webhook: process.env.SLACK_WEBHOOK,
      message: `JS 版本变更检测\n${diff.summary}`,
    });
    
    // 查看变更详情
    for (const change of diff.modified) {
      if (change.severity === 'critical') {
        console.error(`🔴 ${change.name} 函数发生变化`);
      }
    }
  }
}, 60000); // 每分钟检查一次
```

## 示例 5：错误处理和重试

```javascript
import {
  BrowserSandbox,
  withRetry,
  withTimeout,
  isRecoverableError,
  ReverseEngineeringError,
} from 'omnicrawl';

async function executeSignature(code, fnName, args) {
  const sandbox = new BrowserSandbox();
  
  try {
    await sandbox.build();
    sandbox.run(code);
    
    // 带超时的执行
    const result = await withTimeout(
      () => Promise.resolve(sandbox.call(fnName, args)),
      5000 // 5 秒超时
    );
    
    return result;
    
  } finally {
    sandbox.close();
  }
}

// 带重试的签名生成
const signWithRetry = withRetry(
  () => executeSignature(code, 'sign', ['/api/data']),
  {
    maxAttempts: 3,
    baseDelay: 1000,
    shouldRetry: (error) => {
      // 只重试可恢复的错误
      return isRecoverableError(error);
    },
  }
);

try {
  const signature = await signWithRetry();
  console.log('签名:', signature);
} catch (error) {
  if (error instanceof ReverseEngineeringError) {
    console.error('逆向失败:', error.message);
    console.error('上下文:', error.context);
  }
}
```

## 示例 6：输入验证和安全加固

```javascript
import {
  validateUrl,
  validateCode,
  validateNumber,
  RateLimiter,
  sanitizeHtml,
} from 'omnicrawl';

// URL 验证
try {
  const safeUrl = validateUrl(userInput, {
    allowedProtocols: ['https:'],
    allowPrivateIPs: false,
  });
  console.log('安全的 URL:', safeUrl);
} catch (error) {
  console.error('URL 验证失败:', error.message);
}

// 代码验证
try {
  const safeCode = validateCode(userCode, {
    maxLength: 100000,
    allowDangerousPatterns: false, // 阻止 require/eval
  });
  // 安全执行
} catch (error) {
  console.error('代码包含危险模式:', error.message);
}

// 速率限制
const limiter = new RateLimiter({
  maxRequests: 100,
  windowMs: 60000, // 1 分钟
});

app.post('/api/reverse', (req, res) => {
  try {
    const { remaining } = limiter.check(req.ip);
    console.log(`剩余请求: ${remaining}`);
    
    // 处理请求...
    
  } catch (error) {
    res.status(429).json({ error: '请求过于频繁' });
  }
});

// HTML 清理
const userComment = '<script>alert("xss")</script>Hello';
const safe = sanitizeHtml(userComment);
console.log(safe); // &lt;script&gt;...
```

## 最佳实践

### 1. 资源管理
```javascript
// ✅ 正确：使用 try-finally
const sandbox = new BrowserSandbox();
try {
  await sandbox.build();
  // 使用 sandbox...
} finally {
  sandbox.close(); // 确保清理
}

// ✅ 或使用便捷函数（自动清理）
const result = await runInBrowserSandbox(code, 'fn', args);
```

### 2. 性能优化
```javascript
// ✅ AST 缓存自动启用
import { parseWithCache, getASTCacheStats } from 'omnicrawl';

// 多次解析同一代码时自动使用缓存
const ast1 = parseWithCache(code);
const ast2 = parseWithCache(code); // 命中缓存

// 查看缓存统计
console.log(getASTCacheStats());
// { hits: 1, misses: 1, hitRate: 0.5 }
```

### 3. 错误处理
```javascript
// ✅ 使用结构化错误
import { OmniCrawlError, isRecoverableError } from 'omnicrawl';

try {
  // 操作...
} catch (error) {
  if (error instanceof OmniCrawlError) {
    console.log('错误代码:', error.code);
    console.log('上下文:', error.context);
    console.log('可恢复:', error.recoverable);
  }
}
```
