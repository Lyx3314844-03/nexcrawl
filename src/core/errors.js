import { OmniCrawlError } from '../errors.js';

export class AppError extends OmniCrawlError {
  constructor(statusCode, message, details = undefined, options = {}) {
    super(message, {
      code: options.code ?? `HTTP_${statusCode}`,
      context: options.context ?? details ?? {},
      recoverable: options.recoverable ?? statusCode < 500,
    });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }
}
