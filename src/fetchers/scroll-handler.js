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

const LOAD_MORE_TEXT_PATTERN = /\b(load more|show more|see more|more results|more items|view more|加载更多|查看更多|更多|更多结果)\b/i;
const ITEM_SELECTOR_CANDIDATES = [
  '[data-index]',
  '[data-item-index]',
  '[data-testid*="item"]',
  '[data-testid*="card"]',
  '[data-testid*="result"]',
  '[role="listitem"]',
  '[role="row"]',
  'article',
  'li',
  '.product-card',
  '.result-card',
  '.search-result',
  '.feed-item',
  '.card',
  '[class*="virtual"] [class*="item"]',
  '[class*="virtual"] [class*="card"]',
  '[class*="list"] > *',
  '[class*="grid"] > *',
];
const SCROLL_CONTAINER_SELECTOR_CANDIDATES = [
  '[data-testid*="virtual"]',
  '[data-testid*="list"]',
  '[data-testid*="feed"]',
  '[class*="virtual"]',
  '[class*="virtuoso"]',
  '[class*="react-window"]',
  '[class*="react-virtualized"]',
  '[class*="infinite"]',
  '[class*="feed"]',
  '[class*="results"]',
  '[class*="list"]',
  '[role="feed"]',
  '[role="list"]',
  'main',
];

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  maxScrolls: 100,
  delayMs: 400,
  stabilityThresholdMs: 2000,
  maxStableIterations: 4,
  scrollStep: null,
  loadMoreSelector: null,
  scrollTargetSelector: null,
  itemSelector: null,
  observeLazyContainers: true,
  requireBottom: true,
  sampleItems: 12,
};

function normalizeAutoScrollOptions(opts = {}) {
  const config = { ...DEFAULTS, ...(opts ?? {}) };
  return {
    ...config,
    maxScrolls: Math.max(1, Math.min(500, Number(config.maxScrolls ?? DEFAULTS.maxScrolls) || DEFAULTS.maxScrolls)),
    delayMs: Math.max(0, Math.min(30000, Number(config.delayMs ?? DEFAULTS.delayMs) || DEFAULTS.delayMs)),
    stabilityThresholdMs: Math.max(
      0,
      Math.min(120000, Number(config.stabilityThresholdMs ?? DEFAULTS.stabilityThresholdMs) || DEFAULTS.stabilityThresholdMs),
    ),
    maxStableIterations: Math.max(
      1,
      Math.min(50, Number(config.maxStableIterations ?? DEFAULTS.maxStableIterations) || DEFAULTS.maxStableIterations),
    ),
    sampleItems: Math.max(3, Math.min(50, Number(config.sampleItems ?? DEFAULTS.sampleItems) || DEFAULTS.sampleItems)),
    observeLazyContainers: config.observeLazyContainers !== false,
    requireBottom: config.requireBottom !== false,
  };
}

