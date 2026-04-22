# 安全与合规边界

## 明确不做的事情

NexCrawl 不提供以下能力：

- 绕过访问控制。
- 伪造身份、设备信誉或 attestation token。
- 绕过 Play Integrity、SafetyNet、DeviceCheck、App Attest。
- 批量破解验证码或账号风险页。
- 未授权采集个人数据、付费内容或受保护系统。

## 框架遇到强风控时怎么处理

当检测到 attestation、设备信誉、SSO、扫码、Passkey、账号风险等信号时，框架会：

1. 生成合规计划。
2. 阻断自动绕过路径。
3. 进入人机 challenge 或人工审批。
4. 要求使用授权账号、授权设备、授权测试环境。
5. 记录审计日志。

## 合规建议

- 只采集你有权访问的数据。
- 尊重 robots.txt、服务条款和速率限制。
- 不要绕过登录、付费墙或访问控制。
- 对账号、代理、设备和凭证使用租户隔离。
- 启用 `NexCrawl_VAULT_KEY` 加密凭证。
- 定期审计 `.NexCrawl/audit.ndjson`。

## 生产部署建议

- 为 HTTP API 配置 `NexCrawl_API_KEY`。
- 使用反向代理加 TLS。
- 使用最小权限账号。
- 为不同租户配置不同账号池、代理池、设备池和配额。
- 将密钥迁移到 Vault/KMS 等外部密钥系统。
- 为失败率、登录态健康、账号池健康、设备池健康配置告警。

