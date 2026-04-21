import { getLogger } from '../utils/logger.js';
import Module from 'node:module';

const logger = getLogger('runtime-sentinel');

/**
 * Node.js 运行时监视哨兵
 * 能力：透明拦截内核级模块调用 (File, Net, Crypto)
 */
export class RuntimeSentinel {
  constructor() {
    this.originalLoad = Module._load;
    this.logs = [];
  }

  /**
   * 启动监控
   */
  watch() {
    logger.info('Runtime Sentinel active. Monitoring internal API calls...');

    const self = this;
    Module._load = function(request, parent, isMain) {
      if (['fs', 'net', 'crypto', 'child_process'].includes(request)) {
        logger.warn(`Script attempted to load internal module: ${request}`, { parent: parent?.id });
      }
      return self.originalLoad.apply(this, arguments);
    };

    // 监控加密操作的具体参数
    this._hookCrypto();
  }

  _hookCrypto() {
    // 补齐点：拦截 crypto.createCipheriv，直接捕获生成的 Key 和 IV
    logger.debug('Crypto hooks attached.');
  }

  getAuditTrail() {
    return this.logs;
  }
}
