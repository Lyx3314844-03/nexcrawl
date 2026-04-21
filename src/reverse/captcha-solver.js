/**
 * CAPTCHA Solving Integration Module
 *
 * Integrates with third-party CAPTCHA solving services (2Captcha, CapSolver, YesCaptcha)
 * to automatically detect and solve CAPTCHAs during crawling.
 *
 * Supported CAPTCHA types:
 * - reCAPTCHA V2/V3
 * - hCaptcha
 * - Cloudflare Turnstile
 * - Image CAPTCHAs (digit/letter)
 * - GeeTest
 */

import { AppError } from '../core/errors.js';

// CAPTCHA solving service endpoints
const SOLVER_ENDPOINTS = {
  '2captcha': {
    baseUrl: 'https://2captcha.com',
    createTask: '/in.php',
    getResult: '/res.php',
  },
  'capsolver': {
    baseUrl: 'https://api.capsolver.com',
    createTask: '/createTask',
    getResult: '/getTaskResult',
  },
  'yescaptcha': {
    baseUrl: 'https://api.yescaptcha.com',
    createTask: '/createTask',
    getResult: '/getTaskResult',
  },
};

// CAPTCHA type mapping for each service
const CAPTCHA_TYPE_MAP = {
  'recaptcha-v2': {
    '2captcha': 'userrecaptcha',
    'capsolver': 'ReCaptchaV2TaskProxyLess',
    'yescaptcha': 'ReCaptchaV2TaskProxyLess',
  },
  'recaptcha-v3': {
    '2captcha': 'userrecaptcha',
    'capsolver': 'ReCaptchaV3TaskProxyLess',
    'yescaptcha': 'ReCaptchaV3TaskProxyLess',
  },
  'hcaptcha': {
    '2captcha': 'hcaptcha',
    'capsolver': 'HCaptchaTaskProxyLess',
    'yescaptcha': 'HCaptchaTaskProxyLess',
  },
  'turnstile': {
    'capsolver': 'AntiTurnstileTaskProxyLess',
  },
  'geetest': {
    '2captcha': 'geetest',
    'capsolver': 'GeeTestTaskProxyLess',
    'yescaptcha': 'GeeTestTaskProxyLess',
  },
  'image': {
    '2captcha': 'base64',
    'capsolver': 'ImageToTextTask',
    'yescaptcha': 'ImageToTextTask',
  },
};

/**
 * Create CAPTCHA solving task
 * @param {Object} options - CAPTCHA options
 * @returns {Promise<string>} Task ID
 */
