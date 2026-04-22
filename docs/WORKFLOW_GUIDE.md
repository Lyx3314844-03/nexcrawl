# Workflow 编写指南

## 基本结构

```json
{
  "name": "example-workflow",
  "seedUrls": ["https://example.com"],
  "mode": "http",
  "concurrency": 1,
  "maxDepth": 0,
  "extract": [],
  "plugins": [{ "name": "dedupe" }, { "name": "audit" }],
  "output": {
    "dir": "runs",
    "console": true,
    "persistBodies": false
  }
}
```

## mode 选择

| mode | 用途 |
| --- | --- |
| `http` | 普通网页、接口、速度优先 |
| `cheerio` | 静态 HTML 解析 |
| `browser` | JS 渲染、SPA、需要 cookie/storage |
| `hybrid` | 自动在 HTTP 和浏览器之间折中 |
| `websocket` | WebSocket 流 |

## 常用 extract

### 正则

```json
{ "name": "title", "type": "regex", "pattern": "<title>([^<]+)</title>" }
```

### CSS selector

```json
{ "name": "headline", "type": "selector", "selector": "h1" }
```

### JSON path

```json
{ "name": "items", "type": "json", "path": "data.items" }
```

### 页面表面分析

```json
{ "name": "surface", "type": "surface" }
```

## 发现链接

```json
{
  "discovery": {
    "enabled": true,
    "maxPages": 20,
    "sameOriginOnly": true,
    "extractor": { "name": "links", "type": "links", "all": true }
  }
}
```

## Session 与登录态

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

登录复杂时，优先使用：

- `/platform/login/analyze`
- `/platform/login/state-machine`
- `/platform/login/interactive-plan`
- `/api/login-recorder/*`

## 代理池

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
      }
    ]
  }
}
```

## 输出位置

默认每次运行会生成：

- `runs/<jobId>/summary.json`
- `runs/<jobId>/results.ndjson`
- `runs/<jobId>/events.ndjson`
- `runs/<jobId>/workflow.json`

