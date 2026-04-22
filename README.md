<p align="center">
  <img src="logo.svg" width="180" alt="OmniCrawl" />
</p>

# OmniCrawl / NexCrawl

面向 Web、API、协议和 App 场景的数据采集平台。

它提供普通网页抓取、浏览器抓取、接口抓取、协议语义分析、登录态维护、账号/代理/设备资源管理、任务调度、数据导出、控制台、审计和治理能力。

它不是"保证绕过任何网站限制"的工具。遇到 SSO、扫码登录、Passkey/WebAuthn、账号风险页、Play Integrity、SafetyNet、DeviceCheck、App Attest、设备信誉和强风控时，框架会进入人机协作、合规门禁或停止自动化。

## 快速开始

```bash
npm install
npm start
```

打开控制台：

```text
http://127.0.0.1:3100/dashboard
```

运行示例 workflow：

```bash
node src/cli.js run examples/demo.workflow.json
```

查看框架能力：

```bash
node src/cli.js capabilities
```

从目标描述直接脚手架 workflow：

```bash
node src/cli.js scaffold target.json --output generated.workflow.json
```

`target.json` 可以是 URL/Body/Header 驱动的 universal target 描述，例如 GraphQL、WebSocket、普通页面或 JSON API。

如果目标被识别为 gRPC/Protobuf，CLI 现在会直接输出可执行的 `.workflow.json`，通过内置 gRPC transport 进入现有任务、调度和历史链路。

## 什么时候用它

| 目标 | 可用能力 |
| --- | --- |
| 普通 HTML 页面 | HTTP / Cheerio 抓取、CSS/regex/surface 提取 |
| JS 渲染页面 | 浏览器抓取、debug capture、session storage/cookie |
| JSON API | HTTP API crawler、JSON path 提取 |
| GraphQL | endpoint 探测、操作语义排序、分页提示 |
| WebSocket | 订阅模型、心跳、错误恢复推断 |
| gRPC/Protobuf | 样本聚类、字段语义提示、gRPC crawler |
| 登录后页面 | auth handler、session store、login recorder、replay workflow |
| SSO/扫码/Passkey/风险页 | interactive auth plan + human challenge |
| 原生 App | device pool、App 执行计划、Appium/Frida/mitmproxy helper |
| 强风控/attestation | compliance gate，不做绕过 |
| 平台运营 | Dashboard、任务历史、回放、repair、自愈 patch |
| 治理 | 多租户、RBAC、配额、账号池、凭证加密、审计 |

## 万能规划器

目标类型不确定时，先用 universal planner：

```bash
curl -s http://127.0.0.1:3100/platform/universal/plan \
  -H "content-type: application/json" \
  -d "{\"url\":\"https://example.com/graphql\",\"body\":\"mutation Login { login { token } }\"}"
```

它会返回推荐 lanes，例如：

- `http-crawl`
- `browser-crawl`
- `graphql-semantics`
- `websocket-semantics`
- `grpc-semantics`
- `login-state-machine`
- `interactive-auth`
- `mobile-app-execution`
- `anti-bot-lab`
- `attestation-compliance`

## CLI

```bash
node src/cli.js run <workflow.json>
node src/cli.js serve --port 3100
node src/cli.js scaffold target.json --output generated.workflow.json
node src/cli.js init ./my-crawler
node src/cli.js register <workflow.json> --id my-workflow
node src/cli.js workflows
node src/cli.js history
node src/cli.js sessions
node src/cli.js proxies
node src/cli.js capabilities
```

## 文档

当前文档入口：

- [文档索引](./docs/README.md)
- [中文快速上手](./docs/QUICK_START_ZH.md)
- [能力矩阵与边界](./docs/CAPABILITIES.md)
- [Workflow 编写指南](./docs/WORKFLOW_GUIDE.md)
- [平台 API 指南](./docs/PLATFORM_API.md)
- [运营与治理](./docs/OPERATIONS_AND_GOVERNANCE.md)
- [执行器扩展指南](./docs/EXECUTOR_EXTENSIONS.md)
- [安全与合规边界](./docs/SAFETY_BOUNDARIES.md)

## 安全边界

请只采集你有权访问的数据。框架不会提供绕过访问控制、伪造 attestation、破解账号风险页或规避第三方安全机制的保证。

生产环境建议：

- 设置 `OMNICRAWL_API_KEY` 保护 HTTP API。
- 设置 `OMNICRAWL_VAULT_KEY` 加密本地凭证。
- 使用多租户、RBAC、配额隔离资源。
- 审计 `.omnicrawl/audit.ndjson`。
- 为失败率、登录态、账号池、设备池和告警队列配置监控。

## 开发验证

```bash
npm run lint
npm test
```
