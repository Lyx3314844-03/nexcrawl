/**
 * Advanced Fingerprint Protection — Canvas, WebGL, AudioContext, Fonts
 *
 * Provides comprehensive anti-fingerprinting measures beyond basic stealth.
 * Use this when targeting sites with advanced fingerprinting detection.
 */

import { addInitScriptCompat } from '../runtime/browser-page-compat.js';

/**
 * Generate consistent but unique Canvas fingerprint noise.
 * Uses session seed to ensure same fingerprint within session.
 */
export function generateCanvasNoiseInjection(options = {}) {
  const noiseLevel = options.noiseLevel ?? 3; // 0-10
  const seed = options.seed ?? Math.random();
  
  return `
(() => {
  const seed = ${seed};
  const noiseLevel = ${noiseLevel};
  
  // Seeded random for consistency
  let rngState = seed * 9301 + 49297;
  const seededRandom = () => {
    rngState = (rngState * 9301 + 49297) % 233280;
    return rngState / 233280;
  };
  
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  
  const addNoise = (imageData) => {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (seededRandom() - 0.5) * noiseLevel;
      data[i] = Math.max(0, Math.min(255, data[i] + noise));     // R
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise)); // G
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise)); // B
    }
    return imageData;
  };
  
  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    const ctx = this.getContext('2d');
    if (ctx && this.width > 0 && this.height > 0) {
      try {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        addNoise(imageData);
        ctx.putImageData(imageData, 0, 0);
      } catch {}
    }
    return origToDataURL.apply(this, args);
  };
  
  HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
    const ctx = this.getContext('2d');
    if (ctx && this.width > 0 && this.height > 0) {
      try {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        addNoise(imageData);
        ctx.putImageData(imageData, 0, 0);
      } catch {}
    }
    return origToBlob.call(this, callback, ...args);
  };
  
  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const imageData = origGetImageData.apply(this, args);
    return addNoise(imageData);
  };
})();
`;
}

/**
 * Generate WebGL fingerprint protection.
 * Randomizes renderer info and adds noise to readPixels.
 */
export function generateWebGLProtection(options = {}) {
  const vendor = options.vendor ?? 'Google Inc. (Intel)';
  const renderer = options.renderer ?? 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)';
  const seed = options.seed ?? Math.random();
  
  return `
(() => {
  const seed = ${seed};
  let rngState = seed * 9301 + 49297;
  const seededRandom = () => {
    rngState = (rngState * 9301 + 49297) % 233280;
    return rngState / 233280;
  };
  
  // WebGL1
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return ${JSON.stringify(vendor)};
      if (parameter === 37446) return ${JSON.stringify(renderer)};
      if (parameter === 3379) return 16384; // MAX_TEXTURE_SIZE
      if (parameter === 34076) return 16384; // MAX_CUBE_MAP_TEXTURE_SIZE
      if (parameter === 34024) return 16; // MAX_VERTEX_ATTRIBS
      if (parameter === 34921) return 16; // MAX_VERTEX_UNIFORM_VECTORS
      if (parameter === 36347) return 32; // MAX_VARYING_VECTORS
      if (parameter === 36348) return 16; // MAX_FRAGMENT_UNIFORM_VECTORS
      if (parameter === 34930) return 16; // MAX_TEXTURE_IMAGE_UNITS
      return getParameter.call(this, parameter);
    };
    
    const origReadPixels = WebGLRenderingContext.prototype.readPixels;
    WebGLRenderingContext.prototype.readPixels = function(...args) {
      origReadPixels.apply(this, args);
      const pixels = args[6];
      if (pixels && pixels.length) {
        for (let i = 0; i < pixels.length; i++) {
          pixels[i] += (seededRandom() - 0.5) * 2;
        }
      }
    };
  } catch {}
  
  // WebGL2
  try {
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return ${JSON.stringify(vendor)};
      if (parameter === 37446) return ${JSON.stringify(renderer)};
      if (parameter === 3379) return 16384;
      if (parameter === 34076) return 16384;
      return getParameter2.call(this, parameter);
    };
    
    const origReadPixels2 = WebGL2RenderingContext.prototype.readPixels;
    WebGL2RenderingContext.prototype.readPixels = function(...args) {
      origReadPixels2.apply(this, args);
      const pixels = args[6];
      if (pixels && pixels.length) {
        for (let i = 0; i < pixels.length; i++) {
          pixels[i] += (seededRandom() - 0.5) * 2;
        }
      }
    };
  } catch {}
  
  // Shader precision
  try {
    const origGetShaderPrecisionFormat = WebGLRenderingContext.prototype.getShaderPrecisionFormat;
    WebGLRenderingContext.prototype.getShaderPrecisionFormat = function(shaderType, precisionType) {
      const result = origGetShaderPrecisionFormat.call(this, shaderType, precisionType);
      if (result) {
        return {
          rangeMin: result.rangeMin + Math.floor(seededRandom() * 2),
          rangeMax: result.rangeMax + Math.floor(seededRandom() * 2),
          precision: result.precision + Math.floor(seededRandom() * 2),
        };
      }
      return result;
    };
  } catch {}
})();
`;
}

