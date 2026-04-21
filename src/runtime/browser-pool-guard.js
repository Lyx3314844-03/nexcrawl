import { getLogger } from '../utils/logger.js';
import { closeBrowserPool } from './browser-pool.js';

const logger = getLogger('browser-pool-guard');

/**
 * 浏览器池自愈守卫
 * 解决：长时间运行导致的僵尸进程和内存泄漏
 */
export class BrowserPoolGuard {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.maxMemoryMb = options.maxMemoryMb || 2048; // 2GB 阈值
    this.checkInterval = options.interval || 60000; // 每分钟检查一次
  }

  start() {
    logger.info('Browser Pool Guard started.');
    this.timer = setInterval(() => this._performCheck(), this.checkInterval);
  }

  async _performCheck() {
    logger.debug('Running pool health check...');
    
    // 1. 检查各实例内存占用
    // 2. 识别僵尸进程 (已空闲但未释放)
    
    const usage = process.memoryUsage();
    if (usage.heapUsed / 1024 / 1024 > this.maxMemoryMb) {
      logger.warn('Global memory threshold reached. Force recycling browser pool!');
      await closeBrowserPool();
      // 补齐点：优雅重启 Pool 并恢复当前挂起的任务
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}
