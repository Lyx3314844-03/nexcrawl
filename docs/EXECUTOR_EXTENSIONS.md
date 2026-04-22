# 执行器扩展指南

## 为什么需要执行器

框架已经能生成计划，但真实环境里的 App 安装、ADB 命令、Frida attach、mitmproxy 抓包、Passkey 确认、扫码确认都需要具体执行器接入。

当前默认策略：

- 没有执行器时只 dry-run 或生成人工 challenge。
- 不会假装完成真实设备操作。
- 不会绕过 attestation 或设备信誉检查。

## 移动 App 执行器

入口：

```js
import { buildMobileAppExecutionPlan, executeMobileAppPlan } from 'nexcrawl';

const plan = buildMobileAppExecutionPlan({
  app: { packageName: 'com.demo', apkPath: 'demo.apk' },
  capture: { reinstall: true }
});

const adapter = {
  async 'install-app'(step) {
    // run adb install / ideviceinstaller here
  },
  async 'launch-app'(step) {
    // run adb shell monkey or appium launch here
  },
  async 'start-frida-session'(step) {
    // start frida process here
  },
  async 'start-network-capture'(step) {
    // start mitmdump here
  }
};

await executeMobileAppPlan(plan, adapter, { dryRun: false });
```

常见 step：

- `reserve-device`
- `uninstall-app`
- `install-app`
- `inject-ca-certificate`
- `start-network-capture`
- `start-frida-session`
- `launch-app`
- `collect-unified-model`
- `cleanup`

## 人工交互执行器

入口：

```js
import { HumanInteractionBroker } from 'nexcrawl';

const broker = new HumanInteractionBroker();
const challenge = broker.createChallenge({
  type: 'qr-login',
  tenantId: 'tenant-a',
  accountId: 'acct-1',
  instructions: '请用授权账号扫码登录'
});

// 人工完成后：
broker.resolveChallenge(challenge.id, { ok: true });
```

适用：

- SSO
- 企业 OAuth/SAML
- 扫码登录
- Passkey/WebAuthn
- 账号风险页
- 人工审批

## 反爬实验执行器

反爬实验室负责实验矩阵和结果记录，不负责绕过安全系统。

你可以接入：

- 浏览器 profile 版本回归。
- 代理/身份/浏览器组合实验。
- 成功率统计。
- 降级页面检测。

## attestation 合规门禁

入口：

```js
import { buildAttestationCompliancePlan } from 'nexcrawl';

const plan = buildAttestationCompliancePlan({
  status: 403,
  body: 'Play Integrity attestation failed'
});
```

如果检测到 attestation：

- 停止自动化。
- 使用 owner-approved test device。
- 人工升级。
- 记录审计。

禁止：

- 伪造 integrity token。
- 绕过设备信誉。
- 伪装 attestation。

