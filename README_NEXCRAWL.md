<div align="center">

<img src="https://img.shields.io/badge/NexCrawl-v1.1.0-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyek0xMSAxN3YtNkg5bDMtNCAzIDRoLTJ2NmgtMnoiLz48L3N2Zz4=" alt="NexCrawl">

# 🕷️ NexCrawl

### 新一代企业级智能爬虫框架

*Next-Generation Enterprise Intelligent Web Crawling Framework*

[![npm version](https://img.shields.io/badge/npm-1.1.0-cb3837?style=flat-square&logo=npm)](https://www.npmjs.com/package/nexcrawl)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?style=flat-square&logo=node.js)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-532%20passing-22c55e?style=flat-square&logo=checkmarx)](tests/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)](https://github.com/Lyx3314844-03/nexcrawl)

<br/>

> 集 **多模式抓取** · **深度反检测** · **JS逆向工程** · **分布式调度** · **完整可观测性** 于一体  
> 专为对抗强反爬保护目标而生

<br/>

[快速开始](#-快速开始) · [核心能力](#-核心能力) · [API文档](#-编程接口) · [部署指南](#-部署) · [示例](#-使用示例)

</div>

---

## 📦 安装

### Windows

```powershell
# 要求 Node.js >= 20.0.0
npm install nexcrawl

# 全局安装 CLI
npm install -g nexcrawl

# 验证安装
nexcrawl --version
```

### macOS

```bash
# 使用 Homebrew 安装 Node.js（如未安装）
brew install node

# 安装 NexCrawl
npm install nexcrawl

# 全局安装 CLI
sudo npm install -g nexcrawl

# 验证安装
nexcrawl --version
```

### Linux (Ubuntu / Debian / CentOS)

```bash
# Ubuntu / Debian — 安装 Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# 安装 NexCrawl
npm install nexcrawl

# 全局安装 CLI
sudo npm install -g nexcrawl

# 验证安装
nexcrawl --version
```

---

## 🚀 快速开始

```js
import { OmniCrawler } from 'nexcrawl';

const crawler = new OmniCrawler({ name: 'my-first-crawler' })
  .addRequests(['https://example.com'])
  .setMode('http')
  .onPage(async (ctx) => {
    const title = ctx.response.body.match(/<title>(.*?)<\/title>/)?.[1];
    await ctx.pushData({ title, url: ctx.request.url });
  });

const summary = await crawler.run();
console.log(`✅ 完成！抓取 ${summary.pagesFetched} 页，获取 ${summary.resultCount} 条数据`);
```

**启动 Web 服务**

```bash
nexcrawl serve --port 3100
# 访问 http://localhost:3100 打开 Dashboard
```

**运行 Workflow 配置文件**

```bash
nexcrawl run workflow.json
```

---

## 🎯 核心能力

### 一、抓取引擎

<table>
<tr>
<th>模式</th>
<th>说明</th>
<th>适用场景</th>
</tr>
<tr>
<td><code>http</code></td>
<td>原生 HTTP/1.1 + HTTP/2，无浏览器开销</td>
<td>API 接口、静态页面</td>
</tr>
<tr>
<td><code>cheerio</code></td>
<td>服务端 jQuery，轻量 HTML 解析</td>
<td>传统 HTML 页面</td>
</tr>
<tr>
<td><code>browser</code></td>
<td>Playwright / Puppeteer / Patchright</td>
<td>SPA、动态渲染页面</td>
</tr>
<tr>
<td><code>hybrid</code></td>
<td>同任务内自动切换 HTTP 和浏览器</td>
<td>混合型网站</td>
</tr>
<tr>
<td><code>websocket</code></td>
<td>订阅 WebSocket 数据流</td>
<td>实时行情、聊天数据</td>
</tr>
<tr>
<td><code>graphql</code></td>
<td>自动内省 Schema，支持分页</td>
<td>GraphQL API</td>
</tr>
<tr>
<td><code>sitemap</code></td>
<td>自动解析 sitemap.xml 作为种子</td>
<td>大型站点全量抓取</td>
</tr>
<tr>
<td><code>feed</code></td>
<td>RSS / Atom 订阅</td>
<td>新闻、博客内容</td>
</tr>
</table>

---

### 二、🛡️ 反检测与绕过

#### 指纹伪装

| 能力 | 说明 |
|------|------|
| **TLS 指纹** | JA3 / JA4 计算与伪造，内置 Chrome / Firefox / Safari 配置文件 |
| **HTTP/2 指纹** | SETTINGS 帧、WINDOW_UPDATE、HEADERS 优先级完整伪造 |
| **请求头顺序** | 按真实浏览器顺序排列 headers，通过 Akamai 检测 |
| **Canvas 噪声** | 注入 Canvas 指纹干扰代码 |
| **WebGL 保护** | 伪造渲染器信息（GPU 型号、厂商） |
| **AudioContext** | 音频指纹随机化 |
| **字体指纹** | 字体列表随机化 |
| **Client Hints** | `Sec-CH-UA` 等 HTTP 客户端提示完整伪造 |

#### 挑战绕过

| 目标 | 支持能力 |
|------|---------|
| **Cloudflare** | JS 挑战求解、等待 clearance cookie、构建绕过 headers |
| **Akamai** | 专用 headers 构建、行为模拟 |
| **PerimeterX** | Cookie 挑战处理、脚本规避 |
| **DataDome** | Cookie 挑战自动处理 |
| **CAPTCHA** | 对接 CapSolver 等第三方服务，支持图片/滑块/点选 |

#### 行为模拟

```js
// 启用完整隐身模式
crawler.useStealth({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)...',
  locale: 'zh-CN',
  platform: 'Win32',
})
```

- 🖱️ 鼠标轨迹生成（贝塞尔曲线）
- ⌨️ 打字节奏模拟（随机延迟）
- 📜 滚动事件序列生成
- 🎭 交互序列编排与执行

#### 身份一致性

```js
crawler.setIdentity({
  enabled: true,
  userAgent: 'Chrome/120',
  acceptLanguage: 'zh-CN,zh',
  tlsProfile: 'chrome-latest',
  h2Profile: 'chrome-latest',
  consistency: { autoCorrect: true }  // 自动纠正漂移
})
```

---

### 三、🔬 JS 逆向工程

```
NexCrawl Reverse Engineering Stack
├── AST 分析层（Babel + Esprima）
│   ├── 字符串数组还原
│   ├── 控制流平坦化还原
│   ├── 常量折叠 / 死代码消除
│   └── AST 解析缓存（LRU）
├── 签名分析层
│   ├── 签名函数自动定位
│   ├── 依赖树提取
│   ├── RPC 包装生成
│   └── 参数结构推断
├── 协议分析层
│   ├── Protobuf 结构推断（无需 .proto）
│   ├── gRPC 请求/响应解析
│   ├── WASM 导入/导出分析
│   └── Webpack 模块依赖图
└── 运行时分析层
    ├── 浏览器沙箱隔离执行
    ├── CDP 实时调试
    ├── Node.js 加密逻辑分析
    └── SM2/SM3/SM4/AES/RSA 识别
```

**示例：自动提取签名函数**

```js
import { autoSetupSignatureRPC, callSignatureRPC } from 'nexcrawl/reverse';

// 自动定位并包装签名函数
const rpc = await autoSetupSignatureRPC(jsSource, { functionName: 'sign' });

// 直接调用签名
const signature = await callSignatureRPC(rpc, { timestamp: Date.now(), data: 'test' });
```

---

### 四、📋 请求队列与调度

#### 队列实现

| 类型 | 持久化 | 分布式 | 适用场景 |
|------|--------|--------|---------|
| 内存队列 | ❌ | ❌ | 开发测试 |
| SQLite 队列 | ✅ | ❌ | 单机生产 |
| Redis 队列 | ✅ | ✅ | 多机分布式 |

#### 调度特性

- 🎯 **优先级队列**：种子页(100) > 发现页(50) > 分页(80)
- 🏠 **主机感知调度**：同主机请求均匀分散，防止单站过载
- 🪣 **预算窗口限速**：时间窗口内最多 N 个请求
- 🔄 **断点续爬**：进程重启后自动从上次位置恢复
- 🚦 **组退避**：失败后自动降速该域名，隔离重试风暴
- 🏷️ **发现通道**：独立并发控制不同类型的发现链接

---

### 五、🌐 代理管理

```js
crawler.setProxyPool({
  strategy: 'roundRobin',  // roundRobin | weighted | sticky
  servers: [
    { server: 'http://proxy1:8080', username: 'user', password: 'pass', weight: 2 },
    { server: 'http://proxy2:8080', region: 'us', country: 'US' },
  ],
  maxFailures: 3,        // 失败 3 次进入冷却
  cooldownMs: 30000,     // 冷却 30 秒
  allowDirectFallback: true,
})
```

**支持的代理提供商**：Bright Data · Smartproxy · Oxylabs · 自定义列表

---

### 六、💾 数据提取与存储

#### 提取规则

```json
{
  "extract": [
    { "type": "selector", "selector": "h1.title", "field": "title" },
    { "type": "xpath", "xpath": "//div[@class='price']", "field": "price" },
    { "type": "regex", "pattern": "\"stock\":(\\d+)", "field": "stock" },
    { "type": "json", "path": "$.data.items", "field": "items" },
    { "type": "script", "code": "return document.title", "field": "pageTitle" }
  ]
}
```

#### 导出目标

```
本地文件    → CSV / JSON / JSONL
数据库      → PostgreSQL / MySQL / MongoDB
云存储      → Amazon S3 / Google Cloud Storage / Azure Blob
HTTP        → Webhook（带重试 + Outbox）
```

---

### 七、📊 可观测性

```
监控栈
├── Prometheus 指标导出（/metrics 端点）
├── OpenTelemetry 分布式追踪（OTLP 导出）
├── 质量监控
│   ├── 结构漂移检测（字段缺失/新增告警）
│   ├── WAF 识别（检测是否被拦截）
│   ├── 结果质量评分
│   └── 基线对比（与历史运行对比）
└── 告警通道
    ├── Webhook
    ├── Slack
    ├── 钉钉
    └── 邮件（SMTP）
```

---

### 八、🔧 爬取策略

| 功能 | 说明 |
|------|------|
| **Robots.txt** | 自动获取解析，遵守 Disallow/Allow/Crawl-delay |
| **速率限制** | 令牌桶算法，支持 burst，自适应节流 |
| **HTTP 缓存** | ETag / Last-Modified 条件请求，304 处理 |
| **重试策略** | 指数退避 + 抖动，按状态码配置 |
| **分页发现** | 自动识别下一页链接（rel=next / 文本匹配） |
| **变更追踪** | 对比历史结果，检测字段变化，变更 Feed API |

---

### 九、🏗️ 分布式部署

```
分布式架构
├── 控制平面（Redis）
│   ├── Job Queue — 分布式任务队列
│   ├── Schedule Manager — 分布式调度（租约机制）
│   ├── Event Bus — 事件广播
│   └── Worker Registry — Worker 注册发现
└── 数据平面（Redis + SQLite）
    ├── 分布式结果存储
    ├── 分布式事件日志
    ├── 分布式 Artifact 存储
    └── 自动 GC（过期数据清理）
```

---

## 💻 编程接口

### 链式 API

```js
import { OmniCrawler } from 'nexcrawl';

const crawler = new OmniCrawler({ name: 'product-crawler', projectRoot: './data' })
  // 添加种子
  .addRequests(['https://shop.example.com/products'])
  // 设置模式
  .setMode('browser')
  // 反检测配置
  .useStealth()
  .setIdentity({ userAgent: 'Chrome/120', tlsProfile: 'chrome-latest' })
  // 代理配置
  .setProxyPool({ servers: [{ server: 'http://proxy:8080' }] })
  // 速率限制
  .setRateLimiter({ requestsPerSecond: 2, burstSize: 5 })
  // 路由处理
  .onPage(async (ctx) => {
    // 提取数据
    const price = ctx.extracted.price;
    const title = ctx.extracted.title;

    // 存储数据
    await ctx.pushData({ title, price, url: ctx.request.url });

    // 发现更多链接
    await ctx.enqueueExtractedLinks('a.product-link');
  })
  // 导出配置
  .setOutput({ path: 'results.csv' });

const summary = await crawler.run();
```

### 预设爬虫类

```js
import {
  HttpCrawler,        // 纯 HTTP 爬虫
  CheerioCrawler,     // Cheerio HTML 解析
  BrowserCrawler,     // 浏览器爬虫
  HybridCrawler,      // 混合模式
  PlaywrightCrawler,  // Playwright 专用
  PatchrightCrawler,  // 反检测浏览器
  GraphQLCrawler,     // GraphQL API
  WebSocketCrawler,   // WebSocket 数据流
  SitemapCrawler,     // Sitemap 全量抓取
} from 'nexcrawl';
```

### Workflow JSON 配置

```json
{
  "name": "product-scraper",
  "seedUrls": ["https://shop.example.com"],
  "mode": "cheerio",
  "concurrency": 5,
  "extract": [
    { "type": "selector", "selector": ".product-title", "field": "title" },
    { "type": "selector", "selector": ".price", "field": "price" }
  ],
  "discovery": {
    "enabled": true,
    "maxPages": 1000,
    "include": ["https://shop.example.com/products/**"]
  },
  "output": {
    "path": "results.csv",
    "format": "csv"
  },
  "rateLimiter": {
    "requestsPerSecond": 2
  }
}
```

### CLI 命令

```bash
# 运行 Workflow
nexcrawl run workflow.json

# 启动 HTTP API + Dashboard
nexcrawl serve --port 3100 --host 0.0.0.0

# 查看框架能力
nexcrawl capabilities

# 查看历史任务
nexcrawl history

# 管理代理
nexcrawl proxies
nexcrawl proxy-probe proxy-1 --url https://example.com

# 查看集成状态
nexcrawl integrations
```

---

## 🐳 部署

### Docker Compose（推荐）

```yaml
# docker-compose.yml
version: '3.8'
services:
  nexcrawl:
    image: nexcrawl:latest
    ports:
      - "3100:3100"
    environment:
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis

  redis:
    image: redis:7-alpine

  prometheus:
    image: prom/prometheus
    volumes:
      - ./deploy/docker/prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
```

```bash
docker-compose up -d
```

### Kubernetes

```bash
helm install nexcrawl ./deploy/helm/nexcrawl \
  --set redis.enabled=true \
  --set replicas=3
```

---

## 📈 性能基准

| 场景 | 并发数 | 速率 |
|------|--------|------|
| HTTP 模式（无代理） | 50 | ~500 req/s |
| HTTP 模式（带代理池） | 20 | ~200 req/s |
| 浏览器模式 | 5 | ~20 req/s |
| 分布式（3 Worker） | 150 | ~1500 req/s |

---

## 🧪 测试

```bash
# 运行全部测试（532 个）
npm test

# 运行逆向工程测试
npm run test:reverse

# 运行 API 测试
npm run test:api

# 测试覆盖率
npm run test:coverage
```

---

## 📁 项目结构

```
nexcrawl/
├── src/
│   ├── api/           # 编程 API（OmniCrawler、Router、CrawlContext）
│   ├── fetchers/      # 抓取引擎（HTTP、Browser、WS、GraphQL）
│   ├── runtime/       # 运行时（队列、代理、会话、导出、调度）
│   ├── reverse/       # 逆向工程（AST、签名、协议、沙箱）
│   ├── plugins/       # 插件系统
│   ├── utils/         # 工具函数
│   └── core/          # 核心（日志、错误）
├── tests/             # 测试套件（532 个测试）
├── examples/          # 使用示例
├── deploy/            # 部署配置（Docker、Helm、K8s）
└── docs/              # 文档
```

---

## 🔌 插件系统

```js
// 自定义插件
const myPlugin = {
  name: 'my-plugin',

  async beforeRequest({ request }) {
    // 修改请求
    request.headers['x-custom'] = 'value';
  },

  async afterResponse({ response }) {
    // 处理响应
    if (response.status === 429) {
      return { reverseChallenge: { detected: true, shouldRetry: true } };
    }
  },

  async onError({ error, item }) {
    console.error(`Failed: ${item.url}`, error.message);
  },
};

crawler.use(myPlugin);
```

**内置插件**：去重 · 节流 · 审计 · UA 轮换

---

## 🆚 与主流框架对比

| 能力 | Scrapy | Crawlee | **NexCrawl** |
|------|--------|---------|-------------|
| TLS 指纹伪装 | ❌ | ❌ | ✅ JA3/JA4 |
| HTTP/2 指纹 | ❌ | ❌ | ✅ |
| JS 反混淆 | ❌ | ❌ | ✅ AST 级别 |
| 身份一致性检测 | ❌ | ❌ | ✅ 自动纠正 |
| Cloudflare 绕过 | 需插件 | ❌ | ✅ 内置 |
| WAF 对抗 | ❌ | ❌ | ✅ 多厂商 |
| 分布式队列 | 需插件 | ❌ | ✅ Redis 原生 |
| 断点续爬 | 需插件 | ✅ | ✅ |
| Protobuf 推断 | ❌ | ❌ | ✅ |
| WASM 分析 | ❌ | ❌ | ✅ |
| 行为模拟 | ❌ | ❌ | ✅ |
| 质量监控 | ❌ | ❌ | ✅ |

---

## 📄 许可证

[MIT License](LICENSE) © 2026 NexCrawl Contributors

---

<div align="center">

**如果这个项目对你有帮助，请给一个 ⭐ Star！**

[![GitHub stars](https://img.shields.io/github/stars/Lyx3314844-03/nexcrawl?style=social)](https://github.com/Lyx3314844-03/nexcrawl)

</div>
