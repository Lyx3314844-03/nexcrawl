/**
 * Input Validation and Security Hardening.
 * Validates user inputs to prevent injection attacks and sandbox escapes.
 */

import { ValidationError } from '../errors.js';
import { getGlobalConfig } from './config.js';

// ─── URL Validation ───────────────────────────────────────────────────────

export function validateUrl(url, options = {}) {
  const allowedProtocols = options.allowedProtocols ?? ['http:', 'https:'];
  const allowPrivateIPs = options.allowPrivateIPs ?? getGlobalConfig().get('security.validation.allowPrivateIPs') ?? false;
  
  try {
    const parsed = new URL(url);
    
    if (!allowedProtocols.includes(parsed.protocol)) {
      throw new ValidationError(`Protocol ${parsed.protocol} not allowed`, {
        field: 'url',
        value: url,
        context: { allowedProtocols },
      });
    }
    
    if (!allowPrivateIPs) {
      const hostname = parsed.hostname;
      if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|localhost$|0\.0\.0\.0$)/.test(hostname)) {
        throw new ValidationError('Private IP addresses not allowed', {
          field: 'url',
          value: url,
        });
      }
    }
    
    return parsed.href;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Invalid URL format', { field: 'url', value: url });
  }
}

// ─── Code Validation ──────────────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /require\s*\(\s*['"]fs['"]\s*\)/,
  /require\s*\(\s*['"]net['"]\s*\)/,
  /eval\s*\(/,
  /Function\s*\(/,
  /import\s*\(\s*['"][^'"]*['"]\s*\)/,
  /process\.exit/,
  /process\.kill/,
];

export function validateCode(code, options = {}) {
  const maxLength = options.maxLength ?? getGlobalConfig().get('security.validation.maxCodeLength') ?? 1000000; // 1MB
  const allowDangerousPatterns = options.allowDangerousPatterns ?? getGlobalConfig().get('security.validation.allowDangerousPatterns') ?? false;
  
  if (typeof code !== 'string') {
    throw new ValidationError('Code must be a string', { field: 'code', value: typeof code });
  }
  
  if (code.length > maxLength) {
    throw new ValidationError(`Code exceeds maximum length of ${maxLength}`, {
      field: 'code',
      value: code.length,
    });
  }
  
  if (!allowDangerousPatterns) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(code)) {
        throw new ValidationError('Code contains dangerous patterns', {
          field: 'code',
          context: { pattern: pattern.source },
        });
      }
    }
  }
  
  return code;
}

// ─── Selector Validation ──────────────────────────────────────────────────

export function validateSelector(selector, options = {}) {
  const maxLength = options.maxLength ?? 1000;
  
  if (typeof selector !== 'string') {
    throw new ValidationError('Selector must be a string', {
      field: 'selector',
      value: typeof selector,
    });
  }
  
  if (selector.length > maxLength) {
    throw new ValidationError(`Selector exceeds maximum length of ${maxLength}`, {
      field: 'selector',
      value: selector.length,
    });
  }
  
  // Basic CSS selector validation
  if (!/^[a-zA-Z0-9\s\-_#.\[\]="':,>+~*()]+$/.test(selector)) {
    throw new ValidationError('Selector contains invalid characters', {
      field: 'selector',
      value: selector,
    });
  }
  
  return selector;
}

// ─── Numeric Validation ───────────────────────────────────────────────────

export function validateNumber(value, options = {}) {
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  const integer = options.integer ?? false;
  
  const num = Number(value);
  
  if (isNaN(num) || !isFinite(num)) {
    throw new ValidationError('Value must be a valid number', {
      field: options.field ?? 'value',
      value,
    });
  }
  
  if (integer && !Number.isInteger(num)) {
    throw new ValidationError('Value must be an integer', {
      field: options.field ?? 'value',
      value,
    });
  }
  
  if (num < min || num > max) {
    throw new ValidationError(`Value must be between ${min} and ${max}`, {
      field: options.field ?? 'value',
      value,
      context: { min, max },
    });
  }
  
  return num;
}

// ─── Object Validation ────────────────────────────────────────────────────

export function validateObject(obj, schema) {
  if (typeof obj !== 'object' || obj === null) {
    throw new ValidationError('Value must be an object', { value: typeof obj });
  }
  
  const errors = [];
  
  for (const [key, rules] of Object.entries(schema)) {
    const value = obj[key];
    
    if (rules.required && value === undefined) {
      errors.push({ field: key, message: 'Field is required' });
      continue;
    }
    
    if (value === undefined) continue;
    
    if (rules.type && typeof value !== rules.type) {
      errors.push({ field: key, message: `Expected type ${rules.type}, got ${typeof value}` });
    }
    
    if (rules.validate && typeof rules.validate === 'function') {
      try {
        rules.validate(value);
      } catch (error) {
        errors.push({ field: key, message: error.message });
      }
    }
  }
  
  if (errors.length > 0) {
    throw new ValidationError('Object validation failed', { context: { errors } });
  }
  
  return obj;
}

// ─── Sanitization ─────────────────────────────────────────────────────────

export function sanitizeHtml(html) {
  return String(html)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

export function sanitizeFilename(filename) {
  return String(filename)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 255);
}

// ─── Rate Limiting ────────────────────────────────────────────────────────

class RateLimiter {
  constructor(options = {}) {
    this.maxRequests = options.maxRequests ?? 100;
    this.windowMs = options.windowMs ?? 60000; // 1 minute
    this.requests = new Map();
  }
  
  check(key) {
    const now = Date.now();
    const record = this.requests.get(key) ?? { count: 0, resetAt: now + this.windowMs };
    
    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + this.windowMs;
    }
    
    record.count++;
    this.requests.set(key, record);
    
    if (record.count > this.maxRequests) {
      throw new ValidationError('Rate limit exceeded', {
        context: { key, limit: this.maxRequests, resetAt: record.resetAt },
      });
    }
    
    return { remaining: this.maxRequests - record.count, resetAt: record.resetAt };
  }
  
  reset(key) {
    this.requests.delete(key);
  }
  
  clear() {
    this.requests.clear();
  }
}

export { RateLimiter };
