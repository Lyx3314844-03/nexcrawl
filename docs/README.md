# NexCrawl 文档中心

> 完整的技术文档、API 参考、操作指南与治理规范

## 快速导航

| 文档 | 描述 | 适合人群 |
| --- | --- | --- |
| [中文快速上手](./QUICK_START_ZH.md) | 5 分钟快速安装、配置并运行第一个采集任务 | 新用户 |
| [能力矩阵与边界](./CAPABILITIES.md) | 已实现的核心能力、协议支持与安全边界 | 架构师、安全团队 |
| [Workflow 编写指南](./WORKFLOW_GUIDE.md) | JSON Workflow 结构、提取器、插件、会话管理 | 开发者 |
| [平台 API 参考](./PLATFORM_API.md) | RESTful API 端点、请求/响应格式、鉴权 | 后端开发、集成 |
| [运营与治理](./OPERATIONS_AND_GOVERNANCE.md) | 多租户、RBAC、配额、凭证管理、审计 | 运维、管理员 |
| [执行器扩展指南](./EXECUTOR_EXTENSIONS.md) | 移动 App、人工交互、反爬实验、Attestation 合规 | 高级用户 |
| [安全与合规边界](./SAFETY_BOUNDARIES.md) | 明确不提供的能力、合规建议、生产部署规范 | 安全、法务 |

## 项目定位

NexCrawl 是一个面向 **Web、API、协议和 App 场景** 的数据采集平台。

它提供：
- **自动规划**：万能规划器自动识别目标类型并选择执行路径
- **任务执行**：HTTP 爬虫、浏览器渲染、GraphQL/WebSocket/gRPC 协议支持
- **会话与账号治理**：Session 管理、登录状态机、账号池、代理池、设备池
- **协议语义分析**：GraphQL 探测、WebSocket 订阅模型、Protobuf 样本聚类
- **自愈建议**：失败诊断、修复计划、任务回放
- **审计与控制台**：多租户隔离、RBAC、配额管理、审计日志、Web Dashboard

> **安全声明**：NexCrawl 不是"保证绕过任何网站限制"的工具。遇到 SSO、扫码、Passkey/WebAuthn、设备 Attestation、账号风险和强风控时，框架会进入人机协作、合规门禁或停止自动化。

## 快速开始

### 安装与启动

```bash
# 克隆仓库
git clone https://github.com/Lyx3314844-03/nexcrawl.git
cd nexcrawl

# 安装依赖
npm install

# 启动服务
npm start
```

### 访问控制台

```
http://127.0.0.1:3100/dashboard
```

### 运行第一个 Workflow

```bash
node src/cli.js run examples/demo.workflow.json
```

### 查看能力矩阵

```bash
node src/cli.js capabilities
```

## 核心概念

```
┌─────────────────────────────────────────────────┐
│                  NexCrawl Platform               │
├──────────┬──────────┬──────────┬────────────────┤
│  Web     │  API     │ Protocol│  Mobile App    │
│  Crawler │  Crawler │ Engine  │  Execution     │
├──────────┴──────────┴──────────┴────────────────┤
│              Universal Planner                   │
├─────────────────────────────────────────────────┤
│        Session / Account / Proxy / Device        │
├─────────────────────────────────────────────────┤
│         Governance / Audit / Dashboard           │
└─────────────────────────────────────────────────┘
```

## 文档结构

```
docs/
├── README.md                 # 文档入口（本文件）
├── QUICK_START_ZH.md         # 中文快速上手
├── CAPABILITIES.md           # 能力矩阵与边界
├── WORKFLOW_GUIDE.md         # Workflow 编写指南
├── PLATFORM_API.md           # 平台 API 参考
├── OPERATIONS_AND_GOVERNANCE.md  # 运营与治理
├── EXECUTOR_EXTENSIONS.md    # 执行器扩展指南
└── SAFETY_BOUNDARIES.md      # 安全与合规边界
```

## 推荐阅读路径

### 新用户
1. [中文快速上手](./QUICK_START_ZH.md) → 安装、启动、运行第一个任务
2. [Workflow 编写指南](./WORKFLOW_GUIDE.md) → 学习 JSON Workflow 结构
3. [能力矩阵](./CAPABILITIES.md) → 了解已支持协议和功能

### 运维与管理
1. [运营与治理](./OPERATIONS_AND_GOVERNANCE.md) → 多租户、RBAC、配额
2. [平台 API 参考](./PLATFORM_API.md) → RESTful API 端点
3. [安全与合规](./SAFETY_BOUNDARIES.md) → 生产部署建议

### 高级用户
1. [执行器扩展指南](./EXECUTOR_EXTENSIONS.md) → 移动 App、人工交互
2. [能力矩阵](./CAPABILITIES.md) → 安全边界与合规门禁

## 获取帮助

- **GitHub Issues**: [报告问题或提出功能请求](https://github.com/Lyx3314844-03/nexcrawl/issues)
- **文档**: 本目录下的完整文档
- **示例**: `examples/` 目录下的 Workflow 示例
