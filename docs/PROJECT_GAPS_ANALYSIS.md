# OmniCrawl 当前缺陷分析

## 状态说明

本文件已按当前仓库状态更新。

截至本次修订：

- **源代码文件**: 142 个 `src/**/*.js`
- **测试文件**: 70 个 `tests/**/*.test.js`
- **已收敛的历史问题**:
  - API 默认绑定回环地址
  - API Key 不再接受 query 参数
  - HTTP 边界已返回结构化错误
  - 核心日志已接入敏感字段脱敏
  - 全局配置已接入 workflow 加载、直接 `runWorkflow()` 和 programmatic API 默认值
  - 根 `package.json` 已补齐 `test:reverse` / `test:watch` / `test:coverage`
  - 文档中一批已失效示例已修正

因此，旧版本文档中把若干基础设施描述为“完全缺失”的说法，已不再成立；当前更准确的表述应是“能力已存在，但成熟度和边界仍需澄清”。

## 仍然存在的主要缺陷

### 1. 文档仍有局部漂移

**现状**

- `README.md` / `EXAMPLES.md` / `CONFIG.md` 已做一轮收敛，但 `docs/` 下仍有部分设计文档保留旧叙述。
- 某些架构文档仍把 observability 描述成 `prom-client + OpenTelemetry SDK` 的完整生产集成，而当前实现更接近**内置同步指标/追踪摘要**。

**影响**

- 用户容易高估某些能力的成熟度。
- 新贡献者会被旧路线图误导。

**建议**

- 继续对 `docs/API_REFERENCE.md`、`docs/ARCHITECTURE.md`、`docs/QUICK_START.md` 做逐条对账。
- 为“当前已实现”和“计划中能力”显式分栏。

### 2. 可观测性仍偏轻量

**现状**

- 当前 `src/runtime/observability.js` 已统一并可工作，但它是**仓库内置实现**，不是完整的外部 Prometheus / OTEL 生产接入层。
- `server.js` 的 `/metrics` 仍是平台摘要接口，而不是完整 exporter 注册表。

**影响**

- 文档如果继续写成“生产级 Prometheus + OpenTelemetry”会过度承诺。
- 使用者可能期待现成的外部 collector / registry / exporter 生态对接。

**建议**

- 二选一：
  - 明确降级文档描述，强调当前是内置 observability surface。
  - 或补齐真正的 `prom-client` / OTEL exporter 集成和依赖声明。

### 3. 超大文件仍然是主要维护风险

**现状**

- `src/server.js`
- `src/runtime/job-runner.js`
- `src/reverse/reverse-lab-manager.js`

这些文件仍承担过多职责。

**影响**

- 回归半径大
- 阅读与验证成本高
- 继续堆功能会降低稳定性

**建议**

- 先拆 `server.js` 的 route registration 和 error/auth middleware。
- 再拆 `job-runner.js` 的：
  - request resolution
  - retry/backoff
  - summary/reporting
  - observability hooks

### 4. 测试数量提升了，但覆盖策略仍不均衡

**现状**

- 现在测试文件数量已明显高于旧文档中的 47。
- 但测试仍更偏向“功能存在”和“主路径回归”，不等于关键模块都具备完整边界覆盖。

**影响**

- 大模块重构仍有风险。
- 文档中的“覆盖率 34%”已过时，但“覆盖足够高”同样不能直接下结论。

**建议**

- 引入统一 coverage 基线报告。
- 优先补：
  - `workflow-loader`
  - `workflow-templates`
  - `reverse-*runtime`
  - `server` 路由级集成测试

### 5. 全局配置虽已接线，但仍非全覆盖

**现状**

- `performance` 与 `security.validation` 的关键项已接入主链路。
- 但 `DEFAULT_CONFIG` 中大量字段仍只是**配置模板**，不会自动驱动所有模块。

**影响**

- 用户可能误以为 `setGlobalConfig()` 会全局影响所有 reverse / stealth / runtime 行为。

**建议**

- 在 `CONFIG.md` 和类型声明里明确“已生效字段”。
- 继续决定：
  - 要么扩大全局配置覆盖面
  - 要么缩减/分拆 `DEFAULT_CONFIG`

### 6. 部分高级能力仍更像 toolkit，而非稳定平台能力

**现状**

- WAF 对抗、逆向、指纹伪装、浏览器调试能力很强，但成熟度并不完全一致。
- 某些能力更接近“专家工具箱”，不是零配置稳定产品面。

**影响**

- 营销式文案容易高估默认成功率。

**建议**

- 对这类能力添加成熟度标签：
  - stable
  - advanced
  - experimental

## 建议优先级

### P0

1. 继续清理 `docs/` 中剩余的过时表述。
2. 为 observability 明确真实边界，避免过度承诺。

### P1

3. 拆分 `server.js` / `job-runner.js`。
4. 增加覆盖率基线与模块级测试目标。

### P2

5. 决定全局配置模型是扩展还是收缩。
6. 为高级反爬/逆向能力补成熟度分级。

## 结论

OmniCrawl 当前最大的风险，已经不是“完全缺少基础设施”，而是：

- **文档叙述与当前实现边界不够一致**
- **大文件架构带来的长期维护成本**
- **高级能力的成熟度表达不清**

下一阶段最值得做的是：继续收敛文档，再开始结构拆分。
