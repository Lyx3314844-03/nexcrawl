# 执行器扩展指南

> 移动 App、人工交互、反爬实验和 Attestation 合规门禁的扩展接入指南

---

## 为什么需要执行器

NexCrawl 框架能够生成完整的采集计划，但真实环境中的以下操作需要具体执行器接入：

| 操作类型 | 需要执行器 |
| --- | --- |
| App 安装/卸载 | ADB / ideviceinstaller |
| App 启动/自动化 | Appium / ADB shell |
| 网络抓包 | mitmproxy / mitmdump |
| Hook/逆向分析 | Frida |
| Passkey 确认 | 人工交互 |
| 扫码登录 | 人工交互 |
| SSO 认证 | 人工交互 |

### 默认策略

| 条件 | 行为 |
| --- | --- |
| 没有执行器 | 仅 dry-run 或生成人工 challenge |
| 不会假装完成 | 不会假装完成真实设备操作 |
| 不会绕过安全 | 不会绕过 Attestation 或设备信誉检查 |

---

## 移动 App 执行器

### 入口 API

```js
import { buildMobileAppExecutionPlan, executeMobileAppPlan } from 'nexcrawl';

// 1. 生成执行计划
const plan = buildMobileAppExecutionPlan({
  app: {
    packageName: 'com.demo',
    apkPath: 'demo.apk'
  },
  capture: {
    reinstall: true,
    networkCapture: true,
    fridaSession: true
  }
});

// 2. 定义执行器适配器
const adapter = {
  async 'install-app'(step) {
    // 执行 adb install 或 ideviceinstaller
    // 返回 { ok: true, details: {} }
  },
  async 'launch-app'(step) {
    // 执行 adb shell monkey 或 appium launch
    // 返回 { ok: true, details: {} }
  },
  async 'start-frida-session'(step) {
    // 启动 frida 进程
    // 返回 { ok: true, details: {} }
  },
  async 'start-network-capture'(step) {
    // 启动 mitmdump
    // 返回 { ok: true, details: {} }
  }
};

// 3. 执行计划
await executeMobileAppPlan(plan, adapter, { dryRun: false });
```

### 标准步骤

| 步骤 | 说明 | 常用工具 |
| --- | --- | --- |
| `reserve-device` | 预留设备 | 设备池 API |
| `uninstall-app` | 卸载旧版本 | `adb uninstall` |
| `install-app` | 安装 APK | `adb install` / `ideviceinstaller` |
| `inject-ca-certificate` | 注入 CA 证书 | `adb push` / 手动 |
| `start-network-capture` | 启动网络抓包 | `mitmdump` |
| `start-frida-session` | 启动 Frida Hook | `frida` |
| `launch-app` | 启动应用 | `adb shell monkey` / Appium |
| `collect-unified-model` | 采集统一模型数据 | 框架内置 |
| `cleanup` | 清理环境 | 框架内置 |

### Dry-Run 模式

```js
// dryRun: true 时仅生成计划，不执行真实操作
await executeMobileAppPlan(plan, adapter, { dryRun: true });
```

---

## 人工交互执行器

### 入口 API

```js
import { HumanInteractionBroker } from 'nexcrawl';

const broker = new HumanInteractionBroker();

// 创建人工确认任务
const challenge = broker.createChallenge({
  type: 'qr-login',
  tenantId: 'tenant-a',
  accountId: 'acct-1',
  instructions: '请用授权账号扫码登录'
});

// 等待人工完成
// ... 用户收到通知并完成操作 ...

// 标记任务完成
broker.resolveChallenge(challenge.id, { ok: true });
```

### 适用场景

| 场景 | Challenge Type | 说明 |
| --- | --- | --- |
| SSO | `sso-login` | 企业单点登录（SAML/OIDC） |
| 企业 OAuth | `oauth-login` | 企业 OAuth 认证 |
| 扫码登录 | `qr-login` | 二维码扫描登录 |
| Passkey/WebAuthn | `passkey-auth` | 无密码认证 |
| 账号风险页 | `account-risk` | 账号安全保护页面 |
| 人工审批 | `manual-approval` | 管理员审批流程 |

