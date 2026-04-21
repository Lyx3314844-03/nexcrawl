import { PluginManager } from './plugin-manager.js';

/**
 * MiddlewareManager extends PluginManager to provide a more structured 
 * request/response lifecycle pipeline, similar to Scrapy or Crawlee.
 */
export class MiddlewareManager extends PluginManager {
  /**
   * Run 'beforeRequest' hooks. Can modify headers, proxies, or cancel requests.
   */
  async processRequest(payload) {
    return this.runHook('beforeRequest', payload);
  }

  /**
   * Run 'afterResponse' hooks. Can inspect results, handle WAF, or trigger retries.
   */
  async processResponse(payload) {
    return this.runHook('afterResponse', payload);
  }

  /**
   * Run 'onError' hooks. For specialized error reporting or recovery.
   */
  async processError(payload) {
    return this.runHook('onError', payload);
  }

  /**
   * Run 'afterExtract' hooks. For post-processing extracted data.
   */
  async processExtraction(payload) {
    return this.runHook('afterExtract', payload);
  }
}
