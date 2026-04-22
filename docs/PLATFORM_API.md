# 平台 API 参考

> NexCrawl RESTful API 完整端点文档

## 概述

NexCrawl 提供完整的 RESTful API，用于任务管理、Workflow 执行、登录认证、资源池治理等功能。

**默认地址**: `http://127.0.0.1:3100`

### 启动服务

```bash
npm start
```

### 认证

生产环境建议配置 API 密钥：

```bash
# 设置环境变量
export NexCrawl_API_KEY=your-secret-key

# 或在请求头中传递
curl -H "Authorization: Bearer $NexCrawl_API_KEY" http://127.0.0.1:3100/health
```

---

## 健康与能力

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 服务健康检查 |
| `GET` | `/capabilities` | 已启用能力列表 |
| `GET` | `/runtime/metrics` | 运行时指标 |
| `GET` | `/metrics` | Prometheus 格式指标 |

### 示例

```bash
# 健康检查
curl http://127.0.0.1:3100/health
# 响应: {"status": "ok", "uptime": 123.45, "version": "1.0.0"}

# 查看能力
curl http://127.0.0.1:3100/capabilities
```

---

## 万能规划器

自动识别目标类型并生成执行计划。

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `POST` | `/platform/universal/plan` | 目标分析与 Lane 选择 |
| `POST` | `/tools/universal-workflow/build` | 生成可执行 Workflow 脚手架 |

### 请求示例

```bash
curl -s http://127.0.0.1:3100/platform/universal/plan \
  -H "content-type: application/json" \
  -d '{
    "url": "https://example.com/graphql",
    "body": "mutation Login { login { token } }"
  }'
```

### 响应示例

```json
{
  "url": "https://example.com/graphql",
  "detectedType": "graphql",
  "lanes": [
    {
      "name": "graphql-semantics",
      "confidence": 0.95,
      "reason": "Detected GraphQL mutation pattern"
    }
  ],
  "recommendedWorkflow": {
    "mode": "graphql",
    "extract": []
  }
}
```

### 支持的目标类型

| 类型 | Lane | 说明 |
| --- | --- | --- |
| 普通网页 | `http-crawl` | HTTP 抓取 |
| SPA/JS 渲染 | `browser-crawl` | 浏览器渲染 |
| JSON API | `json-api` | API 采集 |
| GraphQL | `graphql-semantics` | GraphQL 分析 |
| WebSocket | `websocket` | WebSocket 订阅 |
| gRPC | `grpc` | gRPC/Protobuf 分析 |
| 登录页 | `interactive-auth` | 交互式认证 |
| 移动 App | `mobile-app-execution` | App 执行计划 |
| 强风控 | `attestation-compliance` | Attestation 合规 |

---

## 任务管理

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `POST` | `/jobs` | 创建任务 |
| `GET` | `/jobs` | 任务列表 |
| `GET` | `/jobs/:jobId` | 任务详情 |
| `GET` | `/jobs/:jobId/detail` | 任务详细信息 |
| `GET` | `/jobs/:jobId/results` | 采集结果 |
| `GET` | `/jobs/:jobId/event-log` | 事件日志 |
| `GET` | `/jobs/:jobId/diagnostics` | 诊断信息 |
| `GET` | `/jobs/:jobId/repair-plan` | 修复计划 |
| `POST` | `/jobs/:jobId/replay-workflow/run` | 回放任务 |

### 创建任务

```bash
curl -s http://127.0.0.1:3100/jobs \
  -H "content-type: application/json" \
  -d '{
    "name": "test-job",
    "seedUrls": ["https://example.com"],
    "mode": "http",
    "maxDepth": 0
  }'
```

### 查看结果

```bash
# 查看结果
curl http://127.0.0.1:3100/jobs/<jobId>/results

# 查看事件日志
curl http://127.0.0.1:3100/jobs/<jobId>/event-log

# 获取诊断信息
curl http://127.0.0.1:3100/jobs/<jobId>/diagnostics

# 获取修复建议
curl http://127.0.0.1:3100/jobs/<jobId>/repair-plan
```

---

## Workflows 与调度

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `GET` | `/workflows` | Workflow 列表 |
| `POST` | `/workflows` | 创建 Workflow |
| `POST` | `/workflows/:workflowId/run` | 运行 Workflow |
| `GET` | `/schedules` | 调度列表 |
| `POST` | `/schedules` | 创建调度 |
| `PATCH` | `/schedules/:scheduleId` | 更新调度 |

