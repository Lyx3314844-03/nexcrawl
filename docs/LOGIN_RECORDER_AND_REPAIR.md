# 登录录制器和修复计划快速操作

## 功能概述

### 1. 登录录制器 Dashboard

可视化面板用于录制登录流程，支持：
- 实时录制用户操作（点击、输入、导航）
- 保存和管理录制会话
- 导出录制数据用于 workflow replay

### 2. Repair Plan 一键注册并重跑

自动修复失败的 workflow 并立即重新运行：
- 自动生成修复补丁
- 一键注册修复后的 workflow
- 立即启动新 job 执行

## 使用指南

### 登录录制器

#### 1. 访问 Dashboard

```bash
# 启动服务器
npm start

# 访问录制器面板
open http://localhost:3000/login-recorder
```

#### 2. 开始录制

1. 在面板中输入目标 URL（如 `https://example.com/login`）
2. 点击 "▶ Start Recording"
3. 在浏览器中执行登录操作
4. 点击 "■ Stop & Save" 保存录制

#### 3. 管理会话

- **重命名**: 点击 "✏ Rename" 修改会话名称
- **导出**: 点击 "⬇ Export" 下载 JSON 格式的录制数据
- **查看**: 面板显示所有已保存的会话和步骤数

#### 4. API 集成

```javascript
// 开始录制
POST /api/login-recorder/start
{
  "url": "https://example.com/login"
}

// 记录动作（由浏览器扩展或 CDP 调用）
POST /api/login-recorder/action
{
  "type": "click",
  "selector": "#login-button",
  "value": null
}

// 停止录制
POST /api/login-recorder/stop

// 获取状态
GET /api/login-recorder/status

// 导出会话
GET /api/login-recorder/sessions/:id/export
```

### Repair Plan 一键注册并重跑

#### 1. 生成修复计划

```javascript
POST /api/workflows/repair-plan
{
  "workflow": {
    "name": "my-workflow",
    "mode": "http",
    "seedUrls": ["https://example.com"]
  },
  "diagnostics": {
    "suspects": [
      { "type": "auth-or-session-state" }
    ]
  },
  "failedRequests": [...]
}

// 响应
{
  "patch": { ... },
  "reasons": ["Enable session persistence..."],
  "rebuiltWorkflow": { ... },
  "suggestedWorkflowId": "my-workflow-repaired",
  "quickActions": {
    "registerAndRerun": {
      "enabled": true,
      "workflowId": "my-workflow-repaired",
      "endpoint": "/api/workflows/register-and-run"
    }
  }
}
```

#### 2. 一键注册并重跑

```javascript
POST /api/workflows/register-and-run
{
  "workflow": { ... },
  "diagnostics": { ... },
  "recipe": { ... },
  "failedRequests": [...]
}

// 响应
{
  "success": true,
  "workflowId": "my-workflow-repaired",
  "jobId": "job-123",
  "message": "Registered workflow \"my-workflow-repaired\" and started job job-123",
  "runPromise": { ... }
}
```

#### 3. 代码示例

```javascript
import { buildWorkflowRepairPlan, registerAndRerunRepair } from 'omnicrawl';

// 生成修复计划
const repairPlan = buildWorkflowRepairPlan({
  workflow: failedWorkflow,
  diagnostics: jobDiagnostics,
  failedRequests: job.failedRequests,
});

console.log('Repair reasons:', repairPlan.reasons);
console.log('Quick actions:', repairPlan.quickActions);

// 一键注册并重跑
const result = await registerAndRerunRepair({
  repairPlan,
  jobStore,
  workflowRegistry,
  jobRunner,
});

console.log(`Started job ${result.jobId} with workflow ${result.workflowId}`);
```

## 修复策略

Repair Plan 会根据诊断结果自动应用以下修复：

### 1. 认证/会话问题
```javascript
// 检测到: auth-or-session-state
// 修复: 启用会话持久化和浏览器 replay
{
  session: { enabled: true, captureStorage: true },
  browser: { replay: { steps: [...] } }
}
```

### 2. 签名/参数链问题
```javascript
// 检测到: signature-or-parameter-chain
// 修复: 启用逆向分析和签名捕获
{
  reverse: { enabled: true, autoReverseAnalysis: true },
  signer: { enabled: true, capture: { enabled: true } }
}
```

