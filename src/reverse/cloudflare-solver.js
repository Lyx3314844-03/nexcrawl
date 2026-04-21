/**
 * Cloudflare WAF Challenge Solver Module
 *
 * Detects and automatically solves Cloudflare challenges including:
 * - 5 Second Challenge (JS challenge)
 * - Turnstile (CAPTCHA-like)
 * - Managed Challenge (dynamic)
 *
 * Note: This module focuses on legitimate authorization flows and
 * requires the user to own or have access to the target site.
 */

import { AppError } from '../core/errors.js';

/**
 * Detect Cloudflare challenge type from response
 * @param {Object} response - HTTP response
 * @returns {Object|null} Challenge info or null
 */
export function detectCloudflareChallenge(response = {}) {
  const { headers = {}, body = '', html = '', status = 200, url = '' } = response;
  const headersLower = {};
  for (const [k, v] of Object.entries(headers)) {
    headersLower[k.toLowerCase()] = v;
  }
  const bodyText = String(body || html).toLowerCase();

  // Check for cf-ray header (Cloudflare presence)
  const hasCfRay = Boolean(headersLower['cf-ray']);
  const hasCfCache = Boolean(headersLower['cf-cache-status']);
  const server = String(headersLower['server'] ?? '').toLowerCase();
  const isCloudflare = hasCfRay || hasCfCache || server.includes('cloudflare');

  if (!isCloudflare) {
    return {
      detected: false,
      type: null,
      challengeUrl: url || null,
    };
  }

  // 5 Second Challenge / JS Challenge
  if (bodyText.includes('cdn-cgi/challenge-platform') || bodyText.includes('challenge-platform') || bodyText.includes('jschl-answer') || bodyText.includes('__cf_chl')) {
    return {
      type: 'js-challenge',
      version: bodyText.includes('v2') ? 'v2' : 'v1',
      challengeUrl: url,
      detected: true,
    };
  }

  // Turnstile
  if (bodyText.includes('turnstile') || bodyText.includes('cf-turnstile') || bodyText.includes('__cf_chl_captcha')) {
    const siteKeyMatch = bodyText.match(/data-sitekey=["']([^"']+)["']/);
    return {
      type: 'turnstile',
      siteKey: siteKeyMatch?.[1] ?? null,
      challengeUrl: url,
      detected: true,
    };
  }

  // Managed Challenge (IUAM)
  if (status === 403 && (bodyText.includes('attention required') || bodyText.includes('access denied'))) {
    return {
      type: 'managed-challenge',
      challengeUrl: url,
      detected: true,
    };
  }

  // Challenge cookie check
  const setCookie = headersLower['set-cookie'];
  if (setCookie) {
    const cookies = Array.isArray(setCookie) ? setCookie.join(';') : setCookie;
    if (cookies.includes('cf_clearance')) {
      return {
        type: 'clearance-obtained',
        challengeUrl: url,
        detected: true,
      };
    }
    if (cookies.includes('__cf_bm')) {
      return {
        type: 'bot-management',
        challengeUrl: url,
        detected: true,
      };
    }
  }

  return {
    detected: false,
    type: 'cloudflare-present',
    challengeUrl: url || null,
  };
}

/**
 * Extract Cloudflare challenge parameters from HTML
 */
export function extractChallengeParams(html) {
  const params = {};

  // Extract jschl-answer challenge params (v1)
  const sMatch = html.match(/name="s"\s+value="([^"]+)"/);
  const jschl_vc = html.match(/name="jschl_vc"\s+value="([^"]+)"/);
  const pass = html.match(/name="pass"\s+value="([^"]+)"/);
  const jschl_answer = html.match(/name="jschl_answer"\s+value="([^"]+)"/);

  if (sMatch) params.s = sMatch[1];
  if (jschl_vc) params.jschl_vc = jschl_vc[1];
  if (pass) params.pass = pass[1];
  if (jschl_answer) params.jschl_answer = jschl_answer[1];

  // Extract challenge script for v2
  const challengeScript = html.match(/<script[^>]*>([\s\S]*?var\s+t,r,a,f,.*?[\s\S]*?)<\/script>/);
  if (challengeScript) {
    params.challengeScript = challengeScript[1];
  }

  // Extract Turnstile site key
  const turnstileKey = html.match(/data-sitekey=["']([^"']+)["']/);
  if (turnstileKey) {
    params.turnstileSiteKey = turnstileKey[1];
  }

  return params;
}

/**
 * Solve Cloudflare JS challenge (v1 legacy)
 * This parses the challenge JavaScript and computes the answer
 */