/**
 * Generate AudioContext fingerprint protection.
 */
export function generateAudioContextProtection(options = {}) {
  const seed = options.seed ?? Math.random();
  
  return `
(() => {
  const seed = ${seed};
  let rngState = seed * 9301 + 49297;
  const seededRandom = () => {
    rngState = (rngState * 9301 + 49297) % 233280;
    return rngState / 233280;
  };
  
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    
    const origGetByteFrequencyData = AnalyserNode.prototype.getByteFrequencyData;
    const origGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
    const origGetByteTimeDomainData = AnalyserNode.prototype.getByteTimeDomainData;
    const origGetFloatTimeDomainData = AnalyserNode.prototype.getFloatTimeDomainData;
    
    const addNoiseToArray = (arr) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] += (seededRandom() - 0.5) * 0.1;
      }
    };
    
    AnalyserNode.prototype.getByteFrequencyData = function(array) {
      origGetByteFrequencyData.call(this, array);
      addNoiseToArray(array);
    };
    
    AnalyserNode.prototype.getFloatFrequencyData = function(array) {
      origGetFloatFrequencyData.call(this, array);
      addNoiseToArray(array);
    };
    
    AnalyserNode.prototype.getByteTimeDomainData = function(array) {
      origGetByteTimeDomainData.call(this, array);
      addNoiseToArray(array);
    };
    
    AnalyserNode.prototype.getFloatTimeDomainData = function(array) {
      origGetFloatTimeDomainData.call(this, array);
      addNoiseToArray(array);
    };
    
    // Randomize AudioContext properties
    const origCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function() {
      const osc = origCreateOscillator.call(this);
      const origStart = osc.start;
      osc.start = function(when) {
        const noise = seededRandom() * 0.0001;
        return origStart.call(this, when ? when + noise : noise);
      };
      return osc;
    };
  } catch {}
})();
`;
}

/**
 * Generate font enumeration protection.
 */
export function generateFontProtection(options = {}) {
  const allowedFonts = options.allowedFonts ?? [
    'Arial', 'Verdana', 'Times New Roman', 'Courier New',
    'Georgia', 'Palatino', 'Garamond', 'Bookman', 'Comic Sans MS',
    'Trebuchet MS', 'Impact', 'Lucida Console',
  ];
  
  return `
(() => {
  const allowedFonts = ${JSON.stringify(allowedFonts)};
  
  // Block font enumeration via canvas
  try {
    const origMeasureText = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function(text) {
      const font = this.font || '';
      const fontFamily = font.match(/['"]?([^'"]+)['"]?/)?.[1] || '';
      
      // If font not in allowed list, return generic measurement
      if (fontFamily && !allowedFonts.some(f => fontFamily.includes(f))) {
        return { width: text.length * 8, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 8 };
      }
      
      return origMeasureText.call(this, text);
    };
  } catch {}
  
  // Block @font-face enumeration
  try {
    if (document.fonts && document.fonts.check) {
      const origCheck = document.fonts.check;
      document.fonts.check = function(font, text) {
        const fontFamily = font.match(/['"]?([^'"]+)['"]?/)?.[1] || '';
        if (fontFamily && !allowedFonts.some(f => fontFamily.includes(f))) {
          return false;
        }
        return origCheck.call(this, font, text);
      };
    }
  } catch {}
})();
`;
}

/**
 * Build complete fingerprint protection script.
 */
export function buildFingerprintProtection(options = {}) {
  const seed = options.seed ?? Math.random();
  const parts = [];
  
  if (options.canvas !== false) {
    parts.push(generateCanvasNoiseInjection({ ...options, seed }));
  }
  
  if (options.webgl !== false) {
    parts.push(generateWebGLProtection({ ...options, seed }));
  }
  
  if (options.audio !== false) {
    parts.push(generateAudioContextProtection({ ...options, seed }));
  }
  
  if (options.fonts !== false) {
    parts.push(generateFontProtection(options));
  }
  
  return parts.join('\n');
}

/**
 * Apply fingerprint protection to a Puppeteer/Playwright page.
 */
export async function applyFingerprintProtection(page, options = {}) {
  const script = buildFingerprintProtection(options);
  
  try {
    await addInitScriptCompat(page, script);
    return { success: true, seed: options.seed };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
