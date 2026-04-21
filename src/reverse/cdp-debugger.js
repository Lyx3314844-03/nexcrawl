import CDP from 'chrome-remote-interface';

function toRegExpPatterns(patterns = []) {
  return patterns
    .filter(Boolean)
    .map((value) => String(value))
    .map((value) => new RegExp(value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')));
}

export class ReverseCdpDebugger {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.interceptedRequests = [];
    this.requestPatterns = [];
  }

  async connect({ host = '127.0.0.1', port = 9222, target } = {}) {
    try {
      const selectedTarget = target ?? (await this.#pickDefaultTarget({ host, port }));
      this.client = await CDP({ host, port, target: selectedTarget });
      this.isConnected = true;
      this.interceptedRequests = [];
      this.requestPatterns = [];

      const { Network, Page } = this.client;
      await Network.enable();
      await Page.enable();

      Network.requestWillBeSent((event) => {
        if (this.requestPatterns.length > 0 && !this.requestPatterns.some((pattern) => pattern.test(event.request.url))) {
          return;
        }

        this.interceptedRequests.push({
          requestId: event.requestId,
          url: event.request.url,
          method: event.request.method,
          headers: event.request.headers,
          postData: event.request.postData ?? null,
          timestamp: Date.now(),
        });

        if (this.interceptedRequests.length > 2000) {
          this.interceptedRequests.shift();
        }
      });

      return {
        success: true,
        message: 'Connected to Chrome DevTools',
        target: selectedTarget,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to connect: ${error?.message ?? String(error)}`,
      };
    }
  }

  async disconnect() {
    if (!this.client) return;
    await this.client.close();
    this.client = null;
    this.isConnected = false;
  }

  async interceptNetworkRequests(patterns = []) {
    if (!this.client || !this.isConnected) {
      return {
        success: false,
        error: 'Not connected to Chrome',
      };
    }

    this.interceptedRequests = [];
    this.requestPatterns = toRegExpPatterns(patterns);

    return {
      success: true,
      message: `Recording requests matching: ${patterns.length > 0 ? patterns.join(', ') : 'all'}`,
      count: this.interceptedRequests.length,
    };
  }

  getInterceptedRequests() {
    return {
      success: true,
      data: {
        requests: this.interceptedRequests,
        count: this.interceptedRequests.length,
      },
    };
  }

  async evaluateJavaScript(expression) {
    if (!this.client || !this.isConnected) {
      return {
        success: false,
        error: 'Not connected to Chrome',
      };
    }

    try {
      const { Runtime } = this.client;
      const result = await Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return {
        success: true,
        data: {
          result: result.result,
          exceptionDetails: result.exceptionDetails ?? null,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message ?? String(error),
      };
    }
  }

  async setBreakpoint(url, lineNumber, condition = '') {
    if (!this.client || !this.isConnected) {
      return {
        success: false,
        error: 'Not connected to Chrome',
      };
    }

    try {
      const { Debugger } = this.client;
      await Debugger.enable();
      const result = await Debugger.setBreakpointByUrl({
        url,
        lineNumber: Math.max(0, Number(lineNumber) - 1),
        condition,
      });
      return {
        success: true,
        data: {
          breakpointId: result.breakpointId,
          locations: result.locations ?? [],
          url,
          lineNumber,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message ?? String(error),
      };
    }
  }

  async navigateTo(url) {
    if (!this.client || !this.isConnected) {
      return {
        success: false,
        error: 'Not connected to Chrome',
      };
    }

    try {
      const { Page } = this.client;
      const loaded = new Promise((resolve) => {
        Page.loadEventFired(resolve);
      });
      await Page.navigate({ url });
      await loaded;
      return {
        success: true,
        message: `Navigated to ${url}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message ?? String(error),
      };
    }
  }

  async getCookies(urls = []) {
    if (!this.client || !this.isConnected) {
      return {
        success: false,
        error: 'Not connected to Chrome',
      };
    }

    try {
      const { Network } = this.client;
      const result = await Network.getCookies(urls.length > 0 ? { urls } : {});
      return {
        success: true,
        data: {
          cookies: result.cookies,
          count: result.cookies.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message ?? String(error),
      };
    }
  }

  async #pickDefaultTarget({ host, port }) {
    const targets = await CDP.List({ host, port });
    return targets.find((item) => item.type === 'page') ?? targets[0];
  }
}