async function collectScrollState(page, cfg) {
  return page.evaluate((input) => {
    const itemSelectorCandidates = input.itemSelectorCandidates ?? [];
    const scrollContainerSelectorCandidates = input.scrollContainerSelectorCandidates ?? [];
    const loadMorePattern = new RegExp(input.loadMorePattern, 'i');
    const sampleItems = Math.max(3, Number(input.sampleItems ?? 12) || 12);

    const isVisible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const safeQueryAll = (rootNode, selector) => {
      try {
        return Array.from(rootNode.querySelectorAll(selector));
      } catch {
        return [];
      }
    };

    const safeQueryOne = (selector) => {
      try {
        return document.querySelector(selector);
      } catch {
        return null;
      }
    };

    const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

    const fingerprintNode = (node) => {
      const text = normalizeText(node?.textContent).slice(0, 120);
      const href = node?.getAttribute?.('href') ?? '';
      const src = node?.getAttribute?.('src') ?? '';
      const dataId =
        node?.getAttribute?.('data-id')
        ?? node?.getAttribute?.('data-key')
        ?? node?.getAttribute?.('data-testid')
        ?? '';
      const aria = node?.getAttribute?.('aria-label') ?? '';
      return [href, src, dataId, aria, text].filter(Boolean).join('|');
    };

    const isScrollable = (node) => {
      if (!node) return false;
      if (node === document.body || node === document.documentElement || node === document.scrollingElement) {
        const scrollHeight = Math.max(
          document.documentElement?.scrollHeight ?? 0,
          document.body?.scrollHeight ?? 0,
        );
        const clientHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
        return scrollHeight > clientHeight + 120;
      }

      const style = window.getComputedStyle(node);
      if (!style) return false;
      const overflowY = style.overflowY ?? style.overflow ?? '';
      const scrollableStyle = ['auto', 'scroll', 'overlay'].includes(overflowY);
      return node.scrollHeight > node.clientHeight + 120 && (scrollableStyle || /virtual|list|feed|result/i.test(node.className));
    };

    const scoreScrollTarget = (node) => {
      if (!node) return -1;
      if (node === document.body || node === document.documentElement || node === document.scrollingElement) {
        return Math.max(
          document.documentElement?.scrollHeight ?? 0,
          document.body?.scrollHeight ?? 0,
        );
      }

      const overflowY = window.getComputedStyle(node).overflowY ?? '';
      const className = String(node.className ?? '');
      return (
        Math.max(0, node.scrollHeight - node.clientHeight)
        + Math.min(node.clientHeight, 1500)
        + (['auto', 'scroll', 'overlay'].includes(overflowY) ? 300 : 0)
        + (/virtual|infinite|feed|result|list/i.test(className) ? 500 : 0)
      );
    };

    const candidateNodes = [];
    const pushCandidate = (node) => {
      if (!node || candidateNodes.includes(node)) return;
      candidateNodes.push(node);
    };

    pushCandidate(document.scrollingElement ?? document.documentElement ?? document.body);

    if (input.scrollTargetSelector) {
      pushCandidate(safeQueryOne(input.scrollTargetSelector));
    }

    for (const selector of scrollContainerSelectorCandidates) {
      for (const node of safeQueryAll(document, selector)) {
        pushCandidate(node);
      }
    }

    const scrollRoot = candidateNodes
      .filter(isScrollable)
      .sort((left, right) => scoreScrollTarget(right) - scoreScrollTarget(left))[0]
      ?? (document.scrollingElement ?? document.documentElement ?? document.body);

    const root = scrollRoot instanceof Element && scrollRoot !== document.body && scrollRoot !== document.documentElement
      ? scrollRoot
      : document;

    const detectItemSelector = () => {
      if (input.itemSelector) {
        return input.itemSelector;
      }

      let bestSelector = null;
      let bestScore = -1;
      for (const selector of itemSelectorCandidates) {
        const matches = safeQueryAll(root, selector);
        if (matches.length < 2 || matches.length > 500) {
          continue;
        }

        const score = matches.length
          + matches.slice(0, Math.min(matches.length, 8)).reduce((total, node) => {
            const fingerprint = fingerprintNode(node);
            return total + (fingerprint ? Math.min(fingerprint.length, 80) : 0);
          }, 0);

        if (score > bestScore) {
          bestSelector = selector;
          bestScore = score;
        }
      }

      return bestSelector;
    };

    const itemSelector = detectItemSelector();
    const itemNodes = itemSelector
      ? safeQueryAll(root, itemSelector).filter(isVisible).slice(0, sampleItems)
      : [];
    const fingerprints = itemNodes.map(fingerprintNode).filter(Boolean);

    const allLoadMoreCandidates = input.loadMoreSelector
      ? safeQueryAll(document, input.loadMoreSelector)
      : safeQueryAll(document, 'button, a, [role="button"]');
    const loadMoreNode = allLoadMoreCandidates.find((node) => {
      const text = normalizeText(node?.textContent ?? node?.getAttribute?.('aria-label') ?? '');
      return isVisible(node) && Boolean(text) && loadMorePattern.test(text);
    }) ?? null;

    const scrollTop =
      scrollRoot === document.body || scrollRoot === document.documentElement || scrollRoot === document.scrollingElement
        ? window.scrollY || window.pageYOffset || 0
        : scrollRoot.scrollTop;
    const clientHeight =
      scrollRoot === document.body || scrollRoot === document.documentElement || scrollRoot === document.scrollingElement
        ? window.innerHeight || document.documentElement?.clientHeight || 0
        : scrollRoot.clientHeight;
    const scrollHeight =
      scrollRoot === document.body || scrollRoot === document.documentElement || scrollRoot === document.scrollingElement
        ? Math.max(
            document.documentElement?.scrollHeight ?? 0,
            document.body?.scrollHeight ?? 0,
          )
        : scrollRoot.scrollHeight;

    return {
      detectedItemSelector: itemSelector ?? null,
      scrollTarget: scrollRoot === document.body || scrollRoot === document.documentElement || scrollRoot === document.scrollingElement
        ? 'window'
        : 'element',
      scrollTop,
      clientHeight,
      scrollHeight,
      atBottom: scrollTop + clientHeight >= scrollHeight - 8,
      itemCount: itemNodes.length,
      topSignature: fingerprints.slice(0, 3).join('||'),
      bottomSignature: fingerprints.slice(-3).join('||'),
      loadMoreVisible: Boolean(loadMoreNode),
    };
  }, {
    ...cfg,
    loadMorePattern: LOAD_MORE_TEXT_PATTERN.source,
    itemSelectorCandidates: ITEM_SELECTOR_CANDIDATES,
    scrollContainerSelectorCandidates: SCROLL_CONTAINER_SELECTOR_CANDIDATES,
  });
}

