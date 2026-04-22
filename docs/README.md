# OmniCrawl / NexCrawl 文档

这是当前版本的完整文档入口。

## 推荐阅读顺序

1. [中文快速上手](./QUICK_START_ZH.md)
2. [能力边界与能力矩阵](./CAPABILITIES.md)
3. [Workflow 编写指南](./WORKFLOW_GUIDE.md)
4. [平台 API 指南](./PLATFORM_API.md)
5. [运营与治理](./OPERATIONS_AND_GOVERNANCE.md)
6. [执行器扩展指南](./EXECUTOR_EXTENSIONS.md)
7. [安全与合规边界](./SAFETY_BOUNDARIES.md)

## 一句话定位

OmniCrawl / NexCrawl 是一个面向 Web、API、协议和 App 场景的数据采集平台。它提供自动规划、任务执行、会话和账号治理、代理和设备资源管理、协议语义分析、自愈建议、审计和控制台。

它不是"保证绕过任何网站限制"的工具。遇到 SSO、扫码、Passkey/WebAuthn、设备 attestation、账号风险和强风控时，框架会进入人机协作、合规门禁或停止自动化。

## 最常用入口

```bash
npm install
npm start
```

打开控制台：

```text
http://127.0.0.1:3100/dashboard
```

命令行运行 workflow：

```bash
node src/cli.js run examples/demo.workflow.json
```

查看能力：

```bash
node src/cli.js capabilities
```
