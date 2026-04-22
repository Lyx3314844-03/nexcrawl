const URL_RE = /^https?:\/\//i;
const GRAPHQL_RE = /(graphql|__schema|query\s+\w+|mutation\s+\w+)/i;
const WS_RE = /^wss?:\/\//i;
const GRPC_RE = /(grpc|protobuf|application\/grpc|\.proto\b)/i;
const APP_RE = /(apk|ipa|bundleId|packageName|android|ios|appium|frida|mitmproxy)/i;
const LOGIN_RE = /(login|signin|sign-in|auth|password|登录|请先登录)/i;
const INTERACTIVE_RE = /(sso|saml|openid|oauth|qr code|scan|扫码|二维码|passkey|webauthn|security key|账号风险|风控)/i;
const ATTESTATION_RE = /(play integrity|safetynet|devicecheck|app attest|attestation|device reputation|设备信誉|完整性校验)/i;
const ANTI_BOT_RE = /(captcha|cloudflare|akamai|datadome|perimeterx|kasada|waf|robot check|access denied|unusual traffic|验证码)/i;

function stringifyTarget(input = {}) {
  return [
    input.url,
    input.target,
    input.source,
    input.html,
    input.body,
    input.headers ? JSON.stringify(input.headers) : '',
    input.app ? JSON.stringify(input.app) : '',
    input.samples ? JSON.stringify(input.samples) : '',
  ].filter(Boolean).join('\n');
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function detectSourceKind(input = {}) {
  const text = stringifyTarget(input);
  const url = String(input.url ?? input.target ?? '');
  if (WS_RE.test(url)) return 'websocket';
  if (input.kind) return String(input.kind).toLowerCase();
  if (input.app || APP_RE.test(text)) return 'mobile-app';
  if (GRPC_RE.test(text)) return 'grpc';
  if (GRAPHQL_RE.test(text)) return 'graphql';
  if (/^\s*[\[{]/.test(String(input.body ?? input.sample ?? ''))) return 'api-json';
  if (URL_RE.test(url)) return 'web';
  return 'unknown';
}

export function analyzeUniversalTarget(input = {}) {
  const text = stringifyTarget(input);
  const sourceKind = detectSourceKind(input);
  const signals = {
    needsBrowser: /<script|__NEXT_DATA__|window\.__|data-reactroot|vue|nuxt|hydration/i.test(text) || input.rendered === true,
    loginLikely: LOGIN_RE.test(text),
    interactiveAuthLikely: INTERACTIVE_RE.test(text),
    antiBotLikely: ANTI_BOT_RE.test(text),
    attestationLikely: ATTESTATION_RE.test(text),
    graphqlLikely: sourceKind === 'graphql' || GRAPHQL_RE.test(text),
    websocketLikely: sourceKind === 'websocket',
    grpcLikely: sourceKind === 'grpc',
    mobileAppLikely: sourceKind === 'mobile-app',
  };
  const blockers = unique([
    signals.attestationLikely ? 'attestation-compliance-review' : null,
    signals.interactiveAuthLikely ? 'human-interaction-required' : null,
  ]);

  return {
    kind: 'universal-target-analysis',
    sourceKind,
    signals,
    blockers,
    canAutoRun: blockers.length === 0,
  };
}

function lane(type, reason, config = {}) {
  return {
    type,
    reason,
    config,
  };
}

export function buildUniversalCrawlPlan(input = {}) {
  const analysis = analyzeUniversalTarget(input);
  const lanes = [];
  const warnings = [];

  if (analysis.signals.attestationLikely) {
    lanes.push(lane('attestation-compliance', 'Target shows platform/device integrity requirements.', {
      policy: 'do-not-bypass',
      next: 'Use owner-approved test devices/accounts or stop automation.',
    }));
  }

  if (analysis.signals.interactiveAuthLikely) {
    lanes.push(lane('interactive-auth', 'Target likely requires SSO, QR, Passkey/WebAuthn, or risk review.', {
      challenge: true,
      next: 'Create human challenge and capture session after confirmation.',
    }));
  } else if (analysis.signals.loginLikely) {
    lanes.push(lane('login-state-machine', 'Target likely needs login/session management.', {
      session: true,
      accountPool: true,
    }));
  }

  if (analysis.signals.mobileAppLikely) {
    lanes.push(lane('mobile-app-execution', 'Target appears to be a native/mobile app capture task.', {
      devicePool: true,
      appium: true,
      frida: true,
      mitmproxy: true,
      dryRunDefault: true,
    }));
  } else if (analysis.signals.grpcLikely) {
    lanes.push(lane('grpc-semantics', 'Target appears to use gRPC/Protobuf.', {
      inferMessageTypes: true,
      replayRequiresSchemaOrSamples: true,
    }));
  } else if (analysis.signals.websocketLikely) {
    lanes.push(lane('websocket-semantics', 'Target is a WebSocket stream.', {
      inferSubscription: true,
      inferHeartbeat: true,
    }));
  } else if (analysis.signals.graphqlLikely) {
    lanes.push(lane('graphql-semantics', 'Target appears to use GraphQL.', {
      inferOperations: true,
      detectPagination: true,
    }));
  } else if (analysis.sourceKind === 'api-json') {
    lanes.push(lane('api-json', 'Target appears to return structured JSON.', {
      mode: 'http',
      extract: 'json',
    }));
  } else if (analysis.signals.needsBrowser) {
    lanes.push(lane('browser-crawl', 'Target appears to require JavaScript rendering.', {
      mode: 'browser',
      captureDebug: true,
    }));
  } else if (analysis.sourceKind === 'web') {
    lanes.push(lane('http-crawl', 'Target looks like a standard web page.', {
      mode: 'http',
      extract: ['title', 'links', 'surface'],
    }));
  }

  if (analysis.signals.antiBotLikely) {
    lanes.push(lane('anti-bot-lab', 'Target shows anti-bot or degraded-page signals.', {
      experimentMatrix: true,
      degradedPageDetection: true,
    }));
    warnings.push('Anti-bot signals require measurement and compliant operation; success is not guaranteed.');
  }

  if (lanes.length === 0) {
    lanes.push(lane('manual-discovery', 'Target type is unknown.', {
      next: 'Provide URL, HTML/body sample, network transcript, or app metadata.',
    }));
  }

  return {
    kind: 'universal-crawl-plan',
    analysis,
    lanes,
    warnings,
    runnable: analysis.canAutoRun && !analysis.signals.attestationLikely,
    nextActions: lanes.map((entry) => entry.type),
  };
}

