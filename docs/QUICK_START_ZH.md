# 中文快速上手

## 1. 安装与启动

```bash
npm install
npm start
```

默认服务地址：

```text
http://127.0.0.1:3100/dashboard
```

如果只想跑一个 workflow：

```bash
node src/cli.js run examples/demo.workflow.json
```

## 2. 用 Dashboard 跑第一个任务

1. 打开 `/dashboard`。
2. 找到“零代码快速开始”。
3. 填目标网址。
4. 选择页面类型：静态网页、浏览器渲染页、JSON 接口、Sitemap/Feed。
5. 点击“一键运行”。
6. 在 Recent Jobs 里点击 Inspect 查看结果、事件、失败请求和修复建议。

## 3. 用 Universal Planner 先判断目标类型

当你不知道目标是普通网页、SPA、GraphQL、WebSocket、App、登录页还是强风控页面时，先调用万能规划器：

```bash
curl -s http://127.0.0.1:3100/platform/universal/plan \
  -H "content-type: application/json" \
  -d "{\"url\":\"https://example.com\",\"html\":\"<script>window.__APP__={}</script>\"}"
```

返回的 `lanes` 会告诉你应该走 `http-crawl`、`browser-crawl`、`graphql-semantics`、`interactive-auth`、`mobile-app-execution`、`attestation-compliance` 等哪条路径。

## 4. 最小 workflow 示例

```json
{
  "name": "quick-html",
  "seedUrls": ["https://example.com"],
  "mode": "http",
  "concurrency": 1,
  "maxDepth": 0,
  "extract": [
    { "name": "title", "type": "regex", "pattern": "<title>([^<]+)</title>" },
    { "name": "surface", "type": "surface" }
  ],
  "plugins": [{ "name": "dedupe" }, { "name": "audit" }],
  "output": {
    "dir": "runs",
    "console": true,
    "persistBodies": false
  }
}
```

保存为 `workflow.json` 后运行：

```bash
node src/cli.js run workflow.json
```

## 5. 常见场景怎么选

| 场景 | 推荐入口 |
| --- | --- |
| 普通 HTML 页面 | `mode: "http"` |
| 需要 JS 渲染的页面 | `mode: "browser"` 或 Dashboard 浏览器模板 |
| JSON API | `ApiJsonCrawler` 或 JSON workflow |
| GraphQL | `/platform/protocol/semantics` + GraphQL crawler |
| WebSocket | `/platform/protocol/semantics` + WebSocket crawler |
| gRPC/Protobuf | gRPC workflow / `GrpcCrawler` + 样本语义分析 |
| 登录页 | 登录状态机 + session store + login recorder |
| SSO/扫码/Passkey | interactive auth challenge |
| 原生 App | device pool + mobile app execution plan |
| 强风控/attestation | attestation compliance gate |
