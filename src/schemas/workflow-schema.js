import { z } from 'zod';

function normalizeProxyInput(value) {
  if (typeof value === 'string') {
    return { server: value };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  if (value.url && !value.server) {
    return {
      ...value,
      server: value.url,
    };
  }

  return value;
}

function normalizeOutputInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  if (value.directory && !value.dir) {
    return {
      ...value,
      dir: value.directory,
    };
  }

  return value;
}

function normalizeRateLimiterInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  if (value.domainOverrides instanceof Map) {
    return {
      ...value,
      domainOverrides: Object.fromEntries(value.domainOverrides),
    };
  }

  return value;
}

const extractorRuleSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['regex', 'json', 'script', 'selector', 'links', 'surface', 'reverse', 'xpath', 'media', 'network']),
    format: z.enum(['url', 'object']).optional(),
    pattern: z.string().optional(),
    flags: z.string().default(''),
    path: z.string().optional(),
    xpath: z.string().optional(),
    selector: z.string().optional(),
    attribute: z.string().optional(),
    all: z.boolean().default(false),
    code: z.string().optional(),
    mode: z.enum(['auto', 'script', 'html']).default('auto'),
    operation: z.string().optional(),
    functionName: z.string().optional(),
    args: z.array(z.any()).default([]),
    expression: z.string().optional(),
    language: z.string().optional(),
    languages: z.array(z.string()).optional(),
    options: z.record(z.any()).optional(),
    xml: z.boolean().optional(),
    kinds: z.array(z.enum(['image', 'video', 'audio'])).optional(),
    includeDom: z.boolean().optional(),
    includeMeta: z.boolean().optional(),
    includeJsonLd: z.boolean().optional(),
    includeNetwork: z.boolean().optional(),
    includeResponse: z.boolean().optional(),
    transport: z.string().optional(),
    transports: z.array(z.string()).optional(),
    urlPattern: z.string().optional(),
    preferUrlPatterns: z.array(z.string()).optional(),
    avoidUrlPatterns: z.array(z.string()).optional(),
    selection: z.enum(['payload', 'primary-data']).optional(),
    source: z.enum(['request', 'response']).optional(),
    requireJson: z.boolean().optional(),
    includeMeta: z.boolean().optional(),
    maxItems: z.number().int().positive().max(500).default(50),
  })
  .passthrough();

const pluginSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().optional(),
    exportName: z.string().optional(),
    options: z.record(z.any()).default({}),
  })
  .passthrough();

const proxyServerSchema = z
  .object({
    label: z.string().optional(),
    server: z.string().min(1),
    url: z.string().min(1).optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    region: z.string().optional(),
    country: z.string().optional(),
    city: z.string().optional(),
    bypass: z.array(z.string()).default([]),
    weight: z.number().positive().max(100).default(1),
    disabled: z.boolean().default(false),
    match: z
      .object({
        hosts: z.array(z.string()).default([]),
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
        protocols: z.array(z.enum(['http', 'https'])).default([]),
      })
      .default({}),
  })
  .passthrough()
  .transform(({ url, ...proxy }) => proxy);

const grpcRequestConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    service: z.string().min(1).optional(),
    method: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    metadata: z.record(z.string()).default({}),
    descriptorPaths: z.array(z.string().min(1)).default([]),
    requestType: z.string().min(1).optional(),
    responseType: z.string().min(1).optional(),
    requestSchema: z.any().optional(),
    responseSchema: z.any().optional(),
    stream: z.boolean().default(false),
    bodyEncoding: z.enum(['auto', 'json', 'protobuf-base64', 'grpc-frame-base64', 'utf8']).default('auto'),
    maxRetries: z.number().int().nonnegative().max(10).optional(),
    retryDelayMs: z.number().int().nonnegative().max(120000).optional(),
  })
  .passthrough();

const seedRequestSchema = z
  .object({
    url: z.string().url(),
    method: z.string().optional(),
    headers: z.record(z.string()).default({}),
    body: z.string().optional(),
    grpc: grpcRequestConfigSchema.optional(),
    label: z.string().nullable().optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    userData: z.record(z.any()).default({}),
    metadata: z.record(z.any()).default({}),
  })
  .passthrough();

