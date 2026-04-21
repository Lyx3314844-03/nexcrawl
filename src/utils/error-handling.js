/**
 * Error Handling Utilities — Wrap functions with consistent error handling.
 */

import { wrapError, ReverseEngineeringError, ParsingError, ValidationError } from '../errors.js';

/**
 * Wrap a function to catch and convert errors to OmniCrawl errors.
 */
export function withErrorHandling(fn, ErrorClass = ReverseEngineeringError, options = {}) {
  return function(...args) {
    try {
      const result = fn.apply(this, args);
      if (result instanceof Promise) {
        return result.catch((error) => {
          throw wrapError(error, ErrorClass, options);
        });
      }
      return result;
    } catch (error) {
      throw wrapError(error, ErrorClass, options);
    }
  };
}

/**
 * Wrap async function with error handling.
 */
export function withAsyncErrorHandling(fn, ErrorClass = ReverseEngineeringError, options = {}) {
  return async function(...args) {
    try {
      return await fn.apply(this, args);
    } catch (error) {
      throw wrapError(error, ErrorClass, options);
    }
  };
}

/**
 * Safe execution with fallback value.
 */
export function safeExecute(fn, fallback = null, options = {}) {
  const logError = options.logError ?? false;
  
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.catch((error) => {
        if (logError) console.error('Safe execution failed:', error);
        return fallback;
      });
    }
    return result;
  } catch (error) {
    if (logError) console.error('Safe execution failed:', error);
    return fallback;
  }
}

/**
 * Retry function with exponential backoff.
 */
export async function withRetry(fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelay = options.baseDelay ?? 1000;
  const maxDelay = options.maxDelay ?? 10000;
  const shouldRetry = options.shouldRetry ?? ((error) => error.recoverable);
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Execute with timeout.
 */
export async function withTimeout(fn, timeoutMs, options = {}) {
  const timeoutError = options.timeoutError ?? new ReverseEngineeringError('Operation timed out', {
    code: 'TIMEOUT',
    context: { timeoutMs },
  });
  
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(timeoutError), timeoutMs)),
  ]);
}

/**
 * Batch error collection for multiple operations.
 */
export async function collectErrors(operations) {
  const results = [];
  const errors = [];
  
  for (const [index, op] of operations.entries()) {
    try {
      const result = await op();
      results.push({ index, success: true, result });
    } catch (error) {
      errors.push({ index, error });
      results.push({ index, success: false, error });
    }
  }
  
  return { results, errors, hasErrors: errors.length > 0 };
}
