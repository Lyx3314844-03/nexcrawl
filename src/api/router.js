/**
 * @typedef {Object} RouteMatch
 * @property {function(import('./crawl-context.js').CrawlContext): Promise<void>} handler
 * @property {Object} params - Extracted route parameters
 * @property {string|null} label - Route label
 */

/**
 * Router maps URL patterns to handler functions.
 * Supports glob patterns, RegExp, named params (:id), and labeled routes.
 *
 * @example
 * const router = new Router()
 *   .addHandler('/products/*', productHandler, { label: 'product' })
 *   .addHandler(/^\/api\/v\d+\/items/, itemsHandler)
 *   .addDefaultHandler(genericHandler);
 */
export class Router {
  constructor() {
    /** @private */
    this._routes = [];
    /** @private */
    this._defaultHandler = null;
    /** @private */
    this._labeledHandlers = new Map();
  }

  /**
   * Register a handler for a URL pattern.
   * @param {string|RegExp} pattern - URL pattern (glob, RegExp, or :param)
   * @param {function} handler - Handler function receiving CrawlContext
   * @param {Object} [options] - Route options
   * @param {string} [options.label] - Label for direct dispatch via enqueue({ label })
   * @returns {this}
   */
  addHandler(pattern, handler, options = {}) {
    this._routes.push({ pattern, handler, label: options.label ?? null });
    if (options.label) {
      this._labeledHandlers.set(options.label, handler);
    }
    return this;
  }

  /**
   * Register a default handler for unmatched URLs.
   * @param {function} handler
   * @returns {this}
   */
  addDefaultHandler(handler) {
    this._defaultHandler = handler;
    return this;
  }

  /**
   * Get a handler by its label.
   * @param {string} label
   * @returns {function|null}
   */
  getHandlerByLabel(label) {
    return this._labeledHandlers.get(label) ?? null;
  }

  /**
   * Resolve a URL to a matching handler.
   * @param {string} url
   * @param {string|null} [label] - Optional label for direct dispatch
   * @returns {RouteMatch|null}
   */
  resolve(url, label = null) {
    if (label) {
      for (const route of this._routes) {
        if (route.label !== label) {
          continue;
        }
        const params = this._match(route.pattern, url);
        if (params !== null) {
          return { handler: route.handler, params, label };
        }
      }
      const handler = this._labeledHandlers.get(label);
      if (handler) return { handler, params: {}, label };
    }
    for (const route of this._routes) {
      const params = this._match(route.pattern, url);
      if (params !== null) return { handler: route.handler, params, label: route.label };
    }
    if (this._defaultHandler) return { handler: this._defaultHandler, params: {}, label: null };
    return null;
  }

  /** @private */
  _match(pattern, url) {
    if (pattern instanceof RegExp) {
      const m = pattern.exec(url);
      if (!m) return null;
      const params = {};
      if (m.groups) Object.assign(params, m.groups);
      else for (let i = 1; i < m.length; i++) params[i] = m[i];
      return params;
    }
    if (typeof pattern === 'string') return this._globMatch(pattern, url);
    return null;
  }

  /** @private */
  _globMatch(pattern, url) {
    let path;
    try {
      const urlObj = new URL(url);
      path = urlObj.pathname + urlObj.search;
    } catch(e) {
      // Bare path (e.g. /products/123) - use as-is
      path = url;
    }
    const pp = pattern.split('/');
    const up = path.split('/');
    const params = {};
    let pi = 0, ui = 0;
    while (pi < pp.length && ui < up.length) {
      const seg = pp[pi];
      if (seg === '**') {
        if (pi === pp.length - 1) return params;
        const next = pp[pi + 1];
        while (ui < up.length && up[ui] !== next) ui++;
        pi++;
        continue;
      }
      if (seg === '*') { params['seg' + pi] = up[ui]; pi++; ui++; continue; }
      if (seg.startsWith(':')) { params[seg.slice(1)] = up[ui]; pi++; ui++; continue; }
      if (seg === up[ui]) { pi++; ui++; continue; }
      return null;
    }
    return pi === pp.length && ui >= up.length ? params : null;
  }

  /**
   * List all registered route labels.
   * @returns {string[]}
   */
  labels() { return [...this._labeledHandlers.keys()]; }

  /**
   * Check if a label is registered.
   * @param {string} label
   * @returns {boolean}
   */
  hasLabel(label) { return this._labeledHandlers.has(label); }
}
