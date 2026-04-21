/**
 * App/Mobile WebView Simulation Module
 *
 * Simulates in-app WebView environments for popular apps
 * (WeChat, Douyin, Taobao, etc.) to scrape data that is only
 * accessible within app webviews.
 *
 * Features:
 * - JSBridge simulation (window.Android, window.WebView, etc.)
 * - App-specific fingerprint injection
 * - Mobile WebView UA spoofing
 * - Native API mocking
 */

import { addInitScriptCompat, setUserAgentCompat, setViewportCompat } from '../runtime/browser-page-compat.js';

/**
 * Common App WebView environments
 */
const APP_WEBVIEW_PROFILES = {
  // WeChat WebView
  'wechat': {
    name: 'WeChat',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 MMWEBID/1234 MicroMessenger/8.0.44 WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
    jsBridge: 'WeixinJSBridge',
    jsBridgeCode: `
(() => {
  // WeChat JSBridge simulation
  window.WeixinJSBridge = window.WeixinJSBridge || {};
  window.WeixinJSBridge.invoke = function(name, params, callback) {
    console.log('[WeixinJSBridge] invoke:', name, params);
    if (typeof callback === 'function') {
      callback({ err_msg: 'ok', result: null });
    }
  };
  window.WeixinJSBridge.call = function(name, params, callback) {
    this.invoke(name, params, callback);
  };
  window.WeixinJSBridge.on = function(name, callback) {
    console.log('[WeixinJSBridge] on:', name);
  };
  window.WeixinJSBridgeReady = true;
  document.dispatchEvent(new Event('WeixinJSBridgeReady'));

  // WeChat specific navigator properties
  Object.defineProperty(navigator, 'app', {
    get: () => 'WeChat',
    configurable: true,
  });
  Object.defineProperty(navigator, 'micromessenger', {
    get: () => true,
    configurable: true,
  });
})();
`,
  },

  // Douyin (TikTok China) WebView
  'douyin': {
    name: 'Douyin',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 aweme/110800 app_name/douyin_ios',
    jsBridge: 'WebViewJavascriptBridge',
    jsBridgeCode: `
(() => {
  // Douyin JSBridge simulation
  window.WebViewJavascriptBridge = window.WebViewJavascriptBridge || {
    send: function(data, responseCallback) {
      console.log('[Douyin Bridge] send:', data);
      if (typeof responseCallback === 'function') {
        responseCallback({ status: 'success' });
      }
    },
    registerHandler: function(name, handler) {
      console.log('[Douyin Bridge] registerHandler:', name);
      this[name] = handler;
    },
    callHandler: function(name, data, responseCallback) {
      console.log('[Douyin Bridge] callHandler:', name, data);
      if (typeof responseCallback === 'function') {
        responseCallback({ result: null });
      }
    },
  };

  // Douyin specific globals
  window.tt = window.tt || {};
  window.tt.miniProgram = {
    getEnv: function(callback) {
      callback({ isDouyin: true });
    },
  };
})();
`,
  },

  // Taobao WebView
  'taobao': {
    name: 'Taobao',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 AliApp(TB/10.38.0) WindVane/8.5.0',
    jsBridge: 'WindVane',
    jsBridgeCode: `
(() => {
  // Taobao WindVane bridge
  window.WindVane = window.WindVane || {
    call: function(api, params, successCallback, errorCallback) {
      console.log('[WindVane] call:', api, params);
      if (typeof successCallback === 'function') {
        successCallback({ result: 'success' });
      }
    },
    isAvailable: true,
  };

  window.WindVaneBase = window.WindVaneBase || {
    version: '8.5.0',
  };

  // Taobao specific globals
  window.Ali = window.Ali || {};
  window.Ali.App = {
    getAppVersion: function() { return '10.38.0'; },
    getDeviceInfo: function() { return { platform: 'android' }; },
  };
})();
`,
  },

  // Android generic WebView
  'android-webview': {
    name: 'Android WebView',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36',
    jsBridge: 'Android',
    jsBridgeCode: `
(() => {
  // Android @JavascriptInterface bridge
  window.Android = window.Android || {
    showToast: function(msg) { console.log('[Android] showToast:', msg); },
    getDeviceId: function() { return 'android-device-12345'; },
    getUserId: function() { return 'user-001'; },
    getToken: function() { return 'android-auth-token'; },
    callNative: function(method, args) {
      console.log('[Android] callNative:', method, args);
      return JSON.stringify({ success: true });
    },
  };

  // Add @JavascriptInterface simulation
  Object.defineProperty(window, 'JSBridge', {
    value: {
      postMessage: function(msg) {
        console.log('[JSBridge] postMessage:', msg);
      },
    },
    configurable: true,
  });
})();
`,
  },

  // iOS WKWebView
  'ios-wkwebview': {
    name: 'iOS WKWebView',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    jsBridge: 'webkit',
    jsBridgeCode: `
(() => {
  // iOS WKWebView message handler
  window.webkit = window.webkit || {
    messageHandlers: {
      appHandler: {
        postMessage: function(msg) {
          console.log('[WKWebView] postMessage:', msg);
        },
      },
    },
  };

  // iOS specific navigator properties
  Object.defineProperty(navigator, 'standalone', {
    get: () => false,
    configurable: true,
  });

  // iOS clipboard access simulation
  document.execCommand = (function(original) {
    return function(command, ...args) {
      if (command === 'copy' || command === 'paste') {
        console.log('[WKWebView] execCommand:', command);
        return true;
      }
      return original.apply(document, [command, ...args]);
    };
  })(document.execCommand);
})();
`,
  },

  // JD (Jingdong) WebView
  'jd': {
    name: 'JD App',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 JD4Android/12.0.0',
    jsBridge: 'JDAppNative',
    jsBridgeCode: `
(() => {
  // JD JSBridge
  window.JDAppNative = window.JDAppNative || {
    base: {
      getDeviceInfo: function() { return { platform: 'android', version: '12.0.0' }; },
      getLocation: function(callback) { callback({ lat: 39.9, lng: 116.4 }); },
    },
    user: {
      getUserInfo: function(callback) { callback({ pin: 'jd_user', token: 'jd_token' }); },
    },
  };
})();
`,
  },
};