### 创建并运行 Workflow

```bash
# 创建 Workflow
curl -s http://127.0.0.1:3100/workflows \
  -H "content-type: application/json" \
  -d @workflow.json

# 运行 Workflow
curl -s http://127.0.0.1:3100/workflows/<workflowId>/run -X POST
```

---

## 登录与人工确认

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `POST` | `/platform/login/analyze` | 分析登录页面 |
| `POST` | `/platform/login/state-machine` | 获取登录状态机 |
| `POST` | `/platform/login/interactive-plan` | 获取交互式登录计划 |
| `GET` | `/platform/human-challenges` | 人工确认任务列表 |
| `POST` | `/platform/human-challenges` | 创建人工确认任务 |
| `POST` | `/platform/human-challenges/:challengeId/resolve` | 完成确认 |

### 分析登录页面

```bash
curl -s http://127.0.0.1:3100/platform/login/analyze \
  -H "content-type: application/json" \
  -d '{
    "url": "https://example.com/login"
  }'
```

响应包含：
- 表单字段分析
- 认证类型检测（表单/OAuth/SSO/扫码/Passkey）
- 推荐登录策略

---

## 账号、设备、代理管理

### 账号池

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `GET` | `/platform/accounts` | 账号列表 |
| `POST` | `/platform/accounts` | 添加账号 |
| `POST` | `/platform/accounts/lease` | 租借账号 |
| `POST` | `/platform/accounts/release` | 释放账号 |
| `POST` | `/platform/accounts/:accountId/enabled` | 启用/禁用账号 |

```bash
# 添加账号
curl -s http://127.0.0.1:3100/platform/accounts \
  -H "content-type: application/json" \
  -d '{
    "id": "acct-1",
    "tenantId": "tenant-a",
    "siteId": "example",
    "username": "demo"
  }'

# 租借账号
curl -s http://127.0.0.1:3100/platform/accounts/lease \
  -H "content-type: application/json" \
  -d '{
    "scope": {
      "tenantId": "tenant-a",
      "siteId": "example"
    }
  }'

# 释放账号
curl -s http://127.0.0.1:3100/platform/accounts/release \
  -H "content-type: application/json" \
  -d '{
    "accountId": "acct-1",
    "result": { "ok": true }
  }'
```

### 设备池

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `GET` | `/platform/devices` | 设备列表 |
| `POST` | `/platform/devices` | 添加设备 |
| `POST` | `/platform/devices/lease` | 租借设备 |

### 代理管理

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `GET` | `/runtime/proxies` | 代理列表 |
| `POST` | `/runtime/proxies/control` | 代理控制 |
| `POST` | `/runtime/proxies/reset` | 重置代理状态 |
| `POST` | `/runtime/proxies/probe` | 代理探测 |

---

## 移动 App 采集

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `POST` | `/platform/app-capture/plan` | 生成 App 抓包计划 |
| `POST` | `/platform/app-capture/merge-streams` | 合并多流数据 |
| `POST` | `/platform/mobile-app/execution-plan` | 生成移动 App 执行计划 |
| `POST` | `/platform/mobile-app/execute-plan` | 执行计划（默认 dry-run） |
| `GET` | `/tools/app-capture/sessions` | App 抓包会话列表 |
| `POST` | `/tools/app-capture/start` | 启动 App 抓包 |

> **注意**: `execute-plan` 默认为 dry-run 模式。接真实执行器前不会假装执行 ADB、Frida 或 mitmproxy。

```bash
# 生成执行计划
curl -s http://127.0.0.1:3100/platform/mobile-app/execution-plan \
  -H "content-type: application/json" \
  -d '{
    "app": {
      "packageName": "com.example.app",
      "apkPath": "app.apk"
    },
    "capture": {
      "reinstall": true,
      "networkCapture": true
    }
  }'
```

---

## 协议语义分析

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `POST` | `/platform/protocol/semantics` | 协议语义分析 |

### 支持的协议类型

| `kind` | 说明 |
| --- | --- |
| `graphql` | GraphQL 查询分析、Schema 探测 |
| `websocket` | WebSocket 消息格式、心跳、重连策略 |
| `grpc` | gRPC 服务分析 |
| `protobuf` | Protobuf 消息反序列化提示 |

```bash
curl -s http://127.0.0.1:3100/platform/protocol/semantics \
  -H "content-type: application/json" \
  -d '{
    "kind": "graphql",
    "url": "https://example.com/graphql",
    "sampleBody": "{ users { id name } }"
  }'
```

