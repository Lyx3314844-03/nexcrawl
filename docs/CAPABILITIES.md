# 能力矩阵与边界

## 已具备的核心能力

| 能力 | 状态 |
| --- | --- |
| HTTP / Cheerio 抓取 | 可用 |
| 浏览器抓取 / SPA / JS 渲染 | 可用 |
| Sitemap / Feed | 可用 |
| 媒体资产发现与下载 | 可用 |
| JSON API | 可用 |
| GraphQL 探测、starter plan、语义排序 | 可用 |
| WebSocket 订阅模型、心跳、错误恢复推断 | 可用 |
| gRPC / Protobuf 样本聚类和语义提示 | 可用 |
| Session store / cookie / storage 复用 | 可用 |
| OAuth/JWT/Basic/Bearer/API Key/Cookie auth handler | 可用 |
| MFA/TOTP 辅助 | 可用 |
| 登录录制与 replay workflow | 可用 |
| 登录状态机 | 可用 |
| SSO/扫码/Passkey/风险页识别与人工 challenge | 可用 |
| 账号池、代理池、浏览器池 | 可用 |
| 设备池与 App 执行计划 | 可用 |
| Appium/Frida/mitmproxy 计划与 helper 生成 | 可用 |
| 强风控/attestation 合规门禁 | 可用 |
| 反爬实验矩阵与降级页面检测 | 可用 |
| 任务队列、调度、历史、回放、导出 | 可用 |
| 多租户、RBAC、配额 | 可用 |
| 审计日志、凭证隔离、加密落盘 | 可用 |
| Dashboard 控制台 | 可用 |

## 不是“万能绕过”

框架不会承诺：

- 绕过 Play Integrity、SafetyNet、DeviceCheck、App Attest。
- 伪造设备信誉或 attestation token。
- 绕过未经授权的访问控制。
- 自动解决所有验证码、账号风险、人工审核。
- 保证任何目标都可采集。

遇到这些情况时，框架会：

- 停止自动化或降级。
- 进入人机 challenge。
- 要求 owner-approved test device / account。
- 记录审计日志。
- 生成合规说明和下一步建议。

## “万能”的实际含义

本项目里的“万能入口”指：

1. 自动识别目标类型。
2. 自动选择执行 lane。
3. 自动指出阻断点。
4. 能进入人工确认或合规门禁。
5. 能把结果、事件、失败和修复建议沉淀下来。

它不是无限制突破任何系统的工具。

