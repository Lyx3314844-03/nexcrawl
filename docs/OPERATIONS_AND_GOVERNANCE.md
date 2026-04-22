# 运营与治理

> 多租户管理、RBAC 权限控制、配额管理、凭证管理和审计操作指南

---

## 状态目录

运行时状态默认保存在项目根目录：

```
.NexCrawl/
```

### 目录结构

```
.NexCrawl/
├── sessions/              # 浏览器和 HTTP 会话快照
├── accounts.json          # 账号池
├── devices.json           # 移动设备池
├── tenants.json           # 租户注册表
├── credentials.json       # 凭证元数据/加密值
├── audit.ndjson           # 审计日志
├── anti-bot-lab.json      # 反爬实验状态
├── human-challenges.json  # 人工确认任务
└── alert-outbox.json      # 告警发送队列
```

> **安全提示**: `.NexCrawl/credentials.json` 包含加密凭证，请勿提交到版本控制。确保 `.gitignore` 已包含此目录。

---

## 多租户管理

NexCrawl 支持多租户隔离，每个租户拥有独立的：
- 账号池
- 代理池
- 设备池
- 配额
- 凭证
- 审计日志

### 创建租户

```bash
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
```

### 租户列表

```bash
curl http://127.0.0.1:3100/platform/tenants
```

### 启用/禁用租户

```bash
# 禁用租户
curl -s http://127.0.0.1:3100/platform/tenants/tenant-a/status \
  -H "content-type: application/json" \
  -d '{ "status": "disabled" }'

# 启用租户
curl -s http://127.0.0.1:3100/platform/tenants/tenant-a/status \
  -H "content-type: application/json" \
  -d '{ "status": "enabled" }'
```

### 租户状态

| 状态 | 说明 |
| --- | --- |
| `enabled` | 正常运行，可创建任务和租借资源 |
| `disabled` | 已禁用，无法执行新操作 |
| `suspended` | 已暂停（如配额超限、违规） |

---

## 配额管理

### 设置配额

```bash
curl -s http://127.0.0.1:3100/platform/orchestration/quotas \
  -H "content-type: application/json" \
  -d '{
    "tenantId": "tenant-a",
    "quota": {
      "running": 2,
      "browser": 1,
      "account": 1,
      "device": 1,
      "proxy": 3
    }
  }'
```

### 配额字段说明

| 字段 | 说明 |
| --- | --- |
| `running` | 最大并发运行任务数 |
| `browser` | 最大并发浏览器实例数 |
| `account` | 最大可租借账号数 |
| `device` | 最大可租借设备数 |
| `proxy` | 最大可使用代理数 |

### 预留资源

```bash
curl -s http://127.0.0.1:3100/platform/orchestration/reserve \
  -H "content-type: application/json" \
  -d '{
    "tenantId": "tenant-a",
    "resources": {
      "browser": 1
    }
  }'
```

预留成功后，资源会被锁定，其他租户无法使用。

### 查看配额

```bash
curl http://127.0.0.1:3100/platform/orchestration/quotas
```

---

## 账号池管理

### 添加账号

```bash
curl -s http://127.0.0.1:3100/platform/accounts \
  -H "content-type: application/json" \
  -d '{
    "id": "acct-1",
    "tenantId": "tenant-a",
    "siteId": "example",
    "username": "demo",
    "metadata": {
      "region": "US",
      "tier": "premium"
    }
  }'
```

### 账号字段说明

| 字段 | 说明 |
| --- | --- |
| `id` | 账号唯一标识 |
| `tenantId` | 所属租户 |
| `siteId` | 目标站点标识 |
| `username` | 账号用户名 |
| `metadata` | （可选）附加元数据 |

### 租借账号

```bash
curl -s http://127.0.0.1:3100/platform/accounts/lease \
  -H "content-type: application/json" \
  -d '{
    "scope": {
      "tenantId": "tenant-a",
      "siteId": "example"
    }
  }'
```

响应包含租借的账号信息，任务完成后需要释放。

### 释放账号

```bash
curl -s http://127.0.0.1:3100/platform/accounts/release \
  -H "content-type: application/json" \
  -d '{
    "accountId": "acct-1",
    "result": { "ok": true }
  }'
```

### 启用/禁用账号

```bash
curl -s http://127.0.0.1:3100/platform/accounts/acct-1/enabled \
  -H "content-type: application/json" \
  -d '{ "enabled": false }'
```

### 查看账号列表

```bash
curl http://127.0.0.1:3100/platform/accounts
```

---

## RBAC 权限控制

### 默认角色

| 角色 | 权限 |
| --- | --- |
| `admin` | 全部允许 |
| `operator` | 允许平台、任务、Workflow 运营动作 |
| `viewer` | 允许读取类动作 |
| 未命中策略 | 默认拒绝 |