### 与平台 API 集成

人工确认任务也可以通过平台 API 管理：

```bash
# 查看待处理的人工确认任务
curl http://127.0.0.1:3100/platform/human-challenges

# 创建人工确认任务
curl -s http://127.0.0.1:3100/platform/human-challenges \
  -H "content-type: application/json" \
  -d '{
    "type": "qr-login",
    "tenantId": "tenant-a",
    "accountId": "acct-1",
    "instructions": "请用授权账号扫码登录"
  }'

# 完成确认
curl -s http://127.0.0.1:3100/platform/human-challenges/<challengeId>/resolve \
  -H "content-type: application/json" \
  -d '{ "ok": true }'
```

---

## 反爬实验执行器

### 功能定位

反爬实验室负责：
- 实验矩阵设计
- 结果记录与统计
- 降级页面检测

**不负责**: 绕过安全系统

### 可接入的操作

| 操作 | 说明 |
| --- | --- |
| 浏览器 profile 版本回归 | 测试不同浏览器版本的采集成功率 |
| 代理/身份/浏览器组合实验 | 测试不同资源组合的效果 |
| 成功率统计 | 统计不同策略的采集成功率 |
| 降级页面检测 | 自动识别反爬导致的降级页面 |

### 实验矩阵

```json
{
  "matrix": {
    "browserVersions": ["chrome-120", "chrome-119", "firefox-121"],
    "proxyTypes": ["residential", "datacenter", "mobile"],
    "strategies": ["default", "headless", "stealth"]
  }
}
```

框架会系统性测试所有组合，记录成功率并推荐最优策略。

---

## Attestation 合规门禁

### 入口 API

```js
import { buildAttestationCompliancePlan } from 'nexcrawl';

const plan = buildAttestationCompliancePlan({
  status: 403,
  body: 'Play Integrity attestation failed'
});
```

### 检测到 Attestation 时的行为

| 行为 | 说明 |
| --- | --- |
| 停止自动化 | 不尝试绕过 Attestation |
| 使用授权设备 | 要求 owner-approved test device |
| 人工升级 | 通知管理员处理 |
| 记录审计 | 写入 `.NexCrawl/audit.ndjson` |

### 明确禁止的操作

| 禁止操作 | 说明 |
| --- | --- |
| 伪造 integrity token | 不伪造任何设备验证令牌 |
| 绕过设备信誉 | 不尝试绕过设备信誉检查 |
| 伪装 Attestation | 不伪装任何 Attestation 结果 |

### 合规路径

当检测到 Attestation 时，框架提供的合规建议：

1. **使用授权测试设备**: 由设备所有者批准的测试设备
2. **使用授权测试环境**: 如沙箱、 staging 环境
3. **联系目标系统管理员**: 获取合法采集授权
4. **调整采集策略**: 如使用公开 API、减少请求频率
5. **记录合规决策**: 完整记录到审计日志

---

## 执行器开发指南

### 适配器接口

所有执行器适配器遵循统一接口：

```ts
interface ExecutorAdapter {
  // 步骤名称 -> 执行函数
  [stepName: string]: (step: ExecutionStep) => Promise<ExecutionResult>;
}

interface ExecutionStep {
  id: string;
  type: string;
  params: Record<string, any>;
}

interface ExecutionResult {
  ok: boolean;
  error?: string;
  details?: Record<string, any>;
}
```

### 开发新的执行器

1. 确定需要支持的步骤类型
2. 实现对应的执行函数
3. 返回标准的 `ExecutionResult`
4. 注册到框架

### 测试执行器

```js
// 使用 dry-run 模式测试
await executeMobileAppPlan(plan, adapter, { dryRun: true });

// 检查生成的计划是否符合预期
console.log(plan.steps);
```

---

## 下一步

- [平台 API 参考](./PLATFORM_API.md) - 移动 App 采集 API
- [安全与合规边界](./SAFETY_BOUNDARIES.md) - Attestation 合规指南
- [运营与治理](./OPERATIONS_AND_GOVERNANCE.md) - 多租户、审计日志
