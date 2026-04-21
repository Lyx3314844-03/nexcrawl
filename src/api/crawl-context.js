/**
 * @typedef {Object} CrawlContext
 * @property {Object} request - The current request being processed
 * @property {Object} response - The fetch response (http or browser)
 * @property {Object} workflow - The resolved workflow config
 * @property {Object} extracted - Extracted data from this page
 * @property {function(string, Object=): Promise<boolean>} enqueue - Enqueue a new URL for crawling
 * @property {function(string|string[], Object=): Promise<number>} enqueueExtractedLinks - Enqueue URLs from extracted data
 * @property {function(Object): Promise<void>} pushData - Push extracted item to dataset
 * @property {function(string): Promise<string|null>} inputValue - Get a value from the key-value store
 * @property {function(string, Object): Promise<void>} setValue - Set a value in the key-value store
 * @property {function(): Object} snapshot - Get a snapshot of current run metrics
 * @property {Object} log - Structured logger scoped to this request
 */

/**
 * Creates a CrawlContext for a given request/response pair.
 * This is the primary interaction surface for route handlers.
 */

function normalizeEnqueueInput(input) {
  if (typeof input === 'string') {
    return { url: input };
  }

  if (!input || typeof input !== 'object' || Array.isArray(input) || !input.url) {
    throw new TypeError('enqueue requires a URL string or an object with a url field');
  }

  return input;
}

export class CrawlContextImpl {
  /**
   * @param {Object} options
   * @param {Object} options.item - The queue item being processed
   * @param {Object} options.response - The fetch response
   * @param {Object} options.extracted - Extraction results
   * @param {Object} options.runner - The active job runner
   */
  constructor({ item, response, extracted, runner, reverseEngine }) {
    /** @type {Object} */
    this.request = {
      url: item.url,
      method: item.method ?? 'GET',
      headers: item.headers ?? {},
      depth: item.depth ?? 0,
      parentUrl: item.parentUrl ?? null,
      uniqueKey: item.uniqueKey ?? null,
      label: item.label ?? item.metadata?.label ?? null,
      params: item.params ?? {},
      userData: item.userData ?? {},
      metadata: item.metadata ?? {},
    };

    /** @type {Object} */
    this.response = response;

    /** @type {Object} */
    this.extracted = extracted;

    /** @private */
    this._runner = runner;
    /** @private @type {Object[]} Items buffered by pushData, awaiting pipeline processing */
    this._pendingItems = [];

    /** @private @type {import('../reverse/reverse-engine.js').ReverseEngine|null} */
    this._reverseEngine = reverseEngine ?? null;
    /** @type {Object} */
    this.log = runner?.logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  }