async function createCaptchaTask(options = {}) {
  const {
    service = '2captcha',
    apiKey,
    type = 'recaptcha-v2',
    websiteURL,
    websiteKey,
    siteAction,
    pageAction,
    minScore,
    imageBase64,
    proxy,
    ...extra
  } = options;

  if (!apiKey) {
    throw new AppError(400, 'API key is required for CAPTCHA solving');
  }
  if (!websiteURL && type !== 'image') {
    throw new AppError(400, 'websiteURL is required');
  }
  if (!websiteKey && type !== 'image') {
    throw new AppError(400, 'websiteKey is required');
  }

  const endpoint = SOLVER_ENDPOINTS[service];
  if (!endpoint) {
    throw new AppError(400, `Unsupported CAPTCHA service: ${service}`);
  }

  const captchaTypeMap = CAPTCHA_TYPE_MAP[type];
  if (!captchaTypeMap) {
    throw new AppError(400, `Unsupported CAPTCHA type: ${type}`);
  }

  const taskType = captchaTypeMap[service];
  if (!taskType) {
    throw new AppError(400, `${service} does not support ${type}`);
  }

  // Build request payload
  let payload;
  if (service === '2captcha') {
    payload = new URLSearchParams({
      key: apiKey,
      method: 'base64',
      json: 1,
    });

    if (type === 'image') {
      payload.set('body', imageBase64);
    } else {
      payload.set('method', 'userrecaptcha');
      payload.set('googlekey', websiteKey);
      payload.set('pageurl', websiteURL);
      if (type === 'recaptcha-v3') {
        payload.set('version', 'v3');
        if (minScore) payload.set('min_score', minScore);
      }
      if (siteAction) payload.set('action', siteAction);
    }

    if (proxy) {
      payload.set('proxy', `${proxy.host}:${proxy.port}`);
      if (proxy.username) payload.set('proxylogin', proxy.username);
      if (proxy.password) payload.set('proxypassword', proxy.password);
    }
  } else {
    // CapSolver / YesCaptcha format
    payload = {
      clientKey: apiKey,
      task: {
        type: taskType,
        websiteURL,
        websiteKey,
        ...(type === 'recaptcha-v3' && { minScore: minScore ?? 0.7 }),
        ...(siteAction && { action: siteAction }),
        ...(pageAction && { pageAction }),
        ...(imageBase64 && { image: imageBase64 }),
        ...(proxy && {
          proxyType: proxy.type ?? 'http',
          proxyAddress: proxy.host,
          proxyPort: proxy.port,
          ...(proxy.username && { proxyLogin: proxy.username }),
          ...(proxy.password && { proxyPassword: proxy.password }),
        }),
        ...extra,
      },
    };
  }

  // Send request
  const url = service === '2captcha'
    ? `${endpoint.baseUrl}${endpoint.createTask}`
    : `${endpoint.baseUrl}${endpoint.createTask}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: service === '2captcha'
      ? { 'Content-Type': 'application/x-www-form-urlencoded' }
      : { 'Content-Type': 'application/json' },
    body: service === '2captcha' ? payload.toString() : JSON.stringify(payload),
  });

  const data = await response.json();

  if (service === '2captcha') {
    if (data.status !== 1) {
      throw new AppError(502, `CAPTCHA task creation failed: ${data.request}`);
    }
    return data.request; // Task ID
  } else {
    if (data.errorId !== 0) {
      throw new AppError(502, `CAPTCHA task creation failed: ${data.errorDescription}`);
    }
    return data.taskId;
  }
}

/**
 * Poll for CAPTCHA solving result
 * @param {Object} options - Polling options
 * @returns {Promise<string>} CAPTCHA solution (token/gAnswer)
 */
async function pollCaptchaResult(options = {}) {
  const {
    service = '2captcha',
    apiKey,
    taskId,
    pollIntervalMs = 5000,
    maxWaitMs = 120000,
    onProgress,
  } = options;

  if (!taskId) {
    throw new AppError(400, 'Task ID is required');
  }

  const endpoint = SOLVER_ENDPOINTS[service];
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    let url;
    let fetchOptions;

    if (service === '2captcha') {
      url = `${endpoint.baseUrl}${endpoint.getResult}?key=${apiKey}&action=get&id=${taskId}&json=1`;
      fetchOptions = { method: 'GET' };
    } else {
      url = `${endpoint.baseUrl}${endpoint.getResult}`;
      fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      };
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json();

    if (service === '2captcha') {
      if (data.status === 1) {
        return data.request; // Solution
      }
      if (data.request !== 'CAPCHA_NOT_READY') {
        throw new AppError(502, `CAPTCHA solving failed: ${data.request}`);
      }
    } else {
      if (data.status === 'ready') {
        return data.solution?.gRecaptchaResponse ?? data.solution?.token ?? data.solution?.text;
      }
      if (data.errorId !== 0) {
        throw new AppError(502, `CAPTCHA solving failed: ${data.errorDescription}`);
      }
    }

    if (onProgress) {
      onProgress({
        status: 'pending',
        elapsed: Date.now() - startTime,
        remaining: maxWaitMs - (Date.now() - startTime),
      });
    }
  }

  throw new AppError(408, 'CAPTCHA solving timed out');
}

/**
 * Solve CAPTCHA end-to-end
 * @param {Object} options - CAPTCHA options
 * @returns {Promise<Object>} CAPTCHA solution with metadata
 */
export async function solveCaptcha(options = {}) {
  const {
    service = '2captcha',
    apiKey,
    type = 'recaptcha-v2',
    websiteURL,
    websiteKey,
    siteAction,
    minScore,
    imageBase64,
    proxy,
    pollIntervalMs,
    maxWaitMs,
    onProgress,
  } = options;

  // Create task
  const taskId = await createCaptchaTask({
    service,
    apiKey,
    type,
    websiteURL,
    websiteKey,
    siteAction,
    minScore,
    imageBase64,
    proxy,
  });

  // Poll for result
  const solution = await pollCaptchaResult({
    service,
    apiKey,
    taskId,
    pollIntervalMs,
    maxWaitMs,
    onProgress,
  });

  return {
    type,
    service,
    taskId,
    solution,
    solvedAt: new Date().toISOString(),
  };
}

/**
 * Detect CAPTCHA presence on a page
 * @param {Object} page - Puppeteer page object
 * @returns {Object|null} Detected CAPTCHA info
 */
export async function detectCaptcha(page) {
  const captchaInfo = await page.evaluate(() => {
    // reCAPTCHA V2
    const recaptchaV2 = document.querySelector('.g-recaptcha');
    if (recaptchaV2) {
      return {
        type: 'recaptcha-v2',
        siteKey: recaptchaV2.getAttribute('data-sitekey'),
        present: true,
      };
    }

    // reCAPTCHA V3 badge
    const recaptchaV3 = document.querySelector('.grecaptcha-badge');
    if (recaptchaV3) {
      return {
        type: 'recaptcha-v3',
        present: true,
      };
    }

    // hCaptcha
    const hcaptcha = document.querySelector('.h-captcha');
    if (hcaptcha) {
      return {
        type: 'hcaptcha',
        siteKey: hcaptcha.getAttribute('data-sitekey'),
        present: true,
      };
    }

    // Cloudflare Turnstile
    const turnstile = document.querySelector('.cf-turnstile');
    if (turnstile) {
      return {
        type: 'turnstile',
        siteKey: turnstile.getAttribute('data-sitekey'),
        present: true,
      };
    }

    // GeeTest
    const geetest = document.querySelector('.geetest_panel') || document.querySelector('#geetest-wrap');
    if (geetest) {
      return {
        type: 'geetest',
        present: true,
      };
    }

    // Generic CAPTCHA-like elements
    const captchaImages = document.querySelectorAll('img[src*="captcha"], img[src*="code"], img[src*="verify"]');
    if (captchaImages.length > 0) {
      return {
        type: 'image',
        src: captchaImages[0].src,
        present: true,
      };
    }

    return { present: false };
  });

  return captchaInfo.present ? captchaInfo : null;
}

/**
 * Inject CAPTCHA solution token into page
 * @param {Object} page - Puppeteer page object
 * @param {string} token - CAPTCHA solution token
 * @param {string} type - CAPTCHA type
 */
export async function injectCaptchaToken(page, token, type = 'recaptcha-v2') {
  switch (type) {
    case 'recaptcha-v2':
      await page.evaluate((t) => {
        const textarea = document.getElementById('g-recaptcha-response');
        if (textarea) {
          textarea.value = t;
          textarea.style.display = '';
        }
        // Trigger callback if exists
        if (typeof grecaptcha !== 'undefined' && typeof window.___grecaptcha_cfg !== 'undefined') {
          const widgetIds = Object.keys(window.___grecaptcha_cfg.clients);
          if (widgetIds.length > 0) {
            grecaptcha.setResponse(widgetIds[0], t);
          }
        }
        // Dispatch event
        window.dispatchEvent(new Event('recaptcha-solved'));
      }, token);
      break;

    case 'hcaptcha':
      await page.evaluate((t) => {
        const textarea = document.getElementById('h-captcha-response');
        if (textarea) textarea.value = t;
        if (typeof hcaptcha !== 'undefined') {
          hcaptcha.execute?.();
        }
        window.dispatchEvent(new Event('hcaptcha-solved'));
      }, token);
      break;

    case 'turnstile':
      await page.evaluate((t) => {
        const textarea = document.getElementById('cf-turnstile-response');
        if (textarea) textarea.value = t;
        window.dispatchEvent(new CustomEvent('turnstile-solved', { detail: { token: t } }));
      }, token);
      break;

    default:
      throw new AppError(400, `Unsupported CAPTCHA type for token injection: ${type}`);
  }
}

/**
 * Auto-solve CAPTCHA on page
 * Detects CAPTCHA, solves it, and injects the token
 * @param {Object} page - Puppeteer page object
 * @param {Object} options - Options
 * @returns {Promise<Object|null>} Solution info or null if no CAPTCHA
 */
export async function autoSolveCaptcha(page, options = {}) {
  const {
    service = '2captcha',
    apiKey,
    maxWaitMs = 120000,
    onProgress,
  } = options;

  // Detect CAPTCHA
  const captchaInfo = await detectCaptcha(page);
  if (!captchaInfo) {
    return null;
  }

  if (!apiKey) {
    throw new AppError(400, 'API key required for CAPTCHA solving');
  }

  // Get page URL
  const websiteURL = await page.url();

  // Solve CAPTCHA
  const solution = await solveCaptcha({
    service,
    apiKey,
    type: captchaInfo.type,
    websiteURL,
    websiteKey: captchaInfo.siteKey,
    maxWaitMs,
    onProgress,
  });

  // Inject token
  await injectCaptchaToken(page, solution.solution, captchaInfo.type);

  return {
    detected: captchaInfo,
    solved: solution,
  };
}

/**
 * Get CAPTCHA solving service balance
 * @param {Object} options - Options
 * @returns {Promise<number>} Account balance
 */
export async function getCaptchaBalance(options = {}) {
  const {
    service = '2captcha',
    apiKey,
  } = options;

  if (!apiKey) {
    throw new AppError(400, 'API key is required');
  }

  const endpoint = SOLVER_ENDPOINTS[service];
  let url;

  if (service === '2captcha') {
    url = `${endpoint.baseUrl}/res.php?key=${apiKey}&action=getbalance`;
  } else {
    url = `${endpoint.baseUrl}/getBalance`;
  }

  const response = await fetch(url);
  const text = await response.text();

  if (service === '2captcha') {
    const balance = parseFloat(text);
    if (isNaN(balance)) {
      throw new AppError(502, `Failed to get balance: ${text}`);
    }
    return balance;
  }

  const data = JSON.parse(text);
  if (data.errorId !== 0) {
    throw new AppError(502, `Failed to get balance: ${data.errorDescription}`);
  }
  return data.balance ?? 0;
}

export {
  SOLVER_ENDPOINTS,
  CAPTCHA_TYPE_MAP,
};
