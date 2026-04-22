import { getLogger } from '../utils/logger.js';
import { aiAnalysis } from '../reverse/ai-analysis.js';

const logger = getLogger('ai-agent');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncateText(value, maxLength = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeDecision(decision = {}) {
  if (typeof decision === 'string') {
    return {
      action: 'finish',
      reason: decision,
    };
  }

  if (!isPlainObject(decision)) {
    throw new TypeError('AI decision must be an object');
  }

  const action = String(decision.action ?? '').trim().toLowerCase();
  if (!action) {
    throw new Error('AI decision did not include an action');
  }

  return {
    ...decision,
    action,
    selector: decision.selector ?? decision.target ?? null,
    text: decision.text ?? decision.value ?? null,
    direction: decision.direction ?? 'down',
    reason: decision.reason ?? decision.thought ?? null,
    waitMs: Number(decision.waitMs ?? decision.delayMs ?? 0) || 0,
  };
}

function getBrowserPage(crawler) {
  return crawler?.page
    ?? crawler?._page
    ?? crawler?.currentPage
    ?? crawler?._currentPage
    ?? crawler?._runner?.page
    ?? null;
}

function isMobileCrawlerLike(crawler) {
  return crawler
    && typeof crawler.findElement === 'function'
    && typeof crawler.click === 'function'
    && typeof crawler.type === 'function'
    && typeof crawler.swipe === 'function';
}

function parseMobileElements(source, maxItems = 25) {
  const elements = [];
  const seen = new Set();
  const nodePattern = /<node\b([^>]*)\/?>/gi;
  let match;

  while ((match = nodePattern.exec(String(source ?? ''))) !== null && elements.length < maxItems) {
    const attrs = match[1] ?? '';
    const readAttr = (name) => {
      const attrMatch = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'));
      return attrMatch?.[1] ?? '';
    };

    const text = readAttr('text') || readAttr('content-desc') || readAttr('resource-id');
    if (!text) {
      continue;
    }

    const selector = readAttr('resource-id')
      ? `id=${readAttr('resource-id')}`
      : readAttr('content-desc')
        ? `accessibility id=${readAttr('content-desc')}`
        : null;

    const key = `${selector ?? ''}:${text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    elements.push({
      selector,
      text: truncateText(text, 120),
      type: readAttr('class') || 'node',
      enabled: readAttr('enabled') !== 'false',
      clickable: readAttr('clickable') === 'true',
    });
  }

  return elements;
}

async function captureBrowserState(page, options = {}) {
  const elementLimit = Number(options.elementLimit ?? 25) || 25;
  const snapshot = await page.evaluate((maxItems, includeHtmlSnippet) => {
    const toText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const interactiveSelectors = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[data-testid]',
      '[aria-label]',
    ];
    const elements = [];
    const seen = new Set();

    for (const node of document.querySelectorAll(interactiveSelectors.join(','))) {
      if (elements.length >= maxItems) break;
      const text = toText(
        node.getAttribute('aria-label')
        || node.getAttribute('placeholder')
        || node.textContent
        || node.getAttribute('value'),
      );
      const selector =
        node.id
          ? `#${node.id}`
          : node.getAttribute('data-testid')
            ? `[data-testid="${node.getAttribute('data-testid')}"]`
            : node.name
              ? `${node.tagName.toLowerCase()}[name="${node.name}"]`
              : null;
      const key = `${selector ?? ''}:${text}`;
      if (!text || seen.has(key)) continue;
      seen.add(key);

      elements.push({
        selector,
        text: text.slice(0, 160),
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute('type') || null,
        href: node.getAttribute('href') || null,
        disabled: node.hasAttribute('disabled'),
      });
    }

    return {
      url: window.location.href,
      title: document.title || null,
      htmlSnippet: includeHtmlSnippet ? document.body?.innerText?.slice(0, 1200) ?? '' : null,
      elements,
    };
  }, elementLimit, options.includeHtmlSnippet === true);

  return snapshot;
}

async function performBrowserAction(page, decision) {
  switch (decision.action) {
    case 'click': {
      if (!decision.selector) {
        throw new Error('click action requires selector');
      }
      await page.click(decision.selector);
      return;
    }

    case 'type': {
      if (!decision.selector) {
        throw new Error('type action requires selector');
      }
      const text = String(decision.text ?? '');
      if (typeof page.locator === 'function') {
        await page.locator(decision.selector).fill(text);
      } else {
        if (decision.clearFirst !== false && typeof page.$eval === 'function') {
          await page.$eval(decision.selector, (element) => {
            if ('value' in element) {
              element.value = '';
            }
          });
        }
        if (typeof page.focus === 'function') {
          await page.focus(decision.selector);
        }
        await page.type(decision.selector, text);
      }
      return;
    }

    case 'scroll': {
      const direction = String(decision.direction ?? 'down').toLowerCase();
      const delta = direction === 'up' ? -window.innerHeight * 0.8 : window.innerHeight * 0.8;
      await page.evaluate((nextDelta) => {
        window.scrollBy({ top: nextDelta, behavior: 'instant' });
      }, delta);
      return;
    }

    case 'press': {
      const key = String(decision.key ?? decision.text ?? 'Enter');
      if (!page.keyboard?.press) {
        throw new Error('browser page does not support keyboard.press');
      }
      await page.keyboard.press(key);
      return;
    }

    case 'wait': {
      await delay(Math.max(0, Number(decision.waitMs ?? 1000) || 1000));
      return;
    }

    default:
      throw new Error(`Unsupported browser action: ${decision.action}`);
  }
}

/**
 * AI task agent.
 * Generates small action plans from the current browser/mobile state and executes them.
 */
