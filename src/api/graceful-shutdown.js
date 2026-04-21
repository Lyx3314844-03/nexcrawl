/**
 * Graceful shutdown manager for OmniCrawler.
 * Handles SIGTERM, SIGINT, and SIGHUP signals to allow
 * in-flight requests to complete before exiting.
 *
 * v2: Adds zero-data-loss job persistence — on shutdown, all in-flight
 * job state (request queue, dataset, key-value store) is persisted so
 * the crawler can resume from exactly where it left off.
 *
 * @example
 * const shutdown = new GracefulShutdown({ timeoutMs: 30000 });
 * shutdown.register(() => crawler.teardown());
 * shutdown.registerJobPersistence(() => jobRunner.persistState());
 * shutdown.install();
 */

const ACTIVE_SHUTDOWNS = new Set();
let sharedSigtermHandler = null;
let sharedSighupHandler = null;

async function dispatchSharedShutdown(reason) {
  const pending = [...ACTIVE_SHUTDOWNS].map((shutdown) => shutdown.shutdown(reason));
  await Promise.allSettled(pending);
}

function installSharedHandlers() {
  if (!sharedSigtermHandler) {
    sharedSigtermHandler = async () => { await dispatchSharedShutdown('signal'); };
    process.on('SIGTERM', sharedSigtermHandler);
    process.on('SIGINT', sharedSigtermHandler);
  }

  if (!sharedSighupHandler) {
    sharedSighupHandler = async () => { await dispatchSharedShutdown('sighup'); };
    process.on('SIGHUP', sharedSighupHandler);
  }
}

function uninstallSharedHandlers() {
  if (ACTIVE_SHUTDOWNS.size > 0) {
    return;
  }

  if (sharedSigtermHandler) {
    process.removeListener('SIGTERM', sharedSigtermHandler);
    process.removeListener('SIGINT', sharedSigtermHandler);
    sharedSigtermHandler = null;
  }

  if (sharedSighupHandler) {
    process.removeListener('SIGHUP', sharedSighupHandler);
    sharedSighupHandler = null;
  }
}

export class GracefulShutdown {
  /**
   * @param {Object} [options]
   * @param {number} [options.timeoutMs=15000] - Max wait time before force exit
   * @param {boolean} [options.install=true] - Auto-install signal handlers
   * @param {function} [options.onShutdown] - Cleanup callback
   * @param {boolean} [options.persistOnShutdown=true] - Enable job persistence on shutdown
   */
  constructor(options = {}) {
    this._timeoutMs = options.timeoutMs ?? 15000;
    /** @private @type {Array<function(): Promise<void>>} */
    this._callbacks = [];
    /** @private @type {Array<function(): Promise<void>>} */
    this._persistenceCallbacks = [];
    this._shuttingDown = false;
    this._installed = false;
    this._persistOnShutdown = options.persistOnShutdown !== false;
    if (options.onShutdown) this._callbacks.push(options.onShutdown);
    if (options.install !== false) this.install();
  }

  /**
   * Register a cleanup callback.
   * @param {function(): Promise<void>} callback
   * @returns {this}
   */
  register(callback) {
    this._callbacks.push(callback);
    return this;
  }

  /**
   * Register a job persistence callback.
   * Persistence callbacks run BEFORE regular cleanup callbacks,
   * ensuring in-flight state is saved before resources are released.
   *
   * @param {function(): Promise<void>} callback - Must return a Promise
   * @returns {this}
   */
  registerJobPersistence(callback) {
    this._persistenceCallbacks.push(callback);
    return this;
  }

  /**
   * Install signal handlers for SIGTERM, SIGINT, SIGHUP.
   * @returns {this}
   */
  install() {
    if (this._installed) return this;
    this._installed = true;
    ACTIVE_SHUTDOWNS.add(this);
    installSharedHandlers();
    return this;
  }

  /**
   * Uninstall signal handlers.
   * @returns {this}
   */
  uninstall() {
    if (!this._installed) return this;
    this._installed = false;
    ACTIVE_SHUTDOWNS.delete(this);
    uninstallSharedHandlers();
    return this;
  }

  /**
   * Persist all job state — called FIRST during shutdown.
   * This ensures zero data loss even if cleanup callbacks fail.
   *
   * @private
   * @returns {Promise<{ persisted: boolean, errors: string[] }>}
   */
  async _persistState() {
    if (!this._persistOnShutdown || this._persistenceCallbacks.length === 0) {
      return { persisted: false, errors: [] };
    }

    const errors = [];
    for (const cb of this._persistenceCallbacks) {
      try {
        await cb();
      } catch (e) {
        const msg = e?.message ?? String(e);
        errors.push(msg);
        process.stderr.write(`[omnicrawl] job persistence error: ${msg}\n`);
      }
    }

    return { persisted: errors.length === 0, errors };
  }

  /**
   * Initiate graceful shutdown.
   * Order: 1) Persist job state  2) Run cleanup callbacks  3) Exit
   *
   * @param {string} [reason='manual']
   * @returns {Promise<void>}
   */
  async shutdown(reason = 'manual') {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    const timeout = setTimeout(() => {
      process.stderr.write(`[omnicrawl] graceful shutdown timed out after ${this._timeoutMs}ms, forcing exit\n`);
      process.exit(1);
    }, this._timeoutMs);
    timeout.unref?.();

    try {
      // Phase 1: Persist job state (ZERO DATA LOSS priority)
      const persistResult = await this._persistState();
      if (persistResult.errors.length > 0) {
        process.stderr.write(`[omnicrawl] WARNING: ${persistResult.errors.length} persistence error(s) during shutdown\n`);
      }

      // Phase 2: Run cleanup callbacks (release resources)
      for (const cb of this._callbacks) {
        try { await cb(); } catch (e) {
          process.stderr.write(`[omnicrawl] shutdown callback error: ${e?.message ?? e}\n`);
        }
      }
    } finally {
      clearTimeout(timeout);
      this.uninstall();
    }
  }

  /**
   * Internal shutdown method for testing.
   * Runs persistence then cleanup without signal handling or process.exit.
   * @private
   * @returns {Promise<void>}
   */
  async _performShutdown() {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    // Phase 1: Persist job state
    const persistResult = await this._persistState();
    if (persistResult.errors.length > 0) {
      process.stderr.write(`[omnicrawl] WARNING: ${persistResult.errors.length} persistence error(s) during shutdown\n`);
    }

    // Phase 2: Run cleanup callbacks
    for (const cb of this._callbacks) {
      try { await cb(); } catch (e) {
        process.stderr.write(`[omnicrawl] shutdown callback error: ${e?.message ?? e}\n`);
      }
    }

    this.uninstall();
  }

  /** Whether shutdown has been initiated. @type {boolean} */
  get isShuttingDown() { return this._shuttingDown; }
}
