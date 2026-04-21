/**
 * FunctionTracer — Hook arbitrary functions in a JS sandbox and capture
 * call chains, arguments, return values, and exceptions.
 *
 * Works by wrapping target functions with a Proxy before execution,
 * recording every invocation in a structured trace log.
 *
 * Usage:
 *   const tracer = new FunctionTracer(code);
 *   await tracer.prepare();
 *   const result = await tracer.call('sign', [url, body, timestamp]);
 *   console.log(tracer.getTrace());
 */

import vm from 'node:vm';
import { JSDOM } from 'jsdom';

function serializeArg(value, depth = 0) {
  if (depth > 3) return '[deep]';
  if (value === null) return null;
  if (value === undefined) return undefined;
  const t = typeof value;
  if (t === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => serializeArg(v, depth + 1));
  if (t === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 20)) {
      out[k] = serializeArg(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export class FunctionTracer {
  /**
   * @param {string} code - JavaScript source to execute in sandbox
   * @param {Object} [options]
   * @param {string[]} [options.hookPatterns] - Function name substrings to auto-hook (e.g. ['sign','hash','encrypt'])
   * @param {boolean} [options.hookAll=false] - Hook every function defined in the sandbox
   * @param {number} [options.maxTraceEntries=500]
   * @param {Object} [options.env] - Extra globals injected into sandbox
   */
  constructor(code, options = {}) {
    this.code = code;
    this.options = options;
    this.trace = [];
    this.sandbox = null;
    this._callDepth = 0;
    this._callChainEntries = [];
  }

  /** Build sandbox, execute code, install hooks. */
  async prepare() {
    const dom = new JSDOM('', { url: 'https://example.com' });
    const win = dom.window;

    const logs = [];
    const tracer = this;

    this.sandbox = vm.createContext({
      // Browser globals
      window: win,
      document: win.document,
      navigator: win.navigator,
      location: win.location,
      history: win.history,
      screen: win.screen,
      performance: win.performance,
      crypto: win.crypto,
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      setTimeout: (fn, ms) => { try { fn(); } catch { /* ignore */ } },
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      console: {
        log: (...a) => logs.push({ level: 'log', args: a }),
        warn: (...a) => logs.push({ level: 'warn', args: a }),
        error: (...a) => logs.push({ level: 'error', args: a }),
        info: (...a) => logs.push({ level: 'info', args: a }),
      },
      // Node globals
      Buffer,
      process: { env: {}, version: 'v20.0.0', platform: 'linux' },
      // User-supplied extras
      ...(this.options.env ?? {}),
    });

    // Execute the target code
    try {
      vm.runInContext(this.code, this.sandbox, { timeout: 10000 });
    } catch (err) {
      // Some scripts throw on load (e.g. IIFE that calls missing APIs) — continue anyway
      this._loadError = err.message;
    }

    this._logs = logs;

    // Install hooks
    this._installHooks();
    return this;
  }

  _installHooks() {
    const { hookPatterns = [], hookAll = false } = this.options;
    const tracer = this;

    for (const [key, value] of Object.entries(this.sandbox)) {
      if (typeof value !== 'function') continue;
      if (key.startsWith('__')) continue;

      const shouldHook = hookAll
        || hookPatterns.some((p) => key.toLowerCase().includes(p.toLowerCase()));

      if (!shouldHook) continue;

      this.sandbox[key] = this._wrapFn(value, key);
    }

    // Also hook methods on plain objects one level deep
    for (const [objKey, obj] of Object.entries(this.sandbox)) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      for (const [methodKey, method] of Object.entries(obj)) {
        if (typeof method !== 'function') continue;
        const fullName = `${objKey}.${methodKey}`;
        const shouldHook = hookAll
          || hookPatterns.some((p) => fullName.toLowerCase().includes(p.toLowerCase()) || methodKey.toLowerCase().includes(p.toLowerCase()));
        if (!shouldHook) continue;
        try { obj[methodKey] = this._wrapFn(method, fullName); } catch { /* read-only property, skip */ }
      }
    }
  }

  _wrapFn(fn, name) {
    const tracer = this;
    return function tracedFn(...args) {
      const callId = tracer.trace.length;
      const depth = tracer._callDepth;
      tracer._callDepth++;

      const entry = {
        id: callId,
        depth,
        name,
        args: args.map((a) => serializeArg(a)),
        returnValue: undefined,
        error: null,
        durationMs: 0,
        calledAt: Date.now(),
      };
      tracer.trace.push(entry);

      const t0 = Date.now();
      try {
        const ret = fn.apply(this, args);
        // Handle promise returns
        if (ret && typeof ret.then === 'function') {
          return ret.then((resolved) => {
            entry.returnValue = serializeArg(resolved);
            entry.durationMs = Date.now() - t0;
            tracer._callDepth--;
            return resolved;
          }).catch((err) => {
            entry.error = err?.message ?? String(err);
            entry.durationMs = Date.now() - t0;
            tracer._callDepth--;
            throw err;
          });
        }
        entry.returnValue = serializeArg(ret);
        entry.durationMs = Date.now() - t0;
        tracer._callDepth--;
        return ret;
      } catch (err) {
        entry.error = err?.message ?? String(err);
        entry.durationMs = Date.now() - t0;
        tracer._callDepth--;
        throw err;
      }
    };
  }

  /**
   * Call a named function in the sandbox and return its result.
   * @param {string} fnName - Function name (supports dot notation: 'obj.sign')
   * @param {any[]} [args=[]]
   * @param {number} [timeoutMs=5000]
   */
  async call(fnName, args = [], timeoutMs = 5000) {
    if (!this.sandbox) throw new Error('call prepare() first');

    const parts = fnName.split('.');
    let fn = this.sandbox;
    for (const part of parts) {
      fn = fn?.[part];
    }
    if (typeof fn !== 'function') {
      throw new Error(`Function not found in sandbox: ${fnName}`);
    }

    // Wrap in a timeout
    return Promise.race([
      Promise.resolve().then(() => fn(...args)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('call timeout')), timeoutMs)),
    ]);
  }

  /**
   * Hook a specific function by name after prepare().
   * @param {string} fnName
   */
  hookFunction(fnName) {
    const parts = fnName.split('.');
    let obj = this.sandbox;
    for (let i = 0; i < parts.length - 1; i++) obj = obj?.[parts[i]];
    const last = parts[parts.length - 1];
    if (typeof obj?.[last] !== 'function') throw new Error(`${fnName} not found`);
    obj[last] = this._wrapFn(obj[last], fnName);
  }

  /** Get the full call trace. */
  getTrace() {
    return this.trace.slice(0, this.options.maxTraceEntries ?? 500);
  }

  /** Get only calls matching a name pattern. */
  filterTrace(pattern) {
    const re = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
    return this.trace.filter((e) => re.test(e.name));
  }

  /** Get a call tree (nested by depth). */
  getCallTree() {
    const roots = [];
    const stack = [];
    for (const entry of this.trace) {
      const node = { ...entry, children: [] };
      while (stack.length > 0 && stack[stack.length - 1].depth >= entry.depth) stack.pop();
      if (stack.length === 0) roots.push(node);
      else stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
    return roots;
  }

  /** Reset trace without re-executing code. */
  clearTrace() {
    this.trace = [];
    this._callDepth = 0;
  }

  /**
   * Backward-compat: Hook all functions on a plain object context.
   * Wraps each function with trace instrumentation.
   * @param {Object} context - Object whose functions will be hooked
   */
  hook(context) {
    if (!context || typeof context !== 'object') return;
    const tracer = this;
    for (const [key, value] of Object.entries(context)) {
      if (typeof value !== 'function') continue;
      context[key] = tracer._wrapFnCompat(value, key);
    }
    this._hookedContext = context;
  }

  /**
   * Wrap a function for the hook() backward-compat API.
   * Records { fnName, args, result, error } entries.
   */
  _wrapFnCompat(fn, name) {
    const tracer = this;
    return function wrapped(...args) {
      const entry = {
        fnName: name,
        args: args.slice(),
        result: undefined,
        error: null,
      };
      // Push BEFORE calling so nested calls appear in correct order
      tracer._callChainEntries.push(entry);
      try {
        const ret = fn.apply(this, args);
        entry.result = ret;
        return ret;
      } catch (err) {
        entry.error = err?.message ?? String(err);
        throw err;
      }
    };
  }

  /**
   * Backward-compat: Get the call chain from hook() calls.
   * Returns array of { fnName, args, result, error } entries.
   */
  getCallChain() {
    return this._callChainEntries.slice();
  }

  get consoleLogs() { return this._logs ?? []; }
  get loadError() { return this._loadError ?? null; }
}

/**
 * Convenience: execute code, hook patterns, call a function, return trace.
 *
 * @param {string} code
 * @param {string} fnName
 * @param {any[]} args
 * @param {string[]} hookPatterns
 * @returns {Promise<{ result: any, trace: Object[], callTree: Object[], logs: Object[] }>}
 */
export async function traceFunction(code, fnName, args = [], hookPatterns = []) {
  const tracer = new FunctionTracer(code, { hookPatterns: hookPatterns.length ? hookPatterns : [fnName] });
  await tracer.prepare();
  let result;
  let callError = null;
  try {
    result = await tracer.call(fnName, args);
  } catch (err) {
    callError = err.message;
  }
  return {
    result,
    callError,
    error: callError,
    trace: tracer.getTrace(),
    callTree: tracer.getCallTree(),
    logs: tracer.consoleLogs,
    loadError: tracer.loadError,
  };
}
