/**
 * Infinite-scroll & lazy-loading handler for browser-based crawling.
 *
 * Detects and automates scrolling to load additional content in
 * single-page applications, infinite-scroll feeds, and lazy-loaded
 * sections.  Supports IntersectionObserver-based lazy loading,
 * "load more" button clicking, and height-stable auto-scroll.
 *
 * Usage:
 *   import { autoScroll } from '../fetchers/scroll-handler.js';
 *   await autoScroll(page, { maxScrolls: 200, delayMs: 500 });
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('scroll-handler');

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  maxScrolls: 100,
  delayMs: 400,
  stabilityThresholdMs: 2000,
  scrollStep: 'window.scrollBy(0, document.body.scrollHeight)',
  loadMoreSelector: null,
  observeLazyContainers: false,
};

// ─── Core scroll loop ────────────────────────────────────────────────────────

/**
 * Perform automated scrolling on a browser page until no new content appears.
 *
 * @param {import('playwright').Page | import('puppeteer').Page} page
 * @param {object} [opts]
 * @param {number} [opts.maxScrolls]           - Maximum scroll iterations (default 100)
 * @param {number} [opts.delayMs]             - Delay between scrolls in ms (default 400)
 * @param {number} [opts.stabilityThresholdMs] - Stop when height unchanged for this long (default 2000)
 * @param {string} [opts.scrollStep]           - JS expression executed per scroll
 * @param {string|null} [opts.loadMoreSelector] - CSS selector for a "Load more" button
 * @param {boolean} [opts.observeLazyContainers] - Also trigger IntersectionObserver containers
 * @returns {Promise<{scrollsPerformed: number, finalHeight: number, timedOut: boolean}>}
 */
export async function autoScroll(page, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let scrollsPerformed = 0;
  let timedOut = false;
  let prevHeight = 0;
  let stableSince = Date.now();

  // Inject a scroll-height listener before we start
  await page.evaluate(() => {
    window.__omniScrollHeights = [document.documentElement.scrollHeight];
  });

  while (scrollsPerformed < cfg.maxScrolls) {
    // 1. Scroll down
    await page.evaluate(cfg.scrollStep);
    scrollsPerformed++;

    // 2. Click "Load more" if present
    if (cfg.loadMoreSelector) {
      try {
        const btn = await page.$(cfg.loadMoreSelector);
        if (btn && await btn.isVisible()) {
          await btn.click();
          log.debug('Clicked load-more button', { selector: cfg.loadMoreSelector });
        }
      } catch { /* selector may not exist on every page */ }
    }

    // 3. Trigger IntersectionObserver-based lazy containers
    if (cfg.observeLazyContainers) {
      await triggerLazyContainers(page);
    }

    // 4. Wait a tick for network responses
    await delay(cfg.delayMs);

    // 5. Check page height stability
    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    if (currentHeight !== prevHeight) {
      prevHeight = currentHeight;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= cfg.stabilityThresholdMs) {
      log.info('Scroll completed – height stable', {
        scrollsPerformed,
        finalHeight: currentHeight,
      });
      break;
    }

    // Safety: if we've hit the max, flag it
    if (scrollsPerformed >= cfg.maxScrolls) {
      timedOut = true;
      log.warn('Reached max scroll limit', { maxScrolls: cfg.maxScrolls });
    }
  }

  const finalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  return { scrollsPerformed, finalHeight, timedOut };
}

// ─── IntersectionObserver trigger ────────────────────────────────────────────

/**
 * Force-trigger any lazy-loaded containers that rely on IntersectionObserver
 * by programmatically scrolling them into view.
 *
 * @param {import('playwright').Page | import('puppeteer').Page} page
 */
export async function triggerLazyContainers(page) {
  await page.evaluate(() => {
    const candidates = document.querySelectorAll(
      '[data-src], [data-lazy], [data-srcset], [loading="lazy"], .lazy, .lazyload'
    );
    for (const el of candidates) {
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      // Force event dispatch for frameworks that listen for custom events
      el.dispatchEvent(new Event('lazyload', { bubbles: true }));
      el.dispatchEvent(new Event('lazy:beforeload', { bubbles: true }));
      // Handle images with data-src
      if (el.dataset.src) el.src = el.dataset.src;
      if (el.dataset.srcset) el.srcset = el.dataset.srcset;
    }
  });
}

// ─── SPA deep-link discovery ────────────────────────────────────────────────

/**
 * Discover deeply-linked SPA routes by scrolling and collecting pushState/replaceState
 * URLs that appear during scrolling.
 *
 * @param {import('playwright').Page | import('puppeteer').Page} page
 * @param {object} [opts] - Same options as autoScroll
 * @returns {Promise<{urls: string[], scrollsPerformed: number}>}
 */
export async function discoverSpaRoutes(page, opts = {}) {
  // Hook history API before scrolling
  await page.evaluate(() => {
    window.__omniSpaUrls = [location.href];
    const origPush = history.pushState;
    history.pushState = function (...args) {
      window.__omniSpaUrls.push(args[2]);
      return origPush.apply(this, args);
    };
  });

  const result = await autoScroll(page, opts);

  const urls = await page.evaluate(() => [...new Set(window.__omniSpaUrls)]);
  return { urls, scrollsPerformed: result.scrollsPerformed };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
