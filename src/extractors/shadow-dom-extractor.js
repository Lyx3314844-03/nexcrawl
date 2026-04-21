/**
 * Shadow DOM & iframe extractor.
 *
 * Penetrates Shadow DOM (open & closed roots), cross-origin iframes
 * (best-effort via CDP), and <slot> projection points to extract
 * structured data that standard DOM queries cannot reach.
 *
 * Usage:
 *   import { extractShadowDom, extractIframes } from '../extractors/shadow-dom-extractor.js';
 *   const result = await extractShadowDom(page, { selector: 'my-widget' });
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('shadow-dom-extractor');

// ─── Shadow DOM extraction ───────────────────────────────────────────────────

/**
 * Recursively extract content from Shadow DOM roots.
 *
 * @param {import('playwright').Page | import('puppeteer').Page} page
 * @param {object} [opts]
 * @param {string}   [opts.selector]      - Host element selector (default: all shadow hosts)
 * @param {boolean}  [opts.includeClosed]  - Attempt closed shadow roots via CDP (default true)
 * @param {number}   [opts.maxDepth]       - Recursion depth limit (default 5)
 * @param {string[]} [opts.extractFields]  - Fields to extract per element: text, attributes, html (default all)
 * @returns {Promise<Array<{host: string, depth: number, html: string, text: string, attributes: object, children: Array[]}>>}
 */
export async function extractShadowDom(page, opts = {}) {
  const { selector = '', includeClosed = true, maxDepth = 5, extractFields = ['text', 'attributes', 'html'] } = opts;

  const results = await page.evaluate(
    async ({ hostSelector, maxD, fields }) => {
      const collected = [];

      function walk(el, depth) {
        if (depth > maxD) return;

        let root = el.shadowRoot;
        if (!root) return;

        const entry = { host: el.tagName.toLowerCase(), depth };
        if (fields.includes('text')) entry.text = root.textContent?.trim() ?? '';
        if (fields.includes('html')) entry.html = root.innerHTML;
        if (fields.includes('attributes')) {
          entry.attributes = {};
          for (const attr of el.attributes) {
            entry.attributes[attr.name] = attr.value;
          }
        }

        entry.children = [];
        for (const child of root.children) {
          const childResult = walk(child, depth + 1);
          if (childResult) entry.children.push(childResult);
        }

        // Traverse <slot> projected nodes
        for (const slot of root.querySelectorAll('slot')) {
          const assigned = slot.assignedNodes({ flatten: true });
          for (const node of assigned) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              entry.children.push({
                host: node.tagName?.toLowerCase() ?? 'text',
                depth: depth + 1,
                text: node.textContent?.trim() ?? '',
                slotName: slot.name || 'default',
              });
            }
          }
        }

        collected.push(entry);
        return entry;
      }

      const hosts = hostSelector
        ? document.querySelectorAll(hostSelector)
        : document.querySelectorAll('*');

      for (const el of hosts) {
        if (el.shadowRoot) walk(el, 0);
      }
      return collected;
    },
    { hostSelector: selector, maxD: maxDepth, fields: extractFields }
  );

  // For closed shadow roots, fall back to CDP
  if (includeClosed && results.length === 0 && selector) {
    const closedResults = await extractClosedShadowRoots(page, selector, maxDepth);
    results.push(...closedResults);
  }

  log.info('Shadow DOM extraction complete', { count: results.length });
  return results;
}

// ─── Closed shadow root extraction via CDP ────────────────────────────────────

/**
 * Attempt to extract closed shadow roots via Chrome DevTools Protocol.
 * This works only with Chromium-based browsers and requires CDP access.
 *
 * @param {import('playwright').Page | import('puppeteer').Page} page
 * @param {string} selector
 * @param {number} maxDepth
 * @returns {Promise<Array>}
 */
