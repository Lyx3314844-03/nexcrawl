/**
 * Core Logger Factory — Creates Pino-backed structured loggers.
 *
 * This is the low-level logger factory used by runtime internals.
 * Prefer using getLogger() from utils/logger.js for application code.
 */

import { sanitize, sanitizeString } from '../utils/sanitizer.js';

let _pino = null;
const _pinoRoots = new Map();

async function _loadPino() {
  if (_pino !== null) return;  // false = already tried and failed
  try {
    _pino = (await import('pino')).default;
  } catch {
    _pino = false;  // sentinel: prevent infinite retry
  }
}

const _pinoLoadPromise = _loadPino();

/**
 * Create a structured JSON logger with optional Pino backend.
 *
 * @param {Object|string} [base={}] - Base fields included in every log entry
 * @param {string} [base.module] - Module name tag
 * @returns {{ info: Function, warn: Function, error: Function, debug: Function, child: Function }}
 */
export function createLogger(base = {}) {
  const normalizedBase = normalizeBase(base);
  let impl = null;

  // Try Pino first (async upgrade)
  _pinoLoadPromise.then(() => {
    if (_pino) {
      const isTest = process.argv.includes('--test');
      const isDev = process.env.NODE_ENV !== 'production' && !isTest;
      let transport;
      if (isDev) {
        try {
          transport = { target: 'pino-pretty', options: { colorize: !process.env.NO_COLOR } };
        } catch { /* ignore */ }
      }
      const rootKey = JSON.stringify({
        level: process.env.LOG_LEVEL ?? 'info',
        pretty: Boolean(transport),
      });
      if (!_pinoRoots.has(rootKey)) {
        _pinoRoots.set(rootKey, _pino({
          name: 'omnicrawl',
          level: process.env.LOG_LEVEL ?? 'info',
          ...(transport ? { transport } : {}),
        }));
      }

      impl = _pinoRoots.get(rootKey).child({ ...normalizedBase });
    }
  });

  // Fallback implementation (used synchronously before Pino loads)
  function write(level, message, fields = {}) {
    if (String(process.env.LOG_LEVEL ?? '').toLowerCase() === 'silent') {
      return;
    }

    const sanitizedMessage = sanitizeString(String(message));
    const sanitizedFields = sanitize(fields ?? {});
    if (impl) {
      impl[level](sanitizedFields, sanitizedMessage);
      return;
    }

    const payload = {
      at: new Date().toISOString(),
      level,
      message: sanitizedMessage,
      ...normalizedBase,
      ...sanitizedFields,
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
  }

  return {
    info(message, fields) { write('info', message, fields); },
    warn(message, fields) { write('warn', message, fields); },
    error(message, fields) { write('error', message, fields); },
    debug(message, fields) { write('debug', message, fields); },
    child(extra = {}) {
      return createLogger({ ...normalizedBase, ...normalizeBase(extra) });
    },
  };
}

function normalizeBase(base) {
  if (typeof base === 'string') {
    return { component: base };
  }

  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return { component: String(base ?? 'omnicrawl') };
  }

  return sanitize({ ...base });
}
