# 平台 API 指南

启动：

```bash
npm start
```

默认地址：

```text
http://127.0.0.1:3100
```

## 能力与健康

```http
GET /health
GET /capabilities
GET /runtime/metrics
GET /metrics
```

## 万能规划器

```http
POST /platform/universal/plan
POST /tools/universal-workflow/build
```

示例：

```json
{
  "url": "https://example.com/graphql",
  "body": "mutation Login { login { token } }"
}
```

`/platform/universal/plan` 返回 lanes 分析，`/tools/universal-workflow/build` 在此基础上继续生成脚手架：

- Web / Browser / JSON API / GraphQL / WebSocket 目标返回可执行 workflow。
- gRPC / Protobuf 目标现在也返回可执行 workflow，并通过内置 gRPC transport 进入现有运行时。

## 任务

```http
POST /jobs
GET /jobs
GET /jobs/:jobId
GET /jobs/:jobId/detail
GET /jobs/:jobId/results
GET /jobs/:jobId/event-log
GET /jobs/:jobId/diagnostics
GET /jobs/:jobId/repair-plan
POST /jobs/:jobId/replay-workflow/run
```

## Workflows 与调度

```http
GET /workflows
POST /workflows
POST /workflows/:workflowId/run
GET /schedules
POST /schedules
PATCH /schedules/:scheduleId
```

## 登录与人工确认

```http
POST /platform/login/analyze
POST /platform/login/state-machine
POST /platform/login/interactive-plan
GET /platform/human-challenges
POST /platform/human-challenges
POST /platform/human-challenges/:challengeId/resolve
```

## 账号、设备、代理

```http
GET /platform/accounts
POST /platform/accounts
POST /platform/accounts/lease
POST /platform/accounts/release
POST /platform/accounts/:accountId/enabled

GET /platform/devices
POST /platform/devices
POST /platform/devices/lease

GET /runtime/proxies
POST /runtime/proxies/control
POST /runtime/proxies/reset
POST /runtime/proxies/probe
```

## 移动 App

```http
POST /platform/app-capture/plan
POST /platform/app-capture/merge-streams
POST /platform/mobile-app/execution-plan
POST /platform/mobile-app/execute-plan
GET /tools/app-capture/sessions
POST /tools/app-capture/start
```

`execute-plan` 默认 dry-run。接真实执行器前不会假装执行 ADB、Frida 或 mitmproxy。

## 协议语义

```http
POST /platform/protocol/semantics
```

`kind` 支持：

- `graphql`
- `websocket`
- `grpc`
- `protobuf`

## 多租户、RBAC、配额

```http
GET /platform/tenants
POST /platform/tenants
POST /platform/tenants/:tenantId/status
GET /platform/orchestration/quotas
POST /platform/orchestration/quotas
POST /platform/orchestration/reserve
GET /platform/governance/access/policies
POST /platform/governance/access/evaluate
```

## 审计与凭证

```http
GET /platform/governance/audit
POST /platform/governance/audit
POST /platform/governance/credentials
GET /platform/governance/credentials/:tenantId/:name
```

凭证接口只返回元数据，不返回明文值。

## 强风控合规门禁

```http
POST /platform/attestation/compliance-plan
```

该接口只做检测、阻断和升级建议，不做绕过。
