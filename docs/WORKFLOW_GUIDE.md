# Workflow 编写指南

> 学习如何使用 JSON Workflow 配置和执行数据采集任务

## 概述

Workflow 是 NexCrawl 的核心配置格式，使用 JSON 定义采集任务的目标、策略和输出。它是一个**声明式**配置，框架会根据配置自动选择执行引擎。

---

## 基本结构

```json
{
  "name": "example-workflow",
  "seedUrls": ["https://example.com"],
  "mode": "http",
  "concurrency": 1,
  "maxDepth": 0,
  "extract": [],
  "plugins": [
    { "name": "dedupe" },
    { "name": "audit" }
  ],
  "output": {
    "dir": "runs",
    "console": true,
    "persistBodies": false
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `name` | string | ✅ | 任务名称，用于日志和输出目录命名 |
| `seedUrls` | string[] | ✅ | 种子 URL 列表 |
| `mode` | string | ✅ | 执行模式（见下表） |
| `concurrency` | number | - | 并发数，默认 `1` |
| `maxDepth` | number | - | 最大爬取深度，`0` 表示仅种子页 |
| `extract` | array | - | 提取器配置（见下方） |
| `plugins` | array | - | 插件配置（去重、审计等） |
| `output` | object | - | 输出配置 |
| `discovery` | object | - | 链接发现配置 |
| `session` | object | - | 会话管理配置 |
| `proxyPool` | object | - | 代理池配置 |

---

## 执行模式 (mode)

| 模式 | 用途 | 适用场景 |
| --- | --- | --- |
| `http` | 普通网页、接口、速度优先 | 静态 HTML、REST API |
| `cheerio` | 静态 HTML 解析 | 无需 JS 渲染的页面 |
| `browser` | JS 渲染、SPA、需要 cookie/storage | 单页应用、动态内容 |
| `hybrid` | 自动在 HTTP 和浏览器之间折中 | 不确定页面类型时 |
| `websocket` | WebSocket 流 | 实时数据流订阅 |
| `graphql` | GraphQL 协议分析 | GraphQL API 采集 |
| `grpc` | gRPC/Protobuf 协议 | gRPC 服务采集 |

### 模式选择决策树

```
目标是什么类型？
├── 静态 HTML/API → http 或 cheerio
├── 需要 JS 渲染 → browser
├── 不确定 → hybrid（自动判断）
├── WebSocket 流 → websocket
├── GraphQL API → graphql
└── gRPC 服务 → grpc
```

---

## 提取器 (extract)

### 正则提取器

适用于从 HTML 或文本中提取特定模式的内容：

```json
{
  "name": "title",
  "type": "regex",
  "pattern": "<title>([^<]+)</title>"
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 提取字段名 |
| `type` | `"regex"` |
| `pattern` | 正则表达式，第一个捕获组为提取值 |

### CSS 选择器

适用于从 HTML DOM 中提取元素：

```json
{
  "name": "headline",
  "type": "selector",
  "selector": "h1"
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 提取字段名 |
| `type` | `"selector"` |
| `selector` | CSS 选择器 |
| `attribute` | （可选）提取属性，如 `href`、`src` |

### JSON Path

适用于从 JSON API 响应中提取数据：

```json
{
  "name": "items",
  "type": "json",
  "path": "data.items"
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 提取字段名 |
| `type` | `"json"` |
| `path` | JSON Path，支持点分 notation |

### 页面表面分析

自动分析页面结构，提取链接、表单、脚本等元数据：

```json
{
  "name": "surface",
  "type": "surface"
}
```

自动提取：
- 所有链接（`<a href>`）
- 表单（`<form>`）
- 脚本（`<script>`）
- 样式表（`<link>`）
- 图片（`<img>`）
- 元数据（`<meta>`）

---

## 链接发现 (discovery)

配置如何从当前页面发现并跟踪新链接：

```json
{
  "discovery": {
    "enabled": true,
    "maxPages": 20,
    "sameOriginOnly": true,
    "extractor": {
      "name": "links",
      "type": "links",
      "all": true
    }
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 是否启用链接发现 |
| `maxPages` | number | `100` | 最大发现页数 |
| `sameOriginOnly` | boolean | `true` | 是否仅限同源 |
| `urlPatterns` | string[] | - | URL 匹配模式（正则） |
| `excludePatterns` | string[] | - | URL 排除模式 |

---

## 会话与登录态管理

### 基础会话配置

```json
{
  "session": {
    "enabled": true,
    "scope": "job",
    "persist": true,
    "isolate": true,
    "captureStorage": true
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `scope` | `"job"`（任务级）或 `"workflow"`（工作流级） |
| `persist` | 是否持久化会话（重启后可复用） |
| `isolate` | 是否隔离会话（多任务不共享 cookie） |
| `captureStorage` | 是否捕获 localStorage/sessionStorage |

### 复杂登录场景

对于需要交互登录的场景，使用平台 API：

```bash
# 分析登录页面
curl -s http://127.0.0.1:3100/platform/login/analyze \
  -H "content-type: application/json" \
  -d '{"url": "https://example.com/login"}'

# 获取登录状态机
curl -s http://127.0.0.1:3100/platform/login/state-machine \
  -H "content-type: application/json" \
  -d '{"url": "https://example.com/login"}'

# 获取交互式登录计划
curl -s http://127.0.0.1:3100/platform/login/interactive-plan \
  -H "content-type: application/json" \
  -d '{"url": "https://example.com/login"}'
```

> 对于 SSO、扫码、Passkey 等复杂场景，框架会进入**人机协作**模式。详见 [执行器扩展指南](./EXECUTOR_EXTENSIONS.md)。

---

## 代理池配置

```json
{
  "proxyPool": {
    "enabled": true,
    "strategy": "stickySession",
    "servers": [
      {
        "label": "proxy-a",
        "server": "http://127.0.0.1:8080",
        "country": "US"
      },
      {
        "label": "proxy-b",
        "server": "http://127.0.0.1:8081",
        "country": "UK"
      }
    ]
  }
}
```

### 代理策略

| 策略 | 说明 |
| --- | --- |
| `roundRobin` | 轮询分配 |
| `stickySession` | 同一会话固定使用同一代理 |
| `geoTarget` | 按地理位置选择代理 |
| `healthBased` | 基于健康度选择 |

### 代理管理 API

```bash
# 查看代理列表
curl http://127.0.0.1:3100/runtime/proxies

# 代理控制
curl -s http://127.0.0.1:3100/runtime/proxies/control \
  -H "content-type: application/json" \
  -d '{"action": "enable", "label": "proxy-a"}'

# 重置代理状态
curl -s http://127.0.0.1:3100/runtime/proxies/reset

# 代理探测
curl -s http://127.0.0.1:3100/runtime/proxies/probe
```

---

## 输出配置

```json
{
  "output": {
    "dir": "runs",
    "console": true,
    "persistBodies": false,
    "format": "ndjson"
  }
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `dir` | `"runs"` | 输出目录 |
| `console` | `true` | 是否输出到控制台 |
| `persistBodies` | `false` | 是否持久化 HTML 正文 |
| `format` | `"ndjson"` | 输出格式：`ndjson` 或 `json` |

### 默认输出文件

```
runs/<jobId>/
├── summary.json        # 任务摘要
├── results.ndjson      # 采集结果
├── events.ndjson       # 事件日志
├── workflow.json       # 使用的 Workflow 配置
└── bodies/             # （可选）HTML 正文文件
```

---

## 完整示例

### 示例 1：简单 HTML 提取

```json
{
  "name": "news-scraper",
  "seedUrls": ["https://news.example.com"],
  "mode": "http",
  "concurrency": 2,
  "maxDepth": 1,
  "extract": [
    { "name": "title", "type": "selector", "selector": "h1" },
    { "name": "content", "type": "selector", "selector": ".article-body" },
    { "name": "publishDate", "type": "regex", "pattern": "Published: (\\d{4}-\\d{2}-\\d{2})" }
  ],
  "plugins": [
    { "name": "dedupe" },
    { "name": "audit" }
  ],
  "output": {
    "console": true,
    "persistBodies": false
  }
}
```

### 示例 2：浏览器渲染 + 会话管理

```json
{
  "name": "spa-crawler",
  "seedUrls": ["https://app.example.com"],
  "mode": "browser",
  "concurrency": 1,
  "maxDepth": 0,
  "extract": [
    { "name": "data", "type": "json", "path": "window.__INITIAL_STATE__" }
  ],
  "session": {
    "enabled": true,
    "scope": "job",
    "persist": true,
    "captureStorage": true
  },
  "plugins": [{ "name": "audit" }]
}
```

### 示例 3：API 采集 + JSON 提取

```json
{
  "name": "api-collector",
  "seedUrls": ["https://api.example.com/v1/items"],
  "mode": "http",
  "concurrency": 5,
  "maxDepth": 0,
  "extract": [
    { "name": "items", "type": "json", "path": "data.items" },
    { "name": "total", "type": "json", "path": "meta.total" }
  ],
  "plugins": [{ "name": "dedupe" }]
}
```

---

## 运行 Workflow

```bash
# 从文件运行
node src/cli.js run workflow.json

# 通过 API 运行
curl -s http://127.0.0.1:3100/workflows \
  -H "content-type: application/json" \
  -d @workflow.json

# 通过 Dashboard
# 打开 http://127.0.0.1:3100/dashboard，上传或粘贴 Workflow JSON
```

---

## 下一步

- [平台 API 参考](./PLATFORM_API.md) - 了解完整的 RESTful API
- [执行器扩展指南](./EXECUTOR_EXTENSIONS.md) - 移动 App、人工交互
- [运营与治理](./OPERATIONS_AND_GOVERNANCE.md) - 多租户、RBAC、配额
