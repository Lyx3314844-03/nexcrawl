<p align="center">
  <img src="logo.svg" width="200" alt="NexCrawl" />
</p>

<p align="center">
  <strong>NexCrawl</strong> - 下一代数据采集平台
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Version-1.2.0-8B5CF6" alt="Version" /></a>
  <a href="docs/README.md"><img src="https://img.shields.io/badge/docs-中文文档-06B6D4" alt="Docs" /></a>
</p>

---

## 简介

**NexCrawl** 是一个面向 Web、API、协议和 App 场景的企业级数据采集平台。

它提供普通网页抓取、浏览器抓取、接口抓取、协议语义分析、登录态维护、账号/代理/设备资源管理、任务调度、数据导出、控制台、审计和治理能力。

> **安全声明**: 本框架不是"保证绕过任何网站限制"的工具。遇到 SSO、扫码登录、Passkey/WebAuthn、账号风险页、Play Integrity、SafetyNet、DeviceCheck、App Attest、设备信誉和强风控时，框架会进入人机协作、合规门禁或停止自动化。

## 核心特性

### 多协议支持

| 协议/场景 | 能力 | 状态 |
|-----------|------|------|
| **HTTP/HTTPS** | Cheerio 抓取、CSS/Regex/Surface 提取 | 稳定 |
| **浏览器** | JS 渲染、SPA、Cookie/Storage 管理 | 稳定 |
| **JSON API** | HTTP API 抓取、JSONPath 提取 | 稳定 |
| **GraphQL** | Endpoint 探测、语义排序、分页 | 稳定 |
| **WebSocket** | 订阅模型、心跳、错误恢复 | 稳定 |
| **gRPC/Protobuf** | 样本聚类、语义提示 | 稳定 |
| **Sitemap/Feed** | 自动发现、批量抓取 | 稳定 |
| **媒体资产** | 发现、下载、去重 | 稳定 |

### 高级功能

- **登录态管理**: Auth handler、Session store、Login recorder、Replay workflow
- **人工协作**: SSO/扫码/Passkey/风险页的人机协作确认
- **移动 App**: Device pool、App 执行计划、Appium/Frida/mitmproxy 支持
- **反爬实验**: 实验矩阵、降级检测、成功率统计
- **自愈能力**: 失败分析、自动修复建议、Workaround 生成
- **万能规划器**: 自动识别目标类型，推荐最佳执行路径

### 企业级治理

- **多租户**: 租户隔离、资源配额、独立配置
- **RBAC**: 角色权限管理、操作审计
- **账号池**: 账号管理、租借/释放、健康监控
- **代理池**: 多代理支持、策略路由、自动切换
- **设备池**: 移动设备管理、App 执行计划
- **凭证管理**: 加密存储、访问控制、审计日志

## 快速开始

### 一键安装

**Windows:**
```bash
install-windows.bat
```

**macOS:**
```bash
chmod +x install-macos.sh && ./install-macos.sh
```

**Linux:**
```bash
chmod +x install-linux.sh && ./install-linux.sh
```

### 手动安装

```bash
# 1. 克隆仓库
git clone https://github.com/Lyx3314844-03/nexcrawl.git
cd nexcrawl

# 2. 安装依赖
npm install

# 3. 启动服务
npm start

# 4. 打开控制台
# http://127.0.0.1:3100/dashboard
```

### Docker 部署

```bash
# 构建镜像
docker build -t nexcrawl .

# 运行容器
docker run -p 3100:3100 nexcrawl
```

## 使用示例

### 运行 Demo

```bash
node src/cli.js run examples/demo.workflow.json
```

### 查看框架能力

```bash
node src/cli.js capabilities
```

### 万能规划器

目标类型不确定时，先用万能规划器自动识别：

```bash
curl -s http://127.0.0.1:3100/platform/universal/plan \
  -H "content-type: application/json" \
  -d '{
    "url": "https://example.com/graphql",
    "body": "mutation Login { login { token } }"
  }'
```

规划器会返回推荐的执行路径：
- `http-crawl` - 普通网页抓取
- `browser-crawl` - 浏览器渲染
- `graphql-semantics` - GraphQL 协议分析
- `websocket-semantics` - WebSocket 分析
- `grpc-semantics` - gRPC/Protobuf 分析
- `login-state-machine` - 登录状态机
- `interactive-auth` - 交互式认证
- `mobile-app-execution` - 移动 App 执行
- `anti-bot-lab` - 反爬实验
- `attestation-compliance` - 合规门禁

### Workflow 示例

