/**
 * Fingerprint Consistency Manager
 *
 * Ensures TLS, HTTP/2, Canvas, and browser fingerprints
 * remain consistent across sessions and requests. Provides
 * fingerprint profiles that can be bound to sessions and
 * rotated on demand.
 */

import {
  getBrowserTLSProfile,
  calculateJA3,
  calculateJA4,
  BROWSER_PROFILES,
} from './tls-fingerprint.js';
import {
  getH2BrowserProfile,
  H2_BROWSER_PROFILES,
} from './http2-fingerprint.js';
import { getHeaderOrder } from './header-order.js';

/**
 * Generate a complete fingerprint profile
 */
export function generateFingerprintProfile(options = {}) {
  const {
    tlsProfile = 'chrome-latest',
    h2Profile = null,
    headerProfile = null,
    canvasNoise = 3,
    audioNoise = 2,
    webglVendor = 'Google Inc. (Intel)',
    webglRenderer = 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
    userAgent = null,
    locale = 'zh-CN',
    timezone = 'Asia/Shanghai',
    platform = 'Win32',
    screenResolution = { width: 1920, height: 1080 },
    deviceMemory = 8,
    hardwareConcurrency = 8,
    seed = null, // Optional seed for reproducibility
  } = options;

  const tls = getBrowserTLSProfile(tlsProfile) ?? BROWSER_PROFILES['chrome-latest'];
  const h2 = h2Profile ? getH2BrowserProfile(h2Profile) : getH2BrowserProfile(tlsProfile);
  const headerProfileName = headerProfile ?? tlsProfile;

  const ja3 = calculateJA3({
    tlsVersion: tls.tlsMaxVersion,
    ciphers: tls.ciphers,
    extensions: tls.extensions,
    groups: tls.groups,
    ecPointFormats: tls.ecPointFormats,
  });

  const ja4 = calculateJA4({
    tlsVersion: tls.tlsMaxVersion,
    alpn: tls.alpn,
    ciphers: tls.ciphers,
    extensions: tls.extensions,
  });

  const effectiveUA = userAgent ?? tls.name.includes('Chrome')
    ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    : tls.name.includes('Firefox')
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

  const profile = {
    id: seed ? `fp-${seed}` : `fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    tls: {
      profile: tls.name,
      ciphers: tls.ciphers,
      extensions: tls.extensions,
      groups: tls.groups,
      ja3,
      ja4,
    },
    http2: h2 ? {
      profile: h2.name,
      settings: h2.settings,
      pseudoHeaderOrder: h2.pseudoHeaderOrder,
    } : null,
    headers: {
      profile: headerProfileName,
      order: getHeaderOrder(headerProfileName),
    },
    browser: {
      userAgent: effectiveUA,
      locale,
      timezone,
      platform,
      screen: screenResolution,
      deviceMemory,
      hardwareConcurrency,
      webglVendor,
      webglRenderer,
      maxTouchPoints: platform === 'Win32' ? 0 : 5,
    },
    canvas: {
      noise: canvasNoise,
    },
    audio: {
      noise: audioNoise,
    },
  };

  return profile;
}

/**
 * Get all built-in fingerprint presets
 */
export function getFingerprintPresets() {
  return [
    {
      id: 'chrome-windows',
      name: 'Chrome on Windows',
      tlsProfile: 'chrome-latest',
      h2Profile: 'chrome-latest',
      headerProfile: 'chrome-latest',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      platform: 'Win32',
      screen: { width: 1920, height: 1080 },
    },
    {
      id: 'firefox-windows',
      name: 'Firefox on Windows',
      tlsProfile: 'firefox-latest',
      h2Profile: 'firefox-latest',
      headerProfile: 'firefox-latest',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
      platform: 'Win32',
      screen: { width: 1920, height: 1080 },
    },
    {
      id: 'safari-macos',
      name: 'Safari on macOS',
      tlsProfile: 'safari-latest',
      h2Profile: 'safari-latest',
      headerProfile: 'safari-latest',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      platform: 'MacIntel',
      screen: { width: 2560, height: 1600 },
    },
    {
      id: 'chrome-android',
      name: 'Chrome on Android',
      tlsProfile: 'chrome-latest',
      h2Profile: 'chrome-latest',
      headerProfile: 'chrome-latest',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
      platform: 'Linux armv8l',
      screen: { width: 1080, height: 2400 },
      maxTouchPoints: 5,
    },
    {
      id: 'safari-iphone',
      name: 'Safari on iPhone',
      tlsProfile: 'safari-latest',
      h2Profile: 'safari-latest',
      headerProfile: 'safari-latest',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      screen: { width: 393, height: 852 },
      maxTouchPoints: 5,
    },
  ];
}

/**
 * Build injection code from a fingerprint profile
 */
export function buildFingerprintInjection(profile) {
  const { browser, canvas, audio } = profile;

  return `
(() => {
  // User Agent is set via CDP, not here
  Object.defineProperty(navigator, 'platform', {
    get: () => ${JSON.stringify(browser.platform)},
    configurable: true,
  });
  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => ${browser.deviceMemory},
    configurable: true,
  });
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => ${browser.hardwareConcurrency},
    configurable: true,
  });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    get: () => ${browser.maxTouchPoints ?? 0},
    configurable: true,
  });

  // WebGL spoof
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return ${JSON.stringify(browser.webglVendor)};
      if (p === 37446) return ${JSON.stringify(browser.webglRenderer)};
      return getParameter.call(this, p);
    };
  } catch(_e) {}

  // Canvas noise
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] += (Math.random() - 0.5) * ${canvas.noise};
          imageData.data[i + 1] += (Math.random() - 0.5) * ${canvas.noise};
          imageData.data[i + 2] += (Math.random() - 0.5) * ${canvas.noise};
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return origToDataURL.apply(this, args);
    };
  } catch(_e) {}

  // Audio noise
  try {
    const origGetByteFrequencyData = AnalyserNode.prototype.getByteFrequencyData;
    AnalyserNode.prototype.getByteFrequencyData = function(arr) {
      const result = origGetByteFrequencyData.call(this, arr);
      if (arr instanceof Uint8Array) {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.min(255, Math.max(0, arr[i] + Math.round((Math.random() - 0.5) * ${audio.noise})));
        }
      }
      return result;
    };
  } catch(_e) {}
})();
`;
}