const rateLimiterSchema = z
  .object({
    enabled: z.boolean().default(true),
    requestsPerSecond: z.number().positive().max(1000).default(1),
    minDelayMs: z.number().int().nonnegative().max(600000).default(0),
    maxDelayMs: z.number().int().nonnegative().max(600000).default(0),
    burstSize: z.number().int().positive().max(100).default(1),
    maxConcurrent: z.number().int().positive().max(100).optional(),
    domainOverrides: z.record(z.number().positive()).default({}),
    autoThrottle: z
      .object({
        enabled: z.boolean().default(false),
        minRequestsPerSecond: z.number().positive().max(1000).default(0.25),
        maxRequestsPerSecond: z.number().positive().max(1000).optional(),
        targetLatencyMs: z.number().int().positive().max(120000).default(2000),
        errorRateThreshold: z.number().min(0).max(1).default(0.2),
        scaleDownFactor: z.number().gt(0).lt(1).default(0.7),
        scaleUpStep: z.number().positive().max(5).default(0.1),
        smoothing: z.number().min(0).max(1).default(0.3),
        cooldownMs: z.number().int().nonnegative().max(600000).default(5000),
      })
      .default({}),
  })
  .passthrough()
  .transform((value) => ({
    ...value,
    maxConcurrent: value.maxConcurrent ?? value.burstSize,
  }));

const observabilitySchema = z
  .object({
    tracing: z
      .object({
        enabled: z.boolean().default(false),
        serviceName: z.string().min(1).default('omnicrawl'),
        endpoint: z.string().url().optional(),
        sampleRate: z.number().min(0).max(1).default(1),
      })
      .default({}),
    metrics: z
      .object({
        enabled: z.boolean().default(false),
        port: z.number().int().positive().max(65535).default(9100),
        prefix: z.string().default('omnicrawl_'),
        defaultLabels: z.record(z.string()).default({}),
      })
      .default({}),
  })
  .passthrough();

const identitySchema = z
  .object({
    enabled: z.boolean().default(false),
    bundleId: z.string().min(1).optional(),
    userAgent: z.string().optional(),
    acceptLanguage: z.string().optional(),
    locale: z.string().default('zh-CN'),
    languages: z.array(z.string().min(1)).default(['zh-CN', 'zh', 'en-US']),
    timezoneId: z.string().optional(),
    platform: z.string().default('Win32'),
    vendor: z.string().default('Google Inc.'),
    deviceMemory: z.number().positive().max(64).default(8),
    hardwareConcurrency: z.number().int().positive().max(128).default(8),
    maxTouchPoints: z.number().int().nonnegative().max(32).default(0),
    webglVendor: z.string().default('Google Inc. (Intel)'),
    webglRenderer: z.string().default('ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)'),
    canvasNoise: z.number().nonnegative().max(10).default(3),
    audioNoise: z.number().nonnegative().max(10).default(2),
    proxyRegion: z.string().optional(),
    proxyCountry: z.string().optional(),
    proxyCity: z.string().optional(),
    fonts: z.array(z.string().min(1)).default([]),
    clientHints: z.record(z.string()).default({}),
    geolocation: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracy: z.number().positive().max(100000).default(100),
      })
      .optional(),
    tlsProfile: z.string().optional(),
    h2Profile: z.any().optional(),
    consistency: z
      .object({
        httpHeaders: z.boolean().default(true),
        browserProfile: z.boolean().default(true),
        bindProxyRegion: z.boolean().default(false),
        driftDetection: z.boolean().default(true),
        autoCorrect: z.boolean().default(true),
      })
      .default({}),
  })
  .default({});

const signerRegressionCaseSchema = z
  .object({
    name: z.string().min(1),
    params: z.record(z.any()).default({}),
    equals: z.any().optional(),
    matches: z.string().optional(),
    exists: z.boolean().optional(),
  })
  .passthrough();

