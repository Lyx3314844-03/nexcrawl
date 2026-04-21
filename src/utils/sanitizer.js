/**
 * Sanitizer - Redact sensitive data from logs and outputs
 */

const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'cookie',
  'session',
  'private',
  'credential',
];

const REDACTED = '***REDACTED***';

/**
 * Sanitize an object by redacting sensitive fields
 * @param {any} obj - Object to sanitize
 * @param {number} maxDepth - Maximum recursion depth
 * @returns {any} Sanitized object
 */
export function sanitize(obj, maxDepth = 10) {
  if (maxDepth <= 0) return '[Max Depth Reached]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => sanitize(item, maxDepth - 1));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some(s => lowerKey.includes(s));

    if (isSensitive) {
      sanitized[key] = REDACTED;
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitize(value, maxDepth - 1);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Sanitize a string by redacting sensitive patterns
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string
 */
export function sanitizeString(str) {
  if (typeof str !== 'string') return str;

  // Redact common patterns
  return str
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***REDACTED***')
    .replace(/token[=:]\s*[A-Za-z0-9._-]+/gi, 'token=***REDACTED***')
    .replace(/apikey[=:]\s*[A-Za-z0-9._-]+/gi, 'apikey=***REDACTED***')
    .replace(/password[=:]\s*\S+/gi, 'password=***REDACTED***');
}

/**
 * Sanitize HTTP headers
 * @param {Object} headers - Headers object
 * @returns {Object} Sanitized headers
 */
export function sanitizeHeaders(headers) {
  const sanitized = { ...headers };
  const sensitiveHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];

  for (const key of Object.keys(sanitized)) {
    if (sensitiveHeaders.includes(key.toLowerCase())) {
      sanitized[key] = REDACTED;
    }
  }

  return sanitized;
}

/**
 * Sanitize URL by removing sensitive query parameters
 * @param {string} url - URL to sanitize
 * @returns {string} Sanitized URL
 */
export function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    const sensitiveParams = ['token', 'apikey', 'api_key', 'password', 'secret'];

    for (const param of sensitiveParams) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, REDACTED);
      }
    }

    return parsed.toString();
  } catch {
    return url;
  }
}