  #resolveTargetUrl(url) {
    const value = String(url ?? '').trim();
    if (!value) {
      throw new Error('enqueue requires a non-empty url');
    }
    return new URL(value, this.finalUrl || this.request.url).href;
  }

  /**
   * Enqueue a new request for crawling.
   * Accepts either a URL string or a richer request descriptor.
   * @param {string|Object} url - URL or request descriptor to enqueue
   * @param {Object} [options] - Enqueue options
   * @param {number} [options.depth] - Override depth (default: current depth + 1)
   * @param {Object} [options.userData] - Custom data attached to the request
   * @param {string} [options.label] - Route label for handler dispatch
   * @returns {Promise<boolean>}
   */
  async enqueue(url, options = {}) {
    const input = normalizeEnqueueInput(url);
    const targetUrl = this.#resolveTargetUrl(input.url);
    return this._runner.enqueue({
      url: targetUrl,
      method: input.method,
      headers: input.headers,
      body: input.body,
      replayState: input.replayState ?? this.response?.replayState ?? null,
      uniqueKey: input.uniqueKey ?? null,
      priority: input.priority,
      depth: options.depth ?? input.depth ?? this.request.depth + 1,
      parentUrl: this.request.url,
      userData: {
        ...(input.userData ?? {}),
        ...(options.userData ?? {}),
      },
      label: options.label ?? input.label ?? null,
      metadata: {
        source: 'handler',
        parentLabel: this.request.label,
        ...(input.label ? { label: input.label } : {}),
        ...(options.label ? { label: options.label } : {}),
        ...(input.metadata ?? {}),
        ...(options.metadata ?? {}),
      },
    });
  }

  /**
   * Enqueue multiple requests at once.
   * @param {Array<string|Object>} urls - URLs or request descriptors to enqueue
   * @param {Object} [options] - Same options as enqueue
   * @returns {Promise<number>} Number of URLs successfully enqueued
   */
  async enqueueLinks(urls, options = {}) {
    let count = 0;
    const seen = new Set();
    for (const input of Array.isArray(urls) ? urls : []) {
      const normalized = normalizeEnqueueInput(input);
      const dedupeKey = JSON.stringify([
        this.#resolveTargetUrl(normalized.url),
        normalized.method ?? 'GET',
        normalized.body ?? '',
        normalized.uniqueKey ?? '',
      ]);
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      const added = await this.enqueue(normalized, options);
      if (added) count += 1;
    }
    return count;
  }

  /**
   * Enqueue URLs from extracted data or a provided array.
   * @param {string|Array<string|Object>} [source='links'] - Extracted field name or explicit request list
   * @param {Object} [options] - Same options as enqueue
   * @returns {Promise<number>} Number of URLs successfully enqueued
   */
  async enqueueExtractedLinks(source = 'links', options = {}) {
    if (Array.isArray(source)) {
      return this.enqueueLinks(source, options);
    }

    const field = String(source ?? 'links');
    const urls = this.extracted?.[field];
    if (!Array.isArray(urls)) {
      return 0;
    }
    return this.enqueueLinks(urls, options);
  }

  /**
   * Push an extracted data item to the dataset store.
   * @param {Object} item - Data item to persist
   * @returns {Promise<void>}
   */
  async pushData(item) {
    this._pendingItems.push({
      ...item,
      _url: this.request.url,
      _depth: this.request.depth,
      _fetchedAt: this.response?.fetchedAt ?? new Date().toISOString(),
    });
  }

  /**
   * Drain all buffered items. If an ItemPipeline is provided, items are processed
   * through it before being returned. Dropped items are excluded.
   * @param {ItemPipeline} [pipeline] - Optional pipeline to process items through
   * @returns {Promise<Object[]>} Drained and optionally processed items
   */
  async drainItems(pipeline) {
    const items = this._pendingItems.splice(0);
    if (!pipeline) return items;
    const results = [];
    for (const item of items) {
      const result = await pipeline.process(item, this);
      if (result.item && !result.dropped) results.push(result.item);
      else if (result.error) this.log.warn('Pipeline step failed', { error: result.error.message });
    }
    return results;
  }

  /**
   * Get a value from the key-value store.
   * @param {string} key - Key to look up
   * @returns {Promise<string|null>}
   */
  async inputValue(key) {
    const keyValueStore = this._runner?.programmaticKeyValueStore ?? this._runner?.keyValueStore ?? null;
    if (!keyValueStore) {
      return null;
    }
    const record = await keyValueStore.getRecord(key);
    return record?.value ?? null;
  }

  /**
   * Set a value in the key-value store.
   * @param {string} key - Key to set
   * @param {Object} value - Value to store
   * @returns {Promise<void>}
   */
  async setValue(key, value) {
    const keyValueStore = this._runner?.programmaticKeyValueStore ?? this._runner?.keyValueStore ?? null;
    if (!keyValueStore) {
      throw new Error('Key-value store is not available for this crawl context');
    }
    await keyValueStore.setRecord(key, value);
  }

  /**
   * Get a snapshot of current run metrics.
   * @returns {Object}
   */
  snapshot() {
    return {
      pagesFetched: this._runner.pagesFetched,
      resultCount: this._runner.resultCount,
      failureCount: this._runner.failureCount,
      skippedCount: this._runner.skippedCount,
      autoscale: this._runner.autoscaler?.snapshot?.() ?? null,
      queue: this._runner.requestQueue?.summary?.() ?? null,
    };
  }

  // ---- Reverse Engineering Analysis Methods ----

  /**
   * Get the ReverseEngine instance for direct advanced operations.
   * Returns null if no reverse capabilities are configured.
   * @type {import('../reverse/reverse-engine.js').ReverseEngine|null}
   */
  get reverseEngine() {
    return this._reverseEngine;
  }

  /**
   * Analyze JavaScript source code using the reverse engine.
   * @param {string} code - JS source code to analyze
   * @param {Object} [options] - Analysis options
   * @returns {Promise<Object>} Analysis result
   */
  async analyzeJS(code, options = {}) {
    if (!this._reverseEngine) return { success: false, error: 'Reverse engine not configured' };
    return this._reverseEngine.analyzeJS(code, options);
  }

  /**
   * Analyze cryptographic functions in source code.
   * @param {string} code - JS source code to analyze
   * @param {Object} [options] - Analysis options
   * @returns {Promise<Object>} Crypto analysis result
   */
  async analyzeCrypto(code, options = {}) {
    if (!this._reverseEngine) return { success: false, error: 'Reverse engine not configured' };
    return this._reverseEngine.analyzeCrypto(code, options);
  }

  /**
   * Analyze a Webpack bundle.
   * @param {string} code - Webpack bundle source code
   * @param {Object} [options] - Analysis options
   * @returns {Promise<Object>} Webpack analysis result
   */
  async analyzeWebpack(code, options = {}) {
    if (!this._reverseEngine) return { success: false, error: 'Reverse engine not configured' };
    return this._reverseEngine.analyzeWebpack(code, options);
  }

  /**
   * Locate signature/encryption functions in source code.
   * @param {string} code - JS source code
   * @param {Object} [options] - Locator options
   * @returns {Promise<Object>} Signature location result
   */
  async locateSignature(code, options = {}) {
    if (!this._reverseEngine) return { success: false, error: 'Reverse engine not configured' };
    return this._reverseEngine.locateSignature(code, options);
  }

  /**
   * Summarize the reverse engineering workflow for the current page.
   * Uses the page body as input if no HTML is provided.
   * @param {string} [html] - Optional HTML override (defaults to response body)
   * @param {Object} [options] - Workflow options
   * @returns {Promise<Object>} Workflow summary with next steps
   */
  async summarizeWorkflow(html, options = {}) {
    if (!this._reverseEngine) return { success: false, error: 'Reverse engine not configured' };
    const input = html ?? this.body ?? '';
    return this._reverseEngine.summarizeWorkflow(input, options);
  }

  /**
   * Analyze the current page surface using the AI-oriented reverse analyzer.
   * @param {Object} [payload] - Analysis payload overrides
   * @returns {Promise<Object>} Combined analysis result
   */
  async analyzeAISurface(payload = {}) {
    if (!this._reverseEngine) return { success: false, error: 'Reverse engine not configured' };
    return this._reverseEngine.analyzeAISurface({
      html: payload.html ?? this.body,
      body: payload.body ?? this.body,
      status: payload.status ?? this.status,
      headers: payload.headers ?? this.headers,
      target: payload.target ?? this.finalUrl,
      ...payload,
    });
  }

  /**
   * Run a generic reverse operation.
   * @param {string} operation - Operation name (e.g. 'analyze', 'crypto.identify')
   * @param {Object} [payload] - Operation-specific payload
   * @returns {Promise<Object>} Operation result
   */
  async runReverseOperation(operation, payload = {}) {
    if (!this._reverseEngine) return { success: false, error: 'Reverse engine not configured' };
    return this._reverseEngine.runReverseOperation(operation, payload);
  }

  /**
   * Simulate human behavior on the current browser page (browser mode only).
   * @param {Object} [options] - Behavior simulation options
   * @returns {Promise<void>}
   */
  async simulateHumanBehavior(options = {}) {
    if (!this._reverseEngine) throw new Error('Reverse engine not configured');
    if (!this.page) throw new Error('simulateHumanBehavior requires browser mode');
    return this._reverseEngine.simulateHumanBehavior(this.page, options);
  }

  /**
   * Generate hook injection code for monitoring network/crypto/params.
   * @param {Object} [options] - Hook generation options
   * @returns {string} JavaScript hook code
   */
  generateHookCode(options = {}) {
    if (!this._reverseEngine) return '';
    return this._reverseEngine.generateHookCode(options);
  }

  /**
   * Access the raw page object (browser mode only). Returns null for HTTP mode.
   * @type {Object|null}
   */
  get page() {
    return this.response?._page ?? null;
  }

  /**
   * Access the response body as text.
   * @type {string}
   */
  get body() {
    return this.response?.body ?? '';
  }

  /**
   * The final URL after redirects.
   * @type {string}
   */
  get finalUrl() {
    return this.response?.finalUrl ?? this.request.url;
  }

  /**
   * HTTP status code.
   * @type {number}
   */
  get status() {
    return this.response?.status ?? 0;
  }

  /**
   * Whether the request was successful (status < 400).
   * @type {boolean}
   */
  get ok() {
    if (this.response?.ok !== undefined) return this.response.ok;
    return (this.response?.status ?? 0) >= 200 && (this.response?.status ?? 0) < 400;
  }

  /**
   * Response headers.
   * @type {Object}
   */
  get headers() {
    return this.response?.headers ?? {};
  }

  /**
   * Route params resolved by the Router, if available.
   * @type {Object}
   */
  get params() {
    return this.request.params ?? {};
  }

  /**
   * Route label resolved by the Router, if available.
   * @type {string|null}
   */
  get label() {
    return this.request.label ?? null;
  }
}