async function performScrollStep(page, cfg) {
  return page.evaluate((input) => {
    const scrollContainerSelectorCandidates = input.scrollContainerSelectorCandidates ?? [];
    const loadMorePattern = new RegExp(input.loadMorePattern, 'i');

    const isVisible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const safeQueryAll = (rootNode, selector) => {
      try {
        return Array.from(rootNode.querySelectorAll(selector));
      } catch {
        return [];
      }
    };

    const safeQueryOne = (selector) => {
      try {
        return document.querySelector(selector);
      } catch {
        return null;
      }
    };

    const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

    const isScrollable = (node) => {
      if (!node) return false;
      if (node === document.body || node === document.documentElement || node === document.scrollingElement) {
        const scrollHeight = Math.max(
          document.documentElement?.scrollHeight ?? 0,
          document.body?.scrollHeight ?? 0,
        );
        const clientHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
        return scrollHeight > clientHeight + 120;
      }

      const style = window.getComputedStyle(node);
      if (!style) return false;
      const overflowY = style.overflowY ?? style.overflow ?? '';
      return node.scrollHeight > node.clientHeight + 120 && ['auto', 'scroll', 'overlay'].includes(overflowY);
    };

    const scoreScrollTarget = (node) => {
      if (!node) return -1;
      if (node === document.body || node === document.documentElement || node === document.scrollingElement) {
        return Math.max(
          document.documentElement?.scrollHeight ?? 0,
          document.body?.scrollHeight ?? 0,
        );
      }
      const className = String(node.className ?? '');
      return (
        Math.max(0, node.scrollHeight - node.clientHeight)
        + Math.min(node.clientHeight, 1500)
        + (/virtual|infinite|feed|result|list/i.test(className) ? 500 : 0)
      );
    };

    const candidateNodes = [];
    const pushCandidate = (node) => {
      if (!node || candidateNodes.includes(node)) return;
      candidateNodes.push(node);
    };

    pushCandidate(document.scrollingElement ?? document.documentElement ?? document.body);
    if (input.scrollTargetSelector) {
      pushCandidate(safeQueryOne(input.scrollTargetSelector));
    }
    for (const selector of scrollContainerSelectorCandidates) {
      for (const node of safeQueryAll(document, selector)) {
        pushCandidate(node);
      }
    }

    const scrollRoot = candidateNodes
      .filter(isScrollable)
      .sort((left, right) => scoreScrollTarget(right) - scoreScrollTarget(left))[0]
      ?? (document.scrollingElement ?? document.documentElement ?? document.body);

    const clientHeight =
      scrollRoot === document.body || scrollRoot === document.documentElement || scrollRoot === document.scrollingElement
        ? window.innerHeight || document.documentElement?.clientHeight || 0
        : scrollRoot.clientHeight;
    const stepSize = Math.max(240, Math.floor(clientHeight * 0.85));

    if (typeof input.scrollStep === 'string' && input.scrollStep.trim()) {
      // eslint-disable-next-line no-eval
      (0, eval)(input.scrollStep);
    } else if (scrollRoot === document.body || scrollRoot === document.documentElement || scrollRoot === document.scrollingElement) {
      window.scrollBy(0, stepSize);
    } else {
      scrollRoot.scrollBy(0, stepSize);
    }

    const loadMoreCandidates = input.loadMoreSelector
      ? safeQueryAll(document, input.loadMoreSelector)
      : safeQueryAll(document, 'button, a, [role="button"]');
    const loadMoreNode = loadMoreCandidates.find((node) => {
      const text = normalizeText(node?.textContent ?? node?.getAttribute?.('aria-label') ?? '');
      return isVisible(node) && Boolean(text) && loadMorePattern.test(text);
    }) ?? null;

    if (loadMoreNode) {
      loadMoreNode.scrollIntoView({ behavior: 'instant', block: 'center' });
      loadMoreNode.click();
    }

    return {
      clickedLoadMore: Boolean(loadMoreNode),
      stepSize,
    };
  }, {
    ...cfg,
    loadMorePattern: LOAD_MORE_TEXT_PATTERN.source,
    scrollContainerSelectorCandidates: SCROLL_CONTAINER_SELECTOR_CANDIDATES,
  });
}

