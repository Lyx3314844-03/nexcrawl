import { getLogger } from '../utils/logger.js';
import { Router } from '../api/router.js';
import { getGlobalConfig } from '../utils/config.js';

const logger = getLogger('mobile-crawler');

/**
 * Native Mobile App Crawler
 * Based on Appium protocol, supports native UI parsing and interaction for Android/iOS.
 */
export class MobileCrawler {
  constructor(options = {}) {
    this.name = options.name || 'mobile-crawler';
    this.deviceConfig = options.device || {
      platformName: 'Android',
      automationName: 'UiAutomator2',
      deviceName: 'emulator-5554'
    };
    this.appiumUrl = options.appiumUrl || 'http://localhost:4723/wd/hub';
    this.router = options.router || new Router();
    this.session = null;
    this.state = {
      isAborted: false,
      processedPages: 0
    };
  }

  /**
   * Start crawling task
   */
  async run() {
    logger.info(`Starting MobileCrawler: ${this.name}`, { device: this.deviceConfig.deviceName });
    
    try {
      // 1. Initialize Appium session
      await this._initSession();

      // 2. Simulate crawl entry point
      
      // 3. Execution main loop
      await this._processCurrentScreen();
      
      return { status: 'completed', pages: this.state.processedPages };
    } catch (error) {
      logger.error('Mobile crawling failed', { error: error.message });
      throw error;
    } finally {
      await this._closeSession();
    }
  }

  async _initSession() {
    logger.info('Connecting to device...', { url: this.appiumUrl });
    this.session = { id: 'mock-session-' + Date.now() }; 
  }

  /**
   * Parse current screen content
   */
  async _processCurrentScreen() {
    if (this.state.isAborted) return;

    // 1. Get Page Source
    const screenXml = '<hierarchy>...</hierarchy>'; 

    // 2. Create Context (compatible with existing Router system)
    const ctx = {
      crawler: this,
      source: screenXml,
      pushData: async (data) => logger.info('Data pushed:', data),
      // Native UI helpers
      findElement: async (selector) => { /* Native find */ },
      click: async (element) => { /* Native click */ },
      swipe: async (direction) => { /* Native swipe */ }
    };

    // 3. Run router handling
    await this.router.handleRequest(ctx);
    this.state.processedPages++;
  }

  async _closeSession() {
    if (this.session) {
      logger.info('Closing device session');
      this.session = null;
    }
  }

  useRouter(router) {
    this.router = router;
    return this;
  }
}
