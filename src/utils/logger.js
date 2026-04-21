/**
 * Structured Logging System — Pino-backed with zero-dependency fallback.
 *
 * Production: Uses Pino for high-throughput structured JSON logging.
 * Development: Uses pino-pretty for human-readable output.
 * Fallback: If Pino is unavailable, uses built-in lightweight logger.
 *
 * Environment variables:
 *   LOG_LEVEL  - debug|info|warn|error|silent (default: info)
 *   LOG_JSON   - true|false (default: false in dev, true in production)
 *   LOG_PRETTY - true|false (default: true in dev, false in production)
 *   NO_COLOR   - 1 to disable color in pretty mode
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

// ─── Pino Integration ───────────────────────────────────────────

// null = not attempted yet, false = attempted and failed, object = loaded
let _pino = null;
let _pinoPretty = null;

/**
 * Attempt to load pino and pino-pretty.
 * Failures are recorded with a sentinel (false) to prevent infinite retries.
 */
async function _loadPino() {
  if (_pino !== null) return; // already attempted (false = failed, object = success)
  try {
    _pino = (await import('pino')).default;
    try {
      _pinoPretty = (await import('pino-pretty')).default;
    } catch {
      _pinoPretty = false; // pretty not available
    }
  } catch {
    _pino = false; // pino not available — sentinel prevents retry
  }
}

// Start loading pino eagerly (non-blocking)
const _pinoLoadPromise = _loadPino();

// ─── Built-in Fallback Logger ───────────────────────────────────

class FallbackLogger {
  constructor(options = {}) {
    this.level = options.level ?? 'info';
    this.name = options.name ?? 'omnicrawl';
    this.json = options.json ?? false;
    this.timestamp = options.timestamp ?? true;
    this._bindings = options.bindings ?? {};
  }

  _shouldLog(level) {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  _format(level, message, context = {}) {
    const entry = {
      level,
      name: this.name,
      msg: message,
      ...this._bindings,
      ...context,
    };

    if (this.timestamp) {
      entry.time = new Date().toISOString();
    }

    if (this.json) {
      return JSON.stringify(entry);
    }

    const parts = [
      entry.time ? `[${entry.time}]` : '',
      `[${level.toUpperCase()}]`,
      `[${this.name}]`,
      message,
    ];

    if (Object.keys(context).length > 0) {
      parts.push(JSON.stringify(context));
    }

    return parts.filter(Boolean).join(' ');
  }

  debug(message, context) {
    if (this._shouldLog('debug')) console.debug(this._format('debug', message, context));
  }
  info(message, context) {
    if (this._shouldLog('info')) console.info(this._format('info', message, context));
  }
  warn(message, context) {
    if (this._shouldLog('warn')) console.warn(this._format('warn', message, context));
  }
  error(message, context) {
    if (this._shouldLog('error')) console.error(this._format('error', message, context));
  }

  child(options = {}) {
    return new FallbackLogger({
      level: this.level,
      name: options.name ?? this.name,
      json: this.json,
      timestamp: this.timestamp,
      bindings: { ...this._bindings, ...(options.bindings ?? {}), ...options },
    });
  }
}

// ─── Pino-backed Logger ─────────────────────────────────────────

class PinoLogger {
  constructor(pinoInstance, name = 'omnicrawl') {
    this._pino = pinoInstance;
    this._name = name;
    this.level = pinoInstance.level;
  }

  debug(message, context) {
    this._pino.debug({ ...context, module: this._name }, message);
  }
  info(message, context) {
    this._pino.info({ ...context, module: this._name }, message);
  }
  warn(message, context) {
    this._pino.warn({ ...context, module: this._name }, message);
  }
  error(message, context) {
    this._pino.error({ ...context, module: this._name }, message);
  }

  child(options = {}) {
    const childPino = this._pino.child({
      module: options.name ?? this._name,
      ...options.bindings,
    });
    return new PinoLogger(childPino, options.name ?? this._name);
  }
}

// ─── Unified Logger Facade ──────────────────────────────────────

/**
 * Logger — automatically uses Pino if available, otherwise falls back
 * to the built-in lightweight logger.
 */
class Logger {
  constructor(options = {}) {
    this.level = options.level ?? process.env.LOG_LEVEL ?? 'info';
    this.name = options.name ?? 'omnicrawl';
    this.json = options.json ?? (process.env.LOG_JSON === 'true' || process.env.NODE_ENV === 'production');
    this.timestamp = options.timestamp ?? true;
    this._bindings = options.bindings ?? {};

    // Will be upgraded to Pino once loaded
    this._impl = new FallbackLogger({
      level: this.level,
      name: this.name,
      json: this.json,
      timestamp: this.timestamp,
      bindings: this._bindings,
    });

    // Try to upgrade to Pino
    this._upgradeToPino();
  }

  /**
   * Attempt to upgrade the underlying logger to Pino.
   * This is non-blocking — if Pino isn't loaded yet, we keep using FallbackLogger.
   */
  async _upgradeToPino() {
    await _pinoLoadPromise;
    if (_pino && _pino !== false) {
      const isDev = process.env.NODE_ENV !== 'production';
      const usePretty = isDev && _pinoPretty && _pinoPretty !== false && process.env.LOG_PRETTY !== 'false';

      const pinoOpts = {
        level: this.level,
        name: this.name,
        ...(usePretty ? { transport: { target: 'pino-pretty', options: { colorize: !process.env.NO_COLOR } } } : {}),
      };

      const pinoInstance = _pino(pinoOpts);
      this._impl = new PinoLogger(pinoInstance, this.name);
    }
  }

  debug(message, context) { this._impl.debug(message, context); }
  info(message, context) { this._impl.info(message, context); }
  warn(message, context) { this._impl.warn(message, context); }
  error(message, context) { this._impl.error(message, context); }

  child(options = {}) {
    return this._impl.child({ name: options.name ?? this.name, ...options });
  }
}

// ─── Global Logger Access ──────────────────────────────────────

let globalLogger = null;

/**
 * Get or create the global logger instance.
 * @param {string} [name] - Optional module name for child logger
 * @returns {Logger}
 */
export function getLogger(name) {
  if (!globalLogger) {
    globalLogger = new Logger({
      level: process.env.LOG_LEVEL ?? 'info',
      json: process.env.LOG_JSON === 'true' || process.env.NODE_ENV === 'production',
    });
  }
  return name ? globalLogger.child({ name }) : globalLogger;
}

/**
 * Override the global logger.
 * @param {Logger} logger
 */
export function setLogger(logger) {
  globalLogger = logger;
}

export { Logger };