### 权限评估

```bash
curl -s http://127.0.0.1:3100/platform/governance/access/evaluate \
  -H "content-type: application/json" \
  -d '{
    "tenantId": "tenant-a",
    "roles": ["admin"],
    "action": "platform.accounts.lease",
    "resource": "tenant:tenant-a:accounts"
  }'
```

响应：

```json
{
  "allowed": true,
  "role": "admin",
  "action": "platform.accounts.lease"
}
```

### 权限动作分类

| 分类 | 动作示例 |
| --- | --- |
| 平台运营 | `platform.*` |
| 任务管理 | `jobs.create`, `jobs.read`, `jobs.run` |
| Workflow | `workflows.create`, `workflows.run` |
| 账号管理 | `platform.accounts.*` |
| 设备管理 | `platform.devices.*` |
| 代理管理 | `runtime.proxies.*` |
| 审计 | `governance.audit.read` |
| 凭证 | `governance.credentials.*` |

### 查看策略

```bash
curl http://127.0.0.1:3100/platform/governance/access/policies
```

---

## 凭证管理

### 注册凭证

```bash
curl -s http://127.0.0.1:3100/platform/governance/credentials \
  -H "content-type: application/json" \
  -d '{
    "tenantId": "tenant-a",
    "name": "api-token",
    "value": "secret",
    "scope": ["crawl"]
  }'
```

### 凭证字段说明

| 字段 | 说明 |
| --- | --- |
| `tenantId` | 所属租户 |
| `name` | 凭证名称 |
| `value` | 凭证值（会被加密存储） |
| `scope` | 使用范围（如 `["crawl", "browser"]`） |

### 查询凭证元数据

```bash
curl http://127.0.0.1:3100/platform/governance/credentials/tenant-a/api-token
```

> **安全提示**: 凭证 API **只返回元数据**（fingerprint、scope、加密状态），**不返回明文值**。

### 启用本地加密落盘

```bash
# Windows
set NexCrawl_VAULT_KEY=replace-with-long-random-secret
npm start

# Linux/macOS
export NexCrawl_VAULT_KEY=replace-with-long-random-secret
npm start
```

密钥要求：
- 长度建议 >= 32 字符
- 使用强随机值
- 生产环境建议迁移到 Vault/KMS

---

## 审计日志

### 查询审计日志

```bash
# 通过 API 查询
curl http://127.0.0.1:3100/platform/governance/audit

# 写入审计记录
curl -s http://127.0.0.1:3100/platform/governance/audit \
  -H "content-type: application/json" \
  -d '{
    "tenantId": "tenant-a",
    "action": "job.create",
    "actor": "admin",
    "resource": "jobs",
    "details": {}
  }'
```

### 日志文件

```
.NexCrawl/audit.ndjson
```

### 日志格式

每行一条 JSON 记录：

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "tenantId": "tenant-a",
  "action": "job.create",
  "actor": "admin",
  "resource": "jobs",
  "result": "success",
  "details": {}
}
```

### 敏感字段脱敏

审计日志中的敏感字段（如凭证值、密码、token）会被自动脱敏：

```json
{
  "action": "credentials.create",
  "details": {
    "name": "api-token",
    "value": "***REDACTED***"
  }
}
```

---

## 设备池管理

### 添加设备

```bash
curl -s http://127.0.0.1:3100/platform/devices \
  -H "content-type: application/json" \
  -d '{
    "id": "device-1",
    "tenantId": "tenant-a",
    "type": "android",
    "metadata": {
      "model": "Pixel 6",
      "osVersion": "13"
    }
  }'
```

### 租借设备

```bash
curl -s http://127.0.0.1:3100/platform/devices/lease \
  -H "content-type: application/json" \
  -d '{
    "scope": {
      "tenantId": "tenant-a"
    }
  }'
```

---

## 告警管理

告警队列保存在：

```
.NexCrawl/alert-outbox.json
```

### 建议配置的告警

| 告警类型 | 触发条件 | 建议接收方式 |
| --- | --- | --- |
| 任务失败率 | > 10% | Webhook/邮件 |
| 登录态失效 | 失效账号 > 20% | Webhook/邮件 |
| 代理失效 | 失效代理 > 30% | Webhook |
| 配额超限 | 达到配额 80% | 控制台通知 |
| 设备离线 | 在线设备 < 最小阈值 | Webhook/邮件 |

---

## 下一步

- [平台 API 参考](./PLATFORM_API.md) - 完整的 RESTful API 文档
- [安全与合规边界](./SAFETY_BOUNDARIES.md) - 生产部署建议和合规指南
- [执行器扩展指南](./EXECUTOR_EXTENSIONS.md) - 移动 App 和人工交互执行器