### 3. 指纹/反爬虫问题
```javascript
// 检测到: fingerprint-or-anti-bot
// 修复: 加强身份一致性
{
  identity: {
    enabled: true,
    consistency: { httpHeaders: true, browserProfile: true }
  }
}
```

### 4. 代理/网络质量问题
```javascript
// 检测到: proxy-or-network-quality
// 修复: 增加重试韧性
{
  retry: { attempts: 3, backoffMs: 1000 }
}
```

## 最佳实践

### 登录录制器

1. **录制前准备**
   - 清除浏览器缓存和 cookies
   - 使用隐身模式确保干净环境
   - 准备好测试账号

2. **录制过程**
   - 操作要慢，确保每个动作被捕获
   - 等待页面完全加载后再操作
   - 避免不必要的操作（如鼠标移动）

3. **录制后验证**
   - 检查录制的步骤是否完整
   - 测试导出的 JSON 是否可用
   - 在 workflow 中验证 replay 效果

### Repair Plan

1. **诊断优先**
   - 先运行完整诊断获取 suspects
   - 收集失败请求的详细信息
   - 分析失败模式

2. **渐进式修复**
   - 先预览修复计划（`/repair-plan`）
   - 检查修复原因是否合理
   - 确认后再执行注册并重跑

3. **监控结果**
   - 跟踪修复后的 job 执行
   - 对比修复前后的成功率
   - 根据结果调整修复策略

## 故障排查

### 登录录制器

**问题**: 录制的动作不完整
- 检查浏览器控制台是否有错误
- 确认 `/api/login-recorder/action` 端点可访问
- 验证 CDP 连接是否正常

**问题**: 无法停止录制
- 刷新页面重新开始
- 检查 activeRecording 状态
- 查看服务器日志

### Repair Plan

**问题**: 修复后仍然失败
- 检查诊断结果是否准确
- 验证修复补丁是否正确应用
- 尝试手动调整 workflow 配置

**问题**: 注册失败
- 确认 workflowRegistry 可用
- 检查 workflow ID 是否冲突
- 验证 workflow schema 是否有效

## 技术细节

### 录制数据格式

```json
{
  "id": "rec-1234567890",
  "url": "https://example.com/login",
  "steps": [
    {
      "type": "navigate",
      "selector": null,
      "value": "https://example.com/login",
      "timestamp": "2026-04-18T11:50:00.000Z"
    },
    {
      "type": "click",
      "selector": "#username",
      "value": null,
      "timestamp": "2026-04-18T11:50:01.000Z"
    },
    {
      "type": "type",
      "selector": "#username",
      "value": "user@example.com",
      "timestamp": "2026-04-18T11:50:02.000Z"
    }
  ],
  "startedAt": "2026-04-18T11:50:00.000Z",
  "stoppedAt": "2026-04-18T11:50:10.000Z"
}
```

### Repair Plan 结构

```javascript
{
  patch: {
    // 修复补丁（合并到原 workflow）
    mode: 'browser',
    session: { enabled: true },
    // ...
  },
  reasons: [
    // 修复原因列表
    'Enable session persistence for auth failures',
    // ...
  ],
  rebuiltWorkflow: {
    // 完整的修复后 workflow
  },
  suggestedWorkflowId: 'my-workflow-repaired',
  quickActions: {
    registerAndRerun: {
      enabled: true,
      workflowId: 'my-workflow-repaired',
      endpoint: '/api/workflows/register-and-run'
    }
  }
}
```

## 限制和注意事项

### 登录录制器

- 当前是"动作录制器"，不是完整的远程可视化录屏
- 需要浏览器扩展或 CDP 集成才能自动捕获动作
- 录制数据存储在内存中，重启服务器会丢失

### Repair Plan

- 修复策略基于启发式规则，不保证 100% 成功
- 某些复杂问题可能需要手动调整
- 修复后的 workflow 需要验证和测试

## 未来改进

- [ ] 登录录制器支持远程可视化录屏
- [ ] 录制数据持久化到数据库
- [ ] 支持录制回放和编辑
- [ ] AI 辅助修复策略生成
- [ ] 修复效果自动评估和反馈
