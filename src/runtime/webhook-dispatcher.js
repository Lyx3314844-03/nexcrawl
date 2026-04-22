import { getLogger } from '../utils/logger.js';
import { fetch } from 'undici';

const logger = getLogger('webhook-dispatcher');

/**
 * 实时事件分发器
 * 场景：将抓取事件实时同步给下游系统 (ERP/搜索/分析)
 */
export class WebhookDispatcher {
  constructor(endpoint, options = {}) {
    this.endpoint = endpoint;
    this.secret = options.secret; // HMAC 签名校验
    this.maxRetries = options.maxRetries || 3;
  }

  /**
   * 发送事件
   * @param {string} eventName 事件名 (job.finished, data.found)
   * @param {object} payload 载荷
   */
  async dispatch(eventName, payload) {
    logger.info(`Dispatching webhook event: ${eventName}`, { url: this.endpoint });

    const body = JSON.stringify({
      event: eventName,
      timestamp: new Date().toISOString(),
      data: payload
    });

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      logger.debug('Webhook delivered successfully');
    } catch (error) {
      logger.error('Webhook delivery failed', { error: error.message });
      // 补齐点：集成框架已有的重试策略
    }
  }
}
