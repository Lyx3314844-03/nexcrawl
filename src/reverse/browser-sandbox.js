/**
 * BrowserSandbox — a full browser-like execution environment for reverse engineering.
 *
 * Provides:
 *   - Complete window/document/navigator/location globals via jsdom
 *   - fetch() and XMLHttpRequest interception (captures outbound requests)
 *   - localStorage / sessionStorage / cookie simulation
 *   - Controllable Date.now() / performance.now() (freeze or advance time)
 *   - Console capture
 *   - Timeout/interval execution (synchronous, safe)
 *
 * Use this when a signature function depends on DOM APIs, storage, or network calls.
 *
 * Usage:
 *   const sb = new BrowserSandbox({ url: 'https://example.com', freezeTime: Date.now() });
 *   await sb.run(jsCode);
 *   const result = await sb.call('sign', ['/api/data', 'body']);
 *   console.log(sb.capturedRequests); // all fetch/XHR calls made during execution
 */

import vm from 'node:vm';
import { JSDOM } from 'jsdom';

export class BrowserSandbox {
  /**
   * @param {Object} [options]
   * @param {string} [options.url='https://example.com'] - Page URL for location/document.domain
   * @param {number|null} [options.freezeTime=null] - Freeze Date.now() at this ms value (null = real time)
   * @param {Object} [options.cookies={}] - Initial cookie key-value pairs
   * @param {Object} [options.localStorage={}] - Initial localStorage entries
   * @param {Object} [options.env={}] - Extra globals
   * @param {number} [options.vmTimeoutMs=10000]
   * @param {boolean} [options.interceptNetwork=true] - Capture fetch/XHR calls
   */
  constructor(options = {}) {
    this.options = {
      url: 'https://example.com',
      freezeTime: null,
      cookies: {},
      localStorage: {},
      env: {},
      vmTimeoutMs: 10000,
      interceptNetwork: true,
      ...options,
    };
    this.capturedRequests = [];
    this._logs = [];
    this._context = null;
  }

