/**
 * Structured error classes for OmniCrawl.
 * Provides clear error categorization and context for debugging.
 */

export class OmniCrawlError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code ?? 'UNKNOWN_ERROR';
    this.context = options.context ?? {};
    this.recoverable = options.recoverable ?? false;
    this.timestamp = Date.now();
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      recoverable: this.recoverable,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

// ─── Network Errors ───────────────────────────────────────────────────────

export class NetworkError extends OmniCrawlError {
  constructor(message, options = {}) {
    super(message, { code: 'NETWORK_ERROR', recoverable: true, ...options });
  }
}

export class TimeoutError extends NetworkError {
  constructor(message, options = {}) {
    super(message, { code: 'TIMEOUT', ...options });
  }
}

export class ProxyError extends NetworkError {
  constructor(message, options = {}) {
    super(message, { code: 'PROXY_ERROR', ...options });
  }
}

// ─── HTTP Errors ──────────────────────────────────────────────────────────

export class HttpError extends OmniCrawlError {
  constructor(message, statusCode, options = {}) {
    super(message, { code: `HTTP_${statusCode}`, recoverable: statusCode < 500, ...options });
    this.statusCode = statusCode;
  }
}

export class RateLimitError extends HttpError {
  constructor(message, options = {}) {
    super(message, 429, { code: 'RATE_LIMIT', recoverable: true, ...options });
    this.retryAfter = options.retryAfter ?? null;
  }
}

// ─── Anti-Bot Errors ──────────────────────────────────────────────────────

export class AntiBotError extends OmniCrawlError {
  constructor(message, options = {}) {
    super(message, { code: 'ANTI_BOT', recoverable: false, ...options });
  }
}

export class CaptchaError extends AntiBotError {
  constructor(message, options = {}) {
    super(message, { code: 'CAPTCHA_REQUIRED', ...options });
    this.captchaType = options.captchaType ?? 'unknown';
  }
}

export class WafBlockError extends AntiBotError {
  constructor(message, options = {}) {
    super(message, { code: 'WAF_BLOCK', ...options });
    this.wafType = options.wafType ?? 'unknown';
  }
}

// ─── Parsing Errors ───────────────────────────────────────────────────────

export class ParsingError extends OmniCrawlError {
  constructor(message, options = {}) {
    super(message, { code: 'PARSING_ERROR', recoverable: false, ...options });
  }
}

export class ASTParsingError extends ParsingError {
  constructor(message, options = {}) {
    super(message, { code: 'AST_PARSE_ERROR', ...options });
  }
}

export class SelectorError extends ParsingError {
  constructor(message, options = {}) {
    super(message, { code: 'SELECTOR_ERROR', ...options });
    this.selector = options.selector ?? null;
  }
}

// ─── Validation Errors ────────────────────────────────────────────────────

export class ValidationError extends OmniCrawlError {
  constructor(message, options = {}) {
    super(message, { code: 'VALIDATION_ERROR', recoverable: false, ...options });
    this.field = options.field ?? null;
    this.value = options.value ?? null;
  }
}

export class SchemaValidationError extends ValidationError {
  constructor(message, options = {}) {
    super(message, { code: 'SCHEMA_VALIDATION_ERROR', ...options });
    this.errors = options.errors ?? [];
  }
}

// ─── Resource Errors ──────────────────────────────────────────────────────

export class ResourceError extends OmniCrawlError {
  constructor(message, options = {}) {
    super(message, { code: 'RESOURCE_ERROR', recoverable: true, ...options });
  }
}

export class BrowserPoolExhaustedError extends ResourceError {
  constructor(message, options = {}) {
    super(message, { code: 'BROWSER_POOL_EXHAUSTED', ...options });
  }
}

export class StorageError extends ResourceError {
  constructor(message, options = {}) {
    super(message, { code: 'STORAGE_ERROR', ...options });
  }
}

// ─── Configuration Errors ─────────────────────────────────────────────────

export class ConfigurationError extends OmniCrawlError {
  constructor(message, options = {}) {
    super(message, { code: 'CONFIGURATION_ERROR', recoverable: false, ...options });
  }
}

// ─── Reverse Engineering Errors ───────────────────────────────────────────

export class ReverseEngineeringError extends OmniCrawlError {
  constructor(message, options = {}) {
    super(message, { code: 'REVERSE_ERROR', recoverable: false, ...options });
  }
}

export class DeobfuscationError extends ReverseEngineeringError {
  constructor(message, options = {}) {
    super(message, { code: 'DEOBFUSCATION_ERROR', ...options });
  }
}

export class SandboxError extends ReverseEngineeringError {
  constructor(message, options = {}) {
    super(message, { code: 'SANDBOX_ERROR', ...options });
  }
}

// ─── Utility Functions ────────────────────────────────────────────────────

/**
 * Check if an error is recoverable (can retry).
 */
export function isRecoverableError(error) {
  return error instanceof OmniCrawlError && error.recoverable;
}

/**
 * Wrap a native error into OmniCrawl error.
 */
export function wrapError(error, ErrorClass = OmniCrawlError, options = {}) {
  if (error instanceof OmniCrawlError) return error;
  
  return new ErrorClass(error.message, {
    ...options,
    context: {
      ...options.context,
      originalError: error.name,
      originalStack: error.stack,
    },
  });
}

/**
 * Create error from HTTP response.
 */
export function createHttpError(response, options = {}) {
  const { status, statusText, url } = response;
  const message = `HTTP ${status} ${statusText} for ${url}`;
  
  if (status === 429) {
    return new RateLimitError(message, { ...options, context: { url, status } });
  }
  
  return new HttpError(message, status, { ...options, context: { url, status } });
}
