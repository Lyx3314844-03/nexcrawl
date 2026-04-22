import { getLogger } from '../utils/logger.js';
import { Router } from '../api/router.js';

const logger = getLogger('mobile-crawler');
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

function ensureTrailingSlash(value) {
  return String(value).endsWith('/') ? String(value) : `${value}/`;
}

function normalizeCapabilities(device = {}) {
  return {
    platformName: device.platformName ?? 'Android',
    automationName: device.automationName ?? 'UiAutomator2',
    deviceName: device.deviceName ?? 'emulator-5554',
    ...device,
  };
}

function parseElementId(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value[W3C_ELEMENT_KEY] ?? value.ELEMENT ?? null;
}

function normalizeSelector(selector) {
  if (selector && typeof selector === 'object' && !Array.isArray(selector)) {
    if (selector.elementId) {
      return { elementId: selector.elementId };
    }
    if (selector[W3C_ELEMENT_KEY] || selector.ELEMENT) {
      return { elementId: parseElementId(selector) };
    }
    if (selector.using && selector.value !== undefined) {
      return {
        using: String(selector.using),
        value: String(selector.value),
      };
    }
  }

  if (typeof selector !== 'string') {
    throw new TypeError('selector must be a string or selector object');
  }

  if (selector.startsWith('//') || selector.startsWith('(')) {
    return { using: 'xpath', value: selector };
  }

  const shorthand = selector.match(/^(id|xpath|accessibility|accessibility id|css selector|class name|name|android|ios predicate|ios class chain)=(.+)$/i);
  if (shorthand) {
    const strategy = shorthand[1].toLowerCase();
    return {
      using:
        strategy === 'accessibility'
          ? 'accessibility id'
          : strategy === 'android'
            ? '-android uiautomator'
            : strategy === 'ios predicate'
              ? '-ios predicate string'
              : strategy === 'ios class chain'
                ? '-ios class chain'
                : strategy,
      value: shorthand[2],
    };
  }

  return {
    using: 'accessibility id',
    value: selector,
  };
}

function computeSwipePoints(direction, viewport = {}) {
  const width = Number(viewport.width ?? 1000);
  const height = Number(viewport.height ?? 1000);
  const centerX = Math.round(width / 2);
  const centerY = Math.round(height / 2);

  switch (direction) {
    case 'up':
      return { startX: centerX, startY: Math.round(height * 0.8), endX: centerX, endY: Math.round(height * 0.2) };
    case 'down':
      return { startX: centerX, startY: Math.round(height * 0.2), endX: centerX, endY: Math.round(height * 0.8) };
    case 'left':
      return { startX: Math.round(width * 0.8), startY: centerY, endX: Math.round(width * 0.2), endY: centerY };
    case 'right':
      return { startX: Math.round(width * 0.2), startY: centerY, endX: Math.round(width * 0.8), endY: centerY };
    default:
      throw new Error(`unsupported swipe direction: ${direction}`);
  }
}

function buildScreenQueueEntry(input, fallbackPath = '/') {
  if (typeof input === 'string') {
    return { path: input, label: null, metadata: {} };
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('screen entry must be a string or object');
  }

  return {
    path: input.path ?? fallbackPath,
    label: input.label ?? null,
    metadata: input.metadata ?? {},
  };
}

/**
 * Native Mobile App crawler with a minimal Appium execution layer.
 *
 * Supported today:
 * - W3C session create/delete
 * - page source capture
 * - element lookup
 * - click / type / swipe / back helpers
 * - screen queue routing using synthetic paths
 */
export class MobileCrawler {
  constructor(options = {}) {
    this.name = options.name || 'mobile-crawler';
    this.deviceConfig = normalizeCapabilities(options.device);
    this.appiumUrl = options.appiumUrl || 'http://localhost:4723/wd/hub';
    this.router = options.router || new Router();
    this.maxScreens = Number(options.maxScreens ?? 1);
    this.entryScreen = buildScreenQueueEntry(options.entryScreen ?? '/', '/');
    this.screenPathResolver = typeof options.screenPathResolver === 'function' ? options.screenPathResolver : null;
    this.viewport = {
      width: Number(options.viewport?.width ?? 1000),
      height: Number(options.viewport?.height ?? 1000),
    };
    this.waitBetweenScreensMs = Number(options.waitBetweenScreensMs ?? 0);
    this.session = null;
    this.state = {
      isAborted: false,
      processedPages: 0,
      items: [],
      interactions: 0,
      queue: [],
    };
  }