/**
 * Get app WebView profile by name
 */
export function getAppWebViewProfile(appName) {
  const name = String(appName).toLowerCase().replace(/[\s-]+/g, '-');
  return APP_WEBVIEW_PROFILES[name] ?? null;
}

/**
 * Get all available app WebView profiles
 */
export function getAvailableWebViewProfiles() {
  return Object.entries(APP_WEBVIEW_PROFILES).map(([key, profile]) => ({
    id: key,
    name: profile.name,
    userAgent: profile.userAgent.slice(0, 60) + '...',
    jsBridge: profile.jsBridge,
  }));
}

/**
 * Build JSBridge injection code for a specific app
 * @param {string} appName - App name
 * @param {Object} customizations - Custom overrides
 * @returns {string} JavaScript code to inject
 */
export function buildJSBridgeInjection(appName, customizations = {}) {
  const profile = getAppWebViewProfile(appName);
  if (!profile) {
    throw new Error(`Unknown app WebView profile: ${appName}`);
  }

  let code = profile.jsBridgeCode;

  // Apply customizations
  if (customizations.deviceId) {
    code = code.replace(/android-device-12345/g, customizations.deviceId);
  }
  if (customizations.userId) {
    code = code.replace(/user-001/g, customizations.userId);
  }
  if (customizations.token) {
    code = code.replace(/android-auth-token/g, customizations.token);
  }
  if (customizations.userAgent) {
    // UA is set via CDP, not injected code
  }

  return code;
}

/**
 * Inject app WebView environment into Puppeteer page
 * @param {Object} page - Puppeteer page object
 * @param {string} appName - App name
 * @param {Object} options - Options
 */
export async function injectAppWebView(page, appName, options = {}) {
  const profile = getAppWebViewProfile(appName);
  if (!profile) {
    throw new Error(`Unknown app WebView profile: ${appName}`);
  }

  // Set user agent
  await setUserAgentCompat(page, options.userAgent ?? profile.userAgent);

  // Set viewport to mobile
  const viewport = options.viewport ?? { width: 375, height: 812 }; // iPhone dimensions
  await setViewportCompat(page, viewport);

  // Inject JSBridge
  const jsBridgeCode = buildJSBridgeInjection(appName, options);
  await addInitScriptCompat(page, jsBridgeCode);

  // Set additional properties
  if (options.extraGlobals) {
    await addInitScriptCompat(page, (globals) => {
      for (const [key, value] of Object.entries(globals)) {
        window[key] = value;
      }
    }, options.extraGlobals);
  }

  return {
    app: profile.name,
    userAgent: profile.userAgent,
    jsBridge: profile.jsBridge,
    viewport,
  };
}

/**
 * Create a complete mobile app scraping configuration
 * @param {string} appName - App name
 * @param {Object} options - Options
 * @returns {Object} Complete configuration
 */
export function createAppScrapeConfig(appName, options = {}) {
  const profile = getAppWebViewProfile(appName);
  if (!profile) {
    throw new Error(`Unknown app WebView profile: ${appName}`);
  }

  return {
    browser: {
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=375,812',
      ],
    },
    emulate: {
      userAgent: profile.userAgent,
      viewport: {
        width: 375,
        height: 812,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        isLandscape: false,
      },
    },
    injection: {
      jsBridgeCode: profile.jsBridgeCode,
      app: profile.name,
      jsBridgeName: profile.jsBridge,
    },
    ...options,
  };
}

/**
 * Detect which app WebView the current page is running in
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<Object|null>} Detected app info
 */
export async function detectAppWebView(page) {
  const appInfo = await page.evaluate(() => {
    // Check WeChat
    if (window.WeixinJSBridge || navigator.micromessenger) {
      return { app: 'wechat', name: 'WeChat' };
    }

    // Check Douyin
    if (window.WebViewJavascriptBridge && window.tt) {
      return { app: 'douyin', name: 'Douyin' };
    }

    // Check Taobao
    if (window.WindVane && window.Ali) {
      return { app: 'taobao', name: 'Taobao' };
    }

    // Check JD
    if (window.JDAppNative) {
      return { app: 'jd', name: 'JD' };
    }

    // Check generic Android WebView
    if (window.Android || window.JSBridge) {
      return { app: 'android-webview', name: 'Android WebView' };
    }

    // Check iOS WKWebView
    if (window.webkit?.messageHandlers) {
      return { app: 'ios-wkwebview', name: 'iOS WKWebView' };
    }

    return null;
  });

  return appInfo;
}

export {
  APP_WEBVIEW_PROFILES,
};
