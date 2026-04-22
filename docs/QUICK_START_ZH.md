# 中文快速上手指南

> 5 分钟内完成安装、配置并运行你的第一个数据采集任务

## 前置要求

| 要求 | 说明 |
| --- | --- |
| Node.js | `>= 18.0.0`（推荐 LTS 版本） |
| npm | `>= 9.0.0`（随 Node.js 一起安装） |
| 操作系统 | Windows 10+、macOS 12+、Ubuntu 20.04+ |
| 内存 | 至少 2GB 可用内存 |
| 磁盘 | 至少 500MB 可用空间 |

---

## 1. 安装与启动

### 方式一：从源码安装

```bash
# 克隆仓库
git clone https://github.com/Lyx3314844-03/nexcrawl.git
cd nexcrawl

# 安装依赖
npm install

# 启动服务
npm start
```

### 方式二：使用安装脚本

```bash
# Windows
install-windows.bat

# macOS
bash install-macos.sh

# Linux
bash install-linux.sh
```

### 启动后访问

| 服务 | 地址 |
| --- | --- |
| Web Dashboard | `http://127.0.0.1:3100/dashboard` |
| Platform API | `http://127.0.0.1:3100` |
| 健康检查 | `http://127.0.0.1:3100/health` |
| 能力列表 | `http://127.0.0.1:3100/capabilities` |

### 仅运行 Workflow（无需启动服务）

```bash
node src/cli.js run examples/demo.workflow.json
```

---

## 2. 用 Dashboard 跑第一个任务

1. **打开 Dashboard**：访问 `http://127.0.0.1:3100/dashboard`
2. **找到"零代码快速开始"** 区域
3. **填写目标网址**：输入要采集的 URL
4. **选择页面类型**：
   | 类型 | 适用场景 |
   | --- | --- |
   | 静态网页 | 普通 HTML 页面，无需 JS 渲染 |
   | 浏览器渲染页 | SPA、需要 JS 执行的页面 |
   | JSON 接口 | REST API、返回 JSON 的端点 |
   | Sitemap/Feed | 网站地图、RSS/Atom Feed |
5. **点击"一键运行"**
6. **查看结果**：在 Recent Jobs 里点击 **Inspect** 查看：
   - 采集结果
   - 事件日志
   - 失败请求
   - 修复建议

---

## 3. 用万能规划器自动识别目标类型

当你不确定目标是普通网页、SPA、GraphQL、WebSocket、App、登录页还是强风控页面时，先调用万能规划器：

```bash
curl -s http://127.0.0.1:3100/platform/universal/plan \
  -H "content-type: application/json" \
  -d '{
    "url": "https://example.com",
    "html": "<script>window.__APP__={}</script>"
  }'
```

### 返回的 `lanes` 说明

规划器会返回推荐的执行路径：

| Lane | 说明 |
| --- | --- |
| `http-crawl` | 普通 HTTP 抓取，适用于静态页面和 API |
| `browser-crawl` | 浏览器渲染，适用于 SPA 和 JS 动态页面 |
| `graphql-semantics` | GraphQL 协议分析与查询生成 |
| `interactive-auth` | 交互式登录，适用于需要认证的页面 |
| `mobile-app-execution` | 移动 App 执行计划 |
| `attestation-compliance` | 设备 Attestation 合规检测 |

---

## 4. 最小 Workflow 示例

创建文件 `workflow.json`：

```json
{
  "name": "quick-html",
  "seedUrls": ["https://example.com"],
  "mode": "http",
  "concurrency": 1,
  "maxDepth": 0,
  "extract": [
    { "name": "title", "type": "regex", "pattern": "<title>([^<]+)</title>" },
    { "name": "surface", "type": "surface" }
  ],
  "plugins": [
    { "name": "dedupe" },
    { "name": "audit" }
  ],
  "output": {
    "dir": "runs",
    "console": true,
    "persistBodies": false
  }
}
```

运行：

```bash
node src/cli.js run workflow.json
```

### 输出文件

运行完成后，结果保存在 `runs/<jobId>/` 目录：

```
runs/<jobId>/
├── summary.json        # 任务摘要、统计信息
├── results.ndjson      # 采集结果（每行一条 JSON）
├── events.ndjson       # 事件日志
└── workflow.json       # 使用的 Workflow 配置
```

---

## 5. 常见场景配置指南

| 场景 | 推荐配置 | 文档链接 |
| --- | --- | --- |
| 普通 HTML 页面 | `mode: "http"` | [Workflow 指南](./WORKFLOW_GUIDE.md) |
| 需要 JS 渲染的页面 | `mode: "browser"` 或 Dashboard 浏览器模板 | [Workflow 指南](./WORKFLOW_GUIDE.md) |
| JSON API | `ApiJsonCrawler` 或 JSON workflow | [平台 API](./PLATFORM_API.md) |
| GraphQL | `/platform/protocol/semantics` + GraphQL crawler | [平台 API](./PLATFORM_API.md) |
| WebSocket | `/platform/protocol/semantics` + WebSocket crawler | [平台 API](./PLATFORM_API.md) |
| gRPC/Protobuf | gRPC workflow / `GrpcCrawler` + 样本语义分析 | [执行器扩展](./EXECUTOR_EXTENSIONS.md) |
| 登录页 | 登录状态机 + session store + login recorder | [Workflow 指南](./WORKFLOW_GUIDE.md) |
| SSO/扫码/Passkey | interactive auth challenge | [执行器扩展](./EXECUTOR_EXTENSIONS.md) |
| 原生 App | device pool + mobile app execution plan | [执行器扩展](./EXECUTOR_EXTENSIONS.md) |
| 强风控/attestation | attestation compliance gate | [安全边界](./SAFETY_BOUNDARIES.md) |

---

## 6. 下一步

- 阅读 [Workflow 编写指南](./WORKFLOW_GUIDE.md) 学习更多提取器和插件
- 查看 [平台 API 参考](./PLATFORM_API.md) 了解完整的 RESTful API
- 了解 [能力矩阵](./CAPABILITIES.md) 查看已支持的协议和功能
- 阅读 [安全与合规边界](./SAFETY_BOUNDARIES.md) 了解生产部署规范