  /** Build the sandbox context. Must be called before run()/call(). */
  async build() {
    const opts = this.options;
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: opts.url,
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    const win = dom.window;

    // ── Storage ──────────────────────────────────────────────────────────────
    const makeStorage = (initial = {}) => {
      const store = { ...initial };
      return {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
        clear: () => { for (const k of Object.keys(store)) delete store[k]; },
        key: (i) => Object.keys(store)[i] ?? null,
        get length() { return Object.keys(store).length; },
        _store: store,
      };
    };

    const localStorageImpl = makeStorage(opts.localStorage);
    const sessionStorageImpl = makeStorage();

    // ── Cookie ───────────────────────────────────────────────────────────────
    const cookieStore = { ...opts.cookies };
    const cookieDescriptor = {
      get: () => Object.entries(cookieStore).map(([k, v]) => `${k}=${v}`).join('; '),
      set: (val) => {
        const [pair] = String(val).split(';');
        const [k, v] = pair.split('=');
        if (k) cookieStore[k.trim()] = (v ?? '').trim();
      },
      configurable: true,
    };

    // ── Time control ─────────────────────────────────────────────────────────
    const frozenTime = opts.freezeTime;
    const FakeDate = frozenTime != null ? class FakeDate extends Date {
      constructor(...args) { super(args.length ? args[0] : frozenTime); }
      static now() { return frozenTime; }
      static parse(...a) { return Date.parse(...a); }
    } : Date;

    const perfNow = frozenTime != null ? () => 0 : () => performance.now();

    // ── Network interception ─────────────────────────────────────────────────
    const captured = this.capturedRequests;
    const interceptNetwork = opts.interceptNetwork;

    const fakeFetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      const method = init.method ?? 'GET';
      const headers = init.headers ?? {};
      const body = init.body ?? null;
      if (interceptNetwork) {
        captured.push({ type: 'fetch', url, method, headers, body, capturedAt: Date.now() });
      }
      // Return a minimal mock response
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: { get: () => null, has: () => false },
        json: async () => ({}),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
        clone() { return this; },
      };
    };

    const FakeXHR = class FakeXMLHttpRequest {
      constructor() {
        this.readyState = 0; this.status = 200; this.statusText = 'OK';
        this.responseText = ''; this.response = ''; this.responseType = '';
        this._method = ''; this._url = ''; this._headers = {};
        this.onreadystatechange = null; this.onload = null; this.onerror = null;
      }
      open(method, url) { this._method = method; this._url = url; this.readyState = 1; }
      setRequestHeader(k, v) { this._headers[k] = v; }
      send(body) {
        if (interceptNetwork) {
          captured.push({ type: 'xhr', url: this._url, method: this._method, headers: this._headers, body: body ?? null, capturedAt: Date.now() });
        }
        this.readyState = 4; this.status = 200;
        if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
        if (typeof this.onload === 'function') this.onload();
      }
      getAllResponseHeaders() { return ''; }
      getResponseHeader() { return null; }
      abort() {}
    };

    // ── Console ──────────────────────────────────────────────────────────────
    const logs = this._logs;
    const fakeConsole = {
      log: (...a) => logs.push({ level: 'log', args: a }),
      warn: (...a) => logs.push({ level: 'warn', args: a }),
      error: (...a) => logs.push({ level: 'error', args: a }),
      info: (...a) => logs.push({ level: 'info', args: a }),
      debug: (...a) => logs.push({ level: 'debug', args: a }),
    };

    // ── Timers (synchronous safe execution) ──────────────────────────────────
    const pendingTimers = [];
    const fakeSetTimeout = (fn, _ms, ...args) => {
      const id = pendingTimers.length;
      pendingTimers.push({ fn, args });
      return id;
    };
    const fakeClearTimeout = (id) => { if (pendingTimers[id]) pendingTimers[id] = null; };

    // ── Build context ─────────────────────────────────────────────────────────
    const ctx = vm.createContext({
      // Core browser globals
      window: undefined, // set below after context creation
      document: win.document,
      navigator: win.navigator,
      location: win.location,
      history: win.history,
      screen: win.screen,
      performance: { now: perfNow, timing: { navigationStart: frozenTime ?? Date.now() } },
      Date: FakeDate,
      // Storage
      localStorage: localStorageImpl,
      sessionStorage: sessionStorageImpl,
      // Network
      fetch: fakeFetch,
      XMLHttpRequest: FakeXHR,
      // Encoding
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      TextEncoder: win.TextEncoder,
      TextDecoder: win.TextDecoder,
      // Crypto
      crypto: win.crypto,
      // Timers
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      setInterval: () => 0,
      clearInterval: () => {},
      requestAnimationFrame: (fn) => { fakeSetTimeout(fn, 0); return 0; },
      // Console
      console: fakeConsole,
      // Node compat
      Buffer,
      process: { env: {}, version: 'v20.0.0', platform: 'linux' },
      // Misc
      Math, JSON, String, Number, Boolean, Array, Object, Symbol, Promise,
      Error, TypeError, RangeError, SyntaxError,
      parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      encodeURI, decodeURI,
      // User extras
      ...opts.env,
    });

    // Self-reference
    ctx.window = ctx;
    ctx.self = ctx;
    ctx.globalThis = ctx;

    // Patch document.cookie
    try {
      Object.defineProperty(ctx.document, 'cookie', cookieDescriptor);
    } catch { /* ignore */ }

    this._context = ctx;
    this._pendingTimers = pendingTimers;
    return this;
  }

  /**
   * Execute JavaScript code in the sandbox.
   * @param {string} code
   */
  run(code) {
    if (!this._context) throw new Error('call build() first');
    try {
      vm.runInContext(code, this._context, { timeout: this.options.vmTimeoutMs });
    } catch (err) {
      this._loadError = err.message;
    }
    // Drain pending timers (synchronous)
    for (const timer of this._pendingTimers) {
      if (timer) { try { timer.fn(...timer.args); } catch { /* ignore */ } }
    }
    this._pendingTimers.length = 0;
    return this;
  }

  /**
   * Call a named function in the sandbox.
   * @param {string} fnName - Supports dot notation
   * @param {any[]} [args=[]]
   */
  call(fnName, args = []) {
    if (!this._context) throw new Error('call build() first');
    const parts = fnName.split('.');
    let fn = this._context;
    for (const p of parts) fn = fn?.[p];
    if (typeof fn !== 'function') throw new Error(`${fnName} not found in sandbox`);
    return fn(...args);
  }

  /** Get a value from the sandbox by name. */
  get(name) {
    return this._context?.[name];
  }

  get logs() { return this._logs; }
  get loadError() { return this._loadError ?? null; }
  get cookieStore() { return this._context?.document?.cookie ?? ''; }

  /** Clean up resources */
  close() {
    if (this._context) {
      this._context = null;
    }
    this._pendingTimers = [];
    this.capturedRequests.length = 0;
    this._logs.length = 0;
  }
}

/**
 * Convenience: build sandbox, run code, call function, return result + captured requests.
 *
 * @param {string} code
 * @param {string} fnName
 * @param {any[]} args
 * @param {Object} [sandboxOptions]
 */
export async function runInBrowserSandbox(code, fnName, args = [], sandboxOptions = {}) {
  const sb = new BrowserSandbox(sandboxOptions);
  try {
    await sb.build();
    sb.run(code);
    let result = null;
    let callError = null;
    try {
      result = sb.call(fnName, args);
    } catch (err) {
      callError = err.message;
    }
    return {
      result,
      callError,
      capturedRequests: sb.capturedRequests,
      logs: sb.logs,
      loadError: sb.loadError,
    };
  } finally {
    sb.close();
  }
}