const signerSchema = z
  .object({
    enabled: z.boolean().default(false),
    assetId: z.string().min(1).optional(),
    source: z.enum(['auto', 'artifact', 'inline', 'rpc']).default('auto'),
    functionName: z.string().optional(),
    paramName: z.string().optional(),
    maxCandidates: z.number().int().positive().max(50).default(5),
    minScore: z.number().int().nonnegative().max(1000).default(20),
    capture: z
      .object({
        enabled: z.boolean().default(true),
        sources: z.array(z.enum(['responseBody', 'debugScripts'])).default(['responseBody']),
        maxScripts: z.number().int().positive().max(100).default(10),
      })
      .default({}),
    inject: z
      .object({
        enabled: z.boolean().default(false),
        mode: z.enum(['artifact', 'rpc', 'value']).default('artifact'),
        location: z.enum(['header', 'query', 'body', 'cookie']).default('header'),
        name: z.string().default('x-signature'),
        rpcUrl: z.string().url().optional(),
        template: z.string().optional(),
        params: z.record(z.string()).default({}),
      })
      .default({}),
    regression: z
      .object({
        enabled: z.boolean().default(false),
        cases: z.array(signerRegressionCaseSchema).default([]),
      })
      .default({}),
  })
  .default({});

const reverseRegressionSchema = z
  .object({
    enabled: z.boolean().default(false),
    requestContracts: z.array(
      z.object({
        name: z.string().min(1),
        urlPattern: z.string().optional(),
        finalUrlPattern: z.string().optional(),
        method: z.string().optional(),
        transport: z.enum(['document', 'fetch', 'xhr', 'websocket', 'other']).optional(),
        status: z.number().int().min(100).max(599).optional(),
        requestHeaderNames: z.array(z.string().min(1)).default([]),
        responseHeaderNames: z.array(z.string().min(1)).default([]),
        requestBodyPattern: z.string().optional(),
        responseBodyPattern: z.string().optional(),
        minMatches: z.number().int().nonnegative().max(1000).default(1),
        maxMatches: z.number().int().nonnegative().max(1000).optional(),
      }).passthrough(),
    ).default([]),
    challenge: z
      .object({
        enabled: z.boolean().default(false),
        maxDetected: z.number().int().nonnegative().max(1000).default(0),
        requireSolved: z.boolean().default(false),
      })
      .default({}),
    identity: z
      .object({
        enabled: z.boolean().default(false),
        allowDriftFields: z.array(z.string().min(1)).default([]),
      })
      .default({}),
    antiBot: z
      .object({
        enabled: z.boolean().default(false),
        maxChallengeLikely: z.number().int().nonnegative().max(1000).default(0),
        maxBlocked: z.number().int().nonnegative().max(1000).default(0),
      })
      .default({}),
  })
  .default({});

const reverseSchema = z
  .object({
    enabled: z.boolean().default(false),
    autoReverseAnalysis: z.boolean().default(false),
    cloudflare: z.union([z.boolean(), z.record(z.any())]).default(false),
    captcha: z.object({
      provider: z.string().optional(),
      service: z.string().optional(),
      apiKey: z.string().optional(),
      maxWaitMs: z.number().int().positive().max(600000).optional(),
    }).passthrough().nullable().default(null),
    behaviorSimulation: z.union([z.boolean(), z.record(z.any())]).default(false),
    challenge: z
      .object({
        enabled: z.boolean().default(true),
        statuses: z.array(z.number().int().min(100).max(599)).default([403, 429, 503]),
        bodyPatterns: z.array(z.string().min(1)).default([
          'cdn-cgi/challenge-platform',
          'attention required',
          'captcha',
          '__cf_chl',
        ]),
        maxSolveAttempts: z.number().int().positive().max(10).default(2),
        retryOnSolved: z.boolean().default(false),
        retryOnFailed: z.boolean().default(true),
        retryDelayMs: z.number().int().nonnegative().max(120000).default(1000),
        sessionAction: z.enum(['retain', 'reportFailure', 'retire']).default('reportFailure'),
        proxyAction: z.enum(['retain', 'reportFailure', 'cooldown']).default('reportFailure'),
        attribution: z.enum(['challenge', 'session', 'proxy', 'signer', 'identity']).default('challenge'),
        validate: z
          .object({
            enabled: z.boolean().default(true),
            successCookieNames: z.array(z.string().min(1)).default(['cf_clearance']),
            absencePatterns: z.array(z.string().min(1)).default([
              'cdn-cgi/challenge-platform',
              'attention required',
              'captcha',
              '__cf_chl',
            ]),
          })
          .default({}),
      })
      .default({}),
    app: z
      .object({
        enabled: z.boolean().default(false),
        platform: z.enum(['android', 'ios', 'miniapp', 'webview']).default('android'),
        frida: z
          .object({
            enabled: z.boolean().default(false),
            deviceId: z.string().optional(),
            bundleId: z.string().optional(),
            scriptPath: z.string().optional(),
            exec: z
              .object({
                command: z.string().min(1),
                args: z.array(z.string()).default([]),
                shell: z.boolean().default(false),
              })
              .optional(),
          })
          .default({}),
        mitmproxy: z
          .object({
            enabled: z.boolean().default(false),
            dumpPath: z.string().optional(),
            mode: z.string().default('regular'),
            addonPath: z.string().optional(),
            exec: z
              .object({
                command: z.string().min(1),
                args: z.array(z.string()).default([]),
                shell: z.boolean().default(false),
              })
              .optional(),
          })
          .default({}),
        protobuf: z
          .object({
            enabled: z.boolean().default(false),
            descriptorPaths: z.array(z.string().min(1)).default([]),
          })
          .default({}),
        grpc: z
          .object({
            enabled: z.boolean().default(false),
            services: z.record(z.any()).default({}),
          })
          .default({}),
        websocket: z
          .object({
            captureBinary: z.boolean().default(true),
          })
          .default({}),
        sslPinning: z
          .object({
            enabled: z.boolean().default(false),
            mode: z.enum(['advisory', 'external']).default('advisory'),
          })
          .default({}),
      })
      .default({}),
    assets: z
      .object({
        enabled: z.boolean().default(true),
        storageDir: z.string().default('.omnicrawl/reverse-assets'),
        persistArtifacts: z.boolean().default(true),
        captureSignerFromResponse: z.boolean().default(true),
      })
      .default({}),
    regression: reverseRegressionSchema,
  })
  .default({});

const browserAutoScrollSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { __provided: false };
    }
    return {
      __provided: Object.keys(value).length > 0,
      ...value,
    };
  },
  z
    .object({
      __provided: z.boolean().default(false),
      enabled: z.boolean().optional(),
      maxScrolls: z.number().int().positive().max(500).default(60),
      delayMs: z.number().int().nonnegative().max(30000).default(400),
      stabilityThresholdMs: z.number().int().nonnegative().max(120000).default(2000),
      maxStableIterations: z.number().int().positive().max(50).default(4),
      scrollStep: z.string().optional(),
      loadMoreSelector: z.string().optional(),
      scrollTargetSelector: z.string().optional(),
      itemSelector: z.string().optional(),
      observeLazyContainers: z.boolean().default(true),
      requireBottom: z.boolean().default(true),
      sampleItems: z.number().int().positive().max(50).default(12),
    })
    .transform(({ __provided, ...value }) => ({
      ...value,
      enabled: value.enabled ?? __provided,
    })),
);

export const workflowSchema = z
  .object({
    name: z.string().min(1),
    seedUrls: z.array(z.string().url()).min(1),
    seedRequests: z.array(seedRequestSchema).optional(),
    mode: z.enum(['http', 'browser', 'cheerio', 'hybrid']).default('hybrid'),
    concurrency: z.number().int().positive().max(20).default(3),
    maxDepth: z.number().int().nonnegative().max(10).default(1),
    timeoutMs: z.number().int().positive().max(120000).default(30000),
    headers: z.record(z.string()).default({}),
    identity: identitySchema,
    reverse: reverseSchema,
    signer: signerSchema,
    request: z
      .object({
        method: z.string().default('GET'),
        body: z.string().optional(),
      })
      .default({ method: 'GET' }),
    grpc: grpcRequestConfigSchema.optional(),
    websocket: z
      .object({
        sendMessage: z.any().optional(),
        sendMessages: z.array(z.any()).default([]),
        collectMs: z.number().int().positive().max(300000).default(5000),
        maxMessages: z.number().int().positive().max(10000).default(100),
        terminateOn: z.string().optional(),
        connectTimeoutMs: z.number().int().positive().max(120000).default(10000),
        binary: z.boolean().default(false),
      })
      .default({}),
    browser: z
      .object({
        engine: z.string().default('auto'),
        headless: z.boolean().default(true),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).default('networkidle2'),
        timeoutMs: z.number().int().positive().max(120000).default(45000),
        waitForSelector: z.string().optional(),
        sleepMs: z.number().int().nonnegative().max(30000).default(0),
        viewport: z
          .object({
            width: z.number().int().positive().default(1440),
            height: z.number().int().positive().default(900),
          })
          .default({
            width: 1440,
            height: 900,
          }),
        executablePath: z.string().optional(),
        launchArgs: z.array(z.string()).default([]),
        autoScroll: browserAutoScrollSchema,
        debug: z
          .object({
            enabled: z.boolean().default(true),
            captureScripts: z.boolean().default(true),
            captureNetwork: z.boolean().default(true),
            captureSourceMaps: z.boolean().default(true),
            captureHooks: z.boolean().default(true),
            maxScripts: z.number().int().positive().max(200).default(40),
            maxRequests: z.number().int().positive().max(300).default(80),
            maxSourceMaps: z.number().int().positive().max(200).default(40),
            maxHookEvents: z.number().int().positive().max(1000).default(200),
            maxScriptBytes: z.number().int().positive().max(2000000).default(200000),
            maxSourceMapBytes: z.number().int().positive().max(2000000).default(200000),
            maxRequestBodyBytes: z.number().int().positive().max(512000).default(8192),
            maxResponseBodyBytes: z.number().int().positive().max(512000).default(8192),
            maxHeaderEntries: z.number().int().positive().max(200).default(40),
            timeoutMs: z.number().int().positive().max(30000).default(5000),
            hookMode: z.enum(['strict', 'balanced']).default('strict'),
            persistArtifacts: z.boolean().default(true),
            previewItems: z.number().int().positive().max(50).default(5),
            previewBytes: z.number().int().positive().max(16384).default(1024),
            har: z
              .object({
                enabled: z.boolean().default(false),
                includeBodies: z.boolean().default(true),
              })
              .default({}),
            tracing: z
              .object({
                enabled: z.boolean().default(false),
                screenshots: z.boolean().default(true),
                snapshots: z.boolean().default(true),
                sources: z.boolean().default(false),
              })
              .default({}),
          })
          .default({}),
        replay: z
          .object({
            initScripts: z.array(z.string().min(1)).default([]),
            finalUrl: z.string().optional(),
            finalMethod: z.string().optional(),
            finalBody: z.string().optional(),
            storageSeeds: z.array(
              z.object({
                area: z.enum(['localStorage', 'sessionStorage']).default('localStorage'),
                key: z.string().min(1),
                value: z.string(),
              }).passthrough(),
            ).default([]),
            blockResourceTypes: z.array(
              z.enum(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'xhr', 'fetch', 'websocket', 'manifest', 'other']),
            ).default([]),
            blockUrlPatterns: z.array(z.string().min(1)).default([]),
            cookies: z.array(
              z.object({
                name: z.string().min(1),
                value: z.string(),
                domain: z.string().optional(),
                url: z.string().url().optional(),
                path: z.string().optional(),
                expires: z.number().optional(),
                httpOnly: z.boolean().optional(),
                secure: z.boolean().optional(),
                sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
              }).passthrough(),
            ).default([]),
            steps: z.array(
              z.object({
                type: z.enum(['navigate', 'waitForSelector', 'extractState', 'setHeader', 'click', 'type', 'press', 'select', 'scroll', 'waitForResponse', 'extractResponseBody', 'assert', 'branch', 'goto', 'wait']),
                label: z.string().optional(),
                url: z.string().optional(),
                target: z.string().optional(),
                waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).optional(),
                timeoutMs: z.number().int().positive().max(120000).optional(),
                durationMs: z.number().int().nonnegative().max(120000).optional(),
                selector: z.string().optional(),
                visible: z.boolean().optional(),
                shadowHostSelector: z.string().optional(),
                frameUrlPattern: z.string().optional(),
                frameSelector: z.string().optional(),
                waitForNavigation: z.boolean().optional(),
                button: z.enum(['left', 'right', 'middle']).optional(),
                clickCount: z.number().int().positive().max(10).optional(),
                delayMs: z.number().int().nonnegative().max(30000).optional(),
                clear: z.boolean().optional(),
                keyPress: z.string().optional(),
                optionLabel: z.string().optional(),
                optionIndex: z.number().int().nonnegative().max(1000).optional(),
                x: z.number().int().optional(),
                y: z.number().int().optional(),
                to: z.enum(['top', 'bottom']).optional(),
                repeat: z.number().int().positive().max(1000).optional(),
                retries: z.number().int().nonnegative().max(10).optional(),
                retryDelayMs: z.number().int().nonnegative().max(120000).optional(),
                onErrorGoto: z.string().optional(),
                errorSaveAs: z.string().optional(),
                source: z.enum(['cookie', 'localStorage', 'sessionStorage', 'text', 'html', 'attribute']).optional(),
                key: z.string().optional(),
                attribute: z.string().optional(),
                saveAs: z.string().optional(),
                name: z.string().optional(),
                value: z.string().optional(),
                state: z.string().optional(),
                equals: z.any().optional(),
                notEquals: z.any().optional(),
                exists: z.boolean().optional(),
                matches: z.string().optional(),
                message: z.string().optional(),
                urlPattern: z.string().optional(),
                method: z.string().optional(),
                status: z.number().int().min(100).max(599).optional(),
                resourceType: z.enum(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'xhr', 'fetch', 'websocket', 'manifest', 'other']).optional(),
                onMatchGoto: z.string().optional(),
                cases: z.array(z.object({
                  state: z.string().optional(),
                  equals: z.any().optional(),
                  notEquals: z.any().optional(),
                  exists: z.boolean().optional(),
                  matches: z.string().optional(),
                  goto: z.string(),
                }).passthrough()).optional(),
                defaultGoto: z.string().optional(),
                from: z.string().optional(),
                format: z.enum(['text', 'json']).optional(),
                path: z.string().optional(),
              }).passthrough(),
            ).default([]),
          })
          .default({}),
        pool: z
          .object({
            maxBrowsers: z.number().int().positive().max(20).default(2),
            closeIdleMs: z.number().int().positive().max(3600000).default(120000),
          })
          .default({}),
      })
      .default({}),
    session: z
      .object({
        enabled: z.boolean().default(false),
        id: z.string().optional(),
        scope: z.enum(['job', 'custom']).default('job'),
        persist: z.boolean().default(true),
        isolate: z.boolean().default(true),
        captureStorage: z.boolean().default(true),
        pool: z
          .object({
            enabled: z.boolean().default(false),
            id: z.string().optional(),
            maxSessions: z.number().int().positive().max(100).default(5),
            maxFailures: z.number().int().positive().max(20).default(2),
            retireAfterUses: z.number().int().positive().max(10000).default(50),
            bindProxy: z.boolean().default(true),
            strategy: z.enum(['leastUsed', 'roundRobin']).default('leastUsed'),
          })
          .default({}),
      })
      .default({}),
    proxy: z.preprocess(
      normalizeProxyInput,
      z
        .object({
          server: z.string().min(1),
          url: z.string().min(1).optional(),
          username: z.string().optional(),
          password: z.string().optional(),
          bypass: z.array(z.string()).default([]),
          label: z.string().optional(),
        })
        .passthrough()
        .transform(({ url, ...proxy }) => proxy)
        .optional(),
    ),
    proxyPool: z
      .object({
        enabled: z.boolean().default(false),
        strategy: z.enum(['roundRobin', 'stickySession', 'healthiest']).default('roundRobin'),
        stickyBySession: z.boolean().default(true),
        maxFailures: z.number().int().positive().max(20).default(2),
        cooldownMs: z.number().int().positive().max(3600000).default(30000),
        retryOnStatuses: z.array(z.number().int().min(100).max(599)).default([408, 429, 500, 502, 503, 504]),
        allowDirectFallback: z.boolean().default(false),
        servers: z.array(z.preprocess(normalizeProxyInput, proxyServerSchema)).default([]),
      })
      .default({}),
    rateLimiter: z.preprocess(normalizeRateLimiterInput, rateLimiterSchema.optional()),
      retry: z
        .object({
          attempts: z.number().int().positive().max(10).default(1),
          backoffMs: z.number().int().nonnegative().max(60000).default(0),
          strategy: z.enum(['fixed', 'exponential']).default('fixed'),
          maxBackoffMs: z.number().int().nonnegative().max(600000).default(60000),
          jitterRatio: z.number().min(0).max(1).default(0),
          respectRetryAfter: z.boolean().default(true),
          retryOnStatuses: z.array(z.number().int().min(100).max(599)).default([408, 429, 500, 502, 503, 504]),
          groupBackoff: z
            .object({
              enabled: z.boolean().default(false),
              groupBy: z.enum(['hostname', 'origin', 'registrableDomain']).optional(),
              baseDelayMs: z.number().int().nonnegative().max(3600000).default(5000),
              maxDelayMs: z.number().int().nonnegative().max(86400000).default(300000),
              multiplier: z.number().min(1).max(10).default(2),
              respectRetryAfter: z.boolean().default(true),
              resetOnSuccess: z.boolean().default(true),
              onNetworkError: z.boolean().default(true),
              statusCodes: z.array(z.number().int().min(100).max(599)).default([408, 429, 500, 502, 503, 504]),
            })
            .default({}),
        })
        .default({}),
    crawlPolicy: z
      .object({
        robotsTxt: z
          .object({
            enabled: z.boolean().default(false),
            userAgent: z.string().min(1).default('*'),
            respectCrawlDelay: z.boolean().default(true),
            seedSitemaps: z.boolean().default(true),
            allowOnError: z.boolean().default(true),
            timeoutMs: z.number().int().positive().max(120000).default(10000),
            maxCrawlDelayMs: z.number().int().positive().max(600000).default(30000),
            maxSitemaps: z.number().int().positive().max(100).default(10),
            maxUrlsPerSitemap: z.number().int().positive().max(10000).default(200),
          })
          .default({}),
      })
      .default({}),
    requestQueue: z
      .object({
        sortQueryParams: z.boolean().default(true),
        stripHash: z.boolean().default(true),
        stripTrailingSlash: z.boolean().default(false),
        dropQueryParams: z.array(z.string().min(1)).default(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'msclkid', 'yclid']),
        dropQueryParamPatterns: z.array(z.string().min(1)).default(['^utm_']),
        includeMethodInUniqueKey: z.boolean().default(false),
        includeBodyInUniqueKey: z.boolean().default(false),
        reclaimInProgress: z.boolean().default(true),
        hostAwareScheduling: z.boolean().default(true),
        groupBy: z.enum(['hostname', 'origin', 'registrableDomain']).default('hostname'),
        maxInProgressPerGroup: z.number().int().nonnegative().max(100).optional(),
        maxInProgressPerHost: z.number().int().nonnegative().max(100).default(1),
        budgetWindowMs: z.number().int().nonnegative().max(3600000).default(0),
        maxRequestsPerWindow: z.number().int().nonnegative().max(10000).default(0),
        seenSet: z
          .object({
            enabled: z.boolean().default(false),
            scope: z.enum(['workflow', 'custom']).default('workflow'),
            id: z.string().min(1).optional(),
          })
          .default({}),
        priority: z
          .object({
            seed: z.number().int().min(-1000).max(1000).default(100),
            sitemap: z.number().int().min(-1000).max(1000).default(80),
            discovery: z.number().int().min(-1000).max(1000).default(50),
            depthPenalty: z.number().int().nonnegative().max(1000).default(10),
          })
          .default({}),
      })
      .default({}),
    httpCache: z
      .object({
        enabled: z.boolean().default(false),
        storeId: z.string().min(1).optional(),
        shared: z.boolean().default(true),
        persistBody: z.boolean().default(true),
        reuseBodyOnNotModified: z.boolean().default(true),
        maxBodyBytes: z.number().int().positive().max(10_000_000).default(1_000_000),
      })
      .default({}),
    export: z
      .object({
        enabled: z.boolean().default(true),
        outputs: z.array(
          z.object({
            kind: z.enum(['results', 'events', 'summary']).default('results'),
            backend: z.enum(['file', 'stdout', 'http', 'postgres', 'mysql', 'mongodb', 'sink']).optional(),
            format: z.enum(['csv', 'json', 'jsonl', 'ndjson']).default('json'),
            path: z.string().optional(),
            method: z.enum(['POST', 'PUT']).optional(),
            headers: z.record(z.string()).optional(),
            timeoutMs: z.number().int().positive().max(120000).optional(),
            retryAttempts: z.number().int().nonnegative().max(10).optional(),
            retryBackoffMs: z.number().int().nonnegative().max(120000).optional(),
            table: z.string().optional(),
            database: z.string().optional(),
            collection: z.string().optional(),
            jsonColumn: z.string().optional(),
            metadataColumn: z.string().optional(),
            batchSize: z.number().int().positive().max(10000).optional(),
            ordered: z.boolean().optional(),
            signingSecret: z.string().optional(),
            signatureHeader: z.string().optional(),
            signatureAlgorithm: z.enum(['sha1', 'sha256', 'sha512']).optional(),
            flatten: z.boolean().optional(),
            columns: z.array(z.string()).optional(),
            indent: z.number().int().nonnegative().max(8).optional(),
            query: z.string().optional(),
            limit: z.number().int().positive().max(100000).optional(),
          }).passthrough(),
        ).default([]),
      })
      .default({}),
    autoscale: z
      .object({
        enabled: z.boolean().default(false),
        minConcurrency: z.number().int().positive().max(100).default(1),
        maxConcurrency: z.number().int().positive().max(100).optional(),
        scaleUpStep: z.number().int().positive().max(20).default(1),
        scaleDownStep: z.number().int().positive().max(20).default(1),
        targetLatencyMs: z.number().int().positive().max(120000).default(3000),
        maxFailureRate: z.number().min(0).max(1).default(0.2),
        sampleWindow: z.number().int().positive().max(500).default(20),
      })
      .default({}),
    quality: z
      .object({
        schema: z
          .object({
            required: z.array(z.string()).default([]),
            types: z.record(z.enum(['string', 'number', 'boolean', 'object', 'array', 'null'])).default({}),
          })
          .default({}),
        trend: z
          .object({
            windowSize: z.number().int().positive().max(50).default(5),
          })
          .default({}),
        alerting: z
          .object({
            webhook: z
              .object({
                enabled: z.boolean().default(false),
                url: z.string().url().optional(),
                headers: z.record(z.string()).default({}),
                minSeverity: z.enum(['info', 'warning', 'error', 'critical']).default('warning'),
                includeSummary: z.boolean().default(true),
                signingSecret: z.string().optional(),
                signatureHeader: z.string().default('x-omnicrawl-signature'),
                signatureAlgorithm: z.enum(['sha1', 'sha256', 'sha512']).default('sha256'),
                retryAttempts: z.number().int().nonnegative().max(10).default(2),
                retryBackoffMs: z.number().int().nonnegative().max(120000).default(1000),
                timeoutMs: z.number().int().positive().max(120000).default(10000),
              })
              .default({}),
          })
          .default({}),
      })
      .default({}),
    extract: z.array(extractorRuleSchema).default([]),
    discovery: z
      .object({
        enabled: z.boolean().default(false),
        maxPages: z.number().int().positive().max(500).default(25),
        maxLinksPerPage: z.number().int().positive().max(500).default(50),
        sameOriginOnly: z.boolean().default(true),
        respectNoFollow: z.boolean().default(false),
        skipFileExtensions: z.array(z.string().min(1)).default([]),
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
        strategy: z
          .object({
            classify: z.boolean().default(true),
            enqueuePagination: z.boolean().default(true),
            enqueueCanonical: z.boolean().default(false),
            enqueueAlternateLanguages: z.boolean().default(false),
            skipLogout: z.boolean().default(true),
            skipAssetLinks: z.boolean().default(true),
            lanes: z.record(
              z.object({
                maxInProgress: z.number().int().positive().max(100).optional(),
                budgetWindowMs: z.number().int().nonnegative().max(600000).optional(),
                maxRequestsPerWindow: z.number().int().positive().max(1000).optional(),
              }).passthrough(),
            ).default({}),
          })
          .default({}),
        rules: z.array(
          z.object({
            pattern: z.string().min(1),
            action: z.enum(['enqueue', 'skip']).default('enqueue'),
            priority: z.number().int().min(-1000).max(1000).optional(),
            label: z.string().min(1).optional(),
            userData: z.record(z.any()).default({}),
            metadata: z.record(z.any()).default({}),
          }).passthrough(),
        ).default([]),
        extractor: extractorRuleSchema.optional(),
      })
      .default({}),
    plugins: z.array(pluginSchema).default([{ name: 'dedupe' }, { name: 'audit' }]),
    output: z.preprocess(
      normalizeOutputInput,
      z
        .object({
          dir: z.string().default('runs'),
          directory: z.string().optional(),
          persistBodies: z.boolean().default(false),
          console: z.boolean().default(true),
        })
        .default({})
        .transform(({ directory, ...output }) => output),
    ),
    observability: observabilitySchema.optional(),
  })
  .passthrough();

export function validateWorkflow(input) {
  return workflowSchema.parse(input);
}