---

## 多租户、RBAC、配额

### 租户管理

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `GET` | `/platform/tenants` | 租户列表 |
| `POST` | `/platform/tenants` | 创建租户 |
| `POST` | `/platform/tenants/:tenantId/status` | 启用/禁用租户 |

```bash
# 创建租户
curl -s http://127.0.0.1:3100/platform/tenants \
  -H "content-type: application/json" \
  -d '{
    "id": "tenant-a",
    "name": "Tenant A",
    "quotas": {
      "running": 2,
      "browser": 1
    }
  }'

# 禁用租户
curl -s http://127.0.0.1:3100/platform/tenants/tenant-a/status \
  -H "content-type: application/json" \
  -d '{ "status": "disabled" }'
```

### 配额管理

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `GET` | `/platform/orchestration/quotas` | 配额列表 |
| `POST` | `/platform/orchestration/quotas` | 设置配额 |
| `POST` | `/platform/orchestration/reserve` | 预留资源 |

### RBAC 权限评估

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `GET` | `/platform/governance/access/policies` | 策略列表 |
| `POST` | `/platform/governance/access/evaluate` | 权限评估 |

```bash
# 权限评估
curl -s http://127.0.0.1:3100/platform/governance/access/evaluate \
  -H "content-type: application/json" \
  -d '{
    "tenantId": "tenant-a",
    "roles": ["admin"],
    "action": "platform.accounts.lease",
    "resource": "tenant:tenant-a:accounts"
  }'
```

### 默认角色

| 角色 | 权限 |
| --- | --- |
| `admin` | 全部允许 |
| `operator` | 允许平台、任务、Workflow 运营动作 |
| `viewer` | 允许读取类动作 |
| 未命中策略 | 默认拒绝 |

---

## 审计与凭证

### 审计日志

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `GET` | `/platform/governance/audit` | 查询审计日志 |
| `POST` | `/platform/governance/audit` | 写入审计日志 |

审计内容会写入 `.NexCrawl/audit.ndjson`，敏感字段会被脱敏。

### 凭证管理

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `POST` | `/platform/governance/credentials` | 注册凭证 |
| `GET` | `/platform/governance/credentials/:tenantId/:name` | 查询凭证元数据 |

> **安全提示**: 凭证接口只返回元数据（fingerprint、scope、加密状态），**不返回明文值**。

```bash
# 注册凭证
curl -s http://127.0.0.1:3100/platform/governance/credentials \
  -H "content-type: application/json" \
  -d '{
    "tenantId": "tenant-a",
    "name": "api-token",
    "value": "secret",
    "scope": ["crawl"]
  }'
```

### 启用本地加密落盘

```bash
# Windows
set NexCrawl_VAULT_KEY=replace-with-long-random-secret

# Linux/macOS
export NexCrawl_VAULT_KEY=replace-with-long-random-secret

npm start
```

---

## 强风控合规门禁

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `POST` | `/platform/attestation/compliance-plan` | 生成 Attestation 合规计划 |

该接口只做**检测、阻断和升级建议**，**不做绕过**。

```bash
curl -s http://127.0.0.1:3100/platform/attestation/compliance-plan \
  -H "content-type: application/json" \
  -d '{
    "status": 403,
    "body": "Play Integrity attestation failed"
  }'
```

响应包含：
- 检测结果
- 阻断建议
- 升级路径
- 合规说明

---

## 错误响应

所有 API 错误统一格式：

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Missing required field: seedUrls",
    "details": {}
  }
}
```

### 常见错误码

| 错误码 | HTTP 状态 | 说明 |
| --- | :---: | --- |
| `INVALID_REQUEST` | 400 | 请求参数错误 |
| `UNAUTHORIZED` | 401 | 未认证或认证失败 |
| `FORBIDDEN` | 403 | 无权限 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `QUOTA_EXCEEDED` | 429 | 配额超限 |
| `INTERNAL_ERROR` | 500 | 内部错误 |

---

## 下一步

- [Workflow 编写指南](./WORKFLOW_GUIDE.md) - 学习 JSON Workflow 配置
- [运营与治理](./OPERATIONS_AND_GOVERNANCE.md) - 多租户、RBAC 详细操作
- [执行器扩展指南](./EXECUTOR_EXTENSIONS.md) - 移动 App、人工交互
