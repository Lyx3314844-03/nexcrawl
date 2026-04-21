import { HttpCrawler } from '../api/crawler-presets.js';
import { getLogger } from '../utils/logger.js';
import { SocksProxyAgent } from 'socks-proxy-agent';

const logger = getLogger('tor-crawler');

/**
 * Tor 匿名爬虫
 * 场景：暗网抓取、高匿名性采集、绕过 IP 封禁
 */
export class TorCrawler extends HttpCrawler {
  constructor(options = {}) {
    super(options);
    this.torProxy = options.torProxy || 'socks5h://127.0.0.1:9050';
  }

  /**
   * 重写请求逻辑，强制走 Tor 代理
   */
  async _fetch(url, options) {
    const agent = new SocksProxyAgent(this.torProxy);
    logger.debug(`Fetching via Tor: ${url}`);
    
    return await super._fetch(url, {
      ...options,
      agent,
      timeout: 30000 // Tor 较慢，增加超时
    });
  }

  /**
   * 自动更换 Tor 身份 (New Identity)
   */
  async renewIdentity() {
    logger.info('Requesting new Tor identity...');
    // 逻辑：向 Tor Control Port 发送 'SIGNAL NEWNYM'
  }
}