  async run() {
    logger.info(`Starting MobileCrawler: ${this.name}`, { device: this.deviceConfig.deviceName });

    try {
      await this._initSession();
      this.state.queue.push(this.entryScreen);

      while (!this.state.isAborted && this.state.queue.length > 0 && this.state.processedPages < this.maxScreens) {
        const screen = this.state.queue.shift();
        await this._processCurrentScreen(screen);
        if (this.waitBetweenScreensMs > 0 && !this.state.isAborted) {
          await new Promise((resolve) => setTimeout(resolve, this.waitBetweenScreensMs));
        }
      }

      return {
        status: this.state.isAborted ? 'aborted' : 'completed',
        pages: this.state.processedPages,
        items: [...this.state.items],
        interactions: this.state.interactions,
        sessionId: this.session?.id ?? null,
      };
    } catch (error) {
      logger.error('Mobile crawling failed', { error: error.message });
      throw error;
    } finally {
      await this._closeSession();
    }
  }

  stop() {
    this.state.isAborted = true;
    return this;
  }

  useRouter(router) {
    this.router = router;
    return this;
  }

  setEntryScreen(screen) {
    this.entryScreen = buildScreenQueueEntry(screen, '/');
    return this;
  }

  enqueueScreen(screen) {
    this.state.queue.push(buildScreenQueueEntry(screen, '/'));
    return this;
  }

  async _initSession() {
    logger.info('Connecting to device...', { url: this.appiumUrl });
    const payload = {
      capabilities: {
        alwaysMatch: this.deviceConfig,
        firstMatch: [{}],
      },
    };

    const response = await this._requestAppium('session', {
      method: 'POST',
      body: payload,
    });
    const value = response.value ?? {};
    const sessionId = response.sessionId ?? value.sessionId;

    if (!sessionId) {
      throw new Error('Appium session response did not include a session id');
    }

    this.session = {
      id: sessionId,
      capabilities: value.capabilities ?? value,
    };
  }

  async _processCurrentScreen(screenTask = this.entryScreen) {
    if (this.state.isAborted) {
      return;
    }

    const source = await this._getPageSource();
    const activity = await this._getCurrentActivity();
    const appPackage = await this._getCurrentPackage();
    const screen = {
      path: screenTask.path ?? this.entryScreen.path,
      label: screenTask.label ?? null,
      metadata: screenTask.metadata ?? {},
      activity,
      package: appPackage,
      source,
    };

    if (this.screenPathResolver) {
      const resolvedPath = await this.screenPathResolver(screen);
      if (resolvedPath) {
        screen.path = resolvedPath;
      }
    }

    const route = this.router.resolve(screen.path, screen.label);
    if (!route) {
      logger.warn('No mobile route matched current screen', { path: screen.path, label: screen.label });
      this.state.processedPages += 1;
      return;
    }

    const pushedItems = [];
    const ctx = {
      crawler: this,
      source,
      screen,
      session: this.session,
      params: route.params ?? {},
      label: route.label,
      pushData: async (data) => {
        this.state.items.push(data);
        pushedItems.push(data);
      },
      enqueueScreen: (next) => {
        this.enqueueScreen(next);
      },
      stop: () => {
        this.stop();
      },
      findElement: (selector) => this.findElement(selector),
      click: (selectorOrElement) => this.click(selectorOrElement),
      tap: (selectorOrElement) => this.click(selectorOrElement),
      type: (selectorOrElement, text, options = {}) => this.type(selectorOrElement, text, options),
      swipe: (directionOrOptions) => this.swipe(directionOrOptions),
      back: () => this.back(),
    };

    await route.handler(ctx);
    this.state.processedPages += 1;

    logger.info('Processed mobile screen', {
      path: screen.path,
      label: route.label,
      pushedItems: pushedItems.length,
    });
  }