export async function extractClosedShadowRoots(page, selector, maxDepth = 5) {
  const results = [];
  try {
    const cdp = typeof page.context === 'function'
      ? await page.context().newCDPSession(page)     // Playwright
      : await page.target().createCDPSession();       // Puppeteer

    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const nodes = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector,
    });

    for (const nodeId of nodes.nodeIds) {
      try {
        const { shadowRoots } = await cdp.send('DOM.describeNode', { nodeId });
        if (shadowRoots?.length) {
          for (const sr of shadowRoots) {
            const { outerHTML } = await cdp.send('DOM.getOuterHTML', {
              nodeId: sr.nodeId,
            });
            results.push({
              host: selector,
              depth: 0,
              html: outerHTML,
              closedRoot: true,
            });
          }
        }
      } catch {
        // Node may have been detached
      }
    }
  } catch (err) {
    log.warn('CDP closed-shadow extraction failed', { error: err.message });
  }
  return results;
}

// ─── Iframe extraction ────────────────────────────────────────────────────────

/**
 * Extract content from same-origin and cross-origin iframes.
 *
 * **Limitation**: For cross-origin iframes, CDP's Page.getResourceContent
 * only returns cached resources, not live DOM HTML. Full cross-origin
 * iframe extraction requires browser-level frame access or CDP DOM queries.
 * Same-origin iframes have full DOM access and work reliably.
 *
 * @param {import('playwright').Page | import('puppeteer').Page} page
 * @param {object} [opts]
 * @param {string}   [opts.selector]      - Iframe CSS selector (default: all iframes)
 * @param {string[]} [opts.extractFields] - Fields to extract (default: html, text, src)
 * @returns {Promise<Array<{src: string, sameOrigin: boolean, html: string, text: string, title: string}>>}
 */
export async function extractIframes(page, opts = {}) {
  const { selector = 'iframe', extractFields = ['html', 'text', 'src'] } = opts;
  const results = [];

  const frameElements = await page.$$(selector);
  for (let i = 0; i < frameElements.length; i++) {
    const frameEl = frameElements[i];
    try {
      const src = await frameEl.evaluate(el => el.src || el.getAttribute('src') || '');
      const sameOrigin = await frameEl.evaluate(el => {
        try {
          return el.contentDocument !== null;
        } catch { return false; }
      });

      const entry = { src, sameOrigin };

      if (sameOrigin) {
        const contentFrame = await frameEl.contentFrame();
        if (contentFrame) {
          if (extractFields.includes('html')) entry.html = await contentFrame.evaluate(() => document.documentElement.outerHTML);
          if (extractFields.includes('text')) entry.text = await contentFrame.evaluate(() => document.body?.textContent?.trim() ?? '');
          entry.title = await contentFrame.title();
        }
      } else {
        // Cross-origin: best-effort via CDP
        try {
          const cdp = typeof page.context === 'function'
            ? await page.context().newCDPSession(page)
            : await page.target().createCDPSession();

          const { frameTree } = await cdp.send('Page.getFrameTree');
          const frames = flattenFrameTree(frameTree);
          const urlObj = new URL(src, 'http://localhost');
          const match = frames.find(f => f.url === src || f.url?.includes(urlObj.pathname));
          if (match) {
            const { content } = await cdp.send('Page.getResourceContent', {
              frameId: match.frameId,
              url: match.url,
            });
            if (extractFields.includes('html')) entry.html = content ?? '';
            entry.title = match.url;
          }
        } catch (err) {
          log.warn('Cross-origin iframe extraction limited by CORS', { src, error: err.message });
          entry.html = '';
          entry.title = '';
        }
      }
      results.push(entry);
    } catch (err) {
      log.warn('Iframe extraction error', { index: i, error: err.message });
    }
  }

  log.info('Iframe extraction complete', { count: results.length });
  return results;
}

// ─── Combined deep extraction ────────────────────────────────────────────────

/**
 * Perform a full deep extraction combining Shadow DOM and iframe traversal.
 *
 * @param {import('playwright').Page | import('puppeteer').Page} page
 * @param {object} [opts] - Combined options from extractShadowDom & extractIframes
 * @returns {Promise<{shadowDom: Array, iframes: Array}>}
 */
export async function deepExtract(page, opts = {}) {
  const [shadowDom, iframes] = await Promise.all([
    extractShadowDom(page, opts),
    extractIframes(page, opts),
  ]);
  return { shadowDom, iframes };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function flattenFrameTree(tree) {
  const frames = [];
  if (tree.frame) frames.push(tree.frame);
  if (tree.childFrames) {
    for (const child of tree.childFrames) {
      frames.push(...flattenFrameTree(child));
    }
  }
  return frames;
}
