# OmniCrawl 配置示例

当前版本已经接入主链路的全局配置主要是：

- `performance.concurrency`
- `performance.timeout`
- `security.validation.maxCodeLength`
- `security.validation.allowDangerousPatterns`
- `security.validation.allowPrivateIPs`

其它字段仍然适合作为你自己的配置对象模板，但不会自动影响所有运行时模块。

## JavaScript 配置对象

创建 `omnicrawl.config.js` 并在入口手动加载：

```javascript
export default {
  // 逆向工程配置
  reverse: {
    // AST 解析缓存
    astCache: {
      enabled: true,
      maxSize: 100,        // 最大缓存条目数
      ttl: 3600000,        // 缓存过期时间（毫秒）
    },
    
    // 沙箱配置
    sandbox: {
      vmTimeout: 10000,    // VM 执行超时（毫秒）
      interceptNetwork: true,
      freezeTime: null,    // 冻结时间（null = 不冻结）
    },
    
    // 代码优化器
    optimizer: {
      maxPasses: 5,        // 最大优化轮数
      enabled: true,
    },
  },
  
  // 反检测配置
  stealth: {
    // 指纹防护
    fingerprint: {
      canvas: true,
      webgl: true,
      audio: true,
      fonts: true,
      noiseLevel: 3,       // 噪声级别 0-10
    },
    
    // TLS 指纹
    tlsProfile: 'chrome_120',
    
    // 行为模拟
    behaviorSimulation: true,
  },
  
  // 安全配置
  security: {
    // 输入验证
    validation: {
      maxCodeLength: 1000000,
      allowDangerousPatterns: false,
      allowPrivateIPs: false,
    },
    
    // 速率限制
    rateLimit: {
      enabled: true,
      maxRequests: 100,
      windowMs: 60000,
    },
  },
  
  // 性能配置
  performance: {
    concurrency: 10,     // 并发数
    timeout: 30000,      // 请求超时（毫秒）
    retries: 3,          // 重试次数
  },
};
```

## 环境变量配置

创建 `.env`:

```bash
# 日志级别
LOG_LEVEL=info          # debug, info, warn, error, silent
LOG_JSON=false          # 是否输出 JSON 格式

# 性能配置
OMNICRAWL_CONCURRENCY=10
OMNICRAWL_TIMEOUT=30000

# AST 缓存
# 仅支持显式关闭
OMNICRAWL_AST_CACHE=false

# 代理配置
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080

# 告警配置
SLACK_WEBHOOK=https://hooks.slack.com/services/xxx
DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=xxx
```

## 使用配置

### 方式 1：加载配置文件

```javascript
import { setGlobalConfig } from 'omnicrawl';
import config from './omnicrawl.config.js';

setGlobalConfig(config);
```

### 方式 2：环境变量

```javascript
import { loadConfigFromEnv } from 'omnicrawl';

loadConfigFromEnv();
```

### 方式 3：代码配置

```javascript
import { ConfigManager } from 'omnicrawl';

const config = new ConfigManager({
  performance: {
    concurrency: 20,
    timeout: 60000,
  },
  reverse: {
    astCache: {
      maxSize: 200,
    },
  },
});

// 获取配置
const concurrency = config.get('performance.concurrency');

// 设置配置
config.set('performance.timeout', 90000);

// 获取所有配置
const allConfig = config.getAll();
```

## 生产环境配置示例

```javascript
export default {
  reverse: {
    astCache: {
      enabled: true,
      maxSize: 500,        // 生产环境增大缓存
      ttl: 7200000,        // 2 小时
    },
    sandbox: {
      vmTimeout: 5000,     // 生产环境缩短超时
      interceptNetwork: true,
    },
  },
  
  stealth: {
    fingerprint: {
      canvas: true,
      webgl: true,
      audio: true,
      fonts: true,
      noiseLevel: 5,       // 生产环境增加噪声
    },
    tlsProfile: 'chrome_120',
    behaviorSimulation: true,
  },
  
  security: {
    validation: {
      maxCodeLength: 500000,  // 生产环境限制更严格
      allowDangerousPatterns: false,
      allowPrivateIPs: false,
    },
    rateLimit: {
      enabled: true,
      maxRequests: 50,        // 生产环境更严格
      windowMs: 60000,
    },
  },
  
  performance: {
    concurrency: 50,          // 生产环境高并发
    timeout: 20000,           // 更短超时
    retries: 5,               // 更多重试
  },
};
```

## 开发环境配置示例

```javascript
export default {
  reverse: {
    astCache: {
      enabled: true,
      maxSize: 50,           // 开发环境小缓存
      ttl: 1800000,          // 30 分钟
    },
    sandbox: {
      vmTimeout: 30000,      // 开发环境长超时便于调试
      interceptNetwork: true,
    },
  },
  
  stealth: {
    fingerprint: {
      canvas: false,         // 开发环境可关闭部分功能
      webgl: false,
      audio: false,
      fonts: false,
      noiseLevel: 0,
    },
    tlsProfile: 'chrome_120',
    behaviorSimulation: false,
  },
  
  security: {
    validation: {
      maxCodeLength: 2000000,
      allowDangerousPatterns: true,  // 开发环境允许
      allowPrivateIPs: true,         // 开发环境允许
    },
    rateLimit: {
      enabled: false,                // 开发环境关闭限流
    },
  },
  
  performance: {
    concurrency: 5,
    timeout: 60000,
    retries: 1,
  },
};
```
