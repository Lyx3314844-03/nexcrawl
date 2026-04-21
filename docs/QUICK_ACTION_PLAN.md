# OmniCrawl 快速改进行动计划

## 当前建议

旧版行动计划里相当一部分 P0 项已完成或部分完成，因此本文件已改为**当前阶段**的短期路线图。

## 近两周优先事项

### 1. 文档对账

目标：让仓库里的 Markdown 不再互相打架。

任务：

- [ ] 对齐 `docs/API_REFERENCE.md` 与当前导出面
- [ ] 对齐 `docs/ARCHITECTURE.md` 与当前 observability 实现
- [ ] 对齐 `docs/QUICK_START.md` 与当前 programmatic API
- [ ] 为高级能力标注成熟度：`stable / advanced / experimental`

验收标准：

- ✅ 根文档与 `docs/` 不再出现明显互斥结论
- ✅ 新用户按文档可跑通基础示例

### 2. 拆分超大文件

目标：降低修改半径和回归成本。

优先拆分：

- [ ] `src/server.js`
- [ ] `src/runtime/job-runner.js`

建议切分顺序：

1. 先把 `server.js` 中的认证、错误处理中间件、基础 route helpers 抽出
2. 再把 job runner 的 request assembly / summary building / retry policy 分离

验收标准：

- ✅ 文件职责更清晰
- ✅ 现有测试无回归
- ✅ 新增模块边界可单测

### 3. 建立覆盖率基线

目标：停止用过时的“约 34%”口径描述项目质量。

任务：

- [ ] 固化 `npm run test:coverage` 输出产物
- [ ] 在 CI 中保存覆盖率摘要
- [ ] 为关键模块建立最低覆盖目标

优先模块：

- [ ] `workflow-loader`
- [ ] `workflow-templates`
- [ ] `server` 路由层
- [ ] `reverse-*runtime`

验收标准：

- ✅ 仓库中有可复用的 coverage 基线
- ✅ 文档中的覆盖率描述改为实际数字

### 4. 收敛全局配置模型

目标：避免 `setGlobalConfig()` 给人“全能开关”的错觉。

任务：

- [ ] 列出当前已接线配置项
- [ ] 决定扩大全局配置覆盖，还是缩减 `DEFAULT_CONFIG`
- [ ] 在 `CONFIG.md` 和类型定义中明确边界

验收标准：

- ✅ 用户能明确知道哪些配置会真实生效

## 不再作为当前 P0 的旧条目

以下事项已不应继续在文档中写成“尚未开始”：

- `/metrics` 端点已存在
- `security.yml` 已存在
- `CONTRIBUTING.md` 已存在
- 根脚本已包含 `test:reverse` / `test:watch` / `test:coverage`
- 结构化错误、日志脱敏、默认回环绑定已接入

## 推荐执行顺序

1. 先完成 `docs/` 全量对账
2. 再拆 `server.js`
3. 再拆 `job-runner.js`
4. 最后补 coverage 基线与模块级目标
