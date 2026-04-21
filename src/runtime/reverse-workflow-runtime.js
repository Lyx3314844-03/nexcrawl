import { ReverseEngine } from '../reverse/reverse-engine.js';
import { ReversePlugin } from '../plugins/reverse-plugin.js';
import { ReverseAssetStore } from './reverse-asset-store.js';
import { buildNativeCapturePlan } from '../reverse/native-integration.js';

const APP_TYPE_HINTS = [
  { pattern: /(micromessenger|weixin|wechat|tencent\.mm)/i, type: 'wechat' },
  { pattern: /(douyin|aweme|tiktok)/i, type: 'douyin' },
  { pattern: /(taobao|aliapp\(tb|windvane)/i, type: 'taobao' },
  { pattern: /(^|[.\-_])jd([.\-_]|$)|jingdong/i, type: 'jd' },
];

function hasAnyValue(object = {}) {
  return Object.values(object).some((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (value && typeof value === 'object') {
      return hasAnyValue(value);
    }
    return value !== null && value !== undefined && value !== false && value !== '';
  });
}

export function buildIdentityHeaders(identity = {}) {
  const headers = {};

  if (identity.acceptLanguage) {
    headers['accept-language'] = identity.acceptLanguage;
  } else if (identity.languages?.length > 0) {
    headers['accept-language'] = identity.languages.join(',');
  }

  if (identity.clientHints && typeof identity.clientHints === 'object') {
    for (const [key, value] of Object.entries(identity.clientHints)) {
      headers[key.toLowerCase()] = String(value);
    }
  }

  return headers;
}

export function applyIdentityToWorkflow(workflow = {}) {
  const identity = workflow.identity ?? {};
  const nextHeaders = {
    ...(buildIdentityHeaders(identity)),
    ...(workflow.headers ?? {}),
  };

  if (identity.userAgent && !nextHeaders['user-agent']) {
    nextHeaders['user-agent'] = identity.userAgent;
  }

  return {
    ...workflow,
    headers: nextHeaders,
    browser: {
      ...(workflow.browser ?? {}),
      userAgent: identity.userAgent ?? workflow.browser?.userAgent,
    },
  };
}

function inferAppWebViewType(app = {}, identity = {}) {
  const hintValues = [
    app.type,
    app.appType,
    app.profile,
    app.bundleId,
    identity.bundleId,
    identity.userAgent,
  ].filter(Boolean);
  const hintText = hintValues.join(' ');

  for (const hint of APP_TYPE_HINTS) {
    if (hint.pattern.test(hintText)) {
      return hint.type;
    }
  }

  if (app.platform === 'ios') {
    return 'ios-wkwebview';
  }

  return 'android-webview';
}

function buildNativeCapabilitySummary(app = {}) {
  return {
    frida: {
      enabled: app.frida?.enabled === true,
      deviceId: app.frida?.deviceId ?? null,
      bundleId: app.frida?.bundleId ?? app.bundleId ?? null,
      scriptPath: app.frida?.scriptPath ?? null,
      exec: app.frida?.exec?.command ?? null,
      mode: app.frida?.enabled === true ? 'external-advisory' : 'disabled',
    },
    mitmproxy: {
      enabled: app.mitmproxy?.enabled === true,
      dumpPath: app.mitmproxy?.dumpPath ?? null,
      addonPath: app.mitmproxy?.addonPath ?? null,
      exec: app.mitmproxy?.exec?.command ?? null,
      mode: app.mitmproxy?.mode ?? 'regular',
      integration: app.mitmproxy?.enabled === true ? 'external-advisory' : 'disabled',
    },
    protobuf: {
      enabled: app.protobuf?.enabled === true,
      descriptorPaths: Array.isArray(app.protobuf?.descriptorPaths) ? app.protobuf.descriptorPaths : [],
    },
    grpc: {
      enabled: app.grpc?.enabled === true,
      services: app.grpc?.services ?? {},
    },
    websocket: {
      captureBinary: app.websocket?.captureBinary !== false,
    },
    sslPinning: {
      enabled: app.sslPinning?.enabled === true,
      mode: app.sslPinning?.mode ?? 'advisory',
    },
  };
}

function buildAppWebViewConfig(app = {}, identity = {}) {
  if (app.enabled !== true) {
    return null;
  }

  const type = inferAppWebViewType(app, identity);
  return {
    type,
    userAgent: identity.userAgent ?? app.userAgent,
    extraGlobals: {
      __OMNICRAWL_APP_PLATFORM: app.platform ?? null,
      __OMNICRAWL_APP_NATIVE_CAPABILITIES: buildNativeCapabilitySummary(app),
    },
  };
}

export function buildReverseEngineConfigFromWorkflow(workflow = {}) {
  const reverse = workflow.reverse ?? {};
  const identity = workflow.identity ?? {};
  const browserIdentityEnabled =
    identity.enabled === true
    || Boolean(identity.userAgent || identity.locale || identity.timezoneId || identity.webglVendor || identity.webglRenderer);

  const config = {
    ...(browserIdentityEnabled
      ? {
          stealth: {
            locale: identity.locale,
            languages: identity.languages,
            platform: identity.platform,
            vendor: identity.vendor,
            userAgent: identity.userAgent,
            deviceMemory: identity.deviceMemory,
            hardwareConcurrency: identity.hardwareConcurrency,
            maxTouchPoints: identity.maxTouchPoints,
            webglVendor: identity.webglVendor,
            webglRenderer: identity.webglRenderer,
            canvasNoise: identity.canvasNoise,
            audioNoise: identity.audioNoise,
            timezoneId: identity.timezoneId,
            acceptLanguage: identity.acceptLanguage,
          },
        }
      : {}),
    cloudflare: reverse.cloudflare ?? false,
    captcha: reverse.captcha ?? null,
    behaviorSim: reverse.behaviorSimulation ?? false,
    challenge: reverse.challenge?.enabled === false ? null : reverse.challenge,
    reverseAnalysis: reverse.autoReverseAnalysis === true,
    tlsProfile: identity.tlsProfile ?? null,
    h2Profile: identity.h2Profile ?? null,
  };

  if (reverse.app?.enabled === true) {
    config.appWebView = buildAppWebViewConfig(reverse.app, identity);
  }

  return config;
}

export function workflowHasReverseRuntime(workflow = {}) {
  return hasAnyValue(workflow.reverse ?? {})
    || hasAnyValue(workflow.identity ?? {})
    || hasAnyValue(workflow.signer ?? {});
}

export async function createWorkflowReverseRuntime({
  workflow,
  projectRoot,
  jobId,
  dataPlane,
  logger,
} = {}) {
  if (!workflowHasReverseRuntime(workflow)) {
    return {
      workflow,
      reverseEngine: null,
      runtimePlugins: [],
      assetStore: null,
    };
  }

  const workflowWithIdentity = applyIdentityToWorkflow(workflow);
  const reverseConfig = buildReverseEngineConfigFromWorkflow(workflowWithIdentity);
  const reverseEngine = new ReverseEngine(reverseConfig);
  const assetStore = new ReverseAssetStore({
    projectRoot,
    storageDir: workflow.reverse?.assets?.storageDir ?? '.omnicrawl/reverse-assets',
    workflowName: workflow.name,
    jobId,
    dataPlane,
  });
  await assetStore.init();

  if (workflow.reverse?.app?.enabled) {
    const nativePlan = buildNativeCapturePlan(workflow.reverse.app);
    await assetStore.recordAppCapture(`${workflow.name}-app-surface`, {
      platform: workflow.reverse.app.platform,
      webViewProfile: reverseConfig.appWebView?.type ?? null,
      nativeCapabilities: buildNativeCapabilitySummary(workflow.reverse.app),
      nativePlan,
      config: workflow.reverse.app,
    });
  }

  const reversePlugin = new ReversePlugin(reverseEngine, {
    workflow: workflowWithIdentity,
    assetStore,
    autoBehaviorSim: Boolean(workflow.reverse?.behaviorSimulation),
    autoReverseAnalysis: workflow.reverse?.autoReverseAnalysis === true,
  });

  return {
    workflow: workflowWithIdentity,
    reverseEngine,
    runtimePlugins: [reversePlugin.createPlugin(logger)],
    assetStore,
  };
}
