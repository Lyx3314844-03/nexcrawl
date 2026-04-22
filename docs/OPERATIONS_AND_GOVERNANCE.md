# 运营与治理

## 状态目录

运行时状态默认保存在项目根目录：

```text
.omnicrawl/
```

常见文件：

| 文件 | 说明 |
| --- | --- |
| `sessions/` | 浏览器和 HTTP 会话快照 |
| `accounts.json` | 账号池 |
| `devices.json` | 移动设备池 |
| `tenants.json` | 租户注册表 |
| `credentials.json` | 凭证元数据/加密值 |
| `audit.ndjson` | 审计日志 |
| `anti-bot-lab.json` | 反爬实验状态 |
| `human-challenges.json` | 人工确认任务 |
| `alert-outbox.json` | 告警发送队列 |

## 多租户

创建租户：

```bash
curl -s http://127.0.0.1:3100/platform/tenants \
  -H "content-type: application/json" \
  -d "{\"id\":\"tenant-a\",\"name\":\"Tenant A\",\"quotas\":{\"running\":2,\"browser\":1}}"
```

禁用租户：

```bash
curl -s http://127.0.0.1:3100/platform/tenants/tenant-a/status \
  -H "content-type: application/json" \
  -d "{\"status\":\"disabled\"}"
```

## 配额

设置配额：

```bash
curl -s http://127.0.0.1:3100/platform/orchestration/quotas \
  -H "content-type: application/json" \
  -d "{\"tenantId\":\"tenant-a\",\"quota\":{\"running\":2,\"browser\":1,\"account\":1}}"
```

预留资源：

```bash
curl -s http://127.0.0.1:3100/platform/orchestration/reserve \
  -H "content-type: application/json" \
  -d "{\"tenantId\":\"tenant-a\",\"resources\":{\"browser\":1}}"
```

## 账号池

```bash
curl -s http://127.0.0.1:3100/platform/accounts \
  -H "content-type: application/json" \
  -d "{\"id\":\"acct-1\",\"tenantId\":\"tenant-a\",\"siteId\":\"example\",\"username\":\"demo\"}"
```

租借账号：

```bash
curl -s http://127.0.0.1:3100/platform/accounts/lease \
  -H "content-type: application/json" \
  -d "{\"scope\":{\"tenantId\":\"tenant-a\",\"siteId\":\"example\"}}"
```

释放账号：

```bash
curl -s http://127.0.0.1:3100/platform/accounts/release \
  -H "content-type: application/json" \
  -d "{\"accountId\":\"acct-1\",\"result\":{\"ok\":true}}"
```

## RBAC

权限评估：

```bash
curl -s http://127.0.0.1:3100/platform/governance/access/evaluate \
  -H "content-type: application/json" \
  -d "{\"tenantId\":\"tenant-a\",\"roles\":[\"admin\"],\"action\":\"platform.accounts.lease\",\"resource\":\"tenant:tenant-a:accounts\"}"
```

默认策略：

- `admin`: 全部允许。
- `operator`: 允许平台、任务、workflow 运营动作。
- `viewer`: 允许读取类动作。
- 未命中策略默认拒绝。

## 凭证

注册凭证：

```bash
curl -s http://127.0.0.1:3100/platform/governance/credentials \
  -H "content-type: application/json" \
  -d "{\"tenantId\":\"tenant-a\",\"name\":\"api-token\",\"value\":\"secret\",\"scope\":[\"crawl\"]}"
```

启用本地加密落盘：

```bash
set OMNICRAWL_VAULT_KEY=replace-with-long-random-secret
npm start
```

凭证 API 不返回明文，只返回 fingerprint、scope、加密状态等元数据。

## 审计

```http
GET /platform/governance/audit
POST /platform/governance/audit
```

审计内容会写入 `.omnicrawl/audit.ndjson`，敏感字段会被脱敏。