function hasScrollProgress(previousState, currentState) {
  if (!previousState || !currentState) {
    return true;
  }

  return (
    Math.abs(Number(currentState.scrollTop ?? 0) - Number(previousState.scrollTop ?? 0)) > 4
    || Number(currentState.scrollHeight ?? 0) !== Number(previousState.scrollHeight ?? 0)
    || Number(currentState.itemCount ?? 0) !== Number(previousState.itemCount ?? 0)
    || String(currentState.topSignature ?? '') !== String(previousState.topSignature ?? '')
    || String(currentState.bottomSignature ?? '') !== String(previousState.bottomSignature ?? '')
    || Boolean(currentState.loadMoreVisible) !== Boolean(previousState.loadMoreVisible)
  );
}

// ─── Core scroll loop ────────────────────────────────────────────────────────

/**
 * Perform automated scrolling on a browser page until no new content appears.
 *
 * @param {import('playwright').Page | import('puppeteer').Page} page
 * @param {object} [opts]
 * @param {number} [opts.maxScrolls]           - Maximum scroll iterations (default 100)
 * @param {number} [opts.delayMs]             - Delay between scrolls in ms (default 400)
 * @param {number} [opts.stabilityThresholdMs] - Stop when height unchanged for this long (default 2000)
 * @param {number} [opts.maxStableIterations] - Stop when stable state repeats this many times (default 4)
 * @param {string} [opts.scrollStep]           - JS expression executed per scroll
 * @param {string|null} [opts.loadMoreSelector] - CSS selector for a "Load more" button
 * @param {string|null} [opts.scrollTargetSelector] - Explicit scrollable container selector
 * @param {string|null} [opts.itemSelector] - Explicit repeating item selector for progress detection
 * @param {boolean} [opts.observeLazyContainers] - Also trigger IntersectionObserver containers
 * @returns {Promise<{scrollsPerformed: number, finalHeight: number, finalScrollTop: number, itemCount: number, itemSelector: string|null, atBottom: boolean, timedOut: boolean}>}
 */
export async function autoScroll(page, opts = {}) {
  const cfg = normalizeAutoScrollOptions(opts);
  let scrollsPerformed = 0;
  let timedOut = false;
  let stableIterations = 0;
  let lastProgressAt = Date.now();
  let previousState = await collectScrollState(page, cfg);

  while (scrollsPerformed < cfg.maxScrolls) {
    await performScrollStep(page, cfg);
    scrollsPerformed++;

    if (cfg.observeLazyContainers) {
      await triggerLazyContainers(page);
    }

    await delay(cfg.delayMs);

    const currentState = await collectScrollState(page, cfg);
    const progressed = hasScrollProgress(previousState, currentState);
    if (progressed) {
      stableIterations = 0;
      lastProgressAt = Date.now();
    } else {
      stableIterations += 1;
    }

    const stableForMs = Date.now() - lastProgressAt;
    const canStopForStability =
      !progressed
      && stableIterations >= cfg.maxStableIterations
      && stableForMs >= cfg.stabilityThresholdMs
      && (!cfg.requireBottom || currentState.atBottom || currentState.scrollTop <= previousState.scrollTop);

    previousState = currentState;

    if (canStopForStability) {
      log.info('Scroll completed - content stabilized', {
        scrollsPerformed,
        finalHeight: currentState.scrollHeight,
        itemCount: currentState.itemCount,
        itemSelector: currentState.detectedItemSelector,
      });
      break;
    }

    if (scrollsPerformed >= cfg.maxScrolls) {
      timedOut = true;
      log.warn('Reached max scroll limit', { maxScrolls: cfg.maxScrolls });
    }
  }

  const finalState = await collectScrollState(page, cfg);
  return {
    scrollsPerformed,
    finalHeight: Number(finalState.scrollHeight ?? 0),
    finalScrollTop: Number(finalState.scrollTop ?? 0),
    itemCount: Number(finalState.itemCount ?? 0),
    itemSelector: finalState.detectedItemSelector ?? null,
    atBottom: Boolean(finalState.atBottom),
    timedOut,
  };
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

export function createAutoScrollPlugin(opts = {}) {
  const config = normalizeAutoScrollOptions({
    ...opts,
    enabled: opts?.enabled !== false,
  });

  return {
    name: 'omnicrawler-auto-scroll',
    afterNavigation: async ({ page }) => {
      if (!page || config.enabled === false) {
        return null;
      }
      return {
        autoScroll: await autoScroll(page, config),
      };
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
