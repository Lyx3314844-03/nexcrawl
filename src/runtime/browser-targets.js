import { EventEmitter } from 'node:events';

function safeJsonParse(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function supportsListenerApi(target) {
  return target && typeof target.on === 'function' && typeof target.off === 'function';
}

export async function createBrowserRootCdpSession(browser) {
  if (!browser) {
    return null;
  }

  if (typeof browser.newBrowserCDPSession === 'function') {
    return browser.newBrowserCDPSession();
  }

  const browserTarget = typeof browser.target === 'function' ? browser.target() : null;
  if (browserTarget && typeof browserTarget.createCDPSession === 'function') {
    return browserTarget.createCDPSession();
  }

  return null;
}

class RoutedTargetSession extends EventEmitter {
  #closed = false;
  #messageId = 0;
  #pending = new Map();

  constructor(rootSession, sessionId, targetInfo) {
    super();
    this.rootSession = rootSession;
    this.sessionId = sessionId;
    this.targetInfo = { ...targetInfo };
  }

  async send(method, params = {}) {
    if (this.#closed) {
      throw new Error(`target session closed: ${this.targetInfo.type}:${this.targetInfo.targetId}`);
    }

    const id = ++this.#messageId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.rootSession.send('Target.sendMessageToTarget', {
        sessionId: this.sessionId,
        message: JSON.stringify({ id, method, params }),
      }).catch((error) => {
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  updateTargetInfo(nextTargetInfo = {}) {
    this.targetInfo = {
      ...this.targetInfo,
      ...nextTargetInfo,
    };
  }

  handleProtocolMessage(message) {
    const payload = safeJsonParse(message);
    if (!payload) {
      return;
    }

    if (payload.id) {
      const pending = this.#pending.get(payload.id);
      if (!pending) {
        return;
      }

      this.#pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message ?? 'target session command failed'));
      } else {
        pending.resolve(payload.result ?? {});
      }
      return;
    }

    if (payload.method) {
      this.emit(payload.method, payload.params ?? {});
    }
  }

  close(reason = 'detached') {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    for (const { reject } of this.#pending.values()) {
      reject(new Error(`target session closed: ${reason}`));
    }
    this.#pending.clear();
    this.emit('detached', { reason, targetInfo: this.targetInfo });
    this.removeAllListeners();
  }

  async detach() {
    if (this.#closed) {
      return;
    }

    await this.rootSession.send('Target.detachFromTarget', {
      sessionId: this.sessionId,
    }).catch(() => {});
    this.close('manual-detach');
  }
}

export async function attachBrowserTargetSessions(
  browser,
  {
    targetTypes = ['worker', 'service_worker', 'shared_worker'],
    onAttached = null,
    onDetached = null,
    waitForDebuggerOnStart = true,
  } = {},
) {
  const rootSession = await createBrowserRootCdpSession(browser);
  if (!rootSession || !supportsListenerApi(rootSession)) {
    return null;
  }

  const allowedTargetTypes = new Set(targetTypes);
  const sessionsByTargetId = new Map();
  const sessionsBySessionId = new Map();
  const pendingTargetIds = new Set();

  const ensureAttached = async (targetInfo = {}) => {
    const targetId = targetInfo.targetId;
    if (!targetId || !allowedTargetTypes.has(targetInfo.type)) {
      return;
    }
    if (sessionsByTargetId.has(targetId) || pendingTargetIds.has(targetId)) {
      return;
    }

    pendingTargetIds.add(targetId);
    try {
      await rootSession.send('Target.attachToTarget', {
        targetId,
        flatten: false,
      });
    } catch {
      // Best-effort worker target capture should not break the browser session.
    } finally {
      pendingTargetIds.delete(targetId);
    }
  };

  const handleAttachedToTarget = (event = {}) => {
    const { sessionId, targetInfo = {} } = event;
    if (!sessionId || !targetInfo.targetId || !allowedTargetTypes.has(targetInfo.type)) {
      if (sessionId) {
        void rootSession.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      return;
    }

    const existing = sessionsByTargetId.get(targetInfo.targetId);
    if (existing) {
      existing.updateTargetInfo(targetInfo);
      sessionsBySessionId.set(sessionId, existing);
      return;
    }

    const session = new RoutedTargetSession(rootSession, sessionId, targetInfo);
    sessionsByTargetId.set(targetInfo.targetId, session);
    sessionsBySessionId.set(sessionId, session);
    const attached = typeof onAttached === 'function'
      ? Promise.resolve(onAttached(session, targetInfo))
      : Promise.resolve();
    void attached.finally(() => {
      if (waitForDebuggerOnStart) {
        void session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
      }
    });
  };

  const handleReceivedMessage = (event = {}) => {
    const session = sessionsBySessionId.get(event.sessionId);
    if (!session) {
      return;
    }
    session.handleProtocolMessage(event.message);
  };

  const handleDetachedFromTarget = (event = {}) => {
    const session = sessionsBySessionId.get(event.sessionId);
    if (!session) {
      return;
    }

    sessionsBySessionId.delete(event.sessionId);
    sessionsByTargetId.delete(session.targetInfo.targetId);
    session.close('target-detached');
    if (typeof onDetached === 'function') {
      void onDetached(session, session.targetInfo);
    }
  };

  const handleTargetCreated = (event = {}) => {
    void ensureAttached(event.targetInfo ?? {});
  };

  const handleTargetInfoChanged = (event = {}) => {
    const targetInfo = event.targetInfo ?? {};
    if (!targetInfo.targetId) {
      return;
    }

    const existing = sessionsByTargetId.get(targetInfo.targetId);
    if (existing) {
      existing.updateTargetInfo(targetInfo);
      existing.emit('Target.targetInfoChanged', targetInfo);
      return;
    }

    void ensureAttached(targetInfo);
  };

  rootSession.on('Target.attachedToTarget', handleAttachedToTarget);
  rootSession.on('Target.receivedMessageFromTarget', handleReceivedMessage);
  rootSession.on('Target.detachedFromTarget', handleDetachedFromTarget);
  rootSession.on('Target.targetCreated', handleTargetCreated);
  rootSession.on('Target.targetInfoChanged', handleTargetInfoChanged);

  await rootSession.send('Target.setDiscoverTargets', {
    discover: true,
  }).catch(() => {});
  await rootSession.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart,
    flatten: false,
  }).catch(() => {});

  const { targetInfos = [] } = await rootSession.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
  for (const targetInfo of targetInfos) {
    await ensureAttached(targetInfo);
  }

  return {
    rootSession,
    hasEventedTargets: true,
    targetTypes: [...allowedTargetTypes],
    get sessions() {
      return [...sessionsByTargetId.values()];
    },
    async dispose() {
      rootSession.off('Target.attachedToTarget', handleAttachedToTarget);
      rootSession.off('Target.receivedMessageFromTarget', handleReceivedMessage);
      rootSession.off('Target.detachedFromTarget', handleDetachedFromTarget);
      rootSession.off('Target.targetCreated', handleTargetCreated);
      rootSession.off('Target.targetInfoChanged', handleTargetInfoChanged);

      for (const session of [...sessionsByTargetId.values()]) {
        await session.detach().catch(() => {});
      }
      sessionsByTargetId.clear();
      sessionsBySessionId.clear();

      await rootSession.send('Target.setDiscoverTargets', {
        discover: false,
      }).catch(() => {});
      await rootSession.send('Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: false,
      }).catch(() => {});
      await rootSession.detach?.().catch(() => {});
    },
  };
}