  async findElement(selector) {
    const resolved = normalizeSelector(selector);
    if (resolved.elementId) {
      return {
        elementId: resolved.elementId,
        raw: { [W3C_ELEMENT_KEY]: resolved.elementId },
      };
    }

    const response = await this._requestAppium(`session/${this.session.id}/element`, {
      method: 'POST',
      body: {
        using: resolved.using,
        value: resolved.value,
      },
    });

    const elementId = parseElementId(response.value);
    if (!elementId) {
      throw new Error(`element not found for selector: ${resolved.value}`);
    }

    return {
      elementId,
      raw: response.value,
      selector: resolved,
    };
  }

  async click(selectorOrElement) {
    const element = await this.findElement(selectorOrElement);
    await this._requestAppium(`session/${this.session.id}/element/${element.elementId}/click`, {
      method: 'POST',
      body: {},
    });
    this.state.interactions += 1;
    return element;
  }

  async tap(selectorOrElement) {
    return this.click(selectorOrElement);
  }

  async type(selectorOrElement, text, options = {}) {
    const element = await this.findElement(selectorOrElement);
    const value = String(text ?? '');

    if (options.clearFirst) {
      await this._requestAppium(`session/${this.session.id}/element/${element.elementId}/clear`, {
        method: 'POST',
        body: {},
      });
    }

    await this._requestAppium(`session/${this.session.id}/element/${element.elementId}/value`, {
      method: 'POST',
      body: {
        text: value,
        value: [...value],
      },
    });
    this.state.interactions += 1;
    return element;
  }

  async swipe(directionOrOptions = 'up') {
    const points =
      typeof directionOrOptions === 'string'
        ? computeSwipePoints(directionOrOptions, this.viewport)
        : directionOrOptions;

    await this._requestAppium(`session/${this.session.id}/actions`, {
      method: 'POST',
      body: {
        actions: [
          {
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: points.startX, y: points.startY },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: Number(points.holdMs ?? 120) },
              { type: 'pointerMove', duration: Number(points.durationMs ?? 400), x: points.endX, y: points.endY },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
    });
    this.state.interactions += 1;
  }

  async back() {
    await this._requestAppium(`session/${this.session.id}/back`, {
      method: 'POST',
      body: {},
    });
    this.state.interactions += 1;
  }

  async _getPageSource() {
    const getResponse = await this._requestAppium(`session/${this.session.id}/source`, {
      method: 'GET',
      allowHttpErrors: [404, 405],
      rawResponse: true,
    });

    if (!getResponse.ok && (getResponse.status === 404 || getResponse.status === 405)) {
      const postFallback = await this._requestAppium(`session/${this.session.id}/source`, {
        method: 'POST',
        body: {},
      });
      return String(postFallback.value ?? '');
    }

    return String(getResponse.data?.value ?? '');
  }

  async _getCurrentActivity() {
    try {
      const response = await this._requestAppium(`session/${this.session.id}/appium/device/current_activity`, {
        method: 'GET',
      });
      return response.value ?? null;
    } catch {
      return null;
    }
  }

  async _getCurrentPackage() {
    try {
      const response = await this._requestAppium(`session/${this.session.id}/appium/device/current_package`, {
        method: 'GET',
      });
      return response.value ?? null;
    } catch {
      return null;
    }
  }

  async _closeSession() {
    if (!this.session?.id) {
      this.session = null;
      return;
    }

    try {
      await this._requestAppium(`session/${this.session.id}`, {
        method: 'DELETE',
        body: {},
      });
      logger.info('Closing device session', { sessionId: this.session.id });
    } catch (error) {
      logger.warn('Failed to close Appium session cleanly', {
        sessionId: this.session.id,
        error: error.message,
      });
    } finally {
      this.session = null;
    }
  }

  buildAppiumUrl(path) {
    return new URL(String(path).replace(/^\/+/, ''), ensureTrailingSlash(this.appiumUrl)).toString();
  }

  async _requestAppium(path, options = {}) {
    const method = options.method ?? 'GET';
    const headers = {
      accept: 'application/json',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    };

    const response = await fetch(this.buildAppiumUrl(path), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(Number(options.timeoutMs ?? 30000)),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (options.rawResponse) {
      return {
        ok: response.ok,
        status: response.status,
        data,
      };
    }

    if (!response.ok && !(options.allowHttpErrors ?? []).includes(response.status)) {
      throw new Error(data?.value?.message ?? data?.message ?? `Appium request failed with status ${response.status}`);
    }

    return data;
  }
}