export async function solveJsChallenge(html, options = {}) {
  const { timeoutMs = 10000 } = options;
  const params = extractChallengeParams(html);

  if (!params.challengeScript) {
    throw new AppError(400, 'No challenge script found in HTML');
  }

  // Extract and evaluate the challenge expression
  const script = params.challengeScript;

  // Find the mathematical expression to solve
  // Pattern: t = <expression>; a.value = ...
  const exprMatch = script.match(/t\s*=\s*(.*?);/);
  if (!exprMatch) {
    throw new AppError(400, 'Could not extract challenge expression');
  }

  let expression = exprMatch[1];

  // Handle string length operations
  expression = expression.replace(/\.length/g, (match, offset) => {
    const preceding = expression.slice(0, offset);
    const strMatch = preceding.match(/['"]([^'"]*)['"]\s*$/);
    if (strMatch) {
      return String(strMatch[1].length);
    }
    // For variable .length, we'll approximate
    return String(1);
  });

  // Handle !![] as true (1), ![] as false (0)
  expression = expression.replace(/!!\[\]/g, '1');
  expression = expression.replace(/!\[\]/g, '0');
  expression = expression.replace(/\+\[\]/g, '0');
  expression = expression.replace(/\+!!\[\]/g, '1');
  expression = expression.replace(/\+!\[\]/g, '0');

  // Evaluate the expression safely
  try {
    // Use Function constructor for isolated evaluation
    const result = new Function(`"use strict"; return (${expression})`)();

    return {
      success: true,
      answer: Number(result),
      expression,
      method: 'js-challenge-v1',
    };
  } catch {
    return {
      success: false,
      error: 'Failed to evaluate challenge expression',
      expression,
    };
  }
}

/**
 * Wait for Cloudflare clearance cookie
 * Used when the challenge is handled by the browser automatically
 */
export async function waitForClearanceCookie(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cookies = await page.cookies();
    const clearance = cookies.find((c) => c.name === 'cf_clearance');
    if (clearance) {
      return {
        success: true,
        cookie: clearance,
        waitTimeMs: Date.now() - start,
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    success: false,
    error: 'Timeout waiting for cf_clearance cookie',
    waitTimeMs: timeoutMs,
  };
}

/**
 * Auto-handle Cloudflare challenge on a page
 * Combines detection, solving, and verification
 */
export async function handleCloudflareChallenge(page, options = {}) {
  const {
    captchaApiKey = null,
    captchaService = 'capsolver',
    maxWaitMs = 30000,
    onProgress,
  } = options;

  // Get current page content
  const url = await page.url();
  const html = await page.content();
  const statusResponse = await page.evaluate(() => ({
    status: 200, // Simplified
    url: window.location.href,
  }));

  // Detect challenge type
  const challenge = detectCloudflareChallenge({
    body: html,
    url,
    status: statusResponse.status,
  });

  if (!challenge || challenge.detected !== true) {
    return { success: false, reason: 'no-challenge-detected' };
  }

  if (onProgress) {
    onProgress({ stage: 'detected', challenge });
  }

  switch (challenge.type) {
    case 'js-challenge': {
      // Try to solve JS challenge
      const result = await solveJsChallenge(html);
      if (result.success) {
        // Submit the answer via form
        await page.evaluate((answer, vc, pass) => {
          const form = document.querySelector('#challenge-form');
          if (form) {
            const answerInput = form.querySelector('[name="jschl_answer"]');
            if (answerInput) answerInput.value = answer;
            form.submit();
          }
        }, result.answer, challenge.jschl_vc, challenge.pass);

        // Wait for clearance
        return await waitForClearanceCookie(page, maxWaitMs);
      }
      return { success: false, reason: 'js-challenge-failed', detail: result };
    }

    case 'turnstile': {
      if (!captchaApiKey) {
        return { success: false, reason: 'captcha-api-key-required' };
      }
      // Use CAPTCHA solver for Turnstile
      const { solveCaptcha } = await import('./captcha-solver.js');
      const solution = await solveCaptcha({
        service: captchaService,
        apiKey: captchaApiKey,
        type: 'turnstile',
        websiteURL: url,
        websiteKey: challenge.siteKey,
        maxWaitMs,
      });

      // Inject Turnstile token
      await page.evaluate((token) => {
        const textarea = document.getElementById('cf-turnstile-response');
        if (textarea) textarea.value = token;
        // Trigger callback
        const event = new CustomEvent('turnstile-solved', { detail: { token } });
        window.dispatchEvent(event);
      }, solution.solution);

      return { success: true, method: 'turnstile-via-captcha', solution };
    }

    case 'managed-challenge':
    case 'bot-management': {
      // These require browser-based solving with human interaction
      return {
        success: false,
        reason: 'managed-challenge-requires-browser-interaction',
        challenge,
      };
    }

    case 'clearance-obtained': {
      return { success: true, method: 'already-cleared' };
    }

    default: {
      return { success: false, reason: `unknown-challenge-type: ${challenge.type}` };
    }
  }
}

/**
 * Generate stealth request headers that pass Cloudflare basic checks
 */
export function buildCloudflareStealthHeaders(options = {}) {
  const {
    referer = null,
    origin = null,
    locale = 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  } = options;

  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': locale,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Sec-Ch-Ua': '"Chromium";v="123", "Google Chrome";v="123", "Not:A?Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { Referer: referer } : {}),
    ...(origin ? { Origin: origin } : {}),
  };
}