```json
{
  "name": "quick-start",
  "seedUrls": ["https://example.com"],
  "mode": "http",
  "concurrency": 2,
  "maxDepth": 1,
  "extract": [
    { "name": "title", "type": "regex", "pattern": "<title>([^<]+)</title>" },
    { "name": "links", "type": "selector", "selector": "a", "attr": "href" }
  ],
  "output": { "dir": "runs", "console": true }
}
```

保存为 `workflow.json` 后运行：

```bash
node src/cli.js run workflow.json
```

## CLI 命令

```bash
# 运行 workflow
node src/cli.js run <workflow.json>

# 启动 HTTP 服务
node src/cli.js serve --port 3100

# 从目标描述生成 workflow
node src/cli.js scaffold target.json --output workflow.json

# 初始化新项目
node src/cli.js init ./my-crawler

# 注册 workflow
node src/cli.js register <workflow.json> --id my-workflow

# 查看已注册 workflows
node src/cli.js workflows

# 查看任务历史
node src/cli.js history

# 查看会话
node src/cli.js sessions

# 查看代理
node src/cli.js proxies

# 查看能力
node src/cli.js capabilities
```

## 项目结构

```
nexcrawl/
├── src/
│   ├── api/              # API 模块
│   ├── core/             # 核心模块
│   ├── extractors/       # 数据提取器
│   ├── fetchers/         # 抓取器 (HTTP/浏览器/GraphQL/WebSocket)
│   ├── middleware/       # 中间件
│   ├── reverse/          # 逆向工程模块
│   ├── routes/           # API 路由
│   ├── runtime/          # 运行时 (任务调度/会话/代理/账号/设备)
│   ├── schemas/          # 数据验证 Schema
│   ├── types/            # TypeScript 类型定义
│   └── utils/            # 工具函数
├── docs/                 # 文档
├── examples/             # 示例
├── tests/                # 测试
├── deploy/               # 部署配置 (Docker/K8s/Helm)
├── scripts/              # 构建脚本
├── install-windows.bat   # Windows 安装脚本
├── install-macos.sh      # macOS 安装脚本
└── install-linux.sh      # Linux 安装脚本
```

## 文档

| 文档 | 说明 |
|------|------|
| [快速上手](./docs/QUICK_START_ZH.md) | 中文快速入门指南 |
| [能力矩阵](./docs/CAPABILITIES.md) | 详细的功能列表和边界说明 |
| [Workflow 指南](./docs/WORKFLOW_GUIDE.md) | 工作流编写最佳实践 |
| [平台 API](./docs/PLATFORM_API.md) | RESTful API 完整参考 |
| [运营与治理](./docs/OPERATIONS_AND_GOVERNANCE.md) | 多租户、RBAC、配额管理 |
| [执行器扩展](./docs/EXECUTOR_EXTENSIONS.md) | 自定义执行器开发指南 |
| [安全边界](./docs/SAFETY_BOUNDARIES.md) | 安全与合规说明 |
| [安装指南](./INSTALL.md) | 详细的多平台安装说明 |

## 生产环境配置

### 环境变量

```bash
# API 密钥保护
export NEXCRAWL_API_KEY=your-secret-api-key

# 凭证加密
export NEXCRAWL_VAULT_KEY=replace-with-long-random-secret
```

### 安全建议

- 设置 `NEXCRAWL_API_KEY` 保护 HTTP API
- 设置 `NEXCRAWL_VAULT_KEY` 加密本地凭证
- 使用多租户、RBAC、配额隔离资源
- 审计 `.nexcrawl/audit.ndjson`
- 为失败率、登录态、账号池、设备池配置监控告警
- 使用反向代理加 TLS 加密
- 将密钥迁移到 Vault/KMS 等外部密钥管理系统

## 技术栈

| 类别 | 技术 |
|------|------|
| **运行时** | Node.js 20+ |
| **HTTP** | Express.js |
| **浏览器** | Playwright, Puppeteer |
| **解析** | Cheerio, JSDOM |
| **数据库** | SQLite, Redis (可选) |
| **加密** | Crypto-JS, SM-Crypto |
| **日志** | Pino |
| **验证** | Zod |
| **逆向** | ESPrima, Babel |
| **部署** | Docker, Kubernetes, Helm |

## 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 支持

- 报告问题: [GitHub Issues](https://github.com/Lyx3314844-03/nexcrawl/issues)
- 讨论: [GitHub Discussions](https://github.com/Lyx3314844-03/nexcrawl/discussions)
- 文档: [docs/README.md](./docs/README.md)
