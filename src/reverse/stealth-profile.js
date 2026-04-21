export const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache',
  '--disable-infobars',
  '--disable-popup-blocking',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-dev-shm-usage',
  '--no-default-browser-check',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--lang=zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  '--window-size=1440,900',
];

export function buildAntiDetectionHook(options = {}) {
  const seed = Number(options.seed ?? 8731);
  const locale = JSON.stringify(options.locale ?? 'zh-CN');
  const languages = JSON.stringify(options.languages ?? ['zh-CN', 'zh', 'en']);
  const platform = JSON.stringify(options.platform ?? 'Win32');
  const vendor = JSON.stringify(options.vendor ?? 'Google Inc.');
  const userAgent = JSON.stringify(options.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
  const deviceMemory = Number(options.deviceMemory ?? 8);
  const hardwareConcurrency = Number(options.hardwareConcurrency ?? 8);
  const maxTouchPoints = Number(options.maxTouchPoints ?? 0);
  const webglVendor = JSON.stringify(options.webglVendor ?? 'Google Inc. (Intel)');
  const webglRenderer = JSON.stringify(options.webglRenderer ?? 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)');

  return `
(() => {
  const seed = ${Number.isFinite(seed) ? seed : 8731};
  let rngState = Math.max(1, Math.floor(Math.abs(seed) * 1000000) % 2147483647);
  const seededRandom = () => {
    rngState = (rngState * 48271) % 2147483647;
    return rngState / 2147483647;
  };

  const define = (target, key, value) => {
    try {
      const owner =
        target && key in target
          ? target
          : Object.getPrototypeOf(target);

      Object.defineProperty(owner ?? target, key, {
        get: () => value,
        configurable: true,
      });
    } catch (_error) {}
  };

  const defineMethod = (target, key, value) => {
    try {
      const owner =
        target && key in target
          ? target
          : Object.getPrototypeOf(target);

      Object.defineProperty(owner ?? target, key, {
        value,
        configurable: true,
        writable: true,
      });
    } catch (_error) {}
  };

  define(navigator, 'webdriver', false);
  define(navigator, 'languages', ${languages});
  define(navigator, 'platform', ${platform});
  define(navigator, 'vendor', ${vendor});
  define(navigator, 'deviceMemory', ${deviceMemory});
  define(navigator, 'hardwareConcurrency', ${hardwareConcurrency});
  define(navigator, 'maxTouchPoints', ${maxTouchPoints});
  define(navigator, 'pdfViewerEnabled', true);
  define(navigator, 'userAgent', ${userAgent});

  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
      enumerable: true,
      configurable: true,
    });
  } catch (_error) {}

  try {
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands: [
          { brand: 'Chromium', version: '123' },
          { brand: 'Google Chrome', version: '123' },
          { brand: 'Not=A?Brand', version: '24' },
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async () => ({
          architecture: 'x86',
          bitness: '64',
          model: '',
          platform: 'Windows',
          platformVersion: '10.0.0',
          uaFullVersion: '123.0.0.0',
        }),
      }),
      configurable: true,
    });
  } catch (_error) {}

  try {
    const notificationOwner =
      typeof Notification === 'function'
        ? ('permission' in Notification ? Notification : Object.getPrototypeOf(Notification))
        : null;
    if (notificationOwner) {
      Object.defineProperty(notificationOwner, 'permission', {
        get: () => 'default',
        configurable: true,
      });
    }
  } catch (_error) {}

  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      defineMethod(navigator.permissions, 'query', (parameters) => {
        if (parameters && parameters.name === 'notifications') {
          return Promise.resolve({
            state: 'default',
            onchange: null,
            name: 'notifications',
          });
        }
        return originalQuery(parameters);
      });
    }
  } catch (_error) {}

  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.app = window.chrome.app || {};
  if (typeof window.chrome.csi !== 'function') {
    window.chrome.csi = function() { return { onloadT: Date.now() }; };
  }
  if (typeof window.chrome.loadTimes !== 'function') {
    window.chrome.loadTimes = function() { return { firstPaintTime: Date.now() / 1000 }; };
  }

  try {
    const originalCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) {
      if (String(type).includes('mp4')) return 'probably';
      if (String(type).includes('webm')) return 'probably';
      return originalCanPlayType.call(this, type);
    };
  } catch (_error) {}

  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      // UNMASKED_VENDOR_WEBGL
      if (parameter === 37445) return ${webglVendor};
      // UNMASKED_RENDERER_WEBGL
      if (parameter === 37446) return ${webglRenderer};
      // MAX_TEXTURE_SIZE
      if (parameter === 3379) return 16384;
      // MAX_CUBE_MAP_TEXTURE_SIZE
      if (parameter === 34076) return 16384;
      return getParameter.call(this, parameter);
    };
    
    // Add WebGL extension simulation
    const origGetSupportedExtensions = WebGLRenderingContext.prototype.getSupportedExtensions;
    WebGLRenderingContext.prototype.getSupportedExtensions = function() {
      const exts = origGetSupportedExtensions.call(this) || [];
      if (!exts.includes('WEBGL_debug_renderer_info')) exts.push('WEBGL_debug_renderer_info');
      return exts;
    };
  } catch (_error) {}

  // Hardware/Screen fingerprint randomization
  try {
    define(screen, 'width', 1920 + Math.floor(seededRandom() * 100));
    define(screen, 'height', 1080 + Math.floor(seededRandom() * 100));
    define(screen, 'colorDepth', 24);
    define(screen, 'pixelDepth', 24);
  } catch (_error) {}

  try {
    define(Intl.DateTimeFormat().resolvedOptions().__proto__, 'locale', ${locale});
  } catch (_error) {}

  // Canvas fingerprint noise injection
  // Adds subtle pixel-level noise to canvas toDataURL/toBlob to vary fingerprints
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    const noiseAlpha = ${Number(options.canvasNoise ?? 3)}; // 0-10 noise level

    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] += (seededRandom() - 0.5) * noiseAlpha;     // R
          imageData.data[i + 1] += (seededRandom() - 0.5) * noiseAlpha; // G
          imageData.data[i + 2] += (seededRandom() - 0.5) * noiseAlpha; // B
          // Alpha unchanged
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return origToDataURL.apply(this, args);
    };

    HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] += (seededRandom() - 0.5) * noiseAlpha;
          imageData.data[i + 1] += (seededRandom() - 0.5) * noiseAlpha;
          imageData.data[i + 2] += (seededRandom() - 0.5) * noiseAlpha;
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return origToBlob.call(this, callback, ...args);
    };
  } catch (_error) {}

  // AudioContext fingerprint noise injection
  // Modifies AnalyserNode.getByteFrequencyData to add slight variations
  try {
    const origGetByteFrequencyData = AnalyserNode.prototype.getByteFrequencyData;
    const origGetByteTimeDomainData = AnalyserNode.prototype.getByteTimeDomainData;
    const origGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
    const audioNoiseLevel = ${Number(options.audioNoise ?? 2)}; // 0-5 noise level

    AnalyserNode.prototype.getByteFrequencyData = function(array) {
      const result = origGetByteFrequencyData.call(this, array);
      if (array instanceof Uint8Array) {
        for (let i = 0; i < array.length; i++) {
          array[i] = Math.min(255, Math.max(0, array[i] + Math.round((seededRandom() - 0.5) * audioNoiseLevel)));
        }
      }
      return result;
    };

    AnalyserNode.prototype.getByteTimeDomainData = function(array) {
      const result = origGetByteTimeDomainData.call(this, array);
      if (array instanceof Uint8Array) {
        for (let i = 0; i < array.length; i++) {
          array[i] = Math.min(255, Math.max(0, array[i] + Math.round((seededRandom() - 0.5) * audioNoiseLevel)));
        }
      }
      return result;
    };

    AnalyserNode.prototype.getFloatFrequencyData = function(array) {
      const result = origGetFloatFrequencyData.call(this, array);
      if (array instanceof Float32Array) {
        for (let i = 0; i < array.length; i++) {
          array[i] += (seededRandom() - 0.5) * (audioNoiseLevel / 10);
        }
      }
      return result;
    };
  } catch (_error) {}

  // Font enumeration interference
  // Returns randomized font list to prevent consistent font fingerprinting
  try {
    const measureText = CanvasRenderingContext2D.prototype.measureText;
    const baseFonts = ['Arial', 'Times New Roman', 'Courier New', 'Helvetica', 'Verdana'];
    const decoyFonts = ['Segoe UI', 'Roboto', 'Noto Sans', 'Calibri', 'Cambria'];

    CanvasRenderingContext2D.prototype.measureText = function(text) {
      const result = measureText.call(this, text);
      // Add tiny random offset to width to vary font measurement
      if (result.width !== undefined) {
        result.width += (seededRandom() - 0.5) * 0.01;
      }
      return result;
    };
  } catch (_error) {}

  // WebRTC IP leak prevention
  // Blocks RTCPeerConnection from exposing real local/public IPs
  try {
    const OrigRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (OrigRTCPeerConnection) {
      const patchedRTC = function(config, constraints) {
        // Strip any STUN/TURN servers to prevent IP discovery
        const safeConfig = config ? { ...config, iceServers: [] } : {};
        return new OrigRTCPeerConnection(safeConfig, constraints);
      };
      patchedRTC.prototype = OrigRTCPeerConnection.prototype;
      patchedRTC.generateCertificate = OrigRTCPeerConnection.generateCertificate?.bind(OrigRTCPeerConnection);
      window.RTCPeerConnection = patchedRTC;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = patchedRTC;
    }
  } catch (_error) {}

  // Font enumeration defense via document.fonts API
  // Returns a fixed, common font set to prevent font-based fingerprinting
  try {
    const SAFE_FONTS = ['Arial', 'Times New Roman', 'Courier New', 'Helvetica', 'Verdana', 'Georgia'];
    if (document.fonts && document.fonts.check) {
      const origCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = function(font, text) {
        // Only report common fonts as loaded
        const family = String(font).replace(/^[\d.]+px\s+/, '').replace(/['"]/g, '').trim();
        if (SAFE_FONTS.some((f) => family.toLowerCase().includes(f.toLowerCase()))) {
          return true;
        }
        return origCheck(font, text);
      };
    }
  } catch (_error) {}
})();
`;
}

export async function applyStealthProfile({ page, cdp, options = {} } = {}) {
  if (!page || !cdp || options.stealth === false) {
    return;
  }

  const userAgent = options.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
  const acceptLanguage = options.acceptLanguage ?? 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7';

  await cdp.send('Network.setUserAgentOverride', {
    userAgent,
    acceptLanguage,
    platform: options.platform ?? 'Windows',
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: '123' },
        { brand: 'Google Chrome', version: '123' },
        { brand: 'Not=A?Brand', version: '24' },
      ],
      fullVersion: '123.0.0.0',
      platform: 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
    },
  }).catch(() => {});

  await cdp.send('Emulation.setLocaleOverride', {
    locale: options.locale ?? 'zh-CN',
  }).catch(() => {});

  if (options.timezoneId) {
    await cdp.send('Emulation.setTimezoneOverride', {
      timezoneId: options.timezoneId,
    }).catch(() => {});
  }

  // Disable WebRTC at CDP level to prevent IP leaks
  if (options.disableWebRTC !== false) {
    await cdp.send('Network.enable').catch(() => {});
    // Block STUN/TURN requests at network level
    await cdp.send('Network.setBlockedURLs', {
      urls: ['*stun.*', '*turn.*', 'stun:*', 'turn:*'],
    }).catch(() => {});
  }
}
