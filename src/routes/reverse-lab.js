function getObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function getString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function getBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function getNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function register(app, { method = 'get', path, handler }) {
  app[method](path, async (req, res, next) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      next(error);
    }
  });
}

export function registerReverseLabRoutes(app, manager) {
  register(app, {
    path: '/reverse/lab/pages',
    handler: async () => manager.listPages(),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/pages/new',
    handler: async (req) => manager.newPage({
      url: req.body?.url,
      browserConfig: getObject(req.body?.browserConfig),
      session: getObject(req.body?.session, null),
      proxy: getObject(req.body?.proxy, null),
      setSelected: req.body?.setSelected !== false,
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/pages/select',
    handler: async (req) => manager.selectPage(getString(req.body?.pageId)),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/pages/close',
    handler: async (req) => manager.closePage(getString(req.body?.pageId)),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/recorder/start',
    handler: async (req) => manager.startRecorder({
      pageId: getString(req.body?.pageId) || undefined,
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/recorder/stop',
    handler: async (req) => manager.stopRecorder({
      pageId: getString(req.body?.pageId) || undefined,
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/recorder/clear',
    handler: async (req) => manager.clearRecorder({
      pageId: getString(req.body?.pageId) || undefined,
    }),
  });

  register(app, {
    path: '/reverse/lab/recorder',
    handler: async (req) => manager.getRecorder({
      pageId: getString(req.query.pageId) || undefined,
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/recorder/click',
    handler: async (req) => manager.recorderClick({
      pageId: getString(req.body?.pageId) || undefined,
      selector: getString(req.body?.selector),
      waitForNavigation: getBoolean(req.body?.waitForNavigation, false),
      button: getString(req.body?.button, 'left'),
      clickCount: getNumber(req.body?.clickCount, 1),
      delayMs: getNumber(req.body?.delayMs, undefined),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/recorder/type',
    handler: async (req) => manager.recorderType({
      pageId: getString(req.body?.pageId) || undefined,
      selector: getString(req.body?.selector),
      value: req.body?.value,
      clear: req.body?.clear === undefined ? true : getBoolean(req.body?.clear, true),
      delayMs: getNumber(req.body?.delayMs, 50),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/recorder/wait',
    handler: async (req) => manager.recorderWaitForSelector({
      pageId: getString(req.body?.pageId) || undefined,
      selector: getString(req.body?.selector),
      visible: getBoolean(req.body?.visible, false),
      timeoutMs: getNumber(req.body?.timeoutMs, undefined),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/navigate',
    handler: async (req) => manager.navigatePage({
      pageId: getString(req.body?.pageId) || undefined,
      action: getString(req.body?.action, 'goto'),
      url: req.body?.url,
      waitUntil: req.body?.waitUntil,
      timeoutMs: getNumber(req.body?.timeoutMs, undefined),
    }),
  });

  register(app, {
    path: '/reverse/lab/frames',
    handler: async (req) => manager.listFrames(getString(req.query.pageId) || undefined),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/frames/select',
    handler: async (req) => manager.selectFrame({
      pageId: getString(req.body?.pageId) || undefined,
      frameId: getString(req.body?.frameId),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/screenshot',
    handler: async (req) => manager.takeScreenshot({
      pageId: getString(req.body?.pageId) || undefined,
      path: req.body?.path,
      fullPage: getBoolean(req.body?.fullPage, true),
    }),
  });

  register(app, {
    path: '/reverse/lab/scripts',
    handler: async (req) => manager.listScripts(getString(req.query.pageId) || undefined),
  });

  register(app, {
    path: '/reverse/lab/scripts/:scriptId/source',
    handler: async (req) => manager.getScriptSource({
      pageId: getString(req.query.pageId) || undefined,
      scriptId: req.params.scriptId,
      startLine: getNumber(req.query.startLine, undefined),
      endLine: getNumber(req.query.endLine, undefined),
      startOffset: getNumber(req.query.startOffset, undefined),
      endOffset: getNumber(req.query.endOffset, undefined),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/scripts/:scriptId/save',
    handler: async (req) => manager.saveScriptSource({
      pageId: getString(req.body?.pageId) || undefined,
      scriptId: req.params.scriptId,
      path: getString(req.body?.path),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/scripts/search',
    handler: async (req) => manager.searchInSources({
      pageId: getString(req.body?.pageId) || undefined,
      query: getString(req.body?.query),
      isRegex: getBoolean(req.body?.isRegex, false),
      limit: getNumber(req.body?.limit, 50),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/breakpoints/text',
    handler: async (req) => manager.setBreakpointOnText({
      pageId: getString(req.body?.pageId) || undefined,
      query: getString(req.body?.query),
      isRegex: getBoolean(req.body?.isRegex, false),
      condition: getString(req.body?.condition),
      occurrenceIndex: getNumber(req.body?.occurrenceIndex, 0),
      scriptId: req.body?.scriptId,
      mode: getString(req.body?.mode, 'breakpoint'),
      logExpression: getString(req.body?.logExpression),
      autoResume: req.body?.autoResume === undefined ? undefined : getBoolean(req.body?.autoResume, false),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/breakpoints/location',
    handler: async (req) => manager.setBreakpointByLocation({
      pageId: getString(req.body?.pageId) || undefined,
      url: getString(req.body?.url),
      lineNumber: getNumber(req.body?.lineNumber, undefined),
      columnNumber: getNumber(req.body?.columnNumber, 0),
      condition: getString(req.body?.condition),
      isRegex: getBoolean(req.body?.isRegex, false),
      mode: getString(req.body?.mode, 'breakpoint'),
      logExpression: getString(req.body?.logExpression),
      autoResume: req.body?.autoResume === undefined ? undefined : getBoolean(req.body?.autoResume, false),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/breakpoints/request',
    handler: async (req) => manager.breakOnRequest({
      pageId: getString(req.body?.pageId) || undefined,
      pattern: getString(req.body?.pattern),
      isRegex: getBoolean(req.body?.isRegex, false),
    }),
  });

  register(app, {
    path: '/reverse/lab/breakpoints',
    handler: async (req) => manager.listBreakpoints(getString(req.query.pageId) || undefined),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/breakpoints/remove',
    handler: async (req) => manager.removeBreakpoint({
      pageId: getString(req.body?.pageId) || undefined,
      breakpointId: req.body?.breakpointId,
      removeAll: req.body?.all === true,
    }),
  });

  register(app, {
    path: '/reverse/lab/paused',
    handler: async (req) => manager.getPausedInfo(getString(req.query.pageId) || undefined),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/execution/pause',
    handler: async (req) => manager.pause(getString(req.body?.pageId) || undefined),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/execution/resume',
    handler: async (req) => manager.resume(getString(req.body?.pageId) || undefined),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/execution/step',
    handler: async (req) => manager.step({
      pageId: getString(req.body?.pageId) || undefined,
      action: getString(req.body?.action, 'over'),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/evaluate',
    handler: async (req) => manager.evaluate({
      pageId: getString(req.body?.pageId) || undefined,
      expression: getString(req.body?.expression),
      frameId: req.body?.frameId,
      context: getString(req.body?.context, 'main'),
      callFrameIndex: getNumber(req.body?.callFrameIndex, 0),
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/trace-function',
    handler: async (req) => manager.traceFunction({
      pageId: getString(req.body?.pageId) || undefined,
      expression: getString(req.body?.expression),
      autoResume: req.body?.autoResume !== false,
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/trace-text',
    handler: async (req) => manager.traceByText({
      pageId: getString(req.body?.pageId) || undefined,
      query: getString(req.body?.query),
      isRegex: getBoolean(req.body?.isRegex, false),
      occurrenceIndex: getNumber(req.body?.occurrenceIndex, 0),
      scriptId: req.body?.scriptId,
      logExpression: getString(req.body?.logExpression),
      strategy: getString(req.body?.strategy, 'hybrid'),
      targetExpression: getString(req.body?.targetExpression) || undefined,
    }),
  });

  register(app, {
    path: '/reverse/lab/traces',
    handler: async (req) => manager.listTraceEvents(getString(req.query.pageId) || undefined),
  });

  register(app, {
    path: '/reverse/lab/injections',
    handler: async (req) => manager.listInjections(getString(req.query.pageId) || undefined),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/inject-before-load',
    handler: async (req) => manager.injectBeforeLoad({
      pageId: getString(req.body?.pageId) || undefined,
      script: getString(req.body?.script),
      id: req.body?.id,
      applyNow: req.body?.applyNow !== false,
      remove: req.body?.remove === true,
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/injections/remove',
    handler: async (req) => manager.removeInjection({
      pageId: getString(req.body?.pageId) || undefined,
      injectionId: getString(req.body?.injectionId) || undefined,
      removeAll: req.body?.all === true,
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/workflow/trace-request-initiator',
    handler: async (req) => manager.runTraceWorkflow({
      pageId: getString(req.body?.pageId) || undefined,
      url: getString(req.body?.url) || undefined,
      browserConfig: getObject(req.body?.browserConfig),
      session: getObject(req.body?.session, null),
      proxy: getObject(req.body?.proxy, null),
      setSelected: req.body?.setSelected !== false,
      searchQuery: getString(req.body?.searchQuery),
      searchIsRegex: getBoolean(req.body?.searchIsRegex, false),
      searchLimit: getNumber(req.body?.searchLimit, 10),
      traceQuery: getString(req.body?.traceQuery) || undefined,
      traceIsRegex: getBoolean(req.body?.traceIsRegex, false),
      traceOccurrenceIndex: getNumber(req.body?.traceOccurrenceIndex, 0),
      traceScriptId: getString(req.body?.traceScriptId) || undefined,
      traceLogExpression: getString(req.body?.traceLogExpression),
      actionExpression: getString(req.body?.actionExpression) || undefined,
      requestPattern: getString(req.body?.requestPattern) || undefined,
      requestIsRegex: getBoolean(req.body?.requestIsRegex, false),
      waitTimeoutMs: getNumber(req.body?.waitTimeoutMs, 5000),
      pollIntervalMs: getNumber(req.body?.pollIntervalMs, 100),
    }),
  });

  register(app, {
    path: '/reverse/lab/network',
    handler: async (req) => manager.listNetworkRequests(
      getString(req.query.pageId) || undefined,
      getString(req.query.requestId) || null,
    ),
  });

  register(app, {
    path: '/reverse/lab/network/:requestId/initiator',
    handler: async (req) => manager.getRequestInitiator({
      pageId: getString(req.query.pageId) || undefined,
      requestId: req.params.requestId,
    }),
  });

  register(app, {
    method: 'post',
    path: '/reverse/lab/network/:requestId/decode',
    handler: async (req) => manager.decodeNetworkPayload({
      pageId: getString(req.body?.pageId) || undefined,
      requestId: req.params.requestId,
      source: getString(req.body?.source, 'responseBody'),
      protocol: getString(req.body?.protocol, 'protobuf'),
      descriptorPaths: Array.isArray(req.body?.descriptorPaths) ? req.body.descriptorPaths : [],
      messageType: getString(req.body?.messageType) || null,
      path: getString(req.body?.path),
      direction: getString(req.body?.direction, 'request'),
      maxDepth: getNumber(req.body?.maxDepth, 2),
    }),
  });

  register(app, {
    path: '/reverse/lab/websockets',
    handler: async (req) => manager.getWebSocketMessages({
      pageId: getString(req.query.pageId) || undefined,
      connectionId: getString(req.query.connectionId) || null,
    }),
  });

  register(app, {
    path: '/reverse/lab/console',
    handler: async (req) => manager.listConsoleMessages({
      pageId: getString(req.query.pageId) || undefined,
      messageId: getString(req.query.messageId) || null,
    }),
  });
}
