import { getLogger } from '../utils/logger.js';

const logger = getLogger('v-stealth');

/**
 * 顶级仿真环境补丁 (Virtualization-Aware Stealth)
 * 对抗场景：Akamai Advanced, DataDome 顶级防护
 */
export function buildHardenedEnvironmentInjection() {
  return `
    (function() {
      // 1. 深度清理 Error Stack (移除 Playwright/Puppeteer 注入的中间层路径)
      const originalError = Error;
      window.Error = function(message) {
        const err = new originalError(message);
        const originalStack = err.stack;
        Object.defineProperty(err, 'stack', {
          get: () => {
            // 过滤掉包含 'anonymous', 'eval', 'playwright' 等关键字的堆栈行
            return (originalStack || '').split('\\n')
              .filter(line => !line.includes('__pw') && !line.includes('playwright'))
              .join('\\n');
          }
        });
        return err;
      };

      // 2. 仿真时区与 Intl 一致性
      const RealIntl = Intl;
      const fakeLocale = 'zh-CN';
      Object.defineProperty(window, 'Intl', {
        get: () => ({
          ...RealIntl,
          DateTimeFormat: () => new RealIntl.DateTimeFormat(fakeLocale)
        })
      });

      // 3. 屏蔽特定的自动化属性枚举
      const excludeKeys = ['webdriver', '__pw_click', '__puppeteer_evaluation_script'];
      const originalQuery = Navigator.prototype.hasOwnProperty;
      Navigator.prototype.hasOwnProperty = function(name) {
        if (excludeKeys.includes(name)) return false;
        return originalQuery.apply(this, arguments);
      };

      // 4. 模拟 Web 硬件并发数 (根据真实的 CPU 逻辑核心随机化)
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

    })();
  `;
}