export class AiAgent {
  constructor(crawler, options = {}) {
    this.crawler = crawler;
    this.history = [];
    this.maxSteps = Number(options.maxSteps ?? 10) || 10;
    this.delayMs = Number(options.delayMs ?? 1000) || 1000;
    this.elementLimit = Number(options.elementLimit ?? 25) || 25;
    this.includeHtmlSnippet = options.includeHtmlSnippet === true;
    this.stateProvider = typeof options.stateProvider === 'function' ? options.stateProvider : null;
    this.actionExecutor = typeof options.actionExecutor === 'function' ? options.actionExecutor : null;
    this.aiOptions = options.ai ? { ai: options.ai } : {};
  }

  /**
   * Execute a goal such as "search for the newest OmniCrawl article".
   * @param {string} goal
   */
  async execute(goal) {
    const normalizedGoal = String(goal ?? '').trim();
    if (!normalizedGoal) {
      throw new Error('goal is required');
    }

    logger.info(`AI Agent starting task: ${normalizedGoal}`);

    for (let step = 1; step <= this.maxSteps; step += 1) {
      const state = await this._captureState();
      const prompt = `
Goal: ${normalizedGoal}
Step: ${step}/${this.maxSteps}
Current URL/Screen: ${state.url ?? state.path ?? 'unknown'}
Title/Label: ${state.title ?? state.label ?? 'unknown'}
Visible interactive elements: ${JSON.stringify(state.elements ?? [])}
Recent history: ${JSON.stringify(this.history.slice(-5))}
Page summary: ${JSON.stringify(state.summary ?? null)}

Decide the single best next action.
Allowed actions:
1. click(selector)
2. type(selector, text)
3. scroll(direction)
4. press(key)
5. wait(waitMs)
6. finish(reason)

Return JSON only.
`;

      const rawDecision = await aiAnalysis.reason(prompt, {
        jsonMode: true,
        ...this.aiOptions,
      });
      const decision = normalizeDecision(rawDecision);
      logger.info('AI decision', { decision });

      if (decision.action === 'finish') {
        return {
          status: 'success',
          reason: decision.reason ?? 'goal-finished',
          steps: this.history.length,
          history: [...this.history],
        };
      }

      await this._performAction(decision, state);
      this.history.push({
        step,
        action: decision.action,
        selector: decision.selector ?? null,
        text: decision.text ?? null,
        direction: decision.direction ?? null,
        url: state.url ?? state.path ?? null,
      });
      await delay(this.delayMs);
    }

    return {
      status: 'incomplete',
      reason: 'max-steps-reached',
      steps: this.history.length,
      history: [...this.history],
    };
  }

  async _captureState() {
    if (this.stateProvider) {
      return this.stateProvider(this.crawler);
    }

    if (isMobileCrawlerLike(this.crawler)) {
      const source = typeof this.crawler._getPageSource === 'function'
        ? await this.crawler._getPageSource()
        : '';
      const activity = typeof this.crawler._getCurrentActivity === 'function'
        ? await this.crawler._getCurrentActivity()
        : null;
      const appPackage = typeof this.crawler._getCurrentPackage === 'function'
        ? await this.crawler._getCurrentPackage()
        : null;

      return {
        kind: 'mobile',
        url: activity ?? appPackage ?? 'mobile://screen',
        path: activity ?? '/',
        title: activity ?? null,
        label: appPackage ?? null,
        summary: {
          activity,
          package: appPackage,
        },
        elements: parseMobileElements(source, this.elementLimit),
        source,
      };
    }

    const page = getBrowserPage(this.crawler);
    if (page) {
      const snapshot = await captureBrowserState(page, {
        elementLimit: this.elementLimit,
        includeHtmlSnippet: this.includeHtmlSnippet,
      });
      return {
        kind: 'browser',
        ...snapshot,
        summary: snapshot.htmlSnippet ? { textSnippet: truncateText(snapshot.htmlSnippet, 400) } : null,
      };
    }

    if (typeof this.crawler?.snapshot === 'function') {
      const snapshot = this.crawler.snapshot();
      return {
        kind: 'crawler',
        url: snapshot?.jobId ? `omnicrawl://${snapshot.jobId}` : 'omnicrawl://idle',
        title: snapshot?.name ?? null,
        elements: [],
        summary: snapshot,
      };
    }

    return {
      kind: 'unknown',
      url: 'unknown://state',
      title: null,
      elements: [],
      summary: null,
    };
  }

  async _performAction(decision, state) {
    if (this.actionExecutor) {
      await this.actionExecutor(decision, {
        crawler: this.crawler,
        state,
        history: this.history,
      });
      return;
    }

    if (isMobileCrawlerLike(this.crawler)) {
      switch (decision.action) {
        case 'click':
          await this.crawler.click(decision.selector);
          return;
        case 'type':
          await this.crawler.type(decision.selector, decision.text ?? '', {
            clearFirst: decision.clearFirst !== false,
          });
          return;
        case 'scroll':
          await this.crawler.swipe(decision.direction ?? 'down');
          return;
        case 'press':
          if (String(decision.key ?? '').toLowerCase() === 'back' && typeof this.crawler.back === 'function') {
            await this.crawler.back();
            return;
          }
          throw new Error(`Unsupported mobile key action: ${decision.key}`);
        case 'wait':
          await delay(Math.max(0, Number(decision.waitMs ?? 1000) || 1000));
          return;
        default:
          throw new Error(`Unsupported mobile action: ${decision.action}`);
      }
    }

    const page = getBrowserPage(this.crawler);
    if (page) {
      await performBrowserAction(page, decision);
      return;
    }

    throw new Error('No executable browser/mobile surface is available for AiAgent');
  }
}
