import { getLogger } from '../utils/logger.js';

const logger = getLogger('mfa-handler');

/**
 * MFA 自动化处理
 * 场景：登录时自动获取短信/邮件验证码
 */
export class MfaHandler {
  constructor(options = {}) {
    this.provider = options.provider; // 如 'sms-activate', 'imap'
    this.config = options.config;
  }

  /**
   * 获取最新验证码
   * @param {string} filter 过滤条件，如 "google", "facebook"
   */
  async getCode(filter) {
    logger.info(`Waiting for MFA code for ${filter}...`);
    
    // 逻辑：轮询短信平台或 IMAP 邮箱
    if (this.provider === 'imap') {
      return await this._fetchFromEmail(filter);
    }
    
    return "123456"; // 模拟
  }

  async _fetchFromEmail(filter) {
    // 补齐点：集成 node-imap，解析邮件正文并提取 6 位数字
    return "mock-email-code";
  }
}

/**
 * 快捷配置：在 Crawler 登录流程中使用
 */
export async function solveLoginMfa(page, mfaHandler, inputSelector) {
  const code = await mfaHandler.getCode();
  await page.fill(inputSelector, code);
  await page.click('button[type="submit"]');
}
